import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

// ── Types ────────────────────────────────────────────────────────────────────

export type OptionRow = {
  strike: number;
  callOI: number;
  putOI: number;
  callVolume: number;
  putVolume: number;
};

export type InvestorOptionFlow = {
  foreignCallNet: number;  // 외인 콜 순매수 (계약 수)
  foreignPutNet: number;   // 외인 풋 순매수
  instCallNet: number;     // 기관 콜 순매수
  instPutNet: number;      // 기관 풋 순매수
};

export type OptionsSignal = {
  date: string;
  spotPrice: number;
  maxPain: number;
  maxPainDiffPct: number;
  gex: number;
  gammaFlip: number | null;
  pcr: number;
  foreignFlow: InvestorOptionFlow;
  weeklyExpiry: string;
  daysToExpiry: number;
  score: number;
  direction: "bullish" | "bearish" | "neutral";
  details: string[];
  timestamp: string;
};

// ── Config ───────────────────────────────────────────────────────────────────

const CACHE_DIR = join(import.meta.dir, "../.lemonclaw");
const SIGNAL_CACHE_FILE = join(CACHE_DIR, "options_signal.json");
const CONTRACT_MULTIPLIER = 250_000; // KOSPI200 옵션 1계약 = 250,000원

// ── KRX Crawling ─────────────────────────────────────────────────────────────

function prevBusinessDay(from?: Date): string {
  const d = from ? new Date(from) : new Date(Date.now() + 9 * 3600_000);
  // 오늘 16시 이전이면 전일로
  const kst = new Date(Date.now() + 9 * 3600_000);
  if (kst.getUTCHours() < 16) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  // 주말 건너뛰기
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function todayKST(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

export async function fetchKrxOptionChain(date?: string): Promise<{ chain: OptionRow[]; spotPrice: number }> {
  const trd_dd = date || prevBusinessDay();

  // KRX 12003 = KOSPI200 옵션 행사가별 시세
  const params = new URLSearchParams({
    bld: "dbms/MDC/STAT/standard/MDCSTAT12501",
    locale: "ko_KR",
    prodId: "KRDRVOPK2I",  // KOSPI200 옵션
    trdDd: trd_dd,
    mktTpCd: "T",  // 전체
    rghtTpCd: "T", // 전체 (콜+풋)
    share: "1",
    money: "1",
    csvxls_is498: "false",
  });

  const res = await fetch("http://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (compatible; bot)",
      "Referer": "http://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201",
    },
    body: params.toString(),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`KRX option chain HTTP ${res.status}`);
  const data = await res.json() as any;

  const rows: any[] = data.output ?? data.OutBlock_1 ?? [];
  if (rows.length === 0) {
    // 대체 방법: 12501 대신 12003 시도
    return fetchKrxOptionChainFallback(trd_dd);
  }

  // 파싱: 행사가별 콜OI/풋OI/거래량
  const chainMap = new Map<number, OptionRow>();
  for (const row of rows) {
    const strike = parseFloat((row.STRK_PRC || row.ISU_SRT_CD || "0").replace(/,/g, ""));
    if (!strike || isNaN(strike)) continue;

    const callOI = parseInt((row.CALL_OPN_INT_QTY || row.CALL_SETL_OPN_INT || "0").replace(/,/g, ""), 10) || 0;
    const putOI = parseInt((row.PUT_OPN_INT_QTY || row.PUT_SETL_OPN_INT || "0").replace(/,/g, ""), 10) || 0;
    const callVol = parseInt((row.CALL_TRDVOL || row.CALL_ACC_TRDVOL || "0").replace(/,/g, ""), 10) || 0;
    const putVol = parseInt((row.PUT_TRDVOL || row.PUT_ACC_TRDVOL || "0").replace(/,/g, ""), 10) || 0;

    const existing = chainMap.get(strike);
    if (existing) {
      existing.callOI += callOI;
      existing.putOI += putOI;
      existing.callVolume += callVol;
      existing.putVolume += putVol;
    } else {
      chainMap.set(strike, { strike, callOI, putOI, callVolume: callVol, putVolume: putVol });
    }
  }

  // 현재가 = KOSPI200 지수 (KRX에서 직접)
  let spotPrice = 0;
  try {
    spotPrice = await fetchKospi200Spot(trd_dd);
  } catch {
    // 체인 중간값으로 추정
    const strikes = [...chainMap.keys()].sort((a, b) => a - b);
    spotPrice = strikes[Math.floor(strikes.length / 2)] ?? 0;
  }

  return { chain: [...chainMap.values()].sort((a, b) => a.strike - b.strike), spotPrice };
}

async function fetchKrxOptionChainFallback(trd_dd: string): Promise<{ chain: OptionRow[]; spotPrice: number }> {
  // 12003: 행사가격별 거래현황
  const params = new URLSearchParams({
    bld: "dbms/MDC/STAT/standard/MDCSTAT12003",
    locale: "ko_KR",
    trdDd: trd_dd,
    prodId: "KRDRVOPK2I",
    share: "1",
    money: "1",
    csvxls_isNo: "false",
  });

  const res = await fetch("http://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (compatible; bot)",
      "Referer": "http://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201",
    },
    body: params.toString(),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`KRX fallback HTTP ${res.status}`);
  const data = await res.json() as any;
  const rows: any[] = data.output ?? data.OutBlock_1 ?? [];

  const chainMap = new Map<number, OptionRow>();
  for (const row of rows) {
    const strike = parseFloat((row.STRK_PRC || "0").replace(/,/g, ""));
    if (!strike || isNaN(strike)) continue;

    const isCall = (row.RGHT_TP_NM || "").includes("콜") || row.RGHT_TP_CD === "C";
    const oi = parseInt((row.OPN_INT_QTY || "0").replace(/,/g, ""), 10) || 0;
    const vol = parseInt((row.ACC_TRDVOL || row.TRDVOL || "0").replace(/,/g, ""), 10) || 0;

    const existing = chainMap.get(strike) ?? { strike, callOI: 0, putOI: 0, callVolume: 0, putVolume: 0 };
    if (isCall) {
      existing.callOI += oi;
      existing.callVolume += vol;
    } else {
      existing.putOI += oi;
      existing.putVolume += vol;
    }
    chainMap.set(strike, existing);
  }

  let spotPrice = 0;
  try { spotPrice = await fetchKospi200Spot(trd_dd); } catch {}

  return { chain: [...chainMap.values()].sort((a, b) => a.strike - b.strike), spotPrice };
}

