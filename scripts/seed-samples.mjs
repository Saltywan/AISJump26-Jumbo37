// Populate the API with a believable demo set — a couple of "books" of
// exam-style problems, "topics" under each, and problems whose pages are the
// 68 real generated pages already in the repo (apps/pages/static/pages,
// listed in apps/web/src/manifest.ts, checked by
// apps/pages/static/checks.json) — instead of the app showing an
// almost-empty database until someone spends 30-90 seconds and real model
// money generating one page at a time.
//
//   node scripts/seed-samples.mjs
//
// Run from the repo root, on the HOST, with the stack up
// (`docker compose --profile backend up`). It talks to the API over HTTP at
// http://localhost:8000 (override with API_URL) for everything the API can
// do on its own, and shells out to `docker compose exec`/`cp` for the things
// it can't be asked to do over HTTP: writing Problem/Page rows for pages that
// were never actually generated, placing their HTML where a real generation
// would have, and promoting its own seed account to admin (see "THE THREE
// HARD PARTS" below).
//
// This is the section-pivot rewrite. The classroom/lesson-era version of
// this script (three named classrooms, five fixed chapters, no login) is
// archived on `archive/b2b-classroom-poc` — read it first if this one's
// shape is confusing, since most of the design carries straight over: same
// fixture files, same defect curation, same idempotency guarantees, same
// "real endpoints for structure, raw SQL for the two things nothing else can
// do" split. What's new is entirely because content now has an owner and an
// admin role rather than being open to whoever calls the API.
//
// ---------------------------------------------------------------------------
// THE THREE HARD PARTS (read apps/api/app/main.py's review_page/publish_section
// and the STORAGE_DIR/PUBLISHED_DIR split, plus models.py's Section/Problem
// docstrings, before changing any of this):
//
// 1. There is no "generate.py, but instantly and for free" endpoint. Real
//    generation runs a model and a checker (apps/worker/worker.py) and lands
//    a Page row plus an HTML file in STORAGE_DIR. This script fakes only that
//    one step — it copies an existing fixture's HTML to
//    STORAGE_DIR/<problem_id>.html (via `docker compose cp`, since STORAGE_DIR
//    is a volume private to the api/worker containers) and inserts the
//    Problem/Page rows directly with `docker compose exec db psql` — there is
//    no POST /sections/{id}/problems path that doesn't queue a real worker
//    Job. Every Page row it writes carries the file's REAL checks.json entry,
//    not a fabricated one, so a page with genuine collisions still looks like
//    it does after seeding.
//
// 2. Confirmation is real, not skipped. Approving a page is what makes the
//    API copy STORAGE_DIR/<html> into PUBLISHED_DIR/<html> — see
//    _publish_page_file() in main.py — and that copy is the only thing that
//    makes a page reachable by URL at all. So step 1 only ever writes a page
//    as status='ready' (a draft); this script then calls the real
//    POST /pages/{id}/review endpoint to approve the ones meant to be
//    visible, and POST /sections/{id}/publish for each level of the tree
//    that needs it (see publishIfReady() — a topic being published does not
//    make its book visible; _is_section_visible requires every ancestor
//    published, so both need the call). Pages meant to stay drafts (see
//    DEFECT_FILES below) are never reviewed at all — that IS the point: they
//    exist in the database, sitting behind the same gate a real draft would
//    sit behind, invisible to everyone but an admin viewing the review queue.
//
// 3. Every write needs a real admin session — global sections and the
//    problems filed into them are admin-only writes now (see
//    models.py's Section/Problem docstrings on scope+owner_id), and auth is
//    a real cookie-based login, not an open API. This script logs in as its
//    own seed account (SEED_ADMIN_EMAIL below), registering it first if it
//    doesn't exist, and promotes it to admin with one raw SQL UPDATE if it
//    isn't already — the one thing here that bypasses a real endpoint,
//    because ADMIN_EMAILS-driven promotion only runs at API startup and this
//    script has no way to restart that process. It never fabricates a
//    session token or skips login some other way; it does the same
//    register-then-promote a human operator would.
// ---------------------------------------------------------------------------
//
// IDEMPOTENCY — this repo has a documented bug where a version of this idea
// (lib/classroom.ts's syncSeedToServer) ran twice under React's dev
// double-invoke and left 41 classrooms where there should have been 3. Two
// different mechanisms guard against that here, matched to how each kind of
// row gets its id:
//
//   - Sections come from the real POST endpoint, which mints its own
//     server-side id — calling POST twice makes two rows, full stop. So this
//     always does GET-then-match-by-(parent, title) FIRST and only POSTs on
//     a miss, exactly the pattern syncSeedToServer itself now uses.
//   - Problems and pages are inserted directly with SQL, so this mints their
//     ids itself — deterministically, as sha1("<book title>::<topic
//     title>::<file>") — and every INSERT is `ON CONFLICT (id) DO NOTHING`.
//     Same inputs, same ids, every run; a second run's inserts are no-ops.
//   - The review/publish calls are read-checked first (GET the page/section,
//     skip if already in the target state) so re-running this doesn't pile
//     up duplicate Review rows or re-copy files that are already published.
//
// NOT TOUCHING OTHER AGENTS' DATA — this is a shared dev database. Before
// seeding any topic, this reads its existing problems and refuses to touch a
// topic that already contains a problem this script didn't create, the same
// guard the classroom-era version had for a lesson someone had already
// generated real content into by hand.
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

