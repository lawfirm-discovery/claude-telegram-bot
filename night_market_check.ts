// 야간선물 + 옵션 현황 체크 — 예측 보완용
// 야간선물: Yahoo Finance (CME S&P500/나스닥/닛케이 선물 + KRW/USD) → 야간 분위기 지수
// 옵션: KRX 크롤러 (buildOptionsSignal) → 신선 MaxPain/GEX/PCR

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

for (const line of readFileSync(".env", "utf-8").split("\n")) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = m[2];
}

import { buildOptionsSignal } from "./src/options-analysis";

// ── 야간 분위기 지수 ─────────────────────────────────────────────────────────

interface NightMarketAsset {
  symbol: string;
  name: string;
  price: number;
  prevClose: number;
  changePct: number;
  exchangeName: string;
}

async function fetchYahooQuote(symbol: string): Promise<{ price: number; prevClose: number; exchange: string } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const m = result.meta;
    return {
      price: m.regularMarketPrice ?? 0,
      prevClose: m.chartPreviousClose ?? m.previousClose ?? 0,
      exchange: m.exchangeName ?? "",
    };
  } catch {
    return null;
  }
}

async function getNightMarket(): Promise<{
  assets: NightMarketAsset[];
  mood: "RISK_ON" | "RISK_OFF" | "NEUTRAL";
  moodScore: number;
  summary: string;
}> {
  const targets = [
    { symbol: "ES=F",    name: "S&P500 선물 (CME)",   weight: 2 },
    { symbol: "NQ=F",    name: "나스닥100 선물 (CME)", weight: 2 },
    { symbol: "NK=F",    name: "닛케이225 선물 (CME)", weight: 1.5 },
    { symbol: "^KS200",  name: "KOSPI200 지수",        weight: 2 },
    { symbol: "KRW=X",   name: "원/달러 환율",         weight: 1 },
    { symbol: "GC=F",    name: "금 선물 (안전자산)",   weight: 0.5 },
    { symbol: "VIX",     name: "VIX 공포지수",         weight: 1 },
  ];

  const assets: NightMarketAsset[] = [];
  await Promise.all(targets.map(async (t) => {
    const q = await fetchYahooQuote(t.symbol);
    if (!q || q.price === 0) return;
    const changePct = q.prevClose > 0 ? (q.price - q.prevClose) / q.prevClose * 100 : 0;
    assets.push({ symbol: t.symbol, name: t.name, price: q.price, prevClose: q.prevClose, changePct, exchangeName: q.exchange });
  }));

  // 야간 분위기 스코어 계산
  let moodScore = 0;
  const details: string[] = [];

  const sp = assets.find(a => a.symbol === "ES=F");
  const nq = assets.find(a => a.symbol === "NQ=F");
  const nk = assets.find(a => a.symbol === "NK=F");
  const ks = assets.find(a => a.symbol === "^KS200");
  const krw = assets.find(a => a.symbol === "KRW=X");
  const vix = assets.find(a => a.symbol === "VIX");
  const gold = assets.find(a => a.symbol === "GC=F");

  // S&P500 선물 방향 (가중치 2)
  if (sp) {
    moodScore += sp.changePct * 2;
    details.push(`S&P500: ${sp.changePct > 0 ? "+" : ""}${sp.changePct.toFixed(2)}%`);
  }
  // 나스닥 (반도체/AI 민감 → 코스피 상관 높음)
  if (nq) {
    moodScore += nq.changePct * 2;
    details.push(`나스닥: ${nq.changePct > 0 ? "+" : ""}${nq.changePct.toFixed(2)}%`);
  }
  // 닛케이 (아시아 프록시)
  if (nk) {
    moodScore += nk.changePct * 1.5;
    details.push(`닛케이: ${nk.changePct > 0 ? "+" : ""}${nk.changePct.toFixed(2)}%`);
  }
  // KRW/USD — 원화 강세 = 코스피 우호
  if (krw) {
    // KRW=X 상승 = 달러 강세 = 원화 약세 = 코스피 불리
    moodScore += krw.changePct * -1;
    details.push(`원/달러: ${krw.price.toFixed(1)} (${krw.changePct > 0 ? "달러강세▲" : "원화강세▼"})`);
  }
  // VIX — 하락 = 공포 감소 = 좋음
  if (vix) {
    moodScore += vix.changePct * -0.5;
    details.push(`VIX: ${vix.price.toFixed(2)} (${vix.changePct > 0 ? "공포↑" : "안정↓"} ${vix.changePct.toFixed(1)}%)`);
  }

  let mood: "RISK_ON" | "RISK_OFF" | "NEUTRAL";
  if (moodScore >= 3) mood = "RISK_ON";
  else if (moodScore <= -3) mood = "RISK_OFF";
  else mood = "NEUTRAL";

  const summary = `야간 분위기 스코어: ${moodScore.toFixed(1)} → ${mood} (${details.join(" | ")})`;

  return { assets, mood, moodScore, summary };
}

