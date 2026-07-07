/**
 * Code.gs — Google Apps Script Backend for NIEM Course Management
 *
 * วิธีใช้:
 * 1. เปิด script.google.com → New project
 * 2. วางโค้ดนี้ลงใน Code.gs
 * 3. ตั้งค่า SHEET_ID และ DRIVE_FOLDER_ID ด้านล่าง
 * 4. Deploy → New deployment → Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. คัดลอก Web App URL ไปใส่ใน .env (VITE_GAS_WEB_APP_URL=...)
 *
 * ──────────────────────────────────────────────────────────────
 * Google Sheet URL ตัวอย่าง:
 *   https://docs.google.com/spreadsheets/d/[SHEET_ID]/edit
 * Google Drive Folder URL ตัวอย่าง:
 *   https://drive.google.com/drive/folders/[FOLDER_ID]
 */

// ═══════════════════════════════════════════════════════════════
//  CONFIG — กรอกค่าที่นี่
// ═══════════════════════════════════════════════════════════════
const SHEET_ID        = '14pnJIOtxAdB34vatsIbirQScQJCx1GsTugdYUx1Ezl0';
const DRIVE_FOLDER_ID = '1tPyqVLInpB-Tu8oAYh7yY3alK99jAGrM';

// ═══════════════════════════════════════════════════════════════
//  ENTRY POINT
// ═══════════════════════════════════════════════════════════════
function doPost(e) {
  try {
    if (!e.postData || !e.postData.contents) {
      return jsonResponse({ ok: false, error: 'No request body' });
    }
    const req  = JSON.parse(e.postData.contents);
    const { action, args = [] } = req;

    const handlers = {
      verifyPin, getSessionUser, logout,
      getSystemSettings, saveSystemSetting,
      getProjects, saveProject, deleteProject,
      getUsers, saveUserBackend, deleteUserBackend,
      uploadFile, deleteFile,
    };

    if (!handlers[action]) {
      return jsonResponse({ ok: false, error: 'Unknown action: ' + action });
    }

    const result = handlers[action](...args);
    return jsonResponse({ ok: true, result });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

function doGet(e) {
  return jsonResponse({ ok: true, status: 'NIEM GAS Web App is running' });
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════
//  UTILS — Sheets helpers
// ═══════════════════════════════════════════════════════════════
function getSheet(name) {
  if (SHEET_ID === 'YOUR_GOOGLE_SHEET_ID_HERE') {
    throw new Error('กรุณาตั้งค่า SHEET_ID ใน Code.gs');
  }
  const ss = SpreadsheetApp.openById(SHEET_ID);
  return ss.getSheetByName(name);
}

// อ่านทุก row, column B เป็น JSON object (users / projects)
function getAllRows(sheetName) {
  const sheet = getSheet(sheetName);
  if (!sheet) return [];
  const rows = sheet.getDataRange().getValues().slice(1); // skip header
  return rows.map(row => {
    try { return JSON.parse(String(row[1])); } catch { return null; }
  }).filter(Boolean);
}

// เพิ่ม/แก้ไข row: [id, json_blob]
function upsertRow(sheetName, id, obj) {
  const sheet = getSheet(sheetName);
  if (!sheet) throw new Error('ไม่พบ sheet: ' + sheetName);
  const rows = sheet.getDataRange().getValues();
  const json = JSON.stringify(obj);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) {
      sheet.getRange(i + 1, 1, 1, 2).setValues([[String(id), json]]);
      return;
    }
  }
  sheet.appendRow([String(id), json]);
}

// ลบ row ตาม id
function deleteRow(sheetName, id) {
  const sheet = getSheet(sheetName);
  if (!sheet) return;
  const rows = sheet.getDataRange().getValues();
  for (let i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][0]) === String(id)) {
      sheet.deleteRow(i + 1);
      return;
    }
  }
}

// SHA-256 hex (ตรงกับ crypto.subtle ใน browser)
function sha256hex(str) {
  const raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    str,
    Utilities.Charset.UTF_8
  );
  return raw.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

// ═══════════════════════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════════════════════
function verifyPin(pin) {
  const hash  = sha256hex(String(pin));
  const users = getAllRows('users');
  const user  = users.find(u => u.pinHash === hash);
  if (!user) return null;
  return { id: user.id, name: user.name, role: user.role, email: user.email || '' };
}

function getSessionUser() { return null; }
function logout()         { return true;  }

// ═══════════════════════════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════════════════════════
function getSystemSettings() {
  const sheet = getSheet('settings');
  if (!sheet) return {};
  const rows   = sheet.getDataRange().getValues().slice(1);
  const result = {};
  rows.forEach(([key, val]) => {
    if (!key) return;
    try   { result[String(key)] = JSON.parse(String(val)); }
    catch { result[String(key)] = String(val); }
  });
  return result;
}

