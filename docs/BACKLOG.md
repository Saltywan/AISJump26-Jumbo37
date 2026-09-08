# Backlog

Things the product needs that are not part of the current build. Recorded here
rather than only in a chat log, because "we'll fix that later" that lives
nowhere gets forgotten right up until someone hits it in front of a user.
Nothing in this file is scheduled — see `CLAUDE.md`'s "Not built, and
deliberately so" for the short version, this file for the reasoning.

## Revision: shipped for personal content; global is still open

`POST /pages/{page_id}/revise` now does exactly what the previous version of
this section sketched: the model gets the existing page's full HTML plus a
change instruction (`kit/generate.py --revise-from`, `build_revise_prompt()`
in the research repo), told to change only what's asked rather than start
over, `check.mjs` runs on the result exactly as it does for a fresh page, and
the new `Page` lands with `superseded_by` pointing at the one it replaced —
that column finally has something writing to it. Verified on a real golden
page: asked to add missing `why` lines, the diff against the source was
exactly those two lines, nothing else moved.

**Scoped to personal content only, on purpose, not as an oversight.** Global
(library) content is admin-managed and has a review gate a revision has to
interact with correctly:

- A non-admin cannot revise global content at all today (nothing lets one
  write to it in the first place). Whether that should change — a "suggest a
  fix" flow open to any user, say — is a separate, undecided product
  question, not a technical one; asked back to the user 2026-09-07 and left
  open ("this needs more discussion and testing").
- An admin revising an *approved* global page needs the revision to go back
  through review before it replaces what's published, with the old page
  staying live and askable in the meantime — deferred superseding
  (`source.superseded_by` only set once the successor is itself approved,
  not at `ready`), plus a way for the review queue to find a pending revision
  of a page that already has a *different* current version showing as
  approved (today every list endpoint reads only the single current page).
  None of that exists yet.
- Filenames matter here: every page for a problem used to land on
  `<problem_id>.html`; a revision writes `<problem_id>-r<n>.html` specifically
  so a rejected revision's cleanup can never delete the file an approved page
  (or the tutor chat, or `/drafts/`) is still reading.

**Chat itself is still not persisted server-side.** A revision's instruction
and result live in the `Job` row that produced them (durable, but not a
conversation), and the tutor Q&A around a page still lives only in the
browser tab's React state, gone on refresh — see the "Real chat log" item
below. Building revision first, rather than the message table this section
used to plan around, was deliberate: the correct key for that table is
`problem_id`, not `page_id` (a revision produces a new `Page`, so a thread
keyed on the page fragments the moment revision is actually used), and that
was only learned by shipping revision — designing the table first would have
meant designing it against a key this proved wrong.

## Real chat log

Both the tutor Q&A and revision instructions/results are ephemeral from the
frontend's point of view — `AskPanel` (`components/ProblemArtifact.tsx`) is
plain `useState`, gone on close or refresh. A `ChatMessage`-shaped table would
fix this, keyed on `problem_id` (see above), and would need to decide: does
an admin see other users' threads on a global page; is a persisted tutor
*answer* (unreviewed model text) a durable artifact this app now serves; what
happens to a thread when its problem is deleted.

## Effort selection

Shipped for both generation and questions/revisions — `effort` is an optional
field on every problem-creation and `/ask`/`/revise` request body, threaded
through `Job.progress_json` (no schema column; `create_all` never migrates an
existing table, so the transport had to fit inside something that already
existed). Generation and revision both refuse `"low"` — see `kit/CLAUDE.md`'s
measured medium-vs-high comparison, which never tested low, and the shipped
default is high. A tutor question defaults to low, matching what it always
ran at before this was choosable — a question answered strictly from stored
page text is not a reasoning-heavy task by design (`TUTOR_SYSTEM_PROMPT`
forbids it from doing anything else). A revision defaults to inheriting the
*source page's* recorded effort rather than always high, so a small fix on a
medium-effort page doesn't silently get more expensive and a fix on a
high-effort page doesn't silently get worse.

A shared `EffortSelect` (`components/ui.tsx`) now offers it in Generate.tsx
(persisted to `localStorage`) and both AskPanel modes. Not done: per-effort
latency measurement — the generation-latency section below still only has
one number, at high.

## Similar-problem generation: shipped

