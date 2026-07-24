import { chromium } from "playwright";
import { writeFileSync } from "fs";
import { execSync } from "child_process";
import type { Candle } from "./stock";
import { analyzeStockSupport, fetchKisCandles, type SupportLevel } from "./stock-support.js";

const W = 900, H = 520;
const PAD = { l: 65, r: 20, t: 44, b: 32 };
const CW = W - PAD.l - PAD.r;
const CH = H - PAD.t - PAD.b;

function calcBBSeries(values: number[], period: number, k: number) {
  return values.map((_, i) => {
    if (i < period - 1) return { upper: NaN, middle: NaN, lower: NaN };
    const slice = values.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period);
    return { upper: mean + k * std, middle: mean, lower: mean - k * std };
  });
}

function buildHtml(payload: object): string {
  return `<!DOCTYPE html><html><head><style>
body { margin:0; background:#131722; }
canvas { display:block; }
</style></head><body>
<canvas id="c" width="${W}" height="${H}"></canvas>
<script>
(function() {
const d = ${JSON.stringify(payload)};
const cv = document.getElementById('c');
const ctx = cv.getContext('2d');
const W=${W}, H=${H};
const PAD={l:${PAD.l},r:${PAD.r},t:${PAD.t},b:${PAD.b}};
const CW=${CW}, CH=${CH};

// price range (NaN → null after JSON.stringify)
const prices = [];
d.candles.forEach(c => prices.push(c.h, c.l));
d.bb22.forEach(b => { if (b.u != null) prices.push(b.u, b.l); });
d.bb44.forEach(b => { if (b.u != null) prices.push(b.u, b.l); });
const minP = Math.min(...prices) * 0.9985;
const maxP = Math.max(...prices) * 1.0015;
const range = maxP - minP;

const n = d.candles.length;
const colW = CW / n;
const bodyW = Math.max(2, colW * 0.65);

function xAt(i) { return PAD.l + (i + 0.5) * colW; }
function yAt(p) { return PAD.t + (maxP - p) / range * CH; }

// background
ctx.fillStyle = '#131722';
ctx.fillRect(0, 0, W, H);

// grid
const gridSteps = 5;
ctx.setLineDash([]);
for (let i = 0; i <= gridSteps; i++) {
  const y = PAD.t + i * CH / gridSteps;
  ctx.strokeStyle = '#252540';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
  const price = maxP - i * range / gridSteps;
  ctx.fillStyle = '#778ca3';
  ctx.font = '11px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(price >= 1000 ? price.toFixed(0) : price.toFixed(2), PAD.l - 5, y + 4);
}

// x-axis date labels (every ~15 candles)
ctx.fillStyle = '#778ca3';
ctx.font = '10px monospace';
ctx.textAlign = 'center';
const step = Math.max(1, Math.floor(n / 6));
for (let i = 0; i < n; i += step) {
  const label = d.candles[i].dt.slice(5); // MM-DD
  ctx.fillText(label, xAt(i), H - 6);
}

// draw BB band (fill area between upper/lower)
function drawBBFill(series, fillColor) {
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < n; i++) {
    const b = series[i];
    if (b.u == null) { started = false; continue; }
    if (!started) { ctx.moveTo(xAt(i), yAt(b.u)); started = true; }
    else ctx.lineTo(xAt(i), yAt(b.u));
  }
  for (let i = n - 1; i >= 0; i--) {
    const b = series[i];
    if (b.l == null) continue;
    ctx.lineTo(xAt(i), yAt(b.l));
  }
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();
}

// draw BB lines (upper / middle / lower)
function drawBBLines(series, color, midDash) {
  ['u', 'm', 'l'].forEach(key => {
    ctx.strokeStyle = color;
    ctx.lineWidth = key === 'm' ? 1 : 1.5;
    ctx.setLineDash(key === 'm' ? midDash : []);
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const b = series[i];
      if (b[key] == null) { started = false; continue; }
      const x = xAt(i), y = yAt(b[key]);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
  ctx.setLineDash([]);
}

// BB44 (Red) fill then lines
drawBBFill(d.bb44, 'rgba(239,83,80,0.07)');
drawBBLines(d.bb44, '#ef5350', [5, 4]);

// BB22 (White) fill then lines
drawBBFill(d.bb22, 'rgba(255,255,255,0.05)');
drawBBLines(d.bb22, '#e0e0e0', [4, 3]);

// SMA20 (Yellow)
ctx.strokeStyle = '#ffd700';
ctx.lineWidth = 1.5;
ctx.setLineDash([]);
ctx.beginPath();
let smaStarted = false;
for (let i = 0; i < n; i++) {
  const v = d.sma20[i];
  if (v == null) { smaStarted = false; continue; }
  const x = xAt(i), y = yAt(v);
  if (!smaStarted) { ctx.moveTo(x, y); smaStarted = true; }
  else ctx.lineTo(x, y);
}
ctx.stroke();

// 더블비 교차 지점 표시 (수직선)
for (let i = 1; i < n; i++) {
  const cur22 = d.bb22[i], cur44 = d.bb44[i];
  const prv22 = d.bb22[i-1], prv44 = d.bb44[i-1];
  if (!cur22 || !cur44 || !prv22 || !prv44) continue;
  if (cur22.l == null || cur44.l == null || prv22.l == null || prv44.l == null) continue;
  const lowerCross = prv22.l >= prv44.l && cur22.l < cur44.l;
  const upperCross = prv22.u <= prv44.u && cur22.u > cur44.u;
  if (lowerCross || upperCross) {
    const x = xAt(i);
    ctx.strokeStyle = lowerCross ? 'rgba(255,215,0,0.5)' : 'rgba(255,100,100,0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, PAD.t);
    ctx.lineTo(x, PAD.t + CH);
    ctx.stroke();
    // 삼각형 마커
    ctx.fillStyle = lowerCross ? '#ffd700' : '#ff6464';
    ctx.setLineDash([]);
    ctx.beginPath();
    if (lowerCross) {
      const ty = yAt(cur22.l) + 8;
      ctx.moveTo(x, ty + 8); ctx.lineTo(x - 5, ty); ctx.lineTo(x + 5, ty);
    } else {
      const ty = yAt(cur22.u) - 8;
      ctx.moveTo(x, ty - 8); ctx.lineTo(x - 5, ty); ctx.lineTo(x + 5, ty);
    }
    ctx.fill();
  }
}
ctx.setLineDash([]);

// candlesticks
d.candles.forEach((c, i) => {
  const x = xAt(i);
  const up = c.c >= c.o;
  const col = up ? '#26a69a' : '#ef5350';
  ctx.strokeStyle = col;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  // wick
  ctx.beginPath();
  ctx.moveTo(x, yAt(c.h));
  ctx.lineTo(x, yAt(c.l));
  ctx.stroke();
  // body
  const yTop = yAt(Math.max(c.o, c.c));
  const yBot = yAt(Math.min(c.o, c.c));
  const bh = Math.max(1, yBot - yTop);
  if (up) {
    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    ctx.strokeRect(x - bodyW/2, yTop, bodyW, bh);
    ctx.fillStyle = 'rgba(38,166,154,0.35)';
    ctx.fillRect(x - bodyW/2, yTop, bodyW, bh);
  } else {
    ctx.fillStyle = col;
    ctx.fillRect(x - bodyW/2, yTop, bodyW, bh);
  }
});

// title (left-aligned)
ctx.fillStyle = '#ffffff';
ctx.font = 'bold 14px monospace';
ctx.textAlign = 'left';
ctx.fillText(d.title, PAD.l, 26);

// legend (top-right)
const leg = [{label:'BB2(종가,2σ)', color:'#e0e0e0'}, {label:'BB4(시가,4σ)', color:'#ef5350'}, {label:'SMA20', color:'#ffd700'}];
leg.forEach((l, i) => {
  const lx = W - PAD.r - 155 * (leg.length - i);
  ctx.fillStyle = l.color;
  ctx.fillRect(lx, 10, 14, 3);
  ctx.fillStyle = '#aaa';
  ctx.font = '11px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(l.label, lx + 18, 16);
});

})();
</script></body></html>`;
}

