import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { join, dirname } from "path";
import { readFileSync, writeFileSync, renameSync } from "fs";

import { APPROVAL_SYSTEM_PROMPT } from "./approval";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-6";
const CLAUDE_LIGHT_MODEL = process.env.CLAUDE_LIGHT_MODEL || "claude-sonnet-4-6";
const CLAUDE_EFFORT = process.env.CLAUDE_EFFORT || "medium"; // low | medium | high | max
const ENABLE_MODEL_ROUTING = process.env.ENABLE_MODEL_ROUTING !== "false"; // default: true
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || "3600000");
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "200"); // 안전망 (진짜 runaway만 차단)
const USER_SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || "";
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || "2700000"); // 45 min default
const INACTIVITY_TIMEOUT_MS = parseInt(process.env.INACTIVITY_TIMEOUT_MS || "600000"); // 10 min no-output kill
const MAX_PROMPT_ARG_CHARS = 100_000;
const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS || "1500");
const ALLOWED_TOOLS = process.env.ALLOWED_TOOLS || ""; // 빈 값이면 --tools 미전달 (모든 도구 + MCP 도구 사용 가능)
const USE_BARE_MODE = process.env.USE_BARE_MODE === "true"; // default: false (--bare disables OAuth)

const SYSTEM_PROMPT = [APPROVAL_SYSTEM_PROMPT, USER_SYSTEM_PROMPT]
  .filter(Boolean)
  .join("\n\n");

// ═══════════════════════════════════════════════════════════════
// Model routing: route simple messages to lighter model
// ═══════════════════════════════════════════════════════════════

const COMPLEX_PATTERNS = [
  // Code task keywords
  /\b(코드|code|구현|implement|리팩터|refactor|빌드|build|deploy|배포|디버그|debug|fix|버그|수정|migration)\b/i,
  // File operations
  /\b(파일|file|디렉토리|directory|폴더|folder|생성|create|삭제|delete|수정|edit|변경|change|작성|write)\b/i,
  // Multi-step indicators
  /\b(그리고|그 다음|그런 다음|and then|after that|step\s*\d|단계)\b/i,
  // SSH / DB / server
  /\b(ssh|서버|server|데이터베이스|database|db|sql|docker|git|커밋|commit|push|pull)\b/i,
  // Attachments usually mean complex tasks
  /\.(ts|js|py|go|rs|java|tsx|jsx|json|yaml|yml|toml|sh|sql|csv)\b/i,
];

function selectModel(message: string, hasAttachments: boolean): { model: string; effort: string } {
  if (!ENABLE_MODEL_ROUTING) return { model: CLAUDE_MODEL, effort: CLAUDE_EFFORT };
  if (hasAttachments) return { model: CLAUDE_MODEL, effort: "high" };

  const isComplex = COMPLEX_PATTERNS.some((p) => p.test(message));
  const isLong = message.length > 500;

  if (isComplex || isLong) {
    return { model: CLAUDE_MODEL, effort: CLAUDE_EFFORT };
  }
  // Simple question/chat → lighter model
  return { model: CLAUDE_LIGHT_MODEL, effort: "low" };
}

// ═══════════════════════════════════════════════════════════════
// Error classification
// ═══════════════════════════════════════════════════════════════

type FailoverReason =
  | "session_expired"
  | "rate_limit"
  | "overloaded"
  | "timeout"
  | "auth"
  | "billing";

const SESSION_EXPIRED_PATTERNS = [
  "session not found", "session does not exist", "session expired",
  "session invalid", "invalid session", "no such session",
  "conversation not found", "session id not found", "already in use",
];
const RATE_LIMIT_PATTERNS = ["rate_limit", "rate limit", "429", "quota exceeded", "too many requests", "tokens per minute"];
const OVERLOADED_PATTERNS = ["overloaded", "high demand", "service_unavailable", "capacity"];
const TIMEOUT_PATTERNS = ["timeout", "timed out", "econnrefused", "econnreset", "socket hang up", "fetch failed"];
const AUTH_PATTERNS = ["invalid_api_key", "unauthorized", "api_key_revoked", "permission_error"];
const BILLING_PATTERNS = ["payment required", "402", "insufficient credits"];

