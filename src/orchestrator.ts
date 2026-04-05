/**
 * Orchestrator — 리드-워커 멀티봇 작업 위임 시스템
 *
 * 리드 봇이 작업을 서브태스크로 분해하고 워커 봇에 HTTP API로 위임.
 * 워커 봇은 feature branch에서 작업 후 push, 리드가 머지.
 */

import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { saveMessage, saveSession, getMessages, getSessions, getStats, testConnection, type SaveMessageParams, type SaveSessionParams } from "./db";

export type BotRole = "lead" | "worker";

export interface WorkerBot {
  chatId: string; name: string; username: string; apiUrl: string;
  repos: string[]; status: "idle" | "busy" | "offline";
}

export interface SubTask {
  id: string; description: string; repo: string; files?: string[];
  assignedTo?: string; branch?: string;
  status: "pending" | "dispatched" | "in_progress" | "completed" | "failed";
  result?: string; error?: string; createdAt: number; completedAt?: number;
}

export interface OrchestratedTask {
  id: string; originalPrompt: string; subtasks: SubTask[];
  status: "planning" | "dispatching" | "in_progress" | "merging" | "verifying" | "completed" | "failed";
  createdAt: number; completedAt?: number; requestedBy: string;
}

export const BOT_ROLE: BotRole = (process.env.BOT_ROLE || "worker") as BotRole;
export const DEV_BRANCH = process.env.DEV_BRANCH || "dev-hs-rtx6000-new";
const LEAD_BOT_CHAT_ID = process.env.LEAD_BOT_CHAT_ID || "";
const LEAD_API_PORT = parseInt(process.env.LEAD_API_PORT || "18801");

function parseWorkerBots(): WorkerBot[] {
  const raw = process.env.WORKER_BOTS || "";
  if (!raw) return [];
  return raw.split(",").map((entry) => {
    const parts = entry.split(":");
    let apiUrl = "", name = "", username = "", reposStr = "";
    if (parts[0]?.startsWith("http")) {
      apiUrl = `${parts[0]}:${parts[1]}:${parts[2]}`;
      name = parts[3]?.trim() || ""; username = parts[4]?.trim() || ""; reposStr = parts[5] || "";
    } else { name = parts[1]?.trim() || ""; username = parts[2]?.trim() || ""; reposStr = parts[3] || ""; }
    return { chatId: "", name, username, apiUrl, repos: reposStr.split("+").filter(Boolean), status: "idle" as const };
  }).filter(w => w.name && w.apiUrl);
}

const workerBots: WorkerBot[] = parseWorkerBots();
function getLeadApiUrl(): string { return process.env.LEAD_API_URL || `http://100.108.86.92:${LEAD_API_PORT}`; }

// Health Check + Auto Recovery
const RESTART_SECRET = process.env.RESTART_SECRET || "lemonclaw-restart-2024";
const workerFailCount = new Map<string, number>(); // 연속 실패 횟수 추적
let healthCheckCycle = 0; // #6: deep check는 5회마다 1번 (CLI 스폰 부하 줄이기)

async function checkWorkerHealth(): Promise<void> {
  healthCheckCycle++;
  const isDeepCheck = healthCheckCycle % 5 === 0; // 5분마다 deep (60s × 5)

  await Promise.allSettled(workerBots.map(async (w) => {
    try {
      const url = isDeepCheck ? `${w.apiUrl}/health?deep=1` : `${w.apiUrl}/health`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(isDeepCheck ? 20_000 : 5_000) });
      const data = await resp.json() as any;
      if (data.ok) {
        if (w.status === "offline") { w.status = "idle"; console.log(`[HealthCheck] ${w.name} back online`); }
        workerFailCount.set(w.name, 0);

        // CLI 인증 실패 감지 → 세션 리셋 시도 (deep check일 때만)
        if (isDeepCheck && data.cliAuth === false) {
          console.log(`[HealthCheck] ${w.name}: CLI auth failed — resetting session`);
          try {
            await fetch(`${w.apiUrl}/reset-session`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ secret: RESTART_SECRET }),
              signal: AbortSignal.timeout(5_000),
            });
          } catch {}
        }
      } else {
        await handleWorkerDown(w, "unhealthy response");
      }
    } catch {
      await handleWorkerDown(w, "unreachable");
    }
  }));
  const online = workerBots.filter(w => w.status !== "offline").length;
  const offline = workerBots.filter(w => w.status === "offline").length;
  if (isDeepCheck) console.log(`[HealthCheck] deep: ${online} online, ${offline} offline`);
}

