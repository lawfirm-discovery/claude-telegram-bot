import type { Candle } from "./stock";

// ── Weekly Aggregation ────────────────────────────────────────────────────────

// 일봉 캔들 배열을 주봉으로 집계 (월요일 기준)
function aggregateToWeekly(dailyCandles: Candle[]): Candle[] {
  if (dailyCandles.length === 0) return [];
  const sorted = [...dailyCandles].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const weekMap = new Map<string, Candle[]>();
  for (const c of sorted) {
    const d = new Date(c.timestamp);
    const day = d.getUTCDay(); // 0=일, 1=월
    const diff = (day + 6) % 7; // 월요일까지 거리 (월=0)
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - diff);
    const key = monday.toISOString().slice(0, 10);
    if (!weekMap.has(key)) weekMap.set(key, []);
    weekMap.get(key)!.push(c);
  }

  const weeks: Candle[] = [];
  for (const [weekStart, candles] of [...weekMap.entries()].sort()) {
    weeks.push({
      timestamp: weekStart,
      openPrice:  candles[0]!.openPrice,
      highPrice:  Math.max(...candles.map(c => c.highPrice)),
      lowPrice:   Math.min(...candles.map(c => c.lowPrice)),
      closePrice: candles[candles.length - 1]!.closePrice,
      volume:     candles.reduce((s, c) => s + c.volume, 0),
    });
  }
  return weeks;
}

// 주봉 추세 판단: 마지막 완성 주봉의 캔들 형태 + 20주 SMA 기울기
// 반환: "bullish" | "bearish" | "neutral"
export type WeeklyTrend = "bullish" | "bearish" | "neutral";

export function getWeeklyTrend(dailyCandles: Candle[]): WeeklyTrend {
  const weekly = aggregateToWeekly(dailyCandles);
  // 마지막 주봉은 현재 진행 중일 수 있으므로 직전 완성 주봉 사용
  const completed = weekly.length >= 2 ? weekly.slice(0, -1) : weekly;
  if (completed.length < 5) return "neutral";

  const last = completed[completed.length - 1]!;
  const closes = completed.map(c => c.closePrice);

  // 20주 SMA 기울기
  const period = Math.min(20, closes.length);
  const smaRecent = closes.slice(-period).reduce((a, b) => a + b, 0) / period;
  const smaPrev   = closes.slice(-period - 1, -1).reduce((a, b) => a + b, 0) / period;
  const smaRising = smaRecent > smaPrev;

  // 주봉 캔들 형태
  const body = last.closePrice - last.openPrice;
  const isLongBullish = body > 0 && body > (last.highPrice - last.lowPrice) * 0.5;
  const isLongBearish = body < 0 && Math.abs(body) > (last.highPrice - last.lowPrice) * 0.5;
  const hlRange = last.highPrice - last.lowPrice;
  const upperWick = last.highPrice - Math.max(last.closePrice, last.openPrice);
  const isInvertedHammer = hlRange > 0 && upperWick / hlRange > 0.6 && body < 0;

  if (smaRising && (isLongBullish || body > 0)) return "bullish";
  if (!smaRising && (isLongBearish || isInvertedHammer || body < 0)) return "bearish";
  return "neutral";
}

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

