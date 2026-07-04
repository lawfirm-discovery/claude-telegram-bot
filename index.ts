// ~/.claude/*.env (mode 600) 자동 로드 — systemd 서비스가 .bashrc 를 안 읽으므로
// process 시작 직후 직접 주입. 평문 git 노출 회피 + 회전 시 /sync 로 갱신.
(function loadClaudeEnvFiles() {
  const fs = require("fs") as typeof import("fs");
  const os = require("os") as typeof import("os");
  for (const name of ["config-vault.env", "test-accounts.env"]) {
    const path = `${os.homedir()}/.claude/${name}`;
    if (!fs.existsSync(path)) continue;
    for (const line of fs.readFileSync(path, "utf-8").split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
})();

import { bot } from "./src/bot";
import { askClaude, killActiveProcesses } from "./src/claude-engine";
import { startHeartbeat, startCron, fireHook, stopLemonClaw, appendMemoryLog, startSharedMemorySync } from "./src/lemonclaw";
import { markdownToTelegramHtml, splitMessage } from "./src/format";
import { startWorkerApi, stopWorkerApi } from "./src/worker-api";
import { BOT_ROLE, stopHealthCheck } from "./src/orchestrator";
import { initBuildInfo } from "./src/build-info";
import { startStockMonitor, stopStockMonitor } from "./src/stock-monitor";
import { startOptionMonitor, stopOptionMonitor } from "./src/option-monitor";
import { existsSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";
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
// Phase R11.1 — 자기 자신 PID 체크 + 실제 봇 process 인지 cmdline 검증.
//   기존 버그: oldPid === process.pid 면 자기 자신 SIGTERM. systemd 가 4060 봇을
//   1m10s 만에 종료시킨 사고의 root cause 추정.
const PID_FILE = join(import.meta.dir, process.env.BOT_PID_FILE || "bot.pid");

function isBotProcess(pid: number): boolean {
  // Phase R11.6 (2026-05-14): cmdline 매치에 src/bot.ts 도 포함.
  //   기존엔 index.ts 만 매치 → `bun run src/bot.ts` 로 띄운 디버그 좀비를
  //   "봇 아님" 으로 분류 → polling slot 점유한 채 무시됨 → sustained 409 conflict.
  const isBotCmd = (s: string) => /bun/.test(s) && (/index\.ts/.test(s) || /src\/bot\.ts/.test(s));
  // Linux: /proc/<pid>/cmdline 가 가장 정확
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ");
    return isBotCmd(cmdline);
  } catch {
    // /proc 없음 (macOS) — ps fallback. 보수적: ps 도 실패하면 false (다른 unrelated process 죽이지 않게)
    try {
      const out = execSync(`ps -p ${pid} -o command=`, { encoding: "utf-8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
      return isBotCmd(out);
    } catch {
      return false;
    }
  }
}

// Phase R11.5 — supervisor 가 띄운 instance 인지 detect (systemd / launchd)
//   - systemd: INVOCATION_ID 환경변수 자동 설정
//   - launchd: XPC_SERVICE_NAME 또는 LAUNCH_DAEMON 자동 설정
//   외부 nohup launcher 등은 둘 다 unset → 외부로 분류
function isSupervisorManaged(): boolean {
  return !!(process.env.INVOCATION_ID || process.env.XPC_SERVICE_NAME || process.env.LAUNCHD_SOCKET);
}

async function checkAndWritePid(): Promise<void> {
  const selfIsSupervisor = isSupervisorManaged();
  if (existsSync(PID_FILE)) {
    const oldPid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    if (oldPid && !isNaN(oldPid) && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0); // exists check
        if (isBotProcess(oldPid)) {
          // Phase R11.5 — supervisor 우선 양보 패턴
          if (selfIsSupervisor) {
            // 자기 자신이 supervisor 가 띄운 봇 → 기존 (외부 launcher 일 가능성 큼) 죽이기
            console.log(`[Bot] Self is supervisor-managed (INVOCATION_ID set). Killing previous bot instance (PID ${oldPid})...`);
            try { process.kill(oldPid, "SIGTERM"); } catch {}
            Bun.sleepSync(3000);
            try { process.kill(oldPid, "SIGKILL"); } catch {}
            Bun.sleepSync(1000);
          } else {
            // 자기 자신이 외부 launcher → 기존 (supervisor 일 가능성) 에 양보
            console.log(`[Bot] Self is external launcher (no INVOCATION_ID). Existing bot (PID ${oldPid}) wins — exiting (code 0)`);
            process.exit(0);
          }
        } else {
          console.log(`[Bot] PID ${oldPid} exists but not a bot process — skipping`);
        }
      } catch {
        // 기존 process 죽어있음 — 정상, 새로 띄움
      }
    }
  }
  writeFileSync(PID_FILE, String(process.pid));

  // polling 슬롯이 실제로 비었는지 루프로 확인 (최대 60초)
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token) {
    console.log("[Bot] Waiting for Telegram polling slot to clear...");
    const slotOk = await waitForPollingSlot(token, 60_000);
    // Phase R11.6 (2026-05-14): 60s 후에도 slot 안 비면 다른 인스턴스가 polling 잡고 있는 것 →
    //   fall-through 로 polling 시작하면 무한 409 conflict 루프 (2026-05-13 macmini 사고).
    //   supervisor (ThrottleInterval=300) 에 양보 후 재시도하게 exit 75.
    if (!slotOk) {
      console.error("[Bot] Polling slot 60s 대기 후에도 점유됨 — 다른 인스턴스 의심. supervisor 재시작 양보 (exit 75).");
      process.exit(75);
    }
  }
}
await checkAndWritePid();

// Phase R8.2 — 봇 시작 시 로그 rotation 체크 (100MB 초과 시 archive)
// launchd 가 stdout.log 를 fd 로 열고 있어 봇 종료 시점만 안전하게 archive 가능.
// ThrottleInterval=300 backoff 사이에 실행 → safe.
const __rotateLog = async (logPath: string, maxBytes = 100 * 1024 * 1024) => {
  try {
    const f = Bun.file(logPath);
    if (!(await f.exists())) return;
    const size = f.size;
    if (size <= maxBytes) return;
    const archived = `${logPath}.${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${process.pid}`;
    const buf = await f.arrayBuffer();
    await Bun.write(archived, buf);
    await Bun.write(logPath, ""); // truncate
    console.log(`[log-rotate] ${logPath} (${Math.round(size / 1024 / 1024)}MB) → ${archived}`);
  } catch (e: any) {
    console.warn(`[log-rotate] ${logPath} rotation 실패 (무시): ${e.message}`);
  }
};
const __logsDir = join(import.meta.dir, "logs");
await __rotateLog(join(__logsDir, "stdout.log"));
await __rotateLog(join(__logsDir, "stderr.log"));
await __rotateLog(join(import.meta.dir, "bot.log"));

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

  // 주식/옵션 실시간 모니터 (모든 봇)
  const alertChatId =
    process.env.STOCK_ALERT_CHAT_ID ||
    (process.env.ALLOWED_USERS ? process.env.ALLOWED_USERS.split(",")[0]?.trim() : "") ||
    "";
  if (alertChatId) {
    startStockMonitor(alertChatId, sendTelegram);
    startOptionMonitor(alertChatId, sendTelegram);
  } else {
    console.warn("[StockMonitor] STOCK_ALERT_CHAT_ID 또는 ALLOWED_USERS 미설정 — 모니터 비활성");
  }

  // Ralph Loop: 미완료 태스크 재개 (워커만 — 리드는 직접 작업 안 함)
  if (BOT_ROLE === "worker") {
    const { resumeInProgressTasks } = await import("./src/ralph-loop");
    resumeInProgressTasks(askClaude, sendTelegram).catch(e =>
      console.error(`[RalphLoop] Resume error: ${e.message}`)
    );
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
          console.log(`[Bot] 409 conflict (round ${round}, attempt ${attempt}/${maxAttempts}) — stopping stale poller and waiting for slot...`);
          try { bot.stop(); } catch {}
          await new Promise(r => setTimeout(r, 1500));
          if (token) await waitForPollingSlot(token, 35_000);
          continue;
        }
        if (is409) {
          // 409로 모든 시도 소진 — stale polling을 정리한 뒤 60초 대기 후 처음부터 재시도
          console.error(`[Bot] 409 persisted through ${maxAttempts} attempts (round ${round}) — stopping stale poller, waiting 60s then retry`);
          try { bot.stop(); } catch {}
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
// Phase R7.1 + R11.2: signal source + uptime + parent process 진단 로깅
const __startupTime = Date.now();
const shutdown = async (signal: string) => {
  const uptimeSec = Math.round((Date.now() - __startupTime) / 1000);
  const uptimeStr = uptimeSec >= 60 ? `${Math.floor(uptimeSec / 60)}m${uptimeSec % 60}s` : `${uptimeSec}s`;
  console.log(`\nShutting down... (signal=${signal}, uptime=${uptimeStr}, pid=${process.pid})`);
  console.log(`[shutdown] reason: ${signal === "SIGTERM" ? "SIGTERM (외부 신호 — launchd/systemd/manual)" : signal === "SIGINT" ? "SIGINT (Ctrl+C 또는 스크립트)" : signal}`);

  // Phase R11.2 — SIGTERM source 진단 (parent / status / cmdline)
  if (signal === "SIGTERM") {
    try {
      const status = readFileSync(`/proc/${process.pid}/status`, "utf-8");
      const ppidMatch = status.match(/PPid:\s*(\d+)/);
      const ppid = ppidMatch ? parseInt(ppidMatch[1]) : 0;
      let parentInfo = `ppid=${ppid}`;
      if (ppid > 0) {
        try {
          const parentCmd = readFileSync(`/proc/${ppid}/cmdline`, "utf-8").replace(/\0/g, " ").trim();
          const parentStatus = readFileSync(`/proc/${ppid}/status`, "utf-8");
          const pNameMatch = parentStatus.match(/Name:\s*(\S+)/);
          parentInfo += ` parent=${pNameMatch?.[1] || "?"} cmd="${parentCmd.slice(0, 100)}"`;
        } catch { parentInfo += ` parent=(unable to read)`; }
      }
      console.log(`[shutdown] ${parentInfo}`);
      // 실행 중인 child process 도 (전파된 SIGTERM 인지)
      const children = readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, "utf-8").trim();
      if (children) console.log(`[shutdown] children=${children.slice(0, 100)}`);
    } catch {
      // /proc 없음 (macOS) — skip
    }
  }
  try { unlinkSync(PID_FILE); } catch {}
  stopLemonClaw();
  stopHealthCheck();
  stopWorkerApi();
  stopStockMonitor();
  stopOptionMonitor();
  // ssh-proxy 정리 (동적 import — 워커에선 로드 안 됨)
  try { const { stopSshProxy } = await import("./src/ssh-proxy"); stopSshProxy(); } catch {}
  await killActiveProcesses();
  bot.stop();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
