import { bot } from "./src/bot";
import { askClaude, killActiveProcesses } from "./src/claude";
import { startHeartbeat, startCron, fireHook, stopLemonClaw, appendMemoryLog, startSharedMemorySync } from "./src/lemonclaw";
import { markdownToTelegramHtml, splitMessage } from "./src/format";
import { startWorkerApi } from "./src/worker-api";
import { BOT_ROLE } from "./src/orchestrator";

console.log("Starting Claude Telegram Bot (LemonClaw Edition)...");
console.log(`Model: ${process.env.CLAUDE_MODEL || "claude-opus-4-6"}`);
console.log(
  `Allowed users: ${process.env.ALLOWED_USERS || "all (no restriction)"}`
);

// Telegram send helper for LemonClaw autonomous messages
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
        console.error(`[LemonClaw] sendTelegram failed: ${e.message}`);
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

    // Start LemonClaw autonomous systems
    startHeartbeat(askClaude, sendTelegram);
    startCron(askClaude, sendTelegram);
    startSharedMemorySync();

    // Worker API (워커 봇 — HTTP로 리드의 작업 수신)
    if (BOT_ROLE === "worker") {
      startWorkerApi(bot);
    }

    // Lead API (리드 봇 — 워커의 idle 보고 수신)
    if (BOT_ROLE === "lead") {
      const { startLeadApi } = await import("./src/orchestrator");
      startLeadApi();
    }

    // Fire on_start hooks
    fireHook("on_start", askClaude, sendTelegram).catch((e) =>
      console.error(`[LemonClaw] on_start hook error: ${e.message}`)
    );
  },
});

// Graceful shutdown
const shutdown = () => {
  console.log("\nShutting down...");
  stopLemonClaw();
  killActiveProcesses();
  bot.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
