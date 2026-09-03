// Same situation as lib/store.ts (the review queue) and for the same reason:
// stage 2 has no API and no database, but this data still has to survive a
// reload during a demo. It lives in localStorage until stage 3 gives it a
// real backend.
//
// The shape is deliberately close to what a `classrooms` / `lessons` /
// `students` table set would look like: flat arrays of records with a
// classroomId foreign key, rather than classrooms nesting their lessons and
// students inline. That means the eventual API swap only has to replace the
// functions below (load/persist/create/update/delete), not the screens that
// call them — they already read "the lessons whose classroomId is this one"
// rather than "this classroom's .lessons array".
//
// What it is NOT: shared across teachers or devices, and not validated —
// there is no server rejecting a duplicate name or an empty one. A real API
// fixes both in stage 3.
import { useSyncExternalStore } from "react";
import { PAGES } from "../manifest";

export interface Classroom {
  id: string;
  name: string;
  description: string;
  createdAt: number;
}

export interface Lesson {
  id: string;
  classroomId: string;
  title: string;
  /** Manifest files (see ../manifest) this lesson's problems are drawn from —
   *  this is what lets "ดูและสร้างสื่อการสอน" open a real generated page
   *  instead of a dead link. */
  pageFiles: string[];
  createdAt: number;
}

export interface Student {
  id: string;
  classroomId: string;
  name: string;
  createdAt: number;
}

interface State {
  classrooms: Classroom[];
  lessons: Lesson[];
  students: Student[];
}

const STORAGE_KEY = "jumpais.classroom.v1";

/* Demo student names — Thai, mixed ด.ช./ด.ญ., the design's own
   "ด.ญ. สมหญิง สุดแสนสวย" kept as the first one so the built app reads like
   the design rather than diverging from it. */
const STUDENT_NAMES = [
  "ด.ญ. สมหญิง สุดแสนสวย",
  "ด.ช. สมชาย ตั้งใจเรียน",
  "ด.ญ. พิมพ์ชนก แสงทอง",
  "ด.ช. ธนกร ศรีสุข",
  "ด.ญ. กมลชนก วงศ์ไทย",
  "ด.ช. ปิยะพงษ์ รักเรียน",
];

function lessonSeed(
  classroomId: string,
  n: number,
  title: string,
  pageFiles: string[],
  offsetMs: number
): Lesson {
  return {
    id: `${classroomId}-lesson-${n}`,
    classroomId,
    title,
    pageFiles: pageFiles.filter((f) => PAGES.some((p) => p.file === f)),
    createdAt: Date.now() - offsetMs,
  };
}

/* The five chapters every seeded Physics classroom starts with, each backed
   by a handful of the 68 real generated pages (the physics ones) so a lesson
   can actually be opened rather than just displayed. Lesson 1's title and
   file are picked to match the Figma copy ("บทที่ 1: การเคลื่อนที่แบบโปรเจกไทล์"). */
const CHAPTER_TEMPLATES: { title: string; pageFiles: string[] }[] = [
  {
    title: "บทที่ 1: การเคลื่อนที่แบบโปรเจกไทล์",
    pageFiles: ["p02_1.html", "p02_2.html", "p01_1.html", "p01_2.html", "p07_1.html"],
  },
  {
    title: "บทที่ 2: พลังงานและงาน",
    pageFiles: ["p03_1.html", "p03_2.html", "p04_1.html", "p05_1.html", "p07_2.html"],
  },
  {
    title: "บทที่ 3: สมดุลกลและการชน",
    pageFiles: ["p08_1.html", "p08_2.html", "p09_1.html", "p09_2.html", "p06_1.html"],
  },
  {
    title: "บทที่ 4: คลื่นและแสง",
    pageFiles: ["p10_1.html", "p10_2.html", "p11_1.html", "p16_1.html", "p17_1.html"],
  },
  {
    title: "บทที่ 5: ไฟฟ้าและแม่เหล็ก",
    pageFiles: ["p12_1.html", "p12_2.html", "p13_1.html", "p14_1.html", "p14_2.html"],
  },
];

