// Reddit 커뮤니티 빅데이터 주식 심리 분석 (aagag.com → reddit.com 전환)
// SII (주식 관심 지수) + SBI (감성 편향 지수) 기반 역발상 트레이딩 시그널
// Reddit JSON API 사용 — Playwright 불필요, 무인증

import postgres from "postgres";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AagagPost {
  title: string;
  commentCount: number;
  timeStr?: string;
  ageInHours?: number;
}

export interface KeywordStat {
  keyword: string;
  posts: number;
  totalComments: number;
  weighted: number; // SII 기여분 합계
}

export interface AagagResult {
  date: string;
  time: string;
  stockInterestIndex: number;   // SII_t
  sentimentBiasIndex: number;   // SBI_t  [-1, 1]
  signal: "BUY" | "SELL" | "HOLD";
  reason: string;
  generalStats: KeywordStat[];
  sellStats: KeywordStat[];     // 낙관 과열 키워드
  buyStats: KeywordStat[];      // 공포 과열 키워드
}

// ── Constants ─────────────────────────────────────────────────────────────────

// 관심도 측정 서브레딧 (한국 시장 관련)
const SUBREDDITS_GENERAL = "investing+stocks+Korea+StockMarket+SecurityAnalysis";
// 감성 측정 서브레딧 (감정적 언어가 활발한 곳)
const SUBREDDITS_SENTIMENT = "investing+stocks+wallstreetbets+StockMarket";

const BETA = 0.5;            // 댓글 로그 가중 상수
const LIMIT_SII = 3.0;      // 최소 관심도 기준선 (Reddit 볼륨 기준, aagag 5.0에서 조정)
const MAX_POST_AGE_HOURS = 36;
const BUY_SBI  = -0.30;     // 공포 과열 → 역발상 매수 트리거
const SELL_SBI =  0.30;     // 낙관 과열 → 역발상 매도 트리거

// 주식 관심도 키워드 (SII 계산) — 한국 시장 관련 영문 키워드
const GENERAL_KEYWORDS = [
  "KOSPI", "Samsung", "Korea market", "SK Hynix",
  "Korean stocks", "Hyundai", "KOSDAQ", "Kakao",
];

// 감성 편향 키워드 (SBI 계산)
const SELL_KEYWORDS = ["bull run", "rally", "moon", "all time high"];  // 낙관 과열 → 역발상 매도
const BUY_KEYWORDS  = ["crash", "bear market", "recession", "panic sell"]; // 공포 과열 → 역발상 매수

// ── Math ──────────────────────────────────────────────────────────────────────

function logWeight(comments: number): number {
  return 1 + BETA * Math.log(comments + 1);
}

function calcWeightedSum(posts: AagagPost[]): number {
  return posts.reduce((sum, p) => sum + logWeight(p.commentCount), 0);
}

// ── Reddit API Fetcher ────────────────────────────────────────────────────────

interface RedditChild {
  data: {
    title: string;
    num_comments: number;
    score: number;
    subreddit: string;
    created_utc: number;
  };
}

interface RedditResponse {
  data: {
    children: RedditChild[];
  };
}

async function fetchRedditPosts(
  keyword: string,
  subreddits: string,
  retries = 2,
): Promise<AagagPost[]> {
  const params = new URLSearchParams({
    q: keyword,
    sort: "new",
    t: "week",        // 1주 범위로 가져온 뒤 36시간 로컬 필터링
    limit: "100",
    restrict_sr: "on",
  });
  const url = `https://www.reddit.com/r/${subreddits}/search.json?${params}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "KoreaStockSentiment/1.0 (automated sentiment analysis)",
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const json = (await res.json()) as RedditResponse;
      const nowSec = Date.now() / 1000;

      return json.data.children
        .map((child) => {
          const d = child.data;
          const ageInHours = (nowSec - d.created_utc) / 3600;
          return {
            title: d.title,
            commentCount: d.num_comments,
            timeStr: `${ageInHours.toFixed(1)}h ago`,
            ageInHours,
          };
        })
        .filter((p) => (p.ageInHours ?? 9999) <= MAX_POST_AGE_HOURS);

    } catch (e: any) {
      if (attempt < retries) {
        console.warn(`[Reddit] "${keyword}" 실패, 재시도 (${attempt}/${retries}): ${e.message}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      console.error(`[Reddit] "${keyword}" 최종 실패: ${e.message}`);
      return [];
    }
  }

  return [];
}

