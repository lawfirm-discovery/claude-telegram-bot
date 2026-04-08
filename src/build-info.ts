/**
 * 빌드 정보 수집 — 프로세스 시작 시 1회 캐싱
 * 리걸몬스터 DevBuildInfo와 동일한 데이터 구조
 */
import { $ } from "bun";

interface CommitInfo {
  hash: string;
  message: string;
  date: string;
}

interface BuildInfo {
  buildTime: string;
  recentCommits: CommitInfo[];
}

let cached: BuildInfo | null = null;

/** 프로세스 시작 시 1회 호출 — git log에서 최근 8커밋 수집 */
export async function initBuildInfo(): Promise<void> {
  const buildTime = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  const commits: CommitInfo[] = [];
  try {
    const raw = await $`git log -8 --pretty=format:%h||%s||%ci`.text();
    for (const line of raw.trim().split("\n")) {
      const parts = line.split("||", 3);
      if (parts.length === 3) {
        commits.push({ hash: parts[0]!, message: parts[1]!, date: parts[2]! });
      }
    }
  } catch { /* git 없는 환경에서도 안전 */ }
  cached = { buildTime, recentCommits: commits };
}

/** HUD에 합칠 빌드 정보 텍스트 반환 */
export function formatBuildInfo(): string {
  if (!cached) return "";
  const lines: string[] = [];
  lines.push(`📦 Build: ${cached.buildTime}`);
  if (cached.recentCommits.length > 0) {
    lines.push("📋 Recent commits:");
    for (const c of cached.recentCommits) {
      // 메시지 40자 제한 (텔레그램 가독성)
      const msg = c.message.length > 40 ? c.message.slice(0, 37) + "..." : c.message;
      lines.push(`  ${c.hash} ${msg}`);
    }
  }
  return lines.join("\n");
}
