import { bot } from "./src/bot";
import { killActiveProcesses } from "./src/claude";
import { preload as preloadDart } from "./src/services/dart";

console.log("Starting Claude Telegram Bot...");
console.log(`Model: ${process.env.CLAUDE_MODEL || "claude-opus-4-6"}`);
console.log(
  `Allowed users: ${process.env.ALLOWED_USERS || "all (no restriction)"}`
);

bot.start({
  drop_pending_updates: true,
  onStart: (botInfo) => {
    console.log(`Bot @${botInfo.username} is running!`);
    console.log(`Send /start to the bot on Telegram to begin.`);
    // DART 기업코드 백그라운드 프리로드
    preloadDart();
  },
});

// Graceful shutdown
const shutdown = () => {
  console.log("\nShutting down...");
  killActiveProcesses();
  bot.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
