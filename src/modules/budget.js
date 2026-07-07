/**
 * modules/budget.js — Budget Ledger System
 */
import { state } from './state.js';
import { escapeHTML, formatCurrency } from '../utils/format.js';

const ACCOUNT_TYPES = [
  { value: 'expense', label: 'รายจ่าย' },
  { value: 'income', label: 'รายรับ' }
];

const CATEGORIES = [
  'ค่าวิทยากร',
  'ค่าวัสดุ',
  'ค่าอาหาร',
  'ค่าสถานที่',
  'ค่าเดินทาง',
  'ค่าพิมพ์เอกสาร',
  'เงินรับ/สนับสนุน',
  'อื่นๆ'
];

const BUDGET_STATUSES = [
  { value: 'requested', label: 'ขออนุมัติ', tone: 'bg-slate-100 text-slate-700' },
  { value: 'approved', label: 'อนุมัติ', tone: 'bg-blue-50 text-blue-700' },
  { value: 'obligated', label: 'ก่อหนี้/ผูกพัน', tone: 'bg-amber-50 text-amber-700' },
  { value: 'claiming', label: 'รอเบิก', tone: 'bg-teal-50 text-teal-700' },
  { value: 'paid', label: 'เบิกจ่ายแล้ว', tone: 'bg-emerald-50 text-emerald-700' },
  { value: 'rejected', label: 'ไม่อนุมัติ', tone: 'bg-rose-50 text-rose-700' }
];

function getEntryType(entry) {
  return entry?.type === 'income' ? 'income' : 'expense';
}

function refreshProjectIndicatorsIfAvailable() {
  if (typeof window !== 'undefined') window.app?.refreshProjectIndicators?.();
}

function getEntryStatus(entry) {
  return entry?.status || (getEntryType(entry) === 'income' ? 'paid' : 'requested');
}

function getStatusMeta(status) {
  return BUDGET_STATUSES.find(item => item.value === status) || BUDGET_STATUSES[0];
}

function isActiveExpense(entry) {
  return getEntryType(entry) === 'expense' && getEntryStatus(entry) !== 'rejected';
}

function isPaidExpense(entry) {
  return getEntryType(entry) === 'expense' && getEntryStatus(entry) === 'paid';
}

function isClaimQueue(entry) {
  const status = getEntryStatus(entry);
  return getEntryType(entry) === 'expense' && ['approved', 'obligated', 'claiming'].includes(status);
}

function getBudgetSummary(project, budgetValue) {
  const budget = Number(budgetValue ?? project?.budget ?? 0);
  const ledger = project?.ledger || [];
  const extraIncome = ledger
    .filter(entry => getEntryType(entry) === 'income')
    .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const totalIncome = budget + extraIncome;
  const committedExpense = ledger
    .filter(isActiveExpense)
    .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const paidExpense = ledger
    .filter(isPaidExpense)
    .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const claimQueue = ledger
    .filter(isClaimQueue)
    .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const rejectedExpense = ledger
    .filter(entry => getEntryType(entry) === 'expense' && getEntryStatus(entry) === 'rejected')
    .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const available = totalIncome - committedExpense;
  const pct = totalIncome > 0 ? Math.min(Math.round((committedExpense / totalIncome) * 100), 100) : 0;

  return { budget, totalIncome, committedExpense, paidExpense, claimQueue, rejectedExpense, available, pct };
}

function getBudgetAlerts(project) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return (project?.ledger || [])
    .map((entry, index) => ({ entry, index, status: getEntryStatus(entry) }))
    .filter(({ entry, status }) => getEntryType(entry) === 'expense' && status !== 'rejected' && status !== 'paid')
    .map(item => {
      const dueDate = item.entry.dueDate ? new Date(item.entry.dueDate) : null;
      const overdue = dueDate && dueDate < today;
      const missingDoc = ['claiming', 'paid'].includes(item.status) && !item.entry.docNo;
      return { ...item, overdue, missingDoc };
    })
    .filter(item => item.overdue || item.missingDoc || item.status === 'claiming');
}

