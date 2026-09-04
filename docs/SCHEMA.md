# Data model, revised for the classroom design

Supersedes the `Data model` section of [PLAN.md](PLAN.md). That version was
written before the Figma design existed and knows nothing about classrooms,
lessons or students — it modelled a flat queue of problems, which is not the
product any more.

Nothing here is built yet. This is the shape the backend gets built against, and
it is deliberately written after the screens rather than before them, because the
localStorage stores the frontend already uses (`apps/web/src/lib/store.ts`,
`classroom.ts`) were written to be replaced by a real API — they are the honest
specification of what the screens actually need.

## What changed, and why

**A classroom layer exists.** The design opens on ห้องเรียนของฉัน and everything
hangs off a classroom: lessons, students, settings. `PLAN.md` had no such
concept.

**A lesson is not one problem.** The student chat header reads
`1 จาก 4 โจทย์` — one of four problems. So a lesson holds an ordered set of
problems, each of which generates its own page. This is the single biggest
correction to the old model, which conflated the two.

**Two different chats.** The teacher's chat *authors* lessons
(`วันนี้อยากสร้างสื่อการสอนเกี่ยวกับอะไร?`); the student's chat *asks about* an
approved page. They share almost nothing — different participants, different
context, different safety properties — so they are one table with a `kind`
rather than pretending to be the same feature.

**The review gate moved but did not disappear.** There is no review queue screen
in the design. The confirmation now lives on the generated-lesson card in the
teacher's chat: the page and its check report together, and the teacher keeps it.
A lesson is invisible to students until that happens. The gate is the same gate;
only its location changed.

## Tables

```sql
-- Identity. There is no auth yet (see apps/web/src/lib/session.ts); these rows
-- exist so enrolment and authorship have something to point at, and so adding a
-- real identity provider later is a join, not a migration.
user          id, name, role('teacher'|'student'), created_at

classroom     id, name, subject, level, owner_id -> user,
              created_at, archived_at

enrollment    classroom_id, user_id, joined_at        -- PK (classroom_id, user_id)

-- บทเรียน. Ordered within a classroom; chapter is the "บทที่ 1" label.
lesson        id, classroom_id, title, chapter, position,
              status('draft'|'published'), published_at,
              created_by -> user, created_at

-- One of the โจทย์ inside a lesson. Ordered, so "1 จาก 4" is position+1 of count.
problem       id, lesson_id, position,
              source('text'|'image'), raw_text, image_path,
              extracted_text,          -- editable; the only OCR mitigation
              extraction_confidence, level, created_at

-- The generated artefact. One current page per problem, but keep the history:
-- re-running a problem against a newer kit is the whole point of kit_version.
page          id, problem_id, kit_version, model, effort,
              html_path, thumb_path, path_chosen('board'|'svg'),
              checks_json,             -- window.__shellCheck, verbatim
              status('generating'|'ready'|'approved'|'rejected'),
              superseded_by -> page,   -- null for the current one
              created_at

review        id, page_id, reviewer_id -> user,
              action('approved'|'rejected'), note,
              seconds_on_page,         -- rubber-stamping is a silent failure
              created_at

job           id, kind('generate'|'recheck'|'extract'),
              target_id,               -- a problem id for generate
              state('queued'|'running'|'done'|'failed'),
              stage, progress_json, attempts, error,
              started_at, finished_at

-- Both chats. kind='authoring' is the teacher creating lessons (scoped to a
-- classroom); kind='tutor' is a student asking about one approved page.
chat_session  id, kind('authoring'|'tutor'),
              classroom_id, lesson_id, page_id, user_id,
              title, created_at

chat_message  id, session_id, role('user'|'assistant'),
              content, page_id,        -- set when a message produced a page
              created_at
```

## API Surface

