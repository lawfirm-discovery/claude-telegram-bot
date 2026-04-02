/**
 * 기업정보 증거서비스 — 메뉴, 상태관리, DART API 호출 + WebSearch 폴백
 *
 * 전략: DART OpenAPI 직접 호출 → 실패 시 Claude WebSearch 폴백
 */

import { InlineKeyboard } from "grammy";
import { escapeHtml } from "../format";
import * as dart from "../services/dart";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface SelectedCompany {
  name: string;
  corpCode?: string;
  stockCode?: string;
}

export interface CompanyMenuState {
  phase: "idle" | "awaiting_search";
  selectedCompany?: SelectedCompany;
  searchResults?: dart.CorpEntry[];   // DART 검색 결과 캐시 (선택 키보드용)
}

/** DART API 직접 응답 (HTML 포맷) — Claude 호출 불필요 */
export interface DirectResponse {
  type: "direct";
  html: string;
  keyboard?: InlineKeyboard;
}

/** Claude WebSearch 폴백 — handleMessage로 전달 */
export interface FallbackResponse {
  type: "fallback";
  prompt: string;
}

export type ActionResult = DirectResponse | FallbackResponse;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// State management
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const states = new Map<string, CompanyMenuState>();

export function getState(chatId: string): CompanyMenuState {
  let s = states.get(chatId);
  if (!s) { s = { phase: "idle" }; states.set(chatId, s); }
  return s;
}

export function setAwaitingSearch(chatId: string): void {
  getState(chatId).phase = "awaiting_search";
}

export function clearAwaitingSearch(chatId: string): void {
  getState(chatId).phase = "idle";
}

export function setSelectedCompany(chatId: string, company: SelectedCompany): void {
  const s = getState(chatId);
  s.selectedCompany = company;
  s.phase = "idle";
}

export function getSelectedCompany(chatId: string): SelectedCompany | undefined {
  return getState(chatId).selectedCompany;
}

export function isAwaitingSearch(chatId: string): boolean {
  return getState(chatId).phase === "awaiting_search";
}

export function getSearchResults(chatId: string): dart.CorpEntry[] | undefined {
  return getState(chatId).searchResults;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Keyboards
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function mainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("기업 검색", "co:search")
    .text("기업 개황", "co:info")
    .row()
    .text("재무제표", "co:finance")
    .text("공시 검색", "co:disc")
    .row()
    .text("증거 수집", "co:evidence");
}

export function companySelectedKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("기업 개황", "co:info")
    .text("재무제표", "co:finance")
    .row()
    .text("공시 검색", "co:disc")
    .text("증거 수집", "co:evidence")
    .row()
    .text("◂ 다른 기업 검색", "co:search");
}

export function backKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("◂ 기업정보 메뉴", "co:menu");
}

