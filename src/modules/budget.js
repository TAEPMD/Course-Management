/**
 * modules/budget.js — Budget Ledger System
 * Workflow: ขออนุมัติ → อนุมัติ → ก่อหนี้/ผูกพัน → วางบิล → ตั้งเบิก → จ่ายแล้ว
 * พร้อมหลักฐานการเบิกจ่าย (attachments) และประวัติการเปลี่ยนสถานะ (history)
 */
import { state } from './state.js';
import { escapeHTML, formatCurrency } from '../utils/format.js';
import * as gas from '../gas.js';
import {
  ACCOUNT_TYPES,
  BUDGET_STATUSES,
  CATEGORIES,
  NEXT_ACTION_LABELS,
  WORKFLOW,
  checkStatusChange,
  clampPct,
  formatBudgetMonth,
  formatHistoryTime,
  getAttachments,
  getBillAging,
  getBillEntries,
  getBudgetAlerts,
  getBudgetDecision,
  getBudgetSummary,
  getCategoryBreakdown,
  getEntryStatus,
  getEntryType,
  getHistory,
  getMonthlyCashflow,
  getNextStatus,
  getStatusBreakdown,
  getStatusMeta,
  todayISO,
} from '../utils/budgetWorkflow.js';

const MAX_EVIDENCE_SIZE = 4 * 1024 * 1024; // GAS payload limit ~ keep files under 4MB

let modalEntryIdx = null;

function refreshProjectIndicatorsIfAvailable() {
  if (typeof window !== 'undefined') window.app?.refreshProjectIndicators?.();
}

function recordHistory(entry, text) {
  if (!Array.isArray(entry.history)) entry.history = [];
  entry.history.push({
    at: new Date().toISOString(),
    by: state.currentUserName || 'ไม่ระบุผู้ใช้',
    text
  });
  if (entry.history.length > 50) entry.history = entry.history.slice(-50);
}


// ── Workflow: guarded status change ────────────────────────────────────────

/** ข้อความยืนยันของแต่ละ warning ที่ checkStatusChange คืนมา */
const STATUS_CHANGE_PROMPTS = {
  'missing-doc': {
    title: 'ยังไม่มีเลขที่เอกสาร',
    text: 'ควรกรอกเลขที่ใบแจ้งหนี้/ใบสำคัญก่อนตั้งเบิก ต้องการตั้งเบิกต่อหรือไม่?',
    confirmButtonText: 'ตั้งเบิกต่อ',
    cancelButtonText: 'กลับไปกรอกก่อน',
    confirmButtonColor: '#1e3a8a'
  },
  'missing-evidence': {
    title: 'ยังไม่แนบหลักฐานการจ่าย',
    text: 'แนะนำให้แนบสลิปโอน/ใบเสร็จรับเงินก่อนปิดรายการ ต้องการบันทึกจ่ายเลยหรือไม่?',
    confirmButtonText: 'บันทึกจ่ายเลย',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#1e3a8a'
  },
  'confirm-reject': {
    title: 'ยืนยันไม่อนุมัติรายการนี้?',
    text: 'รายการจะถูกตัดออกจากยอดผูกพันงบประมาณ',
    confirmButtonText: 'ไม่อนุมัติ',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#dc2626'
  }
};

async function requestStatusChange(entry, next) {
  const current = getEntryStatus(entry);
  const { ok, warning } = checkStatusChange(entry, next);
  if (!ok) return false;

  const currentLabel = getStatusMeta(current).label;
  const nextLabel = getStatusMeta(next).label;

  const prompt = warning && STATUS_CHANGE_PROMPTS[warning];
  if (prompt) {
    const res = await Swal.fire({ icon: 'warning', showCancelButton: true, ...prompt });
    if (!res.isConfirmed) return false;
  }

  entry.status = next;
  if (next === 'paid' && !entry.paidDate) entry.paidDate = todayISO();
  recordHistory(entry, `เปลี่ยนสถานะ: ${currentLabel} → ${nextLabel}`);
  return true;
}

