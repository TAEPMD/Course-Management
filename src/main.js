/**
 * main.js — Application Entry Point
 * Wires all modules together and exposes `window.app` for HTML onclick handlers
 */

import { state } from './modules/state.js';
import { checkSession, logout, renderNumpad, handlePinInput, syncPinInputField, updatePinDisplay,
         openPinChangeModal, closePinChangeModal, submitPinChange, processLogin, PIN_LENGTH } from './modules/auth.js';
import { checkConnection } from './gas.js';
import { showDashboard, showCourseManagement, showAnnualPlan, showMonthlyPlan, showWeeklyPlan,
         createNewProject, saveProjectInfo, openProject, switchTab, uploadDocument, downloadDocument, deleteDocument,
         deleteProject,
         renderAnnualTimeline, renderMonthlyPlan, changeWeek, refreshProjectIndicators, filterProjects,
         setCourseManagementFilter, resetCourseManagementFilters,
         addKanbanTask, editKanbanTask, deleteKanbanTask, duplicateKanbanTask, moveKanbanTask, toggleKanbanSubtask,
         addKanbanSubtaskRow, removeKanbanSubtaskRow,
         setKanbanFilter, resetKanbanFilters, onKanbanCardClick, setKanbanView,
         onKanbanDragStart, onKanbanDragOver, onKanbanDragEnd, onKanbanDrop } from './modules/projects.js';
import { showUsers, showUserModal, saveUser } from './modules/users.js';
import { showSettings, saveSettings, savePermissions, simulateRole,
         toggleDarkMode, loadDarkMode, loadPublicBranding, loadVisualControls, toggleVisualControlPanel, setVisualMode, previewLogo, uploadLogo,
         addMasterItem, saveMasterDataToCloud } from './modules/settings.js';
import { addBudgetEntry, exportBudgetReport, renderBudgetSummary, saveBudgetToCloud, openBudgetEntry, openBillIntake } from './modules/budget.js';
import { addScheduleSession } from './modules/schedule.js';

// ── Global `app` object exposed for HTML onclick="app.xxx()" compatibility ──
window.app = {
  // Navigation
  showDashboard,
  showCourseManagement,
  showAnnualPlan,
  showMonthlyPlan,
  showWeeklyPlan,
  showUsers,
  showSettings,

  // Auth
  logout,
  openPinChangeModal,
  closePinChangeModal,
  submitPinChange,

  // Projects
  createNewProject,
  saveProjectInfo,
  deleteProject,
  openProject,
  switchTab,
  uploadDocument,
  downloadDocument,
  deleteDocument,
  renderAnnualTimeline,
  renderMonthlyPlan,
  changeWeek,
  refreshProjectIndicators,
  filterProjects,
  setCourseManagementFilter,
  resetCourseManagementFilters,

  // Users
  openUserModal: () => showUserModal(null),
  saveUser,

  // Settings
  savePermissions,
  simulateRole,
  toggleDarkMode,
  toggleVisualControlPanel,
  setVisualMode,
  previewLogo,
  uploadLogo,
  saveGeneralSettings: saveSettings,
  addMasterItem,
  saveMasterDataToCloud,

  // Budget
  addBudgetEntry,
  exportBudgetReport,
  saveBudgetToCloud,
  openBudgetEntry,
  openBillIntake,

  // Kanban
  addKanbanTask,
  editKanbanTask,
  deleteKanbanTask,
  duplicateKanbanTask,
  moveKanbanTask,
  toggleKanbanSubtask,
  addKanbanSubtaskRow,
  removeKanbanSubtaskRow,
  onKanbanCardClick,
  setKanbanFilter,
  resetKanbanFilters,
  setKanbanView,
  onKanbanDragStart,
  onKanbanDragOver,
  onKanbanDragEnd,
  onKanbanDrop,

  // Schedule
  addScheduleSession,
};

