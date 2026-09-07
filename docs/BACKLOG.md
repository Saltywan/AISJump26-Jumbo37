# Backlog

Things the product needs that are not part of the current build. Recorded here
rather than only in a chat log, because "we'll fix that later" that lives
nowhere gets forgotten right up until someone hits it in front of a user.
Nothing in this file is scheduled — see `CLAUDE.md`'s "Not built, and
deliberately so" for the short version, this file for the reasoning.

## Chat history moves server-side, and becomes two-way

Today a generation thread — the messages, not the `Problem`/`Page` rows it
produced — lives in `localStorage` (`apps/web/src/lib/chat.ts`). That was fine
when a teacher generated on one machine in one sitting. It stops being fine the
moment a personal library is expected to follow a user across devices, which
the section pivot's auth work already commits to for `Problem`/`Page`. Right
now those two move server-side while the chat wrapped around them does not —
a user's *generated pages* would follow them to a new browser, their
*conversation about* those pages would not. That mismatch is the first thing
this work has to resolve, not an afterthought once the table exists.

**The harder half of this isn't storage, it's a second capability: asking the
model to fix or tune a page you already have, in the same thread.** Today
generation is one-shot — one message in, one page out, and any follow-up
message in the chat is decorative (see the line in `CLAUDE.md` this backlog
item replaces). The schema is already halfway prepared for the real version:
`Page.superseded_by` exists specifically so a re-run does not destroy the page
it replaces, it currently just has nothing that creates one. A "fix step 3" or
"make the diagram bigger" message would:

1. write a `ChatMessage` row into whatever table this becomes,
2. queue a `Job` whose prompt includes the prior page's source and the user's
   instruction — not a fresh `generate.py` call, closer to what `handle_tutor_ask`
   already does by reading `extract_page_context()` out of stored HTML, except
   the output this time is a new page, not an answer,
3. land a new `Page` row with `superseded_by` pointing back at the one it
   replaced, so the history is a chain, not an overwrite,
4. re-run `check.mjs` on the new page exactly as a fresh generation does — a
   "fix" that introduces a new label collision is exactly the failure mode the
   checker exists to catch, and it must not get a pass just because it started
   from a working page.

This wants its own prompt in the kit (a "revise this page against this
instruction" mode, not the from-scratch one), which is upstream work in
`~/Dev/JumpAIS`, not something to improvise inside the service.

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
