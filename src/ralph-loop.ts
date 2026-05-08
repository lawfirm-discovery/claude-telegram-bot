/**
 * Ralph Loop — 장기 작업을 여러 Claude 세션에 걸쳐 반복 실행
 *
 * 핵심 원리: "에이전트는 매번 기억상실이지만, 파일시스템이 기억을 유지한다."
 *
 * tasks/{taskId}/
 *   prd.json       ← 태스크 아이템 + 상태
 *   progress.log   ← append-only 실행 기록
 *   context.md     ← 앵커 방식 압축 요약
 */

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, renameSync } from "fs";
import { join } from "path";
import { clearSession } from "./claude-engine";
import { askClaudeLight, runEvaluator, type EvalResult } from "./evaluator";
import { runRatchet } from "./test-ratchet";
import { incr, formatOneLineSummary } from "./metrics";
import { appendMemoryLog } from "./lemonclaw";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface TaskItem {
  id: string;
  description: string;
  passes: boolean;
  iteration: number;
  maxIterations: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  /**
   * 동일 미완료 reason 누적 — 봇 재시작 시 stuck 감지 일관성 유지.
   * 메모리 변수만 사용하면 resume 시 0부터 다시 세어 stuck 한 번 더 못 잡음.
   */
  stuckCount?: number;
  lastEvalReason?: string;
  /**
   * Phase R2.2 — state-hash invariant. 객관적 진척 신호 (ratchet + 파일/커밋/diff 토큰).
   * 같은 hash 가 INVARIANT_STUCK_THRESHOLD 회 연속이면 evaluator 무관하게 stuck.
   */
  lastStateHash?: string;
  invariantStuckCount?: number;
}

export interface TaskPRD {
  taskId: string;
  originalPrompt: string;
  requestedBy: string;
  repo: string;
  branch: string;
  files: string[];
  status: "pending" | "running" | "completed" | "failed" | "stopped";
  createdAt: number;
  completedAt?: number;
  items: TaskItem[];
  lastCompressLine: number;
  /**
   * 벽시계 한도 (Phase R1.2). 단위: 초. 누적 경과 시간이 한도 초과 시 자동 stop.
   * default: env RALPH_MAX_WALLCLOCK_SEC 또는 7200 (2시간).
   * 정액제 환경에서 token cost 계산 무의미 → 시간 기반 안전망으로 대체.
   */
  maxWallclockSec?: number;
}

export type AskClaudeFn = (chatId: string, message: string) => Promise<string>;
export type SendTelegramFn = (chatId: string, message: string) => Promise<void>;