async function fetchKospi200Spot(trd_dd: string): Promise<number> {
  const params = new URLSearchParams({
    bld: "dbms/MDC/STAT/standard/MDCSTAT00101",
    locale: "ko_KR",
    idxIndMidclssCd: "02",
    trdDd: trd_dd,
    share: "1",
    money: "1",
    csvxls_isNo: "false",
  });

  const res = await fetch("http://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (compatible; bot)",
      "Referer": "http://data.krx.co.kr/",
    },
    body: params.toString(),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`KRX index HTTP ${res.status}`);
  const data = await res.json() as any;
  const rows: any[] = data.output ?? [];

  // KOSPI200 찾기
  for (const row of rows) {
    if ((row.IDX_NM || "").includes("코스피 200") || (row.IDX_IND_NM || "").includes("코스피 200")) {
      const price = parseFloat((row.CLSPRC_IDX || row.TDD_CLSPRC || "0").replace(/,/g, ""));
      if (price > 0) return price;
    }
  }

  throw new Error("KOSPI200 지수 없음");
}

// ── 주체별 옵션 매매 (외인/기관) ─────────────────────────────────────────────

export async function fetchKrxInvestorOptions(date?: string): Promise<InvestorOptionFlow> {
  const trd_dd = date || prevBusinessDay();

  // KRX 12009: 투자자별 옵션 거래실적
  const params = new URLSearchParams({
    bld: "dbms/MDC/STAT/standard/MDCSTAT12601",
    locale: "ko_KR",
    prodId: "KRDRVOPK2I",
    trdDd: trd_dd,
    askTpCd: "1",  // 순매수
    share: "1",
    money: "1",
    csvxls_isNo: "false",
  });

  const res = await fetch("http://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (compatible; bot)",
      "Referer": "http://data.krx.co.kr/",
    },
    body: params.toString(),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`KRX investor options HTTP ${res.status}`);
  const data = await res.json() as any;
  const rows: any[] = data.output ?? data.OutBlock_1 ?? [];

  let foreignCallNet = 0, foreignPutNet = 0;
  let instCallNet = 0, instPutNet = 0;

  for (const row of rows) {
    const investorNm = row.INVST_TP_NM || row.ASK_CMPNY_TP_NM || "";
    const isForeign = investorNm.includes("외국인") || investorNm.includes("외인");
    const isInst = investorNm.includes("기관") || investorNm.includes("금융투자");

    const callNet = parseInt((row.CALL_NETBID_QTY || row.CALL_NETBY_QTY || "0").replace(/,/g, ""), 10) || 0;
    const putNet = parseInt((row.PUT_NETBID_QTY || row.PUT_NETBY_QTY || "0").replace(/,/g, ""), 10) || 0;

    if (isForeign) { foreignCallNet += callNet; foreignPutNet += putNet; }
    if (isInst) { instCallNet += callNet; instPutNet += putNet; }
  }

  return { foreignCallNet, foreignPutNet, instCallNet, instPutNet };
}