// This script's own account — registered if missing, promoted to admin by
// raw SQL if not already (see "THE THREE HARD PARTS" #3 above). Override
// with SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD if that address is already taken
// by a real person in whatever database this is pointed at.
const SEED_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "seed-admin@jumpais.local";
const SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "seed-admin-password";
const SEED_ADMIN_NAME = "Seed Admin";

/* Two ways to run this, and they differ only in how the two functions under
 * "http/db i/o" reach the database and the storage volume.
 *
 * On the HOST (the original, and still what `node scripts/seed-samples.mjs`
 * does): shell out to `docker compose exec db psql` and `docker compose cp`,
 * because STORAGE_DIR is a volume no host process can see.
 *
 * INSIDE the compose network (SEED_IN_CONTAINER=1, how the `seed` service in
 * docker-compose.yml runs it): talk to psql over the network and copy files
 * straight into the mounted volume. `docker compose` is not available in
 * there, and would be the wrong tool anyway.
 *
 * The container path exists so that `docker compose --profile backend up`
 * alone produces a populated system. A first run that leaves the library
 * empty looks exactly like a broken install to someone who has never seen
 * this app, and "now run this second command" is a step a demo will skip. */
const IN_CONTAINER = process.env.SEED_IN_CONTAINER === "1";
const STORAGE_DIR = process.env.STORAGE_DIR ?? "/storage";
const MODEL = process.env.GEN_MODEL ?? "gemini-3.8-flash";
const EFFORT = process.env.GEN_EFFORT ?? "high";

// ---------------------------------------------------------------- demo data --

// Two "books" — the top-level unit a real exam-question bank is organised
// by (see models.py's Section docstring: a book is just a root section,
// parent_id IS NULL). Same physics fixtures the classroom-era seed used,
// just filed under books-and-topics instead of classrooms-and-chapters.
const BOOKS = [
  { key: "phys_m4", title: "ฟิสิกส์ ม.4 ตะลุยโจทย์", kind: "book" },
  { key: "phys_m5", title: "ฟิสิกส์ ม.5 ตะลุยโจทย์", kind: "book" },
];

// The exact five chapters CHAPTER_TEMPLATES in the archived lib/classroom.ts
// described, each backed for real here by the physics fixtures it only ever
// gestured at — now "topics" (children of a book) rather than "lessons"
// (children of a classroom).
const TOPICS = [
  { title: "การเคลื่อนที่แบบโปรเจกไทล์", files: ["p02_1.html", "p02_2.html", "p01_1.html", "p01_2.html", "p07_1.html"] },
  { title: "พลังงานและงาน", files: ["p03_1.html", "p03_2.html", "p04_1.html", "p05_1.html", "p07_2.html"] },
  { title: "สมดุลกลและการชน", files: ["p08_1.html", "p08_2.html", "p09_1.html", "p09_2.html", "p06_1.html"] },
  { title: "คลื่นและแสง", files: ["p10_1.html", "p10_2.html", "p11_1.html", "p16_1.html", "p17_1.html"] },
  { title: "ไฟฟ้าและแม่เหล็ก", files: ["p12_1.html", "p12_2.html", "p13_1.html", "p14_1.html", "p14_2.html"] },
];

