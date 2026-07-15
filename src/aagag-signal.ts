// AAGAG (aagag.com) 커뮤니티 빅데이터 주식 심리 분석
// SII (주식 관심 지수) + SBI (감성 편향 지수) 기반 역발상 트레이딩 시그널
// Playwright 기반 봇탐지 우회 크롤링 + SQLite 데이터 저장 + 차트 생성

import { chromium } from "playwright";
import postgres from "postgres";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AagagPost {
  title: string;
  commentCount: number;
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
  sellStats: KeywordStat[];     // 급등/과연
  buyStats: KeywordStat[];      // 폭락/급락
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ROOT_URL = "https://aagag.com/issue/";

// iPhone SA 모바일 UA — 안티 애드블록 검사 루틴 우회
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1";

const BETA = 0.5;         // 댓글 로그 가중 상수
const LIMIT_SII = 10.0;  // 최소 시장 활성 관심도 기준선
const BUY_SBI = -0.30;   // 매수 트리거 임계값 (폭락/급락 공포 과열)
const SELL_SBI = 0.30;   // 매도 트리거 임계값 (급등/과연 낙관 과열)

// 주식 관심도 측정 키워드 (SII 계산)
const GENERAL_KEYWORDS = ["주식", "증시", "코스피", "코스닥", "나스닥", "삼전", "매수", "매도"];

// 감성 편향 키워드 (SBI 계산)
const SELL_KEYWORDS = ["폭등", "급등", "급상승"];       // 낙관 과열 → 역발상 매도
const BUY_KEYWORDS  = ["폭락", "급락", "급하락"];       // 공포 과열 → 역발상 매수

// ── Math ──────────────────────────────────────────────────────────────────────

function logWeight(comments: number): number {
  return 1 + BETA * Math.log(comments + 1);
}

function calcSII(posts: AagagPost[]): number {
  return posts.reduce((sum, p) => sum + logWeight(p.commentCount), 0);
}

function calcWeightedSum(posts: AagagPost[]): number {
  return posts.reduce((sum, p) => sum + logWeight(p.commentCount), 0);
}

// ── Stealth Crawler ───────────────────────────────────────────────────────────

async function fetchKeywordPosts(keyword: string, retries = 2): Promise<AagagPost[]> {
  const url = `${ROOT_URL}?word=${encodeURIComponent(keyword)}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-dev-shm-usage",
      ],
    });

    try {
      const context = await browser.newContext({
        userAgent: MOBILE_UA,
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        locale: "ko-KR",
        extraHTTPHeaders: {
          "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
          "Referer": "https://aagag.com/",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });

      // navigator.webdriver 및 자동화 흔적 제거
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
        Object.defineProperty(navigator, "languages", { get: () => ["ko-KR", "ko"] });
        // Playwright 전역 제거
        // @ts-ignore
        delete window.__playwright;
        // @ts-ignore
        delete window.__pw_manual;
        // @ts-ignore
        delete window._playwrightGlobal;
      });

      const page = await context.newPage();

      // 네트워크 유휴 시까지 대기
      await page.goto(url, { waitUntil: "networkidle", timeout: 50_000 });

      // 스크립트 실행 분석 시간 확보 — 난수 기반 지연 (1000~2500ms)
      const delay = Math.floor(Math.random() * 1500) + 1000;
      await page.waitForTimeout(delay);

      // page.evaluate 는 브라우저 컨텍스트에서 실행 — DOM API는 런타임에 존재하므로 any 캐스팅
      const posts = await page.evaluate((): { title: string; commentCount: number }[] => {
        const doc = (globalThis as any).document as {
          querySelectorAll: (s: string) => ArrayLike<any>;
        };
        const results: { title: string; commentCount: number }[] = [];

        // 1순위: #left_side 내 링크 (문서 명세 기준)
        const primaryLinks = doc.querySelectorAll(
          "#left_side div.la.tleft a, #left_side > div.la.tleft > * a"
        );

        // 2순위: 일반 리스트 컨테이너
        const fallbackLinks = doc.querySelectorAll(
          "div.issue_list a, ul.list_container li a, .list_title a, li.issue a, .la.tleft a"
        );

        const linkSet = primaryLinks.length > 0 ? primaryLinks : fallbackLinks;

        Array.from(linkSet).forEach((el: any) => {
          const rawText: string = el.textContent?.trim() || "";
          if (!rawText || rawText.length < 2) return;

          let commentCount = 0;
          const parent: any = el.closest("li, div.item, div.row, tr, article") || el.parentElement;

          if (parent) {
            // span 기반 댓글 수 파싱
            const cSpan: any = parent.querySelector(
              "span.comment_num, span.reply_count, span.c_count, em.num, span.num_reply, b.num, strong.num"
            );
            if (cSpan) {
              const raw: string = (cSpan.textContent || "").replace(/[^0-9]/g, "") || "0";
              commentCount = raw ? parseInt(raw, 10) : 0;
            }

            // 제목 안 [숫자] 패턴 백업 파싱
            if (commentCount === 0) {
              const m = rawText.match(/\[(\d+)\]$/);
              if (m) commentCount = parseInt(m[1]!, 10);
            }
          }

          // 꼬리 [숫자] 제거 후 제목 정제
          const cleanTitle = rawText.replace(/\[\d+\]$/, "").trim();
          if (cleanTitle.length >= 2) {
            results.push({ title: cleanTitle, commentCount });
          }
        });

        return results;
      });

      await browser.close();

      // 파싱 결과가 없으면 재시도 (WAF 막힌 경우)
      if (posts.length === 0 && attempt < retries) {
        console.warn(`[AAGAG] "${keyword}" 파싱 결과 없음, 재시도 (${attempt}/${retries})`);
        await new Promise(r => setTimeout(r, 3000 * attempt));
        continue;
      }

      return posts;
    } catch (e: any) {
      await browser.close();
      if (attempt < retries) {
        console.warn(`[AAGAG] "${keyword}" 크롤링 실패, 재시도 (${attempt}/${retries}): ${e.message}`);
        await new Promise(r => setTimeout(r, 3000 * attempt));
        continue;
      }
      console.error(`[AAGAG] "${keyword}" 최종 실패: ${e.message}`);
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
    reason = "주식 시장 전반에 대한 커뮤니티 관심도가 임계 수준 미달. 노이즈 과대로 신호 생략.";
  } else if (sbi <= BUY_SBI) {
    signal = "BUY";
    reason = `커뮤니티에 폭락/급락 공포 여론이 과열 누적. 역발상 관점 단기 과매도 국면으로 추정 → 매수 신호 (SBI: ${sbi.toFixed(4)})`;
  } else if (sbi >= SELL_SBI) {
    signal = "SELL";
    reason = `커뮤니티에 급등/과연 낙관 여론이 과열 팽배. 대중 광풍 극단 상태 → 분할 매도 신호 (SBI: ${sbi.toFixed(4)})`;
  }

  return { date, time, stockInterestIndex: sii, sentimentBiasIndex: sbi, signal, reason, generalStats, sellStats, buyStats };
}

// ── Full Pipeline ─────────────────────────────────────────────────────────────

export async function runAagagPipeline(): Promise<AagagResult> {
  console.log("[AAGAG] 심리 분석 파이프라인 시작...");

  // 일반 관심도 키워드 병렬 크롤링 (3개씩 묶어서 과부하 방지)
  const generalMap = new Map<string, AagagPost[]>();
  for (let i = 0; i < GENERAL_KEYWORDS.length; i += 3) {
    const batch = GENERAL_KEYWORDS.slice(i, i + 3);
    const results = await Promise.all(batch.map(kw => fetchKeywordPosts(kw)));
    batch.forEach((kw, idx) => generalMap.set(kw, results[idx]!));
    if (i + 3 < GENERAL_KEYWORDS.length) await new Promise(r => setTimeout(r, 2000));
  }

  // 감성 편향 키워드 크롤링
  const [sellResults, buyResults] = await Promise.all([
    Promise.all(SELL_KEYWORDS.map(kw => fetchKeywordPosts(kw))),
    Promise.all(BUY_KEYWORDS.map(kw => fetchKeywordPosts(kw))),
  ]);

  const sellMap = new Map<string, AagagPost[]>();
  SELL_KEYWORDS.forEach((kw, i) => sellMap.set(kw, sellResults[i]!));

  const buyMap = new Map<string, AagagPost[]>();
  BUY_KEYWORDS.forEach((kw, i) => buyMap.set(kw, buyResults[i]!));

  const result = generateAagagSignal(generalMap, sellMap, buyMap);

  console.log(`[AAGAG] 완료 — SII: ${result.stockInterestIndex.toFixed(2)}, SBI: ${result.sentimentBiasIndex.toFixed(4)}, 신호: ${result.signal}`);
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
    .map(s => `  <code>${s.keyword.padEnd(4)}</code> ${s.posts}건 / 댓글 ${s.totalComments}개`)
    .join("\n");

  const sellLines = r.sellStats
    .map(s => `  <code>${s.keyword.padEnd(4)}</code> ${s.posts}건 / 댓글 ${s.totalComments}개`)
    .join("\n");

  const buyLines = r.buyStats
    .map(s => `  <code>${s.keyword.padEnd(4)}</code> ${s.posts}건 / 댓글 ${s.totalComments}개`)
    .join("\n");

  return [
    `${emoji} <b>AAGAG 커뮤니티 심리 분석</b> — ${r.date} ${r.time} KST`,
    ``,
    `<b>📊 주식 관심 지수 (SII)</b>`,
    `  <b>${siiDisplay}</b>  (기준선 ${LIMIT_SII})`,
    ``,
    `<b>📈 일반 키워드 (관심도)</b>`,
    generalLines,
    ``,
    `<b>🔴 매도 키워드 (낙관 과열)</b>`,
    sellLines,
    ``,
    `<b>🟢 매수 키워드 (공포 과열)</b>`,
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
          await schedulerSendPhotoFn(schedulerChatId, chartImage, "AAGAG 심리 추이 (최근 60일)");
        }
      } catch (chartErr: any) {
        console.warn(`[AAGAG] 차트 전송 실패: ${chartErr.message}`);
      }
    }
  } catch (e: any) {
    console.error(`[AAGAG] 스케줄 실행 실패: ${e.message}`);
    if (schedulerSendFn && schedulerChatId) {
      await schedulerSendFn(schedulerChatId, `❌ AAGAG 심리 분석 실패: ${e.message}`);
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

  console.log("[AAGAG] 심리 모니터 시작 — 09:00/16:00 KST 스케줄");

  // 1분 주기로 스케줄 체크
  schedulerTimer = setInterval(
    () => schedulerTick().catch(e => console.error(`[AAGAG] 스케줄러 오류: ${e.message}`)),
    60_000,
  );
}

export function stopAagagMonitor(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log("[AAGAG] 심리 모니터 중지");
  }
}

export function isAagagMonitorRunning(): boolean {
  return schedulerTimer !== null;
}

// ── PostgreSQL (n100) ─────────────────────────────────────────────────────────

const AAGAG_DB_URL = process.env.AAGAG_DB_URL || "postgres://pylon:415416@100.65.20.81:5432/pylon";
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
    console.error(`[AAGAG] 테이블 생성 실패: ${e.message}`);
  }
}

export async function saveAagagResult(r: AagagResult): Promise<void> {
  try {
    await ensureTable();
    const sellMap: Record<string, { posts: number; comments: number }> = {};
    r.sellStats.forEach(s => { sellMap[s.keyword] = { posts: s.posts, comments: s.totalComments }; });
    const buyMap: Record<string, { posts: number; comments: number }> = {};
    r.buyStats.forEach(s => { buyMap[s.keyword] = { posts: s.posts, comments: s.totalComments }; });

    await sql`INSERT INTO aagag_daily
      (date, time, sii, sbi, signal, reason,
       sell_폭등, sell_급등, sell_급상승,
       buy_폭락, buy_급락, buy_급하락,
       sell_폭등_comments, sell_급등_comments, sell_급상승_comments,
       buy_폭락_comments, buy_급락_comments, buy_급하락_comments,
       general_json)
      VALUES (
        ${r.date}, ${r.time}, ${r.stockInterestIndex}, ${r.sentimentBiasIndex}, ${r.signal}, ${r.reason},
        ${sellMap["폭등"]?.posts ?? 0}, ${sellMap["급등"]?.posts ?? 0}, ${sellMap["급상승"]?.posts ?? 0},
        ${buyMap["폭락"]?.posts ?? 0}, ${buyMap["급락"]?.posts ?? 0}, ${buyMap["급하락"]?.posts ?? 0},
        ${sellMap["폭등"]?.comments ?? 0}, ${sellMap["급등"]?.comments ?? 0}, ${sellMap["급상승"]?.comments ?? 0},
        ${buyMap["폭락"]?.comments ?? 0}, ${buyMap["급락"]?.comments ?? 0}, ${buyMap["급하락"]?.comments ?? 0},
        ${JSON.stringify(r.generalStats)}
      )
      ON CONFLICT (date, time) DO UPDATE SET
        sii = EXCLUDED.sii, sbi = EXCLUDED.sbi, signal = EXCLUDED.signal, reason = EXCLUDED.reason,
        sell_폭등 = EXCLUDED.sell_폭등, sell_급등 = EXCLUDED.sell_급등, sell_급상승 = EXCLUDED.sell_급상승,
        buy_폭락 = EXCLUDED.buy_폭락, buy_급락 = EXCLUDED.buy_급락, buy_급하락 = EXCLUDED.buy_급하락,
        sell_폭등_comments = EXCLUDED.sell_폭등_comments, sell_급등_comments = EXCLUDED.sell_급등_comments, sell_급상승_comments = EXCLUDED.sell_급상승_comments,
        buy_폭락_comments = EXCLUDED.buy_폭락_comments, buy_급락_comments = EXCLUDED.buy_급락_comments, buy_급하락_comments = EXCLUDED.buy_급하락_comments,
        general_json = EXCLUDED.general_json
    `;
    console.log(`[AAGAG] DB 저장 완료: ${r.date} ${r.time}`);
  } catch (e: any) {
    console.error(`[AAGAG] DB 저장 실패: ${e.message}`);
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
    console.error(`[AAGAG] DB 조회 실패: ${e.message}`);
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

// background
ctx.fillStyle = '#131722';
ctx.fillRect(0, 0, W, H);

// ── SII range (bars, left Y axis) ──
const siiVals = data.map(d => d.sii);
const maxSii = Math.max(...siiVals, 20) * 1.15;

// ── SBI range (line, right Y axis) ──
const sbiMin = -1, sbiMax = 1;

const colW = CW / n;
const barW = Math.max(4, colW * 0.7);

function xAt(i) { return PAD.l + (i + 0.5) * colW; }
function yLeftAt(v) { return PAD.t + (1 - v / maxSii) * CH; }
function yRightAt(v) { return PAD.t + (sbiMax - v) / (sbiMax - sbiMin) * CH; }

// ── Grid ──
ctx.setLineDash([]);
for (let i = 0; i <= 5; i++) {
  const y = PAD.t + i * CH / 5;
  ctx.strokeStyle = '#252540';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();

  // left Y labels (SII)
  const siiVal = maxSii * (1 - i / 5);
  ctx.fillStyle = '#778ca3';
  ctx.font = '11px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(siiVal.toFixed(0), PAD.l - 6, y + 4);

  // right Y labels (SBI)
  const sbiVal = sbiMax - i * (sbiMax - sbiMin) / 5;
  ctx.textAlign = 'left';
  ctx.fillText(sbiVal.toFixed(1), W - PAD.r + 6, y + 4);
}

// ── SBI trigger lines ──
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

// ── SBI zero line ──
const y0 = yRightAt(0);
ctx.strokeStyle = '#555';
ctx.lineWidth = 1;
ctx.setLineDash([2, 2]);
ctx.beginPath(); ctx.moveTo(PAD.l, y0); ctx.lineTo(W - PAD.r, y0); ctx.stroke();
ctx.setLineDash([]);

// ── X-axis date labels ──
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

// ── Stacked bars (SII = total bar height, sell/buy keyword counts overlaid inside) ──
data.forEach((d, i) => {
  const x = xAt(i);
  const barTop = yLeftAt(d.sii);
  const barBottom = yLeftAt(0);
  const barH = barBottom - barTop;

  // Full SII bar (dark blue)
  ctx.fillStyle = 'rgba(66,133,244,0.35)';
  ctx.fillRect(x - barW/2, barTop, barW, barH);
  ctx.strokeStyle = 'rgba(66,133,244,0.6)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x - barW/2, barTop, barW, barH);

  // Sell keyword overlay (red, from top)
  const sellTotal = (d.sell_폭등 || 0) + (d.sell_급등 || 0) + (d.sell_급상승 || 0);
  // Buy keyword overlay (green, from bottom)
  const buyTotal = (d.buy_폭락 || 0) + (d.buy_급락 || 0) + (d.buy_급하락 || 0);
  const totalKw = sellTotal + buyTotal;

  if (totalKw > 0 && barH > 4) {
    // Sell portion (red, top of bar)
    if (sellTotal > 0) {
      const sellH = Math.max(2, (sellTotal / Math.max(totalKw, 1)) * barH * 0.8);
      ctx.fillStyle = 'rgba(239,83,80,0.55)';
      ctx.fillRect(x - barW/2 + 1, barTop + 1, barW - 2, Math.min(sellH, barH - 2));
    }
    // Buy portion (green, bottom of bar)
    if (buyTotal > 0) {
      const buyH = Math.max(2, (buyTotal / Math.max(totalKw, 1)) * barH * 0.8);
      ctx.fillStyle = 'rgba(38,166,154,0.55)';
      ctx.fillRect(x - barW/2 + 1, barBottom - Math.min(buyH, barH - 2) - 1, barW - 2, Math.min(buyH, barH - 2));
    }

    // Keyword count text inside bar (if bar is tall enough)
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

// ── SBI line (right Y axis) ──
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

// ── SBI dots colored by signal ──
data.forEach((d, i) => {
  const x = xAt(i);
  const y = yRightAt(d.sbi);
  ctx.beginPath();
  ctx.arc(x, y, 3, 0, Math.PI * 2);
  ctx.fillStyle = d.signal === 'BUY' ? '#26a69a' : d.signal === 'SELL' ? '#ef5350' : '#ffd700';
  ctx.fill();
});

// ── Title ──
ctx.fillStyle = '#ffffff';
ctx.font = 'bold 14px monospace';
ctx.textAlign = 'left';
ctx.fillText('AAGAG 커뮤니티 심리 지수 (최근 ' + n + '회)', PAD.l, 28);

// ── Axis labels ──
ctx.font = '11px monospace';
ctx.fillStyle = '#4285f4';
ctx.textAlign = 'right';
ctx.fillText('SII ▲', PAD.l - 6, PAD.t - 8);
ctx.fillStyle = '#ffd700';
ctx.textAlign = 'left';
ctx.fillText('▲ SBI', W - PAD.r + 6, PAD.t - 8);

// ── Legend ──
const legends = [
  {label: 'SII (관심도)', color: 'rgba(66,133,244,0.6)', type: 'rect'},
  {label: '매도 키워드', color: 'rgba(239,83,80,0.7)', type: 'rect'},
  {label: '매수 키워드', color: 'rgba(38,166,154,0.7)', type: 'rect'},
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
  if (rows.length === 0) throw new Error("AAGAG 데이터가 없습니다. 첫 스캔 후 그래프가 생성됩니다.");

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
