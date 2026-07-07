/**
 * gas.js — Backend Bridge Layer
 *
 * Priority:
 *   1. GAS (google.script.run) — เมื่อ deploy ใน Google Apps Script
 *   2. Proxy (/api/gas)        — เมื่อตั้งค่า VITE_GAS_WEB_APP_URL ใน .env
 */

const isGAS = () => typeof google !== 'undefined' && google.script;
const API_TOKEN_KEY = 'niem_api_token';

function gasRun(funcName, ...args) {
  return new Promise((resolve, reject) => {
    google.script.run
      .withSuccessHandler(resolve)
      .withFailureHandler(reject)
      [funcName](...args);
  });
}

async function proxyRun(action, ...args) {
  const response = await fetch('/api/gas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action,
      args,
      token: sessionStorage.getItem(API_TOKEN_KEY) || '',
    }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `API error (${response.status})`);
  if (!data?.ok)    throw new Error(data?.error || 'API request failed');
  return data.result;
}

async function tryProxy(action, ...args) {
  if (isGAS() || typeof fetch !== 'function') {
    throw new Error('ไม่พบ backend สำหรับใช้งานจริง กรุณา deploy ผ่าน Google Apps Script หรือตั้งค่า VITE_GAS_WEB_APP_URL');
  }
  return proxyRun(action, ...args);
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function verifyPin(pin) {
  if (isGAS()) return gasRun('verifyPin', pin);
  const result = await tryProxy('verifyPin', pin);
  if (result?.token) sessionStorage.setItem(API_TOKEN_KEY, result.token);
  return result?.user ?? result;
}

export async function getSessionUser() {
  if (isGAS()) return gasRun('getSessionUser');
  return tryProxy('getSessionUser');
}

export async function logout() {
  if (isGAS()) { sessionStorage.removeItem(API_TOKEN_KEY); return gasRun('logout'); }
  try { await tryProxy('logout'); } catch {}
  sessionStorage.removeItem(API_TOKEN_KEY);
  return true;
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
  try {
    const resp = await fetch('/api/gas', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ action: 'getSessionUser', args: [] }),
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
    console.warn('[DB] checkConnection error:', err.message);
    window.__dbError = err.message;
    return 'error';
  }
}

export async function deleteFile(fileId) {
  if (isGAS()) return gasRun('deleteFile', fileId);
  return tryProxy('deleteFile', fileId);
}
