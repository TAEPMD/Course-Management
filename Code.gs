// ==========================================
// สถาบันการแพทย์ฉุกเฉินแห่งชาติ (NIEM)
// ระบบบริหารจัดการหลักสูตรฝึกอบรม (Backend)
// ==========================================
// ⚡ Optimized: CacheService, LockService, batch I/O,
//    single Spreadsheet reference, structured error handling
// ==========================================

// --- Constants ---
const CACHE_TTL = 300;       // 5 minutes

// --- Security policy ---
const SESSION_IDLE_TTL     = 1800;   // 30 นาทีไม่มีการใช้งาน → session หมดอายุ
const SESSION_ABSOLUTE_TTL = 28800;  // 8 ชั่วโมงนับจาก login → หมดอายุเสมอ
const PIN_MIN_LENGTH       = 6;      // นโยบายใหม่: PIN อย่างน้อย 6 หลัก
const PIN_MAX_LENGTH       = 10;
/**
 * จำนวนรอบ HMAC-SHA256 ที่ใช้ hash PIN
 *
 * ⚠ อย่าเพิ่มค่านี้โดยไม่วัดเวลาจริงก่อน — `Utilities.computeHmacSha256Signature`
 * ใน Apps Script มี overhead ประมาณ 4 ms ต่อครั้ง ค่า 1024 รอบทำให้ login ใช้เวลา
 * ~8-12 วินาที ซึ่งเกินลิมิต Vercel serverless (10 วินาที) แล้วล็อกอินไม่ผ่านเลย
 *
 * 128 รอบ ≈ 0.5 วินาที · การลดค่านี้แทบไม่ลดความปลอดภัยจริง เพราะ PIN 6 หลัก
 * มีแค่ 10^6 ความเป็นไปได้ (ต่อให้ 1024 รอบก็ brute-force ได้ถ้าหลุดทั้ง pepper)
 * ด่านจริงคือ pepper ที่อยู่ใน ScriptProperties (ไม่ได้อยู่ในชีต) + การล็อกบัญชี
 *
 * จำนวนรอบถูกเก็บไว้ใน credential string (`v2$<iterations>$...`) ดังนั้นค่าเดิม
 * ยังตรวจผ่านได้ และจะถูกอัปเกรดให้เองตอนล็อกอินสำเร็จครั้งถัดไป
 */
const PIN_HASH_ITERATIONS  = 128;
const LOGIN_FAIL_WINDOW    = 900;    // นับความพยายามที่ล้มเหลวย้อนหลัง 15 นาที
const LOGIN_MAX_FAILS      = 5;      // ผิดครบ 5 ครั้ง → ล็อกบัญชีชั่วคราว
const LOGIN_LOCK_MAX       = 1800;   // ล็อกสูงสุด 30 นาที
const CLIENT_MAX_FAILS     = 20;     // ผิดรวมจากปลายทางเดียวกัน 20 ครั้ง → บล็อกปลายทาง
const CLIENT_LOCK_SECONDS  = 900;    // บล็อกปลายทาง 15 นาที
const AUTH_LOG_MAX_ROWS    = 5000;

const SHEET_PROJECTS = "Projects";
const SHEET_USERS = "Users";
const SHEET_REGS = "Registrations";
const SHEET_ATT = "Attendance";
const SHEET_AUTH_LOG = "AuthLog";

// คอลัมน์มาตรฐานของชีต Users (เพิ่มให้อัตโนมัติถ้ายังไม่มี)
const USER_HEADERS = ["UserID", "Name", "Role", "Email", "Phone", "PIN", "Username", "Status", "PinUpdatedAt"];

// สิทธิ์ขั้นต่ำของแต่ละ action (บังคับที่เซิร์ฟเวอร์ ไม่เชื่อ UI)
const ROLE_ADMIN_ONLY = ["Admin"];
const ROLE_EDITORS    = ["Admin", "Staff", "Instructor"];
const ROLE_APPROVERS  = ["Admin", "Staff"];

// --- สายอนุมัติงบประมาณ/เบิกจ่าย (ต้องตรงกับ src/utils/budgetWorkflow.js) ---
const BUDGET_WORKFLOW = ["requested", "approved", "obligated", "billed", "claiming", "paid"];
// สถานะที่ผู้ตั้งเรื่อง (เช่น Instructor) ยังแก้เนื้อรายการได้
const BUDGET_OPEN_STATUSES = ["requested", "rejected"];

// --- Shared Spreadsheet Accessor (ลดการเรียก getActiveSpreadsheet ซ้ำ) ---
function getSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet_(name) {
  const sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error("Sheet '" + name + "' not found. Please run setupDatabase() first.");
  return sheet;
}

function ensureProjectTasksColumn_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function(header) { return String(header || ""); });

  if (headers.indexOf("Tasks") > -1) return;

  sheet.getRange(1, lastCol + 1)
    .setValue("Tasks")
    .setFontWeight("bold")
    .setBackground("#1e3a8a")
    .setFontColor("#ffffff");
  cacheRemove_("projects");
  SpreadsheetApp.flush();
}

// --- Cache Helpers (ลดจำนวนครั้งที่อ่าน Sheet) ---
function cacheGet_(key) {
  try {
    const raw = CacheService.getUserCache().get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function cachePut_(key, obj, ttl) {
  try {
    CacheService.getUserCache().put(key, JSON.stringify(obj), ttl || CACHE_TTL);
  } catch (e) { /* Cache quota exceeded - silent fail */ }
}

function cacheRemove_(key) {
  try { CacheService.getUserCache().remove(key); } catch (e) {}
}

// ===========================================
//  CRYPTO HELPERS
// ===========================================

/**
 * Pepper ระดับสคริปต์ — เก็บใน ScriptProperties (ไม่ได้อยู่ในชีต)
 * ถ้าชีตหลุดออกไปแต่ไม่มี pepper ก็ยัง brute-force PIN ไม่ได้
 */
function getPepper_() {
  const props = PropertiesService.getScriptProperties();
  let pepper = props.getProperty("AUTH_PEPPER");
  if (!pepper) {
    pepper = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
    props.setProperty("AUTH_PEPPER", pepper);
  }
  return pepper;
}

function toHex_(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const v = (bytes[i] + 256) % 256;
    out += (v < 16 ? "0" : "") + v.toString(16);
  }
  return out;
}

function sha256Hex_(str) {
  return toHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(str), Utilities.Charset.UTF_8));
}

function randomToken_() {
  return sha256Hex_(Utilities.getUuid() + Utilities.getUuid() + Date.now() + getPepper_());
}

/** HMAC-SHA256 วนซ้ำ (key = salt + pepper) — ชะลอการ brute-force ถ้าชีตหลุด */
function hashPin_(pin, salt, iterations) {
  const keyBytes = Utilities.newBlob(String(salt) + "|" + getPepper_()).getBytes();
  let bytes = Utilities.computeHmacSha256Signature(
    Utilities.newBlob("niem$" + String(pin)).getBytes(), keyBytes);
  for (let i = 1; i < iterations; i++) {
    bytes = Utilities.computeHmacSha256Signature(bytes, keyBytes);
  }
  return Utilities.base64Encode(bytes);
}

