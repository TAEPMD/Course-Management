/**
 * modules/auth.js — Authentication & Session Management
 *
 * หลักการด้านความปลอดภัยของหน้านี้
 *  - session token อยู่ใน httpOnly cookie ที่ proxy ตั้งให้ (JS อ่านไม่ได้)
 *  - ไม่เก็บ role/ชื่อผู้ใช้ไว้ใน sessionStorage อีกต่อไป — ถามเซิร์ฟเวอร์เสมอ
 *  - ข้อความผิดพลาดเป็นข้อความกลาง ไม่บอกว่าบัญชีมีอยู่จริงหรือไม่
 *  - ล็อกชั่วคราวเมื่อกรอกผิดซ้ำ ๆ (เซิร์ฟเวอร์เป็นผู้ตัดสิน ฝั่งนี้แค่แสดงผล)
 *  - ออกจากระบบอัตโนมัติเมื่อไม่มีการใช้งาน
 */
import { state } from './state.js';
import { applyPermissions } from './permissions.js';
import * as gas from '../gas.js';

export const PIN_LENGTH = 6;
// PIN เดิม (ก่อนนโยบาย 6 หลัก) ยังใช้ล็อกอินได้ครั้งสุดท้ายเพื่อไปตั้ง PIN ใหม่
const LEGACY_PIN_MIN = 4;
const IDLE_LIMIT_MS = 30 * 60 * 1000; // ต้องไม่เกิน session idle timeout ฝั่งเซิร์ฟเวอร์
const IDLE_WARNING_MS = 60 * 1000;

let lockTimer = null;
let idleTimer = null;
let idleWarningTimer = null;
let pendingPinChange = null; // { identifier, currentPin }

// ── Login form helpers ────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id); }

function setLoginError(message) {
  const box = el('login-error');
  if (!box) return;
  box.textContent = message || '';
  box.classList.toggle('hidden', !message);
  if (message) el('pin-display')?.classList.add('pin-shake');
  setTimeout(() => el('pin-display')?.classList.remove('pin-shake'), 450);
}

function setLoginBusy(busy) {
  state.isLoggingIn = busy;
  el('login-loader')?.classList.toggle('hidden', !busy);
  el('login-numpad')?.classList.toggle('opacity-50', busy);
  el('login-numpad')?.classList.toggle('pointer-events-none', busy);
  const submit = el('login-submit');
  if (submit) submit.disabled = busy;
}

function clearPin() {
  state.pinInput = '';
  syncPinInputField();
  updatePinDisplay();
}

function getIdentifier() {
  return el('login-identifier')?.value.trim() || '';
}

// ── Numpad ────────────────────────────────────────────────────────────────────

export function renderNumpad() {
  const container = el('login-numpad');
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
      btn.innerHTML = '<i class="fa-solid fa-delete-left" aria-hidden="true"></i><span class="sr-only">ลบตัวเลขล่าสุด</span>';
    } else if (k === 'C') {
      btn.innerHTML = 'C<span class="sr-only">ล้าง PIN ทั้งหมด</span>';
    } else {
      btn.textContent = k;
      btn.setAttribute('aria-label', 'เลข ' + k);
    }
    btn.addEventListener('click', () => handlePinInput(k));
    container.appendChild(btn);
  });
}

export function handlePinInput(key) {
  if (state.isLoggingIn || state.loginLockedUntil > Date.now()) return;
  if (key === 'C') { state.pinInput = ''; }
  else if (key === '<') { state.pinInput = state.pinInput.slice(0, -1); }
  else if (state.pinInput.length < PIN_LENGTH) { state.pinInput += key; }
  syncPinInputField();
  updatePinDisplay();
  if (state.pinInput.length === PIN_LENGTH) processLogin();
}

export function syncPinInputField() {
  const input = el('login-pin-input');
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
  const status = el('pin-status');
  // ประกาศจำนวนหลักที่กรอกแล้วเท่านั้น — ไม่ประกาศตัวเลขจริง
  if (status) status.textContent = `กรอกแล้ว ${state.pinInput.length} จาก ${PIN_LENGTH} หลัก`;
}

