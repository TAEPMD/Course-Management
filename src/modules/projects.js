/**
 * modules/projects.js — Project CRUD, Dashboard, Annual/Monthly/Weekly views
 */
import { state } from './state.js';
import { hasPermission } from './permissions.js';
import { clearClientSession, hideAllViews, isAuthExpiredError, setHeader, updateNavActive } from './auth.js';
import { populateDropdown } from './masterData.js';
import { renderBudgetLedger } from './budget.js';
import { renderAccounting } from './accounting.js';
import { renderFiscalCalendar, renderScheduleSessions } from './schedule.js';
import { escapeHTML, escapeJsAttr, formatCurrency } from '../utils/format.js';
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
            <button type="button" class="governance-focus-row" onclick="app.openProject('${escapeJsAttr(project.id)}')">
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
  renderProgressAdvisorPanel(project);
  return;
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
    renderProjectInfoVisualPanel(project);
  });
}

function getProjectInfoDraft(base = state.currentProject) {
  const project = { ...(base || {}) };
  const value = id => document.getElementById(id)?.value;
  const textValue = id => document.getElementById(id)?.value?.trim();

  if (document.getElementById('input-proj-name')) project.name = textValue('input-proj-name') || project.name || '';
  if (document.getElementById('input-proj-year')) project.year = textValue('input-proj-year') || project.year || '';
  if (document.getElementById('input-proj-status')) project.status = normalizeProjectStatus(value('input-proj-status'));
  if (document.getElementById('input-proj-priority')) project.priority = value('input-proj-priority') || project.priority || 'medium';
  if (document.getElementById('input-proj-progress')) project.progress = clampNumber(value('input-proj-progress'), 0, 100, project.progress || 0);
  if (document.getElementById('input-proj-cme')) project.cme = Math.max(0, Number(value('input-proj-cme')) || 0);
  if (document.getElementById('input-proj-category')) project.category = value('input-proj-category') || project.category || 'basic';
  if (document.getElementById('input-proj-desc')) project.description = textValue('input-proj-desc') || '';
  if (document.getElementById('input-proj-manager')) project.projectManager = textValue('input-proj-manager') || '';
  if (document.getElementById('input-proj-sponsor')) project.sponsor = textValue('input-proj-sponsor') || '';
  if (document.getElementById('input-proj-success')) project.successCriteria = textValue('input-proj-success') || '';
  if (document.getElementById('input-proj-start')) project.startMonth = clampNumber(value('input-proj-start'), 1, 12, project.startMonth || 1);
  if (document.getElementById('input-proj-end')) project.endMonth = clampNumber(value('input-proj-end'), 1, 12, project.endMonth || 12);

  return project;
}

function getProjectInfoDecision(project) {
  const health = getProjectHealthInsight(project);
  const progress = getProjectProgressInsight(project);
  const tasks = getTaskStats(project);
  const schedule = getScheduleStats(project);
  const budget = getBudgetUsage(project);
  const readinessScore = health.readiness.score;
  const budgetControl = budget.budget ? Math.max(0, 100 - Math.max(0, budget.pct - 100)) : 35;
  const decisionScore = Math.round(
    (readinessScore * 0.34) +
    (progress.suggested * 0.24) +
    (schedule.pct * 0.16) +
    (tasks.pct * 0.14) +
    (budgetControl * 0.12)
  );
  const tone = decisionScore >= 80 ? 'emerald' : decisionScore >= 55 ? 'amber' : 'rose';
  const decisionText = decisionScore >= 80
    ? 'พร้อมเดินหน้าหรืออนุมัติขั้นถัดไป'
    : decisionScore >= 55
      ? 'เดินหน้าได้ แต่ควรปิดช่องว่างสำคัญก่อน'
      : 'ควรเติมข้อมูลและลดความเสี่ยงก่อนตัดสินใจ';
  const actions = [
    ...health.reasons,
    ...(progress.gap < -15 ? [`ความคืบหน้าที่บันทึกต่ำกว่าระบบแนะนำ ${Math.abs(progress.gap)}%`] : []),
    ...(tasks.overdue ? [`งาน Kanban เกินกำหนด ${tasks.overdue} รายการ`] : []),
    ...(schedule.total === 0 ? ['ยังไม่มีกำหนดการอบรม'] : []),
    ...(budget.budget === 0 ? ['ยังไม่ได้ตั้งงบประมาณ baseline'] : []),
    ...(!project.successCriteria ? ['ยังไม่มีเกณฑ์ความสำเร็จที่ใช้ปิดโครงการ'] : []),
  ].slice(0, 4);

  return { health, progress, tasks, schedule, budget, readinessScore, budgetControl, decisionScore, tone, decisionText, actions };
}

function renderProjectInfoVisualPanel(project = state.currentProject) {
  const panel = document.getElementById('project-info-visual-panel');
  if (!panel || !project) return;
  const draft = getProjectInfoDraft(project);
  const insight = getProjectInfoDecision(draft);
  const priorityLabel = { high: 'สูง', medium: 'ปานกลาง', low: 'ต่ำ' }[draft.priority] || 'ปานกลาง';
  const categoryLabel = document.getElementById('input-proj-category')?.selectedOptions?.[0]?.textContent || draft.category || '-';
  const fiscalMonths = FISCAL_MONTH_NAMES.map((month, index) => {
    const monthNo = index + 1;
    const active = isFiscalMonthInRange(monthNo, draft.startMonth || 1, draft.endMonth || 12);
    return `<span class="${active ? 'active' : ''}" title="${month}">${month.slice(0, 3)}</span>`;
  }).join('');
  const readinessAngle = Math.min(100, Math.max(0, insight.readinessScore)) * 3.6;
  const decisionAngle = Math.min(100, Math.max(0, insight.decisionScore)) * 3.6;
  const actionMarkup = insight.actions.length
    ? insight.actions.map((item, index) => `
        <li>
          <span>${index + 1}</span>
          <p>${escapeHTML(item)}</p>
        </li>`).join('')
    : '<li class="is-good"><span><i class="fa-solid fa-check"></i></span><p>ข้อมูลสำคัญพร้อมใช้งาน ยังไม่พบประเด็นเร่งด่วน</p></li>';

  panel.innerHTML = `
    <section class="project-info-command">
      <div class="project-info-hero">
        <div class="project-info-copy">
          <p class="project-info-label">General Information Intelligence</p>
          <h3>${escapeHTML(draft.name || 'หลักสูตรใหม่')}</h3>
          <div class="project-info-meta">
            <span><i class="fa-solid fa-calendar-days"></i>ปีงบประมาณ ${escapeHTML(draft.year || '-')}</span>
            <span><i class="fa-solid fa-layer-group"></i>${escapeHTML(categoryLabel)}</span>
            <span><i class="fa-solid fa-flag"></i>Priority ${escapeHTML(priorityLabel)}</span>
          </div>
        </div>
        <div class="project-decision-gauge ${insight.tone}">
          <div class="gauge-ring" style="--gauge:${decisionAngle}deg">
            <strong>${insight.decisionScore}</strong>
            <span>Decision</span>
          </div>
          <p>${insight.decisionText}</p>
        </div>
      </div>

      <div class="project-info-visual-grid">
        <div class="project-info-card readiness">
          <div class="project-info-card-head">
            <span><i class="fa-solid fa-clipboard-check"></i></span>
            <div><strong>Readiness</strong><small>ความครบถ้วนของข้อมูล</small></div>
          </div>
          <div class="mini-gauge" style="--gauge:${readinessAngle}deg"><strong>${insight.readinessScore}%</strong></div>
          <div class="mini-bar"><span style="width:${insight.readinessScore}%"></span></div>
        </div>

        <div class="project-info-card">
          <div class="project-info-card-head">
            <span><i class="fa-solid fa-chart-line"></i></span>
            <div><strong>Progress Signal</strong><small>บันทึกเทียบกับระบบแนะนำ</small></div>
          </div>
          <div class="signal-row"><span>บันทึกไว้</span><b>${insight.progress.manual}%</b></div>
          <div class="signal-row"><span>ระบบแนะนำ</span><b>${insight.progress.suggested}%</b></div>
          <div class="dual-bars">
            <span style="width:${insight.progress.manual}%"></span>
            <em style="width:${insight.progress.suggested}%"></em>
          </div>
        </div>

        <div class="project-info-card">
          <div class="project-info-card-head">
            <span><i class="fa-solid fa-route"></i></span>
            <div><strong>Fiscal Timeline</strong><small>ช่วงเดือนตามปีงบประมาณ</small></div>
          </div>
          <div class="fiscal-spark">${fiscalMonths}</div>
          <p class="spark-caption">${FISCAL_MONTH_NAMES[(draft.startMonth || 1) - 1]} - ${FISCAL_MONTH_NAMES[(draft.endMonth || 12) - 1]}</p>
        </div>

        <div class="project-info-card">
          <div class="project-info-card-head">
            <span><i class="fa-solid fa-scale-balanced"></i></span>
            <div><strong>Control Balance</strong><small>งบ งาน และกำหนดการ</small></div>
          </div>
          <div class="control-matrix">
            <div><strong>${insight.budget.pct}%</strong><span>ใช้งบ</span></div>
            <div><strong>${insight.tasks.pct}%</strong><span>งานเสร็จ</span></div>
            <div><strong>${insight.schedule.pct}%</strong><span>รอบผ่านแล้ว</span></div>
          </div>
        </div>
      </div>

      <div class="project-info-bottom">
        <div class="decision-actions">
          <div class="project-info-card-head">
            <span><i class="fa-solid fa-bullseye"></i></span>
            <div><strong>Next Decision Points</strong><small>สิ่งที่ควรปิดก่อนอนุมัติ/เดินหน้าต่อ</small></div>
          </div>
          <ol>${actionMarkup}</ol>
        </div>
        <div class="project-info-facts">
          <div><span>ผู้จัดการ</span><strong>${escapeHTML(draft.projectManager || '-')}</strong></div>
          <div><span>ผู้สนับสนุน</span><strong>${escapeHTML(draft.sponsor || '-')}</strong></div>
          <div><span>CME/CEU</span><strong>${Number(draft.cme || 0).toLocaleString()} หน่วยกิต</strong></div>
          <div><span>งบประมาณ</span><strong>${formatCurrency(insight.budget.budget)} บาท</strong></div>
        </div>
      </div>
    </section>`;
}

function bindProjectInfoPreview() {
  const panel = document.getElementById('project-info-visual-panel');
  if (!panel || panel.dataset.bound === 'true') return;
  panel.dataset.bound = 'true';
  [
    'input-proj-name', 'input-proj-year', 'input-proj-status', 'input-proj-desc',
    'input-proj-manager', 'input-proj-sponsor', 'input-proj-success', 'input-proj-cme',
    'input-proj-category', 'input-proj-priority', 'input-proj-progress',
    'input-proj-start', 'input-proj-end', 'input-proj-budget'
  ].forEach(id => {
    const input = document.getElementById(id);
    if (!input) return;
    const eventName = input.tagName === 'SELECT' || input.type === 'range' ? 'change' : 'input';
    input.addEventListener(eventName, () => renderProjectInfoVisualPanel(state.currentProject));
  });
}

