import { Routes, Route, Navigate } from "react-router-dom";
import Home from "./pages/Home";
import Viewer from "./pages/Viewer";
import Teacher from "./pages/Teacher";
import Review from "./pages/Review";
import Login from "./pages/Login";
import ClassroomList from "./pages/teacher/ClassroomList";
import ClassroomLayout from "./pages/teacher/ClassroomLayout";
import ClassroomLessons from "./pages/teacher/ClassroomLessons";
import ClassroomStudents from "./pages/teacher/ClassroomStudents";
import ClassroomSettings from "./pages/teacher/ClassroomSettings";
import TeacherChat from "./pages/chat/TeacherChat";
import StudentClassrooms from "./pages/student/StudentClassrooms";
import StudentClassroomLessons from "./pages/student/StudentClassroomLessons";
import StudentLessonChat from "./pages/student/StudentLessonChat";
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
      <Route path="/t" element={user ? <ClassroomList /> : <Navigate to="/login" replace />} />
      <Route path="/t/c/:classroomId" element={<ClassroomLayout />}>
        <Route index element={<Navigate to="lessons" replace />} />
        <Route path="lessons" element={<ClassroomLessons />} />
        <Route path="students" element={<ClassroomStudents />} />
        <Route path="settings" element={<ClassroomSettings />} />
      </Route>
      {/* teacher AI-chat generation flow (Figma 35:629 "New Chat", 35:675
          "Chat") — see src/pages/chat/TeacherChat.tsx. This is where the
          confirmation-before-publish gate lives (docs/BUILD-PLAN.html
          section 04). Not yet linked from ClassroomLessons.tsx's
          "ดูและสร้างสื่อการสอน" card action (that file is out of scope here),
          so for now it's reached by URL / by continuing a thread from the
          sidebar's own "สร้างโจทย์ใหม่" button. */}
      <Route
        path="/t/c/:classroomId/lessons/:lessonId/chat"
        element={user ? <TeacherChat /> : <Navigate to="/login" replace />}
      />
      <Route
        path="/t/c/:classroomId/lessons/:lessonId/chat/:threadId"
        element={user ? <TeacherChat /> : <Navigate to="/login" replace />}
      />

      <Route path="/s" element={user ? <StudentClassrooms /> : <Navigate to="/login" replace />} />
      <Route
        path="/s/c/:classroomId"
        element={user ? <StudentClassroomLessons /> : <Navigate to="/login" replace />}
      />
      <Route
        path="/s/c/:classroomId/lessons/:lessonId"
        element={user ? <StudentLessonChat /> : <Navigate to="/login" replace />}
      />

      {/* the existing, working screens */}
      <Route path="/" element={<Home />} />
      <Route path="/p/:file" element={<Viewer />} />
      <Route path="/teacher" element={<Teacher />} />
      <Route path="/teacher/review/:id" element={<Review />} />
    </Routes>
  );
}