export interface RalphLoopResult {
  taskId: string;
  completed: boolean;
  totalIterations: number;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════

const TASKS_DIR = join(import.meta.dir, "..", "tasks");
const MAX_ITERATIONS = parseInt(process.env.RALPH_MAX_ITERATIONS || "30");
const COMPRESS_THRESHOLD = 60;
/** 벽시계 한도 (Phase R1.2). 정액제 환경에서 비용 계산 무의미 → 시간 기반. */
const DEFAULT_MAX_WALLCLOCK_SEC = parseInt(process.env.RALPH_MAX_WALLCLOCK_SEC || "7200");
/** Phase R2.2 — 같은 state-hash N회 연속이면 stuck (default 4 — 평소 의미있는 변화 없는 반복). */
const INVARIANT_STUCK_THRESHOLD = parseInt(process.env.RALPH_INVARIANT_THRESHOLD || "4");
/**
 * Phase R2.5 — resumption-aware iteration cap.
 * 봇이 재시작되며 같은 task 가 반복 resume → loop → resume 사이클을 탈 때:
 *   현재 resume 후 RESUMPTION_BURST_SEC 안에 RESUMPTION_BURST_ITERS 회 이상 iter 가
 *   돌면 무한 resume 으로 간주하고 강제 종료.
 */
const RESUMPTION_BURST_SEC = parseInt(process.env.RALPH_RESUMPTION_BURST_SEC || "600");
const RESUMPTION_BURST_ITERS = parseInt(process.env.RALPH_RESUMPTION_BURST_ITERS || "50");

const REPO_PATHS: Record<string, string> = {
  "lemon-front": "/home/angrylawyer/lemon-front",
  "lemon-api-server-spring": "/home/angrylawyer/lemon-api-server-spring",
  "lemon-ai-server-FastAPI": "/home/angrylawyer/lemon-ai-server-FastAPI",
  "lemon_flutter": "/home/angrylawyer/lemon_flutter",
};

// ═══════════════════════════════════════════════════════════════
// File Operations
// ═══════════════════════════════════════════════════════════════

function taskDir(taskId: string): string {
  return join(TASKS_DIR, taskId);
}

function ensureTaskDir(taskId: string): void {
  const dir = taskDir(taskId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadPRD(taskId: string): TaskPRD | null {
  try {
    return JSON.parse(readFileSync(join(taskDir(taskId), "prd.json"), "utf-8"));
  } catch { return null; }
}

function savePRD(prd: TaskPRD): void {
  ensureTaskDir(prd.taskId);
  const tmp = join(taskDir(prd.taskId), "prd.json.tmp");
  const target = join(taskDir(prd.taskId), "prd.json");
  writeFileSync(tmp, JSON.stringify(prd, null, 2));
  renameSync(tmp, target);
}

/**
 * Phase R0.5 — progress 를 두 파일에 기록.
 * - progress.log: 사람이 보기 좋은 plain text (legacy 호환)
 * - progress.jsonl: 한 줄 = JSON, 자동화 (jq, dashboard) 친화
 *
 * payload 자동 추론:
 *   "ITERATION N START: ..." → { phase: "iter_start", n }
 *   "TEST RATCHET: PASS/FAIL ..." → { phase: "ratchet", passed, output }
 *   "EVALUATOR: complete=..." → { phase: "evaluator", complete, reason }
 *   기타 → { phase: "log" }
 */
function appendProgress(taskId: string, message: string): void {
  ensureTaskDir(taskId);
  const ts = new Date().toISOString();
  appendFileSync(join(taskDir(taskId), "progress.log"), `[${ts}] ${message}\n`);

  // structured event 도 기록 — 실패해도 본 동작 막지 않음
  try {
    const event: Record<string, unknown> = { ts, taskId, message };
    if (/^ITERATION (\d+).*START/.test(message)) {
      const m = message.match(/^ITERATION (\d+)\/(\d+) START: (.+)$/);
      event.phase = "iter_start";
      if (m) { event.iter = +m[1]; event.maxIter = +m[2]; event.itemId = m[3]; }
    } else if (/^ITERATION (\d+) END/.test(message)) {
      const m = message.match(/^ITERATION (\d+) END: (\d+)s/);
      event.phase = "iter_end";
      if (m) { event.iter = +m[1]; event.elapsedSec = +m[2]; }
    } else if (message.startsWith("TEST RATCHET:")) {
      event.phase = "ratchet";
      event.passed = /^TEST RATCHET: PASS/.test(message);
    } else if (message.startsWith("EVALUATOR:")) {
      event.phase = "evaluator";
      event.complete = /complete=true/.test(message);
    } else if (message.startsWith("ITEM DONE:")) {
      event.phase = "item_done";
    } else if (message.startsWith("ITEM FAILED:") || message.startsWith("STUCK DETECTED:")) {
      event.phase = "item_failed";
    } else if (message.startsWith("BUDGET EXCEEDED:")) {
      event.phase = "budget_exceeded";
    } else if (message.startsWith("STOP REQUESTED") || message.startsWith("STOPPED BY USER")) {
      event.phase = "stop";
    } else if (message.startsWith("RALPH LOOP START")) {
      event.phase = "loop_start";
    } else if (message.startsWith("RALPH LOOP END")) {
      event.phase = "loop_end";
    } else if (message.startsWith("CONTEXT COMPRESSED:")) {
      event.phase = "compress";
    } else if (message.startsWith("LOCK CONFLICT")) {
      event.phase = "lock_conflict";
    } else {
      event.phase = "log";
    }
    appendFileSync(join(taskDir(taskId), "progress.jsonl"), JSON.stringify(event) + "\n");
  } catch {
    // structured 기록 실패는 무시 (.log 만으로도 충분)
  }
}

function readProgressLines(taskId: string): string[] {
  try {
    return readFileSync(join(taskDir(taskId), "progress.log"), "utf-8")
      .split("\n").filter(Boolean);
  } catch { return []; }
}

function readContext(taskId: string): string {
  try {
    return readFileSync(join(taskDir(taskId), "context.md"), "utf-8");
  } catch { return ""; }
}

// ═══════════════════════════════════════════════════════════════
// Phase R1.3 — Fuzzy stuck fingerprint
// ═══════════════════════════════════════════════════════════════

/**
 * evaluator.reason 의 표면 변동 (숫자/공백/대소문자/조사 등) 흡수해서
 * 의미 있게 같은 사유인지 판별하는 fingerprint.
 *
 * 예) "보고서 미완성 (35%)" 와 "보고서가 미완성 (52%)" → 동일 fingerprint.
 *
 * 알고리즘:
 *   1. lowercase
 *   2. 숫자/퍼센트/소수점 제거
 *   3. 공백/구두점 정규화 (한 글자로 압축)
 *   4. 첫 120 글자만 사용 (긴 사유는 앞부분이 핵심)
 */
/**
 * Phase R4.2 — keyword 기반 fingerprint.
 *
 * 호성님 사고 (3060 d9941d81) 분석:
 *   evaluator reason 이 매번 표현 다름:
 *     "원본 작업은 '플러터 갭 구현 반복'인데 실제 구현 단계에 진입하지 못함..."
 *     "갭 분석·우선순위 결정은 완료했으나 플러터 실제 코드 수정이 전혀 없음..."
 *     "B1(주주명부), B2(이사회의사록) 등 나머지 약 5개 이상의 항목이 여전히 미구현..."
 *   → 첫 120자 정확 매칭 실패 → stuck 카운트 0 → 무한 iter
 *
 * 개선:
 *   1. 한국어 단어 단위 split (공백/구두점)
 *   2. 의미 약한 어미/조사/접속사 제거 (stop words)
 *   3. 핵심 keyword 추출 후 정렬 → 표현 변동 흡수
 *   4. 첫 N개 keyword 의 hash → 의미 비슷하면 동일 fingerprint
 */
const STOP_WORDS = new Set([
  "이", "그", "저", "이것", "그것", "저것", "이런", "그런", "저런",
  "은", "는", "이", "가", "을", "를", "에", "의", "와", "과", "로", "으로",
  "있", "없", "것", "수", "더", "안", "또", "그리고", "그러나", "하지만", "그래서",
  "원본", "작업", "현재", "이번", "다음", "여전히", "아직",
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "to", "of", "in", "on", "at", "by", "for", "with", "as",
  "and", "or", "but", "if", "then", "so", "not", "no", "yes",
]);

function reasonFingerprint(reason: string): string {
  if (!reason) return "";
  // 1. 정규화: lowercase + 숫자/퍼센트/구두점 제거
  const cleaned = reason
    .toLowerCase()
    .replace(/[\d.%]+/g, " ")
    .replace(/[,.\-—!?:;()'"`·•/_\[\]{}<>「」『』]+/g, " ");
  // 2. 단어 split + stop word 제거 + 1글자 단어 제거 (한국어 1글자 keyword 거의 무의미)
  const tokens = cleaned
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  // 3. 정렬 후 첫 N개 — 표현 순서 변동 흡수
  const top = Array.from(new Set(tokens)).sort().slice(0, 8);
  return top.join("|");
}

/**
 * Phase R1.4 — 응답이 "다음에 진행할게요" 류 미완 종결로 끝나면 truncation 후보로 마킹.
 *   stop_reason=max_tokens 가 1차 방어선이지만, SDK 가 마커 못 붙이는 경로 (legacy v1, askClaudeLight 등)
 *   대비 2차 방어선. 같은 미완 종결 패턴이 2회 연속이면 stuck 처리.
 *
 * 패턴:
 *   - "...하겠습니다" / "...진행하겠습니다" / "...수정하겠습니다" 류로 끝
 *   - 마지막 200자 안에 "이어서" / "다음에" 가 있고 마침표/줄바꿈 없이 종료
 */
function looksTruncatedKo(text: string): boolean {
  if (!text) return false;
  const tail = text.slice(-200).trim();
  // 종결 부호 (마침표/물음표/느낌표) 로 끝나면 정상 종결 → truncation 아님.
  if (/[.!?。？！]\s*$/.test(tail)) return false;
  // 마침표 없이 미완 종결로 갑자기 끝나는 경우만 truncation 후보:
  if (/(?:겠습니다|할게요|해드릴게요|진행하겠|수정하겠|작성하겠|확인하겠|검토하겠|이어가겠|이어서|계속해서|다음에)\s*$/.test(tail)) {
    return true;
  }
  // Phase R4.3 — 호성님 d9941d81 사고 데이터 기반 추가 패턴 (마침표 없는 작업 보고 끝):
  //   "다음 우선순위", "순차 진행", "구현 진행", "ITERATION X 시작", "확인 후 ...", 등
  if (/(?:다음\s*(?:우선순위|항목|단계|작업)|순차\s*(?:진행|구현)|구현\s*진행|작업\s*진행|확인\s*후|분석\s*후|ITERATION\s*\d+\s*시작)/i.test(tail)) {
    return true;
  }
  return false;
}

function writeContext(taskId: string, content: string): void {
  ensureTaskDir(taskId);
  writeFileSync(join(taskDir(taskId), "context.md"), content);
}

/**
 * Phase R2.2 — State-hash 기반 progress invariant.
 *
 * evaluator 의 reason 텍스트에 의존하지 않고 객관적 진척 신호 (ratchet pass/fail 패턴 +
 * response 의 git/file 키워드) 를 hash 하여 비교. 같은 hash 가 N iter 동안 유지되면 stuck.
 *
 * 호성님 사고에선 응답이 매번 미묘하게 다른 텍스트를 만들어내며 evaluator 가 각기 다른
 * reason 을 반환했지만, 실제 코드/파일 변경은 0 이었음. fingerprint (R1.3) 로도 일부
 * 잡히지만, 더 결정적인 신호가 필요함.
 *
 * 입력 — 한 iteration 의 결과:
 *   ratchetPassed (bool), ratchetSummary 첫 줄, response 의 file path/diff 토큰
 */
function progressStateHash(args: {
  ratchetPassed: boolean;
  ratchetSummary: string;
  response: string;
}): string {
  const ratchetSig = `${args.ratchetPassed ? "P" : "F"}|${args.ratchetSummary.split("\n")[0].slice(0, 120)}`;

  // response 에서 진척의 객관적 흔적만 추출:
  //   - 파일 경로 (a-zA-Z0-9_/.- 으로 시작 + 확장자)
  //   - git commit hash (7~40 hex)
  //   - +N -M lines added/removed 표현
  // 이런 건 진짜 코드 변경이 있을 때만 응답에 등장.
  const sigParts: string[] = [];
  const filePaths = args.response.match(/[\w./-]+\.(ts|tsx|js|jsx|py|java|go|rs|md|json|yaml|yml|sql)\b/gi) || [];
  if (filePaths.length) sigParts.push("F:" + filePaths.slice(0, 5).sort().join(","));
  const commitHashes = args.response.match(/\b[0-9a-f]{7,12}\b/g) || [];
  if (commitHashes.length) sigParts.push("C:" + commitHashes.slice(0, 3).sort().join(","));
  const diffStats = args.response.match(/[+-]\d+ ?(?:lines?|files?)?/g) || [];
  if (diffStats.length) sigParts.push("D:" + diffStats.slice(0, 3).join(","));

  return ratchetSig + "||" + sigParts.join("|");
}

// ═══════════════════════════════════════════════════════════════
// Phase R3.3 + R3.5 — Git workflow 자동화 (1인 사용자 + 단일 브랜치)
// ═══════════════════════════════════════════════════════════════

import { execSync } from "child_process";

/**
 * Phase R3.5 — 자동 commit/push 활성화 flag.
 * default OFF (안전) — 호성님이 명시적으로 RALPH_AUTO_GIT=true 설정 시 활성.
 * test 환경 / 의심스러운 환경에서 실제 repo 건드리는 사고 방지.
 */
const AUTO_GIT_ENABLED = process.env.RALPH_AUTO_GIT === "true";

/** repo 디렉토리에서 git 명령 실행. 실패 시 null 반환 (사후 진단 용도, 비치명적). */
function runGitInRepo(repo: string, args: string[]): string | null {
  const cwd = REPO_PATHS[repo];
  if (!cwd) return null;
  try {
    return execSync(`git ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`,
      { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }
    ).toString();
  } catch {
    return null;
  }
}

/** Phase R3.3 — git diff --stat 을 progress 에 기록 + responses/{itemId}-{N}.diff 에 full diff 저장. */
function captureGitDiff(taskId: string, itemId: string, iter: number, repo: string): { hasChanges: boolean; statSummary: string } {
  if (!repo || !AUTO_GIT_ENABLED) return { hasChanges: false, statSummary: "" };
  const stat = runGitInRepo(repo, ["diff", "--stat"]) ?? "";
  const status = runGitInRepo(repo, ["status", "--porcelain"]) ?? "";
  const hasChanges = !!status.trim() || !!stat.trim();
  if (!hasChanges) return { hasChanges: false, statSummary: "" };

  // full diff 도 별도 파일로 저장 (사후 진단 용도)
  try {
    const fullDiff = runGitInRepo(repo, ["diff", "HEAD"]);
    if (fullDiff) {
      const dir = join(taskDir(taskId), "responses");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${itemId}-${String(iter).padStart(3, "0")}.diff`), fullDiff);
    }
  } catch {}

  // stat summary — 한 줄로 (마지막 line 이 보통 'X files changed')
  const statLines = stat.trim().split("\n");
  const statSummary = statLines.length > 0
    ? statLines[statLines.length - 1] + (statLines.length > 1 ? ` (${statLines.length - 1} files)` : "")
    : "";
  return { hasChanges: true, statSummary };
}

/**
 * Phase R3.5 — Option C Hybrid:
 *   - 매 iter 끝에 ratchet 통과 + 변경 있으면 자동 commit (amend 금지, 항상 새 commit)
 *   - item 완료 (passes=true) 시 자동 push origin dev-hs-rtx6000-new
 *   - ratchet 실패 시 commit 안 함 (깨진 코드 push 차단)
 */
function autoCommit(repo: string, taskId: string, itemId: string, iter: number, summary: string): boolean {
  if (!repo || !AUTO_GIT_ENABLED) return false;
  const status = runGitInRepo(repo, ["status", "--porcelain"]);
  if (!status || !status.trim()) return false; // 변경 없음

  const botName = process.env.BOT_NAME || process.env.HOSTNAME || "ralph";
  const safeSummary = summary.replace(/['"]/g, "").slice(0, 80) || "iteration progress";
  const msg = `[${botName}] ralph #${taskId} iter ${iter} ${itemId}: ${safeSummary}`;

  const addResult = runGitInRepo(repo, ["add", "-A"]);
  if (addResult === null) return false;
  const commitResult = runGitInRepo(repo, ["commit", "-m", msg]);
  return commitResult !== null;
}

function autoPush(repo: string): boolean {
  if (!repo || !AUTO_GIT_ENABLED) return false;
  // 호성님 절대 규칙: dev-hs-rtx6000-new 브랜치만
  const result = runGitInRepo(repo, ["push", "origin", "dev-hs-rtx6000-new"]);
  return result !== null;
}

/**
 * Phase R2.1 — 매 iteration 의 raw response 를 압축과 무관하게 보존.
 *   tasks/{taskId}/responses/iter-{itemId}-{n}.txt
 *   compressContext 가 progress.log 를 요약해도 raw 는 그대로 남음 → stuck 사후 진단 가능.
 *   재실행/resume 에는 영향 없음 (읽기 전용 archive).
 */
function saveRawResponse(taskId: string, itemId: string, iter: number, response: string): void {
  try {
    const dir = join(taskDir(taskId), "responses");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = join(dir, `${itemId}-${String(iter).padStart(3, "0")}.txt`);
    writeFileSync(path, response);
  } catch {
    // 진단용 부수 효과 — 실패해도 본 동작 막지 않음
  }
}

// ═══════════════════════════════════════════════════════════════
// Task Lock — 같은 task 의 동시 실행 방지 (Phase R0.2 W4)
// ═══════════════════════════════════════════════════════════════

interface LockFile {
  pid: number;
  bot: string;
  acquiredAt: number;
}

function lockPath(taskId: string): string {
  return join(taskDir(taskId), ".lock");
}

/**
 * 다른 프로세스 / 봇이 이 task 를 잡고 있는지 확인.
 * 같은 PID 가 살아있으면 hot lock, PID 죽었으면 stale → 해제 가능.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = exists check
    return true;
  } catch {
    return false;
  }
}

/** lock 획득 시도. 실패 시 기존 lock 정보 반환 (호출자가 사용자 알림). */
export function acquireTaskLock(taskId: string): { ok: true } | { ok: false; existing: LockFile } {
  ensureTaskDir(taskId);
  const path = lockPath(taskId);
  if (existsSync(path)) {
    try {
      const existing: LockFile = JSON.parse(readFileSync(path, "utf-8"));
      if (existing.pid && isProcessAlive(existing.pid)) {
        return { ok: false, existing };
      }
      // stale lock — 무시하고 덮어씀
      appendProgress(taskId, `STALE LOCK 해제: pid=${existing.pid} bot=${existing.bot ?? "?"}`);
    } catch {
      // 손상된 lock 파일 → 덮어씀
    }
  }
  const lock: LockFile = {
    pid: process.pid,
    bot: process.env.BOT_NAME || process.env.HOSTNAME || "unknown",
    acquiredAt: Date.now(),
  };
  writeFileSync(path, JSON.stringify(lock, null, 2));
  return { ok: true };
}

export function releaseTaskLock(taskId: string): void {
  const path = lockPath(taskId);
  try {
    if (existsSync(path)) {
      const lock: LockFile = JSON.parse(readFileSync(path, "utf-8"));
      // 자기 PID 의 lock 만 해제
      if (lock.pid === process.pid) {
        require("fs").unlinkSync(path);
      }
    }
  } catch (e) {
    appendProgress(taskId, `LOCK 해제 실패 (무시): ${(e as Error).message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Task Creation
// ═══════════════════════════════════════════════════════════════

export function createTask(params: {
  taskId?: string;
  originalPrompt: string;
  requestedBy: string;
  repo: string;
  branch: string;
  files: string[];
  items: Array<{ description: string; maxIterations?: number }>;
  /** 벽시계 한도(초) — undefined 면 default (env RALPH_MAX_WALLCLOCK_SEC) 또는 7200. */
  maxWallclockSec?: number;
}): TaskPRD {
  const taskId = params.taskId || randomUUID().slice(0, 8);
  const prd: TaskPRD = {
    taskId,
    originalPrompt: params.originalPrompt,
    requestedBy: params.requestedBy,
    repo: params.repo,
    branch: params.branch,
    files: params.files,
    status: "pending",
    createdAt: Date.now(),
    items: params.items.map((item, i) => ({
      id: `item-${i + 1}`,
      description: item.description,
      passes: false,
      iteration: 0,
      maxIterations: item.maxIterations ?? MAX_ITERATIONS,
    })),
    lastCompressLine: 0,
    maxWallclockSec: params.maxWallclockSec ?? DEFAULT_MAX_WALLCLOCK_SEC,
  };
  savePRD(prd);
  appendProgress(taskId, `TASK CREATED: ${params.originalPrompt.slice(0, 200)}`);
  if (prd.maxWallclockSec) {
    appendProgress(taskId, `WALLCLOCK LIMIT: ${prd.maxWallclockSec}s (${Math.round(prd.maxWallclockSec / 60)}min)`);
  }
  return prd;
}

// ═══════════════════════════════════════════════════════════════
// Sub-Goal Planner — 작업을 검증 가능한 서브목표로 분해
// ═══════════════════════════════════════════════════════════════

export async function planSubGoals(
  originalPrompt: string,
  repo: string,
): Promise<Array<{ description: string; maxIterations: number }>> {
  const repoInfo = repo && REPO_PATHS[repo]
    ? `\n대상 레포: ${repo} (${REPO_PATHS[repo]})`
    : "";

  const prompt = `당신은 소프트웨어 작업 계획자입니다. 주어진 작업을 검증 가능한 서브목표로 분해하세요.

## 작업
${originalPrompt}${repoInfo}

## 규칙
- 단순 작업: 1~2개, 중간 작업: 3~5개, 복잡한 작업: 5~7개 서브목표
- 각 목표는 독립적으로 완료 가능하고 검증 방법이 명확해야 함
- maxIterations: 단순=10, 보통=20, 복잡=30 (최대 40)
- **보고서/분석 류 작업**: 결과물을 파일에 저장하는 단계로 명시 (예: "X 분석 결과를 docs/Y.md 에 저장")
  → 응답 본문에 보고서 본문 출력 금지 (token 한도로 truncated 시 무한 루프)
- JSON 배열만 반환 (다른 텍스트 없이):

[{"description": "구체적 서브목표 (파일 저장 위치 포함)", "maxIterations": 20}]`;

  const raw = await askClaudeLight(prompt, { timeoutMs: 30_000 });
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("planSubGoals: JSON 배열 파싱 실패");

  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed) || !parsed.length) throw new Error("planSubGoals: 빈 결과");

  return parsed.map((g: any) => {
    const description = String(g.description || "").slice(0, 500);
    let maxIterations = Math.min(40, Math.max(5, parseInt(g.maxIterations) || MAX_ITERATIONS));
    // Phase R4.4 — 보고서/분석/문서 류 task 의 maxIter 자동 cap (호성님 d9941d81 사고 패턴 차단)
    //   응답 truncation 으로 무한 iter 가능성이 큰 task 를 미리 5회로 제한.
    //   출력이 짧지 않은 task 는 plan 단계에서 파일 저장 형태로 분해되어야 함 (R2.4 prompt 보강 참조).
    const isReportLike = /보고서|분석|문서|리포트|요약|정리|점검|검토|체크|review|report|analysis|summary|audit/i.test(description);
    if (isReportLike && maxIterations > 5) {
      console.log(`[planSubGoals] report-like task → maxIter ${maxIterations} → 5: ${description.slice(0, 60)}`);
      maxIterations = 5;
    }
    return { description, maxIterations };
  });
}

// ═══════════════════════════════════════════════════════════════
// Context Compression — Anchored Iterative (Factory 방식)
// ═══════════════════════════════════════════════════════════════

async function compressContext(taskId: string, prd: TaskPRD): Promise<void> {
  const lines = readProgressLines(taskId);
  const newLines = lines.slice(prd.lastCompressLine);
  if (newLines.length < 20) return;

  const existing = readContext(taskId);

  const prompt = `아래 작업 로그를 간결한 요약으로 합쳐주세요.

${existing ? `## 기존 요약\n${existing}\n` : ""}
## 새로 추가된 로그 (${newLines.length}줄)
${newLines.join("\n")}

다음 형식으로 요약 (마크다운, 간결하게):
## 원본 작업
(한 줄)
## 완료된 작업
- 항목별 나열
## 발견한 패턴/주의사항
- 중요한 것만
## 남은 작업
- 미완료 항목`;

  try {
    const summary = await askClaudeLight(prompt);
    writeContext(taskId, summary);
    prd.lastCompressLine = lines.length;
    savePRD(prd);
    appendProgress(taskId, `CONTEXT COMPRESSED: ${lines.length} lines → summary`);
  } catch (e: any) {
    appendProgress(taskId, `COMPRESS FAILED: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Ralph Loop — 메인 반복 실행
// ═══════════════════════════════════════════════════════════════

export async function runRalphLoop(
  taskId: string,
  askClaude: AskClaudeFn,
  sendTg: SendTelegramFn,
): Promise<RalphLoopResult> {
  const prd = loadPRD(taskId);
  if (!prd) return { taskId, completed: false, totalIterations: 0, error: "prd.json not found" };

  // Phase R0.2 — task lock 획득 (동시 실행 방지)
  const lockResult = acquireTaskLock(taskId);
  if (!lockResult.ok) {
    const ex = lockResult.existing;
    const errMsg = `이미 실행 중: pid=${ex.pid} bot=${ex.bot} (${Math.round((Date.now() - ex.acquiredAt) / 1000)}s 전 시작)`;
    appendProgress(taskId, `LOCK CONFLICT: ${errMsg}`);
    return { taskId, completed: false, totalIterations: 0, error: errMsg };
  }

  prd.status = "running";
  // Phase R1.2 — wallclock 한도가 누락된 legacy task 에 default 주입
  if (prd.maxWallclockSec === undefined) {
    prd.maxWallclockSec = DEFAULT_MAX_WALLCLOCK_SEC;
  }
  savePRD(prd);
  appendProgress(taskId, `RALPH LOOP START (pid=${process.pid} bot=${process.env.BOT_NAME ?? "?"})`);

  // Phase R2.5 — resumption-aware burst counter (in-memory, 본 process 의 진입 시점 baseline)
  const resumeStartedAt = Date.now();
  let iterSinceResume = 0;

  const syntheticChatId = `ralph-${taskId}`;
  let totalIterations = 0;

  for (const item of prd.items) {
    if (item.passes) continue;

    item.startedAt = item.startedAt || Date.now();
    appendProgress(taskId, `ITEM START: ${item.id} — ${item.description.slice(0, 100)}`);

    let lastEvalFeedback: EvalResult | undefined;
    // ── stuck 상태는 prd.json 에 영속 — 봇 재시작 시 카운터 유지 (Phase R0.1 W1+W8) ──
    if (item.stuckCount === undefined) item.stuckCount = 0;
    if (item.lastEvalReason === undefined) item.lastEvalReason = "";

    while (!item.passes && item.iteration < item.maxIterations) {
      // Phase R1.2 — 매 iteration 진입 시 wallclock + 사용자 stop 신호 체크.
      //   prd 를 reload 해서 외부 (다른 process / /ralph stop 명령) 변경 반영.
      const fresh = loadPRD(taskId);
      if (fresh && fresh.status === "stopped") {
        appendProgress(taskId, `STOPPED BY USER (status='stopped' detected at iteration ${item.iteration + 1})`);
        await sendTg(prd.requestedBy,
          `⏹ Ralph #${taskId} 사용자 요청으로 중단됨 (item ${item.id}, iter ${item.iteration})`,
        );
        item.error = item.error || "stopped by user";
        savePRD(prd);
        releaseTaskLock(taskId);
        return { taskId, completed: false, totalIterations, error: "stopped" };
      }

      // wallclock guard — 정액제 환경에서 token cost 무의미 → 시간 한도가 유일한 안전망
      if (prd.maxWallclockSec) {
        const elapsedSec = Math.round((Date.now() - prd.createdAt) / 1000);
        if (elapsedSec >= prd.maxWallclockSec) {
          const min = Math.round(elapsedSec / 60);
          const limitMin = Math.round(prd.maxWallclockSec / 60);
          const msg = `⏰ Ralph #${taskId} 시간 한도 초과: ${min}분 ≥ ${limitMin}분 (item ${item.id}, iter ${item.iteration})`;
          appendProgress(taskId, `WALLCLOCK EXCEEDED: ${elapsedSec}s ≥ ${prd.maxWallclockSec}s`);
          await sendTg(prd.requestedBy, msg + `\n수동 확인 후 /ralph status ${taskId}`);
          item.error = `wallclock exceeded: ${elapsedSec}s`;
          incr("ralph.wallclock_exceeded");
          prd.status = "failed";
          savePRD(prd);
          releaseTaskLock(taskId);
          return { taskId, completed: false, totalIterations, error: "wallclock exceeded" };
        }
      }

      // Phase R2.5 — resumption burst guard. 봇이 자주 재시작되며 같은 task 를 다시 잡고
      //   처음부터 진행하는 사이클 (50 iter / 10분) 을 차단. 사용자에게 알림 + status='failed'.
      iterSinceResume++;
      const sinceResumeSec = Math.round((Date.now() - resumeStartedAt) / 1000);
      if (iterSinceResume >= RESUMPTION_BURST_ITERS && sinceResumeSec <= RESUMPTION_BURST_SEC) {
        const msg = `🌀 Ralph #${taskId} resumption burst 감지 — ` +
          `${iterSinceResume} iter / ${sinceResumeSec}s (한도 ${RESUMPTION_BURST_ITERS}/${RESUMPTION_BURST_SEC}s)\n` +
          `봇이 자주 재시작되며 같은 작업을 무한 반복 → 강제 종료`;
        appendProgress(taskId, `RESUMPTION BURST: ${iterSinceResume}/${sinceResumeSec}s → halt`);
        await sendTg(prd.requestedBy, msg + `\n/ralph status ${taskId}`);
        item.error = "resumption burst";
        incr("ralph.resumption_burst");
        prd.status = "failed";
        savePRD(prd);
        releaseTaskLock(taskId);
        return { taskId, completed: false, totalIterations, error: "resumption burst" };
      }

      item.iteration++;
      totalIterations++;
      const iterStart = Date.now();

      appendProgress(taskId, `ITERATION ${item.iteration}/${item.maxIterations} START: ${item.id}`);
      incr("ralph.iteration.start");

      // 매 반복마다 세션 초기화 → 깨끗한 컨텍스트
      clearSession(syntheticChatId);

      // 1. 프롬프트 조합 (이전 평가 피드백 포함)
      const context = readContext(taskId);
      const recentLog = readProgressLines(taskId).slice(-10).join("\n");
      const prompt = buildIterationPrompt(prd, item, context, recentLog, lastEvalFeedback);

      // 2. Claude 실행
      try {
        const response = await askClaude(syntheticChatId, prompt);

        // Phase R2.1 — raw response 보존 (압축 무관, 사후 진단용)
        saveRawResponse(taskId, item.id, item.iteration, response);

        const elapsed = Math.round((Date.now() - iterStart) / 1000);
        appendProgress(taskId, `ITERATION ${item.iteration} END: ${elapsed}s`);
        appendProgress(taskId, `RESPONSE: ${response.replace(/\n/g, " ").slice(0, 300)}`);

        // Phase R1.1 — claude-v3 가 stop_reason=max_tokens 감지 시 prepend 한 마커 검사.
        //   truncated 응답을 evaluator 에 보내면 항상 incomplete 라 무한 루프 (호성님 사고 사례).
        //   즉시 stuck 처리 → 사용자 에스컬레이트.
        if (response.startsWith("__TRUNCATED_MAX_TOKENS__")) {
          incr("ralph.truncated_halt");
          appendProgress(taskId, `TRUNCATED OUTPUT DETECTED → halting item (max_tokens)`);
          await sendTg(prd.requestedBy,
            `⚠️ Ralph #${taskId} — ${item.id} 응답 잘림 (max_tokens) → 자동 중단\n` +
            `iter ${item.iteration}/${item.maxIterations}, ${elapsed}s\n` +
            `대응: 작업을 더 작은 단위로 분해하거나 보고서를 파일로 저장하도록 재요청\n` +
            `/ralph status ${taskId}`,
          );
          item.error = "truncated (max_tokens)";
          savePRD(prd);
          break; // 다음 item 으로 진행 (이 item 은 실패 처리)
        }

        // Phase R1.4 — 미완 종결 패턴 감지 (2차 방어선).
        //   stop_reason 마커가 없는 경로 (askClaudeLight, legacy v1) 대비.
        //   같은 패턴 2회 연속이면 stuck 처리 (3회 reason 매칭보다 빠르게).
        if (looksTruncatedKo(response)) {
          item.stuckCount = (item.stuckCount ?? 0) + 1;
          appendProgress(taskId, `TRUNCATED-LIKE TAIL: stuckCount=${item.stuckCount}`);
          if ((item.stuckCount ?? 0) >= 2) {
            incr("ralph.truncated_halt");
            await sendTg(prd.requestedBy,
              `⚠️ Ralph #${taskId} — ${item.id} 응답이 미완 종결 패턴 ${item.stuckCount}회 연속\n` +
              `iter ${item.iteration}/${item.maxIterations}\n` +
              `대응: 보고서를 파일로 저장하도록 재요청 (출력 길이 제약 우회)\n` +
              `/ralph status ${taskId}`,
            );
            item.error = "truncated-like (mid-sentence end)";
            savePRD(prd);
            break;
          }
        }

        // 3. 컨텍스트 압축 체크
        const lineCount = readProgressLines(taskId).length;
        if (lineCount - prd.lastCompressLine >= COMPRESS_THRESHOLD) {
          await compressContext(taskId, prd);
        }

        // 4. Test Ratchet — tasks/{taskId}/tests.json 동결 명령 사용
        const testResult = await runRatchet(taskDir(taskId), prd.repo);
        const testSummary = `${testResult.passed ? "PASS" : "FAIL"}: ${testResult.output.slice(0, 400)}`;
        appendProgress(taskId, `TEST RATCHET: ${testSummary}`);
        incr(testResult.passed ? "ratchet.pass" : "ratchet.fail");

        // 5. Evaluator (별도 세션, default Haiku 4.5)
        const evalResult = await runEvaluator({
          taskDescription: item.description,
          contextSummary: readContext(taskId),
          recentLogTail: readProgressLines(taskId).slice(-10).join("\n"),
          testResult: testSummary,
        });
        appendProgress(taskId, `EVALUATOR: complete=${evalResult.complete}, reason=${evalResult.reason}${evalResult.nextFocus ? `, nextFocus=${evalResult.nextFocus}` : ""}`);
        if (evalResult.reason.startsWith("evaluator: JSON parse failed")) {
          incr("evaluator.parse_failed");
        } else {
          incr(evalResult.complete ? "evaluator.complete" : "evaluator.incomplete");
        }
        incr("ralph.iteration.end");

        // 6a. Phase R2.2 — state-hash invariant 체크 (evaluator 와 독립).
        //     ratchet 결과 + response 의 진척 토큰 (파일/커밋/diff) 의 hash.
        //     같은 hash 가 INVARIANT_STUCK_THRESHOLD 회 연속이면 진짜 진척 0 → stuck.
        const stateHash = progressStateHash({
          ratchetPassed: testResult.passed,
          ratchetSummary: testSummary,
          response,
        });
        if (stateHash === item.lastStateHash) {
          item.invariantStuckCount = (item.invariantStuckCount ?? 0) + 1;
          appendProgress(taskId, `INVARIANT MATCH: ${item.invariantStuckCount}× same state-hash`);
        } else {
          item.invariantStuckCount = 0;
          item.lastStateHash = stateHash;
        }
        if ((item.invariantStuckCount ?? 0) >= INVARIANT_STUCK_THRESHOLD) {
          incr("ralph.invariant_stuck");
          await sendTg(prd.requestedBy,
            `🧱 Ralph #${taskId} — ${item.id} 진척 없음 (${item.invariantStuckCount}회 연속 동일 상태)\n` +
            `iter ${item.iteration}/${item.maxIterations}\n` +
            `state-hash: ${stateHash.slice(0, 80)}\n` +
            `대응: 작업 분해 또는 다른 접근 필요\n/ralph status ${taskId}`,
          );
          appendProgress(taskId, `INVARIANT STUCK: ${item.invariantStuckCount}× → halting item`);
          item.error = `invariant stuck (${item.invariantStuckCount}× same state)`;
          savePRD(prd);
          break;
        }

        // 6b. Stuck 감지 — fingerprint 기반 fuzzy 비교 (Phase R1.3)
        //    이전엔 reason 문자열 정확 매칭 → 평가자가 매번 약간 다르게 표현하면 카운트 reset
        //    → 38분 무한 루프 사고. 이제 lowercase + 숫자제거 + 첫 120자 normalize 후 비교.
        if (!evalResult.complete) {
          const newFp = reasonFingerprint(evalResult.reason);
          const oldFp = reasonFingerprint(item.lastEvalReason || "");
          if (newFp && newFp === oldFp) {
            item.stuckCount = (item.stuckCount ?? 0) + 1;
          } else {
            item.stuckCount = 0;
            item.lastEvalReason = evalResult.reason;
          }
          if ((item.stuckCount ?? 0) >= 3) {
            const stuckMsg =
              `⚠️ Ralph #${taskId} — ${item.id} stuck!\n` +
              `동일 문제 ${(item.stuckCount ?? 0) + 1}회 반복: ${evalResult.reason}\n` +
              `${evalResult.nextFocus ? `집중 영역: ${evalResult.nextFocus}\n` : ""}` +
              `수동 확인 후 /ralph status ${taskId}`;
            await sendTg(prd.requestedBy, stuckMsg);
            appendProgress(taskId, `STUCK DETECTED: ${evalResult.reason}`);
            item.error = `stuck: ${evalResult.reason}`;
            incr("ralph.stuck");
            savePRD(prd);
            break;
          }
        } else {
          item.stuckCount = 0;
          item.lastEvalReason = "";
        }

        // 7. 다음 반복에 평가 피드백 전달
        lastEvalFeedback = evalResult;

        // 8. 짝수 반복마다 진행 상황 알림 (1회는 item 시작 알림과 중복 방지)
        if (item.iteration % 2 === 0 && !evalResult.complete) {
          const iterMsg =
            `🔄 Ralph #${taskId} — ${item.id} iter ${item.iteration}/${item.maxIterations}\n` +
            `테스트: ${testResult.passed ? "✅" : "❌"} | 평가: 미완료\n` +
            `${evalResult.nextFocus ? `다음 집중: ${evalResult.nextFocus.slice(0, 80)}` : evalResult.reason.slice(0, 80)}`;
          await sendTg(prd.requestedBy, iterMsg);
        }

        // Phase R3.3 — git diff --stat 자동 기록 (변경 가시성)
        const diffInfo = captureGitDiff(taskId, item.id, item.iteration, prd.repo);
        if (diffInfo.hasChanges) {
          appendProgress(taskId, `GIT DIFF: ${diffInfo.statSummary}`);
        }

        // Phase R3.5 — Option C Hybrid: ratchet 통과 시 자동 commit (매 iter)
        if (testResult.passed && diffInfo.hasChanges) {
          const commitMsg = lastEvalFeedback?.nextFocus || evalResult.reason || item.description.slice(0, 80);
          const committed = autoCommit(prd.repo, taskId, item.id, item.iteration, commitMsg);
          appendProgress(taskId, committed ? `AUTO COMMIT: ${diffInfo.statSummary}` : `AUTO COMMIT 실패`);
          if (committed) incr("ralph.auto_commit");
        } else if (diffInfo.hasChanges && !testResult.passed) {
          appendProgress(taskId, `COMMIT SKIPPED: ratchet 실패 (변경 있지만 커밋 안 함 — 깨진 코드 차단)`);
        }

        if (evalResult.complete && testResult.passed) {
          item.passes = true;
          item.completedAt = Date.now();
          appendProgress(taskId, `ITEM DONE: ${item.id}`);
          incr("ralph.item.passed");

          // Phase R3.5 — item 완료 시 push (rtx6000 동기화 의미 있는 단위)
          const pushed = autoPush(prd.repo);
          appendProgress(taskId, pushed ? `AUTO PUSH: dev-hs-rtx6000-new` : `AUTO PUSH 실패 (또는 변경 없음)`);
          if (pushed) incr("ralph.auto_push");

          await sendTg(prd.requestedBy,
            `✅ Ralph #${taskId} — ${item.id} 완료 (iter ${item.iteration}): ${item.description.slice(0, 80)}`
            + (pushed ? `\n📤 ${prd.repo} → dev-hs-rtx6000-new push 완료` : "")
          );
        } else if (!testResult.passed) {
          appendProgress(taskId, `TEST FAILED → next iteration will fix`);
        } else {
          appendProgress(taskId, `NOT COMPLETE: ${evalResult.remainingWork || evalResult.reason}`);
        }
      } catch (e: any) {
        appendProgress(taskId, `ITERATION ${item.iteration} ERROR: ${e.message}`);
        item.error = e.message;

        if (/auth|billing|api_key/i.test(e.message)) {
          prd.status = "failed";
          savePRD(prd);
          releaseTaskLock(taskId); // 인증 실패도 정상 종료 — lock 해제
          return { taskId, completed: false, totalIterations, error: e.message };
        }
      }

      savePRD(prd);
    }

    if (!item.passes) {
      appendProgress(taskId, `ITEM FAILED: ${item.id} — max iterations exceeded`);
      item.error = item.error || `max iterations (${item.maxIterations}) exceeded`;
      incr("ralph.item.failed");
      savePRD(prd);
    }
  }

  const allDone = prd.items.every(i => i.passes);
  prd.status = allDone ? "completed" : "failed";
  prd.completedAt = Date.now();
  savePRD(prd);

  const elapsed = Math.round((prd.completedAt - prd.createdAt) / 1000);
  appendProgress(taskId, `RALPH LOOP END: ${prd.status} (${elapsed}s, ${totalIterations} iterations)`);

  // Phase R0.2 — lock 해제 (정상 종료)
  releaseTaskLock(taskId);

  // LemonClaw 공유 메모리에 한 줄 요약 append → 다음 ralph가 system prompt로 자기 패턴 인지
  try {
    const verdict = allDone ? "✅" : "❌";
    appendMemoryLog(
      `RALPH #${taskId} ${verdict} ${prd.repo} "${prd.originalPrompt.slice(0, 80)}" ` +
      `iter=${totalIterations} ${elapsed}s items=${prd.items.length} ` +
      `passed=${prd.items.filter(i => i.passes).length} ${formatOneLineSummary()}`
    );
  } catch (e: any) {
    console.error(`[ralph-loop] memory append failed: ${e.message}`);
  }

  return { taskId, completed: allDone, totalIterations };
}

// ═══════════════════════════════════════════════════════════════
// Prompt Builder
// ═══════════════════════════════════════════════════════════════

function buildIterationPrompt(
  prd: TaskPRD,
  item: TaskItem,
  context: string,
  recentLog: string,
  lastEvalFeedback?: EvalResult,
): string {
  const parts: string[] = [];

  // Phase R3.2 — 매 iteration 시작 시 프로젝트 규칙 인지 강제 (절대 규칙 위반 방지)
  parts.push(`## 작업 전 필수 확인 (READ FIRST)
1. 작업 대상 레포의 \`CLAUDE.md\` 를 먼저 read — 호성님 절대 규칙 (ddl-auto=validate, port 3000 금지, bootJar 금지, dev-hs-rtx6000-new 브랜치만, craco 금지 등) 인지
2. \`.claude/agents/\` 에 sub-agent 가이드가 있으면 read
3. 기존 패턴 따르기 — 새 추상화/의존성 도입 전 grep 으로 기존 코드 검색
4. 'as any' TypeScript 사용 지양 — 정확한 타입 작성
5. 최소 변경 원칙 — 인접 코드 리팩토링 금지`);

  if (context) {
    parts.push(`## 이전 작업 진행 상황\n${context}`);
  }

  parts.push(`## 현재 작업\n${item.description}`);

  if (prd.repo) parts.push(`레포: ${prd.repo} (${REPO_PATHS[prd.repo] || prd.repo})`);
  if (prd.branch) parts.push(`브랜치: ${prd.branch}`);
  if (prd.files.length) parts.push(`관련 파일: ${prd.files.join(", ")}`);

  if (recentLog) {
    parts.push(`## 최근 진행 로그\n${recentLog}`);
  }

  // 이전 평가자 피드백 — 다음 반복에서 집중할 방향 제시
  if (lastEvalFeedback && !lastEvalFeedback.complete) {
    const feedbackLines = [
      `이전 반복에서 평가자가 **미완료**로 판정했습니다.`,
      `- 판정 이유: ${lastEvalFeedback.reason}`,
    ];
    if (lastEvalFeedback.nextFocus) {
      feedbackLines.push(`- 이번 반복에서 반드시 해결할 것: **${lastEvalFeedback.nextFocus}**`);
    }
    if (lastEvalFeedback.remainingWork) {
      feedbackLines.push(`- 남은 작업: ${lastEvalFeedback.remainingWork}`);
    }
    parts.push(`## ⚠️ 이전 평가자 피드백\n${feedbackLines.join("\n")}`);
  }

  if (item.iteration > 1) {
    parts.push(`## 주의사항
- 이것은 반복 ${item.iteration}/${item.maxIterations}입니다
- 이전 반복에서 진행한 작업을 이어서 수행하세요
- 이미 완료된 부분은 건드리지 마세요
- 이전에 실패한 테스트가 있다면 해당 문제를 수정하세요
- 작업 후 변경 내용을 git commit 하세요`);
  } else {
    parts.push(`## 지시사항
- 작업 완료 후 변경 내용을 git commit 하세요
- 테스트/컴파일이 통과하는지 확인하세요`);
  }

  // Phase R2.4 — 응답 형식 강제 (structured output).
  //   "보고서/분석/문서" 류 작업이 응답 본문에 직접 출력되면 token 한도로 truncated → 무한 루프.
  //   파일 저장 + 짧은 요약 패턴을 prompt 에 명시 → truncation 자체 회피.
  parts.push(`## 응답 형식 (반드시 준수)
- 긴 결과물(보고서, 분석, 목록 100줄 이상)은 **반드시 파일에 저장**하고 응답에는 다음만 포함:
  - 저장한 파일의 절대 경로
  - 핵심 결과 요약 (10줄 이내)
  - 다음 단계 (1~3줄)
- 응답 본문에 보고서 전체를 출력하지 마세요. 응답이 잘리면 작업이 무한 루프에 빠집니다.
- 응답은 마침표(.)로 끝나야 합니다. "...하겠습니다" 같은 미완 종결 금지 — 한 iteration 안에서 완결.`);

  return parts.join("\n\n");
}

// ═══════════════════════════════════════════════════════════════
// startRalphTask — 사용자 직접 호출용 (bot.ts /ralph 커맨드)
// ═══════════════════════════════════════════════════════════════

/**
 * Phase R4.1 (W1) — Claude CLI 인증 상태 사전 검증.
 *
 * lawbotss-mm / macmini 같은 봇이 'Not logged in · Please run /login' 응답으로
 * 무한 stuck 되는 사고를 ralph 시작 전 단계에서 차단.
 *
 * 검증 방식: askClaudeLight("__ping__") — 빈 ping 메시지. 응답에 "Not logged in" 또는
 * "Please run /login" 또는 "auth" 류 에러 메시지 포함되면 인증 만료로 판단.
 * 정상 응답이면 (어떤 텍스트든) 인증 OK.
 *
 * 반환: { ok: true } | { ok: false; reason: string }
 */
async function verifyClaudeAuth(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const reply = await askClaudeLight("ping (one-word reply: pong)", { timeoutMs: 15_000 });
    const lower = reply.toLowerCase();
    // 인증 관련 에러 텍스트 패턴 — 실제 호성님 사고에서 발견된 메시지 + 일반 OAuth 에러
    const authFailPatterns = [
      "not logged in",
      "please run /login",
      "claude login",
      "no api key",
      "authentication required",
      "auth failed",
      "unauthorized",
    ];
    for (const p of authFailPatterns) {
      if (lower.includes(p)) {
        return { ok: false, reason: `Claude CLI 인증 실패: '${reply.slice(0, 100)}'. 봇 접속 후 'claude login' 실행 필요.` };
      }
    }
    return { ok: true };
  } catch (e: any) {
    const msg = (e?.message || String(e)).toLowerCase();
    // exit code 1 + 'not logged in' / 'please run /login' 류 stderr 도 검출
    if (/not logged in|please run|auth|unauthorized|api key/i.test(msg)) {
      return { ok: false, reason: `Claude CLI 인증 실패: ${e?.message?.slice(0, 100)}. 'claude login' 실행 필요.` };
    }
    // 다른 에러는 일시적일 수 있으니 인증 문제로 간주하지 않음 (false positive 방지)
    return { ok: true };
  }
}

/**
 * Phase R0.4 — plan 승인 gate + 자동 시작 정책.
 *
 * autoStart=true (legacy 호환, default) → 기존처럼 즉시 백그라운드 실행
 * autoStart=false                       → status='pending' 으로 저장 후 사용자 /ralph go <taskId> 대기
 */
export async function startRalphTask(params: {
  originalPrompt: string;
  requestedBy: string;
  repo?: string;
  askClaude: AskClaudeFn;
  sendTg: SendTelegramFn;
  autoStart?: boolean; // default true (기존 동작 유지)
  maxWallclockSec?: number;
}): Promise<{ taskId: string; planText: string; autoStart: boolean; authError?: string }> {
  const repo = params.repo || "";
  const autoStart = params.autoStart !== false;

  // Phase R4.1 (W1) — Claude CLI 인증 사전 검증
  const auth = await verifyClaudeAuth();
  if (!auth.ok) {
    return {
      taskId: "",
      planText: "",
      autoStart: false,
      authError: auth.reason,
    };
  }

  // 작업을 서브목표로 분해 (실패하면 단일 아이템으로 폴백)
  let items: Array<{ description: string; maxIterations: number }>;
  let planText: string;
  try {
    const subGoals = await planSubGoals(params.originalPrompt, repo);
    items = subGoals;
    planText = subGoals
      .map((g, i) => `${i + 1}. ${g.description} (최대 ${g.maxIterations}회)`)
      .join("\n");
  } catch (e: any) {
    console.warn(`[Ralph] planSubGoals failed (${e.message}), falling back to single item`);
    items = [{ description: params.originalPrompt, maxIterations: MAX_ITERATIONS }];
    planText = `1. ${params.originalPrompt} (최대 ${MAX_ITERATIONS}회)`;
  }

  const prd = createTask({
    originalPrompt: params.originalPrompt,
    requestedBy: params.requestedBy,
    repo,
    branch: "",
    files: [],
    items,
    maxWallclockSec: params.maxWallclockSec,
  });

  if (!autoStart) {
    // pending 상태 유지 — 사용자가 /ralph go <taskId> 호출해야 시작.
    appendProgress(prd.taskId, "AWAITING USER APPROVAL");
    return { taskId: prd.taskId, planText, autoStart: false };
  }

  startBackgroundLoop(prd.taskId, params.askClaude, params.sendTg);
  return { taskId: prd.taskId, planText, autoStart: true };
}

/**
 * Phase R4.5 — 종료 사유 분류 (사용자가 한 눈에 파악).
 * runRalphLoop result.error + prd.items 의 error 패턴 → 사람이 읽기 쉬운 분류.
 */
function classifyEndReason(prd: TaskPRD | null, resultError?: string): string {
  if (!prd) return "?";
  if (prd.status === "completed") return "✅ 모든 item 통과";
  if (resultError === "stopped") return "⏹ 사용자 중단";
  if (resultError === "wallclock exceeded") return "⏰ 시간 한도 (2h) 초과";
  if (resultError === "resumption burst") return "🌀 봇 재시작 루프";
  if (resultError === "budget exceeded") return "💰 예산 초과";

  // item 별 error 패턴 분석
  const errors = prd.items.map((i) => i.error || "").filter(Boolean);
  if (!errors.length) return "❌ 알 수 없음";

  if (errors.some((e) => /truncat|max_tokens/i.test(e))) return "✂️ 응답 잘림 (truncation)";
  if (errors.some((e) => /invariant stuck/i.test(e))) return "🧱 진척 없음 (state-hash invariant)";
  if (errors.some((e) => /stuck:/i.test(e))) return "🔁 동일 사유 반복 stuck";
  if (errors.some((e) => /max iterations/i.test(e))) return "🔢 최대 반복 초과";
  if (errors.some((e) => /auth|login|api[_ ]?key/i.test(e))) return "🔐 Claude CLI 인증 실패";
  return `❌ ${errors[0]?.slice(0, 60) || "기타"}`;
}

/**
 * 승인된 task 의 백그라운드 루프 실행 — startRalphTask 와 /ralph go 모두 사용.
 */
export function startBackgroundLoop(
  taskId: string,
  askClaude: AskClaudeFn,
  sendTg: SendTelegramFn,
): void {
  const prd = loadPRD(taskId);
  if (!prd) return;
  const requestedBy = prd.requestedBy;
  const createdAt = prd.createdAt;

  (async () => {
    try {
      const result = await runRalphLoop(taskId, askClaude, sendTg);
      const finalPrd = loadPRD(taskId);
      const elapsed = Math.round(((finalPrd?.completedAt || Date.now()) - createdAt) / 1000);
      const passedCount = finalPrd?.items.filter((i) => i.passes).length ?? 0;
      const totalCount = finalPrd?.items.length ?? 0;
      // Phase R4.5 — 종료 사유 분류 표시
      const reason = classifyEndReason(finalPrd, result.error);

      if (result.completed) {
        await sendTg(
          requestedBy,
          `🎉 Ralph #${taskId} 전체 완료!\n` +
          `⏱ ${elapsed}s | ${result.totalIterations} iter | items ${passedCount}/${totalCount}\n` +
          `결과: ${reason}`,
        );
      } else if (result.error === "stopped") {
        // 사용자 요청 중단은 별도 알림 이미 발송됨
      } else {
        await sendTg(
          requestedBy,
          `❌ Ralph #${taskId} 미완료\n` +
          `⏱ ${elapsed}s | ${result.totalIterations} iter | items ${passedCount}/${totalCount}\n` +
          `사유: ${reason}\n` +
          `/ralph status ${taskId}`,
        );
      }
    } catch (e: any) {
      await sendTg(requestedBy, `❌ Ralph #${taskId} 예외: ${e.message}`).catch(() => {});
    }
  })();
}

// ═══════════════════════════════════════════════════════════════
// User control commands (Phase R0.4 W3) — stop / pause / resume
// ═══════════════════════════════════════════════════════════════

/** /ralph stop — task 를 즉시 중단 신호 (다음 iteration 진입 시 감지). */
export function stopTask(taskId: string): { ok: boolean; message: string } {
  const prd = loadPRD(taskId);
  if (!prd) return { ok: false, message: `태스크 ${taskId} 없음` };
  if (prd.status === "completed" || prd.status === "failed" || prd.status === "stopped") {
    return { ok: false, message: `이미 종료됨 (status=${prd.status})` };
  }
  prd.status = "stopped";
  savePRD(prd);
  appendProgress(taskId, `STOP REQUESTED BY USER`);
  return { ok: true, message: `Ralph #${taskId} 중단 신호 보냄 (다음 iteration 끝에 종료)` };
}

/** /ralph go — pending task 시작. */
export function approveAndStart(
  taskId: string,
  askClaude: AskClaudeFn,
  sendTg: SendTelegramFn,
): { ok: boolean; message: string } {
  const prd = loadPRD(taskId);
  if (!prd) return { ok: false, message: `태스크 ${taskId} 없음` };
  if (prd.status !== "pending") {
    return { ok: false, message: `시작 불가 (현재 status=${prd.status})` };
  }
  appendProgress(taskId, `APPROVED BY USER → starting`);
  startBackgroundLoop(taskId, askClaude, sendTg);
  return { ok: true, message: `Ralph #${taskId} 시작됨` };
}

/** /ralph cancel — pending task 자체를 cancel (실행 시작 안 한 plan 폐기). */
export function cancelPendingTask(taskId: string): { ok: boolean; message: string } {
  const prd = loadPRD(taskId);
  if (!prd) return { ok: false, message: `태스크 ${taskId} 없음` };
  if (prd.status !== "pending") {
    return { ok: false, message: `pending 상태가 아님 (status=${prd.status}) — /ralph stop 사용` };
  }
  prd.status = "stopped";
  prd.completedAt = Date.now();
  savePRD(prd);
  appendProgress(taskId, `CANCELLED BY USER (plan 단계)`);
  return { ok: true, message: `Ralph #${taskId} plan 취소됨` };
}

// ═══════════════════════════════════════════════════════════════
// Resume — 봇 재시작 시 미완료 태스크 탐색
// ═══════════════════════════════════════════════════════════════

export function getInProgressTasks(): TaskPRD[] {
  if (!existsSync(TASKS_DIR)) return [];
  const results: TaskPRD[] = [];
  try {
    for (const dir of readdirSync(TASKS_DIR)) {
      const prd = loadPRD(dir);
      if (prd && prd.status === "running") results.push(prd);
    }
  } catch {}
  return results;
}

export async function resumeInProgressTasks(
  askClaude: AskClaudeFn,
  sendTg: SendTelegramFn,
): Promise<void> {
  const tasks = getInProgressTasks();
  // pending (승인 대기) task 도 알림 — autoStart 하지 않음
  const pendingTasks = listTasks(50).filter(t => t.status === "pending");

  if (!tasks.length && !pendingTasks.length) return;

  if (pendingTasks.length) {
    for (const prd of pendingTasks) {
      try {
        await sendTg(prd.requestedBy,
          `⏸ Ralph #${prd.taskId} 승인 대기 중\n` +
          `${prd.originalPrompt.slice(0, 100)}\n` +
          `시작: /ralph go ${prd.taskId} | 취소: /ralph cancel ${prd.taskId}`
        );
      } catch {}
    }
  }

  if (!tasks.length) return;
  console.log(`[RalphLoop] Resuming ${tasks.length} in-progress task(s)`);

  for (const prd of tasks) {
    try {
      await sendTg(prd.requestedBy,
        `🔄 Ralph Loop 재개: #${prd.taskId} — ${prd.originalPrompt.slice(0, 80)}`
      );
      appendProgress(prd.taskId, `RESUMED after bot restart`);

      const result = await runRalphLoop(prd.taskId, askClaude, sendTg);

      if (result.completed) {
        await sendTg(prd.requestedBy,
          `✅ Ralph #${prd.taskId} 재개 완료 (${result.totalIterations} iterations)`
        );
      } else if (result.error === "stopped") {
        // 사용자 stop 알림은 이미 발송됨
      } else {
        await sendTg(prd.requestedBy,
          `❌ Ralph #${prd.taskId} 재개 실패: ${result.error || "미완료 아이템 존재"}`
        );
      }
    } catch (e: any) {
      console.error(`[RalphLoop] Resume failed for ${prd.taskId}: ${e.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Status & Listing
// ═══════════════════════════════════════════════════════════════

export function formatRalphStatus(taskId: string): string {
  const prd = loadPRD(taskId);
  if (!prd) return `❌ 태스크 ${taskId} 없음`;

  const elapsed = Math.round(((prd.completedAt || Date.now()) - prd.createdAt) / 1000);
  const elapsedStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s` : `${elapsed}s`;
  const lines = [
    `📋 Ralph #${prd.taskId} — ${prd.status}`,
    `⏱ ${elapsedStr} | ${prd.repo || "no-repo"} | ${prd.branch || "no-branch"}`,
    `📝 ${prd.originalPrompt.slice(0, 100)}`,
  ];

  // 시간 한도 진행률 (정액제 환경에서 budget 대신)
  if (prd.maxWallclockSec && prd.status !== "completed") {
    const pct = Math.round((elapsed / prd.maxWallclockSec) * 100);
    const limitMin = Math.round(prd.maxWallclockSec / 60);
    lines.push(`⏰ ${elapsedStr} / ${limitMin}min (${pct}%)`);
  }

  // lock 정보
  try {
    const path = lockPath(taskId);
    if (existsSync(path)) {
      const lock: LockFile = JSON.parse(readFileSync(path, "utf-8"));
      const alive = isProcessAlive(lock.pid);
      lines.push(`🔒 lock: pid=${lock.pid} bot=${lock.bot}${alive ? "" : " (stale)"}`);
    }
  } catch {}

  lines.push("");

  for (const item of prd.items) {
    const icon = item.passes ? "✅" : item.iteration > 0 ? "🔄" : "⏸";
    lines.push(`${icon} ${item.id}: ${item.description.slice(0, 80)}`);
    const stuckSuffix = (item.stuckCount && item.stuckCount > 0) ? ` ⚠️stuck×${item.stuckCount}` : "";
    lines.push(`   iter ${item.iteration}/${item.maxIterations}${item.passes ? " ✓" : ""}${stuckSuffix}${item.error ? ` ❗${item.error}` : ""}`);
  }

  return lines.join("\n");
}

export function listTasks(limit = 10): TaskPRD[] {
  if (!existsSync(TASKS_DIR)) return [];
  const results: TaskPRD[] = [];
  try {
    for (const dir of readdirSync(TASKS_DIR)) {
      const prd = loadPRD(dir);
      if (prd) results.push(prd);
    }
  } catch {}
  return results.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}
