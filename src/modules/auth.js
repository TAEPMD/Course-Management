/**
 * modules/auth.js — Authentication & Session Management
 */
import { state } from './state.js';
import { applyPermissions, hasPermission } from './permissions.js';
import * as gas from '../gas.js';
import { hashPIN } from '../utils/format.js';

export function renderNumpad() {
  const container = document.getElementById('login-numpad');
  if (!container) return;
  const keys = ['1','2','3','4','5','6','7','8','9','C','0','<'];
  container.innerHTML = '';
  keys.forEach(k => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = k === 'C'
      ? 'numpad-btn bg-red-50 text-red-500 hover:bg-red-100 font-black text-lg rounded-2xl h-14 transition-all active:scale-95'
      : k === '<'
      ? 'numpad-btn bg-slate-100 text-slate-600 hover:bg-slate-200 font-black text-xl rounded-2xl h-14 transition-all active:scale-95'
      : 'numpad-btn bg-white hover:bg-blue-50 text-slate-800 font-bold text-xl rounded-2xl h-14 shadow-sm border border-gray-100 transition-all active:scale-95 hover:border-blue-300';
    btn.textContent = k === '<' ? '⌫' : k;
    btn.addEventListener('click', () => handlePinInput(k));
    container.appendChild(btn);
  });
}

export function handlePinInput(key) {
  if (state.isLoggingIn) return;
  if (key === 'C') { state.pinInput = ''; }
  else if (key === '<') { state.pinInput = state.pinInput.slice(0, -1); }
  else if (state.pinInput.length < 5) { state.pinInput += key; }
  syncPinInputField();
  updatePinDisplay();
  if (state.pinInput.length === 5) processLogin();
}

export function syncPinInputField() {
  const input = document.getElementById('login-pin-input');
  if (input && input.value !== state.pinInput) input.value = state.pinInput;
}

export function updatePinDisplay() {
  const dots = document.querySelectorAll('#pin-display > div');
  dots.forEach((dot, i) => {
    const filled = i < state.pinInput.length;
    dot.classList.toggle('bg-blue-900', filled);
    dot.classList.toggle('border-blue-900', filled);
    dot.innerHTML = filled ? '<span class="w-3 h-3 rounded-full bg-white inline-block"></span>' : '';
  });
}

export async function processLogin() {
  if (state.isLoggingIn) return;
  state.isLoggingIn = true;
  document.getElementById('login-loader')?.classList.remove('hidden');
  document.getElementById('login-numpad')?.classList.add('opacity-50', 'pointer-events-none');

  try {
    const user = await gas.verifyPin(state.pinInput);
    if (user) {
      sessionStorage.setItem('niem_auth', 'true');
      sessionStorage.setItem('user_role', user.role);
      sessionStorage.setItem('user_name', user.name);
      state.currentUserRole = user.role;
      state.currentUserName = user.name;
      applyPermissions();
      // Dynamic import to avoid circular deps
      const { showDashboard } = await import('./projects.js');
      showDashboard();
    } else {
      Swal.fire({ icon: 'error', title: 'ACCESS DENIED', text: 'PIN ไม่ถูกต้อง', confirmButtonColor: '#1e3a8a' });
      state.pinInput = '';
      syncPinInputField();
      updatePinDisplay();
    }
  } catch (e) {
    Swal.fire({ icon: 'error', title: 'เกิดข้อผิดพลาด', text: e.message });
  } finally {
    document.getElementById('login-loader')?.classList.add('hidden');
    document.getElementById('login-numpad')?.classList.remove('opacity-50', 'pointer-events-none');
    state.isLoggingIn = false;
  }
}

export async function checkSession() {
  if (sessionStorage.getItem('niem_auth') === 'true') {
    state.currentUserRole = sessionStorage.getItem('user_role');
    state.currentUserName = sessionStorage.getItem('user_name');
    applyPermissions();
    const { showDashboard } = await import('./projects.js');
    showDashboard();
  }
}

export async function logout() {
  await gas.logout();
  sessionStorage.clear();
  state.pinInput = '';
  state.projects = [];
  state.users = [];
  state.currentProject = null;
  state.currentUserRole = null;
  state.currentUserName = null;
  document.getElementById('sidebar')?.classList.add('hidden');
  document.getElementById('top-header')?.classList.add('hidden');
  document.querySelector('.mobile-nav')?.classList.add('hidden');
  hideAllViews();
  document.getElementById('view-login')?.classList.remove('hidden');
  syncPinInputField();
  updatePinDisplay();
}

export function hideAllViews() {
  ['view-login','view-dashboard','view-annual-plan','view-monthly-plan',
   'view-weekly-plan','view-users','view-settings','view-project-detail'].forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });
  document.getElementById('scroll-container')?.scrollTo(0, 0);
}

export function setHeader(title) {
  document.getElementById('top-header')?.classList.remove('hidden');
  const headerTitle = document.getElementById('header-title');
  if (headerTitle) headerTitle.innerText = title;
  document.getElementById('sidebar')?.classList.remove('hidden');
  document.querySelector('.mobile-nav')?.classList.remove('hidden');
}

export function updateNavActive(activeId) {
  ['nav-dashboard','nav-annual','nav-monthly','nav-weekly','nav-users','nav-settings'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.classList.toggle('active', id === activeId);
    btn.classList.toggle('text-blue-200', id !== activeId);
  });
}
