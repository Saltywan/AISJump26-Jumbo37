/**
 * Lightweight, zero-dependency Markdown + LaTeX parser for AniLearn.
 *
 * Designed to safely convert Markdown into HTML while strictly shielding
 * LaTeX formulas ($...$, $$...$$, \(...\), \[...\]) and code blocks
 * from Markdown transformations.
 */

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeMathContent(str: string): string {
  // Only escape &, <, > so that the browser's DOM parser converts them
  // back into literal characters in the DOM text node for KaTeX.
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderMarkdownWithMath(rawText: string, inline: boolean = false): string {
  if (!rawText) return "";

  // 1. Normalize line endings and existing HTML breaks
  let text = rawText
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  // 2. Extract fenced code blocks: ```lang ... ```
  const codeBlocks: { lang: string; code: string }[] = [];
  text = text.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: lang || "", code: code || "" });
    return `\n\n@@BLOCK_CODE_${idx}@@\n\n`;
  });

  // 3. Protect escaped dollars \$
  text = text.replace(/\\\$/g, "@@ESCAPED_DOLLAR@@");

  // 4. Extract display math: $$...$$ or \[...\]
  const displayMath: string[] = [];
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_, math) => {
    const idx = displayMath.length;
    displayMath.push(math);
    return `\n\n@@MATH_DISPLAY_${idx}@@\n\n`;
  });
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => {
    const idx = displayMath.length;
    displayMath.push(math);
    return `\n\n@@MATH_DISPLAY_${idx}@@\n\n`;
  });

  // 5. Extract inline code: `...`
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(code);
    return `@@INLINE_CODE_${idx}@@`;
  });

  // 6. Extract inline math: $...$ or \(...\)
  const inlineMath: string[] = [];
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => {
    const idx = inlineMath.length;
    inlineMath.push(math);
    return `@@MATH_INLINE_${idx}@@`;
  });
  // Match inline dollar formulas: non-empty, not spanning blank lines
  text = text.replace(/\$([^\$\n]+?)\$/g, (_, math) => {
    const idx = inlineMath.length;
    inlineMath.push(math);
    return `@@MATH_INLINE_${idx}@@`;
  });

  // 7. Escape HTML in the remaining text
  text = escapeHtml(text);

  // Restore escaped dollars as entity *after* HTML escaping to avoid &amp;#36;
  text = text.replace(/@@ESCAPED_DOLLAR@@/g, "&#36;");

  // Helper: parse inline markdown elements
  const parseInline = (s: string): string => {
    let out = s;
    // Bold + Italic: ***text*** or ___text___
    out = out.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
    out = out.replace(/___(.+?)___/g, "<strong><em>$1</em></strong>");
    // Bold: **text** or __text__
    out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/__(.+?)__/g, "<strong>$1</strong>");
    // Italic: *text* or _text_
    out = out.replace(/\*([^\*\n]+?)\*/g, "<em>$1</em>");
    out = out.replace(/(^|[^a-zA-Z0-9])_([^_\n]+?)_(?=$|[^a-zA-Z0-9])/g, "$1<em>$2</em>");
    // Strikethrough: ~~text~~
    out = out.replace(/~~(.+?)~~/g, "<del>$1</del>");
    // Links: [label](url)
    out = out.replace(
      /\[([^\]]+)\]\(((?:https?:\/\/|\/|#)[^\s\)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    return out;
  };

  let rendered = "";

  if (inline) {
    rendered = parseInline(text.replace(/\n/g, " "));
  } else {
    // Block-level parsing
    const rawLines = text.split("\n");
    const outBlocks: string[] = [];
    let i = 0;
    const n = rawLines.length;

    while (i < n) {
      const line = rawLines[i];
      const stripped = line.trim();

      if (!stripped) {
        i++;
        continue;
      }

      // Code block placeholder
      const mCb = stripped.match(/^@@BLOCK_CODE_(\d+)@@$/);
      if (mCb) {
        const idx = parseInt(mCb[1], 10);
        const { lang, code } = codeBlocks[idx] || { lang: "", code: "" };
        const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
        outBlocks.push(`<pre><code${langAttr}>${escapeHtml(code)}</code></pre>`);
        i++;
        continue;
      }

      // Display math placeholder
      const mDm = stripped.match(/^@@MATH_DISPLAY_(\d+)@@$/);
      if (mDm) {
        const idx = parseInt(mDm[1], 10);
        outBlocks.push(`<div class="katex-display-block">@@MATH_DISPLAY_${idx}@@</div>`);
        i++;
        continue;
      }

      // Heading: # H1 to ###### H6
      const mH = stripped.match(/^(#{1,6})\s+(.+)$/);
      if (mH) {
        const lvl = mH[1].length;
        const content = parseInline(mH[2].trim());
        outBlocks.push(`<h${lvl}>${content}</h${lvl}>`);
        i++;
        continue;
      }

      // Horizontal rule: ---, ***, ___
      if (/^(?:---|\*\*\*|___)$/.test(stripped)) {
        outBlocks.push("<hr />");
        i++;
        continue;
      }

      // Blockquote: lines starting with &gt;
      if (stripped.startsWith("&gt;")) {
        const bqLines: string[] = [];
        while (
          i < n &&
          (rawLines[i].trim().startsWith("&gt;") ||
            (bqLines.length > 0 &&
              rawLines[i].trim() &&
              !/^(?:#{1,6}\s|[*+-]\s|\d+\.\s|@@BLOCK_CODE_|@@MATH_DISPLAY_|---|\*\*\*|___)/.test(rawLines[i].trim())))
        ) {
          const lStr = rawLines[i].trim();
          if (lStr.startsWith("&gt;")) {
            bqLines.push(lStr.replace(/^&gt;\s?/, ""));
          } else {
            bqLines.push(lStr);
          }
          i++;
        }
        const innerBlocks = bqLines.map((l) => parseInline(l)).join("<br />");
        outBlocks.push(`<blockquote><p>${innerBlocks}</p></blockquote>`);
        continue;
      }

      // Table: header line with pipes, followed by delimiter line
      if (stripped.includes("|") && i + 1 < n && /^\s*\|?[\s:\-|]+\|?\s*$/.test(rawLines[i + 1])) {
        const tableLines: string[] = [];
        while (i < n && rawLines[i].includes("|")) {
          tableLines.push(rawLines[i].trim());
          i++;
        }
        if (tableLines.length >= 2) {
          const parseRow = (rowStr: string): string[] => {
            const rawCells = rowStr.replace(/^\||\|$/g, "").split("|");
            return rawCells.map((c) => parseInline(c.trim()));
          };
          const headers = parseRow(tableLines[0]);
          const trHead = "<tr>" + headers.map((c) => `<th>${c}</th>`).join("") + "</tr>";
          const bodyRows: string[] = [];
          for (let r = 2; r < tableLines.length; r++) {
            const cells = parseRow(tableLines[r]);
            bodyRows.push("<tr>" + cells.map((c) => `<td>${c}</td>`).join("") + "</tr>");
          }
          outBlocks.push(`<table><thead>${trHead}</thead><tbody>${bodyRows.join("")}</tbody></table>`);
          continue;
        }
      }

      // List: ordered or unordered
      const isListStart = /^\s*(?:[*+-]|\d+\.)\s+/.test(rawLines[i]);
      if (isListStart) {
        const listLines: string[] = [];
        while (i < n) {
          const curr = rawLines[i];
          if (!curr.trim()) {
            if (
              i + 1 < n &&
              (/^\s*(?:[*+-]|\d+\.)\s+/.test(rawLines[i + 1]) ||
                (rawLines[i + 1].startsWith("  ") && rawLines[i + 1].trim()))
            ) {
              listLines.push("");
              i++;
              continue;
            } else {
              break;
            }
          }
          if (/^\s*(?:[*+-]|\d+\.)\s+/.test(curr) || (listLines.length > 0 && curr.startsWith("  "))) {
            listLines.push(curr);
            i++;
          } else {
            break;
          }
        }

        interface StackFrame {
          tag: "ul" | "ol";
          indent: number;
        }
        const stack: StackFrame[] = [];
        const htmlParts: string[] = [];

        for (const l of listLines) {
          if (!l.trim()) continue;
          const mItem = l.match(/^(\s*)([*+-]|\d+\.)\s+(.+)$/);
          if (mItem) {
            const indent = mItem[1].length;
            const marker = mItem[2];
            const itemBody = parseInline(mItem[3]);
            const tag: "ul" | "ol" = marker.endsWith(".") ? "ol" : "ul";

            while (stack.length > 0 && stack[stack.length - 1].indent > indent) {
              const top = stack.pop()!;
              htmlParts.push(`</li></${top.tag}>`);
            }

            if (stack.length === 0 || stack[stack.length - 1].indent < indent) {
              stack.push({ tag, indent });
              htmlParts.push(`<${tag}><li>${itemBody}`);
            } else if (stack[stack.length - 1].tag !== tag) {
              const top = stack.pop()!;
              htmlParts.push(`</li></${top.tag}><${tag}><li>${itemBody}`);
              stack.push({ tag, indent });
            } else {
              htmlParts.push(`</li><li>${itemBody}`);
            }
          } else {
            htmlParts.push(`<br />${parseInline(l.trim())}`);
          }
        }

        while (stack.length > 0) {
          const top = stack.pop()!;
          htmlParts.push(`</li></${top.tag}>`);
        }

        outBlocks.push(htmlParts.join(""));
        continue;
      }

      // Paragraph: collect contiguous lines until blank line or special block
      const pLines: string[] = [];
      while (i < n) {
        const curr = rawLines[i];
        const currStripped = curr.trim();
        if (!currStripped) break;
        if (/^(?:#{1,6}\s|[*+-]\s|\d+\.\s|&gt;|@@BLOCK_CODE_|@@MATH_DISPLAY_|---|\*\*\*|___)/.test(currStripped)) {
          break;
        }
        pLines.push(parseInline(currStripped));
        i++;
      }

      if (pLines.length > 0) {
        outBlocks.push(`<p>${pLines.join("<br />")}</p>`);
      }
    }

    rendered = outBlocks.join("");
  }

  // 8. Restore placeholders in reverse order of extraction to support nesting
  // Inline math
  for (let idx = 0; idx < inlineMath.length; idx++) {
    const math = inlineMath[idx];
    rendered = rendered.split(`@@MATH_INLINE_${idx}@@`).join(`$${escapeMathContent(math)}$`);
  }

  // Inline code
  for (let idx = 0; idx < inlineCodes.length; idx++) {
    const code = inlineCodes[idx];
    rendered = rendered.split(`@@INLINE_CODE_${idx}@@`).join(`<code>${escapeHtml(code)}</code>`);
  }

  // Display math
  for (let idx = 0; idx < displayMath.length; idx++) {
    const math = displayMath[idx];
    rendered = rendered.split(`@@MATH_DISPLAY_${idx}@@`).join(`$$${escapeMathContent(math)}$$`);
  }

  // Fenced code blocks
  for (let idx = 0; idx < codeBlocks.length; idx++) {
    const { lang, code } = codeBlocks[idx];
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    rendered = rendered.split(`@@BLOCK_CODE_${idx}@@`).join(`<pre><code${langAttr}>${escapeHtml(code)}</code></pre>`);
  }

  return rendered;
}
