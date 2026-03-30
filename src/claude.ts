import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { join, dirname } from "path";
import { readFileSync, writeFileSync, renameSync } from "fs";

import { APPROVAL_SYSTEM_PROMPT } from "./approval";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-6";
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || "3600000");
// MAX_TURNS: 0 or unset = no limit (CLI default). OpenClaw doesn't send --max-turns.
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "0");
const USER_SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || "";
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || "1200000"); // 20 min default
const MAX_PROMPT_ARG_CHARS = 100_000;
const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS || "1500"); // message batching window

const SYSTEM_PROMPT = [APPROVAL_SYSTEM_PROMPT, USER_SYSTEM_PROMPT]
  .filter(Boolean)
  .join("\n\n");

// ═══════════════════════════════════════════════════════════════
// Error classification (OpenClaw classifyFailoverReason pattern)
// ═══════════════════════════════════════════════════════════════

type FailoverReason =
  | "session_expired"
  | "rate_limit"
  | "overloaded"
  | "timeout"
  | "auth"
  | "billing";

const SESSION_EXPIRED_PATTERNS = [
  "session not found",
  "session does not exist",
  "session expired",
  "session invalid",
  "invalid session",
  "no such session",
  "conversation not found",
  "session id not found",
  "already in use",
];

const RATE_LIMIT_PATTERNS = [
  "rate_limit",
  "rate limit",
  "429",
  "quota exceeded",
  "too many requests",
  "tokens per minute",
];

const OVERLOADED_PATTERNS = [
  "overloaded",
  "high demand",
  "service_unavailable",
  "capacity",
];

const TIMEOUT_PATTERNS = [
  "timeout",
  "timed out",
  "econnrefused",
  "econnreset",
  "socket hang up",
  "fetch failed",
];

const AUTH_PATTERNS = [
  "invalid_api_key",
  "unauthorized",
  "api_key_revoked",
  "permission_error",
];

const BILLING_PATTERNS = ["payment required", "402", "insufficient credits"];

function classifyError(text: string): FailoverReason | null {
  const lower = text.toLowerCase();
  const check = (patterns: string[]) =>
    patterns.some((p) => lower.includes(p));
  if (check(SESSION_EXPIRED_PATTERNS)) return "session_expired";
  if (check(BILLING_PATTERNS)) return "billing";
  if (check(RATE_LIMIT_PATTERNS)) return "rate_limit";
  if (check(OVERLOADED_PATTERNS)) return "overloaded";
  if (check(AUTH_PATTERNS)) return "auth";
  if (check(TIMEOUT_PATTERNS)) return "timeout";
  return null;
}

// ═══════════════════════════════════════════════════════════════
// Session management (persistent, survives pm2 restart)
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
    const data: Record<string, Session> = JSON.parse(
      readFileSync(SESSION_FILE, "utf-8")
    );
    const now = Date.now();
    let loaded = 0;
    for (const [key, session] of Object.entries(data)) {
      if (now - session.lastActive < SESSION_TTL_MS) {
        sessions.set(key, session);
        loaded++;
      }
    }
    if (loaded > 0) console.log(`[Sessions] Restored ${loaded} session(s).`);
  } catch {
    /* first run or corrupt */
  }
}

function saveSessions(): void {
  try {
    const obj: Record<string, Session> = {};
    for (const [key, s] of sessions) obj[key] = s;
    const tmp = SESSION_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, SESSION_FILE);
  } catch (e: any) {
    console.error(`[Sessions] Save failed: ${e.message}`);
  }
}

loadSessions();

export function getSession(chatId: string): Session {
  const existing = sessions.get(chatId);
  if (existing && Date.now() - existing.lastActive < SESSION_TTL_MS) {
    existing.lastActive = Date.now();
    return existing;
  }
  const session: Session = {
    sessionId: randomUUID(),
    isFirstTurn: true,
    lastActive: Date.now(),
  };
  sessions.set(chatId, session);
  saveSessions();
  return session;
}

export function clearSession(chatId: string): void {
  sessions.delete(chatId);
  saveSessions();
}

export function getSessionStats(): { active: number } {
  const now = Date.now();
  for (const [key] of sessions) {
    if (now - sessions.get(key)!.lastActive >= SESSION_TTL_MS)
      sessions.delete(key);
  }
  return { active: sessions.size };
}