async function handleWorkerDown(w: WorkerBot, reason: string): Promise<void> {
  if (w.status === "busy") return; // 작업 중이면 건드리지 않음
  const fails = (workerFailCount.get(w.name) || 0) + 1;
  workerFailCount.set(w.name, fails);

  // 연속 3회 실패 시 재시작 시도 (1회차: 일시적일 수 있음)
  if (fails === 3) {
    console.log(`[HealthCheck] ${w.name}: ${fails} consecutive fails (${reason}) — attempting restart`);
    try {
      await fetch(`${w.apiUrl}/restart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: RESTART_SECRET, reason: `auto-recovery: ${reason}` }),
        signal: AbortSignal.timeout(5_000),
      });
      console.log(`[HealthCheck] ${w.name}: restart signal sent`);
    } catch {
      console.log(`[HealthCheck] ${w.name}: restart failed (server unreachable)`);
    }
  }

  w.status = "offline";
}
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;
export function startHealthCheck(): void { checkWorkerHealth(); healthCheckInterval = setInterval(checkWorkerHealth, 60_000); }
export function stopHealthCheck(): void { if (healthCheckInterval) clearInterval(healthCheckInterval); }

// Task Registry
const activeTasks = new Map<string, OrchestratedTask>();
const subtaskIndex = new Map<string, { taskId: string; subtaskId: string }>();
export function getTask(taskId: string): OrchestratedTask | undefined { return activeTasks.get(taskId); }
export function getWorkerBots(): WorkerBot[] { return workerBots; }

// Domain Affinity
interface AffinityEntry { botName: string; domain: string; taskCount: number; lastWorked: number; successRate: number; }
const AFFINITY_FILE = join(import.meta.dir, "..", ".lemonclaw", "affinity.json");
let affinityMap: AffinityEntry[] = [];
function loadAffinity(): void { try { if (existsSync(AFFINITY_FILE)) affinityMap = JSON.parse(readFileSync(AFFINITY_FILE, "utf-8")); } catch { affinityMap = []; } }
function saveAffinity(): void { try { writeFileSync(AFFINITY_FILE, JSON.stringify(affinityMap, null, 2)); } catch (e: any) { console.error(`[Affinity] ${e.message}`); } }
loadAffinity();

function extractDomain(fp: string): string { const p = fp.replace(/^(lib|src)\/(pages|components|features|widgets)\//, "").split("/"); return p.slice(0, Math.min(2, p.length - 1)).join("/") || "general"; }

export function updateAffinity(botName: string, files: string[], success: boolean): void {
  for (const domain of new Set(files.map(extractDomain))) {
    let e = affinityMap.find(a => a.botName === botName && a.domain === domain);
    if (!e) { e = { botName, domain, taskCount: 0, lastWorked: 0, successRate: 1 }; affinityMap.push(e); }
    e.taskCount++; e.lastWorked = Date.now();
    e.successRate = (e.successRate * (e.taskCount - 1) + (success ? 1 : 0)) / e.taskCount;
  }
  saveAffinity();
}

export function selectBestWorker(files: string[], repo: string): string | null {
  const domains = new Set(files.map(extractDomain));
  const eligible = workerBots.filter(w => w.status !== "offline" && (repo === "" || w.repos.includes(repo)));
  if (!eligible.length) return null;
  const scored = eligible.map(w => {
    let score = w.status === "idle" ? 30 : 0;
    for (const d of domains) { const e = affinityMap.find(a => a.botName === w.name && a.domain === d); if (e) { score += e.taskCount * 10 + e.successRate * 20; if ((Date.now() - e.lastWorked) / 3600000 < 24) score += 15; } }
    return { worker: w, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.worker.name || null;
}

export function formatAffinityReport(): string {
  if (!affinityMap.length) return "아직 어피니티 데이터가 없습니다.";
  const byBot = new Map<string, AffinityEntry[]>();
  for (const e of affinityMap) { const l = byBot.get(e.botName) || []; l.push(e); byBot.set(e.botName, l); }
  const lines: string[] = ["📊 도메인 어피니티 현황\n"];
  for (const [bot, entries] of byBot) { lines.push(`🤖 ${bot}:`); for (const e of entries.sort((a, b) => b.taskCount - a.taskCount).slice(0, 5)) lines.push(`  ${e.domain}: ${e.taskCount}건 (${Math.round(e.successRate * 100)}%)`); }
  return lines.join("\n");
}

// Plan
type AskClaudeFn = (chatId: string, message: string) => Promise<string>;
type SendTelegramFn = (chatId: string, message: string) => Promise<void>;

async function askClaudeLight(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.env.CLAUDE_PATH || "claude", ["-p", prompt, "--model", "claude-sonnet-4-6", "--effort", "low", "--no-tool-use", "--output-format", "text", "--permission-mode", "bypassPermissions"], { env: { ...process.env, NO_COLOR: "1", TELEGRAM_BOT_TOKEN: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} reject(new Error("타임아웃")); }, 30_000);
    proc.on("close", (code) => { clearTimeout(timer); code === 0 && stdout.trim() ? resolve(stdout.trim()) : reject(new Error(stderr.slice(0, 200) || "실패")); });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

export async function planTask(prompt: string, requestedBy: string): Promise<OrchestratedTask> {
  const taskId = randomUUID().slice(0, 8);
  const online = workerBots.filter(w => w.status !== "offline");
  const ah = affinityMap.length > 0 ? `\n어피니티:\n${affinityMap.slice(-20).map(a => `- ${a.botName}: ${a.domain} (${a.taskCount}건)`).join("\n")}` : "";
  const resp = await askClaudeLight(`멀티에이전트 오케스트레이터. 서브태스크 분해.\n워커: ${online.map(w => `${w.name}: ${w.repos.join(",")}`).join("; ")}${ah}\n작업: ${prompt}\nJSON만: [{"description":"..","repo":"..","files":[".."],"assignTo":".."}]`);
  let defs: any[] = []; try { const m = resp.match(/\[[\s\S]*\]/); if (m) defs = JSON.parse(m[0]); } catch { throw new Error(`JSON 에러`); }
  if (!defs.length) throw new Error("빈 결과");
  const subtasks: SubTask[] = defs.map((d: any) => { const id = randomUUID().slice(0, 6), files = d.files || [], repo = d.repo || "", a = selectBestWorker(files, repo) || d.assignTo; return { id, description: d.description || "", repo, files, assignedTo: a, branch: `agent/${a || "x"}/${taskId}-${id}`, status: "pending" as const, createdAt: Date.now() }; });
  const task: OrchestratedTask = { id: taskId, originalPrompt: prompt, subtasks, status: "planning", createdAt: Date.now(), requestedBy };
  activeTasks.set(taskId, task); for (const s of subtasks) subtaskIndex.set(s.id, { taskId, subtaskId: s.id });
  return task;
}

// Dispatch — HTTP
export async function dispatchTask(task: OrchestratedTask): Promise<void> {
  task.status = "dispatching"; const leadApiUrl = getLeadApiUrl();
  for (const sub of task.subtasks) {
    let worker = workerBots.find(w => w.name === sub.assignedTo);
    if (worker && worker.status === "offline") { const fb = workerBots.find(w => w.status === "idle" && w.repos.includes(sub.repo) && w.name !== worker!.name); if (fb) { sub.assignedTo = fb.name; sub.branch = `agent/${fb.name}/${task.id}-${sub.id}`; worker = fb; } else { sub.status = "failed"; sub.error = "오프라인"; continue; } }
    if (!worker) { sub.status = "failed"; sub.error = "워커 없음"; continue; }
    try {
      const r = await fetch(`${worker.apiUrl}/delegate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: formatTaskMessage(task.id, sub), requestedBy: task.requestedBy, taskId: `${task.id}:${sub.id}`, leadApiUrl }), signal: AbortSignal.timeout(10_000) });
      const j = await r.json() as any; if (!j.ok) throw new Error(j.error || "failed");
      sub.status = "dispatched"; worker.status = "busy"; console.log(`[Orchestrator] ${sub.id} → ${worker.name}`);
    } catch (e: any) { sub.status = "failed"; sub.error = e.message; }
  }
  task.status = "in_progress";
}

