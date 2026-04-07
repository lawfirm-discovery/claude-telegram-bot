import { Bot, InlineKeyboard } from "grammy";
import { askClaude, askClaudeWithProgress, clearSession, getSessionStats, getHudInfo, killActiveProcesses, loadInterruptedContext, hasInterruptedContext, type ProgressInfo } from "./claude-engine";
import { appendMemoryLog, appendSharedMemory } from "./lemonclaw";
import {
  BOT_ROLE, planTask, dispatchTask, handleWorkerReport,
  mergeCompletedTask, formatTaskStatus, detectTaskMessage,
  executeWorkerTask, getWorkerBots, formatAffinityReport,
  quickDelegate, detectDelegateMessage,
} from "./orchestrator";
import {
  detectApprovalRequest,
  getApprovalEmoji,
  getApprovalLabel,
  type ApprovalRequest,
} from "./approval";
import { escapeHtml, markdownToTelegramHtml, splitMessage } from "./format";
import { mkdtemp, writeFile, unlink, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required in .env");
  process.exit(1);
}

const ALLOWED_USERS = process.env.ALLOWED_USERS
  ? process.env.ALLOWED_USERS.split(",").map((id) => parseInt(id.trim()))
  : [];

const GROUP_MENTION_PATTERNS = (process.env.GROUP_MENTION_PATTERNS || "")
  .split(",")
  .filter(Boolean);

const bot = new Bot(BOT_TOKEN);

// Pairing system (LemonClaw style)
const pendingPairings = new Map<string, number>();
const approvedUsers = new Set<number>(ALLOWED_USERS);

// Pending approval requests: approvalId -> { chatId, request }
const pendingApprovals = new Map<
  string,
  { chatId: string; request: ApprovalRequest }
>();

function generatePairingCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// --- Access control ---
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  // 봇 간 위임 메시지는 access control 건너뛰기
  if (ctx.from?.is_bot && ctx.message && "text" in ctx.message) {
    const text = (ctx.message as any).text || "";
    if (text.includes("[DELEGATE:") || text.includes("[TASK:")) {
      await next();
      return;
    }
  }

  if (approvedUsers.size === 0 && ALLOWED_USERS.length === 0) {
    await next();
    return;
  }
  if (approvedUsers.has(userId)) {
    await next();
    return;
  }

  // Pairing for DMs
  if (ctx.chat?.type === "private" && ctx.message?.text) {
    const code = generatePairingCode();
    pendingPairings.set(code, userId);
    console.log(`[Pairing] Code ${code} for user ${userId}`);
    await ctx.reply(
      `🔐 Pairing required.\n\nCode: <code>${code}</code>\n\nSend to bot owner.`,
      { parse_mode: "HTML" }
    );
    setTimeout(() => pendingPairings.delete(code), 600_000);
    return;
  }
});

// --- Commands ---
bot.command("start", async (ctx) => {
  await ctx.reply(
    `🤖 Claude Telegram Bot\n\n` +
      `Model: ${process.env.CLAUDE_MODEL || "claude-opus-4-6"}\n` +
      `Your ID: ${ctx.from?.id}\n\n` +
      `/new — New conversation\n` +
      `/model — Current model\n` +
      `/stats — Session stats\n` +
      `/pair <code> — Approve user`
  );
});

bot.command("new", async (ctx) => {
  clearSession(ctx.chat.id.toString());
  await ctx.reply("🔄 New conversation started.");
});

bot.command("model", async (ctx) => {
  await ctx.reply(`Model: ${process.env.CLAUDE_MODEL || "claude-opus-4-6"}`);
});

bot.command("stats", async (ctx) => {
  await ctx.reply(`Active sessions: ${getSessionStats().active}`);
});

