import { bot } from "./src/bot";
import { askClaude, killActiveProcesses } from "./src/claude";
import { startHeartbeat, startCron, fireHook, stopLemonClaw, appendMemoryLog, startSharedMemorySync } from "./src/lemonclaw";
import { markdownToTelegramHtml, splitMessage } from "./src/format";
import { startWorkerApi, stopWorkerApi } from "./src/worker-api";
import { BOT_ROLE, stopHealthCheck } from "./src/orchestrator";
import { initBuildInfo } from "./src/build-info";
import { existsSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
// ssh-proxy는 리드봇에서만 동적 import (워커에서 키 파일 없어서 크래시 방지)

// ── Telegram polling 슬롯 대기 (409 방지) ──
async function waitForPollingSlot(token: string, maxWaitMs = 60_000): Promise<boolean> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < maxWaitMs) {
    attempt++;
    try {
      const resp = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1&timeout=0`, {
        signal: AbortSignal.timeout(5000),
      });
      const data = await resp.json() as any;
      if (data.ok) {
        console.log(`[Bot] Polling slot clear (attempt ${attempt})`);
        return true;
      }
      if (data.error_code === 409) {
        console.log(`[Bot] Polling slot busy (409) — waiting... (${attempt})`);
      } else {
        console.log(`[Bot] Polling check: ${data.description || "unknown"} — waiting... (${attempt})`);
      }
    } catch (e: any) {
      console.log(`[Bot] Polling check error: ${e.message} — waiting... (${attempt})`);
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log(`[Bot] Polling slot wait timed out after ${Math.round((Date.now() - start) / 1000)}s — proceeding anyway`);
  return false;
}

// ── PID 파일 기반 중복 실행 방지 ──
const PID_FILE = join(import.meta.dir, process.env.BOT_PID_FILE || "bot.pid");
async function checkAndWritePid(): Promise<void> {
  if (existsSync(PID_FILE)) {
    const oldPid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    if (oldPid && !isNaN(oldPid)) {
      try {
        process.kill(oldPid, 0);
        console.log(`[Bot] Killing previous instance (PID ${oldPid})...`);
        process.kill(oldPid, "SIGTERM");
        Bun.sleepSync(3000);
        try { process.kill(oldPid, "SIGKILL"); } catch {}
        Bun.sleepSync(1000);
      } catch {
        // 프로세스가 이미 죽어있음 — 정상
      }
    }
  }
  writeFileSync(PID_FILE, String(process.pid));

  // polling 슬롯이 실제로 비었는지 루프로 확인 (최대 60초)
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token) {
    console.log("[Bot] Waiting for Telegram polling slot to clear...");
    await waitForPollingSlot(token, 60_000);
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

// 409 재시도 포함 봇 시작 — 409는 exit하지 않고 무한 재시도 (restart 폭풍 방지)
let onStartFired = false;
async function startBot(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  let round = 0;

  while (true) {
    round++;
    const maxAttempts = 8;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await bot.start({
          drop_pending_updates: true,
          onStart: async (botInfo) => {
            console.log(`Bot @${botInfo.username} is running!`);
            console.log(`Send /start to the bot on Telegram to begin.`);
            if (onStartFired) return;
            onStartFired = true;
            appendMemoryLog(`Bot started: @${botInfo.username}`);
            await startServices();
            fireHook("on_start", askClaude, sendTelegram).catch((e) =>
              console.error(`[LemonClaw] on_start hook error: ${e.message}`)
            );
          },
        });
        return; // bot.stop() 호출 시 정상 리턴
      } catch (e: any) {
        const is409 = e.error_code === 409 || String(e.message || "").includes("409");
        if (is409 && attempt < maxAttempts) {
          console.log(`[Bot] 409 conflict (round ${round}, attempt ${attempt}/${maxAttempts}) — waiting for slot...`);
          if (token) await waitForPollingSlot(token, 35_000);
          continue;
        }
        if (is409) {
          // 409로 모든 시도 소진 — exit하지 않고 60초 대기 후 처음부터 재시도
          console.error(`[Bot] 409 persisted through ${maxAttempts} attempts (round ${round}) — waiting 60s then retry`);
          break;
        }
        // 409가 아닌 에러 — 진짜 문제이므로 exit
        console.error(`[Bot] Fatal non-409 error:`, e.message);
        process.exit(1);
      }
    }

    // 409 라운드 실패 — 60초 후 다시 시도
    if (token) {
      console.log("[Bot] Waiting 60s for polling slot to fully clear...");
      await waitForPollingSlot(token, 60_000);
    } else {
      await new Promise(r => setTimeout(r, 60_000));
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
