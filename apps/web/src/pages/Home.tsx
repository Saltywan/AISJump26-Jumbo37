import { Link } from "react-router-dom";
import { PAGES } from "../manifest";

export default function Home() {
  return (
    <div className="home">
      <div className="home-head">
        <div className="home-head-row">
          <p className="brand">
            <span className="brand-mark">
              Jump<span className="accent">AIS</span>
            </span>
          </p>
          <Link to="/teacher" className="ghost-btn">
            สำหรับครู
          </Link>
        </div>
        <p className="home-sub">เลือกโจทย์เพื่อดูเฉลยแบบทีละขั้นตอน</p>
      </div>
      <div className="grid">
        {PAGES.map((p) => (
          <Link key={p.file} className="card" to={`/legacy/p/${encodeURIComponent(p.file)}`}>
            <p className="card-title">{p.title}</p>
            {p.level && <span className="card-level">{p.level}</span>}
          </Link>
        ))}
      </div>
    </div>
  );
}
