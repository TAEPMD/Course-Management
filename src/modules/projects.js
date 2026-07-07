/**
 * modules/projects.js — Project CRUD, Dashboard, Annual/Monthly/Weekly views
 */
import { state } from './state.js';
import { hasPermission } from './permissions.js';
import { clearClientSession, hideAllViews, isAuthExpiredError, setHeader, updateNavActive } from './auth.js';
import { populateDropdown } from './masterData.js';
import { renderBudgetLedger } from './budget.js';
import { renderFiscalCalendar, renderScheduleSessions } from './schedule.js';
import { escapeHTML, formatCurrency } from '../utils/format.js';
import {
  FISCAL_MONTH_NAMES,
  clampNumber,
  getBudgetUsage,
  getFiscalMonthRange,
  getProjectHealthInsight,
  getProjectExpense,
  getProjectProgressInsight,
  getProjectReadiness,
  isFiscalMonthInRange,
  validateProject
} from '../utils/courseMetrics.js';
import * as gas from '../gas.js';

function getTodayFiscalMonth() {
  return ((new Date().getMonth() + 3) % 12) + 1;
}

function getProjectIdSequence(projects, fiscalYear) {
  const suffix = String(fiscalYear).slice(-2);
  const pattern = new RegExp(`^TR-${suffix}-(\\d+)$`);
  return projects.reduce((max, project) => {
    const match = String(project.id || '').match(pattern);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0) + 1;
}

const PROJECT_STATUS_OPTIONS = ['ร่าง', 'ดำเนินการ', 'ปิดโครงการ'];

function normalizeProjectStatus(status) {
  return PROJECT_STATUS_OPTIONS.includes(status) ? status : 'ร่าง';
}

function getProjectStatusMeta(status) {
  const normalized = normalizeProjectStatus(status);
  if (normalized === 'ดำเนินการ') return { label: normalized, className: 'status-active' };
  if (normalized === 'ปิดโครงการ') return { label: normalized, className: 'status-done' };
  return { label: normalized, className: 'status-draft' };
}

const HEALTH_TONE = {
  emerald: {
    badge: 'health-on-track',
    icon: 'fa-circle-check',
    title: 'On Track',
    label: 'ปกติ'
  },
  amber: {
    badge: 'health-at-risk',
    icon: 'fa-triangle-exclamation',
    title: 'At Risk',
    label: 'มีความเสี่ยง'
  },
  rose: {
    badge: 'health-off-track',
    icon: 'fa-circle-xmark',
    title: 'Off Track',
    label: 'ต้องเร่งแก้'
  }
};

function getHealthTone(health) {
  return HEALTH_TONE[health?.tone] || HEALTH_TONE.amber;
}

function getTaskStats(project) {
  const tasks = project?.tasks || [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const done = tasks.filter(t => t.status === 'done').length;
  const overdue = tasks.filter(t => {
    if (!t.dueDate || t.status === 'done') return false;
    const due = new Date(t.dueDate);
    due.setHours(0, 0, 0, 0);
    return due < today;
  }).length;
  return {
    total: tasks.length,
    done,
    active: tasks.length - done,
    overdue,
    pct: tasks.length ? Math.round((done / tasks.length) * 100) : 0
  };
}

function getScheduleStats(project, now = new Date()) {
  const sessions = project?.schedules || [];
  const dated = sessions.filter(s => Boolean(s.date));
  const completed = dated.filter(s => {
    const d = new Date(s.date);
    d.setHours(23, 59, 59, 999);
    return d < now;
  }).length;
  const nextSession = dated
    .filter(s => {
      const d = new Date(s.date);
      d.setHours(0, 0, 0, 0);
      return d >= now;
    })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
  return {
    total: dated.length,
    completed,
    pct: dated.length ? Math.round((completed / dated.length) * 100) : 0,
    nextSession
  };
}

function renderHealthBadge(project, compact = false) {
  const health = getProjectHealthInsight(project);
  const tone = getHealthTone(health);
  return `
    <span class="health-badge ${tone.badge}" title="${escapeHTML(health.reasons?.join(' • ') || 'ไม่มีประเด็นสำคัญ')}">
      <i class="fa-solid ${tone.icon}"></i>
      ${compact ? escapeHTML(tone.title) : escapeHTML(health.label)}
    </span>`;
}

const STATUS_CHART_KEYS = { 'ร่าง': 'draft', 'ดำเนินการ': 'active', 'ปิดโครงการ': 'done' };

function renderDashboardInsights() {
  const panel = document.getElementById('dashboard-insights');
  if (!panel) return;
  const projects = state.projects;
  if (!projects.length) { panel.innerHTML = ''; return; }

  // ── 1) Budget gauge ──
  const totalBudget = projects.reduce((s, p) => s + Number(p.budget || 0), 0);
  const totalExpense = projects.reduce((s, p) => s + getProjectExpense(p), 0);
  const usagePct = totalBudget > 0 ? Math.round((totalExpense / totalBudget) * 100) : 0;
  const gaugeTone = usagePct >= 100 ? 'bad' : usagePct >= 85 ? 'warn' : 'ok';
  const gaugeAdvice = usagePct >= 100
    ? 'ใช้/ผูกพันเกินวงเงินแล้ว — ทบทวนรายการก่อนอนุมัติเพิ่ม'
    : usagePct >= 85
      ? 'งบใกล้เต็มวงเงิน — ควรชะลอการอนุมัติรายการใหม่'
      : 'งบยังอยู่ในแผน สามารถอนุมัติรายการใหม่ได้';
  const R = 52;
  const CIRC = 2 * Math.PI * R;
  const gaugeOffset = CIRC * (1 - Math.min(usagePct, 100) / 100);

  // ── 2) Status distribution ──
  const statusItems = PROJECT_STATUS_OPTIONS.map(status => ({
    label: status,
    key: STATUS_CHART_KEYS[status],
    count: projects.filter(p => normalizeProjectStatus(p.status) === status).length
  }));
  const totalProjects = projects.length;

  // ── 3) Workload per fiscal month ──
  const monthCounts = FISCAL_MONTH_NAMES.map((_, i) =>
    projects.filter(p => isFiscalMonthInRange(i + 1, p.startMonth, p.endMonth)).length
  );
  const maxCount = Math.max(...monthCounts);
  const nowMonth = getTodayFiscalMonth();
  const peakIndex = monthCounts.indexOf(maxCount);
  const workloadHint = maxCount > 0
    ? `เดือนที่งานหนาแน่นที่สุดคือ ${FISCAL_MONTH_NAMES[peakIndex]} (${maxCount} หลักสูตร) — เลี่ยงการวางหลักสูตรใหม่ซ้อนช่วงนี้`
    : 'ยังไม่มีหลักสูตรที่ระบุช่วงดำเนินงาน';

  panel.innerHTML = `
    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 sm:gap-6">

      <div class="card-modern p-6">
        <div class="mb-4">
          <h3 class="font-bold text-gray-800">การใช้งบประมาณรวม</h3>
          <p class="text-xs text-gray-400 mt-0.5">ช่วยตัดสินใจว่าควรอนุมัติรายการใหม่ได้หรือไม่</p>
        </div>
        <div class="flex items-center gap-5">
          <div class="insight-gauge-wrap" role="img" aria-label="ใช้งบประมาณไปแล้ว ${usagePct}% ของวงเงินรวม">
            <svg viewBox="0 0 120 120" class="insight-gauge">
              <circle cx="60" cy="60" r="${R}" class="gauge-track"></circle>
              <circle cx="60" cy="60" r="${R}" class="gauge-fill gauge-${gaugeTone}"
                stroke-dasharray="${CIRC.toFixed(1)}" stroke-dashoffset="${gaugeOffset.toFixed(1)}"
                transform="rotate(-90 60 60)"></circle>
            </svg>
            <div class="insight-gauge-center">
              <strong class="gauge-num-${gaugeTone}">${usagePct}%</strong>
              <span>ใช้แล้ว</span>
            </div>
          </div>
          <div class="flex-1 min-w-0 space-y-2 text-xs">
            <div class="flex justify-between gap-2"><span class="text-gray-400 font-bold">วงเงินรวม</span><span class="font-black text-gray-800">${formatCurrency(totalBudget)}</span></div>
            <div class="flex justify-between gap-2"><span class="text-gray-400 font-bold">ใช้/ผูกพัน</span><span class="font-black text-gray-800">${formatCurrency(totalExpense)}</span></div>
            <div class="flex justify-between gap-2"><span class="text-gray-400 font-bold">คงเหลือ</span><span class="font-black ${totalBudget - totalExpense < 0 ? 'text-rose-600' : 'text-emerald-600'}">${formatCurrency(totalBudget - totalExpense)}</span></div>
          </div>
        </div>
        <p class="insight-advice insight-advice-${gaugeTone}"><i class="fa-solid ${gaugeTone === 'ok' ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>${gaugeAdvice}</p>
      </div>

      <div class="card-modern p-6">
        <div class="mb-4">
          <h3 class="font-bold text-gray-800">สถานะหลักสูตร</h3>
          <p class="text-xs text-gray-400 mt-0.5">ภาพรวมว่างานส่วนใหญ่อยู่ขั้นตอนไหน</p>
        </div>
        <div class="stack-bar" role="img" aria-label="${statusItems.map(s => `${s.label} ${s.count} หลักสูตร`).join(', ')}">
          ${statusItems.filter(s => s.count > 0).map(s => `
            <span class="stack-seg stack-${s.key}" style="flex-grow:${s.count}" title="${escapeHTML(s.label)}: ${s.count} หลักสูตร (${Math.round((s.count / totalProjects) * 100)}%)"></span>
          `).join('') || '<span class="stack-seg stack-empty" style="flex-grow:1"></span>'}
        </div>
        <div class="mt-4 space-y-2.5">
          ${statusItems.map(s => `
            <div class="flex items-center gap-2.5 text-xs">
              <span class="legend-dot stack-${s.key}"></span>
              <span class="font-bold text-gray-500 flex-1">${escapeHTML(s.label)}</span>
              <span class="font-black text-gray-800">${s.count}</span>
              <span class="text-gray-400 w-10 text-right">${totalProjects ? Math.round((s.count / totalProjects) * 100) : 0}%</span>
            </div>`).join('')}
        </div>
      </div>

      <div class="card-modern p-6 md:col-span-2 xl:col-span-1">
        <div class="mb-4">
          <h3 class="font-bold text-gray-800">หลักสูตรที่ดำเนินการในแต่ละเดือน</h3>
          <p class="text-xs text-gray-400 mt-0.5">ช่วยเลือกเดือนที่เหมาะกับการวางหลักสูตรใหม่</p>
        </div>
        <div class="mini-bar-chart" role="img" aria-label="จำนวนหลักสูตรที่ดำเนินการในแต่ละเดือนของปีงบประมาณ">
          ${monthCounts.map((count, i) => {
            const m = i + 1;
            const h = maxCount > 0 ? Math.max(Math.round((count / maxCount) * 64), count > 0 ? 6 : 0) : 0;
            const isNow = m === nowMonth;
            const showLabel = count > 0 && (isNow || i === peakIndex);
            return `
              <div class="mini-bar-col ${isNow ? 'is-now' : ''}" title="${FISCAL_MONTH_NAMES[i]}: ${count} หลักสูตร${isNow ? ' (เดือนนี้)' : ''}">
                <span class="mini-bar-val">${showLabel ? count : ''}</span>
                <div class="mini-bar-track"><div class="mini-bar ${isNow ? 'mini-bar-now' : ''}" style="height:${h}px"></div></div>
                <span class="mini-bar-label">${FISCAL_MONTH_NAMES[i]}</span>
              </div>`;
          }).join('')}
        </div>
        <p class="insight-advice insight-advice-info"><i class="fa-solid fa-lightbulb"></i>${workloadHint}</p>
      </div>
    </div>`;
}

function renderGovernanceDashboard() {
  const panel = document.getElementById('governance-dashboard');
  if (!panel) return;

  const insights = state.projects.map(project => ({
    project,
    health: getProjectHealthInsight(project),
    tasks: getTaskStats(project),
    schedule: getScheduleStats(project)
  }));
  const offTrack = insights.filter(item => item.health.level === 'off-track').length;
  const atRisk = insights.filter(item => item.health.level === 'at-risk').length;
  const overdueTasks = insights.reduce((sum, item) => sum + item.tasks.overdue, 0);
  const readyProjects = insights.filter(item => item.health.readiness.score >= 85).length;
  const readinessPct = insights.length ? Math.round((readyProjects / insights.length) * 100) : 0;
  const focusItems = insights
    .filter(item => item.health.reasons.length || item.tasks.overdue > 0)
    .sort((a, b) => {
      const rank = { 'off-track': 0, 'at-risk': 1, 'on-track': 2 };
      return rank[a.health.level] - rank[b.health.level] || b.tasks.overdue - a.tasks.overdue;
    })
    .slice(0, 5);

  panel.innerHTML = `
    <div class="card-modern p-6 governance-panel">
      <div class="flex flex-col lg:flex-row lg:items-start justify-between gap-5 mb-5">
        <div>
          <h3 class="font-bold text-gray-800 text-lg">ศูนย์กำกับโครงการ (PMO)</h3>
          <p class="text-xs text-gray-400 mt-1">สรุปสุขภาพหลักสูตรจากความพร้อม งบประมาณ ตารางอบรม และงานค้าง</p>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 w-full lg:w-auto">
          <div class="governance-kpi">
            <span>Off track</span>
            <strong class="text-rose-600">${offTrack}</strong>
          </div>
          <div class="governance-kpi">
            <span>At risk</span>
            <strong class="text-amber-600">${atRisk}</strong>
          </div>
          <div class="governance-kpi">
            <span>งานเกินกำหนด</span>
            <strong class="text-rose-600">${overdueTasks}</strong>
          </div>
          <div class="governance-kpi">
            <span>พร้อมเปิดอบรม</span>
            <strong class="text-emerald-600">${readinessPct}%</strong>
          </div>
        </div>
      </div>
      <div class="space-y-2">
        ${focusItems.length ? focusItems.map(({ project, health, tasks, schedule }) => {
          const tone = getHealthTone(health);
          const reason = health.reasons[0] || (tasks.overdue ? `งานเกินกำหนด ${tasks.overdue} รายการ` : 'ควรติดตามความคืบหน้า');
          return `
            <button type="button" class="governance-focus-row" onclick="app.openProject('${escapeHTML(project.id)}')">
              <span class="health-dot ${tone.badge}"><i class="fa-solid ${tone.icon}"></i></span>
              <span class="min-w-0 text-left">
                <strong class="block truncate">${escapeHTML(project.name || project.id)}</strong>
                <span class="block truncate">${escapeHTML(reason)}</span>
              </span>
              <span class="governance-mini-stat">${health.readiness.score}% ready</span>
              <span class="governance-mini-stat">${tasks.done}/${tasks.total} งาน</span>
              <span class="governance-mini-stat">${schedule.completed}/${schedule.total} รอบ</span>
            </button>`;
        }).join('') : '<p class="text-gray-400 text-xs">ยังไม่มีประเด็นเร่งด่วนในภาพรวมโครงการ</p>'}
      </div>
    </div>`;
}

function renderGovernancePanel(project) {
  const panel = document.getElementById('project-governance-panel');
  if (!panel || !project) return;
  const health = getProjectHealthInsight(project);
  const tone = getHealthTone(health);
  const tasks = getTaskStats(project);
  const schedule = getScheduleStats(project);
  const budget = getBudgetUsage(project);
  const nextActions = [
    ...health.reasons.slice(0, 4),
    ...(tasks.overdue ? [`เร่งปิดงานเกินกำหนด ${tasks.overdue} รายการใน Kanban`] : []),
    ...(schedule.total === 0 ? ['กำหนดรอบอบรมพร้อมวันที่ในแท็บตารางเวลา'] : []),
    ...(budget.budget === 0 ? ['บันทึกงบประมาณที่ได้รับเพื่อควบคุม baseline'] : [])
  ].slice(0, 5);

  panel.innerHTML = `
    <div class="grid grid-cols-1 xl:grid-cols-[1.1fr_0.9fr] gap-5">
      <div class="card-modern p-6 governance-detail-card">
        <div class="flex items-start justify-between gap-4 mb-5">
          <div>
            <h4 class="font-bold text-gray-800 text-lg">Project Health</h4>
            <p class="text-xs text-gray-400 mt-1">ประเมินตามหลักควบคุมโครงการ: Scope, Schedule, Budget, Risk, Evidence</p>
          </div>
          <span class="health-badge ${tone.badge}"><i class="fa-solid ${tone.icon}"></i>${escapeHTML(tone.title)}</span>
        </div>
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          <div class="governance-kpi"><span>Readiness</span><strong>${health.readiness.score}%</strong></div>
          <div class="governance-kpi"><span>Schedule</span><strong>${schedule.pct}%</strong></div>
          <div class="governance-kpi"><span>Budget used</span><strong>${budget.pct}%</strong></div>
          <div class="governance-kpi"><span>Tasks done</span><strong>${tasks.pct}%</strong></div>
        </div>
        <div class="governance-bars">
          ${[
            ['ความพร้อมข้อมูล', health.readiness.score, 'emerald'],
            ['แผนอบรมที่ดำเนินแล้ว', schedule.pct, 'blue'],
            ['ควบคุมงบประมาณ', Math.min(budget.pct, 100), budget.pct >= 90 ? 'rose' : 'amber'],
            ['งานที่ปิดแล้ว', tasks.pct, 'violet']
          ].map(([label, value, color]) => `
            <div>
              <div class="flex justify-between text-xs font-bold mb-1"><span>${label}</span><span>${value}%</span></div>
              <div class="governance-bar"><span class="bar-${color}" style="width:${value}%"></span></div>
            </div>`).join('')}
        </div>
      </div>
      <div class="card-modern p-6">
        <h4 class="font-bold text-gray-800 mb-3">Risk & Action Log</h4>
        <div class="space-y-2">
          ${nextActions.length ? nextActions.map((item, index) => `
            <div class="risk-row">
              <span class="risk-seq">${index + 1}</span>
              <p>${escapeHTML(item)}</p>
            </div>`).join('') : '<p class="text-xs text-gray-400">ยังไม่มีประเด็นความเสี่ยงสำคัญ ระบบประเมินว่าโครงการอยู่ในเกณฑ์ปกติ</p>'}
        </div>
      </div>
    </div>`;
}


function renderProgressPanel(project) {
  const panel = document.getElementById('project-progress-panel');
  if (!panel || !project) return;
  const progress = getProjectProgressInsight(project);
  const gapTone = Math.abs(progress.gap) <= 15 ? 'text-emerald-700 bg-emerald-50' : 'text-amber-700 bg-amber-50';
  const readinessComplete = progress.readinessScore >= 100;
  const progressCards = [
    { label: 'บันทึกไว้', value: `${progress.manual}%` },
    { label: 'ระบบแนะนำ', value: `${progress.suggested}%` },
    {
      label: 'ข้อมูลครบทุกหัวข้อ',
      value: readinessComplete
        ? '<i class="fa-solid fa-check text-emerald-600" aria-label="ครบทุกหัวข้อ"></i>'
        : '<span class="text-sm font-black text-amber-600">ยังไม่ครบ</span>'
    },
    { label: 'ตารางอบรม', value: `${progress.scheduleScore}%` },
    { label: 'เบิกจ่ายจริง', value: `${progress.budgetScore}%` }
  ];
  panel.innerHTML = `
    <div class="rounded-[20px] border border-gray-100 bg-white p-5">
      <div class="flex items-center justify-between gap-3 mb-4">
        <div>
          <p class="text-[10px] font-black uppercase tracking-widest text-gray-400">ตัวช่วยประเมินความคืบหน้า</p>
          <p class="text-sm text-gray-500">ระบบคำนวณจากข้อมูลพร้อมใช้ ตารางอบรม งบที่เบิกจ่าย และเอกสาร</p>
        </div>
        <button type="button" id="apply-progress-recommendation" class="px-4 py-2 rounded-xl bg-blue-900 text-white text-xs font-black hover:scale-[1.02] transition">ใช้ ${progress.suggested}%</button>
      </div>
      <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
        ${progressCards.map(({ label, value }) => `
          <div class="rounded-2xl bg-slate-50 p-3">
            <p class="text-[10px] font-black text-gray-400">${label}</p>
            <p class="text-xl font-black text-gray-900">${value}</p>
          </div>`).join('')}
      </div>
      <div class="mt-4 flex items-center justify-between text-xs">
        <span class="font-bold text-gray-500">ส่วนต่างค่าที่บันทึกกับค่าที่ระบบแนะนำ</span>
        <span class="px-3 py-1 rounded-xl font-black ${gapTone}">${progress.gap > 0 ? '+' : ''}${progress.gap}%</span>
      </div>
    </div>`;

  document.getElementById('apply-progress-recommendation')?.addEventListener('click', () => {
    const input = document.getElementById('input-proj-progress');
    const display = document.getElementById('progress-val-display');
    if (input) input.value = progress.suggested;
    if (display) display.textContent = `${progress.suggested}%`;
    project.progress = progress.suggested;
    renderProgressPanel(project);
  });
}

function parseLocalDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const parts = dateStr.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  const [y, m, d] = parts;
  const local = new Date(y, m - 1, d);
  local.setHours(0, 0, 0, 0);
  return local;
}

function getMondayStart(dateValue) {
  const date = new Date(dateValue);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date;
}

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

  const monthFilter = document.getElementById('month-filter');
  if (monthFilter) monthFilter.value = String(getTodayFiscalMonth());

  renderMonthlyPlan();
}

