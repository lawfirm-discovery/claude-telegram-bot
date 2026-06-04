/**
 * Claude Engine V3 — Agent SDK + Hooks + maxTurns
 *
 * V2와 동일 인터페이스를 유지하되, 장기 작업에 필요한 안전망을 추가:
 *  - PreToolUse 훅 주입: loop-detector, dangerous-cmd
 *  - maxTurns 한도: 무한 tool call 방지
 *  - 별도 세션 파일 (sessions-v3.json): v2와 격리하여 점진적 롤아웃
 *
 * ENGINE_VERSION=v3 일 때만 사용. 기본은 v2.
 */

import {
  query,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
  type SDKCompactBoundaryMessage,
  type PermissionMode,
  type HookCallback,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "crypto";
import { join, dirname } from "path";
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, readdirSync, statSync } from "fs";

import { APPROVAL_SYSTEM_PROMPT } from "./approval";
import {
  loadSystemPrompt, loadChatNotes, appendChatNote,
  loadActiveWorking, mergeActiveWorking, appendWorkingHistory,
  activeWorkingNeedsCompact, setActiveWorking,
} from "./lemonclaw";
import { makeLoopDetectorHook, clearLoopHistory } from "./hooks/loop-detector";
import { dangerousCmdHook } from "./hooks/dangerous-cmd";
import { codeQualityHook } from "./hooks/code-quality";
import { incr, addCostUsd } from "./metrics";

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
const CLAUDE_MAX_TURNS = parseInt(process.env.CLAUDE_MAX_TURNS || process.env.MAX_TURNS || "500");
const DISABLE_HOOKS = process.env.DISABLE_V3_HOOKS === "true";
// Phase R2.3 — task_budget (alpha SDK 옵션). 설정 시 모델이 남은 token 인지하고 페이싱.
//   정액제와 무관하게 작동 (token 사용량 page 권장 — 비용 청구 아님). 0 또는 미설정 시 비활성.
const CLAUDE_TASK_BUDGET = parseInt(process.env.CLAUDE_TASK_BUDGET || "0");
// Auto-compact: contextPercent가 이 임계 이상이면 매 턴 끝에 자동으로 transcript 요약 → 새 세션 시드.
// 0이면 비활성. 기본 70%.
const AUTO_COMPACT_THRESHOLD = parseInt(process.env.AUTO_COMPACT_THRESHOLD || "70");

console.log(
  `[Claude V3] Agent SDK engine loaded ` +
  `(maxTurns=${CLAUDE_MAX_TURNS}, hooks=${DISABLE_HOOKS ? "OFF" : "ON"})`
);

export let CLI_SUPPORTS_EFFORT = false;

// ═══════════════════════════════════════════════════════════════
// Model routing (same as v2)
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
// Session management — separate file from v2
// ═══════════════════════════════════════════════════════════════

export interface Session {
  sessionId: string;
  isFirstTurn: boolean;
  lastActive: number;
  // 이전 세션이 폐기된 경우(conflict 등), 옛 transcript의 자동 요약을 새 세션 첫 턴에 주입한다.
  // 첫 턴 후 제거되어 system prompt를 부풀리지 않는다. ("Claude Code parity" 메모리)
  previousSummary?: string;
}

const SESSION_FILE = join(dirname(import.meta.dir), "sessions-v3.json");
const sessions = new Map<string, Session>();

function loadSessions(): void {
  try {
    const data: Record<string, Session> = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
    const now = Date.now();
    let loaded = 0;
    for (const [key, session] of Object.entries(data)) {
      if (now - session.lastActive < SESSION_TTL_MS) { sessions.set(key, session); loaded++; }
    }
    if (loaded > 0) console.log(`[V3 Sessions] Restored ${loaded} session(s).`);
  } catch { /* first run */ }
}

let _saveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 2000;

