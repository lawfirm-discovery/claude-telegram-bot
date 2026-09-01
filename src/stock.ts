const KIS_BASE = "https://openapi.koreainvestment.com:9443";

// ── Token Cache ──────────────────────────────────────────────────────────────

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const KIS_TOKEN_FILE = join(import.meta.dir, "../.lemonclaw/kis_token.json");
let kisToken: { value: string; expiresAt: number } | null = null;

// 디스크 캐시에서 토큰 복원
try {
  if (existsSync(KIS_TOKEN_FILE)) {
    const cached = JSON.parse(readFileSync(KIS_TOKEN_FILE, "utf-8"));
    if (cached.expiresAt > Date.now()) {
      kisToken = cached;
    }
  }
} catch {}

export async function getKisToken(): Promise<string> {
  const appKey = process.env.KIS_APP_KEY;
  const appSecret = process.env.KIS_APP_SECRET;
  if (!appKey || !appSecret) throw new Error("KIS_APP_KEY / KIS_APP_SECRET 미설정");

  if (kisToken && Date.now() < kisToken.expiresAt - 60_000) return kisToken.value;

  const res = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: appKey, appsecret: appSecret }),
  });
  if (!res.ok) throw new Error(`KIS 토큰 발급 실패: ${res.status}`);
  const data = await res.json() as { access_token: string; expires_in: number };
  kisToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  try { writeFileSync(KIS_TOKEN_FILE, JSON.stringify(kisToken)); } catch {}
  return kisToken.value;
}

// ── KIS GET helper ────────────────────────────────────────────────────────────