export async function generateBBChart(
  candles: Candle[],
  title: string,
  lookback = 80,
): Promise<Buffer> {
  const sorted = [...candles].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  const slice = sorted.slice(Math.max(0, sorted.length - lookback));

  const closes = slice.map(c => c.closePrice);
  const opens  = slice.map(c => c.openPrice);

  const bb22 = calcBBSeries(closes, 2, 2.0).map(b => ({ u: b.upper, m: b.middle, l: b.lower }));
  const bb44 = calcBBSeries(opens,  4, 4.0).map(b => ({ u: b.upper, m: b.middle, l: b.lower }));

  const sma20 = closes.map((_, i) => {
    if (i < 19) return null;
    return closes.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20;
  });

  const chartCandles = slice.map(c => ({
    o: c.openPrice,
    h: c.highPrice,
    l: c.lowPrice,
    c: c.closePrice,
    dt: c.timestamp.slice(0, 10),
  }));

  const html = buildHtml({ candles: chartCandles, bb22, bb44, sma20, title });

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: W, height: H });
    await page.setContent(html, { waitUntil: "networkidle" });
    const shot = await page.screenshot({ type: "png" });
    return Buffer.from(shot);
  } finally {
    await browser.close();
  }
}

// ── Interactive Support Chart ──────────────────────────────────────────────

