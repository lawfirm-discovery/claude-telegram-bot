// ── KIS Candle Fetch ───────────────────────────────────────────────────────

import { getKisToken } from "./stock.js";
import { fetchKrxOptionChain, type OptionRow } from "./options-analysis.js";
const KIS_BASE = "https://openapi.koreainvestment.com:9443";

type KisCandle = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

async function fetchKisDailyCandles(symbol: string, fromDate: string, toDate: string): Promise<KisCandle[]> {
  const token = await getKisToken();
  const appKey = process.env.KIS_APP_KEY!;
  const appSecret = process.env.KIS_APP_SECRET!;
  const url = new URL(`${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`);
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", symbol);
  url.searchParams.set("FID_INPUT_DATE_1", fromDate);
  url.searchParams.set("FID_INPUT_DATE_2", toDate);
  url.searchParams.set("FID_PERIOD_DIV_CODE", "D");
  url.searchParams.set("FID_ORG_ADJ_PRC", "0");
  const res = await fetch(url.toString(), {
    headers: {
      authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      "tr_id": "FHKST03010100",
    },
  });
  if (!res.ok) throw new Error(`KIS 일봉 조회 실패: ${res.status}`);
  const data = await res.json() as any;
  if (data.rt_cd !== "0") throw new Error(`KIS 일봉 오류: ${data.msg1}`);
  return (data.output2 ?? []).map((r: any) => ({
    date: r.stck_bsop_date,
    open: parseInt(r.stck_oprc),
    high: parseInt(r.stck_hgpr),
    low: parseInt(r.stck_lwpr),
    close: parseInt(r.stck_clpr),
    volume: parseInt(r.acml_vol),
  }));
}

export async function fetchKisCandles(symbol: string, days: number): Promise<KisCandle[]> {
  const toDate = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
  // KIS 1회 최대 100일 → days > 100이면 두 번 호출
  const allCandles: KisCandle[] = [];
  let currentTo = toDate;
  while (allCandles.length < days) {
    const toD = new Date(
      parseInt(currentTo.slice(0, 4)),
      parseInt(currentTo.slice(4, 6)) - 1,
      parseInt(currentTo.slice(6, 8)),
    );
    const fromD = new Date(toD);
    fromD.setDate(fromD.getDate() - 140); // 140일치 요청 (주말 포함)
    const fromDate = fromD.toISOString().slice(0, 10).replace(/-/g, "");
    const batch = await fetchKisDailyCandles(symbol, fromDate, currentTo);
    if (batch.length === 0) break;
    allCandles.push(...batch);
    // 다음 배치는 현재 배치 마지막 날 이전으로
    const last = batch[batch.length - 1];
    const prevDate = new Date(
      parseInt(last.date.slice(0, 4)),
      parseInt(last.date.slice(4, 6)) - 1,
      parseInt(last.date.slice(6, 8)),
    );
    prevDate.setDate(prevDate.getDate() - 1);
    currentTo = prevDate.toISOString().slice(0, 10).replace(/-/g, "");
    if (allCandles.length >= days) break;
  }
  return allCandles.slice(0, days);
}

