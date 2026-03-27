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

## License

MIT
