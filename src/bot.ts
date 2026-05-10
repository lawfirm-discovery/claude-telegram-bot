import { Bot, InlineKeyboard } from "grammy";
import { askClaude, askClaudeWithProgress, clearSession, getSessionStats, getHudInfo, killActiveProcesses, loadInterruptedContext, hasInterruptedContext, getCurrentPlan, saveCheckpoint, type ProgressInfo } from "./claude-engine";
import { appendMemoryLog, appendSharedMemory, appendChatNote, clearChatNotes, loadChatNotes, loadActiveWorking, archiveActiveWorking, clearActiveWorking } from "./lemonclaw";
import {
  BOT_ROLE, planTask, dispatchTask, handleWorkerReport,
  mergeCompletedTask, formatTaskStatus, detectTaskMessage,
  executeWorkerTask, getWorkerBots, formatAffinityReport,
  quickDelegate, detectDelegateMessage,
} from "./orchestrator";
import { formatRalphStatus, listTasks, startRalphTask, stopTask, approveAndStart, cancelPendingTask } from "./ralph-loop";
import {
  detectApprovalRequest,
  getApprovalEmoji,
  getApprovalLabel,
  type ApprovalRequest,
} from "./approval";
import { escapeHtml, markdownToTelegramHtml, splitMessage } from "./format";
import { formatBuildInfo } from "./build-info";
import { handleDelegateApprovalCallback } from "./worker-api";
import { mkdtemp, writeFile, unlink, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required in .env");
  process.exit(1);
}

const ALLOWED_USERS = process.env.ALLOWED_USERS
  ? process.env.ALLOWED_USERS.split(",").map((id) => parseInt(id.trim()))
  : [];

const GROUP_MENTION_PATTERNS = (process.env.GROUP_MENTION_PATTERNS || "")
  .split(",")
  .filter(Boolean);

const bot = new Bot(BOT_TOKEN);

// Pairing system (LemonClaw style)
const pendingPairings = new Map<string, number>();
const approvedUsers = new Set<number>(ALLOWED_USERS);

// Pending approval requests: approvalId -> { chatId, request }
const pendingApprovals = new Map<
  string,
  { chatId: string; request: ApprovalRequest }
>();

function generatePairingCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// --- Access control ---
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  // [DEBUG R3.7] 모든 incoming message 의 chat type / text / entities dump (DM/forum 매칭 진단용)
  if (ctx.message) {
    const m: any = ctx.message;
    console.log(
      `[DEBUG-MSG] chat.type=${ctx.chat?.type} chat.id=${ctx.chat?.id} ` +
      `from=${userId} thread=${m.message_thread_id ?? '-'} ` +
      `text=${JSON.stringify(m.text?.slice(0, 80) ?? '')} ` +
      `entities=${JSON.stringify((m.entities || []).map((e: any) => ({ type: e.type, offset: e.offset, length: e.length })))}`
    );
  }
  if (!userId) return;

  // 봇 간 위임 메시지는 access control 건너뛰기
  if (ctx.from?.is_bot && ctx.message && "text" in ctx.message) {
    const text = (ctx.message as any).text || "";
    if (text.includes("[DELEGATE:") || text.includes("[TASK:")) {
      await next();
      return;
    }
  }

  if (approvedUsers.size === 0 && ALLOWED_USERS.length === 0) {
    await next();
    return;
  }
  if (approvedUsers.has(userId)) {
    await next();
    return;
  }

  // Pairing for DMs
  if (ctx.chat?.type === "private" && ctx.message?.text) {
    const code = generatePairingCode();
    pendingPairings.set(code, userId);
    console.log(`[Pairing] Code ${code} for user ${userId}`);
    await ctx.reply(
      `🔐 Pairing required.\n\nCode: <code>${code}</code>\n\nSend to bot owner.`,
      { parse_mode: "HTML" }
    );
    setTimeout(() => pendingPairings.delete(code), 600_000);
    return;
  }
});

// --- Commands ---
bot.command("start", async (ctx) => {
  await ctx.reply(
    `🤖 Claude Telegram Bot\n\n` +
      `Model: ${process.env.CLAUDE_MODEL || "claude-opus-4-6"}\n` +
      `Your ID: ${ctx.from?.id}\n\n` +
      `/new — New conversation\n` +
      `/clear — 세션 + 메모 모두 초기화\n` +
      `/note <텍스트> — 사용자 영구 메모 (매 턴 자동 주입)\n` +
      `/plan — 진행 중인 계획 추출 표시\n` +
      `/checkpoint — 현재 대화 핵심을 영구 저장\n` +
      `/working [clear] — 봇 자체 작업 메모리(active.md) 표시/비우기\n` +
      `/archive <이름> — 현재 작업을 명시적 archive로 이동\n` +
      `/model — Current model\n` +
      `/stats — Session stats\n` +
      `/pair <code> — Approve user`
  );
});

bot.command("new", async (ctx) => {
  clearSession(ctx.chat.id.toString());
  await ctx.reply("🔄 New conversation started.");
});

// /clear — /new alias + chat notes도 함께 삭제
bot.command("clear", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  clearSession(chatId);
  clearChatNotes(chatId);
  await ctx.reply("🧹 대화 초기화: 세션 + 사용자 메모 모두 삭제됨.");
});

// /note <text> — 사용자 명시 메모 영구 저장 (매 턴 system prompt에 주입됨)
bot.command("note", async (ctx) => {
  const text = ctx.match?.trim();
  if (!text) {
    const existing = loadChatNotes(ctx.chat.id.toString());
    const preview = existing
      ? `현재 메모:\n\n${existing.slice(-1500)}`
      : "(저장된 메모 없음)";
    await ctx.reply(
      `사용법: /note <기억할 내용>\n예: /note Phase 3+4 다음 작업으로 진행 합의됨\n\n${preview}`
    );
    return;
  }
  const chatId = ctx.chat.id.toString();
  appendChatNote(chatId, text);
  const shown = text.length > 80 ? text.slice(0, 80) + "..." : text;
  await ctx.reply(`📌 메모 저장됨: ${shown}\n\n(매 턴 시스템 프롬프트에 자동 주입됩니다.)`);
});