// ── Temporary lockout ─────────────────────────────────────────────────────────

function startLockCountdown(seconds) {
  state.loginLockedUntil = Date.now() + seconds * 1000;
  clearPin();
  const box = el('login-lock');
  const numpad = el('login-numpad');

  const tick = () => {
    const remaining = Math.ceil((state.loginLockedUntil - Date.now()) / 1000);
    if (remaining <= 0) {
      clearInterval(lockTimer);
      lockTimer = null;
      state.loginLockedUntil = 0;
      box?.classList.add('hidden');
      numpad?.classList.remove('opacity-50', 'pointer-events-none');
      if (el('login-submit')) el('login-submit').disabled = false;
      setLoginError('');
      return;
    }
    const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
    const ss = String(remaining % 60).padStart(2, '0');
    if (box) {
      box.classList.remove('hidden');
      box.innerHTML = `<i class="fa-solid fa-lock" aria-hidden="true"></i> ป้อนรหัสผิดหลายครั้ง — ลองใหม่ได้ในอีก <strong>${mm}:${ss}</strong>`;
    }
  };

  numpad?.classList.add('opacity-50', 'pointer-events-none');
  if (el('login-submit')) el('login-submit').disabled = true;
  if (lockTimer) clearInterval(lockTimer);
  tick();
  lockTimer = setInterval(tick, 1000);
}

// ── Login ─────────────────────────────────────────────────────────────────────

export async function processLogin() {
  if (state.isLoggingIn) return;
  if (state.loginLockedUntil > Date.now()) return;

  const identifier = getIdentifier();
  if (!identifier) {
    setLoginError('กรุณากรอกชื่อผู้ใช้หรืออีเมล');
    el('login-identifier')?.focus();
    return;
  }
  if (state.pinInput.length < LEGACY_PIN_MIN) {
    setLoginError(`กรุณากรอก PIN อย่างน้อย ${LEGACY_PIN_MIN} หลัก`);
    return;
  }

  setLoginBusy(true);
  setLoginError('');
  const pin = state.pinInput;

  try {
    const result = await gas.login(identifier, pin) || {};

    switch (result.status) {
      case 'ok':
        clearPin();
        await startSession(result.user);
        break;

      case 'must_change_pin':
        clearPin();
        pendingPinChange = { identifier, currentPin: pin, user: result.user };
        openPinChangeModal(true);
        break;

      case 'locked':
        startLockCountdown(Math.max(30, Number(result.retryAfter) || 300));
        break;

      case 'disabled':
        clearPin();
        setLoginError('บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ');
        break;

      case 'upgrade_required':
        clearPin();
        setLoginError('ระบบมีการอัปเดต กรุณารีเฟรชหน้าเว็บแล้วเข้าสู่ระบบใหม่');
        break;

      default:
        clearPin();
        // ข้อความกลาง — ไม่เปิดเผยว่าชื่อผู้ใช้มีอยู่จริงหรือไม่
        setLoginError('ชื่อผู้ใช้หรือ PIN ไม่ถูกต้อง');
    }
  } catch (e) {
    clearPin();
    setLoginError(e?.message || 'เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่');
  } finally {
    setLoginBusy(false);
  }
}

async function startSession(user) {
  state.currentUserRole = user?.role || null;
  state.currentUserName = user?.name || null;
  state.currentUserId = user?.id || null;
  applyPermissions();
  startIdleWatch();
  // Dynamic import เพื่อเลี่ยง circular dependency
  import('./settings.js').then(m => m.loadSettings()).catch(() => {});
  const { showDashboard } = await import('./projects.js');
  showDashboard();
}

// ── Forced PIN change ─────────────────────────────────────────────────────────

