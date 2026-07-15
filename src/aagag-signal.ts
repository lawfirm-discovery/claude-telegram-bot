// AAGAG (aagag.com) 커뮤니티 빅데이터 주식 심리 분석
// SII (주식 관심 지수) + SBI (감성 편향 지수) 기반 역발상 트레이딩 시그널
// Playwright 기반 봇탐지 우회 크롤링

import { chromium } from "playwright";

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
    if (schedulerSendFn && schedulerChatId) {
      await schedulerSendFn(schedulerChatId, formatAagagReport(result));
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
): void {
  if (schedulerTimer) return;

  schedulerChatId = chatId;
  schedulerSendFn = sendFn;

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
