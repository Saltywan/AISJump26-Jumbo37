// Populate the API with a believable demo set — a few classrooms, lessons
// under them, and problems whose pages are the 68 real generated pages
// already in the repo (apps/pages/static/pages, listed in
// apps/web/src/manifest.ts, checked by apps/pages/static/checks.json) —
// instead of the app showing an almost-empty database until someone spends
// 30-90 seconds and real model money generating one page at a time.
//
//   node scripts/seed-samples.mjs
//
// Run from the repo root, on the HOST, with the stack up
// (`docker compose --profile backend up`). It talks to the API over HTTP at
// http://localhost:8000 (override with API_URL) for everything the API can
// do on its own, and shells out to `docker compose exec`/`cp` for the two
// things it can't be asked to do over HTTP: writing Problem/Page rows for
// pages that were never actually generated, and placing their HTML where a
// real generation would have (see "THE TWO HARD PARTS" below). No npm
// dependencies — Node 18+'s built-in fetch and child_process are enough.
//
// ---------------------------------------------------------------------------
// THE TWO HARD PARTS (read apps/api/app/main.py's review_page/publish_lesson
// and the STORAGE_DIR/PUBLISHED_DIR split before changing any of this):
//
// 1. There is no "generate.py, but instantly and for free" endpoint. Real
//    generation runs a model and a checker (apps/worker/worker.py) and lands
//    a Page row plus an HTML file in STORAGE_DIR. This script fakes only that
//    one step — it copies an existing fixture's HTML to
//    STORAGE_DIR/<problem_id>.html (via `docker compose cp`, since STORAGE_DIR
//    is a volume private to the api/worker containers) and inserts the
//    Problem/Page rows directly with `docker compose exec db psql` — there is
//    no POST /lessons/{id}/problems path that doesn't queue a real worker Job.
//    Every Page row it writes carries the file's REAL checks.json entry, not
//    a fabricated one, so a page with genuine collisions still looks like it
//    does after seeding.
//
// 2. Confirmation is real, not skipped. Approving a page is what makes the
//    API copy STORAGE_DIR/<html> into PUBLISHED_DIR/<html> — see
//    _publish_page_file() in main.py — and that copy is the only thing that
//    makes a page reachable by URL at all. So step 1 only ever writes a page
//    as status='ready' (a draft); this script then calls the real
//    POST /pages/{id}/review endpoint to approve the ones meant to be
//    visible, and calls the real POST /lessons/{id}/publish once every
//    problem in a lesson is approved. Pages meant to stay drafts (see
//    DEFECT_FILES below) are never reviewed at all — that IS the point: they
//    exist in the database, sitting behind the same gate a real draft would
//    sit behind, invisible to students and to GET .../problems?approved_only.
// ---------------------------------------------------------------------------
//
// IDEMPOTENCY — this repo has a documented bug where a version of this idea
// (lib/classroom.ts's syncSeedToServer) ran twice under React's dev
// double-invoke and left 41 classrooms where there should have been 3. Two
// different mechanisms guard against that here, matched to how each kind of
// row gets its id:
//
//   - Classrooms and lessons come from the real POST endpoints, which mint
//     their own server-side ids — calling POST twice makes two rows, full
//     stop. So this always does GET-then-match-by-name (classrooms) or
//     GET-then-match-by-title (lessons) FIRST and only POSTs on a miss,
//     exactly the pattern syncSeedToServer itself now uses.
//   - Problems and pages are inserted directly with SQL, so this mints their
//     ids itself — deterministically, as sha1("<classroom name>::<lesson
//     title>::<file>") — and every INSERT is `ON CONFLICT (id) DO NOTHING`.
//     Same inputs, same ids, every run; a second run's inserts are no-ops.
//   - The review/publish calls are read-checked first (GET the page/lesson,
//     skip if already in the target state) so re-running this doesn't pile
//     up duplicate Review rows or re-copy files that are already published.
//
// NOT TOUCHING OTHER AGENTS' DATA — this is a shared dev database (see the
// classrooms list before this script ever ran: three near-duplicate "Physics
// ม.4/1" rows and a stray "ห้องเรียนทดสอบ" test classroom already existed from
// other work in this repo). ensureClassroom() below disambiguates same-named
// classrooms by matching `subject` too, not name alone, so it lands on the
// one THIS script created/expects rather than a stray duplicate. And before
// seeding any lesson, this reads its existing problems and refuses to touch
// a lesson that already contains a problem this script didn't create — one
// of the classrooms already had a lesson with 3 REAL generated-and-approved
// problems in it (evidently from earlier manual testing of the confirmation
// flow), and this script leaves that lesson alone entirely rather than mixing
// fixture stand-ins into it.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PAGES_DIR = path.join(REPO_ROOT, "apps/pages/static/pages");
const CHECKS_JSON = path.join(REPO_ROOT, "apps/pages/static/checks.json");
const KIT_VERSION_FILE = path.join(REPO_ROOT, "packages/kit/VERSION");

