// 내일 코스피 방향 예측
// 1. 옵션 시그널 (MaxPain / GEX / PCR / 외인flow)
// 2. 기관 디레버리징 조기경보 (주요 종목)
// 3. 바닥 신호 (Bottom Squeeze)
// 4. 코스피200 야간선물 (kred.dev)

import { readFileSync, existsSync } from "fs";
import { join } from "path";

for (const line of readFileSync(".env", "utf-8").split("\n")) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = m[2];
}

import type { Candle, InvestorTrend } from "./src/stock";
import { getKisToken, getCandles, getInvestorTrend } from "./src/stock";
import { detectSupplyDivergence, detectCorrelatedCrash, detectForcedLiquidation, evaluateDeleverageAlert } from "./src/deleverage-signal";
import { detectBottomSignals } from "./src/bottom-signal";

// ── 분석 대상 종목 ─────────────────────────────────────────────────────────
const KOSPI_STOCKS = [
  { symbol: "005930", name: "삼성전자" },
  { symbol: "000660", name: "SK하이닉스" },
  { symbol: "005380", name: "현대차" },
  { symbol: "373220", name: "LG에너지솔루션" },
  { symbol: "006400", name: "삼성SDI" },
  { symbol: "035420", name: "NAVER" },
  { symbol: "012450", name: "한화에어로스페이스" },
  { symbol: "003670", name: "포스코퓨처엠" },
  { symbol: "105560", name: "KB금융" },
  { symbol: "035720", name: "카카오" },
];

// ── 날짜 계산 ──────────────────────────────────────────────────────────────
function kstDate(offsetDays = 0): string {
  const d = new Date(Date.now() + 9 * 3600_000 + offsetDays * 86400_000);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

// ── KIS 캔들 (100일) ───────────────────────────────────────────────────────
async function fetchCandles(token: string, symbol: string): Promise<Candle[]> {
  const KIS_BASE = "https://openapi.koreainvestment.com:9443";
  const endDate = kstDate(0);
  const startDate = kstDate(-120);

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
      timestamp: `${r.stck_bsop_date.slice(0,4)}-${r.stck_bsop_date.slice(4,6)}-${r.stck_bsop_date.slice(6,8)}`,
      openPrice: parseInt(r.stck_oprc),
      highPrice: parseInt(r.stck_hgpr),
      lowPrice: parseInt(r.stck_lwpr),
      closePrice: parseInt(r.stck_clpr),
      volume: parseInt(r.acml_vol),
    }));
}

// ── 당일 수익률 계산 ───────────────────────────────────────────────────────
function lastDailyReturn(candles: Candle[]): number {
  const sorted = [...candles].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  if (sorted.length < 2) return 0;
  const last = sorted[sorted.length - 1]!;
  const prev = sorted[sorted.length - 2]!;
  return (last.closePrice - prev.closePrice) / prev.closePrice * 100;
}

// ── 옵션 캐시 로드 ─────────────────────────────────────────────────────────
function loadOptionsSignal(): any {
  const path = join(import.meta.dir, ".lemonclaw/options_signal.json");
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

// ── kred.dev 코스피200 야간선물 ─────────────────────────────────────────────
interface NightFuturesData {
  sessionDate: string;
  dayClose: number;
  lastClose: number;
  firstOpen: number;
  changePct: number;
  barCount: number;
}

async function fetchKredNightFutures(): Promise<NightFuturesData | null> {
  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      "Referer": "https://kred.dev/ko/kospi-200-night-futures",
    };
    const signal = AbortSignal.timeout(10000);

    const [statusRes, barsRes] = await Promise.all([
      fetch("https://kred.dev/futures-api/ohlc/status", { headers, signal }),
      fetch("https://kred.dev/futures-api/ohlc/bars", { headers, signal }),
    ]);

    if (!statusRes.ok || !barsRes.ok) return null;

    const status = await statusRes.json() as {
      session_date: string; day_close: number; bar_count: number;
    };
    const barsData = await barsRes.json() as {
      bars: { time: number; open: number; high: number; low: number; close: number; volume: number }[];
    };

    const bars = barsData.bars;
    if (!bars || bars.length < 30) return null;

    const sorted = [...bars].sort((a, b) => a.time - b.time);
    const firstBar = sorted[0]!;
    const lastBar = sorted[sorted.length - 1]!;
    const changePct = status.day_close > 0
      ? (lastBar.close - status.day_close) / status.day_close * 100
      : 0;

    return {
      sessionDate: status.session_date,
      dayClose: status.day_close,
      lastClose: lastBar.close,
      firstOpen: firstBar.open,
      changePct,
      barCount: bars.length,
    };
  } catch (e: any) {
    console.error(`[야간선물] kred.dev 조회 실패: ${e.message}`);
    return null;
  }
}

