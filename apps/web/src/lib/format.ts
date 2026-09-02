export function checkIdOf(file: string): string {
  return file.replace(/\.html$/, "");
}

export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "เมื่อสักครู่";
  if (min < 60) return `${min} นาทีที่แล้ว`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} ชั่วโมงที่แล้ว`;
  const day = Math.round(hr / 24);
  return `${day} วันที่แล้ว`;
}

export function formatSeconds(s: number): string {
  if (s < 60) return `${Math.round(s)} วิ`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m} นาที ${rem} วิ`;
}