export async function showWeeklyPlan() {
  if (!hasPermission('weekly')) { _noAccess('Weekly Schedule'); return; }
  hideAllViews(); setHeader('Weekly Schedule');
  document.getElementById('view-weekly-plan')?.classList.remove('hidden');
  updateNavActive('nav-weekly');
  if (!state.projects.length) await loadProjects();

  state.currentWeekStart = new Date();

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
    if (isAuthExpiredError(e)) {
      Swal.fire({
        icon: 'info',
        title: 'Session หมดอายุ',
        text: 'กรุณาเข้าสู่ระบบใหม่',
        confirmButtonColor: '#1e3a8a'
      });
      clearClientSession();
      return;
    }
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
  const totalExpense = state.projects.reduce((sum, p) => sum + getProjectExpense(p), 0);
  const budgetRemaining = budget - totalExpense;
  const readinessAlerts = state.projects
    .map(p => ({ p, readiness: getProjectReadiness(p) }))
    .filter(item => item.readiness.score < 85);
  const totalTasks = state.projects.reduce((s, p) => s + (p.tasks?.length || 0), 0);

  const warningProjects = state.projects
    .map(p => {
      const usage = getBudgetUsage(p);
      return { p, projectBudget: usage.budget, projectExpense: usage.expense, usagePct: usage.pct };
    })
    .filter(item => item.projectBudget > 0 && item.usagePct >= 90)
    .sort((a, b) => b.usagePct - a.usagePct);

  const activeCount = state.projects.filter(p => normalizeProjectStatus(p.status) === 'ดำเนินการ').length;
  if (el('stat-projects-active')) {
    el('stat-projects-active').innerHTML = activeCount
      ? `<i class="fa-solid fa-circle-play"></i> ${activeCount} ดำเนินการ`
      : '';
  }
  if (el('stat-people')) el('stat-people').innerText = people.toLocaleString();
  if (el('stat-budget')) el('stat-budget').innerText = formatCurrency(budget);
  if (el('stat-tasks'))  el('stat-tasks').innerText = totalTasks;
  if (el('stat-budget-remaining')) {
    el('stat-budget-remaining').innerText = formatCurrency(budgetRemaining);
    el('stat-budget-remaining').className = `text-3xl font-black ${budgetRemaining < 0 ? 'text-red-700' : 'text-emerald-700'}`;
  }
  if (el('stat-budget-alert-count')) {
    el('stat-budget-alert-count').innerText = `${warningProjects.length + readinessAlerts.length} รายการ`;
  }
  renderDashboardInsights();
  renderGovernanceDashboard();

  const warningList = el('budget-warning-list');
  if (warningList) {
    const budgetItems = warningProjects.slice(0, 4).map(({ p, usagePct, projectBudget, projectExpense }) => {
          const over = usagePct >= 100;
          const tone = over ? 'text-red-700 bg-red-50' : 'text-amber-700 bg-amber-50';
          const label = over ? 'เกินแผน' : 'ใกล้เกินแผน';
          return `
            <div class="flex items-center justify-between gap-3 rounded-xl px-3 py-2 ${tone}">
              <div class="min-w-0">
                <p class="font-bold text-xs truncate">${escapeHTML(p.name || '-')}</p>
                <p class="text-[11px] opacity-80">ใช้ไป ${formatCurrency(projectExpense)} / ${formatCurrency(projectBudget)}</p>
              </div>
              <div class="text-right shrink-0">
                <p class="text-xs font-black">${usagePct}%</p>
                <p class="text-[10px] font-bold opacity-80">${label}</p>
              </div>
            </div>`;
        });
    const readinessItems = readinessAlerts.slice(0, 3).map(({ p, readiness }) => `
      <div class="flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-sky-700 bg-sky-50">
        <div class="min-w-0">
          <p class="font-bold text-xs truncate">${escapeHTML(p.name || '-')}</p>
          <p class="text-[11px] opacity-80">ข้อมูลยังไม่ครบ: ${escapeHTML(readiness.missing.slice(0, 2).join(', ') || '-')}</p>
        </div>
        <div class="text-right shrink-0">
          <p class="text-xs font-black">${readiness.score}%</p>
          <p class="text-[10px] font-bold opacity-80">ความพร้อม</p>
        </div>
      </div>`);
    warningList.innerHTML = [...budgetItems, ...readinessItems].length
      ? [...budgetItems, ...readinessItems].join('')
      : '<p class="text-gray-400 text-xs">ยังไม่มีรายการแจ้งเตือน</p>';
  }
}

