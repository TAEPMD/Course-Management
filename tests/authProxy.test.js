/**
 * tests/authProxy.test.js
 * เทสต์ชั้น proxy: cookie, CSRF, allowlist ของ action, rate limit
 * ดู docs/SECURITY.md ประกอบ
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_COOKIE,
  readCookie,
  sessionCookie,
  csrfError,
  buildGasPayload,
  loginRateLimited,
  clientIp,
  clientMeta,
} from '../api/_authProxy.js';

/** สร้าง request จำลองแบบย่อ */
function req(headers = {}, socket = { remoteAddress: '10.0.0.1' }) {
  return { headers: { 'x-requested-with': 'niem-app', ...headers }, socket };
}

// ── cookie ──────────────────────────────────────────────────────────────────

test('readCookie: อ่านค่าที่ต้องการจากหลาย cookie', () => {
  const r = req({ cookie: `foo=1; ${SESSION_COOKIE}=abc123; bar=2` });
  assert.equal(readCookie(r, SESSION_COOKIE), 'abc123');
  assert.equal(readCookie(r, 'foo'), '1');
});

test('readCookie: ไม่มี cookie header → สตริงว่าง', () => {
  assert.equal(readCookie(req(), SESSION_COOKIE), '');
  assert.equal(readCookie(req({ cookie: 'other=1' }), SESSION_COOKIE), '');
});

test('readCookie: decode ค่าที่ถูก URL-encode', () => {
  const r = req({ cookie: `${SESSION_COOKIE}=a%20b%2Bc` });
  assert.equal(readCookie(r, SESSION_COOKIE), 'a b+c');
});

test('readCookie: ไม่จับคู่ผิดกับ cookie ที่ชื่อขึ้นต้นเหมือนกัน', () => {
  const r = req({ cookie: `${SESSION_COOKIE}_other=nope; ${SESSION_COOKIE}=yes` });
  assert.equal(readCookie(r, SESSION_COOKIE), 'yes');
});

test('sessionCookie: ต้องเป็น HttpOnly + SameSite=Strict + Secure + จำกัด Path', () => {
  const cookie = sessionCookie('tok');
  assert.ok(cookie.includes('HttpOnly'), 'JS ในหน้าเว็บต้องอ่านไม่ได้');
  assert.ok(cookie.includes('SameSite=Strict'));
  assert.ok(cookie.includes('Secure'));
  assert.ok(cookie.includes('Path=/api'));
  assert.ok(cookie.startsWith(`${SESSION_COOKIE}=tok;`));
  assert.ok(/Max-Age=\d+/.test(cookie));
});

test('sessionCookie: ค่าว่าง = สั่งลบ cookie (Max-Age=0)', () => {
  assert.ok(sessionCookie('').includes('Max-Age=0'));
});

test('sessionCookie: dev ผ่าน http ไม่ต้องใส่ Secure', () => {
  assert.ok(!sessionCookie('tok', { secure: false }).includes('Secure'));
});

test('sessionCookie: token ถูก encode ก่อนใส่ลง header', () => {
  assert.ok(sessionCookie('a b;c').startsWith(`${SESSION_COOKIE}=a%20b%3Bc;`));
});

// ── CSRF ────────────────────────────────────────────────────────────────────

test('csrfError: ต้องมี X-Requested-With', () => {
  assert.match(csrfError({ headers: {} }), /X-Requested-With/);
  assert.match(csrfError({ headers: { 'x-requested-with': 'อย่างอื่น' } }), /X-Requested-With/);
  assert.equal(csrfError(req()), '');
});

test('csrfError: Origin ต่าง host ถูกปฏิเสธ', () => {
  const bad = req({ origin: 'https://evil.example', host: 'course.example' });
  assert.match(csrfError(bad), /Cross-origin/);
});

test('csrfError: Origin ตรงกับ host ผ่าน', () => {
  assert.equal(csrfError(req({ origin: 'https://course.example', host: 'course.example' })), '');
});

test('csrfError: เชื่อ x-forwarded-host ก่อน host (หลัง proxy ของ Vercel)', () => {
  const r = req({
    origin: 'https://course.example',
    host: 'internal.vercel',
    'x-forwarded-host': 'course.example',
  });
  assert.equal(csrfError(r), '');
});

test('csrfError: Origin ที่ parse ไม่ได้ถูกปฏิเสธ', () => {
  assert.match(csrfError(req({ origin: 'ไม่ใช่ url', host: 'course.example' })), /Invalid Origin/);
});

test('csrfError: ไม่มี Origin (same-origin fetch บางกรณี) ยังผ่านได้ถ้ามี header', () => {
  assert.equal(csrfError(req({ host: 'course.example' })), '');
});

// ── allowlist + payload ─────────────────────────────────────────────────────

const withSession = { cookie: `${SESSION_COOKIE}=tok-123` };

test('buildGasPayload: action นอก allowlist ถูกปฏิเสธ 400', () => {
  for (const action of ['evalScript', 'getUsersRaw', '', '__proto__']) {
    const out = buildGasPayload(req(withSession), JSON.stringify({ action }));
    assert.equal(out.status, 400, `action "${action}" ไม่ควรผ่าน`);
    assert.equal(out.error, 'Unsupported action');
  }
});

