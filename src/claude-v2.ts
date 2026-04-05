/**
 * Claude Engine V2 — Agent SDK 기반
 *
 * v1(spawn + stream-json)과 동일한 인터페이스를 제공하되,
 * @anthropic-ai/claude-agent-sdk의 query()를 사용하여:
 * - Typed async iterable 스트리밍
 * - Query.interrupt() graceful 취소
 * - 세션 자동 resume
 * - MCP 도구 등록 가능
 */

import {
  query,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
  type SDKCompactBoundaryMessage,
  type PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "crypto";
import { join, dirname } from "path";
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, readdirSync, statSync } from "fs";

import { APPROVAL_SYSTEM_PROMPT } from "./approval";
import { loadSystemPrompt, appendMemoryLog } from "./lemonclaw";

// ═══════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-6";
const CLAUDE_LIGHT_MODEL = process.env.CLAUDE_LIGHT_MODEL || "claude-sonnet-4-6";
const CLAUDE_EFFORT = process.env.CLAUDE_EFFORT || "medium";
const ENABLE_MODEL_ROUTING = process.env.ENABLE_MODEL_ROUTING !== "false";
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || "3600000");
const USER_SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || "";
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || "2700000");
const INACTIVITY_TIMEOUT_MS = parseInt(process.env.INACTIVITY_TIMEOUT_MS || "600000");
const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS || "1500");
const DANGEROUS_MODE = process.env.DANGEROUS_MODE === "true";

// LemonClaw system prompt
const LEMONCLAW_PROMPT = loadSystemPrompt();
const SYSTEM_PROMPT = [LEMONCLAW_PROMPT, APPROVAL_SYSTEM_PROMPT, USER_SYSTEM_PROMPT]
  .filter(Boolean)
  .join("\n\n");

export let CLI_SUPPORTS_EFFORT = true; // SDK handles this internally

console.log("[Claude V2] Agent SDK engine loaded");

// ═══════════════════════════════════════════════════════════════
// Model routing (same as v1)
// ═══════════════════════════════════════════════════════════════

const COMPLEX_PATTERNS = [
  /\b(코드|code|구현|implement|리팩터|refactor|빌드|build|deploy|배포|디버그|debug|fix|버그|수정|migration)\b/i,
  /\b(파일|file|디렉토리|directory|폴더|folder|생성|create|삭제|delete|수정|edit|변경|change|작성|write)\b/i,
  /\b(그리고|그 다음|그런 다음|and then|after that|step\s*\d|단계)\b/i,
  /\b(ssh|서버|server|데이터베이스|database|db|sql|docker|git|커밋|commit|push|pull)\b/i,
  /\.(ts|js|py|go|rs|java|tsx|jsx|json|yaml|yml|toml|sh|sql|csv)\b/i,
];

function selectModel(message: string, hasAttachments: boolean): { model: string; effort: string } {
  if (!ENABLE_MODEL_ROUTING) return { model: CLAUDE_MODEL, effort: CLAUDE_EFFORT };
  if (hasAttachments) return { model: CLAUDE_MODEL, effort: "high" };
  const isComplex = COMPLEX_PATTERNS.some((p) => p.test(message));
  const isLong = message.length > 500;
  if (isComplex || isLong) return { model: CLAUDE_MODEL, effort: CLAUDE_EFFORT };
  return { model: CLAUDE_LIGHT_MODEL, effort: "low" };
}

// ═══════════════════════════════════════════════════════════════
// Session management (same file-based approach as v1)
// ═══════════════════════════════════════════════════════════════

export interface Session {
  sessionId: string;
  isFirstTurn: boolean;
  lastActive: number;
}

const SESSION_FILE = join(dirname(import.meta.dir), "sessions-v2.json");
const sessions = new Map<string, Session>();

function loadSessions(): void {
  try {
    const data: Record<string, Session> = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
    const now = Date.now();
    let loaded = 0;
    for (const [key, session] of Object.entries(data)) {
      if (now - session.lastActive < SESSION_TTL_MS) { sessions.set(key, session); loaded++; }
    }
    if (loaded > 0) console.log(`[V2 Sessions] Restored ${loaded} session(s).`);
  } catch { /* first run */ }
}

function saveSessions(): void {
  try {
    const obj: Record<string, Session> = {};
    for (const [key, s] of sessions) obj[key] = s;
    const tmp = SESSION_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, SESSION_FILE);
  } catch (e: any) { console.error(`[V2 Sessions] Save failed: ${e.message}`); }
}

loadSessions();

setInterval(() => {
  const now = Date.now();
  let pruned = 0;
  for (const [key, session] of sessions) {
    if (now - session.lastActive >= SESSION_TTL_MS) { sessions.delete(key); pruned++; }
  }
  if (pruned > 0) { saveSessions(); console.log(`[V2 Sessions] Pruned ${pruned} expired.`); }
}, 3600_000);

