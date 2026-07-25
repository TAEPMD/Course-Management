/**
 * tests/budgetWorkflow.test.js
 * เทสต์ workflow งบประมาณ: ขออนุมัติ → อนุมัติ → ก่อหนี้ → วางบิล → ตั้งเบิก → จ่าย
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORKFLOW,
  CLAIM_QUEUE_STATUSES,
  getEntryType,
  getEntryStatus,
  getStatusMeta,
  getNextStatus,
  getAttachments,
  getHistory,
  isActiveExpense,
  isPaidExpense,
  isClaimQueue,
  getBudgetSummary,
  getBudgetAlerts,
  getBudgetDecision,
  getCategoryBreakdown,
  getStatusBreakdown,
  getMonthlyCashflow,
  getBillEntries,
  getBillAging,
  checkStatusChange,
  clampPct,
} from '../src/utils/budgetWorkflow.js';

// ── ประเภท / สถานะพื้นฐาน ───────────────────────────────────────────────────

test('getEntryType: อะไรที่ไม่ใช่ income ถือเป็น expense', () => {
  assert.equal(getEntryType({ type: 'income' }), 'income');
  assert.equal(getEntryType({ type: 'expense' }), 'expense');
  assert.equal(getEntryType({}), 'expense');
  assert.equal(getEntryType(undefined), 'expense');
});

test('getEntryStatus: ค่าเริ่มต้นต่างกันตามประเภท', () => {
  assert.equal(getEntryStatus({ type: 'expense' }), 'requested');
  assert.equal(getEntryStatus({ type: 'income' }), 'paid');
  assert.equal(getEntryStatus({ type: 'expense', status: 'billed' }), 'billed');
});

test('getStatusMeta: สถานะที่ไม่รู้จัก fallback เป็นตัวแรก', () => {
  assert.equal(getStatusMeta('billed').label, 'วางบิลแล้ว');
  assert.equal(getStatusMeta('ไม่มีจริง').value, 'requested');
});

test('WORKFLOW: ลำดับต้องมี billed อยู่ระหว่าง obligated กับ claiming', () => {
  assert.deepEqual(WORKFLOW, ['requested', 'approved', 'obligated', 'billed', 'claiming', 'paid']);
});

test('getNextStatus: เดินไปข้างหน้าทีละขั้นจนสุดทาง', () => {
  assert.equal(getNextStatus({ status: 'requested' }), 'approved');
  assert.equal(getNextStatus({ status: 'obligated' }), 'billed');
  assert.equal(getNextStatus({ status: 'billed' }), 'claiming');
  assert.equal(getNextStatus({ status: 'claiming' }), 'paid');
  assert.equal(getNextStatus({ status: 'paid' }), null, 'จ่ายแล้วคือปลายทาง');
  assert.equal(getNextStatus({ status: 'rejected' }), null, 'ไม่อนุมัติอยู่นอก workflow');
});

test('getAttachments / getHistory: คืน array เสมอ', () => {
  assert.deepEqual(getAttachments(undefined), []);
  assert.deepEqual(getAttachments({ attachments: 'ไม่ใช่ array' }), []);
  assert.deepEqual(getAttachments({ attachments: [{ name: 'a' }] }), [{ name: 'a' }]);
  assert.deepEqual(getHistory({ history: null }), []);
});

// ── ตัวกรอง ─────────────────────────────────────────────────────────────────

test('isActiveExpense: ตัด rejected และรายรับออก', () => {
  assert.equal(isActiveExpense({ type: 'expense', status: 'billed' }), true);
  assert.equal(isActiveExpense({ type: 'expense', status: 'rejected' }), false);
  assert.equal(isActiveExpense({ type: 'income' }), false);
});

test('isPaidExpense: เฉพาะรายจ่ายที่จ่ายแล้ว', () => {
  assert.equal(isPaidExpense({ type: 'expense', status: 'paid' }), true);
  assert.equal(isPaidExpense({ type: 'income' }), false, 'รายรับ default เป็น paid แต่ต้องไม่นับ');
});

test('isClaimQueue: ต้องรวม billed ด้วย', () => {
  assert.ok(CLAIM_QUEUE_STATUSES.includes('billed'));
  for (const status of CLAIM_QUEUE_STATUSES) {
    assert.equal(isClaimQueue({ type: 'expense', status }), true, status + ' ควรอยู่ในคิวรอเบิก');
  }
  assert.equal(isClaimQueue({ type: 'expense', status: 'requested' }), false);
  assert.equal(isClaimQueue({ type: 'expense', status: 'paid' }), false);
});

// ── สรุปยอด ─────────────────────────────────────────────────────────────────

const project = {
  budget: 100000,
  ledger: [
    { type: 'expense', status: 'paid', amount: 20000, cat: 'ค่าอาหาร', date: '2026-01-05', docNo: 'INV-1', attachments: [{ name: 'slip' }] },
    { type: 'expense', status: 'billed', amount: 10000, cat: 'ค่าวิทยากร', date: '2026-02-05', docNo: 'INV-2', dueDate: '2026-03-01' },
    { type: 'expense', status: 'claiming', amount: 5000, cat: 'ค่าอาหาร', date: '2026-02-10', docNo: 'INV-3', dueDate: '2026-04-01' },
    { type: 'expense', status: 'rejected', amount: 90000, cat: 'ค่าวัสดุ', date: '2026-02-11' },
    { type: 'income', status: 'paid', amount: 50000, date: '2026-01-02' },
  ],
};

test('getBudgetSummary: รายรับเสริมบวกเข้าวงเงิน, rejected ไม่นับผูกพัน', () => {
  const s = getBudgetSummary(project);
  assert.equal(s.budget, 100000);
  assert.equal(s.totalIncome, 150000, 'งบ 100k + รายรับเสริม 50k');
  assert.equal(s.committedExpense, 35000);
  assert.equal(s.paidExpense, 20000);
  assert.equal(s.claimQueue, 15000, 'billed 10k + claiming 5k');
  assert.equal(s.rejectedExpense, 90000);
  assert.equal(s.available, 115000);
  assert.equal(s.pct, 23);
});

test('getBudgetSummary: budgetValue ที่ส่งเข้ามาชนะค่าใน project', () => {
  assert.equal(getBudgetSummary(project, 200000).totalIncome, 250000);
  // 0 ต้องใช้ได้จริง ไม่ตกไปใช้ project.budget
  assert.equal(getBudgetSummary(project, 0).totalIncome, 50000);
});

test('getBudgetSummary: ไม่มีงบ ไม่มี ledger → ทุกอย่าง 0 ไม่ NaN', () => {
  const s = getBudgetSummary({});
  assert.equal(s.totalIncome, 0);
  assert.equal(s.pct, 0);
  assert.equal(s.available, 0);
});

test('getBudgetSummary: pct ถูกบีบไว้ที่ 100 แม้ใช้เกิน', () => {
  const s = getBudgetSummary({ budget: 100, ledger: [{ type: 'expense', amount: 500 }] });
  assert.equal(s.pct, 100);
  assert.equal(s.available, -400, 'ยอดคงเหลือติดลบได้ เพื่อให้เห็นว่าเกินเท่าไร');
});

// ── การแจ้งเตือน ────────────────────────────────────────────────────────────

const NOW = new Date('2026-03-15T09:00:00Z');

test('getBudgetAlerts: จับรายการเกินกำหนด', () => {
  const alerts = getBudgetAlerts(project, NOW);
  const overdue = alerts.filter((a) => a.overdue);
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].entry.docNo, 'INV-2');
});

test('getBudgetAlerts: จ่ายแล้วไม่นับว่าเกินกำหนด', () => {
  const alerts = getBudgetAlerts(
    { ledger: [{ type: 'expense', status: 'paid', amount: 1, dueDate: '2020-01-01', docNo: 'X', attachments: [{}] }] },
    NOW
  );
  assert.equal(alerts.filter((a) => a.overdue).length, 0);
});

test('getBudgetAlerts: จับรายการที่ขาดเลขที่เอกสาร', () => {
  const alerts = getBudgetAlerts(
    { ledger: [{ type: 'expense', status: 'claiming', amount: 1, docNo: '   ' }] },
    NOW
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].missingDoc, true);
});

test('getBudgetAlerts: จ่ายแล้วแต่ไม่มีหลักฐานแนบ ถือว่าต้องตาม', () => {
  const alerts = getBudgetAlerts(
    { ledger: [{ type: 'expense', status: 'paid', amount: 1, docNo: 'INV-9' }] },
    NOW
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].missingEvidence, true);
});

test('getBudgetAlerts: rejected ไม่ถูกเตือน', () => {
  const alerts = getBudgetAlerts(
    { ledger: [{ type: 'expense', status: 'rejected', amount: 1, dueDate: '2020-01-01' }] },
    NOW
  );
  assert.deepEqual(alerts, []);
});

test('getBudgetAlerts: index ที่คืนมาต้องชี้กลับไปยังตำแหน่งจริงใน ledger', () => {
  const alerts = getBudgetAlerts(project, NOW);
  for (const alert of alerts) {
    assert.equal(project.ledger[alert.index], alert.entry);
  }
});

// ── คะแนนควบคุมงบ ───────────────────────────────────────────────────────────

test('clampPct: บีบ 0-100 และกัน NaN', () => {
  assert.equal(clampPct(50.4), 50);
  assert.equal(clampPct(-10), 0);
  assert.equal(clampPct(140), 100);
  assert.equal(clampPct(NaN), 0);
  assert.equal(clampPct(Infinity), 0);
});

test('getBudgetDecision: คะแนนอยู่ในช่วง 0-100 และ tone สอดคล้อง', () => {
  const summary = getBudgetSummary(project);
  const alerts = getBudgetAlerts(project, NOW);
  const decision = getBudgetDecision(project, summary, alerts);

  assert.ok(decision.score >= 0 && decision.score <= 100);
  const expectedTone = decision.score >= 80 ? 'good' : decision.score >= 58 ? 'watch' : 'risk';
  assert.equal(decision.tone, expectedTone);
  assert.ok(decision.advice.length > 0);
});

test('getBudgetDecision: ไม่ตั้งวงเงิน → แนะนำให้ตั้งงบก่อน', () => {
  const empty = { ledger: [] };
  const summary = getBudgetSummary(empty);
  const decision = getBudgetDecision(empty, summary, []);
  assert.ok(decision.advice.includes('ตั้งวงเงินงบประมาณก่อน'));
});

test('getBudgetDecision: นับรายการที่ขาดเอกสาร', () => {
  const p = { budget: 1000, ledger: [{ type: 'expense', status: 'billed', amount: 100 }] };
  const summary = getBudgetSummary(p);
  const decision = getBudgetDecision(p, summary, getBudgetAlerts(p, NOW));
  assert.equal(decision.missingDocs, 1);
});

// ── การจัดกลุ่ม ─────────────────────────────────────────────────────────────

test('getCategoryBreakdown: รวมตามหมวด เรียงมากไปน้อย ตัด rejected', () => {
  const rows = getCategoryBreakdown(project);
  assert.deepEqual(rows, [
    { label: 'ค่าอาหาร', amount: 25000 },
    { label: 'ค่าวิทยากร', amount: 10000 },
  ]);
});

test('getCategoryBreakdown: ไม่ระบุหมวด → "อื่นๆ"', () => {
  const rows = getCategoryBreakdown({ ledger: [{ type: 'expense', amount: 5 }] });
  assert.equal(rows[0].label, 'อื่นๆ');
});

test('getStatusBreakdown: rejected จะโผล่เฉพาะเมื่อมียอด', () => {
  const withRejected = getStatusBreakdown(project).find((r) => r.value === 'rejected');
  assert.ok(withRejected, 'มียอด rejected จึงต้องแสดง');
  assert.equal(withRejected.amount, 90000);

  const withoutRejected = getStatusBreakdown({ ledger: [] }).find((r) => r.value === 'rejected');
  assert.equal(withoutRejected, undefined);
});

test('getMonthlyCashflow: จัดกลุ่มตามเดือน เรียงตามเวลา', () => {
  const rows = getMonthlyCashflow(project);
  assert.deepEqual(rows.map((r) => r.month), ['2026-01', '2026-02']);
  assert.deepEqual(rows[0], { month: '2026-01', income: 50000, expense: 20000 });
  // ก.พ. — rejected 90000 ต้องไม่ถูกนับ
  assert.deepEqual(rows[1], { month: '2026-02', income: 0, expense: 15000 });
});

test('getMonthlyCashflow: รายการไม่มีวันที่ถูกข้าม', () => {
  assert.deepEqual(getMonthlyCashflow({ ledger: [{ type: 'expense', amount: 100 }] }), []);
});

// ── ทะเบียนคุมวางบิล ────────────────────────────────────────────────────────

test('getBillEntries: เฉพาะ billed / claiming / paid', () => {
  const bills = getBillEntries(project);
  assert.deepEqual(bills.map((b) => b.status), ['paid', 'billed', 'claiming']);
  for (const bill of bills) {
    assert.equal(project.ledger[bill.index], bill.entry);
  }
});

test('getBillAging: จ่ายแล้วแสดงวันที่จ่าย', () => {
  const today = new Date('2026-03-15T00:00:00');
  assert.equal(getBillAging({ paidDate: '2026-03-01' }, 'paid', today).label, 'จ่ายเมื่อ 2026-03-01');
  assert.equal(getBillAging({}, 'paid', today).label, 'จ่ายแล้ว');
});

test('getBillAging: คำนวณจำนวนวันถึง/เกินกำหนด', () => {
  const today = new Date('2026-03-15T00:00:00');
  assert.equal(getBillAging({ dueDate: '2026-03-10' }, 'billed', today).days, -5);
  assert.equal(getBillAging({ dueDate: '2026-03-10' }, 'billed', today).label, 'เกินกำหนด 5 วัน');
  assert.equal(getBillAging({ dueDate: '2026-03-15' }, 'billed', today).label, 'ครบกำหนดวันนี้');
  assert.equal(getBillAging({ dueDate: '2026-03-18' }, 'billed', today).days, 3);
  assert.equal(getBillAging({ dueDate: '2026-04-30' }, 'billed', today).tone, 'text-gray-500');
});

test('getBillAging: ไม่ระบุกำหนดชำระ', () => {
  const today = new Date('2026-03-15T00:00:00');
  const aging = getBillAging({}, 'billed', today);
  assert.equal(aging.label, 'ไม่ระบุกำหนด');
  assert.equal(aging.days, null);
});

// ── ด่านตรวจก่อนเปลี่ยนสถานะ ────────────────────────────────────────────────

test('checkStatusChange: เปลี่ยนเป็นสถานะเดิม = ไม่ทำอะไร', () => {
  assert.deepEqual(checkStatusChange({ status: 'billed' }, 'billed'), { ok: false, warning: null, error: null });
});

test('checkStatusChange: ตั้งเบิกโดยไม่มีเลขที่เอกสาร ต้องเตือน', () => {
  assert.deepEqual(
    checkStatusChange({ status: 'billed' }, 'claiming'),
    { ok: true, warning: 'missing-doc', error: null }
  );
  assert.deepEqual(
    checkStatusChange({ status: 'billed', docNo: '  ' }, 'claiming'),
    { ok: true, warning: 'missing-doc', error: null },
    'เลขเอกสารที่เป็นช่องว่างล้วนไม่นับ'
  );
  assert.deepEqual(
    checkStatusChange({ status: 'billed', docNo: 'INV-1' }, 'claiming'),
    { ok: true, warning: null, error: null }
  );
});

test('checkStatusChange: ปิดจ่ายโดยไม่มีหลักฐาน ต้องเตือน', () => {
  assert.deepEqual(
    checkStatusChange({ status: 'claiming', docNo: 'INV-1' }, 'paid'),
    { ok: true, warning: 'missing-evidence', error: null }
  );
  assert.deepEqual(
    checkStatusChange({ status: 'claiming', docNo: 'INV-1', attachments: [{ name: 'slip' }] }, 'paid'),
    { ok: true, warning: null, error: null }
  );
});

test('checkStatusChange: ไม่อนุมัติต้องขอคำยืนยันเสมอ', () => {
  assert.deepEqual(
    checkStatusChange({ status: 'requested' }, 'rejected'),
    { ok: true, warning: 'confirm-reject', error: null }
  );
});

test('checkStatusChange: เดินตาม workflow ปกติผ่านฉลุย', () => {
  assert.deepEqual(checkStatusChange({ status: 'requested' }, 'approved'), { ok: true, warning: null, error: null });
  assert.deepEqual(checkStatusChange({ status: 'approved' }, 'obligated'), { ok: true, warning: null, error: null });
  assert.deepEqual(checkStatusChange({ status: 'obligated' }, 'billed'), { ok: true, warning: null, error: null });
});
