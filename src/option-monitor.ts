import { getCandles } from "./stock";

const KODEX200 = "069500"; // KOSPI200 대리 ETF

// ── KST helpers ───────────────────────────────────────────────────────────────

function nowKST(): Date {
  return new Date(Date.now() + 9 * 3600_000);
}

function todayKST(): string {
  return nowKST().toISOString().slice(0, 10);
}

function candleDateKST(ts: string): string {
  return new Date(new Date(ts).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

// ── VKOSPI (Naver Finance Mobile API) ────────────────────────────────────────

type VKOSPIData = { current: number; changePct: number };
let vkospiCache: { data: VKOSPIData; fetchedAt: number } | null = null;

async function getVKOSPI(): Promise<VKOSPIData> {
  if (vkospiCache && Date.now() - vkospiCache.fetchedAt < 5 * 60_000) {
    return vkospiCache.data;
  }

  const res = await fetch("https://m.stock.naver.com/api/index/VKOSPI/basic", {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; bot)" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`VKOSPI API ${res.status}`);

  const d = await res.json() as any;
  const current = parseFloat(d.closePrice ?? d.currentPrice ?? "0");
  const changePct = parseFloat(d.fluctuationsRatio ?? "0");

  const result: VKOSPIData = { current, changePct };
  vkospiCache = { data: result, fetchedAt: Date.now() };
  return result;
}

// ── KOSPI200 장중 변동성 (Toss API → KODEX 200) ───────────────────────────────

type VolatilityData = {
  changePct: number;      // 전일 대비 등락률
  highLowRangePct: number; // 당일 고저 범위
  recentSwingPct: number;  // 최근 30분 변화율
  reversalScore: number;   // 상하 반전 강도 (가두리 핵심 지표)
};

async function getKospi200Volatility(): Promise<VolatilityData> {
  const today = todayKST();
  const [candles1m, daily] = await Promise.all([
    getCandles(KODEX200, "1m", 450),
    getCandles(KODEX200, "1d", 5),
  ]);

  const todayCandles = candles1m
    .filter(c => candleDateKST(c.timestamp) === today)
    .reverse(); // 오래된 → 최신

  const prevClose = daily.find(c => candleDateKST(c.timestamp) < today)?.closePrice ?? 0;
  const current = todayCandles.at(-1)?.closePrice ?? 0;

  const changePct = prevClose > 0 ? (current - prevClose) / prevClose * 100 : 0;

  const highs = todayCandles.map(c => c.highPrice);
  const lows = todayCandles.map(c => c.lowPrice);
  const dayHigh = highs.length > 0 ? Math.max(...highs) : current;
  const dayLow = lows.length > 0 ? Math.min(...lows) : current;
  const highLowRangePct = dayLow > 0 ? (dayHigh - dayLow) / dayLow * 100 : 0;

  const recent30 = todayCandles.slice(-30);
  const recentStart = recent30[0]?.closePrice ?? current;
  const recentSwingPct = recentStart > 0 ? (current - recentStart) / recentStart * 100 : 0;

  // 반전 점수: 오전 고/저점 vs 오후 반전 여부
  // 오전(첫 절반) 최고가 → 오후 하락폭 or 오전 최저가 → 오후 반등폭
  let reversalScore = 0;
  if (todayCandles.length >= 60) {
    const mid = Math.floor(todayCandles.length / 2);
    const firstHalf = todayCandles.slice(0, mid);
    const secondHalf = todayCandles.slice(mid);

    const fhHigh = Math.max(...firstHalf.map(c => c.highPrice));
    const fhLow = Math.min(...firstHalf.map(c => c.lowPrice));
    const shHigh = Math.max(...secondHalf.map(c => c.highPrice));
    const shLow = Math.min(...secondHalf.map(c => c.lowPrice));

    // 오전 급등 후 오후 급락 패턴
    const dropAfterRise = fhHigh > 0 ? (fhHigh - shLow) / fhHigh * 100 : 0;
    // 오전 급락 후 오후 급등 패턴
    const riseAfterDrop = fhLow > 0 ? (shHigh - fhLow) / fhLow * 100 : 0;

    reversalScore = Math.max(dropAfterRise, riseAfterDrop);
  }

  return { changePct, highLowRangePct, recentSwingPct, reversalScore };
}

// ── 옵션 만기일 캘린더 ────────────────────────────────────────────────────────
// 위클리 KOSPI200: 매주 목요일
// 월물 KOSPI200: 매월 둘째 목요일 (2016년 이후)

type ExpiryInfo = {
  daysToWeekly: number;
  daysToMonthly: number;
  isWeeklyExpiry: boolean;
  isMonthlyExpiry: boolean;
  weeklyDate: string;
  monthlyDate: string;
};

function fmtDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function getThursdaysOfMonth(year: number, month: number): Date[] {
  const result: Date[] = [];
  const d = new Date(Date.UTC(year, month, 1));
  while (d.getUTCMonth() === month) {
    if (d.getUTCDay() === 4) result.push(new Date(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return result;
}

function getMonthlyExpiry(year: number, month: number): Date {
  return getThursdaysOfMonth(year, month)[1]!; // 둘째 목요일
}

function nextThursday(from: Date): Date {
  const d = new Date(from);
  const delta = (4 - d.getUTCDay() + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d;
}

function tradingDaysBetween(from: Date, to: Date): number {
  let count = 0;
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + 1);
  while (d <= to) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) count++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}

function getExpiryInfo(): ExpiryInfo {
  const kst = nowKST();
  const today = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()));

  // 위클리: 이번 주 목요일 (지났으면 다음 주)
  let weekly = nextThursday(new Date(today.getTime() - 86400_000));
  if (weekly < today) weekly = nextThursday(today);

  // 월물: 이달 둘째 목요일 (지났으면 다음 달)
  let monthly = getMonthlyExpiry(today.getUTCFullYear(), today.getUTCMonth());
  if (monthly < today) {
    const next = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
    monthly = getMonthlyExpiry(next.getUTCFullYear(), next.getUTCMonth());
  }

  return {
    daysToWeekly: tradingDaysBetween(today, weekly),
    daysToMonthly: tradingDaysBetween(today, monthly),
    isWeeklyExpiry: fmtDate(weekly) === fmtDate(today),
    isMonthlyExpiry: fmtDate(monthly) === fmtDate(today),
    weeklyDate: fmtDate(weekly),
    monthlyDate: fmtDate(monthly),
  };
}

// ── 가두리 감지 ───────────────────────────────────────────────────────────────

export type AlertLevel = "NORMAL" | "WATCH" | "CAUTION" | "DANGER" | "CRITICAL";

export type GaduriSignal = {
  level: AlertLevel;
  score: number;
  signals: string[];
  advice: string[];
  vkospi: number;
  vkospiChangePct: number;
  kospi200ChangePct: number;
  highLowRangePct: number;
  recentSwingPct: number;
  reversalScore: number;
  expiry: ExpiryInfo;
  timestamp: string;
  vkospiError?: string;
};

export async function detectGaduri(): Promise<GaduriSignal> {
  let vkospi: VKOSPIData = { current: 0, changePct: 0 };
  let vkospiError: string | undefined;

  try {
    vkospi = await getVKOSPI();
  } catch (e: any) {
    vkospiError = e.message;
  }

  const vol = await getKospi200Volatility();
  const expiry = getExpiryInfo();

  let score = 0;
  const signals: string[] = [];

  // VKOSPI 레벨
  if (vkospi.current >= 40) {
    score += 50;
    signals.push(`🚨 VKOSPI ${vkospi.current.toFixed(2)} — 시장 패닉 수준`);
  } else if (vkospi.current >= 30) {
    score += 35;
    signals.push(`🔴 VKOSPI ${vkospi.current.toFixed(2)} — 극도의 공포 구간`);
  } else if (vkospi.current >= 25) {
    score += 20;
    signals.push(`🟠 VKOSPI ${vkospi.current.toFixed(2)} — 고변동성 경보`);
  } else if (vkospi.current >= 20) {
    score += 10;
    signals.push(`🟡 VKOSPI ${vkospi.current.toFixed(2)} — 경계 구간`);
  } else if (vkospi.current > 0) {
    signals.push(`🟢 VKOSPI ${vkospi.current.toFixed(2)} — 정상`);
  }

  // VKOSPI 급변
  if (Math.abs(vkospi.changePct) >= 15) {
    score += 20;
    const dir = vkospi.changePct > 0 ? "급등" : "급락";
    signals.push(`💥 VKOSPI 전일비 ${vkospi.changePct >= 0 ? "+" : ""}${vkospi.changePct.toFixed(1)}% ${dir} — 변동성 폭발`);
  } else if (Math.abs(vkospi.changePct) >= 8) {
    score += 10;
    const dir = vkospi.changePct > 0 ? "상승" : "하락";
    signals.push(`⚡ VKOSPI 전일비 ${vkospi.changePct >= 0 ? "+" : ""}${vkospi.changePct.toFixed(1)}% ${dir}`);
  }

  // KOSPI200 고저 범위 (가두리 핵심)
  if (vol.highLowRangePct >= 3) {
    score += 30;
    signals.push(`📊 KOSPI200 당일 고저범위 ${vol.highLowRangePct.toFixed(2)}% — 극심한 롤러코스터`);
  } else if (vol.highLowRangePct >= 2) {
    score += 18;
    signals.push(`📊 KOSPI200 당일 고저범위 ${vol.highLowRangePct.toFixed(2)}% — 높은 변동성`);
  } else if (vol.highLowRangePct >= 1.5) {
    score += 8;
    signals.push(`📊 KOSPI200 당일 고저범위 ${vol.highLowRangePct.toFixed(2)}%`);
  }

  // 반전 패턴 (가두리의 핵심: 올렸다가 내리기)
  if (vol.reversalScore >= 3) {
    score += 20;
    signals.push(`🔄 상하 반전 패턴 감지 (반전강도 ${vol.reversalScore.toFixed(1)}%) — 가두리 가능성`);
  } else if (vol.reversalScore >= 1.5) {
    score += 8;
    signals.push(`🔄 부분 반전 패턴 (반전강도 ${vol.reversalScore.toFixed(1)}%)`);
  }

  // 최근 30분 급변
  if (Math.abs(vol.recentSwingPct) >= 1.5) {
    score += 12;
    const dir = vol.recentSwingPct > 0 ? "급등" : "급락";
    signals.push(`⚡ 최근 30분 KOSPI200 ${vol.recentSwingPct >= 0 ? "+" : ""}${vol.recentSwingPct.toFixed(2)}% ${dir}`);
  } else if (Math.abs(vol.recentSwingPct) >= 0.8) {
    score += 5;
    signals.push(`⚡ 최근 30분 KOSPI200 ${vol.recentSwingPct >= 0 ? "+" : ""}${vol.recentSwingPct.toFixed(2)}%`);
  }

  // 만기일 근접
  if (expiry.isMonthlyExpiry) {
    score += 25;
    signals.push(`⏰ 오늘 월물 옵션 만기일 — 외인 포지션 청산 피크`);
  } else if (expiry.isWeeklyExpiry) {
    score += 15;
    signals.push(`⏰ 오늘 위클리 옵션 만기일 — 변동성 최고조 구간`);
  } else if (expiry.daysToMonthly === 1) {
    score += 12;
    signals.push(`📅 내일 월물 만기 (${expiry.monthlyDate}) — 당일 변동성 확대 예고`);
  } else if (expiry.daysToWeekly === 1) {
    score += 8;
    signals.push(`📅 내일 위클리 만기 (${expiry.weeklyDate}) — 변동성 확대 예고`);
  } else if (expiry.daysToWeekly <= 2) {
    score += 3;
    signals.push(`📅 위클리 만기 ${expiry.daysToWeekly}거래일 전 (${expiry.weeklyDate})`);
  }

  // 레벨 결정
  let level: AlertLevel;
  if (score >= 70) level = "CRITICAL";
  else if (score >= 45) level = "DANGER";
  else if (score >= 25) level = "CAUTION";
  else if (score >= 10) level = "WATCH";
  else level = "NORMAL";

  // 대응 조언
  const advice: string[] = [];
  if (level === "CRITICAL") {
    advice.push("즉시 포지션 점검 — 추격 매수·매도 금지");
    advice.push("급등 = 외인 콜 정리 → 오히려 차익실현 타이밍");
    advice.push("급락 = 외인 풋 정리 → 투매 자제, 반등 대기");
    advice.push("만기 후 방향성 확인 전까지 신규 진입 자제");
  } else if (level === "DANGER") {
    advice.push("거래 비중 축소 권고 — 방향 예측 신뢰도 낮음");
    advice.push("손절선 미리 설정 후 포지션 유지 여부 판단");
  } else if (level === "CAUTION") {
    advice.push("변동성 확대 구간 — 단기 매매 주의");
    advice.push("만기일 전후 이상 급등락 출현 시 무대응이 정답일 수 있음");
  } else {
    advice.push("현재 변동성 정상 범위 — 일반 주의 수준 유지");
  }

  const kst = nowKST();
  const timestamp = `${kst.getUTCFullYear()}-${String(kst.getUTCMonth()+1).padStart(2,"0")}-${String(kst.getUTCDate()).padStart(2,"0")} ${String(kst.getUTCHours()).padStart(2,"0")}:${String(kst.getUTCMinutes()).padStart(2,"0")} KST`;

  return {
    level, score, signals, advice,
    vkospi: vkospi.current,
    vkospiChangePct: vkospi.changePct,
    kospi200ChangePct: vol.changePct,
    highLowRangePct: vol.highLowRangePct,
    recentSwingPct: vol.recentSwingPct,
    reversalScore: vol.reversalScore,
    expiry,
    timestamp,
    vkospiError,
  };
}

// ── 포맷 ──────────────────────────────────────────────────────────────────────

const LEVEL_EMOJI: Record<AlertLevel, string> = {
  NORMAL: "🟢",
  WATCH: "🟡",
  CAUTION: "🟠",
  DANGER: "🔴",
  CRITICAL: "🚨",
};

const LEVEL_KR: Record<AlertLevel, string> = {
  NORMAL: "정상",
  WATCH: "감시",
  CAUTION: "주의",
  DANGER: "위험",
  CRITICAL: "긴급경보",
};

export function formatGaduriReport(s: GaduriSignal): string {
  const { expiry } = s;
  const sign = (n: number) => n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
  const lines: string[] = [
    `${LEVEL_EMOJI[s.level]} <b>외인 가두리 감지기 — ${LEVEL_KR[s.level]}</b> (점수 ${s.score}/100+)`,
    `🕐 ${s.timestamp}`,
    ``,
    `<b>📊 핵심 지표</b>`,
    `  VKOSPI: <b>${s.vkospi > 0 ? s.vkospi.toFixed(2) : "조회실패"}</b>${s.vkospi > 0 ? ` (전일비 ${s.vkospiChangePct >= 0 ? "+" : ""}${s.vkospiChangePct.toFixed(1)}%)` : ` — ${s.vkospiError ?? "오류"}`}`,
    `  KOSPI200: 전일비 <b>${sign(s.kospi200ChangePct)}%</b>`,
    `  당일 고저범위: <b>${s.highLowRangePct.toFixed(2)}%</b>`,
    `  최근 30분: <b>${sign(s.recentSwingPct)}%</b>`,
    `  반전강도: <b>${s.reversalScore.toFixed(1)}%</b>`,
    ``,
    `<b>📅 옵션 만기</b>`,
    `  위클리: ${expiry.weeklyDate}${expiry.isWeeklyExpiry ? " ⚠️ <b>오늘!</b>" : ` (${expiry.daysToWeekly}거래일 후)`}`,
    `  월물: ${expiry.monthlyDate}${expiry.isMonthlyExpiry ? " ⚠️ <b>오늘!</b>" : ` (${expiry.daysToMonthly}거래일 후)`}`,
  ];

  if (s.signals.length > 0) {
    lines.push(``, `<b>🔍 감지 신호</b>`);
    for (const sig of s.signals) lines.push(`  ${sig}`);
  }

  if (s.advice.length > 0) {
    lines.push(``, `<b>💡 대응 조언</b>`);
    for (const a of s.advice) lines.push(`  · ${a}`);
  }

  lines.push(``, `<i>VKOSPI 20↑경계 25↑고위험 30↑극도공포 | 고저범위 1.5%↑주의 2%↑위험</i>`);

  return lines.join("\n");
}

// ── 자동 모니터 루프 ─────────────────────────────────────────────────────────

let monitorTimer: ReturnType<typeof setInterval> | null = null;
let monitorChatId = "";
let monitorSend: ((chatId: string, text: string) => Promise<void>) | null = null;
let lastAlertLevel: AlertLevel = "NORMAL";
let lastAlertTime = 0;

const INTERVAL_MS = parseInt(process.env.OPTION_MONITOR_INTERVAL_MS ?? "300000"); // 기본 5분
const ALERT_COOLDOWN_MS = 4 * 3600_000; // 같은 레벨 재알림 쿨다운 4시간

const LEVELS: AlertLevel[] = ["NORMAL", "WATCH", "CAUTION", "DANGER", "CRITICAL"];

function isMarketHours(): boolean {
  const kst = nowKST();
  const day = kst.getUTCDay();
  if (day === 0 || day === 6) return false;
  const min = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return min >= 9 * 60 && min < 15 * 60 + 35;
}

async function monitorTick(): Promise<void> {
  if (!isMarketHours()) return;

  try {
    const signal = await detectGaduri();

    const cur = LEVELS.indexOf(signal.level);
    const last = LEVELS.indexOf(lastAlertLevel);
    const cooldown = Date.now() - lastAlertTime > ALERT_COOLDOWN_MS;

    const shouldAlert =
      (cur > last && signal.level !== "NORMAL") ||
      (cooldown && cur >= LEVELS.indexOf("CAUTION" as AlertLevel));

    if (shouldAlert && monitorSend && monitorChatId) {
      await monitorSend(monitorChatId, formatGaduriReport(signal));
      lastAlertLevel = signal.level;
      lastAlertTime = Date.now();
    }

    if (cur < last) lastAlertLevel = signal.level;
  } catch (e: any) {
    console.error(`[OptionMonitor] tick 오류: ${e.message}`);
  }
}

export function startOptionMonitor(
  chatId: string,
  sendFn: (chatId: string, text: string) => Promise<void>,
): void {
  if (monitorTimer) return;
  monitorChatId = chatId;
  monitorSend = sendFn;
  console.log(`[OptionMonitor] 시작 — 체크 주기 ${INTERVAL_MS / 60000}분`);
  monitorTick().catch(e => console.error(`[OptionMonitor] 초기 체크 실패: ${e.message}`));
  monitorTimer = setInterval(
    () => monitorTick().catch(e => console.error(`[OptionMonitor] 오류: ${e.message}`)),
    INTERVAL_MS,
  );
}

export function stopOptionMonitor(): void {
  if (!monitorTimer) return;
  clearInterval(monitorTimer);
  monitorTimer = null;
  console.log("[OptionMonitor] 중지");
}

export function isOptionMonitorRunning(): boolean {
  return monitorTimer !== null;
}