// /plan — 현재 대화의 진행 중인 계획만 추출해 표시 (read-only)
bot.command("plan", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  await ctx.reply("📋 현재 대화의 진행 계획 추출 중...");
  try {
    const summary = await getCurrentPlan(chatId);
    await ctx.reply(summary || "진행 중인 계획을 찾지 못했습니다. /note로 직접 저장하세요.");
  } catch (e: any) {
    await ctx.reply(`⚠️ 추출 실패: ${e.message}`);
  }
});

// /working — 현재 Working Memory(active.md) 표시 + sub-action(clear)
bot.command("working", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const arg = ctx.match?.trim() || "";
  if (arg === "clear" || arg.startsWith("clear ")) {
    const name = arg.replace(/^clear\s*/, "").trim() || undefined;
    const archived = archiveActiveWorking(chatId, name);
    if (archived) {
      await ctx.reply(`🗂 Active Working Memory 아카이브 후 비움:\n${archived}`);
    } else {
      clearActiveWorking(chatId);
      await ctx.reply("🧹 Active Working Memory 비움 (아카이브 대상 없음).");
    }
    return;
  }
  const active = loadActiveWorking(chatId);
  if (!active) {
    await ctx.reply(
      "📂 Active Working Memory 비어있음.\n\n" +
      "봇이 작업하면서 자동으로 채워집니다 (LLM이 <working-memory> 태그로 self-update).\n" +
      "사용자 명시 메모는 /note 사용."
    );
    return;
  }
  const preview = active.length > 3500 ? active.slice(0, 3500) + "\n\n... (총 " + active.length + "자, /working clear로 비우기)" : active;
  await ctx.reply(`🎯 ACTIVE WORKING MEMORY\n\n${preview}`);
});

// /archive <name> — 명시적으로 active.md를 archive로 이동(비움)
bot.command("archive", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const name = ctx.match?.trim() || "";
  if (!name) {
    await ctx.reply("사용법: /archive <이름>\n예: /archive 노무사_라벨링\n\n현재 active.md를 archive/<날짜>_<이름>.md로 이동 후 active를 비웁니다.");
    return;
  }
  const archived = archiveActiveWorking(chatId, name);
  if (archived) {
    await ctx.reply(`📦 아카이브 완료: ${archived}\n\n새 작업을 시작하세요. (이전 작업은 .lemonclaw/working/${chatId}/archive/에 영구 보관)`);
  } else {
    await ctx.reply("⚠️ active.md가 비어있어 아카이브할 내용이 없습니다.");
  }
});

// /checkpoint — 현재 대화 핵심을 자동 요약해 영구 메모(/note 슬롯)에 저장
bot.command("checkpoint", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  await ctx.reply("💾 현재 대화 핵심을 요약해 영구 저장 중...");
  try {
    const summary = await saveCheckpoint(chatId);
    if (summary) {
      const preview = summary.length > 800 ? summary.slice(0, 800) + "..." : summary;
      await ctx.reply(`✅ 저장됨 (chat-notes에 영구 보존, 매 턴 자동 주입):\n\n${preview}`);
    } else {
      await ctx.reply("⚠️ 저장할 내용이 없거나 요약에 실패했습니다 (transcript가 비어있을 수 있음).");
    }
  } catch (e: any) {
    await ctx.reply(`⚠️ 체크포인트 실패: ${e.message}`);
  }
});

bot.command("model", async (ctx) => {
  await ctx.reply(`Model: ${process.env.CLAUDE_MODEL || "claude-opus-4-6"}`);
});

bot.command("stats", async (ctx) => {
  await ctx.reply(`Active sessions: ${getSessionStats().active}`);
});

// --- Orchestrator Commands (Lead bot only) ---
bot.command("orchestrate", async (ctx) => {
  if (BOT_ROLE !== "lead") {
    await ctx.reply("⚠️ 이 봇은 워커입니다. 리드 봇에서 /orchestrate를 사용하세요.");
    return;
  }
  const taskDescription = ctx.match?.trim();
  if (!taskDescription) {
    await ctx.reply("사용법: /orchestrate <작업 설명>\n예: /orchestrate 전문가 상담 기능에 파일 첨부 추가");
    return;
  }

  const chatId = ctx.chat.id.toString();
  await ctx.reply("🔄 작업을 서브태스크로 분해 중...");

  try {
    // Step 1: Plan
    const task = await planTask(taskDescription, chatId);
    const statusMsg = formatTaskStatus(task);
    await ctx.reply(`📋 작업 계획 완료:\n\n${statusMsg}\n\n진행하려면 "승인", 취소하려면 "취소"를 입력하세요.`);

    // Store task ID for approval
    pendingOrchestrations.set(chatId, task.id);
  } catch (e: any) {
    await ctx.reply(`❌ 분해 실패: ${e.message}`);
  }
});

bot.command("affinity", async (ctx) => {
  await ctx.reply(formatAffinityReport());
});

bot.command("workers", async (ctx) => {
  const workers = getWorkerBots();
  if (!workers.length) {
    await ctx.reply("등록된 워커 봇이 없습니다. .env의 WORKER_BOTS를 설정하세요.");
    return;
  }
  const lines = workers.map(w =>
    `${w.status === "idle" ? "🟢" : "🔴"} ${w.name} (@${w.username}) — ${w.repos.join(", ")}`
  );
  await ctx.reply(`🤖 워커 봇 목록:\n\n${lines.join("\n")}`);
});

