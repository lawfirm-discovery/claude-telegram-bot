import { bot } from "./src/bot";
import { killActiveProcesses } from "./src/claude";

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
