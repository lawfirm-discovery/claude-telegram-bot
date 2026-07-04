import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { getCandles, getPrices } from "./stock";
import {
  LEADING_STOCKS,
  aggregateToWeekly,
  detectSellSignals,
  formatSellAlertGroup,
} from "./sell-signal";
import { detectWbSignals, formatWbAlert } from "./wb-signal";

// ── Config ────────────────────────────────────────────────────────────────────

const WATCHLIST_FILE = join(import.meta.dir, "../.lemonclaw/STOCK_WATCHLIST.md");
const DEDUP_FILE = join(import.meta.dir, "../.lemonclaw/stock_dedup.json");

// 조건 (env로 재정의 가능)
export const CFG = {
  minChangePct:    parseFloat(process.env.STOCK_MIN_CHANGE_PCT    || "5"),   // 전일 대비 최소 상승률
  minExcessPct:    parseFloat(process.env.STOCK_MIN_EXCESS_PCT    || "2"),   // 코스피 대비 최소 초과수익
  minValueBillion: parseFloat(process.env.STOCK_MIN_TRADING_VALUE || "100"), // 최소 거래대금 (억원)
  intervalMs:      parseInt(process.env.STOCK_CHECK_INTERVAL_MS   || "180000"), // 체크 주기 (ms)
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function nowKST(): Date {
  return new Date(Date.now() + 9 * 3600_000);
}

function todayKST(): string {
  return nowKST().toISOString().slice(0, 10); // YYYY-MM-DD
}

function candleDateKST(timestamp: string): string {
  // Toss API timestamp may be KST without timezone suffix — use Intl to extract KST date safely
  return new Date(timestamp).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
}

export function isMarketHours(): boolean {
  const kst = nowKST();
  const day = kst.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return minutes >= 9 * 60 + 5 && minutes < 15 * 60 + 25; // 09:05~15:25
}

function fmtBillion(value100M: number): string {
  if (value100M >= 10_000) {
    const jo = Math.floor(value100M / 10_000);
    const eok = Math.round(value100M % 10_000);
    return eok > 0 ? `${jo}조 ${eok.toLocaleString("ko-KR")}억` : `${jo}조`;
  }
  return `${Math.round(value100M).toLocaleString("ko-KR")}억`;
}

// ── Watchlist ─────────────────────────────────────────────────────────────────

export function loadWatchlist(): string[] {
  if (!existsSync(WATCHLIST_FILE)) return [];
  return readFileSync(WATCHLIST_FILE, "utf-8")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#"))
    .map(l => l.toUpperCase());
}

export function saveWatchlist(symbols: string[]): void {
  const header = "# 주식 모니터링 종목 목록\n# 종목코드를 한 줄에 하나씩 입력 (예: 005930)\n\n";
  writeFileSync(WATCHLIST_FILE, header + [...new Set(symbols)].join("\n") + "\n");
}

export function addToWatchlist(symbol: string): boolean {
  const list = loadWatchlist();
  const sym = symbol.toUpperCase();
  if (list.includes(sym)) return false;
  saveWatchlist([...list, sym]);
  return true;
}

export function removeFromWatchlist(symbol: string): boolean {
  const list = loadWatchlist();
  const sym = symbol.toUpperCase();
  const next = list.filter(s => s !== sym);
  if (next.length === list.length) return false;
  saveWatchlist(next);
  return true;
}

// ── KOSPI proxy (KODEX 200 ETF 069500) ───────────────────────────────────────

async function getKospiChangePct(): Promise<number> {
  try {
    const today = todayKST();
    const [prices, dailyCandles] = await Promise.all([
      getPrices(["069500"]),
      getCandles("069500", "1d", 5),
    ]);
    const current = prices[0]?.lastPrice;
    const prevClose = dailyCandles.find(c => candleDateKST(c.timestamp) < today)?.closePrice;
    if (!current || !prevClose) return 0;
    return (current - prevClose) / prevClose * 100;
  } catch {
    return 0;
  }
}

// ── Persistent dedup ─────────────────────────────────────────────────────────
// 봇 재시작 시에도 이미 보낸 신호를 기억하여 중복/지연 알림 방지

type DedupState = {
  buyAlerts:  Record<string, string>;   // symbol → YYYY-MM-DD
  sellAlerts: Record<string, number>;   // "symbol:weekDate:type" → timestamp
  wbAlerts:   Record<string, number>;   // "wb:symbol:date:type" → timestamp
};

function loadDedup(): DedupState {
  try {
    if (existsSync(DEDUP_FILE)) {
      const saved = JSON.parse(readFileSync(DEDUP_FILE, "utf-8")) as Partial<DedupState>;
      return {
        buyAlerts:  saved.buyAlerts  ?? {},
        sellAlerts: saved.sellAlerts ?? {},
        wbAlerts:   saved.wbAlerts   ?? {},
      };
    }
  } catch (e: any) {
    console.warn(`[StockMonitor] dedup 로드 실패 (초기화): ${e.message}`);
  }
  return { buyAlerts: {}, sellAlerts: {}, wbAlerts: {} };
}

function saveDedup(): void {
  try {
    const state: DedupState = {
      buyAlerts:  Object.fromEntries(alertedDates),
      sellAlerts: Object.fromEntries(sellAlertedKeys),
      wbAlerts:   Object.fromEntries(wbAlertedKeys),
    };
    writeFileSync(DEDUP_FILE, JSON.stringify(state, null, 2));
  } catch (e: any) {
    console.warn(`[StockMonitor] dedup 저장 실패: ${e.message}`);
  }
}

// 디스크에서 dedup 복원
const _savedDedup = loadDedup();

// WB 신호 dedup (영속화)
const wbAlertedKeys = new Map<string, number>(
  Object.entries(_savedDedup.wbAlerts).map(([k, v]) => [k, v as number]),
);

// ── Per-symbol check ──────────────────────────────────────────────────────────

// dedup: symbol → 알림 보낸 날짜 (디스크 영속화)
const alertedDates = new Map<string, string>(Object.entries(_savedDedup.buyAlerts));

async function checkSymbol(symbol: string, kospiChangePct: number): Promise<string | null> {
  const today = todayKST();
  if (alertedDates.get(symbol) === today) return null; // 오늘 이미 알림 보냄

  // 1분봉 가져오기 (최대 450개 ≈ 7.5시간)
  const candles1m = await getCandles(symbol, "1m", 450);

  // 오늘 KST 캔들만 필터 (최신→오래된 순이므로 reverse 필요)
  const todayCandles = candles1m
    .filter(c => candleDateKST(c.timestamp) === today)
    .reverse(); // 오래된 → 최신

  if (todayCandles.length === 0) return null;

  // 현재가 = 최신 1분봉 종가
  const currentPrice = todayCandles.at(-1)!.closePrice;

  // 전일 종가 (일봉에서 today 이전 데이터)
  const dailyCandles = await getCandles(symbol, "1d", 5);
  const prevClose = dailyCandles.find(c => candleDateKST(c.timestamp) < today)?.closePrice;
  if (!prevClose) return null;

  const changePct = (currentPrice - prevClose) / prevClose * 100;
  if (changePct < CFG.minChangePct) return null;

  // 오늘 누적 거래대금 (억원)
  const tradingValueBillion =
    todayCandles.reduce((sum, c) => sum + c.closePrice * c.volume, 0) / 1e8;
  if (tradingValueBillion < CFG.minValueBillion) return null;

  // 코스피 대비 초과수익
  const excessReturn = changePct - kospiChangePct;
  if (excessReturn < CFG.minExcessPct) return null;

  // 알림 중복 방지 + 디스크 영속화
  alertedDates.set(symbol, today);
  saveDedup();

  const kst = nowKST();
  const timeStr = `${String(kst.getUTCHours()).padStart(2, "0")}:${String(kst.getUTCMinutes()).padStart(2, "0")}`;

  return (
    `🟢 🚀 <b>매수 신호 — ${symbol}</b>\n\n` +
    `📅 ${today} ⏰ ${timeStr} KST\n` +
    `💰 현재가: <b>${currentPrice.toLocaleString("ko-KR")}원</b>\n` +
    `📈 전일 대비: <b>+${changePct.toFixed(1)}%</b>\n` +
    `🏆 코스피 대비 초과수익: <b>+${excessReturn.toFixed(1)}%</b>\n` +
    `💵 거래대금: <b>${fmtBillion(tradingValueBillion)}원</b>\n\n` +
    `전일 대비 ${changePct.toFixed(1)}% 상승(코스피 ${excessReturn.toFixed(1)}% 대비 초과수익)하고 ` +
    `거래대금 ${fmtBillion(tradingValueBillion)}원의 자금이 유입되어 주도주 신호가 포착되었습니다.`
  );
}

// ── Monitor loop (매수 신호) ─────────────────────────────────────────────────

let monitorTimer: ReturnType<typeof setInterval> | null = null;
let monitorChatId = "";
let monitorSend: ((chatId: string, text: string) => Promise<void>) | null = null;

async function tick(): Promise<void> {
  if (!isMarketHours()) return;

  const watchlist = loadWatchlist();
  if (watchlist.length === 0) return;

  console.log(`[StockMonitor] tick — ${watchlist.length}종목 체크`);

  let kospiChangePct = 0;
  try {
    kospiChangePct = await getKospiChangePct();
  } catch (e: any) {
    console.warn(`[StockMonitor] KOSPI 조회 실패: ${e.message}`);
  }

  for (const symbol of watchlist) {
    try {
      const msg = await checkSymbol(symbol, kospiChangePct);
      if (msg && monitorSend && monitorChatId) {
        console.log(`[StockMonitor] 신호 포착: ${symbol}`);
        await monitorSend(monitorChatId, msg);
      }
    } catch (e: any) {
      console.error(`[StockMonitor] ${symbol} 체크 실패: ${e.message}`);
    }
  }
}

// ── 매도 신호 모니터 (주봉 기반 — 하승훈 매도 규칙) ─────────────────────────

const SELL_CHECK_INTERVAL_MS = parseInt(process.env.SELL_CHECK_INTERVAL_MS || "7200000"); // 2시간
const WB_CHECK_INTERVAL_MS   = parseInt(process.env.WB_CHECK_INTERVAL_MS   || "14400000"); // 4시간
const MAX_SIGNAL_AGE_DAYS = 7; // 7일 이상 지난 신호는 무시
let sellMonitorTimer: ReturnType<typeof setInterval> | null = null;
let wbMonitorTimer:   ReturnType<typeof setInterval> | null = null;
const sellAlertedKeys = new Map<string, number>(
  Object.entries(_savedDedup.sellAlerts).map(([k, v]) => [k, v as number]),
);

function isSignalFresh(signalDate: string): boolean {
  const signalMs = new Date(signalDate).getTime();
  const nowMs = Date.now();
  const ageMs = nowMs - signalMs;
  return ageMs < MAX_SIGNAL_AGE_DAYS * 86_400_000;
}

async function sellSignalTick(): Promise<void> {
  const allSymbols = new Map<string, { name: string; market: "KR" | "US" }>();

  for (const stock of LEADING_STOCKS) {
    allSymbols.set(stock.symbol, { name: stock.name, market: stock.market });
  }
  for (const sym of loadWatchlist()) {
    if (!allSymbols.has(sym)) {
      const isUS = /^[A-Z]{1,5}$/.test(sym) && !/^\d+$/.test(sym);
      allSymbols.set(sym, { name: sym, market: isUS ? "US" : "KR" });
    }
  }

  console.log(`[SellMonitor] tick — ${allSymbols.size}종목 주봉 매도 신호 분석`);

  let dedupDirty = false;

  for (const [symbol, info] of allSymbols) {
    try {
      const dailyCandles = await getCandles(symbol, "1d", 200);
      if (dailyCandles.length < 30) continue;

      const weeklyCandles = aggregateToWeekly(dailyCandles);
      const signals = detectSellSignals(symbol, info.name, info.market, weeklyCandles);

      // 새 신호만 추려내고, dedup 기록
      const newSignals = signals.filter(signal => {
        const key = `${signal.symbol}:${signal.weekDate}:${signal.type}`;
        if (sellAlertedKeys.has(key)) return false;

        sellAlertedKeys.set(key, Date.now());
        dedupDirty = true;

        if (!isSignalFresh(signal.weekDate)) {
          console.log(`[SellMonitor] 지난 신호 무시 (${signal.weekDate}): ${signal.name} (${signal.type})`);
          return false;
        }
        return true;
      });

      // 같은 종목의 여러 패턴을 하나의 메시지로 합쳐서 발송
      if (newSignals.length > 0 && monitorSend && monitorChatId) {
        console.log(`[SellMonitor] 매도 신호: ${newSignals[0]!.name} (패턴 ${newSignals.length}개)`);
        await monitorSend(monitorChatId, formatSellAlertGroup(newSignals));
      }
    } catch (e: any) {
      console.error(`[SellMonitor] ${symbol} (${info.name}) 실패: ${e.message}`);
    }

    await new Promise((r) => setTimeout(r, 800));
  }

  // 4주 지난 dedup 정리
  const cutoff = Date.now() - 28 * 86_400_000;
  for (const [key, ts] of sellAlertedKeys) {
    if (ts < cutoff) { sellAlertedKeys.delete(key); dedupDirty = true; }
  }

  if (dedupDirty) saveDedup();
}

// ── WB 신호 모니터 (더블 볼린저밴드 다차원 전략) ────────────────────────────

async function wbSignalTick(): Promise<void> {
  const allSymbols = new Map<string, { name: string; market: "KR" | "US" }>();

  for (const stock of LEADING_STOCKS) {
    allSymbols.set(stock.symbol, { name: stock.name, market: stock.market });
  }
  for (const sym of loadWatchlist()) {
    if (!allSymbols.has(sym)) {
      const isUS = /^[A-Z]{1,5}$/.test(sym) && !/^\d+$/.test(sym);
      allSymbols.set(sym, { name: sym, market: isUS ? "US" : "KR" });
    }
  }

  console.log(`[WbMonitor] tick — ${allSymbols.size}종목 WB 신호 분석`);
  let dedupDirty = false;

  for (const [symbol, info] of allSymbols) {
    try {
      const dailyCandles = await getCandles(symbol, "1d", 200);
      if (dailyCandles.length < 50) continue;

      const signals = detectWbSignals(symbol, info.name, info.market, dailyCandles);

      const newSignals = signals.filter(signal => {
        const key = `wb:${signal.symbol}:${signal.date}:${signal.type}`;
        if (wbAlertedKeys.has(key)) return false;
        wbAlertedKeys.set(key, Date.now());
        dedupDirty = true;
        // 3일 이상 지난 신호는 무시 (WB는 일봉 기반, 더 타이트하게)
        const ageMs = Date.now() - new Date(signal.date).getTime();
        if (ageMs > 3 * 86_400_000) {
          console.log(`[WbMonitor] 지난 신호 무시 (${signal.date}): ${signal.name} (${signal.type})`);
          return false;
        }
        return true;
      });

      for (const signal of newSignals) {
        if (monitorSend && monitorChatId) {
          console.log(`[WbMonitor] ${signal.direction === "buy" ? "매수" : "매도"} 신호: ${signal.name} (${signal.type})`);
          await monitorSend(monitorChatId, formatWbAlert(signal));
        }
      }
    } catch (e: any) {
      console.error(`[WbMonitor] ${symbol} 실패: ${e.message}`);
    }

    await new Promise(r => setTimeout(r, 800));
  }

  // 7일 지난 dedup 정리
  const cutoff = Date.now() - MAX_SIGNAL_AGE_DAYS * 86_400_000;
  for (const [key, ts] of wbAlertedKeys) {
    if (ts < cutoff) { wbAlertedKeys.delete(key); dedupDirty = true; }
  }

  if (dedupDirty) saveDedup();
}

// ── Start / Stop ────────────────────────────────────────────────────────────

export function startStockMonitor(
  chatId: string,
  sendFn: (chatId: string, text: string) => Promise<void>,
): void {
  if (monitorTimer) return;

  monitorChatId = chatId;
  monitorSend = sendFn;

  const intervalSec  = CFG.intervalMs / 1000;
  const sellIntervalH = SELL_CHECK_INTERVAL_MS / 3_600_000;
  const wbIntervalH   = WB_CHECK_INTERVAL_MS   / 3_600_000;
  console.log(
    `[StockMonitor] 시작 — 매수 주기 ${intervalSec}s, 매도 주기 ${sellIntervalH}h, WB 주기 ${wbIntervalH}h, ` +
    `조건: 상승>=${CFG.minChangePct}%, 초과>=${CFG.minExcessPct}%, 거래대금>=${CFG.minValueBillion}억, ` +
    `매수감시: ${loadWatchlist().length}개, 매도감시(주도주): ${LEADING_STOCKS.length}개`,
  );

  // 매수 신호 루프 (장중 모멘텀)
  tick().catch(e => console.error(`[StockMonitor] 초기 체크 실패: ${e.message}`));
  monitorTimer = setInterval(
    () => tick().catch(e => console.error(`[StockMonitor] tick 실패: ${e.message}`)),
    CFG.intervalMs,
  );

  // 매도 신호 루프 (주봉 캔들 패턴, 10초 뒤 첫 실행)
  setTimeout(
    () => sellSignalTick().catch(e => console.error(`[SellMonitor] 초기 체크 실패: ${e.message}`)),
    10_000,
  );
  sellMonitorTimer = setInterval(
    () => sellSignalTick().catch(e => console.error(`[SellMonitor] tick 실패: ${e.message}`)),
    SELL_CHECK_INTERVAL_MS,
  );

  // WB 신호 루프 (더블BB 다차원 전략, 30초 뒤 첫 실행)
  setTimeout(
    () => wbSignalTick().catch(e => console.error(`[WbMonitor] 초기 체크 실패: ${e.message}`)),
    30_000,
  );
  wbMonitorTimer = setInterval(
    () => wbSignalTick().catch(e => console.error(`[WbMonitor] tick 실패: ${e.message}`)),
    WB_CHECK_INTERVAL_MS,
  );
}

export function stopStockMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  if (sellMonitorTimer) {
    clearInterval(sellMonitorTimer);
    sellMonitorTimer = null;
  }
  if (wbMonitorTimer) {
    clearInterval(wbMonitorTimer);
    wbMonitorTimer = null;
  }
  console.log("[StockMonitor] 매수+매도+WB 모니터 중지");
}

export function isMonitorRunning(): boolean {
  return monitorTimer !== null;
}

export function isSellMonitorRunning(): boolean {
  return sellMonitorTimer !== null;
}

export function getSellMonitorStatus(): { stocks: number; interval: string; alerts: number } {
  return {
    stocks: LEADING_STOCKS.length,
    interval: `${SELL_CHECK_INTERVAL_MS / 3_600_000}시간`,
    alerts: sellAlertedKeys.size,
  };
}

export function isWbMonitorRunning(): boolean {
  return wbMonitorTimer !== null;
}

export function getWbMonitorStatus(): { stocks: number; interval: string; alerts: number } {
  return {
    stocks: LEADING_STOCKS.length + loadWatchlist().length,
    interval: `${WB_CHECK_INTERVAL_MS / 3_600_000}시간`,
    alerts: wbAlertedKeys.size,
  };
}
