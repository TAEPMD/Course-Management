/**
 * utils/budgetWorkflow.js — ตรรกะงบประมาณล้วน ๆ (ไม่แตะ DOM / Swal / gas)
 *
 * แยกออกมาจาก modules/budget.js เพื่อให้เทสต์ได้โดยไม่ต้องมีเบราว์เซอร์
 * ฟังก์ชันที่ต้องใช้ "วันนี้" รับ `now`/`today` เป็นพารามิเตอร์เสมอ
 * เพื่อให้ผลลัพธ์คงที่ตอนเทสต์
 *
 * Workflow: ขออนุมัติ → อนุมัติ → ก่อหนี้/ผูกพัน → วางบิล → ตั้งเบิก → จ่ายแล้ว
 */

export const ACCOUNT_TYPES = [
  { value: 'expense', label: 'รายจ่าย' },
  { value: 'income', label: 'รายรับ' }
];

export const CATEGORIES = [
  'ค่าวิทยากร',
  'ค่าวัสดุ',
  'ค่าอาหาร',
  'ค่าสถานที่',
  'ค่าเดินทาง',
  'ค่าพิมพ์เอกสาร',
  'เงินรับ/สนับสนุน',
  'อื่นๆ'
];

export const BUDGET_STATUSES = [
  { value: 'requested', label: 'ขออนุมัติ', tone: 'bg-slate-100 text-slate-700', icon: 'fa-file-signature' },
  { value: 'approved', label: 'อนุมัติแล้ว', tone: 'bg-blue-50 text-blue-700', icon: 'fa-thumbs-up' },
  { value: 'obligated', label: 'ก่อหนี้/ผูกพัน', tone: 'bg-amber-50 text-amber-700', icon: 'fa-file-contract' },
  { value: 'billed', label: 'วางบิลแล้ว', tone: 'bg-indigo-50 text-indigo-700', icon: 'fa-file-invoice' },
  { value: 'claiming', label: 'ตั้งเบิก/รอจ่าย', tone: 'bg-teal-50 text-teal-700', icon: 'fa-hourglass-half' },
  { value: 'paid', label: 'จ่ายแล้ว', tone: 'bg-emerald-50 text-emerald-700', icon: 'fa-circle-check' },
  { value: 'rejected', label: 'ไม่อนุมัติ', tone: 'bg-rose-50 text-rose-700', icon: 'fa-ban' }
];

export const WORKFLOW = ['requested', 'approved', 'obligated', 'billed', 'claiming', 'paid'];

export const NEXT_ACTION_LABELS = {
  requested: 'อนุมัติรายการ',
  approved: 'บันทึกก่อหนี้/สั่งซื้อ',
  obligated: 'วางบิล',
  billed: 'ตั้งเบิก',
  claiming: 'บันทึกจ่ายเงิน'
};

/** สถานะที่ถือว่า "ค้างจ่าย" — ใช้ร่วมกันหลายที่ ห้ามลืม billed */
export const CLAIM_QUEUE_STATUSES = ['approved', 'obligated', 'billed', 'claiming'];

/** สถานะที่ต้องมีเลขที่เอกสารกำกับแล้ว */
export const DOC_REQUIRED_STATUSES = ['billed', 'claiming', 'paid'];

export function getEntryType(entry) {
  return entry?.type === 'income' ? 'income' : 'expense';
}

export function getEntryStatus(entry) {
  return entry?.status || (getEntryType(entry) === 'income' ? 'paid' : 'requested');
}

export function getStatusMeta(status) {
  return BUDGET_STATUSES.find(item => item.value === status) || BUDGET_STATUSES[0];
}

export function getAttachments(entry) {
  return Array.isArray(entry?.attachments) ? entry.attachments : [];
}

export function getHistory(entry) {
  return Array.isArray(entry?.history) ? entry.history : [];
}

export function getNextStatus(entry) {
  const status = getEntryStatus(entry);
  const pos = WORKFLOW.indexOf(status);
  if (pos === -1 || pos >= WORKFLOW.length - 1) return null;
  return WORKFLOW[pos + 1];
}

export function todayISO(now = new Date()) {
  return now.toISOString().split('T')[0];
}

export function isActiveExpense(entry) {
  return getEntryType(entry) === 'expense' && getEntryStatus(entry) !== 'rejected';
}

export function isPaidExpense(entry) {
  return getEntryType(entry) === 'expense' && getEntryStatus(entry) === 'paid';
}

