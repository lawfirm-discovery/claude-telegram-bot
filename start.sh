#!/bin/bash
cd /home/angrylawyer/claude-telegram-bot
set -a
source .env
set +a
exec bun run index.ts
