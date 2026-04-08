/**
 * Worker API — HTTP 엔드포인트로 리드 봇의 작업 위임 수신
 *
 * Telegram 봇끼리 메시지를 주고받을 수 없으므로,
 * 리드 봇이 HTTP POST로 워커에 직접 작업을 전달합니다.
 */

import { askClaudeWithProgress, clearSession } from "./claude-engine";
import { markdownToTelegramHtml, splitMessage } from "./format";
import { escapeHtml } from "./format";
import { getHudInfo } from "./claude-engine";
import { formatBuildInfo } from "./build-info";
import {
  detectApprovalRequest,
  getApprovalEmoji,
  getApprovalLabel,
  type ApprovalRequest,
} from "./approval";
import { Bot, InlineKeyboard } from "grammy";
import { spawn } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { writeFile, unlink } from "fs/promises";

// Pending approval requests for delegated tasks
const pendingDelegateApprovals = new Map<
  string,
  { chatId: string; request: ApprovalRequest; bot: Bot; leadUrl?: string; botName: string; botUsername: string }
>();

const WORKER_API_PORT = parseInt(process.env.WORKER_API_PORT || "18800");
const RESTART_SECRET = process.env.RESTART_SECRET || "lemonclaw-restart-2024";

interface DelegateAttachment {
  file_id: string;
  type: "photo" | "document" | "voice";
  filename?: string;
  data?: string; // base64-encoded file content (리드가 직접 다운로드하여 전달)
}

interface DelegateRequest {
  message: string;
  requestedBy: string;   // 요청자 Telegram chat ID
  taskId?: string;
  leadApiUrl?: string;
  attachments?: DelegateAttachment[];
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

  // 첨부파일 처리: base64 data 우선, 없으면 file_id로 폴백
  const localFiles: string[] = [];
  if (req.attachments?.length) {
    for (const att of req.attachments) {
      try {
        const ext = att.filename?.split(".").pop() || (att.type === "photo" ? "jpg" : att.type === "voice" ? "ogg" : "bin");
        const tmpPath = join(tmpdir(), `tg_delegate_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`);

        if (att.data) {
          // base64로 전달된 파일 (리드가 직접 다운로드한 경우)
          const buf = Buffer.from(att.data, "base64");
          await writeFile(tmpPath, buf);
          localFiles.push(tmpPath);
        } else {
          // file_id로 폴백 (같은 봇이거나 레거시 호환)
          const file = await bot.api.getFile(att.file_id);
          const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
          const resp = await fetch(fileUrl);
          const buf = Buffer.from(await resp.arrayBuffer());
          await writeFile(tmpPath, buf);
          localFiles.push(tmpPath);
        }
      } catch (e: any) {
        console.error(`[WorkerAPI] Failed to process attachment ${att.file_id}: ${e.message}`);
        await bot.api.sendMessage(parseInt(chatId), `⚠️ 첨부파일 다운로드 실패: ${e.message}`).catch(() => {});
      }
    }
  }

