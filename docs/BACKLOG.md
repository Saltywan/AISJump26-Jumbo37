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

Not done: no UI control for it yet on Generate.tsx or AskPanel (the API and
worker both support it; nothing in the frontend offers picking it). No
per-effort latency measurement — the generation-latency section below still
only has one number, at high.

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
