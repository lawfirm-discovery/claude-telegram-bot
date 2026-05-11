/**
 * Evaluator — 작업 완료 여부를 별도 세션에서 독립 판정
 *
 * 같은 세션이 자기 작업을 평가하면 자기 편향이 생긴다.
 * Claude CLI를 새 프로세스로 spawn하여 깨끗한 컨텍스트로 판정.
 *
 * default 모델: Haiku 4.5 (가볍고 빠름, Opus 대비 비용 약 1/15).
 * 평가는 단순한 JSON 분류 작업이라 작은 모델로 충분.
 *
 * 환경변수:
 *  - RALPH_EVALUATOR_MODEL: 모델 ID (default claude-haiku-4-5)
 *  - RALPH_EVALUATOR_TIMEOUT: 타임아웃 ms (default 45000)
 *  - RALPH_SKIP_EVALUATOR=true: 평가 단계 건너뛰기 (디버깅)
 */

import { spawn } from "child_process";
import { CLI_SUPPORTS_EFFORT } from "./claude-engine";

export interface EvalResult {
  complete: boolean;
  reason: string;
  remainingWork?: string;
  nextFocus?: string; // 다음 반복에서 집중할 구체적 작업
}

export interface EvaluatorContext {
  taskDescription: string;
  contextSummary: string;
  recentLogTail: string;
  testResult: string;
  /**
   * 현재 워커가 빌드 권한을 가진 중앙 서버(rtx6000)인지 여부.
   * false (비-빌드 워커) 면 evaluator 가 빌드/타입체크/테스트 미실행을 미완료 사유로 삼지 않음.
   * 호성님 멀티서버 규칙: rtx6000 만 빌드 담당, 나머지는 코드 수정 + git push 가 끝.
   */
  isBuildWorker?: boolean;
}

const DEFAULT_MODEL = process.env.RALPH_EVALUATOR_MODEL || "claude-haiku-4-5";
const DEFAULT_TIMEOUT = parseInt(process.env.RALPH_EVALUATOR_TIMEOUT || "45000");
const SKIP = () => process.env.RALPH_SKIP_EVALUATOR === "true";

/**
 * Claude CLI 단발 호출 — tool 없이 텍스트 응답만 (compress/evaluator 공용).
 */