const API_URL = process.env.API_URL ?? "http://localhost:8000";
const MODEL = process.env.GEN_MODEL ?? "gemini-3.8-flash";
const EFFORT = process.env.GEN_EFFORT ?? "high";

// ---------------------------------------------------------------- demo data --

// Same three classrooms and the same five chapter titles lib/classroom.ts's
// local seed() has always used, on purpose: a teacher's browser that has
// never talked to this backend before seeds those exact names locally, and
// its syncSeedToServer() adopts a server classroom's id the moment it finds
// one with a matching name — so seeding under these names is what makes the
// teacher's own classroom list (which reads localStorage, not the API — see
// that file) land on real, generated content instead of an empty shell.
const CLASSROOMS = [
  { key: "phys41", name: "Physics ม.4/1", subject: "ห้องเรียนวิชาฟิสิกส์", level: "ม.4" },
  { key: "phys42", name: "Physics ม.4/2", subject: "ห้องเรียนวิชาฟิสิกส์", level: "ม.4" },
  { key: "phys51", name: "Physics ม.5/1", subject: "ห้องเรียนวิชาฟิสิกส์ ม.5", level: "ม.5" },
];

// The exact five chapters CHAPTER_TEMPLATES in lib/classroom.ts describes,
// each backed for real here by the physics fixtures it only ever gestures at
// (that file's own pageFiles are cosmetic — a local lesson count, not
// anything the API knows about).
const CHAPTERS = [
  { title: "บทที่ 1: การเคลื่อนที่แบบโปรเจกไทล์", files: ["p02_1.html", "p02_2.html", "p01_1.html", "p01_2.html", "p07_1.html"] },
  { title: "บทที่ 2: พลังงานและงาน", files: ["p03_1.html", "p03_2.html", "p04_1.html", "p05_1.html", "p07_2.html"] },
  { title: "บทที่ 3: สมดุลกลและการชน", files: ["p08_1.html", "p08_2.html", "p09_1.html", "p09_2.html", "p06_1.html"] },
  { title: "บทที่ 4: คลื่นและแสง", files: ["p10_1.html", "p10_2.html", "p11_1.html", "p16_1.html", "p17_1.html"] },
  { title: "บทที่ 5: ไฟฟ้าและแม่เหล็ก", files: ["p12_1.html", "p12_2.html", "p13_1.html", "p14_1.html", "p14_2.html"] },
];

// Two more problems, filed into Physics ม.4/1's chapter 5 only — a teacher's
// inbox realistically has a couple of things that arrived and haven't been
// sorted into the right chapter yet, and this is also the one page in the
// whole 68-fixture set with a failed board element (checks.json's
// jsx.failed), which chapters built only from the physics fixtures don't
// have one of. Both stay unapproved, same as the rest of this chapter's
// defective pages below.
const MISC_DRAFTS_FOR = { phys41: { chapterTitle: CHAPTERS[4].title, files: ["m19_2.html", "m21_1.html"] } };

// Pages this seed deliberately leaves unapproved — real defects from
// checks.json, chosen to cover the three kinds the brief calls out:
//   p04_1, p16_1     genuine label collisions
//   p12_1, p14_2     collapsed LaTeX escapes (\angle -> \angle written as a
//                    single backslash, checks.json's `collapsed`)
//   m19_2            a failed board element (jsx.failed: riemannsum threw)
//   m21_1            11 label collisions — the most dramatic case in the set
// A lesson containing any of these never gets published, so the review
// screen has real, worth-looking-at drafts waiting rather than everything
// arriving pre-approved.
const DEFECT_FILES = new Set(["p04_1.html", "p16_1.html", "p12_1.html", "p14_2.html", "m19_2.html", "m21_1.html"]);

// ------------------------------------------------------------------ setup ---

function kitVersion() {
  if (!fs.existsSync(KIT_VERSION_FILE)) return "unknown";
  const m = /^source-commit:\s*(\S+)/m.exec(fs.readFileSync(KIT_VERSION_FILE, "utf8"));
  return m ? m[1].slice(0, 12) : "unknown";
}

// Same extraction gen-manifest.mjs uses for the same reason: the title lives
// in the page's own `Shell.page({ title: '...' })` call, single-quoted, and
// that's a better source of truth than re-typing 68 titles by hand.
function titleOf(html) {
  const m = /title\s*:\s*'((?:[^'\\]|\\.)*)'/.exec(html.slice(0, 4000));
  return m ? m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\") : null;
}