test('buildGasPayload: action ที่ต้องล็อกอิน แต่ไม่มี cookie → 401', () => {
  const out = buildGasPayload(req(), JSON.stringify({ action: 'getProjects' }));
  assert.equal(out.status, 401);
});

test('buildGasPayload: action สาธารณะเรียกได้โดยไม่มี session', () => {
  for (const action of ['login', 'getPublicSettings', 'getSessionUser', 'logout']) {
    const out = buildGasPayload(req(), JSON.stringify({ action }));
    assert.equal(out.error, undefined, `${action} ควรเรียกได้ตอนยังไม่ล็อกอิน`);
    assert.equal(out.action, action);
  }
});

test('buildGasPayload: token มาจาก cookie เท่านั้น — ที่ client ส่งมาถูกทิ้ง', () => {
  const out = buildGasPayload(
    req(withSession),
    JSON.stringify({ action: 'getProjects', token: 'token-ปลอม' })
  );
  assert.equal(out.payload.token, 'tok-123');
});

test('buildGasPayload: meta ที่ client ส่งมาถูกทับเสมอ', () => {
  const out = buildGasPayload(
    req(withSession),
    JSON.stringify({ action: 'getProjects', meta: { client: 'ปลอม', ua: 'ปลอม' } })
  );
  assert.notEqual(out.payload.meta.client, 'ปลอม');
  assert.notEqual(out.payload.meta.ua, 'ปลอม');
  assert.match(out.payload.meta.client, /^[0-9a-f]{32}$/);
});

test('buildGasPayload: args ที่ไม่ใช่ array ถูกปฏิเสธ', () => {
  const out = buildGasPayload(
    req(withSession),
    JSON.stringify({ action: 'getProjects', args: { evil: true } })
  );
  assert.equal(out.status, 400);
  assert.equal(out.error, 'Invalid args');
});

test('buildGasPayload: ไม่ส่ง args → กลายเป็น array ว่าง', () => {
  const out = buildGasPayload(req(withSession), JSON.stringify({ action: 'getProjects' }));
  assert.deepEqual(out.payload.args, []);
});

test('buildGasPayload: body ที่ไม่ใช่ JSON → 400', () => {
  const out = buildGasPayload(req(withSession), '{ พัง');
  assert.equal(out.status, 400);
  assert.equal(out.error, 'Invalid JSON body');
});

test('buildGasPayload: body ว่างถือเป็น object ว่าง (แล้วตกที่ allowlist)', () => {
  const out = buildGasPayload(req(withSession), '');
  assert.equal(out.error, 'Unsupported action');
});

test('buildGasPayload: รับ body ที่ parse มาแล้วได้ด้วย', () => {
  const out = buildGasPayload(req(withSession), { action: 'getProjects', args: [1] });
  assert.deepEqual(out.payload.args, [1]);
});

// ── fingerprint ─────────────────────────────────────────────────────────────

test('clientIp: ใช้ตัวแรกใน x-forwarded-for', () => {
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })), '1.2.3.4');
  assert.equal(clientIp(req({ 'x-forwarded-for': ['9.9.9.9'] })), '9.9.9.9');
  assert.equal(clientIp(req()), '10.0.0.1', 'ไม่มี header → ใช้ socket');
});

test('clientMeta: hash เสมอ ไม่ส่ง IP/UA ดิบออกไป', () => {
  const meta = clientMeta(req({ 'x-forwarded-for': '1.2.3.4', 'user-agent': 'Mozilla/5.0' }));
  assert.match(meta.client, /^[0-9a-f]{32}$/);
  assert.match(meta.ua, /^[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(meta).includes('1.2.3.4'));
  assert.ok(!JSON.stringify(meta).includes('Mozilla'));
});

test('clientMeta: IP เดียวกันได้ค่าเดิม, คนละ IP ได้คนละค่า', () => {
  const a = clientMeta(req({ 'x-forwarded-for': '1.1.1.1', 'user-agent': 'UA' }));
  const b = clientMeta(req({ 'x-forwarded-for': '1.1.1.1', 'user-agent': 'UA' }));
  const c = clientMeta(req({ 'x-forwarded-for': '2.2.2.2', 'user-agent': 'UA' }));
  assert.equal(a.client, b.client);
  assert.notEqual(a.client, c.client);
});

// ── rate limit ──────────────────────────────────────────────────────────────

test('loginRateLimited: ปล่อยผ่านช่วงแรก แล้วบล็อกเมื่อเกินโควตา', () => {
  // ใช้ IP เฉพาะของเทสต์นี้ กันชนกับเทสต์อื่น (ตัวนับเป็น state ระดับโมดูล)
  const ip = '203.0.113.77';
  const r = req({ 'x-forwarded-for': ip });

  for (let i = 0; i < 30; i += 1) {
    assert.equal(loginRateLimited(r), 0, `ครั้งที่ ${i + 1} ยังไม่ควรถูกบล็อก`);
  }
  const retryAfter = loginRateLimited(r);
  assert.ok(retryAfter > 0, 'ครั้งที่ 31 ต้องถูกบล็อก');
  assert.ok(retryAfter <= 15 * 60, 'บอกเวลารอไม่เกินความยาวหน้าต่าง');
});

test('loginRateLimited: แต่ละ IP นับแยกกัน', () => {
  const other = req({ 'x-forwarded-for': '203.0.113.88' });
  assert.equal(loginRateLimited(other), 0);
});
