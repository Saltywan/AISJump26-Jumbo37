import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PAGES } from "../manifest";
import { PAGES_URL } from "../lib/api";

export default function Viewer() {
  const { file } = useParams<{ file: string }>();
  const [loaded, setLoaded] = useState(false);

  // Only ever embed a page from our own fixture list — never build an iframe
  // src straight from whatever happened to be in the URL.
  const entry = useMemo(() => PAGES.find((p) => p.file === file), [file]);

  if (!entry) {
    return (
      <div className="not-found">
        <p>ไม่พบโจทย์นี้</p>
        <Link to="/legacy">กลับไปหน้ารายการ</Link>
      </div>
    );
  }

  const src = `${PAGES_URL}/pages/${entry.file}`;

  return (
    <div className="viewer">
      <div className="viewer-bar">
        <Link to="/legacy" className="back-btn" aria-label="กลับ">
          ‹
        </Link>
        <span className="viewer-title">{entry.title}</span>
        {entry.level && <span className="viewer-level">{entry.level}</span>}
      </div>
      <div className="viewer-stage">
        {!loaded && (
          <div className="viewer-loading">
            <span className="spinner" />
            กำลังโหลดโจทย์…
          </div>
        )}
        <iframe
          key={entry.file}
          className="viewer-frame"
          src={src}
          title={entry.title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
        />
      </div>
    </div>
  );
}