// --- Orchestrator Commands (Lead bot only) ---
bot.command("orchestrate", async (ctx) => {
  if (BOT_ROLE !== "lead") {
    await ctx.reply("⚠️ 이 봇은 워커입니다. 리드 봇에서 /orchestrate를 사용하세요.");
    return;
  }
  const taskDescription = ctx.match?.trim();
  if (!taskDescription) {
    await ctx.reply("사용법: /orchestrate <작업 설명>\n예: /orchestrate 전문가 상담 기능에 파일 첨부 추가");
    return;
  }

  const chatId = ctx.chat.id.toString();
  await ctx.reply("🔄 작업을 서브태스크로 분해 중...");

  try {
    // Step 1: Plan
    const task = await planTask(taskDescription, chatId);
    const statusMsg = formatTaskStatus(task);
    await ctx.reply(`📋 작업 계획 완료:\n\n${statusMsg}\n\n진행하려면 "승인", 취소하려면 "취소"를 입력하세요.`);

    // Store task ID for approval
    pendingOrchestrations.set(chatId, task.id);
  } catch (e: any) {
    await ctx.reply(`❌ 분해 실패: ${e.message}`);
  }
});

bot.command("affinity", async (ctx) => {
  await ctx.reply(formatAffinityReport());
});

bot.command("workers", async (ctx) => {
  const workers = getWorkerBots();
  if (!workers.length) {
    await ctx.reply("등록된 워커 봇이 없습니다. .env의 WORKER_BOTS를 설정하세요.");
    return;
  }
  const lines = workers.map(w =>
    `${w.status === "idle" ? "🟢" : "🔴"} ${w.name} (@${w.username}) — ${w.repos.join(", ")}`
  );
  await ctx.reply(`🤖 워커 봇 목록:\n\n${lines.join("\n")}`);
});

// Pending orchestration approvals
const pendingOrchestrations = new Map<string, string>();

bot.command("pair", async (ctx) => {
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(ctx.from?.id!))
    return;
  const code = ctx.match?.trim().toUpperCase();
  if (!code) {
    await ctx.reply("Usage: /pair <CODE>");
    return;
  }
  const targetUserId = pendingPairings.get(code);
  if (!targetUserId) {
    await ctx.reply("Invalid or expired code.");
    return;
  }
  approvedUsers.add(targetUserId);
  pendingPairings.delete(code);
  await ctx.reply(`✅ User ${targetUserId} approved.`);
});

// --- Approval callback handler ---
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const isApprove = data.startsWith("approve:");
  const isReject = data.startsWith("reject:");

  if (!isApprove && !isReject) return;

  const approvalId = data.split(":")[1] ?? "";
  const pending = pendingApprovals.get(approvalId);

  if (!pending) {
    await ctx.answerCallbackQuery({ text: "Expired or already handled." });
    return;
  }

  const { chatId, request } = pending;
  pendingApprovals.delete(approvalId);

  const emoji = getApprovalEmoji(request.type);
  const label = getApprovalLabel(request.type);

  if (isApprove) {
    // Update button message (HTML mode, LemonClaw style)
    try {
      await ctx.editMessageText(
        `${emoji} <b>${label}</b> ✅ 승인됨\n\n<pre><code>${escapeHtmlForApproval(request.content)}</code></pre>`,
        { parse_mode: "HTML" }
      );
    } catch {
      try {
        await ctx.editMessageText(
          `${emoji} ${label} ✅ 승인됨\n\n${request.content}`
        );
      } catch {}
    }
    await ctx.answerCallbackQuery({ text: "✅ 승인됨" });

    console.log(`[Approval] APPROVED id=${approvalId} chat=${chatId}`);

    // Send approval to Claude and get execution result
    await ctx.replyWithChatAction("typing");
    const typingInterval = setInterval(async () => {
      try {
        await ctx.replyWithChatAction("typing");
      } catch {}
    }, 4000);

    try {
      const response = await askClaudeWithProgress(chatId, "승인합니다. 진행해주세요.");
      clearInterval(typingInterval);

      // Check if there's another approval needed
      const nextApproval = detectApprovalRequest(response);
      if (nextApproval) {
        await sendApprovalRequest(ctx, chatId, nextApproval, response);
      } else {
        await sendResponse(ctx, response, chatId);
      }
    } catch (error: any) {
      clearInterval(typingInterval);
      await ctx.reply(`⚠️ ${error.message}`);
    }
  } else {
    // Rejected
    try {
      await ctx.editMessageText(
        `${emoji} <b>${label}</b> ❌ 거절됨\n\n<pre><code>${escapeHtmlForApproval(request.content)}</code></pre>`,
        { parse_mode: "HTML" }
      );
    } catch {
      try {
        await ctx.editMessageText(
          `${emoji} ${label} ❌ 거절됨\n\n${request.content}`
        );
      } catch {}
    }
    await ctx.answerCallbackQuery({ text: "❌ 거절됨" });

    console.log(`[Approval] REJECTED id=${approvalId} chat=${chatId}`);

    // Tell Claude it was rejected
    try {
      const response = await askClaude(
        chatId,
        "거절합니다. 실행하지 마세요."
      );
      await sendResponse(ctx, response, chatId);
    } catch {}
  }
});