// ── Ledger table ────────────────────────────────────────────────────────────

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
      const nextStatus = type === 'expense' && status !== 'rejected' ? getNextStatus(entry) : null;
      const attachCount = getAttachments(entry).length;
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
          ${status === 'paid' && entry.paidDate ? `<p class="mt-1 text-[10px] text-emerald-600 font-bold">จ่ายเมื่อ ${escapeHTML(entry.paidDate)}</p>` : ''}
        </td>
        <td class="px-4 py-3 min-w-[170px]">
          <input type="text" value="${escapeHTML(entry.docNo||'')}" data-idx="${idx}" data-field="docNo" placeholder="เลขที่เอกสาร/ใบแจ้งหนี้"
            class="ledger-input bg-white border border-gray-100 rounded-lg px-2 py-1 text-xs font-bold text-gray-700 outline-none w-full focus:ring-2 focus:ring-blue-500">
          <input type="date" value="${escapeHTML(entry.dueDate||'')}" data-idx="${idx}" data-field="dueDate"
            class="ledger-input mt-1 bg-white border border-gray-100 rounded-lg px-2 py-1 text-xs text-gray-500 outline-none w-full focus:ring-2 focus:ring-blue-500">
        </td>
        <td class="px-4 py-3 text-right">
          <input type="number" value="${entry.amount||0}" data-idx="${idx}" data-field="amount"
            class="ledger-input bg-transparent border-none text-sm font-black ${amountClass} text-right outline-none w-28">
        </td>
        <td class="px-4 py-3">
          <div class="flex items-center justify-center gap-1">
            ${nextStatus ? `
              <button data-next="${idx}" title="${NEXT_ACTION_LABELS[status] || 'ไปขั้นถัดไป'}"
                class="btn-next-ledger w-7 h-7 flex items-center justify-center text-blue-600 hover:bg-blue-50 rounded-lg transition">
                <i class="fa-solid fa-forward-step text-xs"></i>
              </button>` : ''}
            <button data-open="${idx}" title="รายละเอียด / หลักฐาน / ประวัติ"
              class="btn-open-ledger relative w-7 h-7 flex items-center justify-center text-slate-600 hover:bg-slate-100 rounded-lg transition">
              <i class="fa-solid fa-paperclip text-xs"></i>
              ${attachCount ? `<span class="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-0.5 rounded-full bg-blue-600 text-white text-[9px] font-black flex items-center justify-center">${attachCount}</span>` : ''}
            </button>
            <button data-del="${idx}" title="ลบรายการ"
              class="btn-del-ledger w-7 h-7 flex items-center justify-center text-red-400 hover:bg-red-50 rounded-lg transition">
              <i class="fa-solid fa-trash text-xs"></i>
            </button>
          </div>
        </td>`;
      tbody.appendChild(tr);
    });
  }
  // Bind events
  tbody.querySelectorAll('.ledger-input').forEach(el => {
    el.addEventListener('change', e => {
      const idx = +e.target.dataset.idx;
      const field = e.target.dataset.field;
      const entry = p.ledger[idx];
      if (!entry) return;
      if (field === 'status') {
        requestStatusChange(entry, e.target.value).then(() => {
          renderBudgetLedger();
          refreshProjectIndicatorsIfAvailable();
        });
        return;
      }
      entry[field] = field === 'amount' ? +e.target.value : e.target.value;
      if (field === 'amount' || field === 'type' || field === 'dueDate' || field === 'docNo') renderBudgetLedger();
      else renderBudgetSummary();
      refreshProjectIndicatorsIfAvailable();
    });
  });
  tbody.querySelectorAll('.btn-next-ledger').forEach(btn => {
    btn.addEventListener('click', () => {
      const entry = p.ledger[+btn.dataset.next];
      const next = getNextStatus(entry);
      if (!next) return;
      requestStatusChange(entry, next).then(changed => {
        if (!changed) return;
        renderBudgetLedger();
        refreshProjectIndicatorsIfAvailable();
      });
    });
  });
  tbody.querySelectorAll('.btn-open-ledger').forEach(btn => {
    btn.addEventListener('click', () => openBudgetEntry(+btn.dataset.open));
  });
  tbody.querySelectorAll('.btn-del-ledger').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = +btn.dataset.del;
      const entry = p.ledger[idx];
      const res = await Swal.fire({
        icon: 'warning',
        title: 'ลบรายการนี้?',
        text: entry?.desc ? `"${entry.desc}" จะถูกลบพร้อมหลักฐานและประวัติ` : 'รายการจะถูกลบพร้อมหลักฐานและประวัติ',
        showCancelButton: true,
        confirmButtonText: 'ลบรายการ',
        cancelButtonText: 'ยกเลิก',
        confirmButtonColor: '#dc2626'
      });
      if (!res.isConfirmed) return;
      p.ledger.splice(idx, 1);
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
  const entry = {
    date: todayISO(),
    type: 'expense',
    status: 'requested',
    desc: '',
    cat: 'ค่าวัสดุ',
    payee: '',
    docNo: '',
    billDate: '',
    dueDate: '',
    paidDate: '',
    payRef: '',
    note: '',
    amount: 0,
    attachments: [],
    history: []
  };
  recordHistory(entry, 'สร้างรายการ (ขออนุมัติ)');
  p.ledger.push(entry);
  renderBudgetLedger();
  refreshProjectIndicatorsIfAvailable();
}

// ── Billing register (ทะเบียนคุมวางบิล / บัญชีเจ้าหนี้) ────────────────────

function renderBillingPanel(project) {
  const panel = document.getElementById('budget-billing-panel');
  if (!panel || !project) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const bills = getBillEntries(project)
    .map(item => ({ ...item, aging: getBillAging(item.entry, item.status, today) }))
    .sort((a, b) => String(a.entry.dueDate || '9999').localeCompare(String(b.entry.dueDate || '9999')));

  const sum = list => list.reduce((total, { entry }) => total + Number(entry.amount || 0), 0);
  const unpaid = bills.filter(item => item.status !== 'paid');
  const overdue = unpaid.filter(item => item.aging.days !== null && item.aging.days < 0);
  const dueSoon = unpaid.filter(item => item.aging.days !== null && item.aging.days >= 0 && item.aging.days <= 7);
  const paidBills = bills.filter(item => item.status === 'paid');

  const chips = [
    { label: 'บิลค้างจ่าย', count: unpaid.length, amount: sum(unpaid), tone: 'bg-indigo-50 border-indigo-100 text-indigo-700' },
    { label: 'เกินกำหนด', count: overdue.length, amount: sum(overdue), tone: 'bg-rose-50 border-rose-100 text-rose-700' },
    { label: 'ครบกำหนดใน 7 วัน', count: dueSoon.length, amount: sum(dueSoon), tone: 'bg-amber-50 border-amber-100 text-amber-700' },
    { label: 'จ่ายแล้ว', count: paidBills.length, amount: sum(paidBills), tone: 'bg-emerald-50 border-emerald-100 text-emerald-700' }
  ];

  panel.innerHTML = `
    <div class="bg-white rounded-[20px] border border-gray-100 overflow-hidden">
      <div class="p-5 border-b border-gray-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h4 class="font-bold text-gray-800">ทะเบียนคุมวางบิล (บัญชีเจ้าหนี้)</h4>
          <p class="text-xs text-gray-400 mt-0.5">ติดตามใบวางบิล/ใบแจ้งหนี้ที่รับเข้ามา อายุหนี้ และกำหนดจ่าย</p>
        </div>
        <button id="budget-bill-intake-btn" class="px-4 py-2 bg-indigo-600 text-white text-xs font-bold rounded-xl hover:scale-105 transition shrink-0">
          <i class="fa-solid fa-file-invoice mr-1"></i>รับวางบิล
        </button>
      </div>
      <div class="p-5 grid grid-cols-2 xl:grid-cols-4 gap-3">
        ${chips.map(chip => `
          <div class="p-4 rounded-2xl border ${chip.tone}">
            <p class="text-[10px] font-bold uppercase tracking-widest opacity-70">${chip.label}</p>
            <p class="text-lg font-black mt-1">${formatCurrency(chip.amount)}</p>
            <p class="text-[11px] opacity-70">${chip.count} ใบ</p>
          </div>`).join('')}
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left min-w-[900px]">
          <thead>
            <tr class="bg-gray-50">
              <th class="px-4 py-3 text-xs font-bold text-gray-400 uppercase">เลขที่บิล</th>
              <th class="px-4 py-3 text-xs font-bold text-gray-400 uppercase">รายการ / เจ้าหนี้</th>
              <th class="px-4 py-3 text-xs font-bold text-gray-400 uppercase">วันวางบิล</th>
              <th class="px-4 py-3 text-xs font-bold text-gray-400 uppercase">ครบกำหนด</th>
              <th class="px-4 py-3 text-xs font-bold text-gray-400 uppercase">อายุหนี้</th>
              <th class="px-4 py-3 text-xs font-bold text-gray-400 uppercase">สถานะ</th>
              <th class="px-4 py-3 text-xs font-bold text-gray-400 uppercase text-right">จำนวนเงิน</th>
              <th class="px-4 py-3 text-xs font-bold text-gray-400 uppercase text-center">จัดการ</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-50">
            ${bills.length ? bills.map(({ entry, index, status, aging }) => {
              const statusMeta = getStatusMeta(status);
              const next = status !== 'paid' ? getNextStatus(entry) : null;
              return `
                <tr class="hover:bg-slate-50/50 transition-colors">
                  <td class="px-4 py-3 text-xs font-black text-gray-700">${escapeHTML(entry.docNo || '-')}</td>
                  <td class="px-4 py-3 min-w-[200px]">
                    <p class="text-xs font-black text-gray-800 truncate">${escapeHTML(entry.desc || '-')}</p>
                    <p class="text-[11px] text-gray-400">${escapeHTML(entry.payee || 'ไม่ระบุเจ้าหนี้')}</p>
                  </td>
                  <td class="px-4 py-3 text-xs text-gray-500">${escapeHTML(entry.billDate || '-')}</td>
                  <td class="px-4 py-3 text-xs text-gray-500">${escapeHTML(entry.dueDate || '-')}</td>
                  <td class="px-4 py-3 text-xs font-bold ${aging.tone}">${aging.label}</td>
                  <td class="px-4 py-3"><span class="px-2 py-1 rounded-lg text-[10px] font-black ${statusMeta.tone}">${statusMeta.label}</span></td>
                  <td class="px-4 py-3 text-right text-sm font-black text-rose-700">${formatCurrency(Number(entry.amount || 0))}</td>
                  <td class="px-4 py-3">
                    <div class="flex items-center justify-center gap-1">
                      ${next ? `<button data-bill-next="${index}" title="${NEXT_ACTION_LABELS[status] || 'ไปขั้นถัดไป'}" class="w-7 h-7 flex items-center justify-center text-blue-600 hover:bg-blue-50 rounded-lg transition"><i class="fa-solid fa-forward-step text-xs"></i></button>` : ''}
                      <button data-bill-open="${index}" title="รายละเอียด / หลักฐาน" class="w-7 h-7 flex items-center justify-center text-slate-600 hover:bg-slate-100 rounded-lg transition"><i class="fa-solid fa-paperclip text-xs"></i></button>
                    </div>
                  </td>
                </tr>`;
            }).join('') : `<tr><td colspan="8" class="p-8 text-center text-gray-300 font-bold">ยังไม่มีใบวางบิล — กดปุ่ม "รับวางบิล" เมื่อได้รับใบแจ้งหนี้</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>`;

  panel.querySelector('#budget-bill-intake-btn')?.addEventListener('click', () => openBillIntake());
  panel.querySelectorAll('[data-bill-open]').forEach(btn => {
    btn.addEventListener('click', () => openBudgetEntry(+btn.dataset.billOpen));
  });
  panel.querySelectorAll('[data-bill-next]').forEach(btn => {
    btn.addEventListener('click', () => {
      const entry = project.ledger[+btn.dataset.billNext];
      const next = getNextStatus(entry);
      if (!next) return;
      requestStatusChange(entry, next).then(changed => {
        if (!changed) return;
        renderBudgetLedger();
        refreshProjectIndicatorsIfAvailable();
      });
    });
  });
}

