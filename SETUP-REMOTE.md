# 원격 서버 Bun 텔레그램 봇 설치 가이드

> 기존 Python 봇(`claude-code-telegram-richard`)을 제거하고
> Bun 봇(`claude-telegram-bot`)으로 교체하는 절차

---

## 서버별 정보

| 서버 | SSH | 봇 Username | 토큰 |
|------|-----|-------------|------|
| A4500 | `ssh -p 2223 angrylawyer@182.227.106.181` | @a4500_claude_style_bot | (BotFather에서 발급) |
| 3060 | `ssh -p 2225 angrylawyer@100.66.165.128` | @b3060_claude_style_bot | (BotFather에서 발급) |

---

## 1단계: 기존 Python 봇 제거

```bash
# 프로세스 종료
pkill -f "python -m src.main" 2>/dev/null
sudo systemctl stop claude-telegram-bot* 2>/dev/null
sudo systemctl disable claude-telegram-bot* 2>/dev/null

# 기존 디렉토리 백업 후 삭제
mv ~/claude-code-telegram-a4500 ~/claude-code-telegram-a4500.bak 2>/dev/null
mv ~/claude-code-telegram-3060 ~/claude-code-telegram-3060.bak 2>/dev/null
mv ~/claude-code-telegram-richard ~/claude-code-telegram-richard.bak 2>/dev/null

# Python venv 정리 (선택)
rm -rf ~/.cache/pypoetry/virtualenvs/claude-code-telegram-* 2>/dev/null
```

---

## 2단계: Bun 설치 (없는 경우)

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun --version  # 확인
```

---

## 3단계: 레포 클론 & 의존성 설치

```bash
cd ~
git clone https://github.com/lawfirm-discovery/claude-telegram-bot.git
cd ~/claude-telegram-bot
bun install
```

---

## 4단계: .env 설정

```bash
cp .env.example .env
nano .env
```

### A4500 .env

```env
TELEGRAM_BOT_TOKEN=your_a4500_bot_token_here
ALLOWED_USERS=62649819
CLAUDE_PATH=/home/angrylawyer/.local/bin/claude
CLAUDE_MODEL=claude-opus-4-6
TIMEOUT_MS=1200000
SESSION_TTL_MS=3600000
MAX_TURNS=0
DEBOUNCE_MS=1500
SYSTEM_PROMPT=
GROUP_MENTION_PATTERNS=대답해
```

### 3060 .env

```env
TELEGRAM_BOT_TOKEN=your_3060_bot_token_here
ALLOWED_USERS=62649819
CLAUDE_PATH=/home/angrylawyer/.local/bin/claude
CLAUDE_MODEL=claude-opus-4-6
TIMEOUT_MS=1200000
SESSION_TTL_MS=3600000
MAX_TURNS=0
DEBOUNCE_MS=1500
SYSTEM_PROMPT=
GROUP_MENTION_PATTERNS=대답해
```

---

## 5단계: systemd 서비스 등록

```bash
sudo tee /etc/systemd/system/claude-telegram-bot.service > /dev/null << 'EOF'
[Unit]
Description=Claude Code Telegram Bot (Custom Bun)
After=network.target

[Service]
Type=simple
User=angrylawyer
WorkingDirectory=/home/angrylawyer/claude-telegram-bot
ExecStart=/home/angrylawyer/.bun/bin/bun run index.ts
Restart=on-failure
RestartSec=10
Environment=HOME=/home/angrylawyer
Environment=PATH=/home/angrylawyer/.bun/bin:/home/angrylawyer/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable claude-telegram-bot
sudo systemctl start claude-telegram-bot
```

---

## 6단계: 확인

```bash
sudo systemctl status claude-telegram-bot
# Active: active (running) 확인

# 로그
sudo journalctl -u claude-telegram-bot -f --no-pager -n 20
```

---

## 업데이트 (이후)

```bash
cd ~/claude-telegram-bot && git pull && bun install
sudo systemctl restart claude-telegram-bot
```

---

## 타임아웃 설정 요약

| 항목 | 값 | 설명 |
|------|-----|------|
| `TIMEOUT_MS` | 1200000 | 전체 타임아웃 20분 |
| no-output (fresh) | min 300s, max 900s | 새 세션: 5~15분 무응답 허용 |
| no-output (resume) | min 180s, max 600s | 이어하기: 3~10분 무응답 허용 |
| `SESSION_TTL_MS` | 3600000 | 세션 1시간 유지 |
| `MAX_TURNS` | 0 | 턴 제한 없음 (CLI 기본값) |

---

## 전제 조건

- Claude Code CLI 설치됨 (`~/.local/bin/claude`)
- Claude 인증 완료 (`claude auth login` 또는 `~/.claude/.credentials.json` 복사)
- Bun 설치됨 (`~/.bun/bin/bun`)
