/**
 * modules/schedule.js — Fiscal Year Calendar + Schedule Sessions
 */
import { state } from './state.js';
import { escapeHTML } from '../utils/format.js';

const MONTH_NAMES = ['ต.ค.','พ.ย.','ธ.ค.','ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.'];
const Q_LABELS = ['Q1','Q1','Q1','Q2','Q2','Q2','Q3','Q3','Q3','Q4','Q4','Q4'];

export function renderFiscalCalendar() {
  const grid = document.getElementById('fiscal-cal-grid');
  if (!grid) return;
  const p = state.currentProject;
  const start = p?.startMonth || 1;
  const end   = p?.endMonth   || 1;
  grid.innerHTML = '';

  MONTH_NAMES.forEach((name, i) => {
    const m = i + 1;
    const inRange = m >= start && m <= end;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.month = m;
    btn.className = `relative py-3 rounded-2xl text-sm font-bold transition-all duration-200 border-2 cal-month-btn ${
      inRange
        ? 'bg-blue-600 text-white border-blue-700 shadow-lg shadow-blue-500/25 scale-[1.02]'
        : 'bg-white text-gray-600 border-gray-100 hover:border-blue-300 hover:bg-blue-50'}`;
    btn.innerHTML = `
      <span class="block text-[10px] font-black opacity-60 mb-0.5">${Q_LABELS[i]}</span>${name}
      ${m === start ? '<span class="absolute top-1 right-1.5 text-[8px] font-black text-yellow-300">▶</span>' : ''}
      ${m === end && m !== start ? '<span class="absolute bottom-1 right-1.5 text-[8px] font-black text-yellow-300">■</span>' : ''}`;
    grid.appendChild(btn);
  });

  // Bind click via delegation
  grid.onclick = e => {
    const btn = e.target.closest('.cal-month-btn');
    if (!btn || !p) return;
    const m = +btn.dataset.month;
    if (!p._calPicking || m <= p.startMonth) {
      p.startMonth = m; p.endMonth = m; p._calPicking = true;
    } else {
      p.endMonth = m; p._calPicking = false;
    }
    const startEl = document.getElementById('input-proj-start');
    const endEl   = document.getElementById('input-proj-end');
    if (startEl) startEl.value = p.startMonth;
    if (endEl)   endEl.value   = p.endMonth;
    renderFiscalCalendar();
  };

  _updateCalendarLabels(start, end);
}

function _updateCalendarLabels(start, end) {
  const el = id => document.getElementById(id);
  if (el('cal-start-label'))    el('cal-start-label').textContent    = MONTH_NAMES[start-1] || '-';
  if (el('cal-end-label'))      el('cal-end-label').textContent      = MONTH_NAMES[end-1]   || '-';
  if (el('cal-duration-label')) el('cal-duration-label').textContent = end >= start ? (end - start + 1) : '-';
}

// -------- Sessions --------
export function renderScheduleSessions() {
  const p = state.currentProject;
  if (!p) return;
  if (!p.schedules) p.schedules = [];
  const container = document.getElementById('schedule-sessions-container');
  if (!container) return;
  container.innerHTML = '';

  if (!p.schedules.length) {
    container.innerHTML = `<p class="text-center text-gray-300 font-bold py-8">ยังไม่มีรอบอบรม — กดปุ่ม "เพิ่มรอบ" ด้านบน</p>`;
    return;
  }
  p.schedules.forEach((s, idx) => {
    const row = document.createElement('div');
    row.className = 'flex flex-wrap gap-3 p-4 bg-gray-50 rounded-2xl border border-gray-100 items-center';
    row.innerHTML = `
      <div class="flex-1 min-w-[140px]">
        <label class="block text-[10px] font-bold text-gray-400 mb-1">ชื่อรอบ</label>
        <input type="text" value="${escapeHTML(s.name||'')}" data-idx="${idx}" data-field="name"
          class="session-input w-full bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm font-medium focus:ring-2 focus:ring-blue-500 outline-none">
      </div>
      <div class="w-36">
        <label class="block text-[10px] font-bold text-gray-400 mb-1">วันที่เริ่ม</label>
        <input type="date" value="${escapeHTML(s.date||'')}" data-idx="${idx}" data-field="date"
          class="session-input w-full bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none">
      </div>
      <div class="w-20">
        <label class="block text-[10px] font-bold text-gray-400 mb-1">จำนวนวัน</label>
        <input type="number" min="1" value="${s.days||1}" data-idx="${idx}" data-field="days"
          class="session-input w-full bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm text-center focus:ring-2 focus:ring-blue-500 outline-none">
      </div>
      <div class="w-36">
        <label class="block text-[10px] font-bold text-gray-400 mb-1">สถานที่</label>
        <input type="text" value="${escapeHTML(s.venue||'')}" data-idx="${idx}" data-field="venue"
          class="session-input w-full bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none">
      </div>
      <button data-del="${idx}" class="btn-del-session mt-5 w-8 h-8 flex items-center justify-center text-red-400 hover:bg-red-50 rounded-xl transition shrink-0">
        <i class="fa-solid fa-trash text-xs"></i>
      </button>`;
    container.appendChild(row);
  });

  container.querySelectorAll('.session-input').forEach(el => {
    el.addEventListener('change', e => {
      const idx   = +e.target.dataset.idx;
      const field = e.target.dataset.field;
      if (p.schedules[idx]) p.schedules[idx][field] = field === 'days' ? +e.target.value : e.target.value;
    });
  });
  container.querySelectorAll('.btn-del-session').forEach(btn => {
    btn.addEventListener('click', () => {
      p.schedules.splice(+btn.dataset.del, 1);
      renderScheduleSessions();
    });
  });
}

export function addScheduleSession() {
  const p = state.currentProject;
  if (!p) return;
  if (!p.schedules) p.schedules = [];
  p.schedules.push({ name: 'รอบที่ ' + (p.schedules.length + 1), date: '', days: 1, venue: '' });
  renderScheduleSessions();
}