// --- Worker Code Sync ---
bot.command("sync", async (ctx) => {
  if (BOT_ROLE !== "lead") {
    await ctx.reply("⚠️ /sync는 리드봇에서만 실행 가능합니다.");
    return;
  }
  const arg = ctx.match?.trim() || "";
  const parts = arg.split(/\s+/).filter(Boolean);
  const workers = getWorkerBots();
  const workerNames = new Set(workers.map(w => w.name));

  // 2026-05-10: 인자 파싱 — 등록된 워커 이름이면 워커, 아니면 branch.
  //   호성님 사고 (`/sync a4500` → branch="a4500" 으로 17개 워커에 잘못된 checkout 시도) 차단.
  let branch = "feat/orchestrator";
  let targetWorker = "";
  for (const p of parts) {
    if (workerNames.has(p)) {
      targetWorker = p;
    } else {
      branch = p;
    }
  }

  const targets = targetWorker
    ? workers.filter(w => w.name === targetWorker)
    : workers;

  if (!targets.length) {
    await ctx.reply(targetWorker ? `워커 '${targetWorker}' 없음` : "등록된 워커가 없습니다.");
    return;
  }

  const RESTART_SECRET = process.env.RESTART_SECRET || "lemonclaw-restart-2024";
  const syncCmd = `cd /home/angrylawyer/claude-telegram-bot && git fetch origin && git checkout ${branch} && git pull origin ${branch} && bun install --frozen-lockfile 2>/dev/null; echo PULL_OK`;

  await ctx.reply(`🔄 ${targets.length}개 워커에 <code>${branch}</code> 동기화 시작...`, { parse_mode: "HTML" });

  const results = await Promise.allSettled(
    targets.map(async (w) => {
      // Step 1: git pull
      const pullResp = await fetch(`${w.apiUrl}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: RESTART_SECRET, command: syncCmd, timeout: 60000 }),
        signal: AbortSignal.timeout(70_000),
      });
      const pullData = await pullResp.json() as any;
      if (!pullData.stdout?.includes("PULL_OK")) {
        return { name: w.name, ok: false, msg: pullData.stderr?.slice(-300) || pullData.stdout?.slice(-300) || "git pull failed" };
      }
      // Step 2: restart via /restart (responds first, then exits after 1s)
      try {
        await fetch(`${w.apiUrl}/restart`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret: RESTART_SECRET, reason: `sync: ${branch}` }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {}
      return { name: w.name, ok: true, msg: pullData.stdout?.slice(-300) || "synced" };
    })
  );

  const lines = results.map((r, i) => {
    if (r.status === "rejected") return `❌ ${targets[i]?.name}: ${r.reason?.message || "fetch 실패"}`;
    const d = r.value;
    const icon = d.ok ? "✅" : "❌";
    return `${icon} <b>${d.name}</b>\n<code>${escapeHtml(d.msg.slice(-200))}</code>`;
  });

  await ctx.reply(`📦 동기화 결과 (<code>${branch}</code>):\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
});

// --- Ralph Loop Commands (Phase R0.4 — plan 승인 gate + stop/cancel) ---
function ralphIcon(status: string): string {
  return status === "completed" ? "✅"
    : status === "running" ? "🔄"
    : status === "failed" ? "❌"
    : status === "stopped" ? "⏹"
    : status === "pending" ? "⏸"
    : "❓";
}

bot.command("ralph", async (ctx) => {
  const arg = ctx.match?.trim();
  const chatId = ctx.chat.id.toString();
  const sendTg: (targetChatId: string, msg: string) => Promise<void> = async (targetChatId, msg) => {
    try {
      for (const chunk of splitMessage(msg)) {
        await bot.api.sendMessage(parseInt(targetChatId) || ctx.chat.id, chunk, { parse_mode: "HTML" });
      }
    } catch (e: any) {
      console.error(`[Ralph] sendTg error: ${e.message}`);
    }
  };

  if (!arg) {
    const tasks = listTasks(5);
    if (!tasks.length) {
      await ctx.reply(
        "📋 Ralph 태스크 없음\n\n사용법:\n" +
        "  /ralph <지시>            — 계획 수립 후 승인 대기\n" +
        "  /ralph! <지시>           — 즉시 실행 (승인 생략)\n" +
        "  /ralph go <id>           — 승인 후 시작\n" +
        "  /ralph stop <id>         — 실행 중단\n" +
        "  /ralph cancel <id>       — pending plan 폐기\n" +
        "  /ralph status <id>       — 상세 상태\n" +
        "  /ralph list              — 최근 태스크"
      );
      return;
    }
    const lines = tasks.map(t => `${ralphIcon(t.status)} #${t.taskId}: ${t.originalPrompt.slice(0, 60)}`);
    await ctx.reply(`📋 최근 Ralph 태스크:\n\n${lines.join("\n")}`);
    return;
  }

  if (arg.startsWith("status ")) {
    const taskId = arg.slice(7).trim();
    await ctx.reply(formatRalphStatus(taskId));
    return;
  }

  if (arg === "list") {
    const tasks = listTasks(10);
    if (!tasks.length) { await ctx.reply("태스크 없음"); return; }
    const lines = tasks.map(t => {
      const elapsed = Math.round(((t.completedAt || Date.now()) - t.createdAt) / 1000);
      return `${ralphIcon(t.status)} #${t.taskId} (${elapsed}s) — ${t.originalPrompt.slice(0, 50)}`;
    });
    await ctx.reply(`📋 Ralph 태스크 목록:\n\n${lines.join("\n")}`);
    return;
  }

  // /ralph go <taskId>  — pending plan 승인 후 시작
  if (arg.startsWith("go ")) {
    const taskId = arg.slice(3).trim();
    const r = approveAndStart(taskId, askClaude, sendTg);
    await ctx.reply(r.ok ? `✅ ${r.message}\n<code>/ralph status ${taskId}</code>` : `❌ ${r.message}`, { parse_mode: "HTML" });
    return;
  }

  // /ralph stop <taskId>  — 실행 중인 task 중단 (다음 iteration 끝에 종료)
  if (arg.startsWith("stop ")) {
    const taskId = arg.slice(5).trim();
    const r = stopTask(taskId);
    await ctx.reply(r.ok ? `⏹ ${r.message}` : `❌ ${r.message}`);
    return;
  }

  // /ralph cancel <taskId>  — pending plan 폐기
  if (arg.startsWith("cancel ")) {
    const taskId = arg.slice(7).trim();
    const r = cancelPendingTask(taskId);
    await ctx.reply(r.ok ? `🗑 ${r.message}` : `❌ ${r.message}`);
    return;
  }

  // 새 Ralph 태스크 — plan 승인 gate 활성 (호성님 "설계 → 승인 → 구현" 원칙)
  await ctx.reply("🔍 목표 분해 및 계획 수립 중...");
  try {
    const result = await startRalphTask({
      originalPrompt: arg,
      requestedBy: chatId,
      askClaude,
      sendTg,
      autoStart: false, // ← Phase R0.4: 승인 대기
    });
    if (result.authError) {
      await ctx.reply(`🔐 <b>Claude CLI 인증 만료</b>\n\n${escapeHtml(result.authError)}`, { parse_mode: "HTML" });
      return;
    }
    await ctx.reply(
      `📋 <b>Ralph #${result.taskId} 계획 수립 완료</b>\n\n` +
      `${escapeHtml(result.planText)}\n\n` +
      `▶️ 시작: <code>/ralph go ${result.taskId}</code>\n` +
      `🗑 취소: <code>/ralph cancel ${result.taskId}</code>\n` +
      `📊 상세: <code>/ralph status ${result.taskId}</code>`,
      { parse_mode: "HTML" }
    );
  } catch (e: any) {
    await ctx.reply(`❌ Ralph 계획 수립 실패: ${escapeHtml(e.message)}`, { parse_mode: "HTML" });
  }
});

// /ralph! <지시>  — 즉시 실행 (legacy 호환, 승인 단계 생략)
bot.command("ralph_now", async (ctx) => {
  const arg = ctx.match?.trim();
  if (!arg) { await ctx.reply("사용법: /ralph_now <지시>"); return; }
  const chatId = ctx.chat.id.toString();
  const sendTg = async (targetChatId: string, msg: string) => {
    try {
      for (const chunk of splitMessage(msg)) {
        await bot.api.sendMessage(parseInt(targetChatId) || ctx.chat.id, chunk, { parse_mode: "HTML" });
      }
    } catch (e: any) {
      console.error(`[Ralph] sendTg error: ${e.message}`);
    }
  };

  await ctx.reply("🔍 목표 분해 및 즉시 실행...");
  try {
    const result = await startRalphTask({
      originalPrompt: arg,
      requestedBy: chatId,
      askClaude,
      sendTg,
      autoStart: true,
    });
    if (result.authError) {
      await ctx.reply(`🔐 <b>Claude CLI 인증 만료</b>\n\n${escapeHtml(result.authError)}`, { parse_mode: "HTML" });
      return;
    }
    await ctx.reply(
      `✅ <b>Ralph #${result.taskId} 시작</b>\n\n` +
      `📋 <b>계획:</b>\n${escapeHtml(result.planText)}\n\n` +
      `백그라운드 실행 중 — 완료 시 자동 알림.\n` +
      `<code>/ralph status ${result.taskId}</code>`,
      { parse_mode: "HTML" }
    );
  } catch (e: any) {
    await ctx.reply(`❌ Ralph 시작 실패: ${escapeHtml(e.message)}`, { parse_mode: "HTML" });
  }
});

// Pending orchestration approvals
const pendingOrchestrations = new Map<string, string>();

bot.command("pair", async (ctx) => {
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(ctx.from?.id!))
    return;
  const code = ctx.match?.trim().toUpperCase();
  if (!code) {
    await ctx.reply("Usage: /pair <CODE>");
    return;
  }
  const targetUserId = pendingPairings.get(code);
  if (!targetUserId) {
    await ctx.reply("Invalid or expired code.");
    return;
  }
  approvedUsers.add(targetUserId);
  pendingPairings.delete(code);
  await ctx.reply(`✅ User ${targetUserId} approved.`);
});

// --- Approval callback handler ---
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;

  // 위임 작업 승인/거절 먼저 체크
  if (data.startsWith("delegate_approve:") || data.startsWith("delegate_reject:")) {
    await handleDelegateApprovalCallback(data, ctx);
    return;
  }

  const isApprove = data.startsWith("approve:");
  const isReject = data.startsWith("reject:");

  if (!isApprove && !isReject) return;

  const approvalId = data.split(":")[1] ?? "";
  const pending = pendingApprovals.get(approvalId);

  if (!pending) {
    await ctx.answerCallbackQuery({ text: "Expired or already handled." });
    return;
  }

  const { chatId, request } = pending;
  pendingApprovals.delete(approvalId);

  const emoji = getApprovalEmoji(request.type);
  const label = getApprovalLabel(request.type);

  if (isApprove) {
    // Update button message (HTML mode, LemonClaw style)
    try {
      await ctx.editMessageText(
        `${emoji} <b>${label}</b> ✅ 승인됨\n\n<pre><code>${escapeHtmlForApproval(request.content)}</code></pre>`,
        { parse_mode: "HTML" }
      );
    } catch {
      try {
        await ctx.editMessageText(
          `${emoji} ${label} ✅ 승인됨\n\n${request.content}`
        );
      } catch {}
    }
    await ctx.answerCallbackQuery({ text: "✅ 승인됨" });

    console.log(`[Approval] APPROVED id=${approvalId} chat=${chatId}`);

    // Send approval to Claude and get execution result
    await ctx.replyWithChatAction("typing");
    const typingInterval = setInterval(async () => {
      try {
        await ctx.replyWithChatAction("typing");
      } catch {}
    }, 4000);

    try {
      const response = await askClaudeWithProgress(chatId, "승인합니다. 진행해주세요.");
      clearInterval(typingInterval);

      // Check if there's another approval needed
      const nextApproval = detectApprovalRequest(response);
      if (nextApproval) {
        await sendApprovalRequest(ctx, chatId, nextApproval, response);
      } else {
        await sendResponse(ctx, response, chatId);
      }
    } catch (error: any) {
      clearInterval(typingInterval);
      await ctx.reply(`⚠️ ${error.message}`);
    }
  } else {
    // Rejected
    try {
      await ctx.editMessageText(
        `${emoji} <b>${label}</b> ❌ 거절됨\n\n<pre><code>${escapeHtmlForApproval(request.content)}</code></pre>`,
        { parse_mode: "HTML" }
      );
    } catch {
      try {
        await ctx.editMessageText(
          `${emoji} ${label} ❌ 거절됨\n\n${request.content}`
        );
      } catch {}
    }
    await ctx.answerCallbackQuery({ text: "❌ 거절됨" });

    console.log(`[Approval] REJECTED id=${approvalId} chat=${chatId}`);

    // Tell Claude it was rejected
    try {
      const response = await askClaude(
        chatId,
        "거절합니다. 실행하지 마세요."
      );
      await sendResponse(ctx, response, chatId);
    } catch {}
  }
});

// --- Helpers ---
async function downloadTelegramFile(
  fileId: string,
  extension: string
): Promise<string> {
  const file = await bot.api.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(fileUrl);
  const buffer = Buffer.from(await response.arrayBuffer());
  const dir = await mkdtemp(join(tmpdir(), "claude-tg-"));
  const filePath = join(dir, `file.${extension}`);
  await writeFile(filePath, buffer, { mode: 0o600 });
  return filePath;
}

async function cleanupFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {}
}

