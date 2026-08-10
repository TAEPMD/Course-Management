/**
 * tests/gasLedgerGuard.test.js
 * เทสต์ด่านฝั่งเซิร์ฟเวอร์ (Code.gs) ของสายอนุมัติเบิกจ่าย
 *
 * โหลด Code.gs เข้า vm พร้อม stub ของ Apps Script API แทนการ deploy จริง
 * — ดัก guardLedgerChanges_() ซึ่งเป็นด่านสุดท้ายที่ UI ข้ามไม่ได้
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** สร้าง sandbox ที่มี Code.gs โหลดอยู่ พร้อม stub เท่าที่ guard ต้องใช้ */
function loadCodeGs() {
  const source = fs.readFileSync(path.join(root, 'Code.gs'), 'utf8');
  const logs = [];

  const noop = () => {};
  const sandbox = {
    console,
    logs,
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => null }), flush: noop },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => null, setProperty: noop, deleteProperty: noop }),
      getUserProperties: () => ({ getProperty: () => null, setProperty: noop, deleteProperty: noop }),
    },
    CacheService: { getScriptCache: () => ({ get: () => null, put: noop, remove: noop }) },
    LockService: { getDocumentLock: () => ({ waitLock: noop, releaseLock: noop }) },
    Utilities: {
      getUuid: () => 'uuid-0000',
      newBlob: (value) => ({ getBytes: () => Array.from(String(value)).map((c) => c.charCodeAt(0)) }),
      computeHmacSha256Signature: () => [1, 2, 3],
      computeDigest: () => [1, 2, 3],
      base64Encode: () => 'HASHED',
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
    },
    Logger: { log: (m) => logs.push(String(m)) },
    Session: { getActiveUser: () => ({ getEmail: () => '' }) },
    DriveApp: {},
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'Code.gs' });

  // authLog_ เขียนลงชีตจริง — แทนที่ด้วยตัวเก็บ log ในหน่วยความจำ
  vm.runInContext('authLog_ = function (event, detail) { logs.push(event); };', sandbox);
  return sandbox;
}

const sandbox = loadCodeGs();
const guard = (incoming, existing, role) =>
  sandbox.guardLedgerChanges_(incoming, existing, { id: 'u1', role });
const guardBudgetControl = (incomingBudget, incomingControl, existingBudget, existingControl, role) =>
  sandbox.guardBudgetControlChanges_(incomingBudget, incomingControl, existingBudget, existingControl, { id: 'u1', role });
const guardAccounting = (incoming, existing, role) =>
  sandbox.guardAccountingChanges_(incoming, existing, { id: 'u1', role });

/** `const` ใน Code.gs เป็น lexical binding ไม่ได้ขึ้นไปอยู่บน global object ของ sandbox */
const readConst = (name) => vm.runInContext(name, sandbox);

/** ค่าที่ข้ามมาจาก vm คนละ realm — prototype ไม่ตรง ทำให้ deepStrictEqual ไม่ผ่าน */
const plain = (value) => JSON.parse(JSON.stringify(value));

const entry = (over = {}) => ({ id: 'e1', type: 'expense', status: 'requested', amount: 100, desc: 'ทดสอบ', ...over });

test('Code.gs โหลดเข้า vm ได้ และมี guardLedgerChanges_', () => {
  assert.equal(typeof sandbox.guardLedgerChanges_, 'function');
  assert.equal(typeof sandbox.guardBudgetControlChanges_, 'function');
  assert.equal(typeof sandbox.guardAccountingChanges_, 'function');
  assert.equal(typeof sandbox.validateAccountingPayload_, 'function');
  assert.deepEqual(plain(readConst('BUDGET_WORKFLOW')), ['requested', 'approved', 'obligated', 'billed', 'claiming', 'paid']);
});

test('Instructor แก้ Baseline หรือ Forecast ผ่าน API โดยตรงไม่ได้', () => {
  assert.throws(
    () => guardBudgetControl(120000, { baselineAmount: 120000 }, 100000, { baselineAmount: 100000 }, 'Instructor'),
    /Forbidden/
  );
});

test('Instructor บันทึกรายการโดยไม่เปลี่ยน Budget Control ได้', () => {
  const control = { baselineAmount: 100000, forecastEtc: 40000 };
  assert.doesNotThrow(() => guardBudgetControl(100000, control, 100000, control, 'Instructor'));
});

test('Admin และ Staff กำหนด Baseline / Forecast ได้', () => {
  assert.doesNotThrow(() => guardBudgetControl(120000, { baselineAmount: 120000 }, 100000, {}, 'Admin'));
  assert.doesNotThrow(() => guardBudgetControl(120000, { baselineAmount: 120000 }, 100000, {}, 'Staff'));
});