/** เปรียบเทียบแบบใช้เวลาคงที่ — ไม่รั่วข้อมูลผ่าน timing */
function timingSafeEqual_(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** สร้าง credential string รูปแบบ v2$<iterations>$<salt>$<hash> */
function makeCredential_(pin) {
  const salt = Utilities.getUuid().replace(/-/g, "");
  return "v2$" + PIN_HASH_ITERATIONS + "$" + salt + "$" + hashPin_(pin, salt, PIN_HASH_ITERATIONS);
}

/**
 * ตรวจ PIN กับค่าที่เก็บไว้
 * รองรับของเดิม: plaintext PIN และ sha256 hex (จาก Code.gs รุ่นเก่า)
 * → ถ้าตรงแบบเก่า จะคืน legacy = true เพื่ออัปเกรดเป็น v2 ทันที
 */
function verifyCredential_(pin, stored) {
  stored = String(stored || "").trim();
  if (!stored) return { ok: false, legacy: false, iterations: 0 };

  if (stored.indexOf("v2$") === 0) {
    const parts = stored.split("$");
    const iterations = parseInt(parts[1], 10) || PIN_HASH_ITERATIONS;
    return {
      ok: timingSafeEqual_(hashPin_(pin, parts[2], iterations), parts[3] || ""),
      legacy: false,
      iterations: iterations
    };
  }
  if (/^[0-9]{4,10}$/.test(stored)) {
    return { ok: timingSafeEqual_(String(pin), stored), legacy: true, iterations: 0 };
  }
  if (/^[a-f0-9]{64}$/i.test(stored)) {
    return { ok: timingSafeEqual_(sha256Hex_(pin), stored.toLowerCase()), legacy: true, iterations: 0 };
  }
  return { ok: false, legacy: false, iterations: 0 };
}

/** นโยบาย PIN — คืนข้อความเหตุผลถ้าไม่ผ่าน, คืน "" ถ้าผ่าน */
function validatePinPolicy_(pin) {
  const value = String(pin || "");
  if (!new RegExp("^[0-9]{" + PIN_MIN_LENGTH + "," + PIN_MAX_LENGTH + "}$").test(value)) {
    return "PIN ต้องเป็นตัวเลข " + PIN_MIN_LENGTH + "-" + PIN_MAX_LENGTH + " หลัก";
  }
  if (/^(\d)\1+$/.test(value)) return "PIN ห้ามเป็นตัวเลขซ้ำกันทั้งหมด";

  let ascending = true, descending = true;
  for (let i = 1; i < value.length; i++) {
    const diff = Number(value.charAt(i)) - Number(value.charAt(i - 1));
    if (diff !== 1) ascending = false;
    if (diff !== -1) descending = false;
  }
  if (ascending || descending) return "PIN ห้ามเป็นเลขเรียงกัน เช่น 123456";

  const banned = ["123456", "654321", "112233", "121212", "123123", "111222",
                  "102030", "159357", "147258", "246810", "999999", "000000"];
  if (banned.indexOf(value) > -1) return "PIN นี้ถูกใช้กันแพร่หลายเกินไป กรุณาเลือกใหม่";
  return "";
}

// ===========================================
//  BRUTE-FORCE PROTECTION
// ===========================================
function failKey_(kind, id) {
  return "authfail_" + kind + "_" + sha256Hex_(String(id).toLowerCase()).substring(0, 32);
}

function getFailState_(kind, id) {
  try {
    const raw = CacheService.getScriptCache().get(failKey_(kind, id));
    return raw ? JSON.parse(raw) : { fails: 0, lockUntil: 0 };
  } catch (e) { return { fails: 0, lockUntil: 0 }; }
}

function putFailState_(kind, id, stateObj) {
  try {
    CacheService.getScriptCache().put(
      failKey_(kind, id), JSON.stringify(stateObj), LOGIN_FAIL_WINDOW);
  } catch (e) { /* cache quota — ไม่ให้ล้มทั้ง request */ }
}

function clearFailState_(kind, id) {
  try { CacheService.getScriptCache().remove(failKey_(kind, id)); } catch (e) {}
}

/** วินาทีที่ยังต้องรอ (0 = ไม่ถูกล็อก) */
function lockRemaining_(kind, id) {
  const st = getFailState_(kind, id);
  const now = Math.floor(Date.now() / 1000);
  return st.lockUntil > now ? st.lockUntil - now : 0;
}

function registerFail_(kind, id, maxFails, lockSeconds) {
  const st = getFailState_(kind, id);
  const now = Math.floor(Date.now() / 1000);
  st.fails = (st.fails || 0) + 1;
  if (st.fails >= maxFails) {
    const escalated = lockSeconds
      ? lockSeconds
      : Math.min(LOGIN_LOCK_MAX, 60 * Math.pow(2, st.fails - maxFails));
    st.lockUntil = now + escalated;
  }
  putFailState_(kind, id, st);
  return st;
}

// ===========================================
//  AUDIT LOG
// ===========================================
function authLog_(event, detail) {
  try {
    const ss = getSpreadsheet_();
    let sheet = ss.getSheetByName(SHEET_AUTH_LOG);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_AUTH_LOG);
      sheet.getRange(1, 1, 1, 6)
        .setValues([["Timestamp", "Event", "Identifier", "UserID", "Client", "Detail"]])
        .setFontWeight("bold").setBackground("#7f1d1d").setFontColor("#ffffff");
    }
    detail = detail || {};
    sheet.appendRow([
      new Date(),
      String(event),
      String(detail.identifier || ""),
      String(detail.userId || ""),
      String(detail.client || ""),
      String(detail.note || "")
    ]);
    if (sheet.getLastRow() > AUTH_LOG_MAX_ROWS && Math.random() < 0.1) {
      sheet.deleteRows(2, sheet.getLastRow() - AUTH_LOG_MAX_ROWS);
    }
  } catch (e) {
    Logger.log("authLog_ error: " + e.toString());
  }
}

// ===========================================
//  SESSION MANAGEMENT
// ===========================================
/**
 * เก็บเฉพาะ hash ของ token (cache หลุด = เอา token ไปใช้ไม่ได้)
 * epoch ใช้ตัดทุก session พร้อมกันเมื่อจำเป็น
 */
function sessionEpoch_() {
  return PropertiesService.getScriptProperties().getProperty("SESSION_EPOCH") || "1";
}

function sessionKey_(token) {
  return "sess" + sessionEpoch_() + "_" + sha256Hex_(token);
}

function createApiSession_(user, meta, mustChangePin) {
  const token = randomToken_();
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    user: user,
    iat: now,
    exp: now + SESSION_ABSOLUTE_TTL,
    seen: now,
    ua: (meta && meta.ua) || "",
    mcp: !!mustChangePin // ยังต้องตั้ง PIN ใหม่ก่อนใช้งานส่วนอื่น
  };
  CacheService.getScriptCache().put(sessionKey_(token), JSON.stringify(payload), SESSION_IDLE_TTL);
  return token;
}

/** ปลดสถานะ "ต้องเปลี่ยน PIN" หลังตั้ง PIN ใหม่สำเร็จ */
function clearMustChangePin_(token) {
  if (!token) return;
  const cache = CacheService.getScriptCache();
  const raw = cache.get(sessionKey_(token));
  if (!raw) return;
  try {
    const payload = JSON.parse(raw);
    payload.mcp = false;
    cache.put(sessionKey_(token), JSON.stringify(payload), SESSION_IDLE_TTL);
  } catch (e) { /* session จะหมดอายุเองอยู่แล้ว */ }
}

