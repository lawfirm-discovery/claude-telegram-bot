Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\lawbot\Documents\GitHub\claude-telegram-bot"
WshShell.Run "cmd /c set PATH=%PATH%;C:\Users\lawbot\.bun\bin && bun run index.ts > bot.log 2>&1", 0, False
