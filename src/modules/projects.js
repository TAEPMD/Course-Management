/**
 * modules/projects.js — Project CRUD, Dashboard, Annual/Monthly/Weekly views
 */
import { state } from './state.js';
import { hasPermission } from './permissions.js';
import { hideAllViews, setHeader, updateNavActive } from './auth.js';
import { populateDropdown } from './masterData.js';
import { renderBudgetLedger } from './budget.js';
import { renderFiscalCalendar, renderScheduleSessions } from './schedule.js';
import { escapeHTML, formatCurrency } from '../utils/format.js';
import * as gas from '../gas.js';

// -------- Navigation --------
export async function showDashboard() {
  hideAllViews();
  setHeader('Dashboard');
  document.getElementById('view-dashboard')?.classList.remove('hidden');
  updateNavActive('nav-dashboard');
  if (!state.projects.length) await loadProjects();
  else { renderDashboardStats(); renderProjectTable(); }
}

export async function showAnnualPlan() {
  if (!hasPermission('annual')) { _noAccess('Annual Plan'); return; }
  hideAllViews(); setHeader('Annual Plan');
  document.getElementById('view-annual-plan')?.classList.remove('hidden');
  updateNavActive('nav-annual');
  if (!state.projects.length) await loadProjects();
  renderAnnualTimeline();
}

export async function showMonthlyPlan() {
  if (!hasPermission('monthly')) { _noAccess('Monthly Overview'); return; }
  hideAllViews(); setHeader('Monthly Overview');
  document.getElementById('view-monthly-plan')?.classList.remove('hidden');
  updateNavActive('nav-monthly');
  if (!state.projects.length) await loadProjects();
  renderMonthlyPlan();
}

export async function showWeeklyPlan() {
  if (!hasPermission('weekly')) { _noAccess('Weekly Schedule'); return; }
  hideAllViews(); setHeader('Weekly Schedule');
  document.getElementById('view-weekly-plan')?.classList.remove('hidden');
  updateNavActive('nav-weekly');
  if (!state.projects.length) await loadProjects();
  renderWeeklyPlan();
}

function _noAccess(page) {
  Swal.fire({ icon: 'warning', title: 'ไม่มีสิทธิ์เข้าถึง', text: `บทบาทของคุณไม่มีสิทธิ์ดูหน้า ${page}`, confirmButtonColor: '#1e3a8a' });
}

