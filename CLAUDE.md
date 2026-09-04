# JumpAIS — the service

A teacher submits a Thai maths or physics problem; a model writes a
self-contained HTML page that draws the solution step by step; **a teacher
confirms it before any student sees it**; a student steps through it and can ask
about it.

The generator lives in `~/Dev/JumpAIS` and has its own CLAUDE.md. Read it before
touching anything under `packages/kit/` — that directory is **vendored, not
source**.

## Run it

```bash
docker compose up --build                    # web :5173, pages :8080
docker compose --profile backend up --build  # + db, api :8000, worker
```

`db`, `api` and `worker` sit behind the `backend` profile so the frontend can be
demonstrated on fixtures alone. `.env` needs `GOOGLE_CLOUD_API_KEY` (and
`OPENROUTER_API_KEY` only if you point the worker at a non-Gemini model).

```
/login   →  /t  teacher: classrooms → lessons / students / settings → chat
         →  /s  student: classrooms → lessons → lesson chat
/legacy  the stage-1 and stage-2 screens, kept for reference
```

## The shape

```
apps/web      React 18 + TS + Vite. Plain CSS custom properties — no Tailwind,
              no UI library. Tokens at the top of styles.css come from the Figma
              file: --primary #3ebad0, IBM Plex Sans Thai, a 5px spacing step.
apps/api      FastAPI + SQLAlchemy + Postgres. Owns classrooms, lessons,
              problems, pages, reviews, jobs. Never serves page HTML.
apps/worker   Polls the job table and shells out to the vendored kit's
              generate.py and check.mjs (including direct multimodal image generation).
              Does not reimplement either.
apps/pages    nginx on its own origin. Serves fixtures at /pages/ and approved
              generated pages at /generated/.
packages/kit  vendored copy of the kit. Produced by kit/sync-to-app.sh in the
              research repo; verified by packages/kit/check-version.sh. Do not
              edit by hand — changes belong upstream.
```

## The two rules that shape everything

**1. A generated page runs model-written JavaScript.** It is served from a
different origin and embedded with `sandbox="allow-scripts"` and **no**
`allow-same-origin`. The app therefore cannot read anything out of a page — which
is exactly why the check report is stored in Postgres and fetched from the API.
Do not weaken the sandbox, do not inline a page into the app document, and do not
add a route to the API that returns page bytes.

**2. A page a teacher has not approved is not in the students' path at all.**
The worker writes drafts to the `storage` volume. On approval the API copies the
file into the `published` volume; rejection removes it again. nginx serves the
published volume at `/generated/`, so that path physically cannot contain an
unapproved page — no naming convention to get wrong, and nothing to leak by
accident.

Drafts are served too, at `/drafts/`, from the storage volume. That is not an
oversight and it is not a hole that can be closed: serving only approved pages
means the page a teacher must look at *before* approving returns 404, and a
reviewer who cannot see the page cannot review it. Be precise about what this
boundary is — with no authentication anywhere in this system, `/drafts/` is a
**product** boundary, not a security one. The student app never links it and the
API never returns an unapproved page's path, but a guessed URL would serve it.
Real protection needs auth on the pages origin; do not describe it as sealed
until that exists.

The gate is enforced server-side too: `?published_only=true` and
`?approved_only=true` do not return unconfirmed rows, and `approved_only` also
requires the lesson to be published, so unpublishing cannot be walked around with
a remembered lesson id.

## The thing that matters most, and the reason for the review screen

**Every automated check is blind to a wrong diagram.** A geometry construction
came through with its compass arcs clipped to fragments and a stray filled sector
and scored perfectly clean on collisions, animation density, LaTeX and board
health. Another drew both compass circles and no perpendicular while asserting
`PH ⊥ AB` in its answer card.

So the review screen is built so the **fast path is looking at the page**. The
numbers are annotation. If you change that screen, keep the page large, keep the
report beside it rather than under it, and keep the decision reachable without
scrolling. `seconds_on_page` is recorded on every review because rubber-stamping
is this design's silent failure and has to be visible from the first day.

## The generated page is an artifact, not an embed

`components/Artifact.tsx`. In the conversation a finished page is a **card** —
one clickable object, message-sized. Opening it hands the page the whole
viewport, and the controls that decide anything about it live in that view's top
right.

Two earlier layouts are why. First the page was embedded in the chat column with
the check report beside it, so a chat message was half page and half report and
neither had room. Then the student's screen split the animation and the
conversation into two permanent columns — which only fixed the vertical version
of the same mistake: the page was still boxed inside a message, now permanently
half a screen wide. A page that draws a solution wants the whole screen; a
message cannot give it one.

Publishing lives in that expanded view, and the chat's own top bar shows
**เปิดดูหน้าก่อนเผยแพร่** until the teacher has opened the artifact. That is the
gate in the only form that means anything: a confirm button reachable without
opening the page is a button pressed without opening the page. Do not add a
publish control that works from the card.

