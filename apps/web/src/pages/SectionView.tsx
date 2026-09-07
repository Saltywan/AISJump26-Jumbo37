/* One section, browsed rather than managed — works for a personal folder and
 * a global topic/book alike, since both are the same Section row. Shows its
 * child sections as cards and its own problems as artifacts; the "add a
 * problem here" action only appears when the section is actually the
 * viewer's own personal one — global content is admin-managed, from /admin,
 * not from here (see the section pivot's "no non-admin writes to global"
 * decision).
 *
 * There is no GET /sections/{id} — the API only lists ("mine" / "global"),
 * on purpose: a POC-scale tree fits in one list fetch, and a second
 * single-item endpoint would just be a second place the same row's shape
 * could drift from the list's. So this fetches both lists and looks the
 * section up client-side, same as Library.tsx already does for the roots. */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { Button, Card, PageHeader, SectionTitle } from "../components/ui";
import { ProblemArtifact } from "../components/ProblemArtifact";
import { CreateSectionModal } from "../components/SectionModals";
import { useSession } from "../lib/session";
import { api, type ApiProblem, type ApiSection } from "../lib/api";
import angleSmallLeftUrl from "../icons/angle-small-left.svg";
import plusSmallUrl from "../icons/plus-small.svg";

export default function SectionView() {
  const { user } = useSession();
  const { sectionId = "" } = useParams();
  const navigate = useNavigate();
  const [all, setAll] = useState<ApiSection[]>([]);
  const [problems, setProblems] = useState<ApiProblem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  async function refresh() {
    const [mine, global] = await Promise.all([api.mySections(), api.globalSections()]);
    setAll([...mine, ...global]);
    try {
      setProblems(await api.sectionProblems(sectionId));
    } catch {
      setProblems([]);
    }
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
        <p className="classroom-empty">ไม่พบหมวดหมู่นี้ — อาจถูกลบไปแล้ว หรือยังไม่เผยแพร่</p>
      </AppShell>
    );
  }

  const isMine = section.scope === "personal" && section.owner_id === user.id;
  const children = all.filter((s) => s.parent_id === section.id && (isMine || s.status === "published" || user.role === "admin"));
  const parent = section.parent_id ? all.find((s) => s.id === section.parent_id) : undefined;
  const backTo = parent ? `/library/section/${parent.id}` : "/";
  const backLabel = parent ? parent.title : "หน้าแรก";

  return (
    <AppShell>
      <button type="button" className="chat-sidebar-back section-back" onClick={() => navigate(backTo)}>
        <img src={angleSmallLeftUrl} alt="" width={20} height={20} />
        <span>กลับไปยัง {backLabel}</span>
      </button>

      <PageHeader
        title={section.title}
        subtitle={section.kind ?? (section.scope === "global" ? "คลังข้อสอบกลาง" : "โฟลเดอร์ของฉัน")}
        action={
          isMine ? (
            <Button variant="primary" onClick={() => navigate(`/new?section=${section.id}`)}>
              <img src={plusSmallUrl} alt="" width={20} height={20} />
              <span>สร้างโจทย์ในนี้</span>
            </Button>
          ) : undefined
        }
      />

      <section className="library-section">
        <div className="library-section-head">
          <SectionTitle>หมวดหมู่ย่อย</SectionTitle>
          {isMine ? (
            <button type="button" className="ui-btn ui-btn-quiet" onClick={() => setShowCreate(true)}>
              <img src={plusSmallUrl} alt="" width={18} height={18} />
              <span>สร้างหมวดหมู่ย่อย</span>
            </button>
          ) : null}
        </div>
        {children.length === 0 ? (
          <p className="classroom-empty">ยังไม่มีหมวดหมู่ย่อย</p>
        ) : (
          <div className="library-folder-grid">
            {children.map((s) => (
              <Card key={s.id} title={s.title} meta={s.kind ?? undefined} to={`/library/section/${s.id}`} />
            ))}
          </div>
        )}
      </section>

      <section className="library-section">
        <SectionTitle>โจทย์ในหมวดนี้</SectionTitle>
        {problems.length === 0 ? (
          <p className="classroom-empty">ยังไม่มีโจทย์ในหมวดนี้</p>
        ) : (
          <div className="library-problem-grid">
            {problems.map((p) => (
              <ProblemArtifact key={p.id} problem={p} isAdmin={user.role === "admin"} isMine={isMine} onChanged={refresh} />
            ))}
          </div>
        )}
      </section>

      {showCreate ? (
        <CreateSectionModal
          scope="personal"
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