test('Instructor ดูบัญชีได้ แต่แก้สมุดรายวันผ่าน API โดยตรงไม่ได้', () => {
  const before = { journals: [] };
  const after = {
    journals: [{
      id: 'j1', date: '2026-08-01', description: 'ตั้งเจ้าหนี้',
      lines: [{ account: '5102', debit: 100 }, { account: '2100', credit: 100 }],
    }],
  };
  assert.throws(() => guardAccounting(after, before, 'Instructor'), /Forbidden/);
  assert.doesNotThrow(() => guardAccounting(before, before, 'Instructor'));
  assert.doesNotThrow(() => guardAccounting({ journals: [], reconciliations: [] }, {}, 'Instructor'));
});

test('Admin และ Staff บันทึกบัญชีที่สมดุลได้', () => {
  const accounting = {
    journals: [{
      id: 'j1', date: '2026-08-01', description: 'ตั้งเจ้าหนี้',
      lines: [{ account: '5102', debit: 100 }, { account: '2100', credit: 100 }],
    }],
  };
  assert.doesNotThrow(() => guardAccounting(accounting, {}, 'Admin'));
  assert.doesNotThrow(() => guardAccounting(accounting, {}, 'Staff'));
});

test('ฝั่ง GAS ปฏิเสธรายการบัญชีที่ไม่สมดุลหรือบรรทัดไม่ถูกต้อง', () => {
  const unbalanced = { journals: [{ date: '2026-08-01', description: 'ผิด', lines: [{ account: '5102', debit: 100 }, { account: '2100', credit: 90 }] }] };
  const bothSides = { journals: [{ date: '2026-08-01', description: 'ผิด', lines: [{ account: '5102', debit: 100, credit: 100 }, { account: '2100', credit: 100 }] }] };
  assert.throws(() => guardAccounting(unbalanced, {}, 'Admin'), /ไม่สมดุล/);
  assert.throws(() => guardAccounting(bothSides, {}, 'Admin'), /ไม่ถูกต้อง/);
  const unknownAccount = { journals: [{ date: '2026-08-01', description: 'ผิด', lines: [{ account: '9999', debit: 100 }, { account: '2100', credit: 100 }] }] };
  assert.throws(() => guardAccounting(unknownAccount, {}, 'Admin'), /ไม่พบรหัสบัญชี/);
});

test('ปิดงวดแล้วห้ามเพิ่ม แก้ ลบรายการเดิม และห้ามย้อนวันปิดงวด', () => {
  const posted = { id: 'j1', date: '2026-07-31', description: 'รายการเดิม', lines: [{ account: '5102', debit: 100 }, { account: '2100', credit: 100 }] };
  const existing = { closedThrough: '2026-07-31', journals: [posted] };
  assert.throws(() => guardAccounting({ closedThrough: '', journals: [posted] }, existing, 'Admin'), /ย้อนวันที่/);
  assert.throws(() => guardAccounting({ closedThrough: '2026-07-31', journals: [] }, existing, 'Admin'), /แก้หรือลบ/);
  const added = { id: 'j2', date: '2026-07-15', description: 'ย้อนหลัง', lines: [{ account: '5102', debit: 50 }, { account: '2100', credit: 50 }] };
  assert.throws(() => guardAccounting({ closedThrough: '2026-07-31', journals: [posted, added] }, existing, 'Staff'), /เพิ่มรายการ/);
  const current = { id: 'j3', date: '2026-08-01', description: 'งวดใหม่', lines: [{ account: '5102', debit: 50 }, { account: '2100', credit: 50 }] };
  assert.doesNotThrow(() => guardAccounting({ closedThrough: '2026-07-31', journals: [posted, current] }, existing, 'Staff'));
});

test('ลำดับ workflow ฝั่ง GAS ต้องตรงกับฝั่งหน้าเว็บ', async () => {
  const { WORKFLOW } = await import('../src/utils/budgetWorkflow.js');
  assert.deepEqual(plain(readConst('BUDGET_WORKFLOW')), WORKFLOW, 'สองฝั่งต้องนิยาม workflow เหมือนกัน');
});

// ── การข้ามขั้น ─────────────────────────────────────────────────────────────

test('Instructor ยิง API ตรงเพื่อตั้งเป็น "จ่ายแล้ว" ต้องโดนปฏิเสธ', () => {
  const existing = [entry({ status: 'requested' })];
  const incoming = [entry({ status: 'paid' })];
  assert.throws(() => guard(incoming, existing, 'Instructor'), /Forbidden/);
});