// ── Signal Generation ─────────────────────────────────────────────────────────

function buildKeywordStat(keyword: string, posts: AagagPost[]): KeywordStat {
  return {
    keyword,
    posts: posts.length,
    totalComments: posts.reduce((s, p) => s + p.commentCount, 0),
    weighted: calcWeightedSum(posts),
  };
}

export function generateAagagSignal(
  generalMap: Map<string, AagagPost[]>,
  sellMap: Map<string, AagagPost[]>,
  buyMap: Map<string, AagagPost[]>,
): AagagResult {
  const now = new Date(Date.now() + 9 * 3600_000);
  const date = now.toISOString().slice(0, 10);
  const time = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;

  // SII: 주식 전반 관심 지수
  let sii = 0;
  const generalStats: KeywordStat[] = [];
  for (const kw of GENERAL_KEYWORDS) {
    const posts = generalMap.get(kw) ?? [];
    const stat = buildKeywordStat(kw, posts);
    generalStats.push(stat);
    sii += stat.weighted;
  }

  // SBI 분자/분모 계산
  let sumSell = 0;
  const sellStats: KeywordStat[] = [];
  for (const kw of SELL_KEYWORDS) {
    const posts = sellMap.get(kw) ?? [];
    const stat = buildKeywordStat(kw, posts);
    sellStats.push(stat);
    sumSell += stat.weighted;
  }

  let sumBuy = 0;
  const buyStats: KeywordStat[] = [];
  for (const kw of BUY_KEYWORDS) {
    const posts = buyMap.get(kw) ?? [];
    const stat = buildKeywordStat(kw, posts);
    buyStats.push(stat);
    sumBuy += stat.weighted;
  }

  const denom = sumSell + sumBuy;
  const sbi = denom > 0 ? (sumSell - sumBuy) / (denom + 1e-6) : 0;

  // 시그널 결정
  let signal: "BUY" | "SELL" | "HOLD" = "HOLD";
  let reason = "시장에 뚜렷한 감정 쏠림 현상이 관측되지 않아 관망을 추천합니다.";

  if (sii < LIMIT_SII) {
    reason = "Reddit 한국 시장 관련 관심도가 임계 수준 미달. 신호 신뢰도 낮음.";
  } else if (sbi <= BUY_SBI) {
    signal = "BUY";
    reason = `Reddit에 crash/recession 공포 여론이 과열. 역발상 단기 과매도 국면 추정 → 매수 신호 (SBI: ${sbi.toFixed(4)})`;
  } else if (sbi >= SELL_SBI) {
    signal = "SELL";
    reason = `Reddit에 bull run/moon 낙관 여론이 과열. 대중 광풍 극단 상태 → 분할 매도 신호 (SBI: ${sbi.toFixed(4)})`;
  }

  return { date, time, stockInterestIndex: sii, sentimentBiasIndex: sbi, signal, reason, generalStats, sellStats, buyStats };
}

// ── Full Pipeline ─────────────────────────────────────────────────────────────