export function isClaimQueue(entry) {
  return getEntryType(entry) === 'expense' && CLAIM_QUEUE_STATUSES.includes(getEntryStatus(entry));
}

const sumAmount = entries => entries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);

export function getBudgetSummary(project, budgetValue) {
  const budget = Number(budgetValue ?? project?.budget ?? 0);
  const ledger = project?.ledger || [];
  const extraIncome = sumAmount(ledger.filter(entry => getEntryType(entry) === 'income'));
  const totalIncome = budget + extraIncome;
  const committedExpense = sumAmount(ledger.filter(isActiveExpense));
  const paidExpense = sumAmount(ledger.filter(isPaidExpense));
  const claimQueue = sumAmount(ledger.filter(isClaimQueue));
  const rejectedExpense = sumAmount(
    ledger.filter(entry => getEntryType(entry) === 'expense' && getEntryStatus(entry) === 'rejected')
  );
  const available = totalIncome - committedExpense;
  const pct = totalIncome > 0 ? Math.min(Math.round((committedExpense / totalIncome) * 100), 100) : 0;

  return { budget, totalIncome, committedExpense, paidExpense, claimQueue, rejectedExpense, available, pct };
}

export function getBudgetAlerts(project, now = new Date()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return (project?.ledger || [])
    .map((entry, index) => ({ entry, index, status: getEntryStatus(entry) }))
    .filter(({ entry, status }) => getEntryType(entry) === 'expense' && status !== 'rejected')
    .map(item => {
      const dueDate = item.entry.dueDate ? new Date(item.entry.dueDate) : null;
      const overdue = item.status !== 'paid' && dueDate && dueDate < today;
      const missingDoc = DOC_REQUIRED_STATUSES.includes(item.status) && !String(item.entry.docNo || '').trim();
      const missingEvidence = item.status === 'paid' && !getAttachments(item.entry).length;
      return { ...item, overdue, missingDoc, missingEvidence };
    })
    .filter(item => item.overdue || item.missingDoc || item.missingEvidence || ['billed', 'claiming'].includes(item.status));
}

export function clampPct(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.round(value), 100));
}

export function getBudgetDecision(project, summary, alerts) {
  const ledger = project?.ledger || [];
  const activeExpenses = ledger.filter(isActiveExpense);
  const missingDocs = activeExpenses.filter(entry =>
    DOC_REQUIRED_STATUSES.includes(getEntryStatus(entry)) && !String(entry.docNo || '').trim()
  ).length;
  const missingEvidence = activeExpenses.filter(entry =>
    getEntryStatus(entry) === 'paid' && !getAttachments(entry).length
  ).length;
  const overdueAlerts = alerts.filter(item => item.overdue).length;
  const usageControl = summary.totalIncome > 0
    ? clampPct(100 - Math.max(summary.pct - 78, 0) * 2.8)
    : 35;
  const liquidity = summary.totalIncome > 0
    ? clampPct((summary.available / summary.totalIncome) * 100)
    : 0;
  const documentControl = activeExpenses.length
    ? clampPct(100 - ((missingDocs + missingEvidence) / activeExpenses.length) * 100)
    : 100;
  const alertControl = clampPct(100 - alerts.length * 16 - overdueAlerts * 12);
  const execution = summary.committedExpense > 0
    ? clampPct((summary.paidExpense / summary.committedExpense) * 100)
    : 0;
  const score = Math.round(
    (usageControl * .34) +
    (liquidity * .22) +
    (documentControl * .18) +
    (alertControl * .16) +
    (execution * .10)
  );
  const tone = score >= 80 ? 'good' : score >= 58 ? 'watch' : 'risk';
  const title = tone === 'good'
    ? 'ควบคุมงบได้ดี'
    : tone === 'watch'
      ? 'ต้องเฝ้าระวังการใช้จ่าย'
      : 'ควรทบทวนก่อนอนุมัติรายการใหม่';
  const advice = summary.totalIncome <= 0
    ? 'ตั้งวงเงินงบประมาณก่อน เพื่อให้ระบบประเมิน burn rate และงบคงเหลือได้แม่นขึ้น'
    : summary.pct >= 100
      ? 'ยอดผูกพันแตะหรือเกินวงเงินแล้ว ควรหยุดอนุมัติรายการใหม่และตรวจรายการที่ยังไม่จ่าย'
      : alerts.length
        ? 'มีรายการที่ต้องติดตาม ให้ปิดเอกสาร/หลักฐานและกำหนดจ่ายก่อนเพิ่มภาระผูกพันใหม่'
        : summary.pct >= 80
          ? 'งบยังไปต่อได้ แต่ควรอนุมัติเฉพาะรายการที่จำเป็นและมีเอกสารครบ'
          : 'สถานะงบยังอยู่ในกรอบ สามารถวางแผนรายการถัดไปได้';

  return { score, tone, title, advice, usageControl, liquidity, documentControl, alertControl, execution, missingDocs, overdueAlerts };
}

