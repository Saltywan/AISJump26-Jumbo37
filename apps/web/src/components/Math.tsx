/* Render text and model answers that contain LaTeX.
 *
 * Uses bundled KaTeX and auto-render extension to synchronously and reliably
 * format formulas such as "$v_y = 0$", "$v$-$t$", and equations.
 */
import { useEffect, useRef } from "react";
import "katex/dist/katex.min.css";
import renderMathInElement from "katex/contrib/auto-render";
import { renderMarkdownWithMath } from "./markdown";

export function MathText({
  text,
  className,
  inline = false,
}: {
  text: string;
  className?: string;
  inline?: boolean;
}) {
  const ref = useRef<HTMLDivElement & HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!text) {
      el.innerHTML = "";
      return;
    }

    try {
      const html = renderMarkdownWithMath(text, inline);
      el.innerHTML = html;
      renderMathInElement(el, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
          { left: "\\[", right: "\\]", display: true },
        ],
        // A model answer is not a trusted template. Leave a command KaTeX
        // cannot parse as the literal text it already is rather than letting
        // it stop the whole render.
        throwOnError: false,
        ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
      });
    } catch {
      /* fallback plain text remains in element */
      el.textContent = text;
    }
  }, [text, inline]);

  const fullClassName = ["math-markdown", inline ? "math-inline" : "math-block", className]
    .filter(Boolean)
    .join(" ");

  if (inline) {
    return <span ref={ref} className={fullClassName} />;
  }
  return <div ref={ref} className={fullClassName} />;
}