// ── 메인 예측 로직 ─────────────────────────────────────────────────────────
async function predictKospi() {
  const now = new Date(Date.now() + 9 * 3600_000);
  const todayStr = now.toISOString().slice(0, 10);
  const tomorrowDate = new Date(now);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  while (tomorrowDate.getDay() === 0 || tomorrowDate.getDay() === 6) {
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  }
  const tomorrowStr = tomorrowDate.toISOString().slice(0, 10);

  console.log(`\n📊 코스피 방향 예측 — ${tomorrowStr} (내일)`);
  console.log("=".repeat(50));

  // 1. 야간선물 조회
  const nightFutures = await fetchKredNightFutures();
  if (nightFutures) {
    console.log(`  야간선물 세션 ${nightFutures.sessionDate}: day_close=${nightFutures.dayClose} → ${nightFutures.lastClose} (${nightFutures.changePct > 0 ? "+" : ""}${nightFutures.changePct.toFixed(2)}%)`);
  } else {
    console.log("  야간선물: 데이터 없음 (세션 오프라인 또는 조회 실패)");
  }

  // 2. 옵션 시그널
  const opts = loadOptionsSignal();

  // 3. KIS 토큰 + 종목 분석
  let token: string;
  try {
    token = await getKisToken();
  } catch (e: any) {
    console.error(`KIS 토큰 실패: ${e.message}`);
    process.exit(1);
  }

  console.log(`\n[1/3] 종목 데이터 수집 중 (${KOSPI_STOCKS.length}개)...`);

  const stockReturns: { symbol: string; name: string; market: "KR"; dailyReturn: number }[] = [];
  const deleverageSignals: any[] = [];
  const bottomSignals: { symbol: string; name: string; count: number }[] = [];

  for (const stock of KOSPI_STOCKS) {
    try {
      await new Promise(r => setTimeout(r, 200)); // rate limit
      const candles = await fetchCandles(token, stock.symbol);
      if (candles.length < 25) {
        console.log(`  ${stock.name}: 데이터 부족`);
        continue;
      }

      const dailyReturn = lastDailyReturn(candles);
      stockReturns.push({ symbol: stock.symbol, name: stock.name, market: "KR", dailyReturn });

      // 투자자 트렌드 (수급)
      let trends: InvestorTrend[] = [];
      try {
        trends = await getInvestorTrend(stock.symbol);
      } catch {}

      // 디레버리징 신호
      const sig1 = detectSupplyDivergence(stock.symbol, stock.name, "KR", candles, trends);
      if (sig1) deleverageSignals.push(sig1);

      const sig3 = detectForcedLiquidation(stock.symbol, stock.name, "KR", candles);
      if (sig3) deleverageSignals.push(sig3);

      // 바닥 신호
      const bSigs = detectBottomSignals(stock.symbol, stock.name, "KR", candles);
      if (bSigs.length > 0) {
        const latest = bSigs[bSigs.length - 1]!;
        const sorted = [...candles].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        const lastDate = sorted[sorted.length - 1]!.timestamp.slice(0, 10);
        if (latest.date === lastDate) {
          bottomSignals.push({ symbol: stock.symbol, name: stock.name, count: bSigs.length });
        }
      }

      console.log(`  ${stock.name}: ${dailyReturn > 0 ? "+" : ""}${dailyReturn.toFixed(2)}% | 디레버: ${deleverageSignals.filter(s => s.symbol === stock.symbol).length}건 | 바닥: ${bottomSignals.filter(s => s.symbol === stock.symbol).length}건`);
    } catch (e: any) {
      console.log(`  ${stock.name}: 오류 — ${e.message}`);
    }
  }

  // 상관 급락 신호
  const correlatedSignals = detectCorrelatedCrash(stockReturns);
  const allDelev = [...deleverageSignals, ...correlatedSignals];
  const alert = evaluateDeleverageAlert(allDelev);

  // ── 종합 스코어 계산 ──────────────────────────────────────────────────────
  // +1 = 강력 상승 요인, -1 = 강력 하락 요인
  const scores: { factor: string; score: number; detail: string }[] = [];

  // avgReturn 미리 계산 (옵션 스코어링에서도 사용)
  const avgReturn = stockReturns.length > 0
    ? stockReturns.reduce((s, r) => s + r.dailyReturn, 0) / stockReturns.length
    : 0;

  // [A] 옵션 시그널
  if (opts) {
    // 오늘 날짜 기준으로 만기까지 남은 거래일 동적 계산
    const expiryMs = new Date(opts.weeklyExpiry).getTime();
    const todayMs = new Date(Date.now() + 9 * 3600_000).setHours(0, 0, 0, 0);
    const effectiveDays = Math.max(0, Math.ceil((expiryMs - todayMs) / 86400_000));
    // MaxPain 중력 (만기까지 가까울수록 강함)
    const mpDiffPct = opts.maxPainDiffPct * 100;
    if (Math.abs(mpDiffPct) < 0.5) {
      const gravity = effectiveDays <= 2 ? +0.5 : +0.3;
      scores.push({ factor: "MaxPain 중력", score: gravity, detail: `현재가≈MaxPain(${opts.maxPain}) 수렴 | 만기 D-${effectiveDays}` });
    } else if (mpDiffPct < -1) {
      scores.push({ factor: "MaxPain 중력", score: +0.7, detail: `현가 MaxPain 하회 ${mpDiffPct.toFixed(1)}% → 상향 인력 | 만기 D-${effectiveDays}` });
    } else if (mpDiffPct > 1) {
      scores.push({ factor: "MaxPain 중력", score: -0.7, detail: `현가 MaxPain 상회 ${mpDiffPct.toFixed(1)}% → 하향 인력 | 만기 D-${effectiveDays}` });
    }
    // PCR — 전날 급등(>5%) 시 역발상 비적용: 고PCR = 실제 하락 헤지 수요
    if (opts.pcr > 1.3) {
      if (avgReturn > 5.0) {
        scores.push({ factor: "PCR (풋/콜)", score: -0.3, detail: `PCR ${opts.pcr.toFixed(2)} — 급등(+${avgReturn.toFixed(1)}%) 직후 풋 헤지 수요, 역발상 비적용` });
      } else {
        scores.push({ factor: "PCR (풋/콜)", score: +0.5, detail: `PCR ${opts.pcr.toFixed(2)} 높음 → 헤지 과잉 → 역발상 상승` });
      }
    } else if (opts.pcr < 0.8) {
      scores.push({ factor: "PCR (풋/콜)", score: -0.5, detail: `PCR ${opts.pcr.toFixed(2)} 낮음 → 낙관 과잉 → 역발상 하락` });
    }
    // GEX 음수 = 추세 증폭기. 전날 방향으로 증폭 방향 판단
    if (opts.gex < 0) {
      if (avgReturn < -1.0) {
        scores.push({ factor: "GEX (Gamma)", score: -0.5, detail: `GEX ${opts.gex.toFixed(1)}B 음수 + 하락 모멘텀 → 하락 증폭 위험` });
      } else if (avgReturn > 1.0) {
        scores.push({ factor: "GEX (Gamma)", score: +0.3, detail: `GEX ${opts.gex.toFixed(1)}B 음수 + 상승 모멘텀 → 상승 증폭` });
      } else {
        scores.push({ factor: "GEX (Gamma)", score: 0, detail: `GEX ${opts.gex.toFixed(1)}B 음수 → 방향 미결정, 증폭 대기 (중립)` });
      }
    }
    // 외인 옵션 플로우
    const foreignBias = opts.foreignFlow.foreignCallNet - opts.foreignFlow.foreignPutNet;
    if (foreignBias > 50) {
      scores.push({ factor: "외인 옵션 플로우", score: +0.5, detail: `외인 콜 우위 +${foreignBias}계약 → 상승 베팅` });
    } else if (foreignBias < -50) {
      scores.push({ factor: "외인 옵션 플로우", score: -0.5, detail: `외인 풋 우위 ${foreignBias}계약 → 하락 헤지` });
    }

    // 외인 선물 포지션 (가장 빠른 선행 지표)
    if (opts.foreignFutures) {
      const fn = opts.foreignFutures.foreignNet;
      if (fn > 2000) {
        scores.push({ factor: "외인 선물 포지션", score: +1.0, detail: `선물 순매수 +${fn.toLocaleString()}계약 — 강세 포지션` });
      } else if (fn > 500) {
        scores.push({ factor: "외인 선물 포지션", score: +0.5, detail: `선물 순매수 +${fn.toLocaleString()}계약` });
      } else if (fn < -2000) {
        scores.push({ factor: "외인 선물 포지션", score: -1.0, detail: `선물 순매도 ${fn.toLocaleString()}계약 — 약세 포지션` });
      } else if (fn < -500) {
        scores.push({ factor: "외인 선물 포지션", score: -0.5, detail: `선물 순매도 ${fn.toLocaleString()}계약` });
      } else {
        scores.push({ factor: "외인 선물 포지션", score: 0, detail: `선물 순포지션 ${fn > 0 ? "+" : ""}${fn}계약 — 중립` });
      }
    }

    // IV Rank
    if (opts.ivRank !== null && opts.ivRank !== undefined) {
      const ir = opts.ivRank;
      if (ir >= 80) {
        scores.push({ factor: "IV Rank (변동성 순위)", score: +0.5, detail: `IVRank ${ir} — 극단 공포, VKOSPI ${opts.vkospi?.toFixed(1) ?? "?"}` });
      } else if (ir <= 20) {
        scores.push({ factor: "IV Rank (변동성 순위)", score: -0.2, detail: `IVRank ${ir} — 저변동성, 방향성 약` });
      }
    }

    // 스큐
    if (opts.skew !== null && opts.skew !== undefined) {
      const sk = opts.skew;
      if (sk > 5) {
        scores.push({ factor: "옵션 스큐", score: -0.5, detail: `스큐 +${sk}%p — OTM풋 IV 크게 우위, 실질 하락 헤지 수요` });
      } else if (sk < -2) {
        scores.push({ factor: "옵션 스큐", score: +0.3, detail: `스큐 ${sk}%p — 콜 IV 우위, 상승 기대` });
      }
    }

    // OI 변화량 (대량 신규 베팅)
    if (opts.oiChanges && opts.oiChanges.length > 0) {
      const bigPuts = opts.oiChanges.filter((c: any) => c.putOIDiff > 2000);
      const bigCalls = opts.oiChanges.filter((c: any) => c.callOIDiff > 2000);
      if (bigPuts.length > 0) {
        scores.push({ factor: "OI 변화 (풋)", score: -0.5, detail: `${bigPuts[0].strike}행사가 풋 +${bigPuts[0].putOIDiff.toLocaleString()}계약 신규 유입` });
      }
      if (bigCalls.length > 0) {
        scores.push({ factor: "OI 변화 (콜)", score: +0.5, detail: `${bigCalls[0].strike}행사가 콜 +${bigCalls[0].callOIDiff.toLocaleString()}계약 신규 유입` });
      }
    }
  }

  // [C] 디레버리징 경보
  if (alert) {
    const score = alert.level === "RED" ? -1 : -0.5;
    scores.push({ factor: "기관 청산 경보", score, detail: `${alert.level} | ${alert.signals.length}건 발동` });
  } else if (allDelev.length === 0) {
    scores.push({ factor: "기관 청산 경보", score: +0.3, detail: "이상 신호 없음 — 조용한 수급" });
  }

  // [D] 당일 수익률 모멘텀 — 급등(>5%) 시 평균회귀 역산
  if (avgReturn > 5.0) {
    scores.push({ factor: "당일 모멘텀", score: -0.7, detail: `주요 종목 평균 +${avgReturn.toFixed(2)}% 급등 → 차익실현 눌림 예상 (역산)` });
  } else if (avgReturn > 1.0) {
    scores.push({ factor: "당일 모멘텀", score: +0.5, detail: `주요 종목 평균 +${avgReturn.toFixed(2)}% → 추세 지속` });
  } else if (avgReturn < -1.0) {
    scores.push({ factor: "당일 모멘텀", score: -0.5, detail: `주요 종목 평균 ${avgReturn.toFixed(2)}% → 약세 지속` });
  } else {
    scores.push({ factor: "당일 모멘텀", score: avgReturn / 4, detail: `주요 종목 평균 ${avgReturn > 0 ? "+" : ""}${avgReturn.toFixed(2)}% — 혼조` });
  }

  // [E] 바닥 신호
  if (bottomSignals.length >= 2) {
    scores.push({ factor: "바닥 신호 (Bottom Squeeze)", score: +0.7, detail: `${bottomSignals.map(s => s.name).join(", ")} — ${bottomSignals.length}종목 바닥 신호 발동` });
  } else if (bottomSignals.length === 1) {
    scores.push({ factor: "바닥 신호 (Bottom Squeeze)", score: +0.3, detail: `${bottomSignals[0]!.name} 바닥 신호` });
  }

  // [F] 코스피200 야간선물 (kred.dev)
  if (nightFutures) {
    const { changePct, lastClose, dayClose, barCount, sessionDate } = nightFutures;
    let score: number;
    if (changePct >= 1.5)       score = +1.5;
    else if (changePct >= 0.7)  score = +1.0;
    else if (changePct >= 0.3)  score = +0.5;
    else if (changePct <= -1.5) score = -1.5;
    else if (changePct <= -0.7) score = -1.0;
    else if (changePct <= -0.3) score = -0.5;
    else                        score = 0;

    scores.push({
      factor: "코스피200 야간선물 (kred.dev)",
      score,
      detail: `세션 ${sessionDate} | 전일종가 ${dayClose} → 야간종가 ${lastClose} (${changePct > 0 ? "+" : ""}${changePct.toFixed(2)}%) | ${barCount}봉`,
    });
  }

  // ── 최종 판정 ──────────────────────────────────────────────────────────────
  const totalScore = scores.reduce((s, f) => s + f.score, 0);
  const maxScore = scores.length;

  let verdict: string;
  let confidence: string;
  if (totalScore >= 1.5) { verdict = "📈 상승"; confidence = "중강"; }
  else if (totalScore >= 0.5) { verdict = "📈 약상승"; confidence = "중약"; }
  else if (totalScore >= -0.5) { verdict = "↔️ 중립/혼조"; confidence = "낮음"; }
  else if (totalScore >= -1.5) { verdict = "📉 약하락"; confidence = "중약"; }
  else { verdict = "📉 하락"; confidence = "중강"; }

  // ── 출력 ──────────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(50));
  console.log(`\n🎯 내일 (${tomorrowStr}) 코스피 방향 예측\n`);
  console.log(`결론: ${verdict}  [신뢰도: ${confidence}]`);
  console.log(`종합 스코어: ${totalScore.toFixed(2)} / ${maxScore} 가능`);
  console.log("\n📋 팩터별 분석:");
  for (const f of scores) {
    const arrow = f.score > 0.1 ? "▲" : f.score < -0.1 ? "▼" : "─";
    console.log(`  ${arrow} [${f.score > 0 ? "+" : ""}${f.score.toFixed(1)}] ${f.factor}`);
    console.log(`        ${f.detail}`);
  }

  // 당일 수익률 요약
  console.log("\n📊 오늘 주요 종목 수익률:");
  for (const r of stockReturns.sort((a, b) => b.dailyReturn - a.dailyReturn)) {
    const bar = r.dailyReturn > 0 ? "🟢" : r.dailyReturn < 0 ? "🔴" : "⚪";
    console.log(`  ${bar} ${r.name}: ${r.dailyReturn > 0 ? "+" : ""}${r.dailyReturn.toFixed(2)}%`);
  }

  if (alert) {
    console.log(`\n⚠️ 기관 청산 경보: ${alert.summary}`);
  }

  console.log("\n" + "=".repeat(50));
  console.log("⚠️ 면책: 이 예측은 구현된 시그널 엔진 출력이며 투자 조언이 아닙니다.");

  return { verdict, totalScore, scores, opts, alert, bottomSignals, stockReturns, nightFutures };
}

const _result = await predictKospi();
process.stdout.write("\n__PREDICTION_JSON__\n" + JSON.stringify(_result, null, 2) + "\n");
