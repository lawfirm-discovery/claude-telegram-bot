import { spawn } from "child_process";
import { randomUUID } from "crypto";

export interface ClaudeResponse {
  type: string;
  subtype: string;
  is_error: boolean;
  result: string;
  session_id: string;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface Session {
  sessionId: string;
  isFirstTurn: boolean;
  lastActive: number;
}

const sessions = new Map<string, Session>();

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-6";
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || "3600000");
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "5");
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || "";
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || "180000");

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

export function getSessionStats(): {
  active: number;
  sessions: Map<string, Session>;
} {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now - session.lastActive >= SESSION_TTL_MS) {
      sessions.delete(key);
    }
  }
  return { active: sessions.size, sessions };
}

export async function askClaude(
  chatId: string,
  message: string,
  attachments?: string[]
): Promise<string> {
  const session = getSession(chatId);

  // Build prompt with file attachments (OpenClaw style)
  let fullPrompt = message;
  if (attachments && attachments.length > 0) {
    fullPrompt = `${message}\n\n${attachments.join("\n")}`;
  }

  // Build args matching OpenClaw's claude-cli backend
  const args: string[] = [
    "-p",
    fullPrompt,
    "--output-format",
    "json",
    "--permission-mode",
    "bypassPermissions",
    "--model",
    CLAUDE_MODEL,
    "--max-turns",
    String(MAX_TURNS),
  ];

  if (session.isFirstTurn) {
    // First turn: use --session-id to create a named session
    args.push("--session-id", session.sessionId);
    if (SYSTEM_PROMPT) {
      args.push("--append-system-prompt", SYSTEM_PROMPT);
    }
  } else {
    // Subsequent turns: resume the existing session
    args.push("--resume", session.sessionId);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_PATH, args, {
      env: { ...process.env, NO_COLOR: "1" },
      timeout: TIMEOUT_MS,
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
        console.error(`[Claude] exit=${code} stderr=${stderr}`);
        // On error, try fresh session next time
        if (stderr.includes("session") || stderr.includes("resume")) {
          session.isFirstTurn = true;
          session.sessionId = randomUUID();
        }
        reject(
          new Error(stderr.split("\n")[0] || `Claude exited with code ${code}`)
        );
        return;
      }

      try {
        // Parse response - handle both single JSON and NDJSON
        let response: ClaudeResponse | null = null;
        const lines = stdout.trim().split("\n");

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "result") {
              response = parsed;
              break;
            }
          } catch {
            // Skip non-JSON lines
          }
        }

        if (!response) {
          response = JSON.parse(stdout);
        }

        if (response!.is_error) {
          reject(new Error(response!.result || "Unknown Claude error"));
          return;
        }

        const resultText = response!.result || "";

        // Mark session as resumed for future calls
        session.isFirstTurn = false;
        session.sessionId = response!.session_id || session.sessionId;
        session.lastActive = Date.now();

        const usage = response!.usage;
        console.log(
          `[Claude] chat=${chatId} in=${usage?.input_tokens || 0} out=${usage?.output_tokens || 0} cache_read=${usage?.cache_read_input_tokens || 0} cost=$${(response!.total_cost_usd || 0).toFixed(4)}`
        );

        resolve(resultText || "(empty response)");
      } catch (e) {
        console.error(`[Claude] parse error, stdout=${stdout.slice(0, 500)}`);
        reject(new Error("Failed to parse Claude response"));
      }
    });

    proc.on("error", (err: Error) => {
      reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
    });
  });
}
