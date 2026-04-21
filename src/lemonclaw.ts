/**
 * LemonClaw Engine — SOUL, HEARTBEAT, CRON, HOOKS, MEMORY
 *
 * 에이전트를 자율적으로 동작하게 만드는 핵심 모듈.
 * - SOUL.md + AGENTS.md → system prompt 주입
 * - HEARTBEAT.md → 주기적 자가 점검
 * - CRON.md → 스케줄 기반 자동 실행
 * - HOOKS.md → 이벤트 트리거
 * - MEMORY.md + memory/ → 장기 기억 & 일일 로그
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";

// ═══════════════════════════════════════════════════════════════
// Paths
// ═══════════════════════════════════════════════════════════════

const LEMONCLAW_DIR = join(import.meta.dir, "..", ".lemonclaw");
const SOUL_PATH = join(LEMONCLAW_DIR, "SOUL.md");
const AGENTS_PATH = join(LEMONCLAW_DIR, "AGENTS.md");
const EXPERT_TYPES_PATH = join(LEMONCLAW_DIR, "EXPERT_TYPES.md");
const HEARTBEAT_PATH = join(LEMONCLAW_DIR, "HEARTBEAT.md");
const CRON_PATH = join(LEMONCLAW_DIR, "CRON.md");
const HOOKS_PATH = join(LEMONCLAW_DIR, "HOOKS.md");
const MEMORY_PATH = join(LEMONCLAW_DIR, "MEMORY.md");
const SHARED_MEMORY_PATH = join(LEMONCLAW_DIR, "SHARED_MEMORY.md");
const MEMORY_DIR = join(LEMONCLAW_DIR, "memory");

// ═══════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════

const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || "1800000"); // 30 min
const HEARTBEAT_CHAT_ID = process.env.HEARTBEAT_CHAT_ID || process.env.ALLOWED_USERS?.split(",")[0] || "";
const CRON_CHECK_INTERVAL_MS = 60_000; // 1 min

// ═══════════════════════════════════════════════════════════════
// File loaders (safe read with fallback)
// ═══════════════════════════════════════════════════════════════

function readMd(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/** Load SOUL.md + AGENTS.md + EXPERT_TYPES.md + MEMORY.md + SHARED_MEMORY.md as combined system prompt */
export function loadSystemPrompt(): string {
  const soul = readMd(SOUL_PATH);
  const agents = readMd(AGENTS_PATH);
  const expertTypes = readMd(EXPERT_TYPES_PATH);
  const memory = readMd(MEMORY_PATH);
  const shared = readMd(SHARED_MEMORY_PATH);

  const parts: string[] = [];
  if (soul) parts.push(`# 🧠 SOUL\n${soul}`);
  if (agents) parts.push(`# 📋 AGENTS\n${agents}`);
  if (expertTypes) parts.push(`# 👥 EXPERT TYPES\n${expertTypes}`);
  if (memory) parts.push(`# 📝 MEMORY\n${memory}`);
  if (shared) parts.push(`# 🔗 SHARED MEMORY (다른 봇들의 최근 작업)\n${shared}`);

  // 커밋 프리픽스 규칙 주입
  const commitPrefix = getCommitPrefix();
  if (commitPrefix) {
    parts.push(`# 🏷️ GIT COMMIT RULE\n모든 git commit 메시지 앞에 반드시 "[${commitPrefix}]" 프리픽스를 붙여라. 예: "[${commitPrefix}] fix: 버그 수정". Co-Authored-By 라인에는 붙이지 않는다.`);
  }

  return parts.join("\n\n---\n\n");
}