// ── Max Pain 계산 ────────────────────────────────────────────────────────────

export function calcMaxPain(chain: OptionRow[]): number {
  if (chain.length === 0) return 0;

  let minPain = Infinity;
  let maxPainStrike = 0;

  for (const target of chain) {
    let totalPain = 0;

    for (const row of chain) {
      // 콜 매도자 손실: max(0, target.strike - row.strike) × callOI
      if (target.strike > row.strike) {
        totalPain += (target.strike - row.strike) * row.callOI * CONTRACT_MULTIPLIER;
      }
      // 풋 매도자 손실: max(0, row.strike - target.strike) × putOI
      if (row.strike > target.strike) {
        totalPain += (row.strike - target.strike) * row.putOI * CONTRACT_MULTIPLIER;
      }
    }

    if (totalPain < minPain) {
      minPain = totalPain;
      maxPainStrike = target.strike;
    }
  }

  return maxPainStrike;
}

// ── GEX (Gamma Exposure) 계산 ────────────────────────────────────────────────

export function calcGEX(chain: OptionRow[], spotPrice: number): { gex: number; gammaFlip: number | null } {
  if (chain.length === 0 || spotPrice <= 0) return { gex: 0, gammaFlip: null };

  // 간이 Gamma 추정 (BSM 정확 계산은 IV/잔존일 필요하므로 프록시 사용)
  // Gamma ∝ N'(d1) / (S × σ × √T) → OI 가중 근사
  // 단순화: GEX = Σ (callOI - putOI) × 근사감마 × contractMultiplier × spotPrice
  // 근사감마: ATM에 가까울수록 높고, 멀수록 작음 (정규분포 형태)

  const sigma = 0.15; // 연간 변동성 추정 (15%)
  const T = 5 / 252;  // 위클리 만기까지 약 5영업일 추정
  const sqrtT = Math.sqrt(T);

  let totalGEX = 0;
  let flipStrike: number | null = null;
  let prevSign = 0;

  for (const row of chain) {
    const moneyness = Math.log(spotPrice / row.strike) / (sigma * sqrtT);
    // 간이 N'(d1) ≈ exp(-d1²/2) / √(2π)
    const nd1 = Math.exp(-moneyness * moneyness / 2) / Math.sqrt(2 * Math.PI);
    const gamma = nd1 / (spotPrice * sigma * sqrtT);

    // 콜 = 양의 감마, 풋 = 음의 감마 (마켓메이커 관점)
    const rowGEX = (row.callOI - row.putOI) * gamma * CONTRACT_MULTIPLIER * spotPrice / 1e9;
    totalGEX += rowGEX;

    // Gamma Flip 탐지 (누적 GEX 부호 전환점)
    const sign = rowGEX >= 0 ? 1 : -1;
    if (prevSign !== 0 && sign !== prevSign && !flipStrike) {
      flipStrike = row.strike;
    }
    prevSign = sign;
  }

  return { gex: totalGEX, gammaFlip: flipStrike };
}

