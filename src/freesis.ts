// FreeSIS (금융투자협회) 증시자금추이 API
// 직접 REST API 호출 — Playwright 불필요
// API: POST http://freesis.kofia.or.kr/meta/getMetaDataList.do

const FREESIS_BASE = "http://freesis.kofia.or.kr";
const REFERER = `${FREESIS_BASE}/stat/FreeSIS.do?parentDivId=MSIS10000000000000&serviceId=STATSCU0100000060`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export type MarketFundRow = {
  date: string;              // YYYYMMDD
  investorDeposit: number;   // 투자자예탁금 (백만원)
  derivativesDeposit: number; // 장내파생상품 거래예수금 (백만원)
  rpBalance: number;         // 대고객 RP 매도잔고 (백만원)
  marginReceivable: number;  // 위탁매매 미수금 (백만원)
  forcedSell: number;        // 실제 반대매매금액 (백만원)
  forcedSellRate: number;    // 반대매매율 (%)
};

function yyyymmddToDisplay(d: string): string {
  return `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`;
}

function toDateParam(daysAgo = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

export async function fetchMarketFundFlow(days = 10): Promise<MarketFundRow[]> {
  const endDate = toDateParam(0);
  const startDate = toDateParam(days + 5); // 공휴일 고려해 여유분

  const body = JSON.stringify({
    dmSearch: {
      tmpV40: "1000000",
      tmpV41: "1",
      tmpV1: "D",
      tmpV45: startDate,
      tmpV46: endDate,
      OBJ_NM: "STATSCU0100000060BO",
    },
  });

  const res = await fetch(`${FREESIS_BASE}/meta/getMetaDataList.do`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Referer": REFERER,
      "User-Agent": UA,
    },
    body,
  });

  if (!res.ok) throw new Error(`FreeSIS HTTP ${res.status}`);

  const json = await res.json() as { ds1?: Array<Record<string, number | string>> };
  const rows = json.ds1 ?? [];

  return rows.slice(0, days).map(r => ({
    date: String(r.TMPV1),
    investorDeposit: Number(r.TMPV2) || 0,
    derivativesDeposit: Number(r.TMPV3) || 0,
    rpBalance: Number(r.TMPV4) || 0,
    marginReceivable: Number(r.TMPV5) || 0,
    forcedSell: Number(r.TMPV6) || 0,
    forcedSellRate: Number(r.TMPV7) || 0,
  }));
}

function fmt조(val: number): string {
  const 조 = val / 100_0000; // 백만원 → 조원
  return `${조.toFixed(1)}조`;
}

function fmt억(val: number): string {
  const 억 = val / 100; // 백만원 → 억원
  return `${억.toFixed(0)}억`;
}

function fmtDiff(curr: number, prev: number): string {
  const diff = curr - prev;
  const pct = prev > 0 ? (diff / prev) * 100 : 0;
  const sign = diff >= 0 ? "+" : "";
  return `${sign}${fmt조(diff)} (${sign}${pct.toFixed(1)}%)`;
}

export function formatMarketFundReport(rows: MarketFundRow[]): string {
  if (rows.length === 0) return "데이터 없음";

  const latest = rows[0]!;
  const prev = rows[1];

  const lines: string[] = [
    `<b>📊 증시자금추이</b> (FreeSIS · ${yyyymmddToDisplay(latest.date)})`,
    "",
    `💰 <b>투자자예탁금:</b> ${fmt조(latest.investorDeposit)}`,
  ];

  if (prev) {
    lines.push(`   전일대비: ${fmtDiff(latest.investorDeposit, prev.investorDeposit)}`);
  }

  lines.push(
    `📈 장내파생상품 예수금: ${fmt조(latest.derivativesDeposit)}`,
    `🏦 대고객 RP 잔고: ${fmt조(latest.rpBalance)}`,
    `⚠️ 위탁매매 미수금: ${fmt억(latest.marginReceivable)}`,
    `🔴 반대매매: ${fmt억(latest.forcedSell)} (${latest.forcedSellRate}%)`,
  );

  // 최근 5일 예탁금 추이
  const trend = rows.slice(0, 5);
  if (trend.length > 1) {
    lines.push("", "<b>투자자예탁금 추이 (최근 5일)</b>");
    for (let i = 0; i < trend.length; i++) {
      const r = trend[i]!;
      const p = trend[i + 1];
      const mmdd = `${r.date.slice(4, 6)}/${r.date.slice(6, 8)}`;
      const diffStr = p ? fmtDiff(r.investorDeposit, p.investorDeposit) : "";
      lines.push(`${mmdd}  ${fmt조(r.investorDeposit)}  ${diffStr}`);
    }
  }

  lines.push("", `<i>단위: 백만원 기준 | 출처: FreeSIS(금투협)</i>`);
  return lines.join("\n");
}
