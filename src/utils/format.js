/**
 * utils/format.js
 * Formatting utilities
 */

export function formatCurrency(n) {
  return new Intl.NumberFormat('th-TH', { style: 'decimal', maximumFractionDigits: 0 }).format(n || 0);
}

/**
 * Escape ข้อความก่อนแทรกลง HTML
 *
 * escape `'` ด้วย เพราะ template ในโปรเจกต์นี้มี attribute ที่ครอบด้วย `"`
 * และ inline handler ที่ครอบสตริง JS ด้วย `'` — ถ้าปล่อย apostrophe ไว้
 * ข้อความที่มีเครื่องหมาย ' จะหลุดออกจาก attribute ได้
 */
export function escapeHTML(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape ค่าที่จะฝังใน "สตริง JavaScript ที่อยู่ใน HTML attribute"
 * เช่น onclick="app.openProject('<ค่าตรงนี้>')"
 *
 * เบราว์เซอร์ decode HTML entity ก่อน แล้วค่อย parse ค่านั้นเป็น JavaScript
 * ดังนั้น escapeHTML อย่างเดียวไม่พอ — `&#39;` จะถูก decode กลับเป็น `'`
 * แล้วปิดสตริง JS ได้ ต้อง escape ชั้น JS ก่อน (backslash) แล้วค่อย escape ชั้น HTML
 */
export function escapeJsAttr(str) {
  const jsEscaped = String(str ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '');
  return escapeHTML(jsEscaped);
}