export async function openBillIntake() {
  const p = state.currentProject;
  if (!p) return;
  if (!p.ledger) p.ledger = [];
  const eligible = p.ledger
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => getEntryType(entry) === 'expense' && ['requested', 'approved', 'obligated'].includes(getEntryStatus(entry)));

  const inputClass = 'w-full border border-gray-200 rounded-xl px-3 py-2 text-sm font-bold text-gray-700 outline-none focus:ring-2 focus:ring-indigo-500';
  const labelClass = 'block text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1 mt-3 text-left';
  const result = await Swal.fire({
    title: 'รับวางบิล / บันทึกใบแจ้งหนี้',
    width: 620,
    html: `
      <div class="text-left">
        <label class="${labelClass}">ผูกกับรายการงบประมาณ</label>
        <select id="bill-link" class="${inputClass}">
          <option value="new">— สร้างรายการรายจ่ายใหม่ —</option>
          ${eligible.map(({ entry, index }) => `<option value="${index}">${escapeHTML(entry.desc || 'ไม่มีชื่อ')} • ${formatCurrency(Number(entry.amount || 0))} (${getStatusMeta(getEntryStatus(entry)).label})</option>`).join('')}
        </select>
        <label class="${labelClass}">รายการ</label>
        <input id="bill-desc" class="${inputClass}" placeholder="เช่น ค่าอาหารว่างผู้อบรม">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="${labelClass}">ผู้วางบิล / เจ้าหนี้</label>
            <input id="bill-payee" class="${inputClass}" placeholder="ชื่อร้าน/บริษัท/หน่วยงาน">
          </div>
          <div>
            <label class="${labelClass}">หมวดค่าใช้จ่าย</label>
            <select id="bill-cat" class="${inputClass}">${CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}</select>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="${labelClass}">เลขที่บิล/ใบแจ้งหนี้ *</label>
            <input id="bill-docno" class="${inputClass}" placeholder="เช่น INV-2569/001">
          </div>
          <div>
            <label class="${labelClass}">จำนวนเงิน (บาท) *</label>
            <input id="bill-amount" type="number" min="0" class="${inputClass}" placeholder="0">
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="${labelClass}">วันที่รับวางบิล</label>
            <input id="bill-date" type="date" class="${inputClass}" value="${todayISO()}">
          </div>
          <div>
            <label class="${labelClass}">วันครบกำหนดจ่าย</label>
            <input id="bill-due" type="date" class="${inputClass}">
          </div>
        </div>
      </div>`,
    showCancelButton: true,
    confirmButtonText: 'บันทึกวางบิล',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#4f46e5',
    focusConfirm: false,
    didOpen: () => {
      const link = document.getElementById('bill-link');
      link?.addEventListener('change', () => {
        const entry = link.value === 'new' ? null : p.ledger[+link.value];
        if (!entry) return;
        document.getElementById('bill-desc').value = entry.desc || '';
        document.getElementById('bill-payee').value = entry.payee || '';
        document.getElementById('bill-cat').value = entry.cat || 'อื่นๆ';
        document.getElementById('bill-amount').value = Number(entry.amount || 0) || '';
        if (entry.docNo) document.getElementById('bill-docno').value = entry.docNo;
        if (entry.dueDate) document.getElementById('bill-due').value = entry.dueDate;
      });
    },
    preConfirm: () => {
      const value = id => document.getElementById(id)?.value?.trim() || '';
      const data = {
        link: value('bill-link') || 'new',
        desc: value('bill-desc'),
        payee: value('bill-payee'),
        cat: value('bill-cat'),
        docNo: value('bill-docno'),
        amount: Number(value('bill-amount')) || 0,
        billDate: value('bill-date'),
        dueDate: value('bill-due')
      };
      if (!data.docNo) { Swal.showValidationMessage('กรุณากรอกเลขที่บิล/ใบแจ้งหนี้'); return false; }
      if (data.amount <= 0) { Swal.showValidationMessage('กรุณากรอกจำนวนเงินให้ถูกต้อง'); return false; }
      return data;
    }
  });
  if (!result.isConfirmed || !result.value) return;
  const data = result.value;

  let entry;
  if (data.link === 'new') {
    entry = {
      date: data.billDate || todayISO(),
      type: 'expense',
      status: 'requested',
      desc: '', cat: 'อื่นๆ', payee: '', docNo: '', billDate: '', dueDate: '', paidDate: '', payRef: '', note: '',
      amount: 0, attachments: [], history: []
    };
    recordHistory(entry, 'สร้างรายการจากใบวางบิล');
    p.ledger.push(entry);
  } else {
    entry = p.ledger[+data.link];
    if (!entry) return;
  }
  entry.desc = data.desc || entry.desc || 'รายการจากใบวางบิล';
  entry.payee = data.payee || entry.payee || '';
  entry.cat = data.cat || entry.cat || 'อื่นๆ';
  entry.docNo = data.docNo;
  entry.billDate = data.billDate;
  entry.dueDate = data.dueDate;
  entry.amount = data.amount;
  entry.status = 'billed';
  recordHistory(entry, `รับวางบิล เลขที่ ${data.docNo} (ครบกำหนด ${data.dueDate || 'ไม่ระบุ'})`);

  renderBudgetLedger();
  refreshProjectIndicatorsIfAvailable();
  Swal.fire({ icon: 'success', title: 'บันทึกวางบิลแล้ว', text: 'รายการถูกเปลี่ยนสถานะเป็น "วางบิลแล้ว"', toast: true, position: 'top-end', timer: 2200, showConfirmButton: false });
}