const CHECKS_BY_ID = new Map(JSON.parse(fs.readFileSync(CHECKS_JSON, "utf8")).map((row) => [row.id, row]));
const KIT_VERSION = kitVersion();

function idFor(...parts) {
  return crypto.createHash("sha1").update(parts.join("::")).digest("hex").slice(0, 32);
}

function sqlQuote(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlJson(value) {
  return `${sqlQuote(JSON.stringify(value))}::json`;
}

// ------------------------------------------------------------- http/db i/o --

async function apiGet(pathname) {
  const res = await fetch(`${API_URL}${pathname}`);
  if (!res.ok) throw new Error(`GET ${pathname} -> ${res.status}`);
  return res.json();
}

async function apiPost(pathname, body) {
  const res = await fetch(`${API_URL}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`POST ${pathname} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Run every INSERT in one `psql` call, piped over stdin — much cheaper than
 *  one `docker compose exec` per row for ~70 problems + pages. */
function runSql(sql) {
  if (!sql.trim()) return;
  execFileSync(
    "docker",
    ["compose", "exec", "-T", "db", "psql", "-U", "jumpais", "-d", "jumpais", "-v", "ON_ERROR_STOP=1"],
    { cwd: REPO_ROOT, input: sql, stdio: ["pipe", "inherit", "inherit"] }
  );
}

/** Copies a fixture's HTML into the api container's STORAGE_DIR at the exact
 *  path (`<problem_id>.html`, flat, no subdirectory) apps/worker/worker.py's
 *  handle_generate() writes a real draft to — see that function's
 *  `final_name = f"{problem.id}.html"`. review_page() (main.py) looks for the
 *  file at STORAGE_DIR/<html_path> the moment a teacher approves it, so it
 *  has to already be sitting there under exactly this name. */
function copyIntoStorage(localFile, problemId) {
  execFileSync("docker", ["compose", "cp", path.join(PAGES_DIR, localFile), `api:/storage/${problemId}.html`], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

// -------------------------------------------------------------- ensure*() --

async function ensureClassroom({ name, subject, level }) {
  const existing = await apiGet("/classrooms");
  const candidates = existing.filter((c) => c.name === name);
  const exact = candidates.find((c) => (c.subject ?? "") === (subject ?? ""));
  const hit = exact ?? candidates[0];
  if (hit) {
    if (candidates.length > 1) {
      console.log(`  ! ${candidates.length} classrooms already named "${name}" — using ${hit.id} (subject matches)`);
    }
    console.log(`  = classroom "${name}" -> ${hit.id} (existing)`);
    return hit.id;
  }
  const { id } = await apiPost("/classrooms", { name, subject, level });
  console.log(`  + classroom "${name}" -> ${id} (created)`);
  return id;
}

async function ensureLesson(classroomId, title) {
  const existing = await apiGet(`/classrooms/${classroomId}/lessons`);
  const hit = existing.find((l) => l.title === title);
  if (hit) return hit;
  const { id } = await apiPost(`/classrooms/${classroomId}/lessons`, { title });
  console.log(`    + lesson "${title}" -> ${id} (created)`);
  return { id, title, status: "draft", problem_count: 0 };
}

// ------------------------------------------------------------ seedLesson() --

/** Seeds one lesson with `files`. Refuses to touch a lesson that already has
 *  a problem this script didn't create (see the module comment's "NOT
 *  TOUCHING OTHER AGENTS' DATA") — it reads the lesson's current problems and
 *  bails the moment it finds an id outside the set it expects for this exact
 *  (classroom name, lesson title, files) triple. */
async function seedLesson(classroomName, classroomId, level, lesson, files) {
  const expectedIds = new Set(files.map((f) => idFor(classroomName, lesson.title, f)));
  const existingProblems = lesson.problem_count > 0 ? await apiGet(`/lessons/${lesson.id}/problems`) : [];
  const foreign = existingProblems.filter((p) => !expectedIds.has(p.id));
  if (foreign.length > 0) {
    console.log(`    - "${lesson.title}": has ${foreign.length} problem(s) this script didn't create — leaving it alone`);
    return;
  }
  const existingIds = new Set(existingProblems.map((p) => p.id));
  const missing = files.filter((f) => !existingIds.has(idFor(classroomName, lesson.title, f)));

  let sql = "";
  const toReview = []; // { pageId, file }
  files.forEach((file, i) => {
    const problemId = idFor(classroomName, lesson.title, file);
    const pageId = idFor(classroomName, lesson.title, file, "page");
    toReview.push({ pageId, file });
    if (!missing.includes(file)) return; // already inserted by an earlier run

    const html = fs.readFileSync(path.join(PAGES_DIR, file), "utf8");
    const stem = file.replace(/\.html$/, "");
    const title = titleOf(html) ?? stem;
    const checks = CHECKS_BY_ID.get(stem) ?? null;
    const pathChosen = html.includes("Shell.board(") ? "board" : "svg";

    copyIntoStorage(file, problemId);

    sql += `
INSERT INTO problem (id, lesson_id, position, source, raw_text, extracted_text, level)
VALUES (${sqlQuote(problemId)}, ${sqlQuote(lesson.id)}, ${i}, 'text', ${sqlQuote(title)}, ${sqlQuote(title)}, ${sqlQuote(level)})
ON CONFLICT (id) DO NOTHING;
INSERT INTO page (id, problem_id, kit_version, model, effort, html_path, path_chosen, checks_json, status)
VALUES (${sqlQuote(pageId)}, ${sqlQuote(problemId)}, ${sqlQuote(KIT_VERSION)}, ${sqlQuote(MODEL)}, ${sqlQuote(EFFORT)}, ${sqlQuote(`${problemId}.html`)}, ${sqlQuote(pathChosen)}, ${sqlJson(checks)}, 'ready')
ON CONFLICT (id) DO NOTHING;
`;
  });
  if (missing.length > 0) {
    runSql(sql);
    console.log(`    + "${lesson.title}": inserted ${missing.length} problem(s) (${missing.join(", ")})`);
  } else {
    console.log(`    = "${lesson.title}": already has all ${files.length} seeded problem(s)`);
  }

  // Confirmation: approve every non-defect page through the real endpoint —
  // this is the only thing that copies STORAGE_DIR -> PUBLISHED_DIR (see
  // review_page() in main.py) and makes the page servable at all. Defect
  // pages are never reviewed, on purpose (see DEFECT_FILES above).
  let approvedNow = 0;
  for (const { pageId, file } of toReview) {
    if (DEFECT_FILES.has(file)) continue;
    const page = await apiGet(`/pages/${pageId}`);
    if (page.status === "approved") continue;
    await apiPost(`/pages/${pageId}/review`, {
      action: "approved",
      note: "อนุมัติจากชุดข้อมูลตัวอย่าง (scripts/seed-samples.mjs)",
      seconds_on_page: 45 + Math.floor(Math.random() * 100),
    });
    approvedNow++;
  }
  if (approvedNow > 0) console.log(`      approved ${approvedNow} page(s)`);

  // Publish only when nothing in this lesson is a deliberate draft — a
  // lesson with any DEFECT_FILES problem can't publish anyway (main.py's
  // publish_lesson requires every problem approved) and shouldn't: that's
  // what leaves it sitting in the review queue on purpose.
  const hasDefect = files.some((f) => DEFECT_FILES.has(f));
  if (!hasDefect) {
    const fresh = await apiGet(`/classrooms/${classroomId}/lessons`);
    const current = fresh.find((l) => l.id === lesson.id);
    if (current && current.status !== "published") {
      await apiPost(`/lessons/${lesson.id}/publish`, {});
      console.log(`      published`);
    }
  }
}

// ----------------------------------------------------------------- main() --

async function main() {
  try {
    await apiGet("/healthz");
  } catch {
    console.error(`API not reachable at ${API_URL} — is \`docker compose --profile backend up\` running?`);
    process.exitCode = 1;
    return;
  }

  for (const classroom of CLASSROOMS) {
    console.log(`\n${classroom.name}`);
    const classroomId = await ensureClassroom(classroom);
    for (const chapter of CHAPTERS) {
      const lesson = await ensureLesson(classroomId, chapter.title);
      await seedLesson(classroom.name, classroomId, classroom.level, lesson, chapter.files);
    }
    const misc = MISC_DRAFTS_FOR[classroom.key];
    if (misc) {
      const lesson = await ensureLesson(classroomId, misc.chapterTitle);
      // Appended to the same chapter-5 lesson, past its usual 5 files — see
      // seedLesson's foreign-problem guard for why this is safe to call a
      // second time with a longer file list than the plain CHAPTERS pass
      // used (the first 5 ids are already expected/present, so it just adds
      // the 2 new ones and leaves the rest alone).
      const chapter5 = CHAPTERS.find((c) => c.title === misc.chapterTitle);
      await seedLesson(classroom.name, classroomId, classroom.level, lesson, [...chapter5.files, ...misc.files]);
    }
  }

  console.log("\ndone.");
}

main();
