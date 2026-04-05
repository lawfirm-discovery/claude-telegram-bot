/**
 * Claude Engine Router — v1/v2 전환
 *
 * ENGINE_VERSION 환경변수로 엔진 선택:
 *   v1 (default) = spawn + stream-json (기존)
 *   v2           = @anthropic-ai/claude-agent-sdk
 *
 * 모든 외부 모듈(bot.ts, worker-api.ts, orchestrator.ts)은
 * 이 파일에서 import하여 엔진에 무관하게 동작.
 */

const ENGINE_VERSION = process.env.ENGINE_VERSION || "v2";

console.log(`[Engine] Using Claude engine: ${ENGINE_VERSION}`);

// Re-export types (동일 인터페이스)
export type { Session, HudInfo, ProgressInfo, OnProgress } from "./claude";

// 동적 import 대신 조건부 re-export
// Bun은 top-level await + dynamic import를 잘 지원하므로 이 방식 사용

let engine: typeof import("./claude");

if (ENGINE_VERSION === "v2") {
  engine = await import("./claude-v2");
} else {
  engine = await import("./claude");
}

export const CLI_SUPPORTS_EFFORT = engine.CLI_SUPPORTS_EFFORT;
export const askClaude = engine.askClaude;
export const askClaudeWithProgress = engine.askClaudeWithProgress;
export const clearSession = engine.clearSession;
export const getSession = engine.getSession;
export const getSessionStats = engine.getSessionStats;
export const getHudInfo = engine.getHudInfo;
export const clearHud = engine.clearHud;
export const killActiveProcesses = engine.killActiveProcesses;
export const saveInterruptedContext = engine.saveInterruptedContext;
export const loadInterruptedContext = engine.loadInterruptedContext;
export const hasInterruptedContext = engine.hasInterruptedContext;