function saveSessions(): void {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      const obj: Record<string, Session> = {};
      for (const [key, s] of sessions) obj[key] = s;
      const tmp = SESSION_FILE + ".tmp";
      writeFileSync(tmp, JSON.stringify(obj));
      renameSync(tmp, SESSION_FILE);
    } catch (e: unknown) { console.error(`[V3 Sessions] Save failed: ${e instanceof Error ? e.message : e}`); }
  }, SAVE_DEBOUNCE_MS);
}

function saveSessionsSync(): void {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  try {
    const obj: Record<string, Session> = {};
    for (const [key, s] of sessions) obj[key] = s;
    const tmp = SESSION_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, SESSION_FILE);
  } catch (e: unknown) { console.error(`[V3 Sessions] Save failed: ${e instanceof Error ? e.message : e}`); }
}

loadSessions();

process.on("SIGTERM", saveSessionsSync);
process.on("SIGINT", saveSessionsSync);

setInterval(() => {
  const now = Date.now();
  let pruned = 0;
  for (const [key, session] of sessions) {
    if (now - session.lastActive >= SESSION_TTL_MS) { sessions.delete(key); pruned++; }
  }
  if (pruned > 0) { saveSessions(); console.log(`[V3 Sessions] Pruned ${pruned} expired.`); }
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
  clearLoopHistory(chatId);
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
// Interrupted context (shared with v2 — same on-disk format)
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
  } catch (e: any) { console.error(`[V3 Context] Save failed: ${e.message}`); }
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
// Progress types (same interface as v1/v2)
// ═══════════════════════════════════════════════════════════════

export interface ProgressInfo {
  type: "tool_use" | "tool_result" | "thinking" | "text_chunk" | "tool_progress";
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  text?: string;
  turnNumber: number;
  elapsedSeconds?: number;
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
// Message debouncer (same as v2)
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
// Hook wiring per chatId
// ═══════════════════════════════════════════════════════════════

function buildHooks(chatId: string): NonNullable<Parameters<typeof query>[0]["options"]>["hooks"] {
  if (DISABLE_HOOKS) return undefined;
  const preHooks: HookCallback[] = [makeLoopDetectorHook(chatId), dangerousCmdHook, codeQualityHook];
  return {
    PreToolUse: [{ hooks: preHooks }],
  };
}

// ═══════════════════════════════════════════════════════════════
// Previous-session summary (Claude Code parity memory)
//
// sessionId가 폐기되면 Claude Code SDK의 transcript jsonl 연결이 끊겨 봇이
// "이전 대화"를 통째 잊는다. 이를 막기 위해, 폐기 직전 옛 jsonl의 마지막
// 메시지들을 Haiku로 요약해 새 세션 첫 턴 system prompt에 주입한다.
// ═══════════════════════════════════════════════════════════════

function jsonlPathFor(sessionId: string): string {
  const cwdEncoded = process.cwd().replace(/\//g, "-");
  const home = process.env.HOME || "";
  return join(home, ".claude", "projects", cwdEncoded, `${sessionId}.jsonl`);
}

function extractRecentTranscript(sessionId: string, maxItems = 30): string {
  try {
    const path = jsonlPathFor(sessionId);
    if (!existsSync(path)) return "";
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    const out: string[] = [];
    for (const line of lines.slice(-maxItems * 2)) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === "user" && obj.message?.content) {
          const c = typeof obj.message.content === "string"
            ? obj.message.content
            : JSON.stringify(obj.message.content);
          out.push(`USER: ${c.slice(0, 800)}`);
        } else if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
          const text = obj.message.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n");
          if (text) out.push(`ASSISTANT: ${text.slice(0, 1500)}`);
        }
      } catch {}
    }
    return out.slice(-maxItems).join("\n\n");
  } catch {
    return "";
  }
}