export async function runAagagPipeline(): Promise<AagagResult> {
  console.log("[Reddit] 심리 분석 파이프라인 시작...");

  // 일반 관심도 키워드 병렬 크롤링 (3개씩 묶어서 과부하 방지)
  const generalMap = new Map<string, AagagPost[]>();
  for (let i = 0; i < GENERAL_KEYWORDS.length; i += 3) {
    const batch = GENERAL_KEYWORDS.slice(i, i + 3);
    const results = await Promise.all(
      batch.map((kw) => fetchRedditPosts(kw, SUBREDDITS_GENERAL)),
    );
    batch.forEach((kw, idx) => generalMap.set(kw, results[idx]!));
    if (i + 3 < GENERAL_KEYWORDS.length) await new Promise((r) => setTimeout(r, 1000));
  }

  // 감성 편향 키워드 크롤링
  const [sellResults, buyResults] = await Promise.all([
    Promise.all(SELL_KEYWORDS.map((kw) => fetchRedditPosts(kw, SUBREDDITS_SENTIMENT))),
    Promise.all(BUY_KEYWORDS.map((kw) => fetchRedditPosts(kw, SUBREDDITS_SENTIMENT))),
  ]);

  const sellMap = new Map<string, AagagPost[]>();
  SELL_KEYWORDS.forEach((kw, i) => sellMap.set(kw, sellResults[i]!));

  const buyMap = new Map<string, AagagPost[]>();
  BUY_KEYWORDS.forEach((kw, i) => buyMap.set(kw, buyResults[i]!));

  const result = generateAagagSignal(generalMap, sellMap, buyMap);
  console.log(`[Reddit] 완료 — SII: ${result.stockInterestIndex.toFixed(2)}, SBI: ${result.sentimentBiasIndex.toFixed(4)}, 신호: ${result.signal}`);
  return result;
}

// ── Formatter ─────────────────────────────────────────────────────────────────

const SIGNAL_EMOJI: Record<string, string> = {
  BUY: "🟢",
  SELL: "🔴",
  HOLD: "⚪",
};

const SIGNAL_LABEL: Record<string, string> = {
  BUY: "역발상 매수",
  SELL: "역발상 매도",
  HOLD: "관망",
};

export function formatAagagReport(r: AagagResult): string {
  const sbiBar = (() => {
    const pct = Math.round((r.sentimentBiasIndex + 1) / 2 * 10);
    return "▓".repeat(pct) + "░".repeat(10 - pct);
  })();

  const siiDisplay = r.stockInterestIndex.toFixed(1);
  const sbiDisplay = r.sentimentBiasIndex.toFixed(4);
  const emoji = SIGNAL_EMOJI[r.signal] ?? "⚪";
  const label = SIGNAL_LABEL[r.signal] ?? r.signal;

  const generalLines = r.generalStats
    .map((s) => `  <code>${s.keyword.padEnd(16)}</code> ${s.posts}건 / 댓글 ${s.totalComments}개`)
    .join("\n");

  const sellLines = r.sellStats
    .map((s) => `  <code>${s.keyword.padEnd(16)}</code> ${s.posts}건 / 댓글 ${s.totalComments}개`)
    .join("\n");

  const buyLines = r.buyStats
    .map((s) => `  <code>${s.keyword.padEnd(16)}</code> ${s.posts}건 / 댓글 ${s.totalComments}개`)
    .join("\n");

  return [
    `${emoji} <b>Reddit 커뮤니티 심리 분석</b> — ${r.date} ${r.time} KST`,
    ``,
    `<b>📊 주식 관심 지수 (SII)</b>`,
    `  <b>${siiDisplay}</b>  (기준선 ${LIMIT_SII})`,
    ``,
    `<b>📈 한국 시장 키워드 (관심도)</b>`,
    `  <i>r/investing+stocks+Korea+StockMarket</i>`,
    generalLines,
    ``,
    `<b>🔴 낙관 과열 키워드 (매도 신호 역발상)</b>`,
    `  <i>r/investing+stocks+wallstreetbets</i>`,
    sellLines,
    ``,
    `<b>🟢 공포 과열 키워드 (매수 신호 역발상)</b>`,
    `  <i>r/investing+stocks+wallstreetbets</i>`,
    buyLines,
    ``,
    `<b>🧭 감성 편향 지수 (SBI)</b>`,
    `  공포 ◀ [${sbiBar}] ▶ 탐욕`,
    `  <b>${sbiDisplay}</b>  (매수<${BUY_SBI} | 매도>${SELL_SBI})`,
    ``,
    `<b>⚡ 역발상 시그널: ${emoji} ${label}</b>`,
    `  ${r.reason}`,
  ].join("\n");
}

// ── Scheduler (09:00 / 16:00 KST) ────────────────────────────────────────────

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let schedulerChatId = "";
let schedulerSendFn: ((chatId: string, text: string) => Promise<void>) | null = null;
let schedulerSendPhotoFn: ((chatId: string, image: Buffer, caption: string) => Promise<void>) | null = null;
let lastRunDate = "";
let lastRunHour = -1;
let isRunning = false;

