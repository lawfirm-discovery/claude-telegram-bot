import { Bot, Context, session } from "grammy";
import { askClaude, clearSession, getSessionStats } from "./claude";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required in .env");
  process.exit(1);
}

const ALLOWED_USERS = process.env.ALLOWED_USERS
  ? process.env.ALLOWED_USERS.split(",").map((id) => parseInt(id.trim()))
  : [];

const bot = new Bot(BOT_TOKEN);

// Access control middleware
bot.use(async (ctx, next) => {
  if (ALLOWED_USERS.length > 0) {
    const userId = ctx.from?.id;
    if (!userId || !ALLOWED_USERS.includes(userId)) {
      console.log(`[Bot] Blocked user ${userId} (${ctx.from?.username})`);
      return;
    }
  }
  await next();
});

// /start command
bot.command("start", async (ctx) => {
  const userId = ctx.from?.id;
  await ctx.reply(
    `Claude Telegram Bot\n\n` +
      `Your User ID: ${userId}\n\n` +
      `Commands:\n` +
      `/new - New conversation\n` +
      `/model - Current model info\n` +
      `/stats - Session stats\n\n` +
      `Send any message to chat with Claude.`
  );
});

// /new - clear session
bot.command("new", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  clearSession(chatId);
  await ctx.reply("New conversation started.");
});

// /model - show model
bot.command("model", async (ctx) => {
  const model = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
  await ctx.reply(`Model: ${model}`);
});

// /stats
bot.command("stats", async (ctx) => {
  const stats = getSessionStats();
  await ctx.reply(`Active sessions: ${stats.active}`);
});

// Handle text messages
bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const text = ctx.message.text;

  if (!text || text.startsWith("/")) return;

  // Send typing indicator
  await ctx.replyWithChatAction("typing");

  // Keep typing indicator alive during long responses
  const typingInterval = setInterval(async () => {
    try {
      await ctx.replyWithChatAction("typing");
    } catch {}
  }, 4000);

  try {
    const response = await askClaude(chatId, text);

    clearInterval(typingInterval);

    // Split long messages (Telegram limit: 4096 chars)
    if (response.length <= 4096) {
      await ctx.reply(response, { parse_mode: "Markdown" }).catch(() =>
        // Fallback without markdown if parsing fails
        ctx.reply(response)
      );
    } else {
      const chunks = splitMessage(response, 4096);
      for (const chunk of chunks) {
        await ctx.reply(chunk, { parse_mode: "Markdown" }).catch(() =>
          ctx.reply(chunk)
        );
      }
    }
  } catch (error: any) {
    clearInterval(typingInterval);
    console.error(`[Bot] Error for chat ${chatId}:`, error.message);
    await ctx.reply(`Error: ${error.message}`);
  }
});

// Handle photos with captions
bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const caption = ctx.message.caption || "Describe this image";

  await ctx.replyWithChatAction("typing");

  try {
    // Get the largest photo
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const file = await ctx.api.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    // Download the image
    const imageResponse = await fetch(fileUrl);
    const buffer = await imageResponse.arrayBuffer();
    const tmpPath = `/tmp/tg_photo_${chatId}_${Date.now()}.jpg`;
    await Bun.write(tmpPath, buffer);

    const response = await askClaude(
      chatId,
      `[Image attached at ${tmpPath}] ${caption}`
    );

    // Cleanup
    try {
      await Bun.file(tmpPath).exists() && (await Bun.$`rm ${tmpPath}`);
    } catch {}

    await ctx.reply(response, { parse_mode: "Markdown" }).catch(() =>
      ctx.reply(response)
    );
  } catch (error: any) {
    console.error(`[Bot] Photo error for chat ${chatId}:`, error.message);
    await ctx.reply(`Error processing image: ${error.message}`);
  }
});

// Handle documents
bot.on("message:document", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const caption = ctx.message.caption || "Analyze this file";

  await ctx.replyWithChatAction("typing");

  try {
    const doc = ctx.message.document;
    const file = await ctx.api.getFile(doc.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    const fileResponse = await fetch(fileUrl);
    const buffer = await fileResponse.arrayBuffer();
    const ext = doc.file_name?.split(".").pop() || "txt";
    const tmpPath = `/tmp/tg_doc_${chatId}_${Date.now()}.${ext}`;
    await Bun.write(tmpPath, buffer);

    const response = await askClaude(
      chatId,
      `[File "${doc.file_name}" attached at ${tmpPath}] ${caption}`
    );

    try {
      await Bun.file(tmpPath).exists() && (await Bun.$`rm ${tmpPath}`);
    } catch {}

    await ctx.reply(response, { parse_mode: "Markdown" }).catch(() =>
      ctx.reply(response)
    );
  } catch (error: any) {
    console.error(`[Bot] Document error for chat ${chatId}:`, error.message);
    await ctx.reply(`Error processing document: ${error.message}`);
  }
});

function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at newline
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      // Try space
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
