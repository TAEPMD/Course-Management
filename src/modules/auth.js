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
    if (k === '<') {
      btn.innerHTML = '<i class="fa-solid fa-delete-left" aria-hidden="true"></i><span class="sr-only">Backspace</span>';
    } else {
      btn.textContent = k;
    }
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
  const boxes = document.querySelectorAll('#pin-display .pin-box');
  boxes.forEach((box, i) => {
    const filled = i < state.pinInput.length;
    const isCurrent = i === state.pinInput.length;
    box.classList.toggle('filled', filled);
    box.classList.toggle('active-cursor', !filled && isCurrent);
    box.innerHTML = filled ? '<span class="w-3 h-3 rounded-full bg-white inline-block"></span>' : '';
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
    try {
      const user = await gas.getSessionUser();
      if (!user) {
        clearClientSession();
        return;
      }
      sessionStorage.setItem('user_role', user.role);
      sessionStorage.setItem('user_name', user.name);
      state.currentUserRole = user.role;
      state.currentUserName = user.name;
      applyPermissions();
      const { showDashboard } = await import('./projects.js');
      showDashboard();
    } catch (e) {
      if (isAuthExpiredError(e)) {
        clearClientSession();
        Swal.fire({
          icon: 'info',
          title: 'Session หมดอายุ',
          text: 'กรุณาเข้าสู่ระบบใหม่',
          confirmButtonColor: '#1e3a8a'
        });
      } else {
        console.warn('Session check failed:', e.message);
        clearClientSession();
      }
    }
  }
}

export function isAuthExpiredError(error) {
  return /Unauthorized|Invalid or expired API session|Please login/i.test(error?.message || String(error || ''));
}

export function clearClientSession() {
  sessionStorage.clear();
  state.pinInput = '';
  state.projects = [];
  state.users = [];
  state.currentProject = null;
  state.currentUserRole = null;
  state.currentUserName = null;
  document.getElementById('sidebar')?.classList.add('hidden');
  document.getElementById('sidebar')?.classList.remove('drawer-open');
  document.getElementById('mobile-overlay')?.classList.remove('active');
  document.getElementById('top-header')?.classList.add('hidden');
  document.querySelector('.mobile-nav')?.classList.add('hidden');
  document.body.style.overflow = '';
  hideAllViews();
  document.getElementById('view-login')?.classList.remove('hidden');
  syncPinInputField();
  updatePinDisplay();
}

export async function logout() {
  await gas.logout();
  clearClientSession();
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
