/**
 * _authProxy.js — ตัวช่วยด้านความปลอดภัยของชั้น proxy
 *
 * ใช้ร่วมกันระหว่าง Vercel serverless (api/gas.js) และ Vite dev middleware
 * (vite.config.js) เพื่อให้ dev กับ production มีพฤติกรรมเดียวกัน
 *
 * หน้าที่:
 *  - เก็บ session token ไว้ใน httpOnly cookie (JavaScript ในหน้าเว็บอ่านไม่ได้ → กัน XSS ขโมย token)
 *  - จำกัดจำนวนครั้งการล็อกอินต่อ IP
 *  - อนุญาตเฉพาะ action ที่รู้จัก และกัน CSRF
 *  - ผูก client fingerprint (IP+UA) ส่งให้ GAS ใช้ทำ lockout
 */
import crypto from 'node:crypto';

export const SESSION_COOKIE = 'niem_sid';
const SESSION_MAX_AGE = 8 * 60 * 60; // 8 ชั่วโมง — ตรงกับ absolute timeout ฝั่ง GAS

/** action ที่ client เรียกได้ (นอกเหนือจากนี้ตอบ 400 ทันที) */
const ALLOWED_ACTIONS = new Set([
  'login', 'getSessionUser', 'logout', 'changeOwnPin', 'getPublicSettings',
  'getSystemSettings', 'saveSystemSetting',
  'getProjects', 'saveProject', 'deleteProject',
  'getUsers', 'saveUserBackend', 'deleteUserBackend',
  'uploadFile', 'deleteFile',
]);

const PUBLIC_ACTIONS = new Set(['login', 'getPublicSettings', 'getSessionUser', 'logout']);

/** ล็อกอินผิดได้กี่ครั้งต่อ IP ในหนึ่งช่วงเวลา (ด่านแรก — GAS มีด่านที่สองที่แม่นกว่า) */
const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_MAX_LOGIN_ATTEMPTS = 30;
const ipHits = new Map(); // best-effort ต่ออินสแตนซ์ — ไม่ใช่ด่านเดียวที่มี

function pepper() {
  return process.env.PROXY_FINGERPRINT_SALT || process.env.GAS_WEB_APP_URL || 'niem-local-dev';
}

export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  if (Array.isArray(forwarded) && forwarded.length) return String(forwarded[0]).trim();
  return req.socket?.remoteAddress || '';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** ลายนิ้วมือปลายทาง — ส่งให้ GAS ใช้นับความพยายามล็อกอิน (ไม่ส่ง IP ดิบออกไป) */
export function clientMeta(req) {
  const ua = String(req.headers['user-agent'] || '');
  return {
    client: sha256(clientIp(req) + '|' + pepper()).slice(0, 32),
    ua: sha256(ua + '|' + pepper()).slice(0, 32),
  };
}

export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return '';
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return '';
}

export function sessionCookie(token, { secure = true } = {}) {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/api', // ส่งเฉพาะตอนเรียก API — ไฟล์ static ไม่ต้องเห็น cookie นี้
    `Max-Age=${token ? SESSION_MAX_AGE : 0}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/** ตรวจ CSRF: ต้องมา from same-origin และมี custom header ที่ cross-site form ส่งไม่ได้ */
export function csrfError(req) {
  if (String(req.headers['x-requested-with'] || '') !== 'niem-app') {
    return 'Missing X-Requested-With header';
  }
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    try {
      if (new URL(origin).host !== String(host)) return 'Cross-origin request rejected';
    } catch {
      return 'Invalid Origin header';
    }
  }
  return '';
}

/** จำกัดจำนวนครั้งของ action ล็อกอินต่อ IP (in-memory, best effort) */
export function loginRateLimited(req) {
  const key = clientIp(req) || 'unknown';
  const now = Date.now();
  const hit = ipHits.get(key);

  if (!hit || now - hit.start > IP_WINDOW_MS) {
    ipHits.set(key, { start: now, count: 1 });
    if (ipHits.size > 5000) ipHits.clear(); // กันหน่วยความจำบวม
    return 0;
  }
  hit.count += 1;
  if (hit.count > IP_MAX_LOGIN_ATTEMPTS) {
    return Math.ceil((IP_WINDOW_MS - (now - hit.start)) / 1000);
  }
  return 0;
}

/**
 * ตรวจ payload จาก client และประกอบ payload ที่จะส่งต่อให้ GAS
 * คืน { error } ถ้าไม่ผ่าน, คืน { action, payload } ถ้าผ่าน
 */
export function buildGasPayload(req, rawBody) {
  let body;
  try {
    body = typeof rawBody === 'string' ? (rawBody ? JSON.parse(rawBody) : {}) : (rawBody || {});
  } catch {
    return { error: 'Invalid JSON body', status: 400 };
  }

  const action = String(body.action || '');
  if (!ALLOWED_ACTIONS.has(action)) return { error: 'Unsupported action', status: 400 };
  if (body.args !== undefined && !Array.isArray(body.args)) {
    return { error: 'Invalid args', status: 400 };
  }

  // token มาจาก httpOnly cookie เท่านั้น — ค่าที่ client ส่งมาถูกทิ้งทั้งหมด
  const token = readCookie(req, SESSION_COOKIE);
  if (!token && !PUBLIC_ACTIONS.has(action)) {
    return { error: 'Unauthorized: Please login', status: 401 };
  }

  return {
    action,
    payload: {
      action,
      args: body.args || [],
      token,
      meta: clientMeta(req), // ทับ meta ที่ client ส่งมาเสมอ
    },
  };
}

export const securityHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  'Pragma': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