async function kisGet(path: string, trId: string, params: Record<string, string>): Promise<any> {
  const token = await getKisToken();
  const appKey = process.env.KIS_APP_KEY!;
  const appSecret = process.env.KIS_APP_SECRET!;

  const url = new URL(`${KIS_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: trId,
    },
  });
  if (!res.ok) throw new Error(`KIS API 오류 [${trId}]: HTTP ${res.status}`);
  const data = await res.json() as any;
  if (data.rt_cd !== "0") throw new Error(`KIS API 오류 [${trId}]: ${data.msg1}`);
  return data;
}

// ── Symbol helpers ────────────────────────────────────────────────────────────

function isKrSymbol(symbol: string): boolean {
  return /^\d{6}$/.test(symbol);
}

function dateToStr(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type Candle = {
  timestamp: string;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  volume: number;
};

export type PriceInfo = {
  symbol: string;
  lastPrice: number;
  currency: string;
  timestamp: string;
};

export type OrderbookLevel = { price: number; volume: number };
export type Orderbook = { asks: OrderbookLevel[]; bids: OrderbookLevel[] };

// ── getPrices ─────────────────────────────────────────────────────────────────

export async function getPrices(symbols: string[]): Promise<PriceInfo[]> {
  const results: PriceInfo[] = [];
  for (const symbol of symbols) {
    if (isKrSymbol(symbol)) {
      const data = await kisGet(
        "/uapi/domestic-stock/v1/quotations/inquire-price",
        "FHKST01010100",
        { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: symbol },
      );
      results.push({
        symbol,
        lastPrice: parseInt(data.output?.stck_prpr || "0", 10),
        currency: "KRW",
        timestamp: new Date().toISOString(),
      });
    } else {
      // US 주식
      const data = await kisGet(
        "/uapi/overseas-price/v1/quotations/price",
        "HHDFS00000300",
        { AUTH: "", EXCD: "NAS", SYMB: symbol },
      );
      results.push({
        symbol,
        lastPrice: parseFloat(data.output?.last || "0"),
        currency: "USD",
        timestamp: new Date().toISOString(),
      });
    }
  }
  return results;
}

// ── getCandles ────────────────────────────────────────────────────────────────

// YYYYMMDD → "YYYY-MM-DD" (KIS 일봉 timestamp)
function kisDailyTs(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

// Naver 분봉 XML 파싱 (YYYYMMDDHHmm|open|high|low|close|volume)
// Naver는 close/volume만 제공하므로 open/high/low = close로 설정
async function getNaverIntraday(symbol: string, count: number): Promise<Candle[]> {
  const res = await fetch(
    `https://fchart.stock.naver.com/sise.nhn?symbol=${symbol}&timeframe=minute&count=${count}&requestType=0`,
    { headers: { "User-Agent": "Mozilla/5.0 (compatible; bot)" }, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(`Naver 분봉 오류: ${res.status}`);

  const xml = await res.text();
  const matches = xml.matchAll(/<item data="([^"]+)"/g);
  const candles: Candle[] = [];

  for (const m of matches) {
    const parts = m[1]!.split("|");
    if (parts.length < 6) continue;

    const dt = parts[0]!; // YYYYMMDDHHmm (12 chars)
    const closeStr = parts[4];
    const volStr = parts[5];
    if (!closeStr || closeStr === "null") continue;

    const close = parseFloat(closeStr);
    const vol = parseInt(volStr === "null" ? "0" : (volStr ?? "0"), 10);
    if (close <= 0) continue;

    // KST 타임스탬프로 변환
    const ts = `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}T${dt.slice(8, 10)}:${dt.slice(10, 12)}:00+09:00`;
    candles.push({ timestamp: ts, openPrice: close, highPrice: close, lowPrice: close, closePrice: close, volume: vol });
  }

  // Naver는 오래된 것부터 반환 → 최신 우선으로 뒤집기
  candles.reverse();
  return candles.slice(0, count);
}

// 국내 일봉 — 150일 단위로 최대 2페이지 (총 ~200 영업일)
async function getKrDailyCandles(symbol: string, count: number): Promise<Candle[]> {
  const candles: Candle[] = [];
  const pages = count > 100 ? 2 : 1;

  for (let i = 0; i < pages && candles.length < count; i++) {
    const end = daysAgo(i * 150);
    const start = daysAgo((i + 1) * 150);

    const data = await kisGet(
      "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
      "FHKST03010100",
      {
        FID_COND_MRKT_DIV_CODE: "J",
        FID_INPUT_ISCD: symbol,
        FID_INPUT_DATE_1: dateToStr(start),
        FID_INPUT_DATE_2: dateToStr(end),
        FID_PERIOD_DIV_CODE: "D",
        FID_ORG_ADJ_PRC: "0",
      },
    );

    const rows: any[] = data.output2 ?? [];
    for (const r of rows) {
      if (!r.stck_bsop_date) continue;
      candles.push({
        timestamp: kisDailyTs(r.stck_bsop_date),
        openPrice: parseInt(r.stck_oprc || "0", 10),
        highPrice: parseInt(r.stck_hgpr || "0", 10),
        lowPrice: parseInt(r.stck_lwpr || "0", 10),
        closePrice: parseInt(r.stck_clpr || "0", 10),
        volume: parseInt(r.acml_vol || "0", 10),
      });
    }

    if (rows.length < 50) break; // 데이터 없으면 중단
  }

  return candles.slice(0, count); // KIS는 이미 최신 우선 반환
}

// 미국 일봉 — KIS 해외 API (최대 100캔들)
async function getUsDailyCandles(symbol: string, count: number): Promise<Candle[]> {
  const data = await kisGet(
    "/uapi/overseas-price/v1/quotations/dailyprice",
    "HHDFS76240000",
    { AUTH: "", EXCD: "NAS", SYMB: symbol, GUBN: "0", BYMD: "", MODYN: "Y", MODP: "0" },
  );

  const rows: any[] = data.output2 ?? [];
  return rows
    .filter(r => r.xymd)
    .map(r => ({
      timestamp: kisDailyTs(r.xymd),
      openPrice: parseFloat(r.open || "0"),
      highPrice: parseFloat(r.high || "0"),
      lowPrice: parseFloat(r.low || "0"),
      closePrice: parseFloat(r.clos || "0"),
      volume: parseInt(r.tvol || "0", 10),
    }))
    .slice(0, count);
}

export async function getCandles(
  symbol: string,
  interval: "1m" | "1d" = "1d",
  count = 200,
): Promise<Candle[]> {
  if (interval === "1m") {
    return getNaverIntraday(symbol, count);
  }
  if (isKrSymbol(symbol)) {
    return getKrDailyCandles(symbol, count);
  }
  return getUsDailyCandles(symbol, count);
}

// ── getOrderbook ──────────────────────────────────────────────────────────────

export async function getOrderbook(symbol: string): Promise<Orderbook> {
  const data = await kisGet(
    "/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn",
    "FHKST01010200",
    { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: symbol },
  );

  const o = data.output1 ?? {};
  const asks: OrderbookLevel[] = [];
  const bids: OrderbookLevel[] = [];

  for (let i = 1; i <= 10; i++) {
    const ap = parseInt(o[`askp${i}`] || "0", 10);
    const av = parseInt(o[`askp_rsqn${i}`] || "0", 10);
    const bp = parseInt(o[`bidp${i}`] || "0", 10);
    const bv = parseInt(o[`bidp_rsqn${i}`] || "0", 10);
    if (ap > 0) asks.push({ price: ap, volume: av });
    if (bp > 0) bids.push({ price: bp, volume: bv });
  }

  return { asks, bids };
}

// ── getStockInfo ──────────────────────────────────────────────────────────────

export async function getStockInfo(symbol: string): Promise<any> {
  if (!isKrSymbol(symbol)) {
    return { name: symbol, stockName: symbol, symbol };
  }
  const data = await kisGet(
    "/uapi/domestic-stock/v1/quotations/inquire-price",
    "FHKST01010100",
    { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: symbol },
  );
  const name = data.output?.hts_kor_isnm ?? symbol;
  return { name, stockName: name, symbol };
}

// ── getExchangeRate ───────────────────────────────────────────────────────────

export async function getExchangeRate(): Promise<number> {
  const res = await fetch("https://m.stock.naver.com/api/index/FX_USDKRW/basic", {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; bot)" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`환율 조회 실패: ${res.status}`);
  const d = await res.json() as any;
  return parseFloat(d.closePrice ?? d.currentPrice ?? "0");
}

// ── KIS API (수급 전용) ───────────────────────────────────────────────────────

export type InvestorTrend = {
  date: string;
  foreigner: number;  // 외국인 순매수
  institution: number; // 기관 순매수
  individual: number;  // 개인 순매수
  isEstimate?: boolean; // 장중 추정치 여부
};

function isMarketOpen(): boolean {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const day = kst.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = kst.getUTCHours();
  const m = kst.getUTCMinutes();
  const minutes = h * 60 + m;
  return minutes >= 9 * 60 && minutes < 15 * 60 + 30;
}

function todayKST(): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10).replace(/-/g, "");
}

