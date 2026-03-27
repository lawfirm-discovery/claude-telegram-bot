import { Bot } from "grammy";
import { askClaude, clearSession, getSessionStats } from "./claude";
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

// Pairing system (OpenClaw style)
const pendingPairings = new Map<string, number>();
const approvedUsers = new Set<number>(ALLOWED_USERS);

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
      `🔐 Pairing required.\n\nCode: \`${code}\`\n\nSend to bot owner.`,
      { parse_mode: "Markdown" }
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

function isBotMentioned(text: string, botUsername: string): boolean {
  if (text.includes(`@${botUsername}`)) return true;
  for (const pattern of GROUP_MENTION_PATTERNS) {
    if (text.includes(pattern)) return true;
  }
  return false;
}

// Send response with Markdown fallback and auto-chunking
async function sendResponse(ctx: any, text: string): Promise<void> {
  const chunks = splitMessage(text, 4096);
  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(chunk);
    }
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
    let i = remaining.lastIndexOf("\n", maxLength);
    if (i < maxLength / 2) i = remaining.lastIndexOf(" ", maxLength);
    if (i < maxLength / 2) i = maxLength;
    chunks.push(remaining.substring(0, i));
    remaining = remaining.substring(i).trimStart();
  }
  return chunks;
}

// --- Core message handler (OpenClaw style: batch spawn, wait, reply) ---
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
    await sendResponse(ctx, response);
  } catch (error: any) {
    clearInterval(typingInterval);
    console.error(`[Bot] Error chat=${chatId}:`, error.message);
    await ctx.reply(`⚠️ ${error.message}`);
  }
}

// --- Message handlers ---
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  if (!text || text.startsWith("/")) return;

  // Group: only respond when mentioned
  if (ctx.chat.type !== "private") {
    const botInfo = await bot.api.getMe();
    if (!isBotMentioned(text, botInfo.username || "")) return;
  }

  await handleMessage(ctx, ctx.chat.id.toString(), text);
});

bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const caption = ctx.message.caption || "이 이미지를 분석해줘";
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
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
