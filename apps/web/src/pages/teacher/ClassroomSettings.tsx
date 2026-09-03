/* Figma: Setting -- Classroom (nodes 48:5042 and 60:7009 for the
   delete-confirmation overlay) — name/description fields, save, and a
   destructive delete flow. The confirmation is a real dialog: it traps
   focus, Escape closes it, and the destructive action sits visually apart
   from Cancel (danger-tinted, on the right, per the design). */
import { useEffect, useRef, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { Button, Input } from "../../components/ui";
import type { Classroom } from "../../lib/classroom";
import { deleteClassroom, updateClassroom } from "../../lib/classroom";
import trashUrl from "../../icons/trash.svg";
import exclamationUrl from "../../icons/exclamation.svg";

export default function ClassroomSettings() {
  const { classroom } = useOutletContext<{ classroom: Classroom }>();
  const navigate = useNavigate();
  const [name, setName] = useState(classroom.name);
  const [description, setDescription] = useState(classroom.description);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saved, setSaved] = useState(false);

  // The fields are seeded from the classroom prop once; if the teacher
  // navigates to a different classroom's settings the component remounts
  // (the route key changes with :classroomId) so this doesn't need to react
  // to classroom changing under it.

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    updateClassroom(classroom.id, { name: name.trim() || classroom.name, description: description.trim() });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  }

  function handleConfirmDelete() {
    deleteClassroom(classroom.id);
    navigate("/t");
  }

  return (
    <form className="ui-stack classroom-settings-form" onSubmit={handleSave}>
      <Input label="ชื่อห้องเรียน" value={name} onChange={(e) => setName(e.target.value)} placeholder={classroom.name} />
      <Input
        label="รายละเอียด"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={classroom.description}
      />

      <div className="classroom-settings-actions">
        <button type="button" className="ui-btn ui-btn-danger-soft" onClick={() => setConfirmOpen(true)}>
          <img src={trashUrl} alt="" width={16} height={16} />
          <span>ลบห้องเรียน</span>
        </button>
        <Button type="submit" variant="primary" className="ui-btn-compact">
          บันทึกการแก้ไข
        </Button>
      </div>
      {saved ? (
        <p className="classroom-saved-note" role="status">
          บันทึกการแก้ไขแล้ว
        </p>
      ) : null}

      {confirmOpen ? (
        <DeleteConfirmModal
          classroomName={classroom.name}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={handleConfirmDelete}
        />
      ) : null}
    </form>
  );
}

function DeleteConfirmModal({
  classroomName,
  onCancel,
  onConfirm,
}: {
  classroomName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus trap: remember what had focus, move focus into the dialog, cycle
  // Tab/Shift+Tab inside it, close on Escape, and restore focus on unmount —
  // the minimum a "real dialog" needs without pulling in a library.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="modal-card"
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-classroom-title"
        aria-describedby="delete-classroom-desc"
      >
        <img src={exclamationUrl} alt="" width={30} height={30} />
        <div className="modal-text">
          <p id="delete-classroom-title" className="modal-title">
            ลบ &ldquo;{classroomName}&rdquo; หรือไม่?
          </p>
          <p id="delete-classroom-desc" className="modal-desc">
            ห้องเรียนนี้จะถูกลบและไม่สามารถกู้คืนได้
          </p>
        </div>
        <div className="modal-actions">
          <button type="button" ref={cancelRef} className="ui-btn ui-btn-outline modal-btn" onClick={onCancel}>
            ยกเลิก
          </button>
          <button type="button" className="ui-btn ui-btn-danger-soft modal-btn" onClick={onConfirm}>
            ลบห้องเรียน
          </button>
        </div>
      </div>
    </div>
  );
}
