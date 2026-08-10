import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAutomaticJournals,
  buildProjectJournals,
  getAccountingControl,
  getFinancialStatements,
  getTrialBalance,
  validateJournal,
} from '../src/utils/accounting.js';

const project = {
  accounting: { openingCash: 100000, openingDate: '2026-01-01', journals: [] },
  ledger: [
    { id: 'inc-1', type: 'income', status: 'paid', amount: 50000, paidDate: '2026-01-02', desc: 'เงินสนับสนุน' },
    { id: 'exp-1', type: 'expense', status: 'paid', amount: 20000, cat: 'ค่าอาหาร', docNo: 'INV-1', billDate: '2026-01-05', paidDate: '2026-01-10', desc: 'อาหารอบรม' },
    { id: 'exp-2', type: 'expense', status: 'billed', amount: 10000, cat: 'ค่าวิทยากร', docNo: 'INV-2', billDate: '2026-01-12', desc: 'วิทยากร' },
    { id: 'exp-3', type: 'expense', status: 'obligated', amount: 5000, cat: 'ค่าวัสดุ' },
    { id: 'exp-4', type: 'expense', status: 'rejected', amount: 99999 },
  ],
};

test('validateJournal: รายการสมดุลผ่าน และรายการไม่สมดุลไม่ผ่าน', () => {
  const balanced = validateJournal({
    date: '2026-01-01', description: 'ปรับปรุง',
    lines: [{ account: '5102', debit: 100, credit: 0 }, { account: '2200', debit: 0, credit: 100 }],
  });
  assert.equal(balanced.valid, true);
  assert.equal(balanced.debit, 100);
  assert.equal(balanced.credit, 100);
  assert.equal(validateJournal({
    date: '2026-01-01', description: 'ผิด',
    lines: [{ account: '5102', debit: 100 }, { account: '2200', credit: 90 }],
  }).valid, false);
});

test('buildAutomaticJournals: วางบิลรับรู้เจ้าหนี้และจ่ายเงินล้างเจ้าหนี้', () => {
  const journals = buildAutomaticJournals(project);
  const accrual = journals.find(journal => journal.id === 'auto-exp-1-accrual');
  const payment = journals.find(journal => journal.id === 'auto-exp-1-payment');
  assert.deepEqual(accrual.lines.map(line => [line.account, line.debit, line.credit]), [
    ['5103', 20000, 0], ['2100', 0, 20000],
  ]);
  assert.deepEqual(payment.lines.map(line => [line.account, line.debit, line.credit]), [
    ['2100', 20000, 0], ['1100', 0, 20000],
  ]);
});

test('buildAutomaticJournals: รายการผูกพันยังไม่ลง GL และ rejected ถูกตัดออก', () => {
  const journals = buildAutomaticJournals(project);
  assert.equal(journals.some(journal => journal.sourceId === 'exp-3'), false);
  assert.equal(journals.some(journal => journal.sourceId === 'exp-4'), false);
});

test('getTrialBalance: เดบิตเท่ากับเครดิตเสมอ', () => {
  const trial = getTrialBalance(project);
  assert.equal(trial.balanced, true);
  assert.equal(trial.debit, trial.credit);
  assert.equal(trial.difference, 0);
});

test('getFinancialStatements: รายได้ ค่าใช้จ่าย และสมการบัญชีถูกต้อง', () => {
  const statements = getFinancialStatements(project);
  assert.equal(statements.income.total, 50000);
  assert.equal(statements.expenses.total, 30000);
  assert.equal(statements.surplus, 20000);
  assert.equal(statements.assets.total, 130000);
  assert.equal(statements.liabilities.total, 10000);
  assert.equal(statements.equity.total, 120000);
  assert.equal(statements.equationDifference, 0);
});

test('buildProjectJournals: รวม manual journal ที่สมดุลและไม่รวมรายการ voided', () => {
  const p = structuredClone(project);
  p.accounting.journals = [
    { id: 'j1', date: '2026-01-20', description: 'ค้างจ่าย', lines: [{ account: '5102', debit: 1000 }, { account: '2200', credit: 1000 }] },
    { id: 'j2', date: '2026-01-21', description: 'ยกเลิก', status: 'voided', lines: [{ account: '5102', debit: 500 }, { account: '2200', credit: 500 }] },
  ];
  const journals = buildProjectJournals(p);
  assert.equal(journals.some(journal => journal.id === 'j1'), true);
  assert.equal(journals.some(journal => journal.id === 'j2'), false);
});

test('getAccountingControl: แสดงเงินฝาก เจ้าหนี้ ภาระผูกพัน และสถานะกระทบยอด', () => {
  const p = structuredClone(project);
  p.accounting.reconciliations = [{ date: '2026-01-31', bookBalance: 130000, statementBalance: 130000, difference: 0 }];
  const control = getAccountingControl(p);
  assert.equal(control.bank, 130000);
  assert.equal(control.payable, 10000);
  assert.equal(control.openCommitments, 5000);
  assert.equal(control.reconciliationDifference, 0);
  assert.equal(control.score, 100);
});

