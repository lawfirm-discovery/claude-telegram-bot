import { Bot } from "grammy";
import { askClaude, clearSession, getSessionStats } from "./claude";
import { mkdtemp, writeFile, unlink, mkdir } from "fs/promises";
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

// Group chat settings (OpenClaw style)
const GROUP_MENTION_PATTERNS = (
  process.env.GROUP_MENTION_PATTERNS || ""
).split(",").filter(Boolean);

const bot = new Bot(BOT_TOKEN);

// Pairing system (OpenClaw style)
const pendingPairings = new Map<string, number>(); // code -> userId
const approvedUsers = new Set<number>(ALLOWED_USERS);

function generatePairingCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Access control middleware
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  // If no restrictions, allow all
  if (approvedUsers.size === 0 && ALLOWED_USERS.length === 0) {
    await next();
    return;
  }

  // Check if user is approved
  if (approvedUsers.has(userId)) {
    await next();
    return;
  }

  // Pairing flow for DMs
  if (ctx.chat?.type === "private") {
    const code = generatePairingCode();
    pendingPairings.set(code, userId);
    console.log(
      `[Pairing] Code ${code} for user ${userId} (@${ctx.from?.username})`
    );
    await ctx.reply(
      `🔐 Pairing required.\n\nCode: \`${code}\`\n\nSend this code to the bot owner to get approved.`,
      { parse_mode: "Markdown" }
    );
    // Auto-expire after 10 min
    setTimeout(() => pendingPairings.delete(code), 600_000);
    return;
  }
});

// /start command
bot.command("start", async (ctx) => {
  const userId = ctx.from?.id;
  const model = process.env.CLAUDE_MODEL || "claude-opus-4-6";
  await ctx.reply(
    `🤖 Claude Telegram Bot\n\n` +
      `Model: ${model}\n` +
      `Your ID: ${userId}\n\n` +
      `Commands:\n` +
      `/new — New conversation\n` +
      `/model — Current model\n` +
      `/stats — Session stats\n` +
      `/pair <code> — Approve a user (owner only)\n\n` +
      `Send any message to chat with Claude.`
  );
});

// /new - clear session
bot.command("new", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  clearSession(chatId);
  await ctx.reply("🔄 New conversation started.");
});

// /model - show model
bot.command("model", async (ctx) => {
  const model = process.env.CLAUDE_MODEL || "claude-opus-4-6";
  await ctx.reply(`Model: ${model}`);
});

// /stats
bot.command("stats", async (ctx) => {
  const stats = getSessionStats();
  await ctx.reply(`Active sessions: ${stats.active}`);
});

// /pair <code> - approve a user (owner only)
bot.command("pair", async (ctx) => {
  const userId = ctx.from?.id;
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(userId!)) {
    return;
  }

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
  console.log(`[Pairing] User ${targetUserId} approved by ${userId}`);
});

// Download a Telegram file to a temp path
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

// Clean up temp file
async function cleanupFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {}
}

// Send a response, handling long messages and markdown fallback
async function sendResponse(
  ctx: any,
  text: string,
  replyToId?: number
): Promise<void> {
  const chunks = splitMessage(text, 4096);

  for (const chunk of chunks) {
    const opts: any = {};
    if (replyToId) opts.reply_to_message_id = replyToId;

    // Try Markdown first, fall back to plain text
    try {
      await ctx.reply(chunk, { ...opts, parse_mode: "Markdown" });
    } catch {
      await ctx.reply(chunk, opts);
    }
  }
}

// Check if bot is mentioned in group chat
function isBotMentioned(text: string, botUsername: string): boolean {
  if (text.includes(`@${botUsername}`)) return true;
  for (const pattern of GROUP_MENTION_PATTERNS) {
    if (text.includes(pattern)) return true;
  }
  return false;
}

// Handle text messages
bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const text = ctx.message.text;

  if (!text || text.startsWith("/")) return;

  // In group chats, only respond when mentioned
  if (ctx.chat.type !== "private") {
    const botInfo = await bot.api.getMe();
    if (!isBotMentioned(text, botInfo.username || "")) return;
  }

  await handleMessage(ctx, chatId, text);
});

// Handle photos
bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const caption = ctx.message.caption || "이 이미지를 분석해줘";

  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  let tmpPath: string | null = null;

  try {
    tmpPath = await downloadTelegramFile(photo.file_id, "jpg");
    await handleMessage(ctx, chatId, caption, [tmpPath]);
  } finally {
    if (tmpPath) await cleanupFile(tmpPath);
  }
});

// Handle documents
bot.on("message:document", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const doc = ctx.message.document;
  const caption = ctx.message.caption || `이 파일을 분석해줘: ${doc.file_name}`;
  const ext = doc.file_name?.split(".").pop() || "txt";

  let tmpPath: string | null = null;

  try {
    tmpPath = await downloadTelegramFile(doc.file_id, ext);
    await handleMessage(ctx, chatId, caption, [tmpPath]);
  } finally {
    if (tmpPath) await cleanupFile(tmpPath);
  }
});

// Handle voice messages
bot.on("message:voice", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  let tmpPath: string | null = null;

  try {
    tmpPath = await downloadTelegramFile(ctx.message.voice.file_id, "ogg");
    await handleMessage(ctx, chatId, "이 음성 메시지를 분석해줘", [tmpPath]);
  } finally {
    if (tmpPath) await cleanupFile(tmpPath);
  }
});

// Core message handler
async function handleMessage(
  ctx: any,
  chatId: string,
  text: string,
  attachments?: string[]
): Promise<void> {
  // Typing indicator
  await ctx.replyWithChatAction("typing");
  const typingInterval = setInterval(async () => {
    try {
      await ctx.replyWithChatAction("typing");
    } catch {}
  }, 4000);

  try {
    const response = await askClaude(chatId, text, attachments);
    clearInterval(typingInterval);
    await sendResponse(ctx, response, ctx.message?.message_id);
  } catch (error: any) {
    clearInterval(typingInterval);
    console.error(`[Bot] Error chat=${chatId}:`, error.message);
    await ctx.reply(`⚠️ ${error.message}`);
  }
}

function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Split at newline, then space, then hard cut
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trimStart();
  }

  return chunks;
}

// Error handling
bot.catch((err) => {
  console.error("[Bot] Unhandled error:", err.message);
});

export { bot };
