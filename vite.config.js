import { defineConfig, loadEnv } from 'vite';
import https from 'node:https';
import http  from 'node:http';
import {
  buildGasPayload,
  csrfError,
  loginRateLimited,
  securityHeaders,
  sessionCookie,
} from './api/_authProxy.js';

/**
 * Vite dev middleware: /api/gas → VITE_GAS_WEB_APP_URL
 *
 * ใช้ตัวช่วยชุดเดียวกับ api/gas.js (cookie session, rate limit, CSRF, allowlist)
 * เพื่อให้ dev ทดสอบเส้นทางความปลอดภัยได้เหมือน production
 *
 * GAS Web App ส่ง HTTP 302 redirect เสมอ (แม้แต่ POST)
 * ใช้ Node.js HTTP โดยตรงเพื่อ follow redirect ได้อย่างถูกต้อง
 */
function gasProxyPlugin() {
  return {
    name: 'gas-proxy',
    configureServer(server) {
      server.middlewares.use('/api/gas', (req, res) => {
        const reply = (status, payload, extraHeaders = {}) => {
          res.writeHead(status, { ...securityHeaders, ...extraHeaders });
          res.end(JSON.stringify(payload));
        };

        const GAS_URL = process.env.VITE_GAS_WEB_APP_URL?.trim();
        if (!GAS_URL) {
          return reply(503, { ok: false, error: 'VITE_GAS_WEB_APP_URL ยังไม่ได้ตั้งค่าใน .env' });
        }
        if (req.method !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
        if (csrfError(req))        return reply(403, { ok: false, error: 'Request rejected' });

        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          const built = buildGasPayload(req, Buffer.concat(chunks).toString());
          if (built.error) return reply(built.status, { ok: false, error: built.error });

          if (built.action === 'login') {
            const retryAfter = loginRateLimited(req);
            if (retryAfter) {
              return reply(429, { ok: true, result: { status: 'locked', retryAfter } });
            }
          }

          gasRequest(GAS_URL, JSON.stringify(built.payload))
            .then(({ status, data }) => {
              let parsed;
              try { parsed = JSON.parse(data); }
              catch { return reply(502, { ok: false, error: 'Backend ตอบกลับไม่ถูกต้อง' }); }

              const cookies = [];
              if (built.action === 'login' && parsed?.ok && parsed.result?.token) {
                cookies.push(sessionCookie(parsed.result.token, { secure: false }));
                delete parsed.result.token;
              }
              if (built.action === 'logout') cookies.push(sessionCookie('', { secure: false }));
              if (parsed?.ok === false && /Unauthorized|expired|Please login/i.test(String(parsed.error || ''))) {
                cookies.push(sessionCookie('', { secure: false }));
              }
              reply(status === 200 ? 200 : status, parsed, cookies.length ? { 'Set-Cookie': cookies } : {});
            })
            .catch(err => {
              console.error('\n[GAS Proxy] ❌ Error:', err.message, '\n');
              reply(502, { ok: false, error: 'ติดต่อ backend ไม่สำเร็จ' });
            });
        });
      });
    },
  };
}

/**
 * POST ไปยัง GAS URL พร้อม follow redirect
 *
 * GAS flow:
 *   depth 0  → POST body ไปที่ script.google.com
 *   depth 1+ → GET ที่ redirect URL (script.googleusercontent.com)
 */
// GAS อาจรับ connection แล้วเงียบ — ถ้าไม่ตั้งเพดานเวลา dev server จะไม่ตอบกลับเลย
// และเบราว์เซอร์จะค้างที่หน้าโหลดแบบไม่มี error
const GAS_SOCKET_TIMEOUT_MS = 25000;

function gasRequest(url, body, depth = 0) {
  if (depth > 8) return Promise.reject(new Error('Too many redirects'));

  let u;
  try { u = new URL(url); }
  catch (e) { return Promise.reject(new Error('Invalid URL: ' + url)); }

  return new Promise((resolve, reject) => {
    const isPost = depth === 0 && !!body;
    const mod    = u.protocol === 'https:' ? https : http;
    const buf    = isPost ? Buffer.from(body) : null;

    const options = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   isPost ? 'POST' : 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NIEM-GAS-Proxy/1.0)',
        'Accept':     'application/json, text/plain, */*',
        ...(isPost ? {
          'Content-Type':   'application/json',
          'Content-Length': buf.length,
        } : {}),
      },
    };

    console.log(`[GAS Proxy] ${options.method} ${u.hostname}${u.pathname} (hop ${depth})`);

    const r = mod.request(options, resp => {
      const loc = resp.headers.location;

      if ([301, 302, 303, 307, 308].includes(resp.statusCode) && loc) {
        console.log(`[GAS Proxy]  → ${resp.statusCode} redirect → ${loc.substring(0, 80)}...`);
        resp.resume(); // drain to free socket

        // Resolve the redirect URL (absolute / protocol-relative / path-relative)
        let next;
        if (/^https?:\/\//i.test(loc))  next = loc;
        else if (loc.startsWith('//'))  next = u.protocol + loc;
        else                            next = `${u.protocol}//${u.host}${loc.startsWith('/') ? loc : '/' + loc}`;

        // 307/308 keep the original method; 301-303 switch to GET
        const keepBody = [307, 308].includes(resp.statusCode);
        gasRequest(next, keepBody ? body : null, depth + 1).then(resolve).catch(reject);
        return;
      }

      const parts = [];
      resp.on('data', c => parts.push(c));
      resp.on('end', () => {
        const data = Buffer.concat(parts).toString();
        console.log(`[GAS Proxy]  ← ${resp.statusCode} (${data.length} bytes)`);
        resolve({ status: resp.statusCode, data });
      });
    });

    r.setTimeout(GAS_SOCKET_TIMEOUT_MS, () => {
      console.error(`[GAS Proxy] ⏱ ไม่มีการตอบกลับใน ${GAS_SOCKET_TIMEOUT_MS / 1000}s (hop ${depth}) — ตัดการเชื่อมต่อ`);
      r.destroy(new Error(`GAS ไม่ตอบกลับภายใน ${GAS_SOCKET_TIMEOUT_MS / 1000} วินาที`));
    });

    r.on('error', err => {
      console.error(`[GAS Proxy] Network error at hop ${depth}:`, err.message);
      reject(err);
    });

    if (buf) r.write(buf);
    r.end();
  });
}

export default defineConfig(({ mode }) => {
  // Vite ไม่ได้ใส่ค่าจาก .env ลง process.env ให้เอง — dev proxy อ่านจากตรงนี้
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''));
  return {
    plugins: [gasProxyPlugin()],
    build: {
      outDir: 'dist',
    },
    server: {
      port: 3000,
      open: true,
    },
  };
});