function renderProgressAdvisorPanel(project) {
  const panel = document.getElementById('project-progress-panel');
  if (!panel || !project) return;
  const progress = getProjectProgressInsight(project);
  const readinessComplete = progress.readinessScore >= 100;
  const gapAbs = Math.abs(progress.gap);
  const gapTone = gapAbs <= 10 ? 'aligned' : gapAbs <= 25 ? 'watch' : 'risk';
  const gapText = progress.gap === 0
    ? 'ตรงกับค่าที่ระบบแนะนำ'
    : progress.gap > 0
      ? `บันทึกมากกว่าค่าแนะนำ ${progress.gap}%`
      : `บันทึกต่ำกว่าค่าแนะนำ ${gapAbs}%`;
  const recommendationText = gapAbs <= 10
    ? 'ค่าที่บันทึกสอดคล้องกับข้อมูลประกอบ'
    : progress.gap < 0
      ? 'ควรพิจารณาใช้ค่าที่ระบบแนะนำ หรือเติมข้อมูลสนับสนุนเพิ่มเติม'
      : 'ค่าที่บันทึกสูงกว่าข้อมูลประกอบ ควรตรวจหลักฐานก่อนอนุมัติ';
  const readinessAngle = Math.min(100, Math.max(0, progress.readinessScore)) * 3.6;
  const suggestedAngle = Math.min(100, Math.max(0, progress.suggested)) * 3.6;
  const manualAngle = Math.min(100, Math.max(0, progress.manual)) * 3.6;
  const componentRows = [
    { label: 'ข้อมูลครบทุกหัวข้อ', value: progress.readinessScore, icon: readinessComplete ? 'fa-check' : 'fa-circle-half-stroke', tone: readinessComplete ? 'ok' : 'warn' },
    { label: 'ตารางอบรม', value: progress.scheduleScore, icon: 'fa-calendar-check', tone: progress.scheduleScore >= 60 ? 'ok' : 'warn' },
    { label: 'เบิกจ่ายจริง', value: progress.budgetScore, icon: 'fa-file-invoice-dollar', tone: progress.budgetScore >= 60 ? 'ok' : 'warn' },
  ];

  panel.innerHTML = `
    <section class="progress-advisor-card">
      <div class="progress-advisor-head">
        <div>
          <p class="progress-advisor-kicker">ตัวช่วยประเมินความคืบหน้า</p>
          <h4>Progress Decision Advisor</h4>
          <p>คำนวณจากความพร้อมของข้อมูล ตารางอบรม งบที่เบิกจ่าย และหลักฐานประกอบ</p>
        </div>
        <button type="button" id="apply-progress-recommendation" class="progress-advisor-apply">
          <i class="fa-solid fa-wand-magic-sparkles"></i>
          <span>ใช้ ${progress.suggested}%</span>
        </button>
      </div>

      <div class="progress-advisor-grid">
        <div class="progress-gauge-card primary">
          <div class="progress-gauge" style="--gauge:${suggestedAngle}deg">
            <strong>${progress.suggested}%</strong>
            <span>แนะนำ</span>
          </div>
          <div>
            <p class="progress-gauge-title">ระบบแนะนำ</p>
            <p class="progress-gauge-copy">ค่าที่ควรใช้จากข้อมูลประกอบปัจจุบัน</p>
          </div>
        </div>

        <div class="progress-gauge-card">
          <div class="progress-gauge manual" style="--gauge:${manualAngle}deg">
            <strong>${progress.manual}%</strong>
            <span>บันทึก</span>
          </div>
          <div>
            <p class="progress-gauge-title">บันทึกไว้</p>
            <p class="progress-gauge-copy">${gapText}</p>
          </div>
        </div>

        <div class="progress-gauge-card">
          <div class="progress-gauge readiness" style="--gauge:${readinessAngle}deg">
            <strong>${progress.readinessScore}%</strong>
            <span>พร้อม</span>
          </div>
          <div>
            <p class="progress-gauge-title">ความพร้อมข้อมูล</p>
            <p class="progress-gauge-copy">${readinessComplete ? 'ข้อมูลครบทุกหัวข้อสำคัญ' : 'ยังมีข้อมูลหลักที่ควรเติม'}</p>
          </div>
        </div>
      </div>

      <div class="progress-comparison">
        <div class="progress-rail-label">
          <span>Manual</span>
          <strong>${progress.manual}%</strong>
        </div>
        <div class="progress-rail">
          <span class="manual" style="width:${progress.manual}%"></span>
          <em class="suggested" style="left:${progress.suggested}%"></em>
        </div>
        <div class="progress-rail-label">
          <span>Suggested</span>
          <strong>${progress.suggested}%</strong>
        </div>
      </div>

      <div class="progress-advisor-bottom">
        <div class="progress-components">
          ${componentRows.map(item => `
            <div class="progress-component ${item.tone}">
              <span><i class="fa-solid ${item.icon}"></i></span>
              <div>
                <div class="progress-component-label"><strong>${item.label}</strong><b>${item.value}%</b></div>
                <div class="progress-component-bar"><i style="width:${item.value}%"></i></div>
              </div>
            </div>`).join('')}
        </div>
        <div class="progress-gap-card ${gapTone}">
          <span>${progress.gap > 0 ? '+' : ''}${progress.gap}%</span>
          <strong>ส่วนต่างจากค่าแนะนำ</strong>
          <p>${recommendationText}</p>
        </div>
      </div>
    </section>`;

  document.getElementById('apply-progress-recommendation')?.addEventListener('click', () => {
    const input = document.getElementById('input-proj-progress');
    const display = document.getElementById('progress-val-display');
    if (input) input.value = progress.suggested;
    if (display) display.textContent = `${progress.suggested}%`;
    project.progress = progress.suggested;
    renderProgressAdvisorPanel(project);
    renderProjectInfoVisualPanel(project);
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

export async function showCourseManagement() {
  if (!hasPermission('courses')) { _noAccess('Course Management'); return; }
  hideAllViews();
  setHeader('บริหารหลักสูตร');
  document.getElementById('view-course-management')?.classList.remove('hidden');
  updateNavActive('nav-courses');
  if (!state.projects.length) await loadProjects();
  renderCourseManagement();
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
      // ถ้ามาจาก proxy (code = AUTH_EXPIRED) gas.js แจ้ง + เคลียร์ session ให้แล้ว
      // แจ้งซ้ำจะกลายเป็นกล่องที่สองทับกล่องแรก
      if (e?.code !== gas.AUTH_EXPIRED) {
        Swal.fire({
          icon: 'info',
          title: 'Session หมดอายุ',
          text: 'กรุณาเข้าสู่ระบบใหม่',
          confirmButtonColor: '#1e3a8a'
        });
        clearClientSession();
      }
      return;
    }
    gas.notifyApiError('โหลดข้อมูลล้มเหลว', e);
    return;
  }
  Swal.close();
  renderDashboardStats();
  renderProjectTable();
  renderCourseManagement();
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
  renderCourseManagement();

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

function getCourseManagementFilter() {
  if (!state.courseManagementFilter) {
    state.courseManagementFilter = { q: '', status: 'all', year: 'all', health: 'all' };
  }
  return state.courseManagementFilter;
}

export function setCourseManagementFilter(field, value) {
  const filter = getCourseManagementFilter();
  filter[field] = String(value || '').trim();
  renderCourseManagement();
}

export function resetCourseManagementFilters() {
  state.courseManagementFilter = { q: '', status: 'all', year: 'all', health: 'all' };
  ['course-management-search', 'course-management-status', 'course-management-health', 'course-management-year'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = id === 'course-management-search' ? '' : 'all';
  });
  renderCourseManagement();
}

function getCourseManagementProjects() {
  const filter = getCourseManagementFilter();
  const q = String(filter.q || '').toLowerCase();
  return state.projects.filter(project => {
    const health = getProjectHealthInsight(project);
    const status = normalizeProjectStatus(project.status);
    const matchesQuery = !q || [
      project.name,
      project.id,
      project.category,
      project.year,
      project.status,
      project.projectManager,
      project.sponsor
    ].some(value => String(value || '').toLowerCase().includes(q));
    const matchesStatus = filter.status === 'all' || status === filter.status;
    const matchesYear = filter.year === 'all' || String(project.year || '') === filter.year;
    const matchesHealth = filter.health === 'all' || health.level === filter.health;
    return matchesQuery && matchesStatus && matchesYear && matchesHealth;
  });
}

function syncCourseManagementControls() {
  const filter = getCourseManagementFilter();
  const search = document.getElementById('course-management-search');
  const status = document.getElementById('course-management-status');
  const health = document.getElementById('course-management-health');
  const year = document.getElementById('course-management-year');
  if (search) search.value = filter.q || '';
  if (status) status.value = filter.status || 'all';
  if (health) health.value = filter.health || 'all';
  if (year) {
    const years = [...new Set(state.projects.map(project => String(project.year || '').trim()).filter(Boolean))]
      .sort((a, b) => b.localeCompare(a, 'th'));
    year.innerHTML = '<option value="all">ทุกปีงบประมาณ</option>' +
      years.map(item => `<option value="${escapeHTML(item)}">${escapeHTML(item)}</option>`).join('');
    year.value = years.includes(filter.year) ? filter.year : 'all';
    if (!years.includes(filter.year)) filter.year = 'all';
  }
}

function renderCourseManagementInsights(projects) {
  const panel = document.getElementById('course-management-insights');
  if (!panel) return;
  const all = state.projects;
  const healthItems = all.map(project => ({ project, health: getProjectHealthInsight(project) }));
  const offTrack = healthItems.filter(item => item.health.level === 'off-track').length;
  const atRisk = healthItems.filter(item => item.health.level === 'at-risk').length;
  const active = all.filter(project => normalizeProjectStatus(project.status) === 'ดำเนินการ').length;
  const totalBudget = all.reduce((sum, project) => sum + Number(project.budget || 0), 0);
  const totalExpense = all.reduce((sum, project) => sum + getBudgetUsage(project).expense, 0);
  const budgetPct = totalBudget > 0 ? Math.round((totalExpense / totalBudget) * 100) : 0;
  const totalTasks = all.reduce((sum, project) => sum + (project.tasks?.length || 0), 0);
  const doneTasks = all.reduce((sum, project) => sum + (project.tasks?.filter(task => task.status === 'done').length || 0), 0);
  const taskPct = totalTasks ? Math.round((doneTasks / totalTasks) * 100) : 0;
  const focusItems = healthItems
    .filter(item => item.health.reasons.length)
    .sort((a, b) => {
      const rank = { 'off-track': 0, 'at-risk': 1, 'on-track': 2 };
      return rank[a.health.level] - rank[b.health.level];
    })
    .slice(0, 4);
  const decisionScore = all.length
    ? Math.round(
        ((all.length - offTrack) / all.length) * 42 +
        (active / all.length) * 18 +
        Math.max(0, 100 - Math.max(0, budgetPct - 82) * 3) * .22 +
        taskPct * .18
      )
    : 0;
  const decisionTone = decisionScore >= 78 ? 'good' : decisionScore >= 55 ? 'watch' : 'risk';

  panel.innerHTML = `
    <section class="course-command-panel ${decisionTone}">
      <div class="course-command-main">
        <div class="course-command-score">
          <div class="course-command-gauge" style="--gauge:${Math.min(decisionScore, 100) * 3.6}deg">
            <strong>${decisionScore}</strong>
            <span>Control</span>
          </div>
          <div>
            <h3>${decisionTone === 'good' ? 'พอร์ตหลักสูตรอยู่ในเกณฑ์ควบคุมได้' : decisionTone === 'watch' ? 'ควรเร่งปิดช่องว่างบางหลักสูตร' : 'มีหลายหลักสูตรที่ต้องจัดการก่อนเดินหน้าต่อ'}</h3>
            <p>แสดง ${projects.length} จาก ${all.length} หลักสูตร ตามตัวกรองปัจจุบัน</p>
          </div>
        </div>
        <div class="course-command-kpis">
          <div><span>ทั้งหมด</span><strong>${all.length}</strong></div>
          <div><span>ดำเนินการ</span><strong>${active}</strong></div>
          <div><span>เสี่ยง</span><strong>${atRisk + offTrack}</strong></div>
          <div><span>งานเสร็จ</span><strong>${taskPct}%</strong></div>
        </div>
      </div>
      <div class="course-command-side">
        <div class="course-mini-bars">
          <div><span>ใช้งบ</span><b>${budgetPct}%</b><i><em style="width:${Math.min(budgetPct, 100)}%"></em></i></div>
          <div><span>งานเสร็จ</span><b>${taskPct}%</b><i><em style="width:${taskPct}%"></em></i></div>
          <div><span>สุขภาพดี</span><b>${all.length ? Math.round(((all.length - atRisk - offTrack) / all.length) * 100) : 0}%</b><i><em style="width:${all.length ? Math.round(((all.length - atRisk - offTrack) / all.length) * 100) : 0}%"></em></i></div>
        </div>
        <div class="course-focus-list">
          ${focusItems.length ? focusItems.map(({ project, health }) => `
            <button type="button" onclick="app.openProject('${escapeJsAttr(project.id)}')">
              <span class="${health.tone}"><i class="fa-solid ${health.icon}"></i></span>
              <strong>${escapeHTML(project.name || project.id)}</strong>
              <small>${escapeHTML(health.reasons[0] || 'ควรติดตาม')}</small>
            </button>`).join('') : '<p>ยังไม่มีหลักสูตรที่ต้องเร่งติดตาม</p>'}
        </div>
      </div>
    </section>`;
}

function renderCourseManagementCards(projects) {
  const list = document.getElementById('course-management-card-list');
  if (!list) return;
  if (!projects.length) {
    list.innerHTML = '<p class="course-management-empty">ไม่พบหลักสูตรตามตัวกรองปัจจุบัน</p>';
    return;
  }
  list.innerHTML = projects.map(project => {
    const statusMeta = getProjectStatusMeta(project.status);
    const health = getProjectHealthInsight(project);
    const readiness = getProjectReadiness(project);
    const tasks = getTaskStats(project);
    const budget = getBudgetUsage(project);
    return `
      <article class="course-management-card" onclick="app.openProject('${escapeJsAttr(project.id)}')" role="button" tabindex="0">
        <div class="course-management-card-head">
          <div>
            <strong>${escapeHTML(project.name || project.id)}</strong>
            <span>${escapeHTML(project.id)} • ปี ${escapeHTML(project.year || '-')} • ${escapeHTML(project.category || '-')}</span>
          </div>
          <span class="status-badge ${statusMeta.className}">${escapeHTML(statusMeta.label)}</span>
        </div>
        <div class="course-management-card-metrics">
          <div><span>พร้อม</span><b>${readiness.score}%</b></div>
          <div><span>งาน</span><b>${tasks.done}/${tasks.total}</b></div>
          <div><span>ใช้งบ</span><b>${budget.pct}%</b></div>
        </div>
        <div class="course-management-card-actions">
          ${renderHealthBadge(project, true)}
          <button type="button" aria-label="เปิดแก้ไขหลักสูตร ${escapeHTML(project.name || project.id)}" onclick="event.stopPropagation(); app.openProject('${escapeJsAttr(project.id)}')"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i></button>
          <button type="button" aria-label="ลบหลักสูตร ${escapeHTML(project.name || project.id)}" onclick="event.stopPropagation(); app.deleteProject('${escapeJsAttr(project.id)}')"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>
        </div>
      </article>`;
  }).join('');
}

function renderCourseManagementTable(projects) {
  const tbody = document.getElementById('course-management-table-body');
  if (!tbody) return;
  if (!projects.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="course-management-empty">ไม่พบหลักสูตรตามตัวกรองปัจจุบัน</td></tr>`;
    return;
  }
  tbody.innerHTML = projects.map(project => {
    const statusMeta = getProjectStatusMeta(project.status);
    const readiness = getProjectReadiness(project);
    const tasks = getTaskStats(project);
    const budget = getBudgetUsage(project);
    return `
      <tr onclick="app.openProject('${escapeJsAttr(project.id)}')">
        <td>
          <div class="course-row-title">
            <strong>${escapeHTML(project.name || project.id)}</strong>
            <span>${escapeHTML(project.id)} • ปี ${escapeHTML(project.year || '-')} • ${escapeHTML(project.category || '-')}</span>
          </div>
        </td>
        <td class="text-center"><span class="status-badge ${statusMeta.className}">${escapeHTML(statusMeta.label)}</span></td>
        <td class="text-center">${renderHealthBadge(project, true)}</td>
        <td class="text-center">
          <div class="course-mini-progress"><span style="width:${readiness.score}%"></span></div>
          <b class="course-table-percent">${readiness.score}%</b>
        </td>
        <td class="text-center"><span class="course-table-pill">${tasks.done}/${tasks.total}</span></td>
        <td class="text-right">
          <strong class="course-budget-text">${formatCurrency(project.budget)}</strong>
          <small>${budget.pct}% used</small>
        </td>
        <td class="text-center">
          <div class="course-row-actions">
            <button type="button" onclick="event.stopPropagation(); app.openProject('${escapeJsAttr(project.id)}')" title="แก้ไขหลักสูตร"><i class="fa-solid fa-pen-to-square"></i></button>
            <button type="button" onclick="event.stopPropagation(); app.deleteProject('${escapeJsAttr(project.id)}')" title="ลบหลักสูตร"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

function renderCourseManagement() {
  if (!document.getElementById('view-course-management')) return;
  syncCourseManagementControls();
  const projects = getCourseManagementProjects();
  renderCourseManagementInsights(projects);
  renderCourseManagementCards(projects);
  renderCourseManagementTable(projects);
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
      <div class="mobile-list-card" onclick="app.openProject('${escapeJsAttr(p.id)}')" role="button" tabindex="0"
           onkeydown="if(event.key==='Enter')app.openProject('${escapeJsAttr(p.id)}')">
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
            <button type="button" onclick="event.stopPropagation(); app.openProject('${escapeJsAttr(p.id)}')" class="w-9 h-9 inline-flex items-center justify-center rounded-xl bg-blue-50 text-blue-700 active:bg-blue-100 transition" aria-label="แก้ไขหลักสูตร">
              <i class="fa-solid fa-pen-to-square text-xs"></i>
            </button>
            <button type="button" onclick="event.stopPropagation(); app.deleteProject('${escapeJsAttr(p.id)}')" class="w-9 h-9 inline-flex items-center justify-center rounded-xl bg-rose-50 text-rose-600 active:bg-rose-100 transition" aria-label="ลบหลักสูตร">
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
          <button type="button" onclick="event.stopPropagation(); app.openProject('${escapeJsAttr(p.id)}')" class="w-9 h-9 inline-flex items-center justify-center rounded-xl bg-blue-50 text-blue-700 hover:bg-blue-100 transition" title="แก้ไขหลักสูตร">
            <i class="fa-solid fa-pen-to-square text-xs"></i>
          </button>
          <button type="button" onclick="event.stopPropagation(); app.deleteProject('${escapeJsAttr(p.id)}')" class="w-9 h-9 inline-flex items-center justify-center rounded-xl bg-rose-50 text-rose-600 hover:bg-rose-100 transition" title="ลบหลักสูตร">
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
  bindProjectInfoPreview();
  renderProjectInfoVisualPanel(p);
  renderProgressPanel(p);
  renderGovernancePanel(p);
  renderDocsTable();
  renderFiscalCalendar();
  renderBudgetLedger();
  renderAccounting(p);
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
  renderProjectInfoVisualPanel(state.currentProject);
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
  renderProjectInfoVisualPanel(p);

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
    gas.notifyApiError('บันทึกล้มเหลว', e);
  }
}

export async function deleteProject(projectId = state.currentProject?.id) {
  const project = state.projects.find(p => String(p.id) === String(projectId));
  if (!project) return;
  const returnToCourseManagement = !document.getElementById('view-course-management')?.classList.contains('hidden');

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
    if (returnToCourseManagement) {
      renderDashboardStats();
      renderProjectTable();
      renderCourseManagement();
    } else {
      showDashboard();
    }
  } catch (e) {
    gas.notifyApiError('ลบหลักสูตรไม่สำเร็จ', e);
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
  if (status) status.innerHTML = `<span class="text-blue-600 font-bold animate-pulse">Uploading ${escapeHTML(f.name)}...</span>`;
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const data = e.target.result.split(',')[1];
      const url = await gas.uploadFile(data, f.name);
      state.currentProject.docs ||= [];
      state.currentProject.docs.push({ name: f.name, date: new Date().toISOString().split('T')[0], url });
      if (status) status.innerHTML = `<span class="text-blue-600 font-bold animate-pulse">Saving ${escapeHTML(f.name)}...</span>`;
      await gas.saveProject(state.currentProject);
      if (inp) inp.value = '';
      if (status) status.innerHTML = `<span class="text-emerald-500 font-bold">Success!</span>`;
      setTimeout(() => { if (status) status.innerHTML = ''; }, 3000);
      renderDocsTable();
    } catch (err) {
      if (status) status.innerHTML = `<span class="text-red-500 font-bold">${escapeHTML(err.message)}</span>`;
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
      gas.notifyApiError('ลบล้มเหลว', err);
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
      <tr class="hover:bg-slate-50 cursor-pointer" onclick="app.openProject('${escapeJsAttr(p.id)}')" title="${escapeHTML(tooltip)} — คลิกเพื่อเปิดหลักสูตร">
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
let _lastDragEndAt = 0;
let _kanbanView = 'board';
let _kanbanGanttScale = 'auto';
const KANBAN_SORT_OPTIONS = [
  { id: 'manual', label: 'ลำดับที่จัดไว้' },
  { id: 'risk', label: 'ความเสี่ยงก่อน' },
  { id: 'priority', label: 'ความสำคัญสูงก่อน' },
  { id: 'due', label: 'กำหนดส่งใกล้ก่อน' },
  { id: 'progress', label: 'ความคืบหน้ามากก่อน' },
  { id: 'updated', label: 'อัปเดตล่าสุด' },
  { id: 'title', label: 'ชื่องาน ก–ฮ' },
];
const _kanbanColumnSort = {
  todo: 'manual',
  doing: 'manual',
  review: 'manual',
  done: 'manual',
};
const _kanbanFilters = {
  q: '',
  status: 'all',
  category: 'all',
  priority: 'all',
  due: 'all',
  risk: 'all',
};

const KANBAN_COLS = [
  { id: 'todo',   label: 'แผนงาน',          shortLabel: 'Plan',    icon: 'fa-inbox',         wipLimit: null, bg: 'bg-slate-50',   border: 'border-slate-200',   countBg: 'bg-slate-100 text-slate-600',     addColor: 'text-slate-500' },
  { id: 'doing',  label: 'กำลังดำเนินการ',  shortLabel: 'Execute', icon: 'fa-spinner',       wipLimit: 5,    bg: 'bg-blue-50',    border: 'border-blue-200',    countBg: 'bg-blue-100 text-blue-700',       addColor: 'text-blue-500' },
  { id: 'review', label: 'ตรวจรับ / ทบทวน', shortLabel: 'Review',  icon: 'fa-clipboard-check', wipLimit: 3,  bg: 'bg-violet-50',  border: 'border-violet-200',  countBg: 'bg-violet-100 text-violet-700',   addColor: 'text-violet-500' },
  { id: 'done',   label: 'เสร็จสมบูรณ์',     shortLabel: 'Done',    icon: 'fa-circle-check',   wipLimit: null, bg: 'bg-emerald-50', border: 'border-emerald-200', countBg: 'bg-emerald-100 text-emerald-700', addColor: 'text-emerald-500' },
];

const PRIORITY_CFG = {
  high:   { label: 'สูง',  cls: 'bg-rose-50 text-rose-600',   dot: 'bg-rose-500' },
  medium: { label: 'กลาง', cls: 'bg-amber-50 text-amber-600', dot: 'bg-amber-400' },
  low:    { label: 'ต่ำ',  cls: 'bg-slate-100 text-slate-500', dot: 'bg-slate-400' },
};

const KANBAN_CATEGORY_CFG = {
  academic:   { label: 'วิชาการ', cls: 'bg-blue-50 text-blue-700', icon: 'fa-book-open' },
  instructor: { label: 'วิทยากร', cls: 'bg-violet-50 text-violet-700', icon: 'fa-chalkboard-user' },
  logistics:  { label: 'สถานที่/อุปกรณ์', cls: 'bg-cyan-50 text-cyan-700', icon: 'fa-boxes-stacked' },
  document:   { label: 'เอกสาร', cls: 'bg-slate-100 text-slate-600', icon: 'fa-file-lines' },
  budget:     { label: 'งบประมาณ', cls: 'bg-emerald-50 text-emerald-700', icon: 'fa-coins' },
  evaluation: { label: 'ประเมินผล', cls: 'bg-fuchsia-50 text-fuchsia-700', icon: 'fa-chart-line' },
};

function _getKanbanDueDays(task) {
  if (!task.dueDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(task.dueDate);
  due.setHours(0, 0, 0, 0);
  return Math.round((due - today) / 86400000);
}

function _isKanbanTaskOverdue(task) {
  const days = _getKanbanDueDays(task);
  return days !== null && days < 0 && task.status !== 'done';
}

function _getKanbanDependency(task) {
  if (!task?.dependsOn) return { task: null, missing: false, incomplete: false };
  const dependency = state.currentProject?.tasks?.find(item => item.id === task.dependsOn) || null;
  return {
    task: dependency,
    missing: !dependency,
    incomplete: Boolean(dependency && dependency.status !== 'done'),
  };
}

function _isKanbanTaskBlocked(task) {
  if (!task || task.status === 'done') return false;
  const dependency = _getKanbanDependency(task);
  return Boolean(task.blocked || dependency.missing || dependency.incomplete);
}

function _getKanbanTaskProgress(task) {
  if (task.status === 'done') return 100;
  const subtasks = _normalizeSubtasks(task);
  if (subtasks.length) return Math.round((subtasks.filter(item => item.done).length / subtasks.length) * 100);
  if (task.status === 'review') return 80;
  if (task.status === 'doing') return 35;
  return 0;
}

function _sortKanbanColumnTasks(tasks, status) {
  const sortBy = _kanbanColumnSort[status] || 'manual';
  if (sortBy === 'manual') return tasks;

  const priorityRank = { high: 0, medium: 1, low: 2 };
  const dueValue = task => {
    if (!task.dueDate) return Number.POSITIVE_INFINITY;
    const value = new Date(task.dueDate).getTime();
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  };
  const updatedValue = task => {
    const value = new Date(task.updatedAt || task.createdAt || 0).getTime();
    return Number.isFinite(value) ? value : 0;
  };
  const riskRank = task => {
    if (_isKanbanTaskBlocked(task)) return 0;
    if (_isKanbanTaskOverdue(task)) return 1;
    return 2;
  };

  return tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => {
      let result = 0;
      if (sortBy === 'risk') {
        result = riskRank(a.task) - riskRank(b.task)
          || (priorityRank[a.task.priority || 'medium'] ?? 1) - (priorityRank[b.task.priority || 'medium'] ?? 1)
          || dueValue(a.task) - dueValue(b.task);
      } else if (sortBy === 'priority') {
        result = (priorityRank[a.task.priority || 'medium'] ?? 1) - (priorityRank[b.task.priority || 'medium'] ?? 1)
          || dueValue(a.task) - dueValue(b.task);
      } else if (sortBy === 'due') {
        result = dueValue(a.task) - dueValue(b.task);
      } else if (sortBy === 'progress') {
        result = _getKanbanTaskProgress(b.task) - _getKanbanTaskProgress(a.task);
      } else if (sortBy === 'updated') {
        result = updatedValue(b.task) - updatedValue(a.task);
      } else if (sortBy === 'title') {
        result = String(a.task.title || '').localeCompare(String(b.task.title || ''), 'th', { numeric: true, sensitivity: 'base' });
      }
      return result || a.index - b.index;
    })
    .map(item => item.task);
}

function _matchesKanbanFilters(task) {
  const query = _kanbanFilters.q.trim().toLowerCase();
  const searchable = [task.title, task.description, task.assignee]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (query && !searchable.includes(query)) return false;
  if (_kanbanFilters.status !== 'all' && (task.status || 'todo') !== _kanbanFilters.status) return false;
  if (_kanbanFilters.category !== 'all' && (task.category || 'academic') !== _kanbanFilters.category) return false;
  if (_kanbanFilters.priority !== 'all' && (task.priority || 'medium') !== _kanbanFilters.priority) return false;
  if (_kanbanFilters.due === 'overdue' && !_isKanbanTaskOverdue(task)) return false;
  if (_kanbanFilters.due === 'upcoming' && (_isKanbanTaskOverdue(task) || !task.dueDate)) return false;
  if (_kanbanFilters.risk === 'blocked' && !_isKanbanTaskBlocked(task)) return false;
  if (_kanbanFilters.risk === 'unowned' && (task.assignee || task.status === 'done')) return false;
  if (_kanbanFilters.risk === 'unscheduled' && (task.dueDate || task.status === 'done')) return false;

  return true;
}

function _hasActiveKanbanFilters() {
  return Boolean(
    _kanbanFilters.q.trim() ||
    _kanbanFilters.status !== 'all' ||
    _kanbanFilters.category !== 'all' ||
    _kanbanFilters.priority !== 'all' ||
    _kanbanFilters.due !== 'all' ||
    _kanbanFilters.risk !== 'all'
  );
}

function _kanbanOption(value, label, selectedValue) {
  return `<option value="${value}" ${selectedValue === value ? 'selected' : ''}>${label}</option>`;
}

function _pct(part, total) {
  return total ? Math.round((part / total) * 100) : 0;
}

function _barWidth(value, max) {
  if (value <= 0 || !max) return 0;
  return Math.max(4, Math.round((value / max) * 100));
}

function _getKanbanAnalytics(tasks) {
  const total = tasks.length;
  const done = tasks.filter(t => t.status === 'done').length;
  const doing = tasks.filter(t => t.status === 'doing').length;
  const review = tasks.filter(t => t.status === 'review').length;
  const todo = tasks.filter(t => t.status === 'todo').length;
  const active = total - done;
  const overdue = tasks.filter(_isKanbanTaskOverdue).length;
  const blocked = tasks.filter(_isKanbanTaskBlocked).length;
  const dueSoon = tasks.filter(t => {
    const days = _getKanbanDueDays(t);
    return days !== null && days >= 0 && days <= 7 && t.status !== 'done';
  }).length;
  const highActive = tasks.filter(t => t.priority === 'high' && t.status !== 'done').length;
  const unscheduled = tasks.filter(t => !t.dueDate && t.status !== 'done').length;
  const unowned = tasks.filter(t => !t.assignee && t.status !== 'done').length;
  const readyForReview = tasks.filter(t => t.status === 'review' && !_isKanbanTaskBlocked(t)).length;
  const wipBreaches = KANBAN_COLS.filter(col => col.wipLimit && tasks.filter(t => t.status === col.id).length > col.wipLimit);
  const progress = _pct(done, total);
  const planQuality = _pct(tasks.filter(t => t.assignee && t.dueDate).length, total);
  const riskScore = overdue * 3 + blocked * 3 + highActive * 2 + dueSoon + unowned + wipBreaches.length * 2;
  const riskPenalty = total
    ? Math.min(100, Math.round(((overdue * 24) + (blocked * 28) + (unowned * 8) + (unscheduled * 6) + (wipBreaches.length * 12)) / total))
    : 0;
  const deliveryConfidence = total
    ? Math.max(0, Math.min(100, Math.round((progress * .35) + (planQuality * .25) + ((100 - riskPenalty) * .4))))
    : 0;
  const statusLevel = !total
    ? 'empty'
    : riskScore >= 9
      ? 'danger'
      : riskScore >= 4
        ? 'watch'
        : 'healthy';

  const categoryRows = Object.entries(KANBAN_CATEGORY_CFG).map(([id, cfg]) => {
    const categoryTasks = tasks.filter(t => (t.category || 'academic') === id);
    const categoryDone = categoryTasks.filter(t => t.status === 'done').length;
    return {
      id,
      ...cfg,
      total: categoryTasks.length,
      active: categoryTasks.length - categoryDone,
      done: categoryDone,
      overdue: categoryTasks.filter(_isKanbanTaskOverdue).length,
      high: categoryTasks.filter(t => t.priority === 'high' && t.status !== 'done').length,
      progress: _pct(categoryDone, categoryTasks.length),
    };
  }).filter(row => row.total > 0)
    .sort((a, b) => b.active - a.active || b.overdue - a.overdue || b.total - a.total);

  const maxCategoryLoad = Math.max(1, ...categoryRows.map(row => row.active));
  const statusRows = KANBAN_COLS.map(col => ({
    ...col,
    total: tasks.filter(t => t.status === col.id).length,
  }));

  const recommendation = !total
    ? 'เริ่มจากเพิ่มงานสำคัญ 3-5 รายการเพื่อเห็นภาพความคืบหน้า'
    : blocked
      ? `ปลด Blocker และ Dependency ที่ค้าง ${blocked} รายการก่อนรับงานใหม่เข้าสู่ WIP`
      : overdue
      ? `ควรปิดหรือต่อรองกำหนดงานเกินกำหนด ${overdue} รายการก่อน`
      : wipBreaches.length
        ? `ลดงานระหว่างทำใน ${wipBreaches.map(col => col.label).join(', ')} ให้ไม่เกิน WIP limit`
      : highActive
        ? `โฟกัสงานสำคัญสูงที่ยังไม่ปิด ${highActive} รายการ`
        : dueSoon
          ? `ติดตามงานที่ครบกำหนดใน 7 วัน ${dueSoon} รายการ`
          : 'สถานะโดยรวมดี ใช้เวลาตรวจคอขวดในคอลัมน์กำลังดำเนินการ';

  return {
    total, done, doing, review, todo, active, overdue, blocked, dueSoon, highActive,
    unscheduled, unowned, readyForReview, wipBreaches, progress, planQuality,
    riskScore, riskPenalty, deliveryConfidence, statusLevel, categoryRows, maxCategoryLoad, statusRows, recommendation,
  };
}

function _getKanbanAlertItems(tasks) {
  return tasks
    .map(task => ({ task, blocked: _isKanbanTaskBlocked(task), overdue: _isKanbanTaskOverdue(task) }))
    .filter(item => item.blocked || item.overdue)
    .sort((a, b) => {
      const rank = item => (item.blocked && item.overdue) ? 0 : item.blocked ? 1 : 2;
      const dueRank = item => _getKanbanDueDays(item.task) ?? 999;
      return rank(a) - rank(b) || dueRank(a) - dueRank(b);
    });
}

function _renderKanbanAlertRow({ task, blocked, overdue }) {
  const cfg = KANBAN_CATEGORY_CFG[task.category || 'academic'];
  const dependency = _getKanbanDependency(task);
  const reason = blocked
    ? (task.blockerReason || (dependency.missing
        ? 'Dependency ไม่พบ'
        : dependency.incomplete
          ? `รอ: ${dependency.task.title}`
          : 'ติด Blocker'))
    : '';
  return `
    <button type="button" class="kanban-alert-row" onclick="app.editKanbanTask('${escapeJsAttr(task.id)}')">
      <span class="kanban-alert-icons">
        ${blocked ? '<i class="fa-solid fa-ban" title="ติด Blocker"></i>' : ''}
        ${overdue ? '<i class="fa-solid fa-clock-rotate-left" title="เกินกำหนด"></i>' : ''}
      </span>
      <span class="kanban-alert-body">
        <strong>${escapeHTML(task.title || 'งานไม่มีชื่อ')}</strong>
        <span class="kanban-alert-meta">
          ${cfg ? `<em>${escapeHTML(cfg.label)}</em>` : ''}
          <em class="${task.assignee ? '' : 'text-rose-500'}">${escapeHTML(task.assignee || 'ไม่มีเจ้าของ')}</em>
        </span>
        ${reason ? `<span class="kanban-alert-reason">${escapeHTML(reason)}</span>` : ''}
      </span>
      ${_kanbanDueChip(task)}
    </button>`;
}

function _renderKanbanAlertList(items) {
  if (!items.length) return `<div class="kanban-insight-empty">ไม่มีงานเกินกำหนดหรือติด Blocker ในตอนนี้</div>`;
  return `<div class="kanban-alert-list">${items.map(_renderKanbanAlertRow).join('')}</div>`;
}

function _renderKanbanProgressBar(value, cls = '') {
  return `
    <div class="kanban-progress-track ${cls}">
      <span style="width:${Math.min(100, Math.max(0, value))}%"></span>
    </div>`;
}

function _renderKanbanInsights(tasks) {
  const data = _getKanbanAnalytics(tasks);
  const statusText = {
    empty: 'ยังไม่มีข้อมูล',
    healthy: 'ควบคุมได้',
    watch: 'ควรเฝ้าระวัง',
    danger: 'ต้องเร่งตัดสินใจ',
  }[data.statusLevel];
  const statusIcon = {
    empty: 'fa-seedling',
    healthy: 'fa-circle-check',
    watch: 'fa-triangle-exclamation',
    danger: 'fa-circle-exclamation',
  }[data.statusLevel] || 'fa-chart-line';
  const categoryRows = data.categoryRows.length
    ? data.categoryRows.slice(0, 6).map(row => `
        <div class="kanban-load-row">
          <div class="kanban-load-label">
            <span class="${row.cls}"><i class="fa-solid ${row.icon}"></i></span>
            <strong>${row.label}</strong>
          </div>
          <div class="kanban-load-meter">
            <span style="width:${_barWidth(row.active, data.maxCategoryLoad)}%"></span>
          </div>
          <div class="kanban-load-metrics">
            <em>${row.active} เปิด</em>
            ${row.overdue ? `<b class="text-rose-600">${row.overdue} เกิน</b>` : ''}
          </div>
        </div>`).join('')
    : `<div class="kanban-insight-empty">ยังไม่มี workload ตามหมวดหมู่</div>`;
  const action = data.blocked
    ? { label: 'ดู Blocker', handler: "app.setKanbanFilter('risk','blocked')" }
    : data.overdue
      ? { label: 'ดูงานเกินกำหนด', handler: "app.setKanbanFilter('due','overdue')" }
      : data.wipBreaches.length
        ? { label: 'ดูงานระหว่างทำ', handler: "app.setKanbanFilter('status','doing')" }
        : data.unowned
          ? { label: 'ดูงานไม่มีเจ้าของ', handler: "app.setKanbanFilter('risk','unowned')" }
          : { label: 'ดูงานที่เปิดอยู่', handler: "app.setKanbanFilter('status','doing')" };
  const alertItems = _getKanbanAlertItems(tasks);

  return `
    <div class="kanban-insights">
      <section class="kanban-decision-card ${data.statusLevel}">
        <div class="kanban-decision-head">
          <span><i class="fa-solid ${statusIcon}"></i></span>
          <div>
            <p>Decision Pulse</p>
            <strong>${statusText}</strong>
          </div>
        </div>
        <div class="kanban-health-visual">
          <div class="kanban-health-gauge" style="--health-score:${data.deliveryConfidence}">
            <span>${data.deliveryConfidence}</span><small>/100</small>
          </div>
          <div class="kanban-health-copy">
            <strong>Delivery confidence</strong>
            <span>ส่งมอบ ${data.progress}% · แผนครบ ${data.planQuality}%</span>
          </div>
        </div>
        <div class="kanban-recommendation-row">
          <p class="kanban-recommendation">${data.recommendation}</p>
          <button type="button" onclick="${action.handler}">${action.label}<i class="fa-solid fa-arrow-right"></i></button>
        </div>
      </section>

      <section class="kanban-chart-card">
        <div class="kanban-chart-head">
          <strong>Flow สถานะ</strong>
          <span>${data.active} งานเปิด</span>
        </div>
        <div class="kanban-status-stack" aria-label="สัดส่วนสถานะงาน">
          ${data.statusRows.map(row => `<button type="button" class="${row.id}" style="width:${_pct(row.total, data.total)}%" title="กรอง ${row.label}: ${row.total}" onclick="app.setKanbanFilter('status','${row.id}')"></button>`).join('')}
        </div>
        <div class="kanban-status-legend">
          ${data.statusRows.map(row => `<button type="button" onclick="app.setKanbanFilter('status','${row.id}')"><i class="${row.id}"></i><span>${row.label}</span><b>${row.total}</b></button>`).join('')}
        </div>
      </section>

      <section class="kanban-chart-card">
        <div class="kanban-chart-head">
          <strong>Risk Radar</strong>
          <span>คะแนน ${data.riskScore}</span>
        </div>
        <div class="kanban-risk-grid">
          <button type="button" onclick="app.setKanbanFilter('risk','blocked')" class="${data.blocked ? 'is-danger' : ''}"><i class="fa-solid fa-ban"></i><strong>${data.blocked}</strong><span>ติด Blocker</span></button>
          <button type="button" onclick="app.setKanbanFilter('due','overdue')" class="${data.overdue ? 'is-danger' : ''}"><i class="fa-solid fa-clock-rotate-left"></i><strong>${data.overdue}</strong><span>เกินกำหนด</span></button>
          <button type="button" onclick="app.setKanbanFilter('status','review')"><i class="fa-solid fa-clipboard-check"></i><strong>${data.readyForReview}</strong><span>รอตรวจรับ</span></button>
          <button type="button" onclick="app.setKanbanFilter('risk','unowned')"><i class="fa-solid fa-user-slash"></i><strong>${data.unowned}</strong><span>ไม่มีเจ้าของ</span></button>
        </div>
      </section>

      <section class="kanban-chart-card kanban-workload-card">
        <div class="kanban-chart-head">
          <strong>Workload ตามหมวดหมู่</strong>
          <span>${data.categoryRows.length} หมวด</span>
        </div>
        <div class="kanban-load-list">${categoryRows}</div>
      </section>

      <section class="kanban-chart-card kanban-alert-card">
        <div class="kanban-chart-head">
          <strong>งานเกินกำหนด / ติด Blocker</strong>
          <span>${alertItems.length} รายการ</span>
        </div>
        ${_renderKanbanAlertList(alertItems)}
      </section>
    </div>`;
}

function _renderKanbanToolbar(allTasks, visibleTasks) {
  const doneCount = allTasks.filter(t => t.status === 'done').length;
  const overdueCount = allTasks.filter(_isKanbanTaskOverdue).length;
  const blockedCount = allTasks.filter(_isKanbanTaskBlocked).length;
  const doingCount = allTasks.filter(t => t.status === 'doing').length;
  const activeFilters = _hasActiveKanbanFilters();

  return `
    <div class="kanban-toolbar">
      <div class="kanban-toolbar-main">
        <div class="kanban-toolbar-title">
          <span class="kanban-toolbar-icon"><i class="fa-solid fa-list-check"></i></span>
          <div>
            <p class="font-black text-gray-800 text-sm">ภาพรวมงาน</p>
            <p class="text-xs text-gray-400">แสดง ${visibleTasks.length}/${allTasks.length} รายการ</p>
          </div>
        </div>
        <div class="kanban-summary">
          <span><strong>${allTasks.length}</strong> งานทั้งหมด</span>
          <span><strong>${doneCount}</strong> ส่งมอบแล้ว</span>
          <span class="${doingCount > 5 ? 'text-amber-700' : ''}"><strong>${doingCount}/5</strong> WIP</span>
          <span class="${blockedCount ? 'text-rose-600' : ''}"><strong>${blockedCount}</strong> Blocker</span>
          <span class="${overdueCount ? 'text-rose-600' : ''}"><strong>${overdueCount}</strong> เกินกำหนด</span>
        </div>
        <div class="kanban-view-switch" role="tablist" aria-label="เลือกมุมมอง">
          <button type="button" class="${_kanbanView === 'board' ? 'active' : ''}" onclick="app.setKanbanView('board')">
            <i class="fa-solid fa-table-columns"></i><span>บอร์ด</span>
          </button>
          <button type="button" class="${_kanbanView === 'gantt' ? 'active' : ''}" onclick="app.setKanbanView('gantt')">
            <i class="fa-solid fa-chart-gantt"></i><span>Gantt</span>
          </button>
        </div>
      </div>
      <div class="kanban-filters">
        <label class="kanban-search">
          <i class="fa-solid fa-magnifying-glass"></i>
          <input id="kanban-search-input" type="search" value="${escapeHTML(_kanbanFilters.q)}"
                 placeholder="ค้นหางาน ผู้รับผิดชอบ หรือรายละเอียด"
                 oninput="app.setKanbanFilter('q', this.value)">
        </label>
        <select class="kanban-filter-select" onchange="app.setKanbanFilter('status', this.value)" aria-label="กรองสถานะงาน">
          ${_kanbanOption('all', 'ทุกสถานะ', _kanbanFilters.status)}
          ${KANBAN_COLS.map(col => _kanbanOption(col.id, col.label, _kanbanFilters.status)).join('')}
        </select>
        <select class="kanban-filter-select" onchange="app.setKanbanFilter('category', this.value)" aria-label="กรองหมวดหมู่">
          ${_kanbanOption('all', 'ทุกหมวดหมู่', _kanbanFilters.category)}
          ${Object.entries(KANBAN_CATEGORY_CFG).map(([id, cfg]) => _kanbanOption(id, cfg.label, _kanbanFilters.category)).join('')}
        </select>
        <select class="kanban-filter-select" onchange="app.setKanbanFilter('priority', this.value)" aria-label="กรองความสำคัญ">
          ${_kanbanOption('all', 'ทุกความสำคัญ', _kanbanFilters.priority)}
          ${Object.entries(PRIORITY_CFG).map(([id, cfg]) => _kanbanOption(id, `สำคัญ${cfg.label}`, _kanbanFilters.priority)).join('')}
        </select>
        <select class="kanban-filter-select" onchange="app.setKanbanFilter('due', this.value)" aria-label="กรองกำหนดส่ง">
          ${_kanbanOption('all', 'ทุกกำหนดส่ง', _kanbanFilters.due)}
          ${_kanbanOption('overdue', 'เกินกำหนด', _kanbanFilters.due)}
          ${_kanbanOption('upcoming', 'มีกำหนดส่ง', _kanbanFilters.due)}
        </select>
        <select class="kanban-filter-select" onchange="app.setKanbanFilter('risk', this.value)" aria-label="กรองความเสี่ยงของงาน">
          ${_kanbanOption('all', 'ทุกความเสี่ยง', _kanbanFilters.risk)}
          ${_kanbanOption('blocked', 'ติด Blocker / Dependency', _kanbanFilters.risk)}
          ${_kanbanOption('unowned', 'ยังไม่มีผู้รับผิดชอบ', _kanbanFilters.risk)}
          ${_kanbanOption('unscheduled', 'ยังไม่กำหนดส่ง', _kanbanFilters.risk)}
        </select>
        <button type="button" onclick="app.resetKanbanFilters()" class="kanban-reset-btn" ${activeFilters ? '' : 'disabled'}>
          <i class="fa-solid fa-rotate-left"></i>
          <span>ล้างตัวกรอง</span>
        </button>
      </div>
      ${_renderKanbanInsights(visibleTasks)}
    </div>`;
}

function _placeKanbanTask(taskId, newStatus, beforeTaskId = null) {
  const tasks = state.currentProject?.tasks;
  if (!Array.isArray(tasks)) return false;

  const fromIndex = tasks.findIndex(t => t.id === taskId);
  if (fromIndex < 0) return false;

  const [task] = tasks.splice(fromIndex, 1);
  task.status = newStatus;
  task.updatedAt = new Date().toISOString();

  const beforeIndex = beforeTaskId
    ? tasks.findIndex(t => t.id === beforeTaskId)
    : -1;

  if (beforeIndex >= 0) tasks.splice(beforeIndex, 0, task);
  else tasks.push(task);

  return true;
}

async function _saveKanbanOrder(taskId, { beforeTaskId = null, reposition = false } = {}) {
  renderKanban(state.currentProject);
  renderDashboardStats();
  try { await gas.saveProject(state.currentProject); } catch {}
}

function _getKanbanDropTarget(column, pointerY) {
  const cards = [...column.querySelectorAll('.kanban-list > .kanban-card:not(.dragging)')];
  const target = cards.find(card => {
    const rect = card.getBoundingClientRect();
    return pointerY < rect.top + (rect.height / 2);
  });
  return target?.dataset.taskId || null;
}

function _clearKanbanDropMarkers() {
  document.querySelectorAll('.kanban-drop-marker').forEach(marker => marker.remove());
}

function _showKanbanDropMarker(column, beforeTaskId) {
  const list = column.querySelector('.kanban-list');
  if (!list) return;

  _clearKanbanDropMarkers();
  const marker = document.createElement('div');
  marker.className = 'kanban-drop-marker';

  const target = beforeTaskId ? list.querySelector(`[data-task-id="${CSS.escape(beforeTaskId)}"]`) : null;
  if (target) list.insertBefore(marker, target);
  else list.appendChild(marker);
}

function _kanbanDueChip(task) {
  if (!task.dueDate) return '';
  const days = _getKanbanDueDays(task);
  let label, cls, icon = 'fa-regular fa-calendar';
  if (task.status === 'done') {
    label = task.dueDate; cls = 'due-none';
  } else if (days < 0) {
    label = `เกิน ${Math.abs(days)} วัน`; cls = 'due-overdue'; icon = 'fa-solid fa-triangle-exclamation';
  } else if (days === 0) {
    label = 'ครบกำหนดวันนี้'; cls = 'due-soon'; icon = 'fa-solid fa-bell';
  } else if (days === 1) {
    label = 'พรุ่งนี้'; cls = 'due-soon';
  } else if (days <= 3) {
    label = `อีก ${days} วัน`; cls = 'due-soon';
  } else {
    label = `อีก ${days} วัน`; cls = 'due-none';
  }
  return `<span class="kanban-due-chip ${cls}" title="กำหนดเสร็จ ${escapeHTML(task.dueDate)}">
    <i class="${icon} text-[9px]"></i>${label}
  </span>`;
}

function _kanbanDependencyChip(task) {
  if (!task.dependsOn) return '';
  const dependency = _getKanbanDependency(task);
  const isReady = dependency.task?.status === 'done';
  const label = dependency.missing
    ? 'Dependency ไม่พบ'
    : `${isReady ? 'พร้อมเริ่ม' : 'รอ'}: ${dependency.task.title}`;
  return `<span class="kanban-dependency-chip ${isReady ? 'is-ready' : 'is-waiting'}"
                title="งานก่อนหน้า: ${escapeHTML(dependency.task?.title || 'ไม่พบงาน')}">
    <i class="fa-solid fa-link"></i>${escapeHTML(label)}
  </span>`;
}

function _normalizeSubtasks(task) {
  if (!Array.isArray(task.subtasks)) return [];
  return task.subtasks
    .map((subtask, index) => typeof subtask === 'string'
      ? { id: `${task.id}-sub-${index}`, title: subtask, done: false }
      : {
          id: subtask.id || `${task.id}-sub-${index}`,
          title: String(subtask.title || '').trim(),
          done: Boolean(subtask.done),
        })
    .filter(subtask => subtask.title);
}

function _renderKanbanSubtasks(task) {
  const subtasks = _normalizeSubtasks(task);
  if (!subtasks.length) return '';
  const completed = subtasks.filter(subtask => subtask.done).length;
  const progress = Math.round((completed / subtasks.length) * 100);
  return `
    <div class="kanban-subtasks" onclick="event.stopPropagation()">
      <div class="kanban-subtasks-head">
        <span><i class="fa-solid fa-list-check"></i> งานย่อย</span>
        <strong>${completed}/${subtasks.length}</strong>
      </div>
      <div class="kanban-subtasks-progress"><span style="width:${progress}%"></span></div>
      <div class="kanban-subtask-list">
        ${subtasks.map(subtask => `
          <button type="button" class="kanban-subtask ${subtask.done ? 'done' : ''}"
                  onclick="app.toggleKanbanSubtask('${escapeJsAttr(task.id)}','${escapeJsAttr(subtask.id)}')"
                  aria-pressed="${subtask.done}" title="${subtask.done ? 'ทำเครื่องหมายว่ายังไม่เสร็จ' : 'ทำเครื่องหมายว่าเสร็จแล้ว'}">
            <i class="fa-${subtask.done ? 'solid fa-circle-check' : 'regular fa-circle'}"></i>
            <span>${escapeHTML(subtask.title)}</span>
          </button>`).join('')}
      </div>
    </div>`;
}

function _taskCard(task) {
  const pri = PRIORITY_CFG[task.priority] || PRIORITY_CFG.medium;
  const cat = KANBAN_CATEGORY_CFG[task.category] || KANBAN_CATEGORY_CFG.academic;
  const isOverdue = _isKanbanTaskOverdue(task);
  const isBlocked = _isKanbanTaskBlocked(task);
  const progress = _getKanbanTaskProgress(task);
  const statusColorClass = isBlocked ? 'kanban-card-blocked' : isOverdue ? 'kanban-card-overdue' : `kanban-card-${task.status || 'todo'}`;
  const colIndex = KANBAN_COLS.findIndex(c => c.id === (task.status || 'todo'));
  const prevCol = KANBAN_COLS[colIndex - 1];
  const nextCol = KANBAN_COLS[colIndex + 1];
  return `
    <div class="kanban-card ${statusColorClass} kanban-pri-${task.priority || 'medium'}" draggable="true" data-task-id="${escapeHTML(task.id)}"
         onclick="app.onKanbanCardClick(event,'${escapeJsAttr(task.id)}')"
         ondragstart="app.onKanbanDragStart(event,'${escapeJsAttr(task.id)}')"
         ondragend="app.onKanbanDragEnd(event)">
      <div class="kanban-card-head">
        <p class="kanban-card-title">${escapeHTML(task.title)}</p>
        <details class="kanban-card-menu" onclick="event.stopPropagation()">
          <summary title="จัดการงาน" aria-label="เปิดเมนูจัดการงาน"><i class="fa-solid fa-ellipsis"></i></summary>
          <div class="kanban-card-menu-popover">
            <button type="button" onclick="app.editKanbanTask('${escapeJsAttr(task.id)}')">
              <i class="fa-solid fa-pen"></i><span>แก้ไขงาน</span>
            </button>
            <button type="button" onclick="app.duplicateKanbanTask('${escapeJsAttr(task.id)}')">
              <i class="fa-regular fa-copy"></i><span>ทำสำเนา</span>
            </button>
            <button type="button" class="is-delete" onclick="event.preventDefault();app.deleteKanbanTask('${escapeJsAttr(task.id)}')">
              <i class="fa-regular fa-trash-can"></i><span>ลบงาน</span>
            </button>
          </div>
        </details>
      </div>
      ${isBlocked ? `<div class="kanban-blocker-alert"><i class="fa-solid fa-ban"></i><span>${escapeHTML(task.blockerReason || 'รอปลด Blocker หรือ Dependency ก่อนดำเนินงานต่อ')}</span></div>` : ''}
      ${task.description ? `<p class="kanban-card-description">${escapeHTML(task.description)}</p>` : ''}
      <div class="kanban-card-progress" aria-label="ความคืบหน้า ${progress}%">
        <span style="width:${progress}%"></span><em>${progress}%</em>
      </div>
      ${_renderKanbanSubtasks(task)}
      <div class="flex items-center flex-wrap gap-1.5 mt-2">
        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-bold ${cat.cls}">
          <i class="fa-solid ${cat.icon} text-[9px]"></i>${cat.label}
        </span>
        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-bold ${pri.cls}">
          <span class="w-1.5 h-1.5 rounded-full ${pri.dot} inline-block"></span>${pri.label}
        </span>
        ${task.assignee
          ? `<span class="kanban-owner-chip"><i class="fa-solid fa-user"></i>${escapeHTML(task.assignee)}</span>`
          : task.status !== 'done' ? `<span class="kanban-owner-chip is-missing"><i class="fa-solid fa-user-plus"></i>ยังไม่มีเจ้าของ</span>` : ''}
        ${task.acceptanceCriteria ? `<span class="kanban-dod-chip" title="เกณฑ์ตรวจรับ: ${escapeHTML(task.acceptanceCriteria)}"><i class="fa-solid fa-clipboard-check"></i>มีเกณฑ์ตรวจรับ</span>` : ''}
        ${_kanbanDueChip(task)}
        ${_kanbanDependencyChip(task)}
      </div>
      <div class="kanban-card-footer">
        ${prevCol
          ? `<button type="button" onclick="event.stopPropagation();app.moveKanbanTask('${escapeJsAttr(task.id)}','${escapeJsAttr(prevCol.id)}')" class="kanban-move-btn" title="ย้ายไป ${prevCol.label}">
               <i class="fa-solid fa-arrow-left"></i><span>ย้อนกลับ</span>
             </button>`
          : '<span></span>'}
        ${nextCol
          ? `<button type="button" onclick="event.stopPropagation();app.moveKanbanTask('${escapeJsAttr(task.id)}','${escapeJsAttr(nextCol.id)}')" class="kanban-move-btn next" title="ย้ายไป ${nextCol.label}">
               <span>ขั้นถัดไป</span><i class="fa-solid fa-arrow-right"></i>
             </button>`
          : '<span></span>'}
      </div>
    </div>`;
}

function _subtaskEditorRow(subtask = {}) {
  const id = subtask.id || `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return `
    <div class="swk-subtask-row" data-subtask-id="${escapeHTML(id)}">
      <label class="swk-subtask-check" title="สถานะงานย่อย">
        <input type="checkbox" ${subtask.done ? 'checked' : ''} aria-label="งานย่อยเสร็จแล้ว">
        <i class="fa-regular fa-circle"></i>
      </label>
      <input type="text" class="swk-subtask-title" value="${escapeHTML(subtask.title || '')}" placeholder="ชื่องานย่อย">
      <button type="button" class="swk-subtask-delete" onclick="app.removeKanbanSubtaskRow(this)" title="ลบงานย่อย" aria-label="ลบงานย่อย">
        <i class="fa-solid fa-trash-can"></i>
      </button>
    </div>`;
}

export function addKanbanSubtaskRow() {
  const list = document.getElementById('swk-subtask-list');
  if (!list) return;
  list.querySelector('.swk-subtask-empty')?.remove();
  list.insertAdjacentHTML('beforeend', _subtaskEditorRow());
  const count = document.getElementById('swk-subtask-count');
  if (count) count.textContent = String(list.querySelectorAll('.swk-subtask-row').length);
  list.querySelector('.swk-subtask-row:last-child .swk-subtask-title')?.focus();
}

export function removeKanbanSubtaskRow(button) {
  const list = document.getElementById('swk-subtask-list');
  button?.closest('.swk-subtask-row')?.remove();
  const count = document.getElementById('swk-subtask-count');
  if (count) count.textContent = String(list?.querySelectorAll('.swk-subtask-row').length || 0);
  if (list && !list.querySelector('.swk-subtask-row')) {
    list.innerHTML = '<div class="swk-subtask-empty"><i class="fa-regular fa-clipboard"></i><span>ยังไม่มีงานย่อย กด “เพิ่มงานย่อย” เพื่อเริ่มต้น</span></div>';
  }
}

function _kanbanTaskForm(task) {
  const t = task || {};
  const subtasks = _normalizeSubtasks(t);
  const dependencyOptions = (state.currentProject?.tasks || [])
    .filter(item => item.id !== t.id)
    .map(item => `<option value="${escapeHTML(item.id)}" ${t.dependsOn === item.id ? 'selected' : ''}>${escapeHTML(item.title)}</option>`)
    .join('');
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
      <div>
        <div class="swk-subtask-toolbar">
          <label>งานย่อย <span id="swk-subtask-count">${subtasks.length}</span></label>
          <button type="button" onclick="app.addKanbanSubtaskRow()"><i class="fa-solid fa-plus"></i> เพิ่มงานย่อย</button>
        </div>
        <div id="swk-subtask-list" class="swk-subtask-editor">
          ${subtasks.length
            ? subtasks.map(_subtaskEditorRow).join('')
            : '<div class="swk-subtask-empty"><i class="fa-regular fa-clipboard"></i><span>ยังไม่มีงานย่อย กด “เพิ่มงานย่อย” เพื่อเริ่มต้น</span></div>'}
        </div>
      </div>
      <div>
        <label class="block text-xs font-bold text-gray-400 uppercase mb-1">ผู้รับผิดชอบ</label>
        <input id="swk-assignee" class="swal2-input !text-sm" placeholder="ชื่อ-สกุล" value="${escapeHTML(t.assignee || '')}">
      </div>
      <div>
        <label class="block text-xs font-bold text-gray-400 uppercase mb-1">งานก่อนหน้า (Dependency)</label>
        <select id="swk-depends" class="swal2-select !text-sm">
          <option value="">ไม่มีงานก่อนหน้า</option>
          ${dependencyOptions}
        </select>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-xs font-bold text-gray-400 uppercase mb-1">วันเริ่มงาน</label>
          <input type="date" id="swk-start" class="swal2-input !text-sm" value="${escapeHTML(t.startDate || '')}">
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
      <div>
        <label class="block text-xs font-bold text-gray-400 uppercase mb-1">หมวดหมู่</label>
        <select id="swk-category" class="swal2-select !text-sm">
          ${Object.entries(KANBAN_CATEGORY_CFG).map(([id, cfg]) => `<option value="${id}" ${(t.category || 'academic') === id ? 'selected' : ''}>${cfg.label}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="block text-xs font-bold text-gray-400 uppercase mb-1">เกณฑ์ตรวจรับ / Definition of Done</label>
        <textarea id="swk-acceptance" class="swal2-textarea !text-sm !h-16" placeholder="ระบุผลลัพธ์หรือหลักฐานที่ใช้ยืนยันว่างานเสร็จสมบูรณ์">${escapeHTML(t.acceptanceCriteria || '')}</textarea>
      </div>
      <div class="swk-blocker-box ${t.blocked ? 'is-blocked' : ''}">
        <label class="swk-blocker-toggle">
          <input type="checkbox" id="swk-blocked" ${t.blocked ? 'checked' : ''}
                 onchange="this.closest('.swk-blocker-box').classList.toggle('is-blocked', this.checked)">
          <span><i class="fa-solid fa-ban"></i> งานติด Blocker</span>
        </label>
        <textarea id="swk-blocker-reason" class="swal2-textarea !text-sm !h-14" placeholder="ระบุสาเหตุ สิ่งที่รอ และผู้ที่ต้องตัดสินใจ">${escapeHTML(t.blockerReason || '')}</textarea>
      </div>
    </div>`;
}

function _readKanbanTaskForm() {
  const title = document.getElementById('swk-title')?.value.trim();
  if (!title) { Swal.showValidationMessage('กรุณากรอกชื่องาน'); return false; }
  const startDate = document.getElementById('swk-start')?.value || '';
  const dueDate = document.getElementById('swk-due')?.value || '';
  if (startDate && dueDate && startDate > dueDate) {
    Swal.showValidationMessage('วันเริ่มงานต้องไม่เกินกำหนดเสร็จ');
    return false;
  }
  const subtasks = [...document.querySelectorAll('#swk-subtask-list .swk-subtask-row')]
    .map((row, index) => ({
      id: row.dataset.subtaskId || `sub-${Date.now().toString(36)}-${index}`,
      title: row.querySelector('.swk-subtask-title')?.value.trim() || '',
      done: Boolean(row.querySelector('input[type="checkbox"]')?.checked),
    }))
    .filter(subtask => subtask.title);
  return {
    title,
    description: document.getElementById('swk-desc')?.value.trim() || '',
    assignee:    document.getElementById('swk-assignee')?.value.trim() || '',
    dependsOn:   document.getElementById('swk-depends')?.value || '',
    startDate,
    dueDate,
    priority:    document.getElementById('swk-priority')?.value || 'medium',
    status:      document.getElementById('swk-status')?.value || 'todo',
    category:    document.getElementById('swk-category')?.value || 'academic',
    acceptanceCriteria: document.getElementById('swk-acceptance')?.value.trim() || '',
    blocked:     Boolean(document.getElementById('swk-blocked')?.checked),
    blockerReason: document.getElementById('swk-blocker-reason')?.value.trim() || '',
    subtasks,
  };
}

// ── Gantt timeline view ──
const _GANTT_DAY_MS = 86400000;

function _ganttParseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d)) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

// A task is plottable when it has at least one date.
// startDate+dueDate → bar, dueDate only → milestone, startDate only → 1-day bar
function _ganttTaskRange(task) {
  const start = _ganttParseDate(task.startDate);
  const due = _ganttParseDate(task.dueDate);
  if (!start && !due) return null;
  const from = start || due;
  const to = due || start;
  if (from > to) return { from: to, to: from, milestone: false };
  return { from, to, milestone: !start && !!due };
}

function _ganttBarClass(task) {
  if (_isKanbanTaskBlocked(task)) return 'gantt-bar-blocked';
  if (_isKanbanTaskOverdue(task)) return 'gantt-bar-overdue';
  if (task.status === 'done') return 'gantt-bar-done';
  if (task.status === 'review') return 'gantt-bar-review';
  if (task.status === 'doing') return 'gantt-bar-doing';
  return 'gantt-bar-todo';
}

function _renderKanbanGantt(tasks) {
  const scheduled = [];
  const unscheduled = [];
  tasks.forEach(task => {
    const range = _ganttTaskRange(task);
    if (range) scheduled.push({ task, ...range });
    else unscheduled.push(task);
  });

  const unscheduledHTML = unscheduled.length ? `
    <div class="gantt-unscheduled">
      <p class="gantt-unscheduled-title"><i class="fa-regular fa-calendar-xmark"></i> ยังไม่กำหนดวัน (${unscheduled.length})</p>
      <div class="gantt-unscheduled-list">
        ${unscheduled.map(t => `
          <button type="button" class="gantt-unscheduled-chip" onclick="app.editKanbanTask('${escapeJsAttr(t.id)}')" title="คลิกเพื่อกำหนดวัน">
            <i class="fa-solid fa-plus text-[9px]"></i>${escapeHTML(t.title)}
          </button>`).join('')}
      </div>
    </div>` : '';

  if (!scheduled.length) {
    return `
      <div class="kanban-gantt">
        <div class="gantt-empty">
          <i class="fa-solid fa-chart-gantt"></i>
          <p>ยังไม่มีงานที่กำหนดวันเริ่มหรือกำหนดเสร็จ</p>
          <p class="gantt-empty-hint">เพิ่มวันเริ่มงาน/กำหนดเสร็จให้งาน เพื่อแสดงบนไทม์ไลน์</p>
        </div>
        ${unscheduledHTML}
      </div>`;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let min = today, max = today;
  scheduled.forEach(({ from, to }) => {
    if (from < min) min = from;
    if (to > max) max = to;
  });
  const rangeStart = new Date(min.getTime() - 2 * _GANTT_DAY_MS);
  const rangeEnd = new Date(max.getTime() + 4 * _GANTT_DAY_MS);
  const days = Math.round((rangeEnd - rangeStart) / _GANTT_DAY_MS) + 1;
  const autoDayWidth = days <= 35 ? 30 : days <= 70 ? 20 : days <= 140 ? 14 : 10;
  const dayW = _kanbanGanttScale === 'detail'
    ? 30
    : _kanbanGanttScale === 'overview'
      ? 10
      : autoDayWidth;
  const showDayNumbers = dayW >= 14;
  const trackW = days * dayW;
  const dayIndex = d => Math.round((d - rangeStart) / _GANTT_DAY_MS);

  // Month header spans
  const monthSpans = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(rangeStart.getTime() + i * _GANTT_DAY_MS);
    const label = d.toLocaleDateString('th-TH', { month: 'short', year: '2-digit' });
    const last = monthSpans[monthSpans.length - 1];
    if (last && last.label === label) last.count++;
    else monthSpans.push({ label, count: 1 });
  }

  // Day header cells
  let dayCells = '';
  for (let i = 0; i < days; i++) {
    const d = new Date(rangeStart.getTime() + i * _GANTT_DAY_MS);
    const dow = d.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isToday = d.getTime() === today.getTime();
    const text = showDayNumbers ? d.getDate() : (dow === 1 ? d.getDate() : '');
    dayCells += `<span class="gantt-day-cell ${isWeekend ? 'weekend' : ''} ${isToday ? 'today' : ''}" style="width:${dayW}px">${text}</span>`;
  }

  // Weekend shading + day grid lines as track background
  const satOffset = ((6 - rangeStart.getDay() + 7) % 7) * dayW;
  const trackBg = `background-image:` +
    `linear-gradient(90deg, rgba(100,116,139,.09) 0 ${2 * dayW}px, transparent ${2 * dayW}px),` +
    `linear-gradient(90deg, rgba(100,116,139,.12) 1px, transparent 1px);` +
    `background-size:${7 * dayW}px 100%, ${dayW}px 100%;` +
    `background-position:${satOffset}px 0, 0 0;` +
    `background-repeat:repeat-x, repeat;`;

  // Rows grouped by category (workstream swimlanes)
  const groups = Object.entries(KANBAN_CATEGORY_CFG)
    .map(([id, cfg]) => ({
      id, cfg,
      items: scheduled
        .filter(({ task }) => (task.category || 'academic') === id)
        .sort((a, b) => a.from - b.from || a.to - b.to),
    }))
    .filter(g => g.items.length);

  const rows = groups.map(group => {
    const done = group.items.filter(({ task }) => task.status === 'done').length;
    const gFrom = group.items.reduce((m, i) => i.from < m ? i.from : m, group.items[0].from);
    const gTo = group.items.reduce((m, i) => i.to > m ? i.to : m, group.items[0].to);
    const gLeft = dayIndex(gFrom) * dayW;
    const gWidth = (dayIndex(gTo) - dayIndex(gFrom) + 1) * dayW;

    const groupRow = `
      <div class="gantt-row gantt-group-row">
        <div class="gantt-label gantt-group-label">
          <i class="fa-solid ${group.cfg.icon}"></i>
          <span>${group.cfg.label}</span>
          <em>${done}/${group.items.length}</em>
        </div>
        <div class="gantt-track" style="width:${trackW}px;${trackBg}">
          <span class="gantt-group-span" style="left:${gLeft}px;width:${gWidth}px"></span>
        </div>
      </div>`;

    const taskRows = group.items.map(({ task, from, to, milestone }) => {
      const left = dayIndex(from) * dayW;
      const width = Math.max((dayIndex(to) - dayIndex(from) + 1) * dayW - 2, dayW - 2);
      const barCls = _ganttBarClass(task);
      const isOverdue = _isKanbanTaskOverdue(task);
      const durationDays = dayIndex(to) - dayIndex(from) + 1;
      const tip = `${escapeHTML(task.title)} • ${escapeHTML(task.dueDate ? 'ครบกำหนด ' + task.dueDate : 'เริ่ม ' + task.startDate)}${task.assignee ? ' • ' + escapeHTML(task.assignee) : ''}`;

      // Overdue: hatched extension from due date to today (classic slippage visual)
      const extWidth = isOverdue ? (dayIndex(today) - dayIndex(to)) * dayW : 0;
      const overdueExt = extWidth > 0
        ? `<span class="gantt-overdue-ext" style="left:${left + width + 2}px;width:${extWidth}px"></span>`
        : '';

      const shape = milestone
        ? `<button type="button" class="gantt-milestone ${barCls}" style="left:${left + dayW / 2}px" title="${tip}"
                   onclick="app.editKanbanTask('${escapeJsAttr(task.id)}')"></button>`
        : `<button type="button" class="gantt-bar ${barCls}" style="left:${left}px;width:${width}px" title="${tip}"
                   onclick="app.editKanbanTask('${escapeJsAttr(task.id)}')">
             ${width >= 56 ? `<span class="gantt-bar-text">${durationDays} วัน${task.assignee ? ' • ' + escapeHTML(task.assignee) : ''}</span>` : ''}
           </button>`;

      return `
        <div class="gantt-row">
          <div class="gantt-label gantt-task-label" onclick="app.editKanbanTask('${escapeJsAttr(task.id)}')" title="${escapeHTML(task.title)}">
            <span class="gantt-label-dot ${barCls}"></span>
            <span class="gantt-label-text ${task.status === 'done' ? 'done' : ''}">${escapeHTML(task.title)}</span>
            ${task.assignee ? `<span class="gantt-label-assignee">${escapeHTML(task.assignee)}</span>` : ''}
          </div>
          <div class="gantt-track" style="width:${trackW}px;${trackBg}">
            ${overdueExt}${shape}
          </div>
        </div>`;
    }).join('');

    return groupRow + taskRows;
  }).join('');

  const todayLeft = dayIndex(today) * dayW + Math.floor(dayW / 2);

  return `
    <div class="kanban-gantt">
      <div class="gantt-legend">
        <span><i class="gantt-dot gantt-bar-todo"></i>รอดำเนินการ</span>
        <span><i class="gantt-dot gantt-bar-doing"></i>กำลังดำเนินการ</span>
        <span><i class="gantt-dot gantt-bar-review"></i>ตรวจรับ</span>
        <span><i class="gantt-dot gantt-bar-done"></i>เสร็จแล้ว</span>
        <span><i class="gantt-dot gantt-bar-blocked"></i>ติด Blocker</span>
        <span><i class="gantt-dot gantt-bar-overdue"></i>เกินกำหนด</span>
        <span><i class="gantt-dot gantt-dot-milestone"></i>Milestone (มีเฉพาะกำหนดเสร็จ)</span>
        <div class="gantt-scale-switch" role="group" aria-label="ระดับการขยาย Gantt">
          <button type="button" class="${_kanbanGanttScale === 'overview' ? 'active' : ''}" onclick="app.setKanbanGanttScale('overview')">ภาพรวม</button>
          <button type="button" class="${_kanbanGanttScale === 'auto' ? 'active' : ''}" onclick="app.setKanbanGanttScale('auto')">พอดี</button>
          <button type="button" class="${_kanbanGanttScale === 'detail' ? 'active' : ''}" onclick="app.setKanbanGanttScale('detail')">รายวัน</button>
        </div>
      </div>
      <div class="gantt-scroll">
        <div class="gantt-canvas" style="width:${240 + trackW}px">
          <div class="gantt-row gantt-header-months">
            <div class="gantt-label gantt-header-spacer">ไทม์ไลน์งาน</div>
            <div class="gantt-track" style="width:${trackW}px">
              ${monthSpans.map(m => `<span class="gantt-month-cell" style="width:${m.count * dayW}px">${m.label}</span>`).join('')}
            </div>
          </div>
          <div class="gantt-row gantt-header-days">
            <div class="gantt-label gantt-header-spacer"></div>
            <div class="gantt-track" style="width:${trackW}px">${dayCells}</div>
          </div>
          <div class="gantt-body">
            ${rows}
            <div class="gantt-today-line" style="left:${240 + todayLeft}px"><span>วันนี้</span></div>
          </div>
        </div>
      </div>
      ${unscheduledHTML}
    </div>`;
}

export function setKanbanView(view) {
  _kanbanView = view === 'gantt' ? 'gantt' : 'board';
  renderKanban(state.currentProject);
}

export function setKanbanGanttScale(scale) {
  _kanbanGanttScale = ['overview', 'detail'].includes(scale) ? scale : 'auto';
  renderKanban(state.currentProject);
}

export function renderKanban(project) {
  const p = project || state.currentProject;
  if (!p) return;
  p.tasks = p.tasks || [];
  const board = document.getElementById('kanban-board');
  if (!board) return;

  // Rebuilding the board removes the focused/moved card from the DOM. Keep the
  // viewport anchored so changing a task status does not jump the user upward.
  const pageScroller = document.getElementById('scroll-container');
  const pageScrollTop = pageScroller?.scrollTop ?? 0;
  const columnsScrollLeft = board.querySelector('.kanban-columns')?.scrollLeft ?? 0;
  const restoreScrollPosition = () => {
    if (pageScroller) pageScroller.scrollTop = pageScrollTop;
    const columnsScroller = board.querySelector('.kanban-columns');
    if (columnsScroller) columnsScroller.scrollLeft = columnsScrollLeft;
  };
  const finishRender = () => {
    restoreScrollPosition();
    requestAnimationFrame(restoreScrollPosition);
  };

  const visibleTasks = p.tasks.filter(_matchesKanbanFilters);

  if (_kanbanView === 'gantt') {
    board.innerHTML = _renderKanbanToolbar(p.tasks, visibleTasks) + _renderKanbanGantt(visibleTasks);
    finishRender();
    return;
  }

  const columnsHtml = KANBAN_COLS.map(col => {
    const tasks = _sortKanbanColumnTasks(visibleTasks.filter(t => t.status === col.id), col.id);
    const totalInColumn = p.tasks.filter(t => t.status === col.id).length;
    const isOverWip = Boolean(col.wipLimit && totalInColumn > col.wipLimit);
    const emptyText = _hasActiveKanbanFilters()
      ? 'ไม่มีงานตรงกับตัวกรอง'
      : 'ลากการ์ดมาวางที่นี่';
    return `
      <div class="kanban-column kanban-column-${col.id} ${isOverWip ? 'is-over-wip' : ''} ${col.bg} ${col.border}"
           data-status="${col.id}"
           ondragover="app.onKanbanDragOver(event)"
           ondragleave="event.target === this && this.classList.remove('drag-over')"
           ondrop="app.onKanbanDrop(event,'${escapeJsAttr(col.id)}')">
        <div class="kanban-col-header">
          <div class="kanban-col-heading">
            <span class="kanban-col-icon"><i class="fa-solid ${col.icon}"></i></span>
            <div class="kanban-col-title">
              <small>${col.shortLabel}</small>
              <strong>${col.label}</strong>
            </div>
            <div class="kanban-col-metrics">
              ${col.wipLimit
                ? `<span class="kanban-wip-limit ${isOverWip ? 'is-over' : ''}" title="งานระหว่างทำ ${totalInColumn} จากขีดจำกัด ${col.wipLimit}">WIP ${totalInColumn}/${col.wipLimit}</span>`
                : `<span class="kanban-count ${col.countBg}" title="จำนวนงาน">${tasks.length}</span>`}
              ${tasks.length !== totalInColumn ? `<span class="kanban-muted-count">${totalInColumn} ทั้งหมด</span>` : ''}
            </div>
          </div>
          <button onclick="app.addKanbanTask('${escapeJsAttr(col.id)}')"
                  class="kanban-add-btn ${col.addColor}" title="เพิ่มงาน">
            <i class="fa-solid fa-plus text-xs"></i>
          </button>
        </div>
        <label class="kanban-col-sort">
          <i class="fa-solid fa-arrow-down-wide-short" aria-hidden="true"></i>
          <span>เรียง</span>
          <select onchange="app.setKanbanColumnSort('${escapeJsAttr(col.id)}', this.value)" aria-label="เรียงงานใน ${escapeHTML(col.label)}">
            ${KANBAN_SORT_OPTIONS.map(option => _kanbanOption(option.id, option.label, _kanbanColumnSort[col.id])).join('')}
          </select>
        </label>
        <div class="kanban-list space-y-2.5 min-h-[80px]">
          ${tasks.map(_taskCard).join('') || `<div class="kanban-empty"><i class="fa-regular fa-folder-open"></i><span>${emptyText}</span></div>`}
        </div>
      </div>`;
  }).join('');
  board.innerHTML = _renderKanbanToolbar(p.tasks, visibleTasks)
    + `<div class="kanban-columns" aria-label="กระดานงาน 4 ขั้นตอน">${columnsHtml}</div>`;
  finishRender();
}

function _syncKanbanColumns() {
  document.querySelectorAll('#kanban-board .kanban-column').forEach(column => {
    const status = column.dataset.status;
    const list = column.querySelector('.kanban-list');
    if (!list) return;
    const visibleCount = list.querySelectorAll(':scope > .kanban-card').length;
    const totalCount = state.currentProject?.tasks?.filter(task => task.status === status).length || 0;
    const count = column.querySelector('.kanban-count');
    if (count) count.textContent = String(visibleCount);
    const columnConfig = KANBAN_COLS.find(col => col.id === status);
    const isOverWip = Boolean(columnConfig?.wipLimit && totalCount > columnConfig.wipLimit);
    column.classList.toggle('is-over-wip', isOverWip);
    const wipBadge = column.querySelector('.kanban-wip-limit');
    if (wipBadge && columnConfig?.wipLimit) {
      wipBadge.textContent = `WIP ${totalCount}/${columnConfig.wipLimit}`;
      wipBadge.classList.toggle('is-over', isOverWip);
    }
    column.querySelector('.kanban-muted-count')?.remove();
    if (visibleCount !== totalCount) {
      count?.insertAdjacentHTML('afterend', `<span class="kanban-muted-count">${totalCount} ทั้งหมด</span>`);
    }
    list.querySelector('.kanban-empty')?.remove();
    if (!visibleCount) {
      const emptyText = _hasActiveKanbanFilters() ? 'ไม่มีงานตรงกับตัวกรอง' : 'ลากการ์ดมาวางที่นี่';
      list.insertAdjacentHTML('beforeend', `<div class="kanban-empty"><i class="fa-regular fa-folder-open"></i><span>${emptyText}</span></div>`);
    }
  });
}

function _patchKanbanTaskCard(taskId, { afterTaskId = null, beforeTaskId = null, reposition = false } = {}) {
  if (_kanbanView !== 'board') return;
  const board = document.getElementById('kanban-board');
  const task = state.currentProject?.tasks?.find(item => item.id === taskId);
  const currentCard = board?.querySelector(`.kanban-card[data-task-id="${CSS.escape(taskId)}"]`);
  if (!board || !task) return;

  if (!_matchesKanbanFilters(task)) {
    currentCard?.remove();
    _syncKanbanColumns();
    return;
  }

  const holder = document.createElement('div');
  holder.innerHTML = _taskCard(task).trim();
  const nextCard = holder.firstElementChild;
  const targetList = board.querySelector(`.kanban-column[data-status="${CSS.escape(task.status)}"] .kanban-list`);
  if (!nextCard || !targetList) return;
  if (reposition) {
    const beforeCard = beforeTaskId
      ? targetList.querySelector(`.kanban-card[data-task-id="${CSS.escape(beforeTaskId)}"]`)
      : null;
    currentCard?.remove();
    targetList.querySelector('.kanban-empty')?.remove();
    if (beforeCard) targetList.insertBefore(nextCard, beforeCard);
    else targetList.appendChild(nextCard);
  } else if (currentCard && currentCard.parentElement === targetList) currentCard.replaceWith(nextCard);
  else {
    currentCard?.remove();
    targetList.querySelector('.kanban-empty')?.remove();
    const previousCard = afterTaskId
      ? targetList.querySelector(`.kanban-card[data-task-id="${CSS.escape(afterTaskId)}"]`)
      : null;
    if (previousCard) previousCard.insertAdjacentElement('afterend', nextCard);
    else targetList.appendChild(nextCard);
  }
  _syncKanbanColumns();
}

function _removeKanbanTaskCard(taskId) {
  document.querySelector(`#kanban-board .kanban-card[data-task-id="${CSS.escape(taskId)}"]`)?.remove();
  _syncKanbanColumns();
}

export function setKanbanFilter(key, value) {
  if (!Object.prototype.hasOwnProperty.call(_kanbanFilters, key)) return;
  _kanbanFilters[key] = value || (key === 'q' ? '' : 'all');
  renderKanban(state.currentProject);
  if (key === 'q') {
    const input = document.getElementById('kanban-search-input');
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }
}

export function setKanbanColumnSort(status, sortBy) {
  if (!KANBAN_COLS.some(column => column.id === status)) return;
  if (!KANBAN_SORT_OPTIONS.some(option => option.id === sortBy)) return;
  _kanbanColumnSort[status] = sortBy;
  renderKanban(state.currentProject);
}

export function resetKanbanFilters() {
  _kanbanFilters.q = '';
  _kanbanFilters.status = 'all';
  _kanbanFilters.category = 'all';
  _kanbanFilters.priority = 'all';
  _kanbanFilters.due = 'all';
  _kanbanFilters.risk = 'all';
  renderKanban(state.currentProject);
}

export async function addKanbanTask(status) {
  const { value } = await Swal.fire({
    title: 'เพิ่มงานใหม่',
    width: 480,
    heightAuto: false,
    scrollbarPadding: false,
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

  const pageScroller = document.getElementById('scroll-container');
  const savedScrollTop = pageScroller?.scrollTop ?? 0;
  const restoreWorkingPosition = () => {
    if (pageScroller) pageScroller.scrollTop = savedScrollTop;
  };

  const { value } = await Swal.fire({
    title: 'แก้ไขงาน',
    width: 480,
    heightAuto: false,
    scrollbarPadding: false,
    html: _kanbanTaskForm(task),
    focusConfirm: false,
    returnFocus: false,
    showCancelButton: true,
    confirmButtonText: '<i class="fa-solid fa-floppy-disk mr-1"></i> บันทึก',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#1e3a8a',
    preConfirm: _readKanbanTaskForm
  });

  // SweetAlert removes the focused card/button when it closes. Restore the
  // Kanban working position before any part of the board is rendered again.
  restoreWorkingPosition();
  requestAnimationFrame(() => {
    restoreWorkingPosition();
    requestAnimationFrame(restoreWorkingPosition);
  });

  if (!value) return;
  Object.assign(task, value, { updatedAt: new Date().toISOString() });
  renderKanban(state.currentProject);
  renderDashboardStats();
  try {
    await gas.saveProject(state.currentProject);
    Swal.fire({ icon: 'success', title: 'บันทึกงานแล้ว', toast: true, position: 'top-end', timer: 1200, showConfirmButton: false, returnFocus: false, heightAuto: false, scrollbarPadding: false });
  } catch (e) {
    gas.notifyApiError('บันทึกงานล้มเหลว', e, { heightAuto: false, scrollbarPadding: false });
  }
}

export async function duplicateKanbanTask(taskId) {
  if (!state.currentProject) return;
  const tasks = state.currentProject.tasks = state.currentProject.tasks || [];
  const index = tasks.findIndex(t => t.id === taskId);
  if (index < 0) return;

  const source = tasks[index];
  const copy = {
    ...source,
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    title: `${source.title} (สำเนา)`,
    subtasks: _normalizeSubtasks(source).map((subtask, subtaskIndex) => ({
      ...subtask,
      id: `sub-${Date.now().toString(36)}-${subtaskIndex}`,
    })),
    createdAt: new Date().toISOString(),
  };
  delete copy.updatedAt;
  tasks.splice(index + 1, 0, copy);

  renderKanban(state.currentProject);
  try {
    await gas.saveProject(state.currentProject);
    Swal.fire({
      icon: 'success',
      title: 'ทำสำเนางานแล้ว',
      text: 'วางสำเนาไว้ถัดจากงานต้นฉบับ',
      toast: true,
      position: 'top-end',
      timer: 1800,
      timerProgressBar: true,
      showConfirmButton: false,
      returnFocus: false,
      heightAuto: false,
      scrollbarPadding: false,
    });
  } catch (e) {
    gas.notifyApiError('บันทึกงานล้มเหลว', e, { returnFocus: false, heightAuto: false, scrollbarPadding: false });
  }
}

export async function deleteKanbanTask(taskId) {
  const pageScroller = document.getElementById('scroll-container');
  const savedScrollTop = pageScroller?.scrollTop ?? 0;
  const savedWindowScrollTop = window.scrollY;
  const restoreWorkingPosition = () => {
    if (pageScroller) pageScroller.scrollTop = savedScrollTop;
    if (window.scrollY !== savedWindowScrollTop) window.scrollTo(0, savedWindowScrollTop);
  };

  const result = await Swal.fire({
    title: 'ลบงานนี้?', icon: 'warning',
    heightAuto: false,
    scrollbarPadding: false,
    showCancelButton: true,
    returnFocus: false,
    confirmButtonColor: '#ef4444',
    confirmButtonText: 'ลบ',
    cancelButtonText: 'ยกเลิก',
  });

  restoreWorkingPosition();
  requestAnimationFrame(() => {
    restoreWorkingPosition();
    requestAnimationFrame(restoreWorkingPosition);
  });

  if (!result.isConfirmed || !state.currentProject) return;
  const board = document.getElementById('kanban-board');
  if (board) {
    if (!board.hasAttribute('tabindex')) board.setAttribute('tabindex', '-1');
    board.focus({ preventScroll: true });
  }
  state.currentProject.tasks = state.currentProject.tasks?.filter(t => t.id !== taskId) || [];
  renderKanban(state.currentProject);
  restoreWorkingPosition();
  requestAnimationFrame(restoreWorkingPosition);
  setTimeout(restoreWorkingPosition, 100);
  try { await gas.saveProject(state.currentProject); } catch {}
}

export async function moveKanbanTask(taskId, newStatus) {
  if (!state.currentProject) return;
  if (!KANBAN_COLS.some(c => c.id === newStatus)) return;
  if (_placeKanbanTask(taskId, newStatus)) {
    await _saveKanbanOrder(taskId, { reposition: true });
  }
}

export async function toggleKanbanSubtask(taskId, subtaskId) {
  const task = state.currentProject?.tasks?.find(item => item.id === taskId);
  if (!task) return;
  task.subtasks = _normalizeSubtasks(task);
  const subtask = task.subtasks.find(item => item.id === subtaskId);
  if (!subtask) return;

  subtask.done = !subtask.done;
  subtask.updatedAt = new Date().toISOString();
  task.updatedAt = subtask.updatedAt;
  _patchKanbanTaskCard(task.id);
  renderDashboardStats();
  try {
    await gas.saveProject(state.currentProject);
  } catch (e) {
    subtask.done = !subtask.done;
    _patchKanbanTaskCard(task.id);
    gas.notifyApiError('บันทึกงานย่อยไม่สำเร็จ', e);
  }
}

export function onKanbanCardClick(event, taskId) {
  // A click fires right after a drag ends — ignore it so drops don't open the editor
  if (Date.now() - _lastDragEndAt < 300) return;
  editKanbanTask(taskId);
}

export function onKanbanDragStart(event, taskId) {
  _dragTaskId = taskId;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', taskId);
  event.currentTarget.classList.add('dragging');
}

export function onKanbanDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const column = event.currentTarget;
  column.classList.add('drag-over');
  _showKanbanDropMarker(column, _getKanbanDropTarget(column, event.clientY));
}

export function onKanbanDragEnd(event) {
  _lastDragEndAt = Date.now();
  event.currentTarget?.classList.remove('dragging');
  document.querySelectorAll('.kanban-column').forEach(c => c.classList.remove('drag-over'));
  _clearKanbanDropMarkers();
}

export async function onKanbanDrop(event, newStatus) {
  event.preventDefault();
  document.querySelectorAll('.kanban-column').forEach(c => c.classList.remove('drag-over'));
  const taskId = _dragTaskId || event.dataTransfer.getData('text/plain');
  _dragTaskId = null;
  if (!taskId || !state.currentProject) return;

  const task = state.currentProject.tasks?.find(item => item.id === taskId);
  const isManualReorder = task?.status === newStatus && _kanbanColumnSort[newStatus] !== 'manual';
  if (isManualReorder) _kanbanColumnSort[newStatus] = 'manual';
  const beforeTaskId = _getKanbanDropTarget(event.currentTarget, event.clientY);
  _clearKanbanDropMarkers();
  if (_placeKanbanTask(taskId, newStatus, beforeTaskId)) {
    await _saveKanbanOrder(taskId, { beforeTaskId, reposition: true });
  }
}
