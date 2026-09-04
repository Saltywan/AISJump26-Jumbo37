// Backs the two teacher "Chat" screens (Figma nodes 35:629 "New Chat" and
// 35:675 "Chat" — see src/pages/chat/TeacherChat.tsx) and, downstream, what a
// student sees in src/pages/student/StudentLessonChat.tsx.
//
// Same reasoning as lib/store.ts and lib/classroom.ts: stage 2 has no API, so
// this lives in localStorage until stage 3 gives it a real backend. The shape
// again mirrors what a real table would look like — a flat list of threads
// keyed by (classroomId, lessonId), not lessons nesting their threads inline.
//
// This file does NOT modify lib/classroom.ts (out of scope for this pass —
// another agent owns it). It only reads from it (classroomOf/lessonsOf) and
// keeps its own, additive layer:
//
//   the *product decision that must be honoured*: a freshly generated page is
//   not visible to students the moment it's generated. It sits as a "draft"
//   thread, with its checker report, until a teacher looks at the report
//   AND the page itself and explicitly presses "เผยแพร่ให้นักเรียน" (publish
//   to students) in src/pages/chat/TeacherChat.tsx. Only then does
//   studentVisibleFiles() below add its file to what a lesson's students see.
//
// See docs/BUILD-PLAN.html section 04: every automated check here (see
// checks.ts / severity.ts) can be green on a page that is visibly wrong, so
// the gate is a human looking at the rendered page, not a rule engine.
import { useSyncExternalStore } from "react";
import { PAGES } from "../manifest";
import { api, isLive, pageSrc, watchJob } from "./api";

export type ThreadStatus = "generating" | "draft" | "published";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  imageUrl?: string;
  createdAt: number;
}

export interface ChatThread {
  id: string;
  classroomId: string;
  lessonId: string;
  /** The problem text as typed/asked — also the thread's title in the sidebar. */
  title: string;
  status: ThreadStatus;
  createdAt: number;
  messages: ChatMessage[];
  /** Fixture file backing the generated page once ready — see submitPrompt. */
  file?: string;
  /** Set only while status === "generating"; the fake pipeline flips it then. */
  readyAt?: number;

  /* Set when the page came from the real backend rather than a fixture. */
  jobId?: string;
  pageId?: string;
  /** When this thread's page first became reviewable (real, backend-issued
   *  pageId in hand). publishThread() measures the gap between this and the
   *  publish click as seconds_on_page — see docs/SCHEMA.md's `review` table.
   *  It is a proxy, not an eye tracker: it can't tell a careful read from a
   *  tab left open, but it is the one signal available without instrumenting
   *  TeacherChat.tsx (out of scope for this pass — another agent owns it),
   *  and a number close to zero is exactly the rubber-stamp case it exists
   *  to surface. */
  readyForReviewAt?: number;
  /** Stage reported by the worker while generating — the waiting screen shows
   *  it instead of a spinner, because a 30-90s spinner kills a live demo and
   *  the checks are genuinely interesting to watch land. */
  stage?: string;
  /** How the page is served: worker output lives under /generated/, the
   *  fixtures under /pages/. */
  kind?: "generated" | "fixture";
  /** Why this thread is a stand-in, when it is one. Shown on the card rather
   *  than quietly pretending the model ran. */
  demoReason?: string;
  /** In-flight server confirmation flag to prevent double-publish and premature URL flip */
  publishing?: boolean;
  /** Set only for a thread started from a photo (see attachImageJob): what the
   *  model read the problem as, straight from the problem row's
   *  extracted_text. A misread photo produces a flawless page solving the
   *  wrong problem that every automated check passes — this string, next to
   *  the confirm control, is the only thing that makes that catchable. Absent
   *  for a text-typed thread, where the typed text already is the record. */
  extractedText?: string;
  problemId?: string;
  imagePath?: string;
  checks?: unknown | null;
}

interface State {
  threads: ChatThread[];
}

const STORAGE_KEY = "jumpais.chat.v1";
const FIXTURE_FILES = PAGES.map((p) => p.file);

function load(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { threads: [] };
    const parsed = JSON.parse(raw) as Partial<State>;
    return { threads: Array.isArray(parsed.threads) ? parsed.threads : [] };
  } catch {
    return { threads: [] };
  }
}

let state: State = load();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // private mode / storage full: state still works for this tab
  }
}

