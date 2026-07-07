import { defineConfig } from 'vite';
import https from 'node:https';
import http  from 'node:http';

/**
 * Vite dev middleware: /api/gas → VITE_GAS_WEB_APP_URL
 *
 * GAS Web App ส่ง HTTP 302 redirect เสมอ (แม้แต่ POST)
 * ใช้ Node.js HTTP โดยตรงเพื่อ follow redirect ได้อย่างถูกต้อง
 */
function gasProxyPlugin() {
  return {
    name: 'gas-proxy',
    configureServer(server) {
      server.middlewares.use('/api/gas', (req, res) => {
        const GAS_URL = process.env.VITE_GAS_WEB_APP_URL?.trim();

        if (!GAS_URL) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            ok: false,
            error: 'VITE_GAS_WEB_APP_URL ยังไม่ได้ตั้งค่าใน .env',
          }));
        }

        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          gasRequest(GAS_URL, body)
            .then(({ status, data }) => {
              res.writeHead(status, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
              });
              res.end(data);
            })
            .catch(err => {
              console.error('\n[GAS Proxy] ❌ Error:', err.message, '\n');
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: `Proxy error: ${err.message}` }));
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

    r.on('error', err => {
      console.error(`[GAS Proxy] Network error at hop ${depth}:`, err.message);
      reject(err);
    });

    if (buf) r.write(buf);
    r.end();
  });
}

export default defineConfig({
  plugins: [gasProxyPlugin()],
  build: {
    outDir: 'dist',
  },
  server: {
    port: 3000,
    open: true,
  },
});