**Flip the thread to `published` only after the server says it is.** The two
states are served from different paths — `/drafts/` and `/generated/` — so the
status flip is also an iframe `src` swap. Flipping it optimistically raced the
API's copy into the published volume and the teacher's own page 404'd on them
the moment they confirmed it. `publishThread()` awaits `review(approved)` first
and leaves the thread a draft if that call fails, with `publishing` guarding the
double click.

## State: where things actually live

Server is the source of truth when it is up. `lib/api.ts` is the client;
`isLive()` is what a screen asks before promising anything, and every call
degrades to the local fixtures **with a visible notice** rather than failing —
`demoReason` on a chat thread exists to say "this is a stand-in", and a canned
page must never be passed off as a freshly generated one.

Classrooms, lessons, problems, pages, reviews, and jobs are **all server-owned**.
`TeacherChat` hydrates and periodically syncs problem threads directly from
`GET /lessons/{id}/problems` via `syncLessonProblems()`, so problems, draft/published
states, and generated animation cards follow the teacher across tabs and devices.
**Ids must come from the server** — locally minted ids posted to the API 404, and
that silently broke real generation for an entire session while the UI showed a
fixture and looked fine.

When a problem, lesson, or classroom is deleted, the API unlinks the generated
HTML files and uploads from Docker volumes (`/storage` and `/published`) to prevent
storage disk leaks.

## Traps this repo has already fallen into

- **Optimistic UI on disk copy races.** Flipping the iframe src to
  `/generated/<file>` immediately on publish button click raced the server's
  `shutil.copy2` into the published volume, causing 404s until reload. The client
  must await `api.review(...)` and `api.publishLesson(...)` before flipping status.
- **Fixture pre-seeding causes teacher vs student split-brain.** Injecting 5 mock
  fixture pages into a newly created lesson caused the teacher to see "5 โจทย์"
  while the database and student saw 0. Real lessons must start with 0 problems
  (`pageFiles: []`) when live.
- **Deleted records leak disk files without volume cleanup.** Deleting classrooms,
  lessons, or problems must actively unlink HTML drafts and published files from
  Docker volumes (`/storage` and `/published`), not just delete database rows.
- **Revoke lesson publish on problem deletion.** If a problem is deleted or rejected
  from a published lesson, the lesson's status must revert to `"draft"` so students
  never encounter missing problems in "N จาก M โจทย์".
- **A guard written after an `await` is not a guard.** `syncSeedToServer` checked
  a flag only set at the end, so React's dev double-invoke and every storage
  clear created another full set of rows — 41 classrooms, 14 of them identical.
- **Verify through the UI, not with curl.** The backend was "verified end to end"
  with API-issued ids while every request the actual UI made returned 404.
- **A photographed problem goes to the model whole.** `run_generate()` passes
  `--image` straight to `kit/generate.py`; there is no OCR pass and the earlier
  restate-to-text-first design is gone, because going through text lost every
  diagram. What the model understood is recovered afterwards from the page's own
  `Shell.page({problem})` call (`extract_problem_statement`) — that line is the
  only record of what it read, and the only way a teacher catches a misread.
- **Kit changes belong upstream first.** Image support was written into
  `packages/kit/generate.py` — the vendored copy — so `sync-to-app.sh` would
  have deleted it. Edit `~/Dev/JumpAIS/kit/`, then sync. `check-version.sh` says
  which way the drift runs; it caught this one.
- **Test two devices, not two roles in one browser.** localStorage makes a broken
  cross-device gate look like it works.
- **A fake delay can beat a real one.** The demo pipeline's 1.4–3.2s stand-in
  raced a real 30–90s generation and silently won.
- **`tsc -b` failing may be another agent's file.** Check `git status` before
  chasing it.
- **The worker needs the kit re-synced** after any change upstream, or it runs an
  old copy. It has already run without `generate.py` at all, and with a
  `check.mjs` that predated the `--json` flag it depends on.
- **Checkers can disagree by browser build.** The contrast check reported six
  unreadable labels under one Chromium and none under another; an SVG shape with
  no authored fill computes to black by spec.

## Not built, and deliberately so

No authentication. `lib/session.ts` is a seam that says plainly it is not a
security boundary; the role picker on the login screen is a demo control.

No CAS — the model computes its own arithmetic. This is the largest correctness
gap in the product and nothing in the UI mitigates it.

Chat follow-up replies beyond the initial generated problem stay local.
Problem authoring, generated pages, review statuses, and review checks are
all persisted in PostgreSQL and synced across sessions.

## Docs

`docs/BUILD-PLAN.html` — the five-stage build order and the review rationale.
`docs/SCHEMA.md` — the data model, API surface, and why a lesson holds several problems.
`docs/PLAN.md` — superseded, kept for its API notes.