function buildSupportChartHtml(
  symbol: string,
  candles: Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }>,
  supports: SupportLevel[],
  currentPrice: number,
): string {
  const sourceColor: Record<string, string> = {
    PUT_WALL:    "#e040fb",
    DYNAMIC_MA:  "#ffd700",
    LOCAL_MINIMA: "#64b5f6",
    VOLUME_VAL:  "#81c784",
    INTEGRATED:  "#ff8a65",
  };

  const priceLines = supports.map(s => ({
    price: s.price,
    color: sourceColor[s.source] ?? "#aaaaaa",
    lineWidth: s.source === "INTEGRATED" ? 2 : 1,
    lineStyle: 2, // dashed
    axisLabelVisible: true,
    title: `[${s.score}] ${s.price.toLocaleString()}원`,
    description: s.description,
    score: s.score,
    source: s.source,
    gap: (((currentPrice - s.price) / currentPrice) * 100).toFixed(1),
  }));

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>${symbol} 지지선 분석</title>
<script src="https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"></script>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #131722; color: #d1d4dc; font-family: -apple-system, monospace; }
#header { padding: 12px 16px; border-bottom: 1px solid #2a2e39; display: flex; align-items: center; gap: 16px; }
#header h1 { font-size: 15px; color: #fff; }
#header .price { font-size: 18px; font-weight: bold; color: #26a69a; }
#chart-wrap { position: relative; }
#chart { width: 100%; height: calc(100vh - 52px); }
#tooltip {
  position: fixed;
  display: none;
  background: rgba(20,24,32,0.96);
  border: 1px solid #363c4e;
  border-radius: 6px;
  padding: 10px 14px;
  pointer-events: none;
  z-index: 100;
  min-width: 220px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.5);
}
#tooltip .t-source { font-size: 10px; letter-spacing: 0.5px; margin-bottom: 4px; text-transform: uppercase; }
#tooltip .t-price { font-size: 16px; font-weight: bold; color: #fff; }
#tooltip .t-gap { font-size: 12px; color: #778ca3; margin-top: 2px; }
#tooltip .t-desc { font-size: 12px; color: #aaa; margin-top: 6px; border-top: 1px solid #2a2e39; padding-top: 6px; }
#tooltip .t-score { font-size: 11px; color: #ffd700; margin-top: 4px; }
#legend {
  position: fixed;
  bottom: 20px;
  right: 20px;
  background: rgba(20,24,32,0.9);
  border: 1px solid #2a2e39;
  border-radius: 6px;
  padding: 10px 14px;
  z-index: 50;
}
#legend .l-title { font-size: 11px; color: #778ca3; margin-bottom: 6px; }
.l-item { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 11px; }
.l-line { width: 20px; height: 2px; }
</style>
</head>
<body>
<div id="header">
  <h1>${symbol} 지지선 분석</h1>
  <span class="price">${currentPrice.toLocaleString()}원</span>
  <span style="font-size:12px;color:#778ca3;">${new Date().toLocaleDateString("ko-KR")} 기준</span>
</div>
<div id="chart-wrap">
  <div id="chart"></div>
</div>
<div id="tooltip">
  <div class="t-source" id="tt-source"></div>
  <div class="t-price" id="tt-price"></div>
  <div class="t-gap" id="tt-gap"></div>
  <div class="t-desc" id="tt-desc"></div>
  <div class="t-score" id="tt-score"></div>
</div>
<div id="legend">
  <div class="l-title">지지선 범례</div>
  <div class="l-item"><div class="l-line" style="background:#e040fb;height:2px"></div><span>풋옵션 Put Wall</span></div>
  <div class="l-item"><div class="l-line" style="background:#ffd700"></div><span>이동평균선 (MA)</span></div>
  <div class="l-item"><div class="l-line" style="background:#64b5f6"></div><span>스윙로우 / 피벗</span></div>
  <div class="l-item"><div class="l-line" style="background:#81c784"></div><span>매물대 VAL</span></div>
  <div class="l-item"><div class="l-line" style="background:#ff8a65;height:2px"></div><span>통합 지지선</span></div>