/** 검색 결과를 선택 버튼으로 변환 (최대 10개, 2열) */
export function searchResultsKeyboard(results: dart.CorpEntry[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const label = r.stockCode
      ? `${r.corpName} (${r.stockCode})`
      : r.corpName;
    kb.text(label, `co:sel:${i}`);
    if (i % 2 === 1 || i === results.length - 1) kb.row();
  }
  kb.text("◂ 기업정보 메뉴", "co:menu");
  return kb;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Messages (HTML)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function mainMenuMessage(selected?: SelectedCompany): string {
  const lines: string[] = [
    `<b>기업정보</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
  ];

  if (selected) {
    lines.push(``);
    const stock = selected.stockCode ? ` (${selected.stockCode})` : "";
    lines.push(`▸ 선택된 기업: <b>${escapeHtml(selected.name)}</b>${stock}`);
  }

  lines.push(``);
  lines.push(`▪ <b>기업 검색</b>  ─  회사명으로 검색`);
  lines.push(`▪ <b>기업 개황</b>  ─  기본 정보, 대표자, 업종`);
  lines.push(`▪ <b>재무제표</b>  ─  매출, 영업이익, 자산`);
  lines.push(`▪ <b>공시 검색</b>  ─  최근 공시 목록`);
  lines.push(`▪ <b>증거 수집</b>  ─  종합 리포트 생성`);

  return lines.join("\n");
}

export function searchPromptMessage(): string {
  return [
    `<b>기업 검색</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `검색할 기업명을 입력하세요.`,
    ``,
    `<i>예: 삼성전자, 카카오, LG에너지솔루션</i>`,
  ].join("\n");
}

export function needsCompanyMessage(): string {
  return [
    `먼저 기업을 검색해주세요.`,
    ``,
    `▸ <b>기업 검색</b> 버튼을 눌러 기업명을 입력하세요.`,
  ].join("\n");
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Actions: DART API 우선 → WebSearch 폴백
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 기업 검색 — DART corp code 목록 검색 → 폴백: Claude WebSearch */
export async function doSearch(chatId: string, query: string): Promise<ActionResult> {
  if (dart.isAvailable()) {
    try {
      const results = await dart.searchCompany(query);
      const state = getState(chatId);
      state.searchResults = results;

      if (results.length === 0) {
        return { type: "direct", html: `"${escapeHtml(query)}" ─ 검색 결과가 없습니다.\n\n<i>WebSearch로 재검색합니다...</i>` };
      }
      if (results.length === 1) {
        // 단일 결과 → 자동 선택
        const r = results[0];
        setSelectedCompany(chatId, { name: r.corpName, corpCode: r.corpCode, stockCode: r.stockCode });
        return {
          type: "direct",
          html: dart.formatSearchResults(results),
          keyboard: companySelectedKeyboard(),
        };
      }
      return {
        type: "direct",
        html: dart.formatSearchResults(results),
        keyboard: searchResultsKeyboard(results),
      };
    } catch (e: any) {
      console.error(`[Company] DART search failed, falling back to WebSearch: ${e.message}`);
    }
  }
  // 폴백: Claude WebSearch
  setSelectedCompany(chatId, { name: query });
  return { type: "fallback", prompt: buildSearchPrompt(query) };
}

/** 기업 개황 — DART company.json → 폴백 */
export async function doInfo(chatId: string): Promise<ActionResult> {
  const sel = getSelectedCompany(chatId);
  if (!sel) return { type: "direct", html: needsCompanyMessage() };

  if (dart.isAvailable() && sel.corpCode) {
    try {
      const info = await dart.getCompanyInfo(sel.corpCode);
      return {
        type: "direct",
        html: dart.formatCompanyInfo(info),
        keyboard: companySelectedKeyboard(),
      };
    } catch (e: any) {
      console.error(`[Company] DART info failed, falling back: ${e.message}`);
    }
  }
  return { type: "fallback", prompt: buildInfoPrompt(sel.name) };
}

/** 재무제표 — DART fnlttSinglAcnt.json → 폴백 */
export async function doFinance(chatId: string): Promise<ActionResult> {
  const sel = getSelectedCompany(chatId);
  if (!sel) return { type: "direct", html: needsCompanyMessage() };

  if (dart.isAvailable() && sel.corpCode) {
    try {
      const items = await dart.getFinancials(sel.corpCode);
      return {
        type: "direct",
        html: dart.formatFinancials(items, sel.name),
        keyboard: companySelectedKeyboard(),
      };
    } catch (e: any) {
      console.error(`[Company] DART finance failed, falling back: ${e.message}`);
    }
  }
  return { type: "fallback", prompt: buildFinancePrompt(sel.name) };
}

/** 공시 목록 — DART list.json → 폴백 */
export async function doDisclosure(chatId: string): Promise<ActionResult> {
  const sel = getSelectedCompany(chatId);
  if (!sel) return { type: "direct", html: needsCompanyMessage() };

  if (dart.isAvailable() && sel.corpCode) {
    try {
      const items = await dart.getDisclosures(sel.corpCode);
      return {
        type: "direct",
        html: dart.formatDisclosures(items, sel.name),
        keyboard: companySelectedKeyboard(),
      };
    } catch (e: any) {
      console.error(`[Company] DART disclosure failed, falling back: ${e.message}`);
    }
  }
  return { type: "fallback", prompt: buildDisclosurePrompt(sel.name) };
}

/** 증거 수집 — 항상 Claude (종합 분석이므로 WebSearch 필요) */
export async function doEvidence(chatId: string): Promise<ActionResult> {
  const sel = getSelectedCompany(chatId);
  if (!sel) return { type: "direct", html: needsCompanyMessage() };
  return { type: "fallback", prompt: buildEvidencePrompt(sel.name) };
}

/** 검색 결과에서 기업 선택 */
export function selectFromResults(chatId: string, index: number): SelectedCompany | null {
  const results = getSearchResults(chatId);
  if (!results || index < 0 || index >= results.length) return null;
  const r = results[index];
  const company: SelectedCompany = { name: r.corpName, corpCode: r.corpCode, stockCode: r.stockCode };
  setSelectedCompany(chatId, company);
  return company;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Claude WebSearch 폴백 프롬프트
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function now(): string {
  return new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
}

export function buildSearchPrompt(query: string): string {
  return `[기업정보 증거서비스 — 기업 검색]

사용자가 "${query}" 기업을 검색합니다.

다음을 수행하세요:
1. WebSearch로 "${query}" 기업의 정확한 정보를 검색 (DART 전자공시, 금융감독원, KRX, 네이버금융 등)
2. 검색된 기업의 기본 정보를 아래 형식으로 정리:

━━━━━━━━━━━━━━━━━━
▸ 기업명: (정식 명칭)
▸ 종목코드: (상장 시)
▸ 대표자:
▸ 법인등록번호:
▸ 업종:
▸ 설립일:
▸ 소재지:
▸ 상장여부: KOSPI / KOSDAQ / 비상장
━━━━━━━━━━━━━━━━━━

여러 기업이 검색되면 각각 간략히 나열하세요.
출처 URL을 반드시 포함하세요. 한국어로 답변하세요.
조사 시각: ${now()}`;
}

export function buildInfoPrompt(name: string): string {
  return `[기업정보 증거서비스 — 기업 개황]

"${name}"의 기업 개황을 조사하세요.

WebSearch/WebFetch로 다음 정보를 수집:
1. 기본 정보 (정식명칭, 영문명, 종목코드, 법인등록번호)
2. 대표이사 및 경영진
3. 업종 및 주요 사업 내용
4. 소재지 (본사, 주요 사업장)
5. 설립일, 상장일
6. 최근 주요 연혁
7. 계열회사 / 관계회사

깔끔한 텍스트 형식, 구분선 사용.
출처 URL 포함. 한국어로 답변.
조사 시각: ${now()}`;
}

export function buildFinancePrompt(name: string): string {
  return `[기업정보 증거서비스 — 재무제표]

"${name}"의 최근 재무정보를 조사하세요.

WebSearch/WebFetch로 다음을 수집:
1. 최근 3년 주요 재무지표:
   ─ 매출액, 영업이익, 당기순이익
   ─ 자산총계, 부채총계, 자본총계
   ─ 부채비율, ROE, ROA
2. 최근 분기 실적 (있을 경우)
3. 배당 현황
4. 신용등급 (있을 경우)

DART 전자공시, 네이버금융, FnGuide 등에서 검색.
숫자는 억원/조원 단위로 읽기 쉽게 표시.
출처 URL 포함. 한국어로 답변.
조사 시각: ${now()}`;
}

export function buildDisclosurePrompt(name: string): string {
  return `[기업정보 증거서비스 — 공시 검색]

"${name}"의 최근 주요 공시를 조사하세요.

WebSearch/WebFetch로 다음을 수집:
1. DART(dart.fss.or.kr)에서 최근 공시 목록 (최근 3개월)
2. 주요 공시 유형별 분류:
   ─ 정기보고서 (사업보고서, 반기보고서, 분기보고서)
   ─ 주요사항보고서
   ─ 지분공시
   ─ 기타 주요 공시
3. 각 공시의 제목, 날짜, 원문 링크

DART 전자공시시스템(dart.fss.or.kr)에서 직접 검색.
출처 URL 포함. 한국어로 답변.
조사 시각: ${now()}`;
}

export function buildEvidencePrompt(name: string): string {
  return `[기업정보 증거서비스 — 종합 증거 수집]

"${name}"에 대한 종합 증거 리포트를 작성하세요.
법적 증거 수집 목적입니다. 아래 항목을 모두 조사하여 하나의 종합 리포트로 작성하세요.

━━ 1. 기업 기본정보 ━━
─ 정식명칭, 법인등록번호, 사업자등록번호
─ 대표이사, 소재지, 설립일
─ 업종, 주요사업

━━ 2. 재무 현황 ━━
─ 최근 3년 주요 재무지표
─ 자본금, 매출, 영업이익

━━ 3. 최근 공시 ━━
─ 주요 공시 목록 (최근 6개월)
─ 정기보고서 제출 현황

━━ 4. 주요 변동사항 ━━
─ 대표이사 변경, 합병, 분할 등
─ 소송, 행정처분, 제재 관련 공시

━━ 5. 출처 목록 ━━
─ 모든 정보의 출처 URL

각 섹션에 조사 일시를 기록하세요.
확인되지 않은 정보는 "미확인"으로 명시하세요.
빠짐없이 철저하게 조사하세요.
한국어로 답변.
조사 시각: ${now()}`;
}