/** อ่าน session + ต่ออายุแบบ sliding (idle timeout) และบังคับ absolute timeout */
function getApiSession_(token, meta) {
  if (!token) return null;
  const cache = CacheService.getScriptCache();
  const raw = cache.get(sessionKey_(token));
  if (!raw) return null;

  let payload;
  try { payload = JSON.parse(raw); } catch (e) { return null; }

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || now >= payload.exp) {
    cache.remove(sessionKey_(token));
    return null;
  }
  // ผูก session กับ user-agent — token ที่ถูกขโมยไปใช้ที่เครื่องอื่นจะใช้ไม่ได้
  if (payload.ua && meta && meta.ua && payload.ua !== meta.ua) {
    authLog_("session_ua_mismatch", { userId: payload.user && payload.user.id, client: (meta && meta.client) || "" });
    cache.remove(sessionKey_(token));
    return null;
  }

  payload.seen = now;
  cache.put(sessionKey_(token), JSON.stringify(payload), SESSION_IDLE_TTL);

  const user = payload.user || {};
  user.mustChangePin = !!payload.mcp;
  return user;
}

function revokeApiSession_(token) {
  if (!token) return;
  try { CacheService.getScriptCache().remove(sessionKey_(token)); } catch (e) {}
}

function requireApiSession_(token, meta) {
  const session = getApiSession_(token, meta);
  if (!session) throw new Error("Unauthorized: Invalid or expired API session");
  return session;
}

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===========================================
//  AUTHORIZATION
// ===========================================
function normalizeRole_(role) {
  const r = String(role || "").trim().toLowerCase();
  if (r === "admin" || r === "ผู้ดูแลระบบ") return "Admin";
  if (r === "staff") return "Staff";
  if (r === "instructor") return "Instructor";
  if (r === "trainee") return "Trainee";
  return r ? String(role).trim() : "Trainee";
}

function checkAuth(sessionOverride) {
  if (sessionOverride) return sessionOverride;
  // โหมด HtmlService (google.script.run) — session ผูกกับผู้ใช้ Google ที่เรียก
  const session = PropertiesService.getUserProperties().getProperty("auth_session");
  if (!session) throw new Error("Unauthorized: Please login with PIN");
  return JSON.parse(session);
}

function requireRole_(session, allowedRoles) {
  const user = checkAuth(session);
  const role = normalizeRole_(user && user.role);
  if (allowedRoles.indexOf(role) === -1) {
    authLog_("forbidden", { userId: user && user.id, note: role });
    throw new Error("Forbidden: บัญชีนี้ไม่มีสิทธิ์ดำเนินการนี้");
  }
  return user;
}

// ===========================================
//  USERS SHEET ACCESS
// ===========================================
/** เพิ่มคอลัมน์ที่ขาด (Username/Status/PinUpdatedAt) ให้ชีตเดิมโดยไม่ทำข้อมูลเดิมเสีย */
function ensureUserColumns_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h || "").trim(); });

  let added = false;
  for (let i = 0; i < USER_HEADERS.length; i++) {
    if (headers.indexOf(USER_HEADERS[i]) === -1) {
      sheet.getRange(1, headers.length + 1)
        .setValue(USER_HEADERS[i])
        .setFontWeight("bold").setBackground("#0f766e").setFontColor("#ffffff");
      headers.push(USER_HEADERS[i]);
      added = true;
    }
  }
  if (added) {
    cacheRemove_("users");
    SpreadsheetApp.flush();
  }

  const index = {};
  for (let j = 0; j < headers.length; j++) index[headers[j]] = j;
  return index;
}

/** อ่านผู้ใช้ทั้งหมดพร้อม credential (ใช้ภายในเท่านั้น — ห้ามส่งออก API) */
function readUserRows_() {
  const sheet = getSheet_(SHEET_USERS);
  const col = ensureUserColumns_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { sheet: sheet, col: col, rows: [] };

  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const rows = [];
  for (let i = 0; i < values.length; i++) {
    if (!values[i][col.UserID]) continue;
    rows.push({
      rowNumber: i + 2,
      id:         String(values[i][col.UserID]),
      name:       String(values[i][col.Name] || ""),
      role:       normalizeRole_(values[i][col.Role]),
      email:      String(values[i][col.Email] || ""),
      phone:      String(values[i][col.Phone] || ""),
      credential: String(values[i][col.PIN] || ""),
      username:   String(values[i][col.Username] || ""),
      status:     String(values[i][col.Status] || "active"),
      pinUpdatedAt: values[i][col.PinUpdatedAt] || ""
    });
  }
  return { sheet: sheet, col: col, rows: rows };
}

function publicUser_(row) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    email: row.email,
    phone: row.phone,
    username: row.username,
    status: row.status
  };
}

// ===========================================
//  LOGIN
// ===========================================
/**
 * เข้าสู่ระบบด้วย (ชื่อผู้ใช้ | อีเมล | ชื่อ-สกุล) + PIN
 * คืน object เดียวเสมอ — ไม่บอกว่าบัญชีมีอยู่จริงหรือไม่ (กัน user enumeration)
 *   { status: 'ok' | 'invalid' | 'locked' | 'disabled' | 'must_change_pin', ... }
 */
function login(identifier, pin, meta) {
  meta = meta || {};
  const id = String(identifier || "").trim();
  const client = String(meta.client || "");

  if (!id || !/^[0-9]{4,10}$/.test(String(pin || ""))) {
    return { status: "invalid" };
  }

  // 1) ปลายทางถูกบล็อกอยู่หรือไม่
  if (client) {
    const clientWait = lockRemaining_("client", client);
    if (clientWait > 0) return { status: "locked", retryAfter: clientWait };
  }
  // 2) บัญชีนี้ถูกล็อกชั่วคราวหรือไม่
  const idWait = lockRemaining_("identity", id);
  if (idWait > 0) {
    authLog_("login_locked", { identifier: id, client: client });
    return { status: "locked", retryAfter: idWait };
  }

  // ไม่ใช้ LockService ที่นี่ — login เป็นการอ่านล้วน (การเขียนมีแค่ตอนอัปเกรด
  // credential ซึ่งจับ lock ของตัวเอง) ถ้าล็อกทั้งก้อนไว้ ผู้ใช้ที่ล็อกอินพร้อมกัน
  // จะต่อคิวกันทีละคน แล้วคนท้าย ๆ จะโดน waitLock timeout กลายเป็น "PIN ไม่ถูกต้อง"
  try {
    const store = readUserRows_();
    const needle = id.toLowerCase();
    const candidates = store.rows.filter(function (row) {
      return [row.username, row.email, row.name].some(function (field) {
        return String(field || "").trim().toLowerCase() === needle;
      });
    });

    let matched = null, legacy = false, usedIterations = 0;
    for (let i = 0; i < candidates.length; i++) {
      const result = verifyCredential_(pin, candidates[i].credential);
      if (result.ok) {
        matched = candidates[i];
        legacy = result.legacy;
        usedIterations = result.iterations;
        break;
      }
    }
    // ไม่มีบัญชีตรง → ยังคำนวณ hash หลอกหนึ่งครั้ง ให้เวลาตอบสนองใกล้เคียงกัน
    if (!matched && candidates.length === 0) {
      hashPin_(pin, "dummy-salt-for-timing", PIN_HASH_ITERATIONS);
    }

    if (!matched) {
      registerFail_("identity", id, LOGIN_MAX_FAILS, 0);
      if (client) registerFail_("client", client, CLIENT_MAX_FAILS, CLIENT_LOCK_SECONDS);
      authLog_("login_failed", { identifier: id, client: client });
      const wait = lockRemaining_("identity", id);
      return wait > 0 ? { status: "locked", retryAfter: wait } : { status: "invalid" };
    }

    if (String(matched.status || "active").toLowerCase() === "disabled") {
      authLog_("login_disabled", { identifier: id, userId: matched.id, client: client });
      return { status: "disabled" };
    }

    clearFailState_("identity", id);
    if (client) clearFailState_("client", client);

    const user = publicUser_(matched);
    // PIN เดิมยังไม่ผ่านนโยบายใหม่ → บังคับตั้งใหม่ก่อนใช้งาน
    const mustChangePin = legacy || String(pin).length < PIN_MIN_LENGTH || !!validatePinPolicy_(pin);
    const token = createApiSession_(user, meta, mustChangePin);
    authLog_("login_success", {
      identifier: id, userId: matched.id, client: client,
      note: mustChangePin ? "must_change_pin" : ""
    });

    // credential ที่ hash ไว้ด้วยจำนวนรอบเก่า (ช้า) → เขียนใหม่ด้วยค่าปัจจุบัน
    // ตอนนี้เรามี PIN ตัวจริงอยู่ในมือแล้ว จึง re-hash ได้โดยผู้ใช้ไม่ต้องทำอะไร
    if (!legacy && usedIterations && usedIterations !== PIN_HASH_ITERATIONS) {
      rehashCredential_(matched, pin);
    }

    return {
      status: mustChangePin ? "must_change_pin" : "ok",
      user: user,
      token: token,
      mustChangePin: mustChangePin,
      expiresIn: SESSION_IDLE_TTL
    };
  } catch (e) {
    Logger.log("login error: " + e.toString());
    return { status: "invalid" };
  }
}

