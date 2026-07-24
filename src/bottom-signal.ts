import type { Candle } from "./stock";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BottomSignal {
  symbol: string;
  name: string;
  market: "KR" | "US";
  date: string;
  price: number;
  bottomPrice: number;
  triggerPrice: number;
  reboundRatio: number;
  volumeRatio: number;
  adx: number;
  filters: {
    squeezed: boolean;
    volumeDriedUp: boolean;
    consolidating: boolean;
  };
  reason: string;
}

// ── Math Helpers ─────────────────────────────────────────────────────────────

function sma(values: number[], period: number): number[] {
  const result = new Array<number>(values.length).fill(0);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) result[i] = sum / period;
  }
  return result;
}

function ema(values: number[], period: number): number[] {
  const result = new Array<number>(values.length).fill(0);
  if (values.length === 0) return result;
  const mult = 2 / (period + 1);
  result[0] = values[0]!;
  for (let i = 1; i < values.length; i++) {
    result[i] = (values[i]! - result[i - 1]!) * mult + result[i - 1]!;
  }
  return result;
}

function stddev(values: number[], smaArr: number[], period: number): number[] {
  const result = new Array<number>(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) {
    let varSum = 0;
    for (let j = 0; j < period; j++) {
      varSum += (values[i - j]! - smaArr[i]!) ** 2;
    }
    result[i] = Math.sqrt(varSum / period);
  }
  return result;
}

function atr(candles: Candle[], period: number): number[] {
  const result = new Array<number>(candles.length).fill(0);
  if (candles.length === 0) return result;

  const tr = new Array<number>(candles.length).fill(0);
  tr[0] = candles[0]!.highPrice - candles[0]!.lowPrice;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const pc = candles[i - 1]!.closePrice;
    tr[i] = Math.max(c.highPrice - c.lowPrice, Math.abs(c.highPrice - pc), Math.abs(c.lowPrice - pc));
  }

  let cur = 0;
  for (let i = 0; i < period; i++) cur += tr[i]!;
  cur /= period;
  result[period - 1] = cur;
  for (let i = period; i < candles.length; i++) {
    cur = (cur * (period - 1) + tr[i]!) / period;
    result[i] = cur;
  }
  return result;
}

function adx(candles: Candle[], period = 14): number[] {
  const n = candles.length;
  const result = new Array<number>(n).fill(0);
  if (n < period * 2) return result;

  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  const trArr = new Array<number>(n).fill(0);

  for (let i = 1; i < n; i++) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    const upMove = c.highPrice - p.highPrice;
    const downMove = p.lowPrice - c.lowPrice;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    trArr[i] = Math.max(
      c.highPrice - c.lowPrice,
      Math.abs(c.highPrice - p.closePrice),
      Math.abs(c.lowPrice - p.closePrice),
    );
  }

  let smoothTR = 0, smoothPlusDM = 0, smoothMinusDM = 0;
  for (let i = 1; i <= period; i++) {
    smoothTR += trArr[i]!;
    smoothPlusDM += plusDM[i]!;
    smoothMinusDM += minusDM[i]!;
  }

  const dx: number[] = [];
  for (let i = period; i < n; i++) {
    if (i > period) {
      smoothTR = smoothTR - smoothTR / period + trArr[i]!;
      smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i]!;
      smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i]!;
    }
    const plusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const minusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
    const diSum = plusDI + minusDI;
    const dxVal = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
    dx.push(dxVal);
  }

  if (dx.length < period) return result;
  let adxVal = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period * 2 - 1] = adxVal;
  for (let i = period; i < dx.length; i++) {
    adxVal = (adxVal * (period - 1) + dx[i]!) / period;
    result[period + i] = adxVal;
  }
  return result;
}

// ── Main Detection ───────────────────────────────────────────────────────────