function formatTaskMessage(tid: string, sub: SubTask): string {
  return `[TASK:${tid}:${sub.id}]\n작업: ${sub.description}\n레포: ${sub.repo}\n브랜치: ${sub.branch}\n${sub.files?.length ? `파일: ${sub.files.join(", ")}` : ""}\n\n규칙: git checkout -b ${sub.branch}, push, DONE/FAIL 보고`;
}

// Quick Delegate + Session Affinity
let rrIdx = 0;
const SESSION_AFFINITY_TTL_MS = 600_000; // 10분 내 후속 요청은 같은 워커로
const userLastWorker = new Map<string, { workerName: string; timestamp: number }>();

export function getUserLastWorker(requestedBy: string): string | null {
  const entry = userLastWorker.get(requestedBy);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > SESSION_AFFINITY_TTL_MS) {
    userLastWorker.delete(requestedBy);
    return null;
  }
  return entry.workerName;
}

export async function quickDelegate(message: string, requestedBy: string): Promise<{ workerName: string; taskId: string } | null> {
  const idle = workerBots.filter(w => w.status === "idle");
  if (!idle.length) return null;

  let bw: WorkerBot;

  // 1순위: 세션 어피니티 — 최근 같은 사용자의 요청을 처리한 워커 (idle이면)
  const lastWorkerName = getUserLastWorker(requestedBy);
  const affinityWorker = lastWorkerName ? idle.find(w => w.name === lastWorkerName) : null;

  if (affinityWorker) {
    bw = affinityWorker;
    console.log(`[Orchestrator] Session affinity: ${bw.name} for user=${requestedBy}`);
  } else {
    // 2순위: 도메인 어피니티 — 파일 경로 기반
    const fh = message.match(/(?:src|lib|pages|components)\/[\w/.-]+/g) || [];
    if (fh.length) {
      const bn = selectBestWorker(fh, "");
      bw = idle.find(w => w.name === bn) || idle[rrIdx % idle.length]!;
    } else {
      // 3순위: 라운드로빈
      bw = idle[rrIdx % idle.length]!;
    }
  }

  rrIdx++;
  const taskId = randomUUID().slice(0, 8);
  bw.status = "busy";

  try {
    const r = await fetch(`${bw.apiUrl}/delegate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, requestedBy, taskId, leadApiUrl: getLeadApiUrl() }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = await r.json() as any;
    if (!j.ok) throw new Error(j.error || "failed");

    // 세션 어피니티 기록
    userLastWorker.set(requestedBy, { workerName: bw.name, timestamp: Date.now() });

    console.log(`[Orchestrator] → ${bw.name}: ${message.slice(0, 50)}`);
    setTimeout(() => { if (bw.status === "busy") bw.status = "idle"; }, 600_000);
    return { workerName: bw.name, taskId };
  } catch (e: any) {
    bw.status = "offline";
    const rem = workerBots.filter(w => w.status === "idle");
    if (rem.length) return quickDelegate(message, requestedBy);
    return null;
  }
}

export function detectDelegateMessage(text: string): { requestedBy: string; message: string } | null { const m = text.match(/\[DELEGATE:(\d+)\]\n?([\s\S]*)/); return m ? { requestedBy: m[1]!, message: m[2]!.trim() } : null; }

// Collect
export interface TaskCompletionResult { taskId: string; subtaskId: string; allDone: boolean; task: OrchestratedTask; }
export function handleWorkerReport(msg: string): TaskCompletionResult | null {
  const dm = msg.match(/\[DONE:(\w+):(\w+)\]/), fm = msg.match(/\[FAIL:(\w+):(\w+)\]\s*(.*)/);
  if (!dm && !fm) return null;
  const [, tid, sid] = (dm || fm)!; const task = activeTasks.get(tid!); if (!task) return null;
  const sub = task.subtasks.find(s => s.id === sid); if (!sub) return null;
  if (dm) { sub.status = "completed"; sub.completedAt = Date.now(); } else { sub.status = "failed"; sub.error = fm?.[3] || "?"; sub.completedAt = Date.now(); }
  if (sub.assignedTo && sub.files?.length) updateAffinity(sub.assignedTo, sub.files, !!dm);
  const w = workerBots.find(w => w.name === sub.assignedTo); if (w) w.status = "idle";
  return { taskId: tid!, subtaskId: sid!, allDone: task.subtasks.every(s => s.status === "completed" || s.status === "failed"), task };
}

// Merge
function runGit(cwd: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise(r => { const p = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }); let o = ""; p.stdout?.on("data", d => o += d); p.stderr?.on("data", d => o += d); p.on("close", c => r({ code: c ?? 1, output: o.trim() })); p.on("error", e => r({ code: 1, output: e.message })); });
}
const REPO_PATHS: Record<string, string> = { "lemon-front": "/home/angrylawyer/lemon-front", "lemon-api-server-spring": "/home/angrylawyer/lemon-api-server-spring", "lemon-ai-server-FastAPI": "/home/angrylawyer/lemon-ai-server-FastAPI", "lemon_flutter": "/home/angrylawyer/lemon_flutter" };

export async function mergeCompletedTask(task: OrchestratedTask, _ac: AskClaudeFn, sendTg: SendTelegramFn): Promise<string> {
  task.status = "merging"; const results: string[] = [];
  const done = task.subtasks.filter(s => s.status === "completed" && s.branch);
  for (const s of done) { const rp = REPO_PATHS[s.repo]; if (!rp) { results.push(`❌ ${s.id}: 레포 없음`); continue; } await runGit(rp, ["fetch", "origin"]); const mr = await runGit(rp, ["merge", `origin/${s.branch}`, "--no-edit"]); if (mr.code === 0) results.push(`✅ ${s.id}: 머지 OK`); else { await runGit(rp, ["merge", "--abort"]); results.push(`⚠️ ${s.id}: 충돌`); } }
  task.status = "verifying"; results.push(...await verifyCode(task));
  if (!results.some(r => r.startsWith("❌"))) { for (const repo of new Set(done.map(s => s.repo))) { const rp = REPO_PATHS[repo]; if (rp) { await runGit(rp, ["push", "origin", DEV_BRANCH]); results.push(`🚀 ${repo}: push`); } } task.status = "completed"; } else task.status = "failed";
  task.completedAt = Date.now(); const sum = fmtSummary(task, results); await sendTg(task.requestedBy, sum); return sum;
}

async function verifyCode(task: OrchestratedTask): Promise<string[]> {
  const results: string[] = [];
  for (const repo of new Set(task.subtasks.filter(s => s.status === "completed").map(s => s.repo))) {
    const rp = REPO_PATHS[repo]; if (!rp) continue;
    let cmd: string[]; if (repo === "lemon_flutter") cmd = ["/home/angrylawyer/flutter/bin/flutter", "analyze", "--no-pub"]; else if (repo === "lemon-front") cmd = ["npx", "tsc", "--noEmit"]; else if (repo.includes("spring")) cmd = ["./gradlew", "compileJava"]; else continue;
    const r = await new Promise<{ code: number; output: string }>(res => { const p = spawn(cmd[0]!, cmd.slice(1), { cwd: rp, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LEMON_FORK_JAVAC: "true" } }); let o = ""; p.stdout?.on("data", d => o += d); p.stderr?.on("data", d => o += d); p.on("close", c => res({ code: c ?? 1, output: o })); p.on("error", e => res({ code: 1, output: e.message })); });
    results.push(r.code === 0 ? `✅ ${repo}: OK` : `❌ ${repo}: 에러`);
  }
  return results;
}

// Worker Mode
export interface DetectedTask { taskId: string; subtaskId: string; description: string; repo: string; branch: string; files: string[]; }
export function detectTaskMessage(msg: string): DetectedTask | null {
  const m = msg.match(/\[TASK:(\w+):(\w+)\]/); if (!m) return null; const l = msg.split("\n");
  return { taskId: m[1]!, subtaskId: m[2]!, description: l.find(x => x.startsWith("작업:"))?.slice(3).trim() || "", repo: l.find(x => x.startsWith("레포:"))?.slice(3).trim() || "", branch: l.find(x => x.startsWith("브랜치:"))?.slice(4).trim() || "", files: (l.find(x => x.startsWith("파일:"))?.slice(3).trim() || "").split(",").map(f => f.trim()).filter(Boolean) };
}

export async function executeWorkerTask(task: DetectedTask, askClaude: AskClaudeFn, sendTg: SendTelegramFn): Promise<void> {
  const rp = REPO_PATHS[task.repo]; if (!rp) { await sendTg(LEAD_BOT_CHAT_ID, `[FAIL:${task.taskId}:${task.subtaskId}] 레포 없음`); return; }
  try {
    await runGit(rp, ["checkout", DEV_BRANCH]); await runGit(rp, ["pull", "origin", DEV_BRANCH]); await runGit(rp, ["checkout", "-b", task.branch]);
    await askClaude(LEAD_BOT_CHAT_ID, `워커: ${task.description}\n레포: ${task.repo} (${rp})\n브랜치: ${task.branch}\n${task.files.length ? `파일: ${task.files.join(", ")}` : ""}`);
    const pr = await runGit(rp, ["push", "origin", task.branch]); await runGit(rp, ["checkout", DEV_BRANCH]);
    await sendTg(LEAD_BOT_CHAT_ID, pr.code === 0 || pr.output.includes("up-to-date") ? `[DONE:${task.taskId}:${task.subtaskId}]` : `[FAIL:${task.taskId}:${task.subtaskId}] push fail`);
  } catch (e: any) { await runGit(rp, ["checkout", DEV_BRANCH]).catch(() => {}); await sendTg(LEAD_BOT_CHAT_ID, `[FAIL:${task.taskId}:${task.subtaskId}] ${e.message}`); }
}

// Formatting
export function formatTaskStatus(task: OrchestratedTask): string {
  const lines = [`📋 #${task.id} — ${task.status}`, `⏱ ${Math.round((Date.now() - task.createdAt) / 1000)}s | ${task.subtasks.length}개`, ""];
  for (const s of task.subtasks) { lines.push(`${s.status === "completed" ? "✅" : s.status === "failed" ? "❌" : s.status === "dispatched" ? "📨" : "⏸"} ${s.id} → ${s.assignedTo || "?"} (${s.repo})`); lines.push(`   ${s.description.slice(0, 80)}`); if (s.error) lines.push(`   ❗ ${s.error}`); }
  return lines.join("\n");
}

function fmtSummary(task: OrchestratedTask, results: string[]): string {
  return [`📋 #${task.id} — ${task.status === "completed" ? "✅" : "❌"}`, `⏱ ${Math.round(((task.completedAt || Date.now()) - task.createdAt) / 1000)}s`, `요청: ${task.originalPrompt.slice(0, 100)}`, "", ...results].join("\n");
}

// Lead API — 프론트엔드 대시보드 + 워커 간 통신
const LEAD_CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };

export function startLeadApi(): void {
  Bun.serve({ port: LEAD_API_PORT, idleTimeout: 120, async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: LEAD_CORS });
    const json = (data: any, status = 200) => Response.json(data, { status, headers: LEAD_CORS });
    const url = new URL(req.url);

    // 전체 상태 (프론트엔드 대시보드용)
    if (url.pathname === "/health") {
      return json({ ok: true, role: "lead", workers: workerBots.map(w => ({ name: w.name, username: w.username, status: w.status, repos: w.repos, apiUrl: w.apiUrl })) });
    }

    // 워커 상세 상태 (프론트에서 전체 워커의 deep health를 한 번에 조회)
    if (url.pathname === "/workers" && req.method === "GET") {
      const results = await Promise.allSettled(workerBots.map(async (w) => {
        try {
          const resp = await fetch(`${w.apiUrl}/health`, { signal: AbortSignal.timeout(5_000) });
          const data = await resp.json() as any;
          return { name: w.name, username: w.username, apiUrl: w.apiUrl, repos: w.repos, orchestratorStatus: w.status, health: data.ok ? "online" : "error", pid: data.pid, botUsername: data.botUsername };
        } catch {
          return { name: w.name, username: w.username, apiUrl: w.apiUrl, repos: w.repos, orchestratorStatus: w.status, health: "offline" };
        }
      }));
      const workers = results.map(r => r.status === "fulfilled" ? r.value : { health: "error" });
      return json({ ok: true, workers, timestamp: Date.now() });
    }

    // 개별 워커 제어: POST /worker-action { worker: "3060", action: "restart" | "reset-session" }
    if (url.pathname === "/worker-action" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const w = workerBots.find(w => w.name === body.worker);
        if (!w) return json({ ok: false, error: "worker not found" }, 404);

        const endpoint = body.action === "restart" ? "/restart" : body.action === "reset-session" ? "/reset-session" : null;
        if (!endpoint) return json({ ok: false, error: "invalid action" }, 400);

        const resp = await fetch(`${w.apiUrl}${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret: RESTART_SECRET, reason: `dashboard: ${body.action}` }),
          signal: AbortSignal.timeout(10_000),
        });
        const result = await resp.json();
        return json({ ok: true, worker: w.name, action: body.action, result });
      } catch (e: any) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // 워커 상세 (auth + 사용량 포함): GET /workers-detail
    if (url.pathname === "/workers-detail" && req.method === "GET") {
      const results = await Promise.allSettled(workerBots.map(async (w) => {
        try {
          const resp = await fetch(`${w.apiUrl}/health?deep=1`, { signal: AbortSignal.timeout(15_000) });
          const data = await resp.json() as any;
          // recent-activity에서 비용 합산
          let totalCost = 0;
          let totalSessions = 0;
          try {
            const actResp = await fetch(`${w.apiUrl}/recent-activity?count=100`, { signal: AbortSignal.timeout(5_000) });
            const actData = await actResp.json() as any;
            if (actData.ok && actData.activities) {
              for (const a of actData.activities) {
                if (a.cost) { totalCost += a.cost; totalSessions++; }
              }
            }
          } catch {}
          return {
            name: w.name, username: w.username, apiUrl: w.apiUrl, repos: w.repos,
            orchestratorStatus: w.status, health: data.ok ? "online" : "error",
            pid: data.pid, botUsername: data.botUsername,
            cliAuth: data.cliAuth,
            authInfo: data.authInfo || null,
            totalCost: Math.round(totalCost * 10000) / 10000,
            totalSessions,
          };
        } catch {
          return { name: w.name, username: w.username, apiUrl: w.apiUrl, repos: w.repos, orchestratorStatus: w.status, health: "offline" };
        }
      }));
      const workers = results.map(r => r.status === "fulfilled" ? r.value : { health: "error" });
      return json({ ok: true, workers, timestamp: Date.now() });
    }

    // 워커 로그 프록시: POST /worker-logs { worker, lines? }
    if (url.pathname === "/worker-logs" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const w = workerBots.find(w => w.name === body.worker);
        if (!w) return json({ ok: false, error: "worker not found" }, 404);
        const resp = await fetch(`${w.apiUrl}/logs?lines=${body.lines || 100}`, { signal: AbortSignal.timeout(10_000) });
        return json(await resp.json());
      } catch (e: any) { return json({ ok: false, error: e.message }, 500); }
    }

    // 워커 명령 실행 프록시: POST /worker-exec { worker, command }
    if (url.pathname === "/worker-exec" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const w = workerBots.find(w => w.name === body.worker);
        if (!w) return json({ ok: false, error: "worker not found" }, 404);
        const resp = await fetch(`${w.apiUrl}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret: RESTART_SECRET, command: body.command, timeout: body.timeout }),
          signal: AbortSignal.timeout(65_000),
        });
        return json(await resp.json());
      } catch (e: any) { return json({ ok: false, error: e.message }, 500); }
    }

    // 워커 최근 작업 프록시: POST /worker-recent { worker, count? }
    if (url.pathname === "/worker-recent" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const w = workerBots.find(w => w.name === body.worker);
        if (!w) return json({ ok: false, error: "worker not found" }, 404);
        const resp = await fetch(`${w.apiUrl}/recent-activity?count=${body.count || 10}`, { signal: AbortSignal.timeout(10_000) });
        return json(await resp.json());
      } catch (e: any) { return json({ ok: false, error: e.message }, 500); }
    }

    // ═══ DB API — 대화 기록 저장/조회 ═══

    // 워커가 메시지를 보고: POST /report-message
    if (url.pathname === "/report-message" && req.method === "POST") {
      try {
        const body = await req.json() as SaveMessageParams;
        await saveMessage(body);
        return json({ ok: true });
      } catch (e: any) { return json({ ok: false, error: e.message }, 500); }
    }

    // 워커가 세션 완료를 보고: POST /report-session
    if (url.pathname === "/report-session" && req.method === "POST") {
      try {
        const body = await req.json() as SaveSessionParams;
        await saveSession(body);
        return json({ ok: true });
      } catch (e: any) { return json({ ok: false, error: e.message }, 500); }
    }

    // 대화 조회: POST /messages { botName?, chatId?, search?, limit?, offset? }
    if (url.pathname === "/messages" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const result = await getMessages(body);
        return json({ ok: true, ...result });
      } catch (e: any) { return json({ ok: false, error: e.message }, 500); }
    }

    // 세션 조회: POST /sessions { botName?, limit? }
    if (url.pathname === "/sessions" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const sessions = await getSessions(body.botName, body.limit);
        return json({ ok: true, sessions });
      } catch (e: any) { return json({ ok: false, error: e.message }, 500); }
    }

    // 통계: GET /stats
    if (url.pathname === "/stats") {
      try {
        const stats = await getStats();
        return json({ ok: true, ...stats });
      } catch (e: any) { return json({ ok: false, error: e.message }, 500); }
    }

    // DB 상태: GET /db-health
    if (url.pathname === "/db-health") {
      const ok = await testConnection();
      return json({ ok, db: ok ? "connected" : "disconnected" });
    }

    // 워커 idle 보고
    if (url.pathname === "/worker-idle" && req.method === "POST") {
      try {
        const b = await req.json() as any;
        const w = workerBots.find(w => w.name === b.workerName || w.username === b.workerName);
        if (w) { w.status = "idle"; console.log(`[LeadAPI] ${w.name} idle`); }
        if (b.requestedBy && w) { userLastWorker.set(b.requestedBy, { workerName: w.name, timestamp: Date.now() }); }
        return json({ ok: true });
      } catch { return json({ ok: false }, 400); }
    }

    return new Response("Not found", { status: 404, headers: LEAD_CORS });
  }});
  console.log(`[LeadAPI] Listening on port ${LEAD_API_PORT}`);
  startHealthCheck();
}
