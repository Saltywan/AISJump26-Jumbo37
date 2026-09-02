// Stage 2 has no API and no database (see docs/BUILD-PLAN.html section 02,
// stage 2). Approve/reject state has to live somewhere anyway, so it lives in
// localStorage, deliberately, for two reasons:
//
//   1. A demo reloads. Refreshing the tab mid-review (or the browser
//      restarting between a rehearsal and the real thing) must not wipe out
//      a queue teachers have already worked through — plain in-memory
//      (useState/Context) state would reset on every reload, which is a much
//      worse failure mode for a live demo than a stale localStorage entry.
//   2. It's the shape the eventual API will have anyway: an append-only log
//      of review events (id, reviewer, action, note, seconds_on_page,
//      created_at — see docs/PLAN.md's `review` table), keyed by page, with
//      "current status" derived as "the last event". Writing it that way now
//      means stage 3 replaces the storage layer, not the data model.
//
// What it is NOT: shared across reviewers, or across devices. Two teachers on
// two machines would each have their own queue. That's a real limitation and
// exactly what a database fixes in stage 3 — noted here rather than hidden.
import { useSyncExternalStore } from "react";
import { PAGES, type PageEntry } from "../manifest";

export type JobState = "generating" | "ready";
export type ReviewAction = "approved" | "rejected";
export type QueueStatus = "generating" | "pending" | "approved" | "rejected";

export interface QueueItem {
  id: string;
  /** Fixture file backing this item's page + checker output. */
  file: string;
  title: string;
  level: string;
  source: "fixture" | "submitted";
  submittedText?: string;
  createdAt: number;
  job: JobState;
  /** Set only while job === "generating"; the fake pipeline flips it then. */
  readyAt?: number;
}

export interface ReviewEvent {
  id: string;
  pageId: string;
  reviewer: string;
  action: ReviewAction;
  note: string;
  secondsOnPage: number;
  createdAt: number;
}

interface State {
  queue: QueueItem[];
  reviews: ReviewEvent[];
  reviewerName: string;
}

const STORAGE_KEY = "jumpais.stage2.v1";
const FIXTURE_FILES = PAGES.map((p: PageEntry) => p.file);

function seed(): State {
  return {
    queue: PAGES.map((p, i) => ({
      id: p.file,
      file: p.file,
      title: p.title,
      level: p.level,
      source: "fixture" as const,
      // Spread creation times out so a fresh queue still sorts sensibly by
      // "submitted" order (oldest fixture first) without every item sharing
      // one timestamp.
      createdAt: Date.now() - (PAGES.length - i) * 60_000,
      job: "ready" as const,
    })),
    reviews: [],
    reviewerName: "",
  };
}

function load(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seed();
    const parsed = JSON.parse(raw) as Partial<State>;
    if (!Array.isArray(parsed.queue)) return seed();
    return {
      queue: parsed.queue,
      reviews: Array.isArray(parsed.reviews) ? parsed.reviews : [],
      reviewerName: typeof parsed.reviewerName === "string" ? parsed.reviewerName : "",
    };
  } catch {
    return seed();
  }
}

let state: State = load();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage full or unavailable (private mode) — state still works for
    // this tab, it just won't survive a reload. Not worth surfacing in a demo.
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

export function useStore(): State {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Latest review event for a page, if any — the one that decides its status. */
export function latestReview(reviews: ReviewEvent[], pageId: string): ReviewEvent | undefined {
  let best: ReviewEvent | undefined;
  for (const r of reviews) {
    if (r.pageId === pageId && (!best || r.createdAt > best.createdAt)) best = r;
  }
  return best;
}

export function statusOf(item: QueueItem, reviews: ReviewEvent[]): QueueStatus {
  if (item.job === "generating") return "generating";
  const r = latestReview(reviews, item.id);
  return r ? r.action : "pending";
}

/** All prior review events for one page, oldest first — the audit trail. */
export function historyOf(reviews: ReviewEvent[], pageId: string): ReviewEvent[] {
  return reviews.filter((r) => r.pageId === pageId).sort((a, b) => a.createdAt - b.createdAt);
}

let genCounter = 0;
function genId(prefix: string) {
  genCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${genCounter}`;
}

/** Fake the front of the pipeline: text in, a queue item appears, then —
 *  after a short simulated wait — it borrows one of the 68 real generated
 *  pages (and its real checker output) to review. There is no model in stage
 *  2, so "generation" here is honest about being a stand-in: the submitted
 *  text is kept and shown, but the page and its checks are a real fixture,
 *  not something produced from that text. */
export function submitProblem(text: string) {
  const file = FIXTURE_FILES[Math.floor(Math.random() * FIXTURE_FILES.length)];
  const fixture = PAGES.find((p) => p.file === file)!;
  const id = genId("sub");
  const delayMs = 1800 + Math.random() * 2200;
  const item: QueueItem = {
    id,
    file,
    title: fixture.title,
    level: fixture.level,
    source: "submitted",
    submittedText: text,
    createdAt: Date.now(),
    job: "generating",
    readyAt: Date.now() + delayMs,
  };
  set({ ...state, queue: [item, ...state.queue] });
}

/** Flip any items whose fake generation delay has elapsed. Call this on a
 *  timer; it's a no-op when nothing is generating. */
export function tickJobs() {
  const now = Date.now();
  let changed = false;
  const queue = state.queue.map((item) => {
    if (item.job === "generating" && item.readyAt !== undefined && item.readyAt <= now) {
      changed = true;
      const { readyAt: _readyAt, ...rest } = item;
      return { ...rest, job: "ready" as const };
    }
    return item;
  });
  if (changed) set({ ...state, queue });
}

export function hasPendingJobs(): boolean {
  return state.queue.some((i) => i.job === "generating");
}

export function recordReview(pageId: string, action: ReviewAction, note: string, secondsOnPage: number) {
  const event: ReviewEvent = {
    id: genId("rev"),
    pageId,
    reviewer: state.reviewerName || "ผู้ตรวจ",
    action,
    note,
    secondsOnPage,
    createdAt: Date.now(),
  };
  set({ ...state, reviews: [...state.reviews, event] });
}

export function setReviewerName(name: string) {
  set({ ...state, reviewerName: name });
}

export function resetDemoData() {
  set(seed());
}