async function fetchKisCurrentPrice(symbol: string): Promise<number> {
  const token = await getKisToken();
  const appKey = process.env.KIS_APP_KEY!;
  const appSecret = process.env.KIS_APP_SECRET!;
  const url = new URL(`${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price`);
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", symbol);
  const res = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${token}`, appkey: appKey, appsecret: appSecret, "tr_id": "FHKST01010100" },
  });
  if (!res.ok) return 0;
  const data = await res.json() as any;
  return parseInt(data.output?.stck_prpr ?? "0") || 0;
}

// ── Types ──────────────────────────────────────────────────────────────────

export type SupportLevel = {
  price: number;
  score: number; // 0~100
  source: "DYNAMIC_MA" | "LOCAL_MINIMA" | "VOLUME_VAL" | "INTEGRATED" | "PUT_WALL";
  description: string;
};

export type StockSupportResult = {
  symbol: string;
  currentPrice: number;
  supports: SupportLevel[];
  timestamp: string;
};

// ── Ring Buffer (GC-free O(1) push/get) ───────────────────────────────────

class RingBuffer<T> {
  private buf: (T | undefined)[];
  private writePtr = 0;
  private size = 0;

  constructor(private cap: number) {
    this.buf = new Array(cap);
  }

  push(item: T): void {
    this.buf[this.writePtr] = item;
    this.writePtr = (this.writePtr + 1) % this.cap;
    if (this.size < this.cap) this.size++;
  }

  get(index: number): T | undefined {
    if (index < 0 || index >= this.size) return undefined;
    const actual = (this.writePtr - 1 - index + this.cap) % this.cap;
    return this.buf[actual];
  }

  length(): number {
    return this.size;
  }

  toArray(): T[] {
    const out: T[] = [];
    for (let i = this.size - 1; i >= 0; i--) out.push(this.get(i)!);
    return out;
  }
}

// ── Core Predictor ─────────────────────────────────────────────────────────

type Bar = { open: number; high: number; low: number; close: number; volume: number };

export class StockSupportPredictor {
  private history: RingBuffer<Bar>;

  constructor(lookback = 500) {
    this.history = new RingBuffer<Bar>(lookback);
  }

  loadRaw(open: number, high: number, low: number, close: number, volume: number): void {
    this.history.push({ open, high, low, close, volume });
  }

  // 1. Dynamic MA Support (SMA n일 지지선)
  private calcMA(period: number, currentPrice: number): SupportLevel | null {
    if (this.history.length() < period) return null;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += this.history.get(i)!.close;
    const ma = sum / period;
    const current = currentPrice > 0 ? currentPrice : this.history.get(0)!.close;
    if (ma >= current) return null;
    const gap = (current - ma) / current;
    // 너무 먼 MA는 낮은 점수
    const score = Math.max(0, Math.round(60 - gap * 500));
    return {
      price: Math.round(ma),
      score,
      source: "DYNAMIC_MA",
      description: `SMA${period} 동적 지지선 (현재가 대비 ${(gap * 100).toFixed(1)}% 하방)`,
    };
  }

  // 2. Local Minima Clustering (스윙로우 클러스터링)
  private calcClusteredMinima(
    currentPrice: number,
    windowSize = 10,
    mergeThresholdPct = 0.02,
  ): SupportLevel[] {
    const candles = this.history.toArray();
    const n = candles.length;
    if (n < windowSize * 2 + 1) return [];

    const localMinima: number[] = [];
    for (let i = windowSize; i < n - windowSize; i++) {
      const low = candles[i].low;
      let isMin = true;
      for (let j = i - windowSize; j <= i + windowSize; j++) {
        if (j === i) continue;
        if (candles[j].low < low) { isMin = false; break; }
      }
      if (isMin) localMinima.push(low);
    }

    if (localMinima.length === 0) return [];

    // 거리 기반 밀집 클러스터링
    const clusters: { sum: number; count: number }[] = [];
    for (const low of localMinima) {
      let matched = false;
      for (const c of clusters) {
        if (Math.abs(low - c.sum / c.count) / (c.sum / c.count) <= mergeThresholdPct) {
          c.sum += low;
          c.count++;
          matched = true;
          break;
        }
      }
      if (!matched) clusters.push({ sum: low, count: 1 });
    }

    const current = currentPrice > 0 ? currentPrice : this.history.get(0)!.close;
    return clusters
      .map(c => ({
        price: Math.round(c.sum / c.count),
        score: Math.min(100, c.count * 20),
        source: "LOCAL_MINIMA" as const,
        description: `스윙로우 클러스터 (테스트 ${c.count}회)`,
      }))
      .filter(s => s.price < current)
      .sort((a, b) => b.score - a.score);
  }

  // 3. Volume Area Low (매물대 가치영역 하단, VAL)
  private calcVolumeAreaLow(
    currentPrice: number,
    numBuckets = 60,
    valueAreaPct = 0.70,
    recentDays = 60, // 최근 N일만 사용 (과거 극단값 제거)
  ): SupportLevel | null {
    const all = this.history.toArray();
    const candles = all.slice(0, Math.min(recentDays, all.length));
    if (candles.length === 0) return null;

    let minP = Infinity, maxP = -Infinity, totalVol = 0;
    for (const c of candles) {
      if (c.low < minP) minP = c.low;
      if (c.high > maxP) maxP = c.high;
      totalVol += c.volume;
    }
    if (maxP === minP) return null;

    const bucketSize = (maxP - minP) / numBuckets;
    const buckets = new Float64Array(numBuckets);

    for (const c of candles) {
      const lo = Math.floor((c.low - minP) / bucketSize);
      const hi = Math.min(numBuckets - 1, Math.floor((c.high - minP) / bucketSize));
      const share = c.volume / Math.max(1, hi - lo + 1);
      for (let i = lo; i <= hi; i++) buckets[i] += share;
    }

    // POC 탐색
    let maxVol = -1, pocIdx = 0;
    for (let i = 0; i < numBuckets; i++) {
      if (buckets[i] > maxVol) { maxVol = buckets[i]; pocIdx = i; }
    }

    // Value Area 70% 확장
    const targetVol = totalVol * valueAreaPct;
    let accumulated = buckets[pocIdx];
    let lowerIdx = pocIdx, upperIdx = pocIdx;

    while (accumulated < targetVol) {
      const nextLo = lowerIdx > 0 ? buckets[lowerIdx - 1] : -1;
      const nextHi = upperIdx < numBuckets - 1 ? buckets[upperIdx + 1] : -1;
      if (nextLo < 0 && nextHi < 0) break;
      if (nextLo >= nextHi) { lowerIdx--; accumulated += nextLo; }
      else { upperIdx++; accumulated += nextHi; }
    }

    const valPrice = Math.round(minP + lowerIdx * bucketSize);
    const current = currentPrice > 0 ? currentPrice : this.history.get(0)!.close;
    if (valPrice >= current) return null;

    return {
      price: valPrice,
      score: 75,
      source: "VOLUME_VAL",
      description: `매물대 가치영역 하단 VAL (총 거래량의 ${Math.round(valueAreaPct * 100)}% 구간 하단)`,
    };
  }

  // 4. Pivot Points (전일 고/저/종가 기반 단기 지지선)
  private calcPivotPoints(currentPrice: number): SupportLevel[] {
    if (this.history.length() < 2) return [];
    const prev = this.history.get(1)!; // 전일봉 (0이 당일)
    const pivot = (prev.high + prev.low + prev.close) / 3;
    const s1 = 2 * pivot - prev.high;
    const s2 = pivot - (prev.high - prev.low);
    const s3 = prev.low - 2 * (prev.high - pivot);
    const current = currentPrice > 0 ? currentPrice : this.history.get(0)!.close;
    return [
      { price: Math.round(s1), score: 55, source: "LOCAL_MINIMA" as const, description: "피벗 지지1 (S1)" },
      { price: Math.round(s2), score: 45, source: "LOCAL_MINIMA" as const, description: "피벗 지지2 (S2)" },
      { price: Math.round(s3), score: 35, source: "LOCAL_MINIMA" as const, description: "피벗 지지3 (S3)" },
    ].filter(s => s.price < current && s.price > 0);
  }

  // 통합: 근접 지지가격 병합 + 스코어 내림차순
  predict(currentPrice = 0, tolerancePct = 0.015): SupportLevel[] {
    const candidates: SupportLevel[] = [];

    // MA 20, 60, 120일
    for (const period of [20, 60, 120]) {
      const ma = this.calcMA(period, currentPrice);
      if (ma) candidates.push(ma);
    }

    // 스윙로우 클러스터 (windowSize=5로 민감도 높임, 상위 5개)
    const minima = this.calcClusteredMinima(currentPrice, 5);
    candidates.push(...minima.slice(0, 5));

    // VAL
    const val = this.calcVolumeAreaLow(currentPrice);
    if (val) candidates.push(val);

    // 피벗 포인트 (단기)
    const pivots = this.calcPivotPoints(currentPrice);
    candidates.push(...pivots);

    // 근접 가격대 병합
    const integrated: SupportLevel[] = [];
    for (const cand of candidates) {
      let merged = false;
      for (const existing of integrated) {
        if (Math.abs(cand.price - existing.price) / existing.price <= tolerancePct) {
          const w1 = existing.score, w2 = cand.score;
          existing.price = Math.round((existing.price * w1 + cand.price * w2) / (w1 + w2));
          existing.score = Math.min(100, existing.score + Math.round(cand.score * 0.4));
          existing.source = "INTEGRATED";
          existing.description += ` / ${cand.description}`;
          merged = true;
          break;
        }
      }
      if (!merged) integrated.push({ ...cand });
    }

    return integrated.sort((a, b) => b.score - a.score);
  }
}

// ── Put Wall (KOSPI200 풋옵션 OI → 개별종목 환산) ─────────────────────────

// KOSPI200 내 주요 종목 비중 (%) — 삼성전자가 ~30%
const KOSPI200_WEIGHT: Record<string, number> = {
  "005930": 0.30,  // 삼성전자
  "000660": 0.07,  // SK하이닉스
  "373220": 0.04,  // LG에너지솔루션
  "207940": 0.03,  // 삼성바이오로직스
  "005380": 0.03,  // 현대차
};

function convertKospi200PutWallToStock(
  chain: OptionRow[],
  k200Spot: number,
  stockPrice: number,
  weight: number,
): SupportLevel[] {
  // 현재가 아래 행사가의 풋옵션만 필터
  const putsBelowSpot = chain.filter(r => r.strike < k200Spot && r.putOI > 0);
  if (putsBelowSpot.length === 0) return [];

  const maxOI = Math.max(...putsBelowSpot.map(r => r.putOI));
  const maxVol = Math.max(1, ...putsBelowSpot.map(r => r.putVolume));

  // OI 70% + 거래량 30% 가중 스코어 (PDF 공식)
  const scored = putsBelowSpot.map(r => ({
    strike: r.strike,
    score: (r.putOI / maxOI) * 0.7 + (r.putVolume / maxVol) * 0.3,
    putOI: r.putOI,
    putVol: r.putVolume,
  }));

  // 상위 5개 Put Wall 추출
  scored.sort((a, b) => b.score - a.score);
  const topWalls = scored.slice(0, 5);

  return topWalls.map(w => {
    // KOSPI200 행사가 → 개별종목 가격 환산
    // 종목가격 = 현재가 × (옵션행사가 / KOSPI200현재가)
    // 비율 변동분만 적용: stockPrice × (w.strike / k200Spot)
    const convertedPrice = Math.round(stockPrice * (w.strike / k200Spot));
    const pctOI = ((w.putOI / maxOI) * 100).toFixed(0);

    return {
      price: convertedPrice,
      score: Math.round(w.score * 100),
      source: "PUT_WALL" as const,
      description: `풋옵션 매물대 (K200 행사가 ${w.strike}, OI ${w.putOI.toLocaleString()}계약, 상대 ${pctOI}%)`,
    };
  });
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function analyzeStockSupport(
  symbol: string,
  lookbackDays = 100,
): Promise<StockSupportResult> {
  // 캔들/현재가/옵션체인 동시 호출
  const [candles, currentPrice, optionResult] = await Promise.all([
    fetchKisCandles(symbol, lookbackDays),
    fetchKisCurrentPrice(symbol),
    fetchKrxOptionChain().catch(() => null),
  ]);

  const price = currentPrice || (candles[0]?.close ?? 0);

  const predictor = new StockSupportPredictor(lookbackDays + 50);
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    predictor.loadRaw(c.open, c.high, c.low, c.close, c.volume);
  }

  // 기술적 지지선
  const techSupports = predictor.predict(price);

  // 풋옵션 Put Wall 지지선
  let putWallSupports: SupportLevel[] = [];
  const weight = KOSPI200_WEIGHT[symbol] ?? 0;
  if (optionResult && weight > 0) {
    putWallSupports = convertKospi200PutWallToStock(
      optionResult.chain,
      optionResult.spotPrice,
      price,
      weight,
    );
  }

  // 통합: Put Wall + 기술적 병합
  const all = [...putWallSupports, ...techSupports];
  const merged: SupportLevel[] = [];
  for (const cand of all) {
    let found = false;
    for (const existing of merged) {
      if (Math.abs(cand.price - existing.price) / existing.price <= 0.015) {
        const w1 = existing.score, w2 = cand.score;
        existing.price = Math.round((existing.price * w1 + cand.price * w2) / (w1 + w2));
        existing.score = Math.min(100, existing.score + Math.round(cand.score * 0.5));
        existing.source = "INTEGRATED";
        existing.description += ` / ${cand.description}`;
        found = true;
        break;
      }
    }
    if (!found) merged.push({ ...cand });
  }

  // -40% 필터 + 내림차순
  const filtered = merged
    .filter(s => (price - s.price) / price <= 0.40 && s.price < price)
    .sort((a, b) => b.score - a.score);

  return {
    symbol,
    currentPrice: price,
    supports: filtered,
    timestamp: new Date().toISOString(),
  };
}

export function formatSupportReport(result: StockSupportResult): string {
  const { symbol, currentPrice, supports } = result;
  const lines: string[] = [
    `📊 ${symbol} 개별종목 지지선 분석`,
    `현재가: ${currentPrice.toLocaleString()}원`,
    `분석 지지선 ${supports.length}개:`,
    "",
  ];

  const sourceIcon: Record<string, string> = {
    PUT_WALL: "🟣",
    DYNAMIC_MA: "📈",
    LOCAL_MINIMA: "🔵",
    VOLUME_VAL: "📦",
    INTEGRATED: "⭐",
  };

  for (const s of supports) {
    const gap = ((currentPrice - s.price) / currentPrice * 100).toFixed(1);
    const icon = sourceIcon[s.source] ?? "•";
    lines.push(
      `${icon} ${s.price.toLocaleString()}원 [신뢰도 ${s.score}] (현재가 -${gap}%)\n   └ ${s.description}`,
    );
  }

  return lines.join("\n");
}
