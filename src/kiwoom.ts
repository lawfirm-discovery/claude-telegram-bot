import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const KIWOOM_BASE = "https://api.kiwoom.com";
const TOKEN_FILE = join(import.meta.dir, "../.lemonclaw/kiwoom_token.json");

let kiwoomToken: { value: string; expiresAt: number } | null = null;

try {
  if (existsSync(TOKEN_FILE)) {
    const cached = JSON.parse(readFileSync(TOKEN_FILE, "utf-8"));
    if (cached.expiresAt > Date.now()) kiwoomToken = cached;
  }
} catch {}

async function getKiwoomToken(): Promise<string> {
  if (kiwoomToken && Date.now() < kiwoomToken.expiresAt - 60_000) return kiwoomToken.value;

  const appKey = process.env.KIWOOM_APP_KEY;
  const secretKey = process.env.KIWOOM_APP_SECRET;
  if (!appKey || !secretKey) throw new Error("KIWOOM_APP_KEY / KIWOOM_APP_SECRET 미설정");

  const res = await fetch(`${KIWOOM_BASE}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: appKey, secretkey: secretKey }),
  });
  if (!res.ok) throw new Error(`키움 토큰 발급 실패: ${res.status}`);
  const data = (await res.json()) as any;
  if (data.return_code !== 0) throw new Error(`키움 토큰 에러: ${data.return_msg}`);

  const ed = data.expires_dt as string; // "YYYYMMDDHHmmss" KST
  const expiresAt = new Date(
    `${ed.slice(0, 4)}-${ed.slice(4, 6)}-${ed.slice(6, 8)}T${ed.slice(8, 10)}:${ed.slice(10, 12)}:${ed.slice(12, 14)}+09:00`,
  ).getTime();

  kiwoomToken = { value: data.token, expiresAt };
  try { writeFileSync(TOKEN_FILE, JSON.stringify(kiwoomToken)); } catch {}
  return kiwoomToken.value;
}

async function kiwoomPost(path: string, apiId: string, body: Record<string, string>): Promise<any> {
  const token = await getKiwoomToken();
  const res = await fetch(`${KIWOOM_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      Authorization: `Bearer ${token}`,
      "api-id": apiId,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`키움 API 오류: ${res.status}`);
  const data = (await res.json()) as any;
  if (data.return_code !== 0) throw new Error(`키움 API 에러: ${data.return_msg}`);
  return data;
}

function parseQty(raw: string | undefined): number {
  if (!raw) return 0;
  return parseInt(raw.replace(/[^-\d]/g, ""), 10) || 0;
}

// ── Types ────────────────────────────────────────────────────────────────────

export type BrokerSlot = {
  name: string;
  qty: number;   // 순간거래량 (양수=매수, 음수=매도)
  change: number; // 증감
};

export type MajorBrokersResult = {
  stkCd: string;
  buyTop5: BrokerSlot[];
  sellTop5: BrokerSlot[];
  frgnBuySum: number;
  frgnSellSum: number;
  frgnNetSum: number;
  frgnBuyChange: number;
  frgnSellChange: number;
};

// ── ka10040 당일주요거래원 ───────────────────────────────────────────────────

export async function getDailyMajorBrokers(stkCd: string): Promise<MajorBrokersResult> {
  const d = await kiwoomPost("/api/dostk/rkinfo", "ka10040", { stk_cd: stkCd });

  const buyTop5: BrokerSlot[] = [];
  const sellTop5: BrokerSlot[] = [];
  for (let i = 1; i <= 5; i++) {
    if (d[`buy_trde_ori_${i}`]) {
      buyTop5.push({
        name: d[`buy_trde_ori_${i}`],
        qty: parseQty(d[`buy_trde_ori_qty_${i}`]),
        change: parseQty(d[`buy_trde_ori_irds_${i}`]),
      });
    }
    if (d[`sel_trde_ori_${i}`]) {
      sellTop5.push({
        name: d[`sel_trde_ori_${i}`],
        qty: parseQty(d[`sel_trde_ori_qty_${i}`]),
        change: parseQty(d[`sel_trde_ori_irds_${i}`]),
      });
    }
  }

  const frgnBuySum = parseQty(d.frgn_buy_prsm_sum);
  const frgnSellSum = parseQty(d.frgn_sel_prsm_sum);
  const frgnBuyChange = parseQty(d.frgn_buy_prsm_sum_chang);
  const frgnSellChange = parseQty(d.frgn_sel_prsm_sum_chang);

  return {
    stkCd,
    buyTop5,
    sellTop5,
    frgnBuySum,
    frgnSellSum,
    frgnNetSum: frgnBuySum + frgnSellSum,
    frgnBuyChange,
    frgnSellChange,
  };
}

// ── 포맷 ─────────────────────────────────────────────────────────────────────

export function formatMajorBrokers(r: MajorBrokersResult, title?: string): string {
  const fmt = (n: number) => n.toLocaleString("ko-KR");
  const sign = (n: number) => (n >= 0 ? "+" : "");

  const lines: string[] = [];
  lines.push(`📊 <b>${title ?? r.stkCd} 당일주요거래원</b>`);
  lines.push("");

  lines.push("🟢 <b>매수 상위</b>");
  for (const b of r.buyTop5) {
    lines.push(`  ${b.name.trim().padEnd(10)} ${sign(b.qty)}${fmt(b.qty)}주`);
  }
  lines.push("");

  lines.push("🔴 <b>매도 상위</b>");
  for (const s of r.sellTop5) {
    lines.push(`  ${s.name.trim().padEnd(10)} ${fmt(s.qty)}주`);
  }
  lines.push("");

  const netStr = `${sign(r.frgnNetSum)}${fmt(r.frgnNetSum)}`;
  const netEmoji = r.frgnNetSum >= 0 ? "🔵" : "🔴";
  lines.push(`${netEmoji} <b>외국계 합산</b>`);
  lines.push(`  매수 ${sign(r.frgnBuySum)}${fmt(r.frgnBuySum)}주 (증감 ${sign(r.frgnBuyChange)}${fmt(r.frgnBuyChange)})`);
  lines.push(`  매도 ${fmt(r.frgnSellSum)}주 (증감 ${sign(r.frgnSellChange)}${fmt(r.frgnSellChange)})`);
  lines.push(`  순매수 <b>${netStr}주</b>`);

  return lines.join("\n");
}

// ── 폴링 ─────────────────────────────────────────────────────────────────────

type PollingState = {
  timer: ReturnType<typeof setInterval>;
  lastNetSum: number;
};

const pollingMap = new Map<string, PollingState>();

export function startBrokerPolling(
  stkCd: string,
  intervalMs: number,
  onData: (result: MajorBrokersResult, changed: boolean) => void,
  onError: (err: Error) => void,
) {
  stopBrokerPolling(stkCd);
  let lastNetSum: number | null = null;

  const run = async () => {
    try {
      const result = await getDailyMajorBrokers(stkCd);
      const changed = lastNetSum === null || result.frgnNetSum !== lastNetSum;
      lastNetSum = result.frgnNetSum;
      onData(result, changed);
    } catch (e) {
      onError(e as Error);
    }
  };

  run();
  const timer = setInterval(run, intervalMs);
  pollingMap.set(stkCd, { timer, lastNetSum: 0 });
}

export function stopBrokerPolling(stkCd: string) {
  const s = pollingMap.get(stkCd);
  if (s) { clearInterval(s.timer); pollingMap.delete(stkCd); }
}

export function isBrokerPolling(stkCd: string): boolean {
  return pollingMap.has(stkCd);
}

export function listBrokerPolling(): string[] {
  return [...pollingMap.keys()];
}
