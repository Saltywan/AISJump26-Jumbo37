import { Routes, Route, Navigate } from "react-router-dom";
import Home from "./pages/Home";
import Viewer from "./pages/Viewer";
import Teacher from "./pages/Teacher";
import Review from "./pages/Review";
import Login from "./pages/Login";
import Register from "./pages/Register";
import Library from "./pages/Library";
import SectionView from "./pages/SectionView";
import Generate from "./pages/Generate";
import AdminHome from "./pages/admin/AdminHome";
import AdminSection from "./pages/admin/AdminSection";
import AdminReview from "./pages/admin/AdminReview";
import { useSession } from "./lib/session";

/* Role-free routing — every signed-in user lands on the same home screen
 * (/library) now that there is no classroom to split teacher from student
 * (see the section pivot). Admin gets an extra branch under /admin; nothing
 * else changes by role. `resolved` guards every route: the initial
 * GET /auth/me is still in flight for a moment on first load, and bouncing to
 * /login before it settles would boot a genuinely signed-in user off their
 * own reload.
 */
function Guard({ children, adminOnly = false }: { children: JSX.Element; adminOnly?: boolean }) {
  const { user, resolved } = useSession();
  if (!resolved) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && user.role !== "admin") return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  const { user, resolved } = useSession();
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />

      <Route path="/" element={<Guard><Library /></Guard>} />
      <Route path="/library/section/:sectionId" element={<Guard><SectionView /></Guard>} />
      <Route path="/new" element={<Guard><Generate /></Guard>} />

      <Route path="/admin" element={<Guard adminOnly><AdminHome /></Guard>} />
      <Route path="/admin/review" element={<Guard adminOnly><AdminReview /></Guard>} />
      <Route path="/admin/section/:sectionId" element={<Guard adminOnly><AdminSection /></Guard>} />

      {/* The stage-1 and stage-2 screens, kept and walled off rather than
          deleted: a second, self-consistent generate-review-approve flow over
          fixtures, with their own store, predating the classroom design and
          now predating this pivot too. Untouched by either — no auth guard,
          same as before, since they never depended on a session to begin
          with. */}
      <Route path="/legacy" element={<Home />} />
      <Route path="/legacy/p/:file" element={<Viewer />} />
      <Route path="/legacy/teacher" element={<Teacher />} />
      <Route path="/legacy/teacher/review/:id" element={<Review />} />

      <Route path="*" element={resolved ? <Navigate to={user ? "/" : "/login"} replace /> : null} />
    </Routes>
  );
}
