import { Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Viewer from "./pages/Viewer";
import Teacher from "./pages/Teacher";
import Review from "./pages/Review";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/p/:file" element={<Viewer />} />
      <Route path="/teacher" element={<Teacher />} />
      <Route path="/teacher/review/:id" element={<Review />} />
    </Routes>
  );
}
