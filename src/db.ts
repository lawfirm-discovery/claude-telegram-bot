/**
 * DB Module — PostgreSQL 대화 기록 저장
 *
 * 리드봇에서만 실행. 워커는 Lead API를 통해 메시지를 보고.
 * Bun.sql 내장 PostgreSQL 드라이버 사용 (별도 의존성 없음).
 */

const DB_URL = process.env.LEMONCLAW_DB_URL || "postgres://lemonclaw:lemonclaw2024@127.0.0.1:5434/lemonclaw";

let db: ReturnType<typeof Bun.sql> | null = null;

function getDb() {
  if (!db) {
    db = Bun.sql(DB_URL);
  }
  return db;
}

export async function testConnection(): Promise<boolean> {
  try {
    const result = await getDb()`SELECT 1 AS ok`;
    return result[0]?.ok === 1;
  } catch (e: any) {
    console.error(`[DB] Connection failed: ${e.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// Messages
// ═══════════════════════════════════════════════════════════════

export interface SaveMessageParams {
  botName: string;
  botUsername?: string;
  chatId: string;
  userName?: string;
  direction: "inbound" | "outbound";
  messageText: string;
  attachments?: string[];
  telegramMessageId?: number;
  replyToMessageId?: number;
}

export async function saveMessage(params: SaveMessageParams): Promise<void> {
  try {
    await getDb()`
      INSERT INTO bot_messages (bot_name, bot_username, chat_id, user_name, direction, message_text, attachments, telegram_message_id, reply_to_message_id)
      VALUES (${params.botName}, ${params.botUsername || null}, ${params.chatId}, ${params.userName || null}, ${params.direction}, ${params.messageText}, ${JSON.stringify(params.attachments || [])}, ${params.telegramMessageId || null}, ${params.replyToMessageId || null})
    `;
  } catch (e: any) {
    console.error(`[DB] saveMessage failed: ${e.message}`);
  }
}

export interface MessageQuery {
  botName?: string;
  chatId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function getMessages(query: MessageQuery): Promise<{ messages: any[]; total: number }> {
  const limit = Math.min(query.limit || 50, 200);
  const offset = query.offset || 0;

  try {
    let where = "1=1";
    const params: any[] = [];
    let paramIdx = 1;

    if (query.botName) { where += ` AND bot_name = $${paramIdx++}`; params.push(query.botName); }
    if (query.chatId) { where += ` AND chat_id = $${paramIdx++}`; params.push(query.chatId); }
    if (query.search) { where += ` AND message_text ILIKE $${paramIdx++}`; params.push(`%${query.search}%`); }

    // Bun.sql은 tagged template만 지원하므로 raw query 방식 사용
    const messages = query.search
      ? await getDb()`SELECT * FROM bot_messages WHERE message_text ILIKE ${'%' + query.search + '%'} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
      : query.botName
        ? await getDb()`SELECT * FROM bot_messages WHERE bot_name = ${query.botName} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
        : await getDb()`SELECT * FROM bot_messages ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;

    const countResult = query.search
      ? await getDb()`SELECT COUNT(*)::int AS total FROM bot_messages WHERE message_text ILIKE ${'%' + query.search + '%'}`
      : query.botName
        ? await getDb()`SELECT COUNT(*)::int AS total FROM bot_messages WHERE bot_name = ${query.botName}`
        : await getDb()`SELECT COUNT(*)::int AS total FROM bot_messages`;

    return { messages: Array.from(messages), total: countResult[0]?.total || 0 };
  } catch (e: any) {
    console.error(`[DB] getMessages failed: ${e.message}`);
    return { messages: [], total: 0 };
  }
}

// ═══════════════════════════════════════════════════════════════
// Sessions
// ═══════════════════════════════════════════════════════════════

export interface SaveSessionParams {
  botName: string;
  chatId: string;
  sessionId?: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  totalCost: number;
  durationSec: number;
}

export async function saveSession(params: SaveSessionParams): Promise<void> {
  try {
    await getDb()`
      INSERT INTO bot_sessions (bot_name, chat_id, session_id, turns, input_tokens, output_tokens, cache_read, total_cost, duration_sec, status, ended_at)
      VALUES (${params.botName}, ${params.chatId}, ${params.sessionId || null}, ${params.turns}, ${params.inputTokens}, ${params.outputTokens}, ${params.cacheRead}, ${params.totalCost}, ${params.durationSec}, 'completed', NOW())
    `;
  } catch (e: any) {
    console.error(`[DB] saveSession failed: ${e.message}`);
  }
}

export async function getSessions(botName?: string, limit = 50): Promise<any[]> {
  try {
    const rows = botName
      ? await getDb()`SELECT * FROM bot_sessions WHERE bot_name = ${botName} ORDER BY started_at DESC LIMIT ${limit}`
      : await getDb()`SELECT * FROM bot_sessions ORDER BY started_at DESC LIMIT ${limit}`;
    return Array.from(rows);
  } catch (e: any) {
    console.error(`[DB] getSessions failed: ${e.message}`);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// Stats
// ═══════════════════════════════════════════════════════════════

export async function getStats(): Promise<any> {
  try {
    const msgCount = await getDb()`SELECT COUNT(*)::int AS total FROM bot_messages`;
    const sessionCount = await getDb()`SELECT COUNT(*)::int AS total FROM bot_sessions`;
    const costSum = await getDb()`SELECT COALESCE(SUM(total_cost), 0)::float AS total FROM bot_sessions`;
    const botStats = await getDb()`
      SELECT bot_name, COUNT(*)::int AS message_count, MAX(created_at) AS last_active
      FROM bot_messages GROUP BY bot_name ORDER BY last_active DESC
    `;
    return {
      totalMessages: msgCount[0]?.total || 0,
      totalSessions: sessionCount[0]?.total || 0,
      totalCost: costSum[0]?.total || 0,
      botStats: Array.from(botStats),
    };
  } catch (e: any) {
    console.error(`[DB] getStats failed: ${e.message}`);
    return { totalMessages: 0, totalSessions: 0, totalCost: 0, botStats: [] };
  }
}
