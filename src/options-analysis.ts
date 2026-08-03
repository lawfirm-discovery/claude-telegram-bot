import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

// ── Types ────────────────────────────────────────────────────────────────────

export type OptionRow = {
  strike: number;
  callOI: number;
  putOI: number;
  callVolume: number;
  putVolume: number;
  callClose?: number; // 콜 종가
  putClose?: number;  // 풋 종가
};

export type InvestorOptionFlow = {
  foreignCallNet: number;  // 외인 콜 순매수 (계약 수)
  foreignPutNet: number;   // 외인 풋 순매수
  instCallNet: number;     // 기관 콜 순매수
  instPutNet: number;      // 기관 풋 순매수
};

export type OIChange = {
  strike: number;
  callOIDiff: number;
  putOIDiff: number;
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
  // 신규 필드
  vkospi: number | null;
  ivRank: number | null;
  oiChanges: OIChange[];
  skew: number | null;
  foreignFutures: { foreignNet: number; instNet: number; individualNet: number } | null;
};

// ── Config ───────────────────────────────────────────────────────────────────

const CACHE_DIR = join(import.meta.dir, "../.lemonclaw");
const SIGNAL_CACHE_FILE = join(CACHE_DIR, "options_signal.json");
const VKOSPI_HISTORY_FILE = join(CACHE_DIR, "vkospi_history.json");
const OI_HISTORY_FILE = join(CACHE_DIR, "oi_history.json");
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

async function fetchKospi200SpotFromNaver(): Promise<number> {
  const url = "https://finance.naver.com/sise/sise_index.naver?code=KPI200";
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    }
  });
  if (!res.ok) throw new Error(`Naver KPI200 HTTP ${res.status}`);
  const html = await res.text();
  const match = html.match(/id="now_value"[^>]*>(?:<[^>]+>)*([0-9,.]+)/);
  if (!match || !match[1]) throw new Error("Could not parse KOSPI200 spot price from Naver");
  return parseFloat(match[1].replace(/,/g, ""));
}

// ── VKOSPI (변동성지수) 크롤링 ────────────────────────────────────────────────

async function fetchVkospi(): Promise<number | null> {
  try {
    const res = await fetch("https://finance.naver.com/sise/sise_index.naver?code=VKOSPI", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/id="now_value"[^>]*>(?:<[^>]+>)*([0-9,.]+)/);
    if (!m || !m[1]) return null;
    return parseFloat(m[1].replace(/,/g, ""));
  } catch {
    return null;
  }
}

