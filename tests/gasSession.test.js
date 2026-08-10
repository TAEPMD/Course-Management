/**
 * tests/gasSession.test.js
 * เทสต์ความคงทนของ session ฝั่ง Code.gs
 *
 * ปัญหาที่เทสต์ชุดนี้กัน: session เคยอยู่ใน CacheService อย่างเดียว ซึ่งเป็น
 * best-effort — Apps Script ล้างเมื่อไรก็ได้ และล้างยกชุดทุกครั้งที่ deploy
 * สคริปต์ใหม่ ผู้ใช้ที่ทำงานค้างอยู่จะโดนเด้ง "Session หมดอายุ" ทั้งที่ยังไม่หมด
 *
 * โหลด Code.gs เข้า vm พร้อม stub ของ Apps Script API (แนวเดียวกับ gasLedgerGuard)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadCodeGs() {
  const source = fs.readFileSync(path.join(root, 'Code.gs'), 'utf8');
  const logs = [];
  const cache = new Map();   // CacheService — ล้างได้ตลอดเวลา
  const props = new Map();   // ScriptProperties — ถาวร
  let now = 1_700_000_000_000;

  const noop = () => {};
  const sandbox = {
    console,
    logs,
    cache,
    props,
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => null }), flush: noop },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => { props.set(k, String(v)); },
        deleteProperty: (k) => { props.delete(k); },
        getProperties: () => Object.fromEntries(props),
      }),
      getUserProperties: () => ({ getProperty: () => null, setProperty: noop, deleteProperty: noop }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => { cache.set(k, String(v)); },
        remove: (k) => { cache.delete(k); },
      }),
    },
    LockService: { getDocumentLock: () => ({ waitLock: noop, releaseLock: noop }) },
    Utilities: {
      getUuid: () => 'uuid-0000',
      newBlob: (value) => ({ getBytes: () => Array.from(String(value)).map((c) => c.charCodeAt(0)) }),
      computeHmacSha256Signature: () => [1, 2, 3],
      computeDigest: (_alg, value) => Array.from(String(value)).map((c) => c.charCodeAt(0)),
      base64Encode: () => 'HASHED',
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
    },
    Logger: { log: (m) => logs.push(String(m)) },
    Session: { getActiveUser: () => ({ getEmail: () => '' }) },
    DriveApp: {},
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'Code.gs' });
  vm.runInContext('authLog_ = function (event) { logs.push(event); };', sandbox);

  return {
    sandbox,
    cache,
    props,
    logs,
    advance: (seconds) => { now += seconds * 1000; },
    call: (fn, ...args) => vm.runInContext(`(${fn})`, sandbox)(...args),
  };
}

const META = { ua: 'ua-hash', client: 'client-hash' };
const USER = { id: 'U1', name: 'สมชาย', role: 'Admin' };

test('cache ถูกล้าง (เช่น deploy ใหม่) — session ยังใช้ได้ต่อจากสำเนาถาวร', () => {
  const gas = loadCodeGs();
  const token = gas.call('createApiSession_', USER, META, false);

  gas.cache.clear(); // จำลอง Apps Script ล้าง cache ทั้งชุด
  const session = gas.call('getApiSession_', token, META);

  assert.ok(session, 'ต้องกู้ session คืนมาได้ ไม่ใช่เด้งออก');
  assert.equal(session.id, 'U1');
  assert.equal(gas.cache.size, 1, 'กู้แล้วต้องอุ่น cache กลับไปด้วย');
});

test('สำเนาถาวรยังบังคับ idle timeout 30 นาทีเหมือนเดิม', () => {
  const gas = loadCodeGs();
  const token = gas.call('createApiSession_', USER, META, false);

  gas.cache.clear();
  gas.advance(1801); // เกิน SESSION_IDLE_TTL
  assert.equal(gas.call('getApiSession_', token, META), null);
  assert.equal([...gas.props.keys()].filter((k) => /^sess\d+_/.test(k)).length, 0,
    'session ที่ตายแล้วต้องถูกลบสำเนาทิ้ง');
});

test('สำเนาถาวรยังบังคับ absolute timeout 8 ชั่วโมง', () => {
  const gas = loadCodeGs();
  const token = gas.call('createApiSession_', USER, META, false);

  for (let i = 0; i < 20; i += 1) { // ใช้งานต่อเนื่องทุก 25 นาที
    gas.advance(1500);
    gas.call('getApiSession_', token, META);
  }
  assert.equal(gas.call('getApiSession_', token, META), null, 'ครบ 8 ชม. ต้องหมดอายุ');
});

test('ใช้งานต่อเนื่องข้ามการล้าง cache หลายรอบ — ไม่หลุดกลางคัน', () => {
  const gas = loadCodeGs();
  const token = gas.call('createApiSession_', USER, META, false);

  for (let i = 0; i < 6; i += 1) {
    gas.advance(600); // 10 นาที
    gas.cache.clear();
    assert.ok(gas.call('getApiSession_', token, META), `รอบที่ ${i + 1} ต้องยังล็อกอินอยู่`);
  }
});

test('logout ลบทั้ง cache และสำเนาถาวร', () => {
  const gas = loadCodeGs();
  const token = gas.call('createApiSession_', USER, META, false);

  gas.call('revokeApiSession_', token);
  assert.equal(gas.cache.size, 0);
  assert.equal([...gas.props.keys()].filter((k) => /^sess\d+_/.test(k)).length, 0);
  assert.equal(gas.call('getApiSession_', token, META), null);
});

test('user-agent ไม่ตรง — ตัด session ทิ้งทั้งสองที่', () => {
  const gas = loadCodeGs();
  const token = gas.call('createApiSession_', USER, META, false);

  assert.equal(gas.call('getApiSession_', token, { ua: 'ua-อื่น', client: 'c' }), null);
  assert.equal(gas.cache.size, 0);
  assert.equal([...gas.props.keys()].filter((k) => /^sess\d+_/.test(k)).length, 0);
  assert.ok(gas.logs.includes('session_ua_mismatch'));
});

test('sweep เก็บกวาดเฉพาะสำเนาที่ตายแล้ว ไม่แตะ property อื่น', () => {
  const gas = loadCodeGs();
  gas.props.set('siteName', 'NIEM');
  gas.props.set('SESSION_EPOCH', '1');

  const live = gas.call('createApiSession_', USER, META, false);
  gas.props.set('sess1_dead', JSON.stringify({ user: USER, exp: 1, seen: 1 }));

  const removed = gas.call('sweepSessionCopies_', true);
  assert.equal(removed, 1);
  assert.equal(gas.props.get('siteName'), 'NIEM');
  assert.equal(gas.props.get('SESSION_EPOCH'), '1');
  assert.ok(gas.call('getApiSession_', live, META), 'session ที่ยังใช้งานอยู่ต้องไม่ถูกกวาด');
});

test('ตั้ง PIN ใหม่สำเร็จ — สถานะ mustChangePin ถูกปลดทั้งใน cache และสำเนา', () => {
  const gas = loadCodeGs();
  const token = gas.call('createApiSession_', USER, META, true);
  assert.equal(gas.call('getApiSession_', token, META).mustChangePin, true);

  gas.call('clearMustChangePin_', token);
  gas.cache.clear(); // บังคับให้อ่านจากสำเนาถาวร
  assert.equal(gas.call('getApiSession_', token, META).mustChangePin, false);
});

test('getPublicSettings บอกเวอร์ชันของ Code.gs ที่ deploy อยู่จริง (ไม่เอาค่าจาก cache)', () => {
  const gas = loadCodeGs();
  const first = gas.call('getPublicSettings');
  assert.ok(first.backendVersion, 'ต้องมี backendVersion ติดมาด้วย');

  // เรียกซ้ำ (คราวนี้ผ่าน cache) ต้องยังได้เวอร์ชันเดิม ไม่ใช่ undefined
  const second = gas.call('getPublicSettings');
  assert.equal(second.backendVersion, first.backendVersion);
});

test('เขียนสำเนา session ไม่สำเร็จ — ล็อกอินยังผ่าน และมีร่องรอยใน log', () => {
  const gas = loadCodeGs();
  vm.runInContext(
    'PropertiesService.getScriptProperties = function () {' +
    '  return { getProperty: function (k) { return k === "AUTH_PEPPER" ? "pepper" : null; },' +
    '           setProperty: function () { throw new Error("quota exceeded"); },' +
    '           deleteProperty: function () {},' +
    '           getProperties: function () { return {}; } };' +
    '};',
    gas.sandbox,
  );

  const token = gas.call('createApiSession_', USER, META, false);
  assert.ok(gas.call('getApiSession_', token, META), 'cache ยังใช้งานได้ตามปกติ');
  assert.ok(gas.logs.includes('session_copy_failed'), 'ต้องบันทึกไว้ว่าเขียนสำเนาไม่ได้');
});
