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
import { join } from "path";

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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

let workerServer: ReturnType<typeof Bun.serve> | null = null;
export function stopWorkerApi(): void { if (workerServer) { workerServer.stop(true); workerServer = null; } }

export function startWorkerApi(bot: Bot): void {
  workerServer = Bun.serve({
    port: WORKER_API_PORT, reusePort: true,
    async fetch(req) {
      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const url = new URL(req.url);

      const jsonRes = (data: any, status = 200) => Response.json(data, { status, headers: CORS_HEADERS });

      // Health check (with optional deep CLI auth check)
      if (url.pathname === "/health") {
        const deep = url.searchParams.get("deep") === "1";
        const botInfo = await bot.api.getMe().catch(() => null);
        const base = { ok: true, role: "worker", timestamp: Date.now(), pid: process.pid, botUsername: botInfo?.username || "unknown" };
        if (deep) {
          const cliOk = await checkCliAuth();
          const authInfo = await getAuthInfo();
          return jsonRes({ ...base, cliAuth: cliOk, authInfo });
        }
        return jsonRes(base);
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

      // 로그 조회: GET /logs?lines=100
      if (url.pathname === "/logs") {
        const lines = parseInt(url.searchParams.get("lines") || "100");
        try {
          const logPath = join(import.meta.dir, "..", "bot.log");
          const file = Bun.file(logPath);
          if (await file.exists()) {
            const text = await file.text();
            const allLines = text.split("\n");
            const tail = allLines.slice(-Math.min(lines, 500)).join("\n");
            return jsonRes({ ok: true, lines: tail, total: allLines.length });
          }
          return jsonRes({ ok: false, error: "bot.log not found" }, 404);
        } catch (e: any) {
          return jsonRes({ ok: false, error: e.message }, 500);
        }
      }

      // 명령 실행: POST /exec { secret, command, timeout? }
      if (url.pathname === "/exec" && req.method === "POST") {
        try {
          const body = await req.json() as any;
          if (body.secret !== RESTART_SECRET) return jsonRes({ ok: false, error: "unauthorized" }, 403);
          if (!body.command) return jsonRes({ ok: false, error: "command required" }, 400);

          const timeoutMs = Math.min(body.timeout || 30000, 60000);
          const proc = Bun.spawn(["bash", "-c", body.command], {
            cwd: join(import.meta.dir, ".."),
            env: { ...process.env, NO_COLOR: "1", PATH: `${process.env.HOME}/.bun/bin:${process.env.HOME}/.local/bin:${process.env.HOME}/.nvm/versions/node/v22.22.0/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH}` },
            stdout: "pipe",
            stderr: "pipe",
          });
          const timer = setTimeout(() => proc.kill(), timeoutMs);
          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          const code = await proc.exited;
          clearTimeout(timer);

          console.log(`[WorkerAPI] Exec: "${body.command.slice(0, 60)}" exit=${code}`);
          return jsonRes({ ok: code === 0, stdout: stdout.slice(0, 10000), stderr: stderr.slice(0, 5000), exitCode: code });
        } catch (e: any) {
          return jsonRes({ ok: false, error: e.message }, 500);
        }
      }

      // 최근 작업 내역: GET /recent-activity?count=10
      if (url.pathname === "/recent-activity") {
        try {
          const count = parseInt(url.searchParams.get("count") || "10");
          const logPath = join(import.meta.dir, "..", "bot.log");
          const file = Bun.file(logPath);
          if (!(await file.exists())) return jsonRes({ ok: true, activities: [] });

          const text = await file.text();
          const lines = text.split("\n");
          const activities: any[] = [];

          // Claude 세션 완료 로그 파싱: [Claude] chat=X turns=Y in=Z out=W cost=$C duration=Ds
          for (const line of lines) {
            const match = line.match(/\[Claude\] chat=(\S+) turns=(\d+) in=(\d+) out=(\d+).*cost=\$([0-9.]+).*duration=(\S+)/);
            if (match) {
              activities.push({
                chatId: match[1], turns: parseInt(match[2]),
                inputTokens: parseInt(match[3]), outputTokens: parseInt(match[4]),
                cost: parseFloat(match[5]), duration: match[6],
              });
            }
            // 위임 수신 로그
            const delegateMatch = line.match(/\[WorkerAPI\] Received delegate: "(.+?)"/);
            if (delegateMatch) {
              activities.push({ type: "delegate", message: delegateMatch[1] });
            }
          }

          return jsonRes({ ok: true, activities: activities.slice(-count) });
        } catch (e: any) {
          return jsonRes({ ok: false, error: e.message }, 500);
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
  const leadUrl = req.leadApiUrl || process.env.LEAD_API_URL;
  const botName = process.env.BOT_NAME || botUsername;

  // DB에 수신 메시지 저장
  reportMessage(leadUrl, { botName, botUsername, chatId, direction: "inbound", messageText: req.message });

  try {
    await bot.api.sendMessage(parseInt(chatId), `📥 @${botUsername} 작업 수신. 처리 중...`);

    const response = await askClaudeWithProgress(chatId, req.message);

    // DB에 응답 메시지 저장
    reportMessage(leadUrl, { botName, botUsername, chatId, direction: "outbound", messageText: response.slice(0, 10000) });

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

    // HUD + 세션 DB 저장
    const hud = getHudInfo(chatId);
    if (hud && hud.inputTokens > 0) {
      const pct = hud.contextPercent;
      const bar = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
      const hudText = `Context: ${bar} ${pct}% | Turn ${hud.turnNumber} | ${hud.durationSec}s`;
      try { await bot.api.sendMessage(parseInt(chatId), `<code>${escapeHtml(hudText)}</code>`, { parse_mode: "HTML" }); } catch {}

      // 세션 완료 보고
      reportSession(leadUrl, { botName, chatId, turns: hud.turnNumber, inputTokens: hud.inputTokens, outputTokens: hud.outputTokens, cacheRead: hud.cacheRead, totalCost: 0, durationSec: hud.durationSec });
    }

    console.log(`[WorkerAPI] Completed delegate for ${chatId}`);
  } catch (e: any) {
    console.error(`[WorkerAPI] Failed: ${e.message}`);
    try { await bot.api.sendMessage(parseInt(chatId), `⚠️ @${botUsername} 작업 실패: ${e.message}`); } catch {}
  } finally {
    notifyLeadIdle(botUsername, req.leadApiUrl, req.requestedBy).catch(() => {});
  }
}

/** Lead API에 메시지 보고 (비동기, 실패 무시) */
function reportMessage(leadUrl: string | undefined, data: any): void {
  const url = leadUrl || process.env.LEAD_API_URL;
  if (!url) return;
  fetch(`${url}/report-message`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data), signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

/** Lead API에 세션 완료 보고 (비동기, 실패 무시) */
function reportSession(leadUrl: string | undefined, data: any): void {
  const url = leadUrl || process.env.LEAD_API_URL;
  if (!url) return;
  fetch(`${url}/report-session`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data), signal: AbortSignal.timeout(5000),
  }).catch(() => {});
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

/** Claude CLI 인증 상세 정보 */
async function getAuthInfo(): Promise<any> {
  return new Promise((resolve) => {
    const proc = spawn(process.env.CLAUDE_PATH || "claude", ["auth", "status"], {
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} resolve(null); }, 10_000);
    proc.on("close", (code) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
    proc.on("error", () => { clearTimeout(timer); resolve(null); });
  });
}

/** 리드 봇에 idle 상태 보고 (requestedBy 포함 — 세션 어피니티용) */
async function notifyLeadIdle(workerName: string, leadApiUrl?: string, requestedBy?: string): Promise<void> {
  const leadUrl = leadApiUrl || process.env.LEAD_API_URL;
  if (!leadUrl) { console.warn("[WorkerAPI] No LEAD_API_URL"); return; }
  try {
    await fetch(`${leadUrl}/worker-idle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerName, requestedBy }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
}