// Two more problems, filed into the ม.4 book's last topic only — a library
// realistically has a couple of things that arrived and haven't been sorted
// into the right topic yet, and this is also the one page in the whole
// 68-fixture set with a failed board element (checks.json's jsx.failed),
// which topics built only from the physics fixtures don't have one of. Both
// stay unapproved, same as the rest of this topic's defective pages below.
const MISC_DRAFTS_FOR = { phys_m4: { topicTitle: TOPICS[4].title, files: ["m19_2.html", "m21_1.html"] } };

// Pages this seed deliberately leaves unapproved — real defects from
// checks.json, chosen to cover the three kinds the brief calls out:
//   p04_1, p16_1     genuine label collisions
//   p12_1, p14_2     collapsed LaTeX escapes (\angle -> \angle written as a
//                    single backslash, checks.json's `collapsed`)
//   m19_2            a failed board element (jsx.failed: riemannsum threw)
//   m21_1            11 label collisions — the most dramatic case in the set
// A topic containing any of these never gets published, so the review
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

// The session cookie, captured once at login and attached to every request
// after — Node's fetch has no cookie jar of its own, and this script only
// ever needs the one cookie, so a module-level string is simpler than
// pulling in a jar library for it.
let sessionCookie = null;

async function apiGet(pathname) {
  const res = await fetch(`${API_URL}${pathname}`, {
    headers: sessionCookie ? { Cookie: sessionCookie } : {},
  });
  if (!res.ok) throw new Error(`GET ${pathname} -> ${res.status}`);
  return res.json();
}

