/**
 * Loop Detector — PreToolUse hook
 *
 * 같은 도구를 같은 인자로 연속 N회 호출하면 차단한다.
 * 자율 에이전트가 동일 실패를 반복하며 토큰을 소진하는 것을 막기 위함.
 *
 * 특징:
 *  - chatId(또는 session_id) 기준으로 최근 호출 N개를 보관
 *  - 직전 N개가 모두 동일 (toolName, normalizedInput) 이면 'deny'
 *  - normalizedInput: command/file_path 등 핵심 키만 안정적으로 직렬화
 */

import type {
  HookCallback,
  PreToolUseHookInput,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";

const HISTORY = new Map<string, { tool: string; sig: string; ts: number }[]>();
const MAX_HISTORY = 6;
const REPEAT_THRESHOLD = parseInt(process.env.LOOP_DETECTOR_THRESHOLD || "3");

function normalizeInput(toolName: string, input: unknown): string {
  try {
    const inp = (input ?? {}) as Record<string, any>;
    // 공통 필드만 뽑아 안정 직렬화 (전체 stringify는 timestamp 등으로 노이즈)
    const keys = ["command", "file_path", "pattern", "path", "url", "query"];
    const picked: Record<string, any> = {};
    for (const k of keys) if (k in inp) picked[k] = inp[k];
    if (Object.keys(picked).length === 0) {
      return JSON.stringify(inp).slice(0, 300);
    }
    return JSON.stringify(picked);
  } catch {
    return String(input).slice(0, 300);
  }
}

export function makeLoopDetectorHook(chatId: string): HookCallback {
  return async (input, _toolUseID, _opts) => {
    if (input.hook_event_name !== "PreToolUse") {
      return {};
    }
    const pre = input as PreToolUseHookInput;
    const sig = normalizeInput(pre.tool_name, pre.tool_input);
    const key = chatId;

    const hist = HISTORY.get(key) ?? [];
    hist.push({ tool: pre.tool_name, sig, ts: Date.now() });
    if (hist.length > MAX_HISTORY) hist.shift();
    HISTORY.set(key, hist);

    if (hist.length >= REPEAT_THRESHOLD) {
      const last = hist.slice(-REPEAT_THRESHOLD);
      const first = last[0];
      const allSame = first !== undefined && last.every(
        (h) => h.tool === first.tool && h.sig === first.sig
      );
      if (allSame && first) {
        const reason =
          `[loop-detector] ${pre.tool_name}이(가) 동일 인자로 ${REPEAT_THRESHOLD}회 연속 호출됨. ` +
          `다른 접근을 시도하거나 작업을 중단하세요. sig=${first.sig.slice(0, 120)}`;
        console.warn(`[loop-detector] BLOCK chat=${chatId} ${reason}`);
        // 히스토리 리셋 (한 번 차단 후 같은 차단을 즉시 또 발동시키지 않기 위해)
        HISTORY.set(key, []);
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
}

export function clearLoopHistory(chatId: string): void {
  HISTORY.delete(chatId);
}