/**
 * เขียน credential ใหม่ด้วยจำนวนรอบปัจจุบัน (เรียกหลังล็อกอินสำเร็จเท่านั้น)
 * ล้มเหลวก็ไม่เป็นไร — ผู้ใช้ล็อกอินผ่านแล้ว ครั้งหน้าค่อยลองใหม่
 */
function rehashCredential_(row, pin) {
  const lock = LockService.getDocumentLock();
  try { lock.waitLock(5000); } catch (e) { return; }
  try {
    const store = readUserRows_();
    const fresh = store.rows.filter(function (r) { return r.id === String(row.id); })[0];
    if (!fresh) return;
    store.sheet.getRange(fresh.rowNumber, store.col.PIN + 1).setValue(makeCredential_(pin));
    cacheRemove_("users");
    authLog_("pin_rehashed", { userId: row.id, note: "iterations=" + PIN_HASH_ITERATIONS });
  } catch (e) {
    Logger.log("rehashCredential_ error: " + e.toString());
  } finally {
    lock.releaseLock();
  }
}

/** เปลี่ยน PIN ของบัญชีที่ล็อกอินอยู่ (ต้องยืนยัน PIN ปัจจุบัน) */
function changeOwnPin(currentPin, newPin, session) {
  const user = checkAuth(session);
  const policyError = validatePinPolicy_(newPin);
  if (policyError) return { status: "weak", message: policyError };

  const lock = LockService.getDocumentLock();
  try { lock.waitLock(10000); } catch (e) { throw new Error("System busy"); }

  try {
    const store = readUserRows_();
    const row = store.rows.filter(function (r) { return r.id === String(user.id); })[0];
    if (!row) return { status: "invalid" };

    if (!verifyCredential_(currentPin, row.credential).ok) {
      registerFail_("identity", row.username || row.email || row.name || row.id, LOGIN_MAX_FAILS, 0);
      authLog_("pin_change_failed", { userId: row.id });
      return { status: "invalid" };
    }
    if (verifyCredential_(newPin, row.credential).ok) {
      return { status: "weak", message: "PIN ใหม่ต้องไม่ซ้ำกับ PIN เดิม" };
    }

    store.sheet.getRange(row.rowNumber, store.col.PIN + 1).setValue(makeCredential_(newPin));
    store.sheet.getRange(row.rowNumber, store.col.PinUpdatedAt + 1).setValue(new Date());
    cacheRemove_("users");
    SpreadsheetApp.flush();
    authLog_("pin_changed", { userId: row.id });
    return { status: "ok" };
  } finally {
    lock.releaseLock();
  }
}

function getSessionUser() {
  try {
    const session = PropertiesService.getUserProperties().getProperty("auth_session");
    return session ? JSON.parse(session) : null;
  } catch (e) { return null; }
}

function logout() {
  PropertiesService.getUserProperties().deleteProperty("auth_session");
  cacheRemove_("projects");
  cacheRemove_("users");
  return true;
}

/**
 * โหมด HtmlService: ล็อกอินแล้วเก็บ session ไว้ที่ UserProperties
 * (โหมดเว็บผ่าน proxy ใช้ doPost → login() แทน)
 */
function loginWithProperties(identifier, pin) {
  const result = login(identifier, pin, {});
  if (result.status === "ok" || result.status === "must_change_pin") {
    PropertiesService.getUserProperties().setProperty("auth_session", JSON.stringify(result.user));
    delete result.token; // โหมดนี้ไม่ใช้ bearer token
  }
  return result;
}

// --- Web App Entry ---
function doGet() {
  const html = HtmlService.createHtmlOutputFromFile('index')
    .setTitle('NIEM Training System - Course Management')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  return html;
}

function doPost(e) {
  try {
    const payload = e && e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
    const action = String(payload.action || '');
    const args = Array.isArray(payload.args) ? payload.args : [];
    const token = String(payload.token || '');
    // meta ถูกเติมโดย proxy เท่านั้น (client ปลอมไม่ได้ — proxy ทับค่าทิ้งเสมอ)
    const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};

    // --- Public endpoints (ไม่ต้องมี session) ---
    switch (action) {
      case 'login':
        return jsonResponse_({ ok: true, result: login(args[0], args[1], meta) });
      case 'verifyPin':
        // เวอร์ชันเก่าที่ล็อกอินด้วย PIN อย่างเดียว — ไม่รองรับแล้ว
        return jsonResponse_({ ok: true, result: { status: 'upgrade_required' } });
      case 'getSessionUser': {
        const current = getApiSession_(token, meta);
        return jsonResponse_({ ok: true, result: current });
      }
      case 'logout':
        revokeApiSession_(token);
        return jsonResponse_({ ok: true, result: true });
      case 'getPublicSettings':
        return jsonResponse_({ ok: true, result: getPublicSettings() });
    }

    // --- ต้องมี session ที่ยังไม่หมดอายุ ---
    const session = requireApiSession_(token, meta);

    // ยังไม่ได้ตั้ง PIN ใหม่ → ทำได้อย่างเดียวคือเปลี่ยน PIN (กันการรีเฟรชหน้าเพื่อข้ามขั้นตอน)
    if (session.mustChangePin && action !== 'changeOwnPin') {
      throw new Error("PIN_CHANGE_REQUIRED: กรุณาตั้งรหัส PIN ใหม่ก่อนใช้งาน");
    }

    switch (action) {
      case 'getSystemSettings':
        return jsonResponse_({ ok: true, result: getSystemSettings(session) });
      case 'saveSystemSetting':
        requireRole_(session, ROLE_ADMIN_ONLY);
        return jsonResponse_({ ok: true, result: saveSystemSetting(args[0], args[1], session) });
      case 'changeOwnPin': {
        const changed = changeOwnPin(args[0], args[1], session);
        if (changed && changed.status === 'ok') clearMustChangePin_(token);
        return jsonResponse_({ ok: true, result: changed });
      }
      case 'getProjects':
        return jsonResponse_({ ok: true, result: getProjects(session) });
      case 'saveProject':
        requireRole_(session, ROLE_EDITORS);
        return jsonResponse_({ ok: true, result: saveProject(args[0], session) });
      case 'deleteProject':
        requireRole_(session, ROLE_APPROVERS);
        return jsonResponse_({ ok: true, result: deleteProject(args[0], session) });
      case 'getUsers':
        requireRole_(session, ROLE_ADMIN_ONLY);
        return jsonResponse_({ ok: true, result: getUsers(session) });
      case 'saveUserBackend':
        requireRole_(session, ROLE_ADMIN_ONLY);
        return jsonResponse_({ ok: true, result: saveUserBackend(args[0], session) });
      case 'deleteUserBackend':
        requireRole_(session, ROLE_ADMIN_ONLY);
        return jsonResponse_({ ok: true, result: deleteUserBackend(args[0], session) });
      case 'uploadFile':
        requireRole_(session, ROLE_EDITORS);
        return jsonResponse_({ ok: true, result: uploadFile(args[0], args[1], session) });
      case 'deleteFile':
        requireRole_(session, ROLE_EDITORS);
        return jsonResponse_({ ok: true, result: deleteFile(args[0], session) });
      default:
        throw new Error('Unsupported action');
    }
  } catch (error) {
    Logger.log('doPost error: ' + error.toString());
    return jsonResponse_({ ok: false, error: error.message || String(error) });
  }
}