test('Staff ก็ข้ามขั้นไม่ได้ (requested → paid)', () => {
  const existing = [entry({ status: 'requested' })];
  const incoming = [entry({ status: 'paid' })];
  assert.throws(() => guard(incoming, existing, 'Staff'), /ข้ามขั้น/);
});

test('Staff เดินหน้าทีละขั้นได้', () => {
  const existing = [entry({ status: 'requested' })];
  assert.doesNotThrow(() => guard([entry({ status: 'approved' })], existing, 'Staff'));
});

test('Staff ไม่อนุมัติได้ และเปิดรายการที่ถูกปฏิเสธกลับมาได้', () => {
  assert.doesNotThrow(() => guard([entry({ status: 'rejected' })], [entry({ status: 'obligated' })], 'Staff'));
  assert.doesNotThrow(() => guard([entry({ status: 'requested' })], [entry({ status: 'rejected' })], 'Staff'));
});

test('Staff ย้อนสถานะกลับไม่ได้ แต่ Admin ได้', () => {
  const existing = [entry({ status: 'billed' })];
  const incoming = [entry({ status: 'obligated' })];
  assert.throws(() => guard(incoming, existing, 'Staff'), /Forbidden/);
  assert.doesNotThrow(() => guard(incoming, existing, 'Admin'));
});

test('จ่ายแล้วจะย้อนมาไม่อนุมัติทีหลังไม่ได้', () => {
  assert.throws(() => guard([entry({ status: 'rejected' })], [entry({ status: 'paid' })], 'Staff'), /Forbidden/);
});

// ── การแก้ตัวเลขหลังอนุมัติ ─────────────────────────────────────────────────

test('Instructor แก้จำนวนเงินของรายการที่อนุมัติแล้วไม่ได้', () => {
  const existing = [entry({ status: 'approved', amount: 100 })];
  const incoming = [entry({ status: 'approved', amount: 999999 })];
  assert.throws(() => guard(incoming, existing, 'Instructor'), /ไม่มีสิทธิ์แก้ amount/);
});

test('Instructor แก้รายการของตัวเองตอนยังไม่อนุมัติได้', () => {
  const existing = [entry({ status: 'requested', amount: 100 })];
  const incoming = [entry({ status: 'requested', amount: 250, desc: 'แก้แล้ว' })];
  assert.doesNotThrow(() => guard(incoming, existing, 'Instructor'));
});

test('Instructor แก้รายการที่ถูกปฏิเสธได้ (ต้องกลับไปแก้แล้วยื่นใหม่)', () => {
  const existing = [entry({ status: 'rejected', amount: 100 })];
  const incoming = [entry({ status: 'rejected', amount: 80 })];
  assert.doesNotThrow(() => guard(incoming, existing, 'Instructor'));
});

test('Staff แก้ตัวเลขของรายการที่อนุมัติแล้วได้', () => {
  const existing = [entry({ status: 'approved', amount: 100 })];
  const incoming = [entry({ status: 'approved', amount: 250 })];
  assert.doesNotThrow(() => guard(incoming, existing, 'Staff'));
});

// ── รายการใหม่ / การลบ ──────────────────────────────────────────────────────

test('รายการใหม่ของ Instructor ต้องเริ่มที่ "ขออนุมัติ"', () => {
  assert.throws(() => guard([entry({ id: 'new1', status: 'approved' })], [], 'Instructor'), /ขออนุมัติ/);
  assert.doesNotThrow(() => guard([entry({ id: 'new1', status: 'requested' })], [], 'Instructor'));
});

test('รายรับที่เพิ่มใหม่ไม่ติดกติกาสายอนุมัติ', () => {
  const income = { id: 'inc1', type: 'income', status: 'paid', amount: 5000, desc: 'เงินสนับสนุน' };
  assert.doesNotThrow(() => guard([income], [], 'Instructor'));
});

test('Instructor ลบรายการที่อนุมัติแล้วไม่ได้ แต่ลบรายการที่ยังไม่อนุมัติได้', () => {
  assert.throws(() => guard([], [entry({ status: 'billed' })], 'Instructor'), /ไม่มีสิทธิ์ลบ/);
  assert.doesNotThrow(() => guard([], [entry({ status: 'requested' })], 'Instructor'));
});

test('Staff ลบรายการที่อนุมัติแล้วได้', () => {
  assert.doesNotThrow(() => guard([], [entry({ status: 'billed' })], 'Staff'));
});

