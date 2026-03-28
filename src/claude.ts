import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { join, dirname } from "path";
import { readFileSync, writeFileSync, renameSync } from "fs";

import { APPROVAL_SYSTEM_PROMPT } from "./approval";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-6";
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || "3600000");
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "50");
const USER_SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || "";
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || "300000"); // 5 min default
const MAX_PROMPT_ARG_CHARS = 100_000; // Switch to stdin above this

// Combine approval protocol with user's custom system prompt
const SYSTEM_PROMPT = [APPROVAL_SYSTEM_PROMPT, USER_SYSTEM_PROMPT]
  .filter(Boolean)
  .join("\n\n");

// --- Session expired detection (OpenClaw patterns) ---
const SESSION_EXPIRED_PATTERNS = [
  "session not found",
  "session does not exist",
  "session expired",
  "session invalid",
  "invalid session",
  "no such session",
  "conversation not found",
];

function isSessionExpiredError(text: string): boolean {
  const lower = text.toLowerCase();
  return SESSION_EXPIRED_PATTERNS.some((p) => lower.includes(p));
}

// --- Types ---

export interface Session {
  sessionId: string;
  isFirstTurn: boolean;
  lastActive: number;
}

// --- Persistent session storage (survives pm2 restart) ---
const SESSION_FILE = join(dirname(import.meta.dir), "sessions.json");
const sessions = new Map<string, Session>();

function loadSessions(): void {
  try {
    const raw = readFileSync(SESSION_FILE, "utf-8");
    const data: Record<string, Session> = JSON.parse(raw);
    const now = Date.now();
    let loaded = 0;
    for (const [key, session] of Object.entries(data)) {
      if (now - session.lastActive < SESSION_TTL_MS) {
        sessions.set(key, session);
        loaded++;
      }
    }
    if (loaded > 0) {
      console.log(`[Sessions] Restored ${loaded} session(s) from disk.`);
    }
  } catch {
    // First run or corrupt file - start fresh
  }
}

function saveSessions(): void {
  try {
    const obj: Record<string, Session> = {};
    for (const [key, session] of sessions) {
      obj[key] = session;
    }
    // Atomic write: write to temp then rename
    const tmp = SESSION_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, SESSION_FILE);
  } catch (e: any) {
    console.error(`[Sessions] Failed to save: ${e.message}`);
  }
}

// Load sessions on startup
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
  for (const [key, session] of sessions) {
    if (now - session.lastActive >= SESSION_TTL_MS) {
      sessions.delete(key);
    }
  }
  return { active: sessions.size };
}

// --- Per-chat request queue (OpenClaw KeyedAsyncQueue pattern) ---
// Serializes Claude calls per chatId to prevent concurrent session access

const chatQueues = new Map<string, Promise<void>>();

