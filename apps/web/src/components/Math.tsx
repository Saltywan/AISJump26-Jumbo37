/* Render a model answer that contains LaTeX.
 *
 * The tutor answers in the same notation the pages use — "$v_y = 0$",
 * "$v_y^2 = u_y^2 - 2gH$" — and until now those arrived on screen as raw
 * dollar-signs and backslashes, which is worse than useless to a student: it is
 * the notation they are trying to learn, printed as noise.
 *
 * KaTeX is not added as an npm dependency here. The pages origin already serves
 * the exact copy the generated pages themselves use (packages/kit/lib), so this
 * loads that one: the maths in a chat answer then renders identically to the
 * maths in the page it is describing, which is the point. It is fetched once
 * and cached on the module.
 *
 * If the pages origin is unreachable the text falls back to plain rendering —
 * the same thing it did before — rather than the component failing.
 */
import { useEffect, useRef } from "react";
import { PAGES_URL } from "../lib/api";

declare global {
  interface Window {
    katex?: unknown;
    renderMathInElement?: (el: HTMLElement, opts: unknown) => void;
  }
}

let loading: Promise<boolean> | null = null;

function loadKatex(): Promise<boolean> {
  if (window.renderMathInElement) return Promise.resolve(true);
  if (loading) return loading;

  loading = new Promise<boolean>((resolve) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `${PAGES_URL}/lib/katex.min.css`;
    document.head.appendChild(css);

    const core = document.createElement("script");
    core.src = `${PAGES_URL}/lib/katex.min.js`;
    core.onload = () => {
      const auto = document.createElement("script");
      auto.src = `${PAGES_URL}/lib/auto-render.min.js`;
      auto.onload = () => resolve(true);
      auto.onerror = () => resolve(false);
      document.head.appendChild(auto);
    };
    core.onerror = () => resolve(false);
    document.head.appendChild(core);
  });
  return loading;
}

export function MathText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    el.textContent = text;               // plain text first: correct even if KaTeX never loads
    void loadKatex().then((ok) => {
      if (cancelled || !ok || !ref.current || !window.renderMathInElement) return;
      try {
        window.renderMathInElement(ref.current, {
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
        /* the plain text set above is still on screen */
      }
    });
    return () => {
      cancelled = true;
    };
  }, [text]);

  return <div ref={ref} className={className} />;
}