function nowKST() {
  return new Date(Date.now() + 9 * 3600_000);
}

async function schedulerTick(): Promise<void> {
  const kst = nowKST();
  const day = kst.getUTCDay(); // 0=일, 6=토
  if (day === 0 || day === 6) return; // 주말 제외

  const h = kst.getUTCHours();
  const m = kst.getUTCMinutes();
  const dateStr = kst.toISOString().slice(0, 10);

  // 09:00~09:05 또는 16:00~16:05 에만 실행, 같은 날 같은 시간 중복 방지
  const isScheduled =
    (h === 9 && m < 6) ||
    (h === 16 && m < 6);

  if (!isScheduled) return;
  if (dateStr === lastRunDate && h === lastRunHour) return;
  if (isRunning) return;

  isRunning = true;
  lastRunDate = dateStr;
  lastRunHour = h;

  try {
    const result = await runAagagPipeline();
    await saveAagagResult(result);
    if (schedulerSendFn && schedulerChatId) {
      await schedulerSendFn(schedulerChatId, formatAagagReport(result));
      try {
        const chartImage = await generateAagagChart(60);
        if (schedulerSendPhotoFn) {
          await schedulerSendPhotoFn(schedulerChatId, chartImage, "Reddit 심리 추이 (최근 60일)");
        }
      } catch (chartErr: any) {
        console.warn(`[Reddit] 차트 전송 실패: ${chartErr.message}`);
      }
    }
  } catch (e: any) {
    console.error(`[Reddit] 스케줄 실행 실패: ${e.message}`);
    if (schedulerSendFn && schedulerChatId) {
      await schedulerSendFn(schedulerChatId, `❌ Reddit 심리 분석 실패: ${e.message}`);
    }
  } finally {
    isRunning = false;
  }
}

export function startAagagMonitor(
  chatId: string,
  sendFn: (chatId: string, text: string) => Promise<void>,
  sendPhotoFn?: (chatId: string, image: Buffer, caption: string) => Promise<void>,
): void {
  if (schedulerTimer) return;

  schedulerChatId = chatId;
  schedulerSendFn = sendFn;
  schedulerSendPhotoFn = sendPhotoFn ?? null;

  console.log("[Reddit] 심리 모니터 시작 — 09:00/16:00 KST 스케줄");

  schedulerTimer = setInterval(
    () => schedulerTick().catch((e) => console.error(`[Reddit] 스케줄러 오류: ${e.message}`)),
    60_000,
  );
}

export function stopAagagMonitor(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log("[Reddit] 심리 모니터 중지");
  }
}

export function isAagagMonitorRunning(): boolean {
  return schedulerTimer !== null;
}

// ── PostgreSQL (n100) ─────────────────────────────────────────────────────────

const AAGAG_DB_URL = process.env.AAGAG_DB_URL || "postgres://pylon:415416@192.168.0.61:5432/pylon";
const sql = postgres(AAGAG_DB_URL, { max: 3, idle_timeout: 30, connect_timeout: 10 });

let _tableReady = false;

async function ensureTable(): Promise<void> {
  if (_tableReady) return;
  try {
    await sql`CREATE TABLE IF NOT EXISTS aagag_daily (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      sii DOUBLE PRECISION NOT NULL,
      sbi DOUBLE PRECISION NOT NULL,
      signal TEXT NOT NULL,
      reason TEXT,
      sell_폭등 INTEGER DEFAULT 0, sell_급등 INTEGER DEFAULT 0, sell_급상승 INTEGER DEFAULT 0,
      buy_폭락 INTEGER DEFAULT 0, buy_급락 INTEGER DEFAULT 0, buy_급하락 INTEGER DEFAULT 0,
      sell_폭등_comments INTEGER DEFAULT 0, sell_급등_comments INTEGER DEFAULT 0, sell_급상승_comments INTEGER DEFAULT 0,
      buy_폭락_comments INTEGER DEFAULT 0, buy_급락_comments INTEGER DEFAULT 0, buy_급하락_comments INTEGER DEFAULT 0,
      general_json JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(date, time)
    )`;
    _tableReady = true;
  } catch (e: any) {
    console.error(`[Reddit] 테이블 생성 실패: ${e.message}`);
  }
}

