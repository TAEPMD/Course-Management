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
      getUuid: () => 'uuid',
      computeHmacSha256Signature: () => [1, 2, 3],
      base64Encode: () => 'x',
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

/** `const` ใน Code.gs เป็น lexical binding ไม่ได้ขึ้นไปอยู่บน global object ของ sandbox */
const readConst = (name) => vm.runInContext(name, sandbox);

/** ค่าที่ข้ามมาจาก vm คนละ realm — prototype ไม่ตรง ทำให้ deepStrictEqual ไม่ผ่าน */
const plain = (value) => JSON.parse(JSON.stringify(value));

const entry = (over = {}) => ({ id: 'e1', type: 'expense', status: 'requested', amount: 100, desc: 'ทดสอบ', ...over });

test('Code.gs โหลดเข้า vm ได้ และมี guardLedgerChanges_', () => {
  assert.equal(typeof sandbox.guardLedgerChanges_, 'function');
  assert.deepEqual(plain(readConst('BUDGET_WORKFLOW')), ['requested', 'approved', 'obligated', 'billed', 'claiming', 'paid']);
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

test('parseLedger_: JSON พังต้องไม่ทำให้ทั้งคำขอล้ม', () => {
  assert.deepEqual(plain(sandbox.parseLedger_('{พัง')), []);
  assert.deepEqual(plain(sandbox.parseLedger_('')), []);
  assert.deepEqual(plain(sandbox.parseLedger_('{"a":1}')), [], 'ไม่ใช่ array ก็ต้องคืน array ว่าง');
  assert.deepEqual(plain(sandbox.parseLedger_('[{"id":"a"}]')), [{ id: 'a' }]);
});
