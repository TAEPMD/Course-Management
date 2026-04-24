/**
 * modules/budget.js — Budget Ledger System
 */
import { state } from './state.js';
import { escapeHTML, formatCurrency } from '../utils/format.js';

export function renderBudgetLedger() {
  const p = state.currentProject;
  if (!p) return;
  if (!p.ledger) p.ledger = [];
  const tbody = document.getElementById('budget-ledger-body');
  if (!tbody) return;

  tbody.innerHTML = '';
  if (!p.ledger.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-gray-300 font-bold">ยังไม่มีรายการ — กดปุ่ม "เพิ่มรายการ"</td></tr>`;
  } else {
    const CATS = ['ค่าวิทยากร','ค่าวัสดุ','ค่าอาหาร','ค่าสถานที่','ค่าเดินทาง','ค่าพิมพ์เอกสาร','อื่นๆ'];
    p.ledger.forEach((entry, idx) => {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-slate-50/50 transition-colors';
      tr.innerHTML = `
        <td class="px-4 py-3">
          <input type="date" value="${escapeHTML(entry.date||'')}" data-idx="${idx}" data-field="date"
            class="ledger-input bg-transparent border-none text-xs font-medium text-gray-600 outline-none w-28">
        </td>
        <td class="px-4 py-3">
          <input type="text" value="${escapeHTML(entry.desc||'')}" data-idx="${idx}" data-field="desc" placeholder="รายละเอียด"
            class="ledger-input bg-transparent border-none text-sm font-medium text-gray-800 outline-none w-full min-w-[140px]">
        </td>
        <td class="px-4 py-3">
          <select data-idx="${idx}" data-field="cat"
            class="ledger-input bg-gray-50 border border-gray-100 rounded-lg px-2 py-1 text-xs font-bold focus:ring-2 focus:ring-blue-500 outline-none">
            ${CATS.map(c => `<option value="${c}" ${entry.cat===c?'selected':''}>${c}</option>`).join('')}
          </select>
        </td>
        <td class="px-4 py-3 text-right">
          <input type="number" value="${entry.amount||0}" data-idx="${idx}" data-field="amount"
            class="ledger-input bg-transparent border-none text-sm font-black text-rose-700 text-right outline-none w-28">
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
      if (field === 'amount') renderBudgetSummary();
    });
  });
  tbody.querySelectorAll('.btn-del-ledger').forEach(btn => {
    btn.addEventListener('click', () => {
      p.ledger.splice(+btn.dataset.del, 1);
      renderBudgetLedger();
    });
  });
  renderBudgetSummary();
}

export function addBudgetEntry() {
  const p = state.currentProject;
  if (!p) return;
  if (!p.ledger) p.ledger = [];
  p.ledger.push({ date: new Date().toISOString().split('T')[0], desc: '', cat: 'ค่าวัสดุ', amount: 0 });
  renderBudgetLedger();
}

export function renderBudgetSummary() {
  const p = state.currentProject;
  if (!p) return;
  const budget  = Number(document.getElementById('input-proj-budget')?.value || p.budget || 0);
  const total   = (p.ledger || []).reduce((s, e) => s + Number(e.amount || 0), 0);
  const balance = budget - total;
  const pct     = budget > 0 ? Math.min(Math.round((total / budget) * 100), 100) : 0;

  const el = id => document.getElementById(id);
  if (el('budget-total-expense')) el('budget-total-expense').textContent = formatCurrency(total);
  if (el('budget-balance')) {
    el('budget-balance').textContent = formatCurrency(balance);
    el('budget-balance').className = `text-xl font-black ${balance < 0 ? 'text-red-700' : 'text-emerald-700'}`;
  }
  if (el('budget-pct-label'))   el('budget-pct-label').textContent = pct + '%';
  if (el('budget-progress-bar')) {
    el('budget-progress-bar').style.width = pct + '%';
    el('budget-progress-bar').className = `h-3 rounded-full transition-all duration-500 ${pct>=100?'bg-red-500':pct>=80?'bg-amber-500':'bg-blue-500'}`;
  }
}