  try {
    await bot.api.sendMessage(parseInt(chatId), `📥 @${botUsername} 작업 수신. 처리 중...`);

    // 첨부파일 경로를 메시지에 포함
    const msgWithFiles = localFiles.length
      ? `${req.message}\n\n${localFiles.map(f => `[첨부파일: ${f}]`).join("\n")}`
      : req.message;
    const response = await askClaudeWithProgress(chatId, msgWithFiles);

    // DB에 응답 메시지 저장
    reportMessage(leadUrl, { botName, botUsername, chatId, direction: "outbound", messageText: response.slice(0, 10000) });

    // 승인 마커 감지
    const approval = detectApprovalRequest(response);
    if (approval) {
      await sendDelegateApprovalRequest(bot, chatId, approval, response, leadUrl, botName, botUsername);
      console.log(`[WorkerAPI] Approval requested for delegate chat=${chatId}`);
      // 승인 대기 중이므로 idle 알림은 보내지 않음 (finally에서 처리)
      return;
    }

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
    sendHudAndSession(bot, chatId, leadUrl, botName);

    console.log(`[WorkerAPI] Completed delegate for ${chatId}`);
  } catch (e: any) {
    console.error(`[WorkerAPI] Failed: ${e.message}`);
    try { await bot.api.sendMessage(parseInt(chatId), `⚠️ @${botUsername} 작업 실패: ${e.message}`); } catch {}
  } finally {
    // 임시 첨부파일 정리
    for (const f of localFiles) { unlink(f).catch(() => {}); }
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

/** HUD 정보 전송 + 세션 보고 헬퍼 */
function sendHudAndSession(bot: Bot, chatId: string, leadUrl?: string, botName?: string): void {
  const hud = getHudInfo(chatId);
  if (hud && hud.inputTokens > 0) {
    const pct = hud.contextPercent;
    const bar = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
    const hudText = `Context: ${bar} ${pct}% | Turn ${hud.turnNumber} | ${hud.durationSec}s`;
    const buildText = formatBuildInfo();
    const footer = [hudText, buildText].filter(Boolean).join("\n\n");
    bot.api.sendMessage(parseInt(chatId), `<code>${escapeHtml(footer)}</code>`, { parse_mode: "HTML" }).catch(() => {});
    reportSession(leadUrl, { botName, chatId, turns: hud.turnNumber, inputTokens: hud.inputTokens, outputTokens: hud.outputTokens, cacheRead: hud.cacheRead, totalCost: 0, durationSec: hud.durationSec });
  }
}

/** Escape HTML for approval card content */
function escapeHtmlForApproval(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 위임 작업의 승인 요청 전송 */
async function sendDelegateApprovalRequest(
  bot: Bot,
  chatId: string,
  approval: ApprovalRequest,
  fullResponse: string,
  leadUrl?: string,
  botName?: string,
  botUsername?: string,
): Promise<void> {
  const approvalId = Math.random().toString(36).substring(2, 10);
  pendingDelegateApprovals.set(approvalId, { chatId, request: approval, bot, leadUrl, botName: botName || "", botUsername: botUsername || "" });

  // 10분 후 자동 만료
  setTimeout(() => {
    if (pendingDelegateApprovals.has(approvalId)) {
      pendingDelegateApprovals.delete(approvalId);
      notifyLeadIdle(botUsername || "", leadUrl, chatId).catch(() => {});
    }
  }, 600_000);

  const emoji = getApprovalEmoji(approval.type);
  const label = getApprovalLabel(approval.type);

  // 마커 이전 텍스트 전송
  const beforeMarker = (fullResponse.split(`[${approval.type.toUpperCase()}_START]`)[0] ?? "").trim();
  if (beforeMarker) {
    const chunks = splitMessage(beforeMarker);
    for (const chunk of chunks) {
      const html = markdownToTelegramHtml(chunk);
      try { await bot.api.sendMessage(parseInt(chatId), html, { parse_mode: "HTML" }); } catch {
        try { await bot.api.sendMessage(parseInt(chatId), chunk); } catch {}
      }
    }
  }

  // 승인 카드 + 버튼
  const keyboard = new InlineKeyboard()
    .text("✅ 승인 (Approve)", `delegate_approve:${approvalId}`)
    .text("❌ 거절 (Reject)", `delegate_reject:${approvalId}`);

  const approvalMsg =
    `${emoji} <b>${label} - 승인 필요</b> (@${botUsername})\n\n` +
    `<pre><code>${escapeHtmlForApproval(approval.content)}</code></pre>`;

  try {
    await bot.api.sendMessage(parseInt(chatId), approvalMsg, { parse_mode: "HTML", reply_markup: keyboard });
  } catch {
    await bot.api.sendMessage(parseInt(chatId), `${emoji} ${label} - 승인 필요 (@${botUsername})\n\n${approval.content}`, { reply_markup: keyboard }).catch(() => {});
  }

  console.log(`[WorkerAPI] Approval ${approval.type} id=${approvalId} chat=${chatId}`);
}

/** 위임 작업 승인/거절 콜백 처리 — bot.ts에서 호출 */
export async function handleDelegateApprovalCallback(data: string, ctx: any): Promise<boolean> {
  const isApprove = data.startsWith("delegate_approve:");
  const isReject = data.startsWith("delegate_reject:");
  if (!isApprove && !isReject) return false;

  const approvalId = data.split(":")[1] ?? "";
  const pending = pendingDelegateApprovals.get(approvalId);
  if (!pending) {
    await ctx.answerCallbackQuery({ text: "만료되었거나 이미 처리됨" });
    return true;
  }

  const { chatId, request, bot, leadUrl, botName, botUsername } = pending;
  pendingDelegateApprovals.delete(approvalId);

  const emoji = getApprovalEmoji(request.type);
  const label = getApprovalLabel(request.type);

  if (isApprove) {
    try {
      await ctx.editMessageText(
        `${emoji} <b>${label}</b> ✅ 승인됨 (@${botUsername})\n\n<pre><code>${escapeHtmlForApproval(request.content)}</code></pre>`,
        { parse_mode: "HTML" }
      );
    } catch {
      try { await ctx.editMessageText(`${emoji} ${label} ✅ 승인됨\n\n${request.content}`); } catch {}
    }
    await ctx.answerCallbackQuery({ text: "✅ 승인됨" });
    console.log(`[WorkerAPI] Approval APPROVED id=${approvalId} chat=${chatId}`);

    // Claude에 승인 전달 + 실행 결과 수신
    try {
      const response = await askClaudeWithProgress(chatId, "승인합니다. 진행해주세요.");

      // 또 다른 승인이 필요한지 확인
      const nextApproval = detectApprovalRequest(response);
      if (nextApproval) {
        await sendDelegateApprovalRequest(bot, chatId, nextApproval, response, leadUrl, botName, botUsername);
      } else {
        reportMessage(leadUrl, { botName, botUsername, chatId, direction: "outbound", messageText: response.slice(0, 10000) });
        const header = `🤖 @${botUsername} 작업 완료:\n\n`;
        const chunks = splitMessage(header + response);
        for (const chunk of chunks) {
          const html = markdownToTelegramHtml(chunk);
          try { await bot.api.sendMessage(parseInt(chatId), html, { parse_mode: "HTML" }); } catch {
            try { await bot.api.sendMessage(parseInt(chatId), chunk); } catch {}
          }
        }
        sendHudAndSession(bot, chatId, leadUrl, botName);
        notifyLeadIdle(botUsername, leadUrl, chatId).catch(() => {});
      }
    } catch (e: any) {
      await bot.api.sendMessage(parseInt(chatId), `⚠️ @${botUsername} 작업 실패: ${e.message}`).catch(() => {});
      notifyLeadIdle(botUsername, leadUrl, chatId).catch(() => {});
    }
  } else {
    // 거절
    try {
      await ctx.editMessageText(
        `${emoji} <b>${label}</b> ❌ 거절됨 (@${botUsername})\n\n<pre><code>${escapeHtmlForApproval(request.content)}</code></pre>`,
        { parse_mode: "HTML" }
      );
    } catch {
      try { await ctx.editMessageText(`${emoji} ${label} ❌ 거절됨\n\n${request.content}`); } catch {}
    }
    await ctx.answerCallbackQuery({ text: "❌ 거절됨" });
    console.log(`[WorkerAPI] Approval REJECTED id=${approvalId} chat=${chatId}`);

    try {
      await askClaudeWithProgress(chatId, "거절합니다. 실행하지 마세요.");
    } catch {}
    notifyLeadIdle(botUsername, leadUrl, chatId).catch(() => {});
  }

  return true;
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
