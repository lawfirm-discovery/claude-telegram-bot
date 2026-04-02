/**
 * DART OpenAPI 클라이언트
 *
 * 기업코드 조회, 기업개황, 재무제표, 공시목록을 직접 호출한다.
 * 기업코드 목록은 ZIP→XML을 다운로드 후 메모리 캐시.
 */

import { inflateRawSync } from "node:zlib";

const API_KEY = process.env.DART_API_KEY || "";
const BASE = "https://opendart.fss.or.kr/api";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface CorpEntry {
  corpCode: string;
  corpName: string;
  stockCode: string;   // 빈 문자열이면 비상장
  modifyDate: string;
}

export interface CompanyOverview {
  corpName: string;
  corpNameEng: string;
  stockCode: string;
  ceoName: string;
  corpCls: string;       // Y=유가, K=코스닥, N=코넥스, E=기타
  jurirNo: string;       // 법인등록번호
  bizrNo: string;        // 사업자등록번호
  adres: string;
  hmUrl: string;
  irUrl: string;
  phoneNo: string;
  faxNo: string;
  indutyCode: string;
  estDt: string;         // 설립일 YYYYMMDD
  accMt: string;         // 결산월
}

export interface FinancialItem {
  sjNm: string;          // 재무제표명 (재무상태표, 손익계산서 등)
  accountNm: string;     // 계정명 (자산총계, 매출액 등)
  thstrmAmount: string;  // 당기
  frmtrmAmount: string;  // 전기
  bfefrmtrmAmount: string; // 전전기
  thstrmNm: string;
  frmtrmNm: string;
  bfefrmtrmNm: string;
}

export interface DisclosureItem {
  corpName: string;
  reportNm: string;      // 보고서명
  rceptNo: string;       // 접수번호
  flrNm: string;         // 공시제출인명
  rceptDt: string;       // 접수일자 YYYYMMDD
  rm: string;            // 비고
}

export type DartError = { status: string; message: string };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Corp code cache (ZIP → XML → in-memory)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let corpCache: CorpEntry[] | null = null;
let corpCachePromise: Promise<CorpEntry[]> | null = null;

/** ZIP 파일에서 첫 번째 엔트리를 추출 (Central Directory 기반 — data descriptor 지원) */
function extractFirstFromZip(buf: Buffer): Buffer {
  // End of Central Directory Record (EOCD) 찾기 — 뒤에서 검색
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error("ZIP EOCD not found");

  const cdOffset = buf.readUInt32LE(eocdOffset + 16);   // Central Directory 시작 오프셋

  // Central Directory 첫 엔트리에서 크기 읽기
  if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error("ZIP CD signature mismatch");
  const method = buf.readUInt16LE(cdOffset + 10);
  const compSize = buf.readUInt32LE(cdOffset + 20);
  const localHeaderOffset = buf.readUInt32LE(cdOffset + 42);

  // Local file header에서 데이터 시작 위치 계산
  const nameLen = buf.readUInt16LE(localHeaderOffset + 26);
  const extraLen = buf.readUInt16LE(localHeaderOffset + 28);
  const dataOffset = localHeaderOffset + 30 + nameLen + extraLen;
  const data = buf.subarray(dataOffset, dataOffset + compSize);

  if (method === 0) return Buffer.from(data);
  if (method === 8) return inflateRawSync(data);
  throw new Error(`Unsupported ZIP compression: ${method}`);
}

/** XML에서 <list> 엔트리를 파싱 */
function parseCorpXml(xml: string): CorpEntry[] {
  const entries: CorpEntry[] = [];
  const blocks = xml.match(/<list>[\s\S]*?<\/list>/g) || [];
  for (const block of blocks) {
    const get = (tag: string) => block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() || "";
    entries.push({
      corpCode: get("corp_code"),
      corpName: get("corp_name"),
      stockCode: get("stock_code"),
      modifyDate: get("modify_date"),
    });
  }
  return entries;
}

