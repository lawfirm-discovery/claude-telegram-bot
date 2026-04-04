/**
 * Orchestrator — 리드-워커 멀티봇 작업 위임 시스템
 *
 * 리드 봇이 작업을 서브태스크로 분해하고 워커 봇에 Telegram으로 위임.
 * 워커 봇은 feature branch에서 작업 후 push, 리드가 머지.
 */

import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

// ════════════════════════��══════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type BotRole = "lead" | "worker";

export interface WorkerBot {
  chatId: string;       // Telegram chat ID of the worker bot
  name: string;         // e.g. "a4500", "3060", "macmini"
  username: string;     // Telegram bot username
  repos: string[];      // repos available on this server, e.g. ["lemon-front", "lemon_flutter"]
  status: "idle" | "busy";
}

export interface SubTask {
  id: string;
  description: string;
  repo: string;            // target repo
  files?: string[];        // hint: files to modify
  assignedTo?: string;     // worker bot name
  branch?: string;         // feature branch name
  status: "pending" | "dispatched" | "in_progress" | "completed" | "failed";
  result?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

export interface OrchestratedTask {
  id: string;
  originalPrompt: string;
  subtasks: SubTask[];
  status: "planning" | "dispatching" | "in_progress" | "merging" | "verifying" | "completed" | "failed";
  createdAt: number;
  completedAt?: number;
  requestedBy: string;     // chat ID of the requester
}

// ════════════════════════════════════════���══════════════════════
// Config
// ═══════════════════════════════════════════════════════════════

export const BOT_ROLE: BotRole = (process.env.BOT_ROLE || "worker") as BotRole;
export const DEV_BRANCH = process.env.DEV_BRANCH || "dev-hs-rtx6000-new";
const LEAD_BOT_CHAT_ID = process.env.LEAD_BOT_CHAT_ID || "";

// Parse WORKER_BOTS from env: "chatId:name:username:repo1+repo2,chatId2:name2:..."
function parseWorkerBots(): WorkerBot[] {
  const raw = process.env.WORKER_BOTS || "";
  if (!raw) return [];
  return raw.split(",").map((entry) => {
    const [chatId, name, username, reposStr] = entry.split(":");
    return {
      chatId: chatId?.trim() || "",
      name: name?.trim() || "",
      username: username?.trim() || "",
      repos: (reposStr || "").split("+").filter(Boolean),
      status: "idle" as const,
    };
  }).filter(w => w.chatId && w.name);
}

const workerBots: WorkerBot[] = parseWorkerBots();

// ══════════════════════════════════��════════════════════════��═══
// Task Registry
// ════════════════════════════════════════��══════════════════════

const activeTasks = new Map<string, OrchestratedTask>();
const subtaskIndex = new Map<string, { taskId: string; subtaskId: string }>();

export function getTask(taskId: string): OrchestratedTask | undefined {
  return activeTasks.get(taskId);
}

export function getWorkerBots(): WorkerBot[] {
  return workerBots;
}

// ═══════════════════════════════════════════════════════════════
// Domain Affinity — 봇별 전문 도메인 학습
// ═══════════════════════════════════════════════════════════════

interface AffinityEntry {
  botName: string;
  domain: string;       // e.g. "ldrive", "chat", "erp/guardian", "ai_chat"
  taskCount: number;     // 이 도메인에서 완료한 작업 수
  lastWorked: number;    // 마지막 작업 시간
  successRate: number;   // 성공률 (0~1)
}

const AFFINITY_FILE = join(import.meta.dir, "..", ".lemonclaw", "affinity.json");

// 메모리 + 파일 기반 어피니티 저장
let affinityMap: AffinityEntry[] = [];

function loadAffinity(): void {
  try {
    if (existsSync(AFFINITY_FILE)) {
      affinityMap = JSON.parse(readFileSync(AFFINITY_FILE, "utf-8"));
    }
  } catch { affinityMap = []; }
}

function saveAffinity(): void {
  try {
    writeFileSync(AFFINITY_FILE, JSON.stringify(affinityMap, null, 2));
  } catch (e: any) {
    console.error(`[Affinity] Save failed: ${e.message}`);
  }
}

loadAffinity();

/** 파일 경로에서 도메인 추출 */
function extractDomain(filePath: string): string {
  // lib/pages/erp/guardian/xxx.dart → erp/guardian
  // src/components/Chat/xxx.ts → Chat
  // lib/pages/ldrive/xxx.dart → ldrive
  const parts = filePath.replace(/^(lib|src)\/(pages|components|features|widgets)\//, "").split("/");
  // 첫 1~2 depth를 도메인으로
  return parts.slice(0, Math.min(2, parts.length - 1)).join("/") || "general";
}

/** 작업 완료 후 어피니티 업데이트 */
export function updateAffinity(botName: string, files: string[], success: boolean): void {
  const domains = new Set(files.map(extractDomain));

  for (const domain of domains) {
    let entry = affinityMap.find(a => a.botName === botName && a.domain === domain);
    if (!entry) {
      entry = { botName, domain, taskCount: 0, lastWorked: 0, successRate: 1 };
      affinityMap.push(entry);
    }
    entry.taskCount++;
    entry.lastWorked = Date.now();
    // Rolling average success rate
    entry.successRate = (entry.successRate * (entry.taskCount - 1) + (success ? 1 : 0)) / entry.taskCount;
  }

  saveAffinity();
}

/** 주어진 파일들에 가장 적합한 워커 봇 선택 */
export function selectBestWorker(files: string[], repo: string): string | null {
  const domains = new Set(files.map(extractDomain));
  const eligible = workerBots.filter(w => w.repos.includes(repo));

  if (!eligible.length) return null;

  // 점수 계산: 어피니티(경험) + 상태(idle 우선)
  const scored = eligible.map(w => {
    let score = 0;

    // 어피니티 점수: 이 도메인에서 작업한 경험
    for (const domain of domains) {
      const entry = affinityMap.find(a => a.botName === w.name && a.domain === domain);
      if (entry) {
        score += entry.taskCount * 10;            // 경험치
        score += entry.successRate * 20;           // 성공률 보너스
        // 최근 작업 보너스 (24시간 내)
        const hoursSince = (Date.now() - entry.lastWorked) / 3600000;
        if (hoursSince < 24) score += 15;          // 캐시가 아직 유효할 가능성
      }
    }

    // idle 보너스
    if (w.status === "idle") score += 30;

    return { worker: w, score };
  });

  // 최고 점수 워커 선택
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.worker.name || null;
}

/** 어피니티 현황 포맷 */
export function formatAffinityReport(): string {
  if (!affinityMap.length) return "아직 어피니티 데이터가 없습니다.";

  // 봇별 그룹
  const byBot = new Map<string, AffinityEntry[]>();
  for (const entry of affinityMap) {
    const list = byBot.get(entry.botName) || [];
    list.push(entry);
    byBot.set(entry.botName, list);
  }

  const lines: string[] = ["📊 도메인 어피니티 현황\n"];
  for (const [bot, entries] of byBot) {
    const sorted = entries.sort((a, b) => b.taskCount - a.taskCount).slice(0, 5);
    lines.push(`🤖 ${bot}:`);
    for (const e of sorted) {
      lines.push(`  ${e.domain}: ${e.taskCount}건 (성공률 ${Math.round(e.successRate * 100)}%)`);
    }
  }

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════
// Step 1: Plan — 작업을 서브태스크로 분해
// ═══════════════════════════════════════════════════════════════

type AskClaudeFn = (chatId: string, message: string) => Promise<string>;
type SendTelegramFn = (chatId: string, message: string) => Promise<void>;

/**
 * 경량 Claude 호출 — CLI가 아닌 `claude -p` (print mode) + sonnet + low effort
 * 리드 봇의 계획 단계에서만 사용. 도구 없이 텍스트만 받아옴.
 */
async function askClaudeLight(prompt: string): Promise<string> {
  const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_PATH, [
      "-p", prompt,
      "--model", "claude-sonnet-4-6",
      "--effort", "low",
      "--no-tool-use",
      "--output-format", "text",
      "--permission-mode", "bypassPermissions",
    ], {
      env: { ...process.env, NO_COLOR: "1", TELEGRAM_BOT_TOKEN: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      reject(new Error("계획 타임아웃 (30초)"));
    }, 30_000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else reject(new Error(stderr.slice(0, 200) || "계획 실패"));
    });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

export async function planTask(
  prompt: string,
  requestedBy: string,
  _askClaude?: AskClaudeFn,  // 사용 안 함 — 경량 호출 사용
): Promise<OrchestratedTask> {
  const taskId = randomUUID().slice(0, 8);

  // 어피니티 정보를 프롬프트에 포함
  const affinityHint = affinityMap.length > 0
    ? `\n\n도메인 어피니티 (이전 작업 이력, 가능하면 같은 봇에 배정):\n${
        affinityMap.slice(-20).map(a => `- ${a.botName}: ${a.domain} (${a.taskCount}건)`).join("\n")
      }`
    : "";

  const planPrompt = `당신은 멀티에이전트 개발 오케스트레이터입니다.

다음 작업을 서브태스크로 분해해주세요. 각 서브태스크는 하나의 봇이 독립적으로 실행할 수 있어야 합니다.

사용 가능한 워커 봇과 접근 가능한 레포:
${workerBots.map(w => `- ${w.name} (${w.username}): ${w.repos.join(", ")}`).join("\n")}${affinityHint}

작업: ${prompt}

다음 JSON 형식으로만 응답하세요 (마크다운 코드블록 없이 순수 JSON):
[
  {
    "description": "서브태스크 설명 (구체적 파일/함수 포함)",
    "repo": "대상 레포명 (e.g. lemon-front)",
    "files": ["수정 예상 파일 경로"],
    "assignTo": "워커 봇 이름"
  }
]

규칙:
- 같은 파일을 두 서브태스크에 배정하지 말 것 (충돌 방지)
- 각 서브태스크는 독립적으로 실행 가능해야 함
- 워커의 repos에 없는 레포를 배정하지 말 것
- 이전에 해당 도메인을 작업한 봇이 있으면 같은 봇에 배정 (어피니티)
- API 변경이 필요하면 API 서브태스크를 먼저 배치`;

  const response = await askClaudeLight(planPrompt);

  // Parse JSON from response
  let subtaskDefs: any[] = [];
  try {
    // Try to extract JSON array from response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      subtaskDefs = JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    throw new Error(`서브태스크 분해 실패: JSON 파싱 에러\n${response.slice(0, 200)}`);
  }

  if (!subtaskDefs.length) {
    throw new Error(`서브태스크 분해 실패: 빈 결과\n${response.slice(0, 200)}`);
  }

  const subtasks: SubTask[] = subtaskDefs.map((def: any) => {
    const id = randomUUID().slice(0, 6);
    const files = def.files || [];
    const repo = def.repo || "";

    // 어피니티 기반 워커 선택 (Claude 제안보다 우선)
    const affinityPick = selectBestWorker(files, repo);
    const assignee = affinityPick || def.assignTo || undefined;

    const sub: SubTask = {
      id,
      description: def.description || "",
      repo,
      files,
      assignedTo: assignee,
      branch: `agent/${assignee || "unassigned"}/${taskId}-${id}`,
      status: "pending",
      createdAt: Date.now(),
    };
    return sub;
  });

  const task: OrchestratedTask = {
    id: taskId,
    originalPrompt: prompt,
    subtasks,
    status: "planning",
    createdAt: Date.now(),
    requestedBy,
  };

  activeTasks.set(taskId, task);
  for (const sub of subtasks) {
    subtaskIndex.set(sub.id, { taskId: task.id, subtaskId: sub.id });
  }

  return task;
}

// ════════════════════════════════════════════════���══════════════
// Step 2: Dispatch — 워커 봇에 서브태스크 전송
// ═══════════════════════════════════════════════════════════════

export async function dispatchTask(
  task: OrchestratedTask,
  sendTelegram: SendTelegramFn,
): Promise<void> {
  task.status = "dispatching";

  for (const sub of task.subtasks) {
    const worker = workerBots.find(w => w.name === sub.assignedTo);
    if (!worker) {
      sub.status = "failed";
      sub.error = `워커 ${sub.assignedTo} 를 찾을 수 없습니다`;
      continue;
    }

    // 워커 봇에 Telegram 메시지 전송
    const message = formatTaskMessage(task.id, sub);

    try {
      await sendTelegram(worker.chatId, message);
      sub.status = "dispatched";
      worker.status = "busy";
      console.log(`[Orchestrator] Dispatched subtask ${sub.id} to ${worker.name}`);
    } catch (e: any) {
      sub.status = "failed";
      sub.error = `전송 실패: ${e.message}`;
      console.error(`[Orchestrator] Failed to dispatch to ${worker.name}: ${e.message}`);
    }
  }

  task.status = "in_progress";
}

function formatTaskMessage(taskId: string, sub: SubTask): string {
  const worker = workerBots.find(w => w.name === sub.assignedTo);
  const mention = worker?.username ? `@${worker.username} ` : "";
  return `${mention}[TASK:${taskId}:${sub.id}]
작업: ${sub.description}
레포: ${sub.repo}
브랜치: ${sub.branch}
${sub.files?.length ? `파일: ${sub.files.join(", ")}` : ""}

규칙:
1. \`git checkout -b ${sub.branch}\` 으로 feature branch 생성
2. 작업 완료 후 \`git push origin ${sub.branch}\`
3. 완료 시 "[DONE:${taskId}:${sub.id}]" 메시지를 보내세요
4. 실패 시 "[FAIL:${taskId}:${sub.id}] 사유" 메시지를 보내세요
5. dev 브랜치에 직접 push 금지!`;
}

// ═══════════════════════════════════════════════════════════════
// Quick Delegate — 분해 없이 바로 idle 워커 1명에게 전달
// ═══════════════════════════════════════════════════════════════

export async function quickDelegate(
  message: string,
  requestedBy: string,
  sendTelegram: SendTelegramFn,
): Promise<{ workerName: string; taskId: string } | null> {
  // idle 워커 중 아무나 선택 (어피니티 고려)
  const idle = workerBots.filter(w => w.status === "idle");
  if (!idle.length) return null;

  // 메시지에서 도메인 힌트 추출
  const bestWorker = idle[0]!; // TODO: 어피니티 기반 선택

  const taskId = randomUUID().slice(0, 8);
  const subId = randomUUID().slice(0, 6);
  const mention = bestWorker.username ? `@${bestWorker.username} ` : "";

  bestWorker.status = "busy";

  // 워커에게 보낼 메시지 — [TASK:] 프로토콜이 아닌 일반 메시지로 전달
  // 워커 봇이 그냥 일반 메시지로 처리하도록
  const delegateMsg = `${mention}${message}`;

  try {
    await sendTelegram(bestWorker.chatId, delegateMsg);
    console.log(`[Orchestrator] Quick delegated to ${bestWorker.name}: ${message.slice(0, 50)}`);
    return { workerName: bestWorker.name, taskId };
  } catch (e: any) {
    bestWorker.status = "idle";
    console.error(`[Orchestrator] Quick delegate failed: ${e.message}`);
    return null;
  }
}

// ════════════════════════════════���══════════════════════════════
// Step 3: Collect — 워커 완료 보고 처리
// ═══════════════════════════════════════════════════════════════

export interface TaskCompletionResult {
  taskId: string;
  subtaskId: string;
  allDone: boolean;
  task: OrchestratedTask;
}

export function handleWorkerReport(
  message: string,
): TaskCompletionResult | null {
  // [DONE:taskId:subtaskId] or [FAIL:taskId:subtaskId] reason
  const doneMatch = message.match(/\[DONE:(\w+):(\w+)\]/);
  const failMatch = message.match(/\[FAIL:(\w+):(\w+)\]\s*(.*)/);

  if (!doneMatch && !failMatch) return null;

  const [, taskId, subtaskId] = (doneMatch || failMatch)!;
  const task = activeTasks.get(taskId!);
  if (!task) return null;

  const sub = task.subtasks.find(s => s.id === subtaskId);
  if (!sub) return null;

  const success = !!doneMatch;
  if (success) {
    sub.status = "completed";
    sub.completedAt = Date.now();
    console.log(`[Orchestrator] Subtask ${subtaskId} completed by ${sub.assignedTo}`);
  } else {
    sub.status = "failed";
    sub.error = failMatch?.[3] || "Unknown error";
    sub.completedAt = Date.now();
    console.log(`[Orchestrator] Subtask ${subtaskId} failed: ${sub.error}`);
  }

  // 어피니티 업데이트
  if (sub.assignedTo && sub.files?.length) {
    updateAffinity(sub.assignedTo, sub.files, success);
  }

  // Release worker
  const worker = workerBots.find(w => w.name === sub.assignedTo);
  if (worker) worker.status = "idle";

  // Check if all subtasks are done
  const allDone = task.subtasks.every(s => s.status === "completed" || s.status === "failed");

  return { taskId: taskId!, subtaskId: subtaskId!, allDone, task };
}

// ═══════════════════════════════════════════════════════════════
// Step 4: Merge — feature branches를 dev 브랜치로 머지
// ═══════════════════════════════════════════════════════════════

function runGitInRepo(repoPath: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { cwd: repoPath, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    proc.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { output += d.toString(); });
    proc.on("close", (code) => resolve({ code: code ?? 1, output: output.trim() }));
    proc.on("error", (e) => resolve({ code: 1, output: e.message }));
  });
}

const REPO_PATHS: Record<string, string> = {
  "lemon-front": "/home/angrylawyer/lemon-front",
  "lemon-api-server-spring": "/home/angrylawyer/lemon-api-server-spring",
  "lemon-ai-server-FastAPI": "/home/angrylawyer/lemon-ai-server-FastAPI",
  "lemon_flutter": "/home/angrylawyer/lemon_flutter",
};

export async function mergeCompletedTask(
  task: OrchestratedTask,
  askClaude: AskClaudeFn,
  sendTelegram: SendTelegramFn,
): Promise<string> {
  task.status = "merging";
  const results: string[] = [];

  const completedSubs = task.subtasks.filter(s => s.status === "completed" && s.branch);

  for (const sub of completedSubs) {
    const repoPath = REPO_PATHS[sub.repo];
    if (!repoPath) {
      results.push(`❌ ${sub.id}: 알 수 없는 레포 ${sub.repo}`);
      continue;
    }

    // Fetch latest
    await runGitInRepo(repoPath, ["fetch", "origin"]);

    // Try merge
    const mergeResult = await runGitInRepo(repoPath, [
      "merge", `origin/${sub.branch}`, "--no-edit",
    ]);

    if (mergeResult.code === 0) {
      results.push(`✅ ${sub.id} (${sub.repo}): 머지 성공`);
    } else {
      // Abort failed merge
      await runGitInRepo(repoPath, ["merge", "--abort"]);
      results.push(`⚠️ ${sub.id} (${sub.repo}): 머지 충돌\n${mergeResult.output.slice(0, 200)}`);
    }
  }

  // Verify phase
  task.status = "verifying";
  const verifyResults = await verifyMergedCode(task, askClaude);
  results.push(...verifyResults);

  // Push if all good
  const hasErrors = results.some(r => r.startsWith("❌") || r.includes("에러"));
  if (!hasErrors) {
    for (const repo of new Set(completedSubs.map(s => s.repo))) {
      const repoPath = REPO_PATHS[repo];
      if (repoPath) {
        await runGitInRepo(repoPath, ["push", "origin", DEV_BRANCH]);
        results.push(`🚀 ${repo}: ${DEV_BRANCH}에 push 완료`);
      }
    }
    task.status = "completed";
  } else {
    task.status = "failed";
  }

  task.completedAt = Date.now();

  // Report to requester
  const summary = formatTaskSummary(task, results);
  await sendTelegram(task.requestedBy, summary);

  return summary;
}

async function verifyMergedCode(
  task: OrchestratedTask,
  askClaude: AskClaudeFn,
): Promise<string[]> {
  const results: string[] = [];
  const repos = new Set(task.subtasks.filter(s => s.status === "completed").map(s => s.repo));

  for (const repo of repos) {
    const repoPath = REPO_PATHS[repo];
    if (!repoPath) continue;

    // Run build/analyze based on repo type
    let verifyCmd: string[];
    if (repo === "lemon_flutter") {
      verifyCmd = ["/home/angrylawyer/flutter/bin/flutter", "analyze", "--no-pub"];
    } else if (repo === "lemon-front") {
      verifyCmd = ["npx", "tsc", "--noEmit"];
    } else if (repo.includes("spring")) {
      verifyCmd = ["./gradlew", "compileJava"];
    } else {
      continue;
    }

    const proc = await new Promise<{ code: number; output: string }>((resolve) => {
      const p = spawn(verifyCmd[0]!, verifyCmd.slice(1), {
        cwd: repoPath,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, LEMON_FORK_JAVAC: "true" },
      });
      let output = "";
      p.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
      p.stderr?.on("data", (d: Buffer) => { output += d.toString(); });
      p.on("close", (code) => resolve({ code: code ?? 1, output }));
      p.on("error", (e) => resolve({ code: 1, output: e.message }));
    });

    if (proc.code === 0) {
      results.push(`✅ ${repo}: 빌드 검증 통과`);
    } else {
      const errors = proc.output.split("\n").filter(l => l.includes("error")).slice(0, 5).join("\n");
      results.push(`❌ ${repo}: 빌드 에러\n${errors}`);
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════���═══════════
// Worker Mode — 워커 봇의 태스크 감지 및 실행
// ═══════════════════════════════════════════════════════════════

export interface DetectedTask {
  taskId: string;
  subtaskId: string;
  description: string;
  repo: string;
  branch: string;
  files: string[];
}

export function detectTaskMessage(message: string): DetectedTask | null {
  const match = message.match(/\[TASK:(\w+):(\w+)\]/);
  if (!match) return null;

  const lines = message.split("\n");
  const description = lines.find(l => l.startsWith("작업:"))?.slice(3).trim() || "";
  const repo = lines.find(l => l.startsWith("레포:"))?.slice(3).trim() || "";
  const branch = lines.find(l => l.startsWith("브랜치:"))?.slice(4).trim() || "";
  const filesLine = lines.find(l => l.startsWith("파일:"))?.slice(3).trim() || "";
  const files = filesLine ? filesLine.split(",").map(f => f.trim()) : [];

  return {
    taskId: match[1]!,
    subtaskId: match[2]!,
    description,
    repo,
    branch,
    files,
  };
}

export async function executeWorkerTask(
  task: DetectedTask,
  askClaude: AskClaudeFn,
  sendTelegram: SendTelegramFn,
): Promise<void> {
  const repoPath = REPO_PATHS[task.repo];
  if (!repoPath) {
    await sendTelegram(LEAD_BOT_CHAT_ID, `[FAIL:${task.taskId}:${task.subtaskId}] 레포 ${task.repo} 경로 없음`);
    return;
  }

  try {
    // 1. Ensure on dev branch and up to date
    await runGitInRepo(repoPath, ["checkout", DEV_BRANCH]);
    await runGitInRepo(repoPath, ["pull", "origin", DEV_BRANCH]);

    // 2. Create feature branch
    await runGitInRepo(repoPath, ["checkout", "-b", task.branch]);
    console.log(`[Worker] Created branch ${task.branch} in ${task.repo}`);

    // 3. Execute task via Claude
    const workerPrompt = `당신은 워커 에이전트입니다. 다음 작업을 수행하세요.

레포: ${task.repo} (경로: ${repoPath})
브랜치: ${task.branch}
작업: ${task.description}
${task.files.length ? `관련 파일: ${task.files.join(", ")}` : ""}

규칙:
- 이 레포 내에서만 작업하세요
- 작업 완료 후 변경된 파일을 git add + commit 하세요
- 커밋 메시지는 "feat: ${task.description.slice(0, 50)}" 형식
- git push origin ${task.branch} 하세요
- 빌드/린트 에러가 없는지 확인하세요`;

    await askClaude(LEAD_BOT_CHAT_ID, workerPrompt);

    // 4. Verify branch was pushed
    const pushResult = await runGitInRepo(repoPath, ["push", "origin", task.branch]);

    // 5. Go back to dev branch
    await runGitInRepo(repoPath, ["checkout", DEV_BRANCH]);

    // 6. Report completion
    if (pushResult.code === 0 || pushResult.output.includes("Everything up-to-date")) {
      await sendTelegram(LEAD_BOT_CHAT_ID,
        `[DONE:${task.taskId}:${task.subtaskId}]\n✅ ${task.repo}/${task.branch} push 완료`);
    } else {
      await sendTelegram(LEAD_BOT_CHAT_ID,
        `[FAIL:${task.taskId}:${task.subtaskId}] push 실패: ${pushResult.output.slice(0, 200)}`);
    }
  } catch (e: any) {
    // Cleanup: go back to dev branch
    await runGitInRepo(repoPath, ["checkout", DEV_BRANCH]).catch(() => {});
    await sendTelegram(LEAD_BOT_CHAT_ID,
      `[FAIL:${task.taskId}:${task.subtaskId}] ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Status Formatting
// ═══════════════════════════════════════════════════════════════

export function formatTaskStatus(task: OrchestratedTask): string {
  const elapsed = Math.round((Date.now() - task.createdAt) / 1000);
  const lines = [
    `📋 작업 #${task.id} — ${task.status}`,
    `⏱ ${elapsed}s | 서브태스크: ${task.subtasks.length}개`,
    "",
  ];

  for (const sub of task.subtasks) {
    const icon = sub.status === "completed" ? "✅" :
                 sub.status === "failed" ? "❌" :
                 sub.status === "in_progress" ? "⏳" :
                 sub.status === "dispatched" ? "📨" : "⏸";
    lines.push(`${icon} ${sub.id} → ${sub.assignedTo || "미배정"} (${sub.repo})`);
    lines.push(`   ${sub.description.slice(0, 80)}`);
    if (sub.error) lines.push(`   ❗ ${sub.error}`);
  }

  return lines.join("\n");
}

function formatTaskSummary(task: OrchestratedTask, results: string[]): string {
  const elapsed = Math.round(((task.completedAt || Date.now()) - task.createdAt) / 1000);
  const completed = task.subtasks.filter(s => s.status === "completed").length;
  const failed = task.subtasks.filter(s => s.status === "failed").length;

  return [
    `📋 작업 #${task.id} — ${task.status === "completed" ? "✅ 완료" : "❌ 실패"}`,
    `⏱ ${elapsed}s | 성공: ${completed} | 실패: ${failed}`,
    `원래 요청: ${task.originalPrompt.slice(0, 100)}`,
    "",
    "--- 결과 ---",
    ...results,
  ].join("\n");
}
