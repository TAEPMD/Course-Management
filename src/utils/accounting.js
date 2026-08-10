/**
 * Project accounting — pure double-entry accounting logic.
 * Budget workflow remains the operational source; this module creates the GL view.
 */

export const CHART_OF_ACCOUNTS = [
  { code: '1100', name: 'เงินสดและเงินฝากธนาคาร', type: 'asset', normal: 'debit' },
  { code: '1200', name: 'ลูกหนี้โครงการ', type: 'asset', normal: 'debit' },
  { code: '1300', name: 'เงินทดรองจ่าย', type: 'asset', normal: 'debit' },
  { code: '1400', name: 'ค่าใช้จ่ายจ่ายล่วงหน้า', type: 'asset', normal: 'debit' },
  { code: '2100', name: 'เจ้าหนี้การค้า/ผู้ให้บริการ', type: 'liability', normal: 'credit' },
  { code: '2200', name: 'ค่าใช้จ่ายค้างจ่าย', type: 'liability', normal: 'credit' },
  { code: '3100', name: 'เงินทุนโครงการ/ยอดยกมา', type: 'equity', normal: 'credit' },
  { code: '4100', name: 'เงินงบประมาณและเงินสนับสนุน', type: 'income', normal: 'credit' },
  { code: '5101', name: 'ค่าใช้จ่ายวิทยากร', type: 'expense', normal: 'debit' },
  { code: '5102', name: 'ค่าใช้จ่ายวัสดุ', type: 'expense', normal: 'debit' },
  { code: '5103', name: 'ค่าใช้จ่ายอาหาร', type: 'expense', normal: 'debit' },
  { code: '5104', name: 'ค่าใช้จ่ายสถานที่', type: 'expense', normal: 'debit' },
  { code: '5105', name: 'ค่าใช้จ่ายเดินทาง', type: 'expense', normal: 'debit' },
  { code: '5106', name: 'ค่าใช้จ่ายพิมพ์เอกสาร', type: 'expense', normal: 'debit' },
  { code: '5199', name: 'ค่าใช้จ่ายโครงการอื่น', type: 'expense', normal: 'debit' },
];

export const CATEGORY_ACCOUNT_MAP = {
  'ค่าวิทยากร': '5101',
  'ค่าวัสดุ': '5102',
  'ค่าอาหาร': '5103',
  'ค่าสถานที่': '5104',
  'ค่าเดินทาง': '5105',
  'ค่าพิมพ์เอกสาร': '5106',
};

const accountMap = new Map(CHART_OF_ACCOUNTS.map(account => [account.code, account]));
const roundMoney = value => Math.round((Number(value) || 0) * 100) / 100;
const entryStatus = entry => entry?.status || (entry?.type === 'income' ? 'paid' : 'requested');
const entryType = entry => entry?.type === 'income' ? 'income' : 'expense';
const line = (account, debit = 0, credit = 0, note = '') => ({
  account,
  debit: roundMoney(debit),
  credit: roundMoney(credit),
  note,
});

export function getAccount(code) {
  return accountMap.get(String(code)) || null;
}

export function getExpenseAccount(category) {
  return CATEGORY_ACCOUNT_MAP[category] || '5199';
}

export function validateJournal(journal) {
  const errors = [];
  const lines = Array.isArray(journal?.lines) ? journal.lines : [];
  if (!String(journal?.date || '').trim()) errors.push('กรุณาระบุวันที่ลงบัญชี');
  if (!String(journal?.description || '').trim()) errors.push('กรุณาระบุคำอธิบายรายการ');
  if (lines.length < 2) errors.push('รายการบัญชีต้องมีอย่างน้อย 2 บรรทัด');

  let debit = 0;
  let credit = 0;
  lines.forEach((item, index) => {
    const d = roundMoney(item?.debit);
    const c = roundMoney(item?.credit);
    if (!getAccount(item?.account)) errors.push(`บรรทัด ${index + 1}: ไม่พบรหัสบัญชี`);
    if (d < 0 || c < 0) errors.push(`บรรทัด ${index + 1}: จำนวนเงินต้องไม่ติดลบ`);
    if ((d > 0 && c > 0) || (d === 0 && c === 0)) errors.push(`บรรทัด ${index + 1}: ต้องเป็นเดบิตหรือเครดิตเพียงด้านเดียว`);
    debit += d;
    credit += c;
  });
  if (Math.abs(debit - credit) > 0.009) errors.push('ยอดเดบิตและเครดิตไม่เท่ากัน');
  return { valid: errors.length === 0, errors, debit: roundMoney(debit), credit: roundMoney(credit) };
}

function autoJournal(base, lines) {
  return {
    id: base.id,
    date: base.date || '',
    ref: base.ref || '',
    description: base.description || '-',
    source: 'budget',
    sourceId: base.sourceId || '',
    status: 'posted',
    lines,
  };
}

