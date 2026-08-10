/**
 * gas.js — Backend Bridge Layer
 *
 * Priority:
 *   1. GAS (google.script.run) — เมื่อ deploy ใน Google Apps Script
 *   2. Proxy (/api/gas)        — เมื่อตั้งค่า VITE_GAS_WEB_APP_URL ใน .env
 */

const isGAS = () => typeof google !== 'undefined' && google.script;

function gasRun(funcName, ...args) {
  return new Promise((resolve, reject) => {
    google.script.run
      .withSuccessHandler(resolve)
      .withFailureHandler(reject)
      [funcName](...args);
  });
}

/**
 * เพดานเวลาต่อคำขอ — ถ้าไม่มี ตัว fetch จะค้างได้ไม่จำกัดเวลาเมื่อ backend
 * รับ connection แล้วเงียบหาย ทำให้หน้าเว็บค้างที่ "Verifying..." ตลอดไป
 */
const REQUEST_TIMEOUT_MS = 30000;
const UPLOAD_TIMEOUT_MS = 120000; // อัปโหลดไฟล์ base64 ใช้เวลานานกว่าปกติ

const SLOW_ACTIONS = new Set(['uploadFile']);

/**
 * Session token อยู่ใน httpOnly cookie ที่ proxy เป็นคนตั้ง —
 * โค้ดฝั่งหน้าเว็บอ่านไม่ได้ ทำให้ XSS ขโมย session ไม่ได้
 * X-Requested-With เป็นด่านกัน CSRF (ฟอร์มข้ามเว็บส่ง custom header ไม่ได้)
 */
async function proxyRun(action, ...args) {
  const limit = SLOW_ACTIONS.has(action) ? UPLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);

  let response;
  try {
    response = await fetch('/api/gas', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'niem-app',
      },
      body: JSON.stringify({ action, args }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`เซิร์ฟเวอร์ไม่ตอบกลับภายใน ${Math.round(limit / 1000)} วินาที — ` +
        'กรุณาลองใหม่ หรือตรวจว่า Apps Script Web App ถูก deploy แล้ว');
    }
    throw new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — กรุณาตรวจอินเทอร์เน็ตแล้วลองใหม่');
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json().catch(() => null);
  if (response.status === 429) {
    return data?.result ?? { status: 'locked', retryAfter: 60 };
  }
  if (!response.ok) throw await toApiError(data?.error || `API error (${response.status})`);
  if (!data?.ok)    throw await toApiError(data?.error || 'API request failed');
  return data.result;
}

/**
 * แปลง error จาก backend — ถ้า session หมดอายุ ให้เคลียร์ session
 * พากลับหน้า login และเปลี่ยนข้อความเป็นภาษาไทยที่เข้าใจง่าย
 *
 * หมายเหตุ: `import()` ข้างล่างเป็น dynamic import โดยตั้งใจ เพื่อตัดวงจร
 * auth.js → gas.js → auth.js — อย่าเปลี่ยนเป็น static import เพราะจะเกิด
 * circular dependency ตอนโหลดโมดูล (rollup จะเตือนเรื่อง chunk แต่ไม่มีผล
 * เพราะทั้งแอป bundle เป็น chunk เดียวอยู่แล้ว)
 */