// --- Helpers ---
async function downloadTelegramFile(
  fileId: string,
  extension: string
): Promise<string> {
  const file = await bot.api.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(fileUrl);
  const buffer = Buffer.from(await response.arrayBuffer());
  const dir = await mkdtemp(join(tmpdir(), "claude-tg-"));
  const filePath = join(dir, `file.${extension}`);
  await writeFile(filePath, buffer, { mode: 0o600 });
  return filePath;
}

async function cleanupFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {}
}

// Escape HTML for approval card content (inside <pre><code>)
function escapeHtmlForApproval(text: string): string {
  return escapeHtml(text);
}

function isBotMentioned(text: string, botUsername: string): boolean {
  if (text.includes(`@${botUsername}`)) return true;
  for (const pattern of GROUP_MENTION_PATTERNS) {
    if (text.includes(pattern)) return true;
  }
  return false;
}

// HUD: context usage bar
function formatHud(chatId: string): string | null {
  const hud = getHudInfo(chatId);
  if (!hud || hud.inputTokens === 0) return null;

  const pct = hud.contextPercent;
  const filled = Math.round(pct / 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  const color = pct < 50 ? "🟢" : pct < 80 ? "🟡" : "🔴";

  const tokensK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(0)}K` : `${n}`;
  const duration = hud.durationSec > 0
    ? (hud.durationSec >= 60 ? `${Math.floor(hud.durationSec / 60)}m${hud.durationSec % 60}s` : `${hud.durationSec}s`)
    : "";

  const parts = [
    `${color} Context: ${bar} ${pct}% (${tokensK(hud.inputTokens)}/200K)`,
  ];
  const meta: string[] = [];
  if (hud.turnNumber > 0) meta.push(`🔄 Turn ${hud.turnNumber}`);
  if (duration) meta.push(`⏱ ${duration}`);
  if (hud.cacheRead > 0) meta.push(`📦 Cache ${tokensK(hud.cacheRead)}`);
  if (meta.length > 0) parts.push(meta.join(" | "));

  return parts.join("\n");
}

// LemonClaw style: send response as HTML with auto-chunking, fallback to plain text
async function sendResponse(ctx: any, text: string, chatId?: string): Promise<void> {
  // Chunk raw markdown first, then convert each chunk to HTML
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    const html = markdownToTelegramHtml(chunk);
    try {
      await ctx.reply(html, { parse_mode: "HTML" });
    } catch {
      // Fallback: plain text (no formatting)
      await ctx.reply(chunk);
    }
  }

  // HUD footer (after last chunk)
  if (chatId) {
    const hudText = formatHud(chatId);
    if (hudText) {
      try {
        await ctx.reply(`<code>${escapeHtml(hudText)}</code>`, { parse_mode: "HTML" });
      } catch {
        try { await ctx.reply(hudText); } catch {}
      }
    }
  }
}

// --- LemonClaw ack reaction helpers ---
async function addAckReaction(ctx: any): Promise<boolean> {
  try {
    await ctx.react("👀");
    return true;
  } catch {
    return false;
  }
}

async function removeAckReaction(ctx: any): Promise<void> {
  try {
    // Remove reaction by setting empty array
    await bot.api.setMessageReaction(ctx.chat.id, ctx.message.message_id, []);
  } catch {}
}

// --- Core message handler with real-time progress ---
async function handleMessage(
  ctx: any,
  chatId: string,
  text: string,
  attachments?: string[]
): Promise<void> {
  // "계속" 메시지 감지 → 중단된 컨텍스트 복원
  const CONTINUE_PATTERNS = /^(계속|continue|이어서|이어가|진행|go on)\s*\.?$/i;
  if (CONTINUE_PATTERNS.test(text.trim())) {
    const savedContext = loadInterruptedContext(chatId);
    if (savedContext) {
      text = `이전 작업이 중단되었습니다. 아래 컨텍스트를 참고하여 이어서 진행해주세요.\n\n${savedContext}\n\n---\n위 중단된 작업을 이어서 완료해주세요.`;
      console.log(`[Bot] Injected interrupted context for chat=${chatId}`);
    }
  }

  const didAck = await addAckReaction(ctx);

  await ctx.replyWithChatAction("typing");
  const typingInterval = setInterval(async () => {
    try { await ctx.replyWithChatAction("typing"); } catch {}
  }, 4000);

  // 진행 상황 메시지 (도구 사용 시 실시간 업데이트)
  let progressMsgId: number | null = null;
  let lastProgressText = "";
  let toolHistory: string[] = [];
  let progressThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  const PROGRESS_THROTTLE_MS = 3000; // 3초마다 최대 1번 업데이트
  const startTime = Date.now();

  const updateProgressMessage = async (newText: string) => {
    if (newText === lastProgressText) return;
    lastProgressText = newText;
    try {
      if (progressMsgId) {
        await bot.api.editMessageText(ctx.chat.id, progressMsgId, newText);
      } else {
        const msg = await ctx.reply(newText);
        progressMsgId = msg.message_id;
      }
    } catch {
      // edit 실패 시 무시 (동일 텍스트, 메시지 삭제됨 등)
    }
  };

  const TOOL_EMOJI: Record<string, string> = {
    Read: "📖", Write: "✍️", Edit: "✏️", Bash: "💻", Grep: "🔍",
    Glob: "📂", Agent: "🤖", TaskCreate: "📋", TaskUpdate: "✅",
    WebSearch: "🌐", WebFetch: "🌐",
  };

  const onProgress = (info: ProgressInfo) => {
    if (info.type === "tool_use" && info.toolName) {
      const emoji = TOOL_EMOJI[info.toolName] || "🔧";
      toolHistory.push(`${emoji} ${info.toolName}`);
      // 최근 5개만 표시
      const recent = toolHistory.slice(-5);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const elapsedStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s` : `${elapsed}s`;
      const progressText = `⏳ 작업 중... (turn ${info.turnNumber}, ${elapsedStr})\n${recent.join(" → ")}`;

      // 쓰로틀링: 3초마다 최대 1번 업데이트
      if (!progressThrottleTimer) {
        progressThrottleTimer = setTimeout(() => {
          progressThrottleTimer = null;
          updateProgressMessage(progressText);
        }, PROGRESS_THROTTLE_MS);
      }
    }
  };

  try {
    const response = await askClaudeWithProgress(chatId, text, attachments, onProgress);
    clearInterval(typingInterval);
    if (progressThrottleTimer) clearTimeout(progressThrottleTimer);

    // 진행 상황 메시지 삭제
    if (progressMsgId) {
      try { await bot.api.deleteMessage(ctx.chat.id, progressMsgId); } catch {}
    }

    if (didAck) await removeAckReaction(ctx);

    // LemonClaw: 대화 기록을 메모리에 로깅
    appendMemoryLog(`User[${chatId}]: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);
    appendMemoryLog(`Bot[${chatId}]: ${response.slice(0, 100)}${response.length > 100 ? "..." : ""}`);

    // Shared memory: 코드 변경/빌드/배포 등 의미있는 작업만 기록
    if (toolHistory.length > 0 && /(?:Edit|Write|Bash)/.test(toolHistory.join(" "))) {
      const botUsername = ctx.me?.username || "unknown";
      const summary = `${text.slice(0, 80)} → ${response.slice(0, 120)}`;
      appendSharedMemory(botUsername, summary);
    }

    const approval = detectApprovalRequest(response);
    if (approval) {
      await sendApprovalRequest(ctx, chatId, approval, response);
    } else {
      await sendResponse(ctx, response, chatId);
    }
  } catch (error: any) {
    clearInterval(typingInterval);
    if (progressThrottleTimer) clearTimeout(progressThrottleTimer);
    if (progressMsgId) {
      try { await bot.api.deleteMessage(ctx.chat.id, progressMsgId); } catch {}
    }
    if (didAck) await removeAckReaction(ctx);
    console.error(`[Bot] Error chat=${chatId}:`, error.message);
    const reason = error.failoverReason;
    const hints: Record<string, string> = {
      rate_limit: "\n💡 API 사용량 한도에 도달했습니다. 잠시 후 다시 시도해주세요.",
      overloaded: "\n💡 서버가 혼잡합니다. 잠시 후 다시 시도해주세요.",
      auth: "\n💡 API 인증에 문제가 있습니다. 관리자에게 문의하세요.",
      billing: "\n💡 API 결제 문제가 발생했습니다. 관리자에게 문의하세요.",
    };
    await ctx.reply(`⚠️ ${error.message}${hints[reason] || ""}`);
  }
}

// Send approval request with inline buttons
async function sendApprovalRequest(
  ctx: any,
  chatId: string,
  approval: ApprovalRequest,
  fullResponse: string
): Promise<void> {
  const approvalId = Math.random().toString(36).substring(2, 10);
  pendingApprovals.set(approvalId, { chatId, request: approval });

  // Auto-expire after 10 minutes
  setTimeout(() => pendingApprovals.delete(approvalId), 600_000);

  const emoji = getApprovalEmoji(approval.type);
  const label = getApprovalLabel(approval.type);

  // Send the text before the marker
  const beforeMarker = (fullResponse.split(`[${approval.type.toUpperCase()}_START]`)[0] ?? "").trim();
  if (beforeMarker) {
    await sendResponse(ctx, beforeMarker);
  }

  // Send approval card with buttons
  const keyboard = new InlineKeyboard()
    .text("✅ 승인 (Approve)", `approve:${approvalId}`)
    .text("❌ 거절 (Reject)", `reject:${approvalId}`);

  const approvalMsg =
    `${emoji} <b>${label} - 승인 필요</b>\n\n` +
    `<pre><code>${escapeHtmlForApproval(approval.content)}</code></pre>`;

  try {
    await ctx.reply(approvalMsg, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  } catch {
    await ctx.reply(
      `${emoji} ${label} - 승인 필요\n\n${approval.content}`,
      { reply_markup: keyboard }
    );
  }

  console.log(
    `[Approval] ${approval.type} request id=${approvalId} chat=${chatId}`
  );
}

// --- Message handlers ---
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  if (!text || text.startsWith("/")) return;

  const chatId = ctx.chat.id.toString();
  console.log(`[MSG] role=${BOT_ROLE} chat=${chatId} len=${text.length}`);

  // Group: only respond when mentioned (use cached bot info)
  if (ctx.chat.type !== "private") {
    if (!isBotMentioned(text, ctx.me.username)) return;
  }

  // === Orchestrator: 승인/취소 처리 (Lead) ===
  if (BOT_ROLE === "lead") {
    const pendingTaskId = pendingOrchestrations.get(chatId);
    if (pendingTaskId && /^(승인|확인|진행|approve|yes)$/i.test(text.trim())) {
      pendingOrchestrations.delete(chatId);
      const { getTask } = await import("./orchestrator");
      const task = getTask(pendingTaskId);
      if (task) {
        await ctx.reply("📨 워커 봇에 HTTP 전송 중...");
        await dispatchTask(task);
        await ctx.reply(formatTaskStatus(task));
        return;
      }
    }
    if (pendingTaskId && /^(취소|cancel|no)$/i.test(text.trim())) {
      pendingOrchestrations.delete(chatId);
      await ctx.reply("❌ 작업이 취소되었습니다.");
      return;
    }

    // === Lead: 워커 완료 보고 수신 ===
    const report = handleWorkerReport(text);
    if (report) {
      if (report.allDone) {
        await ctx.reply(`🎉 모든 서브태스크 완료! 머지 시작...\n\n${formatTaskStatus(report.task)}`);
        const sendTg = async (cid: string, msg: string) => {
          try { await bot.api.sendMessage(parseInt(cid), msg); } catch {}
        };
        try {
          await mergeCompletedTask(report.task, askClaude, sendTg);
        } catch (e: any) {
          await ctx.reply(`❌ 머지 실패: ${e.message}`);
        }
      } else {
        await ctx.reply(formatTaskStatus(report.task));
      }
      return;
    }
  }

  // === Worker: 위임 메시지 감지 [DELEGATE:chatId] ===
  if (BOT_ROLE === "worker") {
    const delegated = detectDelegateMessage(text);
    if (delegated) {
      const botName = ctx.me?.username || "worker";
      // 포럼 그룹에 수신 확인
      await ctx.reply(`📥 작업 수신. 처리 중...`);

      try {
        // 실제 작업 실행 (일반 handleMessage와 동일)
        const response = await askClaudeWithProgress(chatId, delegated.message);

        // 요청자(사용자)에게 직접 DM으로 결과 전송
        const header = `🤖 @${botName} 작업 완료:\n\n`;
        const chunks = splitMessage(header + response);
        for (const chunk of chunks) {
          const html = markdownToTelegramHtml(chunk);
          try {
            await bot.api.sendMessage(parseInt(delegated.requestedBy), html, { parse_mode: "HTML" });
          } catch {
            try { await bot.api.sendMessage(parseInt(delegated.requestedBy), chunk); } catch {}
          }
        }

        // HUD 정보도 전송
        const hudText = formatHud(chatId);
        if (hudText) {
          try {
            await bot.api.sendMessage(parseInt(delegated.requestedBy),
              `<code>${escapeHtml(hudText)}</code>`, { parse_mode: "HTML" });
          } catch {}
        }
      } catch (e: any) {
        // 에러도 요청자에게 직접 전송
        try {
          await bot.api.sendMessage(parseInt(delegated.requestedBy),
            `⚠️ @${botName} 작업 실패: ${e.message}`);
        } catch {}
      }
      return;
    }

    // === Worker: 오케스트레이션 태스크 메시지 감지 ===
    const detectedTask = detectTaskMessage(text);
    if (detectedTask) {
      await ctx.reply(`📥 태스크 수신: ${detectedTask.description.slice(0, 80)}\n브랜치: ${detectedTask.branch}\n작업 시작...`);
      const sendTg = async (cid: string, msg: string) => {
        try { await bot.api.sendMessage(parseInt(cid), msg); } catch {}
      };
      try {
        await executeWorkerTask(detectedTask, askClaude, sendTg);
      } catch (e: any) {
        await ctx.reply(`❌ 태스크 실패: ${e.message}`);
      }
      return;
    }
  }

  // === Lead: "직접 처리" 키워드 감지 → 로컬 처리 ===
  const FORCE_LOCAL_RE = /(?:직접\s*처리|직접\s*해줘|개발서버(?:가|에서)\s*처리|로컬에서|여기서\s*처리|네가\s*직접)/;

  if (BOT_ROLE === "lead" && FORCE_LOCAL_RE.test(text)) {
    const cleanedText = text.replace(FORCE_LOCAL_RE, "").trim();
    await ctx.reply("🖥️ 리드 봇이 직접 처리합니다.");
    await handleMessage(ctx, chatId, cleanedText || text);
    return;
  }

  // === Lead: 일반 메시지를 워커에 HTTP로 자동 위임 ===

  if (BOT_ROLE === "lead") {
    const result = await quickDelegate(text, chatId);
    if (result) {
      await ctx.reply(`📨 @${result.workerName} 에 작업 전송 완료\n💬 "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);
    } else {
      await ctx.reply("⚠️ 모든 워커가 작업 중입니다. 잠시 후 다시 시도해주세요.");
    }
    return; // 리드는 절대 직접 작업 안 함
  }

  await handleMessage(ctx, chatId, text);
});

bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const caption = ctx.message.caption || "이 이미지를 분석해줘";
  const photos = ctx.message.photo;
  const photo = photos[photos.length - 1];
  if (!photo) return;
  const tmpPath = await downloadTelegramFile(photo.file_id, "jpg");

  // Lead: 첨부파일 포함 메시지도 워커에 위임 (base64로 파일 데이터 직접 전달)
  if (BOT_ROLE === "lead") {
    const fileData = await readFile(tmpPath);
    const result = await quickDelegate(caption, chatId, [{ file_id: photo.file_id, type: "photo", data: fileData.toString("base64") }]);
    if (result) {
      await ctx.reply(`📨 @${result.workerName} 에 작업 전송 완료\n💬 "${caption.slice(0, 80)}${caption.length > 80 ? "..." : ""}" + 📷 이미지`);
    } else {
      await ctx.reply("⚠️ 모든 워커가 작업 중입니다. 잠시 후 다시 시도해주세요.");
    }
    setTimeout(() => cleanupFile(tmpPath), 120_000);
    return;
  }

  await handleMessage(ctx, chatId, caption, [tmpPath]);
  setTimeout(() => cleanupFile(tmpPath), 120_000);
});

bot.on("message:document", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const doc = ctx.message.document;
  const caption = ctx.message.caption || `이 파일을 분석해줘: ${doc.file_name}`;
  const ext = doc.file_name?.split(".").pop() || "txt";
  const tmpPath = await downloadTelegramFile(doc.file_id, ext);

  // Lead: 첨부파일 포함 메시지도 워커에 위임 (base64로 파일 데이터 직접 전달)
  if (BOT_ROLE === "lead") {
    const fileData = await readFile(tmpPath);
    const result = await quickDelegate(caption, chatId, [{ file_id: doc.file_id, type: "document", filename: doc.file_name, data: fileData.toString("base64") }]);
    if (result) {
      await ctx.reply(`📨 @${result.workerName} 에 작업 전송 완료\n💬 "${caption.slice(0, 80)}${caption.length > 80 ? "..." : ""}" + 📎 ${doc.file_name}`);
    } else {
      await ctx.reply("⚠️ 모든 워커가 작업 중입니다. 잠시 후 다시 시도해주세요.");
    }
    setTimeout(() => cleanupFile(tmpPath), 120_000);
    return;
  }

  await handleMessage(ctx, chatId, caption, [tmpPath]);
  setTimeout(() => cleanupFile(tmpPath), 120_000);
});

bot.on("message:voice", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const tmpPath = await downloadTelegramFile(
    ctx.message.voice.file_id,
    "ogg"
  );
  await handleMessage(ctx, chatId, "이 음성 메시지를 분석해줘", [tmpPath]);
  setTimeout(() => cleanupFile(tmpPath), 120_000);
});

// --- Error handler: send errors to Telegram ---
bot.catch(async (err) => {
  console.error("[Bot] Unhandled error:", err.message);
});

export { bot };
