import { readFileSync } from "fs";

for (const line of readFileSync(".env", "utf-8").split("\n")) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = m[2];
}

import type { Candle } from "./src/stock";

const KIS_BASE = "https://openapi.koreainvestment.com:9443";

let cachedToken: string | null = null;
async function getKisToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const res = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
    }),
  });
  const data = await res.json() as any;
  if (!res.ok) throw new Error(`KIS 토큰 실패: ${res.status} ${data.error_description}`);
  cachedToken = data.access_token;
  return cachedToken!;
}

async function getKisCandles(symbol: string, startDate: string, endDate: string): Promise<Candle[]> {
  const token = await getKisToken();
  const url = new URL(`${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`);
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", symbol);
  url.searchParams.set("FID_INPUT_DATE_1", startDate);
  url.searchParams.set("FID_INPUT_DATE_2", endDate);
  url.searchParams.set("FID_PERIOD_DIV_CODE", "D");
  url.searchParams.set("FID_ORG_ADJ_PRC", "1");
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      appkey: process.env.KIS_APP_KEY!,
      appsecret: process.env.KIS_APP_SECRET!,
      tr_id: "FHKST03010100",
    },
  });
  const data = await res.json() as any;
  return (data.output2 ?? [])
    .filter((r: any) => r.stck_clpr && r.stck_clpr !== "0")
    .map((r: any) => ({
      timestamp: `${r.stck_bsop_date.slice(0,4)}-${r.stck_bsop_date.slice(4,6)}-${r.stck_bsop_date.slice(6,8)}`,
      openPrice: parseInt(r.stck_oprc),
      highPrice: parseInt(r.stck_hgpr),
      lowPrice: parseInt(r.stck_lwpr),
      closePrice: parseInt(r.stck_clpr),
      volume: parseInt(r.acml_vol),
    }));
}

async function getCandles200(symbol: string): Promise<Candle[]> {
  const [c1, c2] = await Promise.all([
    getKisCandles(symbol, "20250710", "20260110"),
    getKisCandles(symbol, "20260110", "20260710"),
  ]);
  const all = [...c1, ...c2];
  const seen = new Set<string>();
  return all
    .filter(c => { if (seen.has(c.timestamp)) return false; seen.add(c.timestamp); return true; })
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// 인라인 디버그 스캐너
function debugScan(symbol: string, name: string, dailyCandles: Candle[]) {
  const sorted = [...dailyCandles].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const n = sorted.length;

  // 최근 30일 가격 흐름 출력
  const recent = sorted.slice(-30);
  console.log(`\n최근 30일 가격 (${recent[0]!.timestamp} ~ ${recent.at(-1)!.timestamp}):`);
  for (const c of recent) {
    const tag = c.timestamp >= "2026-07-03" ? " ◀" : "";
    console.log(`  ${c.timestamp}  종가:${c.closePrice.toLocaleString("ko-KR")}  저가:${c.lowPrice.toLocaleString("ko-KR")}  거래량:${(c.volume/1000).toFixed(0)}K${tag}`);
  }

  // Swing Low 탐지 (최근 30일)
  const window = sorted.slice(-35);
  console.log("\nSwing Low 탐지:");
  for (let i = 2; i < window.length - 1; i++) {
    const prev = window[i - 1]!;
    const curr = window[i]!;
    const next = window[i + 1]!;
    const isPrevSwing = prev.lowPrice < curr.lowPrice && prev.lowPrice < window[i-2]!.lowPrice;
    if (isPrevSwing && curr.timestamp >= "2026-06-01") {
      console.log(`  → ${prev.timestamp} 저가 ${prev.lowPrice.toLocaleString("ko-KR")} (Swing Low)`);
    }
  }

  // 최근 저점과 현재 거리
  const last = sorted.at(-1)!;
  const minLow = Math.min(...sorted.slice(-30).map(c => c.lowPrice));
  const minDate = sorted.slice(-30).find(c => c.lowPrice === minLow)?.timestamp;
  const reboundFromMin = (last.closePrice - minLow) / minLow * 100;
  console.log(`\n최근 30일 최저가: ${minLow.toLocaleString("ko-KR")}원 (${minDate})`);
  console.log(`현재가 기준 반등: +${reboundFromMin.toFixed(1)}%`);
  console.log(`어제(07-09) 종가: ${sorted.find(c => c.timestamp === "2026-07-09")?.closePrice.toLocaleString("ko-KR") ?? "데이터없음"}원`);

  // ADX 간략 계산 (최근 20일)
  const slice = sorted.slice(-25);
  let sumDX = 0, cnt = 0;
  for (let i = 1; i < slice.length; i++) {
    const c = slice[i]!, p = slice[i-1]!;
    const up = c.highPrice - p.highPrice;
    const dn = p.lowPrice - c.lowPrice;
    const plusDM = up > dn && up > 0 ? up : 0;
    const minusDM = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(c.highPrice - c.lowPrice, Math.abs(c.highPrice - p.closePrice), Math.abs(c.lowPrice - p.closePrice));
    if (tr > 0) {
      const plusDI = plusDM / tr * 100;
      const minusDI = minusDM / tr * 100;
      const diSum = plusDI + minusDI;
      if (diSum > 0) { sumDX += Math.abs(plusDI - minusDI) / diSum * 100; cnt++; }
    }
  }
  console.log(`ADX 근사값 (단순평균): ${cnt > 0 ? (sumDX/cnt).toFixed(1) : "N/A"} (< 20이면 무방향성)`);
}

const STOCKS = [
  { symbol: "005930", name: "삼성전자" },
  { symbol: "000660", name: "SK하이닉스" },
];

console.log("KIS 토큰 발급 중...");
await getKisToken();
console.log("완료\n");

for (const stock of STOCKS) {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`${stock.name} (${stock.symbol}) 바닥 분석`);
  console.log("=".repeat(50));
  const candles = await getCandles200(stock.symbol);
  debugScan(stock.symbol, stock.name, candles);
  await new Promise(r => setTimeout(r, 400));
}
