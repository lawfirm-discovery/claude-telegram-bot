/**
 * Telegram Message Throttler
 *
 * 같은 chat에 메시지가 폭주하면 429 (Too Many Requests).
 * Telegram 권장: 1 msg/sec/chat, 30 msg/sec total.
 *
 * 전략:
 *  - chat_id별 "진행 상황 메시지 1개"를 유지하고 edit_message_text로 갱신
 *  - 마지막 갱신으로부터 MIN_INTERVAL_MS 내 호출은 다음 tick까지 디바운스
 *  - IDLE_MS 이상 침묵 후 호출은 새 메시지로 시작 (사용자가 스크롤로 떠난 경우)
 *  - 4096자 초과 시 잘라내기 (Telegram 한계)
 *
 * 사용:
 *   const throttle = createThrottler(bot);
 *   await throttle.update(chatId, "진행 중: 파일 5개 수정...");
 *   await throttle.finalize(chatId);  // 다음 update는 새 메시지로 시작
 */

import type { Bot } from "grammy";

const MIN_INTERVAL_MS = parseInt(process.env.TELEGRAM_THROTTLE_MS || "1100");
const IDLE_MS = parseInt(process.env.TELEGRAM_IDLE_MS || "300000"); // 5분
const MAX_LEN = 4000; // 4096자 한계 + 마진

interface ChatState {
  messageId?: number;
  lastEditAt: number;
  lastText: string;
  pendingText?: string;
  pendingTimer?: ReturnType<typeof setTimeout>;
}

type AnyBot = Bot<any>;

export interface Throttler {
  update(chatId: number | string, text: string): Promise<void>;
  finalize(chatId: number | string): void;
  reset(chatId: number | string): void;
}

export function createThrottler(bot: AnyBot): Throttler {
  const states = new Map<string, ChatState>();

  async function flushNow(key: string): Promise<void> {
    const st = states.get(key);
    if (!st || !st.pendingText) return;
    const text = st.pendingText.slice(0, MAX_LEN);
    st.pendingText = undefined;
    st.pendingTimer = undefined;

    const now = Date.now();
    const idle = !st.messageId || now - st.lastEditAt > IDLE_MS;

    try {
      if (idle) {
        const sent = await bot.api.sendMessage(key, text);
        st.messageId = sent.message_id;
      } else if (text !== st.lastText) {
        await bot.api.editMessageText(key, st.messageId!, text);
      }
      st.lastText = text;
      st.lastEditAt = Date.now();
    } catch (e: any) {
      // edit 대상이 사라졌거나 동일 내용 -> 새 메시지로 fallback
      const msg = e?.message || "";
      const tooManyRequests = e?.error_code === 429;
      const messageNotModified = /message is not modified/i.test(msg);
      if (messageNotModified) {
        st.lastText = text;
        st.lastEditAt = Date.now();
        return;
      }
      if (tooManyRequests) {
        const retry = (e?.parameters?.retry_after ?? 1) * 1000;
        console.warn(`[throttle] 429 retry_after=${retry}ms chat=${key}`);
        await new Promise((r) => setTimeout(r, retry));
        // 재시도 1회
        try {
          if (st.messageId) {
            await bot.api.editMessageText(key, st.messageId, text);
            st.lastText = text;
            st.lastEditAt = Date.now();
            return;
          }
        } catch {}
      }
      // 그 외 실패: 새 메시지로 재시도
      try {
        const sent = await bot.api.sendMessage(key, text);
        st.messageId = sent.message_id;
        st.lastText = text;
        st.lastEditAt = Date.now();
      } catch (err: any) {
        console.error(`[throttle] both edit/send failed chat=${key}: ${err?.message}`);
      }
    }
  }

  function schedule(key: string, st: ChatState): void {
    if (st.pendingTimer) return; // 이미 예약됨
    const elapsed = Date.now() - st.lastEditAt;
    const wait = Math.max(0, MIN_INTERVAL_MS - elapsed);
    st.pendingTimer = setTimeout(() => flushNow(key).catch(() => {}), wait);
  }

  return {
    async update(chatId, text) {
      const key = String(chatId);
      let st = states.get(key);
      if (!st) {
        st = { lastEditAt: 0, lastText: "" };
        states.set(key, st);
      }
      st.pendingText = text;
      schedule(key, st);
    },
    finalize(chatId) {
      const key = String(chatId);
      const st = states.get(key);
      if (!st) return;
      // 마지막 보류 텍스트가 있으면 즉시 flush, 그 후 메시지를 새로 시작하도록 messageId 리셋
      if (st.pendingTimer) {
        clearTimeout(st.pendingTimer);
        st.pendingTimer = undefined;
      }
      if (st.pendingText) {
        flushNow(key).finally(() => {
          st.messageId = undefined;
          st.lastText = "";
        });
      } else {
        st.messageId = undefined;
        st.lastText = "";
      }
    },
    reset(chatId) {
      const key = String(chatId);
      const st = states.get(key);
      if (!st) return;
      if (st.pendingTimer) clearTimeout(st.pendingTimer);
      states.delete(key);
    },
  };
}
