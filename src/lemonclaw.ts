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

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { join } from "path";

// ═══════════════════════════════════════════════════════════════
// Paths
// ═══════════════════════════════════════════════════════════════

const LEMONCLAW_DIR = join(import.meta.dir, "..", ".lemonclaw");
const SOUL_PATH = join(LEMONCLAW_DIR, "SOUL.md");
const AGENTS_PATH = join(LEMONCLAW_DIR, "AGENTS.md");
const HEARTBEAT_PATH = join(LEMONCLAW_DIR, "HEARTBEAT.md");
const CRON_PATH = join(LEMONCLAW_DIR, "CRON.md");
const HOOKS_PATH = join(LEMONCLAW_DIR, "HOOKS.md");
const MEMORY_PATH = join(LEMONCLAW_DIR, "MEMORY.md");
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

/** Load SOUL.md + AGENTS.md + MEMORY.md as combined system prompt */
export function loadSystemPrompt(): string {
  const soul = readMd(SOUL_PATH);
  const agents = readMd(AGENTS_PATH);
  const memory = readMd(MEMORY_PATH);

  const parts: string[] = [];
  if (soul) parts.push(`# 🧠 SOUL\n${soul}`);
  if (agents) parts.push(`# 📋 AGENTS\n${agents}`);
  if (memory) parts.push(`# 📝 MEMORY\n${memory}`);

  return parts.join("\n\n---\n\n");
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
// Shutdown
// ═══════════════════════════════════════════════════════════════

export function stopLemonClaw(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (cronTimer) { clearInterval(cronTimer); cronTimer = null; }
  console.log("[LemonClaw] Stopped");
}
