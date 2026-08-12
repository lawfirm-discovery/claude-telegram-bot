// src/econ-calendar.ts
// 당일 고위험 USD 경제지표 조회 (CPI·FOMC·PPI·NFP 등)
// 소스: Nasdaq Economic Calendar API (무료, 인증 불필요)

export interface EconEvent {
  gmt:       string;   // "08:30" (ET 시간으로 표시됨)
  country:   string;
  eventName: string;
  actual:    string;   // "&nbsp;" = 미발표
  consensus: string;
}

export interface EconCalendarResult {
  events:   EconEvent[];  // 당일 고위험 USD 이벤트 전체
  released: EconEvent[];  // actual 있는 것 (발표 완료)
  pending:  EconEvent[];  // actual 없는 것 (미발표)
  score:    number;
  detail:   string;
}

// 고위험 이벤트 판별 (eventName 기반)
const HIGH_IMPACT_PATTERN = /\b(cpi|core cpi|ppi|core ppi|pce|core pce|non.farm|nfp|unemployment rate|fed funds|fomc|gdp|retail sales|initial jobless)\b/i;

// 실제값 파싱: "0.2%" → 0.2, "&nbsp;" | "" → null
function parseNum(s: string | null | undefined): number | null {
  if (!s || s === "&nbsp;" || s.trim() === "") return null;
  const n = parseFloat(s.replace(/[%KMBk,\s]/g, "").trim());
  return isNaN(n) ? null : n;
}

// 인플레이션 지표: actual < consensus → 비둘기 → 상승
// 실업률: actual < consensus → 상승
// 성장/고용: actual > consensus → 상승 (단 NFP는 큰 단위)
function scoreEvent(e: EconEvent): number {
  const name = e.eventName.toLowerCase();
  const actual = parseNum(e.actual);
  const consensus = parseNum(e.consensus);

  if (actual === null || consensus === null) return 0;
  const diff = actual - consensus;

  // "Index" 절대값 지표는 스코어링 제외 (퍼센트 임계값 기준 부적합)
  if (/index/i.test(e.eventName)) return 0;
  const isInflation = /cpi|pce|ppi/.test(name);
  const isUnemployment = /unemployment rate/.test(name);
  const isGrowth = /gdp|non.farm|nfp|retail sales/.test(name);

  if (isInflation) {
    if      (diff < -0.2) return +1.0;   // 큰폭 하회 → 강한 비둘기
    else if (diff < -0.05) return +0.5;  // 소폭 하회
    else if (diff > 0.2)  return -1.0;   // 큰폭 상회 → 매파 압력
    else if (diff > 0.05) return -0.5;   // 소폭 상회
    return 0;
  }
  if (isUnemployment) {
    return diff < -0.1 ? +0.5 : diff > 0.1 ? -0.5 : 0;
  }
  if (isGrowth) {
    // NFP는 수만 단위, GDP는 0.x%
    const threshold = /non.farm|nfp/.test(name) ? 50 : 0.3;
    return diff > threshold ? +0.5 : diff < -threshold ? -0.5 : 0;
  }
  return 0;
}

export async function getEconCalendar(): Promise<EconCalendarResult | null> {
  try {
    // Nasdaq API는 KST 날짜 기준으로 이벤트를 노출함 (실험적으로 확인)
    const kstDate = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

    const res = await fetch(`https://api.nasdaq.com/api/calendar/economicevents?date=${kstDate}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://www.nasdaq.com/market-activity/economic-calendar",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;

    const data = await res.json() as { data?: { rows?: any[] } };
    const rows: EconEvent[] = data?.data?.rows ?? [];

    // 미국 + 고위험 이벤트 필터
    const highUS = rows.filter(r =>
      r.country === "United States" &&
      HIGH_IMPACT_PATTERN.test(r.eventName)
    );

    if (highUS.length === 0) {
      return { events: [], released: [], pending: [], score: 0, detail: `당일(KST ${kstDate}) 고위험 USD 이벤트 없음` };
    }

    const isReleased = (e: EconEvent) =>
      e.actual && e.actual !== "&nbsp;" && e.actual.trim() !== "";

    const released = highUS.filter(isReleased);
    const pending   = highUS.filter(e => !isReleased(e));

    // 종합 스코어 — 중복 이벤트 많으면 튀지 않게 클램프
    let score = released.reduce((s, e) => s + scoreEvent(e), 0);
    if (pending.length > 0) score -= 0.2;   // 미발표 = 불확실성 패널티
    score = Math.max(-2, Math.min(2, score));

    // 상세 설명 생성
    const fmt = (e: EconEvent) => {
      const s = scoreEvent(e);
      const arrow = s > 0 ? "✅하회" : s < 0 ? "⚠️상회" : "부합";
      return `${e.eventName} ${e.actual}(예측 ${e.consensus || "?"}) ${arrow}`;
    };
    const relDesc = released.map(fmt);
    const penDesc = pending.map(e => `${e.eventName} 미발표(예측 ${e.consensus || "?"})`);
    const detail = [...relDesc, ...penDesc].join(" · ") || "데이터 없음";

    return { events: highUS, released, pending, score, detail };
  } catch (e: any) {
    console.error(`[EconCalendar] 조회 실패: ${e.message}`);
    return null;
  }
}