// ── Save to cloud ───────────────────────────────────────────────────────────

export async function saveBudgetToCloud() {
  const p = state.currentProject;
  if (!p) return;
  const budgetInput = document.getElementById('input-proj-budget');
  if (budgetInput) p.budget = Math.max(0, Number(budgetInput.value) || 0);
  p.updatedAt = new Date().toISOString();
  try {
    await gas.saveProject(p);
    Swal.fire({ icon: 'success', title: 'บันทึกงบประมาณแล้ว', toast: true, position: 'top-end', timer: 1800, showConfirmButton: false });
  } catch (e) {
    Swal.fire({ icon: 'error', title: 'บันทึกล้มเหลว', text: e.message });
  }
}

async function persistQuietly() {
  const p = state.currentProject;
  if (!p) return;
  try {
    await gas.saveProject(p);
  } catch (e) {
    Swal.fire({
      icon: 'warning',
      title: 'ยังไม่ได้บันทึกขึ้นคลาวด์',
      text: 'ข้อมูลถูกเก็บในหน้าจอแล้ว แต่ส่งขึ้นระบบไม่สำเร็จ — กด "บันทึกงบประมาณ" อีกครั้งภายหลัง',
      toast: true, position: 'top-end', timer: 3200, showConfirmButton: false
    });
  }
}

// ── Entry detail modal (หลักฐาน / ประวัติ / การจ่าย) ───────────────────────

function closeBudgetEntryModal() {
  modalEntryIdx = null;
  const modal = document.getElementById('budget-entry-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.innerHTML = '';
  }
  document.removeEventListener('keydown', onModalKeydown);
}

function onModalKeydown(e) {
  if (e.key === 'Escape') closeBudgetEntryModal();
}

export function openBudgetEntry(idx) {
  const p = state.currentProject;
  const entry = p?.ledger?.[idx];
  const modal = document.getElementById('budget-entry-modal');
  if (!entry || !modal) return;
  modalEntryIdx = idx;
  document.addEventListener('keydown', onModalKeydown);
  renderBudgetEntryModal();
}