// ── ความถูกต้องของตัวเลข ────────────────────────────────────────────────────

test('จำนวนเงินติดลบถูกปฏิเสธทุก role ที่ไม่ใช่ Admin', () => {
  const existing = [entry({ status: 'requested' })];
  assert.throws(() => guard([entry({ amount: -1 })], existing, 'Instructor'), /ติดลบ/);
  assert.throws(() => guard([entry({ amount: -1 })], existing, 'Staff'), /ติดลบ/);
});

// ── Admin ───────────────────────────────────────────────────────────────────

test('Admin ผ่านด่านทั้งหมด (รวมย้อนสถานะและลบ)', () => {
  assert.doesNotThrow(() => guard([entry({ status: 'paid' })], [entry({ status: 'requested' })], 'Admin'));
  assert.doesNotThrow(() => guard([], [entry({ status: 'paid' })], 'Admin'));
});

// ── ข้อมูลเดิมที่ยังไม่มี id ────────────────────────────────────────────────

test('รายการเก่าที่ยังไม่มี id ถือเป็นรายการใหม่ ไม่ทำให้บันทึกพัง', () => {
  const legacy = { type: 'expense', status: 'billed', amount: 100, desc: 'ของเก่า' };
  // ไม่มี id เทียบของเดิมไม่ได้ — Staff ต้องบันทึกผ่าน
  assert.doesNotThrow(() => guard([legacy], [legacy], 'Staff'));
});

// ── ต้นทุนการ hash PIN (ทำให้ login ค้างมาก่อน) ─────────────────────────────

test('PIN_HASH_ITERATIONS ต้องไม่สูงจน login เกินลิมิต serverless', () => {
  const iterations = readConst('PIN_HASH_ITERATIONS');
  // Utilities.computeHmacSha256Signature ใน Apps Script ใช้เวลา ~4ms/ครั้ง
  // 1024 รอบ = ~4 วินาทีต่อการ hash หนึ่งครั้ง และ login ต้อง hash ถึงสองครั้ง
  // รวมแล้วเกิน 10 วินาทีที่ Vercel serverless ยอมให้ → ล็อกอินไม่ผ่านเลย
  assert.ok(iterations >= 32, 'ต่ำเกินไปก็ไม่ควร');
  assert.ok(
    iterations <= 256,
    `PIN_HASH_ITERATIONS = ${iterations} สูงเกินไป — เคยตั้ง 1024 แล้ว login ค้างจนใช้งานไม่ได้`
  );
});

test('verifyCredential_ อ่านจำนวนรอบจาก credential string (ของเก่ายังตรวจผ่าน)', () => {
  // stub ทำให้ hashPin_ คืน "HASHED" เสมอ จึงเทียบค่าได้ตรง ๆ
  const old1024 = sandbox.verifyCredential_('123456', 'v2$1024$somesalt$HASHED');
  assert.equal(old1024.ok, true, 'credential เดิมที่ hash ไว้ 1024 รอบต้องยังล็อกอินได้');
  assert.equal(old1024.iterations, 1024, 'ต้องรายงานจำนวนรอบที่ใช้จริง เพื่อให้ login รู้ว่าควร re-hash');

  const current = sandbox.verifyCredential_('123456', 'v2$128$somesalt$HASHED');
  assert.equal(current.iterations, 128);

  const wrong = sandbox.verifyCredential_('123456', 'v2$128$somesalt$ไม่ตรง');
  assert.equal(wrong.ok, false);
});

test('verifyCredential_: ค่าว่าง/รูปแบบไม่รู้จัก ไม่ throw และไม่ผ่าน', () => {
  for (const stored of ['', null, undefined, 'ขยะ']) {
    const res = sandbox.verifyCredential_('123456', stored);
    assert.equal(res.ok, false);
    assert.equal(res.iterations, 0);
  }
});

test('login มี rehashCredential_ ไว้อัปเกรด credential เก่าให้เอง', () => {
  assert.equal(typeof sandbox.rehashCredential_, 'function');
});

test('parseLedger_: JSON พังต้องไม่ทำให้ทั้งคำขอล้ม', () => {
  assert.deepEqual(plain(sandbox.parseLedger_('{พัง')), []);
  assert.deepEqual(plain(sandbox.parseLedger_('')), []);
  assert.deepEqual(plain(sandbox.parseLedger_('{"a":1}')), [], 'ไม่ใช่ array ก็ต้องคืน array ว่าง');
  assert.deepEqual(plain(sandbox.parseLedger_('[{"id":"a"}]')), [{ id: 'a' }]);
});
