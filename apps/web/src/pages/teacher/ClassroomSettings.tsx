/* Figma: Setting -- Classroom (nodes 48:5042 and 60:7009 for the
   delete-confirmation overlay) — name/description fields, save, and a
   destructive delete flow. The confirmation is a real dialog: it traps
   focus, Escape closes it, and the destructive action sits visually apart
   from Cancel (danger-tinted, on the right, per the design). */
import { useRef, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { Button, Input } from "../../components/ui";
import { ModalDialog } from "../../components/Modal";
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
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <ModalDialog
      onClose={onCancel}
      initialFocusRef={cancelRef}
      role="alertdialog"
      labelledBy="delete-classroom-title"
      describedBy="delete-classroom-desc"
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
    </ModalDialog>
  );
}