function renderBudgetEntryModal() {
  const p = state.currentProject;
  const entry = p?.ledger?.[modalEntryIdx];
  const modal = document.getElementById('budget-entry-modal');
  if (!entry || !modal) { closeBudgetEntryModal(); return; }

  const type = getEntryType(entry);
  const status = getEntryStatus(entry);
  const statusMeta = getStatusMeta(status);
  const attachments = getAttachments(entry);
  const history = getHistory(entry).slice().reverse();
  const nextStatus = type === 'expense' && status !== 'rejected' ? getNextStatus(entry) : null;
  const currentPos = WORKFLOW.indexOf(status);

  modal.classList.remove('hidden');
  modal.innerHTML = `
    <div class="budget-modal-backdrop" data-close="1">
      <div class="budget-modal" role="dialog" aria-modal="true" aria-label="รายละเอียดรายการงบประมาณ">
        <header class="budget-modal-head">
          <div class="min-w-0">
            <span class="px-2 py-1 rounded-lg text-[10px] font-black ${statusMeta.tone}"><i class="fa-solid ${statusMeta.icon} mr-1"></i>${statusMeta.label}</span>
            <h4 class="mt-2 text-base font-black text-gray-800 truncate">${escapeHTML(entry.desc || 'รายการไม่มีชื่อ')}</h4>
            <p class="text-xs text-gray-400 mt-0.5">${escapeHTML(entry.cat || '-')} • ${escapeHTML(entry.payee || 'ไม่ระบุผู้รับเงิน')} • ${escapeHTML(entry.date || '-')}</p>
          </div>
          <div class="text-right shrink-0">
            <p class="text-xl font-black ${type === 'income' ? 'text-emerald-600' : 'text-rose-600'}">${formatCurrency(Number(entry.amount || 0))}</p>
            <button data-close="1" class="mt-1 text-xs font-bold text-gray-400 hover:text-gray-600"><i class="fa-solid fa-xmark mr-1"></i>ปิด</button>
          </div>
        </header>

        ${type === 'expense' ? `
        <div class="budget-stepper">
          ${WORKFLOW.map((step, i) => {
            const meta = getStatusMeta(step);
            const stateClass = status === 'rejected' ? 'off' : i < currentPos ? 'done' : i === currentPos ? 'current' : 'todo';
            return `
              <button class="budget-step ${stateClass}" data-step="${step}" title="เปลี่ยนสถานะเป็น: ${meta.label}">
                <span class="budget-step-dot"><i class="fa-solid ${meta.icon}"></i></span>
                <span class="budget-step-label">${meta.label}</span>
              </button>${i < WORKFLOW.length - 1 ? '<span class="budget-step-line"></span>' : ''}`;
          }).join('')}
        </div>
        <div class="budget-modal-actions">
          ${nextStatus ? `<button data-advance="${nextStatus}" class="px-4 py-2 bg-blue-900 text-white text-xs font-bold rounded-xl hover:scale-105 transition"><i class="fa-solid fa-forward-step mr-1"></i>${NEXT_ACTION_LABELS[status] || 'ไปขั้นถัดไป'}</button>` : ''}
          ${status !== 'rejected' && status !== 'paid' ? `<button data-advance="rejected" class="px-4 py-2 bg-white border border-rose-200 text-rose-600 text-xs font-bold rounded-xl hover:bg-rose-50 transition"><i class="fa-solid fa-ban mr-1"></i>ไม่อนุมัติ</button>` : ''}
          ${status === 'rejected' ? `<button data-advance="requested" class="px-4 py-2 bg-white border border-gray-200 text-gray-600 text-xs font-bold rounded-xl hover:bg-gray-50 transition"><i class="fa-solid fa-rotate-left mr-1"></i>นำกลับมาขออนุมัติใหม่</button>` : ''}
        </div>` : ''}

        <div class="budget-modal-grid">
          <section class="budget-modal-card">
            <h5><i class="fa-solid fa-money-check-dollar mr-1"></i>ข้อมูลเอกสารและการจ่าย</h5>
            <label>เลขที่เอกสาร/ใบแจ้งหนี้ (ใช้ตอนวางบิล-ตั้งเบิก)
              <input type="text" data-mfield="docNo" value="${escapeHTML(entry.docNo || '')}" placeholder="เช่น INV-2569/001">
            </label>
            <div class="budget-modal-two">
              <label>วันที่รับวางบิล
                <input type="date" data-mfield="billDate" value="${escapeHTML(entry.billDate || '')}">
              </label>
              <label>วันครบกำหนดจ่าย
                <input type="date" data-mfield="dueDate" value="${escapeHTML(entry.dueDate || '')}">
              </label>
            </div>
            <div class="budget-modal-two">
              <label>วันที่จ่ายจริง
                <input type="date" data-mfield="paidDate" value="${escapeHTML(entry.paidDate || '')}">
              </label>
              <label>ผู้วางบิล/ผู้รับเงิน
                <input type="text" data-mfield="payee" value="${escapeHTML(entry.payee || '')}" placeholder="ชื่อร้าน/บริษัท/หน่วยงาน">
              </label>
            </div>
            <label>เลขอ้างอิงการจ่าย (เลขเช็ค/รายการโอน/ใบสำคัญจ่าย)
              <input type="text" data-mfield="payRef" value="${escapeHTML(entry.payRef || '')}" placeholder="เช่น PV-069/2569">
            </label>
            <label>หมายเหตุ
              <textarea data-mfield="note" rows="2" placeholder="รายละเอียดเพิ่มเติม">${escapeHTML(entry.note || '')}</textarea>
            </label>
          </section>

          <section class="budget-modal-card">
            <h5><i class="fa-solid fa-file-shield mr-1"></i>หลักฐานการเบิกจ่าย <span class="budget-count-chip">${attachments.length}</span></h5>
            <div class="budget-evidence-list">
              ${attachments.length ? attachments.map((file, i) => `
                <div class="budget-evidence-row">
                  <span class="budget-evidence-icon"><i class="fa-solid fa-file-invoice-dollar"></i></span>
                  <div class="min-w-0">
                    <p class="truncate">${escapeHTML(file.name || 'ไฟล์แนบ')}</p>
                    <small>${escapeHTML(file.date || '')}${file.url?.startsWith('data:') ? ' • เก็บชั่วคราว (ยังไม่ขึ้น Drive)' : ''}</small>
                  </div>
                  <button data-view-file="${i}" title="เปิดดู"><i class="fa-solid fa-eye"></i></button>
                  <button data-del-file="${i}" title="ลบหลักฐาน" class="danger"><i class="fa-solid fa-trash"></i></button>
                </div>`).join('') : '<p class="budget-empty-text">ยังไม่มีหลักฐาน — แนบสลิปโอน ใบเสร็จ หรือใบวางบิล</p>'}
            </div>
            <input type="file" id="budget-evidence-input" class="hidden" accept="image/*,.pdf">
            <button id="budget-evidence-upload" class="budget-upload-btn"><i class="fa-solid fa-cloud-arrow-up mr-1"></i>แนบหลักฐาน (รูป/PDF ไม่เกิน 4MB)</button>
          </section>

          <section class="budget-modal-card budget-modal-history">
            <h5><i class="fa-solid fa-clock-rotate-left mr-1"></i>ประวัติการดำเนินการ</h5>
            <div class="budget-history-list">
              ${history.length ? history.map(item => `
                <div class="budget-history-row">
                  <span class="budget-history-dot"></span>
                  <div>
                    <p>${escapeHTML(item.text || '')}</p>
                    <small>${formatHistoryTime(item.at)} • ${escapeHTML(item.by || '-')}</small>
                  </div>
                </div>`).join('') : '<p class="budget-empty-text">ยังไม่มีประวัติ</p>'}
            </div>
          </section>
        </div>

        <footer class="budget-modal-foot">
          <button id="budget-modal-save" class="px-4 py-2 bg-emerald-600 text-white text-xs font-bold rounded-xl hover:scale-105 transition"><i class="fa-solid fa-cloud-arrow-up mr-1"></i>บันทึกงบประมาณขึ้นระบบ</button>
          <button data-close="1" class="px-4 py-2 bg-white border border-gray-200 text-gray-600 text-xs font-bold rounded-xl hover:bg-gray-50 transition">ปิดหน้าต่าง</button>
        </footer>
      </div>
    </div>`;

  bindBudgetEntryModal(entry);
}