/** 봇 식별용 커밋 프리픽스 결정 */
function getCommitPrefix(): string {
  // 1) 환경변수 우선
  if (process.env.COMMIT_PREFIX) return process.env.COMMIT_PREFIX;

  // 2) 리드봇은 프리픽스 불필요
  if (process.env.BOT_ROLE === "lead") return "";

  // 3) hostname → 이름 매핑
  const hostname = require("os").hostname().toLowerCase();
  const hostMap: Record<string, string> = {
    "legalmonster": "rtx4090",      // rtx6000은 lead라서 위에서 걸림, 여기 오면 rtx4090
    "rtx3060winserver": "3060",
    "rtxa4500-server": "a4500",
    "rtx4060winserver": "rtx4060",
  };
  if (hostname in hostMap) return hostMap[hostname]!;

  // 4) macOS 계열 — hostname 패턴 + 사용자명으로 구분
  if (hostname.includes("davolink")) return "m5_mac_pro";
  if (hostname.includes("m4mini")) return "m4mini";

  const user = (process.env.USER || process.env.USERNAME || "").toLowerCase();
  const userMap: Record<string, string> = {
    "angrylawyermacminihome": "macmini",
    "ui_macmini": "ui-macmini",
  };
  if (user in userMap) return userMap[user]!;

  // 5) Windows 워커 — lawbot 사용자 + hostname으로 구분
  if (user === "lawbot") {
    if (hostname.includes("pc1") || hostname.includes("win-pc1")) return "win-pc1";
    if (hostname.includes("pc2") || hostname.includes("win_pc2")) return "win-pc2";
    return "lawbot-macmini";  // macOS lawbot
  }

  // 6) 3rdwin (3070) — angrylawyer@100.86.44.119, hostname: 3rd-win-server
  if (hostname.includes("3rd-win") || hostname.includes("3rdwin") || hostname.includes("3070")) return "3070";

  // 7) fallback: hostname 정리
  return hostname.split(".")[0].replace(/server$/i, "").replace(/winserver$/i, "").replace(/ui-macmini$/i, "") || "unknown";
}