```http
# Classrooms
GET    /classrooms                        Active classrooms with lesson_count
POST   /classrooms                        Create classroom {name, subject, level}
GET    /classrooms/{id}                   Single classroom details
PATCH  /classrooms/{id}                   Update {name, subject, level}
DELETE /classrooms/{id}                   Soft-delete (archived_at) + unlinks volume files

# Lessons
GET    /classrooms/{id}/lessons           Lessons in classroom (query: published_only)
POST   /classrooms/{id}/lessons           Create lesson {title, chapter}
DELETE /lessons/{id}                      Delete lesson + problems + unlinks volume files
POST   /lessons/{id}/publish              Publish lesson (requires all problems approved)
POST   /lessons/{id}/unpublish            Revert lesson status to draft

# Problems
GET    /lessons/{id}/problems             Problems (query: approved_only, returns image_path, job)
POST   /lessons/{id}/problems             Queue text problem {text, level} -> {problem_id, job_id}
POST   /lessons/{id}/problems/image       Upload photo (multipart with optional text, level) -> {problem_id, job_id, image_path}
DELETE /problems/{id}                     Delete problem + unlinks volume files + revokes publish

# Pages & Reviews
GET    /pages/{id}                        Page metadata, html_path, checks
POST   /pages/{id}/review                 Approve or reject {action, note, seconds_on_page}
POST   /pages/{id}/ask                    Ask a question about an approved page {question}

# Jobs
GET    /jobs/{id}                         Job state, stage, progress
GET    /jobs/{id}/events                  SSE stream for real-time stage & checks updates
```

## Invariants worth writing down

**`kit_version` is load-bearing, not bookkeeping.** It is what makes "improve the
shell, re-execute every past page" possible, and that has already paid off
repeatedly — most recently a draw-in fix that took five of six 3D pages from
completely static to animated, and a fix that repaired a page rendering as two
stacked frames, both without regenerating anything. Store it, and keep the
ability to re-run a page against a newer kit. That is what `job.kind='recheck'`
and `page.superseded_by` are for.

**Page HTML is never served by the API.** It is written to the shared storage
volume and served by the `pages` origin, embedded with `sandbox="allow-scripts"`
and *without* `allow-same-origin`. Generated pages run model-written JavaScript;
the opaque origin is the containment, and it is the reason `checks_json` is
stored here at all — the app cannot read anything out of the page.

**`checks_json` is stored verbatim.** The checker's row shape is
`{N, per, total, moved, far, nlabels, decrowded, contrast, collapsed, errs,
explain, latex, jsx}` plus the animation probe's `pre / zeroSteps / stepCounts /
armed`. Do not normalise it into columns: it changes whenever a check is added,
and every consumer already reads it as a blob.

**A lesson publishes when it has at least one approved problem.** `lesson.status='published'`
is reachable as soon as one problem in the lesson has an approved page — the
rest may still be drafts. Students only see the approved subset; the `problem_count`
returned to students reflects approved-only problems, not the total. This allows
incremental publishing: a teacher can share the first two problems while still
generating the third.

**Revocation on problem deletion or rejection.** If a problem is deleted or
rejected from a published lesson, the lesson's status automatically reverts to
`"draft"` *only if no other approved problems remain*. As long as at least one
approved problem exists, the lesson stays published and students continue to see
the remaining approved problems.

**Volume disk cleanup on deletion.** Deleting classrooms, lessons, or problems
actively unlinks draft HTML files, published HTML files, and uploaded images from
Docker volumes (`/storage` and `/published`) to prevent orphaned storage leaks
on the host.

**Awaiting approval gate avoids 404 races.** `POST /pages/{id}/review` copies the
HTML file from `STORAGE_DIR` to `PUBLISHED_DIR`. The UI must await this response
before switching the iframe src to `/generated/<file>` to avoid racing the server's
filesystem write.

**Never call `sympify()` on model output.** It evaluates its input as Python —
remote code execution on the worker. `spikes/spike/render.py` in the research
repo does the unsafe thing and must not be copied.

**Single-call direct multimodal generation for images.** When a teacher uploads a
problem image, the image bytes and teacher text instructions are passed directly
to `kit/generate.py` in a single Gemini call (`Part.from_bytes` + prompt). This
completely eliminates the intermediate text-transcription bottleneck and preserves
high-fidelity diagram details, coordinates, angles, and geometry. The model
transcribes the Thai problem statement directly into `Shell.page({ title, problem })`,
which the worker extracts and populates into `problem.extracted_text` for teacher
review before publishing.

## The worker wraps the kit; it does not reimplement it

`kit/generate.py` and `kit/checks/check.mjs` already work, are measured, and
produce exactly the artefacts this schema stores. The worker shells out to them
and records the result. Rewriting generation as service code would fork the thing
the whole research repo exists to keep honest.

```
job(generate) → kit/generate.py → page html + raw
              → check.mjs --json → checks_json
              → thumbnail        → thumb_path
              → page.status = 'ready'
```

`extract` is performed directly inside the generate job by the multimodal model,
restating what it read into `problem.extracted_text` before generation starts. That
string is displayed alongside the draft card as the primary verification against
misread problems.