function classifyError(text: string): FailoverReason | null {
  const lower = text.toLowerCase();
  const check = (patterns: string[]) => patterns.some((p) => lower.includes(p));
  if (check(SESSION_EXPIRED_PATTERNS)) return "session_expired";
  if (check(BILLING_PATTERNS)) return "billing";
  if (check(RATE_LIMIT_PATTERNS)) return "rate_limit";
  if (check(OVERLOADED_PATTERNS)) return "overloaded";
  if (check(AUTH_PATTERNS)) return "auth";
  if (check(TIMEOUT_PATTERNS)) return "timeout";
  return null;
}

// ═══════════════════════════════════════════════════════════════
// Session management
// ═══════════════════════════════════════════════════════════════

export interface Session {
  sessionId: string;
  isFirstTurn: boolean;
  lastActive: number;
}

const SESSION_FILE = join(dirname(import.meta.dir), "sessions.json");
const sessions = new Map<string, Session>();

function loadSessions(): void {
  try {
    const data: Record<string, Session> = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
    const now = Date.now();
    let loaded = 0;
    for (const [key, session] of Object.entries(data)) {
      if (now - session.lastActive < SESSION_TTL_MS) { sessions.set(key, session); loaded++; }
    }
    if (loaded > 0) console.log(`[Sessions] Restored ${loaded} session(s).`);
  } catch { /* first run or corrupt */ }
}

function saveSessions(): void {
  try {
    const obj: Record<string, Session> = {};
    for (const [key, s] of sessions) obj[key] = s;
    const tmp = SESSION_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, SESSION_FILE);
  } catch (e: any) { console.error(`[Sessions] Save failed: ${e.message}`); }
}

loadSessions();

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

export function clearSession(chatId: string): void { sessions.delete(chatId); lastHud.delete(chatId); saveSessions(); }

// ═══════════════════════════════════════════════════════════════
// HUD: per-chat context usage tracking
// ═══════════════════════════════════════════════════════════════

export interface HudInfo {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  totalTokens: number;
  contextPercent: number;   // 0–100
  turnNumber: number;
  durationSec: number;
}

const MAX_CONTEXT_TOKENS: Record<string, number> = {
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5": 200_000,
};
const DEFAULT_MAX_CONTEXT = 200_000;

const lastHud = new Map<string, HudInfo>();

function updateHud(chatId: string, result: ParsedResult, turnNumber: number): void {
  const maxCtx = MAX_CONTEXT_TOKENS[CLAUDE_MODEL] || DEFAULT_MAX_CONTEXT;
  const totalTokens = result.inputTokens + result.outputTokens;
  const contextPercent = Math.min(100, Math.round((result.inputTokens / maxCtx) * 100));
  lastHud.set(chatId, {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheRead: result.cacheRead,
    totalTokens,
    contextPercent,
    turnNumber,
    durationSec: result.durationMs ? Math.round(result.durationMs / 1000) : 0,
  });
}

export function getHudInfo(chatId: string): HudInfo | null {
  return lastHud.get(chatId) || null;
}

export function clearHud(chatId: string): void {
  lastHud.delete(chatId);
}

export function getSessionStats(): { active: number } {
  const now = Date.now();
  for (const [key] of sessions) {
    if (now - sessions.get(key)!.lastActive >= SESSION_TTL_MS) sessions.delete(key);
  }
  return { active: sessions.size };
}

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
// Message debouncer
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
  enqueueForChat(chatId, () => runClaude(chatId, combinedText, allAttachments))
    .then((result) => messages.forEach((m) => m.resolve(result)))
    .catch((err) => messages.forEach((m) => m.reject(err)));
}

export function askClaude(chatId: string, message: string, attachments?: string[]): Promise<string> {
  if ((attachments && attachments.length > 0) || DEBOUNCE_MS <= 0) {
    return enqueueForChat(chatId, () => runClaude(chatId, message, attachments));
  }
  return new Promise((resolve, reject) => {
    let buf = debounceBuffers.get(chatId);
    if (!buf) { buf = { messages: [], timer: null as any }; debounceBuffers.set(chatId, buf); }
    else { clearTimeout(buf.timer); }
    buf.messages.push({ text: message, attachments, resolve, reject });
    buf.timer = setTimeout(() => flushDebounce(chatId), DEBOUNCE_MS);
  });
}

// ═══════════════════════════════════════════════════════════════
// Active process tracking
// ═══════════════════════════════════════════════════════════════

