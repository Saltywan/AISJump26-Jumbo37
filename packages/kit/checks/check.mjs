import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

/* --shots <dir>  also save each page's final frame there. The pipeline needs a
   thumbnail anyway (README: Shell.showAll() is what produces it), and an
   archived run is much easier to judge with the pictures beside the numbers. */
const argv = process.argv.slice(2);
let shotDir = null;
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--shots') { shotDir = argv[++i]; continue; }
  files.push(argv[i]);
}
if (shotDir) fs.mkdirSync(shotDir, { recursive: true });
const b = await chromium.launch();
const rows = [];
for (const f of files) {
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0, 120)));
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)); });
  await p.goto('file://' + path.resolve(f));
  try { await p.waitForFunction(() => window.__shellCheck != null, { timeout: 25000 }); }
  catch { await p.waitForTimeout(20000); }
  /* a page that never built — a missing lib/, a syntax error, a truncated
     generation — must cost one row in the table, not the whole batch. */
  const built = await p.evaluate(() =>
    !!(document.querySelector('.sh-stage svg.sh-over') || document.querySelector('.sh-stage svg')));
  if (!built) {
    await p.close();
    rows.push({ id: path.basename(f).replace('.html', ''), errs, N: 0, per: [], total: 0,
                explain: null, latex: null, jsx: null, broken: true });
    continue;
  }
  const r = await p.evaluate(() => {
    // a board page has two SVGs in the stage; the shell's text layer is the one
    // labels live in, and it is always the .sh-over overlay when present.
    const svg = document.querySelector('.sh-stage svg.sh-over')
             || document.querySelector('.sh-stage svg');
    const N = document.querySelectorAll('.sh-step').length;
    const boxes = () => {
      const sr = svg.getBoundingClientRect(), out = [];
      for (const g of svg.querySelectorAll('[data-label]')) {
        // A label inside a retired composite is invisible even though its OWN
        // group is not hidden — the opacity lives on the ancestor. Checking only
        // the label's inline style counted things nobody can see, and reported
        // collisions between four stacked matrices of which three were hidden.
        // NOTE: Element.checkVisibility() is NOT usable here. It returns false
        // for SVG <g> whatever the opacity, so using it skipped every label and
        // the checker silently reported 0 collisions on a page with two labels
        // deliberately stacked. Walk the ancestors instead.
        // Read the shell's LOGICAL state, never computed opacity. Computed
        // opacity races the .sh-reveal fade: measuring right after Shell.go(n)
        // can catch a step group at exactly 0 mid-transition, which skipped
        // every label and made this checker silently report 0 collisions on a
        // page with two labels deliberately stacked on each other.
        let hidden = g.style.opacity === '0';
        for (let a = g.parentElement; a && a !== svg && !hidden; a = a.parentElement) {
          if (a.style && a.style.opacity === '0') hidden = true;          // retired table/matrix
          else if (a.classList && a.classList.contains('sh-reveal')
                   && !a.classList.contains('sh-on')) hidden = true;      // step not yet revealed
        }
        if (hidden) continue;
        const inner = g.querySelector('foreignObject') ?
          g.querySelector('foreignObject').firstElementChild : g.querySelector('text');
        if (!inner) continue;
        const q = inner.getBoundingClientRect();
        if (q.width < 1) continue;
        /* KaTeX renders each label three times over: a MathML <mo>, an
           <annotation encoding="application/x-tex"> holding the TeX source for
           copy-paste, and the visible HTML. textContent concatenates all three,
           so a label reading "⇓" was reported as "⇓\Downarrow⇓" and "$=$" as
           "===", which made real collisions look like nonsense. Read the visible
           subtree only. The RECT is deliberately left alone: .katex-mathml is
           position:absolute and 1px square, so it adds nothing to width and
           ~1-2px of height, and measuring the visible subtree instead moved no
           count anywhere across golden, canary and the 68-page bank. */
        const vis = inner.querySelector('.katex-html');
        out.push({ x: q.x - sr.x, y: q.y - sr.y, w: q.width, h: q.height,
                   t: ((vis || inner).textContent || '').trim().slice(0, 16) });
      }
      return out;
    };
    const hit = (A, B) => A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h;
    const per = [];
    for (let n = 1; n <= N; n++) {
      window.Shell.go(n, true);
      const L = boxes();
      let c = 0; const pairs = [];
      for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++)
        if (hit(L[i], L[j])) { c++; if (pairs.length < 2) pairs.push(`"${L[i].t}"×"${L[j].t}"`); }
      per.push({ n, labels: L.length, collisions: c, pairs });
    }
    // how many labels were declared transient
    const total = svg.querySelectorAll('[data-label]').length;
    window.Shell.go(N, true);
    const lab = (window.__shellCheck || {}).labels || {};
    return { N, per, total, moved: lab.leaders || 0, far: lab.far || 0, nlabels: lab.n || 0,
             decrowded: lab.decrowded || 0,
             contrast: (window.__shellCheck || {}).contrast || [],
             explain: (window.__shellCheck || {}).explain || null,
             latex: (window.__shellCheck || {}).latex || null,
             jsx: (window.__shellCheck || {}).jsx || null };
  });
  const id = path.basename(f).replace('.html', '');
  /* Collapsed escapes. A LaTeX command written with ONE backslash inside a JS
     string is not an error anywhere: \h is simply not a valid JS escape, so the
     parser drops the backslash and '$\hat{A}$' becomes '$hat{A}$'. KaTeX then
     renders it as the variables h,a,t and the student reads "hatA".
     This has to be measured on the SOURCE. Every DOM-side check is structurally
     blind to it — by the time the page runs, the backslash is already gone and
     what remains is indistinguishable from text the author meant to write,
     which is exactly why `leaked` reports 0 on all nine affected pages.
     Requiring 3+ letters keeps regex literals (\d, \s, \w) out of it; x and u
     are skipped because those are real JS escapes. */
  const src = fs.readFileSync(f, 'utf8');
  const collapsed = [...src.matchAll(/(?<!\\)\\([a-zA-Z]{3,})/g)]
    .map(m => m[1]).filter(w => !/^[xu]/.test(w));
  if (shotDir) {
    try {
      await p.evaluate(() => window.Shell.showAll());
      /* Wait for the draw-in to FINISH before shooting. A fixed 450ms was fine
         when almost nothing animated; strokes now draw at constant speed for up
         to 1500ms each, so the thumbnail caught circles half-drawn and every
         archived shot looked like the page had broken geometry — arcs instead of
         circles, lines that stop short. The pages were fine; the picture of them
         was taken mid-animation. Poll the logical end state instead. */
      await p.waitForFunction(() => {
        const els = document.querySelectorAll('.sh-draw');
        for (const e of els) {
          const off = parseFloat(getComputedStyle(e).strokeDashoffset);
          if (Number.isFinite(off) && Math.abs(off) > 0.5) return false;
        }
        return true;
      }, { timeout: 6000 }).catch(() => {});
      await p.waitForTimeout(150);
      await p.screenshot({ path: path.join(shotDir, id + '.png'), fullPage: true });
    } catch { /* a page that never finished building has nothing to shoot */ }
  }
  await p.close();
  rows.push({ id, errs, collapsed, ...r });
}
await b.close();
console.log('\nid                 steps  labels  moved   far  band  collisions-per-step   worst  errs');
console.log('-'.repeat(88));
console.log('  "moved" = labels the placer relocated; on a diagram whose meaning is positional');
console.log('  (a table cell, a tree branch, a tick) that is a defect no other check can see.');
console.log('  "far"   = labels seated beyond leader-line range. Exile is normally not an');
console.log('  option, so any of these means no candidate was in range at all.');
console.log('  "band"  = labels bandDecrowd moved. It only runs where co-visible labels');
console.log('  overlap side-by-side, so a suite of uncrowded pages leaves it untested —');
console.log('  which is how it shipped broken twice while every check stayed green.\n');
for (const r of rows) {
  if (r.broken) {
    console.log(`${r.id.padEnd(18)} ${'DID NOT BUILD'.padStart(25)}  ` +
      (r.errs[0] || 'no .sh-stage svg — is lib/ beside the page?').slice(0, 60));
    continue;
  }
  const seq = r.per.map(s => s.collisions).join(',');
  const worst = Math.max(...r.per.map(s => s.collisions));
  console.log(`${r.id.padEnd(18)} ${String(r.N).padStart(5)}  ${String(r.nlabels).padStart(6)}  ` +
    `${String(r.moved).padStart(5)}  ${String(r.far).padStart(4)}  ${String(r.decrowded).padStart(4)}  ${seq.padEnd(19)} ` +
    `${String(worst).padStart(5)}  ${r.errs.length}`);
}
console.log('\nExplanation');
console.log('id                 steps  why  uses  setup  groups  sanity  MISSING-why  unverified');
console.log('-'.repeat(96));
for (const r of rows) {
  const e = r.explain;
  if (!e) { console.log(r.id.padEnd(18), 'no lint'); continue; }
  console.log(`${r.id.padEnd(18)} ${String(e.steps).padStart(5)}  ${String(e.withWhy).padStart(3)}  ` +
    `${String(e.withUses).padStart(4)}  ${(e.hasSetup ? 'yes' : 'NO ').padStart(5)}  ` +
    `${String(e.groups).padStart(6)}  ${(e.hasSanity ? 'yes' : 'NO ').padStart(6)}  ` +
    `${String(e.missingWhy.length).padStart(11)}  ${String(e.unverified.length).padStart(10)}`);
}
console.log('\nLaTeX leaks (visible on screen)   [repaired = slips the shell fixed; still a prompt signal]');
console.log('id                 leaked  thai-in-math  collapsed  repaired  samples');
console.log('-'.repeat(96));
for (const r of rows) {
  const L = r.latex;
  const co = r.collapsed || [];
  if (!L) { console.log(r.id.padEnd(18), 'no lint'); continue; }
  const rp = L.repaired || { escapes: 0, wrapped: 0, tags: 0 };
  const rs = (rp.escapes || rp.wrapped || rp.tags)
    ? `${rp.escapes}esc/${rp.wrapped}wrap/${rp.tags || 0}tag` : '-';
  console.log(`${r.id.padEnd(18)} ${String(L.leaked).padStart(6)}  ${String(L.thaiInMath).padStart(12)}  ` +
    `${String(co.length).padStart(9)}  ${rs.padStart(8)}  ` +
    `${(L.samples.concat(L.thaiSamples)).slice(0,3).join(' ')}` +
    (co.length ? `  [\\${[...new Set(co)].slice(0, 3).join(' \\')}]` : ''));
}
/* Say it loudly. `leaked` reads 0 on every one of these, so a quiet extra
   column is exactly the kind of thing that gets skimmed past for a whole
   session while it is correctly reporting a real defect. */