// -------- Data Loading --------
export async function loadProjects() {
  Swal.fire({ title: 'กำลังโหลด...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
  try {
    state.projects = await gas.getProjects() || [];
  } catch (e) {
    state.projects = [];
    Swal.fire({ icon: 'error', title: 'โหลดข้อมูลล้มเหลว', text: e.message });
    return;
  }
  Swal.close();
  renderDashboardStats();
  renderProjectTable();
}

// -------- Dashboard --------
export function renderDashboardStats() {
  const el = id => document.getElementById(id);
  if (el('stat-projects')) el('stat-projects').innerText = state.projects.length;
  const people = state.projects.reduce((s, p) => s + Number(p.people || 0), 0);
  const budget = state.projects.reduce((s, p) => s + Number(p.budget || 0), 0);
  const risk   = state.projects.filter(p => p.health === 'at-risk' || p.health === 'off-track').length;
  if (el('stat-people')) el('stat-people').innerText = people.toLocaleString();
  if (el('stat-budget')) el('stat-budget').innerText = formatCurrency(budget);
  if (el('stat-risk'))   el('stat-risk').innerText = risk;
}

export function renderProjectTable() {
  const tbody = document.getElementById('project-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!state.projects.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-12 text-center text-gray-300 font-bold">ยังไม่มีโครงการ — กดปุ่ม "+ โครงการใหม่"</td></tr>`;
    return;
  }
  state.projects.forEach(p => {
    const healthColor = p.health === 'off-track' ? 'text-red-500' : p.health === 'at-risk' ? 'text-amber-500' : 'text-emerald-500';
    const healthIcon  = p.health === 'off-track' ? 'fa-circle-xmark' : p.health === 'at-risk' ? 'fa-triangle-exclamation' : 'fa-circle-check';
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-50/50 cursor-pointer transition-colors';
    tr.onclick = () => openProject(p.id);
    tr.innerHTML = `
      <td class="px-6 py-4 text-xs font-bold text-gray-400">${escapeHTML(p.id)}</td>
      <td class="px-6 py-4 font-bold text-gray-800 text-sm">${escapeHTML(p.name)}</td>
      <td class="px-6 py-4 text-xs text-gray-500">${escapeHTML(p.year)}</td>
      <td class="px-6 py-4 text-center"><span class="status-badge ${p.status==='ดำเนินการ'?'status-active':'status-draft'}">${escapeHTML(p.status)}</span></td>
      <td class="px-6 py-4 text-center"><i class="fa-solid ${healthIcon} ${healthColor}"></i></td>
      <td class="px-6 py-4 text-xs text-gray-500 text-right">${formatCurrency(p.budget)}</td>`;
    tbody.appendChild(tr);
  });
}

// -------- Project Detail --------
export function openProject(id) {
  state.currentProject = state.projects.find(p => p.id === id);
  if (!state.currentProject) return;
  const p = state.currentProject;
  hideAllViews();
  document.getElementById('view-project-detail')?.classList.remove('hidden');
  document.getElementById('detail-project-name').innerText = p.name;
  document.getElementById('detail-project-id').innerText = p.id;
  document.getElementById('detail-project-year').innerText = 'ปีงบประมาณ ' + p.year;
  const st = document.getElementById('detail-project-status');
  if (st) { st.innerText = p.status; st.className = `status-badge ${p.status==='ดำเนินการ'?'status-active':'status-draft'}`; }

  document.getElementById('input-proj-name').value  = p.name || '';
  document.getElementById('input-proj-year').value  = p.year || '';
  document.getElementById('input-proj-budget').value = p.budget || 0;
  document.getElementById('input-proj-people').value = p.people || 0;
  document.getElementById('input-proj-start').value  = p.startMonth || 1;
  document.getElementById('input-proj-end').value    = p.endMonth || 12;
  document.getElementById('input-proj-priority').value = p.priority || 'medium';
  document.getElementById('input-proj-health').value   = p.health || 'on-track';
  document.getElementById('input-proj-progress').value = p.progress || 0;
  document.getElementById('progress-val-display').innerText = (p.progress || 0) + '%';
  document.getElementById('input-proj-cme').value = p.cme || 0;
  if (document.getElementById('input-proj-desc'))
    document.getElementById('input-proj-desc').value = p.description || '';

  populateDropdown('input-proj-category',   'category',   p.category   || 'basic');
  populateDropdown('input-proj-audience',   'audience',   p.audience   || 'all');
  populateDropdown('input-proj-assessment', 'assessment', p.assessment || 'attendance');

  switchTab('info');
  renderDocsTable();
  renderFiscalCalendar();
  renderBudgetLedger();
  renderScheduleSessions();
}

export function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    const active = b.getAttribute('data-target') === 'tab-' + name;
    b.classList.toggle('tab-active', active);
    b.classList.toggle('text-gray-400', !active);
  });
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('hidden', c.id !== 'tab-' + name));
}

