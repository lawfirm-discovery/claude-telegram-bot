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
import { spawn } from "child_process";
import { clearSession, CLI_SUPPORTS_EFFORT } from "./claude-engine";

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
}

export interface TaskPRD {
  taskId: string;
  originalPrompt: string;
  requestedBy: string;
  repo: string;
  branch: string;
  files: string[];
  status: "pending" | "running" | "completed" | "failed";
  createdAt: number;
  completedAt?: number;
  items: TaskItem[];
  lastCompressLine: number;
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
const MAX_ITERATIONS = parseInt(process.env.RALPH_MAX_ITERATIONS || "10");
const COMPRESS_THRESHOLD = 60;
const EVALUATOR_MODEL = process.env.RALPH_EVALUATOR_MODEL || "claude-sonnet-4-6";
const SKIP_EVALUATOR = process.env.RALPH_SKIP_EVALUATOR === "true";

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

function appendProgress(taskId: string, message: string): void {
  ensureTaskDir(taskId);
  const ts = new Date().toISOString();
  appendFileSync(join(taskDir(taskId), "progress.log"), `[${ts}] ${message}\n`);
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
// Task Creation
// ═══════════════════════════════════════════════════════════════

export function createTask(params: {
  taskId?: string;
  originalPrompt: string;
  requestedBy: string;
  repo: string;
  branch: string;
  files: string[];
  items: Array<{ description: string }>;
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
      maxIterations: MAX_ITERATIONS,
    })),
    lastCompressLine: 0,
  };
  savePRD(prd);
  appendProgress(taskId, `TASK CREATED: ${params.originalPrompt.slice(0, 200)}`);
  return prd;
}

// ═══════════════════════════════════════════════════════════════
// Light Claude Call (evaluator + compression)
// ═══════════════════════════════════════════════════════════════

function askClaudeLight(prompt: string, timeoutMs = 45_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--model", EVALUATOR_MODEL,
      ...(CLI_SUPPORTS_EFFORT ? ["--effort", "low"] : []),
      "--no-tool-use",
      "--output-format", "text",
      "--permission-mode", "bypassPermissions",
    ];
    const proc = spawn(process.env.CLAUDE_PATH || "claude", args, {
      env: { ...process.env, NO_COLOR: "1", TELEGRAM_BOT_TOKEN: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.stdin?.write(prompt);
    proc.stdin?.end();
    let stdout = "", stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      reject(new Error("evaluator timeout"));
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      code === 0 && stdout.trim() ? resolve(stdout.trim()) : reject(new Error(stderr.slice(0, 200) || "evaluator failed"));
    });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

// ═══════════════════════════════════════════════════════════════
// Test Ratchet
// ═══════════════════════════════════════════════════════════════

async function runTestRatchet(repo: string): Promise<{ passed: boolean; output: string }> {
  const rp = REPO_PATHS[repo];
  if (!rp) return { passed: true, output: "no repo" };

  let cmd: string[];
  if (repo === "lemon_flutter") cmd = ["/home/angrylawyer/flutter/bin/flutter", "analyze", "--no-pub"];
  else if (repo === "lemon-front") cmd = ["npx", "tsc", "--noEmit"];
  else if (repo.includes("spring")) cmd = ["./gradlew", "compileJava"];
  else return { passed: true, output: "no test configured" };

  return new Promise((resolve) => {
    const p = spawn(cmd[0]!, cmd.slice(1), {
      cwd: rp,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LEMON_FORK_JAVAC: "true" },
    });
    let output = "";
    p.stdout?.on("data", (d) => { output += d.toString(); });
    p.stderr?.on("data", (d) => { output += d.toString(); });
    const timer = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch {}
      resolve({ passed: false, output: "test timeout (120s)" });
    }, 120_000);
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ passed: code === 0, output: output.slice(-500) });
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({ passed: false, output: e.message });
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// Evaluator — 별도 Claude 세션으로 완료 여부 독립 판정
// ═══════════════════════════════════════════════════════════════

interface EvalResult {
  complete: boolean;
  reason: string;
  remainingWork?: string;
}