// --- Settings Storage ---
const ALLOWED_SETTING_KEYS = ["siteName", "logoUrl", "permissions"];

function saveSystemSetting(key, value, session) {
  requireRole_(session, ROLE_ADMIN_ONLY);
  if (ALLOWED_SETTING_KEYS.indexOf(String(key)) === -1) {
    throw new Error("ไม่อนุญาตให้บันทึกการตั้งค่านี้");
  }
  PropertiesService.getScriptProperties().setProperty(key, value);
  cacheRemove_("sys_settings");
  cacheRemove_("public_settings");
  SpreadsheetApp.flush();
  return true;
}

function brandingSettings_() {
  const props = PropertiesService.getScriptProperties().getProperties();
  let logoUrl = props.logoUrl || "";

  if (logoUrl.indexOf("drive.google.com") > -1) {
    const match = logoUrl.match(/id=([^&]+)/) || logoUrl.match(/\/d\/(.+?)\//);
    if (match && match[1]) {
      logoUrl = "https://lh3.googleusercontent.com/d/" + match[1];
    }
  }
  return { logoUrl: logoUrl, siteName: props.siteName || "NIEM" };
}

/** เฉพาะ branding — เปิดให้หน้า Login เรียกได้โดยไม่ต้องมี session */
function getPublicSettings() {
  const cached = cacheGet_("public_settings");
  if (cached) return cached;
  const result = brandingSettings_();
  cachePut_("public_settings", result, 600);
  return result;
}

/** การตั้งค่าทั้งหมด — ต้องล็อกอินก่อน และไม่คืนความลับใด ๆ (เช่น adminPin) */
function getSystemSettings(session) {
  checkAuth(session);

  const cached = cacheGet_("sys_settings");
  if (cached) return cached;

  const props = PropertiesService.getScriptProperties().getProperties();
  const branding = brandingSettings_();
  const result = {
    logoUrl: branding.logoUrl,
    siteName: branding.siteName,
    permissions: props.permissions ? JSON.parse(props.permissions) : null
  };
  cachePut_("sys_settings", result, 600); // Cache 10 min for settings
  return result;
}

// ===========================================
//  PROJECTS — Batch Read + Cache
// ===========================================
function getProjects(session) {
  checkAuth(session);

  const sheet = getSheet_(SHEET_PROJECTS);
  ensureProjectTasksColumn_(sheet);

  // ลอง cache ก่อน
  const cached = cacheGet_("projects");
  if (cached) {
    return cached.map(function(project) {
      project.tasks = project.tasks || [];
      return project;
    });
  }

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  // ⚡ อ่านทีเดียว: ตั้งแต่ row 2 ถึง lastRow, ทุกคอลัมน์ที่มี
  const lastCol = sheet.getLastColumn();
  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const projects = [];

  for (let i = 0; i < data.length; i++) {
    if (!data[i][0]) continue; // skip empty rows

    let docs = [], schedules = [], ledger = [], tasks = [];
    try { docs      = data[i][15] ? JSON.parse(data[i][15]) : []; } catch (e) {}
    try { schedules = data[i][16] ? JSON.parse(data[i][16]) : []; } catch (e) {}
    try { ledger    = data[i][17] ? JSON.parse(data[i][17]) : []; } catch (e) {}
    try { tasks     = data[i][18] ? JSON.parse(data[i][18]) : []; } catch (e) {}

    projects.push({
      id:         String(data[i][0]) || '-',
      name:       String(data[i][1]) || '-',
      year:       data[i][2] || '',
      status:     data[i][3] || 'ร่าง',
      people:     Number(data[i][4]) || 0,
      budget:     Number(data[i][5]) || 0,
      startMonth: Number(data[i][6]) || 1,
      endMonth:   Number(data[i][7]) || 12,
      health:     data[i][8]  || 'on-track',
      priority:   data[i][9]  || 'medium',
      progress:   Number(data[i][10]) || 0,
      cme:        Number(data[i][11]) || 0,
      category:   data[i][12] || 'basic',
      audience:   data[i][13] || 'all',
      assessment: data[i][14] || 'attendance',
      docs:       docs,
      schedules:  schedules,
      ledger:     ledger,
      tasks:      tasks
    });
  }

  cachePut_("projects", projects);
  return projects;
}

/** อ่าน ledger ที่เก็บอยู่จริงในชีตออกมาเป็น array (พังก็คืน array ว่าง) */
function parseLedger_(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function ledgerStatus_(entry) {
  if (entry && entry.status) return String(entry.status);
  return entry && entry.type === "income" ? "paid" : "requested";
}

/**
 * ด่านฝั่งเซิร์ฟเวอร์ของสายอนุมัติเบิกจ่าย
 *
 * ฝั่งหน้าเว็บซ่อนปุ่ม/ล็อกช่องให้แล้ว แต่ saveProject รับ ledger ทั้งก้อนมาเขียนทับ
 * ถ้าไม่ตรวจตรงนี้ ผู้ใช้ที่ไม่มีสิทธิ์ยิง API ตรง ๆ ก็ตั้งสถานะเป็น "จ่ายแล้ว" ได้เลย
 *
 * กติกาต้องตรงกับ getAllowedTransitions() ใน src/utils/budgetWorkflow.js
 */
function guardLedgerChanges_(incoming, existing, session) {
  const user = checkAuth(session);
  const role = normalizeRole_(user && user.role);
  const isApprover = ROLE_APPROVERS.indexOf(role) !== -1;
  const isAdmin = role === "Admin";
  if (isAdmin) return; // Admin แก้ได้ทุกอย่าง รวมถึงย้อนสถานะ

  const before = {};
  for (let i = 0; i < existing.length; i++) {
    const entry = existing[i];
    if (entry && entry.id) before[String(entry.id)] = entry;
  }

  const deny = function (message) {
    authLog_("budget_forbidden", { userId: user && user.id, note: role + ": " + message });
    throw new Error("Forbidden: " + message);
  };

  for (let i = 0; i < incoming.length; i++) {
    const entry = incoming[i] || {};
    const status = ledgerStatus_(entry);
    const prior = entry.id ? before[String(entry.id)] : null;

    // รายการใหม่ต้องเริ่มที่ "ขออนุมัติ" เสมอ (ยกเว้นรายรับ และผู้มีสิทธิ์อนุมัติ)
    if (!prior) {
      if (entry.type !== "income" && status !== "requested" && !isApprover) {
        deny("รายการใหม่ต้องเริ่มที่สถานะขออนุมัติ");
      }
      continue;
    }

    const priorStatus = ledgerStatus_(prior);

    if (status !== priorStatus) {
      if (!isApprover) deny("ไม่มีสิทธิ์เปลี่ยนสถานะรายการเบิกจ่าย");

      const from = BUDGET_WORKFLOW.indexOf(priorStatus);
      const to = BUDGET_WORKFLOW.indexOf(status);
      const forwardOneStep = from !== -1 && to === from + 1;
      const rejecting = status === "rejected" && priorStatus !== "paid";
      const reopening = priorStatus === "rejected" && status === "requested";

      if (!forwardOneStep && !rejecting && !reopening) {
        deny("เปลี่ยนสถานะข้ามขั้น: " + priorStatus + " → " + status);
      }
    }

    // อนุมัติแล้วขึ้นไป = เงินผูกพันแล้ว ผู้ที่ไม่ใช่ผู้อนุมัติห้ามแก้ตัวเลข/เอกสาร
    if (!isApprover && BUDGET_OPEN_STATUSES.indexOf(priorStatus) === -1) {
      const locked = ["amount", "desc", "payee", "cat", "type", "docNo", "paidDate", "payRef"];
      for (let f = 0; f < locked.length; f++) {
        const field = locked[f];
        if (String(entry[field] || "") !== String(prior[field] || "")) {
          deny("ไม่มีสิทธิ์แก้ " + field + " ของรายการที่อนุมัติแล้ว");
        }
      }
    }

    // จำนวนเงินติดลบไม่รับเด็ดขาด
    if (Number(entry.amount) < 0) deny("จำนวนเงินต้องไม่ติดลบ");
  }

  // ลบรายการที่ผูกพันแล้วต้องเป็นผู้มีสิทธิ์อนุมัติ
  if (!isApprover) {
    const stillThere = {};
    for (let i = 0; i < incoming.length; i++) {
      if (incoming[i] && incoming[i].id) stillThere[String(incoming[i].id)] = true;
    }
    for (const id in before) {
      if (!stillThere[id] && BUDGET_OPEN_STATUSES.indexOf(ledgerStatus_(before[id])) === -1) {
        deny("ไม่มีสิทธิ์ลบรายการที่อนุมัติแล้ว");
      }
    }
  }
}

function saveProject(p, session) {
  checkAuth(session);

  const lock = LockService.getDocumentLock();
  try { lock.waitLock(10000); } catch (e) {
    throw new Error("ระบบกำลังบันทึกข้อมูลอื่นอยู่ กรุณาลองอีกครั้ง");
  }

  try {
    const sheet = getSheet_(SHEET_PROJECTS);
    ensureProjectTasksColumn_(sheet);
    const data = sheet.getDataRange().getValues();
    let rowIndex = -1;

    let existingLedger = [];
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(p.id)) {
        rowIndex = i + 1;
        existingLedger = parseLedger_(data[i][17]);
        break;
      }
    }

    // ตรวจสายอนุมัติเบิกจ่ายก่อนเขียนทับ — UI ซ่อนปุ่มให้แล้วแต่ API ยังถูกยิงตรงได้
    guardLedgerChanges_(Array.isArray(p.ledger) ? p.ledger : [], existingLedger, session);

    const rowData = [
      p.id, p.name, p.year, p.status,
      Number(p.people) || 0, Number(p.budget) || 0,
      Number(p.startMonth) || 1, Number(p.endMonth) || 12,
      p.health || 'on-track', p.priority || 'medium',
      Number(p.progress) || 0, Number(p.cme) || 0,
      p.category || 'basic', p.audience || 'all', p.assessment || 'attendance',
      JSON.stringify(p.docs || []),
      JSON.stringify(p.schedules || []),
      JSON.stringify(p.ledger || []),
      JSON.stringify(p.tasks || [])
    ];

    if (rowIndex > -1) {
      sheet.getRange(rowIndex, 1, 1, rowData.length).setValues([rowData]);
    } else {
      sheet.appendRow(rowData);
    }

    // ⚡ เคลียร์ cache เพื่อให้ครั้งหน้าโหลดข้อมูลใหม่
    cacheRemove_("projects");
    SpreadsheetApp.flush(); // บังคับ write ทันที

    return true;
  } catch (e) {
    Logger.log("saveProject error: " + e.toString());
    // ข้อความ Forbidden ต้องส่งกลับตามเดิม ฝั่งหน้าเว็บใช้ตรวจเพื่อบอกว่า "ไม่มีสิทธิ์"
    if (String(e.message || "").indexOf("Forbidden") === 0) throw e;
    throw new Error("บันทึกโครงการล้มเหลว: " + e.message);
  } finally {
    lock.releaseLock();
  }
}