export function openPinChangeModal(forced) {
  const modal = el('pin-change-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  el('pin-change-forced')?.classList.toggle('hidden', !forced);
  el('pin-change-cancel')?.classList.toggle('hidden', !!forced);
  el('pin-change-error')?.classList.add('hidden');
  ['pin-change-current', 'pin-change-new', 'pin-change-confirm'].forEach(id => {
    const input = el(id);
    if (input) input.value = '';
  });
  // เพิ่งล็อกอินมา → ใช้ PIN นั้นยืนยันได้เลย ไม่ต้องให้กรอกซ้ำ
  // (กรณีเปิดหน้าใหม่แล้วยังค้างสถานะบังคับเปลี่ยน จะยังต้องกรอก PIN ปัจจุบัน)
  const hasCurrentPin = !!pendingPinChange?.currentPin;
  el('pin-change-current-wrap')?.classList.toggle('hidden', hasCurrentPin);
  el(hasCurrentPin ? 'pin-change-new' : 'pin-change-current')?.focus();
}

export function closePinChangeModal() {
  el('pin-change-modal')?.classList.add('hidden');
  pendingPinChange = null;
}

export async function submitPinChange() {
  const errorBox = el('pin-change-error');
  const showError = (msg) => {
    if (!errorBox) return;
    errorBox.textContent = msg;
    errorBox.classList.remove('hidden');
  };

  const currentPin = pendingPinChange?.currentPin || el('pin-change-current')?.value.trim() || '';
  const newPin = el('pin-change-new')?.value.trim() || '';
  const confirmPin = el('pin-change-confirm')?.value.trim() || '';

  if (!new RegExp(`^\\d{${PIN_LENGTH},10}$`).test(newPin)) {
    return showError(`PIN ใหม่ต้องเป็นตัวเลข ${PIN_LENGTH}-10 หลัก`);
  }
  if (newPin !== confirmPin) return showError('ยืนยัน PIN ไม่ตรงกัน');
  if (/^(\d)\1+$/.test(newPin)) return showError('PIN ห้ามเป็นตัวเลขซ้ำกันทั้งหมด');

  const btn = el('pin-change-submit');
  if (btn) btn.disabled = true;

  try {
    const result = await gas.changeOwnPin(currentPin, newPin) || {};
    if (result.status === 'ok') {
      const user = pendingPinChange?.user;
      closePinChangeModal();
      Swal.fire({
        icon: 'success', title: 'ตั้ง PIN ใหม่แล้ว',
        text: 'ครั้งต่อไปให้ใช้ PIN ใหม่นี้เข้าสู่ระบบ',
        timer: 2200, showConfirmButton: false,
      });
      if (user) await startSession(user);
      return;
    }
    showError(result.message || 'เปลี่ยน PIN ไม่สำเร็จ กรุณาตรวจสอบ PIN ปัจจุบัน');
  } catch (e) {
    showError(e?.message || 'เปลี่ยน PIN ไม่สำเร็จ');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Idle timeout ──────────────────────────────────────────────────────────────

export function startIdleWatch() {
  stopIdleWatch();
  const reset = () => resetIdleTimers();
  ['click', 'keydown', 'pointerdown', 'scroll'].forEach(evt =>
    document.addEventListener(evt, reset, { passive: true }));
  state._idleReset = reset;
  resetIdleTimers();
}

function resetIdleTimers() {
  clearTimeout(idleTimer);
  clearTimeout(idleWarningTimer);
  idleWarningTimer = setTimeout(() => {
    Swal.fire({
      icon: 'warning',
      title: 'ใกล้ออกจากระบบอัตโนมัติ',
      text: 'ไม่มีการใช้งานมาสักพัก ระบบจะออกจากระบบใน 1 นาที',
      timer: IDLE_WARNING_MS,
      timerProgressBar: true,
      showConfirmButton: true,
      confirmButtonText: 'ใช้งานต่อ',
      confirmButtonColor: '#1e3a8a',
    });
  }, IDLE_LIMIT_MS - IDLE_WARNING_MS);

  idleTimer = setTimeout(async () => {
    await logout({ reason: 'idle' });
  }, IDLE_LIMIT_MS);
}

function stopIdleWatch() {
  clearTimeout(idleTimer);
  clearTimeout(idleWarningTimer);
  if (state._idleReset) {
    ['click', 'keydown', 'pointerdown', 'scroll'].forEach(evt =>
      document.removeEventListener(evt, state._idleReset));
    state._idleReset = null;
  }
}

// ── Session bootstrap ─────────────────────────────────────────────────────────

export async function checkSession() {
  try {
    const user = await gas.getSessionUser();
    if (!user) return;
    // รีเฟรชหน้าเพื่อข้ามการตั้ง PIN ใหม่ไม่ได้ — เซิร์ฟเวอร์ยังบล็อกทุกคำสั่งอื่นอยู่
    if (user.mustChangePin) {
      pendingPinChange = { identifier: user.username || user.email || '', currentPin: '', user };
      openPinChangeModal(true);
      return;
    }
    await startSession(user);
  } catch (e) {
    if (isAuthExpiredError(e)) {
      clearClientSession();
    } else {
      console.warn('Session check failed:', e.message);
    }
  }
}

export function isAuthExpiredError(error) {
  return /Unauthorized|Invalid or expired API session|Please login/i.test(error?.message || String(error || ''));
}

export function clearClientSession() {
  stopIdleWatch();
  sessionStorage.clear();
  state.pinInput = '';
  state.projects = [];
  state.users = [];
  state.currentProject = null;
  state.currentUserRole = null;
  state.currentUserName = null;
  state.currentUserId = null;
  pendingPinChange = null;
  closePinChangeModal();
  el('sidebar')?.classList.add('hidden');
  el('sidebar')?.classList.remove('drawer-open');
  el('mobile-overlay')?.classList.remove('active');
  el('top-header')?.classList.add('hidden');
  document.querySelector('.mobile-nav')?.classList.add('hidden');
  document.body.style.overflow = '';
  hideAllViews({ resetScroll: true });
  el('view-login')?.classList.remove('hidden');
  const identifier = el('login-identifier');
  if (identifier) identifier.value = '';
  setLoginError('');
  syncPinInputField();
  updatePinDisplay();
}

export async function logout({ reason } = {}) {
  try { await gas.logout(); } catch { /* ตัด session ฝั่ง client เสมอ */ }
  clearClientSession();
  if (reason === 'idle') {
    Swal.fire({
      icon: 'info',
      title: 'ออกจากระบบอัตโนมัติ',
      text: 'ไม่มีการใช้งานเกินเวลาที่กำหนด กรุณาเข้าสู่ระบบใหม่',
      confirmButtonColor: '#1e3a8a',
    });
  }
}

export function hideAllViews({ resetScroll = false } = {}) {
  ['view-login','view-dashboard','view-course-management','view-annual-plan','view-monthly-plan',
   'view-weekly-plan','view-users','view-settings','view-project-detail'].forEach(id => {
    el(id)?.classList.add('hidden');
  });
  // Keep the user's working position while views/data are being refreshed.
  // A deliberate reset is still available for flows such as logout.
  if (resetScroll) el('scroll-container')?.scrollTo(0, 0);
}

export function setHeader(title) {
  el('top-header')?.classList.remove('hidden');
  const headerTitle = el('header-title');
  if (headerTitle) headerTitle.innerText = title;
  el('sidebar')?.classList.remove('hidden');
  document.querySelector('.mobile-nav')?.classList.remove('hidden');
}

export function updateNavActive(activeId) {
  ['nav-dashboard','nav-courses','nav-annual','nav-monthly','nav-weekly','nav-users','nav-settings'].forEach(id => {
    const btn = el(id);
    if (!btn) return;
    btn.classList.toggle('active', id === activeId);
    btn.classList.toggle('text-blue-200', id !== activeId);
  });
}