// ── PCR (Put/Call Ratio) ─────────────────────────────────────────────────────

export function calcPCR(chain: OptionRow[]): number {
  const totalCallOI = chain.reduce((s, r) => s + r.callOI, 0);
  const totalPutOI = chain.reduce((s, r) => s + r.putOI, 0);
  if (totalCallOI === 0) return 0;
  return totalPutOI / totalCallOI;
}

// ── 만기일 계산 ──────────────────────────────────────────────────────────────

function getNextWeeklyExpiry(): { date: string; days: number } {
  const kst = new Date(Date.now() + 9 * 3600_000);
  const today = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()));

  // 다음 목요일 찾기
  let target = new Date(today);
  const dayOfWeek = today.getUTCDay();
  const daysUntilThursday = (4 - dayOfWeek + 7) % 7 || 7;
  // 오늘이 목요일이면 오늘이 만기일
  if (dayOfWeek === 4) {
    return { date: today.toISOString().slice(0, 10), days: 0 };
  }
  target.setUTCDate(today.getUTCDate() + daysUntilThursday);

  // 영업일 계산
  let businessDays = 0;
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() + 1);
  while (d <= target) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) businessDays++;
    d.setUTCDate(d.getUTCDate() + 1);
  }

  return { date: target.toISOString().slice(0, 10), days: businessDays };
}

// ── 종합 신호 생성 ──────────────────────────────────────────────────────────