function bindBudgetEntryModal(entry) {
  const modal = document.getElementById('budget-entry-modal');
  if (!modal) return;

  modal.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('click', e => {
      if (el.classList.contains('budget-modal-backdrop') && e.target !== el) return;
      closeBudgetEntryModal();
      renderBudgetLedger();
      refreshProjectIndicatorsIfAvailable();
    });
  });

  modal.querySelectorAll('[data-mfield]').forEach(el => {
    el.addEventListener('change', () => {
      entry[el.dataset.mfield] = el.value;
    });
  });

  const changeStatus = next => {
    requestStatusChange(entry, next).then(changed => {
      if (changed) renderBudgetEntryModal();
    });
  };
  modal.querySelectorAll('[data-step]').forEach(btn => {
    btn.addEventListener('click', () => changeStatus(btn.dataset.step));
  });
  modal.querySelectorAll('[data-advance]').forEach(btn => {
    btn.addEventListener('click', () => changeStatus(btn.dataset.advance));
  });

  const fileInput = modal.querySelector('#budget-evidence-input');
  modal.querySelector('#budget-evidence-upload')?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) uploadEvidence(entry, file);
  });

  modal.querySelectorAll('[data-view-file]').forEach(btn => {
    btn.addEventListener('click', () => viewEvidence(entry, +btn.dataset.viewFile));
  });
  modal.querySelectorAll('[data-del-file]').forEach(btn => {
    btn.addEventListener('click', () => deleteEvidence(entry, +btn.dataset.delFile));
  });

  modal.querySelector('#budget-modal-save')?.addEventListener('click', () => saveBudgetToCloud());
}

async function uploadEvidence(entry, file) {
  if (file.size > MAX_EVIDENCE_SIZE) {
    Swal.fire({ icon: 'warning', title: 'ไฟล์ใหญ่เกินไป', text: 'กรุณาใช้ไฟล์ขนาดไม่เกิน 4MB' });
    return;
  }
  Swal.fire({ title: `กำลังอัปโหลด ${file.name}...`, allowOutsideClick: false, didOpen: () => Swal.showLoading() });
  const reader = new FileReader();
  reader.onload = async e => {
    let url;
    let storedLocally = false;
    try {
      url = await gas.uploadFile(e.target.result.split(',')[1], file.name);
    } catch {
      url = e.target.result;
      storedLocally = true;
    }
    if (!Array.isArray(entry.attachments)) entry.attachments = [];
    entry.attachments.push({ name: file.name, date: todayISO(), url });
    recordHistory(entry, `แนบหลักฐาน: ${file.name}`);
    await persistQuietly();
    Swal.close();
    if (storedLocally) {
      Swal.fire({
        icon: 'info',
        title: 'เก็บไฟล์แบบชั่วคราว',
        text: 'อัปโหลดขึ้น Google Drive ไม่สำเร็จ ไฟล์ถูกเก็บในข้อมูลโครงการแทน ควรลองแนบใหม่เมื่อระบบเชื่อมต่อได้',
        toast: true, position: 'top-end', timer: 3500, showConfirmButton: false
      });
    } else {
      Swal.fire({ icon: 'success', title: 'แนบหลักฐานแล้ว', toast: true, position: 'top-end', timer: 1500, showConfirmButton: false });
    }
    renderBudgetEntryModal();
  };
  reader.readAsDataURL(file);
}

function viewEvidence(entry, fileIdx) {
  const file = getAttachments(entry)[fileIdx];
  if (!file?.url) return;
  if (!file.url.startsWith('data:')) {
    window.open(file.url, '_blank');
    return;
  }
  try {
    const matches = file.url.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
    if (!matches) throw new Error('ข้อมูลไฟล์ไม่ถูกต้อง');
    const mimeType = matches[1] || 'application/octet-stream';
    const decoded = matches[2] ? atob(matches[3] || '') : decodeURIComponent(matches[3] || '');
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i);
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    window.open(objectUrl, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch (error) {
    Swal.fire({ icon: 'error', title: 'เปิดไฟล์ไม่สำเร็จ', text: error.message });
  }
}

async function deleteEvidence(entry, fileIdx) {
  const file = getAttachments(entry)[fileIdx];
  if (!file) return;
  const res = await Swal.fire({
    icon: 'warning',
    title: 'ลบหลักฐานนี้?',
    text: `"${file.name || 'ไฟล์แนบ'}" จะถูกลบออกจากรายการ`,
    showCancelButton: true,
    confirmButtonText: 'ลบหลักฐาน',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#dc2626'
  });
  if (!res.isConfirmed) return;
  const fileIdMatch = file.url?.match(/[?&]id=([^&]+)/);
  if (fileIdMatch) {
    try { await gas.deleteFile(fileIdMatch[1]); } catch (e) { console.warn('Drive delete failed but continuing', e); }
  }
  entry.attachments.splice(fileIdx, 1);
  recordHistory(entry, `ลบหลักฐาน: ${file.name || 'ไฟล์แนบ'}`);
  await persistQuietly();
  renderBudgetEntryModal();
}

// ── Export ──────────────────────────────────────────────────────────────────

export function exportBudgetReport() {
  const p = state.currentProject;
  if (!p) return;
  const budget = Number(document.getElementById('input-proj-budget')?.value || p.budget || 0);
  const summary = getBudgetSummary(p, budget);
  const header = ['วันที่', 'ประเภท', 'สถานะ', 'รายการ', 'ผู้รับเงิน/หน่วยงาน', 'หมวด', 'เลขที่เอกสาร', 'วันวางบิล', 'วันครบกำหนด', 'วันที่จ่ายจริง', 'เลขอ้างอิงการจ่าย', 'จำนวนหลักฐาน', 'หมายเหตุ', 'จำนวนเงิน'];
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
      entry.billDate || '',
      entry.dueDate || '',
      entry.paidDate || '',
      entry.payRef || '',
      getAttachments(entry).length,
      entry.note || '',
      Number(entry.amount || 0)
    ];
  });
  const summaryRow = (label, value) => ['สรุปงบประมาณ', ...Array(11).fill(''), label, value];
  const summaryRows = [
    [],
    summaryRow('รายรับรวม', summary.totalIncome),
    summaryRow('ยอดอนุมัติ/ผูกพัน', summary.committedExpense),
    summaryRow('วางบิล/รอเบิกจ่าย', summary.claimQueue),
    summaryRow('เบิกจ่ายแล้ว', summary.paidExpense),
    summaryRow('งบคงเหลือหลังผูกพัน', summary.available)
  ];
  const csv = [header, ...rows, ...summaryRows]
    .map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${p.id || 'course'}-budget-report.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Summary / dashboard ─────────────────────────────────────────────────────

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
      ? alerts.slice(0, 5).map(({ entry, index, status, overdue, missingDoc, missingEvidence }) => {
          const statusMeta = getStatusMeta(status);
          const reason = overdue
            ? 'เกินกำหนดติดตาม'
            : missingEvidence
              ? 'จ่ายแล้วแต่ยังไม่แนบหลักฐาน'
              : missingDoc
                ? 'ขาดเลขที่เอกสาร'
                : status === 'billed'
                  ? 'วางบิลแล้ว รอตั้งเบิก'
                  : 'ตั้งเบิกแล้ว รอจ่าย';
          return `
            <button data-alert-idx="${index}" class="w-full text-left flex items-center justify-between gap-3 rounded-xl bg-slate-50 hover:bg-slate-100 transition px-3 py-2">
              <div class="min-w-0">
                <p class="text-xs font-black text-gray-800 truncate">${escapeHTML(entry.desc || '-')}</p>
                <p class="text-[11px] text-gray-400">${reason} • ${escapeHTML(entry.dueDate || 'ไม่ระบุวันครบกำหนด')}</p>
              </div>
              <span class="shrink-0 px-2 py-1 rounded-lg text-[10px] font-black ${statusMeta.tone}">${statusMeta.label}</span>
            </button>`;
        }).join('')
      : '<p class="text-xs text-gray-400 font-bold">ยังไม่มีรายการที่ต้องติดตาม</p>';
    el('budget-alert-list').querySelectorAll('[data-alert-idx]').forEach(btn => {
      btn.addEventListener('click', () => openBudgetEntry(+btn.dataset.alertIdx));
    });
  }
  renderBudgetVisualPanel(p, summary, alerts);
  renderBillingPanel(p);
}

