import { Routes, Route, Navigate } from "react-router-dom";
import Home from "./pages/Home";
import Viewer from "./pages/Viewer";
import Teacher from "./pages/Teacher";
import Review from "./pages/Review";
import Login from "./pages/Login";
import { useSession } from "./lib/session";

/* Routes follow the Figma information architecture: /login, then a teacher
   space under /t and a student space under /s. The stage-1 and stage-2 screens
   (/, /p/:file, /teacher, /teacher/review/:id) are still mounted while the
   designed screens are built out around them — they hold the working
   student viewer and the review report, and they will be folded into the new
   IA rather than thrown away. */
export default function App() {
  const { user } = useSession();
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      {/* designed screens land here as they are built */}
      <Route path="/t" element={user ? <Teacher /> : <Navigate to="/login" replace />} />
      <Route path="/s" element={user ? <Home /> : <Navigate to="/login" replace />} />

      {/* the existing, working screens */}
      <Route path="/" element={<Home />} />
      <Route path="/p/:file" element={<Viewer />} />
      <Route path="/teacher" element={<Teacher />} />
      <Route path="/teacher/review/:id" element={<Review />} />
    </Routes>
  );
}
