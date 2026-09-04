/* The generated page, as an artifact in the conversation.
 *
 * It used to be embedded: an iframe wedged into the chat column with the check
 * report beside it, so a chat message was half page and half report and neither
 * had room. On the student side the same shape put the animation and the tutor
 * conversation in two permanent columns. Both are the same mistake — a page
 * that wants the whole screen being asked to live inside a message.
 *
 * So the message is a card: one clickable object that says what was made and
 * what state it is in, sized like a message. Opening it hands the page the
 * entire viewport, with the actions that belong to it in the top right of that
 * view — which is where the decision about a page should be made, with the page
 * actually on screen.
 *
 * That is also why publishing lives here rather than under the card: the one
 * product rule this app has is that a teacher looks at the page before students
 * do (docs/BUILD-PLAN.html §04). A confirm button reachable without opening the
 * page is a button that gets pressed without opening the page.
 */
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import caretRightUrl from "../icons/caret-right.svg";
import angleSmallRightUrl from "../icons/angle-small-right.svg";

/* The mark on the card. Drawn rather than imported: none of the Figma icons
   mean "an animated solution", and a glyph that means something specific is
   worth twelve lines of SVG. A curve with its vertex called out is the most
   common thing these pages actually draw. */
function ArtifactGlyph() {
  return (
    <svg className="artifact-glyph" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M4 25 Q 16 1 28 25" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="16" cy="10" r="3" fill="currentColor" />
      <path d="M4 25 H28" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.45" />
    </svg>
  );
}

/** The card that stands in for the page inside the conversation. The whole
 *  thing is one button — a card that is only clickable in one corner reads as
 *  a panel with a link in it, not as an object. */
export function ArtifactCard({
  title,
  kicker,
  status,
  onOpen,
}: {
  title: string;
  /** What kind of thing this is, above the title. */
  kicker: string;
  /** State line under the title: icon + words. Optional. */
  status?: ReactNode;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="artifact-card" onClick={onOpen}>
      <span className="artifact-card-mark">
        <ArtifactGlyph />
      </span>
      <span className="artifact-card-body">
        <span className="artifact-card-kicker">{kicker}</span>
        <span className="artifact-card-title">{title}</span>
        {status ? <span className="artifact-card-status">{status}</span> : null}
      </span>
      <span className="artifact-card-open">
        <span>เปิด</span>
        <img src={angleSmallRightUrl} alt="" width={20} height={20} />
      </span>
    </button>
  );
}

/** The expanded view: the page at full size, with its own header.
 *
 * `actions` is a function of the load state because the controls that matter
 * here — publishing, above all — must not be usable until the page they decide
 * about is actually on screen.
 */
export function ArtifactViewer({
  title,
  subtitle,
  src,
  onClose,
  actions,
  aside,
  asideLabel,
  banner,
  flag,
}: {
  title: string;
  subtitle?: string;
  src: string;
  onClose: () => void;
  actions?: (state: { loaded: boolean }) => ReactNode;
  /** Panel alongside the page — the check report, on the teacher's side. */
  aside?: ReactNode;
  asideLabel?: string;
  /** Full-width strip under the header: the misread-photo warning. */
  banner?: ReactNode;
  /** A note pinned over the page — "go and check step 4". */
  flag?: ReactNode;
}) {
  const [loaded, setLoaded] = useState(false);
  const [replay, setReplay] = useState(0);
  const [asideOpen, setAsideOpen] = useState(() => window.innerWidth >= 1100);

  /* Escape closes, and the page behind must not scroll while this is over it. */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return createPortal(
    <div className="artifact-view" role="dialog" aria-modal="true" aria-label={title}>
      <header className="artifact-view-head">
        <button type="button" className="artifact-view-close" onClick={onClose} aria-label="ปิด">
          ✕
        </button>
        <div className="artifact-view-titles">
          <span className="artifact-view-title">{title}</span>
          {subtitle ? <span className="artifact-view-subtitle">{subtitle}</span> : null}
        </div>
        <div className="artifact-view-actions">
          <button type="button" className="gen-card-replay" onClick={() => setReplay((n) => n + 1)}>
            <img src={caretRightUrl} alt="" width={20} height={20} />
            <span>เล่นอีกครั้ง</span>
          </button>
          {aside ? (
            <button
              type="button"
              className={`gen-card-replay${asideOpen ? " gen-card-replay-on" : ""}`}
              onClick={() => setAsideOpen((v) => !v)}
              aria-expanded={asideOpen}
            >
              {asideLabel ?? "รายงานการตรวจ"}
            </button>
          ) : null}
          {actions?.({ loaded })}
        </div>
      </header>

      {banner}

      <div className={`artifact-view-body${aside && asideOpen ? " artifact-view-body-split" : ""}`}>
        <div className="artifact-view-stage">
          {!loaded && (
            <div className="gen-card-loading">
              <span className="spinner" /> กำลังโหลด…
            </div>
          )}
          {/* Model-written JavaScript, opaque origin: allow-scripts only, and
              deliberately no allow-same-origin — see docs/BUILD-PLAN.html and
              Viewer.tsx. Nothing here ever reaches into this frame. */}
          <iframe
            key={`${src}-${replay}`}
            className="gen-card-frame"
            src={src}
            title={title}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            onLoad={() => setLoaded(true)}
          />
          {flag ? <div className="gen-card-stage-flag">{flag}</div> : null}
        </div>
        {aside && asideOpen ? <div className="artifact-view-aside">{aside}</div> : null}
      </div>
    </div>,
    document.body
  );
}