// 장중 추정 수급 (HHPTJ04160200)
async function getInvestorTrendEstimate(symbol: string): Promise<InvestorTrend | null> {
  const token = await getKisToken();
  const appKey = process.env.KIS_APP_KEY!;
  const appSecret = process.env.KIS_APP_SECRET!;

  const url = new URL(`${KIS_BASE}/uapi/domestic-stock/v1/quotations/investor-trend-estimate`);
  url.searchParams.set("MKSC_SHRN_ISCD", symbol);

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: "HHPTJ04160200",
    },
  });
  if (!res.ok) return null;
  const data = await res.json() as any;

  const rows: any[] = data.output2 ?? data.output ?? [];
  if (rows.length === 0) return null;

  const r = rows[0];
  const foreigner = parseInt(r.frgn_ntby_qty ?? r.frgn_fake_ntby_qty ?? "0", 10);
  const institution = parseInt(r.orgn_ntby_qty ?? r.orgn_fake_ntby_qty ?? "0", 10);
  const individual = parseInt(r.prsn_ntby_qty ?? "0", 10) || -(foreigner + institution);

  return { date: todayKST(), foreigner, institution, individual, isEstimate: true };
}

// 확정 일별 수급 (FHKST01010900)
async function getInvestorTrendDaily(symbol: string): Promise<InvestorTrend[]> {
  const token = await getKisToken();
  const appKey = process.env.KIS_APP_KEY!;
  const appSecret = process.env.KIS_APP_SECRET!;

  const url = new URL(`${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-investor`);
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", symbol);

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: "FHKST01010900",
    },
  });
  if (!res.ok) throw new Error(`KIS 수급 조회 실패: ${res.status}`);
  const data = await res.json() as any;

  return (data.output ?? []).map((r: any) => ({
    date: r.stck_bsop_date,
    foreigner: parseInt(r.frgn_ntby_qty ?? "0", 10),
    institution: parseInt(r.orgn_ntby_qty ?? "0", 10),
    individual: parseInt(r.prsn_ntby_qty ?? "0", 10),
  }));
}

export async function getInvestorTrend(symbol: string): Promise<InvestorTrend[]> {
  const daily = await getInvestorTrendDaily(symbol);

  if (!isMarketOpen()) return daily;

  const today = todayKST();
  const estimate = await getInvestorTrendEstimate(symbol).catch(() => null);
  if (!estimate) return daily;

  const filtered = daily.filter(t => t.date !== today);
  return [estimate, ...filtered];
}