`POST /problems/{id}/similar` — "make one like this" — with three options:
difficulty (`easier`/`same`/`harder`, one axis, not a taxonomy: `same` already
means "same method, new numbers and dressing"), an optional free-text steer,
and effort (inherits the source page's own, same rule revision uses). A new
kit mode, `--similar-to` (`kit/generate.py`, `build_similar_prompt()`,
`kit/prompts/similar.th.txt`), reusing `kind="generate"` rather than adding a
fourth job kind — the source's TEXT only, never its page's HTML, so the model
gets the question and not an answer to anchor on.

Always lands in the CALLER's own personal library, never a write to the
source — which is why, unlike revision, a **global** (`คลังข้อสอบ`) page is a
valid source for any signed-in user, not just its owner or an admin: reading
an approved page and asking for more like it writes nothing anyone else can
observe. Verified with a genuine non-admin account against a real global
page. `Problem.generated_from` (a real column — the first schema change this
app has ever needed after `create_all`, added via `db.py`'s narrowly-scoped
`_add_missing_columns()`, not a full migration framework) records the
lineage, `ON DELETE SET NULL` so deleting a source never destroys its
variants. Capped per-source (`MAX_SIMILAR_PER_SOURCE = 5`) and per-user
in-flight (`MAX_INFLIGHT_GENERATE_PER_USER = 3`, checked on this endpoint
only for now) — a variant is a real ~90s model call a user can trigger
against content they merely read.

Deliberately not built, into this same backlog:
- A count-per-click option ("generate 3 at once") — a pure cost multiplier
  chosen at a UI affordance; click the button again instead.
- Chain-depth limiting (a variant of a variant of a variant) — each step is
  a legitimate act and the two caps above already bound the rate; add the
  same cycle guard `_is_section_visible`/`_has_approved_descendant` use if
  anything ever needs to walk the chain.
- The in-flight cap on `POST /problems` and the two image endpoints (only
  `/similar` enforces it today) — real, but changes existing behaviour and
  deserves its own pass rather than riding in on this one.
- A "show me every variant of X" list — `generated_from` makes it possible
  now; nothing renders it as a list yet, only as one line in a variant's own
  subtitle.
- `revise`'s `instruction` field still has no length cap, unlike `/similar`'s
  `steer` (500 chars) — same category of exposure, worth taking in one pass.

This is narrower than, and does not replace, the personalization item below —
"make one problem like this one" is a feature; suggested practice sets, a
quiz, and weak/strong-topic analysis are a different, larger data model this
one doesn't attempt.

## Generation latency

Measured, not guessed, on 2026-09-07: one full `generate.py --check` run,
`gemini-3.8-flash` at `high` effort, single problem, no retries: **95.7s**
wall clock. `check.mjs` alone, run standalone against the page that run had
already produced: **0.68s**. The checker is under 1% of the total. **The
model call is the entire latency budget** — this was suspected but not
measured before now, and the measurement rules out the checker as a
contributor worth spending effort on.

Levers that actually touch the number, roughly cheapest first:
- **Effort.** CLAUDE.md already has the medium-vs-high comparison
  (35→23 collisions, 1133→1680 animated strokes, 218→268 `why` lines) — that
  was a quality argument, not a latency one, and it was decided in high's
  favour. Re-litigating it trades quality for speed; worth knowing the
  latency-per-effort-level number explicitly before deciding, which this
  measurement doesn't give.
- **Streaming the wait, not the generation.** The job-progress SSE
  (`watchJob`) already shows stage transitions; showing partial output as it
  streams (if the SDK exposes it) would not make 95s shorter but would make it
  read as less dead.
- **A faster model for a first draft, this one for the real page.** Two-pass —
  cheap/fast model sketches, `gemini-3.8-flash` at high effort finishes — is a
  real lever but a research-repo experiment (13-model bake-off territory, see
  `spikes/boardtest/runs/`), not a service-layer change.
- **Parallel generation across a batch** already exists (`--jobs` in
  `generate.py`) but doesn't help one user's one page.

Do not spend time on the checker. The data says it's not there.

## Concurrency: sized for ~12 running / 50+ queued on 2 vCPU / 8GB, not 50 running

The `perf-tuning` branch (2026-09-08) tuned the worker pool, DB connection
pools, Postgres, and the api's threadpool/SSE handling for a target of "50
concurrent generations" on the current VM (2 vCPU / 8GB, see
`docs/DEPLOY-ORACLE-CLOUD.md`). **50 simultaneously *running* generations is
not what got built, deliberately** — every job's work is
`subprocess.run(python3 generate.py)`, a fresh interpreter importing
`google-genai` at ~130MB RSS each; 50 of those alone is 6.5GB, before
Postgres, the api, or anything else. What's actually sized for that target:
**`WORKER_CONCURRENCY=12` running, a 50+-deep queue drains at ~11 jobs/min
(worst-case wait around the queue's own depth in minutes, not hours)**. See
`docker-compose.yml`'s comments on `worker`/`db`/`api` for the full memory
and connection-count arithmetic this is derived from, and
`apps/worker/worker.py`'s `CHECK_CONCURRENCY`/`TUTOR_CONCURRENCY` for why the
Chromium-driving check step and the tutor chat each got their own separate,
narrower gate instead of sharing the generate pool's width.

**Not yet verified against production traffic**: the numbers above are
derived from documented per-process memory costs (a `generate.py` subprocess,
a headless Chromium instance) and connection-count arithmetic, not a real
load test — there is no realistic way to run 50 concurrent real model calls
against this codebase without either the cost of doing so for real or a
mocked model backend, and neither exists yet. Treat the specific numbers as
a reasoned starting point to watch under real usage (worker OOM kills,
Postgres connection exhaustion, and check.mjs's `broken:true` rate are the
three signals worth actually watching once real traffic exists), not as a
guarantee.

**Two things that block going higher, in the order they'll actually bite:**

1. **Google's own per-key rate limit**, not infra, is the first ceiling.
   `apps/worker/worker.py`'s `genai_client()` uses `vertexai=True,
   api_key=...` — Vertex AI's *express mode*, whose RPM is low. Verify the
   key's actual quota tier before raising `WORKER_CONCURRENCY` past the
   current default; if it's still express/free, a billing change is the
   prerequisite for any of the levers below, not another config value.
2. **A bigger box, then a second worker container**, in that order, get
   closer to a real 50-running: 4 vCPU / 16GB funds roughly double every
   number here (`WORKER_CONCURRENCY≈24`, `CHECK_CONCURRENCY≈4`) — still not
   50. `claim_one()`'s `SELECT ... FOR UPDATE SKIP LOCKED` already makes a
   second `worker` container (or `deploy.replicas: 2`) safe today with no
   code change — `max_connections=150` in `docker-compose.yml` already
   carries ~65 connections of spare headroom specifically for this. Two
   workers on a 4 vCPU / 16GB box is a more realistic path to 48-ish running
   than trying to force one worker container past what one box's RAM allows.
   The alternative — making generation in-process instead of
   `subprocess.run`, dropping per-job memory from ~130MB to ~5MB — is the
   only lever that fits real 50-running into 2 vCPU / 8GB, and
   `worker.py`'s own module docstring already argues against it ("a second
   implementation in service code would fork the thing that exists to keep
   this honest"); that argument still holds and this backlog item does not
   propose reopening it.

**Also flagged, not fixed, because it's out of this change's scope (the
concurrency work was about the generation pipeline, not the frontend) but
will be the actual first thing to fall over under 50 concurrent USERS
regardless of anything above**: `apps/web/Dockerfile` runs `npm run dev` —
the Vite dev server — as this app's production frontend. Vite dev serves
every ES module as its own unbundled HTTP request (200+ requests for a cold
page load here) through a single-threaded Node process, plus one open
WebSocket per client for HMR. Fifty cold page loads is 10,000+ requests
against one thread. The fix is a second build stage in that Dockerfile
(`npm run build` → a static `dist/`) served by nginx — the Dockerfile's own
header comment already anticipates exactly this shape of change. Not done
here because it's a frontend build change, not a "config for threading"
change, and deserves its own pass with its own verification.

## Personalization: suggested questions, self-quizzing, weak/strong analysis

Sketched, not designed. The shape: after a user has a personal library of
generated solutions, suggest related practice questions, generate a short quiz
against a topic or section, score it, and surface which topics the user is
weak on. This needs its own data — a `Quiz`/`Attempt`/`Answer` shape, and
almost certainly the `section` tree from the current pivot as the thing weak
points get attributed to ("weak on ตรีโกณมิติ" only means something if
ตรีโกณมิติ is a real node in the tree the user's problems are filed under).
That dependency is the reason this waits for the section model to exist first,
not the reason to build it now.

Not further designed here on purpose — it depends on decisions the section
pivot hasn't made yet (is a personal section's tree the same shape a quiz
would organise by, or does a quiz need its own taxonomy) and guessing at that
now would be designing against a moving target.
