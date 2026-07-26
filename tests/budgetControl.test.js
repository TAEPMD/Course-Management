/**
 * tests/budgetControl.test.js
 * เทสต์ด่านควบคุมภายในของสายงานเบิกจ่าย:
 * สิทธิ์ตาม role, การกันข้ามขั้น, ความถูกต้องของรายการ, วงเงิน, audit trail
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORKFLOW,
  BUDGET_APPROVER_ROLES,
  canApproveBudget,
  canRequestBudget,
  canRevertBudget,
  canEditEntry,
  getAllowedTransitions,
  getEntryStatus,
  isTransitionAllowed,
  getPreviousStatus,
  checkStatusChange,
  makeEntryId,
  ensureEntryId,
  ensureLedgerIds,
  findEntryById,
  findEntryIndexById,
  validateEntry,
  normalizeAmount,
  checkBudgetCap,
  describeFieldChange,
  AUDITED_FIELDS,
} from '../src/utils/budgetWorkflow.js';

const expense = (status, extra = {}) => ({ type: 'expense', status, amount: 100, desc: 'ทดสอบ', ...extra });

// ── สิทธิ์ตาม role ──────────────────────────────────────────────────────────

test('role: Admin/Staff อนุมัติได้, Instructor/Trainee ไม่ได้', () => {
  assert.deepEqual(BUDGET_APPROVER_ROLES, ['Admin', 'Staff']);
  assert.equal(canApproveBudget('Admin'), true);
  assert.equal(canApproveBudget('Staff'), true);
  assert.equal(canApproveBudget('Instructor'), false);
  assert.equal(canApproveBudget('Trainee'), false);
  assert.equal(canApproveBudget(null), false, 'ไม่รู้ role ต้องไม่ให้สิทธิ์');
});

test('role: Instructor ตั้งเรื่องขอเบิกได้ แต่ Trainee ไม่ได้', () => {
  assert.equal(canRequestBudget('Instructor'), true);
  assert.equal(canRequestBudget('Trainee'), false);
});

test('role: ย้อนสถานะได้เฉพาะ Admin', () => {
  assert.equal(canRevertBudget('Admin'), true);
  assert.equal(canRevertBudget('Staff'), false);
});

test('canEditEntry: ยังไม่อนุมัติ ผู้ตั้งเรื่องแก้ได้', () => {
  assert.equal(canEditEntry(expense('requested'), 'Instructor'), true);
  assert.equal(canEditEntry(expense('requested'), 'Trainee'), false);
});

test('canEditEntry: อนุมัติแล้ว Instructor แก้ตัวเลขไม่ได้อีก', () => {
  assert.equal(canEditEntry(expense('approved'), 'Instructor'), false);
  assert.equal(canEditEntry(expense('approved'), 'Staff'), true);
  assert.equal(canEditEntry(expense('billed'), 'Instructor'), false);
});

test('canEditEntry: จ่ายแล้วล็อก ยกเว้น Admin', () => {
  assert.equal(canEditEntry(expense('paid'), 'Staff'), false);
  assert.equal(canEditEntry(expense('paid'), 'Admin'), true);
});

// ── กันข้ามขั้น ─────────────────────────────────────────────────────────────

test('getAllowedTransitions: เดินหน้าได้ทีละขั้นเท่านั้น', () => {
  const allowed = getAllowedTransitions(expense('requested'), 'Staff');
  assert.ok(allowed.includes('approved'));
  assert.ok(!allowed.includes('obligated'), 'ห้ามข้ามไปก่อหนี้');
  assert.ok(!allowed.includes('paid'), 'ห้ามข้ามไปจ่ายแล้ว');
});

test('กันเคสสำคัญ: ขออนุมัติ → จ่ายแล้ว ต้องถูกปฏิเสธ', () => {
  const entry = expense('requested');
  assert.equal(isTransitionAllowed(entry, 'paid', 'Staff'), false);
  assert.equal(isTransitionAllowed(entry, 'paid', 'Admin'), false);

  const res = checkStatusChange(entry, 'paid', 'Staff');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not-allowed');
});

test('ทุกสถานะใน workflow ข้ามไปข้างหน้าเกินหนึ่งขั้นไม่ได้', () => {
  for (let i = 0; i < WORKFLOW.length; i += 1) {
    const entry = expense(WORKFLOW[i]);
    for (let j = i + 2; j < WORKFLOW.length; j += 1) {
      assert.equal(
        isTransitionAllowed(entry, WORKFLOW[j], 'Admin'),
        false,
        `${WORKFLOW[i]} → ${WORKFLOW[j]} ไม่ควรทำได้`
      );
    }
  }
});

test('getAllowedTransitions: Instructor เดินสถานะไม่ได้เลย', () => {
  for (const status of WORKFLOW) {
    assert.deepEqual(getAllowedTransitions(expense(status), 'Instructor'), []);
  }
});

test('getAllowedTransitions: ไม่อนุมัติได้ทุกสถานะที่ยังไม่จ่าย', () => {
  for (const status of ['requested', 'approved', 'obligated', 'billed', 'claiming']) {
    assert.ok(
      getAllowedTransitions(expense(status), 'Staff').includes('rejected'),
      status + ' ควรกดไม่อนุมัติได้'
    );
  }
  assert.ok(!getAllowedTransitions(expense('paid'), 'Staff').includes('rejected'),
    'จ่ายเงินไปแล้วจะมาไม่อนุมัติทีหลังไม่ได้');
});

test('getAllowedTransitions: รายการที่ไม่อนุมัติ เปิดกลับมาได้เป็น "ขออนุมัติ"', () => {
  assert.deepEqual(getAllowedTransitions(expense('rejected'), 'Staff'), ['requested']);
  assert.deepEqual(getAllowedTransitions(expense('rejected'), 'Instructor'), []);
});

test('getAllowedTransitions: Admin ย้อนกลับได้ทีละขั้น, Staff ย้อนไม่ได้', () => {
  assert.ok(getAllowedTransitions(expense('billed'), 'Admin').includes('obligated'));
  assert.ok(!getAllowedTransitions(expense('billed'), 'Staff').includes('obligated'));
  assert.equal(getPreviousStatus(expense('billed')), 'obligated');
  assert.equal(getPreviousStatus(expense('requested')), null);
});

test('getAllowedTransitions: รายรับไม่มีสายอนุมัติ', () => {
  assert.deepEqual(getAllowedTransitions({ type: 'income', status: 'paid' }, 'Admin'), []);
});

test('checkStatusChange: ไม่มีสิทธิ์เลย ได้ error no-permission', () => {
  const res = checkStatusChange(expense('requested'), 'approved', 'Instructor');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no-permission');
});

test('checkStatusChange: ย้อนสถานะต้องขอคำยืนยัน', () => {
  const res = checkStatusChange(expense('billed'), 'obligated', 'Admin');
  assert.equal(res.ok, true);
  assert.equal(res.warning, 'confirm-revert');
});

test('checkStatusChange: ด่านเดิม (เอกสาร/หลักฐาน) ยังทำงานพร้อมตรวจสิทธิ์', () => {
  const noDoc = checkStatusChange(expense('billed'), 'claiming', 'Staff');
  assert.deepEqual(noDoc, { ok: true, warning: 'missing-doc', error: null });

  const noEvidence = checkStatusChange(expense('claiming', { docNo: 'INV-1' }), 'paid', 'Staff');
  assert.deepEqual(noEvidence, { ok: true, warning: 'missing-evidence', error: null });

  const clean = checkStatusChange(
    expense('claiming', { docNo: 'INV-1', attachments: [{ name: 'slip' }] }),
    'paid',
    'Staff'
  );
  assert.deepEqual(clean, { ok: true, warning: null, error: null });
});

test('checkStatusChange: ไม่ส่ง role = ไม่ตรวจสิทธิ์ (เข้ากันได้กับของเดิม)', () => {
  const res = checkStatusChange(expense('requested'), 'approved');
  assert.equal(res.ok, true);
  assert.equal(res.error, null);
});

test('checkStatusChange: สถานะที่ไม่รู้จักถูกปฏิเสธ', () => {
  assert.equal(checkStatusChange(expense('requested'), 'ยิงมั่ว').error, 'unknown-status');
});

// ── รหัสประจำรายการ ─────────────────────────────────────────────────────────

test('makeEntryId: ไม่ซ้ำกันแม้สร้างรัว ๆ ในมิลลิวินาทีเดียวกัน', () => {
  // เคสจริง: ensureLedgerIds เติม id ให้ทั้ง ledger ในทีเดียว → Date.now() เท่ากันหมด
  // ถ้าพึ่งความสุ่มอย่างเดียวจะชนกันได้ (500 ค่าจากช่วง 10^6 ชนกัน ~12%)
  const ids = new Set();
  for (let i = 0; i < 5000; i += 1) ids.add(makeEntryId(1700000000000, 0.5));
  assert.equal(ids.size, 5000, 'ต้องไม่ซ้ำแม้ now และ seed คงที่');
});

test('makeEntryId: รูปแบบขึ้นต้นด้วย led- และไม่มีอักขระที่ต้อง escape', () => {
  const id = makeEntryId();
  assert.match(id, /^led-[0-9a-z-]+$/, 'ใช้เป็น data attribute และในสตริง JS ได้ปลอดภัย');
});

test('ensureEntryId: ไม่ทับ id เดิม', () => {
  const entry = { id: 'led-เดิม' };
  ensureEntryId(entry);
  assert.equal(entry.id, 'led-เดิม');

  const fresh = {};
  const id = ensureEntryId(fresh);
  assert.equal(fresh.id, id);
  assert.match(id, /^led-/);
});

test('ensureLedgerIds: เติม id ให้ข้อมูลเก่าที่ยังไม่มี', () => {
  const project = { ledger: [{ desc: 'เก่า' }, { id: 'led-x', desc: 'มีแล้ว' }, { desc: 'เก่า2' }] };
  assert.equal(ensureLedgerIds(project), 2);
  assert.equal(ensureLedgerIds(project), 0, 'รันซ้ำต้องไม่เติมเพิ่ม');
  assert.equal(new Set(project.ledger.map(e => e.id)).size, 3);
});

test('findEntryById: หาเจอแม้ลำดับใน array เปลี่ยนไป', () => {
  const project = { ledger: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  assert.equal(findEntryIndexById(project, 'c'), 2);
  project.ledger.splice(0, 1); // ลบรายการแรกทิ้ง
  assert.equal(findEntryIndexById(project, 'c'), 1, 'index เลื่อน แต่ต้องยังหาเจอ');
  assert.equal(findEntryById(project, 'c').id, 'c');
  assert.equal(findEntryById(project, 'a'), null);
});

// ── ความถูกต้องของรายการ ────────────────────────────────────────────────────

test('validateEntry: จำนวนเงินติดลบไม่ผ่าน', () => {
  const errors = validateEntry(expense('requested', { amount: -5 }));
  assert.ok(errors.some(e => e.includes('ติดลบ')));
});

test('validateEntry: ยอด 0 ตอนขออนุมัติยังผ่าน แต่พอเดินเรื่องต่อไม่ผ่าน', () => {
  assert.deepEqual(validateEntry(expense('requested', { amount: 0 })), []);
  assert.ok(validateEntry(expense('approved', { amount: 0 })).some(e => e.includes('มากกว่า 0')));
});

test('validateEntry: ต้องมีชื่อรายการ', () => {
  assert.ok(validateEntry(expense('requested', { desc: '   ' })).some(e => e.includes('ระบุรายการ')));
});

test('validateEntry: สถานะที่ต้องมีเอกสาร แต่ไม่มี', () => {
  assert.ok(validateEntry(expense('billed')).some(e => e.includes('เลขที่เอกสาร')));
  assert.ok(!validateEntry(expense('billed', { docNo: 'INV-1' })).some(e => e.includes('เลขที่เอกสาร')));
});

test('validateEntry: จ่ายแล้วต้องมีวันที่จ่าย', () => {
  const errors = validateEntry(expense('paid', { docNo: 'INV-1' }));
  assert.ok(errors.some(e => e.includes('วันที่จ่าย')));
});

test('validateEntry: วันครบกำหนดต้องไม่ก่อนวันวางบิล', () => {
  const errors = validateEntry(expense('requested', { billDate: '2026-03-10', dueDate: '2026-03-01' }));
  assert.ok(errors.some(e => e.includes('ครบกำหนด')));
});

test('validateEntry: รายการที่ถูกต้องไม่มี error', () => {
  assert.deepEqual(
    validateEntry(expense('paid', { docNo: 'INV-1', paidDate: '2026-03-01', amount: 500 })),
    []
  );
});

test('validateEntry: รายรับไม่ต้องมีเลขที่เอกสาร/วันที่จ่าย', () => {
  // รายรับมีสถานะเริ่มต้นเป็น paid แต่ไม่ได้เดินสายเบิกจ่าย
  const income = { type: 'income', desc: 'เงินสนับสนุนจาก สพฉ.', amount: 30000 };
  assert.equal(getEntryStatus(income), 'paid');
  assert.deepEqual(validateEntry(income), []);
});

test('normalizeAmount: กันค่าติดลบ/ไม่ใช่ตัวเลข และปัดเป็นสตางค์', () => {
  assert.equal(normalizeAmount(-10), 0);
  assert.equal(normalizeAmount('abc'), 0);
  assert.equal(normalizeAmount(undefined), 0);
  assert.equal(normalizeAmount(Infinity), 0);
  assert.equal(normalizeAmount('1200.456'), 1200.46);
  assert.equal(normalizeAmount(1200), 1200);
});

// ── คุมวงเงิน ───────────────────────────────────────────────────────────────

const capProject = {
  budget: 100000,
  ledger: [
    { id: 'a', type: 'expense', status: 'approved', amount: 60000 },
    { id: 'b', type: 'expense', status: 'rejected', amount: 50000 },
  ],
};

test('checkBudgetCap: รายการใหม่ที่ยังอยู่ในวงเงิน', () => {
  const cap = checkBudgetCap(capProject, null, 30000);
  assert.equal(cap.committed, 90000);
  assert.equal(cap.exceeds, false);
  assert.equal(cap.remaining, 10000);
  assert.equal(cap.pct, 90);
});

test('checkBudgetCap: รายการใหม่ที่ทำให้เกินวงเงิน', () => {
  const cap = checkBudgetCap(capProject, null, 50000);
  assert.equal(cap.exceeds, true);
  assert.equal(cap.overBy, 10000);
});

test('checkBudgetCap: แก้รายการเดิม ต้องไม่นับยอดเก่าซ้ำ', () => {
  const entry = capProject.ledger[0]; // 60,000 ที่ผูกพันอยู่แล้ว
  const cap = checkBudgetCap(capProject, entry, 70000);
  assert.equal(cap.committed, 70000, 'ต้องหักยอดเดิมออกก่อน ไม่ใช่ 130,000');
  assert.equal(cap.exceeds, false);
});

test('checkBudgetCap: รายการที่ไม่อนุมัติอยู่แล้ว ไม่ต้องหักยอดเดิม', () => {
  const rejected = capProject.ledger[1];
  const cap = checkBudgetCap(capProject, rejected, 10000);
  assert.equal(cap.committed, 70000, '60,000 เดิม + 10,000 ใหม่');
});

test('checkBudgetCap: รายรับเสริมเพิ่มวงเงินให้ด้วย', () => {
  const project = {
    budget: 100000,
    ledger: [{ type: 'income', status: 'paid', amount: 50000 }],
  };
  const cap = checkBudgetCap(project, null, 140000);
  assert.equal(cap.totalIncome, 150000);
  assert.equal(cap.exceeds, false);
});

test('checkBudgetCap: ยังไม่ตั้งวงเงิน = เตือน ไม่บล็อก', () => {
  const cap = checkBudgetCap({ ledger: [] }, null, 5000);
  assert.equal(cap.noBudget, true);
  assert.equal(cap.exceeds, false, 'ไม่มีวงเงินให้เทียบ จึงไม่ควรบล็อก');
});

test('checkBudgetCap: budgetValue ที่ส่งมาชนะค่าใน project', () => {
  const cap = checkBudgetCap(capProject, null, 30000, 200000);
  assert.equal(cap.totalIncome, 200000);
  assert.equal(cap.exceeds, false);
});

// ── Audit trail ─────────────────────────────────────────────────────────────

test('describeFieldChange: จำนวนเงินมีตัวคั่นหลักพันและหน่วย', () => {
  assert.equal(describeFieldChange('amount', 1000, 25000), 'แก้จำนวนเงิน: 1,000 → 25,000 บาท');
});

test('describeFieldChange: ค่าไม่เปลี่ยนจริง คืน null', () => {
  assert.equal(describeFieldChange('desc', 'ก', 'ก'), null);
  assert.equal(describeFieldChange('amount', 100, '100'), null, 'ต่างชนิดแต่ค่าเท่ากันไม่ควรลง log');
});

test('describeFieldChange: ฟิลด์ที่ไม่ต้อง audit คืน null', () => {
  assert.equal(describeFieldChange('note', 'ก', 'ข'), null);
  assert.equal(describeFieldChange('attachments', [], [1]), null);
});

test('describeFieldChange: ค่าว่างอ่านออก', () => {
  assert.equal(describeFieldChange('docNo', '', 'INV-1'), 'แก้เลขที่เอกสาร: (ว่าง) → INV-1');
  assert.equal(describeFieldChange('docNo', 'INV-1', ''), 'แก้เลขที่เอกสาร: INV-1 → (ว่าง)');
});

test('AUDITED_FIELDS: ครอบคลุมฟิลด์การเงินสำคัญ', () => {
  for (const field of ['amount', 'payee', 'docNo', 'paidDate', 'type']) {
    assert.ok(AUDITED_FIELDS[field], field + ' ต้องถูก audit');
  }
});
