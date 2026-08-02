// ── 기관 청산(디레버리징) 조기경보 엔진 ─────────────────────────────────────
// SA 펀드 사태 교훈: 프라임브로커 마진콜 → 숏 어택 → 강제 반대매매 순서를
// 공개 수급·가격·거래량 데이터로 간접 감지한다.

import type { Candle, InvestorTrend } from "./stock";

// ── 테마 그룹 (상관 급락 감지용) ───────────────────────────────────────────────

export const THEME_GROUPS: { name: string; symbols: string[] }[] = [
  { name: "반도체", symbols: ["005930", "000660"] },
  { name: "2차전지", symbols: ["373220", "006400", "003670"] },
  { name: "방산", symbols: ["012450", "047810"] },
  { name: "플랫폼", symbols: ["035420", "035720"] },
  { name: "US_AI", symbols: ["NVDA", "AVGO", "AMD", "PLTR"] },
  { name: "US_빅테크", symbols: ["AAPL", "MSFT", "AMZN", "GOOGL", "META"] },
  { name: "US_기타", symbols: ["TSLA"] },
];

export function getTheme(symbol: string): string | null {
  for (const g of THEME_GROUPS) {
    if (g.symbols.includes(symbol)) return g.name;
  }
  return null;
}

// ── Types ──────────────────────────────────────────────────────────────────────

export type DeleverageSignalType =
  | "SUPPLY_DIVERGENCE"   // 수급 괴리: 호재인데 외국인 대량 매도
  | "CORRELATED_CRASH"    // 상관 급락: 테마 내 동시 -3%
  | "FORCED_LIQUIDATION"; // 투매 시그니처: 거래량 폭증 + 대음봉

export interface DeleverageSignal {
  type: DeleverageSignalType;
  symbol: string;
  name: string;
  market: "KR" | "US";
  date: string;
  severity: number;  // 0~100
  details: string;
  metrics: Record<string, number>;
}

export interface DeleverageAlert {
  level: "YELLOW" | "RED";  // 1/3 = YELLOW, 2/3+ = RED
  date: string;
  signals: DeleverageSignal[];
  summary: string;
}

// ── 신호① 수급 괴리 감지 ──────────────────────────────────────────────────────
// 외국인 N일 연속 순매도 + 주가 하락 → 펀더멘털 무관 강제 청산 의심

export function detectSupplyDivergence(
  symbol: string,
  name: string,
  market: "KR" | "US",
  candles: Candle[],
  investorTrends?: InvestorTrend[],
): DeleverageSignal | null {
  if (candles.length < 10) return null;

  const sorted = [...candles].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const recent5 = sorted.slice(-5);
  const recent10 = sorted.slice(-10);

  // 최근 5일 수익률
  const first = recent5[0]!;
  const last = recent5[recent5.length - 1]!;
  const return5d = (last.closePrice - first.closePrice) / first.closePrice;

  // 최근 5일 평균 거래량 vs 이전 20일 평균 거래량
  const vol5 = recent5.reduce((s, c) => s + c.volume, 0) / 5;
  const prev20 = sorted.slice(-25, -5);
  const volAvg20 = prev20.length > 0
    ? prev20.reduce((s, c) => s + c.volume, 0) / prev20.length
    : vol5;
  const volRatio = volAvg20 > 0 ? vol5 / volAvg20 : 1;

  // 최근 5일 중 음봉 비율
  const bearishDays = recent5.filter(c => c.closePrice < c.openPrice).length;

  // KR: 외국인 수급 데이터 있으면 사용
  let foreignConsecutiveSell = 0;
  let foreignTotalSell = 0;
  if (investorTrends && investorTrends.length >= 3) {
    const recentTrends = investorTrends.slice(0, 5); // 최신순
    for (const t of recentTrends) {
      if (t.foreigner < 0) {
        foreignConsecutiveSell++;
        foreignTotalSell += Math.abs(t.foreigner);
      } else break;
    }
  }

  // 판정: 외국인 3일+ 연속 매도 + 주가 하락 + 거래량 증가
  const hasForeignSelling = foreignConsecutiveSell >= 3;
  const hasPriceDecline = return5d < -0.03; // -3% 이상 하락
  const hasVolumeIncrease = volRatio > 1.5;
  const hasBearishCandles = bearishDays >= 3;

  // KR: 수급 데이터 있으면 수급 기반 판정
  if (market === "KR" && investorTrends && investorTrends.length >= 3) {
    if (!hasForeignSelling) return null;
    if (!hasPriceDecline && !hasVolumeIncrease) return null;
  } else {
    // US 또는 수급 없음: 가격+거래량 기반
    if (!hasPriceDecline) return null;
    if (!hasVolumeIncrease && !hasBearishCandles) return null;
  }

  let severity = 0;
  if (hasForeignSelling) severity += 25 + Math.min(foreignConsecutiveSell - 3, 2) * 10;
  if (hasPriceDecline) severity += Math.min(Math.abs(return5d) * 500, 30);
  if (hasVolumeIncrease) severity += Math.min((volRatio - 1) * 15, 25);
  if (hasBearishCandles) severity += bearishDays * 4;
  severity = Math.min(severity, 100);

  const parts: string[] = [];
  if (hasForeignSelling) parts.push(`외국인 ${foreignConsecutiveSell}일 연속 순매도 (총 ${(foreignTotalSell / 1000).toFixed(0)}K주)`);
  parts.push(`5일 수익률 ${(return5d * 100).toFixed(1)}%`);
  parts.push(`거래량비 ${(volRatio * 100).toFixed(0)}%`);
  parts.push(`음봉 ${bearishDays}/5일`);

  return {
    type: "SUPPLY_DIVERGENCE",
    symbol, name, market,
    date: last.timestamp.slice(0, 10),
    severity,
    details: parts.join(" | "),
    metrics: {
      return5d: return5d * 100,
      volRatio,
      bearishDays,
      foreignConsecutiveSell,
      foreignTotalSell,
    },
  };
}

