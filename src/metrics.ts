/**
 * Metrics — Ralph Loop / Hook 운영 메트릭 수집
 *
 * 14대 자율 워커가 종일 도는 환경에서 "어떤 봇이 loop에 빠지나",
 * "evaluator 비용이 얼마나 나가나", "loop-detector가 차단한 횟수"
 * 같은 운영 질문에 즉답하기 위한 가벼운 카운터.
 *
 * 설계:
 *  - in-memory counter Map (chatId 단위 + global 단위)
 *  - 5분마다 .lemonclaw/metrics-{botName}.json 으로 atomic write
 *  - 24시간 단위 일일 요약 (롤링 윈도우)
 *  - 외부 의존성 없음 (DB/Prometheus 등)
 *
 * 키 네이밍 (표준화):
 *  ralph.iteration.start
 *  ralph.iteration.end
 *  ralph.item.passed
 *  ralph.item.failed
 *  ratchet.pass
 *  ratchet.fail
 *  evaluator.complete
 *  evaluator.incomplete
 *  evaluator.parse_failed
 *  hook.loop_detector.deny
 *  hook.dangerous_cmd.deny
 *  engine.max_turns_hit
 *  engine.cost_usd_milli  (1/1000 USD 단위 정수, 누적)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { dirname, join } from "path";

const BOT_NAME = process.env.BOT_NAME || process.env.HOSTNAME || "unknown";
const METRICS_DIR = join(import.meta.dir, "..", ".lemonclaw");
const METRICS_FILE = join(METRICS_DIR, `metrics-${BOT_NAME}.json`);
const FLUSH_INTERVAL_MS = parseInt(process.env.METRICS_FLUSH_INTERVAL_MS || "300000"); // 5분
const RETENTION_MS = 24 * 3600 * 1000;

interface CounterEntry {
  count: number;
  lastAt: number;
}

interface BucketEntry {
  ts: number;
  key: string;
  delta: number;
}

interface MetricsState {
  botName: string;
  totals: Record<string, CounterEntry>;
  recent: BucketEntry[]; // 24h rolling, 시간순
  startedAt: number;
}

let state: MetricsState = loadOrInit();
let dirty = false;

function loadOrInit(): MetricsState {
  if (existsSync(METRICS_FILE)) {
    try {
      const data = JSON.parse(readFileSync(METRICS_FILE, "utf-8"));
      if (data && typeof data === "object" && data.totals) {
        // 24h 지난 recent 정리
        const now = Date.now();
        data.recent = (data.recent || []).filter((b: BucketEntry) => now - b.ts < RETENTION_MS);
        return data as MetricsState;
      }
    } catch {
      // 손상된 파일은 무시하고 새로 시작
    }
  }
  return { botName: BOT_NAME, totals: {}, recent: [], startedAt: Date.now() };
}

function ensureDir(): void {
  try {
    if (!existsSync(dirname(METRICS_FILE))) mkdirSync(dirname(METRICS_FILE), { recursive: true });
  } catch {}
}

function flushNow(): void {
  if (!dirty) return;
  ensureDir();
  try {
    const tmp = METRICS_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, METRICS_FILE);
    dirty = false;
  } catch (e: any) {
    console.error(`[metrics] flush failed: ${e.message}`);
  }
}

setInterval(() => {
  // 24h 윈도우 정리
  const now = Date.now();
  const before = state.recent.length;
  state.recent = state.recent.filter((b) => now - b.ts < RETENTION_MS);
  if (before !== state.recent.length) dirty = true;
  flushNow();
}, FLUSH_INTERVAL_MS).unref?.();

process.on("SIGTERM", () => flushNow());
process.on("SIGINT", () => flushNow());

/**
 * 카운터 증가. delta 기본 1.
 */
export function incr(key: string, delta = 1): void {
  const now = Date.now();
  const cur = state.totals[key] ?? { count: 0, lastAt: 0 };
  cur.count += delta;
  cur.lastAt = now;
  state.totals[key] = cur;
  state.recent.push({ ts: now, key, delta });
  // 너무 길어지지 않도록 cap (24h × 평균 호출이라도 만 단위면 충분)
  if (state.recent.length > 50_000) {
    state.recent = state.recent.slice(-30_000);
  }
  dirty = true;
}

/**
 * 비용을 누적 (USD). 내부적으론 1/1000 USD 정수 키로 보관.
 */
export function addCostUsd(usd: number): void {
  const milli = Math.round(usd * 1000);
  if (milli !== 0) incr("engine.cost_usd_milli", milli);
}

/**
 * 누적 카운터 전체 조회.
 */
export function getTotals(): Record<string, CounterEntry> {
  return { ...state.totals };
}

/**
 * 마지막 N시간 카운트.
 */
export function getRecentCount(key: string, hours = 1): number {
  const since = Date.now() - hours * 3600 * 1000;
  return state.recent
    .filter((b) => b.ts >= since && b.key === key)
    .reduce((sum, b) => sum + b.delta, 0);
}

/**
 * 일일 요약 텍스트 (Telegram 메시지 한 개에 적합).
 */
export function formatDailySummary(): string {
  const totals = state.totals;
  const lines: string[] = [
    `📊 [${BOT_NAME}] Ralph/Engine Metrics — 24h`,
    "",
  ];

  const groups: Array<{ title: string; keys: string[] }> = [
    { title: "Ralph Loop", keys: ["ralph.iteration.start", "ralph.iteration.end", "ralph.item.passed", "ralph.item.failed"] },
    { title: "Test Ratchet", keys: ["ratchet.pass", "ratchet.fail"] },
    { title: "Evaluator", keys: ["evaluator.complete", "evaluator.incomplete", "evaluator.parse_failed"] },
    { title: "Hooks (차단)", keys: ["hook.loop_detector.deny", "hook.dangerous_cmd.deny"] },
    { title: "Engine", keys: ["engine.max_turns_hit"] },
  ];

  for (const g of groups) {
    const parts = g.keys.map((k) => {
      const total = totals[k]?.count ?? 0;
      const last24h = getRecentCount(k, 24);
      return `  ${k.split(".").pop()}: ${last24h} (24h) / ${total} (total)`;
    });
    lines.push(`▸ ${g.title}`);
    lines.push(...parts);
  }

  // 비용 (milli → USD 두 자리)
  const milli24h = getRecentCount("engine.cost_usd_milli", 24);
  const milliTotal = state.totals["engine.cost_usd_milli"]?.count ?? 0;
  lines.push(`▸ Cost (Light + Evaluator)`);
  lines.push(`  $${(milli24h / 1000).toFixed(3)} (24h) / $${(milliTotal / 1000).toFixed(3)} (total)`);

  return lines.join("\n");
}

/**
 * 짧은 한 줄 (LemonClaw memory append 등에 사용).
 */
export function formatOneLineSummary(): string {
  const t = state.totals;
  const passed = t["ralph.item.passed"]?.count ?? 0;
  const failed = t["ralph.item.failed"]?.count ?? 0;
  const denyLoop = t["hook.loop_detector.deny"]?.count ?? 0;
  const denyCmd = t["hook.dangerous_cmd.deny"]?.count ?? 0;
  const milli = t["engine.cost_usd_milli"]?.count ?? 0;
  return `passed=${passed} failed=${failed} deny(loop=${denyLoop},cmd=${denyCmd}) cost=$${(milli / 1000).toFixed(3)}`;
}

/**
 * 강제 flush (테스트/긴급 종료).
 */
export function flush(): void {
  flushNow();
}
