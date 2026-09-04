/* Two real forms in place of the window.prompt() shortcuts ClassroomList.tsx
 * and ClassroomLayout.tsx used to open "สร้างห้องเรียน" / "สร้างบทเรียน" with.
 *
 * There is no Figma frame for either — the five designed screens don't cover
 * a compose step — so this is built from the design's own parts (Input,
 * Select, Button from components/ui.tsx; the modal-scrim/modal-card shell
 * ClassroomSettings.tsx's delete confirmation already established) rather
 * than a new visual language.
 *
 * Modal, not a routed page: creating a classroom or a lesson is a short,
 * single-purpose action taken from a list a teacher is already looking at —
 * ClassroomList or a classroom's own lesson tab — and a modal keeps them on
 * that list (with its full context: which classroom, which tab) instead of
 * navigating away and back. It's also the same shape the app already commits
 * to for the one other dialog it has (delete confirmation), so a second
 * dialog for creation reads as the same product rather than a different
 * interaction pattern bolted on next to it.
 *
 * Both keep the thing the brief calls out as load-bearing: createClassroom /
 * createLesson (lib/classroom.ts) are async and return the id the API
 * issued when it's up. The submit handlers await that promise and disable
 * the form while it's in flight — the previous prompt() flow read this
 * value synchronously, and skipping the await here would be the same "post a
 * local id nobody on the server has heard of" bug the git history for that
 * file already had once. */
import { useRef, useState, type FormEvent } from "react";
import { Button, Input, Select } from "./ui";
import { ModalDialog } from "./Modal";
import { createClassroom, createLesson } from "../lib/classroom";
import "./creation-modals.css";

const LEVELS = ["ม.1", "ม.2", "ม.3", "ม.4", "ม.5", "ม.6"];

export function CreateClassroomModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (classroomId: string) => void;
}) {
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [level, setLevel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("กรุณาใส่ชื่อห้องเรียน");
      nameRef.current?.focus();
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const classroom = await createClassroom(trimmedName, subject.trim(), level || undefined);
      onCreated(classroom.id);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalDialog onClose={onClose} initialFocusRef={nameRef} labelledBy="create-classroom-title" className="form-modal-card">
      <h2 id="create-classroom-title" className="modal-title form-modal-title">
        สร้างห้องเรียนใหม่
      </h2>
      <form className="ui-stack" onSubmit={handleSubmit}>
        <Input
          ref={nameRef}
          label="ชื่อห้องเรียน"
          placeholder="เช่น Physics ม.4/1"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          required
        />
        {error ? (
          <p className="form-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <Input
          label="วิชา (ไม่บังคับ)"
          placeholder="เช่น ฟิสิกส์"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={100}
        />
        <Select label="ระดับชั้น (ไม่บังคับ)" value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">ไม่ระบุ</option>
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </Select>

        <div className="classroom-settings-actions">
          <button type="button" className="ui-btn ui-btn-outline" onClick={onClose} disabled={submitting}>
            ยกเลิก
          </button>
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? "กำลังสร้าง…" : "สร้างห้องเรียน"}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

export function CreateLessonModal({
  classroomId,
  onClose,
  onCreated,
}: {
  classroomId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [chapter, setChapter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("กรุณาใส่ชื่อบทเรียน");
      titleRef.current?.focus();
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await createLesson(classroomId, trimmedTitle, chapter.trim() || undefined);
      onCreated();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalDialog onClose={onClose} initialFocusRef={titleRef} labelledBy="create-lesson-title" className="form-modal-card">
      <h2 id="create-lesson-title" className="modal-title form-modal-title">
        สร้างบทเรียนใหม่
      </h2>
      <form className="ui-stack" onSubmit={handleSubmit}>
        <Input
          ref={titleRef}
          label="ชื่อบทเรียน"
          placeholder="เช่น บทที่ 1: การเคลื่อนที่แบบโปรเจกไทล์"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={300}
          required
        />
        {error ? (
          <p className="form-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <Input
          label="บทที่ (ไม่บังคับ)"
          placeholder="เช่น บทที่ 1"
          value={chapter}
          onChange={(e) => setChapter(e.target.value)}
          maxLength={100}
        />

        <div className="classroom-settings-actions">
          <button type="button" className="ui-btn ui-btn-outline" onClick={onClose} disabled={submitting}>
            ยกเลิก
          </button>
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? "กำลังสร้าง…" : "สร้างบทเรียน"}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}