export async function buildOptionsSignal(): Promise<OptionsSignal> {
  const [chainResult, investorFlow] = await Promise.all([
    fetchKrxOptionChain(),
    fetchKrxInvestorOptions(),
  ]);

  const { chain, spotPrice } = chainResult;
  const maxPain = calcMaxPain(chain);
  const { gex, gammaFlip } = calcGEX(chain, spotPrice);
  const pcr = calcPCR(chain);
  const expiry = getNextWeeklyExpiry();

  const maxPainDiffPct = spotPrice > 0 ? (spotPrice - maxPain) / maxPain * 100 : 0;

  // 스코어링
  let score = 0;
  const details: string[] = [];

  // 1. Max Pain 괴리 (만기 D-3 이내일 때 가중치 높임)
  const mpWeight = expiry.days <= 3 ? 2 : 1;
  if (maxPainDiffPct < -1.5) {
    score += 2 * mpWeight;
    details.push(`MaxPain↑: 현재가(${spotPrice.toFixed(2)}) < MaxPain(${maxPain.toFixed(2)}) ${maxPainDiffPct.toFixed(1)}% 괴리 → 상승중력`);
  } else if (maxPainDiffPct > 1.5) {
    score -= 2 * mpWeight;
    details.push(`MaxPain↓: 현재가(${spotPrice.toFixed(2)}) > MaxPain(${maxPain.toFixed(2)}) +${maxPainDiffPct.toFixed(1)}% 괴리 → 하락중력`);
  } else {
    details.push(`MaxPain≈: 현재가(${spotPrice.toFixed(2)}) ≈ MaxPain(${maxPain.toFixed(2)}) 수렴 구간`);
  }

  // 2. GEX 방향
  if (gex > 5) {
    score -= 1; // 양수GEX = 횡보장 = 방향성 약
    details.push(`GEX+: ${gex.toFixed(1)}B (양수 → 변동성 억제, 횡보장 가능성)`);
  } else if (gex < -5) {
    // 음수GEX = 방향 증폭 — 방향은 다른 지표로 판단
    details.push(`GEX-: ${gex.toFixed(1)}B (음수 → 추세장, 방향 증폭 구간)`);
  } else {
    details.push(`GEX≈: ${gex.toFixed(1)}B (중립)`);
  }

  // 3. 외인 콜/풋 포지션
  const foreignNet = investorFlow.foreignCallNet - investorFlow.foreignPutNet;
  if (foreignNet > 500) {
    score += 2;
    details.push(`외인콜↑: 콜 순매수(${investorFlow.foreignCallNet}) > 풋(${investorFlow.foreignPutNet}) → 강세 포지션`);
  } else if (foreignNet < -500) {
    score -= 2;
    details.push(`외인풋↑: 풋 순매수(${investorFlow.foreignPutNet}) > 콜(${investorFlow.foreignCallNet}) → 약세 포지션`);
  } else {
    details.push(`외인중립: 콜(${investorFlow.foreignCallNet}) / 풋(${investorFlow.foreignPutNet}) 균형`);
  }

  // 4. PCR
  if (pcr < 0.7) {
    score += 1;
    details.push(`PCR ${pcr.toFixed(2)} (낮음 → 콜 우위, 강세)`);
  } else if (pcr > 1.3) {
    score -= 1;
    details.push(`PCR ${pcr.toFixed(2)} (높음 → 풋 우위, 약세/헤지)`);
  } else {
    details.push(`PCR ${pcr.toFixed(2)} (중립)`);
  }

  // 5. Gamma Flip
  if (gammaFlip) {
    const flipDiff = (spotPrice - gammaFlip) / gammaFlip * 100;
    if (flipDiff < -1) {
      details.push(`GammaFlip ${gammaFlip.toFixed(2)}: 현재가 아래 → 변동성 증폭 구간`);
    } else if (flipDiff > 1) {
      details.push(`GammaFlip ${gammaFlip.toFixed(2)}: 현재가 위 → 변동성 억제 구간`);
    }
  }

  // 방향 결정
  let direction: "bullish" | "bearish" | "neutral";
  if (score >= 3) direction = "bullish";
  else if (score <= -3) direction = "bearish";
  else direction = "neutral";

  const kst = new Date(Date.now() + 9 * 3600_000);
  const timestamp = `${kst.toISOString().slice(0, 10)} ${kst.toISOString().slice(11, 16)} KST`;

  const signal: OptionsSignal = {
    date: todayKST(),
    spotPrice,
    maxPain,
    maxPainDiffPct,
    gex,
    gammaFlip,
    pcr,
    foreignFlow: investorFlow,
    weeklyExpiry: expiry.date,
    daysToExpiry: expiry.days,
    score,
    direction,
    details,
    timestamp,
  };

  // 캐시 저장
  try {
    writeFileSync(SIGNAL_CACHE_FILE, JSON.stringify(signal, null, 2));
  } catch {}

  return signal;
}

// ── 캐시 로드 (API용) ────────────────────────────────────────────────────────

export function loadCachedSignal(): OptionsSignal | null {
  try {
    if (!existsSync(SIGNAL_CACHE_FILE)) return null;
    const raw = JSON.parse(readFileSync(SIGNAL_CACHE_FILE, "utf-8")) as OptionsSignal;
    // 오늘 데이터만 유효
    if (raw.date !== todayKST()) return null;
    return raw;
  } catch {
    return null;
  }
}

// ── 텔레그램 포맷 ────────────────────────────────────────────────────────────

const DIR_EMOJI = { bullish: "🟢", bearish: "🔴", neutral: "⚪" };
const DIR_KR = { bullish: "상승 편향", bearish: "하락 편향", neutral: "중립" };