const CONTROL_LEVELS = {
  good: 'ดี',
  watch: 'เฝ้าระวัง',
  risk: 'ต้องแก้ไข',
  info: 'ข้อมูล'
};

function toneByScore(value, goodAt = 80, watchAt = 50) {
  return value >= goodAt ? 'good' : value >= watchAt ? 'watch' : 'risk';
}

function getControlIndicators(decision, summary, alerts) {
  const overdueCount = alerts.filter(item => item.overdue).length;
  const usageTone = toneByScore(decision.usageControl);
  const liquidityTone = toneByScore(decision.liquidity, 50, 20);
  const docTone = toneByScore(decision.documentControl, 95, 75);
  const alertTone = toneByScore(decision.alertControl);
  const executionTone = summary.committedExpense <= 0 || decision.execution === 0
    ? 'info'
    : decision.execution >= 80 ? 'good' : 'info';

  return [
    {
      label: 'คุมวงเงิน', icon: 'fa-scale-balanced', value: decision.usageControl, tone: usageTone,
      level: CONTROL_LEVELS[usageTone],
      note: summary.totalIncome <= 0
        ? 'ยังไม่ได้ตั้งวงเงินงบประมาณ'
        : usageTone === 'good'
          ? `ผูกพันแล้ว ${summary.pct}% ยังอยู่ในกรอบวงเงิน`
          : usageTone === 'watch'
            ? `ผูกพันแล้ว ${summary.pct}% เริ่มใกล้เพดานวงเงิน`
            : `ผูกพันแล้ว ${summary.pct}% ชนหรือเกินเพดานวงเงิน`
    },
    {
      label: 'สภาพคล่อง', icon: 'fa-droplet', value: decision.liquidity, tone: liquidityTone,
      level: CONTROL_LEVELS[liquidityTone],
      note: liquidityTone === 'good'
        ? `เหลืองบใช้ได้อีก ${formatCurrency(summary.available)} บาท`
        : liquidityTone === 'watch'
          ? `งบคงเหลือ ${formatCurrency(summary.available)} บาท ควรใช้อย่างรอบคอบ`
          : summary.available < 0
            ? `งบติดลบ ${formatCurrency(Math.abs(summary.available))} บาท`
            : `งบเหลือน้อยมาก (${formatCurrency(summary.available)} บาท)`
    },
    {
      label: 'เอกสาร/หลักฐาน', icon: 'fa-clipboard-check', value: decision.documentControl, tone: docTone,
      level: CONTROL_LEVELS[docTone],
      note: docTone === 'good'
        ? 'เอกสารและหลักฐานครบเกือบทุกรายการ'
        : `มีรายการขาดเลขเอกสาร/หลักฐาน ${decision.missingDocs || 'บาง'} รายการ ควรตามให้ครบ`
    },
    {
      label: 'ความเสี่ยงติดตาม', icon: 'fa-bell', value: decision.alertControl, tone: alertTone,
      level: CONTROL_LEVELS[alertTone],
      note: alerts.length === 0
        ? 'ไม่มีรายการค้างติดตาม'
        : overdueCount > 0
          ? `ค้างติดตาม ${alerts.length} รายการ (เกินกำหนด ${overdueCount})`
          : `มีรายการรอติดตาม ${alerts.length} รายการ`
    },
    {
      label: 'ความคืบหน้าเบิกจ่าย', icon: 'fa-flag-checkered', value: decision.execution, tone: executionTone,
      level: executionTone === 'good' ? 'ใกล้ครบ' : decision.execution === 0 ? 'ยังไม่เริ่ม' : 'ระหว่างทาง',
      note: summary.committedExpense <= 0
        ? 'ยังไม่มีรายการผูกพันให้เบิกจ่าย'
        : decision.execution === 0
          ? 'ยังไม่มีรายการที่จ่ายจริง — ปกติในช่วงต้นโครงการ'
          : `จ่ายจริงแล้ว ${formatCurrency(summary.paidExpense)} จากยอดผูกพัน ${formatCurrency(summary.committedExpense)}`
    }
  ];
}