function enqueueForChat<T>(chatId: string, task: () => Promise<T>): Promise<T> {
  const prev = chatQueues.get(chatId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  const tail = next.then(
    () => {},
    () => {}
  );
  chatQueues.set(chatId, tail);
  tail.finally(() => {
    if (chatQueues.get(chatId) === tail) {
      chatQueues.delete(chatId);
    }
  });
  return next;
}

// --- Active process tracking (for graceful shutdown) ---

const activeProcesses = new Set<ChildProcess>();

export function killActiveProcesses(): void {
  for (const proc of activeProcesses) {
    try {
      proc.kill("SIGTERM");
    } catch {}
  }
  activeProcesses.clear();
}

// --- Main API ---

export function askClaude(
  chatId: string,
  message: string,
  attachments?: string[]
): Promise<string> {
  // Serialize requests per chat to prevent concurrent session corruption
  return enqueueForChat(chatId, () =>
    runClaude(chatId, message, attachments)
  );
}

function runClaude(
  chatId: string,
  message: string,
  attachments?: string[]
): Promise<string> {
  const session = getSession(chatId);

  // Build prompt with attachments
  let fullPrompt = message;
  if (attachments && attachments.length > 0) {
    fullPrompt = `${message}\n\n${attachments.join("\n")}`;
  }

  // Build args: use stream-json --verbose to capture all assistant messages
  const args: string[] = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    CLAUDE_MODEL,
    "--max-turns",
    String(MAX_TURNS),
    "--permission-mode",
    "bypassPermissions",
  ];

  if (session.isFirstTurn) {
    args.push("--session-id", session.sessionId);
    args.push("--append-system-prompt", SYSTEM_PROMPT);
  } else {
    args.push("--resume", session.sessionId);
  }

  // Prompt input: arg for short prompts, stdin for long (OpenClaw resolvePromptInput)
  const useStdin = fullPrompt.length > MAX_PROMPT_ARG_CHARS;
  if (!useStdin) {
    // Insert prompt right after "-p"
    args.splice(1, 0, fullPrompt);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_PATH, args, {
      env: { ...process.env, NO_COLOR: "1" },
      stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
    });

    activeProcesses.add(proc);

    // Write long prompts to stdin then close (OpenClaw pattern)
    if (useStdin && proc.stdin) {
      proc.stdin.write(fullPrompt);
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

    // Manual timeout (spawn() doesn't support timeout option)
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let noOutputTimer: ReturnType<typeof setInterval> | null = null;

    const killProc = (reason: string) => {
      console.warn(`[Claude] Killing process: ${reason} chat=${chatId}`);
      try {
        proc.kill("SIGTERM");
        // Force kill after 5s if still alive
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {}
        }, 5000);
      } catch {}
    };

    if (TIMEOUT_MS > 0) {
      // Overall timeout
      timeoutTimer = setTimeout(() => {
        killProc(`overall timeout (${TIMEOUT_MS}ms)`);
      }, TIMEOUT_MS);

      // No-output timeout: kill if no stdout/stderr for 3 minutes
      // (OpenClaw: 80% of overall for fresh, 30% for resume, min 1-3 min)
      const noOutputMs = session.isFirstTurn
        ? Math.min(TIMEOUT_MS * 0.8, 600_000)
        : Math.min(TIMEOUT_MS * 0.3, 180_000);

      noOutputTimer = setInterval(() => {
        if (Date.now() - lastOutputTime > noOutputMs) {
          killProc(`no output for ${Math.round(noOutputMs / 1000)}s`);
        }
      }, 10_000);
    }

    const cleanup = () => {
      activeProcesses.delete(proc);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (noOutputTimer) clearInterval(noOutputTimer);
    };

    proc.on("close", (code: number | null) => {
      cleanup();

      if (code !== 0) {
        console.error(`[Claude] exit=${code} stderr=${stderr.slice(0, 300)}`);
        // Reset session on session-expired errors (OpenClaw specific patterns)
        if (isSessionExpiredError(stderr)) {
          console.log(`[Claude] Session expired, resetting for chat=${chatId}`);
          session.isFirstTurn = true;
          session.sessionId = randomUUID();
          saveSessions();
        }
        const errMsg =
          stderr.split("\n").filter(Boolean)[0] ||
          `Claude exited with code ${code}`;
        reject(new Error(errMsg));
        return;
      }

      try {
        const result = parseStreamJsonOutput(stdout);

        if (result.isError) {
          reject(new Error(result.text || "Unknown Claude error"));
          return;
        }

        // Update session for resume and persist to disk
        session.isFirstTurn = false;
        if (result.sessionId) session.sessionId = result.sessionId;
        session.lastActive = Date.now();
        saveSessions();

        console.log(
          `[Claude] chat=${chatId} in=${result.inputTokens} out=${result.outputTokens}` +
            ` ${result.cacheRead ? `cache_read=${result.cacheRead} ` : ""}` +
            `cost=$${result.cost.toFixed(4)}`
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

// --- Stream-JSON JSONL Parser ---

interface ParsedResult {
  text: string;
  sessionId: string | null;
  isError: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cost: number;
}

// Extract text blocks from assistant message content array
function extractAssistantText(content: any[]): string {
  const textParts: string[] = [];
  for (const block of content) {
    if (block && typeof block.text === "string") {
      textParts.push(block.text);
    }
  }
  return textParts.join("\n");
}

// Parse stream-json --verbose JSONL output
function parseStreamJsonOutput(raw: string): ParsedResult {
  const lines = raw.trim().split("\n");

  let sessionId: string | null = null;
  let isError = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cost = 0;
  let resultText = "";
  let stopReason = "";
  let numTurns = 0;

  const assistantTexts: string[] = [];

  for (const line of lines) {
    let obj: any;
    try {
      obj = JSON.parse(line.trim());
    } catch {
      continue;
    }

    if (!sessionId && obj.session_id) {
      sessionId = obj.session_id;
    }

    if (obj.type === "assistant" && obj.message?.content) {
      const text = extractAssistantText(obj.message.content);
      if (text) {
        assistantTexts.push(text);
      }
    }

    if (obj.type === "result") {
      resultText = (typeof obj.result === "string" ? obj.result : "").trim();
      isError = obj.is_error === true;
      stopReason = obj.stop_reason || "";
      numTurns = obj.num_turns || 0;
      cost = obj.total_cost_usd || 0;
      sessionId = obj.session_id || sessionId;

      if (obj.usage) {
        inputTokens = obj.usage.input_tokens || 0;
        outputTokens = obj.usage.output_tokens || 0;
        cacheRead = obj.usage.cache_read_input_tokens || 0;
      }
    }
  }

  // Priority: result field > longest assistant text > all joined
  let text = resultText;

  if (!text && assistantTexts.length > 0) {
    const longest = assistantTexts.reduce((a, b) =>
      a.length >= b.length ? a : b
    );
    if (longest.length > 100) {
      text = longest;
    } else {
      text = assistantTexts.join("\n\n");
    }
    console.log(
      `[Claude] Using assistant text (result was empty). ` +
        `${assistantTexts.length} msgs, picked ${text.length} chars ` +
        `(longest=${longest.length}).`
    );
  }

  if (
    !text &&
    (stopReason === "max_turns" || stopReason === "max_turns_reached")
  ) {
    text =
      "⏳ 작업이 max-turns 한도에 도달했습니다. /new 로 새 대화를 시작하거나, 계속 진행하려면 메시지를 보내주세요.";
  }

  if (!text && numTurns > 1) {
    text = "✅ 작업을 완료했습니다. 결과를 확인하시거나 추가 요청을 보내주세요.";
  }

  if (!text && outputTokens > 0) {
    console.warn(
      `[Claude] Empty result with ${outputTokens} output tokens. ` +
        `stop_reason=${stopReason} num_turns=${numTurns} ` +
        `assistant_texts=${assistantTexts.length}`
    );
    text =
      "⚠️ 응답이 생성되었으나 텍스트 추출에 실패했습니다. 다시 시도하거나 /new 로 새 대화를 시작해주세요.";
  }

  return {
    text,
    sessionId,
    isError,
    inputTokens,
    outputTokens,
    cacheRead,
    cost,
  };
}