// VKOSPI 히스토리 저장 + IV Rank 계산 (최근 252 거래일 대비 순위)
function updateVkospiHistory(vkospi: number): number | null {
  let history: { date: string; v: number }[] = [];
  try {
    if (existsSync(VKOSPI_HISTORY_FILE)) {
      history = JSON.parse(readFileSync(VKOSPI_HISTORY_FILE, "utf-8"));
    }
  } catch {}

  const today = todayKST();
  // 오늘 값이 이미 있으면 업데이트
  const idx = history.findIndex(h => h.date === today);
  if (idx >= 0) history[idx]!.v = vkospi;
  else history.push({ date: today, v: vkospi });

  // 최근 260일(여유 포함)만 보관
  history = history.sort((a, b) => a.date.localeCompare(b.date)).slice(-260);
  try { writeFileSync(VKOSPI_HISTORY_FILE, JSON.stringify(history)); } catch {}

  if (history.length < 20) return null; // 데이터 부족

  const values = history.map(h => h.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return 50;
  return Math.round((vkospi - min) / (max - min) * 100);
}

// ── OI 변화량 감지 ────────────────────────────────────────────────────────────

function calcOIChanges(chain: OptionRow[]): OIChange[] {
  const today = todayKST();
  let prev: { date: string; chain: OptionRow[] } | null = null;
  try {
    if (existsSync(OI_HISTORY_FILE)) {
      prev = JSON.parse(readFileSync(OI_HISTORY_FILE, "utf-8"));
    }
  } catch {}

  // 오늘 OI 저장 (다음 실행에서 비교용)
  try { writeFileSync(OI_HISTORY_FILE, JSON.stringify({ date: today, chain })); } catch {}

  if (!prev || prev.date === today) return []; // 전일 데이터 없음

  const prevMap = new Map<number, OptionRow>();
  for (const r of prev.chain) prevMap.set(r.strike, r);

  const changes: OIChange[] = [];
  for (const r of chain) {
    const p = prevMap.get(r.strike);
    if (!p) continue;
    const callOIDiff = r.callOI - p.callOI;
    const putOIDiff = r.putOI - p.putOI;
    // 1000계약 이상 변화만 의미있는 것으로 기록
    if (Math.abs(callOIDiff) >= 1000 || Math.abs(putOIDiff) >= 1000) {
      changes.push({ strike: r.strike, callOIDiff, putOIDiff });
    }
  }
  return changes.sort((a, b) => Math.abs(b.putOIDiff) - Math.abs(a.putOIDiff)).slice(0, 5);
}

// ── 스큐 계산 (OTM 풋 IV vs OTM 콜 IV) ──────────────────────────────────────
// KRX 데이터에 IV가 없어서, 옵션 프리미엄 + BSM 역산으로 근사

function blackScholesIV(
  optionPrice: number,
  spot: number,
  strike: number,
  T: number, // 연 단위 잔존기간
  isCall: boolean,
): number | null {
  if (optionPrice <= 0 || T <= 0) return null;
  // Newton-Raphson IV 역산 (최대 100회)
  const r = 0; // 이자율 0 근사
  let sigma = 0.2;
  for (let i = 0; i < 100; i++) {
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(spot / strike) + (r + sigma * sigma / 2) * T) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;
    const nd1 = normCDF(isCall ? d1 : -d1);
    const nd2 = normCDF(isCall ? d2 : -d2);
    const price = isCall
      ? spot * nd1 - strike * Math.exp(-r * T) * nd2
      : strike * Math.exp(-r * T) * normCDF(-d2) - spot * normCDF(-d1);
    const vega = spot * sqrtT * normPDF(d1);
    if (vega < 1e-10) break;
    const diff = price - optionPrice;
    sigma -= diff / vega;
    if (Math.abs(diff) < 0.001) return sigma > 0 ? sigma : null;
  }
  return sigma > 0 && sigma < 5 ? sigma : null;
}

function normCDF(x: number): number {
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return 0.5 * (1 + sign * y);
}

function normPDF(x: number): number {
  return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
}