function deleteProject(projectId, session) {
  checkAuth(session);
  const lock = LockService.getDocumentLock();
  try { lock.waitLock(10000); } catch (e) { throw new Error("System busy"); }

  try {
    const sheet = getSheet_(SHEET_PROJECTS);
    const data = sheet.getDataRange().getValues();
    for (let i = data.length - 1; i >= 1; i--) {
      if (String(data[i][0]) === String(projectId)) {
        sheet.deleteRow(i + 1);
        cacheRemove_("projects");
        SpreadsheetApp.flush();
        return true;
      }
    }
    return false;
  } finally {
    lock.releaseLock();
  }
}

// ===========================================
//  USERS — Batch Read + Cache
// ===========================================
/** รายชื่อผู้ใช้สำหรับหน้าจัดการ — ไม่มี PIN/credential ออกไปเด็ดขาด */
function getUsers(session) {
  requireRole_(session, ROLE_ADMIN_ONLY);

  const cached = cacheGet_("users");
  if (cached) return cached;

  const store = readUserRows_();
  const users = store.rows.map(function (row) {
    const safe = publicUser_(row);
    safe.hasPin = !!row.credential;
    safe.pinUpdatedAt = row.pinUpdatedAt ? String(row.pinUpdatedAt) : "";
    return safe;
  });

  cachePut_("users", users);
  return users;
}

/**
 * บันทึกผู้ใช้ — PIN ถูก hash เสมอ, เว้นว่างไว้ = ไม่เปลี่ยน PIN เดิม
 * ป้องกันไม่ให้ Admin คนสุดท้ายถูกลดสิทธิ์/ปิดใช้งานจนไม่มีใครเข้าระบบได้
 */
