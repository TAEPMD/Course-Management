/**
 * tests/courseMetrics.test.js
 * เทสต์ตรรกะปีงบประมาณ / งบประมาณ / ความพร้อมของหลักสูตร
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampNumber,
  getFiscalMonthRange,
  isFiscalMonthInRange,
  getProjectExpense,
  getBudgetUsage,
  getBudgetControl,
  getProjectReadiness,
  getProjectProgressInsight,
  getProjectHealthInsight,
  validateProject,
} from '../src/utils/courseMetrics.js';

// ── clampNumber ─────────────────────────────────────────────────────────────

test('clampNumber: บีบค่าให้อยู่ในช่วง', () => {
  assert.equal(clampNumber(5, 1, 12), 5);
  assert.equal(clampNumber(0, 1, 12), 1);
  assert.equal(clampNumber(99, 1, 12), 12);
});

test('clampNumber: ค่าที่ไม่ใช่ตัวเลข คืน fallback', () => {
  assert.equal(clampNumber('abc', 1, 12, 7), 7);
  assert.equal(clampNumber(undefined, 1, 12, 7), 7);
  assert.equal(clampNumber(NaN, 1, 12, 7), 7);
  assert.equal(clampNumber(Infinity, 1, 12, 7), 7);
  // ไม่ระบุ fallback → ใช้ min
  assert.equal(clampNumber('abc', 3, 12), 3);
});

// ── ช่วงเดือนปีงบประมาณ ─────────────────────────────────────────────────────

test('getFiscalMonthRange: ช่วงปกติ', () => {
  assert.deepEqual(getFiscalMonthRange(3, 6), [3, 4, 5, 6]);
  assert.deepEqual(getFiscalMonthRange(5, 5), [5]);
});

test('getFiscalMonthRange: ช่วงที่วนข้ามปลายปี', () => {
  assert.deepEqual(getFiscalMonthRange(11, 2), [11, 12, 1, 2]);
});

test('getFiscalMonthRange: ไม่วนไม่รู้จบ — ยาวสุด 12 เดือน', () => {
  assert.equal(getFiscalMonthRange(1, 12).length, 12);
  // ค่าพังก็ยังต้องจบ
  assert.ok(getFiscalMonthRange('x', 'y').length <= 12);
});

test('isFiscalMonthInRange: ครอบคลุมช่วงที่วนข้ามปี', () => {
  assert.equal(isFiscalMonthInRange(12, 11, 2), true);
  assert.equal(isFiscalMonthInRange(1, 11, 2), true);
  assert.equal(isFiscalMonthInRange(5, 11, 2), false);
});

// ── งบประมาณ ────────────────────────────────────────────────────────────────

const ledgerProject = {
  budget: 100000,
  ledger: [
    { type: 'expense', status: 'paid', amount: 20000 },
    { type: 'expense', status: 'billed', amount: 10000 },
    { type: 'expense', status: 'claiming', amount: 5000 },
    { type: 'expense', status: 'rejected', amount: 90000 }, // ต้องไม่ถูกนับ
    { type: 'income', status: 'paid', amount: 50000 },      // รายรับ ไม่ใช่รายจ่าย
  ],
};

test('getProjectExpense: ไม่นับรายการ rejected และไม่นับรายรับ', () => {
  assert.equal(getProjectExpense(ledgerProject), 35000);
});

test('getProjectExpense: โปรเจกต์ว่าง/undefined ได้ 0 ไม่ throw', () => {
  assert.equal(getProjectExpense(undefined), 0);
  assert.equal(getProjectExpense({}), 0);
  assert.equal(getProjectExpense({ ledger: [] }), 0);
});

test('getBudgetUsage: คำนวณคงเหลือและเปอร์เซ็นต์', () => {
  const usage = getBudgetUsage(ledgerProject);
  assert.equal(usage.budget, 100000);
  assert.equal(usage.expense, 35000);
  assert.equal(usage.remaining, 65000);
  assert.equal(usage.pct, 35);
});

test('getBudgetUsage: งบเป็น 0 ต้องไม่หารด้วยศูนย์', () => {
  const usage = getBudgetUsage({ budget: 0, ledger: [{ type: 'expense', amount: 500 }] });
  assert.equal(usage.pct, 0);
  assert.equal(usage.remaining, -500);
});

test('getBudgetControl: billed ต้องถูกนับเป็นยอดรอเบิก', () => {
  const control = getBudgetControl(ledgerProject);
  assert.equal(control.paid, 20000);
  // billed (10000) + claiming (5000) — ถ้าลืม billed ตัวเลขนี้จะเหลือ 5000
  assert.equal(control.pendingClaim, 15000);
  assert.equal(control.expense, 35000);
  assert.equal(control.usagePct, 35);
});

test('getBudgetControl: รายการไม่ระบุ status ถือเป็น requested (ยังไม่นับรอเบิก)', () => {
  const control = getBudgetControl({ budget: 1000, ledger: [{ type: 'expense', amount: 100 }] });
  assert.equal(control.pendingClaim, 0);
  assert.equal(control.expense, 100);
});

// ── ความพร้อมของหลักสูตร ────────────────────────────────────────────────────

const readyProject = {
  name: 'หลักสูตรกู้ชีพขั้นสูง',
  budget: 100000,
  people: 40,
  schedules: [{ date: '2026-03-01' }],
  startMonth: 3,
  endMonth: 4,
  category: 'อบรม',
  audience: 'พยาบาล',
  assessment: 'สอบข้อเขียน',
};

test('getProjectReadiness: ข้อมูลครบได้ 100', () => {
  const readiness = getProjectReadiness(readyProject);
  assert.equal(readiness.score, 100);
  assert.deepEqual(readiness.missing, []);
  assert.equal(readiness.label, 'พร้อมใช้งาน');
});

test('getProjectReadiness: ชื่อ placeholder ไม่นับว่าตั้งชื่อแล้ว', () => {
  for (const name of ['หลักสูตรใหม่', 'รอกรอก', 'New Course']) {
    const readiness = getProjectReadiness({ ...readyProject, name });
    assert.ok(readiness.missing.includes('ชื่อหลักสูตร'), `"${name}" ควรถือว่ายังไม่ได้ตั้งชื่อ`);
  }
});

test('getProjectReadiness: โปรเจกต์ว่างได้ 0 ไม่ throw', () => {
  const readiness = getProjectReadiness({});
  assert.equal(readiness.score, 0);
  assert.equal(readiness.total, 7);
  assert.equal(readiness.tone, 'rose');
});

// ── ความคืบหน้า ─────────────────────────────────────────────────────────────

test('getProjectProgressInsight: นับเฉพาะรอบที่ผ่านไปแล้ว', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  const project = {
    ...readyProject,
    schedules: [{ date: '2026-01-10' }, { date: '2026-03-10' }, { date: '2026-12-10' }],
  };
  const progress = getProjectProgressInsight(project, now);
  assert.equal(progress.totalSessions, 3);
  assert.equal(progress.completedSessions, 2);
  assert.equal(progress.scheduleScore, 67);
});

test('getProjectProgressInsight: gap = ที่บันทึกไว้ - ที่ระบบแนะนำ', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  const progress = getProjectProgressInsight({ ...readyProject, progress: 90 }, now);
  assert.equal(progress.manual, 90);
  assert.equal(progress.gap, 90 - progress.suggested);
});

test('getProjectProgressInsight: ไม่มีรอบอบรม → scheduleScore 0 ไม่ NaN', () => {
  const progress = getProjectProgressInsight({ ...readyProject, schedules: [] }, new Date());
  assert.equal(progress.scheduleScore, 0);
  assert.ok(Number.isFinite(progress.suggested));
});

// ── สุขภาพหลักสูตร ──────────────────────────────────────────────────────────

test('getProjectHealthInsight: ข้อมูลครบ + ความคืบหน้าสอดคล้องหลักฐาน = on-track', () => {
  const now = new Date('2026-03-02T12:00:00Z');
  // readiness 100 + รอบอบรมผ่านครบ → suggested = 70, บันทึกไว้ 70 จึงไม่มี warning
  const project = { ...readyProject, progress: 70, ledger: [] };
  assert.equal(getProjectProgressInsight(project, now).suggested, 70);

  const health = getProjectHealthInsight(project, now);
  assert.equal(health.level, 'on-track');
  assert.deepEqual(health.issues, []);
  assert.deepEqual(health.warnings, []);
});

test('getProjectHealthInsight: บันทึกคืบหน้าต่ำกว่าหลักฐานมาก = at-risk', () => {
  const now = new Date('2026-03-02T12:00:00Z');
  const health = getProjectHealthInsight({ ...readyProject, progress: 30, ledger: [] }, now);
  assert.equal(health.level, 'at-risk');
  assert.ok(health.warnings.some((w) => w.includes('ต่ำกว่าข้อมูลจริง')));
});

test('getProjectHealthInsight: บันทึกคืบหน้าสูงกว่าหลักฐานมาก = at-risk', () => {
  const now = new Date('2026-03-02T12:00:00Z');
  const health = getProjectHealthInsight({ ...readyProject, progress: 100, ledger: [] }, now);
  assert.equal(health.level, 'at-risk');
  assert.ok(health.warnings.some((w) => w.includes('สูงกว่าหลักฐาน')));
});

test('getProjectHealthInsight: ใช้งบเกินวงเงิน = off-track', () => {
  const now = new Date('2026-03-02T12:00:00Z');
  const health = getProjectHealthInsight(
    { ...readyProject, progress: 30, ledger: [{ type: 'expense', status: 'approved', amount: 100000 }] },
    now
  );
  assert.equal(health.level, 'off-track');
  assert.ok(health.issues.some((r) => r.includes('งบประมาณ')));
});

test('getProjectHealthInsight: มีรายการเบิกเกินกำหนด = off-track', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  const health = getProjectHealthInsight(
    {
      ...readyProject,
      progress: 30,
      ledger: [{ type: 'expense', status: 'claiming', amount: 100, dueDate: '2026-01-01' }],
    },
    now
  );
  assert.equal(health.level, 'off-track');
  assert.ok(health.issues.some((r) => r.includes('เกินกำหนด')));
});

test('getProjectHealthInsight: รายการที่จ่ายแล้วไม่นับว่าเกินกำหนด', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  const health = getProjectHealthInsight(
    {
      ...readyProject,
      progress: 30,
      ledger: [{ type: 'expense', status: 'paid', amount: 100, dueDate: '2026-01-01' }],
    },
    now
  );
  assert.ok(!health.issues.some((r) => r.includes('เกินกำหนด')));
});

test('getProjectHealthInsight: reasons = issues ตามด้วย warnings', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  const health = getProjectHealthInsight({ ...readyProject, ledger: [] }, now);
  assert.deepEqual(health.reasons, [...health.issues, ...health.warnings]);
});

// ── validateProject ─────────────────────────────────────────────────────────

test('validateProject: โปรเจกต์ที่ถูกต้องไม่มี error', () => {
  const result = validateProject({ ...readyProject, year: '2569', progress: 50 });
  assert.deepEqual(result.errors, []);
  assert.equal(result.progress, 50);
  assert.equal(result.startMonth, 3);
  assert.equal(result.endMonth, 4);
});

test('validateProject: ต้องมีชื่อจริงและปีงบประมาณ', () => {
  const result = validateProject({ name: '  ', year: '' });
  assert.ok(result.errors.some((e) => e.includes('ชื่อหลักสูตร')));
  assert.ok(result.errors.some((e) => e.includes('ปีงบประมาณ')));
});

test('validateProject: งบและจำนวนคนติดลบไม่ผ่าน', () => {
  const result = validateProject({ ...readyProject, year: '2569', budget: -1, people: -5 });
  assert.ok(result.errors.some((e) => e.includes('งบประมาณ')));
  assert.ok(result.errors.some((e) => e.includes('จำนวนผู้เข้าอบรม')));
});

test('validateProject: ความคืบหน้าเกิน 100 ถูกบีบกลับมาที่ 100', () => {
  const result = validateProject({ ...readyProject, year: '2569', progress: 250 });
  assert.equal(result.progress, 100);
});
