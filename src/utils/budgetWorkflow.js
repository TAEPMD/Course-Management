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

// ── สิทธิ์ในสายงานเบิกจ่าย ──────────────────────────────────────────────────
//
// ใช้ role ชุดเดียวกับที่ระบบมีอยู่ (Admin / Staff / Instructor / Trainee)
// ⚠ นี่เป็นการคุมฝั่งหน้าจอเท่านั้น ด่านจริงต้องอยู่ใน Code.gs ด้วย

/** อนุมัติ / เดินสถานะ / ไม่อนุมัติ ได้ */
export const BUDGET_APPROVER_ROLES = ['Admin', 'Staff'];
/** ตั้งเรื่องขอเบิกและแก้รายการของตัวเองตอนยังไม่อนุมัติได้ */
export const BUDGET_REQUESTER_ROLES = ['Admin', 'Staff', 'Instructor'];
/** ย้อนสถานะกลับ (ใช้แก้กรณีกดพลาด) — จำกัดไว้ที่ Admin */
export const BUDGET_REVERT_ROLES = ['Admin'];

export function canApproveBudget(role) {
  return BUDGET_APPROVER_ROLES.includes(role);
}

export function canRequestBudget(role) {
  return BUDGET_REQUESTER_ROLES.includes(role);
}

export function canRevertBudget(role) {
  return BUDGET_REVERT_ROLES.includes(role);
}

/**
 * แก้ไขเนื้อรายการ (จำนวนเงิน/รายละเอียด/หมวด) ได้หรือไม่
 * - ยังไม่อนุมัติ → ผู้ตั้งเรื่องแก้ได้
 * - อนุมัติแล้วขึ้นไป → เฉพาะผู้มีสิทธิ์อนุมัติ (เงินผูกพันแล้ว)
 * - จ่ายแล้ว → ล็อก ยกเว้น Admin
 */
export function canEditEntry(entry, role) {
  const status = getEntryStatus(entry);
  if (status === 'paid') return canRevertBudget(role);
  if (status === 'requested' || status === 'rejected') return canRequestBudget(role);
  return canApproveBudget(role);
}

// ── การเปลี่ยนสถานะที่อนุญาต ────────────────────────────────────────────────

/**
 * รายการสถานะที่ย้ายไปได้จริงจากสถานะปัจจุบัน
 *
 * กติกา (กันข้ามขั้น — เดิม dropdown เลือกได้ทั้ง 7 สถานะ ทำให้กระโดดจาก
 * "ขออนุมัติ" ไป "จ่ายแล้ว" ได้โดยไม่ผ่านการอนุมัติเลย):
 *  - เดินหน้าได้ทีละขั้นตาม WORKFLOW เท่านั้น
 *  - ไม่อนุมัติ (rejected) ทำได้ทุกสถานะที่ยังไม่จ่าย
 *  - รายการที่ไม่อนุมัติแล้ว เปิดกลับมาเป็น "ขออนุมัติ" ได้
 *  - ย้อนกลับทีละขั้น เฉพาะ role ที่ย้อนได้
 */
export function getAllowedTransitions(entry, role) {
  const status = getEntryStatus(entry);
  const allowed = [];

  // รายรับไม่มีสายอนุมัติ — คุมแค่ว่าใครแก้ได้
  if (getEntryType(entry) === 'income') return allowed;

  if (status === 'rejected') {
    if (canApproveBudget(role)) allowed.push('requested');
    return allowed;
  }

  const pos = WORKFLOW.indexOf(status);
  if (pos === -1) return allowed;

  if (canApproveBudget(role)) {
    if (pos < WORKFLOW.length - 1) allowed.push(WORKFLOW[pos + 1]);
    if (status !== 'paid') allowed.push('rejected');
  }
  if (canRevertBudget(role) && pos > 0) {
    allowed.push(WORKFLOW[pos - 1]);
  }

  return allowed;
}

export function isTransitionAllowed(entry, next, role) {
  return getAllowedTransitions(entry, role).includes(next);
}

/** ย้อนกลับหนึ่งขั้น (null ถ้าย้อนไม่ได้) */
export function getPreviousStatus(entry) {
  const pos = WORKFLOW.indexOf(getEntryStatus(entry));
  if (pos <= 0) return null;
  return WORKFLOW[pos - 1];
}

// ── รหัสประจำรายการ ─────────────────────────────────────────────────────────

/**
 * รายการใน ledger ต้องมี id ของตัวเอง — เดิมอ้างด้วยลำดับใน array
 * ซึ่งเลื่อนได้เมื่อมีการลบ/เรียงใหม่ ทำให้ modal ที่เปิดค้างชี้ผิดรายการ
 */
/**
 * ตัวนับในหน่วยความจำ — รับประกันว่า id ไม่ซ้ำภายใน session เดียว
 *
 * ถ้าพึ่ง Date.now() + Math.random() เพียงสองอย่าง เวลาสร้างรายการรัว ๆ ในมิลลิวินาที
 * เดียวกัน (เช่น ensureLedgerIds เติม id ให้ข้อมูลเก่าทั้งก้อน) ค่า now จะเท่ากันหมด
 * เหลือความสุ่มแค่ช่วงเดียว → ชนกันได้จริงตามหลัก birthday problem
 * และ id เป็นกุญแจที่ findEntryById ใช้ ถ้าชนกันจะหยิบรายการผิด
 */
