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

// Spawn claude -p with stream-json --verbose, wait for exit, parse all JSONL
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

  // Use stream-json --verbose to capture ALL assistant messages (not just final result)
  // This prevents empty responses when Claude ends with tool use and no final text
  const args: string[] = [
    "-p",
    fullPrompt,
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
        const result = parseStreamJsonOutput(stdout);

        if (result.isError) {
          reject(new Error(result.text || "Unknown Claude error"));
          return;
        }

        // Update session for resume
        session.isFirstTurn = false;
        if (result.sessionId) session.sessionId = result.sessionId;
        session.lastActive = Date.now();

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
        // Try to return raw text if JSON parsing fails
        if (stdout.trim()) {
          resolve(stdout.trim().slice(0, 4000));
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
// Collects text from ALL assistant messages, not just the final result field
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

  // Collect text from all assistant messages (in order)
  const assistantTexts: string[] = [];

  for (const line of lines) {
    let obj: any;
    try {
      obj = JSON.parse(line.trim());
    } catch {
      continue;
    }

    // Track session ID from any event
    if (!sessionId && obj.session_id) {
      sessionId = obj.session_id;
    }

    if (obj.type === "assistant" && obj.message?.content) {
      // Extract text from assistant message content blocks
      const text = extractAssistantText(obj.message.content);
      if (text) {
        assistantTexts.push(text);
      }
    }

    if (obj.type === "result") {
      // Final result event - has aggregated usage and cost
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

  // Priority: result field > longest assistant text > all assistant texts joined
  let text = resultText;

  if (!text && assistantTexts.length > 0) {
    // result was empty but we have assistant message texts
    // Pick the LONGEST text (most likely the actual analysis, not "let me check...")
    const longest = assistantTexts.reduce((a, b) =>
      a.length >= b.length ? a : b
    );
    // If the longest text is substantial (>100 chars), use it alone
    // Otherwise join all texts to avoid losing context
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

  // Fallback messages for edge cases
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