// ── KIS 선물 투자자별 포지션 (FHPST01060000) ────────────────────────────────

export type FuturesInvestorPosition = {
  date: string;
  foreignNet: number;
  instNet: number;
  individualNet: number;
};

export async function getFuturesInvestorPosition(): Promise<FuturesInvestorPosition | null> {
  const token = await getKisToken();
  const appKey = process.env.KIS_APP_KEY!;
  const appSecret = process.env.KIS_APP_SECRET!;

  const url = new URL(`${KIS_BASE}/uapi/domestic-futureoption/v1/quotations/inquire-futures-investor`);
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "F");
  url.searchParams.set("FID_INPUT_ISCD", "101W09");

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: "FHPST01060000",
    },
  });
  if (!res.ok) return null;
  const data = await res.json() as any;

  const rows: any[] = data.output ?? [];
  if (rows.length === 0) return null;

  let foreignNet = 0, instNet = 0, individualNet = 0;
  for (const r of rows) {
    const nm = r.mbcr_name ?? r.invst_name ?? "";
    const net = parseInt((r.ntby_qty ?? r.fut_ntby_qty ?? "0").replace(/,/g, ""), 10) || 0;
    if (nm.includes("외국인") || nm.includes("외인")) foreignNet += net;
    else if (nm.includes("기관") || nm.includes("금융투자")) instNet += net;
    else if (nm.includes("개인")) individualNet += net;
  }

  return { date: todayKST(), foreignNet, instNet, individualNet };
}

// ── Technical Indicators ─────────────────────────────────────────────────────

export type BBands = { upper: number; middle: number; lower: number };

export function calcBollingerBands(values: number[], period: number, k = 2.0): BBands {
  if (values.length < period) return { upper: NaN, middle: NaN, lower: NaN };
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period);
  return { upper: mean + k * std, middle: mean, lower: mean - k * std };
}

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(...new Array(period - 1).fill(NaN));
  result.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

export function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return NaN;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export type MACDResult = { macd: number; signal: number; histogram: number };

export function calcMACD(closes: number[], fast = 12, slow = 26, signal = 9): MACDResult {
  if (closes.length < slow + signal) return { macd: NaN, signal: NaN, histogram: NaN };
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const macdLine = fastEma.map((v, i) => v - (slowEma[i] ?? NaN)).filter(v => !isNaN(v));
  const signalLine = ema(macdLine, signal);
  const lastMacd = macdLine.at(-1)!;
  const lastSignal = signalLine.at(-1)!;
  return { macd: lastMacd, signal: lastSignal, histogram: lastMacd - lastSignal };
}

export type VolumeLevel = { priceFrom: number; priceTo: number; volume: number; bar: string };

export function calcVolumeProfile(candles: Candle[], bins = 10): VolumeLevel[] {
  if (candles.length === 0) return [];
  const prices = candles.map(c => c.closePrice);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const step = (maxP - minP) / bins || 1;
  const levels: { from: number; to: number; vol: number }[] = Array.from({ length: bins }, (_, i) => ({
    from: minP + i * step,
    to: minP + (i + 1) * step,
    vol: 0,
  }));
  for (const c of candles) {
    const idx = Math.min(Math.floor((c.closePrice - minP) / step), bins - 1);
    levels[idx]!.vol += c.volume;
  }
  const maxVol = Math.max(...levels.map(l => l.vol));
  return levels
    .sort((a, b) => b.vol - a.vol)
    .slice(0, 5)
    .map(l => ({
      priceFrom: Math.round(l.from),
      priceTo: Math.round(l.to),
      volume: l.vol,
      bar: "█".repeat(Math.round((l.vol / maxVol) * 8)),
    }));
}

// ── Report Builder ────────────────────────────────────────────────────────────

function fmt(n: number, decimals = 0): string {
  if (isNaN(n)) return "N/A";
  return n.toLocaleString("ko-KR", { maximumFractionDigits: decimals });
}

function rsiLabel(rsi: number): string {
  if (isNaN(rsi)) return "";
  if (rsi >= 70) return " ⚠️ 과매수";
  if (rsi <= 30) return " ⚠️ 과매도";
  return "";
}

function macdLabel(h: number): string {
  if (isNaN(h)) return "";
  return h > 0 ? " ▲ 상승" : " ▼ 하락";
}

