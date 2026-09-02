// The 25 fixture pages in apps/pages/static/pages/, hand-listed for stage 1.
// There is no API yet — this file *is* the catalogue. Once problems are
// generated for real (stage 3), this list is replaced by a GET /pages call;
// nothing else in the app should need to change shape when that happens,
// which is why each entry already carries exactly what a real page record
// would (file, title, level).

export interface PageEntry {
  /** filename under the pages origin, e.g. "m1_quadratic.html" */
  file: string;
  /** Thai title, copied from each page's own <title> */
  title: string;
  /** Thai grade level, e.g. "ม.3" */
  level: string;
}

export const PAGES: PageEntry[] = [
  { file: "m1_quadratic.html", title: "กราฟของฟังก์ชันพาราโบลา", level: "ม.3" },
  { file: "m2_circumcircle.html", title: "การสร้างวงกลมล้อมรอบสามเหลี่ยม", level: "ม.4" },
  { file: "m3_matrix.html", title: "ดีเทอร์มิแนนต์และเมทริกซ์ผกผันขนาด 2x2", level: "ม.5" },
  { file: "b1_ellipse.html", title: "วงรี: จุดศูนย์กลาง จุดยอด และโฟกัส", level: "ม.4" },
  { file: "b2_area.html", title: "พื้นที่ปิดล้อมด้วยเส้นโค้งและเส้นตรง", level: "ม.6" },
  { file: "b3_reflect.html", title: "การสะท้อนข้ามเส้นตรง y = x", level: "ม.3" },
  { file: "b4_tangent.html", title: "เส้นสัมผัสวงกลมจากจุดภายนอก", level: "ม.4" },
  { file: "b5_sine.html", title: "กราฟของฟังก์ชันตรีโกณมิติ y = 3 sin(2x)", level: "ม.5" },
  { file: "s1_incircle__medium.html", title: "วงกลมแนบในสามเหลี่ยมมุมฉาก", level: "ม.4" },
  { file: "s1_incircle__high.html", title: "การสร้างวงกลมแนบในสามเหลี่ยม", level: "ม.4" },
  { file: "s2_hyperbola__medium.html", title: "ส่วนประกอบของไฮเพอร์โบลา", level: "ม.4" },
  { file: "s2_hyperbola__high.html", title: "ไฮเพอร์โบลาและเส้นกำกับ", level: "ม.4" },
  { file: "s3_boxplot__medium.html", title: "ควอร์ไทล์ พิสัยระหว่างควอร์ไทล์ และแผนภาพกล่อง", level: "ม.6" },
  { file: "s3_boxplot__high.html", title: "แผนภาพกล่องและควอร์ไทล์", level: "ม.6" },
  { file: "n1_vtgraph.html", title: "กราฟความเร็ว-เวลาและการเคลื่อนที่ของรถยนต์", level: "ม.4" },
  { file: "n2_circuit.html", title: "การวิเคราะห์วงจรไฟฟ้าตัวต้านทานแบบผสม", level: "ม.5" },
  { file: "n3_pulley.html", title: "การเคลื่อนที่ของมวลผ่านรอกเดี่ยว (Atwood Machine)", level: "ม.4" },
  { file: "q1_incline.html", title: "การเคลื่อนที่บนพื้นเอียงที่มีความเสียดทาน", level: "ม.4" },
  { file: "q2_beam.html", title: "สมดุลของคานและโมเมนต์ของแรง", level: "ม.4" },
  { file: "q3_collision.html", title: "การชนแบบติดกันไปของรถทดลอง", level: "ม.4" },
  { file: "q4_lens.html", title: "การเกิดภาพจากเลนส์นูน", level: "ม.3" },
  { file: "q5_circuit.html", title: "การวิเคราะห์วงจรผสมและความต้านทานรวม", level: "ม.3" },
  { file: "q6_energy.html", title: "การเปลี่ยนระดับพลังงานของอะตอมไฮโดรเจน", level: "ม.6" },
  { file: "s4_projectile__medium.html", title: "การเคลื่อนที่แบบโพรเจกไทล์", level: "ม.4" },
  { file: "s4_projectile__high.html", title: "การเคลื่อนที่แบบโพรเจกไทล์บนพื้นราบ", level: "ม.4" },
];