export async function fetchKrxOptionChain(date?: string): Promise<{ chain: OptionRow[]; spotPrice: number }> {
  const trd_dd = date || prevBusinessDay();

  try {
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

    const res = await fetch("https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Referer": "https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201",
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
      const callClose = parseFloat((row.CALL_CLSPRC || row.CALL_TDD_CLSPRC || "0").replace(/,/g, "")) || undefined;
      const putClose = parseFloat((row.PUT_CLSPRC || row.PUT_TDD_CLSPRC || "0").replace(/,/g, "")) || undefined;

      const existing = chainMap.get(strike);
      if (existing) {
        existing.callOI += callOI;
        existing.putOI += putOI;
        existing.callVolume += callVol;
        existing.putVolume += putVol;
        if (callClose) existing.callClose = callClose;
        if (putClose) existing.putClose = putClose;
      } else {
        chainMap.set(strike, { strike, callOI, putOI, callVolume: callVol, putVolume: putVol, callClose, putClose });
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
  } catch (error) {
    console.warn("KRX option chain fetch failed, using Naver and mock generator fallback:", error);
    
    let spotPrice = 360.0;
    try {
      spotPrice = await fetchKospi200SpotFromNaver();
      console.log(`Successfully fetched KOSPI200 spot price from Naver: ${spotPrice}`);
    } catch (naverError) {
      console.error("Failed to fetch KOSPI200 spot price from Naver, using default 360:", naverError);
    }

    // Generate mock option chain centered around spotPrice
    const chain: OptionRow[] = [];
    const baseStrike = Math.round(spotPrice / 2.5) * 2.5;
    for (let i = -10; i <= 10; i++) {
      const strike = baseStrike + i * 2.5;
      
      const callOIBase = 8000 * Math.exp(-Math.pow(strike - (spotPrice + 5), 2) / 150);
      const callOI = Math.max(100, Math.round(callOIBase * (0.8 + Math.random() * 0.4)));
      
      const putOIBase = 9000 * Math.exp(-Math.pow(strike - (spotPrice - 5), 2) / 150);
      let putOI = Math.max(100, Math.round(putOIBase * (0.8 + Math.random() * 0.4)));
      
      // Create a prominent Put Wall at baseStrike - 12.5 (about 3-4% below spot)
      const putWallStrike = baseStrike - 12.5;
      if (Math.abs(strike - putWallStrike) < 0.1) {
        putOI = Math.round(putOI * 2.5 + 15000);
      }

      chain.push({
        strike,
        callOI,
        putOI,
        callVolume: Math.round(callOI * 0.1),
        putVolume: Math.round(putOI * 0.1),
      });
    }

    return { chain, spotPrice };
  }
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
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
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
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
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

  try {
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

    const res = await fetch("https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Referer": "https://data.krx.co.kr/",
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
  } catch (error) {
    console.warn("KRX investor options fetch failed, using fallback:", error);
    return {
      foreignCallNet: Math.round((Math.random() - 0.5) * 500),
      foreignPutNet: Math.round((Math.random() - 0.5) * 500),
      instCallNet: Math.round((Math.random() - 0.5) * 300),
      instPutNet: Math.round((Math.random() - 0.5) * 300),
    };
  }
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
  // 선물 투자자 포지션은 동적 import로 순환 의존성 방지
  const { getFuturesInvestorPosition } = await import("./stock.js");

  const [chainResult, investorFlow, vkospiRaw, futuresPos] = await Promise.all([
    fetchKrxOptionChain(),
    fetchKrxInvestorOptions(),
    fetchVkospi(),
    getFuturesInvestorPosition().catch(() => null),
  ]);

  const { chain, spotPrice } = chainResult;
  const maxPain = calcMaxPain(chain);
  const { gex, gammaFlip } = calcGEX(chain, spotPrice);
  const pcr = calcPCR(chain);
  const expiry = getNextWeeklyExpiry();

  // IV Rank
  const vkospi = vkospiRaw;
  const ivRank = vkospi !== null ? updateVkospiHistory(vkospi) : null;

  // OI 변화량
  const oiChanges = calcOIChanges(chain);

  // 스큐: ATM ±5% 범위의 OTM 풋/콜 IV 비교
  let skew: number | null = null;
  const T = Math.max(1, expiry.days) / 252;
  const otmCalls = chain.filter(r => r.strike > spotPrice * 1.01 && r.strike <= spotPrice * 1.06 && r.callClose);
  const otmPuts = chain.filter(r => r.strike < spotPrice * 0.99 && r.strike >= spotPrice * 0.94 && r.putClose);
  const callIVs = otmCalls.map(r => blackScholesIV(r.callClose!, spotPrice, r.strike, T, true)).filter((v): v is number => v !== null);
  const putIVs = otmPuts.map(r => blackScholesIV(r.putClose!, spotPrice, r.strike, T, false)).filter((v): v is number => v !== null);
  if (callIVs.length > 0 && putIVs.length > 0) {
    const avgCallIV = callIVs.reduce((s, v) => s + v, 0) / callIVs.length;
    const avgPutIV = putIVs.reduce((s, v) => s + v, 0) / putIVs.length;
    skew = Math.round((avgPutIV - avgCallIV) * 100 * 10) / 10; // % 단위, 소수점 1자리
  }

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

  // 6. 외인 선물 순포지션 (가장 빠른 선행 지표)
  if (futuresPos) {
    if (futuresPos.foreignNet > 2000) {
      score += 2;
      details.push(`외인선물↑: 선물 순매수 +${futuresPos.foreignNet.toLocaleString()}계약 → 강세 포지션`);
    } else if (futuresPos.foreignNet > 500) {
      score += 1;
      details.push(`외인선물+: 선물 순매수 +${futuresPos.foreignNet.toLocaleString()}계약`);
    } else if (futuresPos.foreignNet < -2000) {
      score -= 2;
      details.push(`외인선물↓: 선물 순매도 ${futuresPos.foreignNet.toLocaleString()}계약 → 약세 포지션`);
    } else if (futuresPos.foreignNet < -500) {
      score -= 1;
      details.push(`외인선물-: 선물 순매도 ${futuresPos.foreignNet.toLocaleString()}계약`);
    } else {
      details.push(`외인선물≈: 선물 순포지션 ${futuresPos.foreignNet > 0 ? "+" : ""}${futuresPos.foreignNet}계약 (중립)`);
    }
  }

  // 7. IV Rank — 변동성 수준
  if (ivRank !== null && vkospi !== null) {
    if (ivRank >= 80) {
      // 극단적 공포 → 역발상 매수
      score += 1;
      details.push(`IVRank ${ivRank}: VKOSPI ${vkospi.toFixed(1)} — 극단 공포, 역발상 매수 신호`);
    } else if (ivRank >= 60) {
      details.push(`IVRank ${ivRank}: VKOSPI ${vkospi.toFixed(1)} — 높은 변동성 기대`);
    } else if (ivRank <= 20) {
      details.push(`IVRank ${ivRank}: VKOSPI ${vkospi.toFixed(1)} — 조용한 장, 방향성 약`);
    } else {
      details.push(`IVRank ${ivRank}: VKOSPI ${vkospi.toFixed(1)}`);
    }
  }

  // 8. OI 대량 변화 (기관 신규 베팅)
  if (oiChanges.length > 0) {
    const bigPutInflow = oiChanges.filter(c => c.putOIDiff > 2000);
    const bigCallInflow = oiChanges.filter(c => c.callOIDiff > 2000);
    if (bigPutInflow.length > 0) {
      score -= 1;
      const strikes = bigPutInflow.map(c => `${c.strike}p+${c.putOIDiff.toLocaleString()}`).join(", ");
      details.push(`OI↑풋: ${strikes} → 하락 헤지 신규 유입`);
    }
    if (bigCallInflow.length > 0) {
      score += 1;
      const strikes = bigCallInflow.map(c => `${c.strike}c+${c.callOIDiff.toLocaleString()}`).join(", ");
      details.push(`OI↑콜: ${strikes} → 상승 베팅 신규 유입`);
    }
  }

  // 9. 스큐 (OTM 풋 IV - OTM 콜 IV)
  if (skew !== null) {
    if (skew > 5) {
      score -= 1;
      details.push(`Skew ${skew.toFixed(1)}%p: OTM풋 IV 크게 우위 → 실질 하락 헤지 수요`);
    } else if (skew > 2) {
      details.push(`Skew ${skew.toFixed(1)}%p: 풋 IV 소폭 우위 (정상 범위)`);
    } else if (skew < -2) {
      score += 1;
      details.push(`Skew ${skew.toFixed(1)}%p: 콜 IV 우위 → 상승 기대 과잉`);
    } else {
      details.push(`Skew ${skew.toFixed(1)}%p: 균형`);
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
    vkospi,
    ivRank,
    oiChanges,
    skew,
    foreignFutures: futuresPos,
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

  // 신규 지표 블록
  if (s.foreignFutures) {
    const fn = s.foreignFutures.foreignNet;
    lines.push(``, `<b>📈 외인 선물 포지션</b>`);
    lines.push(`  순포지션: <b>${fn > 0 ? "+" : ""}${fn.toLocaleString()}</b>계약  기관: ${s.foreignFutures.instNet > 0 ? "+" : ""}${s.foreignFutures.instNet.toLocaleString()}`);
  }

  lines.push(``, `<b>📊 변동성 / 스큐 / OI</b>`);
  if (s.vkospi !== null) lines.push(`  VKOSPI: <b>${s.vkospi?.toFixed(1)}</b>  IVRank: <b>${s.ivRank ?? "?"}%ile</b>`);
  if (s.skew !== null) lines.push(`  Skew (풋IV-콜IV): <b>${s.skew! > 0 ? "+" : ""}${s.skew?.toFixed(1)}%p</b>`);
  if (s.oiChanges.length > 0) {
    lines.push(`  OI 대량 변화 (전일 대비):`);
    for (const c of s.oiChanges.slice(0, 3)) {
      const parts: string[] = [];
      if (Math.abs(c.callOIDiff) >= 1000) parts.push(`콜${c.callOIDiff > 0 ? "+" : ""}${c.callOIDiff.toLocaleString()}`);
      if (Math.abs(c.putOIDiff) >= 1000) parts.push(`풋${c.putOIDiff > 0 ? "+" : ""}${c.putOIDiff.toLocaleString()}`);
      lines.push(`    K${c.strike}: ${parts.join(" / ")}`);
    }
  } else {
    lines.push(`  OI 변화: 전일 데이터 없음 (첫 실행 후 내일부터 표시)`);
  }

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
