/**
 * api/gas.js — Vercel serverless proxy ไปยัง Google Apps Script
 *
 * ชั้นนี้ทำหน้าที่ด้านความปลอดภัยด้วย:
 *  - แปลง session token เป็น httpOnly cookie (หน้าเว็บไม่เคยเห็น token)
 *  - จำกัดจำนวนครั้งการล็อกอินต่อ IP + ส่ง fingerprint ให้ GAS ทำ lockout
 *  - อนุญาตเฉพาะ action ที่รู้จัก และตรวจ CSRF
 *  - ไม่ส่งรายละเอียด error ภายในกลับไปให้ client
 */
import {
  buildGasPayload,
  csrfError,
  loginRateLimited,
  securityHeaders,
  sessionCookie,
} from './_authProxy.js';

const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL || process.env.VITE_GAS_WEB_APP_URL;
const MAX_BODY_BYTES = 10 * 1024 * 1024; // ไฟล์แนบ base64

function send(res, status, body, extraHeaders = {}) {
  for (const [key, value] of Object.entries({ ...securityHeaders, ...extraHeaders })) {
    res.setHeader(key, value);
  }
  res.status(status).json(body);
}

function rawBody(req) {
  if (req.body !== undefined && req.body !== null && req.body !== '') return req.body;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) reject(new Error('Payload too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return send(res, 405, { ok: false, error: 'Method not allowed' }, { Allow: 'POST' });
  }
  if (!GAS_WEB_APP_URL) {
    return send(res, 503, { ok: false, error: 'Backend ยังไม่ได้ตั้งค่า (GAS_WEB_APP_URL)' });
  }

  const csrf = csrfError(req);
  if (csrf) return send(res, 403, { ok: false, error: 'Request rejected' });

  let body;
  try {
    body = await rawBody(req);
  } catch {
    return send(res, 413, { ok: false, error: 'Payload too large' });
  }

  const built = buildGasPayload(req, body);
  if (built.error) return send(res, built.status, { ok: false, error: built.error });

  if (built.action === 'login') {
    const retryAfter = loginRateLimited(req);
    if (retryAfter) {
      return send(res, 429, {
        ok: true,
        result: { status: 'locked', retryAfter },
      }, { 'Retry-After': String(retryAfter) });
    }
  }

  let data;
  try {
    const response = await fetch(GAS_WEB_APP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(built.payload),
    });
    const text = await response.text();
    try {
      data = JSON.parse(text);
    } catch {
      console.error('[gas-proxy] non-JSON response from GAS:', text.slice(0, 500));
      return send(res, 502, { ok: false, error: 'Backend ตอบกลับไม่ถูกต้อง' });
    }
  } catch (error) {
    console.error('[gas-proxy] request failed:', error?.message);
    return send(res, 502, { ok: false, error: 'ติดต่อ backend ไม่สำเร็จ' });
  }

  const secure = (req.headers['x-forwarded-proto'] || 'https') !== 'http';
  const cookies = [];

  // token ไม่เคยถูกส่งกลับไปให้ browser — เก็บลง httpOnly cookie แทน
  if (built.action === 'login' && data?.ok && data.result?.token) {
    cookies.push(sessionCookie(data.result.token, { secure }));
    delete data.result.token;
  }
  if (built.action === 'logout') {
    cookies.push(sessionCookie('', { secure }));
  }
  // session หมดอายุ/ถูกเพิกถอน → ล้าง cookie ทิ้งเลย
  if (data?.ok === false && /Unauthorized|expired|Please login/i.test(String(data.error || ''))) {
    cookies.push(sessionCookie('', { secure }));
  }
  if (cookies.length) res.setHeader('Set-Cookie', cookies);

  const status = data?.ok === false && /Unauthorized/i.test(String(data.error || '')) ? 401 : 200;
  return send(res, status, data);
}