export function buildAutomaticJournals(project) {
  const journals = [];
  const openingCash = roundMoney(project?.accounting?.openingCash);
  if (openingCash > 0) {
    journals.push(autoJournal({
      id: 'auto-opening', date: project?.accounting?.openingDate || '', ref: 'OPENING',
      description: 'ยอดเงินสดและเงินฝากยกมา', sourceId: 'opening',
    }, [line('1100', openingCash, 0), line('3100', 0, openingCash)]));
  }

  (project?.ledger || []).forEach((entry, index) => {
    const amount = roundMoney(entry?.amount);
    const status = entryStatus(entry);
    if (amount <= 0 || status === 'rejected') return;
    const sourceId = entry.id || `ledger-${index}`;
    const ref = entry.docNo || entry.payRef || sourceId;

    if (entryType(entry) === 'income' && status === 'paid') {
      journals.push(autoJournal({
        id: `auto-${sourceId}-income`, date: entry.paidDate || entry.date || '', ref,
        description: entry.desc || 'รับเงินสนับสนุนโครงการ', sourceId,
      }, [line('1100', amount, 0), line('4100', 0, amount)]));
      return;
    }

    if (entryType(entry) !== 'expense' || !['billed', 'claiming', 'paid'].includes(status)) return;
    const expenseAccount = getExpenseAccount(entry.cat);
    const hasPayableStage = Boolean(entry.billDate || entry.docNo || entry.dueDate);

    if (status === 'billed' || status === 'claiming' || (status === 'paid' && hasPayableStage)) {
      journals.push(autoJournal({
        id: `auto-${sourceId}-accrual`, date: entry.billDate || entry.date || '', ref,
        description: `รับรู้ค่าใช้จ่าย: ${entry.desc || '-'}`, sourceId,
      }, [line(expenseAccount, amount, 0), line('2100', 0, amount)]));
    }

    if (status === 'paid') {
      journals.push(autoJournal({
        id: `auto-${sourceId}-payment`, date: entry.paidDate || entry.date || '', ref: entry.payRef || ref,
        description: `จ่ายชำระ: ${entry.desc || '-'}`, sourceId,
      }, hasPayableStage
        ? [line('2100', amount, 0), line('1100', 0, amount)]
        : [line(expenseAccount, amount, 0), line('1100', 0, amount)]));
    }
  });
  return journals;
}

export function buildProjectJournals(project) {
  const manual = (project?.accounting?.journals || [])
    .filter(journal => journal?.status !== 'voided' && validateJournal(journal).valid)
    .map(journal => ({ ...journal, source: journal.source || 'manual', status: 'posted' }));
  return [...buildAutomaticJournals(project), ...manual]
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.id).localeCompare(String(b.id)));
}

export function getTrialBalance(project) {
  const totals = new Map(CHART_OF_ACCOUNTS.map(account => [account.code, { ...account, debit: 0, credit: 0, balance: 0 }]));
  buildProjectJournals(project).forEach(journal => {
    journal.lines.forEach(item => {
      const row = totals.get(String(item.account));
      if (!row) return;
      row.debit += roundMoney(item.debit);
      row.credit += roundMoney(item.credit);
    });
  });
  const rows = [...totals.values()].map(row => ({
    ...row,
    debit: roundMoney(row.debit),
    credit: roundMoney(row.credit),
    balance: roundMoney(row.normal === 'debit' ? row.debit - row.credit : row.credit - row.debit),
  })).filter(row => row.debit !== 0 || row.credit !== 0);
  const debit = roundMoney(rows.reduce((sum, row) => sum + row.debit, 0));
  const credit = roundMoney(rows.reduce((sum, row) => sum + row.credit, 0));
  return { rows, debit, credit, balanced: Math.abs(debit - credit) < 0.01, difference: roundMoney(debit - credit) };
}

export function getFinancialStatements(project) {
  const trial = getTrialBalance(project);
  const byType = type => trial.rows.filter(row => row.type === type);
  const sumBalance = rows => roundMoney(rows.reduce((sum, row) => sum + row.balance, 0));
  const assets = byType('asset');
  const liabilities = byType('liability');
  const equityAccounts = byType('equity');
  const incomeAccounts = byType('income');
  const expenseAccounts = byType('expense');
  const income = sumBalance(incomeAccounts);
  const expenses = sumBalance(expenseAccounts);
  const surplus = roundMoney(income - expenses);
  const assetTotal = sumBalance(assets);
  const liabilityTotal = sumBalance(liabilities);
  const equityBeforeResult = sumBalance(equityAccounts);
  const equityTotal = roundMoney(equityBeforeResult + surplus);
  return {
    trial,
    income: { rows: incomeAccounts, total: income },
    expenses: { rows: expenseAccounts, total: expenses },
    surplus,
    assets: { rows: assets, total: assetTotal },
    liabilities: { rows: liabilities, total: liabilityTotal },
    equity: { rows: equityAccounts, beforeResult: equityBeforeResult, total: equityTotal },
    equationDifference: roundMoney(assetTotal - liabilityTotal - equityTotal),
  };
}

export function getAccountingControl(project) {
  const statements = getFinancialStatements(project);
  const accounting = project?.accounting || {};
  const reconciliations = Array.isArray(accounting.reconciliations) ? accounting.reconciliations : [];
  const latestReconciliation = [...reconciliations].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0] || null;
  const bank = statements.trial.rows.find(row => row.code === '1100')?.balance || 0;
  const payable = statements.trial.rows.find(row => row.code === '2100')?.balance || 0;
  const receivable = statements.trial.rows.find(row => row.code === '1200')?.balance || 0;
  const openCommitments = roundMoney((project?.ledger || [])
    .filter(entry => entryType(entry) === 'expense' && ['approved', 'obligated'].includes(entryStatus(entry)))
    .reduce((sum, entry) => sum + Number(entry.amount || 0), 0));
  const reconciliationDifference = latestReconciliation ? roundMoney(latestReconciliation.difference) : null;
  const score = Math.max(0, Math.min(100,
    (statements.trial.balanced ? 35 : 0)
    + (Math.abs(statements.equationDifference) < .01 ? 25 : 0)
    + (latestReconciliation && Math.abs(reconciliationDifference) < .01 ? 25 : latestReconciliation ? 10 : 0)
    + ((accounting.journals || []).every(journal => journal.status === 'voided' || validateJournal(journal).valid) ? 15 : 0)
  ));
  return {
    ...statements,
    bank, payable, receivable, openCommitments,
    latestReconciliation, reconciliationDifference, score,
    tone: score >= 85 ? 'good' : score >= 60 ? 'watch' : 'risk',
  };
}