export function getCategoryBreakdown(project) {
  const totals = new Map();
  (project?.ledger || []).filter(isActiveExpense).forEach(entry => {
    const key = entry.cat || 'อื่นๆ';
    totals.set(key, (totals.get(key) || 0) + Number(entry.amount || 0));
  });
  return [...totals.entries()]
    .map(([label, amount]) => ({ label, amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 6);
}

export function getStatusBreakdown(project) {
  return BUDGET_STATUSES.map(status => {
    const amount = sumAmount(
      (project?.ledger || []).filter(entry =>
        getEntryType(entry) === 'expense' && getEntryStatus(entry) === status.value
      )
    );
    return { ...status, amount };
  }).filter(item => item.amount > 0 || item.value !== 'rejected');
}

export function getMonthlyCashflow(project) {
  const monthly = new Map();
  (project?.ledger || []).forEach(entry => {
    const key = String(entry.date || '').slice(0, 7);
    if (!key) return;
    const current = monthly.get(key) || { month: key, income: 0, expense: 0 };
    const amount = Number(entry.amount || 0);
    if (getEntryType(entry) === 'income') current.income += amount;
    else if (getEntryStatus(entry) !== 'rejected') current.expense += amount;
    monthly.set(key, current);
  });
  return [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(-8);
}

// ── ทะเบียนคุมวางบิล / บัญชีเจ้าหนี้ ────────────────────────────────────────

export function getBillEntries(project) {
  return (project?.ledger || [])
    .map((entry, index) => ({ entry, index, status: getEntryStatus(entry) }))
    .filter(({ entry, status }) => getEntryType(entry) === 'expense' && ['billed', 'claiming', 'paid'].includes(status));
}

export function getBillAging(entry, status, today) {
  if (status === 'paid') return { label: entry.paidDate ? `จ่ายเมื่อ ${entry.paidDate}` : 'จ่ายแล้ว', tone: 'text-emerald-600', days: null };
  if (!entry.dueDate) return { label: 'ไม่ระบุกำหนด', tone: 'text-gray-400', days: null };
  const due = new Date(entry.dueDate);
  due.setHours(0, 0, 0, 0);
  const days = Math.round((due - today) / 86400000);
  if (days < 0) return { label: `เกินกำหนด ${-days} วัน`, tone: 'text-rose-600', days };
  if (days === 0) return { label: 'ครบกำหนดวันนี้', tone: 'text-amber-600', days };
  if (days <= 7) return { label: `อีก ${days} วัน`, tone: 'text-amber-600', days };
  return { label: `อีก ${days} วัน`, tone: 'text-gray-500', days };
}

// ── ฟอร์แมตวันที่ ───────────────────────────────────────────────────────────

export function formatBudgetMonth(monthKey) {
  if (!monthKey) return '-';
  const date = new Date(`${monthKey}-01T00:00:00`);
  if (Number.isNaN(date.getTime())) return monthKey;
  return date.toLocaleDateString('th-TH', { month: 'short', year: '2-digit' });
}

export function formatHistoryTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso || '-';
  return date.toLocaleString('th-TH', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/**
 * ตรวจว่าย้ายสถานะได้ไหม (ตรรกะล้วน — ไม่เด้ง dialog)
 * คืน { ok, warning } · warning = เรื่องที่ควรถามผู้ใช้ก่อนยืนยัน
 */
export function checkStatusChange(entry, next) {
  const current = getEntryStatus(entry);
  if (!entry || next === current) return { ok: false, warning: null };

  if (next === 'claiming' && !String(entry.docNo || '').trim()) {
    return { ok: true, warning: 'missing-doc' };
  }
  if (next === 'paid' && !getAttachments(entry).length) {
    return { ok: true, warning: 'missing-evidence' };
  }
  if (next === 'rejected') {
    return { ok: true, warning: 'confirm-reject' };
  }
  return { ok: true, warning: null };
}