// ═══════════════════════════════════════════════════════════════
// Per-chat request queue (OpenClaw KeyedAsyncQueue)
// ═══════════════════════════════════════════════════════════════

const chatQueues = new Map<string, Promise<void>>();

function enqueueForChat<T>(
  chatId: string,
  task: () => Promise<T>
): Promise<T> {
  const prev = chatQueues.get(chatId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  const tail = next.then(
    () => {},
    () => {}
  );
  chatQueues.set(chatId, tail);
  tail.finally(() => {
    if (chatQueues.get(chatId) === tail) chatQueues.delete(chatId);
  });
  return next;
}

// ═══════════════════════════════════════════════════════════════
// Message debouncer (OpenClaw createInboundDebouncer)
// Batches rapid messages into a single prompt
// ═══════════════════════════════════════════════════════════════

interface PendingMessage {
  text: string;
  attachments?: string[];
  resolve: (v: string) => void;
  reject: (e: Error) => void;
}

const debounceBuffers = new Map<
  string,
  { messages: PendingMessage[]; timer: ReturnType<typeof setTimeout> }
>();

function flushDebounce(chatId: string): void {
  const buf = debounceBuffers.get(chatId);
  if (!buf || buf.messages.length === 0) return;
  debounceBuffers.delete(chatId);

  const messages = buf.messages;
  // Combine texts, collect all attachments
  const combinedText = messages.map((m) => m.text).join("\n\n");
  const allAttachments = messages.flatMap((m) => m.attachments ?? []);

  // All promises resolve/reject together
  enqueueForChat(chatId, () => runClaude(chatId, combinedText, allAttachments))
    .then((result) => messages.forEach((m) => m.resolve(result)))
    .catch((err) => messages.forEach((m) => m.reject(err)));
}

export function askClaude(
  chatId: string,
  message: string,
  attachments?: string[]
): Promise<string> {
  // Skip debounce for messages with attachments (OpenClaw policy)
  if ((attachments && attachments.length > 0) || DEBOUNCE_MS <= 0) {
    return enqueueForChat(chatId, () =>
      runClaude(chatId, message, attachments)
    );
  }

  return new Promise((resolve, reject) => {
    let buf = debounceBuffers.get(chatId);
    if (!buf) {
      buf = { messages: [], timer: null as any };
      debounceBuffers.set(chatId, buf);
    } else {
      clearTimeout(buf.timer);
    }
    buf.messages.push({ text: message, attachments, resolve, reject });
    buf.timer = setTimeout(() => flushDebounce(chatId), DEBOUNCE_MS);
  });
}

// ═══════════════════════════════════════════════════════════════
// Active process tracking
// ═══════════════════════════════════════════════════════════════

const activeProcesses = new Set<ChildProcess>();

export function killActiveProcesses(): void {
  for (const proc of activeProcesses) {
    try {
      proc.kill("SIGTERM");
    } catch {}
  }
  activeProcesses.clear();
}

// ═══════════════════════════════════════════════════════════════
// Core CLI execution (OpenClaw executeCliWithSession)
// ═══════════════════════════════════════════════════════════════

function runClaude(
  chatId: string,
  message: string,
  attachments?: string[]
): Promise<string> {
  return runClaudeWithRetry(chatId, message, attachments);
}

// Session-expired auto-retry (OpenClaw pattern: retry once without session)
async function runClaudeWithRetry(
  chatId: string,
  message: string,
  attachments?: string[]
): Promise<string> {
  try {
    return await executeClaudeCli(chatId, message, attachments);
  } catch (err: any) {
    const reason = classifyError(err.message || "");
    if (reason === "session_expired") {
      console.log(
        `[Claude] Session expired for chat=${chatId}, retrying with fresh session`
      );
      const session = sessions.get(chatId);
      if (session) {
        session.isFirstTurn = true;
        session.sessionId = randomUUID();
        saveSessions();
      }
      return await executeClaudeCli(chatId, message, attachments);
    }
    // Annotate error with classification for bot.ts
    if (reason) err.failoverReason = reason;
    throw err;
  }
}

function executeClaudeCli(
  chatId: string,
  message: string,
  attachments?: string[]
): Promise<string> {
  const session = getSession(chatId);

  // Build prompt (OpenClaw appendImagePathsToPrompt)
  let fullPrompt = message;
  if (attachments && attachments.length > 0) {
    fullPrompt = `${message.trimEnd()}\n\n${attachments.join("\n")}`;
  }

  // --- Build args (OpenClaw buildCliArgs) ---
  // Fresh: -p <prompt> --output-format json --permission-mode bypassPermissions
  //        --model <model> --max-turns <n> --session-id <uuid> --append-system-prompt <sp>
  // Resume: -p <prompt> --output-format json --permission-mode bypassPermissions
  //         --resume <sessionId>
  const useResume = !session.isFirstTurn;

  const baseArgs: string[] = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--permission-mode",
    "bypassPermissions",
  ];

  if (useResume) {
    baseArgs.push("--resume", session.sessionId);
  } else {
    baseArgs.push("--model", CLAUDE_MODEL);
    if (MAX_TURNS > 0) baseArgs.push("--max-turns", String(MAX_TURNS));
    baseArgs.push("--session-id", session.sessionId);
    if (SYSTEM_PROMPT) {
      baseArgs.push("--append-system-prompt", SYSTEM_PROMPT);
    }
  }

  // Prompt input: arg for short, stdin for long (OpenClaw resolvePromptInput)
  const useStdin = fullPrompt.length > MAX_PROMPT_ARG_CHARS;
  if (!useStdin) {
    baseArgs.splice(1, 0, fullPrompt); // insert after "-p"
  }

  return new Promise((resolve, reject) => {
    // OpenClaw: always pipe stdin (write empty + close when not using stdin for prompt)
    const proc = spawn(CLAUDE_PATH, baseArgs, {
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    activeProcesses.add(proc);

    // OpenClaw: always write to stdin then close
    if (proc.stdin) {
      if (useStdin) {
        proc.stdin.write(fullPrompt);
      }
      proc.stdin.end();
    }

    let stdout = "";
    let stderr = "";
    let lastOutputTime = Date.now();

    proc.stdout!.on("data", (data: Buffer) => {
      stdout += data.toString();
      lastOutputTime = Date.now();
    });

    proc.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString();
      lastOutputTime = Date.now();
    });

    // --- Timeout watchdog (OpenClaw createProcessSupervisor) ---
    let overallTimer: ReturnType<typeof setTimeout> | null = null;
    let noOutputTimer: ReturnType<typeof setInterval> | null = null;

    let killedByWatchdog = false;
    let killReason = "";

    const killProc = (reason: string) => {
      killedByWatchdog = true;
      killReason = reason;
      console.warn(`[Claude] Kill: ${reason} chat=${chatId}`);
      try {
        proc.kill("SIGKILL");
      } catch {}
    };

    if (TIMEOUT_MS > 0) {
      overallTimer = setTimeout(
        () => killProc(`overall timeout (${TIMEOUT_MS}ms)`),
        TIMEOUT_MS
      );

      // OpenClaw-aligned: fresh=80% of overall (min 300s, max 900s), resume=50% (min 180s, max 600s)
      const noOutputMs = useResume
        ? Math.max(180_000, Math.min(TIMEOUT_MS * 0.5, 600_000))
        : Math.max(300_000, Math.min(TIMEOUT_MS * 0.8, 900_000));

      noOutputTimer = setInterval(() => {
        if (Date.now() - lastOutputTime > noOutputMs) {
          killProc(`no output for ${Math.round(noOutputMs / 1000)}s`);
        }
      }, 10_000);
    }

    const cleanup = () => {
      activeProcesses.delete(proc);
      if (overallTimer) clearTimeout(overallTimer);
      if (noOutputTimer) clearInterval(noOutputTimer);
    };

    proc.on("close", (code: number | null) => {
      cleanup();

      // code === null means killed by signal (SIGKILL from watchdog)
      if (code === null) {
        console.error(`[Claude] exit=null (signal) chat=${chatId} killedByWatchdog=${killedByWatchdog} reason=${killReason}`);
        // Reset session so next attempt starts fresh (avoid "session already in use")
        session.isFirstTurn = true;
        session.sessionId = randomUUID();
        saveSessions();
        const msg = killedByWatchdog
          ? `⏱ Claude 응답 시간 초과 (${killReason}). 다시 시도해주세요.`
          : "Claude 프로세스가 예기치 않게 종료되었습니다. 다시 시도해주세요.";
        reject(new Error(msg));
        return;
      }

      if (code !== 0) {
        console.error(`[Claude] exit=${code} stderr=${stderr.slice(0, 300)}`);
        const errMsg =
          stderr.split("\n").filter(Boolean)[0] ||
          `Claude exited with code ${code}`;
        reject(new Error(errMsg));
        return;
      }

      try {
        const result = parseCliJson(stdout);

        if (result.isError) {
          reject(new Error(result.text || "Unknown Claude error"));
          return;
        }

        // Update session
        session.isFirstTurn = false;
        if (result.sessionId) session.sessionId = result.sessionId;
        session.lastActive = Date.now();
        saveSessions();

        console.log(
          `[Claude] chat=${chatId} in=${result.inputTokens} out=${result.outputTokens}` +
            `${result.cacheRead ? ` cache_read=${result.cacheRead}` : ""}` +
            ` cost=$${result.cost.toFixed(4)}`
        );

        resolve(result.text || "(empty response)");
      } catch (e: any) {
        console.error(
          `[Claude] Parse error: ${e.message} stdout=${stdout.slice(0, 500)}`
        );
        if (stdout.trim()) {
          resolve(stdout.trim().slice(0, 4000));
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
// Output parser (OpenClaw parseCliJson + collectText)
// ═══════════════════════════════════════════════════════════════

interface ParsedResult {
  text: string;
  sessionId: string | null;
  isError: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cost: number;
}

// OpenClaw collectText: recursively extract text from nested JSON
function collectText(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(collectText).join("");
  if (typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content))
    return value.content.map(collectText).join("");
  if (value.message && typeof value.message === "object")
    return collectText(value.message);
  return "";
}

// OpenClaw pickSessionId
function pickSessionId(parsed: any): string | null {
  for (const field of [
    "session_id",
    "sessionId",
    "conversation_id",
    "conversationId",
  ]) {
    const val = parsed[field];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return null;
}

// OpenClaw toUsage
function toUsage(raw: any): {
  input: number;
  output: number;
  cacheRead: number;
} {
  const pick = (key: string) =>
    typeof raw[key] === "number" && raw[key] > 0 ? raw[key] : 0;
  return {
    input: pick("input_tokens") || pick("inputTokens"),
    output: pick("output_tokens") || pick("outputTokens"),
    cacheRead:
      pick("cache_read_input_tokens") ||
      pick("cached_input_tokens") ||
      pick("cacheRead"),
  };
}

// OpenClaw parseCliJson: parse single JSON, extract text via collectText
function parseCliJson(raw: string): ParsedResult {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Empty CLI output");

  let parsed: any;

  // Try single JSON first
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Try JSONL: find type="result" line
    const lines = trimmed.split("\n");
    for (const line of lines) {
      try {
        const obj = JSON.parse(line.trim());
        if (obj.type === "result") {
          parsed = obj;
          break;
        }
      } catch {
        continue;
      }
    }
    // Last line fallback
    if (!parsed) {
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          parsed = JSON.parse(lines[i]!.trim());
          break;
        } catch {
          continue;
        }
      }
    }
  }

  if (!parsed) throw new Error("No valid JSON in CLI output");

  // OpenClaw text extraction: message → content → result → whole object
  let text = (
    collectText(parsed.message) ||
    collectText(parsed.content) ||
    collectText(parsed.result) ||
    collectText(parsed)
  ).trim();

  const sessionId = pickSessionId(parsed);
  const usage = parsed.usage ? toUsage(parsed.usage) : { input: 0, output: 0, cacheRead: 0 };

  // Fallback messages
  if (
    !text &&
    (parsed.stop_reason === "max_turns" ||
      parsed.stop_reason === "max_turns_reached")
  ) {
    text =
      "⏳ 작업이 max-turns 한도에 도달했습니다. 계속 진행하려면 메시지를 보내주세요.";
  }

  if (!text && (parsed.num_turns ?? 0) > 1) {
    text = "✅ 작업을 완료했습니다. 결과를 확인하시거나 추가 요청을 보내주세요.";
  }

  if (!text && usage.output > 0) {
    console.warn(
      `[Claude] Empty result with ${usage.output} output tokens, ` +
        `stop=${parsed.stop_reason} turns=${parsed.num_turns}`
    );
  }

  return {
    text,
    sessionId,
    isError: parsed.is_error === true,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheRead: usage.cacheRead,
    cost: parsed.total_cost_usd || 0,
  };
}