// ── Keyboard PIN support ──
window.addEventListener('keydown', e => {
  const loginView = document.getElementById('view-login');
  if (!loginView || loginView.classList.contains('hidden')) return;

  const target = e.target;
  const isTyping = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  if (isTyping && target.id !== 'login-pin-input') return;

  if (/^[0-9]$/.test(e.key)) { e.preventDefault(); handlePinInput(e.key); }
  else if (/^Digit[0-9]$/.test(e.code)) { e.preventDefault(); handlePinInput(e.code.replace('Digit','')); }
  else if (/^Numpad[0-9]$/.test(e.code)) { e.preventDefault(); handlePinInput(e.code.replace('Numpad','')); }
  else if (e.key === 'Backspace') { e.preventDefault(); handlePinInput('<'); }
  else if (e.key === 'Escape') { e.preventDefault(); handlePinInput('C'); }
});

// ── PIN text input sync ──
document.addEventListener('DOMContentLoaded', () => {
  renderNumpad();
  loadDarkMode();
  loadVisualControls();
  loadPublicBranding();
  checkSession();

  // Login form: ส่งด้วยปุ่ม/Enter ก็ได้ (numpad จะยิงเองเมื่อครบ 6 หลัก)
  document.getElementById('login-form')?.addEventListener('submit', e => {
    e.preventDefault();
    processLogin();
  });

  // ปุ่มแสดง/ซ่อน PIN
  const pinToggle = document.getElementById('login-pin-toggle');
  pinToggle?.addEventListener('click', () => {
    const field = document.getElementById('login-pin-input');
    if (!field) return;
    const show = field.type === 'password';
    field.type = show ? 'text' : 'password';
    pinToggle.textContent = show ? 'ซ่อน PIN' : 'แสดง PIN';
    pinToggle.setAttribute('aria-pressed', String(show));
  });

  // PIN input field sync
  const pinInput = document.getElementById('login-pin-input');
  if (pinInput) {
    pinInput.addEventListener('input', e => {
      const sanitized = e.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH);
      state.pinInput = sanitized;
      syncPinInputField();
      updatePinDisplay();
      if (sanitized.length === PIN_LENGTH) {
        processLogin();
      }
    });
  }
  document.getElementById('login-identifier')?.focus();

  // ── Mobile sidebar drawer ──
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('mobile-overlay');

  function openDrawer() {
    sidebar?.classList.add('drawer-open');
    overlay?.classList.add('active');
    document.body.style.overflow = 'hidden';
  }
  function closeDrawer() {
    sidebar?.classList.remove('drawer-open');
    overlay?.classList.remove('active');
    document.body.style.overflow = '';
  }

  document.getElementById('mobile-menu-btn')?.addEventListener('click', () => {
    sidebar?.classList.contains('drawer-open') ? closeDrawer() : openDrawer();
  });
  overlay?.addEventListener('click', closeDrawer);

  // Escape closes drawer / user modal
  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    closeDrawer();
    document.getElementById('user-modal')?.classList.add('hidden');
    document.getElementById('visual-control-panel')?.classList.add('hidden');
    document.getElementById('visual-control-toggle')?.setAttribute('aria-expanded', 'false');
  });

  document.addEventListener('click', e => {
    const panel = document.getElementById('visual-control-panel');
    const trigger = document.getElementById('visual-control-toggle');
    if (!panel || panel.classList.contains('hidden')) return;
    if (panel.contains(e.target) || trigger?.contains(e.target)) return;
    panel.classList.add('hidden');
    trigger?.setAttribute('aria-expanded', 'false');
  });

  // Clicking the modal backdrop closes it
  document.getElementById('user-modal')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });

  // Close drawer when any sidebar nav item is clicked (mobile)
  sidebar?.querySelectorAll('.sidebar-item').forEach(btn => {
    btn.addEventListener('click', closeDrawer);
  });

  // ── Desktop sidebar collapse ──
  const collapseBtn = document.getElementById('sidebar-collapse-btn');
  const savedCollapse = localStorage.getItem('sidebar_collapsed');
  if (savedCollapse === '1') sidebar?.classList.add('sidebar-collapsed');

  collapseBtn?.addEventListener('click', () => {
    const isCollapsed = sidebar?.classList.toggle('sidebar-collapsed');
    localStorage.setItem('sidebar_collapsed', isCollapsed ? '1' : '0');
  });

  // ── Mobile bottom nav active state sync ──
  // Patched into app navigation calls via MutationObserver on header title
  const mobileNavMap = {
    'nav-dashboard': 'm-nav-dashboard',
    'nav-courses':   'm-nav-courses',
    'nav-annual':    'm-nav-annual',
    'nav-monthly':   'm-nav-monthly',
    'nav-weekly':    'm-nav-weekly',
    'nav-users':     'm-nav-users',
    'nav-settings':  'm-nav-settings',
  };

  function syncMobileNav() {
    const activeDesktop = document.querySelector('.sidebar-item.active');
    if (!activeDesktop) return;
    const desktopId = activeDesktop.id;
    const mobileId = mobileNavMap[desktopId];
    document.querySelectorAll('.mobile-nav button').forEach(btn => {
      const isActive = btn.id === mobileId;
      btn.classList.toggle('text-blue-900', isActive);
      btn.classList.toggle('dark:text-blue-400', isActive);
      btn.classList.toggle('text-gray-400', !isActive);
      btn.classList.toggle('dark:text-slate-500', !isActive);
    });
  }

  // Observe nav changes to sync mobile nav
  const navObs = new MutationObserver(syncMobileNav);
  document.querySelectorAll('.sidebar-item').forEach(el => {
    navObs.observe(el, { attributes: true, attributeFilter: ['class'] });
  });

  document.getElementById('input-proj-budget')?.addEventListener('input', () => {
    renderBudgetSummary();
    refreshProjectIndicators();
  });

  // ── DB Connection Status ──
  checkConnection().then(updateDbStatus);

  // คลิก badge เพื่อ retry
  document.getElementById('db-status-badge')?.addEventListener('click', () => {
    updateDbStatus('checking');
    checkConnection().then(updateDbStatus);
  });

});