const activeProcesses = new Set<ChildProcess>();

export function killActiveProcesses(): void {
  for (const proc of activeProcesses) { try { proc.kill("SIGTERM"); } catch {} }
  activeProcesses.clear();
}

// ═══════════════════════════════════════════════════════════════
// Stream-JSON event types from Claude CLI
// ═══════════════════════════════════════════════════════════════

interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: any;
  tool?: string;
  // result fields
  result?: string;
  is_error?: boolean;
  stop_reason?: string;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: any;
  duration_ms?: number;
}

// ═══════════════════════════════════════════════════════════════
// Progress callback for real-time status updates to Telegram
// ═══════════════════════════════════════════════════════════════

export interface ProgressInfo {
  type: "tool_use" | "tool_result" | "thinking" | "text_chunk";
  toolName?: string;
  text?: string;
  turnNumber: number;
}

// Exported so bot.ts can pass an onProgress callback
export type OnProgress = (info: ProgressInfo) => void;

// Overload askClaude to accept onProgress
export function askClaudeWithProgress(
  chatId: string,
  message: string,
  attachments?: string[],
  onProgress?: OnProgress
): Promise<string> {
  if ((attachments && attachments.length > 0) || DEBOUNCE_MS <= 0) {
    return enqueueForChat(chatId, () => runClaude(chatId, message, attachments, onProgress));
  }
  // Debounced path doesn't support progress (rare)
  return askClaude(chatId, message, attachments);
}

// ═══════════════════════════════════════════════════════════════
// Core CLI execution with stream-json parsing
// ═══════════════════════════════════════════════════════════════

function runClaude(chatId: string, message: string, attachments?: string[], onProgress?: OnProgress): Promise<string> {
  return runClaudeWithRetry(chatId, message, attachments, onProgress);
}

const RETRY_DELAYS: Record<string, number[]> = {
  session_expired: [0],       // 즉시 1회
  rate_limit: [10_000, 30_000, 60_000],  // 10s, 30s, 60s
  overloaded: [15_000, 45_000],          // 15s, 45s
  timeout: [5_000],                       // 5s 1회
};

async function runClaudeWithRetry(
  chatId: string, message: string, attachments?: string[], onProgress?: OnProgress
): Promise<string> {
  let lastError: any;

  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      return await executeClaudeCli(chatId, message, attachments, onProgress);
    } catch (err: any) {
      lastError = err;
      const reason = classifyError(err.message || "");

      if (!reason || !RETRY_DELAYS[reason]) {
        if (reason) err.failoverReason = reason;
        throw err;
      }

      const delays = RETRY_DELAYS[reason];
      if (attempt >= delays.length) {
        err.failoverReason = reason;
        throw err;
      }

      const delay = delays[attempt] ?? 0;
      console.log(`[Claude] ${reason} for chat=${chatId}, retry #${attempt + 1} in ${delay / 1000}s`);

      if (reason === "session_expired") {
        const session = sessions.get(chatId);
        if (session) { session.isFirstTurn = true; session.sessionId = randomUUID(); saveSessions(); }
      }

      if (delay > 0) await new Promise(r => setTimeout(r, delay));
    }
  }

  throw lastError;
}