export async function getStockReport(symbol: string): Promise<string> {
  const lines: string[] = [];
  const upperSymbol = symbol.toUpperCase();

  // 종목 기본 정보
  let stockName = upperSymbol;
  try {
    const info = await getStockInfo(upperSymbol);
    stockName = info.name ?? info.stockName ?? upperSymbol;
  } catch {}

  lines.push(`<b>${stockName} (${upperSymbol})</b>`);
  lines.push("");

  // 현재가
  try {
    const priceInfo = (await getPrices([upperSymbol]))[0];
    if (!priceInfo) throw new Error("가격 데이터 없음");
    const unit = priceInfo.currency === "USD" ? "$" : "₩";
    lines.push(`💰 현재가: <b>${unit}${fmt(priceInfo.lastPrice, priceInfo.currency === "USD" ? 2 : 0)}</b>`);
  } catch (e: any) {
    lines.push(`💰 현재가: 조회 실패 (${e.message})`);
  }

  // 캔들 기반 분석
  let candles: Candle[] = [];
  try {
    candles = await getCandles(upperSymbol, "1d", 200);
    candles = candles.reverse(); // 오래된 것 → 최신 순

    const last = candles.at(-1)!;
    const prev = candles.at(-2)!;
    const change = last.closePrice - prev.closePrice;
    const changePct = (change / prev.closePrice) * 100;
    const arrow = change >= 0 ? "▲" : "▼";

    lines.push(`${arrow} 전일대비: ${fmt(Math.abs(change))}원 (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)`);
    lines.push(`📊 거래량: ${fmt(last.volume)}주`);

    const tradingValue = last.closePrice * last.volume;
    lines.push(`💵 거래대금: ${fmt(tradingValue / 1_000_000)}백만원 (추정)`);

    lines.push("");
    lines.push("📈 기술적 지표");

    const closes = candles.map(c => c.closePrice);
    const rsi = calcRSI(closes);
    lines.push(`  RSI(14): ${fmt(rsi, 1)}${rsiLabel(rsi)}`);

    const macd = calcMACD(closes);
    lines.push(`  MACD: ${fmt(macd.macd, 2)} / Signal: ${fmt(macd.signal, 2)} / Hist: ${fmt(macd.histogram, 2)}${macdLabel(macd.histogram)}`);

    const bb22 = calcBollingerBands(closes, 22);
    const lastClose = last.closePrice;
    const bbPct = isNaN(bb22.upper) ? NaN : (lastClose - bb22.lower) / (bb22.upper - bb22.lower) * 100;
    lines.push(`  볼린저밴드(22): 상단 ${fmt(bb22.upper)} / 중심 ${fmt(bb22.middle)} / 하단 ${fmt(bb22.lower)}` +
      (isNaN(bbPct) ? "" : ` (밴드 내 위치 ${bbPct.toFixed(0)}%)`));

    lines.push("");
    lines.push("🏔 매물대 (상위 5구간)");
    const profile = calcVolumeProfile(candles);
    for (const lv of profile) {
      lines.push(`  ${fmt(lv.priceFrom)}~${fmt(lv.priceTo)}: ${lv.bar} (${fmt(lv.volume)}주)`);
    }
  } catch (e: any) {
    lines.push(`캔들 분석 실패: ${e.message}`);
  }

  // 수급 (KIS)
  lines.push("");
  const marketOpen = isMarketOpen();
  lines.push(`👥 수급 동향 (최근 5일, KIS${marketOpen ? " · 오늘=추정" : ""})`);
  const kisKey = process.env.KIS_APP_KEY;
  if (!kisKey) {
    lines.push("  ⚙️ KIS_APP_KEY 미설정 — .env에 KIS 자격증명 추가 필요");
  } else {
    try {
      const trends = await getInvestorTrend(upperSymbol);
      for (const t of trends.slice(0, 5)) {
        const f = t.foreigner >= 0 ? `+${fmt(t.foreigner)}` : fmt(t.foreigner);
        const inst = t.institution >= 0 ? `+${fmt(t.institution)}` : fmt(t.institution);
        const ind = t.individual >= 0 ? `+${fmt(t.individual)}` : fmt(t.individual);
        const tag = t.isEstimate ? " (추정)" : "";
        lines.push(`  ${t.date}${tag}: 외 ${f} / 기 ${inst} / 개 ${ind}`);
      }
    } catch (e: any) {
      lines.push(`  조회 실패: ${e.message}`);
    }
  }

  return lines.join("\n");
}
