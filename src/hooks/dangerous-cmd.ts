/**
 * Dangerous Command Guard — PreToolUse hook
 *
 * Bash 도구 호출에서 위험 패턴을 차단한다.
 * 차단 사유는 모델에게 reason으로 돌려줘서 다른 접근을 유도.
 *
 * 차단 대상 (예시):
 *  - `rm -rf /` (filesystem 전체 삭제 시도)
 *  - `git push --force` to main/master
 *  - `git reset --hard origin/...` (커밋되지 않은 작업 파괴)
 *  - `git clean -fd` (추적되지 않은 파일 일괄 삭제)
 *  - `kill -9 1` (init 죽이기)
 *  - `:(){ :|:& };:` (fork bomb)
 *
 * 비활성화: env DISABLE_DANGEROUS_CMD_HOOK=true
 */

import type {
  HookCallback,
  PreToolUseHookInput,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";

const DISABLED = process.env.DISABLE_DANGEROUS_CMD_HOOK === "true";

interface Pattern {
  name: string;
  re: RegExp;
  reason: string;
}

const PATTERNS: Pattern[] = [
  {
    name: "rm-rf-root",
    re: /\brm\s+(-[rRfF]+\s+|--recursive\s+|--force\s+)*\/(\s|$)/,
    reason: "rm -rf /  : 시스템 전체 삭제 시도. 절대 차단됨.",
  },
  {
    name: "rm-rf-home",
    re: /\brm\s+-[rRfF]+\s+(~|\$HOME|\/home\/[^\s]+)(\s|$)/,
    reason: "rm -rf ~ : 홈 디렉토리 전체 삭제 시도. 차단됨.",
  },
  {
    name: "git-force-push-main",
    re: /\bgit\s+push\s+(.*\s+)?(--force|-f)\b.*\b(main|master|production|prod)\b/,
    reason: "git push --force to main/master: 공유 히스토리 파괴. 차단됨.",
  },
  {
    name: "git-reset-hard-origin",
    re: /\bgit\s+reset\s+--hard\s+origin\/[^\s]+/,
    reason: "git reset --hard origin/*: 커밋되지 않은 로컬 작업 파괴 가능. 차단됨. 사용자 명시 요청 시에만 허용.",
  },
  {
    name: "git-clean-force",
    re: /\bgit\s+clean\s+(-[a-zA-Z]*[fd]+|--force|--directories)\b/,
    reason: "git clean -fd: 추적되지 않은 파일/디렉토리 일괄 삭제. 차단됨.",
  },
  {
    name: "kill-init",
    re: /\bkill\s+-9?\s+1\b/,
    reason: "kill 1 (init): 시스템 다운 위험. 차단됨.",
  },
  {
    name: "forkbomb",
    re: /:\(\)\{\s*:\|:&\s*\}\s*;?\s*:/,
    reason: "fork bomb 패턴: 시스템 마비 위험. 차단됨.",
  },
  {
    name: "no-verify-flag",
    re: /\bgit\s+commit\b.*--no-verify/,
    reason: "git commit --no-verify: hook 우회. 사용자 명시 요청이 없으면 차단.",
  },
  {
    name: "dd-of-disk",
    re: /\bdd\s+.*\bof=\/dev\/(sd[a-z]|nvme\d|disk\d)/,
    reason: "dd of=/dev/sd*: 디스크 직접 쓰기. 차단됨.",
  },
];

function extractCommand(input: unknown): string {
  try {
    const inp = (input ?? {}) as Record<string, any>;
    if (typeof inp.command === "string") return inp.command;
    return "";
  } catch {
    return "";
  }
}

export const dangerousCmdHook: HookCallback = async (input, _toolUseID, _opts) => {
  if (DISABLED) return {};
  if (input.hook_event_name !== "PreToolUse") return {};
  const pre = input as PreToolUseHookInput;
  if (pre.tool_name !== "Bash") return {};

  const cmd = extractCommand(pre.tool_input);
  if (!cmd) return {};

  for (const pat of PATTERNS) {
    if (pat.re.test(cmd)) {
      console.warn(
        `[dangerous-cmd] BLOCK pattern=${pat.name} cmd=${cmd.slice(0, 200)}`
      );
      const out: HookJSONOutput = {
        continue: true,
        decision: "block",
        reason: pat.reason,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: pat.reason,
        },
      };
      return out;
    }
  }
  return {};
};