function executeClaudeCli(
  chatId: string, message: string, attachments?: string[], onProgress?: OnProgress
): Promise<string> {
  const session = getSession(chatId);

  let fullPrompt = message;
  if (attachments && attachments.length > 0) {
    fullPrompt = `${message.trimEnd()}\n\n${attachments.join("\n")}`;
  }

  const useResume = !session.isFirstTurn;
  const hasAttachments = !!(attachments && attachments.length > 0);
  const routing = selectModel(message, hasAttachments);

  const baseArgs: string[] = [
    "-p", "--verbose",
    "--output-format", "stream-json",
    "--permission-mode", "bypassPermissions",
    "--effort", routing.effort,
  ];

  if (USE_BARE_MODE) baseArgs.push("--bare");
  if (ALLOWED_TOOLS) baseArgs.push("--tools", ALLOWED_TOOLS);

  // NOTE: --max-turns는 CLI에 존재하지 않음. 턴 제한은 stream-json 이벤트로 봇에서 직접 수행 (안전망)

  if (useResume) {
    baseArgs.push("--resume", session.sessionId);
  } else {
    baseArgs.push("--model", routing.model);
    baseArgs.push("--session-id", session.sessionId);
    if (SYSTEM_PROMPT) baseArgs.push("--append-system-prompt", SYSTEM_PROMPT);
  }

  console.log(`[Claude] Routing: model=${routing.model} effort=${routing.effort} resume=${useResume} chat=${chatId}`);

  const useStdin = fullPrompt.length > MAX_PROMPT_ARG_CHARS;
  if (!useStdin) baseArgs.splice(1, 0, fullPrompt);

  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_PATH, baseArgs, {
      env: { ...process.env, NO_COLOR: "1", TELEGRAM_BOT_TOKEN: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    activeProcesses.add(proc);

    if (proc.stdin) {
      if (useStdin) proc.stdin.write(fullPrompt);
      proc.stdin.end();
    }

    // ── Stream-JSON 실시간 파싱 ──
    // stdout을 줄 단위로 파싱하여:
    // 1. 활성 이벤트마다 lastActivityTime 갱신 (스마트 watchdog)
    // 2. tool_use 이벤트를 onProgress 콜백으로 전달 (텔레그램 진행 상황)
    // 3. result 이벤트를 직접 파싱하여 최종 결과 추출

    let rawStdout = "";
    let stderr = "";
    let lastActivityTime = Date.now();
    let lineBuffer = "";
    let turnNumber = 0;
    let resultEvent: StreamEvent | null = null;

    const processLine = (line: string) => {
      if (!line.trim()) return;
      lastActivityTime = Date.now();

      try {
        const event: StreamEvent = JSON.parse(line);

        if (event.type === "system" && event.subtype === "init") {
          // 세션 초기화 확인
          if (event.session_id) {
            session.sessionId = event.session_id;
          }
        }

        if (event.type === "assistant") {
          turnNumber++;

          // 턴 제한 (--max-turns가 CLI에 없으므로 봇에서 직접 제한)
          if (MAX_TURNS > 0 && turnNumber > MAX_TURNS) {
            console.warn(`[Claude] Max turns reached (${MAX_TURNS}) chat=${chatId}, killing process`);
            killProc(`max turns reached (${MAX_TURNS})`);
            return;
          }

          // tool_use 감지
          const msg = event.message;
          if (msg && typeof msg === "object") {
            const content = Array.isArray(msg.content) ? msg.content : [];
            for (const block of content) {
              if (block?.type === "tool_use" && block?.name) {
                console.log(`[Claude] 🔧 Tool: ${block.name} (turn ${turnNumber}) chat=${chatId}`);
                onProgress?.({ type: "tool_use", toolName: block.name, turnNumber });
              }
              if (block?.type === "text" && block?.text) {
                // 최종 텍스트 청크 (진행 상황에서는 보내지 않음, result에서 추출)
              }
            }
          }
        }

        if (event.type === "user") {
          // 도구 결과 반환 — Claude가 다음 단계 진행 중
          onProgress?.({ type: "tool_result", turnNumber });
        }

        if (event.type === "result") {
          resultEvent = event;
        }
      } catch {
        // JSON 파싱 실패 — partial line, 무시
      }
    };

    proc.stdout!.on("data", (data: Buffer) => {
      const chunk = data.toString();
      rawStdout += chunk;
      lastActivityTime = Date.now();

      // 줄 단위 파싱 (partial line 처리)
      lineBuffer += chunk;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || ""; // 마지막 불완전한 줄은 버퍼에 보관
      for (const line of lines) {
        processLine(line);
      }
    });

    proc.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString();
      lastActivityTime = Date.now();
    });

    // ── Timeout watchdog ──
    // 1. Overall timeout: 절대 상한 (기본 45분)
    // 2. Inactivity timeout: stdout/stderr 활동 없으면 kill (기본 10분)
    //    → 활동이 있으면 inactivity 타이머 리셋

    let overallTimer: ReturnType<typeof setTimeout> | null = null;
    let inactivityTimer: ReturnType<typeof setInterval> | null = null;
    let killedByWatchdog = false;
    let killReason = "";

    const killProc = (reason: string) => {
      killedByWatchdog = true;
      killReason = reason;
      console.warn(`[Claude] Kill: ${reason} chat=${chatId}`);
      try { proc.kill("SIGKILL"); } catch {}
    };

    if (TIMEOUT_MS > 0) {
      overallTimer = setTimeout(() => killProc(`overall timeout (${TIMEOUT_MS}ms)`), TIMEOUT_MS);
    }

    if (INACTIVITY_TIMEOUT_MS > 0) {
      inactivityTimer = setInterval(() => {
        const idle = Date.now() - lastActivityTime;
        if (idle >= INACTIVITY_TIMEOUT_MS) {
          killProc(`no output for ${Math.round(idle / 1000)}s`);
        }
      }, 30_000); // 30초마다 체크
    }

    const cleanup = () => {
      activeProcesses.delete(proc);
      if (overallTimer) clearTimeout(overallTimer);
      if (inactivityTimer) clearInterval(inactivityTimer);
    };

    proc.on("close", (code: number | null) => {
      cleanup();

      // 남은 버퍼 처리
      if (lineBuffer.trim()) processLine(lineBuffer);

      if (code === null) {
        console.error(`[Claude] exit=null (signal) chat=${chatId} killedByWatchdog=${killedByWatchdog} reason=${killReason}`);
        session.isFirstTurn = true;
        session.sessionId = randomUUID();
        saveSessions();

        // 타임아웃이라도 중간에 받은 텍스트가 있으면 살려서 전달
        if (killedByWatchdog) {
          const partialText = extractLastAssistantText(rawStdout);
          const elapsed = Math.round((Date.now() - lastActivityTime) / 1000);
          if (partialText && partialText.length > 50) {
            // 부분 응답 + 타임아웃 안내
            resolve(`${partialText}\n\n---\n⏱ _응답이 중간에 중단되었습니다 (${killReason}). 이어서 진행하려면 "계속" 이라고 보내주세요._`);
            return;
          }
          reject(new Error(
            `⏱ Claude 응답 시간 초과 (${killReason}, ${elapsed}s 무응답). 다시 시도해주세요.`
          ));
        } else {
          reject(new Error("Claude 프로세스가 예기치 않게 종료되었습니다. 다시 시도해주세요."));
        }
        return;
      }

      if (code !== 0) {
        console.error(`[Claude] exit=${code} stderr=${stderr.slice(0, 300)}`);
        // exit=1 + empty stderr → session lock/conflict or transient error
        // classify as session_expired to trigger retry with fresh session
        const errMsg = stderr.split("\n").filter(Boolean)[0]
          || "session not found";
        reject(new Error(errMsg));
        return;
      }

      try {
        // result 이벤트가 실시간 파싱으로 이미 잡혔으면 그것 사용
        // 없으면 전체 stdout에서 fallback 파싱
        const result = resultEvent
          ? parseResultEvent(resultEvent)
          : parseCliJson(rawStdout);

        if (result.isError) {
          reject(new Error(result.text || "Unknown Claude error"));
          return;
        }

        session.isFirstTurn = false;
        if (result.sessionId) session.sessionId = result.sessionId;
        session.lastActive = Date.now();
        saveSessions();

        console.log(
          `[Claude] chat=${chatId} turns=${turnNumber} in=${result.inputTokens} out=${result.outputTokens}` +
          `${result.cacheRead ? ` cache_read=${result.cacheRead}` : ""}` +
          ` cost=$${result.cost.toFixed(4)}` +
          ` duration=${result.durationMs ? Math.round(result.durationMs / 1000) + "s" : "?"}`
        );

        updateHud(chatId, result, turnNumber);
        resolve(result.text || "(empty response)");
      } catch (e: any) {
        console.error(`[Claude] Parse error: ${e.message} stdout_len=${rawStdout.length}`);
        // Fallback: 마지막 assistant 텍스트 추출 시도
        const fallback = extractLastAssistantText(rawStdout);
        if (fallback) {
          resolve(fallback);
        } else if (rawStdout.trim()) {
          resolve(rawStdout.trim().slice(0, 4000));
        } else {
          reject(new Error("Failed to parse Claude response"));
        }
      }
    });

    proc.on("error", (err: Error) => {
      cleanup();
      reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// Output parsing
// ═══════════════════════════════════════════════════════════════

interface ParsedResult {
  text: string;
  sessionId: string | null;
  isError: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cost: number;
  durationMs: number;
}

function collectText(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(collectText).join("");
  if (typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) return value.content.map(collectText).join("");
  if (value.message && typeof value.message === "object") return collectText(value.message);
  return "";
}

function pickSessionId(parsed: any): string | null {
  for (const field of ["session_id", "sessionId", "conversation_id", "conversationId"]) {
    const val = parsed[field];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return null;
}

function toUsage(raw: any): { input: number; output: number; cacheRead: number } {
  const pick = (key: string) => typeof raw[key] === "number" && raw[key] > 0 ? raw[key] : 0;
  return {
    input: pick("input_tokens") || pick("inputTokens"),
    output: pick("output_tokens") || pick("outputTokens"),
    cacheRead: pick("cache_read_input_tokens") || pick("cached_input_tokens") || pick("cacheRead"),
  };
}

// result 이벤트에서 직접 파싱 (stream-json 실시간 파싱 결과)
function parseResultEvent(event: StreamEvent): ParsedResult {
  const text = (
    collectText(event.result) ||
    collectText(event.message) ||
    collectText(event)
  ).trim();

  const sessionId = pickSessionId(event);
  const usage = event.usage ? toUsage(event.usage) : { input: 0, output: 0, cacheRead: 0 };

  let finalText = text;
  if (!finalText && (event.stop_reason === "max_turns" || event.stop_reason === "max_turns_reached")) {
    finalText = "⏳ 작업이 max-turns 한도에 도달했습니다. 계속 진행하려면 메시지를 보내주세요.";
  }
  if (!finalText && (event.num_turns ?? 0) > 1) {
    finalText = "✅ 작업을 완료했습니다. 결과를 확인하시거나 추가 요청을 보내주세요.";
  }

  return {
    text: finalText,
    sessionId,
    isError: event.is_error === true,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheRead: usage.cacheRead,
    cost: event.total_cost_usd || 0,
    durationMs: event.duration_ms || 0,
  };
}

// 전체 stdout에서 fallback 파싱 (실시간 파싱 실패 시)
function parseCliJson(raw: string): ParsedResult {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Empty CLI output");

  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split("\n");
    // type="result" 줄 찾기
    for (const line of lines) {
      try {
        const obj = JSON.parse(line.trim());
        if (obj.type === "result") { parsed = obj; break; }
      } catch { continue; }
    }
    // 마지막 줄 fallback
    if (!parsed) {
      for (let i = lines.length - 1; i >= 0; i--) {
        try { parsed = JSON.parse(lines[i]!.trim()); break; } catch { continue; }
      }
    }
  }

  if (!parsed) throw new Error("No valid JSON in CLI output");

  let text = (
    collectText(parsed.message) || collectText(parsed.content) ||
    collectText(parsed.result) || collectText(parsed)
  ).trim();

  const sessionId = pickSessionId(parsed);
  const usage = parsed.usage ? toUsage(parsed.usage) : { input: 0, output: 0, cacheRead: 0 };

  if (!text && (parsed.stop_reason === "max_turns" || parsed.stop_reason === "max_turns_reached")) {
    text = "⏳ 작업이 max-turns 한도에 도달했습니다. 계속 진행하려면 메시지를 보내주세요.";
  }
  if (!text && (parsed.num_turns ?? 0) > 1) {
    text = "✅ 작업을 완료했습니다. 결과를 확인하시거나 추가 요청을 보내주세요.";
  }

  return {
    text, sessionId,
    isError: parsed.is_error === true,
    inputTokens: usage.input, outputTokens: usage.output,
    cacheRead: usage.cacheRead, cost: parsed.total_cost_usd || 0,
    durationMs: parsed.duration_ms || 0,
  };
}

// stdout에서 마지막 assistant 텍스트 블록 추출 (파싱 실패 시 최후 수단)
function extractLastAssistantText(raw: string): string | null {
  const lines = raw.trim().split("\n");
  let lastText = "";
  for (const line of lines) {
    try {
      const obj = JSON.parse(line.trim());
      if (obj.type === "assistant" && obj.message?.content) {
        const content = Array.isArray(obj.message.content) ? obj.message.content : [];
        for (const block of content) {
          if (block?.type === "text" && block?.text) {
            lastText = block.text;
          }
        }
      }
    } catch { continue; }
  }
  return lastText || null;
}
