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

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, statSync, unlinkSync, renameSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";

// ═══════════════════════════════════════════════════════════════
// Paths
// ═══════════════════════════════════════════════════════════════

// LEMONCLAW_DIR/REPO_DIR override — 같은 src를 심볼릭 링크로 공유하는 별도 봇(pylon 등)이
// 자기 디렉토리의 .lemonclaw / git repo를 사용하도록 환경변수로 분리 가능.
// 미지정 시 import.meta.dir 기준(심볼릭 링크 따라간 실제 경로)으로 fallback.
const LEMONCLAW_DIR = process.env.LEMONCLAW_DIR || join(import.meta.dir, "..", ".lemonclaw");
const SOUL_PATH = join(LEMONCLAW_DIR, "SOUL.md");
const AGENTS_PATH = join(LEMONCLAW_DIR, "AGENTS.md");
const EXPERT_TYPES_PATH = join(LEMONCLAW_DIR, "EXPERT_TYPES.md");
const HEARTBEAT_PATH = join(LEMONCLAW_DIR, "HEARTBEAT.md");
const CRON_PATH = join(LEMONCLAW_DIR, "CRON.md");
const HOOKS_PATH = join(LEMONCLAW_DIR, "HOOKS.md");
const MEMORY_PATH = join(LEMONCLAW_DIR, "MEMORY.md");
const SHARED_MEMORY_PATH = join(LEMONCLAW_DIR, "SHARED_MEMORY.md");
const MEMORY_DIR = join(LEMONCLAW_DIR, "memory");
// 채팅별 사용자 명시 메모 (/note, /checkpoint) — 매 턴 system prompt에 주입
const NOTES_DIR = join(LEMONCLAW_DIR, "notes");
// 채팅별 Working Memory — 봇이 자기 작업을 매 턴 자동 기록(history.log) +
// 자율 태그(<working-memory>)로 active.md를 self-update. 매 턴 system prompt에 주입.
const WORKING_DIR = join(LEMONCLAW_DIR, "working");

// ═══════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════

const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || "1800000"); // 30 min
const HEARTBEAT_CHAT_ID = process.env.HEARTBEAT_CHAT_ID || process.env.ALLOWED_USERS?.split(",")[0] || "";
const CRON_CHECK_INTERVAL_MS = 60_000; // 1 min

// SHARED_MEMORY 라인 필터 — 외부 프로젝트(pylon 등) 항목을 system prompt와 로컬 누적에서 제외
// 라인 단위 정규식. .env의 SHARED_MEMORY_EXCLUDE_PATTERNS가 비면 필터링 안 함.
const SHARED_MEMORY_EXCLUDE_RE: RegExp | null = (() => {
  const raw = (process.env.SHARED_MEMORY_EXCLUDE_PATTERNS || "").trim();
  if (!raw) return null;
  try { return new RegExp(raw); } catch { return null; }
})();

function filterSharedMemoryLines(lines: string[]): string[] {
  if (!SHARED_MEMORY_EXCLUDE_RE) return lines;
  return lines.filter(l => !SHARED_MEMORY_EXCLUDE_RE.test(l));
}

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
  const sharedRaw = readMd(SHARED_MEMORY_PATH);
  const shared = sharedRaw && SHARED_MEMORY_EXCLUDE_RE
    ? filterSharedMemoryLines(sharedRaw.split("\n")).join("\n")
    : sharedRaw;

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
      let entries = lines.slice(4).filter(l => l.trim());
      // 외부 프로젝트(pylon 등) 항목 제거 — pull로 들어온 다른 환경 라인은 누적하지 않음
      entries = filterSharedMemoryLines(entries);
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
// Chat-scoped notes (/note, /checkpoint) — 매 턴 system prompt에 주입
// 컨텍스트 손실에도 살아남는 사용자 명시 영구 메모.
// ═══════════════════════════════════════════════════════════════

function chatNotePath(chatId: string): string {
  return join(NOTES_DIR, `${chatId}.md`);
}

export function loadChatNotes(chatId: string): string {
  try {
    const p = chatNotePath(chatId);
    if (!existsSync(p)) return "";
    return readFileSync(p, "utf-8").trim();
  } catch { return ""; }
}

export function appendChatNote(chatId: string, text: string): void {
  try {
    if (!existsSync(NOTES_DIR)) mkdirSync(NOTES_DIR, { recursive: true });
    const p = chatNotePath(chatId);
    const time = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    const line = `- [${time}] ${text.trim()}\n`;
    if (!existsSync(p)) {
      writeFileSync(p, `# Chat Notes — chat=${chatId}\n\n${line}`);
    } else {
      appendFileSync(p, line);
    }
  } catch (e: any) {
    console.error(`[LemonClaw] Chat note write failed: ${e.message}`);
  }
}

