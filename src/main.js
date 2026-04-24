/**
 * main.js — Application Entry Point
 * Wires all modules together and exposes `window.app` for HTML onclick handlers
 */

import './style.css';

import { state } from './modules/state.js';
import { checkSession, logout, renderNumpad, handlePinInput, syncPinInputField } from './modules/auth.js';
import { showDashboard, showAnnualPlan, showMonthlyPlan, showWeeklyPlan,
         createNewProject, saveProjectInfo, openProject, switchTab, uploadDocument, renderWeeklyPlan } from './modules/projects.js';
import { showUsers, showUserModal, closeUserModal, saveUser } from './modules/users.js';
import { showSettings, saveSettings, savePermissions, simulateRole,
         toggleDarkMode, loadDarkMode, loadSettings, previewLogo, uploadLogo, addMasterItem } from './modules/settings.js';
import { addBudgetEntry } from './modules/budget.js';
import { addScheduleSession } from './modules/schedule.js';
import { renderMasterDataLists } from './modules/masterData.js';

// ── Global `app` object exposed for HTML onclick="app.xxx()" compatibility ──
window.app = {
  // Navigation
  showDashboard,
  showAnnualPlan,
  showMonthlyPlan,
  showWeeklyPlan,
  showUsers,
  showSettings,

  // Auth
  logout,
  handlePinInput: key => handlePinInput(key),

  // Projects
  createNewProject,
  saveProjectInfo,
  openProject,
  switchTab,
  uploadDocument,

  // Users
  openUserModal: () => showUserModal(null),
  showUserModal: () => showUserModal(null),
  closeUserModal,
  saveUser,

  // Settings
  saveSettings,
  savePermissions,
  simulateRole,
  toggleDarkMode,
  previewLogo,
  uploadLogo,
  saveGeneralSettings: saveSettings,
  updateAdminPin: saveSettings,
  addMasterItem,

  // Budget
  addBudgetEntry,

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
  loadSettings();
  checkSession();

  // PIN input field sync
  const pinInput = document.getElementById('login-pin-input');
  if (pinInput) {
    pinInput.addEventListener('input', e => {
      const sanitized = e.target.value.replace(/\D/g, '').slice(0, 5);
      state.pinInput = sanitized;
      syncPinInputField();
      if (sanitized.length === 5) {
        import('./modules/auth.js').then(m => m.processLogin());
      }
    });
    pinInput.focus();
  }

  // Mobile sidebar toggle
  document.getElementById('mobile-menu-btn')?.addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    sidebar?.classList.toggle('hidden');
    sidebar?.classList.toggle('fixed');
    sidebar?.classList.toggle('inset-0');
    sidebar?.classList.toggle('z-50');
  });
});
