import type { Candle } from "./stock";

// ── 주도주 목록 (KOSPI + US) ────────────────────────────────────────────────

export const LEADING_STOCKS: { symbol: string; name: string; market: "KR" | "US" }[] = [
  // KOSPI
  { symbol: "005930", name: "삼성전자", market: "KR" },
  { symbol: "000660", name: "SK하이닉스", market: "KR" },
  { symbol: "005380", name: "현대차", market: "KR" },
  { symbol: "373220", name: "LG에너지솔루션", market: "KR" },
  { symbol: "006400", name: "삼성SDI", market: "KR" },
  { symbol: "035420", name: "NAVER", market: "KR" },
  { symbol: "035720", name: "카카오", market: "KR" },
  { symbol: "051910", name: "LG화학", market: "KR" },
  { symbol: "105560", name: "KB금융", market: "KR" },
  { symbol: "012450", name: "한화에어로스페이스", market: "KR" },
  { symbol: "047810", name: "한국항공우주", market: "KR" },
  { symbol: "003670", name: "포스코퓨처엠", market: "KR" },
  // US
  { symbol: "AAPL", name: "Apple", market: "US" },
  { symbol: "MSFT", name: "Microsoft", market: "US" },
  { symbol: "NVDA", name: "NVIDIA", market: "US" },
  { symbol: "TSLA", name: "Tesla", market: "US" },
  { symbol: "AMZN", name: "Amazon", market: "US" },
  { symbol: "GOOGL", name: "Google", market: "US" },
  { symbol: "META", name: "Meta", market: "US" },
  { symbol: "AVGO", name: "Broadcom", market: "US" },
  { symbol: "AMD", name: "AMD", market: "US" },
  { symbol: "PLTR", name: "Palantir", market: "US" },
];

// ── Types ───────────────────────────────────────────────────────────────────

export type SellSignalType = "trap" | "collapse" | "upper_shadow_trap";

export interface SellSignal {
  type: SellSignalType;
  symbol: string;
  name: string;
  market: "KR" | "US";
  weekDate: string;
  close: number;
  open: number;
  high: number;
  low: number;
  resistance?: number;
  slopeRatio?: number;
  reason: string;
}

// ── 일봉 → 주봉 집계 ───────────────────────────────────────────────────────

