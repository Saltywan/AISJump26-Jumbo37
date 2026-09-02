// Turns a raw checker row (checks.ts, straight from the checker) into the
// worst-first flag list the review screen is built around. See docs/BUILD-PLAN.html
// section 04: every signal here was chosen because a teacher can look at it
// and know what to check for in the page — the ordering is severity, worst
// first, matching the table in that section.
//
// Deliberately NOT included: `moved`/`far` per-step attribution, because
// checks.json carries them only as page-level totals (no step number) — there
// is nothing to link to. They still surface, just without a "go to step" chip.
import type { CheckRow } from "../checks";

export type Severity = "critical" | "warning" | "info" | "clean";

export interface FlagItem {
  /** Step to jump to inside the page, if this flag is tied to one. */
  step?: number;
  text: string;
}

export interface Flag {
  key: string;
  label: string;
  severity: Severity;
  count: number;
  /** One line explaining, in a teacher's terms, why this matters. */
  why: string;
  items: FlagItem[];
}

const sevWeight: Record<Severity, number> = { critical: 3, warning: 2, info: 1, clean: 0 };

export function severityOf(row: CheckRow): Flag[] {
  const flags: Flag[] = [];

  const collisions = row.per.filter((p) => p.collisions > 0);
  flags.push({
    key: "collisions",
    label: "ป้ายชนกัน",
    severity: collisions.length ? "critical" : "clean",
    count: collisions.reduce((a, p) => a + p.collisions, 0),
    why: "ป้ายกำกับซ้อนทับกัน อ่านไม่ออกว่าเป็นค่าอะไร",
    items: collisions.map((p) => ({
      step: p.n,
      text: `ขั้นที่ ${p.n}: ชนกัน ${p.collisions} คู่ — ${p.pairs.join(", ")}`,
    })),
  });

  flags.push({
    key: "collapsed",
    label: "คำสั่ง LaTeX เขียนขาด",
    severity: row.collapsed.length ? "critical" : "clean",
    count: row.collapsed.length,
    why: "เขียนแบ็กสแลชตัวเดียว (\\hat แทน \\\\hat) นักเรียนเห็นเป็น \"hatA\" ตรง ๆ — เช็กอื่นมองไม่เห็น",
    items: [...new Set(row.collapsed)].map((w) => ({ text: `\\${w}` })),
  });

  const leaked = row.latex.leaked > 0;
  flags.push({
    key: "leaked",
    label: "LaTeX หลุดออกมานอกสมการ",
    severity: leaked ? "critical" : "clean",
    count: row.latex.leaked,
    why: "คำสั่งคณิตศาสตร์เขียนอยู่นอก $…$ นักเรียนเห็นโค้ดดิบแทนสัญลักษณ์",
    items: row.latex.samples.map((s) => ({ text: s })),
  });

  const jsx = row.jsx;
  const jsxBad = jsx
    ? jsx.failed.length + jsx.unknown.length + jsx.nanEls.length
    : 0;
  flags.push({
    key: "jsx",
    label: "โครงสร้างกระดานสร้างไม่สำเร็จ",
    severity: jsxBad ? "critical" : "clean",
    count: jsxBad,
    why: "ชิ้นส่วนเรขาคณิตบางส่วนของภาพหายไป ไม่ใช่แค่หน้าตาไม่สวย",
    items: jsx
      ? [
          ...jsx.failed.map((f) => ({ text: `${f.type}: ${f.msg}` })),
          ...jsx.unknown.map((t) => ({ text: `ไม่รู้จักชนิด: ${t}` })),
          ...jsx.nanEls.map((t) => ({ text: `${String(t)}: ตำแหน่งเป็น NaN` })),
        ]
      : [],
  });

  flags.push({
    key: "contrast",
    label: "ป้ายอ่านไม่ออกบนพื้นเข้ม",
    severity: row.contrast.length ? "warning" : "clean",
    count: row.contrast.length,
    why: "ป้ายกำกับวางทับพื้นสีเข้มเกินไป ตัวอักษรจมหายไป",
    items: row.contrast.map((c) => ({ text: c })),
  });

  flags.push({
    key: "missingWhy",
    label: "ขั้นที่ไม่มีเหตุผลกำกับ",
    severity: row.explain.missingWhy.length ? "warning" : "clean",
    count: row.explain.missingWhy.length,
    why: "โชว์ว่าทำอะไร แต่ไม่ได้บอกว่าทำไมถึงทำแบบนั้น",
    items: row.explain.missingWhy.map((m) => ({
      step: m.step,
      text: `ขั้นที่ ${m.step}: ได้ค่าใหม่ (${m.newValues.join(", ")}) แต่ไม่มี "เพราะว่า"`,
    })),
  });

  /* How much of the figure is already on screen before step 1, and how many
     steps reveal nothing. A page that draws its whole diagram up front is
     complete before the student presses anything, and stepping through it shows
     only the text changing — it reads as broken even though every other check
     is clean. Warning only when the FIRST step draws nothing, since a later
     reasoning-only step is legitimate and common. */
  const stepCounts = row.stepCounts ?? [];
  const staticFirst = stepCounts.length > 0 && stepCounts[0] === 0;
  const zeroSteps = row.zeroSteps ?? 0;
  flags.push({
    key: "animation",
    label: "ภาพนิ่ง ไม่ได้ค่อย ๆ วาด",
    severity: staticFirst ? "warning" : zeroSteps ? "info" : "clean",
    count: staticFirst ? 1 : zeroSteps,
    why: staticFirst
      ? "ขั้นแรกไม่ได้วาดอะไรเพิ่มเลย ภาพเสร็จตั้งแต่ก่อนกดขั้นที่ 1 — นักเรียนจะเห็นแค่ตัวหนังสือเปลี่ยน"
      : "มีบางขั้นที่ไม่ได้วาดอะไรเพิ่ม ซึ่งบางครั้งก็ถูกต้อง (ขั้นที่เป็นการให้เหตุผลล้วน)",
    items: stepCounts
      .map((c: number, i: number) => ({ step: i + 1, count: c }))
      .filter((x: { count: number }) => x.count === 0)
      .map((x: { step: number }) => ({
        step: x.step,
        text: `ขั้นที่ ${x.step}: ไม่มีเส้นใหม่ถูกวาด`,
      })),
  });

  const latexMinor = row.latex.thaiInMath + row.latex.badCoord.length;
  flags.push({
    key: "latexMinor",
    label: "รายละเอียด LaTeX อื่น ๆ",
    severity: latexMinor ? "info" : "clean",
    count: latexMinor,
    why: "ภาษาไทยปนอยู่ในโหมดคณิตศาสตร์ หรือพิกัดเขียนแบบข้อความล้วน — ไม่ทำให้พังแต่ควรดู",
    items: [
      ...row.latex.thaiSamples.map((s) => ({ text: `ไทยปนสมการ: ${s}` })),
      ...row.latex.badCoord.map((s) => ({ text: `พิกัดแปลก: ${s}` })),
    ],
  });

  const movedFar = row.moved + row.far;
  flags.push({
    key: "movedFar",
    label: "ป้ายถูกย้ายตำแหน่ง",
    severity: row.far > 0 ? "warning" : movedFar > 0 ? "info" : "clean",
    count: movedFar,
    why: "ตัวจัดวางย้ายป้ายให้ไม่ชนกัน — ปกติไม่เป็นไร แต่ถ้าเป็นแผนภาพเชิงตำแหน่ง ป้ายที่ขยับแล้วคือจุดบกพร่อง",
    items:
      movedFar > 0
        ? [{ text: `ย้าย ${row.moved} ป้าย, ไกลเกินระยะ ${row.far} ป้าย (ไม่ผูกกับขั้นใดขั้นหนึ่ง)` }]
        : [],
  });

  if (row.errs.length) {
    flags.push({
      key: "errs",
      label: "ข้อผิดพลาดขณะรัน",
      severity: "critical",
      count: row.errs.length,
      why: "หน้าเพจโยน error ระหว่างสร้างภาพ",
      items: row.errs.map((e) => ({ text: e })),
    });
  }

  // Worst-first, matching the table in docs/BUILD-PLAN.html section 04. Flags
  // are pushed above roughly in that order already, but `errs` is appended
  // last (it's conditional on non-empty) and would otherwise land at the
  // bottom of the list despite being critical — so sort explicitly rather
  // than rely on push order.
  const priority = [
    "errs",
    "collisions",
    "collapsed",
    "leaked",
    "jsx",
    "contrast",
    "missingWhy",
    "animation",
    "latexMinor",
    "movedFar",
  ];
  flags.sort((a, b) => {
    const bySeverity = sevWeight[b.severity] - sevWeight[a.severity];
    if (bySeverity !== 0) return bySeverity;
    return priority.indexOf(a.key) - priority.indexOf(b.key);
  });

  return flags;
}

/** The single worst flag on a page — what a queue row leads with. */
export function worstFlag(row: CheckRow): Flag {
  const flags = severityOf(row);
  return flags.reduce((worst, f) => {
    if (sevWeight[f.severity] > sevWeight[worst.severity]) return f;
    if (sevWeight[f.severity] === sevWeight[worst.severity] && f.count > worst.count) return f;
    return worst;
  }, flags[0]);
}

export function severityColor(s: Severity): string {
  switch (s) {
    case "critical":
      return "var(--sev-critical)";
    case "warning":
      return "var(--sev-warning)";
    case "info":
      return "var(--sev-info)";
    default:
      return "var(--sev-clean)";
  }
}

export function severityBg(s: Severity): string {
  switch (s) {
    case "critical":
      return "var(--sev-critical-bg)";
    case "warning":
      return "var(--sev-warning-bg)";
    case "info":
      return "var(--sev-info-bg)";
    default:
      return "var(--sev-clean-bg)";
  }
}
