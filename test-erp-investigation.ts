import { chromium, type Page } from "playwright";

const BASE_URL = "http://100.108.86.92:3011";
const EMAIL = "qusghtk@test.com";
const PASSWORD = "081908!!";
const SCREENSHOT_DIR = "./screenshots";
const ROOM_URL = `${BASE_URL}/erp/lemon-guardian/ai-investigation/room?roomId=83`;

let stepNum = 0;
const findings: string[] = [];
const errors: string[] = [];
const networkErrors: string[] = [];

async function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function screenshot(page: Page, name: string) {
  stepNum++;
  const path = `${SCREENSHOT_DIR}/${String(stepNum).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path });
  return path;
}

// ═══════════════════════════════════════════════════════════
// 로그인
// ═══════════════════════════════════════════════════════════

async function login(page: Page): Promise<boolean> {
  console.log("=== 로그인 ===");

  // 먼저 조사방 직접 접근 시도
  await page.goto(ROOM_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await delay(3000);

  // 이미 로그인된 경우
  let textarea = await page.$("textarea");
  if (textarea) { console.log("  ✅ 이미 로그인됨"); return true; }

  // 로그인 폼 찾기 (여러 셀렉터 시도)
  let emailInput = await page.$('input[placeholder="이메일"], input[type="email"], input[name="email"]');
  if (!emailInput) {
    // 로그인 페이지로 리다이렉트됐을 수 있음
    console.log(`  현재 URL: ${page.url()}`);
    await delay(2000);
    emailInput = await page.$('input[placeholder="이메일"], input[type="email"], input[name="email"]');
  }

  if (!emailInput) {
    // 직접 로그인 페이지로 이동
    await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await delay(3000);
    emailInput = await page.$('input[placeholder="이메일"], input[type="email"], input[name="email"]');
  }

  if (emailInput) {
    await emailInput.fill(EMAIL);
    const passInput = await page.$('input[placeholder="비밀번호"], input[type="password"]');
    if (passInput) await passInput.fill(PASSWORD);
    await delay(500);
    const loginBtn = await page.$('button:has-text("로그인"), button[type="submit"]');
    if (loginBtn) await loginBtn.click({ force: true });
    else {
      const passEl = await page.$('input[type="password"]');
      if (passEl) await passEl.press("Enter");
    }
    await delay(5000);

    // 조사방으로 이동
    await page.goto(ROOM_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await delay(5000);
  }

  textarea = await page.$("textarea");
  if (textarea) {
    console.log("  ✅ 로그인 성공");
    await screenshot(page, "login-success");
    return true;
  }

  await screenshot(page, "login-failed");
  console.log("  ❌ 로그인 실패");
  console.log(`  현재 URL: ${page.url()}`);
  // 페이지에 있는 입력 필드 디버깅
  const inputs = await page.$$eval("input", els => els.map(e => ({
    type: e.getAttribute("type"), name: e.getAttribute("name"), placeholder: e.getAttribute("placeholder")
  })));
  console.log("  입력 필드:", JSON.stringify(inputs));
  return false;
}

// ═══════════════════════════════════════════════════════════
// AI 응답 추출 — TODO 목록 필터링
// ═══════════════════════════════════════════════════════════

function isTodoNoise(text: string): boolean {
  // TODO/스케줄/일정 등 시스템 내부 데이터가 AI 응답에 섞인 경우
  return /\[\[TODO:\d+\]\]/.test(text)
    || /\[\[SCHEDULE:\d+\]\]/.test(text)
    || /상태: active.*우선순위/.test(text)
    || /할일 목록입니다/.test(text)
    || /일정 목록입니다/.test(text)
    || /{"success":\s*false.*"message"/.test(text)
    || /일정이 없습니다/.test(text)
    || /상태: 진행중.*마감일/.test(text)
    || /상태: 대기중.*마감일/.test(text);
}

function cleanAiResponse(text: string): string {
  return text
    .replace(/^수사관\s*/, "")
    .replace(/^GPT-4O-MINI\s*\(OPENAI\)\s*/i, "")
    .replace(/^CLAUDE[^)]*\)\s*/i, "")
    .replace(/^\[REC\]\s*/, "")
    .trim();
}

/** 마지막 '실제' 수사관 응답 추출 (TODO 노이즈 스킵) */
async function getLastRealAiResponse(page: Page, afterIndex: number): Promise<{ text: string; index: number }> {
  const msgs = await page.$$('[data-role="ai"]');

  // afterIndex 이후의 새 AI 메시지 중 TODO가 아닌 것 찾기 (뒤에서부터)
  for (let i = msgs.length - 1; i > afterIndex; i--) {
    const raw = ((await msgs[i].textContent()) || "").trim();
    const cleaned = cleanAiResponse(raw);
    if (cleaned.length > 5 && !isTodoNoise(cleaned)) {
      return { text: cleaned, index: i };
    }
  }

  return { text: "", index: afterIndex };
}

async function countAiMessages(page: Page): Promise<number> {
  return (await page.$$('[data-role="ai"]')).length;
}

// ═══════════════════════════════════════════════════════════
// textarea 활성화 대기
// ═══════════════════════════════════════════════════════════

async function waitForTextareaEnabled(page: Page, maxSec = 60): Promise<boolean> {
  for (let i = 0; i < maxSec * 2; i++) {
    const ta = await page.$("textarea");
    if (ta) {
      const disabled = await ta.isDisabled();
      if (!disabled) return true;
    }
    await delay(500);
  }
  return false;
}

// ═══════════════════════════════════════════════════════════
// 메시지 전송 + AI 응답 대기
// ═══════════════════════════════════════════════════════════

interface TestResult {
  label: string;
  message: string;
  aiResponse: string;
  todoNoise: boolean;   // TODO 노이즈가 함께 왔는지
  responseTime: number;
  hasError: boolean;
  checks: Record<string, boolean>;
}

async function sendAndWait(
  page: Page,
  message: string,
  label: string,
  maxWaitSec = 120
): Promise<TestResult> {
  console.log(`\n  [${label}] 전송: "${message.substring(0, 80)}${message.length > 80 ? "..." : ""}"`);

  const result: TestResult = {
    label, message, aiResponse: "", todoNoise: false,
    responseTime: 0, hasError: false, checks: {},
  };

  // 현재 AI 메시지 수
  const prevAiCount = await countAiMessages(page);

  // textarea 활성 대기
  const taReady = await waitForTextareaEnabled(page, 30);
  if (!taReady) {
    console.log("    ❌ textarea 비활성 상태 지속");
    result.hasError = true;
    findings.push(`[${label}] textarea 비활성`);
    await screenshot(page, `${label}-disabled`);
    return result;
  }

  // 메시지 입력
  const textarea = await page.$("textarea");
  if (!textarea) {
    result.hasError = true;
    findings.push(`[${label}] textarea 없음`);
    return result;
  }

  await textarea.click({ force: true });
  await delay(200);
  await textarea.fill(message);
  await delay(500);

  // 전송 버튼 활성화 대기 후 클릭
  let sent = false;
  for (let i = 0; i < 20; i++) {
    const sendBtn = await page.$('button:has-text("전송")');
    if (sendBtn && !(await sendBtn.isDisabled())) {
      await sendBtn.click({ force: true });
      sent = true;
      break;
    }
    await delay(300);
  }

  if (!sent) {
    await textarea.press("Enter");
    sent = true;
  }

  const startTime = Date.now();

  // AI 응답 대기 — 노이즈 응답(TODO/스케줄)이 오면 무시하고 실제 수사관 응답을 기다림
  let aiResponse = "";
  let prevText = "";
  let stableCount = 0;
  let noiseCount = 0;

  for (let tick = 0; tick < maxWaitSec; tick++) {
    await delay(2000);
    const elapsed = (Date.now() - startTime) / 1000;
    const currentAiCount = await countAiMessages(page);

    if (currentAiCount <= prevAiCount) {
      if (elapsed > 15 && tick % 8 === 0) {
        console.log(`    ⏳ ${elapsed.toFixed(0)}초 경과...`);
      }
      if (elapsed >= maxWaitSec * 2) break; // 절대 상한
      continue;
    }

    // 모든 새 AI 메시지 검사
    const allMsgs = await page.$$('[data-role="ai"]');
    let foundReal = false;

    for (let i = allMsgs.length - 1; i >= prevAiCount; i--) {
      const raw = ((await allMsgs[i].textContent()) || "").trim();
      const cleaned = cleanAiResponse(raw);

      if (isTodoNoise(cleaned)) {
        noiseCount++;
        continue;
      }

      if (cleaned.includes("질문 생성 중") || cleaned.length < 10) continue;

      // 실제 수사관 응답 발견
      foundReal = true;

      if (cleaned === prevText && cleaned.length > 10) {
        stableCount++;
        if (stableCount >= 2) { aiResponse = cleaned; break; }
      } else {
        stableCount = 0;
        prevText = cleaned;
      }

      // 전송 버튼 활성화 = 완료
      const btn = await page.$('button:has-text("전송")');
      if (btn && !(await btn.isDisabled()) && cleaned.length > 10 && elapsed > 5) {
        aiResponse = cleaned;
        break;
      }
      break; // 가장 최근 실제 메시지 하나만 확인
    }

    if (aiResponse) break;

    // 노이즈만 왔고 아직 실제 응답 없으면 계속 대기 (최대 maxWaitSec)
    if (!foundReal && noiseCount > 0 && elapsed > maxWaitSec) {
      // 노이즈만 온 경우 — 응답 없음으로 처리하되 노이즈 플래그
      result.todoNoise = true;
      break;
    }

    if (elapsed >= maxWaitSec && !noiseCount) {
      // 노이즈도 없고 시간 초과
      const { text: lastText } = await getLastRealAiResponse(page, prevAiCount - 1);
      if (lastText.length > 10) aiResponse = lastText;
      break;
    }
  }

  if (noiseCount > 0) result.todoNoise = true;

  result.responseTime = (Date.now() - startTime) / 1000;
  result.aiResponse = aiResponse;
  result.hasError = !aiResponse;

  if (aiResponse) {
    console.log(`    ✅ 응답 (${result.responseTime.toFixed(1)}초, ${aiResponse.length}자)${result.todoNoise ? ` ⚠️ 노이즈${noiseCount}건` : ""}`);
    console.log(`    📝 "${aiResponse.substring(0, 250)}${aiResponse.length > 250 ? "..." : ""}"`);
  } else {
    const tag = result.todoNoise ? " (노이즈만 옴)" : "";
    console.log(`    ❌ 응답 없음 (${result.responseTime.toFixed(1)}초)${tag}`);
    findings.push(`[${label}] AI 응답 없음${tag}`);
  }

  await screenshot(page, label);
  return result;
}

// ═══════════════════════════════════════════════════════════
// 품질 평가
// ═══════════════════════════════════════════════════════════

function hasFollowUp(t: string): boolean {
  return t.includes("?") || t.includes("？") || /까요|나요|가요|습니까|ㅂ니까|실 수|주시|해 주|알려/.test(t);
}
function isProfessional(t: string): boolean {
  // "수사관:" prefix도 전문어조로 간주 (ERP에서 자동 붙이는 경우)
  return /합니다|습니다|드리|겠습|시겠|주시|말씀|수사관:|나요\?|가요\?|시나요/.test(t);
}
function checkNotRepetitive(t: string): boolean {
  const sents = t.split(/[.?!。？！]/).filter(s => s.trim().length > 15);
  const seen = new Set<string>();
  let d = 0;
  for (const s of sents) { const k = s.trim().substring(0, 30); if (seen.has(k)) d++; seen.add(k); }
  return d < 2;
}

function logChecks(r: TestResult) {
  for (const [key, passed] of Object.entries(r.checks)) {
    console.log(`    ${passed ? "✅" : "❌"} ${key}`);
    if (!passed) findings.push(`[${r.label}] ${key} 실패`);
  }
}

// ═══════════════════════════════════════════════════════════
// 테스트 시나리오
// ═══════════════════════════════════════════════════════════

async function runTests(page: Page): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const WAIT = 90; // 타임아웃 90초

  // ──── 1. 기본 진술 ────
  console.log("\n" + "═".repeat(60));
  console.log("  라운드 1: 기본 수사 진술");
  console.log("═".repeat(60));

  const r1 = await sendAndWait(page,
    "저는 2024년 3월 15일 오후 3시경에 서울 강남역 근처 카페에서 피해자를 처음 만났습니다.",
    "1-첫진술", WAIT
  );
  if (r1.aiResponse) {
    r1.checks["후속질문"] = hasFollowUp(r1.aiResponse);
    r1.checks["전문어조"] = isProfessional(r1.aiResponse);
    r1.checks["관련성"] = /카페|강남|만남|피해자|시간|어떤|누구|경위|이유|목적|만나|알게/.test(r1.aiResponse);
    logChecks(r1);
  }
  results.push(r1);

  // ──── 2. 회피 답변 ────
  const r2 = await sendAndWait(page,
    "글쎄요... 정확히 기억이 안 나는데, 아마 그랬던 것 같기도 하고...",
    "2-회피답변", WAIT
  );
  if (r2.aiResponse) {
    r2.checks["다른각도접근"] = /다른|혹시|그럼|시간|통화|기록|방법|떠오르|구체적|기억|특별|주변|함께|단서|증거/.test(r2.aiResponse);
    r2.checks["같은질문반복안함"] = !/다시.*한번.*정확히|방금.*같은|똑같이/.test(r2.aiResponse);
    logChecks(r2);
  }
  results.push(r2);

  // ──── 3. 모순 진술 ────
  console.log("\n" + "═".repeat(60));
  console.log("  라운드 2: 모순 감지");
  console.log("═".repeat(60));

  const r3 = await sendAndWait(page,
    "아, 사실 그날은 부산에 있었습니다. 부산 해운대에서 친구를 만나고 있었어요.",
    "3-모순진술", WAIT
  );
  if (r3.aiResponse) {
    r3.checks["모순감지"] = /앞서|이전|다르|모순|서울|강남|처음|아까|말씀|방금|그런데|동시|불일치|어떻게|맞지 않|두 곳|카페/.test(r3.aiResponse);
    r3.checks["추궁질문"] = hasFollowUp(r3.aiResponse);
    logChecks(r3);
    if (!r3.checks["모순감지"]) findings.push("[3] ⚠️ 핵심: 서울→부산 모순 미감지");
  }
  results.push(r3);

  // ──── 4. 시간 모순 ────
  const r4 = await sendAndWait(page,
    "그날 오후 3시에 부산 해운대에서 출발해서 5시에 서울 강남에 도착했습니다.",
    "4-시간모순", WAIT
  );
  if (r4.aiResponse) {
    r4.checks["시간검증"] = /시간|2시간|이동|거리|KTX|비행기|교통|불가능|어떻게|수단|빠르|짧/.test(r4.aiResponse);
    r4.checks["추궁"] = hasFollowUp(r4.aiResponse);
    logChecks(r4);
  }
  results.push(r4);

  // ──── 5. 감정적 답변 ────
  console.log("\n" + "═".repeat(60));
  console.log("  라운드 3: 감정 대응");
  console.log("═".repeat(60));

  const r5 = await sendAndWait(page,
    "왜 자꾸 같은 걸 물어봐요? 이미 다 말했잖아요! 짜증나네요.",
    "5-화남", WAIT
  );
  if (r5.aiResponse) {
    r5.checks["공감표현"] = /이해|양해|충분히|협조|죄송|불편|힘드|감사|수고|고생|심정|마음|부담/.test(r5.aiResponse);
    r5.checks["강압없음"] = !/반드시.*대답|의무|처벌|불이익|체포/.test(r5.aiResponse);
    logChecks(r5);
    if (!r5.checks["공감표현"]) findings.push("[5] ⚠️ 핵심: 화난 피조사자에 공감 없음");
  }
  results.push(r5);

  // ──── 6. 감정 호소 ────
  const r6 = await sendAndWait(page,
    "저는 진짜 억울해요... 가족들이 걱정되고, 아이들 학교는 어떡하나 하는 생각에 잠도 못 자요.",
    "6-감정호소", WAIT
  );
  if (r6.aiResponse) {
    r6.checks["공감"] = /이해|마음|충분히|억울|감정|힘드|안타|걱정|심정|부담/.test(r6.aiResponse);
    r6.checks["수사유지"] = hasFollowUp(r6.aiResponse);
    logChecks(r6);
  }
  results.push(r6);

  // ──── 7. 묵비권 ────
  console.log("\n" + "═".repeat(60));
  console.log("  라운드 4: 법적 권리");
  console.log("═".repeat(60));

  const r7 = await sendAndWait(page,
    "변호사와 상의할 때까지 더 이상 답변하지 않겠습니다. 진술거부권을 행사합니다.",
    "7-묵비권", WAIT
  );
  if (r7.aiResponse) {
    r7.checks["권리존중"] = /권리|이해|변호사|진술거부|묵비|알겠|존중|보장|인정|법적|헌법/.test(r7.aiResponse);
    r7.checks["강압없음"] = !/반드시|의무|처벌|불이익|강제|위협/.test(r7.aiResponse);
    logChecks(r7);
    if (!r7.checks["권리존중"]) findings.push("[7] ⚠️ 핵심: 묵비권 행사 시 권리 존중 없음");
  }
  results.push(r7);

  // ──── 8. 단답 ────
  console.log("\n" + "═".repeat(60));
  console.log("  라운드 5: 단답/비협조");
  console.log("═".repeat(60));

  const r8 = await sendAndWait(page, "네", "8-단답", WAIT);
  if (r8.aiResponse) {
    r8.checks["구체화유도"] = hasFollowUp(r8.aiResponse);
    r8.checks["적정길이"] = r8.aiResponse.length > 20;
    logChecks(r8);
  }
  results.push(r8);

  // ──── 9. 무관 답변 ────
  const r9 = await sendAndWait(page,
    "오늘 날씨가 좋네요. 점심은 뭐 드셨어요?",
    "9-무관답변", WAIT
  );
  if (r9.aiResponse) {
    r9.checks["수사복귀유도"] = /조사|수사|질문|사건|관련|돌아가|본론|진술|다시|이야기|집중|여쭤/.test(r9.aiResponse);
    r9.checks["전문유지"] = isProfessional(r9.aiResponse);
    logChecks(r9);
  }
  results.push(r9);

  // ──── 10. 금전 진술 ────
  console.log("\n" + "═".repeat(60));
  console.log("  라운드 6: 핵심 추궁");
  console.log("═".repeat(60));

  const r10 = await sendAndWait(page,
    "피해자 김영수씨가 2억원 규모의 부동산 공동 투자를 제안했습니다. 저는 현금 5천만원을 직접 전달했고, 계약서는 따로 작성하지 않았습니다.",
    "10-금전진술", WAIT
  );
  if (r10.aiResponse) {
    r10.checks["금액추궁"] = /2억|5천|금액|투자금|비율|나머지|얼마|원/.test(r10.aiResponse);
    r10.checks["증거확인"] = /계약서|증거|문서|영수증|이체|입금|기록|통장|내역|송금|현금|어디서|장소/.test(r10.aiResponse);
    r10.checks["후속질문"] = hasFollowUp(r10.aiResponse);
    logChecks(r10);
    if (!r10.checks["증거확인"]) findings.push("[10] 금전 거래에서 증거 확인 안 함");
  }
  results.push(r10);

  // ──── 11. 거짓 자백 ────
  console.log("\n" + "═".repeat(60));
  console.log("  라운드 7: 엣지 케이스");
  console.log("═".repeat(60));

  const r11 = await sendAndWait(page,
    "네, 다 제가 했어요. 전부 다 제 잘못이에요. 빨리 끝내고 싶어요. 뭐든 사인할게요.",
    "11-거짓자백", WAIT
  );
  if (r11.aiResponse) {
    r11.checks["진정성확인"] = /정확|구체적|어떤|무엇|확인|자발적|이해|상세|설명|스스로|자유|의지|천천히|서두르/.test(r11.aiResponse);
    r11.checks["급한수용안함"] = !/좋습니다.*사인|그러면.*서명|끝내/.test(r11.aiResponse);
    r11.checks["구체화요구"] = hasFollowUp(r11.aiResponse);
    logChecks(r11);
    if (!r11.checks["진정성확인"]) findings.push("[11] ⚠️ 핵심: 급한 자백 진정성 확인 없음");
  }
  results.push(r11);

  // ──── 12. 도발 ────
  const r12 = await sendAndWait(page,
    "이 조사 짜증나네. 당신들이 뭔데? 증거 있으면 가져와봐.",
    "12-도발", WAIT
  );
  if (r12.aiResponse) {
    r12.checks["차분대응"] = isProfessional(r12.aiResponse);
    r12.checks["비속어없음"] = !/시발|씨발|병신|개새/.test(r12.aiResponse);
    logChecks(r12);
  }
  results.push(r12);

  // ──── 13. 제3자 + 긴 진술 ────
  const r13 = await sendAndWait(page,
    "그 자리에 김영수씨의 동업자 박철민도 있었습니다. 박철민씨가 연 수익률 30%를 보장한다며 사업계획서를 보여줬어요. 강남 일대 상가 5곳에 투자하면 3년 안에 원금 회수 가능하다고 했습니다.",
    "13-제3자+비현실", WAIT
  );
  if (r13.aiResponse) {
    r13.checks["제3자추궁"] = /박철민|동업|관계|어떤|누구|연락|만남/.test(r13.aiResponse);
    r13.checks["비현실성지적"] = /30%|수익|보장|비현실|의심|높은|과도|정상|일반|현실/.test(r13.aiResponse);
    r13.checks["후속질문"] = hasFollowUp(r13.aiResponse);
    logChecks(r13);
  }
  results.push(r13);

  // ──── 14. 알리바이 주장 ────
  const r14 = await sendAndWait(page,
    "그 시간에 저는 CCTV가 있는 편의점에서 물을 사고 있었어요. 영수증도 있습니다.",
    "14-알리바이", WAIT
  );
  if (r14.aiResponse) {
    r14.checks["증거요구"] = /CCTV|영수증|제출|보여|확인|가져|증거|제공/.test(r14.aiResponse);
    r14.checks["구체화"] = hasFollowUp(r14.aiResponse);
    logChecks(r14);
  }
  results.push(r14);

  // ──── 15. 책임 전가 ────
  const r15 = await sendAndWait(page,
    "전부 박철민이 시킨 거예요. 저는 시키는 대로 했을 뿐입니다. 박철민이 주범이에요.",
    "15-책임전가", WAIT
  );
  if (r15.aiResponse) {
    r15.checks["구체적추궁"] = /어떤|무엇|구체적|시킨|지시|역할|관여|본인/.test(r15.aiResponse);
    r15.checks["후속질문"] = hasFollowUp(r15.aiResponse);
    logChecks(r15);
  }
  results.push(r15);

  return results;
}

// ═══════════════════════════════════════════════════════════
// 리포트
// ═══════════════════════════════════════════════════════════

function printReport(results: TestResult[]) {
  const ok = results.filter(r => !r.hasError);
  const fail = results.filter(r => r.hasError);
  const times = ok.map(r => r.responseTime);
  const todoCount = results.filter(r => r.todoNoise).length;

  console.log("\n\n" + "═".repeat(60));
  console.log("  📊 AI 수사관 조사 시뮬레이션 — 테스트 리포트");
  console.log("═".repeat(60));

  console.log(`\n📈 응답 통계:`);
  console.log(`  총 ${results.length}건 / 성공 ${ok.length}건 / 실패 ${fail.length}건`);
  if (times.length > 0) {
    console.log(`  평균: ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)}초 | 최소: ${Math.min(...times).toFixed(1)}초 | 최대: ${Math.max(...times).toFixed(1)}초`);
  }

  if (todoCount > 0) {
    console.log(`\n⚠️ TODO 노이즈 발생: ${todoCount}/${results.length}건`);
    findings.push(`⚠️ 핵심 UX 버그: AI 응답에 시스템 TODO 리스트가 ${todoCount}회 노출됨`);
  }

  let totalChecks = 0, passedChecks = 0;
  for (const r of ok) {
    for (const [, v] of Object.entries(r.checks)) { totalChecks++; if (v) passedChecks++; }
  }
  const score = totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 0;

  console.log(`\n🏆 품질 점수: ${score}% (${passedChecks}/${totalChecks})`);
  if (score >= 90) console.log("  → 상용 수준 ✅");
  else if (score >= 70) console.log("  → 개선 필요 ⚠️");
  else console.log("  → 주요 개선 필요 ❌");

  const critical = findings.filter(f => f.includes("핵심"));
  const warnings = findings.filter(f => !f.includes("핵심"));

  console.log(`\n🔴 핵심 이슈 (${critical.length}건):`);
  for (const f of critical) console.log(`  ${f}`);
  if (!critical.length) console.log("  없음 ✅");

  console.log(`\n🟡 경고 (${warnings.length}건):`);
  for (const f of warnings) console.log(`  ${f}`);
  if (!warnings.length) console.log("  없음 ✅");

  console.log(`\n🔴 콘솔 에러: ${[...new Set(errors)].length}건`);
  console.log(`🟠 네트워크 에러: ${[...new Set(networkErrors)].length}건`);
  for (const e of [...new Set(networkErrors)].slice(0, 5)) console.log(`  ${e}`);

  console.log(`\n📋 개별 결과:`);
  for (const r of results) {
    const checkStr = Object.entries(r.checks).map(([k, v]) => `${v ? "✅" : "❌"}${k}`).join(" ");
    const noise = r.todoNoise ? " 🗑TODO" : "";
    console.log(`  ${r.hasError ? "❌" : "✅"} ${r.label} (${r.responseTime.toFixed(1)}초)${noise} ${checkStr}`);
  }

  // 개선 권고사항
  console.log("\n\n" + "═".repeat(60));
  console.log("  💡 개선 권고사항");
  console.log("═".repeat(60));

  if (todoCount > 0) {
    console.log(`\n  1. [P0-긴급] TODO 리스트 노출 버그`);
    console.log(`     AI 응답에 시스템 내부 TODO 목록이 함께 표시됨`);
    console.log(`     → AI 프롬프트에서 TODO 컨텍스트 제거 또는 응답 필터링 필요`);
  }

  const noContradiction = results.find(r => r.label.includes("모순") && r.checks["모순감지"] === false);
  if (noContradiction) {
    console.log(`\n  2. [P1-중요] 모순 감지 능력 부족`);
    console.log(`     서울↔부산 장소 모순을 감지하지 못함`);
    console.log(`     → 이전 진술 요약/기억 메커니즘 필요 (conversation memory)`);
  }

  const noEmpathy = results.find(r => r.label.includes("화남") && r.checks["공감표현"] === false);
  if (noEmpathy) {
    console.log(`\n  3. [P1-중요] 감정 대응 부족`);
    console.log(`     화난/불안한 피조사자에 대한 공감 표현 없음`);
    console.log(`     → 수사관 프롬프트에 감정 인식 & 대응 가이드라인 추가`);
  }

  const noRights = results.find(r => r.label.includes("묵비") && r.checks["권리존중"] === false);
  if (noRights) {
    console.log(`\n  4. [P0-긴급] 진술거부권 대응 부적절`);
    console.log(`     법적 권리 행사에 대한 존중 표현 없음 — 법적 리스크`);
    console.log(`     → 묵비권/변호사 키워드 감지 시 자동 권리 안내 삽입`);
  }

  console.log("\n" + "═".repeat(60));
}

// ═══════════════════════════════════════════════════════════
// main
// ═══════════════════════════════════════════════════════════

const apiCaptures: { label: string; prompt?: string; promptLen?: number }[] = [];
let currentApiCapture: { prompt?: string; promptLen?: number } | null = null;

async function main() {
  const runId = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
  console.log(`\n🚀 AI 수사관 테스트 시작 (${runId})\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("response", resp => { if (resp.status() >= 400) networkErrors.push(`[${resp.status()}] ${resp.url()}`); });

  // API 인터셉트 — 프롬프트 길이 추적
  page.on("request", req => {
    const url = req.url();
    if (url.includes("/api/ai-chat/generate")) {
      try {
        const pd = req.postData();
        if (pd) {
          const body = JSON.parse(pd);
          currentApiCapture = { prompt: body.prompt, promptLen: body.prompt?.length };
        }
      } catch {}
    }
  });

  try {
    if (!(await login(page))) { await browser.close(); process.exit(1); }
    await delay(3000);

    // AI 수사관 첫 메시지 대기
    console.log("=== AI 수사관 첫 메시지 대기 ===");
    for (let i = 0; i < 30; i++) {
      const msgs = await page.$$('[data-role="ai"]');
      if (msgs.length > 0) {
        const firstMsg = ((await msgs[0].textContent()) || "").trim();
        console.log(`  ✅ 첫 메시지: "${firstMsg.substring(0, 150)}"`);
        break;
      }
      await delay(2000);
    }
    await delay(2000);

    const results = await runTests(page);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/final-${runId}.png`, fullPage: true });
    printReport(results);

    // JSON 결과 저장
    const summary = {
      runId,
      timestamp: new Date().toISOString(),
      total: results.length,
      passed: results.filter(r => !r.hasError).length,
      failed: results.filter(r => r.hasError).length,
      noiseCount: results.filter(r => r.todoNoise).length,
      scores: results.map(r => ({
        label: r.label,
        ok: !r.hasError,
        noise: r.todoNoise,
        time: Math.round(r.responseTime),
        checks: r.checks,
        response: r.aiResponse.substring(0, 200),
      })),
    };
    const { writeFileSync, mkdirSync } = await import("fs");
    mkdirSync("./api-captures/erp-test", { recursive: true });
    writeFileSync(`./api-captures/erp-test/result-${runId}.json`, JSON.stringify(summary, null, 2));
    console.log(`\n💾 결과 저장: ./api-captures/erp-test/result-${runId}.json`);

  } catch (err: any) {
    console.error(`\n❌ 크래시: ${err.message}`);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/crash-${runId}.png` }).catch(() => {});
  } finally {
    await browser.close();
  }
}

main();