async function summarizeTranscriptWithHaiku(transcript: string): Promise<string> {
  if (!transcript) return "";
  try {
    // @ts-ignore — transitive dep, ESM dynamic import for resilience
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content:
          `다음은 Claude Code 봇과 사용자의 직전 대화입니다. 이 대화의 핵심을 한국어로 간결하게 요약해주세요.\n\n` +
          `## 요약 형식 (이대로 따라주세요)\n` +
          `1. 사용자 요청 / 목표\n` +
          `2. 완료된 작업\n` +
          `3. 진행 중인 분석/계획 (특히 중요 — 후보 옵션·다음 단계 포함)\n` +
          `4. 미해결 항목\n` +
          `5. 사용자가 동의한 결정 사항\n\n` +
          `## 대화 transcript\n${transcript.slice(0, 80000)}\n\n` +
          `요약 (위 5개 섹션 형식, 각 섹션은 짧게):`
      }],
    });
    const text = (msg.content as any[])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
    return text;
  } catch (e: any) {
    console.error(`[V3] Haiku summarize failed: ${e?.message}`);
    return "";
  }
}

async function buildPreviousSummaryForChat(chatId: string): Promise<string> {
  const old = sessions.get(chatId);
  if (!old) return "";
  const transcript = extractRecentTranscript(old.sessionId);
  if (!transcript) return "";
  return await summarizeTranscriptWithHaiku(transcript);
}

// /plan — 현재 세션 transcript에서 "진행 중인 계획"만 추출 (read-only)
export async function getCurrentPlan(chatId: string): Promise<string> {
  const s = sessions.get(chatId);
  if (!s) return "현재 활성 세션이 없습니다. 메시지를 한 번 보내고 다시 시도하세요.";
  const transcript = extractRecentTranscript(s.sessionId, 30);
  if (!transcript) return "이 세션엔 아직 추출할 대화 transcript가 없습니다.";
  try {
    // @ts-ignore — transitive dep
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 768,
      messages: [{
        role: "user",
        content:
          `다음 Claude Code 봇 대화에서 "현재 진행 중인 계획"만 한국어로 정리하세요. ` +
          `후보 옵션, 다음 단계, 미해결 항목, 사용자가 동의한 결정 사항 위주로. 짧고 명확하게.\n\n` +
          `## 대화 transcript\n${transcript.slice(0, 60000)}\n\n진행 계획:`
      }],
    });
    const text = (msg.content as any[])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
    return text || "(추출 결과 없음)";
  } catch (e: any) {
    return `⚠️ 요약 실패: ${e?.message}`;
  }
}

// /checkpoint — 현재 핵심을 요약해 chat note(영구)에 저장
export async function saveCheckpoint(chatId: string): Promise<string> {
  const s = sessions.get(chatId);
  if (!s) return "";
  const transcript = extractRecentTranscript(s.sessionId, 50);
  if (!transcript) return "";
  const summary = await summarizeTranscriptWithHaiku(transcript);
  if (summary) {
    appendChatNote(chatId, `[checkpoint @ ${new Date().toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour12: false })}]\n${summary}`);
  }
  return summary;
}

