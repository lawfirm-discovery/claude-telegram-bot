// 반도체 섹터 실적 컨센서스 수집기
// - 미국: Alpha Vantage EARNINGS API (NVDA/AMD/MU/TSM/AVGO/MRVL)
// - 한국: DART 공시 API (삼성전자/SK하이닉스)
// → n100 PostgreSQL semiconductor_earnings 테이블

import { readFileSync } from "fs";
import postgres from "postgres";

for (const line of readFileSync(".env", "utf-8").split("\n")) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const sql = postgres({
  host: "100.65.20.81",
  port: 5432,
  database: "pylon",
  username: "pylon",
  password: "415416",
});

// ── 대상 종목 ────────────────────────────────────────────────────────────────
const US_STOCKS = [
  { symbol: "NVDA", name: "엔비디아",  weight: 2.0 },
  { symbol: "AMD",  name: "AMD",       weight: 1.5 },
  { symbol: "MU",   name: "마이크론",  weight: 1.5 },
  { symbol: "TSM",  name: "TSMC",      weight: 2.0 },
  { symbol: "AVGO", name: "브로드컴",  weight: 1.5 },
  { symbol: "MRVL", name: "마벨",      weight: 1.0 },
  { symbol: "INTC", name: "인텔",      weight: 1.0 },
  { symbol: "QCOM", name: "퀄컴",      weight: 1.0 },
];

const KR_STOCKS = [
  { symbol: "005930", name: "삼성전자",   weight: 2.0, dartCode: "00126380" },
  { symbol: "000660", name: "SK하이닉스", weight: 2.0, dartCode: "00164779" },
  // 한미반도체(042700): DART 연결재무 없음 — 추후 추가
];

// ── Alpha Vantage: 미국 실적 수집 ────────────────────────────────────────────
async function fetchAlphaVantageEarnings(symbol: string): Promise<any[]> {
  const key = process.env.ALPHA_VANTAGE_KEY!;
  const url = `https://www.alphavantage.co/query?function=EARNINGS&symbol=${symbol}&apikey=${key}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as any;

  if (data.Note || data.Information) {
    throw new Error(`API 제한: ${data.Note ?? data.Information}`);
  }

  return data.quarterlyEarnings ?? [];
}

// Alpha Vantage INCOME_STATEMENT로 매출 컨센서스 보완
async function fetchAlphaVantageRevenue(symbol: string): Promise<Map<string, { reported: number; estimated: number }>> {
  const key = process.env.ALPHA_VANTAGE_KEY!;
  const url = `https://www.alphavantage.co/query?function=INCOME_STATEMENT&symbol=${symbol}&apikey=${key}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return new Map();
  const data = await res.json() as any;

  const map = new Map<string, { reported: number; estimated: number }>();
  for (const q of data.quarterlyReports ?? []) {
    const rev = parseInt(q.totalRevenue ?? "0");
    if (rev > 0) map.set(q.fiscalDateEnding, { reported: rev, estimated: 0 });
  }
  return map;
}

