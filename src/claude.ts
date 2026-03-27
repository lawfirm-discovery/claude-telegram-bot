import { spawn } from "child_process";

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
  };
}

export interface Session {
  sessionId: string | null;
  lastActive: number;
  history: Array<{ role: "user" | "assistant"; content: string }>;
}

const sessions = new Map<string, Session>();

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || "20");
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || "3600000");

export function getSession(chatId: string): Session {
  const existing = sessions.get(chatId);
  if (existing && Date.now() - existing.lastActive < SESSION_TTL_MS) {
    existing.lastActive = Date.now();
    return existing;
  }
  const session: Session = {
    sessionId: null,
    lastActive: Date.now(),
    history: [],
  };
  sessions.set(chatId, session);
  return session;
}

export function clearSession(chatId: string): void {
  sessions.delete(chatId);
}

export function getSessionStats(): { active: number; total: number } {
  const now = Date.now();
  let active = 0;
  for (const [key, session] of sessions) {
    if (now - session.lastActive < SESSION_TTL_MS) {
      active++;
    } else {
      sessions.delete(key);
    }
  }
  return { active, total: sessions.size };
}

export async function askClaude(
  chatId: string,
  message: string
): Promise<string> {
  const session = getSession(chatId);

  const args: string[] = [
    "-p",
    message,
    "--output-format",
    "json",
    "--model",
    CLAUDE_MODEL,
    "--max-turns",
    "3",
  ];

  // Resume existing session for conversation continuity
  if (session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_PATH, args, {
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 120_000,
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
        console.error(`[Claude] exit code ${code}, stderr: ${stderr}`);
        reject(new Error(`Claude exited with code ${code}: ${stderr}`));
        return;
      }

      try {
        // Handle streaming JSON (multiple JSON objects)
        const lines = stdout.trim().split("\n");
        let response: ClaudeResponse | null = null;

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "result" || parsed.result !== undefined) {
              response = parsed;
            }
          } catch {
            // Skip non-JSON lines
          }
        }

        if (!response) {
          // Try parsing entire stdout as single JSON
          response = JSON.parse(stdout);
        }

        if (response!.is_error) {
          reject(new Error(`Claude error: ${response!.result}`));
          return;
        }

        const resultText = response!.result || "";

        // Update session
        session.sessionId = response!.session_id;
        session.lastActive = Date.now();
        session.history.push(
          { role: "user", content: message },
          { role: "assistant", content: resultText }
        );

        // Trim history
        if (session.history.length > MAX_HISTORY * 2) {
          session.history = session.history.slice(-MAX_HISTORY * 2);
        }

        console.log(
          `[Claude] chat=${chatId} tokens_in=${response!.usage?.input_tokens} tokens_out=${response!.usage?.output_tokens} cost=$${response!.total_cost_usd?.toFixed(4)}`
        );

        resolve(resultText || "(empty response)");
      } catch (e) {
        console.error(`[Claude] Failed to parse response: ${stdout}`);
        reject(new Error("Failed to parse Claude response"));
      }
    });

    proc.on("error", (err: Error) => {
      reject(new Error(`Failed to spawn Claude: ${err.message}`));
    });
  });
}
