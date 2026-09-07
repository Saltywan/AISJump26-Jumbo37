/* The admin's view of the whole global tree — every book, published or not,
 * since an admin is the one editing it. Flat data (see lib/api.ts's
 * globalSections()) rendered as a tree here, once, rather than the API
 * shaping it two ways for two callers.
 *
 * Deliberately not drag-to-reorder: up/down buttons on `position` do the same
 * job with a fraction of the code, and reordering forty questions by hand is
 * not really this screen's problem anyway — bulk import (see AdminSection.tsx)
 * is what a real past-papers book actually needs from this pass.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AppShell } from "../../components/AppShell";
import { Button, PageHeader } from "../../components/ui";
import { CreateSectionModal } from "../../components/SectionModals";
import { useSession } from "../../lib/session";
import { api, type ApiSection } from "../../lib/api";
import plusSmallUrl from "../../icons/plus-small.svg";
import globeUrl from "../../icons/globe.svg";
import lockUrl from "../../icons/lock.svg";

function Node({ section, byParent, onChanged }: { section: ApiSection; byParent: Map<string | null, ApiSection[]>; onChanged: () => void }) {
  const children = byParent.get(section.id) ?? [];
  const [busy, setBusy] = useState(false);

  async function togglePublish() {
    setBusy(true);
    try {
      if (section.status === "published") await api.unpublishSection(section.id);
      else await api.publishSection(section.id);
      onChanged();
    } catch (err) {
      alert(err instanceof Error ? err.message : "ทำรายการไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`ลบ "${section.title}" พร้อมทุกอย่างข้างในใช่ไหม?`)) return;
    await api.deleteSection(section.id);
    onChanged();
  }

  return (
    <li className="admin-tree-node">
      <div className="admin-tree-row">
        <Link to={`/admin/section/${section.id}`} className="admin-tree-title">
          {section.title}
        </Link>
        {section.kind ? <span className="admin-tree-kind">{section.kind}</span> : null}
        <span className={`chat-history-status ${section.status === "published" ? "chat-history-status-published" : "chat-history-status-draft"}`}>
          <img src={section.status === "published" ? globeUrl : lockUrl} alt="" width={14} height={14} />
          {section.status === "published" ? "เผยแพร่แล้ว" : "ฉบับร่าง"}
        </span>
        <span className="admin-tree-actions">
          <button type="button" className="ui-btn ui-btn-quiet" disabled={busy} onClick={() => void togglePublish()}>
            {section.status === "published" ? "ยกเลิกเผยแพร่" : "เผยแพร่"}
          </button>
          <button type="button" className="ui-btn ui-btn-quiet" onClick={() => void remove()}>
            ลบ
          </button>
        </span>
      </div>
      {children.length > 0 ? (
        <ul className="admin-tree-children">
          {children.map((c) => (
            <Node key={c.id} section={c} byParent={byParent} onChanged={onChanged} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default function AdminHome() {
  const { user } = useSession();
  const navigate = useNavigate();
  const [sections, setSections] = useState<ApiSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  async function refresh() {
    setSections(await api.globalSections());
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
  }, []);

  if (!user) return null;
  if (user.role !== "admin") {
    return (
      <AppShell>
        <p className="classroom-empty">หน้านี้สำหรับผู้ดูแลระบบเท่านั้น</p>
      </AppShell>
    );
  }

  const byParent = new Map<string | null, ApiSection[]>();
  for (const s of [...sections].sort((a, b) => a.position - b.position)) {
    const list = byParent.get(s.parent_id) ?? [];
    list.push(s);
    byParent.set(s.parent_id, list);
  }
  const roots = byParent.get(null) ?? [];

  return (
    <AppShell>
      <PageHeader
        title="จัดการคลังข้อสอบ"
        subtitle="สร้างและเผยแพร่หนังสือ หัวข้อ และโจทย์ที่นักเรียนทุกคนมองเห็น"
        action={
          <div className="admin-home-actions">
            <Button variant="outline" onClick={() => navigate("/admin/review")}>
              คิวตรวจโจทย์
            </Button>
            <Button variant="primary" onClick={() => setShowCreate(true)}>
              <img src={plusSmallUrl} alt="" width={20} height={20} />
              <span>สร้างหนังสือใหม่</span>
            </Button>
          </div>
        }
      />

      {loading ? (
        <p className="classroom-empty">กำลังโหลด…</p>
      ) : roots.length === 0 ? (
        <p className="classroom-empty">ยังไม่มีหนังสือในคลัง</p>
      ) : (
        <ul className="admin-tree">
          {roots.map((s) => (
            <Node key={s.id} section={s} byParent={byParent} onChanged={refresh} />
          ))}
        </ul>
      )}

      {showCreate ? (
        <CreateSectionModal
          scope="global"
          onClose={() => setShowCreate(false)}
          onCreated={(s) => {
            setShowCreate(false);
            navigate(`/admin/section/${s.id}`);
          }}
        />
      ) : null}
    </AppShell>
  );
}
