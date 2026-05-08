/**
 * Code Quality Guard — PreToolUse hook (Phase R3.6)
 *
 * Edit / Write / MultiEdit 도구 호출에서 호성님 절대 규칙 위반 차단:
 *   - TypeScript `as any` 새 추가 차단 ('정확한 타입 작성' 원칙)
 *   - ecosystem.config.js 수정 차단 (2026-03-18 사고 후 절대 규칙)
 *   - nginx lemon-test-3011 location / 변경 차단 (proxy_pass 로 변경 시도 등)
 *
 * 차단 사유는 모델에게 reason 으로 돌려줘서 우회 (정확한 타입 작성) 유도.
 *
 * 비활성화: env DISABLE_CODE_QUALITY_HOOK=true
 */

import type {
  HookCallback,
  PreToolUseHookInput,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { incr } from "../metrics";

const DISABLED = process.env.DISABLE_CODE_QUALITY_HOOK === "true";

/**
 * 새로 추가되는 텍스트에서 `as any` 사용 검사.
 * 단순 정규식: `as\s+any` 단어 경계 — TypeScript type assertion.
 * 예외: 주석 안의 'as any' 는 detection 어려우니 일단 차단 (호성님 의도: 최대한 지양).
 */
const AS_ANY_RE = /\bas\s+any\b/;

/** ecosystem.config.js 파일 경로 검사. */
const ECOSYSTEM_PATH_RE = /(^|\/)ecosystem\.config\.(js|ts|cjs|mjs)$/;

/**
 * Edit/Write 의 input 에서 새로 추가되는 텍스트 추출.
 *   Write:     content
 *   Edit:      new_string (old_string 제외)
 *   MultiEdit: edits[].new_string 합침
 */
function extractNewContent(toolName: string, input: unknown): { added: string; filePath?: string } {
  const inp = (input ?? {}) as Record<string, any>;
  const filePath: string | undefined = typeof inp.file_path === "string" ? inp.file_path : undefined;

  if (toolName === "Write") {
    return { added: typeof inp.content === "string" ? inp.content : "", filePath };
  }
  if (toolName === "Edit") {
    const oldStr = typeof inp.old_string === "string" ? inp.old_string : "";
    const newStr = typeof inp.new_string === "string" ? inp.new_string : "";
    // diff: new_string 에서 old_string 부분은 기존 코드라 제외 (단순화 — 완벽한 diff 아님)
    // 하지만 old_string 에 'as any' 가 이미 있고 new_string 에 그대로 있으면 새 추가 아님.
    if (oldStr.includes("as any") && AS_ANY_RE.test(newStr)) {
      // 기존에 이미 있고 그대로 → 새 추가 아님
      return { added: "", filePath };
    }
    return { added: newStr, filePath };
  }
  if (toolName === "MultiEdit") {
    const edits = Array.isArray(inp.edits) ? inp.edits : [];
    const allNew = edits
      .map((e: any) => {
        const oldStr = typeof e?.old_string === "string" ? e.old_string : "";
        const newStr = typeof e?.new_string === "string" ? e.new_string : "";
        if (oldStr.includes("as any") && AS_ANY_RE.test(newStr)) return ""; // 기존 보존
        return newStr;
      })
      .join("\n");
    return { added: allNew, filePath };
  }
  return { added: "", filePath };
}

export const codeQualityHook: HookCallback = async (input, _toolUseID, _opts) => {
  if (DISABLED) return {};
  if (input.hook_event_name !== "PreToolUse") return {};
  const pre = input as PreToolUseHookInput;
  const tool = pre.tool_name;
  if (tool !== "Edit" && tool !== "Write" && tool !== "MultiEdit") return {};

  const { added, filePath } = extractNewContent(tool, pre.tool_input);

  // ─── 1. ecosystem.config.js 수정 차단 ───
  if (filePath && ECOSYSTEM_PATH_RE.test(filePath)) {
    const reason =
      "lemon-front 절대 규칙: ecosystem.config.js 수정 금지 (2026-03-18 사고). " +
      "vite build --watch 설정. 변경 시 테스트 서버 장애 위험. " +
      "정말 필요하면 사용자에게 명시적 확인 요청.";
    console.warn(`[code-quality] BLOCK ecosystem ${filePath}`);
    incr("hook.code_quality.deny.ecosystem");
    const out: HookJSONOutput = {
      continue: true,
      decision: "block",
      reason,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
    return out;
  }

  // ─── 2. nginx lemon-test-3011 변경 차단 (proxy_pass 으로 location / 변경 시도) ───
  if (filePath && /\/nginx\/.*(lemon-test-3011|3011)/.test(filePath) && /location\s*\/\s*\{[\s\S]*proxy_pass/.test(added)) {
    const reason =
      "절대 규칙: nginx lemon-test-3011 의 'location /' 는 정적 빌드 서빙 (root build/; try_files). " +
      "proxy_pass 로 변경 금지. 변경 시 테스트 서버 장애.";
    console.warn(`[code-quality] BLOCK nginx-3011 ${filePath}`);
    incr("hook.code_quality.deny.nginx");
    const out: HookJSONOutput = {
      continue: true,
      decision: "block",
      reason,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
    return out;
  }

  // ─── 3. `as any` 새 추가 차단 (호성님 절대 규칙 — 타입 안전) ───
  // .ts/.tsx 파일에만 적용. .test.ts 는 제외 (테스트 mock 에서 자주 필요).
  if (filePath && /\.(ts|tsx)$/.test(filePath) && !/\.(test|spec)\.tsx?$/.test(filePath)) {
    if (AS_ANY_RE.test(added)) {
      const reason =
        "호성님 절대 규칙: TypeScript 'as any' 사용 지양. " +
        "정확한 타입을 작성하세요 (예: `as unknown as SpecificType`, 인터페이스 정의, generic 사용). " +
        "꼭 필요한 경우(외부 라이브러리 타입 부재 등) 사용자에게 사유 명시 후 진행.";
      console.warn(`[code-quality] BLOCK as-any in ${filePath}`);
      incr("hook.code_quality.deny.as_any");
      const out: HookJSONOutput = {
        continue: true,
        decision: "block",
        reason,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      };
      return out;
    }
  }

  return {};
};