async function toApiError(message) {
  if (/Forbidden/i.test(message)) {
    return new Error('บัญชีนี้ไม่มีสิทธิ์ดำเนินการนี้');
  }
  // เซิร์ฟเวอร์บล็อกทุกคำสั่งจนกว่าจะตั้ง PIN ใหม่
  if (/PIN_CHANGE_REQUIRED/i.test(message)) {
    try {
      const { openPinChangeModal } = await import('./modules/auth.js');
      openPinChangeModal(true);
    } catch { /* หน้า login ยังไม่พร้อม */ }
    return new Error('กรุณาตั้งรหัส PIN ใหม่ก่อนใช้งาน');
  }
  if (/Unauthorized|Invalid or expired API session|Please login/i.test(message)) {
    // สองกรณีนี้ข้อความหน้าเว็บเหมือนกันแต่แก้คนละทาง — ต้องแยกให้ออก
    //   no_cookie      : proxy ปฏิเสธเพราะคำขอไม่มี cookie session ติดมาเลย
    //   server_session : cookie มา แต่ GAS ไม่รู้จัก token นี้แล้ว
    const noCookie = /Please login/i.test(message);
    const reason = noCookie ? 'no_cookie' : 'server_session';
    const hint = (noCookie
      ? 'เบราว์เซอร์ไม่ได้แนบ cookie ของ session มากับคำขอ — ตรวจว่าเปิดผ่านโดเมนเดิม และไม่ได้บล็อกคุกกี้ไว้'
      : 'เซิร์ฟเวอร์ไม่พบ session นี้แล้ว — ไม่ได้ใช้งานเกิน 30 นาที ครบ 8 ชั่วโมง หรือ session ถูกล้างตอน deploy Apps Script ใหม่')
      + (backendVersion ? ` · backend ${backendVersion}` : ' · backend ไม่ระบุเวอร์ชัน (Code.gs ที่ deploy อยู่ยังเป็นรุ่นเก่า)');
    console.warn(`[auth] session rejected (${reason}) · backend:`, backendVersion || 'unknown', '·', message);

    try {
      const { clearClientSession } = await import('./modules/auth.js');
      clearClientSession();
    } catch { /* login view unavailable — still throw below */ }
    if (typeof Swal !== 'undefined') {
      Swal.fire({
        icon: 'info',
        title: 'Session หมดอายุ',
        text: 'กรุณาเข้าสู่ระบบใหม่ด้วย PIN',
        footer: hint,
        confirmButtonColor: '#1e3a8a',
      });
    }
    // ติด code ไว้ให้ตัวเรียกรู้ว่า "จัดการ + แจ้งผู้ใช้ไปแล้ว" — ห้ามดูจากข้อความ
    // เพราะข้อความถูกแปลเป็นไทยตรงนี้ ตัวจับ pattern ภาษาอังกฤษปลายทางจะพลาด
    // แล้วไปโผล่เป็นกล่องแดง "โหลดข้อมูลล้มเหลว" ทับกล่องนี้อีกที
    const expired = new Error('Session หมดอายุ กรุณาเข้าสู่ระบบใหม่');
    expired.code = AUTH_EXPIRED;
    expired.reason = reason;
    return expired;
  }
  return new Error(message);
}

/** error ที่ผ่าน toApiError แล้วและแจ้งผู้ใช้ไปแล้ว — ปลายทางไม่ต้องแจ้งซ้ำ */
export const AUTH_EXPIRED = 'AUTH_EXPIRED';

/**
 * เวอร์ชันของ Code.gs ที่ backend ตอบกลับมา (ตั้งค่าตอนโหลด branding)
 * Apps Script deploy ด้วยมือและมักลืมสร้าง version ใหม่ — ค่านี้บอกได้ทันที
 * ว่ากำลังคุยกับโค้ดรุ่นไหน โดยไม่ต้องเดา
 */
let backendVersion = '';

export function setBackendVersion(version) {
  backendVersion = String(version || '');
  console.info('[backend] version:', backendVersion || 'ไม่ระบุ (Code.gs รุ่นเก่ากว่าที่รายงานเวอร์ชัน)');
}

export function getBackendVersion() { return backendVersion; }

/**
 * แจ้ง error จาก API ให้ผู้ใช้ — เงียบไว้ถ้าเป็นกรณี session หมดอายุ
 * เพราะ toApiError แจ้งและพากลับหน้า login ไปแล้ว
 */
export function notifyApiError(title, error, options = {}) {
  if (error?.code === AUTH_EXPIRED) return;
  if (typeof Swal === 'undefined') return;
  Swal.fire({ icon: 'error', title, text: error?.message || String(error || ''), ...options });
}

async function tryProxy(action, ...args) {
  if (isGAS() || typeof fetch !== 'function') {
    throw new Error('ไม่พบ backend สำหรับใช้งานจริง กรุณา deploy ผ่าน Google Apps Script หรือตั้งค่า VITE_GAS_WEB_APP_URL');
  }
  return proxyRun(action, ...args);
}

// ── Auth ──────────────────────────────────────────────────────────────────────

/**
 * เข้าสู่ระบบ — คืน { status, user?, mustChangePin?, retryAfter? }
 * status: ok | must_change_pin | invalid | locked | disabled | upgrade_required
 */