// Escape HTML for approval card content (inside <pre><code>)
function escapeHtmlForApproval(text: string): string {
  return escapeHtml(text);
}

function isBotMentioned(text: string, botUsername: string): boolean {
  if (text.includes(`@${botUsername}`)) return true;
  for (const pattern of GROUP_MENTION_PATTERNS) {
    if (text.includes(pattern)) return true;
  }
  return false;
}

// HUD: context usage bar
function formatHud(chatId: string): string | null {
  const hud = getHudInfo(chatId);
  if (!hud || hud.inputTokens === 0) return null;

  const pct = hud.contextPercent;
  const filled = Math.round(pct / 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  const color = pct < 50 ? "🟢" : pct < 80 ? "🟡" : "🔴";

  const tokensK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(0)}K` : `${n}`;
  const duration = hud.durationSec > 0
    ? (hud.durationSec >= 60 ? `${Math.floor(hud.durationSec / 60)}m${hud.durationSec % 60}s` : `${hud.durationSec}s`)
    : "";

  const parts = [
    `${color} Context: ${bar} ${pct}% (${tokensK(hud.inputTokens)}/200K)`,
  ];
  const meta: string[] = [];
  if (hud.turnNumber > 0) meta.push(`🔄 Turn ${hud.turnNumber}`);
  if (duration) meta.push(`⏱ ${duration}`);
  if (hud.cacheRead > 0) meta.push(`📦 Cache ${tokensK(hud.cacheRead)}`);
  if (meta.length > 0) parts.push(meta.join(" | "));

  return parts.join("\n");
}

// LemonClaw style: send response as HTML with auto-chunking, fallback to plain text
async function sendResponse(ctx: any, text: string, chatId?: string): Promise<void> {
  // [SEND_FILE: /path/to/file] 태그 감지 → 파일 전송
  const FILE_TAG_RE = /\[SEND_FILE:\s*([^\]]+)\]/g;
  const filePaths: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = FILE_TAG_RE.exec(text)) !== null) {
    if (match[1]) filePaths.push(match[1].trim());
  }
  // 태그 제거 후 텍스트 정리
  text = text.replace(/\[SEND_FILE:[^\]]+\]/g, "").trim();

  // Chunk raw markdown first, then convert each chunk to HTML
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    const html = markdownToTelegramHtml(chunk);
    try {
      await ctx.reply(html, { parse_mode: "HTML" });
    } catch {
      // Fallback: plain text (no formatting)
      await ctx.reply(chunk);
    }
  }

  // 파일 전송
  for (const filePath of filePaths) {
    try {
      const { createReadStream, existsSync } = await import("fs");
      if (!existsSync(filePath)) {
        await ctx.reply(`⚠️ 파일 없음: ${filePath}`);
        continue;
      }
      const fileName = filePath.split("/").pop() || "file";
      await ctx.replyWithDocument({ source: createReadStream(filePath), filename: fileName });
    } catch (e: any) {
      await ctx.reply(`⚠️ 파일 전송 실패: ${e.message}`);
    }
  }

  // HUD footer (after last chunk) + 빌드 정보
  if (chatId) {
    const hudText = formatHud(chatId);
    const buildText = formatBuildInfo();
    const footer = [hudText, buildText].filter(Boolean).join("\n\n");
    if (footer) {
      try {
        await ctx.reply(`<code>${escapeHtml(footer)}</code>`, { parse_mode: "HTML" });
      } catch {
        try { await ctx.reply(footer); } catch {}
      }
    }
  }
}

// --- LemonClaw ack reaction helpers ---
async function addAckReaction(ctx: any): Promise<boolean> {
  try {
    await ctx.react("👀");
    return true;
  } catch {
    return false;
  }
}

async function removeAckReaction(ctx: any): Promise<void> {
  try {
    // Remove reaction by setting empty array
    await bot.api.setMessageReaction(ctx.chat.id, ctx.message.message_id, []);
  } catch {}
}

// --- Core message handler with real-time progress ---
async function handleMessage(
  ctx: any,
  chatId: string,
  text: string,
  attachments?: string[]
): Promise<void> {
  // "계속" 메시지 감지 → 중단된 컨텍스트 복원
  const CONTINUE_PATTERNS = /^(계속|continue|이어서|이어가|진행|go on)\s*\.?$/i;
  if (CONTINUE_PATTERNS.test(text.trim())) {
    const savedContext = loadInterruptedContext(chatId);
    if (savedContext) {
      text = `이전 작업이 중단되었습니다. 아래 컨텍스트를 참고하여 이어서 진행해주세요.\n\n${savedContext}\n\n---\n위 중단된 작업을 이어서 완료해주세요.`;
      console.log(`[Bot] Injected interrupted context for chat=${chatId}`);
    }
  }

  const didAck = await addAckReaction(ctx);

  await ctx.replyWithChatAction("typing");
  const typingInterval = setInterval(async () => {
    try { await ctx.replyWithChatAction("typing"); } catch {}
  }, 4000);

  // 진행 상황 메시지 (도구 사용 시 실시간 업데이트)
  let progressMsgId: number | null = null;
  let lastProgressText = "";
  let toolHistory: string[] = [];
  let progressThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  const PROGRESS_THROTTLE_MS = 3000; // 3초마다 최대 1번 업데이트
  const startTime = Date.now();

  const updateProgressMessage = async (newText: string) => {
    if (newText === lastProgressText) return;
    lastProgressText = newText;
    try {
      if (progressMsgId) {
        await bot.api.editMessageText(ctx.chat.id, progressMsgId, newText);
      } else {
        const msg = await ctx.reply(newText);
        progressMsgId = msg.message_id;
      }
    } catch {
      // edit 실패 시 무시 (동일 텍스트, 메시지 삭제됨 등)
    }
  };

  const TOOL_EMOJI: Record<string, string> = {
    Read: "📖", Write: "✍️", Edit: "✏️", Bash: "💻", Grep: "🔍",
    Glob: "📂", Agent: "🤖", TaskCreate: "📋", TaskUpdate: "✅",
    WebSearch: "🌐", WebFetch: "🌐",
  };

  const onProgress = (info: ProgressInfo) => {
    let shouldUpdate = false;

    if (info.type === "tool_use" && info.toolName) {
      const emoji = TOOL_EMOJI[info.toolName] || "🔧";
      const inputSnippet = info.toolInput ? `: ${info.toolInput.slice(0, 60)}` : "";
      toolHistory.push(`${emoji} ${info.toolName}${inputSnippet}`);
      shouldUpdate = true;
    } else if (info.type === "tool_result" && info.toolOutput) {
      const shortOutput = info.toolOutput.slice(0, 80).replace(/\n/g, " ").trim();
      if (shortOutput) {
        toolHistory.push(`  → ${shortOutput}`);
        shouldUpdate = true;
      }
    } else if (info.type === "text_chunk" && info.text) {
      const snippet = info.text.slice(0, 60).replace(/\n/g, " ").trim();
      if (snippet && !toolHistory.some(t => t.startsWith("💬"))) {
        toolHistory.push(`💬 "${snippet}..."`);
        shouldUpdate = true;
      }
    }

    if (!shouldUpdate) return;

    const recent = toolHistory.slice(-8);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const elapsedStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s` : `${elapsed}s`;
    const progressText = `⏳ Turn ${info.turnNumber} 진행 중 (${elapsedStr})\n${recent.join("\n")}`;

    if (!progressThrottleTimer) {
      progressThrottleTimer = setTimeout(() => {
        progressThrottleTimer = null;
        updateProgressMessage(progressText);
      }, PROGRESS_THROTTLE_MS);
    }
  };

  try {
    const response = await askClaudeWithProgress(chatId, text, attachments, onProgress);
    clearInterval(typingInterval);
    if (progressThrottleTimer) clearTimeout(progressThrottleTimer);

    // 진행 상황 메시지 삭제
    if (progressMsgId) {
      try { await bot.api.deleteMessage(ctx.chat.id, progressMsgId); } catch {}
    }

    if (didAck) await removeAckReaction(ctx);

    // LemonClaw: 대화 기록을 메모리에 로깅
    appendMemoryLog(`User[${chatId}]: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);
    appendMemoryLog(`Bot[${chatId}]: ${response.slice(0, 100)}${response.length > 100 ? "..." : ""}`);

    // Shared memory: 코드 변경/빌드/배포 등 의미있는 작업만 기록
    if (toolHistory.length > 0 && /(?:Edit|Write|Bash)/.test(toolHistory.join(" "))) {
      const botUsername = ctx.me?.username || "unknown";
      const summary = `${text.slice(0, 80)} → ${response.slice(0, 120)}`;
      appendSharedMemory(botUsername, summary);
    }

    const approval = detectApprovalRequest(response);
    if (approval) {
      await sendApprovalRequest(ctx, chatId, approval, response);
    } else {
      await sendResponse(ctx, response, chatId);
    }
  } catch (error: any) {
    clearInterval(typingInterval);
    if (progressThrottleTimer) clearTimeout(progressThrottleTimer);
    if (progressMsgId) {
      try { await bot.api.deleteMessage(ctx.chat.id, progressMsgId); } catch {}
    }
    if (didAck) await removeAckReaction(ctx);
    console.error(`[Bot] Error chat=${chatId}:`, error.message);
    const reason = error.failoverReason;
    const hints: Record<string, string> = {
      rate_limit: "\n💡 API 사용량 한도에 도달했습니다. 잠시 후 다시 시도해주세요.",
      overloaded: "\n💡 서버가 혼잡합니다. 잠시 후 다시 시도해주세요.",
      auth: "\n💡 API 인증에 문제가 있습니다. 관리자에게 문의하세요.",
      billing: "\n💡 API 결제 문제가 발생했습니다. 관리자에게 문의하세요.",
    };
    await ctx.reply(`⚠️ ${error.message}${hints[reason] || ""}`);
  }
}

// Send approval request with inline buttons
async function sendApprovalRequest(
  ctx: any,
  chatId: string,
  approval: ApprovalRequest,
  fullResponse: string
): Promise<void> {
  const approvalId = Math.random().toString(36).substring(2, 10);
  pendingApprovals.set(approvalId, { chatId, request: approval });

  // Auto-expire after 10 minutes
  setTimeout(() => pendingApprovals.delete(approvalId), 600_000);

  const emoji = getApprovalEmoji(approval.type);
  const label = getApprovalLabel(approval.type);

  // Send the text before the marker
  const beforeMarker = (fullResponse.split(`[${approval.type.toUpperCase()}_START]`)[0] ?? "").trim();
  if (beforeMarker) {
    await sendResponse(ctx, beforeMarker);
  }

  // Send approval card with buttons
  const keyboard = new InlineKeyboard()
    .text("✅ 승인 (Approve)", `approve:${approvalId}`)
    .text("❌ 거절 (Reject)", `reject:${approvalId}`);

  const approvalMsg =
    `${emoji} <b>${label} - 승인 필요</b>\n\n` +
    `<pre><code>${escapeHtmlForApproval(approval.content)}</code></pre>`;

  try {
    await ctx.reply(approvalMsg, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  } catch {
    await ctx.reply(
      `${emoji} ${label} - 승인 필요\n\n${approval.content}`,
      { reply_markup: keyboard }
    );
  }

  console.log(
    `[Approval] ${approval.type} request id=${approvalId} chat=${chatId}`
  );
}

// --- Message handlers ---
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  if (!text || text.startsWith("/")) return;

  const chatId = ctx.chat.id.toString();
  console.log(`[MSG] role=${BOT_ROLE} chat=${chatId} len=${text.length}`);

  // Group: only respond when mentioned (use cached bot info)
  if (ctx.chat.type !== "private") {
    if (!isBotMentioned(text, ctx.me.username)) return;
  }

  // === Orchestrator: 승인/취소 처리 (Lead) ===
  if (BOT_ROLE === "lead") {
    const pendingTaskId = pendingOrchestrations.get(chatId);
    if (pendingTaskId && /^(승인|확인|진행|approve|yes)$/i.test(text.trim())) {
      pendingOrchestrations.delete(chatId);
      const { getTask } = await import("./orchestrator");
      const task = getTask(pendingTaskId);
      if (task) {
        await ctx.reply("📨 워커 봇에 HTTP 전송 중...");
        await dispatchTask(task);
        await ctx.reply(formatTaskStatus(task));
        return;
      }
    }
    if (pendingTaskId && /^(취소|cancel|no)$/i.test(text.trim())) {
      pendingOrchestrations.delete(chatId);
      await ctx.reply("❌ 작업이 취소되었습니다.");
      return;
    }

    // === Lead: 워커 완료 보고 수신 ===
    const report = handleWorkerReport(text);
    if (report) {
      if (report.allDone) {
        await ctx.reply(`🎉 모든 서브태스크 완료! 머지 시작...\n\n${formatTaskStatus(report.task)}`);
        const sendTg = async (cid: string, msg: string) => {
          try { await bot.api.sendMessage(parseInt(cid), msg); } catch {}
        };
        try {
          await mergeCompletedTask(report.task, askClaude, sendTg);
        } catch (e: any) {
          await ctx.reply(`❌ 머지 실패: ${e.message}`);
        }
      } else {
        await ctx.reply(formatTaskStatus(report.task));
      }
      return;
    }
  }

  // === Worker: 위임 메시지 감지 [DELEGATE:chatId] ===
  if (BOT_ROLE === "worker") {
    const delegated = detectDelegateMessage(text);
    if (delegated) {
      const botName = ctx.me?.username || "worker";
      // 포럼 그룹에 수신 확인
      await ctx.reply(`📥 작업 수신. 처리 중...`);

      try {
        // 실제 작업 실행 (일반 handleMessage와 동일)
        const response = await askClaudeWithProgress(chatId, delegated.message);

        // 요청자(사용자)에게 직접 DM으로 결과 전송
        const header = `🤖 @${botName} 작업 완료:\n\n`;
        const chunks = splitMessage(header + response);
        for (const chunk of chunks) {
          const html = markdownToTelegramHtml(chunk);
          try {
            await bot.api.sendMessage(parseInt(delegated.requestedBy), html, { parse_mode: "HTML" });
          } catch {
            try { await bot.api.sendMessage(parseInt(delegated.requestedBy), chunk); } catch {}
          }
        }

        // HUD 정보도 전송
        const hudText = formatHud(chatId);
        if (hudText) {
          try {
            await bot.api.sendMessage(parseInt(delegated.requestedBy),
              `<code>${escapeHtml(hudText)}</code>`, { parse_mode: "HTML" });
          } catch {}
        }
      } catch (e: any) {
        // 에러도 요청자에게 직접 전송
        try {
          await bot.api.sendMessage(parseInt(delegated.requestedBy),
            `⚠️ @${botName} 작업 실패: ${e.message}`);
        } catch {}
      }
      return;
    }

    // === Worker: 오케스트레이션 태스크 메시지 감지 ===
    const detectedTask = detectTaskMessage(text);
    if (detectedTask) {
      await ctx.reply(`📥 태스크 수신: ${detectedTask.description.slice(0, 80)}\n브랜치: ${detectedTask.branch}\n작업 시작...`);
      const sendTg = async (cid: string, msg: string) => {
        try { await bot.api.sendMessage(parseInt(cid), msg); } catch {}
      };
      try {
        await executeWorkerTask(detectedTask, askClaude, sendTg);
      } catch (e: any) {
        await ctx.reply(`❌ 태스크 실패: ${e.message}`);
      }
      return;
    }
  }

  // === Lead: "직접 처리" 키워드 감지 → 로컬 처리 ===
  const FORCE_LOCAL_RE = /(?:직접\s*처리|직접\s*해줘|개발서버(?:가|에서)\s*처리|로컬에서|여기서\s*처리|네가\s*직접)/;

  if (BOT_ROLE === "lead" && FORCE_LOCAL_RE.test(text)) {
    const cleanedText = text.replace(FORCE_LOCAL_RE, "").trim();
    await ctx.reply("🖥️ 리드 봇이 직접 처리합니다.");
    await handleMessage(ctx, chatId, cleanedText || text);
    return;
  }

  // === Lead: 일반 메시지를 워커에 HTTP로 자동 위임 ===

  if (BOT_ROLE === "lead") {
    const result = await quickDelegate(text, chatId);
    if (result) {
      await ctx.reply(`📨 @${result.workerName} 에 작업 전송 완료\n💬 "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);
    } else {
      await ctx.reply("⚠️ 모든 워커가 작업 중입니다. 잠시 후 다시 시도해주세요.");
    }
    return; // 리드는 절대 직접 작업 안 함
  }

  await handleMessage(ctx, chatId, text);
});

