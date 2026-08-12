import { readFileSync } from "fs";

for (const line of readFileSync(".env", "utf-8").split("\n")) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = m[2];
}

import type { Candle } from "./src/stock";
import { detectBottomSignals } from "./src/bottom-signal";

const KIS_BASE = "https://openapi.koreainvestment.com:9443";

async function getKisToken(): Promise<string> {
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
  if (!res.ok) throw new Error(`KIS 토큰 실패: ${res.status}`);
  return data.access_token;
}

async function getKisCandles(token: string, symbol: string, startDate: string, endDate: string): Promise<Candle[]> {
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
  const rows: any[] = data.output2 ?? [];

  return rows
    .filter(r => r.stck_clpr && r.stck_clpr !== "0")
    .map(r => ({
      timestamp: `${r.stck_bsop_date.slice(0, 4)}-${r.stck_bsop_date.slice(4, 6)}-${r.stck_bsop_date.slice(6, 8)}`,
      openPrice: parseInt(r.stck_oprc),
      highPrice: parseInt(r.stck_hgpr),
      lowPrice: parseInt(r.stck_lwpr),
      closePrice: parseInt(r.stck_clpr),
      volume: parseInt(r.acml_vol),
    }));
}

// 두 구간 나눠 200일치 확보 (KIS는 한번에 최대 100건)
async function getCandles200(token: string, symbol: string): Promise<Candle[]> {
  const [c1, c2] = await Promise.all([
    getKisCandles(token, symbol, "20250710", "20260110"),
    getKisCandles(token, symbol, "20260110", "20260710"),
  ]);
  const all = [...c1, ...c2];
  const seen = new Set<string>();
  return all.filter(c => { if (seen.has(c.timestamp)) return false; seen.add(c.timestamp); return true; })
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

const KR_STOCKS = [
  { symbol: "005930", name: "삼성전자" },
  { symbol: "000660", name: "SK하이닉스" },
  { symbol: "005380", name: "현대차" },
  { symbol: "373220", name: "LG에너지솔루션" },
  { symbol: "006400", name: "삼성SDI" },
  { symbol: "035420", name: "NAVER" },
  { symbol: "035720", name: "카카오" },
  { symbol: "051910", name: "LG화학" },
  { symbol: "105560", name: "KB금융" },
  { symbol: "012450", name: "한화에어로스페이스" },
  { symbol: "047810", name: "한국항공우주" },
  { symbol: "003670", name: "포스코퓨처엠" },
];

const TARGET_DATE = "2026-07-09";
const WINDOW_START = "2026-07-03";

console.log("KIS 토큰 발급 중...");
const token = await getKisToken();
console.log("토큰 발급 완료\n");

const results: any[] = [];

for (const stock of KR_STOCKS) {
  try {
    process.stdout.write(`스캔: ${stock.name} (${stock.symbol})... `);
    const candles = await getCandles200(token, stock.symbol);
    process.stdout.write(`캔들 ${candles.length}개\n`);

    const signals = detectBottomSignals(stock.symbol, stock.name, "KR", candles);
    const recent = signals.filter(s => s.date >= WINDOW_START && s.date <= TARGET_DATE);
    for (const s of recent) results.push(s);

    await new Promise(r => setTimeout(r, 300));
  } catch (e: any) {
    console.error(`  실패: ${e.message}`);
  }
}

console.log("\n════════════════════════════════════════");
console.log(`국내 주도주 바닥 저점 포착 스캔 결과`);
console.log(`기간: ${WINDOW_START} ~ ${TARGET_DATE} (어제)`);
console.log("════════════════════════════════════════");

if (results.length === 0) {
  console.log("해당 기간 내 신호 없음");
} else {
  for (const s of results) {
    const tag = s.date === TARGET_DATE ? " ★어제★" : "";
    console.log(`\n[${s.date}]${tag} ${s.name} (${s.symbol})`);
    console.log(`  현재가: ${s.price.toLocaleString("ko-KR")}원  바닥가: ${s.bottomPrice.toLocaleString("ko-KR")}원  반등: +${(s.reboundRatio * 100).toFixed(1)}%`);
    console.log(`  거래량비: ${(s.volumeRatio * 100).toFixed(0)}%  ADX: ${s.adx.toFixed(1)}`);
    console.log(`  스퀴즈=${s.filters.squeezed ? "✅" : "❌"}  거래량건조=${s.filters.volumeDriedUp ? "✅" : "❌"}  가격압축=${s.filters.consolidating ? "✅" : "❌"}`);
    console.log(`  ${s.reason}`);
  }
}
console.log("\n════════════════════════════════════════");
