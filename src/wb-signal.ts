import type { Candle } from "./stock";

// ── Local Math Helpers ────────────────────────────────────────────────────────

// BB 시리즈: 모든 인덱스에 대해 상단/중심/하단 계산
function calcBBSeries(
  values: number[],
  period: number,
  k = 2.0,
): Array<{ upper: number; middle: number; lower: number }> {
  return values.map((_, i) => {
    if (i < period - 1) return { upper: NaN, middle: NaN, lower: NaN };
    const slice = values.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period);
    return { upper: mean + k * std, middle: mean, lower: mean - k * std };
  });
}

// EMA 전체 시리즈
function calcEMASeries(values: number[], period: number): number[] {
  if (values.length < period) return new Array(values.length).fill(NaN);
  const k = 2 / (period + 1);
  const result: number[] = new Array(period - 1).fill(NaN);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

// 이격도 시리즈: (close - SMA) / SMA × 100
function calcDisparitySeries(values: number[], period: number): number[] {
  return values.map((_, i) => {
    if (i < period - 1) return NaN;
    const slice = values.slice(i - period + 1, i + 1);
    const ma = slice.reduce((a, b) => a + b, 0) / period;
    return (values[i]! - ma) / ma * 100;
  });
}

// RSI 시리즈 (Wilder's smoothing)
function calcRSISeriesLocal(closes: number[], period = 14): number[] {
  const result: number[] = new Array(period).fill(NaN);
  if (closes.length < period + 1) return result;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return result;
}

// 로컬 극소값 인덱스 탐색 (halfWindow 내에서 최솟값인 지점)
function findTroughs(values: number[], halfWindow = 3): number[] {
  const result: number[] = [];
  for (let i = halfWindow; i < values.length - halfWindow; i++) {
    if (isNaN(values[i]!)) continue;
    let ok = true;
    for (let j = i - halfWindow; j <= i + halfWindow; j++) {
      if (j !== i && !isNaN(values[j]!) && values[j]! <= values[i]!) { ok = false; break; }
    }
    if (ok) result.push(i);
  }
  return result;
}

// 로컬 극대값 인덱스 탐색
function findPeaks(values: number[], halfWindow = 3): number[] {
  const result: number[] = [];
  for (let i = halfWindow; i < values.length - halfWindow; i++) {
    if (isNaN(values[i]!)) continue;
    let ok = true;
    for (let j = i - halfWindow; j <= i + halfWindow; j++) {
      if (j !== i && !isNaN(values[j]!) && values[j]! >= values[i]!) { ok = false; break; }
    }
    if (ok) result.push(i);
  }
  return result;
}

// ATR (Average True Range, Wilder's EMA)
function calcATRLocal(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return NaN;
  const slice = candles.slice(-(period + 1));
  let atr = 0;
  for (let i = 1; i <= period; i++) {
    const c = slice[i]!, p = slice[i - 1]!;
    const tr = Math.max(
      c.highPrice - c.lowPrice,
      Math.abs(c.highPrice - p.closePrice),
      Math.abs(c.lowPrice - p.closePrice),
    );
    atr = i === 1 ? tr : (atr * (period - 1) + tr) / period;
  }
  return atr;
}

// 망치형 캔들 판별: 긴 아랫꼬리 + 몸통은 위쪽
function detectHammerLocal(c: Candle): boolean {
  const hlRange = c.highPrice - c.lowPrice;
  const body = Math.abs(c.closePrice - c.openPrice);
  if (hlRange <= 0 || body === 0) return false;
  const hl = hlRange + 0.001;
  return (
    hlRange > 3 * body &&
    (c.closePrice - c.lowPrice) / hl > 0.6 &&
    (c.openPrice  - c.lowPrice) / hl > 0.6
  );
}

// ── Divergence & RSI Filters ──────────────────────────────────────────────────

// 이격도 일반 강세 다이버전스: 가격 저점 하락, 이격도 저점 상승 → 하단 매수 확인
function checkBullishDivergence(closes: number[], period = 20): boolean {
  const wSize = Math.min(60, closes.length);
  if (wSize < 20) return false;
  const priceW = closes.slice(-wSize);
  const dispW  = calcDisparitySeries(closes, period).slice(-wSize);
  const troughs = findTroughs(priceW, 3);
  if (troughs.length < 2) return false;
  const t1 = troughs[troughs.length - 2]!, t2 = troughs[troughs.length - 1]!;
  return priceW[t2]! < priceW[t1]! && dispW[t2]! > dispW[t1]!;
}

// 이격도 히든 약세 다이버전스: 가격 고점 하락, 이격도 고점 상승 → 상단 매도 확인
function checkBearishDivergence(closes: number[], period = 20): boolean {
  const wSize = Math.min(60, closes.length);
  if (wSize < 20) return false;
  const priceW = closes.slice(-wSize);
  const dispW  = calcDisparitySeries(closes, period).slice(-wSize);
  const peaks = findPeaks(priceW, 3);
  if (peaks.length < 2) return false;
  const p1 = peaks[peaks.length - 2]!, p2 = peaks[peaks.length - 1]!;
  return priceW[p2]! < priceW[p1]! && dispW[p2]! > dispW[p1]!;
}

// RSI 트리플 익스트림: 임계 영역(30이하/70이상)에서 3회 독립 저점/고점 형성
function checkRsiTripleExtreme(closes: number[], direction: "buy" | "sell"): boolean {
  const wSize = Math.min(80, closes.length);
  if (wSize < 30) return false;
  const rsi = calcRSISeriesLocal(closes.slice(-wSize));
  if (direction === "buy") {
    return findTroughs(rsi, 2).filter(i => (rsi[i] ?? 100) < 30).length >= 3;
  }
  return findPeaks(rsi, 2).filter(i => (rsi[i] ?? 0) > 70).length >= 3;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type WbSignalType = "wb_bottom" | "onebee_buy" | "wb_top" | "onebee_sell";

export interface WbSignal {
  type: WbSignalType;
  direction: "buy" | "sell";
  symbol: string;
  name: string;
  market: "KR" | "US";
  date: string;
  price: number;
  stopLoss: number;
  targetPrice: number;
  atr: number;
  filters: { disparityOk: boolean; rsiTripleOk: boolean; hammerOk: boolean; trendOk: boolean };
  reason: string;
}

// ── Main Signal Detection ─────────────────────────────────────────────────────

export function detectWbSignals(
  symbol: string,
  name: string,
  market: "KR" | "US",
  dailyCandles: Candle[],
): WbSignal[] {
  const signals: WbSignal[] = [];
  if (dailyCandles.length < 50) return signals;

  const sorted = [...dailyCandles].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  const n = sorted.length;
  const closes = sorted.map(c => c.closePrice);
  const opens  = sorted.map(c => c.openPrice);

  // Band A (White BB): 22기간 종가 기준
  // Band B (Red BB):   44기간 시가 기준
  const bb22 = calcBBSeries(closes, 22, 2.0);
  const bb44 = calcBBSeries(opens,  44, 2.0);
  const ema22 = calcEMASeries(closes, 22);

  const currBB22 = bb22[n - 1]!;
  const currBB44 = bb44[n - 1]!;
  if (isNaN(currBB22.lower) || isNaN(currBB44.lower)) return signals;

  const curr = sorted[n - 1]!;
  const atr = calcATRLocal(sorted, 14);
  if (isNaN(atr)) return signals;

  const isUptrend   = (ema22[n - 1] ?? 0) > (ema22[n - 2] ?? 0);
  const isDowntrend = (ema22[n - 1] ?? 0) < (ema22[n - 2] ?? 0);

  // ── WB 변곡 매수 ─────────────────────────────────────────────────────────
  // 최근 1~3봉: 종가 < BB22하단 AND 저가 < BB44하단 (두 밴드 동시 터치)
  // 현재봉: 종가 > BB22하단 (재진입)
  const dblBottomOffset = [1, 2, 3].find(off => {
    const i = n - 1 - off;
    if (i < 0 || isNaN(bb22[i]!.lower) || isNaN(bb44[i]!.lower)) return false;
    const c = sorted[i]!;
    return c.closePrice < bb22[i]!.lower && c.lowPrice < bb44[i]!.lower;
  });

  if (dblBottomOffset !== undefined && curr.closePrice > currBB22.lower) {
    const disparityOk = checkBullishDivergence(closes);
    const rsiTripleOk = checkRsiTripleExtreme(closes, "buy");
    const hammerOk    = detectHammerLocal(curr);
    const score = [disparityOk, rsiTripleOk, hammerOk].filter(Boolean).length;
    if (score >= 1) {
      signals.push({
        type: "wb_bottom", direction: "buy", symbol, name, market,
        date: curr.timestamp.slice(0, 10),
        price: curr.closePrice,
        stopLoss:    curr.closePrice - atr * 3.0,
        targetPrice: currBB22.upper,
        atr,
        filters: { disparityOk, rsiTripleOk, hammerOk, trendOk: true },
        reason:
          `더블BB 하단 동시 이탈(${dblBottomOffset}봉 전) 후 BB22 하단 재진입. ` +
          `이격도:${disparityOk ? "✅" : "❌"} RSI트리플:${rsiTripleOk ? "✅" : "❌"} 망치형:${hammerOk ? "✅" : "❌"}`,
      });
    }
  }

  // ── 원비 매수 ─────────────────────────────────────────────────────────────
  // 22EMA 우상향 + 최근 1~3봉: 저가 < BB44하단 (단독 터치 — BB22하단은 위)
  // 현재봉: 종가 > BB44하단 (재진입)
  if (isUptrend) {
    const oneBeeBottomOffset = [1, 2, 3].find(off => {
      const i = n - 1 - off;
      if (i < 0 || isNaN(bb22[i]!.lower) || isNaN(bb44[i]!.lower)) return false;
      const c = sorted[i]!;
      return c.lowPrice < bb44[i]!.lower && c.closePrice >= bb22[i]!.lower;
    });
    if (oneBeeBottomOffset !== undefined && curr.closePrice > currBB44.lower) {
      const disparityOk = checkBullishDivergence(closes);
      const rsiTripleOk = checkRsiTripleExtreme(closes, "buy");
      if (disparityOk || rsiTripleOk) {
        signals.push({
          type: "onebee_buy", direction: "buy", symbol, name, market,
          date: curr.timestamp.slice(0, 10),
          price: curr.closePrice,
          stopLoss:    curr.closePrice - atr * 3.0,
          targetPrice: currBB22.upper,
          atr,
          filters: { disparityOk, rsiTripleOk, hammerOk: false, trendOk: true },
          reason:
            `원비 매수: 22EMA 우상향 중 44BB 하단 단독 터치(${oneBeeBottomOffset}봉 전) 후 재진입. ` +
            `이격도:${disparityOk ? "✅" : "❌"} RSI트리플:${rsiTripleOk ? "✅" : "❌"}`,
        });
      }
    }
  }

  // ── WB 변곡 매도 ─────────────────────────────────────────────────────────
  // 최근 1~3봉: 종가 > BB22상단 AND 고가 > BB44상단 (두 밴드 동시 터치)
  // 현재봉: 종가 < BB22상단 (재진입)
  const dblTopOffset = [1, 2, 3].find(off => {
    const i = n - 1 - off;
    if (i < 0 || isNaN(bb22[i]!.upper) || isNaN(bb44[i]!.upper)) return false;
    const c = sorted[i]!;
    return c.closePrice > bb22[i]!.upper && c.highPrice > bb44[i]!.upper;
  });

  if (dblTopOffset !== undefined && curr.closePrice < currBB22.upper) {
    const disparityOk = checkBearishDivergence(closes);
    const rsiTripleOk = checkRsiTripleExtreme(closes, "sell");
    if (disparityOk || rsiTripleOk) {
      signals.push({
        type: "wb_top", direction: "sell", symbol, name, market,
        date: curr.timestamp.slice(0, 10),
        price: curr.closePrice,
        stopLoss:    curr.closePrice + atr * 3.0,
        targetPrice: currBB22.lower,
        atr,
        filters: { disparityOk, rsiTripleOk, hammerOk: false, trendOk: true },
        reason:
          `더블BB 상단 동시 이탈(${dblTopOffset}봉 전) 후 BB22 상단 하향 재진입. ` +
          `이격도:${disparityOk ? "✅" : "❌"} RSI트리플:${rsiTripleOk ? "✅" : "❌"}`,
      });
    }
  }

  // ── 원비 매도 ─────────────────────────────────────────────────────────────
  // 22EMA 하향 + 최근 1~3봉: 고가 > BB44상단 (단독 터치 — BB22상단은 아래)
  // 현재봉: 종가 < BB44상단 (재진입)
  if (isDowntrend) {
    const oneBeeTopOffset = [1, 2, 3].find(off => {
      const i = n - 1 - off;
      if (i < 0 || isNaN(bb22[i]!.upper) || isNaN(bb44[i]!.upper)) return false;
      const c = sorted[i]!;
      return c.highPrice > bb44[i]!.upper && c.closePrice <= bb22[i]!.upper;
    });
    if (oneBeeTopOffset !== undefined && curr.closePrice < currBB44.upper) {
      const disparityOk = checkBearishDivergence(closes);
      const rsiTripleOk = checkRsiTripleExtreme(closes, "sell");
      if (disparityOk || rsiTripleOk) {
        signals.push({
          type: "onebee_sell", direction: "sell", symbol, name, market,
          date: curr.timestamp.slice(0, 10),
          price: curr.closePrice,
          stopLoss:    curr.closePrice + atr * 3.0,
          targetPrice: currBB22.lower,
          atr,
          filters: { disparityOk, rsiTripleOk, hammerOk: false, trendOk: true },
          reason:
            `원비 매도: 22EMA 하향 중 44BB 상단 단독 터치(${oneBeeTopOffset}봉 전) 후 재진입. ` +
            `이격도:${disparityOk ? "✅" : "❌"} RSI트리플:${rsiTripleOk ? "✅" : "❌"}`,
        });
      }
    }
  }

  return signals;
}

// ── Formatting ────────────────────────────────────────────────────────────────

const WB_LABELS: Record<WbSignalType, string> = {
  wb_bottom:   "WB 변곡 매수 (더블BB 하단 재진입)",
  onebee_buy:  "원비 매수 (추세 되돌림 매수)",
  wb_top:      "WB 변곡 매도 (더블BB 상단 재진입)",
  onebee_sell: "원비 매도 (추세 되돌림 매도)",
};

const WB_EMOJI: Record<WbSignalType, string> = {
  wb_bottom:   "🟢",
  onebee_buy:  "🔵",
  wb_top:      "🔴",
  onebee_sell: "🟠",
};

function nowKSTStr(): string {
  const kst = new Date(Date.now() + 9 * 3600_000);
  return `${kst.toISOString().slice(0, 10)} ${kst.toISOString().slice(11, 16)} KST`;
}

function fp(price: number, market: "KR" | "US"): string {
  if (isNaN(price)) return "N/A";
  return market === "US" ? `$${price.toFixed(2)}` : `${Math.round(price).toLocaleString("ko-KR")}원`;
}

export function formatWbAlert(signal: WbSignal): string {
  const isBuy = signal.direction === "buy";
  const flag  = signal.market === "KR" ? "🇰🇷 KOSPI" : "🇺🇸 US";

  const filterLines = [
    `  이격도 다이버전스: ${signal.filters.disparityOk ? "✅" : "❌"}`,
    `  RSI 트리플 익스트림: ${signal.filters.rsiTripleOk ? "✅" : "❌"}`,
    signal.filters.hammerOk ? `  망치형 캔들: ✅` : null,
  ].filter(Boolean).join("\n");

  return (
    `${WB_EMOJI[signal.type]} 📊 <b>${isBuy ? "매수" : "매도"} 신호 — ${signal.name} (${signal.symbol})</b>\n\n` +
    `📌 <b>${WB_LABELS[signal.type]}</b>\n` +
    `${flag} | 📅 ${signal.date}\n` +
    `⏰ ${nowKSTStr()}\n\n` +
    `💰 현재가: <b>${fp(signal.price, signal.market)}</b>\n` +
    `🛑 손절가: ${fp(signal.stopLoss, signal.market)} (ATR × 3)\n` +
    `🎯 목표가: ${fp(signal.targetPrice, signal.market)} (BB22 ${isBuy ? "상단" : "하단"})\n` +
    `📐 ATR(14): ${fp(signal.atr, signal.market)}\n\n` +
    `🔍 필터 결과:\n${filterLines}\n\n` +
    `📋 ${signal.reason}\n\n` +
    `💡 포지션 사이징: 총자본 × 1% ÷ (ATR × 3)\n` +
    `⚠️ <i>WB 다차원 볼린저밴드 전략 — 반드시 스탑로스 설정 후 진입</i>`
  );
}