// ── Media group (앨범) 버퍼: 같은 media_group_id 사진들을 모아서 한번에 처리 ──
const mediaGroupBuffer = new Map<string, {
  chatId: string;
  ctx: any;
  caption: string;
  photos: { file_id: string }[];
  timer: ReturnType<typeof setTimeout>;
}>();
const MEDIA_GROUP_DEBOUNCE_MS = 800;

async function flushMediaGroup(groupId: string): Promise<void> {
  const group = mediaGroupBuffer.get(groupId);
  if (!group) return;
  mediaGroupBuffer.delete(groupId);

  const { chatId, ctx, caption, photos } = group;
  const tmpPaths: string[] = [];
  for (const p of photos) {
    tmpPaths.push(await downloadTelegramFile(p.file_id, "jpg"));
  }

  if (BOT_ROLE === "lead") {
    const atts = await Promise.all(tmpPaths.map(async (tp, i) => {
      const fileData = await readFile(tp);
      return { file_id: photos[i]!.file_id, type: "photo" as const, data: fileData.toString("base64") };
    }));
    const result = await quickDelegate(caption, chatId, atts);
    if (result) {
      await ctx.reply(`📨 @${result.workerName} 에 작업 전송 완료\n💬 "${caption.slice(0, 80)}${caption.length > 80 ? "..." : ""}" + 📷 이미지 ${photos.length}장`);
    } else {
      await ctx.reply("⚠️ 모든 워커가 작업 중입니다. 잠시 후 다시 시도해주세요.");
    }
    for (const tp of tmpPaths) setTimeout(() => cleanupFile(tp), 120_000);
    return;
  }

  await handleMessage(ctx, chatId, caption, tmpPaths);
  for (const tp of tmpPaths) setTimeout(() => cleanupFile(tp), 120_000);
}

bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const caption = ctx.message.caption || "이 이미지를 분석해줘";
  const photos = ctx.message.photo;
  const photo = photos[photos.length - 1];
  if (!photo) return;

  const mgId = ctx.message.media_group_id;

  // 앨범(media_group)이면 버퍼에 모아서 일괄 처리
  if (mgId) {
    const existing = mediaGroupBuffer.get(mgId);
    if (existing) {
      existing.photos.push({ file_id: photo.file_id });
      if (ctx.message.caption) existing.caption = ctx.message.caption;
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => flushMediaGroup(mgId), MEDIA_GROUP_DEBOUNCE_MS);
    } else {
      mediaGroupBuffer.set(mgId, {
        chatId,
        ctx,
        caption,
        photos: [{ file_id: photo.file_id }],
        timer: setTimeout(() => flushMediaGroup(mgId), MEDIA_GROUP_DEBOUNCE_MS),
      });
    }
    return;
  }

  // 단일 사진
  const tmpPath = await downloadTelegramFile(photo.file_id, "jpg");

  if (BOT_ROLE === "lead") {
    const fileData = await readFile(tmpPath);
    const result = await quickDelegate(caption, chatId, [{ file_id: photo.file_id, type: "photo", data: fileData.toString("base64") }]);
    if (result) {
      await ctx.reply(`📨 @${result.workerName} 에 작업 전송 완료\n💬 "${caption.slice(0, 80)}${caption.length > 80 ? "..." : ""}" + 📷 이미지`);
    } else {
      await ctx.reply("⚠️ 모든 워커가 작업 중입니다. 잠시 후 다시 시도해주세요.");
    }
    setTimeout(() => cleanupFile(tmpPath), 120_000);
    return;
  }

  await handleMessage(ctx, chatId, caption, [tmpPath]);
  setTimeout(() => cleanupFile(tmpPath), 120_000);
});