/** Append a work summary to shared memory (for cross-bot knowledge sharing) */
export function appendSharedMemory(botName: string, summary: string): void {
  try {
    const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    const line = `- [${now}] **${botName}**: ${summary}\n`;

    if (!existsSync(SHARED_MEMORY_PATH)) {
      writeFileSync(SHARED_MEMORY_PATH, `# Shared Memory — 봇 간 작업 공유\n\n최근 작업 내역 (최신순):\n\n${line}`);
    } else {
      // 파일이 너무 커지지 않도록 최근 50줄만 유지
      const existing = readFileSync(SHARED_MEMORY_PATH, "utf-8");
      const lines = existing.split("\n");
      const header = lines.slice(0, 4).join("\n"); // 헤더 보존
      const entries = lines.slice(4).filter(l => l.trim());
      entries.push(line.trim());
      const recent = entries.slice(-50); // 최근 50개만
      writeFileSync(SHARED_MEMORY_PATH, `${header}\n${recent.join("\n")}\n`);
    }
  } catch (e: any) {
    console.error(`[LemonClaw] Shared memory write failed: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Memory: daily log
// ═══════════════════════════════════════════════════════════════

function todayLogPath(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return join(MEMORY_DIR, `${yyyy}-${mm}-${dd}.md`);
}

export function appendMemoryLog(entry: string): void {
  try {
    const logPath = todayLogPath();
    const time = new Date().toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });
    const line = `- [${time}] ${entry}\n`;

    if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });

    if (!existsSync(logPath)) {
      const date = new Date().toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" });
      writeFileSync(logPath, `# Daily Log — ${date}\n\n${line}`);
    } else {
      appendFileSync(logPath, line);
    }
  } catch (e: any) {
    console.error(`[LemonClaw] Memory log failed: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// CRON parser
// ═══════════════════════════════════════════════════════════════

interface CronJob {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
  prompt: string;
}

function parseCronFile(): CronJob[] {
  const content = readMd(CRON_PATH);
  const jobs: CronJob[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const pipeIdx = trimmed.indexOf("|");
    if (pipeIdx === -1) continue;

    const cronPart = trimmed.slice(0, pipeIdx).trim();
    const prompt = trimmed.slice(pipeIdx + 1).trim();
    if (!prompt) continue;

    const fields = cronPart.split(/\s+/);
    if (fields.length !== 5) continue;

    jobs.push({
      minute: fields[0]!,
      hour: fields[1]!,
      dayOfMonth: fields[2]!,
      month: fields[3]!,
      dayOfWeek: fields[4]!,
      prompt,
    });
  }

  return jobs;
}

function cronFieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;

  // Handle */N (every N)
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2));
    return !isNaN(step) && step > 0 && value % step === 0;
  }

  // Handle comma-separated values
  const parts = field.split(",");
  return parts.some((p) => parseInt(p.trim()) === value);
}

export function getMatchingCronJobs(): CronJob[] {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const jobs = parseCronFile();

  return jobs.filter((job) =>
    cronFieldMatches(job.minute, now.getMinutes()) &&
    cronFieldMatches(job.hour, now.getHours()) &&
    cronFieldMatches(job.dayOfMonth, now.getDate()) &&
    cronFieldMatches(job.month, now.getMonth() + 1) &&
    cronFieldMatches(job.dayOfWeek, now.getDay())
  );
}

// ═══════════════════════════════════════════════════════════════
// HOOKS parser
// ═══════════════════════════════════════════════════════════════

export type HookEvent = "on_start" | "on_error" | "on_session_new";

interface Hook {
  event: HookEvent;
  prompt: string;
}

function parseHooksFile(): Hook[] {
  const content = readMd(HOOKS_PATH);
  const hooks: Hook[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const pipeIdx = trimmed.indexOf("|");
    if (pipeIdx === -1) continue;

    const event = trimmed.slice(0, pipeIdx).trim() as HookEvent;
    const prompt = trimmed.slice(pipeIdx + 1).trim();
    if (!prompt) continue;

    hooks.push({ event, prompt });
  }

  return hooks;
}

export function getHooksForEvent(event: HookEvent): string[] {
  return parseHooksFile()
    .filter((h) => h.event === event)
    .map((h) => h.prompt);
}

// ═══════════════════════════════════════════════════════════════
// HEARTBEAT runner
// ═══════════════════════════════════════════════════════════════

type ClaudeFn = (chatId: string, message: string) => Promise<string>;
type SendFn = (chatId: string, message: string) => Promise<void>;

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let cronTimer: ReturnType<typeof setInterval> | null = null;

export function startHeartbeat(askClaude: ClaudeFn, sendTelegram: SendFn): void {
  if (!HEARTBEAT_CHAT_ID) {
    console.log("[LemonClaw] No HEARTBEAT_CHAT_ID, heartbeat disabled");
    return;
  }

  if (HEARTBEAT_INTERVAL_MS <= 0) {
    console.log("[LemonClaw] Heartbeat interval <= 0, disabled");
    return;
  }

  console.log(`[LemonClaw] Heartbeat started: every ${HEARTBEAT_INTERVAL_MS / 1000}s, chat=${HEARTBEAT_CHAT_ID}`);

  const runHeartbeat = async () => {
    const checklist = readMd(HEARTBEAT_PATH);
    if (!checklist.trim()) return;

    const prompt = `[HEARTBEAT] 아래 체크리스트를 확인해주세요. Bash 도구로 실제 확인하세요.\n\n${checklist}`;

    try {
      console.log("[LemonClaw] Heartbeat running...");
      const response = await askClaude(HEARTBEAT_CHAT_ID, prompt);

      appendMemoryLog(`HEARTBEAT: ${response.slice(0, 200)}`);

      // HEARTBEAT_OK가 아니면 (= 문제 발견) 텔레그램으로 알림
      if (!response.includes("HEARTBEAT_OK")) {
        await sendTelegram(HEARTBEAT_CHAT_ID, `🫀 Heartbeat Alert\n\n${response}`);
        console.log("[LemonClaw] Heartbeat: issue detected, notified user");
      } else {
        console.log("[LemonClaw] Heartbeat: OK");
      }
    } catch (e: any) {
      console.error(`[LemonClaw] Heartbeat error: ${e.message}`);
      try {
        await sendTelegram(HEARTBEAT_CHAT_ID, `🫀 Heartbeat Error\n\n${e.message}`);
      } catch {}
    }
  };

  // First heartbeat after 1 minute (let bot stabilize)
  setTimeout(runHeartbeat, 60_000);
  heartbeatTimer = setInterval(runHeartbeat, HEARTBEAT_INTERVAL_MS);
}

// ═══════════════════════════════════════════════════════════════
// CRON runner
// ═══════════════════════════════════════════════════════════════

export function startCron(askClaude: ClaudeFn, sendTelegram: SendFn): void {
  if (!HEARTBEAT_CHAT_ID) {
    console.log("[LemonClaw] No HEARTBEAT_CHAT_ID, cron disabled");
    return;
  }

  console.log("[LemonClaw] Cron scheduler started (checking every 60s)");

  cronTimer = setInterval(async () => {
    const jobs = getMatchingCronJobs();
    for (const job of jobs) {
      console.log(`[LemonClaw] Cron triggered: ${job.prompt.slice(0, 50)}...`);
      appendMemoryLog(`CRON: ${job.prompt.slice(0, 100)}`);

      try {
        const response = await askClaude(HEARTBEAT_CHAT_ID, `[CRON] ${job.prompt}`);
        await sendTelegram(HEARTBEAT_CHAT_ID, `⏰ Cron\n\n${response}`);
      } catch (e: any) {
        console.error(`[LemonClaw] Cron error: ${e.message}`);
        try {
          await sendTelegram(HEARTBEAT_CHAT_ID, `⏰ Cron Error\n\n${e.message}`);
        } catch {}
      }
    }
  }, CRON_CHECK_INTERVAL_MS);
}

// ═══════════════════════════════════════════════════════════════
// HOOKS runner
// ═══════════════════════════════════════════════════════════════

export async function fireHook(
  event: HookEvent,
  askClaude: ClaudeFn,
  sendTelegram: SendFn
): Promise<void> {
  if (!HEARTBEAT_CHAT_ID) return;

  // on_start: CLI 호출 없이 직접 메시지 전송 (토큰 절약)
  if (event === "on_start") {
    const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    const msg = `🤖 봇이 재시작되었습니다.\n⏰ ${now}`;
    console.log(`[LemonClaw] Hook on_start: direct message (no CLI)`);
    appendMemoryLog(`HOOK[on_start]: direct message`);
    try {
      await sendTelegram(HEARTBEAT_CHAT_ID, msg);
    } catch (e: any) {
      console.error(`[LemonClaw] Hook on_start error: ${e.message}`);
    }
    return;
  }

  const prompts = getHooksForEvent(event);
  for (const prompt of prompts) {
    console.log(`[LemonClaw] Hook ${event}: ${prompt.slice(0, 50)}...`);
    appendMemoryLog(`HOOK[${event}]: ${prompt.slice(0, 100)}`);

    try {
      const response = await askClaude(HEARTBEAT_CHAT_ID, `[HOOK:${event}] ${prompt}`);
      await sendTelegram(HEARTBEAT_CHAT_ID, response);
    } catch (e: any) {
      console.error(`[LemonClaw] Hook ${event} error: ${e.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Shared Memory Sync (git pull/push)
// ═══════════════════════════════════════════════════════════════

const REPO_DIR = join(import.meta.dir, "..");
let syncTimer: ReturnType<typeof setInterval> | null = null;
const SYNC_INTERVAL_MS = 5 * 60_000; // 5분마다

function runGit(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { cwd: REPO_DIR, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", () => resolve(out.trim()));
    proc.on("error", () => resolve(""));
  });
}

async function syncSharedMemory(): Promise<void> {
  try {
    // 현재 체크아웃 브랜치를 대상으로 동기화 (하드코딩된 'main' 사용 시 다른 브랜치에서 rebase drift 발생)
    const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!branch || branch === "HEAD") return;

    // 1) Pull latest (다른 봇의 shared memory 반영)
    await runGit(["pull", "--rebase", "--autostash", "origin", branch]);

    // 2) 로컬 변경이 있으면 push
    const status = await runGit(["status", "--porcelain", ".lemonclaw/SHARED_MEMORY.md"]);
    if (status) {
      await runGit(["add", ".lemonclaw/SHARED_MEMORY.md"]);
      await runGit(["commit", "-m", "chore: sync shared memory"]);
      await runGit(["push", "origin", branch]);
      console.log("[LemonClaw] Shared memory synced to remote");
    }
  } catch (e: any) {
    console.error(`[LemonClaw] Shared memory sync failed: ${e.message}`);
  }
}

export function startSharedMemorySync(): void {
  // 시작 시 즉시 pull
  syncSharedMemory().catch(() => {});
  syncTimer = setInterval(() => syncSharedMemory().catch(() => {}), SYNC_INTERVAL_MS);
  console.log(`[LemonClaw] Shared memory sync started (every ${SYNC_INTERVAL_MS / 1000}s)`);
}

// ═══════════════════════════════════════════════════════════════
// Shutdown
// ═══════════════════════════════════════════════════════════════

export function stopLemonClaw(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (cronTimer) { clearInterval(cronTimer); cronTimer = null; }
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  // 종료 전 마지막 sync
  syncSharedMemory().catch(() => {});
  console.log("[LemonClaw] Stopped");
}