export function clearChatNotes(chatId: string): void {
  try {
    const p = chatNotePath(chatId);
    if (existsSync(p)) writeFileSync(p, `# Chat Notes — chat=${chatId}\n\n`);
  } catch (e: any) {
    console.error(`[LemonClaw] Chat note clear failed: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Working Memory (Phase 5) — Claude Code parity 자율 메모리
// active.md  : 봇이 <working-memory> 태그로 self-update + 매 턴 system prompt에 주입
// history.log: 매 턴 user/assistant 짧은 요약 1줄씩 (디버깅·검색용)
// archive/   : 완료된 작업 영구 보관 (active.md → 이름 지정 후 이동)
// ═══════════════════════════════════════════════════════════════

const WORKING_ACTIVE_MAX_BYTES = parseInt(process.env.WORKING_ACTIVE_MAX_BYTES || "8192");

function chatWorkingDir(chatId: string): string {
  return join(WORKING_DIR, chatId);
}
function chatActivePath(chatId: string): string {
  return join(chatWorkingDir(chatId), "active.md");
}
function chatHistoryPath(chatId: string): string {
  return join(chatWorkingDir(chatId), "history.log");
}
function chatArchiveDir(chatId: string): string {
  return join(chatWorkingDir(chatId), "archive");
}

function ensureWorkingDirs(chatId: string): void {
  try {
    if (!existsSync(WORKING_DIR)) mkdirSync(WORKING_DIR, { recursive: true });
    const d = chatWorkingDir(chatId);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    const ad = chatArchiveDir(chatId);
    if (!existsSync(ad)) mkdirSync(ad, { recursive: true });
  } catch (e: any) {
    console.error(`[LemonClaw] Working dir create failed: ${e.message}`);
  }
}

export function loadActiveWorking(chatId: string): string {
  try {
    const p = chatActivePath(chatId);
    if (!existsSync(p)) return "";
    return readFileSync(p, "utf-8").trim();
  } catch { return ""; }
}

export function setActiveWorking(chatId: string, content: string): void {
  try {
    ensureWorkingDirs(chatId);
    writeFileSync(chatActivePath(chatId), content.trim() + "\n");
  } catch (e: any) {
    console.error(`[LemonClaw] Active working write failed: ${e.message}`);
  }
}

// 태그 머지 — 봇이 응답한 <working-memory> 본문을 기존 active.md 위에 자연스럽게 병합.
// 모드: append(기존 + 신규), replace(완전 교체).
// 디폴트는 append. 신규 본문에 "<!-- replace -->" 마커 포함 시 replace.
export function mergeActiveWorking(chatId: string, newBlock: string): void {
  if (!newBlock || !newBlock.trim()) return;
  try {
    ensureWorkingDirs(chatId);
    const p = chatActivePath(chatId);
    const existing = existsSync(p) ? readFileSync(p, "utf-8") : "";
    const ts = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });

    if (/<!--\s*replace\s*-->/i.test(newBlock)) {
      const cleaned = newBlock.replace(/<!--\s*replace\s*-->/gi, "").trim();
      writeFileSync(p, `# Active Working Memory — chat=${chatId}\n_업데이트: ${ts}_\n\n${cleaned}\n`);
      return;
    }

    if (!existing) {
      writeFileSync(p, `# Active Working Memory — chat=${chatId}\n_업데이트: ${ts}_\n\n${newBlock.trim()}\n`);
      return;
    }
    // append: 시간 stamp 구분선 추가
    writeFileSync(p, `${existing.trimEnd()}\n\n---\n_업데이트: ${ts}_\n\n${newBlock.trim()}\n`);
  } catch (e: any) {
    console.error(`[LemonClaw] Active working merge failed: ${e.message}`);
  }
}

export function appendWorkingHistory(chatId: string, line: string): void {
  try {
    ensureWorkingDirs(chatId);
    const time = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });
    const safe = line.replace(/\n/g, " ").slice(0, 800);
    appendFileSync(chatHistoryPath(chatId), `[${time}] ${safe}\n`);
  } catch (e: any) {
    console.error(`[LemonClaw] Working history append failed: ${e.message}`);
  }
}

// active.md 가 임계 초과 시 호출자가 외부 LLM으로 압축한 결과를 setActiveWorking으로 저장.
// 여기는 임계 초과 여부만 알려준다.
export function activeWorkingNeedsCompact(chatId: string): boolean {
  try {
    const p = chatActivePath(chatId);
    if (!existsSync(p)) return false;
    return statSync(p).size > WORKING_ACTIVE_MAX_BYTES;
  } catch { return false; }
}

// 현재 active.md 를 archive로 이동 후 active.md 비움.
export function archiveActiveWorking(chatId: string, name?: string): string {
  try {
    const p = chatActivePath(chatId);
    if (!existsSync(p)) return "";
    ensureWorkingDirs(chatId);
    const date = new Date().toISOString().slice(0, 10);
    const safeName = (name || "session").replace(/[^\w가-힣\-_]+/g, "_").slice(0, 40);
    const target = join(chatArchiveDir(chatId), `${date}_${safeName}.md`);
    renameSync(p, target);
    return target;
  } catch (e: any) {
    console.error(`[LemonClaw] Archive failed: ${e.message}`);
    return "";
  }
}

export function clearActiveWorking(chatId: string): void {
  try {
    const p = chatActivePath(chatId);
    if (existsSync(p)) unlinkSync(p);
  } catch (e: any) {
    console.error(`[LemonClaw] Clear active working failed: ${e.message}`);
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

const REPO_DIR = process.env.REPO_DIR || join(import.meta.dir, "..");
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
  // 외부 프로젝트 봇(pylon 등)이 lawfirm-discovery 레포에 잘못 push하는 사고를 막기 위한 kill-switch.
  // pylon 측 .env에 DISABLE_SHARED_MEMORY_SYNC=true 두면 git pull/push 자체를 안 함.
  if (process.env.DISABLE_SHARED_MEMORY_SYNC === "true") {
    console.log("[LemonClaw] Shared memory sync DISABLED (DISABLE_SHARED_MEMORY_SYNC=true)");
    return;
  }
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
  // 종료 전 마지막 sync (kill-switch 활성 시 skip)
  if (process.env.DISABLE_SHARED_MEMORY_SYNC !== "true") {
    syncSharedMemory().catch(() => {});
  }
  console.log("[LemonClaw] Stopped");
}