/* A label drawn on a dark fill, on either drawing path. Palette membership was
   the wrong measure — it flagged legitimate light fills on 5 of 16 golden pages
   while missing the page that was actually unreadable. */
const withContrast = rows.filter(r => (r.contrast || []).length);
if (withContrast.length) {
  console.log(`\n  !! UNREADABLE LABEL on ${withContrast.length} page(s) — dark text on a dark fill.`);
  console.log('     The shell draws label text in dark ink. A fill this dark hides it.');
  for (const r of withContrast)
    console.log(`     ${r.id.padEnd(18)} ${r.contrast.slice(0, 3).join('   ')}`);
}

const withCollapsed = rows.filter(r => (r.collapsed || []).length);
if (withCollapsed.length) {
  const n = withCollapsed.reduce((a, r) => a + r.collapsed.length, 0);
  console.log(`\n  !! ${n} COLLAPSED ESCAPE${n > 1 ? 'S' : ''} on ${withCollapsed.length} page(s) — ` +
    `a LaTeX command written with one backslash instead of two.`);
  console.log('     The backslash is gone before the page ever runs, so "leaked" cannot see it;');
  console.log('     the student reads the command name as letters (\\hat{A} -> "hatA").');
  for (const r of withCollapsed)
    console.log(`     ${r.id.padEnd(18)} ${[...new Set(r.collapsed)].map(w => '\\' + w).join(' ')}`);
} else {
  console.log('\n  No collapsed escapes: every LaTeX command is written \\\\command in source.');
}
console.log('\nJSXGraph board');
console.log('id                 els  constructed  free-pts  step-tied  own-labels  unknown  failed  off-palette');
console.log('-'.repeat(108));
let anyBoard = false;
for (const r of rows) {
  const J = r.jsx;
  if (!J) { console.log(`${r.id.padEnd(18)} raw SVG (no board)`); continue; }
  anyBoard = true;
  console.log(`${r.id.padEnd(18)} ${String(J.elements).padStart(3)}  ${String(J.constructed).padStart(11)}  ` +
    `${String(J.freePoints).padStart(8)}  ${String(J.tied).padStart(9)}  ${String(J.ownLabels).padStart(10)}  ` +
    `${String(J.unknown.length).padStart(7)}  ${String(J.failed.length).padStart(6)}  ${J.offPalette.join(' ') || '-'}`);
  if (J.unknown.length) console.log('   unknown element names:', J.unknown.join(', '));
  if (J.failed.length) console.log('   failed:', J.failed.map(f => f.type + ': ' + f.msg).join(' | ').slice(0, 150));
  if (J.aliased.length) console.log('   rewritten by alias:', J.aliased.join(', '));
}
if (anyBoard) console.log('  constructed = geometry JSXGraph computed; free-pts = coordinates the model typed in');