export function filterProjects(query) {
  state.projectFilter = String(query || '').trim().toLowerCase();
  renderProjectTable();
}

function getFilteredProjects() {
  const q = state.projectFilter;
  if (!q) return state.projects;
  return state.projects.filter(p =>
    [p.name, p.id, p.category, p.year, p.status]
      .some(v => String(v || '').toLowerCase().includes(q))
  );
}

function renderProjectCards(projects) {
  const list = document.getElementById('project-card-list');
  if (!list) return;
  if (!projects.length) {
    list.innerHTML = `<p class="p-8 text-center text-gray-300 font-bold text-sm">${state.projectFilter ? 'ไม่พบหลักสูตรที่ค้นหา' : 'ยังไม่มีหลักสูตร — กดปุ่ม "+ เพิ่มหลักสูตรใหม่"'}</p>`;
    return;
  }
  list.innerHTML = projects.map(p => {
    const statusMeta = getProjectStatusMeta(p.status);
    const taskCount = p.tasks?.length || 0;
    const doneTasks = p.tasks?.filter(t => t.status === 'done').length || 0;
    return `
      <div class="mobile-list-card" onclick="app.openProject('${escapeHTML(p.id)}')" role="button" tabindex="0"
           onkeydown="if(event.key==='Enter')app.openProject('${escapeHTML(p.id)}')">
        <div class="flex items-start justify-between gap-2 mb-2">
          <div class="min-w-0">
            <p class="font-bold text-gray-800 text-sm truncate">${escapeHTML(p.name)}</p>
            <p class="text-[11px] text-gray-400 mt-0.5">${escapeHTML(p.id)} • ${escapeHTML(p.category || '-')} • ${Number(p.people || 0).toLocaleString()} คน</p>
          </div>
          <span class="status-badge ${statusMeta.className} shrink-0">${escapeHTML(statusMeta.label)}</span>
        </div>
        <div class="flex items-center gap-2 mb-2">
          <div class="flex-1 bg-gray-100 rounded-full h-1.5">
            <div class="h-1.5 rounded-full bg-blue-500 transition-all" style="width:${p.progress || 0}%"></div>
          </div>
          <span class="text-[11px] font-bold text-gray-500 shrink-0">${p.progress || 0}%</span>
        </div>
        <div class="flex items-center justify-between gap-2">
          <p class="text-xs text-gray-500 font-bold">${formatCurrency(p.budget)} บาท${taskCount ? ` • ${doneTasks}/${taskCount} งาน` : ''}</p>
          ${renderHealthBadge(p, true)}
          <div class="flex items-center gap-1.5">
            <button type="button" onclick="event.stopPropagation(); app.openProject('${escapeHTML(p.id)}')" class="w-9 h-9 inline-flex items-center justify-center rounded-xl bg-blue-50 text-blue-700 active:bg-blue-100 transition" aria-label="แก้ไขหลักสูตร">
              <i class="fa-solid fa-pen-to-square text-xs"></i>
            </button>
            <button type="button" onclick="event.stopPropagation(); app.deleteProject('${escapeHTML(p.id)}')" class="w-9 h-9 inline-flex items-center justify-center rounded-xl bg-rose-50 text-rose-600 active:bg-rose-100 transition" aria-label="ลบหลักสูตร">
              <i class="fa-solid fa-trash-can text-xs"></i>
            </button>
          </div>
        </div>
      </div>`;
  }).join('');
}