export function getSession(chatId: string): Session {
  const existing = sessions.get(chatId);
  if (existing && Date.now() - existing.lastActive < SESSION_TTL_MS) {
    existing.lastActive = Date.now();
    return existing;
  }
  const session: Session = { sessionId: randomUUID(), isFirstTurn: true, lastActive: Date.now() };
  sessions.set(chatId, session);
  saveSessions();
  return session;
}

export function clearSession(chatId: string): void {
  sessions.delete(chatId);
  lastHud.delete(chatId);
  activeQueries.delete(chatId);
  saveSessions();
}

// ═══════════════════════════════════════════════════════════════
// HUD (usage tracking)
// ═══════════════════════════════════════════════════════════════

export interface HudInfo {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  totalTokens: number;
  contextPercent: number;
  turnNumber: number;
  durationSec: number;
}

const lastHud = new Map<string, HudInfo>();

export function getHudInfo(chatId: string): HudInfo | null {
  return lastHud.get(chatId) || null;
}

export function clearHud(chatId: string): void {
  lastHud.delete(chatId);
}

export function getSessionStats(): { active: number } {
  const now = Date.now();
  for (const [key] of sessions) {
    const s = sessions.get(key);
    if (s && now - s.lastActive >= SESSION_TTL_MS) sessions.delete(key);
  }
  return { active: sessions.size };
}

// ═══════════════════════════════════════════════════════════════
// Interrupted context (same as v1)
// ═══════════════════════════════════════════════════════════════

function contextFilePath(chatId: string): string {
  return join(dirname(import.meta.dir), ".lemonclaw", "memory", `context-${chatId}.md`);
}

export function saveInterruptedContext(
  chatId: string, originalMessage: string, lastAssistantText: string, reason: string
): void {
  try {
    const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    const content = [
      `# 중단된 작업 컨텍스트`, `- 중단 시간: ${now}`, `- 사유: ${reason}`, ``,
      `## 원래 요청`, originalMessage.slice(0, 5000), ``,
      `## 마지막 응답 (중단 시점)`, lastAssistantText.slice(0, 10000),
    ].join("\n");
    writeFileSync(contextFilePath(chatId), content);
  } catch (e: any) { console.error(`[V2 Context] Save failed: ${e.message}`); }
}

export function loadInterruptedContext(chatId: string): string | null {
  const path = contextFilePath(chatId);
  try {
    if (!existsSync(path)) return null;
    const content = readFileSync(path, "utf-8");
    unlinkSync(path);
    return content;
  } catch { return null; }
}

export function hasInterruptedContext(chatId: string): boolean {
  return existsSync(contextFilePath(chatId));
}

// ═══════════════════════════════════════════════════════════════
// Active query tracking (for graceful cancellation)
// ═══════════════════════════════════════════════════════════════

const activeQueries = new Map<string, Query>();

export async function killActiveProcesses(): Promise<void> {
  for (const [chatId, q] of activeQueries) {
    try { await q.interrupt(); } catch {}
    activeQueries.delete(chatId);
  }
}