export async function saveProjectInfo() {
  if (!state.currentProject) return;
  const p = state.currentProject;
  p.name       = document.getElementById('input-proj-name')?.value;
  p.year       = document.getElementById('input-proj-year')?.value;
  p.budget     = Number(document.getElementById('input-proj-budget')?.value) || 0;
  p.people     = Number(document.getElementById('input-proj-people')?.value) || 0;
  p.startMonth = Number(document.getElementById('input-proj-start')?.value) || 1;
  p.endMonth   = Number(document.getElementById('input-proj-end')?.value) || 12;
  p.priority   = document.getElementById('input-proj-priority')?.value;
  p.health     = document.getElementById('input-proj-health')?.value;
  p.progress   = Number(document.getElementById('input-proj-progress')?.value) || 0;
  p.cme        = Number(document.getElementById('input-proj-cme')?.value) || 0;
  p.category   = document.getElementById('input-proj-category')?.value;
  p.audience   = document.getElementById('input-proj-audience')?.value;
  p.assessment = document.getElementById('input-proj-assessment')?.value;
  p.description = document.getElementById('input-proj-desc')?.value || '';

  try {
    await gas.saveProject(p);
    Swal.fire({ icon: 'success', title: 'บันทึกแล้ว', timer: 1500, showConfirmButton: false });
    renderDashboardStats();
    renderProjectTable();
  } catch (e) {
    Swal.fire({ icon: 'error', title: 'บันทึกล้มเหลว', text: e.message });
  }
}