export async function login(identifier, pin) {
  if (isGAS()) return gasRun('loginWithProperties', identifier, pin);
  return tryProxy('login', identifier, pin);
}

export async function changeOwnPin(currentPin, newPin) {
  if (isGAS()) return gasRun('changeOwnPin', currentPin, newPin);
  return tryProxy('changeOwnPin', currentPin, newPin);
}

export async function getSessionUser() {
  if (isGAS()) return gasRun('getSessionUser');
  return tryProxy('getSessionUser');
}

export async function logout() {
  if (isGAS()) return gasRun('logout');
  try { await tryProxy('logout'); } catch {}
  return true;
}

/** เฉพาะชื่อระบบ/โลโก้ — ใช้ตอนยังไม่ล็อกอิน */
export async function getPublicSettings() {
  if (isGAS()) return gasRun('getSystemSettings');
  return tryProxy('getPublicSettings');
}

// ── Settings ──────────────────────────────────────────────────────────────────

export async function getSystemSettings() {
  if (isGAS()) return gasRun('getSystemSettings');
  return tryProxy('getSystemSettings');
}

export async function saveSystemSetting(key, value) {
  if (isGAS()) return gasRun('saveSystemSetting', key, value);
  return tryProxy('saveSystemSetting', key, value);
}

// ── Projects ──────────────────────────────────────────────────────────────────

export async function getProjects() {
  if (isGAS()) return gasRun('getProjects');
  return tryProxy('getProjects');
}

export async function saveProject(project) {
  if (isGAS()) return gasRun('saveProject', project);
  return tryProxy('saveProject', project);
}

export async function deleteProject(projectId) {
  if (isGAS()) return gasRun('deleteProject', projectId);
  return tryProxy('deleteProject', projectId);
}

// ── Users ─────────────────────────────────────────────────────────────────────

export async function getUsers() {
  if (isGAS()) return gasRun('getUsers');
  return tryProxy('getUsers');
}

export async function saveUserBackend(userData) {
  if (isGAS()) return gasRun('saveUserBackend', userData);
  return tryProxy('saveUserBackend', userData);
}

export async function deleteUserBackend(userId) {
  if (isGAS()) return gasRun('deleteUserBackend', userId);
  return tryProxy('deleteUserBackend', userId);
}

// ── File Upload ───────────────────────────────────────────────────────────────

export async function uploadFile(base64Data, filename) {
  if (isGAS()) return gasRun('uploadFile', base64Data, filename);
  return tryProxy('uploadFile', base64Data, filename);
}

// ── Connection Check ──────────────────────────────────────────────────────────

/**
 * ตรวจสอบว่าแอปเชื่อมต่อกับ backend ไหน
 * Returns: 'gas' | 'sheets' | 'error'
 * Sets window.__dbError with detail message when returning 'error'
 */
export async function checkConnection() {
  if (isGAS()) return 'gas';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch('/api/gas', {
      method:  'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'niem-app' },
      body:    JSON.stringify({ action: 'getPublicSettings', args: [] }),
      signal:  controller.signal,
    });
    const data = await resp.json().catch(() => ({}));

    if (resp.status === 503) {
      const detail = data?.error || 'VITE_GAS_WEB_APP_URL ยังไม่ได้ตั้งค่า';
      console.warn('[DB] production backend unavailable:', detail);
      window.__dbError = detail;
      return 'error';
    }
    if (resp.ok) {
      console.info('[DB] เชื่อมต่อ Google Sheets สำเร็จ');
      return 'sheets';
    }
    // HTTP 502 = Vite proxy failed to reach GAS
    const detail = data?.error || `HTTP ${resp.status}`;
    console.warn('[DB] เชื่อมต่อ GAS ไม่ได้:', detail,
      '\n→ ดู log ใน terminal ที่รัน npm run dev เพื่อดูรายละเอียด');
    window.__dbError = detail;
    return 'error';
  } catch (err) {
    const detail = err?.name === 'AbortError'
      ? `backend ไม่ตอบกลับภายใน ${REQUEST_TIMEOUT_MS / 1000} วินาที`
      : err.message;
    console.warn('[DB] checkConnection error:', detail);
    window.__dbError = detail;
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}

export async function deleteFile(fileId) {
  if (isGAS()) return gasRun('deleteFile', fileId);
  return tryProxy('deleteFile', fileId);
}
