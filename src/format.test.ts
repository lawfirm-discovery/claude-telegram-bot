import { test, expect, describe } from "bun:test";
import { escapeHtml, markdownToTelegramHtml, splitMessage } from "./format";

describe("escapeHtml", () => {
  test("escapes &, <, >", () => {
    expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });
  test("empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("markdownToTelegramHtml", () => {
  test("empty/null input", () => {
    expect(markdownToTelegramHtml("")).toBe("");
  });

  test("bold", () => {
    expect(markdownToTelegramHtml("**hello**")).toBe("<b>hello</b>");
  });

  test("italic", () => {
    expect(markdownToTelegramHtml("*hello*")).toBe("<i>hello</i>");
  });

  test("strikethrough", () => {
    expect(markdownToTelegramHtml("~~hello~~")).toBe("<s>hello</s>");
  });

  test("inline code preserves special chars", () => {
    const result = markdownToTelegramHtml("`a < b & c`");
    expect(result).toBe("<code>a &lt; b &amp; c</code>");
  });

  test("fenced code block", () => {
    const result = markdownToTelegramHtml("```ts\nconst x = 1;\n```");
    expect(result).toContain('<pre><code class="language-ts">');
    expect(result).toContain("const x = 1;");
    expect(result).toContain("</code></pre>");
  });

  test("link with & in URL is valid HTML", () => {
    const result = markdownToTelegramHtml("[click](http://example.com?a=1&b=2)");
    expect(result).toBe('<a href="http://example.com?a=1&amp;b=2">click</a>');
  });

  test("blockquote", () => {
    const result = markdownToTelegramHtml("> quoted text");
    expect(result).toBe("<blockquote>quoted text</blockquote>");
  });

  test("heading becomes bold with marker", () => {
    const result = markdownToTelegramHtml("# Title");
    expect(result).toContain("<b>");
    expect(result).toContain("Title");
  });

  test("task list checkbox", () => {
    const result = markdownToTelegramHtml("- [x] done\n- [ ] todo");
    expect(result).toContain("✅");
    expect(result).toContain("⬜");
  });

  test("unordered list", () => {
    const result = markdownToTelegramHtml("- item one\n- item two");
    expect(result).toContain("•");
  });

  test("special chars in regular text are escaped", () => {
    const result = markdownToTelegramHtml("a < b & c > d");
    expect(result).toBe("a &lt; b &amp; c &gt; d");
  });

  test("code block content is not double-escaped", () => {
    const result = markdownToTelegramHtml("```\na & b\n```");
    expect(result).toContain("a &amp; b");
    expect(result).not.toContain("&amp;amp;");
  });
});

describe("splitMessage", () => {
  test("short message returns single chunk", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });

  test("splits long message at boundary", () => {
    const long = "a".repeat(5000);
    const chunks = splitMessage(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("").length).toBe(5000);
  });

  test("prefers splitting at newline", () => {
    const msg = "x".repeat(2000) + "\n" + "y".repeat(2000) + "\n" + "z".repeat(500);
    const chunks = splitMessage(msg);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe("x".repeat(2000));
  });

  test("avoids splitting inside code block", () => {
    const pre = "a".repeat(3000);
    const code = "```\n" + "b".repeat(2000) + "\n```";
    const post = "c".repeat(100);
    const msg = pre + "\n" + code + "\n" + post;
    const chunks = splitMessage(msg);
    const codeBlockChunk = chunks.find((c) => c.includes("```"));
    if (codeBlockChunk) {
      const opens = (codeBlockChunk.match(/```/g) || []).length;
      expect(opens % 2).toBe(0);
    }
  });
});
