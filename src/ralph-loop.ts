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
import { incr, formatOneLineSummary, getTotals } from "./metrics";
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
   * 비용 한도 (Phase R0.3 W5). 단위: USD. 초과 시 task 자동 stop.
   * undefined → 한도 없음 (legacy task 호환).
   */
  maxBudgetUsd?: number;
  /** task 시작 시점의 봇 전체 누적 cost milli — 진행 중 누적치 계산용 baseline. */
  costStartMilli?: number;
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
/** 환경변수 default — 개별 task 가 maxBudgetUsd 명시 안 하면 이 값 적용. */
const DEFAULT_MAX_BUDGET_USD = parseFloat(process.env.RALPH_MAX_BUDGET_USD || "0") || undefined;

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

function writeContext(taskId: string, content: string): void {
  ensureTaskDir(taskId);
  writeFileSync(join(taskDir(taskId), "context.md"), content);
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
  /** USD 한도 — undefined 면 default (env RALPH_MAX_BUDGET_USD) 또는 무한. */
  maxBudgetUsd?: number;
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
    maxBudgetUsd: params.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
  };
  savePRD(prd);
  appendProgress(taskId, `TASK CREATED: ${params.originalPrompt.slice(0, 200)}`);
  if (prd.maxBudgetUsd) {
    appendProgress(taskId, `BUDGET: $${prd.maxBudgetUsd.toFixed(2)} USD`);
  }
  return prd;
}

// ═══════════════════════════════════════════════════════════════
// Cost helpers (Phase R0.3 W5)
// ═══════════════════════════════════════════════════════════════

/** 봇 전체 누적 cost (milli USD). */
function getCurrentCostMilli(): number {
  return getTotals()["engine.cost_usd_milli"]?.count ?? 0;
}

/** task 시작 후 누적된 cost (USD). */
function getTaskCostUsd(prd: TaskPRD): number {
  if (prd.costStartMilli === undefined) return 0;
  return Math.max(0, getCurrentCostMilli() - prd.costStartMilli) / 1000;
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
- JSON 배열만 반환 (다른 텍스트 없이):

[{"description": "구체적 서브목표", "maxIterations": 20}]`;

  const raw = await askClaudeLight(prompt, { timeoutMs: 30_000 });
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("planSubGoals: JSON 배열 파싱 실패");

  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed) || !parsed.length) throw new Error("planSubGoals: 빈 결과");

  return parsed.map((g: any) => ({
    description: String(g.description || "").slice(0, 500),
    maxIterations: Math.min(40, Math.max(5, parseInt(g.maxIterations) || MAX_ITERATIONS)),
  }));
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
  // Phase R0.3 — cost baseline 기록 (resume 시 기존 값 유지)
  if (prd.costStartMilli === undefined) {
    prd.costStartMilli = getCurrentCostMilli();
  }
  savePRD(prd);
  appendProgress(taskId, `RALPH LOOP START (pid=${process.pid} bot=${process.env.BOT_NAME ?? "?"})`);

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
      // Phase R0.3 — 매 iteration 진입 시 budget + 사용자 stop 신호 체크.
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

      // budget guard
      if (prd.maxBudgetUsd) {
        const spent = getTaskCostUsd(prd);
        if (spent >= prd.maxBudgetUsd) {
          const msg = `💰 Ralph #${taskId} 예산 초과: $${spent.toFixed(3)} ≥ $${prd.maxBudgetUsd.toFixed(2)} (item ${item.id}, iter ${item.iteration})`;
          appendProgress(taskId, `BUDGET EXCEEDED: ${msg}`);
          await sendTg(prd.requestedBy, msg + `\n수동 확인 후 /ralph status ${taskId}`);
          item.error = `budget exceeded: $${spent.toFixed(3)}`;
          incr("ralph.budget_exceeded");
          prd.status = "failed";
          savePRD(prd);
          releaseTaskLock(taskId);
          return { taskId, completed: false, totalIterations, error: "budget exceeded" };
        }
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

        const elapsed = Math.round((Date.now() - iterStart) / 1000);
        appendProgress(taskId, `ITERATION ${item.iteration} END: ${elapsed}s`);
        appendProgress(taskId, `RESPONSE: ${response.replace(/\n/g, " ").slice(0, 300)}`);

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

        // 6. Stuck 감지 — 동일 미완료 사유 3회 연속이면 사용자 에스컬레이트
        //    카운터는 item.stuckCount/lastEvalReason 에 저장 → 봇 재시작 시 일관성 유지
        if (!evalResult.complete) {
          if (evalResult.reason === item.lastEvalReason) {
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

        if (evalResult.complete && testResult.passed) {
          item.passes = true;
          item.completedAt = Date.now();
          appendProgress(taskId, `ITEM DONE: ${item.id}`);
          incr("ralph.item.passed");
          await sendTg(prd.requestedBy,
            `✅ Ralph #${taskId} — ${item.id} 완료 (iter ${item.iteration}): ${item.description.slice(0, 80)}`
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

  return parts.join("\n\n");
}

// ═══════════════════════════════════════════════════════════════
// startRalphTask — 사용자 직접 호출용 (bot.ts /ralph 커맨드)
// ═══════════════════════════════════════════════════════════════

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
  maxBudgetUsd?: number;
}): Promise<{ taskId: string; planText: string; autoStart: boolean }> {
  const repo = params.repo || "";
  const autoStart = params.autoStart !== false;

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
    maxBudgetUsd: params.maxBudgetUsd,
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
      const elapsed = Math.round(((loadPRD(taskId)?.completedAt || Date.now()) - createdAt) / 1000);
      if (result.completed) {
        await sendTg(
          requestedBy,
          `🎉 Ralph #${taskId} 전체 완료!\n⏱ ${elapsed}s | ${result.totalIterations} iterations`,
        );
      } else if (result.error === "stopped") {
        // 사용자 요청 중단은 별도 알림 이미 발송됨
      } else {
        await sendTg(
          requestedBy,
          `❌ Ralph #${taskId} 미완료\n⏱ ${elapsed}s | ${result.totalIterations} iterations\n사유: ${result.error || "일부 아이템 실패"}\n/ralph status ${taskId}`,
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

  // 비용 정보
  const cost = getTaskCostUsd(prd);
  if (prd.maxBudgetUsd) {
    const pct = Math.round((cost / prd.maxBudgetUsd) * 100);
    lines.push(`💰 $${cost.toFixed(3)} / $${prd.maxBudgetUsd.toFixed(2)} (${pct}%)`);
  } else if (cost > 0) {
    lines.push(`💰 $${cost.toFixed(3)}`);
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