// ── 메인 ──────────────────────────────────────────────────────────────────────

async function main() {
  const kst = new Date(Date.now() + 9 * 3600_000);
  const kstStr = `${kst.toISOString().slice(0,10)} ${kst.toISOString().slice(11,16)} KST`;

  console.log(`\n🌙 야간선물 + 옵션 현황 체크 — ${kstStr}`);
  console.log("=".repeat(55));

  // 1. 야간 분위기
  console.log("\n[1/2] 야간선물 분위기 수집 중...");
  const night = await getNightMarket();

  // 2. 옵션 신선 데이터
  console.log("[2/2] KRX 옵션 체인 크롤링 중...");
  let opts: any = null;
  try {
    opts = await buildOptionsSignal();
    // 캐시 업데이트
    const cachePath = join(import.meta.dir, ".lemonclaw/options_signal.json");
    writeFileSync(cachePath, JSON.stringify(opts, null, 2));
    console.log(`  옵션 업데이트 완료 → ${cachePath}`);
  } catch (e: any) {
    console.error(`  옵션 크롤링 실패: ${e.message}`);
  }

  // ── 출력 ──────────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(55));
  console.log("🌙 야간선물 현황\n");

  const moodIcon = night.mood === "RISK_ON" ? "🟢" : night.mood === "RISK_OFF" ? "🔴" : "🟡";
  console.log(`${moodIcon} 분위기: ${night.mood}  (스코어: ${night.moodScore.toFixed(1)})`);
  console.log("");
  for (const a of night.assets) {
    const arrow = a.changePct > 0.3 ? "▲" : a.changePct < -0.3 ? "▼" : "─";
    const pct = `${a.changePct > 0 ? "+" : ""}${a.changePct.toFixed(2)}%`;
    console.log(`  ${arrow} ${a.name}: ${a.symbol === "KRW=X" ? a.price.toFixed(1) : a.price.toLocaleString("ko-KR", { maximumFractionDigits: 2 })} (${pct})`);
  }

  if (opts) {
    console.log("\n📊 옵션 현황 (오늘 신선 데이터)\n");
    console.log(`  KOSPI200 스팟: ${opts.spotPrice.toFixed(2)}`);
    console.log(`  MaxPain: ${opts.maxPain.toFixed(2)} (괴리 ${opts.maxPainDiffPct.toFixed(2)}%)`);
    console.log(`  GEX: ${opts.gex.toFixed(1)}B ${opts.gex < 0 ? "(음수→추세장)" : "(양수→횡보장)"}`);
    console.log(`  PCR: ${opts.pcr.toFixed(3)} ${opts.pcr > 1.2 ? "(풋우위→헤지과잉)" : opts.pcr < 0.8 ? "(콜우위→낙관)" : "(균형)"}`);
    console.log(`  외인 콜순매수: ${opts.foreignFlow.foreignCallNet} | 풋순매수: ${opts.foreignFlow.foreignPutNet}`);
    console.log(`  만기: ${opts.weeklyExpiry} (D-${opts.daysToExpiry})`);
    console.log(`  방향 점수: ${opts.score} → ${opts.direction.toUpperCase()}`);
    console.log(`  ${opts.details.join("\n  ")}`);
  }

  console.log("\n" + "=".repeat(55));

  // 리턴값 (예측 통합용)
  return { night, opts };
}

const result = await main();

// JSON 출력 (파이프 활용)
process.stdout.write("\n__JSON__\n" + JSON.stringify(result, null, 2) + "\n");