export async function cancelQuery(chatId: string): Promise<boolean> {
  const q = activeQueries.get(chatId);
  if (q) {
    try { await q.interrupt(); } catch {}
    activeQueries.delete(chatId);
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════
// Progress types (same interface as v1)
// ═══════════════════════════════════════════════════════════════

export interface ProgressInfo {
  type: "tool_use" | "tool_result" | "thinking" | "text_chunk";
  toolName?: string;
  text?: string;
  turnNumber: number;
}

export type OnProgress = (info: ProgressInfo) => void;

// ═══════════════════════════════════════════════════════════════
// Per-chat request queue
// ═══════════════════════════════════════════════════════════════

const chatQueues = new Map<string, Promise<void>>();

function enqueueForChat<T>(chatId: string, task: () => Promise<T>): Promise<T> {
  const prev = chatQueues.get(chatId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  const tail = next.then(() => {}, () => {});
  chatQueues.set(chatId, tail);
  tail.finally(() => { if (chatQueues.get(chatId) === tail) chatQueues.delete(chatId); });
  return next;
}

// ═══════════════════════════════════════════════════════════════
// Message debouncer (same as v1)
// ═══════════════════════════════════════════════════════════════

interface PendingMessage {
  text: string;
  attachments?: string[];
  resolve: (v: string) => void;
  reject: (e: Error) => void;
}

const debounceBuffers = new Map<string, { messages: PendingMessage[]; timer: ReturnType<typeof setTimeout> }>();

function flushDebounce(chatId: string): void {
  const buf = debounceBuffers.get(chatId);
  if (!buf || buf.messages.length === 0) return;
  debounceBuffers.delete(chatId);
  const messages = buf.messages;
  const combinedText = messages.map((m) => m.text).join("\n\n");
  const allAttachments = messages.flatMap((m) => m.attachments ?? []);
  enqueueForChat(chatId, () => runWithSDK(chatId, combinedText, allAttachments))
    .then((result) => messages.forEach((m) => m.resolve(result)))
    .catch((err) => messages.forEach((m) => m.reject(err)));
}

export function askClaude(chatId: string, message: string, attachments?: string[]): Promise<string> {
  if (DEBOUNCE_MS <= 0) {
    return enqueueForChat(chatId, () => runWithSDK(chatId, message, attachments));
  }
  return new Promise((resolve, reject) => {
    let buf = debounceBuffers.get(chatId);
    if (!buf) {
      buf = { messages: [], timer: setTimeout(() => flushDebounce(chatId), DEBOUNCE_MS) };
      debounceBuffers.set(chatId, buf);
    } else {
      clearTimeout(buf.timer);
      buf.timer = setTimeout(() => flushDebounce(chatId), DEBOUNCE_MS);
    }
    buf.messages.push({ text: message, attachments, resolve, reject });
  });
}

export function askClaudeWithProgress(
  chatId: string,
  message: string,
  attachments?: string[],
  onProgress?: OnProgress,
): Promise<string> {
  if ((attachments && attachments.length > 0) || DEBOUNCE_MS <= 0) {
    return enqueueForChat(chatId, () => runWithSDK(chatId, message, attachments, onProgress));
  }
  return askClaude(chatId, message, attachments);
}

// ═══════════════════════════════════════════════════════════════
// Core: Agent SDK query execution
// ═══════════════════════════════════════════════════════════════

async function runWithSDK(
  chatId: string,
  message: string,
  attachments?: string[],
  onProgress?: OnProgress,
): Promise<string> {
  const session = getSession(chatId);
  const routing = selectModel(message, !!(attachments?.length));

  // Build prompt with attachments
  let prompt = message;
  if (attachments?.length) {
    prompt += "\n\n" + attachments.map((f) => `[첨부파일: ${f}]`).join("\n");
  }

  // Refresh system prompt on every call (LemonClaw memory may have changed)
  const freshPrompt = loadSystemPrompt();
  const systemPrompt = [freshPrompt, APPROVAL_SYSTEM_PROMPT, USER_SYSTEM_PROMPT]
    .filter(Boolean)
    .join("\n\n");

  const controller = new AbortController();
  const permissionMode: PermissionMode = DANGEROUS_MODE ? "bypassPermissions" : "bypassPermissions";
  // 봇은 항상 bypassPermissions — 사용자 승인 UI가 Telegram에서 불가능

  const cwd = process.cwd();

  // Build query options
  const queryOptions: Parameters<typeof query>[0]["options"] = {
    cwd,
    permissionMode,
    abortController: controller,
    systemPrompt: {
      type: "preset" as const,
      preset: "claude_code" as const,
      append: systemPrompt,
    },
    model: routing.model,
    resume: session.isFirstTurn ? undefined : session.sessionId,
    ...(session.isFirstTurn ? { sessionId: session.sessionId } : {}),
    pathToClaudeCodeExecutable: CLAUDE_PATH,
    allowDangerouslySkipPermissions: true,
    stderr: (data: string) => {
      if (data.includes("error") || data.includes("Error")) {
        console.error("[V2 stderr]:", data.slice(0, 200));
      }
    },
  };

  let fullText = "";
  let turnNumber = 0;
  let toolsUsed: string[] = [];
  let resultSessionId: string | undefined;
  let resultUsage: { inputTokens: number; outputTokens: number; cacheRead: number; durationMs: number } = {
    inputTokens: 0, outputTokens: 0, cacheRead: 0, durationMs: 0,
  };

  const startTime = Date.now();

  // Inactivity watchdog
  let lastActivity = Date.now();
  const watchdogTimer = setInterval(() => {
    const now = Date.now();
    if (now - lastActivity > INACTIVITY_TIMEOUT_MS) {
      console.log(`[V2] Inactivity timeout (${Math.round(INACTIVITY_TIMEOUT_MS / 1000)}s), aborting...`);
      controller.abort();
    }
    if (now - startTime > TIMEOUT_MS) {
      console.log(`[V2] Overall timeout (${Math.round(TIMEOUT_MS / 1000)}s), aborting...`);
      controller.abort();
    }
  }, 10_000);

  try {
    const response = query({ prompt, options: queryOptions });
    activeQueries.set(chatId, response);

    for await (const msg of response) {
      lastActivity = Date.now();

      if (controller.signal.aborted) {
        fullText = fullText || "⏱ 요청이 취소되었습니다.";
        break;
      }

      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") {
            fullText += block.text;
            onProgress?.({ type: "text_chunk", text: block.text, turnNumber });
          } else if (block.type === "tool_use") {
            turnNumber++;
            toolsUsed.push(block.name);
            onProgress?.({ type: "tool_use", toolName: block.name, turnNumber });
          }
        }
      } else if (msg.type === "user") {
        // Tool result returned
        onProgress?.({ type: "tool_result", turnNumber });
      } else if (msg.type === "system") {
        if (msg.subtype === "init") {
          const sysMsg = msg as SDKSystemMessage;
          resultSessionId = sysMsg.session_id;
          console.log(`[V2] Session init: model=${sysMsg.model}, session=${sysMsg.session_id}`);
        } else if (msg.subtype === "compact_boundary") {
          const cbMsg = msg as SDKCompactBoundaryMessage;
          console.log(`[V2] Context compaction: trigger=${cbMsg.compact_metadata.trigger}`);
        }
      } else if (msg.type === "result") {
        const resultMsg = msg as SDKResultMessage;

        // Extract usage
        if (resultMsg.modelUsage) {
          const modelKey = Object.keys(resultMsg.modelUsage)[0];
          if (modelKey && resultMsg.modelUsage[modelKey]) {
            const mu = resultMsg.modelUsage[modelKey];
            resultUsage = {
              inputTokens: mu.inputTokens,
              outputTokens: mu.outputTokens,
              cacheRead: mu.cacheReadInputTokens || 0,
              durationMs: Date.now() - startTime,
            };
          }
        }

        // Extract final text if different from accumulated
        if (resultMsg.subtype === "success") {
          if ("session_id" in resultMsg && resultMsg.session_id) {
            resultSessionId = resultMsg.session_id;
          }
          if (resultMsg.result && !fullText.includes(resultMsg.result)) {
            if (fullText.length > 0) fullText += "\n\n";
            fullText += resultMsg.result;
          }
        } else {
          // Error — clear session for fresh start
          console.error(`[V2] Result error: ${resultMsg.subtype}`);
          if (resultMsg.subtype !== "error_during_execution") {
            sessions.delete(chatId);
            saveSessions();
          }
          if (!fullText) {
            fullText = `⚠️ 오류 발생: ${resultMsg.subtype}`;
          }
        }
      }
    }
  } catch (error: any) {
    if (controller.signal.aborted) {
      if (!fullText) fullText = "⏱ 요청이 중단되었습니다.";
    } else if (fullText && error.message?.includes("exited with code")) {
      // SDK quirk: ignore exit code error after successful result
      console.log("[V2] Ignoring exit error after result");
    } else {
      console.error(`[V2] Query error: ${error.message}`);
      // On session errors, reset session
      if (error.message?.includes("session") || error.message?.includes("already in use")) {
        sessions.delete(chatId);
        saveSessions();
      }
      if (!fullText) {
        fullText = `⚠️ 오류: ${error.message?.slice(0, 200)}`;
      }
    }
  } finally {
    clearInterval(watchdogTimer);
    activeQueries.delete(chatId);
  }

  // Update session
  if (resultSessionId) {
    session.sessionId = resultSessionId;
  }
  session.isFirstTurn = false;
  session.lastActive = Date.now();
  saveSessions();

  // Update HUD
  const durationMs = Date.now() - startTime;
  const maxCtx = 200_000;
  const totalTokens = resultUsage.inputTokens + resultUsage.outputTokens;
  lastHud.set(chatId, {
    inputTokens: resultUsage.inputTokens,
    outputTokens: resultUsage.outputTokens,
    cacheRead: resultUsage.cacheRead,
    totalTokens,
    contextPercent: Math.min(100, Math.round((resultUsage.inputTokens / maxCtx) * 100)),
    turnNumber,
    durationSec: Math.round(durationMs / 1000),
  });

  if (!fullText.trim()) {
    fullText = "(빈 응답)";
  }

  return fullText;
}

// Cleanup stale context files on startup
(function cleanupStaleContextFiles(): void {
  try {
    const ctxDir = join(dirname(import.meta.dir), ".lemonclaw", "memory");
    if (!existsSync(ctxDir)) return;
    const now = Date.now();
    for (const file of readdirSync(ctxDir)) {
      if (!file.startsWith("context-")) continue;
      try {
        const stat = statSync(join(ctxDir, file));
        if (now - stat.mtimeMs >= 24 * 3600_000) {
          unlinkSync(join(ctxDir, file));
        }
      } catch {}
    }
  } catch {}
})();
