/* Manage one global section: its child sections, and the problems filed
 * directly under it. Three ways to add a problem, cheapest first — typed
 * text, a bulk paste (one problem per line), a photo — because a real
 * exam book is forty questions and adding them one at a time through a chat
 * screen is the reason a global library stays empty otherwise.
 */
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AppShell } from "../../components/AppShell";
import { Button, Card, Input, PageHeader, SectionTitle, Textarea } from "../../components/ui";
import { ProblemArtifact } from "../../components/ProblemArtifact";
import { CreateSectionModal } from "../../components/SectionModals";
import { useSession } from "../../lib/session";
import { api, type ApiProblem, type ApiSection } from "../../lib/api";
import angleSmallLeftUrl from "../../icons/angle-small-left.svg";
import plusSmallUrl from "../../icons/plus-small.svg";
import imageUrl from "../../icons/image.svg";

export default function AdminSection() {
  const { user } = useSession();
  const { sectionId = "" } = useParams();
  const navigate = useNavigate();
  const [all, setAll] = useState<ApiSection[]>([]);
  const [problems, setProblems] = useState<ApiProblem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const [text, setText] = useState("");
  const [bulk, setBulk] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    const [global, probs] = await Promise.all([api.globalSections(), api.sectionProblems(sectionId)]);
    setAll(global);
    setProblems(probs);
    setLoading(false);
  }

  useEffect(() => {
    setLoading(true);
    void refresh();
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionId]);

  if (!user) return null;
  if (user.role !== "admin") {
    return (
      <AppShell>
        <p className="classroom-empty">หน้านี้สำหรับผู้ดูแลระบบเท่านั้น</p>
      </AppShell>
    );
  }
  if (loading) {
    return (
      <AppShell>
        <p className="classroom-empty">กำลังโหลด…</p>
      </AppShell>
    );
  }

  const section = all.find((s) => s.id === sectionId);
  if (!section) {
    return (
      <AppShell>
        <p className="classroom-empty">ไม่พบหมวดหมู่นี้</p>
      </AppShell>
    );
  }

  const children = all.filter((s) => s.parent_id === section.id);
  const parent = section.parent_id ? all.find((s) => s.id === section.parent_id) : undefined;

  async function submitOne(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || submitting) return;
    setSubmitting(true);
    try {
      await api.addGlobalProblem(sectionId, { text: t });
      setText("");
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function submitBulk() {
    const lines = bulk
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      await api.addGlobalProblemsBulk(sectionId, lines.map((text) => ({ text })));
      setBulk("");
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function onFileChosen(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || submitting) return;
    setSubmitting(true);
    try {
      await api.addGlobalProblemImage(sectionId, file);
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell>
      <button type="button" className="chat-sidebar-back section-back" onClick={() => navigate(parent ? `/admin/section/${parent.id}` : "/admin")}>
        <img src={angleSmallLeftUrl} alt="" width={20} height={20} />
        <span>กลับไปยัง {parent ? parent.title : "คลังข้อสอบ"}</span>
      </button>

      <PageHeader title={section.title} subtitle={section.kind ?? undefined} />

      <section className="library-section">
        <div className="library-section-head">
          <SectionTitle>หมวดหมู่ย่อย</SectionTitle>
          <button type="button" className="ui-btn ui-btn-quiet" onClick={() => setShowCreate(true)}>
            <img src={plusSmallUrl} alt="" width={18} height={18} />
            <span>สร้างหมวดหมู่ย่อย</span>
          </button>
        </div>
        {children.length === 0 ? (
          <p className="classroom-empty">ยังไม่มีหมวดหมู่ย่อย</p>
        ) : (
          <div className="library-folder-grid">
            {children.map((s) => (
              <Card key={s.id} title={s.title} meta={s.kind ?? undefined} to={`/admin/section/${s.id}`} />
            ))}
          </div>
        )}
      </section>

      <section className="library-section">
        <SectionTitle>เพิ่มโจทย์</SectionTitle>
        <div className="admin-add-forms">
          <form className="ui-stack admin-add-form" onSubmit={submitOne}>
            <Input
              label="โจทย์เดี่ยว"
              placeholder="พิมพ์โจทย์ที่นี่"
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={submitting}
            />
            <div className="admin-add-form-row">
              <input ref={fileInputRef} type="file" accept="image/*" className="chat-input-file" onChange={(e) => void onFileChosen(e)} />
              <button type="button" className="ui-btn ui-btn-outline" disabled={submitting} onClick={() => fileInputRef.current?.click()}>
                <img src={imageUrl} alt="" width={18} height={18} />
                <span>แนบรูปแทน</span>
              </button>
              <Button type="submit" variant="primary" disabled={submitting || !text.trim()}>
                เพิ่ม
              </Button>
            </div>
          </form>

          <div className="ui-stack admin-add-form">
            <Textarea
              label="เพิ่มหลายข้อพร้อมกัน (บรรทัดละ 1 ข้อ)"
              placeholder={"โจทย์ข้อที่ 1\nโจทย์ข้อที่ 2\nโจทย์ข้อที่ 3"}
              rows={4}
              value={bulk}
              onChange={(e) => setBulk(e.target.value)}
              disabled={submitting}
            />
            <Button variant="outline" disabled={submitting || !bulk.trim()} onClick={() => void submitBulk()}>
              {submitting ? "กำลังส่ง…" : "เพิ่มทั้งหมด"}
            </Button>
          </div>
        </div>
      </section>

      <section className="library-section">
        <SectionTitle>โจทย์ในหมวดนี้ ({problems.length})</SectionTitle>
        {problems.length === 0 ? (
          <p className="classroom-empty">ยังไม่มีโจทย์</p>
        ) : (
          <div className="library-problem-grid">
            {problems.map((p) => (
              <ProblemArtifact key={p.id} problem={p} isAdmin isMine={false} onChanged={refresh} />
            ))}
          </div>
        )}
      </section>

      {showCreate ? (
        <CreateSectionModal
          scope="global"
          parentId={section.id}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void refresh();
          }}
        />
      ) : null}
    </AppShell>
  );
}