</div>

<script>
const CANDLES = ${JSON.stringify(candles)};
const SUPPORTS = ${JSON.stringify(priceLines)};
const CURRENT = ${currentPrice};

const chart = LightweightCharts.createChart(document.getElementById('chart'), {
  layout: { background: { color: '#131722' }, textColor: '#d1d4dc' },
  grid: { vertLines: { color: '#1e2130' }, horzLines: { color: '#1e2130' } },
  crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  rightPriceScale: { borderColor: '#2a2e39' },
  timeScale: { borderColor: '#2a2e39', timeVisible: true },
  handleScroll: true,
  handleScale: true,
});

// 캔들 시리즈
const candleSeries = chart.addCandlestickSeries({
  upColor: '#26a69a', downColor: '#ef5350',
  borderUpColor: '#26a69a', borderDownColor: '#ef5350',
  wickUpColor: '#26a69a', wickDownColor: '#ef5350',
});
candleSeries.setData(CANDLES);

// 거래량 시리즈
const volSeries = chart.addHistogramSeries({
  priceFormat: { type: 'volume' },
  priceScaleId: 'vol',
  color: '#26a69a44',
  base: 0,
});
chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
volSeries.setData(CANDLES.map(c => ({
  time: c.time,
  value: c.volume,
  color: c.close >= c.open ? '#26a69a44' : '#ef535044',
})));

// 현재가 라인
candleSeries.createPriceLine({
  price: CURRENT,
  color: '#ffffff44',
  lineWidth: 1,
  lineStyle: 0,
  axisLabelVisible: true,
  title: '현재가',
});

// 지지선 추가 및 hover 영역 계산
const supportLines = SUPPORTS.map(s => {
  const line = candleSeries.createPriceLine({
    price: s.price,
    color: s.color,
    lineWidth: s.lineWidth,
    lineStyle: s.lineStyle,
    axisLabelVisible: true,
    title: s.title,
  });
  return { line, meta: s };
});

// 툴팁
const tooltip = document.getElementById('tooltip');
const sourceNames = {
  PUT_WALL: '풋옵션 Put Wall',
  DYNAMIC_MA: '이동평균선 지지',
  LOCAL_MINIMA: '스윙로우 / 피벗',
  VOLUME_VAL: '매물대 가치영역',
  INTEGRATED: '통합 지지선',
};

chart.subscribeCrosshairMove(param => {
  if (!param || !param.point) { tooltip.style.display = 'none'; return; }

  const price = candleSeries.coordinateToPrice(param.point.y);
  if (price === null) { tooltip.style.display = 'none'; return; }

  // 지지선 근처(0.8%) hover 감지
  const hit = SUPPORTS.find(s => Math.abs(s.price - price) / s.price < 0.008);
  if (!hit) { tooltip.style.display = 'none'; return; }

  document.getElementById('tt-source').style.color = hit.color;
  document.getElementById('tt-source').textContent = sourceNames[hit.source] || hit.source;
  document.getElementById('tt-price').textContent = hit.price.toLocaleString() + '원';
  document.getElementById('tt-gap').textContent = '현재가 대비 -' + hit.gap + '%';
  document.getElementById('tt-desc').textContent = hit.description;
  document.getElementById('tt-score').textContent = '신뢰도 ' + hit.score + ' / 100';

  const x = param.point.x + 20;
  const y = param.point.y - 20;
  tooltip.style.left = Math.min(x, window.innerWidth - 260) + 'px';
  tooltip.style.top = Math.max(10, y) + 'px';
  tooltip.style.display = 'block';
});

// 화면에 맞게 자동 스크롤
chart.timeScale().fitContent();
</script>
</body>
</html>`;
}

export async function openSupportChart(symbol: string): Promise<string> {
  const result = await analyzeStockSupport(symbol);

  const kisCandles = await fetchKisCandles(symbol, 100);

  const lwCandles = (kisCandles as Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>)
    .slice()
    .reverse() // 과거→최신 순으로
    .map(c => ({
      time: `${c.date.slice(0, 4)}-${c.date.slice(4, 6)}-${c.date.slice(6, 8)}`,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));

  const html = buildSupportChartHtml(symbol, lwCandles, result.supports, result.currentPrice);
  const path = `/tmp/support_chart_${symbol}.html`;
  writeFileSync(path, html, "utf-8");

  // 로컬 브라우저에서 열기 (macOS)
  try { execSync(`open "${path}"`); } catch {}

  return path;
}