function saveSystemSetting(key, value) {
  const sheet = getSheet('settings');
  if (!sheet) throw new Error('ไม่พบ sheet: settings');
  const rows = sheet.getDataRange().getValues();
  const json = JSON.stringify(value);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(key)) {
      sheet.getRange(i + 1, 2).setValue(json);
      return true;
    }
  }
  sheet.appendRow([String(key), json]);
  return true;
}

// ═══════════════════════════════════════════════════════════════
//  PROJECTS
// ═══════════════════════════════════════════════════════════════
function getProjects()           { return getAllRows('projects'); }
function saveProject(project)    { upsertRow('projects', project.id, project); return true; }
function deleteProject(id)       { deleteRow('projects', id); return true; }

// ═══════════════════════════════════════════════════════════════
//  USERS
// ═══════════════════════════════════════════════════════════════
function getUsers() {
  return getAllRows('users').map(u => {
    const { pinHash, ...safe } = u;
    return safe;
  });
}

function saveUserBackend(userData) {
  const { pin, ...rest } = userData;
  if (pin) {
    const pinHash = sha256hex(String(pin));
    upsertRow('users', userData.id, { ...rest, pinHash });
  } else {
    // ไม่ได้ระบุ PIN ใหม่ → เก็บ pinHash เดิมไว้
    const existing = getAllRows('users').find(u => u.id === userData.id);
    const pinHash  = existing ? existing.pinHash : '';
    upsertRow('users', userData.id, { ...rest, pinHash });
  }
  return true;
}

function deleteUserBackend(userId) { deleteRow('users', userId); return true; }

// ═══════════════════════════════════════════════════════════════
//  FILE UPLOAD (Google Drive)
// ═══════════════════════════════════════════════════════════════
function uploadFile(base64Data, filename) {
  if (DRIVE_FOLDER_ID === 'YOUR_GOOGLE_DRIVE_FOLDER_ID_HERE') {
    throw new Error('กรุณาตั้งค่า DRIVE_FOLDER_ID ใน Code.gs');
  }
  const ext = filename.split('.').pop().toLowerCase();
  const mimeMap = {
    pdf:  'application/pdf',
    png:  'image/png',
    jpg:  'image/jpeg',
    jpeg: 'image/jpeg',
    gif:  'image/gif',
    webp: 'image/webp',
    doc:  'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls:  'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  const mimeType = mimeMap[ext] || 'application/octet-stream';
  const blob   = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, filename);
  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const file   = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://drive.google.com/uc?export=view&id=' + file.getId();
}

function deleteFile(fileUrl) {
  if (!fileUrl || fileUrl.startsWith('data:')) return true;
  try {
    // รองรับทั้ง: ?id=xxx  และ  /d/xxx/
    const byQuery = fileUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    const byPath  = fileUrl.match(/\/d\/([a-zA-Z0-9_-]+)\//);
    const fileId  = (byQuery || byPath || [])[1];
    if (fileId) DriveApp.getFileById(fileId).setTrashed(true);
  } catch {}
  return true;
}

// ═══════════════════════════════════════════════════════════════
//  SETUP FUNCTIONS (รันครั้งเดียวจาก Apps Script editor)
// ═══════════════════════════════════════════════════════════════

/**
 * สร้าง sheets ที่จำเป็น (users, projects, settings)
 * รันจาก Apps Script editor → Run → setupSheets
 */
function setupSheets() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  [
    { name: 'users',    headers: ['id', 'data'] },
    { name: 'projects', headers: ['id', 'data'] },
    { name: 'settings', headers: ['key', 'value'] },
  ].forEach(({ name, headers }) => {
    if (!ss.getSheetByName(name)) {
      ss.insertSheet(name).appendRow(headers);
      Logger.log('Created sheet: ' + name);
    } else {
      Logger.log('Sheet already exists: ' + name);
    }
  });
  Logger.log('✅ setupSheets complete');
}

/**
 * สร้าง Admin user คนแรก
 * รันจาก Apps Script editor → Run → setupAdmin
 * แก้ไขค่าด้านล่างก่อนรัน
 */
function setupAdmin() {
  const name = 'ผู้ดูแลระบบ'; // ← แก้ไขชื่อ
  const role = 'admin';        // ← admin / staff / viewer
  const pin  = '';        // ← แก้ไข PIN (5 หลัก)

  if (!/^\d{5}$/.test(String(pin))) {
    throw new Error('Set a real 5-digit Admin PIN before running setupAdmin().');
  }

  const id      = 'user_' + Date.now();
  const pinHash = sha256hex(String(pin));
  upsertRow('users', id, { id, name, role, email: '', phone: '', pinHash });
  Logger.log('✅ Admin created: ' + name + ' | role: ' + role);
}