let entryIdSeq = 0;

export function makeEntryId(now = Date.now(), seed = Math.random()) {
  entryIdSeq = (entryIdSeq + 1) % 0xffffff;
  return 'led-' + now.toString(36)
    + '-' + entryIdSeq.toString(36)
    + '-' + Math.floor(seed * 0xffffffff).toString(36);
}

export function ensureEntryId(entry) {
  if (entry && !entry.id) entry.id = makeEntryId();
  return entry?.id;
}

/** เติม id ให้รายการเก่าที่บันทึกไว้ก่อนมีระบบ id — คืนจำนวนที่เติม */
export function ensureLedgerIds(project) {
  let added = 0;
  for (const entry of project?.ledger || []) {
    if (!entry.id) { ensureEntryId(entry); added += 1; }
  }
  return added;
}

export function findEntryById(project, id) {
  return (project?.ledger || []).find(entry => entry.id === id) || null;
}

export function findEntryIndexById(project, id) {
  return (project?.ledger || []).findIndex(entry => entry.id === id);
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

/**
 * Earned Value / Forecast metrics for project budget governance.
 * BAC = approved baseline, PV/EV use the latest forecast-review progress,
 * AC = paid cost, ETC/EAC may be reviewed manually or estimated statistically.
 */
export function getBudgetPerformance(project, summaryValue) {
  const summary = summaryValue || getBudgetSummary(project);
  const control = project?.budgetControl && typeof project.budgetControl === 'object'
    ? project.budgetControl
    : {};
  const toNonNegative = value => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  };
  const hasManualEtc = Object.prototype.hasOwnProperty.call(control, 'forecastEtc')
    && Number.isFinite(Number(control.forecastEtc))
    && Number(control.forecastEtc) >= 0;

  const bac = toNonNegative(control.baselineAmount ?? summary.budget ?? project?.budget);
  const actualProgress = clampPct(Number(project?.progress || 0));
  const plannedProgress = clampPct(Number(control.plannedProgress ?? actualProgress));
  const pv = bac * (plannedProgress / 100);
  const ev = bac * (actualProgress / 100);
  const ac = toNonNegative(summary.paidExpense);
  const cpi = ac > 0 ? ev / ac : null;
  const spi = pv > 0 ? ev / pv : null;
  const committedUnpaid = Math.max(0, toNonNegative(summary.committedExpense) - ac);
  const statisticalEtc = cpi && cpi > 0
    ? Math.max(committedUnpaid, (bac - ev) / cpi, 0)
    : Math.max(committedUnpaid, bac - ac, 0);
  const etc = hasManualEtc ? toNonNegative(control.forecastEtc) : statisticalEtc;
  const contingency = toNonNegative(control.contingency);
  const eac = ac + etc + contingency;
  const vac = bac - eac;
  const remainingBudget = bac - ac;
  const remainingWork = Math.max(0, bac - ev);
  const tcpi = remainingBudget > 0 ? remainingWork / remainingBudget : null;
  const variancePct = bac > 0 ? (vac / bac) * 100 : 0;
  const tone = bac <= 0 || vac < 0 || (cpi !== null && cpi < 0.9)
    ? 'risk'
    : (variancePct < 5 || (spi !== null && spi < 0.95))
      ? 'watch'
      : 'good';

  return {
    bac, pv, ev, ac, cpi, spi, etc, contingency, eac, vac, tcpi,
    actualProgress, plannedProgress, committedUnpaid, statisticalEtc,
    variancePct, hasManualEtc, tone,
  };
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
 *
 * คืน { ok, warning, error }
 *  - error   = ห้ามทำ (ข้ามขั้น / ไม่มีสิทธิ์) — ไม่มีทางกดผ่าน
 *  - warning = ทำได้แต่ควรถามยืนยันก่อน
 *
 * `role` ไม่ระบุ = ไม่ตรวจสิทธิ์ (เข้ากันได้กับโค้ดเดิมและใช้ตอนเทสต์ตรรกะล้วน)
 */
export function checkStatusChange(entry, next, role = null) {
  const current = getEntryStatus(entry);
  if (!entry || next === current) return { ok: false, warning: null, error: null };

  if (role !== null) {
    if (!isTransitionAllowed(entry, next, role)) {
      const allowed = getAllowedTransitions(entry, role);
      return {
        ok: false,
        warning: null,
        error: allowed.length ? 'not-allowed' : 'no-permission'
      };
    }
  } else if (!WORKFLOW.includes(next) && next !== 'rejected') {
    return { ok: false, warning: null, error: 'unknown-status' };
  }

  if (next === 'claiming' && !String(entry.docNo || '').trim()) {
    return { ok: true, warning: 'missing-doc', error: null };
  }
  if (next === 'paid' && !getAttachments(entry).length) {
    return { ok: true, warning: 'missing-evidence', error: null };
  }
  if (next === 'rejected') {
    return { ok: true, warning: 'confirm-reject', error: null };
  }
  if (getPreviousStatus(entry) === next) {
    return { ok: true, warning: 'confirm-revert', error: null };
  }
  return { ok: true, warning: null, error: null };
}

// ── ความถูกต้องของรายการ ────────────────────────────────────────────────────

/** ฟิลด์ที่เป็นตัวเงิน/สาระสำคัญ — เปลี่ยนแล้วต้องลง audit trail */
export const AUDITED_FIELDS = {
  amount: 'จำนวนเงิน',
  desc: 'รายการ',
  payee: 'ผู้รับเงิน',
  cat: 'หมวดค่าใช้จ่าย',
  type: 'ประเภท',
  docNo: 'เลขที่เอกสาร',
  date: 'วันที่',
  dueDate: 'วันครบกำหนด',
  billDate: 'วันวางบิล',
  paidDate: 'วันที่จ่าย',
  payRef: 'เลขอ้างอิงการจ่าย'
};

/**
 * ตรวจความถูกต้องของรายการหนึ่งบรรทัด
 * คืน array ของข้อความปัญหา (ว่าง = ผ่าน)
 */
export function validateEntry(entry) {
  const errors = [];
  const amount = Number(entry?.amount);

  if (!Number.isFinite(amount)) errors.push('จำนวนเงินไม่ถูกต้อง');
  else if (amount < 0) errors.push('จำนวนเงินต้องไม่ติดลบ');
  else if (amount === 0 && getEntryStatus(entry) !== 'requested') {
    errors.push('จำนวนเงินต้องมากกว่า 0 ก่อนเดินเรื่องต่อ');
  }

  if (!String(entry?.desc || '').trim()) errors.push('ต้องระบุรายการ');

  const status = getEntryStatus(entry);
  // รายรับไม่ได้เดินสายเบิกจ่าย (สถานะเริ่มต้นเป็น paid อยู่แล้ว)
  // จึงไม่ต้องมีเลขที่ใบแจ้งหนี้หรือวันที่จ่าย
  if (getEntryType(entry) === 'expense') {
    if (DOC_REQUIRED_STATUSES.includes(status) && !String(entry?.docNo || '').trim()) {
      errors.push('สถานะนี้ต้องมีเลขที่เอกสาร');
    }
    if (status === 'paid' && !String(entry?.paidDate || '').trim()) {
      errors.push('รายการที่จ่ายแล้วต้องระบุวันที่จ่าย');
    }
  }
  if (entry?.dueDate && entry?.billDate && entry.dueDate < entry.billDate) {
    errors.push('วันครบกำหนดต้องไม่ก่อนวันวางบิล');
  }

  return errors;
}

/** ทำให้ค่าที่รับจาก input อยู่ในรูปที่ปลอดภัยก่อนเก็บลงรายการ */
export function normalizeAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return 0;
  return Math.round(amount * 100) / 100;
}