// 새 세션을 시작하면서 옛 transcript 요약을 previousSummary로 시드한다.
// onProgress가 있으면 사용자에게 한 줄 안내한다.
async function reseedSessionWithSummary(
  chatId: string,
  reason: string,
  onProgress?: OnProgress,
): Promise<void> {
  console.log(`[V3] Reseeding session — chat=${chatId} reason=${reason}`);
  const summary = await buildPreviousSummaryForChat(chatId).catch(() => "");
  sessions.set(chatId, {
    sessionId: randomUUID(),
    isFirstTurn: true,
    lastActive: Date.now(),
    previousSummary: summary || undefined,
  });
  saveSessions();
  if (onProgress) {
    const note = summary
      ? "🔄 이전 대화 컨텍스트가 만료되어 핵심을 자동 요약해 이어갑니다..."
      : "🔄 이전 대화 컨텍스트가 만료되어 새 세션으로 시작합니다 (요약 실패).";
    try { await onProgress({ type: "text_chunk", text: note, turnNumber: 0 }); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════
// Core: SDK query execution with hooks + maxTurns
// ═══════════════════════════════════════════════════════════════

async function runWithSDK(
  chatId: string,
  message: string,
  attachments?: string[],
  onProgress?: OnProgress,
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await runWithSDKInner(chatId, message, attachments, onProgress);
    } catch (err: any) {
      const isConflict = /already in use/i.test(err.message || "");
      if (isConflict && attempt === 0) {
        const active = activeQueries.get(chatId);
        if (active) { try { await active.interrupt(); } catch {} activeQueries.delete(chatId); }
        await reseedSessionWithSummary(chatId, "session_conflict", onProgress);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }
  throw new Error("runWithSDK: unreachable");
}

async function runWithSDKInner(
  chatId: string,
  message: string,
  attachments?: string[],
  onProgress?: OnProgress,
): Promise<string> {
  const session = getSession(chatId);
  const routing = selectModel(message, !!(attachments?.length));

  let prompt = message;
  if (attachments?.length) {
    prompt += "\n\n" + attachments.map((f) => `[첨부파일: ${f}]`).join("\n");
  }

  const freshPrompt = loadSystemPrompt();
  // 이전 세션 요약은 새 세션 첫 턴에만 주입 (한 번 받으면 transcript에 누적되어 이후 턴은 자연스럽게 이어감).
  const previousSummaryBlock = session.isFirstTurn && session.previousSummary
    ? `# 🔄 이전 세션 핵심 (자동 요약)\n${session.previousSummary}\n\n위 요약을 바탕으로 사용자와의 대화를 끊김 없이 이어가세요.`
    : "";
  // 채팅별 사용자 명시 메모 — 매 턴 주입. 컨텍스트 손실/세션 폐기에도 살아남는 영구 메모.
  const chatNotes = loadChatNotes(chatId);
  const chatNotesBlock = chatNotes
    ? `# 📌 사용자 메모 (Chat Notes — 사용자가 /note 또는 /checkpoint로 영구 저장한 내용)\n${chatNotes}\n\n위 메모는 사용자가 명시적으로 기억해달라고 한 사항이므로 항상 우선시하세요.`
    : "";
  // Working Memory (Phase 5) — 봇 자체가 누적해온 작업 컨텍스트. Claude Code의 auto-memory와 동치.
  const activeWorking = loadActiveWorking(chatId);
  const workingBlock = activeWorking
    ? `# 🎯 ACTIVE WORKING MEMORY (당신이 이전 턴에서 직접 기록한 진행 상황 — 항상 참고)\n${activeWorking}`
    : "";
  const workingInstructionBlock =
    `# 🧠 WORKING MEMORY 자율 업데이트 규칙\n` +
    `중요한 결정·완료·미해결·다음 단계가 새로 생겼다면 응답 끝에 다음 태그로 기록하세요. 태그 본문은 사용자에게 보이지 않고 active.md에 저장되어 다음 턴 system prompt에 자동 주입됩니다.\n\n` +
    `<working-memory>\n` +
    `## 결정/완료\n- (이번 턴에 확정한 것)\n\n` +
    `## 진행 중 / 미해결\n- (계속 추적할 항목)\n\n` +
    `## 다음 단계\n- (다음 턴에서 할 일)\n` +
    `</working-memory>\n\n` +
    `규칙:\n` +
    `- 매 턴 무조건 작성하지 말고 변화가 있을 때만. 단순 답변·인사·질문 응답엔 생략.\n` +
    `- 본문에 \`<!-- replace -->\` 마커를 포함하면 active.md를 통째로 교체. 미포함 시 누적 추가.\n` +
    `- 기존 active.md에 같은 항목이 있으면 중복 작성 금지 (replace 모드로 갱신).\n` +
    `- 사용자가 /working clear, /archive를 호출하기 전까지 누적되므로 의미 있는 변화만.`;
  const systemPrompt = [freshPrompt, APPROVAL_SYSTEM_PROMPT, USER_SYSTEM_PROMPT, previousSummaryBlock, chatNotesBlock, workingBlock, workingInstructionBlock]
    .filter(Boolean)
    .join("\n\n");

  const controller = new AbortController();
  const permissionMode: PermissionMode = "bypassPermissions";

  const cwd = process.cwd();

  // SDK가 child Claude Code process를 spawn하므로, child의 stderr 메시지(예: "Session ID ... already in use")는
  // 외부 SDK Error 객체의 message에 보존되지 않고 "Claude Code process exited with code 1"로 wrap된다.
  // catch 블록에서 conflict 감지를 위해 stderr를 별도 버퍼링한다.
  let stderrBuffer = "";

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
    maxTurns: CLAUDE_MAX_TURNS,
    // Phase R2.3 — task_budget 설정 시 모델이 자체 페이싱 → 응답 truncation 빈도 감소
    ...(CLAUDE_TASK_BUDGET > 0 ? { taskBudget: { total: CLAUDE_TASK_BUDGET } } : {}),
    hooks: buildHooks(chatId),
    stderr: (data: string) => {
      stderrBuffer += data;
      if (stderrBuffer.length > 8000) stderrBuffer = stderrBuffer.slice(-4000);
      if (data.includes("error") || data.includes("Error")) {
        console.error("[V3 stderr]:", data.slice(0, 200));
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

  let lastActivity = Date.now();
  const watchdogTimer = setInterval(() => {
    const now = Date.now();
    if (now - lastActivity > INACTIVITY_TIMEOUT_MS) {
      console.log(`[V3] Inactivity timeout (${Math.round(INACTIVITY_TIMEOUT_MS / 1000)}s), aborting...`);
      controller.abort();
    }
    if (now - startTime > TIMEOUT_MS) {
      console.log(`[V3] Overall timeout (${Math.round(TIMEOUT_MS / 1000)}s), aborting...`);
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
            let inputSummary = "";
            try {
              const inp = block.input as Record<string, any>;
              if (inp.command) inputSummary = String(inp.command).slice(0, 200);
              else if (inp.file_path) inputSummary = inp.file_path;
              else if (inp.pattern) inputSummary = `${inp.pattern}`;
              else if (inp.query) inputSummary = String(inp.query).slice(0, 150);
              else inputSummary = JSON.stringify(inp).slice(0, 150);
            } catch {}
            onProgress?.({ type: "tool_use", toolName: block.name, toolInput: inputSummary, turnNumber });
          }
        }
      } else if (msg.type === "user") {
        let outputSummary = "";
        try {
          const content = (msg as any).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block.content === "string") {
                outputSummary = block.content.slice(0, 300);
                break;
              } else if (Array.isArray(block.content)) {
                const textPart = block.content.find((c: any) => c.type === "text");
                if (textPart) { outputSummary = textPart.text?.slice(0, 300) || ""; break; }
              }
            }
          }
        } catch {}
        onProgress?.({ type: "tool_result", toolOutput: outputSummary, turnNumber });
      } else if ((msg as any).type === "tool_progress") {
        const tp = msg as any;
        onProgress?.({ type: "tool_progress", toolName: tp.tool_name, elapsedSeconds: tp.elapsed_time_seconds, turnNumber });
      } else if (msg.type === "system") {
        if (msg.subtype === "init") {
          const sysMsg = msg as SDKSystemMessage;
          resultSessionId = sysMsg.session_id;
          console.log(`[V3] Session init: model=${sysMsg.model}, session=${sysMsg.session_id}`);
        } else if (msg.subtype === "compact_boundary") {
          const cbMsg = msg as SDKCompactBoundaryMessage;
          console.log(`[V3] Context compaction: trigger=${cbMsg.compact_metadata.trigger}`);
        }
      } else if (msg.type === "result") {
        const resultMsg = msg as SDKResultMessage;

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

        if (resultMsg.subtype === "success") {
          if ("session_id" in resultMsg && resultMsg.session_id) {
            resultSessionId = resultMsg.session_id;
          }
          if (resultMsg.result && !fullText.includes(resultMsg.result)) {
            if (fullText.length > 0) fullText += "\n\n";
            fullText += resultMsg.result;
          }
          // Phase R1.1 — stop_reason='max_tokens' 면 응답 truncated. Ralph loop 가 즉시 halt 하도록 마커 prepend.
          //   SDK 가 정상 'success' subtype 으로 결과를 주지만 stop_reason 이 max_tokens 이면 잘림.
          //   호성님 사고 (보고서 38분 무한루프) 의 직접 원인이 이 케이스.
          if (resultMsg.stop_reason === "max_tokens") {
            console.warn("[V3] ⚠️ stop_reason=max_tokens — output truncated, signalling Ralph loop");
            incr("engine.stop_reason.max_tokens");
            fullText = "__TRUNCATED_MAX_TOKENS__\n\n" + fullText;
          }
        } else {
          console.error(`[V3] Result error: ${resultMsg.subtype}`);
          if (resultMsg.subtype === "error_max_turns") {
            incr("engine.max_turns_hit");
            const tail = fullText ? fullText + "\n\n" : "";
            fullText = `${tail}⚠️ maxTurns(${CLAUDE_MAX_TURNS}) 초과로 중단됨. 작업을 더 작은 단위로 나누어 재요청하세요.`;
          }
          // 일시적 result error(max_turns, during_execution 등)는 세션을 유지한다.
          // 사용자가 다음 메시지로 이어갈 수 있고, 진짜 영구 에러는 다음 턴에서 conflict
          // 감지로 reseed 흐름이 처리한다. (Phase 1: 세션 폐기 빈도 축소)
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
      console.log("[V3] Ignoring exit error after result");
    } else {
      console.error(`[V3] Query error: ${error.message}`);
      // SDK는 child의 "already in use" stderr를 "Claude Code process exited with code 1"로 wrap한다.
      // 외부 runWithSDK의 retry가 인식하도록 stderr 버퍼도 검사하고 메시지에 명시해서 throw.
      const conflictDetected = /already in use/i.test(error.message || "")
                            || /already in use/i.test(stderrBuffer);
      if (conflictDetected) {
        throw new Error(`Session ID already in use: ${error.message}`);
      }
      // "session" 부분 매칭은 너무 광범위했음("session timeout", "user session" 등 일시 에러도 잡힘).
      // 명백한 영구 세션 에러만 폐기 후 reseed로 핵심 컨텍스트 보존.
      const permanentSessionError =
        /session\s*(not found|invalid|expired|id\s+(not found|does not exist))|invalid\s+session/i
          .test(error.message || "");
      if (permanentSessionError) {
        console.log(`[V3] Permanent session error — reseeding (chat=${chatId}): ${error.message}`);
        const active = activeQueries.get(chatId);
        if (active) { try { await active.interrupt(); } catch {} activeQueries.delete(chatId); }
        await reseedSessionWithSummary(chatId, "permanent_session_error", onProgress).catch(() => {
          sessions.delete(chatId); saveSessions();
        });
      }
      if (!fullText) {
        fullText = `⚠️ 오류: ${error.message?.slice(0, 200)}`;
      }
    }
  } finally {
    clearInterval(watchdogTimer);
    activeQueries.delete(chatId);
  }

  if (resultSessionId) {
    session.sessionId = resultSessionId;
  }
  session.isFirstTurn = false;
  session.lastActive = Date.now();
  // previousSummary는 첫 턴 system prompt에 한 번만 주입되고 transcript에 누적되므로 폐기.
  if (session.previousSummary) delete session.previousSummary;
  saveSessions();

  const durationMs = Date.now() - startTime;
  const maxCtx = 200_000;
  const totalTokens = resultUsage.inputTokens + resultUsage.outputTokens;
  const contextPercent = Math.min(100, Math.round((resultUsage.inputTokens / maxCtx) * 100));
  lastHud.set(chatId, {
    inputTokens: resultUsage.inputTokens,
    outputTokens: resultUsage.outputTokens,
    cacheRead: resultUsage.cacheRead,
    totalTokens,
    contextPercent,
    turnNumber,
    durationSec: Math.round(durationMs / 1000),
  });

  // Phase 4: Auto-compact — 컨텍스트 임계 도달 시 백그라운드에서 transcript 자동 요약 → 새 세션 시드.
  // 다음 턴이 깨끗한 컨텍스트로 시작하지만 이전 핵심은 previousSummary로 보존.
  if (AUTO_COMPACT_THRESHOLD > 0 && contextPercent >= AUTO_COMPACT_THRESHOLD && !session.isFirstTurn) {
    setImmediate(() => {
      reseedSessionWithSummary(chatId, `auto_compact (${contextPercent}%)`, onProgress).catch((e) => {
        console.error(`[V3] Auto-compact failed (chat=${chatId}): ${e?.message}`);
      });
    });
  }

  const isOpus = routing.model.includes("opus");
  const inRate = isOpus ? 15 : 3;
  const outRate = isOpus ? 75 : 15;
  const estimatedCost = (resultUsage.inputTokens * inRate + resultUsage.outputTokens * outRate + resultUsage.cacheRead * 1.5) / 1_000_000;
  addCostUsd(estimatedCost);
  console.log(
    `[V3] chat=${chatId} turns=${turnNumber} in=${resultUsage.inputTokens} out=${resultUsage.outputTokens}` +
    ` cache_read=${resultUsage.cacheRead} cost=$${estimatedCost.toFixed(4)} duration=${Math.round(durationMs / 1000)}s`
  );

  if (!fullText.trim()) {
    fullText = "(빈 응답)";
  }

  // ─── Phase 5: Working Memory 후처리 ───────────────────────────
  // 1) <working-memory> 태그 추출 → active.md merge, 응답에서 태그 제거
  try {
    const wmRe = /<working-memory>([\s\S]*?)<\/working-memory>/gi;
    const blocks: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = wmRe.exec(fullText)) !== null) {
      const body = m[1]?.trim();
      if (body) blocks.push(body);
    }
    if (blocks.length > 0) {
      mergeActiveWorking(chatId, blocks.join("\n\n"));
      fullText = fullText.replace(wmRe, "").trim();
      if (!fullText) fullText = "✅ (작업 메모리 갱신 완료)";
    }
  } catch (e: any) {
    console.error(`[V3] Working memory tag handling failed: ${e?.message}`);
  }

  // 2) history.log에 user/assistant 짧은 한 줄 append
  try {
    const userSummary = (message || "").replace(/\n+/g, " ").slice(0, 200);
    const assistantSummary = fullText.replace(/\n+/g, " ").slice(0, 400);
    appendWorkingHistory(chatId, `user: ${userSummary} | assistant: ${assistantSummary}`);
  } catch {}

  // 3) active.md 임계 초과 시 백그라운드에서 Haiku 압축
  if (activeWorkingNeedsCompact(chatId)) {
    setImmediate(async () => {
      try {
        const current = loadActiveWorking(chatId);
        if (!current) return;
        const compacted = await compactActiveWorkingWithHaiku(current);
        if (compacted) setActiveWorking(chatId, compacted);
      } catch (e: any) {
        console.error(`[V3] Active working compact failed: ${e?.message}`);
      }
    });
  }

  return fullText;
}

async function compactActiveWorkingWithHaiku(content: string): Promise<string> {
  try {
    // @ts-ignore — transitive dep
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [{
        role: "user",
        content:
          `다음은 Claude Code 봇이 누적해온 작업 메모리(active.md)입니다. 너무 길어져서 압축이 필요합니다.\n\n` +
          `## 압축 규칙\n` +
          `- 가장 최근 결정/진행/미해결/다음 단계를 우선 보존.\n` +
          `- 오래된 항목 중 이미 완료되어 후속 영향 없는 건 제거.\n` +
          `- 핵심 결정 사항은 완료/취소 여부와 관계없이 한 줄로 요약 유지.\n` +
          `- 형식: ## 헤더 + 짧은 글머리표 (마크다운).\n` +
          `- 출력은 압축된 본문만 (다른 설명 금지).\n\n` +
          `## 현재 active.md\n${content.slice(0, 60000)}\n\n압축본:`
      }],
    });
    const text = (msg.content as any[])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
    return text;
  } catch (e: any) {
    console.error(`[V3] Haiku working compact failed: ${e?.message}`);
    return "";
  }
}

// Cleanup stale context files on startup (shared with v2)
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