function updateDbStatus(status) {
  const badge = document.getElementById('db-status-badge');
  const dot   = document.getElementById('db-status-dot');
  const text  = document.getElementById('db-status-text');
  const icon  = document.getElementById('db-status-icon');
  if (!badge) return;

  const cfg = {
    checking: {
      badge: 'flex border-gray-200 bg-gray-50 text-gray-400 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400 cursor-default',
      dot:   'bg-gray-300 animate-pulse',
      label: 'กำลังตรวจสอบ...',
      fa:    '',
      tip:   'กำลังตรวจสอบการเชื่อมต่อ...',
    },
    sheets: {
      badge: 'flex border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 cursor-pointer hover:brightness-95',
      dot:   'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.2)]',
      label: 'Google Sheets',
      fa:    'fa-solid fa-table-cells text-emerald-500',
      tip:   '✅ เชื่อมต่อ Google Sheets สำเร็จ\n(คลิกเพื่อตรวจสอบอีกครั้ง)',
    },
    gas: {
      badge: 'flex border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 cursor-pointer hover:brightness-95',
      dot:   'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.2)]',
      label: 'Apps Script',
      fa:    'fa-solid fa-bolt text-emerald-500',
      tip:   '✅ ทำงานใน Google Apps Script\n(คลิกเพื่อตรวจสอบอีกครั้ง)',
    },
    error: {
      badge: 'flex border-red-200 bg-red-50 text-red-600 dark:border-red-700 dark:bg-red-900/30 dark:text-red-400 cursor-pointer hover:brightness-95',
      dot:   'bg-red-500 animate-pulse',
      label: 'Production DB Error',
      fa:    'fa-solid fa-triangle-exclamation text-red-400',
      tip:   '',  // filled dynamically below
    },
  };

  const c = cfg[status] || cfg.error;

  if (status === 'error') {
    const detail = window.__dbError || 'ไม่ทราบสาเหตุ';
    c.tip = `❌ เชื่อมต่อ backend production ไม่ได้\n${detail}\n\nสาเหตุที่พบบ่อย:\n• ยังไม่ได้ Deploy Web App\n• ยังไม่ได้ตั้งค่า VITE_GAS_WEB_APP_URL\n• Access ตั้งเป็น "Anyone with Google account" ให้เปลี่ยนเป็น "Anyone"\n• URL ไม่ถูกต้อง\n\n(คลิกเพื่อลองใหม่ — ดู log ใน terminal ด้วย)`;
  }

  badge.className  = `items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border select-none transition-all duration-300 ${c.badge}`;
  dot.className    = `w-1.5 h-1.5 rounded-full shrink-0 ${c.dot}`;
  text.textContent = c.label;
  icon.className   = `text-[10px] ${c.fa}`;
  badge.title      = c.tip;
}