export function askClaudeLight(
  prompt: string,
  opts: { model?: string; timeoutMs?: number; effort?: string } = {},
): Promise<string> {
  const model = opts.model || DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const effort = opts.effort || "low";

  return new Promise((resolve, reject) => {
    // CLI 2.1.x: --no-tool-use → --tools "" (모든 tool 비활성)
    const args = [
      "-p",
      "--model", model,
      ...(CLI_SUPPORTS_EFFORT ? ["--effort", effort] : []),
      "--tools", "",
      "--output-format", "text",
      "--permission-mode", "bypassPermissions",
    ];
    const proc = spawn(process.env.CLAUDE_PATH || "claude", args, {
      env: { ...process.env, NO_COLOR: "1", TELEGRAM_BOT_TOKEN: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.stdin?.write(prompt);
    proc.stdin?.end();

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      reject(new Error(`light-call timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else reject(new Error(stderr.slice(0, 200) || `light-call exit ${code}`));
    });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Evaluator 본체. 단일 시도 + JSON 추출 실패 시 재시도 1회.
 * 명시적 strict-JSON 지시 + repair 프롬프트 패턴.
 */
export async function runEvaluator(ctx: EvaluatorContext): Promise<EvalResult> {
  if (SKIP()) return { complete: true, reason: "evaluator skipped (RALPH_SKIP_EVALUATOR)" };

  const prompt = buildEvaluatorPrompt(ctx);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await askClaudeLight(prompt);
      const parsed = extractJson(raw);
      if (parsed) return parsed;
      if (attempt === 0) {
        // repair 시도: 응답을 다시 한 번 JSON으로만 정리하라고 요청
        const repaired = await askClaudeLight(
          `다음 텍스트에서 JSON만 추출하여 그대로 반환하세요. 다른 설명 없이 JSON 한 개만:\n\n${raw.slice(0, 1500)}`,
          { effort: "low", timeoutMs: 20_000 },
        );
        const reparsed = extractJson(repaired);
        if (reparsed) return reparsed;
      }
    } catch (e: any) {
      if (attempt === 1) {
        return { complete: false, reason: `evaluator error: ${e.message}` };
      }
    }
  }
  return { complete: false, reason: "evaluator: JSON parse failed after 2 attempts" };
}

function buildEvaluatorPrompt(ctx: EvaluatorContext): string {
  // 호성님 멀티서버 규칙: rtx6000 만 빌드 담당. 다른 워커(3060/A4500/맥미니/win 등)는
  // 코드 수정 + git push 만 수행하고, rtx6000 auto-pull 이 1분 내 빌드를 자동 검증함.
  // 이 evaluator 가 비-rtx6000 워커에서 빌드 결과를 요구하면 무한 미완료 루프 발생 → 사고 (2026-05-11 f45e1760).
  const buildRule = ctx.isBuildWorker
    ? `- 빌드/타입체크/테스트가 **실행되었고 실패**했다면 미완료`
    : `- **이 워커는 빌드 권한 없음** (rtx6000 만 빌드 담당). 다음 원칙 준수:
  - "빌드/타입체크/테스트 미실행" 을 미완료 사유로 삼지 말 것
  - 코드 수정 + git push 완료 시 → \`complete=true\` 판정 가능
  - rtx6000 auto-pull 이 1분 내 빌드를 자동 검증함 (에러 시 텔레그램 알림)
  - 에이전트가 빌드 명령(flutter/gradle/npm/vite build 등) 시도했다면 규칙 위반이지만, 그래도 코드 수정 + push 가 완료되었으면 complete=true`;

  return `당신은 작업 완료 여부를 판정하는 독립 평가자입니다. 이전 작업 에이전트와 별도의 세션입니다.

## 원본 작업
${ctx.taskDescription}

## 현재 진행 요약
${ctx.contextSummary || "(아직 없음)"}

## 최근 로그 (마지막 10줄)
${ctx.recentLogTail || "(없음)"}

## 빌드/테스트 결과
${ctx.testResult}

## 현재 워커 권한
${ctx.isBuildWorker ? "빌드 가능 (rtx6000 중앙 서버)" : "코드 수정 전용 (비-rtx6000 워커) — 빌드 검증 불가"}

위 정보를 바탕으로 이 작업이 **완전히 완료**되었는지 평가하세요.
- 코드 수정이 있고 git push 가 완료되었으면 높은 확률로 완료
- 로그에 에러, 미구현, TODO, "다음에 수정"이 남아있으면 미완료
${buildRule}
- "원본 작업 범위 밖"이라는 사유로 미완료 처리하지 말 것 (작업 자체가 명확하지 않으면 complete=true)

JSON 한 개만 응답 (코드블록 없이, 다른 텍스트 없이):
{"complete": true, "reason": "판정 이유", "nextFocus": null}
또는
{"complete": false, "reason": "미완료 이유", "remainingWork": "남은 작업", "nextFocus": "다음 반복에서 반드시 해결해야 할 구체적 작업 한 줄"}`;
}

function extractJson(raw: string): EvalResult | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const obj = JSON.parse(match[0]);
    if (typeof obj.complete !== "boolean") return null;
    if (typeof obj.reason !== "string") return null;
    return {
      complete: obj.complete,
      reason: obj.reason,
      remainingWork: typeof obj.remainingWork === "string" ? obj.remainingWork : undefined,
      nextFocus: typeof obj.nextFocus === "string" ? obj.nextFocus : undefined,
    };
  } catch {
    return null;
  }
}
