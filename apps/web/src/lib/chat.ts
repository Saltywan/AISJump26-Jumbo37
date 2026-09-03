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

export type ThreadStatus = "generating" | "draft" | "published";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
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
export function submitPrompt(classroomId: string, lessonId: string, text: string): ChatThread {
  const file = FIXTURE_FILES[Math.floor(Math.random() * FIXTURE_FILES.length)];
  const now = Date.now();
  const delayMs = 1400 + Math.random() * 1800;
  const thread: ChatThread = {
    id: genId("thread"),
    classroomId,
    lessonId,
    title: text,
    status: "generating",
    createdAt: now,
    messages: [{ id: genId("msg"), role: "user", text, createdAt: now }],
    file,
    readyAt: now + delayMs,
  };
  set({ threads: [thread, ...state.threads] });
  return thread;
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

/** The confirmation step itself. A draft only becomes visible to students
 *  once a teacher calls this — see studentVisibleFiles(). */
export function publishThread(id: string) {
  set({
    threads: state.threads.map((t) => (t.id === id ? { ...t, status: "published" as const } : t)),
  });
}

/** Reverts a publish — "เผยแพร่แล้ว" back to "ฉบับร่าง". Not in the Figma
 *  design (which only shows the two states as a fact, not a control to leave
 *  "published"), but withholding it would mean a mis-click can never be
 *  undone from this screen, which is a worse failure mode for a live demo. */
export function unpublishThread(id: string) {
  set({
    threads: state.threads.map((t) => (t.id === id ? { ...t, status: "draft" as const } : t)),
  });
}

/** The kebab menu on a history row only implements this one action (of the
 *  three the Figma annotation lists — rename/pin/delete): delete. Rename and
 *  pin would need their own UI with no clear place in the five designed
 *  screens, so they're left out rather than bolted on. */
export function deleteThread(id: string) {
  set({ threads: state.threads.filter((t) => t.id !== id) });
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
