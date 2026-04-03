import { bot } from "./src/bot";
import { askClaude, killActiveProcesses } from "./src/claude";
import { startHeartbeat, startCron, fireHook, stopOpenClaw, appendMemoryLog } from "./src/openclaw";
import { markdownToTelegramHtml, splitMessage } from "./src/format";

console.log("Starting Claude Telegram Bot (OpenClaw Edition)...");
console.log(`Model: ${process.env.CLAUDE_MODEL || "claude-opus-4-6"}`);
console.log(
  `Allowed users: ${process.env.ALLOWED_USERS || "all (no restriction)"}`
);

// Telegram send helper for OpenClaw autonomous messages
async function sendTelegram(chatId: string, text: string): Promise<void> {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    const html = markdownToTelegramHtml(chunk);
    try {
      await bot.api.sendMessage(parseInt(chatId), html, { parse_mode: "HTML" });
    } catch {
      try {
        await bot.api.sendMessage(parseInt(chatId), chunk);
      } catch (e: any) {
        console.error(`[OpenClaw] sendTelegram failed: ${e.message}`);
      }
    }
  }
}

bot.start({
  drop_pending_updates: true,
  onStart: async (botInfo) => {
    console.log(`Bot @${botInfo.username} is running!`);
    console.log(`Send /start to the bot on Telegram to begin.`);

    appendMemoryLog(`Bot started: @${botInfo.username}`);

    // Start OpenClaw autonomous systems
    startHeartbeat(askClaude, sendTelegram);
    startCron(askClaude, sendTelegram);

    // Fire on_start hooks
    fireHook("on_start", askClaude, sendTelegram).catch((e) =>
      console.error(`[OpenClaw] on_start hook error: ${e.message}`)
    );
  },
});

// Graceful shutdown
const shutdown = () => {
  console.log("\nShutting down...");
  stopOpenClaw();
  killActiveProcesses();
  bot.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