function renderBudgetVisualPanel(project, summary, alerts) {
  const panel = document.getElementById('budget-visual-panel');
  if (!panel || !project) return;

  const decision = getBudgetDecision(project, summary, alerts);
  const gaugeAngle = decision.score * 3.6;
  const usageAngle = summary.pct * 3.6;
  const categoryRows = getCategoryBreakdown(project);
  const categoryTotal = categoryRows.reduce((sum, item) => sum + item.amount, 0);
  const statusRows = getStatusBreakdown(project);
  const statusMax = Math.max(...statusRows.map(item => item.amount), 1);
  const monthlyRows = getMonthlyCashflow(project);
  const monthlyMax = Math.max(...monthlyRows.flatMap(item => [item.income, item.expense]), 1);
  const flowMax = Math.max(summary.totalIncome, summary.committedExpense, summary.paidExpense, summary.claimQueue, Math.abs(summary.available), 1);
  const flowItems = [
    { label: 'รายรับรวม', value: summary.totalIncome, className: 'income' },
    { label: 'ผูกพัน', value: summary.committedExpense, className: 'committed' },
    { label: 'วางบิล/รอเบิก', value: summary.claimQueue, className: 'claim' },
    { label: 'จ่ายแล้ว', value: summary.paidExpense, className: 'paid' },
    { label: 'คงเหลือ', value: summary.available, className: summary.available < 0 ? 'negative' : 'available' }
  ];
  const controlItems = getControlIndicators(decision, summary, alerts);

  panel.innerHTML = `
    <section class="budget-intel-panel">
      <div class="budget-intel-hero">
        <div class="budget-intel-copy">
          <h4>Budget Intelligence</h4>
          <p>วิเคราะห์งบประมาณจากวงเงิน รายการผูกพัน สถานะเบิกจ่าย เอกสาร หลักฐาน และกำหนดติดตาม เพื่อช่วยตัดสินใจก่อนอนุมัติรายการใหม่</p>
        </div>
        <div class="budget-health-card ${decision.tone}">
          <div class="budget-health-gauge" style="--gauge:${gaugeAngle}deg">
            <strong>${decision.score}</strong>
            <span>Health</span>
          </div>
          <div>
            <b>${decision.title}</b>
            <p>${decision.advice}</p>
          </div>
        </div>
      </div>

      <div class="budget-intel-grid">
        <div class="budget-burn-card">
          <div class="budget-card-head">
            <span><i class="fa-solid fa-gauge-high"></i></span>
            <div><strong>Burn Rate</strong><small>ใช้/ผูกพันเทียบกับรายรับรวม</small></div>
          </div>
          <div class="budget-burn-wrap">
            <div class="budget-burn-gauge ${summary.pct >= 100 ? 'risk' : summary.pct >= 80 ? 'watch' : 'good'}" style="--gauge:${usageAngle}deg">
              <strong>${summary.pct}%</strong>
              <span>Used</span>
            </div>
            <div class="budget-flow-bars">
              ${flowItems.map(item => `
                <div class="budget-flow-row ${item.className}">
                  <span>${item.label}</span>
                  <div><i style="width:${clampPct((Math.abs(item.value) / flowMax) * 100)}%"></i></div>
                  <b>${formatCurrency(item.value)}</b>
                </div>`).join('')}
            </div>
          </div>
        </div>

        <div class="budget-category-card">
          <div class="budget-card-head">
            <span><i class="fa-solid fa-chart-pie"></i></span>
            <div><strong>Expense Mix</strong><small>หมวดค่าใช้จ่ายที่ใช้งบมากสุด</small></div>
          </div>
          <div class="budget-category-list">
            ${categoryRows.length ? categoryRows.map(item => `
              <div class="budget-category-row">
                <div class="budget-category-label"><span>${escapeHTML(item.label)}</span><b>${formatCurrency(item.amount)}</b></div>
                <div class="budget-category-bar"><i style="width:${clampPct((item.amount / Math.max(categoryTotal, 1)) * 100)}%"></i></div>
              </div>`).join('') : '<p class="budget-empty-text">ยังไม่มีรายการรายจ่ายสำหรับวิเคราะห์หมวด</p>'}
          </div>
        </div>

        <div class="budget-month-card">
          <div class="budget-card-head">
            <span><i class="fa-solid fa-chart-column"></i></span>
            <div><strong>Monthly Cashflow</strong><small>รายรับและรายจ่ายตามเดือน</small></div>
          </div>
          <div class="budget-month-chart">
            ${monthlyRows.length ? monthlyRows.map(item => `
              <div class="budget-month-col" title="${formatBudgetMonth(item.month)}">
                <div class="budget-month-bars">
                  <i class="income" style="height:${clampPct((item.income / monthlyMax) * 100)}%"></i>
                  <i class="expense" style="height:${clampPct((item.expense / monthlyMax) * 100)}%"></i>
                </div>
                <span>${formatBudgetMonth(item.month)}</span>
              </div>`).join('') : '<p class="budget-empty-text">ยังไม่มีวันที่รายการบัญชีสำหรับทำกราฟรายเดือน</p>'}
          </div>
        </div>

        <div class="budget-status-card">
          <div class="budget-card-head">
            <span><i class="fa-solid fa-list-check"></i></span>
            <div><strong>Status Funnel</strong><small>ยอดรายจ่ายแยกตามสถานะ</small></div>
          </div>
          <div class="budget-status-list">
            ${statusRows.map(item => `
              <div class="budget-status-row">
                <span>${item.label}</span>
                <div><i style="width:${clampPct((item.amount / statusMax) * 100)}%"></i></div>
                <b>${formatCurrency(item.amount)}</b>
              </div>`).join('')}
          </div>
        </div>
      </div>

      <div class="budget-control-grid">
        ${controlItems.map(item => `
          <div class="budget-control-card ${item.tone}">
            <div class="budget-control-top">
              <span class="budget-control-icon"><i class="fa-solid ${item.icon}"></i></span>
              <span class="budget-control-chip">${item.level}</span>
            </div>
            <p class="budget-control-label">${item.label}</p>
            <div class="budget-control-score">
              <strong>${item.value}<em>%</em></strong>
            </div>
            <div class="budget-control-bar"><i style="width:${item.value}%"></i></div>
            <p class="budget-control-note">${item.note}</p>
          </div>`).join('')}
      </div>
    </section>`;
}
