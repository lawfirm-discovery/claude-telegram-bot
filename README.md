# Claude Telegram Bot

OpenClaw-style Telegram bot powered by your Claude subscription. No API key needed — uses Claude Code CLI with your existing subscription auth (OAuth).

## Features

- Chat with Claude Opus/Sonnet directly from Telegram
- Conversation continuity via Claude session resume
- Photo & document attachment support
- Per-chat session management with auto-expiry
- Access control by Telegram user ID
- Long message auto-splitting

## Prerequisites

- [Bun](https://bun.sh) runtime
- [Claude Code CLI](https://claude.com/claude-code) installed and logged in (`claude login`)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Setup

1. **Clone and install**

```bash
git clone https://github.com/lawfirm-discovery/claude-telegram-bot.git
cd claude-telegram-bot
bun install
```

2. **Create a Telegram bot**

Open [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, and copy the token.

3. **Configure**

```bash
cp .env.example .env
```

Edit `.env`:

```env
TELEGRAM_BOT_TOKEN=your_bot_token
CLAUDE_PATH=/path/to/claude        # usually ~/.local/bin/claude
CLAUDE_MODEL=claude-opus-4-6       # or claude-sonnet-4-6
ALLOWED_USERS=                     # comma-separated Telegram user IDs (empty = allow all)
```

4. **Make sure Claude Code is logged in**

```bash
claude login
```

5. **Run**

```bash
bun run index.ts
```

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Show help & your user ID |
| `/new` | Start a new conversation |
| `/model` | Show current model |
| `/stats` | Active session count |

## How It Works

Instead of calling the Anthropic API directly (which requires an API key), this bot spawns `claude -p` as a subprocess. This reuses your Claude Code CLI subscription authentication (OAuth), so you can use your Pro/Max/Team/Enterprise plan directly.

Conversation continuity is maintained via `--resume <session_id>`, so each Telegram chat keeps its own Claude session context.

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | (required) | Telegram bot token |
| `CLAUDE_PATH` | `claude` | Path to Claude CLI binary |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Claude model to use |
| `ALLOWED_USERS` | (empty = all) | Comma-separated allowed Telegram user IDs |
| `MAX_HISTORY` | `20` | Max conversation turns kept in memory |
| `SESSION_TTL_MS` | `3600000` | Session timeout in ms (default: 1 hour) |

## Stock Monitor

실시간 주식 신호 모니터링 기능. 봇이 실행 중일 때 자동으로 돌아가며 텔레그램으로 알림을 보냅니다.

### 신호 유형

| 신호 | 타입 | 주기 | 설명 |
|------|------|------|------|
| 🟢 장중 매수 | 모멘텀 | 3분 | 전일 대비 5%↑ + 거래대금 100억↑ + 코스피 초과수익 |
| 🔴 주봉 매도 | 캔들 패턴 | 2시간 | 트랩/가속붕괴/윗꼬리 3종 패턴 (하승훈 매도 규칙) |
| 🟢🔵 WB 매수 | 볼린저밴드 | 4시간 | 더블BB 하단 재진입 또는 원비 추세 되돌림 |
| 🔴🟠 WB 매도 | 볼린저밴드 | 4시간 | 더블BB 상단 재진입 또는 원비 추세 되돌림 |

### WB 다차원 볼린저밴드 전략

논문 "볼린저밴드 다차원 변동성 결합 모델" 기반으로 구현.

**지표 구성**
- Band A (White BB): 22기간 종가 기준 SMA ± 2σ
- Band B (Red BB): 44기간 시가 기준 SMA ± 2σ

**매수 진입 조건**

| 전략 | 조건 |
|------|------|
| WB 변곡 매수 | 종가 < BB22하단 AND 저가 < BB44하단 (동시 이탈) → 현재봉 BB22 하단 재진입 |
| 원비 매수 | 22EMA 우상향 + 저가 < BB44하단 (단독 터치) → BB44 하단 재진입 |

**매도 진입 조건**

| 전략 | 조건 |
|------|------|
| WB 변곡 매도 | 종가 > BB22상단 AND 고가 > BB44상단 (동시 이탈) → 현재봉 BB22 상단 하향 재진입 |
| 원비 매도 | 22EMA 하향 + 고가 > BB44상단 (단독 터치) → BB44 상단 재진입 |

**필터 체인** (1개 이상 통과 시 신호 발생)

| 필터 | 조건 |
|------|------|
| 이격도 다이버전스 | 가격 저점↓ + 이격도 저점↑ (강세), 가격 고점↓ + 이격도 고점↑ (약세) |
| RSI 트리플 익스트림 | RSI 30이하(또는 70이상) 구간에서 3회 독립 저점/고점 형성 |
| 망치형 캔들 (매수만) | HLRange > 3×Body + 종가/시가 상단 60% 위치 |

**리스크 관리 공식**

```
손절가       = 진입가 - ATR(14) × 3
목표가(매수) = BB22 상단
목표가(매도) = BB22 하단
포지션 크기  = 총자본 × 1% ÷ (ATR × 3)
```

### 워치리스트 관리

`.lemonclaw/STOCK_WATCHLIST.md` 파일에 종목코드를 한 줄에 하나씩 작성합니다.

```
005930
000660
AAPL
```

### 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `STOCK_MIN_CHANGE_PCT` | `5` | 매수 신호 최소 상승률 (%) |
| `STOCK_MIN_TRADING_VALUE` | `100` | 최소 거래대금 (억원) |
| `STOCK_CHECK_INTERVAL_MS` | `180000` | 장중 매수 체크 주기 (ms) |
| `SELL_CHECK_INTERVAL_MS` | `7200000` | 주봉 매도 체크 주기 (ms) |
| `WB_CHECK_INTERVAL_MS` | `14400000` | WB 신호 체크 주기 (ms) |

## License

MIT
