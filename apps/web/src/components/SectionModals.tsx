/* One creation form for both scopes — a personal folder and a global book or
 * topic are the same Section row (see apps/api/app/models.py), so they get
 * the same dialog rather than two near-identical ones drifting apart. Built
 * from Login/CreationModals' own parts (ModalDialog, Input) and
 * creation-modals.css, same reasoning as that file's own header comment: a
 * second dialog built from the app's real classes reads as the same product.
 */
import { useRef, useState, type FormEvent } from "react";
import { Button, Input } from "./ui";
import { ModalDialog } from "./Modal";
import { api, type ApiSection, type Scope } from "../lib/api";
import "./creation-modals.css";

export function CreateSectionModal({
  scope,
  parentId,
  onClose,
  onCreated,
}: {
  scope: Scope;
  /** null/undefined for a root — a "book", or a top-level personal folder. */
  parentId?: string | null;
  onClose: () => void;
  onCreated: (section: ApiSection) => void;
}) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const trimmed = title.trim();
    if (!trimmed) {
      setError("กรุณาใส่ชื่อ");
      titleRef.current?.focus();
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const section = await api.createSection({
        scope,
        parent_id: parentId ?? undefined,
        title: trimmed,
        kind: kind.trim() || undefined,
      });
      onCreated(section);
    } catch {
      setError("สร้างไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setSubmitting(false);
    }
  }

  const isRoot = !parentId;
  const label = scope === "global" ? (isRoot ? "หนังสือ/คลังใหม่" : "หัวข้อย่อยใหม่") : isRoot ? "โฟลเดอร์ใหม่" : "หัวข้อย่อยใหม่";

  return (
    <ModalDialog onClose={onClose} initialFocusRef={titleRef} labelledBy="create-section-title" className="form-modal-card">
      <h2 id="create-section-title" className="modal-title form-modal-title">
        {label}
      </h2>
      <form className="ui-stack" onSubmit={handleSubmit}>
        <Input
          ref={titleRef}
          label="ชื่อ"
          placeholder={isRoot && scope === "global" ? "เช่น A-Level คณิต ย้อนหลัง" : "เช่น ตรีโกณมิติ"}
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
          label="ประเภท (ไม่บังคับ)"
          placeholder="เช่น book, topic, ปี, บทที่"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          maxLength={50}
        />

        <div className="classroom-settings-actions">
          <button type="button" className="ui-btn ui-btn-outline" onClick={onClose} disabled={submitting}>
            ยกเลิก
          </button>
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? "กำลังสร้าง…" : "สร้าง"}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}