function saveUserBackend(userData, session) {
  const actor = requireRole_(session, ROLE_ADMIN_ONLY);
  const lock = LockService.getDocumentLock();
  try { lock.waitLock(10000); } catch (e) { throw new Error("System busy"); }

  try {
    const store = readUserRows_();
    const col = store.col;
    const id = String(userData.id || "").trim();
    if (!id || !String(userData.name || "").trim()) {
      throw new Error("ต้องระบุรหัสผู้ใช้และชื่อ");
    }

    const existing = store.rows.filter(function (r) { return r.id === id; })[0];
    const role = normalizeRole_(userData.role);
    const username = String(userData.username || "").trim();
    const email = String(userData.email || "").trim();
    const status = String(userData.status || (existing && existing.status) || "active").toLowerCase() === "disabled"
      ? "disabled" : "active";

    if (username && !/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
      throw new Error("ชื่อผู้ใช้ต้องเป็น a-z 0-9 . _ - ความยาว 3-32 ตัว");
    }
    // ชื่อผู้ใช้/อีเมล ต้องไม่ซ้ำกับบัญชีอื่น (ไม่งั้นล็อกอินจะกำกวม)
    const clash = store.rows.filter(function (r) {
      if (r.id === id) return false;
      const keys = [r.username, r.email].map(function (v) { return String(v || "").trim().toLowerCase(); });
      return (username && keys.indexOf(username.toLowerCase()) > -1) ||
             (email && keys.indexOf(email.toLowerCase()) > -1);
    });
    if (clash.length) throw new Error("ชื่อผู้ใช้หรืออีเมลนี้ถูกใช้แล้ว");

    // credential: ตั้งใหม่เมื่อส่ง pin มาเท่านั้น
    let credential = existing ? existing.credential : "";
    let pinChanged = false;
    const newPin = String(userData.pin || "").trim();
    if (newPin) {
      const policyError = validatePinPolicy_(newPin);
      if (policyError) throw new Error(policyError);
      credential = makeCredential_(newPin);
      pinChanged = true;
    } else if (!existing) {
      throw new Error("ผู้ใช้ใหม่ต้องกำหนด PIN");
    }

    // กันไม่ให้เหลือ Admin ที่ใช้งานได้ 0 คน
    if (existing && normalizeRole_(existing.role) === "Admin" && (role !== "Admin" || status === "disabled")) {
      const otherAdmins = store.rows.filter(function (r) {
        return r.id !== id && normalizeRole_(r.role) === "Admin" && r.status !== "disabled";
      });
      if (!otherAdmins.length) throw new Error("ต้องมีผู้ดูแลระบบที่ใช้งานได้อย่างน้อย 1 บัญชี");
    }

    const write = function (rowNumber, key, value) {
      if (col[key] === undefined) return;
      store.sheet.getRange(rowNumber, col[key] + 1).setValue(value);
    };

    const rowNumber = existing ? existing.rowNumber : store.sheet.getLastRow() + 1;
    write(rowNumber, "UserID", id);
    write(rowNumber, "Name", String(userData.name).trim());
    write(rowNumber, "Role", role);
    write(rowNumber, "Email", email);
    write(rowNumber, "Phone", String(userData.phone || "-"));
    write(rowNumber, "PIN", credential);
    write(rowNumber, "Username", username);
    write(rowNumber, "Status", status);
    if (pinChanged) write(rowNumber, "PinUpdatedAt", new Date());

    cacheRemove_("users");
    SpreadsheetApp.flush();
    authLog_(existing ? "user_updated" : "user_created", {
      userId: actor.id, identifier: username || email || id,
      note: (pinChanged ? "pin_set " : "") + role + " " + status
    });
    return true;
  } catch (e) {
    Logger.log("saveUserBackend error: " + e.toString());
    throw new Error(e.message || "บันทึกผู้ใช้ล้มเหลว");
  } finally {
    lock.releaseLock();
  }
}

function deleteUserBackend(userId, session) {
  const actor = requireRole_(session, ROLE_ADMIN_ONLY);
  if (String(actor.id) === String(userId)) {
    throw new Error("ลบบัญชีที่กำลังใช้งานอยู่ไม่ได้");
  }
  const remaining = readUserRows_().rows.filter(function (r) {
    return r.id !== String(userId) && normalizeRole_(r.role) === "Admin" && r.status !== "disabled";
  });
  if (!remaining.length) throw new Error("ต้องมีผู้ดูแลระบบที่ใช้งานได้อย่างน้อย 1 บัญชี");
  authLog_("user_deleted", { userId: actor.id, identifier: String(userId) });

  const lock = LockService.getDocumentLock();
  try { lock.waitLock(10000); } catch (e) { throw new Error("System busy"); }

  try {
    const sheet = getSheet_(SHEET_USERS);
    const data = sheet.getDataRange().getValues();
    for (let i = data.length - 1; i >= 1; i--) {
      if (String(data[i][0]) === String(userId)) {
        sheet.deleteRow(i + 1);
        cacheRemove_("users");
        SpreadsheetApp.flush();
        return true;
      }
    }
    return false;
  } finally {
    lock.releaseLock();
  }
}

// ===========================================
//  FILE UPLOAD
// ===========================================
function getMimeType_(filename) {
  const ext = String(filename).split('.').pop().toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'txt') return 'text/plain';
  if (ext === 'doc') return 'application/msword';
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === 'xls') return 'application/vnd.ms-excel';
  if (ext === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return 'application/octet-stream';
}

function uploadFile(base64Data, filename, session) {
  checkAuth(session);
  try {
    // ⚡ ใช้ FolderId จาก PropertiesService แทนการค้นหาชื่อทุกครั้ง
    const props = PropertiesService.getScriptProperties();
    let folderId = props.getProperty("docsFolderId");
    let folder;

    if (folderId) {
      try { folder = DriveApp.getFolderById(folderId); }
      catch (e) { folderId = null; } // folder อาจถูกลบ
    }

    if (!folderId) {
      const folders = DriveApp.getFoldersByName("NIEM_Training_Docs");
      if (folders.hasNext()) {
        folder = folders.next();
      } else {
        folder = DriveApp.createFolder("NIEM_Training_Docs");
      }
      props.setProperty("docsFolderId", folder.getId());
    }

    const blob = Utilities.newBlob(
      Utilities.base64Decode(base64Data),
      getMimeType_(filename),
      filename
    );
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    return "https://drive.google.com/uc?export=download&id=" + file.getId();
  } catch (error) {
    Logger.log("uploadFile error: " + error.toString());
    throw new Error("Upload Failed: " + error.message);
  }
}

function deleteFile(fileId, session) {
  checkAuth(session);
  try {
    const file = DriveApp.getFileById(fileId);
    file.setTrashed(true);
    cacheRemove_("projects");
    SpreadsheetApp.flush();
    return true;
  } catch (error) {
    Logger.log("deleteFile error: " + error.toString());
    throw new Error("Delete Failed: " + error.message);
  }
}
// ===========================================
//  BATCH OPERATIONS — โหลดข้อมูลทั้งหมดในครั้งเดียว
// ===========================================
/**
 * ⚡ Frontend เรียกฟังก์ชันนี้ครั้งเดียวตอนเข้า Dashboard
 * แทนที่จะเรียก getProjects() + getSystemSettings() แยก 2 ครั้ง
 */
function getInitialData() {
  checkAuth();
  return {
    projects: getProjects(),
    settings: getSystemSettings(),
    user: getSessionUser()
  };
}