function seedClassroom(
  id: string,
  name: string,
  description: string,
  createdOffsetMs: number
): { classroom: Classroom; lessons: Lesson[]; students: Student[] } {
  const classroom: Classroom = {
    id,
    name,
    description,
    createdAt: Date.now() - createdOffsetMs,
  };
  // Larger offsetMs -> older createdAt, so lesson 1 (i = 0) gets the largest
  // offset and sorts first once lessonsOf() orders ascending by createdAt.
  const lessons = CHAPTER_TEMPLATES.map((c, i) =>
    lessonSeed(id, i + 1, c.title, c.pageFiles, createdOffsetMs + (CHAPTER_TEMPLATES.length - i) * 60_000)
  );
  const students = STUDENT_NAMES.map((name, i) => ({
    id: `${id}-student-${i}`,
    classroomId: id,
    name,
    createdAt: Date.now() - createdOffsetMs - (STUDENT_NAMES.length - i) * 30_000,
  }));
  return { classroom, lessons, students };
}

function seed(): State {
  // Three sections, so the classroom list has more than one identical card —
  // the design repeats "Physics ม.4/1" five times as a placeholder, but a
  // real list of one teacher's classrooms wouldn't be five copies of the
  // same room. The first keeps the design's exact name and copy.
  const a = seedClassroom("c-phys-4-1", "Physics ม.4/1", "ห้องเรียนวิชาฟิสิกส์", 7 * 86_400_000);
  const b = seedClassroom("c-phys-4-2", "Physics ม.4/2", "ห้องเรียนวิชาฟิสิกส์", 5 * 86_400_000);
  const c = seedClassroom("c-phys-5-1", "Physics ม.5/1", "ห้องเรียนวิชาฟิสิกส์ ม.5", 2 * 86_400_000);
  return {
    classrooms: [a.classroom, b.classroom, c.classroom],
    lessons: [...a.lessons, ...b.lessons, ...c.lessons],
    students: [...a.students, ...b.students, ...c.students],
  };
}

function load(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seed();
    const parsed = JSON.parse(raw) as Partial<State>;
    if (!Array.isArray(parsed.classrooms)) return seed();
    return {
      classrooms: parsed.classrooms,
      lessons: Array.isArray(parsed.lessons) ? parsed.lessons : [],
      students: Array.isArray(parsed.students) ? parsed.students : [],
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

export function useClassroomStore(): State {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function classroomOf(state: State, id: string): Classroom | undefined {
  return state.classrooms.find((c) => c.id === id);
}

export function lessonsOf(state: State, classroomId: string): Lesson[] {
  return state.lessons
    .filter((l) => l.classroomId === classroomId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function studentsOf(state: State, classroomId: string): Student[] {
  return state.students.filter((s) => s.classroomId === classroomId);
}

let genCounter = 0;
function genId(prefix: string) {
  genCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${genCounter}`;
}

export function createClassroom(name: string, description: string): Classroom {
  const classroom: Classroom = {
    id: genId("c"),
    name,
    description,
    createdAt: Date.now(),
  };
  set({ ...state, classrooms: [...state.classrooms, classroom] });
  return classroom;
}

export function updateClassroom(id: string, fields: Partial<Pick<Classroom, "name" | "description">>) {
  set({
    ...state,
    classrooms: state.classrooms.map((c) => (c.id === id ? { ...c, ...fields } : c)),
  });
}

/** Deletes the classroom and cascades to its lessons and students — the
 *  shape a real API's ON DELETE CASCADE would give for free. */
export function deleteClassroom(id: string) {
  set({
    classrooms: state.classrooms.filter((c) => c.id !== id),
    lessons: state.lessons.filter((l) => l.classroomId !== id),
    students: state.students.filter((s) => s.classroomId !== id),
  });
}

/** New lessons borrow a handful of real generated pages at random, the same
 *  honest stand-in the review queue uses for "generation" (see
 *  lib/store.ts's submitProblem): there is no model in this stage, so a
 *  freshly created lesson still opens something real. */
export function createLesson(classroomId: string, title: string): Lesson {
  const pool = PAGES.map((p) => p.file);
  const pageFiles: string[] = [];
  for (let i = 0; i < 5 && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    pageFiles.push(pool.splice(idx, 1)[0]);
  }
  const lesson: Lesson = {
    id: genId("lesson"),
    classroomId,
    title,
    pageFiles,
    createdAt: Date.now(),
  };
  set({ ...state, lessons: [...state.lessons, lesson] });
  return lesson;
}

export function removeStudent(id: string) {
  set({ ...state, students: state.students.filter((s) => s.id !== id) });
}

export function resetClassroomDemoData() {
  set(seed());
}