async function apiPost(pathname, body) {
  const res = await fetch(`${API_URL}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`POST ${pathname} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Run every INSERT in one `psql` call, piped over stdin — much cheaper than
 *  one `docker compose exec` per row for ~70 problems + pages. */
function runSql(sql) {
  if (!sql.trim()) return "";
  const psql = ["psql", "-U", "jumpais", "-d", "jumpais", "-v", "ON_ERROR_STOP=1"];
  const [cmd, args] = IN_CONTAINER
    ? [psql[0], ["-h", process.env.PGHOST ?? "db", ...psql.slice(1)]]
    : ["docker", ["compose", "exec", "-T", "db", ...psql]];
  return execFileSync(cmd, args, { cwd: REPO_ROOT, input: sql, encoding: "utf8" });
}

/** Copies a fixture's HTML into the api container's STORAGE_DIR at the exact
 *  path (`<problem_id>.html`, flat, no subdirectory) apps/worker/worker.py's
 *  handle_generate() writes a real draft to — see that function's
 *  `final_name = f"{problem.id}.html"`. review_page() (main.py) looks for the
 *  file at STORAGE_DIR/<html_path> the moment an admin approves it, so it
 *  has to already be sitting there under exactly this name. */
function copyIntoStorage(localFile, problemId) {
  if (IN_CONTAINER) {
    fs.copyFileSync(path.join(PAGES_DIR, localFile), path.join(STORAGE_DIR, `${problemId}.html`));
    return;
  }
  execFileSync("docker", ["compose", "cp", path.join(PAGES_DIR, localFile), `api:/storage/${problemId}.html`], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

// ------------------------------------------------------------------ auth ---

/** Logs in as SEED_ADMIN_EMAIL, registering it first on a fresh database,
 *  and promotes it to admin with one raw SQL UPDATE if ADMIN_EMAILS didn't
 *  already do it at API startup (see "THE THREE HARD PARTS" #3). Sets the
 *  module-level `sessionCookie` used by every apiGet/apiPost after this. */
async function loginAsSeedAdmin() {
  let res = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: SEED_ADMIN_EMAIL, password: SEED_ADMIN_PASSWORD }),
  });
  if (res.status === 401) {
    // No such account yet on a fresh database — register it. A 401 here
    // could also mean the password changed out from under a stale
    // SEED_ADMIN_PASSWORD, but this account exists for no purpose other than
    // seeding, so "just re-register" would fail loudly (409) if that were
    // ever true for a real reason worth investigating.
    res = await fetch(`${API_URL}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: SEED_ADMIN_EMAIL, password: SEED_ADMIN_PASSWORD, name: SEED_ADMIN_NAME }),
    });
    console.log(`  + registered ${SEED_ADMIN_EMAIL}`);
  }
  if (!res.ok) throw new Error(`login/register as ${SEED_ADMIN_EMAIL} -> ${res.status}: ${await res.text()}`);

  const setCookie = res.headers.get("set-cookie");
  const m = setCookie && /jumpais_session=[^;]+/.exec(setCookie);
  if (!m) throw new Error("no session cookie in login/register response");
  sessionCookie = m[0];

  const me = await apiGet("/auth/me");
  if (me.role !== "admin") {
    runSql(`UPDATE app_user SET role = 'admin' WHERE id = ${sqlQuote(me.id)};`);
    console.log(`  + promoted ${SEED_ADMIN_EMAIL} to admin`);
  }
  return me.id;
}

// -------------------------------------------------------------- ensure*() --

async function ensureSection({ parentId, scope, title, kind }, cache) {
  const hit = cache.find((s) => s.parent_id === (parentId ?? null) && s.title === title);
  if (hit) {
    console.log(`  ${"  ".repeat(parentId ? 1 : 0)}= section "${title}" -> ${hit.id} (existing)`);
    return hit;
  }
  const created = await apiPost("/sections", { parent_id: parentId ?? null, scope, title, kind });
  cache.push(created);
  console.log(`  ${"  ".repeat(parentId ? 1 : 0)}+ section "${title}" -> ${created.id} (created)`);
  return created;
}

// ------------------------------------------------------------- seedTopic() --

/** Seeds one topic section with `files`. Refuses to touch a topic that
 *  already has a problem this script didn't create (see the module
 *  comment's "NOT TOUCHING OTHER AGENTS' DATA") — it reads the topic's
 *  current problems and bails the moment it finds an id outside the set it
 *  expects for this exact (book title, topic title, files) triple. */
async function seedTopic(bookTitle, adminId, topic, files) {
  const expectedIds = new Set(files.map((f) => idFor(bookTitle, topic.title, f)));
  const existingProblems = await apiGet(`/sections/${topic.id}/problems`);
  const foreign = existingProblems.filter((p) => !expectedIds.has(p.id));
  if (foreign.length > 0) {
    console.log(`    - "${topic.title}": has ${foreign.length} problem(s) this script didn't create — leaving it alone`);
    return;
  }
  const existingIds = new Set(existingProblems.map((p) => p.id));
  const missing = files.filter((f) => !existingIds.has(idFor(bookTitle, topic.title, f)));

  let sql = "";
  const toReview = []; // { pageId, file }
  files.forEach((file, i) => {
    const problemId = idFor(bookTitle, topic.title, file);
    const pageId = idFor(bookTitle, topic.title, file, "page");
    toReview.push({ pageId, file });
    if (!missing.includes(file)) return; // already inserted by an earlier run

    const html = fs.readFileSync(path.join(PAGES_DIR, file), "utf8");
    const stem = file.replace(/\.html$/, "");
    const title = titleOf(html) ?? stem;
    const checks = CHECKS_BY_ID.get(stem) ?? null;
    const pathChosen = html.includes("Shell.board(") ? "board" : "svg";

    copyIntoStorage(file, problemId);

    sql += `
INSERT INTO problem (id, section_id, scope, owner_id, created_by, position, source, raw_text, extracted_text, level)
VALUES (${sqlQuote(problemId)}, ${sqlQuote(topic.id)}, 'global', NULL, ${sqlQuote(adminId)}, ${i}, 'text', ${sqlQuote(title)}, ${sqlQuote(title)}, NULL)
ON CONFLICT (id) DO NOTHING;
INSERT INTO page (id, problem_id, kit_version, model, effort, html_path, path_chosen, checks_json, status)
VALUES (${sqlQuote(pageId)}, ${sqlQuote(problemId)}, ${sqlQuote(KIT_VERSION)}, ${sqlQuote(MODEL)}, ${sqlQuote(EFFORT)}, ${sqlQuote(`${problemId}.html`)}, ${sqlQuote(pathChosen)}, ${sqlJson(checks)}, 'ready')
ON CONFLICT (id) DO NOTHING;
`;
  });
  if (missing.length > 0) {
    runSql(sql);
    console.log(`    + "${topic.title}": inserted ${missing.length} problem(s) (${missing.join(", ")})`);
  } else {
    console.log(`    = "${topic.title}": already has all ${files.length} seeded problem(s)`);
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
}

/** Publishes a section if it has any approved descendant and isn't already
 *  published — read-checked first so re-running this is a no-op once
 *  everything's already live. Called once per level (see main()'s loop):
 *  publish_section in main.py only ever affects the one section it's called
 *  on, and _is_section_visible requires every ancestor published, not just
 *  the section holding the problems (see models.py's Section docstring). */
async function publishIfReady(section, cache) {
  const fresh = cache.find((s) => s.id === section.id) ?? section;
  if (fresh.status === "published") return;
  try {
    const published = await apiPost(`/sections/${section.id}/publish`, {});
    Object.assign(fresh, published);
    console.log(`      published "${section.title}"`);
  } catch (e) {
    // 409 "no approved problems to publish" is expected for a topic that's
    // all-defect (see DEFECT_FILES) — everything else is a real failure.
    if (!String(e.message).includes("409")) throw e;
  }
}

// ----------------------------------------------------------------- main() --

/** Wait for the API to answer /healthz.
 *
 * On the host this is one attempt and a clear error, as before — if you ran
 * this by hand and the stack is down, saying so immediately is the useful
 * behaviour. In the container it retries, because the seed service starts at
 * the same moment as the API and losing that race is the normal case, not a
 * failure. */
async function waitForApi() {
  const attempts = IN_CONTAINER ? 60 : 1;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`${API_URL}/healthz`);
      if (res.ok) return true;
    } catch {
      // connection refused — API not up yet, fall through to retry/fail below
    }
    if (i === attempts - 1) return false;
    if (i === 0) console.log(`waiting for ${API_URL} …`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function main() {
  if (!(await waitForApi())) {
    console.error(`API not reachable at ${API_URL} — is \`docker compose --profile backend up\` running?`);
    process.exitCode = 1;
    return;
  }

  console.log("seed admin");
  const adminId = await loginAsSeedAdmin();

  const sectionCache = await apiGet("/sections/global");

  for (const book of BOOKS) {
    console.log(`\n${book.title}`);
    const bookSection = await ensureSection({ scope: "global", title: book.title, kind: book.kind }, sectionCache);
    for (const topicDef of TOPICS) {
      const topic = await ensureSection(
        { parentId: bookSection.id, scope: "global", title: topicDef.title, kind: "topic" },
        sectionCache
      );
      await seedTopic(book.title, adminId, topic, topicDef.files);
      await publishIfReady(topic, sectionCache);
    }
    const misc = MISC_DRAFTS_FOR[book.key];
    if (misc) {
      const topic = sectionCache.find((s) => s.parent_id === bookSection.id && s.title === misc.topicTitle);
      // Appended to the same last-topic section, past its usual 5 files —
      // see seedTopic's foreign-problem guard for why this is safe to call a
      // second time with a longer file list than the plain TOPICS pass used
      // (the first 5 ids are already expected/present, so it just adds the 2
      // new ones and leaves the rest alone).
      const baseTopic = TOPICS.find((t) => t.title === misc.topicTitle);
      await seedTopic(book.title, adminId, topic, [...baseTopic.files, ...misc.files]);
      await publishIfReady(topic, sectionCache);
    }
    // The book itself needs its own publish call too — see publishIfReady's
    // docstring. It naturally lands last: _has_approved_descendant walks the
    // whole subtree, so it only succeeds once at least one topic under it
    // already has an approved page, which every non-all-defect topic above
    // already does by this point.
    await publishIfReady(bookSection, sectionCache);
  }

  console.log("\ndone.");
}

main();
