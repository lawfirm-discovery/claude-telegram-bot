import { bot } from "./src/bot";
import { askClaude, killActiveProcesses } from "./src/claude";
import { startHeartbeat, startCron, fireHook, stopLemonClaw, appendMemoryLog, startSharedMemorySync } from "./src/lemonclaw";
import { markdownToTelegramHtml, splitMessage } from "./src/format";
import { startWorkerApi, stopWorkerApi } from "./src/worker-api";
import { BOT_ROLE, stopHealthCheck } from "./src/orchestrator";
// ssh-proxy는 리드봇에서만 동적 import (워커에서 키 파일 없어서 크래시 방지)

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

// 서버/서비스는 한 번만 시작 (409 재시도 시 중복 방지)
let servicesStarted = false;
async function startServices(): Promise<void> {
  if (servicesStarted) return;
  servicesStarted = true;

  if (BOT_ROLE !== "lead") {
    startHeartbeat(askClaude, sendTelegram);
    startCron(askClaude, sendTelegram);
  }
  startSharedMemorySync();

  if (BOT_ROLE === "worker") {
    startWorkerApi(bot);
  }

  if (BOT_ROLE === "lead") {
    const { startLeadApi } = await import("./src/orchestrator");
    startLeadApi();
  }

  if (BOT_ROLE === "lead") {
    const { startSshProxy } = await import("./src/ssh-proxy");
    startSshProxy();
  }
}

// 409 재시도 포함 봇 시작
async function startBot(retries = 5): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await bot.start({
        drop_pending_updates: true,
        onStart: async (botInfo) => {
          console.log(`Bot @${botInfo.username} is running!`);
          console.log(`Send /start to the bot on Telegram to begin.`);
          appendMemoryLog(`Bot started: @${botInfo.username}`);

          await startServices();

          fireHook("on_start", askClaude, sendTelegram).catch((e) =>
            console.error(`[LemonClaw] on_start hook error: ${e.message}`)
          );
        },
      });
      return; // start()가 정상 종료하면 (bot.stop() 호출 시) 리턴
    } catch (e: any) {
      const is409 = e.error_code === 409 || String(e.message || "").includes("409");
      if (is409 && attempt < retries) {
        // 이전 프로세스의 long-polling이 Telegram 서버에서 타임아웃될 때까지 대기
        const wait = attempt * 5; // 5s, 10s, 15s, 20s
        console.log(`[Bot] 409 conflict — waiting ${wait}s before retry (attempt ${attempt}/${retries})`);
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }
      console.error(`[Bot] Fatal error after ${attempt} attempts:`, e.message);
      process.exit(1);
    }
  }
}

startBot();

// #4 Graceful shutdown — 진행 중 작업 완료 대기 후 종료
const shutdown = async () => {
  console.log("\nShutting down...");
  stopLemonClaw();
  stopHealthCheck();
  stopWorkerApi();
  // ssh-proxy 정리 (동적 import — 워커에선 로드 안 됨)
  try { const { stopSshProxy } = await import("./src/ssh-proxy"); stopSshProxy(); } catch {}
  await killActiveProcesses();
  bot.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