async function loadCorpCodes(): Promise<CorpEntry[]> {
  if (corpCache) return corpCache;
  if (corpCachePromise) return corpCachePromise;

  corpCachePromise = (async () => {
    console.log("[DART] Downloading corp code list...");
    const url = `${BASE}/corpCode.xml?crtfc_key=${API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`DART corpCode download failed: ${res.status}`);
    const zipBuf = Buffer.from(await res.arrayBuffer());
    const xmlBuf = extractFirstFromZip(zipBuf);
    const xml = xmlBuf.toString("utf-8");
    const entries = parseCorpXml(xml);
    console.log(`[DART] Loaded ${entries.length} corp codes`);
    corpCache = entries;
    corpCachePromise = null;
    return entries;
  })();

  return corpCachePromise;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function dartGet<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams({ crtfc_key: API_KEY, ...params });
  const url = `${BASE}/${endpoint}?${qs}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DART API ${endpoint}: HTTP ${res.status}`);
  const json = await res.json() as any;
  if (json.status && json.status !== "000") {
    const err = new Error(`DART API ${endpoint}: [${json.status}] ${json.message}`) as Error & { dartStatus: string };
    err.dartStatus = json.status;
    throw err;
  }
  return json;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Public API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function isAvailable(): boolean {
  return API_KEY.length > 0;
}

/** 기업명으로 검색 (corp code 목록에서 매칭) */
export async function searchCompany(query: string): Promise<CorpEntry[]> {
  const codes = await loadCorpCodes();
  const q = query.toLowerCase().replace(/\s/g, "");
  // 정확히 일치 → 앞부분 일치 → 포함 순으로 정렬
  const matches = codes.filter((c) => c.corpName.toLowerCase().replace(/\s/g, "").includes(q));

  matches.sort((a, b) => {
    const an = a.corpName.toLowerCase().replace(/\s/g, "");
    const bn = b.corpName.toLowerCase().replace(/\s/g, "");
    // 정확 일치 우선
    if (an === q && bn !== q) return -1;
    if (bn === q && an !== q) return 1;
    // 상장사 우선
    if (a.stockCode && !b.stockCode) return -1;
    if (b.stockCode && !a.stockCode) return 1;
    // 이름 길이 짧은 것 우선 (더 정확한 매칭)
    return a.corpName.length - b.corpName.length;
  });

  return matches.slice(0, 10);
}

/** 기업 개황 조회 */
export async function getCompanyInfo(corpCode: string): Promise<CompanyOverview> {
  const data = await dartGet<any>("company.json", { corp_code: corpCode });
  return {
    corpName: data.corp_name || "",
    corpNameEng: data.corp_name_eng || "",
    stockCode: data.stock_code || "",
    ceoName: data.ceo_nm || "",
    corpCls: data.corp_cls || "",
    jurirNo: data.jurir_no || "",
    bizrNo: data.bizr_no || "",
    adres: data.adres || "",
    hmUrl: data.hm_url || "",
    irUrl: data.ir_url || "",
    phoneNo: data.phn_no || "",
    faxNo: data.fax_no || "",
    indutyCode: data.induty_code || "",
    estDt: data.est_dt || "",
    accMt: data.acc_mt || "",
  };
}

/** 단일회사 재무제표 (최근 사업보고서 기준) */
export async function getFinancials(
  corpCode: string,
  year?: string,
  reprtCode: string = "11011", // 사업보고서
): Promise<FinancialItem[]> {
  const bsnsYear = year || String(new Date().getFullYear() - 1);
  const data = await dartGet<any>("fnlttSinglAcnt.json", {
    corp_code: corpCode,
    bsns_year: bsnsYear,
    reprt_code: reprtCode,
    fs_div: "CFS", // 연결재무제표 우선
  });
  const list: any[] = data.list || [];
  return list.map((item) => ({
    sjNm: item.sj_nm || "",
    accountNm: item.account_nm || "",
    thstrmAmount: item.thstrm_amount || "",
    frmtrmAmount: item.frmtrm_amount || "",
    bfefrmtrmAmount: item.bfefrmtrm_amount || "",
    thstrmNm: item.thstrm_nm || "",
    frmtrmNm: item.frmtrm_nm || "",
    bfefrmtrmNm: item.bfefrmtrm_nm || "",
  }));
}

/** 공시 목록 (최근 3개월) */
export async function getDisclosures(
  corpCode: string,
  pageCount: string = "20",
): Promise<DisclosureItem[]> {
  // 최근 3개월
  const now = new Date();
  const end = fmtDate(now);
  const begin = fmtDate(new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()));

  const data = await dartGet<any>("list.json", {
    corp_code: corpCode,
    bgn_de: begin,
    end_de: end,
    page_count: pageCount,
  });
  const list: any[] = data.list || [];
  return list.map((item) => ({
    corpName: item.corp_name || "",
    reportNm: item.report_nm || "",
    rceptNo: item.rcept_no || "",
    flrNm: item.flr_nm || "",
    rceptDt: item.rcept_dt || "",
    rm: item.rm || "",
  }));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Formatters (Telegram HTML)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function fmtDateDisplay(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(0, 4)}.${yyyymmdd.slice(4, 6)}.${yyyymmdd.slice(6, 8)}`;
}

function corpClsLabel(cls: string): string {
  const map: Record<string, string> = { Y: "유가증권(KOSPI)", K: "코스닥(KOSDAQ)", N: "코넥스(KONEX)", E: "기타" };
  return map[cls] || cls;
}

export function formatSearchResults(results: CorpEntry[]): string {
  if (results.length === 0) return "검색 결과가 없습니다.";
  const lines = [
    `<b>기업 검색 결과</b> (${results.length}건)`,
    `━━━━━━━━━━━━━━━━━━━━`,
  ];
  results.forEach((r, i) => {
    const stock = r.stockCode ? ` (${r.stockCode})` : "";
    lines.push(`${i + 1}. <b>${esc(r.corpName)}</b>${stock}`);
  });
  lines.push(``);
  lines.push(`<i>아래 버튼으로 기업을 선택하세요.</i>`);
  return lines.join("\n");
}

export function formatCompanyInfo(info: CompanyOverview): string {
  const lines = [
    `<b>${esc(info.corpName)}</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `▸ 영문명      ${esc(info.corpNameEng) || "─"}`,
    `▸ 종목코드    ${info.stockCode || "비상장"}`,
    `▸ 시장구분    ${corpClsLabel(info.corpCls)}`,
    `▸ 대표이사    ${esc(info.ceoName) || "─"}`,
    `▸ 법인등록번호 ${info.jurirNo || "─"}`,
    `▸ 사업자번호   ${info.bizrNo || "─"}`,
    `▸ 설립일      ${fmtDateDisplay(info.estDt)}`,
    `▸ 결산월      ${info.accMt}월`,
    `▸ 업종코드    ${info.indutyCode || "─"}`,
    `▸ 소재지      ${esc(info.adres) || "─"}`,
    `▸ 전화번호    ${info.phoneNo || "─"}`,
  ];
  if (info.hmUrl) lines.push(`▸ 홈페이지    ${esc(info.hmUrl)}`);
  lines.push(``);
  lines.push(`<i>출처: DART 전자공시시스템 (opendart.fss.or.kr)</i>`);
  return lines.join("\n");
}

export function formatFinancials(items: FinancialItem[], corpName: string): string {
  if (items.length === 0) return `${esc(corpName)} ─ 재무제표 데이터가 없습니다.`;

  // 핵심 계정만 추출 + 중복 제거 (같은 계정명은 첫 번째만 유지 = 연결 우선)
  const KEY_ACCOUNTS = ["자산총계", "부채총계", "자본총계", "매출액", "영업이익", "당기순이익"];
  const seen = new Set<string>();
  const keyItems = items.filter((item) => {
    const match = KEY_ACCOUNTS.some((k) => item.accountNm.includes(k));
    if (!match) return false;
    const key = `${item.sjNm}::${item.accountNm}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 기간명
  const periods = keyItems.length > 0
    ? [keyItems[0].thstrmNm, keyItems[0].frmtrmNm, keyItems[0].bfefrmtrmNm]
    : ["당기", "전기", "전전기"];

  const lines = [
    `<b>${esc(corpName)} ─ 재무제표</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
  ];

  // 재무상태표
  const bsItems = keyItems.filter((i) => i.sjNm.includes("재무상태표"));
  if (bsItems.length > 0) {
    lines.push(`<b>재무상태표</b>`);
    for (const item of bsItems) {
      lines.push(`  ${esc(item.accountNm)}`);
      lines.push(`    ${periods[0]}: ${fmtAmount(item.thstrmAmount)}`);
      lines.push(`    ${periods[1]}: ${fmtAmount(item.frmtrmAmount)}`);
      if (item.bfefrmtrmAmount) lines.push(`    ${periods[2]}: ${fmtAmount(item.bfefrmtrmAmount)}`);
    }
    lines.push(``);
  }

  // 손익계산서
  const isItems = keyItems.filter((i) => i.sjNm.includes("손익계산서") || i.sjNm.includes("포괄손익"));
  if (isItems.length > 0) {
    lines.push(`<b>손익계산서</b>`);
    for (const item of isItems) {
      lines.push(`  ${esc(item.accountNm)}`);
      lines.push(`    ${periods[0]}: ${fmtAmount(item.thstrmAmount)}`);
      lines.push(`    ${periods[1]}: ${fmtAmount(item.frmtrmAmount)}`);
      if (item.bfefrmtrmAmount) lines.push(`    ${periods[2]}: ${fmtAmount(item.bfefrmtrmAmount)}`);
    }
    lines.push(``);
  }

  lines.push(`<i>출처: DART 전자공시시스템 (연결재무제표 기준)</i>`);
  return lines.join("\n");
}

function fmtAmount(raw: string): string {
  if (!raw || raw === "-") return "─";
  const num = parseInt(raw.replace(/,/g, ""), 10);
  if (isNaN(num)) return raw;
  const abs = Math.abs(num);
  const sign = num < 0 ? "-" : "";
  if (abs >= 1_000_000_000_000) return `${sign}${(abs / 1_000_000_000_000).toFixed(1)}조원`;
  if (abs >= 100_000_000) return `${sign}${(abs / 100_000_000).toFixed(0)}억원`;
  if (abs >= 10_000) return `${sign}${(abs / 10_000).toFixed(0)}만원`;
  return `${sign}${abs.toLocaleString()}원`;
}

export function formatDisclosures(items: DisclosureItem[], corpName: string): string {
  if (items.length === 0) return `${esc(corpName)} ─ 최근 3개월 공시가 없습니다.`;
  const lines = [
    `<b>${esc(corpName)} ─ 최근 공시</b> (${items.length}건)`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
  ];
  for (const item of items) {
    const date = fmtDateDisplay(item.rceptDt);
    const link = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${item.rceptNo}`;
    const badge = item.rm ? ` [${esc(item.rm)}]` : "";
    lines.push(`▸ ${date}${badge}`);
    lines.push(`  <a href="${link}">${esc(item.reportNm)}</a>`);
    if (item.flrNm) lines.push(`  제출인: ${esc(item.flrNm)}`);
    lines.push(``);
  }
  lines.push(`<i>출처: DART 전자공시시스템</i>`);
  return lines.join("\n");
}

/** corp code cache 사전 로딩 (봇 시작 시 호출) */
export async function preload(): Promise<void> {
  if (!isAvailable()) return;
  try {
    await loadCorpCodes();
  } catch (e: any) {
    console.error(`[DART] Preload failed: ${e.message}`);
  }
}