// ── 신호② 상관 급락 감지 ──────────────────────────────────────────────────────
// 동일 테마 3종목+ 동시 -3% → 숏 어택 / 디레버리징 패턴

export function detectCorrelatedCrash(
  stockReturns: { symbol: string; name: string; market: "KR" | "US"; dailyReturn: number }[],
): DeleverageSignal[] {
  const signals: DeleverageSignal[] = [];
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

  for (const group of THEME_GROUPS) {
    const members = stockReturns.filter(s => group.symbols.includes(s.symbol));
    const crashedMembers = members.filter(s => s.dailyReturn <= -3);

    // 테마 내 절반 이상이 -3% 이상 하락
    const threshold = Math.min(3, Math.ceil(group.symbols.length * 0.5));
    if (crashedMembers.length < threshold) continue;

    const avgDrop = crashedMembers.reduce((s, m) => s + m.dailyReturn, 0) / crashedMembers.length;
    const severity = Math.min(
      30 + crashedMembers.length * 15 + Math.abs(avgDrop) * 5,
      100,
    );

    const details = crashedMembers
      .map(m => `${m.name} ${m.dailyReturn.toFixed(1)}%`)
      .join(", ");

    for (const m of crashedMembers) {
      signals.push({
        type: "CORRELATED_CRASH",
        symbol: m.symbol,
        name: m.name,
        market: m.market,
        date: today,
        severity,
        details: `[${group.name}] ${crashedMembers.length}/${group.symbols.length}종목 동시 급락: ${details}`,
        metrics: {
          crashedCount: crashedMembers.length,
          totalInGroup: group.symbols.length,
          avgDrop,
          themeCrashRatio: crashedMembers.length / group.symbols.length,
        },
      });
    }
  }

  return signals;
}

// ── 신호③ 투매 시그니처 (강제 반대매매) ───────────────────────────────────────
// 거래량 5일평균 대비 3배↑ + 대음봉 → 강제 청산 물량 유입 의심

export function detectForcedLiquidation(
  symbol: string,
  name: string,
  market: "KR" | "US",
  candles: Candle[],
): DeleverageSignal | null {
  if (candles.length < 25) return null;

  const sorted = [...candles].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const today = sorted[sorted.length - 1]!;
  const prev20 = sorted.slice(-21, -1);

  const volAvg = prev20.reduce((s, c) => s + c.volume, 0) / prev20.length;
  const volRatio = volAvg > 0 ? today.volume / volAvg : 1;

  // 대음봉: 종가 < 시가, 몸통이 전체 레인지의 60%+
  const bodySize = Math.abs(today.closePrice - today.openPrice);
  const range = today.highPrice - today.lowPrice;
  const isBearish = today.closePrice < today.openPrice;
  const bodyRatio = range > 0 ? bodySize / range : 0;

  // 당일 하락률
  const prev = sorted[sorted.length - 2]!;
  const dailyReturn = (today.closePrice - prev.closePrice) / prev.closePrice;

  // 판정: 거래량 3배↑ + 음봉 + -2%↓
  if (volRatio < 2.5) return null;
  if (!isBearish) return null;
  if (dailyReturn > -0.02) return null;

  let severity = 0;
  severity += Math.min((volRatio - 2) * 12, 35);
  severity += Math.min(Math.abs(dailyReturn) * 400, 35);
  severity += bodyRatio > 0.7 ? 15 : bodyRatio > 0.5 ? 10 : 5;
  // 장중 저가가 종가 대비 매우 낮으면 (패닉셀 흔적) 보너스
  const lowerWick = (today.closePrice - today.lowPrice) / today.closePrice;
  if (lowerWick > 0.03) severity += 15;
  severity = Math.min(severity, 100);

  return {
    type: "FORCED_LIQUIDATION",
    symbol, name, market,
    date: today.timestamp.slice(0, 10),
    severity,
    details: `거래량 ${(volRatio).toFixed(1)}배 폭증 | 일봉 ${(dailyReturn * 100).toFixed(1)}% | 몸통비 ${(bodyRatio * 100).toFixed(0)}% | 하꼬리 ${(lowerWick * 100).toFixed(1)}%`,
    metrics: {
      volRatio,
      dailyReturn: dailyReturn * 100,
      bodyRatio,
      lowerWick: lowerWick * 100,
    },
  };
}