export function renderBudgetLedger() {
  const p = state.currentProject;
  if (!p) return;
  if (!p.ledger) p.ledger = [];
  const tbody = document.getElementById('budget-ledger-body');
  if (!tbody) return;

  tbody.innerHTML = '';
  if (!p.ledger.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="p-8 text-center text-gray-300 font-bold">ยังไม่มีรายการ — กดปุ่ม "เพิ่มรายการ"</td></tr>`;
  } else {
    p.ledger.forEach((entry, idx) => {
      const type = getEntryType(entry);
      const status = getEntryStatus(entry);
      const statusMeta = getStatusMeta(status);
      const amountClass = type === 'income' ? 'text-emerald-700' : 'text-rose-700';
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-slate-50/50 transition-colors';
      tr.innerHTML = `
        <td class="px-4 py-3">
          <input type="date" value="${escapeHTML(entry.date||'')}" data-idx="${idx}" data-field="date"
            class="ledger-input bg-transparent border-none text-xs font-medium text-gray-600 outline-none w-28">
        </td>
        <td class="px-4 py-3">
          <select data-idx="${idx}" data-field="type"
            class="ledger-input bg-gray-50 border border-gray-100 rounded-lg px-2 py-1 text-xs font-bold focus:ring-2 focus:ring-blue-500 outline-none">
            ${ACCOUNT_TYPES.map(t => `<option value="${t.value}" ${type===t.value?'selected':''}>${t.label}</option>`).join('')}
          </select>
        </td>
        <td class="px-4 py-3 min-w-[220px]">
          <input type="text" value="${escapeHTML(entry.desc||'')}" data-idx="${idx}" data-field="desc" placeholder="รายละเอียด"
            class="ledger-input bg-transparent border-none text-sm font-bold text-gray-800 outline-none w-full">
          <input type="text" value="${escapeHTML(entry.payee||'')}" data-idx="${idx}" data-field="payee" placeholder="ผู้รับเงิน/หน่วยงาน"
            class="ledger-input mt-1 bg-transparent border-none text-[11px] text-gray-400 outline-none w-full">
        </td>
        <td class="px-4 py-3">
          <select data-idx="${idx}" data-field="cat"
            class="ledger-input bg-gray-50 border border-gray-100 rounded-lg px-2 py-1 text-xs font-bold focus:ring-2 focus:ring-blue-500 outline-none">
            ${CATEGORIES.map(c => `<option value="${c}" ${entry.cat===c?'selected':''}>${c}</option>`).join('')}
          </select>
        </td>
        <td class="px-4 py-3">
          <select data-idx="${idx}" data-field="status"
            class="ledger-input border border-gray-100 rounded-lg px-2 py-1 text-xs font-bold focus:ring-2 focus:ring-blue-500 outline-none ${statusMeta.tone}">
            ${BUDGET_STATUSES.map(s => `<option value="${s.value}" ${status===s.value?'selected':''}>${s.label}</option>`).join('')}
          </select>
        </td>
        <td class="px-4 py-3 min-w-[170px]">
          <input type="text" value="${escapeHTML(entry.docNo||'')}" data-idx="${idx}" data-field="docNo" placeholder="เลขที่เอกสาร"
            class="ledger-input bg-white border border-gray-100 rounded-lg px-2 py-1 text-xs font-bold text-gray-700 outline-none w-full focus:ring-2 focus:ring-blue-500">
          <input type="date" value="${escapeHTML(entry.dueDate||'')}" data-idx="${idx}" data-field="dueDate"
            class="ledger-input mt-1 bg-white border border-gray-100 rounded-lg px-2 py-1 text-xs text-gray-500 outline-none w-full focus:ring-2 focus:ring-blue-500">
        </td>
        <td class="px-4 py-3 text-right">
          <input type="number" value="${entry.amount||0}" data-idx="${idx}" data-field="amount"
            class="ledger-input bg-transparent border-none text-sm font-black ${amountClass} text-right outline-none w-28">
        </td>
        <td class="px-4 py-3 text-center">
          <button data-del="${idx}" class="btn-del-ledger w-7 h-7 flex items-center justify-center text-red-400 hover:bg-red-50 rounded-lg transition mx-auto">
            <i class="fa-solid fa-trash text-xs"></i>
          </button>
        </td>`;
      tbody.appendChild(tr);
    });
  }
  // Bind events
  tbody.querySelectorAll('.ledger-input').forEach(el => {
    el.addEventListener('change', e => {
      const idx = +e.target.dataset.idx;
      const field = e.target.dataset.field;
      if (p.ledger[idx]) p.ledger[idx][field] = field === 'amount' ? +e.target.value : e.target.value;
      if (field === 'amount' || field === 'type' || field === 'status' || field === 'dueDate' || field === 'docNo') renderBudgetLedger();
      else renderBudgetSummary();
      refreshProjectIndicatorsIfAvailable();
    });
  });
  tbody.querySelectorAll('.btn-del-ledger').forEach(btn => {
    btn.addEventListener('click', () => {
      p.ledger.splice(+btn.dataset.del, 1);
      renderBudgetLedger();
      refreshProjectIndicatorsIfAvailable();
    });
  });
  renderBudgetSummary();
}

export function addBudgetEntry() {
  const p = state.currentProject;
  if (!p) return;
  if (!p.ledger) p.ledger = [];
  p.ledger.push({
    date: new Date().toISOString().split('T')[0],
    type: 'expense',
    status: 'requested',
    desc: '',
    cat: 'ค่าวัสดุ',
    payee: '',
    docNo: '',
    dueDate: '',
    amount: 0
  });
  renderBudgetLedger();
  refreshProjectIndicatorsIfAvailable();
}

export function exportBudgetReport() {
  const p = state.currentProject;
  if (!p) return;
  const budget = Number(document.getElementById('input-proj-budget')?.value || p.budget || 0);
  const summary = getBudgetSummary(p, budget);
  const header = ['วันที่', 'ประเภท', 'สถานะ', 'รายการ', 'ผู้รับเงิน/หน่วยงาน', 'หมวด', 'เลขที่เอกสาร', 'วันครบกำหนด', 'จำนวนเงิน'];
  const rows = (p.ledger || []).map(entry => {
    const type = getEntryType(entry) === 'income' ? 'รายรับ' : 'รายจ่าย';
    return [
      entry.date || '',
      type,
      getStatusMeta(getEntryStatus(entry)).label,
      entry.desc || '',
      entry.payee || '',
      entry.cat || '',
      entry.docNo || '',
      entry.dueDate || '',
      Number(entry.amount || 0)
    ];
  });
  const summaryRows = [
    [],
    ['สรุปงบประมาณ', '', '', '', '', '', '', 'รายรับรวม', summary.totalIncome],
    ['', '', '', '', '', '', '', 'ยอดอนุมัติ/ผูกพัน', summary.committedExpense],
    ['', '', '', '', '', '', '', 'รอเบิกจ่าย', summary.claimQueue],
    ['', '', '', '', '', '', '', 'เบิกจ่ายแล้ว', summary.paidExpense],
    ['', '', '', '', '', '', '', 'งบคงเหลือหลังผูกพัน', summary.available]
  ];
  const csv = [header, ...rows, ...summaryRows]
    .map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${p.id || 'course'}-budget-report.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function renderBudgetSummary() {
  const p = state.currentProject;
  if (!p) return;
  const budget = Number(document.getElementById('input-proj-budget')?.value || p.budget || 0);
  const summary = getBudgetSummary(p, budget);
  const alerts = getBudgetAlerts(p);

  const el = id => document.getElementById(id);
  if (el('budget-total-income')) el('budget-total-income').textContent = formatCurrency(summary.totalIncome);
  if (el('budget-total-expense')) el('budget-total-expense').textContent = formatCurrency(summary.committedExpense);
  if (el('budget-paid-expense')) el('budget-paid-expense').textContent = formatCurrency(summary.paidExpense);
  if (el('budget-claim-queue')) el('budget-claim-queue').textContent = formatCurrency(summary.claimQueue);
  if (el('budget-rejected-expense')) el('budget-rejected-expense').textContent = formatCurrency(summary.rejectedExpense);
  if (el('budget-alert-count')) el('budget-alert-count').textContent = `${alerts.length} รายการ`;
  if (el('budget-balance')) {
    el('budget-balance').textContent = formatCurrency(summary.available);
    el('budget-balance').className = `text-xl font-black ${summary.available < 0 ? 'text-red-700' : 'text-emerald-700'}`;
  }
  if (el('budget-pct-label'))   el('budget-pct-label').textContent = summary.pct + '%';
  if (el('budget-progress-bar')) {
    el('budget-progress-bar').style.width = summary.pct + '%';
    el('budget-progress-bar').className = `h-3 rounded-full transition-all duration-500 ${summary.pct>=100?'bg-red-500':summary.pct>=80?'bg-amber-500':'bg-blue-500'}`;
  }
  if (el('budget-alert-list')) {
    el('budget-alert-list').innerHTML = alerts.length
      ? alerts.slice(0, 5).map(({ entry, status, overdue, missingDoc }) => {
          const statusMeta = getStatusMeta(status);
          const reason = overdue ? 'เกินกำหนดติดตาม' : missingDoc ? 'ขาดเลขที่เอกสาร' : 'รอเบิกจ่าย';
          return `
            <div class="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2">
              <div class="min-w-0">
                <p class="text-xs font-black text-gray-800 truncate">${escapeHTML(entry.desc || '-')}</p>
                <p class="text-[11px] text-gray-400">${reason} • ${escapeHTML(entry.dueDate || 'ไม่ระบุวันครบกำหนด')}</p>
              </div>
              <span class="shrink-0 px-2 py-1 rounded-lg text-[10px] font-black ${statusMeta.tone}">${statusMeta.label}</span>
            </div>`;
        }).join('')
      : '<p class="text-xs text-gray-400 font-bold">ยังไม่มีรายการที่ต้องติดตาม</p>';
  }
}
