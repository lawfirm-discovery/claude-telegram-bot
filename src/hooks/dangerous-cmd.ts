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
import { incr } from "../metrics";

const DISABLED = process.env.DISABLE_DANGEROUS_CMD_HOOK === "true";

interface Pattern {
  name: string;
  re: RegExp;
  reason: string;
  /**
   * Phase R3.1 — 특정 봇에서는 차단 안 함.
   * 예: flutter build 는 rtx6000 만 허용 → 다른 봇은 차단, rtx6000 은 통과.
   */
  skipIfBot?: string[];
}

const BOT_NAME = process.env.BOT_NAME || process.env.HOSTNAME || "unknown";

const PATTERNS: Pattern[] = [
  {
    name: "rm-rf-root",
    re: /\brm\s+(-[rRfF]+\s+|--recursive\s+|--force\s+)*\/(\s|$)/,
    reason: "rm -rf /  : 시스템 전체 삭제 시도. 절대 차단됨.",
  },
  {
    name: "rm-rf-home",
    re: /\brm\s+-[rRfF]+\s+(~|\$HOME|\/home\/[^\s]+)(\/[^\s]*)?(\s|$)/,
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

  // ═══════════════════════════════════════════════════════════════
  // Phase R3.1 — 호성님 CLAUDE.md 절대 규칙 (리걸몬스터 프로젝트)
  // ═══════════════════════════════════════════════════════════════

  {
    name: "lemon-craco-build",
    re: /\b(craco\s+build|npm\s+run\s+build|npx\s+craco|npx\s+vite\s+build)\b/,
    reason: "lemon-front 절대 규칙: Vite로 마이그레이션됨. craco/CRA 빌드는 CPU 200%+ 점유로 서버 장애 유발. 빌드는 rtx6000의 lemon-front-build watch 가 자동. 검증만 필요하면 'npx tsc --noEmit'.",
  },
  {
    name: "lemon-vite-dev",
    re: /\b(vite\s+dev|vite\s*$|npm\s+run\s+vite:dev)\b/,
    reason: "lemon-front 절대 규칙: vite dev server 사용 금지 (페이지 로딩 수분 소요). 'vite build --watch' 방식 사용.",
  },
  {
    name: "lemon-gradle-build",
    re: /\.\/gradlew\s+(build|bootJar|jar)\b/,
    reason: "Spring 절대 규칙: bootJar/build 금지. './gradlew bootRun' 사용. 또는 'sudo systemctl restart lemon-spring-api'.",
  },
  {
    name: "lemon-ddl-update",
    re: /\bddl-auto\s*[:=]\s*['"]?(update|create|create-drop|none)\b/i,
    reason: "Spring 절대 규칙: ddl-auto 는 반드시 'validate'. update/create 등은 운영 DB 손상 위험.",
  },
  {
    name: "lemon-port-3000",
    re: /(?:port\s*[:=]\s*3000|:3000\b|--port[\s=]+3000|listen\s+3000)/,
    reason: "절대 규칙: 포트 3000 사용 금지 (Docker open-webui 점유 중). Frontend 는 nginx 3011, dev server 미사용.",
  },
  {
    // 'git checkout <other-branch>' 차단. 단:
    //   - 'git checkout dev-hs-rtx6000-new' (또는 -b 로 같은 이름) 통과
    //   - 'git checkout -- <file>' (파일 복원) 통과
    //   - 'git checkout HEAD~1 -- <file>' 같은 복원 통과
    name: "lemon-branch-checkout",
    re: /\bgit\s+checkout\s+(?!--\s|dev-hs-rtx6000-new\b|-b\s+dev-hs-rtx6000-new\b|HEAD\b)/,
    reason: "절대 규칙: 모든 레포는 'dev-hs-rtx6000-new' 브랜치만. 다른 브랜치 checkout 금지. 파일 복원은 'git checkout -- <file>' 형태로.",
  },
  {
    // Bash 로 ecosystem.config.js 수정 시도 차단 (sed/cat). Edit/Write tool 은 별도 hook 에서.
    name: "lemon-ecosystem-config",
    re: /(?:sed\s+-i|cat\s+>\s*|>>|tee\s+).*\becosystem\.config\.js\b/,
    reason: "lemon-front 절대 규칙: ecosystem.config.js 수정 금지 (2026-03-18 사고). vite build --watch 설정. 변경 시 테스트 서버 장애.",
  },
  {
    // flutter build web 은 rtx6000 만 허용. BOT_NAME 으로 동적 검사.
    // BOT_NAME 이 'rtx6000' 또는 'lead' 면 통과, 다른 봇이면 차단.
    name: "lemon-flutter-build-non-rtx6000",
    re: /\bflutter\s+build\s+web\b/,
    reason: "Flutter 절대 규칙: 'flutter build web' 은 rtx6000 만 실행. 다른 봇은 코드 push 만, 빌드는 rtx6000 의 auto-pull 이 처리.",
    // 동적 검사 — BOT_NAME 이 rtx6000 이면 false positive 아님
    skipIfBot: ["rtx6000", "lead", "rtx6000-pylon"],
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
      // Phase R3.1 — skipIfBot 체크: 특정 봇에서는 통과
      if (pat.skipIfBot && pat.skipIfBot.some((b) => BOT_NAME.toLowerCase().includes(b.toLowerCase()))) {
        continue;
      }
      console.warn(
        `[dangerous-cmd] BLOCK pattern=${pat.name} cmd=${cmd.slice(0, 200)}`
      );
      incr("hook.dangerous_cmd.deny");
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
