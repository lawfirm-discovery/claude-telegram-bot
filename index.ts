import { bot } from "./src/bot";
import { askClaude, killActiveProcesses } from "./src/claude-engine";
import { startHeartbeat, startCron, fireHook, stopLemonClaw, appendMemoryLog, startSharedMemorySync } from "./src/lemonclaw";
import { markdownToTelegramHtml, splitMessage } from "./src/format";
import { startWorkerApi, stopWorkerApi } from "./src/worker-api";
import { BOT_ROLE, stopHealthCheck } from "./src/orchestrator";
import { initBuildInfo } from "./src/build-info";
import { existsSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
// ssh-proxy는 리드봇에서만 동적 import (워커에서 키 파일 없어서 크래시 방지)

// ── PID 파일 기반 중복 실행 방지 ──
const PID_FILE = join(import.meta.dir, process.env.BOT_PID_FILE || "bot.pid");
async function checkAndWritePid(): Promise<void> {
  let killedOldProcess = false;
  if (existsSync(PID_FILE)) {
    const oldPid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    if (oldPid && !isNaN(oldPid)) {
      try {
        // 프로세스 존재 확인 (signal 0 = 확인만)
        process.kill(oldPid, 0);
        // 프로세스가 살아있으면 죽이고 대기
        console.log(`[Bot] Killing previous instance (PID ${oldPid})...`);
        process.kill(oldPid, "SIGTERM");
        Bun.sleepSync(3000);
        try { process.kill(oldPid, "SIGKILL"); } catch {}
        Bun.sleepSync(1000);
        killedOldProcess = true;
      } catch {
        // 프로세스가 이미 죽어있음 — 정상
      }
    }
  }
  writeFileSync(PID_FILE, String(process.pid));

  // 이전 프로세스를 죽였으면 Telegram의 pending long-polling을 명시적으로 캔슬
  // getUpdates(offset=-1, timeout=0)으로 서버측 대기 연결을 즉시 끊음
  if (killedOldProcess) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (token) {
      console.log("[Bot] Cancelling previous Telegram long-polling connection...");
      try {
        await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1&timeout=0`, {
          signal: AbortSignal.timeout(5000),
        });
        // 추가 대기: Telegram 서버가 이전 연결을 완전히 정리하도록
        await new Promise(r => setTimeout(r, 2000));
        console.log("[Bot] Previous polling cancelled OK");
      } catch (e: any) {
        console.log(`[Bot] Polling cancel attempt: ${e.message} (continuing anyway)`);
      }
    }
  }
}
await checkAndWritePid();

// 빌드 정보 캐싱 (프로세스 시작 시 1회)
await initBuildInfo();

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
  if (BOT_ROLE === "lead") {
    startSharedMemorySync();
  }

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
let onStartFired = false;
async function startBot(retries = 5): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await bot.start({
        drop_pending_updates: true,
        onStart: async (botInfo) => {
          console.log(`Bot @${botInfo.username} is running!`);
          console.log(`Send /start to the bot on Telegram to begin.`);

          // 409 retry 시 onStart가 매번 호출됨 — 서비스/훅은 1회만 실행
          if (onStartFired) return;
          onStartFired = true;

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
        console.log(`[Bot] 409 conflict — cancelling stale polling then retry (attempt ${attempt}/${retries})`);
        // 이전 long-polling을 명시적으로 캔슬 후 재시도
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (token) {
          try {
            await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1&timeout=0`, {
              signal: AbortSignal.timeout(5000),
            });
          } catch {}
        }
        const wait = Math.min(attempt * 5, 15); // 5s, 10s, 15s, 15s (캔슬 후이므로 짧게)
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }
      console.error(`[Bot] Fatal error after ${attempt} attempts:`, e.message);
      // 45초 대기 후 exit하여 Telegram 쪽 이전 연결이 타임아웃되도록 함
      console.log(`[Bot] Waiting 45s before exit to let Telegram polling timeout...`);
      await new Promise(r => setTimeout(r, 45_000));
      process.exit(1);
    }
  }
}

startBot();

// #4 Graceful shutdown — 진행 중 작업 완료 대기 후 종료
const shutdown = async () => {
  console.log("\nShutting down...");
  try { unlinkSync(PID_FILE); } catch {}
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
