/**
 * Worker API — HTTP 엔드포인트로 리드 봇의 작업 위임 수신
 *
 * Telegram 봇끼리 메시지를 주고받을 수 없으므로,
 * 리드 봇이 HTTP POST로 워커에 직접 작업을 전달합니다.
 */

import { askClaudeWithProgress, clearSession } from "./claude";
import { markdownToTelegramHtml, splitMessage } from "./format";
import { escapeHtml } from "./format";
import { getHudInfo } from "./claude";
import { Bot } from "grammy";
import { spawn } from "child_process";

const WORKER_API_PORT = parseInt(process.env.WORKER_API_PORT || "18800");
const RESTART_SECRET = process.env.RESTART_SECRET || "lemonclaw-restart-2024";

interface DelegateRequest {
  message: string;
  requestedBy: string;   // 요청자 Telegram chat ID
  taskId?: string;
  leadApiUrl?: string;
}

interface DelegateResponse {
  ok: boolean;
  taskId?: string;
  leadApiUrl?: string;
  error?: string;
}

export function startWorkerApi(bot: Bot): void {
  const server = Bun.serve({
    port: WORKER_API_PORT,
    async fetch(req) {
      const url = new URL(req.url);

      // Health check (with optional deep CLI auth check)
      if (url.pathname === "/health") {
        const deep = url.searchParams.get("deep") === "1";
        const base = { ok: true, role: "worker", timestamp: Date.now(), pid: process.pid };
        if (deep) {
          const cliOk = await checkCliAuth();
          return Response.json({ ...base, cliAuth: cliOk });
        }
        return Response.json(base);
      }

      // Restart: 세션 초기화 + 프로세스 재시작
      if (url.pathname === "/restart" && req.method === "POST") {
        try {
          const body = await req.json() as any;
          if (body.secret !== RESTART_SECRET) {
            return Response.json({ ok: false, error: "unauthorized" }, { status: 403 });
          }
          const reason = body.reason || "remote restart";
          console.log(`[WorkerAPI] Restart requested: ${reason}`);

          // 즉시 응답 후 재시작 (1초 딜레이)
          setTimeout(() => {
            console.log(`[WorkerAPI] Restarting process...`);
            process.exit(1); // pm2/supervisor가 자동 재시작
          }, 1000);

          return Response.json({ ok: true, message: "restarting in 1s", reason });
        } catch (e: any) {
          return Response.json({ ok: false, error: e.message }, { status: 500 });
        }
      }

      // Session reset: 세션만 초기화 (재시작 없이)
      if (url.pathname === "/reset-session" && req.method === "POST") {
        try {
          const body = await req.json() as any;
          if (body.secret !== RESTART_SECRET) {
            return Response.json({ ok: false, error: "unauthorized" }, { status: 403 });
          }
          const chatId = body.chatId || process.env.LEAD_BOT_CHAT_ID || "";
          if (chatId) clearSession(chatId);
          console.log(`[WorkerAPI] Session reset for chat=${chatId}`);
          return Response.json({ ok: true, message: "session reset", chatId });
        } catch (e: any) {
          return Response.json({ ok: false, error: e.message }, { status: 500 });
        }
      }

      // Delegate endpoint
      if (url.pathname === "/delegate" && req.method === "POST") {
        try {
          const body: DelegateRequest = await req.json();
          if (!body.message || !body.requestedBy) {
            return Response.json({ ok: false, error: "message and requestedBy required" }, { status: 400 });
          }

          console.log(`[WorkerAPI] Received delegate: "${body.message.slice(0, 60)}..." from ${body.requestedBy}`);

          // 비동기로 작업 시작 (즉시 응답)
          processDelegate(bot, body).catch(e =>
            console.error(`[WorkerAPI] Process error: ${e.message}`)
          );

          return Response.json({ ok: true, taskId: body.taskId || "quick" });
        } catch (e: any) {
          return Response.json({ ok: false, error: e.message }, { status: 500 });
        }
      }

      return new Response("Not found", { status: 404 });
    },
  });

  console.log(`[WorkerAPI] Listening on port ${WORKER_API_PORT}`);
}

async function processDelegate(bot: Bot, req: DelegateRequest): Promise<void> {
  const chatId = req.requestedBy;
  const botUsername = (await bot.api.getMe()).username || "worker";

  try {
    // 요청자에게 수신 확인
    await bot.api.sendMessage(parseInt(chatId), `📥 @${botUsername} 작업 수신. 처리 중...`);

    // Claude 실행
    const response = await askClaudeWithProgress(chatId, req.message);

    // 요청자에게 결과 DM 전송
    const header = `🤖 @${botUsername} 작업 완료:\n\n`;
    const chunks = splitMessage(header + response);
    for (const chunk of chunks) {
      const html = markdownToTelegramHtml(chunk);
      try {
        await bot.api.sendMessage(parseInt(chatId), html, { parse_mode: "HTML" });
      } catch {
        try { await bot.api.sendMessage(parseInt(chatId), chunk); } catch {}
      }
    }

    // HUD
    const hud = getHudInfo(chatId);
    if (hud && hud.inputTokens > 0) {
      const pct = hud.contextPercent;
      const bar = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
      const hudText = `Context: ${bar} ${pct}% | Turn ${hud.turnNumber} | ${hud.durationSec}s`;
      try {
        await bot.api.sendMessage(parseInt(chatId), `<code>${escapeHtml(hudText)}</code>`, { parse_mode: "HTML" });
      } catch {}
    }

    console.log(`[WorkerAPI] Completed delegate for ${chatId}`);
  } catch (e: any) {
    console.error(`[WorkerAPI] Failed: ${e.message}`);
    try {
      await bot.api.sendMessage(parseInt(chatId), `⚠️ @${botUsername} 작업 실패: ${e.message}`);
    } catch {}
  } finally {
    // 리드에 idle 보고 (완료/실패 상관없이)
    notifyLeadIdle(botUsername, req.leadApiUrl).catch(() => {});
  }
}

/** Claude CLI 인증 상태 확인 */
async function checkCliAuth(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(process.env.CLAUDE_PATH || "claude", ["--print", "--model", "claude-haiku-4-5-20251001", "--output-format", "text"], {
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} resolve(false); }, 15_000);
    proc.stdin?.write("ping");
    proc.stdin?.end();
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) { resolve(true); return; }
      resolve(!stderr.toLowerCase().includes("expired") && !stderr.toLowerCase().includes("unauthorized") && !stderr.toLowerCase().includes("401"));
    });
    proc.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

/** 리드 봇에 idle 상태 보고 */
async function notifyLeadIdle(workerName: string, leadApiUrl?: string): Promise<void> {
  const leadUrl = leadApiUrl || process.env.LEAD_API_URL;
  if (!leadUrl) { console.warn("[WorkerAPI] No LEAD_API_URL"); return; }
  try {
    await fetch(`${leadUrl}/worker-idle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerName }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
}
