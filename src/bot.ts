import { Bot, InlineKeyboard } from "grammy";
import { askClaude, askClaudeWithProgress, clearSession, getSessionStats, getHudInfo, killActiveProcesses, loadInterruptedContext, hasInterruptedContext, type ProgressInfo } from "./claude";
import { appendMemoryLog, appendSharedMemory } from "./lemonclaw";
import {
  detectApprovalRequest,
  getApprovalEmoji,
  getApprovalLabel,
  type ApprovalRequest,
} from "./approval";
import { escapeHtml, markdownToTelegramHtml, splitMessage } from "./format";
import { mkdtemp, writeFile, unlink } from "fs/promises";
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

  // Group: only respond when mentioned (use cached bot info)
  if (ctx.chat.type !== "private") {
    if (!isBotMentioned(text, ctx.me.username)) return;
  }

  await handleMessage(ctx, ctx.chat.id.toString(), text);
});

bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const caption = ctx.message.caption || "이 이미지를 분석해줘";
  const photos = ctx.message.photo;
  const photo = photos[photos.length - 1];
  if (!photo) return;
  const tmpPath = await downloadTelegramFile(photo.file_id, "jpg");
  await handleMessage(ctx, chatId, caption, [tmpPath]);
  setTimeout(() => cleanupFile(tmpPath), 120_000);
});

bot.on("message:document", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const doc = ctx.message.document;
  const caption = ctx.message.caption || `이 파일을 분석해줘: ${doc.file_name}`;
  const ext = doc.file_name?.split(".").pop() || "txt";
  const tmpPath = await downloadTelegramFile(doc.file_id, ext);
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