export function detectBottomSignals(
  symbol: string,
  name: string,
  market: "KR" | "US",
  dailyCandles: Candle[],
  reboundThreshold = 0.02,
  volumeDryUpFactor = 0.60,
  lookbackPeriod = 20,
): BottomSignal[] {
  const signals: BottomSignal[] = [];
  const sorted = [...dailyCandles].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  const n = sorted.length;
  if (n < lookbackPeriod + 5) return signals;

  const closes = sorted.map(c => c.closePrice);
  const volumes = sorted.map(c => c.volume);

  const sma20 = sma(closes, lookbackPeriod);
  const std20 = stddev(closes, sma20, lookbackPeriod);
  const ema20 = ema(closes, lookbackPeriod);
  const atr20 = atr(sorted, lookbackPeriod);
  const smaVol20 = sma(volumes, lookbackPeriod);
  const adxArr = adx(sorted, 14);

  let confirmedBottomPrice = -1;
  let isTrackingRebound = false;

  for (let i = lookbackPeriod; i < n; i++) {
    const curr = sorted[i]!;
    const prev = sorted[i - 1]!;
    const prev2 = sorted[i - 2]!;

    // 1. Swing Low
    const isSwingLow = prev.lowPrice < curr.lowPrice && prev.lowPrice < prev2.lowPrice;

    if (isSwingLow) {
      confirmedBottomPrice = prev.lowPrice;
      isTrackingRebound = true;
    }

    // 2. 반등 추적
    if (isTrackingRebound && confirmedBottomPrice > 0) {
      if (curr.lowPrice < confirmedBottomPrice) {
        confirmedBottomPrice = curr.lowPrice;
      }

      const reboundRatio = (curr.closePrice - confirmedBottomPrice) / confirmedBottomPrice;
      const triggerPrice = confirmedBottomPrice * (1 + reboundThreshold);

      if (curr.closePrice >= triggerPrice) {
        // 3. 변동성 수축 & 거래량 감소 확인
        const bbUpper = sma20[i]! + 2.0 * std20[i]!;
        const bbLower = sma20[i]! - 2.0 * std20[i]!;
        const kcUpper = ema20[i]! + 1.5 * atr20[i]!;
        const kcLower = ema20[i]! - 1.5 * atr20[i]!;

        const isSqueezed = bbUpper < kcUpper && bbLower > kcLower;

        const volRatio = smaVol20[i]! > 0 ? curr.volume / smaVol20[i]! : 1;
        const isVolumeDriedUp = volRatio <= volumeDryUpFactor;

        const rangeStart = Math.max(0, i - 9);
        const rangeCandles = sorted.slice(rangeStart, i + 1);
        const rangeHigh = Math.max(...rangeCandles.map(c => c.highPrice));
        const rangeLow = Math.min(...rangeCandles.map(c => c.lowPrice));
        const rangeTightness = rangeLow > 0 ? (rangeHigh - rangeLow) / rangeLow : 1;
        const isConsolidating = rangeTightness <= 0.05;

        // ADX — 정보 표시용 (blocking 조건 아님)
        const adxVal = adxArr[i]!;

        if (isSqueezed || isVolumeDriedUp || isConsolidating) {
          let reason = `바닥값 ${fp(confirmedBottomPrice, market)} 대비 ${(reboundRatio * 100).toFixed(1)}% 반등 확인. `;

          if (isSqueezed) reason += "볼린저-켈트너 스퀴즈로 횡보 구간 진입 확인. ";
          if (isVolumeDriedUp) reason += `거래량 수축 발생 (20일 평균 대비 ${(volRatio * 100).toFixed(0)}%). `;
          if (isConsolidating) reason += `최근 10봉 가격 변폭 ${(rangeTightness * 100).toFixed(1)}% 이내 횡보 안착. `;
          if (adxVal > 0) reason += `ADX ${adxVal.toFixed(1)}${adxVal < 20 ? " ✅ 무방향성" : " ⚠️ 추세 주의"}`;

          signals.push({
            symbol, name, market,
            date: curr.timestamp.slice(0, 10),
            price: curr.closePrice,
            bottomPrice: confirmedBottomPrice,
            triggerPrice,
            reboundRatio,
            volumeRatio: volRatio,
            adx: adxVal,
            filters: { squeezed: isSqueezed, volumeDriedUp: isVolumeDriedUp, consolidating: isConsolidating },
            reason,
          });

          isTrackingRebound = false;
          confirmedBottomPrice = -1;
        }
      }
    }
  }

  return signals;
}

// ── Formatting ───────────────────────────────────────────────────────────────

function fp(price: number, market: "KR" | "US"): string {
  if (isNaN(price)) return "N/A";
  return market === "US" ? `$${price.toFixed(2)}` : `${Math.round(price).toLocaleString("ko-KR")}원`;
}

function nowKSTStr(): string {
  const kst = new Date(Date.now() + 9 * 3600_000);
  return `${kst.toISOString().slice(0, 10)} ${kst.toISOString().slice(11, 16)} KST`;
}

export function formatBottomAlert(signal: BottomSignal): string {
  const flag = signal.market === "KR" ? "🇰🇷 KOSPI" : "🇺🇸 US";

  const filterLines = [
    `  볼린저 스퀴즈: ${signal.filters.squeezed ? "✅" : "❌"}`,
    `  거래량 건조(Dry-Up): ${signal.filters.volumeDriedUp ? "✅" : "❌"} (${(signal.volumeRatio * 100).toFixed(0)}%)`,
    `  가격 횡보 안착: ${signal.filters.consolidating ? "✅" : "❌"}`,
    `  ADX: ${signal.adx.toFixed(1)} ${signal.adx < 20 ? "✅ 무방향성" : "⚠️ 추세 주의"}`,
  ].join("\n");

  const stopLoss = signal.bottomPrice;
  const riskPct = ((signal.price - stopLoss) / signal.price * 100).toFixed(1);

  return (
    `🏛️ 📊 <b>기관형 바닥 매수 신호 — ${signal.name} (${signal.symbol})</b>\n\n` +
    `📌 <b>바닥 다지기 완료 + 2% 보험비 반등 확인</b>\n` +
    `${flag} | 📅 ${signal.date}\n` +
    `⏰ ${nowKSTStr()}\n\n` +
    `💰 현재가: <b>${fp(signal.price, signal.market)}</b>\n` +
    `📉 바닥가: ${fp(signal.bottomPrice, signal.market)}\n` +
    `📈 반등률: <b>+${(signal.reboundRatio * 100).toFixed(1)}%</b> (트리거: +2%)\n` +
    `🛑 손절가: ${fp(stopLoss, signal.market)} (바닥 이탈 시, -${riskPct}%)\n\n` +
    `🔍 횡보 지지 필터:\n${filterLines}\n\n` +
    `📋 ${signal.reason}\n\n` +
    `💡 매수 원칙: 바닥값 $P_{bottom}$ 이탈 시 즉시 손절\n` +
    `⚠️ <i>기관형 바닥 저점 포착 — 2% 보험비 반등 + 거래량 감소 횡보 지지 전략</i>`
  );
}