bot.on("message:document", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const doc = ctx.message.document;
  const caption = ctx.message.caption || `이 파일을 분석해줘: ${doc.file_name}`;
  const ext = doc.file_name?.split(".").pop() || "txt";
  const tmpPath = await downloadTelegramFile(doc.file_id, ext);

  // Lead: 첨부파일 포함 메시지도 워커에 위임 (base64로 파일 데이터 직접 전달)
  if (BOT_ROLE === "lead") {
    const fileData = await readFile(tmpPath);
    const result = await quickDelegate(caption, chatId, [{ file_id: doc.file_id, type: "document", filename: doc.file_name, data: fileData.toString("base64") }]);
    if (result) {
      await ctx.reply(`📨 @${result.workerName} 에 작업 전송 완료\n💬 "${caption.slice(0, 80)}${caption.length > 80 ? "..." : ""}" + 📎 ${doc.file_name}`);
    } else {
      await ctx.reply("⚠️ 모든 워커가 작업 중입니다. 잠시 후 다시 시도해주세요.");
    }
    setTimeout(() => cleanupFile(tmpPath), 120_000);
    return;
  }

  await handleMessage(ctx, chatId, caption, [tmpPath]);
  setTimeout(() => cleanupFile(tmpPath), 120_000);
});

bot.on("message:voice", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const tmpPath = await downloadTelegramFile(
    ctx.message.voice.file_id,
    "ogg"
  );
  await handleMessage(ctx, chatId, "이 음성 메시지를 분석해줘", [tmpPath]);
  setTimeout(() => cleanupFile(tmpPath), 120_000);
});