export function aggregateToWeekly(dailyCandles: Candle[]): Candle[] {
  if (dailyCandles.length === 0) return [];

  const sorted = [...dailyCandles].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const weeks = new Map<string, Candle>();

  for (const c of sorted) {
    const d = new Date(c.timestamp);
    const day = d.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() + mondayOffset);
    const weekKey = monday.toISOString().slice(0, 10);

    const existing = weeks.get(weekKey);
    if (!existing) {
      weeks.set(weekKey, {
        timestamp: weekKey,
        openPrice: c.openPrice,
        highPrice: c.highPrice,
        lowPrice: c.lowPrice,
        closePrice: c.closePrice,
        volume: c.volume,
      });
    } else {
      existing.highPrice = Math.max(existing.highPrice, c.highPrice);
      existing.lowPrice = Math.min(existing.lowPrice, c.lowPrice);
      existing.closePrice = c.closePrice;
      existing.volume += c.volume;
    }
  }

  return [...weeks.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// ── 매도 신호 감지 (주봉 기반 — 하승훈 대표 매도 규칙) ─────────────────────

export function detectSellSignals(
  symbol: string,
  name: string,
  market: "KR" | "US",
  weeklyCandles: Candle[],
  config: { lookbackPeriod?: number; accelerationThreshold?: number } = {},
): SellSignal[] {
  const lookback = config.lookbackPeriod ?? 20;
  const accelThreshold = config.accelerationThreshold ?? 2.5;
  const signals: SellSignal[] = [];

  if (weeklyCandles.length < Math.max(lookback + 1, 21)) return signals;

  const i = weeklyCandles.length - 1;
  const curr = weeklyCandles[i]!;

  const getResistance = (idx: number): number => {
    const start = Math.max(0, idx - lookback);
    const highs = weeklyCandles.slice(start, idx).map((c) => c.highPrice);
    return highs.length > 0 ? Math.max(...highs) : 0;
  };

  const rollingResistance = getResistance(i);

  // 최근 3봉 내 저항선 돌파 이력 확인
  const recentBreakout = [1, 2, 3].some((offset) => {
    const idx = i - offset;
    if (idx < lookback) return false;
    const resist = getResistance(idx);
    return resist > 0 && weeklyCandles[idx]!.highPrice > resist;
  });

  // ── 1. 트랩 패턴: 신고가 돌파 → 저항선 아래 회귀 + 음봉 ──
  if (
    recentBreakout &&
    rollingResistance > 0 &&
    curr.closePrice < rollingResistance &&
    curr.closePrice < curr.openPrice
  ) {
    signals.push({
      type: "trap",
      symbol, name, market,
      weekDate: curr.timestamp.slice(0, 10),
      close: curr.closePrice, open: curr.openPrice,
      high: curr.highPrice, low: curr.lowPrice,
      resistance: rollingResistance,
      reason:
        `신고가 돌파 후 저항선(${fp(rollingResistance, market)}) 아래로 회귀하는 트랩 패턴. ` +
        `세력의 유동성 유도 후 물량 분배 완료 징후. ` +
        `종가(${fp(curr.closePrice, market)})가 저항선 아래에서 음봉 마감.`,
    });
  }

  // ── 2. 가속 추세 붕괴: 파라볼릭 기울기 + 고점경신 음봉 + 직전 양봉 저가 이탈 ──
  if (i >= 1) {
    const prev = weeklyCandles[i - 1]!;

    const slopeShort = i >= 6
      ? (prev.closePrice - weeklyCandles[i - 6]!.closePrice) / 5
      : 0;
    const slopeLong = i >= 21
      ? (prev.closePrice - weeklyCandles[i - 21]!.closePrice) / 20
      : 0;
    const slopeRatio = slopeLong > 0 ? slopeShort / slopeLong : 0;

    if (
      slopeRatio > accelThreshold &&
      curr.highPrice > prev.highPrice &&
      prev.closePrice > prev.openPrice &&
      curr.closePrice < prev.lowPrice
    ) {
      signals.push({
        type: "collapse",
        symbol, name, market,
        weekDate: curr.timestamp.slice(0, 10),
        close: curr.closePrice, open: curr.openPrice,
        high: curr.highPrice, low: curr.lowPrice,
        slopeRatio,
        reason:
          `가속 상승(기울기 비율 ${slopeRatio.toFixed(1)}x) 후 고점 경신형 하락장악 음봉. ` +
          `직전 양봉 저가(${fp(prev.lowPrice, market)})를 종가(${fp(curr.closePrice, market)})가 완전 이탈. ` +
          `포물선형 급등의 에너지 고갈 — 세력 탈출 신호.`,
      });
    }
  }

  // ── 3. 윗꼬리 트랩: 돌파 구간에서 긴 윗꼬리 음봉 ──
  const candleBody = Math.abs(curr.closePrice - curr.openPrice);
  const upperShadow =
    curr.closePrice >= curr.openPrice
      ? curr.highPrice - curr.closePrice
      : curr.highPrice - curr.openPrice;
  const isLongUpperShadow =
    candleBody > 0 && upperShadow > candleBody * 1.5 && curr.closePrice < curr.openPrice;

  if (recentBreakout && isLongUpperShadow) {
    signals.push({
      type: "upper_shadow_trap",
      symbol, name, market,
      weekDate: curr.timestamp.slice(0, 10),
      close: curr.closePrice, open: curr.openPrice,
      high: curr.highPrice, low: curr.lowPrice,
      reason:
        `신고가 구간에서 긴 윗꼬리 음봉. ` +
        `고가(${fp(curr.highPrice, market)})까지 올렸으나 강한 매도 압력에 ` +
        `종가(${fp(curr.closePrice, market)})가 시가 이하 마감. ` +
        `장중 돌파 매수세 함정 — 추세 반전 경고.`,
    });
  }

  return signals;
}

// ── 포맷 ────────────────────────────────────────────────────────────────────

function fp(price: number, market: "KR" | "US"): string {
  if (market === "US") return `$${price.toFixed(2)}`;
  return `${Math.round(price).toLocaleString("ko-KR")}원`;
}

const SIGNAL_EMOJI: Record<SellSignalType, string> = {
  trap: "🪤",
  collapse: "💥",
  upper_shadow_trap: "📍",
};

const SIGNAL_LABELS: Record<SellSignalType, string> = {
  trap: "세력 유동성 트랩",
  collapse: "가속 추세 붕괴 (하락장악형)",
  upper_shadow_trap: "윗꼬리 트랩 (돌파 실패)",
};

function nowKSTStr(): string {
  const kst = new Date(Date.now() + 9 * 3600_000);
  const d = kst.toISOString().slice(0, 10);
  const t = kst.toISOString().slice(11, 16);
  return `${d} ${t} KST`;
}

export function formatSellAlert(signal: SellSignal): string {
  const emoji = SIGNAL_EMOJI[signal.type];
  const label = SIGNAL_LABELS[signal.type];
  const marketFlag = signal.market === "KR" ? "🇰🇷" : "🇺🇸";

  let metrics =
    `📊 O ${fp(signal.open, signal.market)} | ` +
    `H ${fp(signal.high, signal.market)} | ` +
    `L ${fp(signal.low, signal.market)} | ` +
    `C ${fp(signal.close, signal.market)}`;

  if (signal.resistance) {
    metrics += `\n📏 저항선: ${fp(signal.resistance, signal.market)}`;
  }
  if (signal.slopeRatio) {
    metrics += `\n📐 기울기 가속: ${signal.slopeRatio.toFixed(1)}배`;
  }

  return (
    `🔴 🚨 <b>매도 신호 — ${signal.name} (${signal.symbol})</b>\n\n` +
    `${emoji} <b>${label}</b>\n` +
    `${marketFlag} ${signal.market === "KR" ? "KOSPI" : "US"} | 📅 주봉 기준: ${signal.weekDate}\n` +
    `⏰ 알림 발송: ${nowKSTStr()}\n\n` +
    `${metrics}\n\n` +
    `<b>📋 분석:</b>\n${signal.reason}\n\n` +
    `⚠️ <i>하승훈 매도 규칙 기반 — 보유 중이라면 분할 매도를 검토하세요.</i>`
  );
}

// 같은 종목의 여러 패턴을 하나의 메시지로 합쳐서 발송
export function formatSellAlertGroup(signals: SellSignal[]): string {
  if (signals.length === 1) return formatSellAlert(signals[0]!);

  const s = signals[0]!;
  const marketFlag = s.market === "KR" ? "🇰🇷" : "🇺🇸";

  let header =
    `🔴 🚨 <b>매도 신호 — ${s.name} (${s.symbol})</b>\n\n` +
    `${marketFlag} ${s.market === "KR" ? "KOSPI" : "US"} | 📅 주봉 기준: ${s.weekDate}\n` +
    `⏰ 알림 발송: ${nowKSTStr()}\n` +
    `📊 O ${fp(s.open, s.market)} | H ${fp(s.high, s.market)} | L ${fp(s.low, s.market)} | C ${fp(s.close, s.market)}\n\n`;

  const patternLines = signals.map(sig => {
    const emoji = SIGNAL_EMOJI[sig.type];
    const label = SIGNAL_LABELS[sig.type];
    let extra = "";
    if (sig.resistance) extra += ` | 저항선 ${fp(sig.resistance, sig.market)}`;
    if (sig.slopeRatio) extra += ` | 가속 ${sig.slopeRatio.toFixed(1)}x`;
    return `${emoji} <b>${label}</b>${extra}\n${sig.reason}`;
  }).join("\n\n");

  return header + patternLines + `\n\n⚠️ <i>하승훈 매도 규칙 기반 — 보유 중이라면 분할 매도를 검토하세요.</i>`;
}