async function collectUSEarnings(): Promise<number> {
  let saved = 0;

  for (const stock of US_STOCKS) {
    try {
      console.log(`  [US] ${stock.name} (${stock.symbol}) 수집 중...`);
      // Rate limit: 분당 5회 → 13초 간격
      await new Promise(r => setTimeout(r, 13000));

      const quarters = await fetchAlphaVantageEarnings(stock.symbol);
      if (!quarters.length) {
        console.log(`    → 데이터 없음`);
        continue;
      }

      // 최근 8분기만 저장 (2년치)
      const recent = quarters.slice(0, 8);

      for (const q of recent) {
        const fiscalDate = q.fiscalDateEnding;
        const reportedDate = q.reportedDate || null;
        const reportedEps = parseFloat(q.reportedEPS ?? "0") || null;
        const estimatedEps = parseFloat(q.estimatedEPS ?? "0") || null;
        const surprisePct = parseFloat(q.surprisePercentage ?? "0") || null;
        const surprise = parseFloat(q.surprise ?? "0") || null;

        await sql`
          INSERT INTO semiconductor_earnings
            (symbol, name, market, fiscal_date_ending, reported_date,
             reported_eps, estimated_eps, eps_surprise, eps_surprise_pct, weight)
          VALUES
            (${stock.symbol}, ${stock.name}, 'US', ${fiscalDate}, ${reportedDate},
             ${reportedEps}, ${estimatedEps}, ${surprise}, ${surprisePct}, ${stock.weight})
          ON CONFLICT (symbol, fiscal_date_ending) DO UPDATE SET
            reported_date = EXCLUDED.reported_date,
            reported_eps = EXCLUDED.reported_eps,
            estimated_eps = EXCLUDED.estimated_eps,
            eps_surprise = EXCLUDED.eps_surprise,
            eps_surprise_pct = EXCLUDED.eps_surprise_pct,
            weight = EXCLUDED.weight
        `;
        saved++;
      }
      console.log(`    → ${recent.length}분기 저장 완료`);
    } catch (e: any) {
      console.error(`    ⚠️ ${stock.symbol} 오류: ${e.message}`);
    }
  }

  return saved;
}

// ── DART API: 한국 실적 수집 ─────────────────────────────────────────────────
async function fetchDartFinancials(dartCode: string, symbol: string, name: string, weight: number): Promise<number> {
  const dartKey = process.env.DART_API_KEY;
  if (!dartKey) {
    console.log(`    DART_API_KEY 없음 — 스킵`);
    return 0;
  }

  // reprt_code: 11011=1Q, 11012=반기(2Q), 11013=3Q, 11014=사업보고서(4Q/연간)
  const quarterMap: Record<string, { month: string; label: string }> = {
    "11011": { month: "03-31", label: "1Q" },
    "11012": { month: "06-30", label: "2Q" },
    "11013": { month: "09-30", label: "3Q" },
    "11014": { month: "12-31", label: "4Q" },
  };
  const currentYear = new Date().getFullYear();

  let saved = 0;
  for (const year of [currentYear, currentYear - 1, currentYear - 2]) {
    for (const [reprtCode, info] of Object.entries(quarterMap)) {
      try {
        await new Promise(r => setTimeout(r, 300));
        const url = `https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json?crtfc_key=${dartKey}&corp_code=${dartCode}&bsns_year=${year}&reprt_code=${reprtCode}&fs_div=CFS`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) continue;
        const data = await res.json() as any;
        if (data.status !== "000" || !data.list?.length) continue;

        const list: any[] = data.list;

        // 손익계산서 항목만 필터 (account_id 기준)
        const revenue = list.find(r =>
          r.account_nm === "매출액" || r.account_id === "ifrs-full_Revenue"
        );
        const opIncome = list.find(r =>
          r.account_nm === "영업이익" || r.account_id === "dart_OperatingIncomeLoss"
        );

        const toNum = (v: string | undefined) =>
          v ? parseInt(v.replace(/,/g, ""), 10) || null : null;

        const revenueVal = toNum(revenue?.thstrm_amount);
        const opIncomeVal = toNum(opIncome?.thstrm_amount);
        const fiscalDate = `${year}-${info.month}`;

        if (revenueVal) {
          await sql`
            INSERT INTO semiconductor_earnings
              (symbol, name, market, fiscal_date_ending, reported_revenue, weight)
            VALUES
              (${symbol}, ${name}, 'KR', ${fiscalDate}, ${revenueVal}, ${weight})
            ON CONFLICT (symbol, fiscal_date_ending) DO UPDATE SET
              reported_revenue = EXCLUDED.reported_revenue,
              weight = EXCLUDED.weight
          `;
          console.log(`    ${info.label} ${year}: 매출 ${(revenueVal / 1e12).toFixed(1)}조 저장`);
          saved++;
        }
      } catch {}
    }
  }
  return saved;
}

