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
        if (g.style.opacity === '0') continue;
        const inner = g.querySelector('foreignObject') ?
          g.querySelector('foreignObject').firstElementChild : g.querySelector('text');
        if (!inner) continue;
        const q = inner.getBoundingClientRect();
        if (q.width < 1) continue;
        out.push({ x: q.x - sr.x, y: q.y - sr.y, w: q.width, h: q.height,
                   t: (inner.textContent || '').trim().slice(0, 16) });
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
    return { N, per, total, explain: (window.__shellCheck || {}).explain || null,
             latex: (window.__shellCheck || {}).latex || null,
             jsx: (window.__shellCheck || {}).jsx || null };
  });
  const id = path.basename(f).replace('.html', '');
  if (shotDir) {
    try {
      await p.evaluate(() => window.Shell.showAll());
      await p.waitForTimeout(450);
      await p.screenshot({ path: path.join(shotDir, id + '.png'), fullPage: true });
    } catch { /* a page that never finished building has nothing to shoot */ }
  }
  await p.close();
  rows.push({ id, errs, ...r });
}
await b.close();
console.log('\nid                 steps  peak-labels-on-screen  collisions-per-step   worst  errs');
console.log('-'.repeat(92));
for (const r of rows) {
  if (r.broken) {
    console.log(`${r.id.padEnd(18)} ${'DID NOT BUILD'.padStart(25)}  ` +
      (r.errs[0] || 'no .sh-stage svg — is lib/ beside the page?').slice(0, 60));
    continue;
  }
  const peak = Math.max(...r.per.map(s => s.labels));
  const seq = r.per.map(s => s.collisions).join(',');
  const worst = Math.max(...r.per.map(s => s.collisions));
  console.log(`${r.id.padEnd(18)} ${String(r.N).padStart(5)}  ${String(peak).padStart(21)}  ` +
    `${seq.padEnd(19)} ${String(worst).padStart(5)}  ${r.errs.length}`);
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
console.log('id                 leaked  thai-in-math  repaired  samples');
console.log('-'.repeat(88));
for (const r of rows) {
  const L = r.latex;
  if (!L) { console.log(r.id.padEnd(18), 'no lint'); continue; }
  const rp = L.repaired || { escapes: 0, wrapped: 0 };
  const rs = (rp.escapes || rp.wrapped) ? `${rp.escapes}esc/${rp.wrapped}wrap` : '-';
  console.log(`${r.id.padEnd(18)} ${String(L.leaked).padStart(6)}  ${String(L.thaiInMath).padStart(12)}  ` +
    `${rs.padStart(8)}  ${(L.samples.concat(L.thaiSamples)).slice(0,4).join(' ')}`);
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

console.log('\nTOTAL collisions summed over every step:',
  rows.reduce((a, r) => a + r.per.reduce((x, s) => x + s.collisions, 0), 0));
for (const r of rows) {
  const bad = r.per.filter(s => s.collisions);
  if (bad.length) console.log(' ', r.id, bad.map(s => `step${s.n}:${s.pairs.join(' ')}`).join(' | ').slice(0, 160));
}