async function runEvaluator(taskId: string, item: TaskItem, testResult: string): Promise<EvalResult> {
  if (SKIP_EVALUATOR) return { complete: true, reason: "evaluator skipped" };

  const context = readContext(taskId);
  const recentLog = readProgressLines(taskId).slice(-10).join("\n");

  const prompt = `당신은 작업 완료 여부를 판정하는 독립 평가자입니다. 이전 작업 에이전트와 별도의 세션입니다.

## 원본 작업
${item.description}

## 현재 진행 요약
${context || "(아직 없음)"}

## 최근 로그 (마지막 10줄)
${recentLog}

## 빌드/테스트 결과
${testResult}

위 정보를 바탕으로, 이 작업이 **완전히 완료**되었는지 평가하세요.
- 코드 수정이 있었고 테스트가 통과했으면 높은 확률로 완료
- 로그에 에러, 미구현, TODO가 남아있으면 미완료
- 빌드 실패면 무조건 미완료

JSON만 응답 (다른 텍스트 없이):
{"complete": true, "reason": "판정 이유"}
또는
{"complete": false, "reason": "미완료 이유", "remainingWork": "남은 작업"}`;

  try {
    const raw = await askClaudeLight(prompt);
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]) as EvalResult;
    return { complete: false, reason: "JSON parse failed", remainingWork: raw.slice(0, 200) };
  } catch (e: any) {
    appendProgress(taskId, `EVALUATOR ERROR: ${e.message}`);
    return { complete: false, reason: `evaluator error: ${e.message}` };
  }
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

  prd.status = "running";
  savePRD(prd);
  appendProgress(taskId, `RALPH LOOP START`);

  const syntheticChatId = `ralph-${taskId}`;
  let totalIterations = 0;

  for (const item of prd.items) {
    if (item.passes) continue;

    item.startedAt = item.startedAt || Date.now();
    appendProgress(taskId, `ITEM START: ${item.id} — ${item.description.slice(0, 100)}`);

    while (!item.passes && item.iteration < item.maxIterations) {
      item.iteration++;
      totalIterations++;
      const iterStart = Date.now();

      appendProgress(taskId, `ITERATION ${item.iteration}/${item.maxIterations} START: ${item.id}`);

      // 매 반복마다 세션 초기화 → 깨끗한 컨텍스트
      clearSession(syntheticChatId);

      // 1. 프롬프트 조합
      const context = readContext(taskId);
      const recentLog = readProgressLines(taskId).slice(-10).join("\n");
      const prompt = buildIterationPrompt(prd, item, context, recentLog);

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

        // 4. Test Ratchet
        const testResult = await runTestRatchet(prd.repo);
        const testSummary = `${testResult.passed ? "PASS" : "FAIL"}: ${testResult.output.slice(0, 200)}`;
        appendProgress(taskId, `TEST RATCHET: ${testSummary}`);

        // 5. Evaluator (별도 세션)
        const evalResult = await runEvaluator(taskId, item, testSummary);
        appendProgress(taskId, `EVALUATOR: complete=${evalResult.complete}, reason=${evalResult.reason}`);

        if (evalResult.complete && testResult.passed) {
          item.passes = true;
          item.completedAt = Date.now();
          appendProgress(taskId, `ITEM DONE: ${item.id}`);
          await sendTg(prd.requestedBy,
            `✅ Ralph #${taskId} — ${item.id} 완료 (iter ${item.iteration}): ${item.description.slice(0, 80)}`
          );
        } else if (!testResult.passed) {
          appendProgress(taskId, `TEST FAILED → next iteration will fix`);
          await sendTg(prd.requestedBy,
            `🔄 Ralph #${taskId} — ${item.id} iter ${item.iteration}: 테스트 실패, 다음 반복에서 수정`
          );
        } else {
          appendProgress(taskId, `NOT COMPLETE: ${evalResult.remainingWork || evalResult.reason}`);
        }
      } catch (e: any) {
        appendProgress(taskId, `ITERATION ${item.iteration} ERROR: ${e.message}`);
        item.error = e.message;

        if (/auth|billing|api_key/i.test(e.message)) {
          prd.status = "failed";
          savePRD(prd);
          return { taskId, completed: false, totalIterations, error: e.message };
        }
      }

      savePRD(prd);
    }

    if (!item.passes) {
      appendProgress(taskId, `ITEM FAILED: ${item.id} — max iterations exceeded`);
      item.error = item.error || `max iterations (${item.maxIterations}) exceeded`;
      savePRD(prd);
    }
  }

  const allDone = prd.items.every(i => i.passes);
  prd.status = allDone ? "completed" : "failed";
  prd.completedAt = Date.now();
  savePRD(prd);

  const elapsed = Math.round((prd.completedAt - prd.createdAt) / 1000);
  appendProgress(taskId, `RALPH LOOP END: ${prd.status} (${elapsed}s, ${totalIterations} iterations)`);

  return { taskId, completed: allDone, totalIterations };
}

// ═══════════════════════════════════════════════════════════════
// Prompt Builder
// ═══════════════════════════════════════════════════════════════

function buildIterationPrompt(prd: TaskPRD, item: TaskItem, context: string, recentLog: string): string {
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
    `⏱ ${elapsedStr} | ${prd.repo} | ${prd.branch}`,
    `📝 ${prd.originalPrompt.slice(0, 100)}`,
    "",
  ];

  for (const item of prd.items) {
    const icon = item.passes ? "✅" : item.iteration > 0 ? "🔄" : "⏸";
    lines.push(`${icon} ${item.id}: ${item.description.slice(0, 80)}`);
    lines.push(`   iter ${item.iteration}/${item.maxIterations}${item.passes ? " ✓" : ""}${item.error ? ` ❗${item.error}` : ""}`);
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
