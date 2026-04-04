/**
 * Orchestrator — 리드-워커 멀티봇 작업 위임 시스템
 *
 * 리드 봇이 작업을 서브태스크로 분해하고 워커 봇에 Telegram으로 위임.
 * 워커 봇은 feature branch에서 작업 후 push, 리드가 머지.
 */

import { randomUUID } from "crypto";
import { spawn } from "child_process";

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

// ══════════════════════════════════════════════════��════════════
// Step 1: Plan — 작업을 서브태스크로 분해
// ═════════════════════════════════════���═════════════════════════

type AskClaudeFn = (chatId: string, message: string) => Promise<string>;
type SendTelegramFn = (chatId: string, message: string) => Promise<void>;

export async function planTask(
  prompt: string,
  requestedBy: string,
  askClaude: AskClaudeFn,
): Promise<OrchestratedTask> {
  const taskId = randomUUID().slice(0, 8);

  const planPrompt = `당신은 멀티에이전트 개발 오케스트레이터입니다.

다음 작업을 서브태스크로 분해해주세요. 각 서브태스크는 하나의 봇이 독립적으로 실행할 수 있어야 합니다.

사용 가능한 워커 봇과 접근 가능한 레포:
${workerBots.map(w => `- ${w.name} (${w.username}): ${w.repos.join(", ")}`).join("\n")}

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
- API 변경이 필요하면 API 서브태스크를 먼저 배치`;

  const response = await askClaude(requestedBy, planPrompt);

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
    const sub: SubTask = {
      id,
      description: def.description || "",
      repo: def.repo || "",
      files: def.files || [],
      assignedTo: def.assignTo || undefined,
      branch: `agent/${def.assignTo || "unassigned"}/${taskId}-${id}`,
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
  return `[TASK:${taskId}:${sub.id}]
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

  if (doneMatch) {
    sub.status = "completed";
    sub.completedAt = Date.now();
    console.log(`[Orchestrator] Subtask ${subtaskId} completed by ${sub.assignedTo}`);
  } else {
    sub.status = "failed";
    sub.error = failMatch?.[3] || "Unknown error";
    sub.completedAt = Date.now();
    console.log(`[Orchestrator] Subtask ${subtaskId} failed: ${sub.error}`);
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