async function collectKREarnings(): Promise<number> {
  let saved = 0;
  for (const stock of KR_STOCKS) {
    console.log(`  [KR] ${stock.name} (${stock.symbol}) DART 수집 중...`);
    const n = await fetchDartFinancials(stock.dartCode, stock.symbol, stock.name, stock.weight);
    console.log(`    → ${n}건 저장`);
    saved += n;
  }
  return saved;
}

// ── 최근 실적 서프라이즈 요약 (predict_kospi.ts용) ───────────────────────────
export async function getRecentEarningsSurprise(daysBefore = 30): Promise<{
  avgSurprisePct: number;
  weightedSurprisePct: number;
  records: { symbol: string; name: string; surprisePct: number; weight: number; reportedDate: string }[];
  hasData: boolean;
} | null> {
  try {
    const rows = await sql<{
      symbol: string; name: string; eps_surprise_pct: number;
      weight: number; reported_date: string;
    }[]>`
      SELECT symbol, name, eps_surprise_pct, weight, reported_date::text
      FROM semiconductor_earnings
      WHERE reported_date >= NOW() - INTERVAL '${sql.unsafe(String(daysBefore))} days'
        AND eps_surprise_pct IS NOT NULL
        AND market = 'US'
      ORDER BY reported_date DESC
    `;

    if (!rows.length) return { avgSurprisePct: 0, weightedSurprisePct: 0, records: [], hasData: false };

    // 이상치 캡: INTC처럼 EPS≈0일 때 서프라이즈%가 수백%로 튀는 경우 제한
    const CAP = 30;
    const cap = (v: number) => Math.max(-CAP, Math.min(CAP, v));

    const totalWeight = rows.reduce((s, r) => s + (Number(r.weight) ?? 1), 0);
    const weightedSum = rows.reduce((s, r) => s + cap(Number(r.eps_surprise_pct)) * (Number(r.weight) ?? 1), 0);
    const avgSurprisePct = rows.reduce((s, r) => s + cap(Number(r.eps_surprise_pct)), 0) / rows.length;

    return {
      avgSurprisePct,
      weightedSurprisePct: totalWeight > 0 ? weightedSum / totalWeight : 0,
      records: rows.map(r => ({
        symbol: r.symbol, name: r.name,
        surprisePct: Number(r.eps_surprise_pct),
        weight: Number(r.weight),
        reportedDate: r.reported_date,
      })),
      hasData: true,
    };
  } catch {
    return null;
  }
}

// ── 메인 실행 ────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n💾 반도체 섹터 실적 컨센서스 수집 시작");
  console.log("=".repeat(50));

  console.log("\n[1/2] 미국 주식 (Alpha Vantage)...");
  console.log("  ⚠️  Rate limit: 종목당 13초 대기 (무료 플랜 분당 5회 제한)");
  const usCount = await collectUSEarnings();
  console.log(`  → 총 ${usCount}건 저장`);

  console.log("\n[2/2] 한국 주식 (DART API)...");
  const krCount = await collectKREarnings();
  console.log(`  → 총 ${krCount}건 저장`);

  // 최근 서프라이즈 요약
  console.log("\n📊 최근 30일 실적 서프라이즈 요약:");
  const summary = await getRecentEarningsSurprise(30);
  if (summary?.hasData) {
    for (const r of summary.records) {
      const icon = r.surprisePct > 0 ? "🟢" : "🔴";
      console.log(`  ${icon} ${r.name}(${r.symbol}): EPS ${r.surprisePct > 0 ? "+" : ""}${r.surprisePct.toFixed(1)}% 서프라이즈 | 발표 ${r.reportedDate}`);
    }
    console.log(`  가중평균 서프라이즈: ${summary.weightedSurprisePct > 0 ? "+" : ""}${summary.weightedSurprisePct.toFixed(2)}%`);
  } else {
    console.log("  최근 30일 내 실적 발표 없음");
  }

  await sql.end();
  console.log("\n✅ 완료");
}

// 직접 실행 시에만 main() 호출
if (import.meta.main) {
  await main();
}