export function formatOptionsReport(s: OptionsSignal): string {
  const lines: string[] = [
    `${DIR_EMOJI[s.direction]} <b>T+1 옵션 수급 신호 — ${DIR_KR[s.direction]}</b> (스코어 ${s.score >= 0 ? "+" : ""}${s.score})`,
    `🕐 ${s.timestamp}`,
    `📅 위클리 만기: ${s.weeklyExpiry} (D-${s.daysToExpiry})`,
    ``,
    `<b>📊 핵심 지표</b>`,
    `  KOSPI200: <b>${s.spotPrice.toFixed(2)}</b>`,
    `  Max Pain: <b>${s.maxPain.toFixed(2)}</b> (괴리 ${s.maxPainDiffPct >= 0 ? "+" : ""}${s.maxPainDiffPct.toFixed(1)}%)`,
    `  GEX: <b>${s.gex.toFixed(1)}B</b>${s.gammaFlip ? ` | Flip: ${s.gammaFlip.toFixed(2)}` : ""}`,
    `  PCR: <b>${s.pcr.toFixed(2)}</b>`,
    ``,
    `<b>👥 외인 옵션 포지션</b>`,
    `  콜 순매수: <b>${fmtNum(s.foreignFlow.foreignCallNet)}</b>계약`,
    `  풋 순매수: <b>${fmtNum(s.foreignFlow.foreignPutNet)}</b>계약`,
    `  기관 콜: ${fmtNum(s.foreignFlow.instCallNet)} | 풋: ${fmtNum(s.foreignFlow.instPutNet)}`,
  ];

  if (s.details.length > 0) {
    lines.push(``, `<b>🔍 분석</b>`);
    for (const d of s.details) lines.push(`  · ${d}`);
  }

  lines.push(``, `<b>💡 해석</b>`);
  if (s.direction === "bullish") {
    lines.push(`  옵션 수급상 상승 우위. Max Pain 수렴 방향과 외인 콜 포지션이 매수 쪽.`);
  } else if (s.direction === "bearish") {
    lines.push(`  옵션 수급상 하락 우위. 외인 풋 포지션 우위 + Max Pain 하방 중력.`);
  } else {
    lines.push(`  옵션 수급 혼조. 방향성 판단 유보 — 다른 지표와 교차 확인 필요.`);
  }

  lines.push(``, `<i>⚠️ T+1 데이터 기반 — 당일 장중 실시간 변화 미반영</i>`);

  return lines.join("\n");
}

function fmtNum(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toLocaleString("ko-KR")}`;
}

// ── 자동 모니터 (매일 오전 8:30 실행) ────────────────────────────────────────

let monitorTimer: ReturnType<typeof setInterval> | null = null;
let monitorChatId = "";
let monitorSend: ((chatId: string, text: string) => Promise<void>) | null = null;

async function morningTick(): Promise<void> {
  const kst = new Date(Date.now() + 9 * 3600_000);
  const hour = kst.getUTCHours();
  const minute = kst.getUTCMinutes();
  const day = kst.getUTCDay();

  // 평일 08:30~08:45 사이에만 실행
  if (day === 0 || day === 6) return;
  if (hour !== 8 || minute < 30 || minute > 45) return;

  // 오늘 이미 캐시 있으면 스킵
  if (loadCachedSignal()) return;

  try {
    const signal = await buildOptionsSignal();
    if (monitorSend && monitorChatId) {
      await monitorSend(monitorChatId, formatOptionsReport(signal));
    }
  } catch (e: any) {
    console.error(`[OptionsAnalysis] 모닝 리포트 실패: ${e.message}`);
  }
}

const CHECK_INTERVAL_MS = 5 * 60_000; // 5분마다 체크 (08:30 감지용)

export function startOptionsMonitor(
  chatId: string,
  sendFn: (chatId: string, text: string) => Promise<void>,
): void {
  if (monitorTimer) return;
  monitorChatId = chatId;
  monitorSend = sendFn;
  console.log("[OptionsAnalysis] 모니터 시작 — 평일 08:30 옵션 수급 리포트 발송");
  morningTick().catch(e => console.error(`[OptionsAnalysis] 초기 체크 실패: ${e.message}`));
  monitorTimer = setInterval(
    () => morningTick().catch(e => console.error(`[OptionsAnalysis] tick 실패: ${e.message}`)),
    CHECK_INTERVAL_MS,
  );
}

export function stopOptionsMonitor(): void {
  if (!monitorTimer) return;
  clearInterval(monitorTimer);
  monitorTimer = null;
  console.log("[OptionsAnalysis] 모니터 중지");
}

export function isOptionsMonitorRunning(): boolean {
  return monitorTimer !== null;
}