/* Failed and unknown board elements were reported only inside the JSXGraph
   table, and I read past them for a whole session while a transformation page
   silently drew no reflected triangle. A missing element is a wrong diagram,
   which is the failure this project cares about most, so it is summarised
   beside the collision total where it cannot be skimmed over. */
{
  const broken = rows.filter(r => r.jsx && ((r.jsx.failed || []).length
    || (r.jsx.unknown || []).length || (r.jsx.nanEls || []).length));
  if (broken.length) {
    console.log('\n!! BOARD ELEMENTS THAT DID NOT GET CREATED — the diagram is missing geometry:');
    for (const r of broken)
      console.log('   ' + r.id + ': ' + [...(r.jsx.failed || []).map(f => f.type + ' (threw)'),
                                         ...(r.jsx.unknown || []).map(u => u + ' (unknown)'),
                                         ...(r.jsx.nanEls || []).map(n => n + ' (NaN position)')
                                        ].join(', '));
  } else {
    console.log('\nBoard elements: all created and positioned (0 failed, 0 unknown, 0 NaN)');
  }
}

console.log('\nTOTAL collisions summed over every step:',
  rows.reduce((a, r) => a + r.per.reduce((x, s) => x + s.collisions, 0), 0));
for (const r of rows) {
  const bad = r.per.filter(s => s.collisions);
  if (bad.length) console.log(' ', r.id, bad.map(s => `step${s.n}:${s.pairs.join(' ')}`).join(' | ').slice(0, 160));
}
