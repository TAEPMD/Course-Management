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
let pinRevealed = false;     // ปุ่ม "แสดง PIN" — เปลี่ยนจุด • เป็นตัวเลขในกล่อง

// ── Login form helpers ────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id); }

function setLoginError(message) {
  const box = el('login-error');
  if (!box) return;
  box.textContent = message || '';
  box.classList.toggle('hidden', !message);
  // บอกสถานะผิดพลาดที่ตัวช่องกรอกด้วย ไม่ใช่แค่ข้อความด้านล่าง
  el('pin-field')?.classList.toggle('has-error', !!message);
  el('login-pin-input')?.setAttribute('aria-invalid', message ? 'true' : 'false');
  if (message) el('pin-display')?.classList.add('pin-shake');
  setTimeout(() => el('pin-display')?.classList.remove('pin-shake'), 450);
}

/** ล้างข้อความผิดพลาดทันทีที่ผู้ใช้เริ่มแก้ไข — ไม่ให้ error ค้างจนสับสน */
export function clearLoginError() {
  if (!el('login-error')?.classList.contains('hidden')) setLoginError('');
}

function setLoginBusy(busy) {
  state.isLoggingIn = busy;
  // ต้องดูสถานะล็อกด้วย ไม่งั้น finally ของ processLogin จะปลดปุ่ม/แป้นคืน
  // ทั้งที่เพิ่งโดนล็อก — ผู้ใช้จะเห็นปุ่มกดได้แต่กดแล้วไม่มีอะไรเกิดขึ้น
  const locked = state.loginLockedUntil > Date.now();
  el('login-form')?.classList.toggle('is-busy', busy);
  setLoginInputsBlocked(busy || locked, locked);
  const submit = el('login-submit');
  if (submit) {
    submit.disabled = busy || locked;
    submit.setAttribute('aria-busy', String(busy));
  }
}

/** ปิด/เปิดการกรอกทั้งชุด (ใช้ทั้งตอนกำลังตรวจสอบ และตอนถูกล็อกชั่วคราว) */
function setLoginInputsBlocked(blocked, locked = blocked) {
  el('login-numpad')?.classList.toggle('opacity-50', blocked);
  el('login-numpad')?.classList.toggle('pointer-events-none', blocked);
  el('pin-field')?.classList.toggle('is-locked', locked);
  const pin = el('login-pin-input');
  if (pin) pin.disabled = locked; // ถูกล็อกแล้วต้องพิมพ์ไม่ได้จริง ๆ ไม่ใช่พิมพ์ได้แต่ไม่มีผล
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
    // สไตล์อยู่ใน style.css (บล็อก LOGIN UX PASS) ไม่ประกอบคลาส Tailwind ที่นี่
    btn.className = 'numpad-btn'
      + (k === 'C' ? ' numpad-btn-clear' : k === '<' ? ' numpad-btn-back' : '');
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
  clearLoginError();
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

/** ปุ่มแสดง/ซ่อน PIN — กล่องจะโชว์ตัวเลขจริงแทนจุดเมื่อเปิด */
export function setPinReveal(show) {
  pinRevealed = !!show;
  const btn = el('login-pin-toggle');
  if (btn) btn.setAttribute('aria-pressed', String(pinRevealed));
  const icon = el('login-pin-toggle-icon');
  if (icon) icon.className = pinRevealed ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
  const text = el('login-pin-toggle-text');
  if (text) text.textContent = pinRevealed ? 'ซ่อน PIN' : 'แสดง PIN';
  updatePinDisplay();
}

export function isPinRevealed() { return pinRevealed; }

export function updatePinDisplay() {
  const boxes = document.querySelectorAll('#pin-display .pin-box');
  boxes.forEach((box, i) => {
    const filled = i < state.pinInput.length;
    const isCurrent = i === state.pinInput.length;
    box.classList.toggle('filled', filled);
    box.classList.toggle('active-cursor', !filled && isCurrent);
    if (filled && pinRevealed) box.textContent = state.pinInput[i];
    else if (filled) box.innerHTML = '<span class="pin-dot"></span>';
    else box.textContent = '';
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

  const tick = () => {
    const remaining = Math.ceil((state.loginLockedUntil - Date.now()) / 1000);
    if (remaining <= 0) {
      clearInterval(lockTimer);
      lockTimer = null;
      state.loginLockedUntil = 0;
      box?.classList.add('hidden');
      setLoginInputsBlocked(false);
      if (el('login-submit')) el('login-submit').disabled = false;
      setLoginError('');
      el('login-pin-input')?.focus();
      return;
    }
    const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
    const ss = String(remaining % 60).padStart(2, '0');
    if (box) {
      box.classList.remove('hidden');
      box.innerHTML = `<i class="fa-solid fa-lock" aria-hidden="true"></i> ป้อนรหัสผิดหลายครั้ง — ลองใหม่ได้ในอีก <strong>${mm}:${ss}</strong>`;
    }
  };

  setLoginInputsBlocked(true);
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
  // gas.js แปลข้อความเป็นไทยแล้วติด code ไว้ — ต้องเช็ค code ก่อน ไม่งั้น
  // การจับ pattern อังกฤษจะพลาดทุกครั้งที่ error ผ่าน toApiError มา
  if (error?.code === gas.AUTH_EXPIRED) return true;
  return /Unauthorized|Invalid or expired API session|Please login|Session หมดอายุ/i
    .test(error?.message || String(error || ''));
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
  setLoginBusy(false);
  syncPinInputField();
  setPinReveal(false); // ไม่ทิ้งสถานะ "แสดง PIN" ค้างไว้ให้ผู้ใช้คนถัดไป
  identifier?.focus();
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
