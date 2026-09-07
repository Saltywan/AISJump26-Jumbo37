/* Home. Three things, in the order a returning user cares about them: what
 * you just made and haven't filed anywhere, the folders you've organised
 * yourself, and the published books everyone shares. No classrooms, no
 * lessons — every signed-in user gets the same shape of home screen now
 * (see the section pivot); the only thing that changes with role is whether
 * "จัดการคลังข้อสอบ" shows up in the navbar.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { Button, Card, PageHeader, SectionTitle } from "../components/ui";
import { ProblemArtifact } from "../components/ProblemArtifact";
import { CreateSectionModal } from "../components/SectionModals";
import { useSession } from "../lib/session";
import { api, type ApiProblem, type ApiSection } from "../lib/api";
import plusSmallUrl from "../icons/plus-small.svg";

export default function Library() {
  const { user } = useSession();
  const navigate = useNavigate();
  const [mine, setMine] = useState<ApiSection[]>([]);
  const [global, setGlobal] = useState<ApiSection[]>([]);
  const [problems, setProblems] = useState<ApiProblem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  async function refresh() {
    const [mySections, globalSections, myProblems] = await Promise.all([
      api.mySections(),
      api.globalSections(),
      api.myProblems(),
    ]);
    setMine(mySections);
    setGlobal(globalSections);
    setProblems(myProblems);
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
    // Any problem still generating needs its stage refreshed without a full
    // page action to trigger it — cheap poll rather than an EventSource per
    // in-flight row (see /new for the one live SSE connection this app opens).
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!user) return null;

  const myRoots = mine.filter((s) => !s.parent_id);
  const globalRoots = global.filter((s) => !s.parent_id && s.status === "published");
  const inbox = problems.filter((p) => !p.section_id);

  return (
    <AppShell>
      <PageHeader
        title={`สวัสดี, ${user.name}`}
        subtitle="สร้างสื่อการสอนใหม่ หรือดูสิ่งที่คุณเคยสร้างไว้"
        action={
          <Button variant="primary" onClick={() => navigate("/new")}>
            <img src={plusSmallUrl} alt="" width={20} height={20} />
            <span>สร้างโจทย์ใหม่</span>
          </Button>
        }
      />

      {loading ? (
        <p className="classroom-empty">กำลังโหลด…</p>
      ) : (
        <>
          {inbox.length > 0 ? (
            <section className="library-section">
              <SectionTitle>โจทย์ที่ยังไม่จัดหมวดหมู่</SectionTitle>
              <div className="library-problem-grid">
                {inbox.map((p) => (
                  <ProblemArtifact key={p.id} problem={p} isAdmin={false} isMine onChanged={refresh} />
                ))}
              </div>
            </section>
          ) : null}

          <section className="library-section">
            <div className="library-section-head">
              <SectionTitle>โฟลเดอร์ของฉัน</SectionTitle>
              <button type="button" className="ui-btn ui-btn-quiet" onClick={() => setShowCreate(true)}>
                <img src={plusSmallUrl} alt="" width={18} height={18} />
                <span>สร้างโฟลเดอร์</span>
              </button>
            </div>
            {myRoots.length === 0 ? (
              <p className="classroom-empty">ยังไม่มีโฟลเดอร์ — จัดกลุ่มโจทย์ที่สร้างไว้ได้ที่นี่</p>
            ) : (
              <div className="library-folder-grid">
                {myRoots.map((s) => (
                  <Card key={s.id} title={s.title} meta={s.kind ?? undefined} to={`/library/section/${s.id}`} />
                ))}
              </div>
            )}
          </section>

          <section className="library-section">
            <SectionTitle>คลังข้อสอบ</SectionTitle>
            {globalRoots.length === 0 ? (
              <p className="classroom-empty">ยังไม่มีหนังสือที่เผยแพร่</p>
            ) : (
              <div className="library-folder-grid">
                {globalRoots.map((s) => (
                  <Card key={s.id} title={s.title} meta={s.kind ?? undefined} to={`/library/section/${s.id}`} />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {showCreate ? (
        <CreateSectionModal
          scope="personal"
          onClose={() => setShowCreate(false)}
          onCreated={(s) => {
            setShowCreate(false);
            navigate(`/library/section/${s.id}`);
          }}
        />
      ) : null}
    </AppShell>
  );
}
