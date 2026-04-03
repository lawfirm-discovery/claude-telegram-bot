// LemonClaw-style markdown → Telegram HTML conversion
// Telegram HTML supports: <b>, <i>, <s>, <u>, <code>, <pre>, <a>, <blockquote>, <tg-spoiler>

const TELEGRAM_TEXT_CHUNK_LIMIT = 4000;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert markdown text to Telegram HTML.
 * Handles: code blocks, inline code, bold, italic, strikethrough, links, blockquotes.
 * Order matters — code blocks/inline code are extracted first to prevent inner formatting.
 */
export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown) return "";

  // Placeholder system to protect code blocks from formatting passes
  const placeholders: string[] = [];
  const ph = (content: string): string => {
    const idx = placeholders.length;
    placeholders.push(content);
    return `\x00PH${idx}\x00`;
  };

  let html = markdown;

  // 1. Fenced code blocks: ```lang\n...\n``` (also handle ``` without newline after lang)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const escaped = escapeHtml(code.replace(/\n$/, ""));
    return ph(
      lang
        ? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`
        : `<pre><code>${escaped}</code></pre>`
    );
  });

  // 2. Inline code: `...`
  html = html.replace(/`([^`\n]+)`/g, (_m, code) => {
    return ph(`<code>${escapeHtml(code)}</code>`);
  });

  // 3. Escape remaining HTML entities
  html = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // 4. Bold: **text** or __text__
  html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  html = html.replace(/__(.+?)__/g, "<b>$1</b>");

  // 5. Italic: *text* or _text_ (not inside words with underscores)
  html = html.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, "<i>$1</i>");
  html = html.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, "<i>$1</i>");

  // 6. Strikethrough: ~~text~~
  html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 7. Links: [text](url)
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2">$1</a>'
  );

  // 8. Blockquotes: > text (at line start)
  html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");
  // Merge adjacent blockquotes
  html = html.replace(/<\/blockquote>\n<blockquote>/g, "\n");

  // 9. Restore placeholders
  html = html.replace(/\x00PH(\d+)\x00/g, (_m, idx) => placeholders[parseInt(idx)] ?? "");

  return html;
}

/**
 * Split text into chunks respecting Telegram's message size limit.
 * LemonClaw uses 4000 characters (not 4096) for safety margin.
 */
export function splitMessage(text: string, maxLength = TELEGRAM_TEXT_CHUNK_LIMIT): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // 코드 블록 내부에서 자르지 않도록: maxLength 범위 내 마지막 완전한 코드 블록 경계 찾기
    let i = maxLength;
    const candidate = remaining.substring(0, maxLength);

    // 열린 ``` 가 닫히지 않았는지 확인
    const backtickMatches = candidate.match(/```/g);
    const unclosed = backtickMatches && backtickMatches.length % 2 !== 0;

    if (unclosed) {
      // 마지막 열린 ``` 앞에서 자르기
      const lastOpen = candidate.lastIndexOf("```");
      if (lastOpen > maxLength / 4) {
        i = lastOpen;
      }
    } else {
      // Try to split at double newline (paragraph), then newline, then space
      let found = remaining.lastIndexOf("\n\n", maxLength);
      if (found < maxLength / 2) found = remaining.lastIndexOf("\n", maxLength);
      if (found < maxLength / 2) found = remaining.lastIndexOf(" ", maxLength);
      if (found >= maxLength / 4) i = found;
    }

    chunks.push(remaining.substring(0, i));
    remaining = remaining.substring(i).trimStart();
  }
  return chunks;
}