function set(next: State) {
  state = next;
  persist();
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot() {
  return state;
}

export function useChatStore(): State {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function threadsOf(state: State, classroomId: string, lessonId: string): ChatThread[] {
  return state.threads
    .filter((t) => t.classroomId === classroomId && t.lessonId === lessonId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function threadOf(state: State, id: string): ChatThread | undefined {
  return state.threads.find((t) => t.id === id);
}

let genCounter = 0;
function genId(prefix: string) {
  genCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${genCounter}`;
}

/** Start a new thread: the prompt appears immediately as a user bubble, the
 *  page "generates" after a short fake delay (see tickThreads), the same
 *  honest stand-in lib/store.ts uses — a real fixture page and its real
 *  checker output, not something produced from the typed text. */
/* Real generation.
 *
 * Posts the problem, then streams the job. The thread goes to "draft" when a
 * page exists — a draft, not an approval: a teacher still has to look at it.
 * If the backend is unreachable or the job fails, this falls back to the
 * fixture stand-in and records why on the thread, so the card can say so
 * instead of passing a canned page off as a fresh one.
 */
export async function attachLiveJob(
  threadId: string,
  _classroomId: string,
  lessonId: string,
  text: string
): Promise<void> {
  // Cleared synchronously, before the first `await` below ever yields
  // control back to the event loop. TeacherChat.tsx's submit() always calls
  // this immediately after submitPrompt() creates the thread, in the same
  // call stack, so nothing else can run in between — clearing readyAt only
  // after isLive()/addProblem() resolve further down (as this used to) is a
  // real race, not a formality: tickThreads() runs on its own 400ms timer,
  // the fake pipeline's delay is 1.4-3.2s, and a real generation reliably
  // takes tens of seconds, so tickThreads regularly won that race and flipped
  // the thread to a fixture "draft" before this function ever got a pageId.
  // That failure is invisible: the thread still said "draft" with a plausible
  // page in it, just one with no jobId or pageId behind it, which is exactly
  // the shape publishThread() below reads as "this thread never went live"
  // and silently confirms only in localStorage. Every branch past this point
  // now finishes the thread itself rather than leaning on tickThreads' timer,
  // since the thing that timer was for — a beat before the fixture "arrives"
  // — no longer applies once this has taken over.
  patch(threadId, { readyAt: undefined });

  if (!(await isLive())) {
    patch(threadId, {
      status: "draft",
      demoReason: "เซิร์ฟเวอร์ไม่พร้อมใช้งาน — แสดงตัวอย่างที่เตรียมไว้",
    });
    return;
  }

  try {
    const { problem_id, job_id } = await api.addProblem(lessonId, { text });
    patch(threadId, { problemId: problem_id });
    watchGeneration(threadId, job_id);
  } catch (err) {
    patch(threadId, {
      status: "draft",
      demoReason: `ส่งงานไม่สำเร็จ (${String(err).slice(0, 60)}) — แสดงตัวอย่างที่เตรียมไว้`,
    });
  }
}

/** Everything past "a job_id exists" is identical whether that job came from
 *  a typed problem (attachLiveJob) or a photo (attachImageJob below) — stream
 *  progress, then land on a draft thread holding the resulting page. Split out
 *  so the image path attaches to this exact same watcher instead of growing a
 *  second, parallel way of following a job to its page (the brief is explicit
 *  that it shouldn't). */
/** Re-attach to jobs still running from a previous visit.
 *
 * The job lives in Postgres, so generation genuinely continues while nobody is
 * looking — but the SSE watcher is a component's, and it dies when the screen
 * unmounts. Come back to a thread and it would sit on "กำลังสร้าง…" forever
 * with nothing listening, even though the page had finished minutes ago.
 *
 * Call this on mount. It is safe to call repeatedly: a thread already being
 * watched in this tab is skipped. */
const watching = new Set<string>();

export function resumeWatchers() {
  for (const t of state.threads) {
    if (t.status !== "generating" || !t.jobId) continue;
    if (watching.has(t.id)) continue;
    watching.add(t.id);
    watchGeneration(t.id, t.jobId);
  }
}

function watchGeneration(threadId: string, jobId: string) {
  watching.add(threadId);
  patch(threadId, { jobId, stage: "queued", demoReason: undefined });

  watchJob(
    jobId,
    (e) => patch(threadId, { stage: e.stage ?? e.state }),
    async (e) => {
      const pageId = (e.progress as { page_id?: string } | null)?.page_id;
      if (e.state === "failed" || !pageId) {
        patch(threadId, {
          status: "draft",
          stage: undefined,
          demoReason: e.error?.slice(0, 160) ?? "งานสร้างไม่สำเร็จ — แสดงตัวอย่างที่เตรียมไว้",
        });
        return;
      }
      try {
        const page = await api.page(pageId);
        const t = threadOf(state, threadId);
        let extracted = t?.extractedText;
        if (t?.lessonId && t?.problemId && !extracted) {
          try {
            const problems = await api.problems(t.lessonId);
            const prob = problems.find((p) => p.id === t.problemId);
            if (prob?.source === "image" && (prob.extracted_text || prob.text)) {
              extracted = (prob.extracted_text || prob.text) ?? undefined;
            }
          } catch {
            // best effort
          }
        }
        patch(threadId, {
          status: "draft",
          stage: undefined,
          pageId,
          file: page.html_path ?? undefined,
          kind: "generated",
          demoReason: undefined,
          readyForReviewAt: Date.now(),
          checks: page.checks ?? null,
          ...(extracted ? { extractedText: extracted } : {}),
        });
      } catch {
        patch(threadId, { status: "draft", stage: undefined });
      }
    }
  );
}

/** Same product decision as attachLiveJob, for a photo instead of typed text:
 *  the thread still starts as "generating" and lands on the exact same draft
 *  review card once a page exists (see watchGeneration above). The one thing
 *  a photo adds is extractedText: what the model read the problem as. Per
 *  apps/api/app/main.py's add_problem_image docstring, that restatement is
 *  written by the worker's restate_image() *inside* the same generate job,
 *  before generation runs on the text it produces — so it can land anywhere
 *  from "almost immediately" to "most of the way through the 30-90s job",
 *  not at upload time. loadExtractedText below polls for it independently of
 *  watchGeneration's own progress, since it comes from the problem row, not
 *  the job's progress payload. See ChatThread.extractedText's docstring for
 *  why that string matters more than it looks. */
export async function attachImageJob(
  threadId: string,
  _classroomId: string,
  lessonId: string,
  file: File,
  text?: string
): Promise<void> {
  patch(threadId, { readyAt: undefined });

  if (!(await isLive())) {
    patch(threadId, {
      status: "draft",
      demoReason: "เซิร์ฟเวอร์ไม่พร้อมใช้งาน — แสดงตัวอย่างที่เตรียมไว้",
    });
    return;
  }

  try {
    const { problem_id, job_id, image_path } = await api.uploadProblemImage(lessonId, file, text);
    const t = state.threads.find((th) => th.id === threadId);
    const updatedMessages = t?.messages.map((m, idx) =>
      idx === 0 && !m.imageUrl && image_path ? { ...m, imageUrl: pageSrc(image_path, "draft") } : m
    );
    patch(threadId, {
      problemId: problem_id,
      imagePath: image_path,
      ...(updatedMessages ? { messages: updatedMessages } : {}),
    });
    watchGeneration(threadId, job_id);
    void loadExtractedText(threadId, lessonId, problem_id);
  } catch (err) {
    patch(threadId, {
      status: "draft",
      demoReason: `อัปโหลดรูปไม่สำเร็จ (${String(err).slice(0, 60)}) — แสดงตัวอย่างที่เตรียมไว้`,
    });
  }
}

/** extracted_text lives on the problem row, not the job or the page, and
 *  there is no single-problem endpoint — so this reads it off the same
 *  GET /lessons/{id}/problems list_problems already returns (its `text` field
 *  IS extracted_text: main.py fills it as `prob.extracted_text or
 *  prob.raw_text`, and an image-sourced problem has neither until the worker
 *  writes it — see restate_image() in the docstring above). That write
 *  happens partway through the same generate job, at a point this module has
 *  no other visibility into, so this polls on its own clock rather than
 *  piggybacking on watchGeneration's job events — up to ~2 minutes, generously
 *  past the 30-90s a generation normally takes, then gives up quietly.
 *  Failures (network hiccups, a slow first request racing the DB write) are
 *  swallowed the same way: the draft card simply omits the box rather than
 *  showing something fabricated or stale. */
async function loadExtractedText(threadId: string, lessonId: string, problemId: string, attempt = 0): Promise<void> {
  try {
    const rows = await api.problems(lessonId);
    const row = rows.find((p) => p.id === problemId);
    if (row?.text) {
      patch(threadId, { extractedText: row.text });
      return;
    }
  } catch {
    /* retried below, up to the attempt limit */
  }
  if (attempt < 40) {
    setTimeout(() => void loadExtractedText(threadId, lessonId, problemId, attempt + 1), 3000);
  }
}

function patch(id: string, fields: Partial<ChatThread>) {
  set({ threads: state.threads.map((t) => (t.id === id ? { ...t, ...fields } : t)) });
}

function createThread(classroomId: string, lessonId: string, title: string, bubbleText: string, imageUrl?: string): ChatThread {
  const file = FIXTURE_FILES[Math.floor(Math.random() * FIXTURE_FILES.length)];
  const now = Date.now();
  const delayMs = 1400 + Math.random() * 1800;
  const thread: ChatThread = {
    id: genId("thread"),
    classroomId,
    lessonId,
    title,
    status: "generating",
    createdAt: now,
    messages: [{ id: genId("msg"), role: "user", text: bubbleText, imageUrl, createdAt: now }],
    file,
    kind: "fixture",
    readyAt: now + delayMs,
  };
  set({ threads: [thread, ...state.threads] });
  return thread;
}

export function submitPrompt(classroomId: string, lessonId: string, text: string): ChatThread {
  return createThread(classroomId, lessonId, text, text);
}

/** The photo equivalent of submitPrompt — same synchronous "generating" thread
 *  so the screen moves immediately, before attachImageJob (lib/chat.ts) even
 *  knows whether the backend is reachable. The title is a placeholder until
 *  extractedText (see attachImageJob) comes back with something more useful;
 *  TeacherChat.tsx doesn't wait on it to navigate. */
export function submitImagePrompt(classroomId: string, lessonId: string, text?: string, imageUrl?: string): ChatThread {
  const title = text?.trim() ? text.trim() : "โจทย์จากรูปภาพ";
  const bubble = text?.trim() ? text.trim() : "";
  return createThread(classroomId, lessonId, title, bubble, imageUrl);
}

/** Flip any threads whose fake generation delay has elapsed. Call on a timer;
 *  a no-op when nothing is generating (see lib/store.ts's tickJobs). */
export function tickThreads() {
  const now = Date.now();
  let changed = false;
  const threads = state.threads.map((t) => {
    if (t.status === "generating" && t.readyAt !== undefined && t.readyAt <= now) {
      changed = true;
      const { readyAt: _readyAt, ...rest } = t;
      return {
        ...rest,
        status: "draft" as const,
        messages: [
          ...rest.messages,
          {
            id: genId("msg"),
            role: "assistant" as const,
            text: "สร้างสื่อแอนิเมชันเสร็จแล้วครับ",
            createdAt: now,
          },
        ],
      };
    }
    return t;
  });
  if (changed) set({ threads });
}

export function hasPendingThreads(): boolean {
  return state.threads.some((t) => t.status === "generating");
}

/** The confirmation step itself — called from TeacherChat.tsx exactly as
 *  before (`onClick={() => publishThread(thread.id)}`), now wired to the real
 *  gate instead of only flipping a local field.
 *
 * localStorage is flipped first and unconditionally: it is what
 * studentVisibleFiles() reads, so a thread with no live pageId (a fixture
 * stand-in, or a backend that never came up — see attachLiveJob) still
 * publishes for a single-browser demo, matching the old behaviour exactly.
 *
 * When the thread has a real pageId, that flip is provisional: this also
 * POSTs the confirmation to the API — first `review(pageId, "approved")` with
 * seconds_on_page measured from when the page first became reviewable (see
 * readyForReviewAt), then `publishLesson`, which only actually flips the
 * lesson's server-side `status` once every problem in it has an approved
 * page. A 409 there just means a sibling thread in this lesson is still a
 * draft — not an error from this thread's point of view — so it is swallowed.
 * Postgres, not localStorage, is what a second device's student view reads
 * (see pages/student/*), so this network call is the one that actually makes
 * the page reachable across devices; the local flip alone would look
 * published only on this browser. */
export async function publishThread(id: string): Promise<void> {
  const thread = state.threads.find((t) => t.id === id);
  if (!thread || thread.status === "published" || thread.publishing) return;

  if (thread.pageId && (await isLive())) {
    patch(id, { publishing: true });
    try {
      const secondsOnPage = thread.readyForReviewAt
        ? Math.max(0, Math.round((Date.now() - thread.readyForReviewAt) / 1000))
        : undefined;
      await api.review(thread.pageId, { action: "approved", seconds_on_page: secondsOnPage });
      await api.publishLesson(thread.lessonId).catch(() => {
        /* lesson has other unapproved problems — expected, not this thread's problem */
      });
      // The server copied the file into PUBLISHED_DIR inside review(), so now
      // and only now is /generated/<file> guaranteed to exist. Flipping status
      // here ensures the iframe's src swap will not race the file copy and 404.
      patch(id, { status: "published", publishing: false, demoReason: undefined });
    } catch (err) {
      patch(id, {
        publishing: false,
        demoReason: `ยืนยันกับเซิร์ฟเวอร์ไม่สำเร็จ (${String(err).slice(0, 60)}) — ยังคงเป็นฉบับร่าง`,
      });
    }
  } else {
    // Offline / fixture fallback
    patch(id, { status: "published", publishing: false });
  }
}

/** Reverts a publish — "เผยแพร่แล้ว" back to "ฉบับร่าง". Not in the Figma
 *  design (which only shows the two states as a fact, not a control to leave
 *  "published"), but withholding it would mean a mis-click can never be
 *  undone from this screen, which is a worse failure mode for a live demo.
 *
 * Mirrors publishThread: local flip always happens (offline/fixture case),
 * and when the thread has a real lessonId on a live backend this also calls
 * unpublishLesson — see that endpoint's docstring for why it revokes
 * visibility only and leaves any page's approval and review history alone. */
export async function unpublishThread(id: string): Promise<void> {
  const thread = state.threads.find((t) => t.id === id);
  if (!thread) return;

  patch(id, { status: "draft" });
  if (!thread.pageId || !(await isLive())) return;

  try {
    await api.review(thread.pageId, { action: "rejected", note: "ยกเลิกการเผยแพร่โดยผู้สอน" });
    const hasOtherPublished = state.threads.some(
      (t) => t.id !== id && t.lessonId === thread.lessonId && t.status === "published"
    );
    if (!hasOtherPublished) {
      await api.unpublishLesson(thread.lessonId);
    }
  } catch {
    /* local state already reverted; nothing more useful to surface here */
  }
}

/** The kebab menu on a history row only implements this one action (of the
 *  three the Figma annotation lists — rename/pin/delete): delete. Rename and
 *  pin would need their own UI with no clear place in the five designed
 *  screens, so they're left out rather than bolted on. */
export async function deleteThread(id: string): Promise<void> {
  const thread = state.threads.find((t) => t.id === id);
  const probId = thread?.problemId || (thread && !thread.id.startsWith("thread-") ? thread.id : undefined);
  set({ threads: state.threads.filter((t) => t.id !== id) });
  if (probId && (await isLive())) {
    try {
      await api.deleteProblem(probId);
    } catch {
      /* ignore */
    }
  }
}

export async function syncLessonProblems(classroomId: string, lessonId: string): Promise<void> {
  if (!(await isLive())) return;
  try {
    const problems = await api.problems(lessonId, false);
    let changed = false;
    let nextThreads = [...state.threads];

    for (const prob of problems) {
      const existingIdx = nextThreads.findIndex(
        (t) =>
          t.id === prob.id ||
          t.problemId === prob.id ||
          (t.lessonId === lessonId && t.title === (prob.text || "") && !t.problemId)
      );

      const serverStatus: ThreadStatus =
        prob.page?.status === "approved"
          ? "published"
          : prob.page?.status === "ready"
          ? "draft"
          : prob.job?.state === "queued" || prob.job?.state === "running"
          ? "generating"
          : "draft";

      const createdTime = prob.created_at
        ? new Date(prob.created_at).getTime()
        : Date.now() - prob.position * 1000;

      if (existingIdx >= 0) {
        const t = nextThreads[existingIdx];
        let threadChanged = false;
        const updated: ChatThread = { ...t };

        if (!t.problemId) {
          updated.problemId = prob.id;
          threadChanged = true;
        }
        if (t.status !== "published" && serverStatus === "published") {
          updated.status = "published";
          threadChanged = true;
        }
        if (prob.page?.html_path && (!t.file || t.kind !== "generated")) {
          updated.file = prob.page.html_path;
          updated.kind = "generated";
          updated.pageId = prob.page.id;
          threadChanged = true;
        }
        // Recover threads stuck at "generating" after a page-refresh or
        // browser close.  The server job finished but the SSE listener was
        // gone, so the thread never transitioned.  Two cases:
        //   1. Page exists → job succeeded, transition to serverStatus.
        //   2. No running job and no page → job failed silently, fall back
        //      to draft so the card stops showing an eternal spinner.
        if (t.status === "generating" && serverStatus !== "generating") {
          updated.status = serverStatus;
          updated.stage = undefined;
          threadChanged = true;
        }
        if (prob.page?.checks && !t.checks) {
          updated.checks = prob.page.checks;
          threadChanged = true;
        }
        if (prob.image_path && !t.imagePath) {
          updated.imagePath = prob.image_path;
          threadChanged = true;
        }
        if (prob.source === "image" && prob.text && !t.extractedText) {
          updated.extractedText = prob.text;
          threadChanged = true;
        }
        if (prob.job && (prob.job.state === "queued" || prob.job.state === "running")) {
          if (t.stage !== (prob.job.stage ?? prob.job.state)) {
            updated.stage = prob.job.stage ?? prob.job.state;
            threadChanged = true;
          }
          if (t.jobId !== prob.job.id) {
            updated.jobId = prob.job.id;
            threadChanged = true;
          }
          if (!watching.has(t.id)) {
            watchGeneration(t.id, prob.job.id);
          }
        }
        if (threadChanged) {
          nextThreads[existingIdx] = updated;
          changed = true;
        }
      } else {
        const thread: ChatThread = {
          id: prob.id,
          problemId: prob.id,
          classroomId,
          lessonId,
          title: prob.text || (prob.source === "image" ? "โจทย์จากรูปภาพ" : `โจทย์ข้อที่ ${prob.position + 1}`),
          status: serverStatus,
          createdAt: createdTime,
          messages: [
            {
              id: `msg-${prob.id}-u`,
              role: "user",
              text: prob.text || (prob.source === "image" ? "📷 แนบรูปโจทย์" : `โจทย์ข้อที่ ${prob.position + 1}`),
              createdAt: createdTime,
            },
            ...(prob.page
              ? [
                  {
                    id: `msg-${prob.id}-a`,
                    role: "assistant" as const,
                    text: "สร้างสื่อแอนิเมชันเสร็จแล้วครับ",
                    createdAt: createdTime,
                  },
                ]
              : []),
          ],
          file: prob.page?.html_path ?? undefined,
          kind: prob.page ? "generated" : undefined,
          pageId: prob.page?.id,
          jobId: prob.job?.id,
          stage: prob.job?.stage ?? prob.job?.state,
          imagePath: prob.image_path ?? undefined,
          extractedText: prob.source === "image" ? (prob.text ?? undefined) : undefined,
          checks: prob.page?.checks ?? null,
        };
        nextThreads.push(thread);
        changed = true;
        if (serverStatus === "generating" && prob.job?.id) {
          watchGeneration(thread.id, prob.job.id);
        }
      }
    }

    if (changed) {
      set({ threads: nextThreads });
    }
  } catch {
    /* ignore offline */
  }
}

export function addUserMessage(threadId: string, text: string) {
  set({
    threads: state.threads.map((t) =>
      t.id === threadId
        ? { ...t, messages: [...t.messages, { id: genId("msg"), role: "user" as const, text, createdAt: Date.now() }] }
        : t
    ),
  });
}

export function addAssistantMessage(threadId: string, text: string) {
  set({
    threads: state.threads.map((t) =>
      t.id === threadId
        ? {
            ...t,
            messages: [...t.messages, { id: genId("msg"), role: "assistant" as const, text, createdAt: Date.now() }],
          }
        : t
    ),
  });
}

/** What a student sees for a lesson: the lesson's own seeded pageFiles (see
 *  lib/classroom.ts — treated as already-published canon, the same way the
 *  68-page fixture set is canon for the old stage-1 viewer) plus any thread
 *  this module has published for that lesson. This is the one place the
 *  confirmation gate actually takes effect: a "generating" or "draft" thread's
 *  file never appears here. */
export function studentVisibleFiles(state: State, classroomId: string, lessonId: string, seeded: string[]): string[] {
  const published = state.threads
    .filter((t) => t.classroomId === classroomId && t.lessonId === lessonId && t.status === "published" && t.file)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((t) => t.file!);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of [...seeded, ...published]) {
    if (!seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}
