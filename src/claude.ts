import { spawn } from "child_process";
import { randomUUID } from "crypto";

import { APPROVAL_SYSTEM_PROMPT } from "./approval";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-6";
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || "3600000");
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "50");
const USER_SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || "";
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || "0"); // 0 = no timeout

// Combine approval protocol with user's custom system prompt
const SYSTEM_PROMPT = [APPROVAL_SYSTEM_PROMPT, USER_SYSTEM_PROMPT]
  .filter(Boolean)
  .join("\n\n");

export interface Session {
  sessionId: string;
  isFirstTurn: boolean;
  lastActive: number;
}

const sessions = new Map<string, Session>();

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
  return session;
}

export function clearSession(chatId: string): void {
  sessions.delete(chatId);
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

// OpenClaw-style batch execution: spawn claude -p, wait for exit, parse result
export function askClaude(
  chatId: string,
  message: string,
  attachments?: string[]
): Promise<string> {
  const session = getSession(chatId);

  // Build prompt with attachments (OpenClaw style: append paths to prompt)
  let fullPrompt = message;
  if (attachments && attachments.length > 0) {
    fullPrompt = `${message}\n\n${attachments.join("\n")}`;
  }

  // Build args matching OpenClaw's claude-cli backend:
  // args: ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions"]
  // resumeArgs: ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions", "--resume", "{sessionId}"]
  const args: string[] = [
    "-p",
    fullPrompt,
    "--output-format",
    "json",
    "--model",
    CLAUDE_MODEL,
    "--max-turns",
    String(MAX_TURNS),
    "--permission-mode",
    "bypassPermissions",
  ];

  if (session.isFirstTurn) {
    // First turn: create a named session + inject approval system prompt
    args.push("--session-id", session.sessionId);
    args.push("--append-system-prompt", SYSTEM_PROMPT);
  } else {
    // Subsequent turns: resume (OpenClaw uses resumeArgs with {sessionId} replacement)
    args.push("--resume", session.sessionId);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_PATH, args, {
      env: { ...process.env, NO_COLOR: "1" },
      timeout: TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code: number | null) => {
      if (code !== 0) {
        console.error(`[Claude] exit=${code} stderr=${stderr.slice(0, 300)}`);
        // Reset session on resume errors
        if (
          stderr.includes("session") ||
          stderr.includes("resume") ||
          stderr.includes("not found")
        ) {
          session.isFirstTurn = true;
          session.sessionId = randomUUID();
        }
        const errMsg =
          stderr.split("\n").filter(Boolean)[0] ||
          `Claude exited with code ${code}`;
        reject(new Error(errMsg));
        return;
      }

      try {
        // OpenClaw parseCliOutput: parse JSONL, look for type:"result"
        const result = parseClaudeOutput(stdout);

        if (result.isError) {
          reject(new Error(result.text || "Unknown Claude error"));
          return;
        }

        // Update session for resume
        session.isFirstTurn = false;
        if (result.sessionId) session.sessionId = result.sessionId;
        session.lastActive = Date.now();

        console.log(
          `[Claude] chat=${chatId} in=${result.inputTokens} out=${result.outputTokens} cost=$${result.cost.toFixed(4)}`
        );

        resolve(result.text || "(empty response)");
      } catch (e: any) {
        console.error(
          `[Claude] Parse error: ${e.message} stdout=${stdout.slice(0, 300)}`
        );
        // Try to return raw text if JSON parsing fails
        if (stdout.trim()) {
          resolve(stdout.trim());
        } else {
          reject(new Error("Failed to parse Claude response"));
        }
      }
    });

    proc.on("error", (err: Error) => {
      reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
    });
  });
}

// OpenClaw-compatible output parser
// Handles both single JSON and JSONL (newline-delimited JSON) output
interface ParsedResult {
  text: string;
  sessionId: string | null;
  isError: boolean;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

// OpenClaw collectText: recursively extract text from nested JSON structures
function collectText(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map((entry) => collectText(entry)).join("");
  if (typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content))
    return value.content.map((entry: any) => collectText(entry)).join("");
  if (
    typeof value.message === "object" &&
    value.message !== null &&
    !Array.isArray(value.message)
  )
    return collectText(value.message);
  return "";
}

function parseClaudeOutput(raw: string): ParsedResult {
  const trimmed = raw.trim();

  // Try single JSON first (OpenClaw parseCliJson)
  try {
    const obj = JSON.parse(trimmed);
    return extractResult(obj);
  } catch {
    // Not single JSON, try JSONL
  }

  // Parse JSONL: look for type:"result" line (OpenClaw parseCliJsonl)
  const lines = trimmed.split("\n");
  let fallbackSessionId: string | null = null;
  let fallbackUsage: any = null;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line.trim());
      // Collect session ID from any line
      if (!fallbackSessionId) {
        fallbackSessionId =
          obj.session_id || obj.sessionId || obj.conversation_id || null;
      }
      if (obj.usage) fallbackUsage = obj.usage;
      if (obj.type === "result") {
        return extractResult(obj);
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  // Last resort: try last JSON line
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]!.trim());
      return extractResult(obj);
    } catch {
      continue;
    }
  }

  throw new Error("No valid JSON result found in Claude output");
}

function extractResult(obj: any): ParsedResult {
  // OpenClaw parseCliJson approach: try multiple fields with || (not ??)
  // || falls through on empty strings, ?? does not
  let text = (
    collectText(obj.message) ||
    collectText(obj.content) ||
    collectText(obj.result) ||
    collectText(obj)
  ).trim();

  // When stop_reason is "max_turns_reached", Claude ran out of turns
  if (
    !text &&
    (obj.stop_reason === "max_turns" ||
      obj.stop_reason === "max_turns_reached")
  ) {
    text =
      "⏳ 작업이 max-turns 한도에 도달했습니다. /new 로 새 대화를 시작하거나, 계속 진행하려면 메시지를 보내주세요.";
  }

  // When result is empty but Claude clearly did work (tool use),
  // provide a meaningful fallback (relaxed: any num_turns, any stop_reason)
  if (!text && (obj.num_turns ?? 0) > 1) {
    text = "✅ 작업을 완료했습니다. 결과를 확인하시거나 추가 요청을 보내주세요.";
  }

  // Final fallback: if still empty and there were output tokens, log for debugging
  if (!text && (obj.usage?.output_tokens ?? 0) > 0) {
    console.warn(
      `[Claude] Empty result with ${obj.usage?.output_tokens} output tokens. ` +
        `stop_reason=${obj.stop_reason} num_turns=${obj.num_turns} ` +
        `keys=${Object.keys(obj).join(",")}`
    );
    text =
      "⚠️ 응답이 생성되었으나 텍스트 추출에 실패했습니다. 다시 시도하거나 /new 로 새 대화를 시작해주세요.";
  }

  const sessionId =
    obj.session_id || obj.sessionId || obj.conversation_id || null;

  return {
    text,
    sessionId,
    isError: obj.is_error === true,
    inputTokens: obj.usage?.input_tokens || 0,
    outputTokens: obj.usage?.output_tokens || 0,
    cost: obj.total_cost_usd || 0,
  };
}
