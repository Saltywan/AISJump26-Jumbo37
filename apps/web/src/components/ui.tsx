/* Primitives taken from the Figma file (Jumbo-37). Every screen in the design
   is built from this handful of parts, so they live here once rather than being
   re-derived per screen — which is how two screens end up with buttons that are
   nearly, but not quite, the same.
 *
 * The design's own component names are kept (Button, Input, Card, Tabs) so a
 * frame in Figma maps onto something with the same name here. */
import { forwardRef } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router-dom";

/* Button — three variants, all from the design:
   primary   Primary/500 fill, white SemiBold text   (สร้างห้องเรียน, Login)
   outline   white fill, Neutral/200 border          (ออกจากระบบ, cancel)
   quiet     no fill, no border                      (ดูบทเรียน ›, tab-like)
   Padding is spacing-lg/spacing-sm with a spacing-md gap, radius 10. */
type Variant = "primary" | "outline" | "quiet" | "danger";

export function Button({
  variant = "primary",
  icon,
  iconAfter,
  children,
  className = "",
  ...rest
}: {
  variant?: Variant;
  icon?: ReactNode;
  iconAfter?: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`ui-btn ui-btn-${variant} ${className}`} {...rest}>
      {icon}
      {children}
      {iconAfter}
    </button>
  );
}

/* Same shape as Button but navigates. The design uses this for the whole
   classroom card as well as for "ดูบทเรียน ›". */
export function ButtonLink({
  variant = "quiet",
  icon,
  iconAfter,
  to,
  children,
  className = "",
}: {
  variant?: Variant;
  icon?: ReactNode;
  iconAfter?: ReactNode;
  to: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Link className={`ui-btn ui-btn-${variant} ${className}`} to={to}>
      {icon}
      {children}
      {iconAfter}
    </Link>
  );
}

/* Input — a SemiBold 18px label above a bordered field. The label is part of
   the component in the design, not a separate thing screens assemble.
 *
 * forwardRef exists for one reason: a creation form's "focus the field with
 * the problem" after a failed validation, and the dialog's own "focus the
 * first field on open" (see components/Modal.tsx) — neither is reachable
 * from outside without a ref to the actual <input>. */
export const Input = forwardRef<
  HTMLInputElement,
  { label?: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>
>(function Input({ label, hint, className = "", ...rest }, ref) {
  return (
    <label className={`ui-field ${className}`}>
      {label ? <span className="ui-field-label">{label}</span> : null}
      <input ref={ref} className="ui-input" {...rest} />
      {hint ? <span className="ui-field-hint">{hint}</span> : null}
    </label>
  );
});

/* Select — same label-above-field shape as Input, and the same `ui-input`
   class, so a dropdown sitting next to a text field in a form doesn't look
   like it wandered in from a different design. Native <select> chrome is left
   alone (no Figma frame calls for a custom one), the same trade-off the rest
   of the app makes for controls it has no frame for. */
export function Select({
  label,
  hint,
  className = "",
  children,
  ...rest
}: {
  label?: string;
  hint?: string;
  children?: ReactNode;
} & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <label className={`ui-field ${className}`}>
      {label ? <span className="ui-field-label">{label}</span> : null}
      <select className="ui-input" {...rest}>
        {children}
      </select>
      {hint ? <span className="ui-field-hint">{hint}</span> : null}
    </label>
  );
}

export function Textarea({
  label,
  className = "",
  ...rest
}: { label?: string } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <label className={`ui-field ${className}`}>
      {label ? <span className="ui-field-label">{label}</span> : null}
      <textarea className="ui-input ui-textarea" {...rest} />
    </label>
  );
}

/* Card — white, Neutral/200 border, radius 15, 20px padding. In the design it
   is a row: a title block on the left and an action on the right. Give it `to`
   and the whole row becomes the link, which is how the classroom list works. */
export function Card({
  title,
  meta,
  action,
  to,
  children,
  className = "",
}: {
  title?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  to?: string;
  children?: ReactNode;
  className?: string;
}) {
  const inner = (
    <>
      {title || meta ? (
        <div className="ui-card-text">
          {title ? <span className="ui-card-title">{title}</span> : null}
          {meta ? <span className="ui-card-meta">{meta}</span> : null}
        </div>
      ) : null}
      {children}
      {action ? <div className="ui-card-action">{action}</div> : null}
    </>
  );
  return to ? (
    <Link className={`ui-card ui-card-link ${className}`} to={to}>
      {inner}
    </Link>
  ) : (
    <div className={`ui-card ${className}`}>{inner}</div>
  );
}