export function renderProjectTable() {
  const tbody = document.getElementById('project-table-body');
  const projects = getFilteredProjects();
  renderProjectCards(projects);
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!projects.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="p-12 text-center">
      <i class="fa-solid ${state.projectFilter ? 'fa-magnifying-glass' : 'fa-folder-open'} text-3xl text-gray-200 block mb-2"></i>
      <span class="text-gray-300 font-bold">${state.projectFilter ? 'ไม่พบหลักสูตรที่ค้นหา — ลองใช้คำค้นอื่น' : 'ยังไม่มีหลักสูตร — เริ่มจากปุ่ม "+ เพิ่มหลักสูตรใหม่" มุมขวาบน'}</span>
    </td></tr>`;
    return;
  }
  projects.forEach(p => {
    const taskCount = p.tasks?.length || 0;
    const doneTasks = p.tasks?.filter(t => t.status === 'done').length || 0;
    const statusMeta = getProjectStatusMeta(p.status);
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-50/50 cursor-pointer transition-colors';
    tr.onclick = () => openProject(p.id);
    tr.innerHTML = `
      <td class="px-6 py-4 text-xs font-bold text-gray-400">${escapeHTML(p.id)}</td>
      <td class="px-6 py-4">
        <p class="font-bold text-gray-800 text-sm">${escapeHTML(p.name)}</p>
        <p class="text-[11px] text-gray-400 mt-1">${escapeHTML(p.category || '-')} • ${Number(p.people || 0).toLocaleString()} คน</p>
      </td>
      <td class="px-6 py-4 text-center">
        <span class="status-badge ${statusMeta.className}">${escapeHTML(statusMeta.label)}</span>
      </td>
      <td class="px-6 py-4 text-center">
        ${renderHealthBadge(p)}
      </td>
      <td class="px-6 py-4 text-center">
        <div class="flex items-center justify-center gap-2">
          <div class="w-24 bg-gray-100 rounded-full h-1.5">
            <div class="h-1.5 rounded-full bg-blue-500 transition-all" style="width:${p.progress||0}%"></div>
          </div>
          <span class="text-xs font-bold text-gray-500">${p.progress||0}%</span>
        </div>
        ${taskCount ? `<p class="text-[10px] text-gray-400 mt-1">${doneTasks}/${taskCount} งาน</p>` : ''}
      </td>
      <td class="px-6 py-4 text-xs text-gray-500 text-right">${formatCurrency(p.budget)}</td>
      <td class="px-6 py-4">
        <div class="flex items-center justify-center gap-2">
          <button type="button" onclick="event.stopPropagation(); app.openProject('${escapeHTML(p.id)}')" class="w-9 h-9 inline-flex items-center justify-center rounded-xl bg-blue-50 text-blue-700 hover:bg-blue-100 transition" title="แก้ไขหลักสูตร">
            <i class="fa-solid fa-pen-to-square text-xs"></i>
          </button>
          <button type="button" onclick="event.stopPropagation(); app.deleteProject('${escapeHTML(p.id)}')" class="w-9 h-9 inline-flex items-center justify-center rounded-xl bg-rose-50 text-rose-600 hover:bg-rose-100 transition" title="ลบหลักสูตร">
            <i class="fa-solid fa-trash-can text-xs"></i>
          </button>
        </div>
      </td>`;
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

  document.getElementById('input-proj-name').value  = p.name || '';
  document.getElementById('input-proj-year').value  = p.year || '';
  document.getElementById('input-proj-budget').value = p.budget || 0;
  document.getElementById('input-proj-people').value = p.people || 0;
  document.getElementById('input-proj-status').value = normalizeProjectStatus(p.status);
  document.getElementById('input-proj-start').value  = p.startMonth || 1;
  document.getElementById('input-proj-end').value    = p.endMonth || 12;
  document.getElementById('input-proj-priority').value = p.priority || 'medium';
  document.getElementById('input-proj-progress').value = p.progress || 0;
  document.getElementById('progress-val-display').innerText = (p.progress || 0) + '%';
  document.getElementById('input-proj-cme').value = p.cme || 0;
  if (document.getElementById('input-proj-desc'))
    document.getElementById('input-proj-desc').value = p.description || '';
  if (document.getElementById('input-proj-manager'))
    document.getElementById('input-proj-manager').value = p.projectManager || '';
  if (document.getElementById('input-proj-sponsor'))
    document.getElementById('input-proj-sponsor').value = p.sponsor || '';
  if (document.getElementById('input-proj-success'))
    document.getElementById('input-proj-success').value = p.successCriteria || '';

  populateDropdown('input-proj-category',   'category',   p.category   || 'basic');
  populateDropdown('input-proj-audience',   'audience',   p.audience   || 'all');
  populateDropdown('input-proj-assessment', 'assessment', p.assessment || 'attendance');

  switchTab('info');
  renderProgressPanel(p);
  renderGovernancePanel(p);
  renderDocsTable();
  renderFiscalCalendar();
  renderBudgetLedger();
  renderScheduleSessions();
  renderKanban(p);
}

export function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    const active = b.getAttribute('data-target') === 'tab-' + name;
    b.classList.toggle('tab-active', active);
    b.classList.toggle('text-gray-400', !active);
  });
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('hidden', c.id !== 'tab-' + name));
}

export function refreshProjectIndicators() {
  if (!state.currentProject) return;
  const progressInput = document.getElementById('input-proj-progress');
  if (progressInput) state.currentProject.progress = clampNumber(progressInput.value, 0, 100, 0);
  renderProgressPanel(state.currentProject);
  renderGovernancePanel(state.currentProject);
}

export async function saveProjectInfo() {
  if (!state.currentProject) return;
  const p = state.currentProject;
  p.name       = document.getElementById('input-proj-name')?.value.trim();
  p.year       = document.getElementById('input-proj-year')?.value.trim();
  p.budget     = Math.max(0, Number(document.getElementById('input-proj-budget')?.value) || 0);
  p.people     = Math.max(0, Number(document.getElementById('input-proj-people')?.value) || 0);
  p.status     = normalizeProjectStatus(document.getElementById('input-proj-status')?.value);
  p.startMonth = clampNumber(document.getElementById('input-proj-start')?.value, 1, 12, 1);
  p.endMonth   = clampNumber(document.getElementById('input-proj-end')?.value, 1, 12, 12);
  p.priority   = document.getElementById('input-proj-priority')?.value;
  p.progress   = clampNumber(document.getElementById('input-proj-progress')?.value, 0, 100, 0);
  p.cme        = Math.max(0, Number(document.getElementById('input-proj-cme')?.value) || 0);
  p.category   = document.getElementById('input-proj-category')?.value;
  p.audience   = document.getElementById('input-proj-audience')?.value;
  p.assessment = document.getElementById('input-proj-assessment')?.value;
  p.description = document.getElementById('input-proj-desc')?.value.trim() || '';
  p.projectManager = document.getElementById('input-proj-manager')?.value.trim() || '';
  p.sponsor = document.getElementById('input-proj-sponsor')?.value.trim() || '';
  p.successCriteria = document.getElementById('input-proj-success')?.value.trim() || '';
  p.updatedAt = new Date().toISOString();

  const validation = validateProject(p);
  if (validation.errors.length) {
    Swal.fire({
      icon: 'warning',
      title: 'ข้อมูลหลักสูตรยังไม่พร้อมบันทึก',
      html: `<ul class="text-left text-sm space-y-1">${validation.errors.map(error => `<li>• ${escapeHTML(error)}</li>`).join('')}</ul>`,
      confirmButtonColor: '#1e3a8a'
    });
    return;
  }

  try {
    await gas.saveProject(p);
    Swal.fire({ icon: 'success', title: 'บันทึกแล้ว', timer: 1500, showConfirmButton: false });
    renderDashboardStats();
    renderProjectTable();
  } catch (e) {
    Swal.fire({ icon: 'error', title: 'บันทึกล้มเหลว', text: e.message });
  }
}

export async function deleteProject(projectId = state.currentProject?.id) {
  const project = state.projects.find(p => String(p.id) === String(projectId));
  if (!project) return;

  const result = await Swal.fire({
    icon: 'warning',
    title: 'ลบหลักสูตรนี้?',
    html: `<div class="text-sm text-gray-500">หลักสูตร <strong>${escapeHTML(project.name || project.id)}</strong> จะถูกลบออกจากระบบ</div>`,
    showCancelButton: true,
    confirmButtonText: 'ลบหลักสูตร',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#dc2626',
    focusCancel: true
  });
  if (!result.isConfirmed) return;

  try {
    await gas.deleteProject(project.id);
    state.projects = state.projects.filter(p => String(p.id) !== String(project.id));
    if (state.currentProject?.id === project.id) state.currentProject = null;
    Swal.fire({ icon: 'success', title: 'ลบหลักสูตรแล้ว', timer: 1400, showConfirmButton: false });
    showDashboard();
  } catch (e) {
    Swal.fire({ icon: 'error', title: 'ลบหลักสูตรไม่สำเร็จ', text: e.message });
  }
}

export function createNewProject() {
  const fiscalYear = String(new Date().getFullYear() + 543);
  const id = 'TR-' + fiscalYear.slice(-2) + '-' + String(getProjectIdSequence(state.projects, fiscalYear)).padStart(2, '0');
  const p = {
    id, name: 'หลักสูตรใหม่ (รอกรอกชื่อ)',
    year: fiscalYear,
    status: 'ร่าง', people: 0, budget: 0,
    docs: [], schedules: [], ledger: [], tasks: [],
    startMonth: 1, endMonth: 12,
    priority: 'medium',
    progress: 0, cme: 0,
    category: 'basic', audience: 'all', assessment: 'attendance',
    projectManager: '', sponsor: '', successCriteria: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  state.projects.unshift(p);
  openProject(id);
  Swal.fire({ title: 'สร้างหลักสูตรใหม่', icon: 'info', toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
}

// -------- Documents --------
export function renderDocsTable() {
  const tbody = document.getElementById('docs-table-body');
  if (!tbody) return;
  const docs = state.currentProject?.docs || [];
  if (!docs.length) { tbody.innerHTML = `<tr><td colspan="4" class="p-8 text-center text-gray-300 font-bold">No documents</td></tr>`; return; }
  tbody.innerHTML = '';
  docs.forEach((doc, idx) => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-50/50 transition-colors';
    tr.innerHTML = `
      <td class="px-6 py-4"><div class="flex items-center space-x-3">
        <div class="w-8 h-8 rounded-lg bg-red-50 text-red-500 flex items-center justify-center"><i class="fa-solid fa-file-pdf"></i></div>
        <span class="text-xs font-bold text-gray-700">${escapeHTML(doc.name)}</span></div></td>
      <td class="px-6 py-4 text-xs font-bold text-gray-400">${escapeHTML(doc.date)}</td>
      <td class="px-6 py-4 text-center"><button onclick="app.downloadDocument(${idx})" class="p-2 text-blue-600 hover:bg-blue-50 rounded-xl transition" title="Download"><i class="fa-solid fa-download"></i></button></td>
      <td class="px-6 py-4 text-center"><button onclick="app.deleteDocument(${idx}); return false;" class="p-2 text-red-600 hover:bg-red-50 rounded-xl transition" title="Delete"><i class="fa-solid fa-trash"></i></button></td>`;
    tbody.appendChild(tr);
  });
}

export async function uploadDocument() {
  const inp = document.getElementById('file-upload');
  const f = inp?.files?.[0];
  if (!f) { Swal.fire('Alert', 'Please select file', 'warning'); return; }
  if (!state.currentProject) {
    Swal.fire('Alert', 'Please open a project first', 'warning');
    return;
  }
  const status = document.getElementById('upload-status');
  if (status) status.innerHTML = `<span class="text-blue-600 font-bold animate-pulse">Uploading ${f.name}...</span>`;
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const data = e.target.result.split(',')[1];
      const url = await gas.uploadFile(data, f.name);
      state.currentProject.docs ||= [];
      state.currentProject.docs.push({ name: f.name, date: new Date().toISOString().split('T')[0], url });
      if (status) status.innerHTML = `<span class="text-blue-600 font-bold animate-pulse">Saving ${f.name}...</span>`;
      await gas.saveProject(state.currentProject);
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

export async function deleteDocument(index) {
  if (!state.currentProject) return false;
  const doc = state.currentProject.docs?.[index];
  if (!doc) return false;
  
  const result = await Swal.fire({
    title: 'ลบเอกสาร?',
    text: `ยืนยันการลบ "${doc.name}"`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#ef4444',
    confirmButtonText: 'ลบ',
    cancelButtonText: 'ยกเลิก'
  });

  if (result.isConfirmed) {
    try {
      // Extract fileId from Google Drive URL if available
      const fileIdMatch = doc.url?.match(/[?&]id=([^&]+)/);
      const fileId = fileIdMatch ? fileIdMatch[1] : null;
      
      // Delete from Drive (production only)
      if (fileId) {
        try { await gas.deleteFile(fileId); } catch (e) { console.warn('Drive delete failed but continuing', e); }
      }
      
      state.currentProject.docs.splice(index, 1);
      await gas.saveProject(state.currentProject);
      Swal.fire({ icon: 'success', title: 'ลบแล้ว', toast: true, position: 'top-end', timer: 1200, showConfirmButton: false });
      renderDocsTable();
    } catch (err) {
      Swal.fire({ icon: 'error', title: 'ลบล้มเหลว', text: err.message });
    }
  }
  return false;
}

function openDataUrlDocument(dataUrl, filename) {
  const matches = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!matches) throw new Error('Invalid document data');

  const mimeType = matches[1] || 'application/octet-stream';
  const isBase64 = Boolean(matches[2]);
  const payload = matches[3] || '';
  const decoded = isBase64 ? atob(payload) : decodeURIComponent(payload);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i);

  const blob = new Blob([bytes], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const opened = window.open(objectUrl, '_blank', 'noopener');

  if (!opened) {
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename || 'document';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

export function downloadDocument(index) {
  const doc = state.currentProject?.docs?.[index];
  if (!doc || !doc.url) {
    Swal.fire('Alert', 'Document URL not available', 'warning');
    return false;
  }

  if (doc.url.startsWith('data:')) {
    try {
      openDataUrlDocument(doc.url, doc.name);
      Swal.fire({
        icon: 'info',
        title: 'เปิดไฟล์จากข้อมูลชั่วคราว',
        text: 'ไฟล์นี้ยังไม่ถูกเก็บบน Google Drive จริง ควรอัปโหลดใหม่หลังตั้งค่า backend เสร็จ',
        toast: true,
        position: 'top-end',
        timer: 2500,
        showConfirmButton: false
      });
    } catch (error) {
      Swal.fire('Error', error.message, 'error');
    }
    return false;
  }

  window.open(doc.url, '_blank');
  return false;
}


// -------- Annual / Monthly / Weekly (stub — extend as needed) --------
export function renderAnnualTimeline() {
  const container = document.getElementById('annual-timeline-body');
  if (!container) return;
  const MONTHS = FISCAL_MONTH_NAMES;
  const yearFilter = document.getElementById('annual-year-filter')?.value || 'all';
  const projects = yearFilter === 'all'
    ? state.projects
    : state.projects.filter(p => {
        const projectYear = Number(p.year);
        const selectedYear = Number(yearFilter);
        return String(p.year) === String(yearFilter)
          || (Number.isFinite(projectYear) && projectYear === selectedYear)
          || (Number.isFinite(projectYear) && projectYear - 543 === selectedYear);
      });

  const nowMonth = getTodayFiscalMonth();
  document.querySelectorAll('#annual-timeline-head th[data-month]').forEach(th => {
    th.classList.toggle('gantt-now-col', Number(th.dataset.month) === nowMonth);
  });

  container.innerHTML = projects.length
    ? projects.map(p => {
      const statusKey = STATUS_CHART_KEYS[normalizeProjectStatus(p.status)];
      const months = getFiscalMonthRange(p.startMonth, p.endMonth);
      const rangeLabel = `${MONTHS[months[0] - 1]} - ${MONTHS[months[months.length - 1] - 1]} (${months.length} เดือน)`;
      const health = getProjectHealthInsight(p);
      const tone = getHealthTone(health);
      const tooltip = `${p.name || p.id} • ${rangeLabel} • ${normalizeProjectStatus(p.status)} • คืบหน้า ${p.progress || 0}%`;
      return `
      <tr class="hover:bg-slate-50 cursor-pointer" onclick="app.openProject('${escapeHTML(p.id)}')" title="${escapeHTML(tooltip)} — คลิกเพื่อเปิดหลักสูตร">
        <td class="px-4 py-3">
          <div class="flex items-center gap-2.5 min-w-0">
            <span class="health-dot ${tone.badge}" title="${escapeHTML(health.reasons.join(' • ') || 'ไม่มีประเด็นสำคัญ')}"><i class="fa-solid ${tone.icon}"></i></span>
            <div class="min-w-0">
              <p class="font-bold text-gray-800 truncate max-w-[210px]">${escapeHTML(p.name)}</p>
              <p class="text-[10px] text-gray-400 mt-0.5">${rangeLabel} • คืบหน้า ${p.progress || 0}%</p>
            </div>
          </div>
        </td>
        ${MONTHS.map((_, i) => {
          const m = i + 1;
          const active = months.includes(m);
          const cellCls = m === nowMonth ? ' gantt-now-col' : '';
          if (!active) return `<td class="px-1 py-3 text-center${cellCls}"></td>`;
          const cap = `${months[0] === m ? ' gantt-cap-start' : ''}${months[months.length - 1] === m ? ' gantt-cap-end' : ''}`;
          return `<td class="px-1 py-3 text-center${cellCls}"><div class="gantt-bar gantt-${statusKey}${cap}" title="${escapeHTML(tooltip)}"></div></td>`;
        }).join('')}
      </tr>`;
    }).join('')
    : `<tr><td colspan="13" class="px-4 py-12 text-center">
        <i class="fa-regular fa-calendar text-3xl text-gray-200 block mb-2"></i>
        <span class="text-gray-300 font-bold">ไม่พบหลักสูตรในปีที่เลือก — ลองเปลี่ยนปีงบประมาณด้านบน</span>
      </td></tr>`;
}

export function renderMonthlyPlan() {
  const container = document.getElementById('monthly-list-container');
  if (!container) return;
  const MONTHS = FISCAL_MONTH_NAMES;
  const selectedMonth = Number(document.getElementById('month-filter')?.value) || 1;
  const selectedName = MONTHS[selectedMonth - 1] || '-';
  const projects = state.projects.filter(p => {
    return isFiscalMonthInRange(selectedMonth, p.startMonth, p.endMonth);
  });

  container.innerHTML = `
    <div class="md:col-span-2 lg:col-span-3 card-modern p-5 mb-2 flex items-center justify-between gap-4">
      <div>
        <h3 class="font-bold text-gray-800 text-lg">${selectedName}</h3>
        <p class="text-xs text-gray-400">พบ ${projects.length} หลักสูตรในเดือนที่เลือก</p>
      </div>
      <div class="text-xs text-gray-500 font-medium">แสดงตามช่วงเดือนของหลักสูตร</div>
    </div>
    ${projects.length
      ? projects.map(p => `
        ${(() => {
          const readiness = getProjectReadiness(p);
          const usage = getBudgetUsage(p);
          const months = getFiscalMonthRange(p.startMonth, p.endMonth);
          const statusMeta = getProjectStatusMeta(p.status);
          return `
        <div class="card-modern p-5">
          <div class="flex items-start justify-between gap-3 mb-3">
            <div>
              <h4 class="font-bold text-gray-800">${escapeHTML(p.name)}</h4>
              <p class="text-xs text-gray-400">${escapeHTML(p.id)} • ปี ${escapeHTML(String(p.year || '-'))}</p>
            </div>
            <span class="status-badge ${statusMeta.className}">${escapeHTML(statusMeta.label)}</span>
          </div>
          <div class="text-xs text-gray-500 space-y-2">
            <div>ช่วงดำเนินงาน: ${MONTHS[(Number(p.startMonth) || 1) - 1]} - ${MONTHS[(Number(p.endMonth) || 12) - 1]} (${months.length} เดือน)</div>
            <div>ผู้เข้าร่วม: ${Number(p.people || 0).toLocaleString()} คน</div>
            <div>
              <div class="flex items-center justify-between text-[11px] font-bold mb-1">
                <span>ใช้งบ ${formatCurrency(Number(p.budget || 0))}</span>
                <span class="${usage.pct >= 100 ? 'text-rose-600' : usage.pct >= 85 ? 'text-amber-600' : ''}">${usage.pct}%</span>
              </div>
              <div class="h-2 rounded-full bg-gray-100 overflow-hidden" title="ใช้/ผูกพันแล้ว ${formatCurrency(usage.expense)} จาก ${formatCurrency(usage.budget)} บาท">
                <div class="h-full rounded-full ${usage.pct >= 100 ? 'bg-rose-500' : usage.pct >= 85 ? 'bg-amber-500' : 'bg-blue-500'}" style="width:${Math.min(usage.pct, 100)}%"></div>
              </div>
            </div>
            <div>
              <div class="flex items-center justify-between text-[11px] font-bold mb-1">
                <span>ความพร้อมหลักสูตร</span><span>${readiness.score}%</span>
              </div>
              <div class="h-2 rounded-full bg-gray-100 overflow-hidden">
                <div class="h-full rounded-full ${readiness.tone === 'emerald' ? 'bg-emerald-500' : readiness.tone === 'amber' ? 'bg-amber-500' : 'bg-rose-500'}" style="width:${readiness.score}%"></div>
              </div>
            </div>
          </div>
        </div>`;
        })()}
      `).join('')
      : `<div class="md:col-span-2 lg:col-span-3 text-center py-16">
          <i class="fa-regular fa-calendar-minus text-4xl text-gray-200 block mb-3"></i>
          <p class="text-gray-300 font-bold">ไม่มีหลักสูตรในเดือนที่เลือก</p>
          <p class="text-xs text-gray-400 mt-1.5">ลองเลือกเดือนอื่นจากตัวเลือกด้านบน</p>
        </div>`}
  `;
}

export function renderWeeklyPlan() {
  const container = document.getElementById('weekly-grid');
  if (!container) return;
  const rangeEl = document.getElementById('weekly-date-range');
  const current = state.currentWeekStart instanceof Date ? new Date(state.currentWeekStart) : new Date();
  const weekStart = getMondayStart(current);
  state.currentWeekStart = weekStart;
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  if (rangeEl) {
    rangeEl.textContent = `${weekStart.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })} - ${weekEnd.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })}`;
  }

  const sessions = state.projects.flatMap(p =>
    (p.schedules || []).map(s => ({ ...s, projectName: p.name }))
  ).filter(s => {
    if (!s.date) return false;
    const d = parseLocalDate(s.date);
    if (!d) return false;
    return d >= weekStart && d <= weekEnd;
  }).sort((a, b) => a.date.localeCompare(b.date));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  container.innerHTML = sessions.length
    ? sessions.map(s => {
      const sessionDate = parseLocalDate(s.date);
      const isToday = sessionDate && sessionDate.getTime() === today.getTime();
      return `<div class="weekly-session-card bg-white rounded-2xl border ${isToday ? 'weekly-today' : 'border-gray-100'} shadow-sm">
        <div class="weekly-date-badge">
          <span>${s.date ? new Date(s.date).toLocaleDateString('th-TH',{month:'short'}) : '-'}</span>
          <strong>${s.date ? new Date(s.date).getDate() : '-'}</strong>
        </div>
        <div class="weekly-session-main">
          <p class="font-bold text-gray-800 text-sm truncate">${escapeHTML(s.name || 'รอบอบรม')}${isToday ? ' <span class="weekly-today-badge">วันนี้</span>' : ''}</p>
          <p class="text-xs text-gray-500 line-clamp-2">${escapeHTML(s.projectName)}</p>
          ${s.venue ? `<p class="text-xs text-gray-400 truncate"><i class="fa-solid fa-location-dot mr-1"></i>${escapeHTML(s.venue)}</p>` : ''}
        </div>
        <span class="weekly-days-badge">${s.days||1} วัน</span>
      </div>`;
    }).join('')
    : `<div class="col-span-full text-center py-16">
        <i class="fa-regular fa-calendar-xmark text-4xl text-gray-200 block mb-3"></i>
        <p class="text-gray-300 font-bold">ไม่มีกำหนดการอบรมในสัปดาห์นี้</p>
        <p class="text-xs text-gray-400 mt-1.5">ใช้ปุ่มลูกศรด้านบนเพื่อดูสัปดาห์อื่น หรือเพิ่มรอบอบรมในแท็บ "ตารางเวลา" ของหลักสูตร</p>
      </div>`;
}

export function changeWeek(delta) {
  const base = state.currentWeekStart instanceof Date ? new Date(state.currentWeekStart) : new Date();
  base.setDate(base.getDate() + (delta * 7));
  state.currentWeekStart = base;
  renderWeeklyPlan();
}

// ══════════════════════════════════════
//  KANBAN TASK BOARD
// ══════════════════════════════════════
let _dragTaskId = null;

const KANBAN_COLS = [
  { id: 'todo',  label: 'รอดำเนินการ', icon: 'fa-inbox',         bg: 'bg-slate-50',   border: 'border-slate-200',  countBg: 'bg-slate-100 text-slate-600',   addColor: 'text-slate-400' },
  { id: 'doing', label: 'กำลังดำเนินการ', icon: 'fa-spinner',        bg: 'bg-amber-50',   border: 'border-amber-200',  countBg: 'bg-amber-100 text-amber-700',   addColor: 'text-amber-400' },
  { id: 'done',  label: 'เสร็จแล้ว',    icon: 'fa-circle-check',  bg: 'bg-emerald-50', border: 'border-emerald-200',countBg: 'bg-emerald-100 text-emerald-700', addColor: 'text-emerald-500' },
];

const PRIORITY_CFG = {
  high:   { label: 'สูง',  cls: 'bg-rose-50 text-rose-600',   dot: 'bg-rose-500' },
  medium: { label: 'กลาง', cls: 'bg-amber-50 text-amber-600', dot: 'bg-amber-400' },
  low:    { label: 'ต่ำ',  cls: 'bg-slate-100 text-slate-500', dot: 'bg-slate-400' },
};

function _taskCard(task) {
  const pri = PRIORITY_CFG[task.priority] || PRIORITY_CFG.medium;
  const isOverdue = task.dueDate && new Date(task.dueDate) < new Date() && task.status !== 'done';
  return `
    <div class="kanban-card" draggable="true"
         ondragstart="app.onKanbanDragStart(event,'${task.id}')"
         ondragend="app.onKanbanDragEnd(event)">
      <div class="flex items-start justify-between gap-2 mb-2">
        <p class="font-bold text-gray-800 text-sm leading-snug flex-1">${escapeHTML(task.title)}</p>
        <div class="flex items-center gap-1 flex-shrink-0">
          <button onclick="app.editKanbanTask('${task.id}')"
                  class="text-gray-300 hover:text-blue-500 transition p-0.5 rounded" title="แก้ไขงาน">
            <i class="fa-solid fa-pen text-[11px]"></i>
          </button>
          <button onclick="app.deleteKanbanTask('${task.id}')"
                  class="text-gray-300 hover:text-red-400 transition p-0.5 rounded" title="ลบงาน">
            <i class="fa-solid fa-xmark text-xs"></i>
          </button>
        </div>
      </div>
      ${task.description ? `<p class="text-xs text-gray-400 mb-3 leading-relaxed">${escapeHTML(task.description)}</p>` : ''}
      <div class="flex items-center flex-wrap gap-1.5 mt-2">
        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-bold ${pri.cls}">
          <span class="w-1.5 h-1.5 rounded-full ${pri.dot} inline-block"></span>${pri.label}
        </span>
        ${task.assignee ? `<span class="inline-flex items-center gap-1 text-[10px] font-medium text-gray-400 bg-gray-50 px-2 py-0.5 rounded-lg"><i class="fa-solid fa-user text-[9px]"></i>${escapeHTML(task.assignee)}</span>` : ''}
        ${task.dueDate ? `<span class="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-lg ${isOverdue ? 'bg-rose-50 text-rose-500' : 'text-gray-400 bg-gray-50'}"><i class="fa-regular fa-calendar text-[9px]"></i>${escapeHTML(task.dueDate)}</span>` : ''}
      </div>
    </div>`;
}

function _kanbanTaskForm(task) {
  const t = task || {};
  return `
    <div class="space-y-3 text-left mt-2">
      <div>
        <label class="block text-xs font-bold text-gray-400 uppercase mb-1">ชื่องาน *</label>
        <input id="swk-title" class="swal2-input !text-sm" placeholder="เช่น ประสานวิทยากร" value="${escapeHTML(t.title || '')}">
      </div>
      <div>
        <label class="block text-xs font-bold text-gray-400 uppercase mb-1">รายละเอียด</label>
        <textarea id="swk-desc" class="swal2-textarea !text-sm !h-16" placeholder="รายละเอียดงาน...">${escapeHTML(t.description || '')}</textarea>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-xs font-bold text-gray-400 uppercase mb-1">ผู้รับผิดชอบ</label>
          <input id="swk-assignee" class="swal2-input !text-sm" placeholder="ชื่อ-สกุล" value="${escapeHTML(t.assignee || '')}">
        </div>
        <div>
          <label class="block text-xs font-bold text-gray-400 uppercase mb-1">กำหนดเสร็จ</label>
          <input type="date" id="swk-due" class="swal2-input !text-sm" value="${escapeHTML(t.dueDate || '')}">
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-xs font-bold text-gray-400 uppercase mb-1">ความสำคัญ</label>
          <select id="swk-priority" class="swal2-select !text-sm">
            <option value="high" ${t.priority === 'high' ? 'selected' : ''}>สูง</option>
            <option value="medium" ${!t.priority || t.priority === 'medium' ? 'selected' : ''}>กลาง</option>
            <option value="low" ${t.priority === 'low' ? 'selected' : ''}>ต่ำ</option>
          </select>
        </div>
        <div>
          <label class="block text-xs font-bold text-gray-400 uppercase mb-1">สถานะ</label>
          <select id="swk-status" class="swal2-select !text-sm">
            ${KANBAN_COLS.map(col => `<option value="${col.id}" ${(t.status || 'todo') === col.id ? 'selected' : ''}>${col.label}</option>`).join('')}
          </select>
        </div>
      </div>
    </div>`;
}

function _readKanbanTaskForm() {
  const title = document.getElementById('swk-title')?.value.trim();
  if (!title) { Swal.showValidationMessage('กรุณากรอกชื่องาน'); return false; }
  return {
    title,
    description: document.getElementById('swk-desc')?.value.trim() || '',
    assignee:    document.getElementById('swk-assignee')?.value.trim() || '',
    dueDate:     document.getElementById('swk-due')?.value || '',
    priority:    document.getElementById('swk-priority')?.value || 'medium',
    status:      document.getElementById('swk-status')?.value || 'todo',
  };
}

export function renderKanban(project) {
  const p = project || state.currentProject;
  if (!p) return;
  p.tasks = p.tasks || [];
  const board = document.getElementById('kanban-board');
  if (!board) return;

  board.innerHTML = KANBAN_COLS.map(col => {
    const tasks = p.tasks.filter(t => t.status === col.id);
    return `
      <div class="kanban-column ${col.bg} ${col.border}"
           data-status="${col.id}"
           ondragover="event.preventDefault(); this.classList.add('drag-over')"
           ondragleave="event.target === this && this.classList.remove('drag-over')"
           ondrop="app.onKanbanDrop(event,'${col.id}')">
        <div class="kanban-col-header">
          <div class="flex items-center gap-2">
            <i class="fa-solid ${col.icon} text-sm opacity-60"></i>
            <span class="font-bold text-gray-700 text-sm">${col.label}</span>
            <span class="kanban-count ${col.countBg}">${tasks.length}</span>
          </div>
          <button onclick="app.addKanbanTask('${col.id}')"
                  class="kanban-add-btn ${col.addColor}" title="เพิ่มงาน">
            <i class="fa-solid fa-plus text-xs"></i>
          </button>
        </div>
        <div class="space-y-2.5 min-h-[80px]">
          ${tasks.map(_taskCard).join('') || `<p class="text-center text-xs text-gray-300 py-6 font-medium">ลากการ์ดมาวางที่นี่</p>`}
        </div>
      </div>`;
  }).join('');
}

export async function addKanbanTask(status) {
  const { value } = await Swal.fire({
    title: 'เพิ่มงานใหม่',
    width: 480,
    html: _kanbanTaskForm({ status }),
    focusConfirm: false,
    showCancelButton: true,
    confirmButtonText: '<i class="fa-solid fa-plus mr-1"></i> เพิ่มงาน',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#1e3a8a',
    preConfirm: _readKanbanTaskForm
  });

  if (!value || !state.currentProject) return;
  state.currentProject.tasks = state.currentProject.tasks || [];
  state.currentProject.tasks.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    ...value,
    createdAt: new Date().toISOString(),
  });
  renderKanban(state.currentProject);
  renderDashboardStats();
  try { await gas.saveProject(state.currentProject); } catch {}
}

export async function editKanbanTask(taskId) {
  if (!state.currentProject) return;
  state.currentProject.tasks = state.currentProject.tasks || [];
  const task = state.currentProject.tasks.find(t => t.id === taskId);
  if (!task) return;

  const { value } = await Swal.fire({
    title: 'แก้ไขงาน',
    width: 480,
    html: _kanbanTaskForm(task),
    focusConfirm: false,
    showCancelButton: true,
    confirmButtonText: '<i class="fa-solid fa-floppy-disk mr-1"></i> บันทึก',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#1e3a8a',
    preConfirm: _readKanbanTaskForm
  });

  if (!value) return;
  Object.assign(task, value, { updatedAt: new Date().toISOString() });
  renderKanban(state.currentProject);
  renderDashboardStats();
  try {
    await gas.saveProject(state.currentProject);
    Swal.fire({ icon: 'success', title: 'บันทึกงานแล้ว', toast: true, position: 'top-end', timer: 1200, showConfirmButton: false });
  } catch (e) {
    Swal.fire({ icon: 'error', title: 'บันทึกงานล้มเหลว', text: e.message });
  }
}

export async function deleteKanbanTask(taskId) {
  const result = await Swal.fire({
    title: 'ลบงานนี้?', icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#ef4444',
    confirmButtonText: 'ลบ',
    cancelButtonText: 'ยกเลิก',
  });
  if (!result.isConfirmed || !state.currentProject) return;
  state.currentProject.tasks = state.currentProject.tasks?.filter(t => t.id !== taskId) || [];
  renderKanban(state.currentProject);
  renderDashboardStats();
  try { await gas.saveProject(state.currentProject); } catch {}
}

export function onKanbanDragStart(event, taskId) {
  _dragTaskId = taskId;
  event.dataTransfer.effectAllowed = 'move';
  event.currentTarget.classList.add('dragging');
}

export function onKanbanDragEnd(event) {
  event.currentTarget?.classList.remove('dragging');
  document.querySelectorAll('.kanban-column').forEach(c => c.classList.remove('drag-over'));
}

export async function onKanbanDrop(event, newStatus) {
  event.preventDefault();
  document.querySelectorAll('.kanban-column').forEach(c => c.classList.remove('drag-over'));
  if (!_dragTaskId || !state.currentProject) return;
  const task = state.currentProject.tasks?.find(t => t.id === _dragTaskId);
  _dragTaskId = null;
  if (!task || task.status === newStatus) return;
  task.status = newStatus;
  renderKanban(state.currentProject);
  try { await gas.saveProject(state.currentProject); } catch {}
}