export async function saveAagagResult(r: AagagResult): Promise<void> {
  try {
    await ensureTable();

    // sell/buy 첫 3개 키워드를 기존 컬럼에 매핑 (하위 호환)
    const s = r.sellStats;
    const b = r.buyStats;

    // general_json에 전체 stats 저장 (키워드 변경 이력 보존)
    const fullJson = {
      general: r.generalStats,
      sell: r.sellStats,
      buy: r.buyStats,
    };

    await sql`INSERT INTO aagag_daily
      (date, time, sii, sbi, signal, reason,
       sell_폭등, sell_급등, sell_급상승,
       buy_폭락, buy_급락, buy_급하락,
       sell_폭등_comments, sell_급등_comments, sell_급상승_comments,
       buy_폭락_comments, buy_급락_comments, buy_급하락_comments,
       general_json)
      VALUES (
        ${r.date}, ${r.time}, ${r.stockInterestIndex}, ${r.sentimentBiasIndex}, ${r.signal}, ${r.reason},
        ${s[0]?.posts ?? 0}, ${s[1]?.posts ?? 0}, ${s[2]?.posts ?? 0},
        ${b[0]?.posts ?? 0}, ${b[1]?.posts ?? 0}, ${b[2]?.posts ?? 0},
        ${s[0]?.totalComments ?? 0}, ${s[1]?.totalComments ?? 0}, ${s[2]?.totalComments ?? 0},
        ${b[0]?.totalComments ?? 0}, ${b[1]?.totalComments ?? 0}, ${b[2]?.totalComments ?? 0},
        ${JSON.stringify(fullJson)}
      )
      ON CONFLICT (date, time) DO UPDATE SET
        sii = EXCLUDED.sii, sbi = EXCLUDED.sbi, signal = EXCLUDED.signal, reason = EXCLUDED.reason,
        sell_폭등 = EXCLUDED.sell_폭등, sell_급등 = EXCLUDED.sell_급등, sell_급상승 = EXCLUDED.sell_급상승,
        buy_폭락 = EXCLUDED.buy_폭락, buy_급락 = EXCLUDED.buy_급락, buy_급하락 = EXCLUDED.buy_급하락,
        sell_폭등_comments = EXCLUDED.sell_폭등_comments, sell_급등_comments = EXCLUDED.sell_급등_comments, sell_급상승_comments = EXCLUDED.sell_급상승_comments,
        buy_폭락_comments = EXCLUDED.buy_폭락_comments, buy_급락_comments = EXCLUDED.buy_급락_comments, buy_급하락_comments = EXCLUDED.buy_급하락_comments,
        general_json = EXCLUDED.general_json
    `;
    console.log(`[Reddit] DB 저장 완료: ${r.date} ${r.time}`);
  } catch (e: any) {
    console.error(`[Reddit] DB 저장 실패: ${e.message}`);
  }
}

export interface AagagDailyRow {
  date: string;
  time: string;
  sii: number;
  sbi: number;
  signal: string;
  sell_폭등: number; sell_급등: number; sell_급상승: number;
  buy_폭락: number; buy_급락: number; buy_급하락: number;
  sell_폭등_comments: number; sell_급등_comments: number; sell_급상승_comments: number;
  buy_폭락_comments: number; buy_급락_comments: number; buy_급하락_comments: number;
}

export async function getAagagHistory(days = 60): Promise<AagagDailyRow[]> {
  try {
    await ensureTable();
    const rows = await sql`
      SELECT * FROM aagag_daily
      ORDER BY date DESC, time DESC
      LIMIT ${days * 2}
    `;
    return (Array.from(rows) as AagagDailyRow[]).reverse();
  } catch (e: any) {
    console.error(`[Reddit] DB 조회 실패: ${e.message}`);
    return [];
  }
}