// ── 종합 경보 레벨 판정 ───────────────────────────────────────────────────────

export function evaluateDeleverageAlert(
  allSignals: DeleverageSignal[],
): DeleverageAlert | null {
  if (allSignals.length === 0) return null;

  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

  // 종목별로 겹치는 신호 유형 수 카운트
  const bySymbol = new Map<string, Set<DeleverageSignalType>>();
  for (const s of allSignals) {
    if (!bySymbol.has(s.symbol)) bySymbol.set(s.symbol, new Set());
    bySymbol.get(s.symbol)!.add(s.type);
  }

  // 2개+ 신호 유형이 겹치는 종목이 있으면 RED
  const multiSignalStocks = [...bySymbol.entries()]
    .filter(([, types]) => types.size >= 2)
    .map(([sym]) => sym);

  // 전체 발동 신호 유형 수
  const allTypes = new Set(allSignals.map(s => s.type));

  let level: "YELLOW" | "RED";
  if (multiSignalStocks.length > 0 || allTypes.size >= 2) {
    level = "RED";
  } else {
    level = "YELLOW";
  }

  // 요약 생성
  const typeCounts = {
    SUPPLY_DIVERGENCE: allSignals.filter(s => s.type === "SUPPLY_DIVERGENCE").length,
    CORRELATED_CRASH: allSignals.filter(s => s.type === "CORRELATED_CRASH").length,
    FORCED_LIQUIDATION: allSignals.filter(s => s.type === "FORCED_LIQUIDATION").length,
  };

  const parts: string[] = [];
  if (typeCounts.SUPPLY_DIVERGENCE > 0) parts.push(`수급괴리 ${typeCounts.SUPPLY_DIVERGENCE}건`);
  if (typeCounts.CORRELATED_CRASH > 0) parts.push(`상관급락 ${typeCounts.CORRELATED_CRASH}건`);
  if (typeCounts.FORCED_LIQUIDATION > 0) parts.push(`투매시그니처 ${typeCounts.FORCED_LIQUIDATION}건`);

  const summary = `[${level}] 기관 청산 조기경보 — ${parts.join(", ")} (${allSignals.length}건 총 발동)`;

  return { level, date: today, signals: allSignals, summary };
}

// ── 포맷 (텔레그램 HTML) ──────────────────────────────────────────────────────

const SIGNAL_LABELS: Record<DeleverageSignalType, string> = {
  SUPPLY_DIVERGENCE: "📉 수급 괴리",
  CORRELATED_CRASH: "🔗 상관 급락",
  FORCED_LIQUIDATION: "💥 투매 시그니처",
};

export function formatDeleverageAlert(alert: DeleverageAlert): string {
  const icon = alert.level === "RED" ? "🔴" : "🟡";
  const lines: string[] = [
    `${icon} <b>기관 청산 조기경보 [${alert.level}]</b>`,
    `📅 ${alert.date}`,
    "",
  ];

  // 신호 유형별 그룹
  const byType = new Map<DeleverageSignalType, DeleverageSignal[]>();
  for (const s of alert.signals) {
    if (!byType.has(s.type)) byType.set(s.type, []);
    byType.get(s.type)!.push(s);
  }

  for (const [type, signals] of byType) {
    lines.push(`<b>${SIGNAL_LABELS[type]}</b> (${signals.length}건)`);
    // 중복 제거 (상관 급락은 테마당 1줄)
    const seen = new Set<string>();
    for (const s of signals) {
      const key = type === "CORRELATED_CRASH" ? s.details.split("]")[0] + "]" : s.symbol;
      if (seen.has(key)) continue;
      seen.add(key);
      const flag = s.market === "KR" ? "🇰🇷" : "🇺🇸";
      if (type === "CORRELATED_CRASH") {
        lines.push(`  ${flag} ${s.details}`);
      } else {
        lines.push(`  ${flag} <b>${s.name}</b> (${s.symbol}) — 심각도 ${s.severity}`);
        lines.push(`     ${s.details}`);
      }
    }
    lines.push("");
  }

  // 교차 신호 종목 강조
  const bySymbol = new Map<string, Set<DeleverageSignalType>>();
  for (const s of alert.signals) {
    if (!bySymbol.has(s.symbol)) bySymbol.set(s.symbol, new Set());
    bySymbol.get(s.symbol)!.add(s.type);
  }
  const multiHits = [...bySymbol.entries()]
    .filter(([, types]) => types.size >= 2)
    .map(([sym, types]) => {
      const s = alert.signals.find(x => x.symbol === sym)!;
      return `⚠️ <b>${s.name}</b>: ${[...types].map(t => SIGNAL_LABELS[t]).join(" + ")}`;
    });

  if (multiHits.length > 0) {
    lines.push("<b>⚡ 복수 신호 교차 종목</b>");
    lines.push(...multiHits);
    lines.push("");
  }

  lines.push(
    "<i>SA 펀드형 디레버리징 패턴 감지 엔진</i>",
    "<i>PB 마진콜→숏어택→강제반대매매 순서를 공개 데이터로 간접 추적</i>",
  );

  return lines.join("\n");
}