// ── คุมวงเงิน ───────────────────────────────────────────────────────────────

/**
 * ผลกระทบต่อวงเงินถ้าจะตั้ง/แก้รายจ่ายรายการหนึ่งเป็นจำนวน `nextAmount`
 *
 * นับเฉพาะรายจ่ายที่ยัง active (ไม่รวม rejected) เทียบกับรายรับรวม
 * `entry` = null เมื่อเป็นรายการใหม่
 */
export function checkBudgetCap(project, entry, nextAmount, budgetValue) {
  const summary = getBudgetSummary(project, budgetValue);
  const previous = entry && isActiveExpense(entry) ? Number(entry.amount || 0) : 0;
  const committed = summary.committedExpense - previous + normalizeAmount(nextAmount);
  const overBy = committed - summary.totalIncome;
  const pct = summary.totalIncome > 0 ? Math.round((committed / summary.totalIncome) * 100) : 0;

  return {
    totalIncome: summary.totalIncome,
    committed,
    remaining: summary.totalIncome - committed,
    pct,
    /** ไม่มีวงเงินตั้งไว้ — เตือนแต่ไม่บล็อก */
    noBudget: summary.totalIncome <= 0,
    exceeds: summary.totalIncome > 0 && overBy > 0,
    overBy: overBy > 0 ? overBy : 0
  };
}

// ── Audit trail ─────────────────────────────────────────────────────────────

/**
 * ข้อความบรรยายการแก้ไขฟิลด์ สำหรับลง history
 * คืน null ถ้าไม่ใช่ฟิลด์ที่ต้องบันทึก หรือค่าไม่ได้เปลี่ยนจริง
 */
export function describeFieldChange(field, before, after) {
  const label = AUDITED_FIELDS[field];
  if (!label) return null;

  const from = before === undefined || before === null || before === '' ? '(ว่าง)' : String(before);
  const to = after === undefined || after === null || after === '' ? '(ว่าง)' : String(after);
  if (from === to) return null;

  if (field === 'amount') {
    const fmt = value => Number(value || 0).toLocaleString('th-TH');
    return `แก้${label}: ${fmt(before)} → ${fmt(after)} บาท`;
  }
  return `แก้${label}: ${from} → ${to}`;
}