// --- Error handler: 분류 + 자세한 진단 (Phase R7.1) ---
//   호성님 사고 패턴 분석:
//   - 'You're out of extra usage' → Claude Code 정액제 한도 (재시작 X — task 측 R6.1 처리)
//   - 'EFATAL/polling stopped/network error/ETELEGRAM' → polling 회복 불가, process 재시작이 빠름
//   - 그 외 → log only (봇 재시작 안 함, polling 재시도)
bot.catch(async (err) => {
  const msg = err.message || String(err);
  console.error("[Bot] Unhandled error:", msg.slice(0, 500));

  // Claude 사용량 한도 — 봇 자체는 살아있게, ralph 측 R6.1 이 task halt
  // 패턴 확장 (R11.4): "You've hit your limit · resets May 10, 1pm (UTC)" 같은 장기 한도 포함
  if (/out\s*of\s*(extra\s*)?usage|hit\s*your\s*(\w+\s*)?limit|usage\s*limit|rate\s*limit|too\s*many\s*requests|quota\s*(reached|exceeded)|credit\s*(exhausted|out)/i.test(msg)) {
    console.warn("[Bot] Claude usage limit detected in error path — keeping bot alive");
    return;
  }

  // Telegram polling fatal: process 재시작이 회복 가장 빠름 (launchd/systemd 가 자동 재시작)
  const fatal = ["EFATAL", "polling stopped", "network error", "ETELEGRAM", "EAI_AGAIN", "ECONNRESET"]
    .some((p) => msg.toLowerCase().includes(p.toLowerCase()));
  if (fatal) {
    console.error("[Bot] Fatal polling error → exiting for supervisor restart");
    try { await killActiveProcesses(); } catch {}
    process.exit(1);
  }
  // 그 외: 로그만 — bot.dispose/restart 안 함
});

// --- Phase R7.1: uncaught exception / unhandled rejection 진단 로깅 ---
// 봇이 graceful shutdown 없이 죽는 path 를 명시적으로 잡음. fatal exit (1) 을 supervisor 가 재시작.
process.on("uncaughtException", (err) => {
  console.error(`[Bot] uncaughtException: ${err.message}\n${err.stack?.split("\n").slice(0, 8).join("\n")}`);
  // 안전하게 종료 — supervisor 재시작
  process.exit(1);
});
process.on("unhandledRejection", (reason: any) => {
  const msg = reason?.message || String(reason);
  console.error(`[Bot] unhandledRejection: ${msg.slice(0, 500)}`);
  // Claude usage limit 은 task 측에서 처리 — process 죽이지 않음
  // 패턴 확장 (R11.4): "You've hit your limit · resets May 10..." 같은 장기 한도 포함
  if (/out\s*of\s*(extra\s*)?usage|hit\s*your\s*(\w+\s*)?limit|usage\s*limit|rate\s*limit|quota\s*(reached|exceeded)|credit\s*(exhausted|out)/i.test(msg)) {
    console.warn("[Bot] Claude usage limit in unhandledRejection — keeping alive");
    return;
  }
  // 다른 unhandledRejection 도 일단 keep alive (정상 동작 가능성) — 단 로그 남김
});

export { bot };
