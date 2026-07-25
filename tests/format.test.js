/**
 * tests/format.test.js
 * เทสต์ตัว escape — ด่านกัน XSS ของทั้งแอป
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeHTML, escapeJsAttr, formatCurrency } from '../src/utils/format.js';

test('escapeHTML: escape อักขระ HTML ครบทั้ง 5 ตัว', () => {
  assert.equal(escapeHTML('&'), '&amp;');
  assert.equal(escapeHTML('<'), '&lt;');
  assert.equal(escapeHTML('>'), '&gt;');
  assert.equal(escapeHTML('"'), '&quot;');
  assert.equal(escapeHTML("'"), '&#39;');
});

test('escapeHTML: escape & ก่อนตัวอื่น ไม่ double-escape', () => {
  // ถ้าเรียงผิด "<" จะกลายเป็น &amp;lt; แทน &lt;
  assert.equal(escapeHTML('<a>'), '&lt;a&gt;');
  assert.equal(escapeHTML('&lt;'), '&amp;lt;');
});

test('escapeHTML: ปิดช่อง XSS ผ่าน attribute ที่ครอบด้วย single quote', () => {
  const evil = "x' onerror='alert(1)";
  const out = escapeHTML(evil);
  assert.ok(!out.includes("'"), 'ต้องไม่เหลือ apostrophe ดิบ');
});

test('escapeHTML: null / undefined กลายเป็นสตริงว่าง ไม่ throw', () => {
  assert.equal(escapeHTML(null), '');
  assert.equal(escapeHTML(undefined), '');
  assert.equal(escapeHTML(0), '0');
  assert.equal(escapeHTML(false), 'false');
});

test('escapeJsAttr: escape ชั้น JS ก่อน แล้วค่อยชั้น HTML', () => {
  // ' ต้องกลายเป็น \' (backslash) ก่อน แล้ว ' ถึงถูก escape เป็น &#39;
  assert.equal(escapeJsAttr("it's"), 'it\\&#39;s');
});

test('escapeJsAttr: backslash ถูก escape ก่อน จะได้ไม่กิน escape ตัวถัดไป', () => {
  // ถ้าไม่ escape backslash ก่อน ค่า "\\'" จะ decode ออกมาเป็น \' แล้วปิดสตริงได้
  assert.equal(escapeJsAttr('\\'), '\\\\');
  assert.equal(escapeJsAttr("\\'"), '\\\\\\&#39;');
});

test('escapeJsAttr: หลัง browser decode HTML แล้ว ต้องยังไม่หลุดออกจากสตริง JS', () => {
  const decodeEntities = (s) =>
    s.replace(/&#39;/g, "'").replace(/&quot;/g, '"')
     .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  for (const evil of ["'", "');alert(1);//", '"', "\\", "a'b\"c\\d"]) {
    const attr = escapeJsAttr(evil);
    // จำลองสิ่งที่เบราว์เซอร์ทำ: decode entity ก่อน แล้วค่อย parse เป็น JS
    const jsSource = "'" + decodeEntities(attr) + "'";
    // ถ้า escape ถูก ค่านี้ต้อง parse กลับมาได้เท่าเดิม (ไม่ throw / ไม่หลุด)
    assert.equal(JSON.parse(JSON.stringify(eval(jsSource))), evil);
  }
});

test('escapeJsAttr: ตัด newline ทิ้ง (สตริง JS ธรรมดาข้ามบรรทัดไม่ได้)', () => {
  assert.equal(escapeJsAttr('a\nb'), 'ab');
  assert.equal(escapeJsAttr('a\r\nb'), 'ab');
});

test('formatCurrency: ใส่ตัวคั่นหลักพัน และปัดเศษทิ้ง', () => {
  assert.equal(formatCurrency(1234567), '1,234,567');
  assert.equal(formatCurrency(0), '0');
  assert.equal(formatCurrency(null), '0');
  assert.equal(formatCurrency(undefined), '0');
  assert.equal(formatCurrency(1234.6), '1,235');
});
