/**
 * Ralph Loop 기능 테스트
 * 실행: RALPH_SKIP_EVALUATOR=true bun test-ralph.ts
 */

import { createTask, loadPRD, runRalphLoop, getInProgressTasks, formatRalphStatus, listTasks, resumeInProgressTasks } from "./src/ralph-loop";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";

const TASKS_DIR = join(import.meta.dir, "tasks");

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

// ─── 1. 파일 오퍼레이션 ──────────────────────────────────────────

console.log("\n[1] 파일 오퍼레이션");

const t1 = createTask({
  taskId: "test-001",
  originalPrompt: "테스트 태스크",
  requestedBy: "99999",
  repo: "lemon-front",
  branch: "agent/test/test-001",
  files: ["src/test.ts"],
  items: [{ description: "테스트 아이템 1" }, { description: "테스트 아이템 2" }],
});

ok("createTask returns TaskPRD", !!t1 && t1.taskId === "test-001");
ok("prd.json 생성됨", existsSync(join(TASKS_DIR, "test-001", "prd.json")));
ok("progress.log 생성됨", existsSync(join(TASKS_DIR, "test-001", "progress.log")));

const loaded = loadPRD("test-001");
ok("loadPRD 복원", !!loaded && loaded.items.length === 2);
ok("아이템 상태 초기화", loaded?.items[0]?.passes === false && loaded?.items[0]?.iteration === 0);

const status = formatRalphStatus("test-001");
ok("formatRalphStatus 출력", status.includes("test-001") && status.includes("pending"));

const tasks = listTasks();
ok("listTasks 포함", tasks.some(t => t.taskId === "test-001"));

// ─── 2. 존재하지 않는 태스크 ─────────────────────────────────────

console.log("\n[2] 엣지 케이스");

const missing = loadPRD("nonexistent");
ok("없는 태스크 → null", missing === null);

const missingStatus = formatRalphStatus("nonexistent");
ok("없는 태스크 status → 에러 메시지", missingStatus.includes("없음"));

// ─── 3. Ralph Loop 실행 (mock Claude) ───────────────────────────

console.log("\n[3] Ralph Loop (RALPH_SKIP_EVALUATOR=true, mock Claude)");

const t2 = createTask({
  taskId: "test-002",
  originalPrompt: "mock 태스크 — 2번 반복 후 완료",
  requestedBy: "99999",
  repo: "lemon-ai-server-FastAPI",  // 빌드 체크 없음
  branch: "agent/test/test-002",
  files: [],
  items: [{ description: "mock 작업" }],
});

let callCount = 0;
const mockAskClaude = async (_chatId: string, _message: string): Promise<string> => {
  callCount++;
  // 2번째 호출에서 완료 메시지 반환
  return callCount >= 2
    ? "작업 완료했습니다. 모든 변경사항을 커밋했습니다."
    : "작업 진행 중입니다. 파일을 분석하고 있습니다.";
};

const sendLog: string[] = [];
const mockSendTg = async (_chatId: string, message: string): Promise<void> => {
  sendLog.push(message);
};

// RALPH_SKIP_EVALUATOR=true 로 evaluator 건너뛰기
process.env.RALPH_SKIP_EVALUATOR = "true";

const result = await runRalphLoop("test-002", mockAskClaude, mockSendTg);

ok("loop 완료", result.completed === true);
ok("총 반복 수 기록", result.totalIterations >= 1);
ok("Claude 최소 1회 호출", callCount >= 1);
ok("sendTg 완료 메시지 포함", sendLog.some(m => m.includes("완료")));

const prd2 = loadPRD("test-002");
ok("prd.json status=completed", prd2?.status === "completed");
ok("아이템 passes=true", prd2?.items[0]?.passes === true);

const progressLog = readFileSync(join(TASKS_DIR, "test-002", "progress.log"), "utf-8");
ok("progress.log ITEM DONE 포함", progressLog.includes("ITEM DONE"));
ok("progress.log RALPH LOOP END 포함", progressLog.includes("RALPH LOOP END"));

// ─── 4. 재개 (Resume) ────────────────────────────────────────────

console.log("\n[4] 재개 (Resume)");

const t3 = createTask({
  taskId: "test-003",
  originalPrompt: "재개 테스트",
  requestedBy: "99999",
  repo: "lemon-ai-server-FastAPI",
  branch: "agent/test/test-003",
  files: [],
  items: [{ description: "재개 아이템" }],
});

// running 상태로 강제 설정 (봇 크래시 시뮬레이션)
t3.status = "running";
t3.items[0]!.iteration = 1; // 이미 1번 했다가 중단
const { writeFileSync } = await import("fs");
writeFileSync(join(TASKS_DIR, "test-003", "prd.json"), JSON.stringify(t3, null, 2));

const inProgress = getInProgressTasks();
ok("running 태스크 감지", inProgress.some(t => t.taskId === "test-003"));

callCount = 0;
const resumeLog: string[] = [];
await resumeInProgressTasks(mockAskClaude, async (_c, m) => { resumeLog.push(m); });

ok("재개 Telegram 알림 전송", resumeLog.some(m => m.includes("재개") || m.includes("완료")));
const prd3 = loadPRD("test-003");
ok("재개 후 완료", prd3?.status === "completed");

// ─── 5. 실패 케이스 (max iterations) ────────────────────────────
// evaluator를 100ms 타임아웃으로 강제 실패 → complete=false → max iter 초과

console.log("\n[5] 최대 반복 초과");

process.env.RALPH_SKIP_EVALUATOR = "false";
process.env.RALPH_EVALUATOR_TIMEOUT = "100"; // 즉시 실패

const t4 = createTask({
  taskId: "test-004",
  originalPrompt: "실패 태스크 — 영원히 미완료",
  requestedBy: "99999",
  repo: "lemon-ai-server-FastAPI",
  branch: "agent/test/test-004",
  files: [],
  items: [{ description: "절대 안 끝나는 작업" }],
});

// maxIterations를 2로 줄여서 빠른 테스트
const prd4 = loadPRD("test-004")!;
prd4.items[0]!.maxIterations = 2;
writeFileSync(join(TASKS_DIR, "test-004", "prd.json"), JSON.stringify(prd4, null, 2));

const neverDone = async () => "아직 작업 중입니다. 계속 진행하겠습니다.";
const failResult = await runRalphLoop("test-004", neverDone as any, mockSendTg);

ok("max 초과 시 completed=false", failResult.completed === false);
const prd4Final = loadPRD("test-004");
ok("max 초과 시 status=failed", prd4Final?.status === "failed");
ok("아이템에 error 메시지", !!prd4Final?.items[0]?.error);

// ─── 정리 ─────────────────────────────────────────────────────

console.log("\n[정리] 테스트용 tasks 삭제");
for (const id of ["test-001", "test-002", "test-003", "test-004"]) {
  try { rmSync(join(TASKS_DIR, id), { recursive: true, force: true }); } catch {}
}
console.log("  삭제 완료");

// ─── 결과 ────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(40)}`);
console.log(`결과: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