// ── Chart Generation (Bar + Line Combo) ───────────────────────────────────────

const CHART_W = 1000, CHART_H = 560;
const CPAD = { l: 60, r: 60, t: 48, b: 60 };

function buildAagagChartHtml(rows: AagagDailyRow[]): string {
  return `<!DOCTYPE html><html><head><style>
body { margin:0; background:#131722; }
canvas { display:block; }
</style></head><body>
<canvas id="c" width="${CHART_W}" height="${CHART_H}"></canvas>
<script>
(function() {
const data = ${JSON.stringify(rows)};
const cv = document.getElementById('c');
const ctx = cv.getContext('2d');
const W = ${CHART_W}, H = ${CHART_H};
const PAD = {l:${CPAD.l}, r:${CPAD.r}, t:${CPAD.t}, b:${CPAD.b}};
const CW = W - PAD.l - PAD.r;
const CH = H - PAD.t - PAD.b;
const n = data.length;
if (n === 0) return;

ctx.fillStyle = '#131722';
ctx.fillRect(0, 0, W, H);

const siiVals = data.map(d => d.sii);
const maxSii = Math.max(...siiVals, 20) * 1.15;
const sbiMin = -1, sbiMax = 1;
const colW = CW / n;
const barW = Math.max(4, colW * 0.7);

function xAt(i) { return PAD.l + (i + 0.5) * colW; }
function yLeftAt(v) { return PAD.t + (1 - v / maxSii) * CH; }
function yRightAt(v) { return PAD.t + (sbiMax - v) / (sbiMax - sbiMin) * CH; }

ctx.setLineDash([]);
for (let i = 0; i <= 5; i++) {
  const y = PAD.t + i * CH / 5;
  ctx.strokeStyle = '#252540';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();

  const siiVal = maxSii * (1 - i / 5);
  ctx.fillStyle = '#778ca3';
  ctx.font = '11px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(siiVal.toFixed(0), PAD.l - 6, y + 4);

  const sbiVal = sbiMax - i * (sbiMax - sbiMin) / 5;
  ctx.textAlign = 'left';
  ctx.fillText(sbiVal.toFixed(1), W - PAD.r + 6, y + 4);
}

[{v: 0.30, c: '#ef5350', label: 'SELL 0.30'}, {v: -0.30, c: '#26a69a', label: 'BUY -0.30'}].forEach(trig => {
  const y = yRightAt(trig.v);
  ctx.strokeStyle = trig.c;
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 4]);
  ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = trig.c;
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(trig.label, W - PAD.r + 4, y - 4);
});

const y0 = yRightAt(0);
ctx.strokeStyle = '#555';
ctx.lineWidth = 1;
ctx.setLineDash([2, 2]);
ctx.beginPath(); ctx.moveTo(PAD.l, y0); ctx.lineTo(W - PAD.r, y0); ctx.stroke();
ctx.setLineDash([]);

ctx.fillStyle = '#778ca3';
ctx.font = '10px monospace';
ctx.textAlign = 'center';
const labelStep = Math.max(1, Math.floor(n / 12));
for (let i = 0; i < n; i += labelStep) {
  const d = data[i];
  const label = d.date.slice(5) + ' ' + d.time;
  ctx.save();
  ctx.translate(xAt(i), H - PAD.b + 14);
  ctx.rotate(-0.5);
  ctx.fillText(label, 0, 0);
  ctx.restore();
}

data.forEach((d, i) => {
  const x = xAt(i);
  const barTop = yLeftAt(d.sii);
  const barBottom = yLeftAt(0);
  const barH = barBottom - barTop;

  ctx.fillStyle = 'rgba(66,133,244,0.35)';
  ctx.fillRect(x - barW/2, barTop, barW, barH);
  ctx.strokeStyle = 'rgba(66,133,244,0.6)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x - barW/2, barTop, barW, barH);

  const sellTotal = (d.sell_폭등 || 0) + (d.sell_급등 || 0) + (d.sell_급상승 || 0);
  const buyTotal = (d.buy_폭락 || 0) + (d.buy_급락 || 0) + (d.buy_급하락 || 0);
  const totalKw = sellTotal + buyTotal;

  if (totalKw > 0 && barH > 4) {
    if (sellTotal > 0) {
      const sellH = Math.max(2, (sellTotal / Math.max(totalKw, 1)) * barH * 0.8);
      ctx.fillStyle = 'rgba(239,83,80,0.55)';
      ctx.fillRect(x - barW/2 + 1, barTop + 1, barW - 2, Math.min(sellH, barH - 2));
    }
    if (buyTotal > 0) {
      const buyH = Math.max(2, (buyTotal / Math.max(totalKw, 1)) * barH * 0.8);
      ctx.fillStyle = 'rgba(38,166,154,0.55)';
      ctx.fillRect(x - barW/2 + 1, barBottom - Math.min(buyH, barH - 2) - 1, barW - 2, Math.min(buyH, barH - 2));
    }

    if (barH > 28 && colW > 16) {
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'center';
      if (sellTotal > 0) {
        ctx.fillStyle = '#ff9999';
        ctx.fillText(sellTotal.toString(), x, barTop + 14);
      }
      if (buyTotal > 0) {
        ctx.fillStyle = '#80e5d8';
        ctx.fillText(buyTotal.toString(), x, barBottom - 6);
      }
    }
  }
});

ctx.strokeStyle = '#ffd700';
ctx.lineWidth = 2.5;
ctx.setLineDash([]);
ctx.beginPath();
data.forEach((d, i) => {
  const x = xAt(i);
  const y = yRightAt(d.sbi);
  if (i === 0) ctx.moveTo(x, y);
  else ctx.lineTo(x, y);
});
ctx.stroke();

data.forEach((d, i) => {
  const x = xAt(i);
  const y = yRightAt(d.sbi);
  ctx.beginPath();
  ctx.arc(x, y, 3, 0, Math.PI * 2);
  ctx.fillStyle = d.signal === 'BUY' ? '#26a69a' : d.signal === 'SELL' ? '#ef5350' : '#ffd700';
  ctx.fill();
});

ctx.fillStyle = '#ffffff';
ctx.font = 'bold 14px monospace';
ctx.textAlign = 'left';
ctx.fillText('Reddit 주식 심리 지수 — SII/SBI (최근 ' + n + '회)', PAD.l, 28);

ctx.font = '11px monospace';
ctx.fillStyle = '#4285f4';
ctx.textAlign = 'right';
ctx.fillText('SII ▲', PAD.l - 6, PAD.t - 8);
ctx.fillStyle = '#ffd700';
ctx.textAlign = 'left';
ctx.fillText('▲ SBI', W - PAD.r + 6, PAD.t - 8);

const legends = [
  {label: 'SII (관심도)', color: 'rgba(66,133,244,0.6)', type: 'rect'},
  {label: '낙관 키워드', color: 'rgba(239,83,80,0.7)', type: 'rect'},
  {label: '공포 키워드', color: 'rgba(38,166,154,0.7)', type: 'rect'},
  {label: 'SBI (감성편향)', color: '#ffd700', type: 'line'},
];
let lx = PAD.l + 10;
legends.forEach(l => {
  if (l.type === 'rect') {
    ctx.fillStyle = l.color;
    ctx.fillRect(lx, 36, 12, 8);
  } else {
    ctx.strokeStyle = l.color;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(lx, 40); ctx.lineTo(lx + 12, 40); ctx.stroke();
  }
  ctx.fillStyle = '#aaa';
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(l.label, lx + 16, 44);
  lx += l.label.length * 7 + 36;
});

})();
</script></body></html>`;
}

export async function generateAagagChart(days = 60): Promise<Buffer> {
  const rows = await getAagagHistory(days);
  if (rows.length === 0) throw new Error("Reddit 심리 데이터가 없습니다. 첫 스캔 후 그래프가 생성됩니다.");

  const { chromium } = await import("playwright");
  const html = buildAagagChartHtml(rows);
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: CHART_W, height: CHART_H });
    await page.setContent(html, { waitUntil: "networkidle" });
    const shot = await page.screenshot({ type: "png" });
    return Buffer.from(shot);
  } finally {
    await browser.close();
  }
}
