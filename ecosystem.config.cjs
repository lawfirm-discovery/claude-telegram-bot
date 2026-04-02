module.exports = {
  apps: [
    {
      name: "claude-telegram-bot",
      script: "index.ts",
      interpreter: "bun",
      cwd: "C:\\Users\\lawbot\\claude-telegram-bot",
      autorestart: true,
      watch: false,
      max_restarts: 50,
      restart_delay: 5000,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: "500M",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "C:\\Users\\lawbot\\claude-telegram-bot\\logs\\error.log",
      out_file: "C:\\Users\\lawbot\\claude-telegram-bot\\logs\\out.log",
      merge_logs: true,
      env: {
        MAX_TURNS: "200",
        TIMEOUT_MS: "1200000",
      },
    },
  ],
};