// SMA 전체 시리즈
function calcSMASeries(values: number[], period: number): number[] {
  return values.map((_, i) => {
    if (i < period - 1) return NaN;
    return values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
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

// 매물대(볼륨 프로파일) 상위 구간 계산 — bins 개 구간 중 상위 topN 반환
function calcVolumeZones(
  candles: Candle[],
  bins = 20,
  topN = 3,
): Array<{ from: number; to: number; vol: number }> {
  if (candles.length === 0) return [];
  const prices = candles.map(c => c.closePrice);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const step = (maxP - minP) / bins || 1;
  const levels = Array.from({ length: bins }, (_, i) => ({
    from: minP + i * step,
    to: minP + (i + 1) * step,
    vol: 0,
  }));
  for (const c of candles) {
    const idx = Math.min(Math.floor((c.closePrice - minP) / step), bins - 1);
    levels[idx]!.vol += c.volume;
  }
  return levels.sort((a, b) => b.vol - a.vol).slice(0, topN);
}

// BB 돌파 방향에 강한 매물대가 있는지 확인
// direction: "up" → 현재가 위쪽에 매물대가 있으면 저항(true), "down" → 아래쪽에 지지(true)
// resistanceZone=true → 회귀 가능성 높음, false → 추세 지속 가능성 높음
function checkResistanceZone(
  candles: Candle[],
  currentPrice: number,
  atr: number,
  direction: "up" | "down",
): boolean {
  const zones = calcVolumeZones(candles, 20, 3);
  const buffer = atr * 1.5; // 현재가 ± 1.5ATR 이내를 "바로 위/아래"로 간주
  return zones.some(z => {
    const zoneCenter = (z.from + z.to) / 2;
    if (direction === "up")
      return zoneCenter > currentPrice && zoneCenter < currentPrice + buffer;
    return zoneCenter < currentPrice && zoneCenter > currentPrice - buffer;
  });
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

// 역망치형(shooting star) 캔들 판별: 긴 윗꼬리 + 몸통은 아래쪽 → 밴드 상단 복귀 신호
function detectInvertedHammerLocal(c: Candle): boolean {
  const hlRange = c.highPrice - c.lowPrice;
  const body = Math.abs(c.closePrice - c.openPrice);
  if (hlRange <= 0 || body === 0) return false;
  const hl = hlRange + 0.001;
  return (
    hlRange > 3 * body &&
    (c.highPrice - Math.max(c.closePrice, c.openPrice)) / hl > 0.6
  );
}

// ── Double Bottom / Double Top 패턴 ─────────────────────────────────────────

// 쌍바닥 감지: 최근 lookback 봉 내에서 두 저점이 비슷한 가격대에 형성됐는지
// - 두 저점 간격 최소 minGap봉 이상
// - 두 저점 가격 차이 maxDiff% 이내
// - 두 번째 저점이 BB 하단에 닿아 있으면 추가 점수
function detectDoubleBottom(
  candles: Candle[],
  bb22Lower: number,
  lookback = 40,
  minGap = 5,
  maxDiff = 0.03,
): { detected: boolean; bbTouch: boolean } {
  const slice = candles.slice(-lookback);
  const lows = slice.map(c => c.lowPrice);
  const troughs = findTroughs(lows, 2);
  if (troughs.length < 2) return { detected: false, bbTouch: false };

  for (let i = troughs.length - 2; i >= 0; i--) {
    const t1 = troughs[i]!, t2 = troughs[i + 1]!;
    if (t2 - t1 < minGap) continue;
    const p1 = lows[t1]!, p2 = lows[t2]!;
    const diff = Math.abs(p1 - p2) / Math.max(p1, p2);
    if (diff <= maxDiff) {
      const bbTouch = p2 <= bb22Lower * 1.01; // 두 번째 저점이 BB하단과 1% 이내
      return { detected: true, bbTouch };
    }
  }
  return { detected: false, bbTouch: false };
}

// 쌍봉 감지: 최근 lookback 봉 내에서 두 고점이 비슷한 가격대에 형성됐는지
function detectDoubleTop(
  candles: Candle[],
  bb22Upper: number,
  lookback = 40,
  minGap = 5,
  maxDiff = 0.03,
): { detected: boolean; bbTouch: boolean } {
  const slice = candles.slice(-lookback);
  const highs = slice.map(c => c.highPrice);
  const peaks = findPeaks(highs, 2);
  if (peaks.length < 2) return { detected: false, bbTouch: false };

  for (let i = peaks.length - 2; i >= 0; i--) {
    const p1 = peaks[i]!, p2 = peaks[i + 1]!;
    if (p2 - p1 < minGap) continue;
    const h1 = highs[p1]!, h2 = highs[p2]!;
    const diff = Math.abs(h1 - h2) / Math.max(h1, h2);
    if (diff <= maxDiff) {
      const bbTouch = h2 >= bb22Upper * 0.99; // 두 번째 고점이 BB상단과 1% 이내
      return { detected: true, bbTouch };
    }
  }
  return { detected: false, bbTouch: false };
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

// 이격도 일반 약세 다이버전스: 가격 고점 상승, 이격도 고점 하락 → 상단 매도 확인
function checkBearishDivergence(closes: number[], period = 20): boolean {
  const wSize = Math.min(60, closes.length);
  if (wSize < 20) return false;
  const priceW = closes.slice(-wSize);
  const dispW  = calcDisparitySeries(closes, period).slice(-wSize);
  const peaks = findPeaks(priceW, 3);
  if (peaks.length < 2) return false;
  const p1 = peaks[peaks.length - 2]!, p2 = peaks[peaks.length - 1]!;
  // 일반 약세 다이버전스: 가격 고점은 올라가는데 이격도 고점은 내려가면 하락 신호
  return priceW[p2]! > priceW[p1]! && dispW[p2]! < dispW[p1]!;
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

export type WbSignalType = "wb_bottom" | "onebee_buy" | "wb_top" | "onebee_sell" | "doublebee_cross_buy" | "doublebee_cross_sell";

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
  weeklyTrend: WeeklyTrend;
  filters: {
    disparityOk: boolean;
    rsiTripleOk: boolean;
    hammerOk: boolean;
    invertedHammerOk: boolean;
    trendOk: boolean;
    weeklyAligned: boolean;     // 주봉 추세와 시그널 방향이 일치하는지
    resistanceNear: boolean;
    doublePattern: boolean;
    doubleBbTouch: boolean;
  };
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
  if (dailyCandles.length < 20) return signals;

  const sorted = [...dailyCandles].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  const n = sorted.length;
  const closes = sorted.map(c => c.closePrice);
  const opens  = sorted.map(c => c.openPrice);

  // Band A (White BB): 길이 2, 표준편차 2, 종가
  // Band B (Red BB):   길이 4, 표준편차 4, 시가
  const bb22 = calcBBSeries(closes, 2, 2.0);
  const bb44 = calcBBSeries(opens,  4, 4.0);
  const sma20 = calcSMASeries(closes, 20);

  const currBB22 = bb22[n - 1]!;
  const currBB44 = bb44[n - 1]!;
  const prevBB22 = bb22[n - 2];
  const prevBB44 = bb44[n - 2];
  if (isNaN(currBB22.lower) || isNaN(currBB44.lower)) return signals;

  const curr = sorted[n - 1]!;
  const atr = calcATRLocal(sorted, 14);
  if (isNaN(atr)) return signals;

  const isUptrend    = (sma20[n - 1] ?? 0) > (sma20[n - 2] ?? 0);
  const isDowntrend  = (sma20[n - 1] ?? 0) < (sma20[n - 2] ?? 0);
  const weeklyTrend  = getWeeklyTrend(sorted);

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
    const disparityOk    = checkBullishDivergence(closes);
    const rsiTripleOk    = checkRsiTripleExtreme(closes, "buy");
    const hammerOk       = detectHammerLocal(curr);
    const resistanceNear = checkResistanceZone(sorted, curr.closePrice, atr, "up");
    const { detected: doublePattern, bbTouch: doubleBbTouch } = detectDoubleBottom(sorted, currBB22.lower);
    const weeklyAligned = weeklyTrend === "bullish" || weeklyTrend === "neutral";
    const score = [disparityOk, rsiTripleOk, hammerOk, doublePattern].filter(Boolean).length;
    if (score >= 1) {
      signals.push({
        type: "wb_bottom", direction: "buy", symbol, name, market,
        date: curr.timestamp.slice(0, 10),
        price: curr.closePrice,
        stopLoss:    curr.closePrice - atr * 3.0,
        targetPrice: currBB22.upper,
        atr,
        weeklyTrend,
        filters: { disparityOk, rsiTripleOk, hammerOk, invertedHammerOk: false, trendOk: true, weeklyAligned, resistanceNear, doublePattern, doubleBbTouch },
        reason:
          `더블BB 하단 동시 이탈(${dblBottomOffset}봉 전) 후 BB22 하단 재진입. ` +
          `이격도:${disparityOk ? "✅" : "❌"} RSI트리플:${rsiTripleOk ? "✅" : "❌"} 망치형:${hammerOk ? "✅" : "❌"} ` +
          `쌍바닥:${doublePattern ? (doubleBbTouch ? "✅BB접촉" : "✅감지") : "❌"} ` +
          `주봉:${weeklyTrend === "bullish" ? "✅상승" : weeklyTrend === "bearish" ? "⚠️하락" : "→횡보"} ` +
          `위쪽 매물대:${resistanceNear ? "⚠️있음" : "✅없음"}`,
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
      const disparityOk    = checkBullishDivergence(closes);
      const rsiTripleOk    = checkRsiTripleExtreme(closes, "buy");
      const resistanceNear = checkResistanceZone(sorted, curr.closePrice, atr, "up");
      const { detected: doublePattern, bbTouch: doubleBbTouch } = detectDoubleBottom(sorted, currBB44.lower);
      if (disparityOk || rsiTripleOk || doublePattern) {
        signals.push({
          type: "onebee_buy", direction: "buy", symbol, name, market,
          date: curr.timestamp.slice(0, 10),
          price: curr.closePrice,
          stopLoss:    curr.closePrice - atr * 3.0,
          targetPrice: currBB22.upper,
          atr,
          filters: { disparityOk, rsiTripleOk, hammerOk: false, invertedHammerOk: false, trendOk: true, resistanceNear, doublePattern, doubleBbTouch },
          reason:
            `원비 매수: 22EMA 우상향 중 44BB 하단 단독 터치(${oneBeeBottomOffset}봉 전) 후 재진입. ` +
            `이격도:${disparityOk ? "✅" : "❌"} RSI트리플:${rsiTripleOk ? "✅" : "❌"} ` +
            `쌍바닥:${doublePattern ? (doubleBbTouch ? "✅BB접촉" : "✅감지") : "❌"} ` +
            `위쪽 매물대:${resistanceNear ? "⚠️있음" : "✅없음"}`,
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
    const disparityOk      = checkBearishDivergence(closes);
    const rsiTripleOk      = checkRsiTripleExtreme(closes, "sell");
    const invertedHammerOk = detectInvertedHammerLocal(curr);
    const resistanceNear   = checkResistanceZone(sorted, curr.closePrice, atr, "down");
    const { detected: doublePattern, bbTouch: doubleBbTouch } = detectDoubleTop(sorted, currBB22.upper);
    const score = [disparityOk, rsiTripleOk, invertedHammerOk, doublePattern].filter(Boolean).length;
    if (score >= 1) {
      signals.push({
        type: "wb_top", direction: "sell", symbol, name, market,
        date: curr.timestamp.slice(0, 10),
        price: curr.closePrice,
        stopLoss:    curr.closePrice + atr * 3.0,
        targetPrice: currBB22.lower,
        atr,
        filters: { disparityOk, rsiTripleOk, hammerOk: false, invertedHammerOk, trendOk: true, resistanceNear, doublePattern, doubleBbTouch },
        reason:
          `더블BB 상단 동시 이탈(${dblTopOffset}봉 전) 후 BB22 상단 하향 재진입. ` +
          `이격도:${disparityOk ? "✅" : "❌"} RSI트리플:${rsiTripleOk ? "✅" : "❌"} 역망치형:${invertedHammerOk ? "✅" : "❌"} ` +
          `쌍봉:${doublePattern ? (doubleBbTouch ? "✅BB접촉" : "✅감지") : "❌"} ` +
          `아래쪽 지지대:${resistanceNear ? "⚠️있음" : "✅없음"}`,
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
      const disparityOk      = checkBearishDivergence(closes);
      const rsiTripleOk      = checkRsiTripleExtreme(closes, "sell");
      const invertedHammerOk = detectInvertedHammerLocal(curr);
      const resistanceNear   = checkResistanceZone(sorted, curr.closePrice, atr, "down");
      const { detected: doublePattern, bbTouch: doubleBbTouch } = detectDoubleTop(sorted, currBB44.upper);
      if (disparityOk || rsiTripleOk || invertedHammerOk || doublePattern) {
        signals.push({
          type: "onebee_sell", direction: "sell", symbol, name, market,
          date: curr.timestamp.slice(0, 10),
          price: curr.closePrice,
          stopLoss:    curr.closePrice + atr * 3.0,
          targetPrice: currBB22.lower,
          atr,
          filters: { disparityOk, rsiTripleOk, hammerOk: false, invertedHammerOk, trendOk: true, resistanceNear, doublePattern, doubleBbTouch },
          reason:
            `원비 매도: 22EMA 하향 중 44BB 상단 단독 터치(${oneBeeTopOffset}봉 전) 후 재진입. ` +
            `이격도:${disparityOk ? "✅" : "❌"} RSI트리플:${rsiTripleOk ? "✅" : "❌"} 역망치형:${invertedHammerOk ? "✅" : "❌"} ` +
            `쌍봉:${doublePattern ? (doubleBbTouch ? "✅BB접촉" : "✅감지") : "❌"} ` +
            `아래쪽 지지대:${resistanceNear ? "⚠️있음" : "✅없음"}`,
        });
      }
    }
  }

  // ── 더블비 교차 감지 ─────────────────────────────────────────────────────
  // BB2(종가,2σ)가 BB4(시가,4σ)를 돌파하는 순간: 단기 변동성 > 중기 변동성
  // 직전 봉에서 BB2가 BB4 안에 있었다가 현재 봉에서 BB2가 BB4를 벗어남
  if (prevBB22 && prevBB44 && !isNaN(prevBB22.lower) && !isNaN(prevBB44.lower)) {
    const lowerCross =
      prevBB22.lower >= prevBB44.lower &&   // 직전: BB2하단 ≥ BB4하단 (정상)
      currBB22.lower <  currBB44.lower;     // 현재: BB2하단이 BB4하단 아래로 돌파

    const upperCross =
      prevBB22.upper <= prevBB44.upper &&   // 직전: BB2상단 ≤ BB4상단 (정상)
      currBB22.upper >  currBB44.upper;     // 현재: BB2상단이 BB4상단 위로 돌파

    if (lowerCross) {
      const resistanceNear = checkResistanceZone(sorted, curr.closePrice, atr, "up");
      const { detected: doublePattern, bbTouch: doubleBbTouch } = detectDoubleBottom(sorted, currBB22.lower);
      signals.push({
        type: "doublebee_cross_buy", direction: "buy", symbol, name, market,
        date: curr.timestamp.slice(0, 10),
        price: curr.closePrice,
        stopLoss:    curr.closePrice - atr * 3.0,
        targetPrice: currBB22.upper,
        atr,
        filters: { disparityOk: false, rsiTripleOk: false, hammerOk: false, invertedHammerOk: false, trendOk: isUptrend, resistanceNear, doublePattern, doubleBbTouch },
        reason:
          `더블비 하단 교차: BB2 하단이 BB4 하단 아래로 돌파 — 단기 변동성 폭발, 밴드 회귀 매수. ` +
          `SMA20:${isUptrend ? "상승✅" : isDowntrend ? "하락⚠️" : "횡보"} ` +
          `쌍바닥:${doublePattern ? (doubleBbTouch ? "✅BB접촉" : "✅감지") : "❌"} ` +
          `위쪽 매물대:${resistanceNear ? "⚠️있음" : "✅없음"}`,
      });
    }

    if (upperCross) {
      const resistanceNear = checkResistanceZone(sorted, curr.closePrice, atr, "down");
      const { detected: doublePattern, bbTouch: doubleBbTouch } = detectDoubleTop(sorted, currBB22.upper);
      signals.push({
        type: "doublebee_cross_sell", direction: "sell", symbol, name, market,
        date: curr.timestamp.slice(0, 10),
        price: curr.closePrice,
        stopLoss:    curr.closePrice + atr * 3.0,
        targetPrice: currBB22.lower,
        atr,
        filters: { disparityOk: false, rsiTripleOk: false, hammerOk: false, invertedHammerOk: false, trendOk: isDowntrend, resistanceNear, doublePattern, doubleBbTouch },
        reason:
          `더블비 상단 교차: BB2 상단이 BB4 상단 위로 돌파 — 단기 변동성 폭발, 밴드 회귀 매도. ` +
          `SMA20:${isDowntrend ? "하락✅" : isUptrend ? "상승⚠️" : "횡보"} ` +
          `쌍봉:${doublePattern ? (doubleBbTouch ? "✅BB접촉" : "✅감지") : "❌"} ` +
          `아래쪽 지지대:${resistanceNear ? "⚠️있음" : "✅없음"}`,
      });
    }
  }

  return signals;
}

// ── Formatting ────────────────────────────────────────────────────────────────

const WB_LABELS: Record<WbSignalType, string> = {
  wb_bottom:           "WB 변곡 매수 (더블BB 하단 재진입)",
  onebee_buy:          "원비 매수 (SMA20 상승 중 BB4 하단 터치)",
  wb_top:              "WB 변곡 매도 (더블BB 상단 재진입)",
  onebee_sell:         "원비 매도 (SMA20 하락 중 BB4 상단 터치)",
  doublebee_cross_buy: "더블비 교차 매수 (BB2 하단 > BB4 하단 돌파)",
  doublebee_cross_sell:"더블비 교차 매도 (BB2 상단 > BB4 상단 돌파)",
};

const WB_EMOJI: Record<WbSignalType, string> = {
  wb_bottom:           "🟢",
  onebee_buy:          "🔵",
  wb_top:              "🔴",
  onebee_sell:         "🟠",
  doublebee_cross_buy: "💥",
  doublebee_cross_sell:"💥",
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
    signal.filters.hammerOk         ? `  망치형 캔들: ✅`   : null,
    signal.filters.invertedHammerOk ? `  역망치형 캔들: ✅` : null,
    signal.filters.doublePattern
      ? `  ${isBuy ? "쌍바닥" : "쌍봉"} 패턴: ✅${signal.filters.doubleBbTouch ? " (BB 접촉)" : ""}`
      : null,
    `  ${isBuy ? "위쪽" : "아래쪽"} 매물대: ${signal.filters.resistanceNear ? "⚠️ 있음 (추세 약화 주의)" : "✅ 없음 (추세 지속 유리)"}`,
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