/* Tabs — บทเรียน / นักเรียน / การตั้งค่า. The active tab is marked by a
   Primary/500 underline; in the Figma the active frame is 1.5px taller than
   its siblings, which is that rule. */
export function Tabs({
  items,
}: {
  items: { key: string; label: string; to?: string; active?: boolean; onClick?: () => void }[];
}) {
  return (
    <div className="ui-tabs" role="tablist">
      {items.map((t) =>
        t.to ? (
          <Link
            key={t.key}
            className={`ui-tab ${t.active ? "ui-tab-active" : ""}`}
            to={t.to}
            role="tab"
            aria-selected={!!t.active}
          >
            {t.label}
          </Link>
        ) : (
          <button
            key={t.key}
            className={`ui-tab ${t.active ? "ui-tab-active" : ""}`}
            onClick={t.onClick}
            role="tab"
            aria-selected={!!t.active}
            type="button"
          >
            {t.label}
          </button>
        )
      )}
    </div>
  );
}

/* The greeting block at the top of every logged-in page: Heading 3 title,
   Body SM subtitle in Neutral/500, and an optional action pinned right. */
export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="ui-page-header">
      <div className="ui-page-header-text">
        <h1 className="ui-page-title">{title}</h1>
        {subtitle ? <p className="ui-page-subtitle">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="ui-section-title">{children}</h2>;
}

/* A small effort picker, shared by Generate.tsx and the tutor/revise panel in
   ProblemArtifact.tsx — one component so both read the same three labels and
   the same visual language, rather than two screens drifting on wording for
   the same underlying kit vocabulary (low/medium/high — see lib/api.ts's
   Effort type). `options` is which of the three this particular caller may
   offer: generation and revision both refuse "low" (see the API's own
   _validate_effort and its reasoning), a tutor question offers all three. No
   latency promise in the copy on purpose — that number isn't measured yet
   (see docs/BACKLOG.md), so the labels only ever claim depth, never speed. */
const EFFORT_LABEL: Record<string, string> = { low: "ปกติ", medium: "มาตรฐาน", high: "ละเอียด" };

export function EffortSelect({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string;
  onChange: (v: "low" | "medium" | "high") => void;
  options: readonly ("low" | "medium" | "high")[];
  disabled?: boolean;
}) {
  return (
    <div className="ui-effort" role="radiogroup" aria-label="ระดับความละเอียดของ AI">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          role="radio"
          aria-checked={value === opt}
          disabled={disabled}
          className={`ui-effort-opt${value === opt ? " ui-effort-opt-active" : ""}`}
          onClick={() => onChange(opt)}
        >
          {EFFORT_LABEL[opt]}
        </button>
      ))}
    </div>
  );
}

/* Difficulty picker for SimilarProblemModal.tsx — deliberately the same
   ui-effort* classes EffortSelect uses, not a parallel set: a second
   control that must stay pixel-identical to the first is exactly the kind
   of near-duplicate that quietly drifts. Not folded into EffortSelect
   itself, though — the two pick from different, independent vocabularies
   (see lib/api.ts's Effort vs Variation) and happen to share a look, which
   is a styling fact, not a reason to make one component do both jobs. */
const VARIATION_LABEL: Record<string, string> = { easier: "ง่ายกว่า", same: "เท่าเดิม", harder: "ยากกว่า" };

export function VariationSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: "easier" | "same" | "harder") => void;
  disabled?: boolean;
}) {
  return (
    <div className="ui-effort" role="radiogroup" aria-label="ระดับความยากของโจทย์ใหม่">
      {(["easier", "same", "harder"] as const).map((opt) => (
        <button
          key={opt}
          type="button"
          role="radio"
          aria-checked={value === opt}
          disabled={disabled}
          className={`ui-effort-opt${value === opt ? " ui-effort-opt-active" : ""}`}
          onClick={() => onChange(opt)}
        >
          {VARIATION_LABEL[opt]}
        </button>
      ))}
    </div>
  );
}
