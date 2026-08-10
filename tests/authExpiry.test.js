/**
 * tests/authExpiry.test.js
 * กันบั๊กเดิมกลับมา: gas.js แปลข้อความ session หมดอายุเป็นภาษาไทย แต่ตัวตรวจ
 * ปลายทางจับ pattern ภาษาอังกฤษ → ทุกครั้งที่ session หมดอายุ ผู้ใช้จะเจอ
 * กล่องแดง "โหลดข้อมูลล้มเหลว: Session หมดอายุ..." ซ้อนบนกล่องแจ้งของ gas.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AUTH_EXPIRED, notifyApiError } from '../src/gas.js';
import { isAuthExpiredError } from '../src/modules/auth.js';

function expiredError() {
  const e = new Error('Session หมดอายุ กรุณาเข้าสู่ระบบใหม่');
  e.code = AUTH_EXPIRED;
  return e;
}

test('isAuthExpiredError: error ที่ผ่าน toApiError แล้ว (ข้อความไทย + code)', () => {
  assert.equal(isAuthExpiredError(expiredError()), true);
});

test('isAuthExpiredError: ข้อความดิบจาก backend/proxy', () => {
  for (const msg of ['Unauthorized: Please login', 'Invalid or expired API session']) {
    assert.equal(isAuthExpiredError(new Error(msg)), true, msg);
  }
});

test('isAuthExpiredError: ข้อความไทยที่ไม่มี code (โหมด GAS โดยตรง)', () => {
  assert.equal(isAuthExpiredError(new Error('Session หมดอายุ กรุณาเข้าสู่ระบบใหม่')), true);
});

test('isAuthExpiredError: error อื่นต้องไม่ถูกนับเป็น session หมดอายุ', () => {
  assert.equal(isAuthExpiredError(new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้')), false);
  assert.equal(isAuthExpiredError(new Error('บัญชีนี้ไม่มีสิทธิ์ดำเนินการนี้')), false);
  assert.equal(isAuthExpiredError(null), false);
});

test('notifyApiError: เงียบเมื่อ session หมดอายุ (gas.js แจ้งไปแล้ว)', () => {
  const calls = [];
  globalThis.Swal = { fire: opts => calls.push(opts) };
  try {
    notifyApiError('โหลดข้อมูลล้มเหลว', expiredError());
    assert.deepEqual(calls, []);
  } finally {
    delete globalThis.Swal;
  }
});

test('notifyApiError: error ปกติยังแจ้งผู้ใช้ พร้อม options ที่ส่งเพิ่ม', () => {
  const calls = [];
  globalThis.Swal = { fire: opts => calls.push(opts) };
  try {
    notifyApiError('บันทึกงานล้มเหลว', new Error('เขียนชีตไม่สำเร็จ'), { heightAuto: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].icon, 'error');
    assert.equal(calls[0].title, 'บันทึกงานล้มเหลว');
    assert.equal(calls[0].text, 'เขียนชีตไม่สำเร็จ');
    assert.equal(calls[0].heightAuto, false);
  } finally {
    delete globalThis.Swal;
  }
});

test('notifyApiError: ไม่ระเบิดเมื่อยังไม่มี Swal ในหน้า', () => {
  delete globalThis.Swal;
  assert.doesNotThrow(() => notifyApiError('บันทึกล้มเหลว', new Error('x')));
});
