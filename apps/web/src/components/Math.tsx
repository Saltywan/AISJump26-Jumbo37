/* Render text and model answers that contain LaTeX.
 *
 * Uses bundled KaTeX and auto-render extension to synchronously and reliably
 * format formulas such as "$v_y = 0$", "$v$-$t$", and equations.
 */
import { useEffect, useRef } from "react";
import "katex/dist/katex.min.css";
import renderMathInElement from "katex/contrib/auto-render";

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
    const normalized = text.replace(/<br\s*\/?>/gi, "\n");
    el.textContent = normalized;
    try {
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
    }
  }, [text]);

  if (inline) {
    return <span ref={ref} className={className} />;
  }
  return <div ref={ref} className={className} />;
}