// ===========================================
//  DATABASE SETUP (รันครั้งแรก)
// ===========================================
function setupDatabase() {
  const ss = getSpreadsheet_();

  // -- Projects --
  let sheetProj = ss.getSheetByName(SHEET_PROJECTS);
  if (!sheetProj) sheetProj = ss.insertSheet(SHEET_PROJECTS);
  const headersProj = [
    "ID", "Name", "Year", "Status", "People", "Budget",
    "StartMonth", "EndMonth", "Health", "Priority", "Progress",
    "CME", "Category", "Audience", "Assessment",
    "Docs", "Schedules", "Ledger", "Tasks"
  ];
  sheetProj.getRange(1, 1, 1, headersProj.length)
    .setValues([headersProj]).setFontWeight("bold")
    .setBackground("#1e3a8a").setFontColor("#ffffff");

  // -- Users --
  let sheetUsers = ss.getSheetByName(SHEET_USERS);
  if (!sheetUsers) sheetUsers = ss.insertSheet(SHEET_USERS);
  sheetUsers.getRange(1, 1, 1, USER_HEADERS.length)
    .setValues([USER_HEADERS]).setFontWeight("bold")
    .setBackground("#0f766e").setFontColor("#ffffff");

  // Production: do not seed sample users. Add the first real Admin row in the Users sheet.

  // -- Registrations --
  let sheetReg = ss.getSheetByName(SHEET_REGS);
  if (!sheetReg) sheetReg = ss.insertSheet(SHEET_REGS);
  const headersReg = ["RegID", "ProjectID", "UserID", "RegDate", "Status", "PreTest", "PostTest", "Grade"];
  sheetReg.getRange(1, 1, 1, headersReg.length)
    .setValues([headersReg]).setFontWeight("bold")
    .setBackground("#b45309").setFontColor("#ffffff");

  // -- Attendance --
  let sheetAtt = ss.getSheetByName(SHEET_ATT);
  if (!sheetAtt) sheetAtt = ss.insertSheet(SHEET_ATT);
  const headersAtt = ["AttID", "ProjectID", "UserID", "CheckInTime", "CheckOutTime", "Date", "Location"];
  sheetAtt.getRange(1, 1, 1, headersAtt.length)
    .setValues([headersAtt]).setFontWeight("bold")
    .setBackground("#4338ca").setFontColor("#ffffff");

  // ลบ Sheet เริ่มต้น
  try { ss.deleteSheet(ss.getSheetByName("Sheet1")); } catch (e) {}
  try { ss.deleteSheet(ss.getSheetByName("แผ่นงาน1")); } catch (e) {}

  SpreadsheetApp.flush();
  Logger.log("✅ Database setup complete (Projects, Users, Registrations, Attendance)");
  return true;
}

// ===========================================
//  SECURITY MAINTENANCE (รันจาก Apps Script editor)
// ===========================================
/**
 * รันครั้งเดียวหลังอัปเดตโค้ดนี้:
 *  1) เพิ่มคอลัมน์ Username / Status / PinUpdatedAt
 *  2) แปลง PIN ที่เก็บเป็น plaintext/sha256 ให้เป็น hash แบบมี salt+pepper
 *  3) ลบ adminPin ที่ค้างอยู่ใน ScriptProperties
 *  4) เติม Username จากอีเมลให้บัญชีที่ยังไม่มี
 * PIN ของผู้ใช้ยังเป็นค่าเดิม — ระบบจะบังคับตั้ง PIN 6 หลักใหม่ตอนล็อกอินครั้งถัดไป
 */
function migrateSecurity() {
  const store = readUserRows_();
  const col = store.col;
  let hashed = 0, named = 0;

  store.rows.forEach(function (row) {
    const cred = String(row.credential || "").trim();
    if (cred && cred.indexOf("v2$") !== 0) {
      // plaintext → hash ทันที (ค่า PIN เดิมยังใช้ล็อกอินได้)
      const plain = /^[0-9]{4,10}$/.test(cred) ? cred : null;
      if (plain) {
        store.sheet.getRange(row.rowNumber, col.PIN + 1).setValue(makeCredential_(plain));
        hashed++;
      }
    }
    if (!String(row.username || "").trim()) {
      const fromEmail = String(row.email || "").split("@")[0].replace(/[^a-zA-Z0-9._-]/g, "");
      if (fromEmail.length >= 3) {
        store.sheet.getRange(row.rowNumber, col.Username + 1).setValue(fromEmail);
        named++;
      }
    }
    if (!String(row.status || "").trim()) {
      store.sheet.getRange(row.rowNumber, col.Status + 1).setValue("active");
    }
  });

  PropertiesService.getScriptProperties().deleteProperty("adminPin");
  getPepper_(); // สร้าง pepper ถ้ายังไม่มี
  cacheRemove_("users");
  cacheRemove_("sys_settings");
  cacheRemove_("public_settings");
  SpreadsheetApp.flush();

  const summary = "✅ migrateSecurity: hash PIN " + hashed + " บัญชี, ตั้ง username " + named + " บัญชี";
  Logger.log(summary);
  return summary;
}

/**
 * ดูว่าแต่ละบัญชีใช้อะไรล็อกอินได้บ้าง (รันจาก Apps Script editor → ดูผลใน Execution log)
 * ไม่แสดง PIN — บอกแค่ว่าเก็บเป็น hash แล้วหรือยัง
 */
function whoCanLogin() {
  const rows = readUserRows_().rows;
  if (!rows.length) {
    Logger.log("⚠️ ไม่มีผู้ใช้ในชีต Users เลย");
    return "no users";
  }
  Logger.log("ล็อกอินได้ด้วยค่าใดค่าหนึ่งในช่อง 'ชื่อผู้ใช้ หรือ อีเมล' ต่อไปนี้:");
  rows.forEach(function (r) {
    const cred = String(r.credential || "");
    Logger.log(
      "• " + (r.username || "(ยังไม่มี username)") +
      "  | อีเมล: " + (r.email || "-") +
      "  | ชื่อ: " + (r.name || "-") +
      "  | สิทธิ์: " + r.role +
      "  | สถานะ: " + r.status +
      "  | PIN: " + (!cred ? "ยังไม่ตั้ง" : (cred.indexOf("v2$") === 0 ? "hash แล้ว" : "ยังเป็น plaintext (ควรรัน migrateSecurity)"))
    );
  });
  return rows.length + " accounts";
}

/**
 * ตั้ง PIN ใหม่ให้บัญชีใดบัญชีหนึ่ง — ใช้กรณีลืม PIN จนเข้าระบบไม่ได้
 * รันจาก Apps Script editor เท่านั้น (ผู้ที่เปิด editor ได้คือเจ้าของสคริปต์อยู่แล้ว)
 *   ตัวอย่าง: resetUserPin("somchai", "481625")
 */
function resetUserPin(identifier, newPin) {
  const policyError = validatePinPolicy_(newPin);
  if (policyError) throw new Error(policyError);

  const store = readUserRows_();
  const needle = String(identifier || "").trim().toLowerCase();
  const row = store.rows.filter(function (r) {
    return [r.username, r.email, r.name, r.id].some(function (f) {
      return String(f || "").trim().toLowerCase() === needle;
    });
  })[0];
  if (!row) throw new Error("ไม่พบบัญชี: " + identifier);

  store.sheet.getRange(row.rowNumber, store.col.PIN + 1).setValue(makeCredential_(newPin));
  store.sheet.getRange(row.rowNumber, store.col.PinUpdatedAt + 1).setValue(new Date());
  if (String(row.status || "").toLowerCase() === "disabled") {
    store.sheet.getRange(row.rowNumber, store.col.Status + 1).setValue("active");
  }
  clearFailState_("identity", identifier); // ปลดล็อกบัญชีถ้าถูกล็อกอยู่
  cacheRemove_("users");
  SpreadsheetApp.flush();
  authLog_("pin_reset_by_owner", { userId: row.id, identifier: String(identifier) });

  const summary = "✅ ตั้ง PIN ใหม่ให้ " + (row.username || row.email || row.name) + " แล้ว";
  Logger.log(summary);
  return summary;
}

/**
 * เพิกถอนทุก session ทันที (เช่น สงสัยว่า token รั่ว) — PIN ไม่ถูกแตะต้อง
 * ทุกคนจะถูกเด้งออกและต้องล็อกอินใหม่
 */
function revokeAllSessions() {
  const props = PropertiesService.getScriptProperties();
  const next = String(Number(props.getProperty("SESSION_EPOCH") || "1") + 1);
  props.setProperty("SESSION_EPOCH", next);
  authLog_("sessions_revoked", { note: "epoch=" + next });
  Logger.log("✅ ตัดทุก session แล้ว (epoch " + next + ")");
  return true;
}