export function createNewProject() {
  const id = 'TR-' + (new Date().getFullYear() + 543).toString().slice(-2) + '-' + String(state.projects.length + 1).padStart(2, '0');
  const p = {
    id, name: 'โครงการใหม่ (รอกรอกชื่อ)',
    year: String(new Date().getFullYear() + 543),
    status: 'ร่าง', people: 0, budget: 0,
    docs: [], schedules: [], ledger: [],
    startMonth: 1, endMonth: 12,
    health: 'on-track', priority: 'medium',
    progress: 0, cme: 0,
    category: 'basic', audience: 'all', assessment: 'attendance'
  };
  state.projects.unshift(p);
  openProject(id);
  Swal.fire({ title: 'สร้างโครงการใหม่', icon: 'info', toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
}

// -------- Documents --------
export function renderDocsTable() {
  const tbody = document.getElementById('docs-table-body');
  if (!tbody) return;
  const docs = state.currentProject?.docs || [];
  if (!docs.length) { tbody.innerHTML = `<tr><td colspan="3" class="p-8 text-center text-gray-300 font-bold">No documents</td></tr>`; return; }
  tbody.innerHTML = '';
  docs.forEach(doc => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="px-6 py-4"><div class="flex items-center space-x-3">
        <div class="w-8 h-8 rounded-lg bg-red-50 text-red-500 flex items-center justify-center"><i class="fa-solid fa-file-pdf"></i></div>
        <span class="text-xs font-bold text-gray-700">${escapeHTML(doc.name)}</span></div></td>
      <td class="px-6 py-4 text-xs font-bold text-gray-400">${escapeHTML(doc.date)}</td>
      <td class="px-6 py-4 text-center"><a href="${escapeHTML(doc.url||'#')}" target="_blank" class="p-2 text-blue-600 hover:bg-blue-50 rounded-xl transition"><i class="fa-solid fa-download"></i></a></td>`;
    tbody.appendChild(tr);
  });
}

export async function uploadDocument() {
  const inp = document.getElementById('file-upload');
  const f = inp?.files?.[0];
  if (!f) { Swal.fire('Alert', 'Please select file', 'warning'); return; }
  const status = document.getElementById('upload-status');
  if (status) status.innerHTML = `<span class="text-blue-600 font-bold animate-pulse">Uploading ${f.name}...</span>`;
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const data = e.target.result.split(',')[1];
      const url = await gas.uploadFile(data, f.name);
      state.currentProject.docs.push({ name: f.name, date: new Date().toISOString().split('T')[0], url });
      if (inp) inp.value = '';
      if (status) status.innerHTML = `<span class="text-emerald-500 font-bold">Success!</span>`;
      setTimeout(() => { if (status) status.innerHTML = ''; }, 3000);
      renderDocsTable();
    } catch (err) {
      if (status) status.innerHTML = `<span class="text-red-500 font-bold">${err.message}</span>`;
    }
  };
  reader.readAsDataURL(f);
}

// -------- Annual / Monthly / Weekly (stub — extend as needed) --------
export function renderAnnualTimeline() {
  const container = document.getElementById('annual-timeline-container');
  if (!container) return;
  const MONTHS = ['ต.ค.','พ.ย.','ธ.ค.','ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.'];
  container.innerHTML = `
    <div class="overflow-x-auto">
      <table class="w-full text-xs min-w-[900px]">
        <thead><tr class="bg-gray-50">
          <th class="px-4 py-3 text-left w-48">โครงการ</th>
          ${MONTHS.map((m,i) => `<th class="px-2 py-3 text-center ${i<3?'bg-emerald-50 text-emerald-700':i<6?'bg-blue-50 text-blue-700':i<9?'bg-purple-50 text-purple-700':'bg-orange-50 text-orange-700'}">${m}</th>`).join('')}
        </tr></thead>
        <tbody class="divide-y divide-gray-100">
          ${state.projects.map(p => `<tr class="hover:bg-slate-50">
            <td class="px-4 py-3 font-bold text-gray-800 truncate max-w-[180px]">${escapeHTML(p.name)}</td>
            ${MONTHS.map((_,i) => {
              const m = i+1;
              const active = m >= (p.startMonth||1) && m <= (p.endMonth||12);
              return `<td class="px-1 py-3 text-center">${active ? '<div class="h-5 rounded bg-blue-500 mx-0.5"></div>' : ''}</td>`;
            }).join('')}
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

export function renderMonthlyPlan() {
  // grouped by month — simple implementation
  const container = document.getElementById('monthly-plan-container');
  if (!container) return;
  const MONTHS = ['ต.ค.','พ.ย.','ธ.ค.','ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.'];
  container.innerHTML = MONTHS.map((name, i) => {
    const m = i + 1;
    const ps = state.projects.filter(p => m >= (p.startMonth||1) && m <= (p.endMonth||12));
    return `<div class="card-modern p-4">
      <h4 class="font-bold text-gray-700 mb-3">${name} <span class="text-xs text-gray-400">(${ps.length} โครงการ)</span></h4>
      ${ps.length ? ps.map(p => `<div class="text-xs font-medium text-gray-600 py-1 border-b border-gray-50 last:border-0">${escapeHTML(p.name)}</div>`).join('') : '<p class="text-xs text-gray-300">ไม่มีโครงการ</p>'}
    </div>`;
  }).join('');
}

export function renderWeeklyPlan() {
  const container = document.getElementById('weekly-plan-container');
  if (!container) return;
  const sessions = state.projects.flatMap(p =>
    (p.schedules || []).map(s => ({ ...s, projectName: p.name }))
  ).filter(s => s.date).sort((a, b) => a.date.localeCompare(b.date));
  container.innerHTML = sessions.length
    ? sessions.map(s => `<div class="flex items-center gap-4 p-4 bg-white rounded-2xl border border-gray-100 shadow-sm">
        <div class="w-12 h-12 rounded-xl bg-blue-50 flex flex-col items-center justify-center shrink-0">
          <span class="text-xs font-bold text-blue-500">${s.date ? new Date(s.date).toLocaleDateString('th-TH',{month:'short'}) : '-'}</span>
          <span class="text-lg font-black text-blue-900">${s.date ? new Date(s.date).getDate() : '-'}</span>
        </div>
        <div class="flex-1 min-w-0">
          <p class="font-bold text-gray-800 text-sm truncate">${escapeHTML(s.name || 'รอบอบรม')}</p>
          <p class="text-xs text-gray-500">${escapeHTML(s.projectName)}</p>
          ${s.venue ? `<p class="text-xs text-gray-400"><i class="fa-solid fa-location-dot mr-1"></i>${escapeHTML(s.venue)}</p>` : ''}
        </div>
        <span class="text-xs font-bold text-blue-500 shrink-0">${s.days||1} วัน</span>
      </div>`).join('')
    : '<p class="text-center text-gray-300 font-bold py-16">ยังไม่มีกำหนดการอบรม</p>';
}
