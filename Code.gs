// ==========================================
// สถาบันการแพทย์ฉุกเฉินแห่งชาติ (NIEM)
// ระบบบริหารจัดการหลักสูตรฝึกอบรม (Backend)
// ==========================================
// ⚡ Optimized: CacheService, LockService, batch I/O,
//    single Spreadsheet reference, structured error handling
// ==========================================

// --- Constants ---
const ADMIN_PIN_HASH = "01a051099cc994df4d11037819699796af703f6532b9c564effc5c90fb89d265";
const CACHE_TTL = 300;       // 5 minutes
const API_SESSION_TTL = 21600; // 6 hours
const SHEET_PROJECTS = "Projects";
const SHEET_USERS = "Users";
const SHEET_REGS = "Registrations";
const SHEET_ATT = "Attendance";

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

// --- Security & Session Management ---
function checkAuth(sessionOverride) {
  if (sessionOverride) return sessionOverride;
  const session = PropertiesService.getUserProperties().getProperty("auth_session");
  if (!session) throw new Error("Unauthorized: Please login with PIN");
  return JSON.parse(session);
}

function authenticatePin_(inputPin) {
  const sheet = getSheet_(SHEET_USERS);
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][5]) === String(inputPin)) {
      return {
        id: String(data[i][0]),
        name: String(data[i][1]),
        role: String(data[i][2]),
        email: String(data[i][3])
      };
    }
  }

  return null;
}

function createApiSession_(user) {
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put("api_session_" + token, JSON.stringify(user), API_SESSION_TTL);
  return token;
}

function getApiSession_(token) {
  if (!token) return null;
  const raw = CacheService.getScriptCache().get("api_session_" + token);
  return raw ? JSON.parse(raw) : null;
}

function revokeApiSession_(token) {
  if (!token) return;
  CacheService.getScriptCache().remove("api_session_" + token);
}

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function requireApiSession_(token) {
  const session = getApiSession_(token);
  if (!session) throw new Error("Unauthorized: Invalid or expired API session");
  return session;
}

function verifyPin(inputPin) {
  const lock = LockService.getUserLock();
  try {
    lock.waitLock(5000); // ป้องกัน brute-force ซ้ำพร้อมกัน
  } catch (e) {
    return null; // ถ้ารอ lock ไม่ทัน ให้ถือว่าล้มเหลว
  }

  try {
    const user = authenticatePin_(inputPin);
    if (!user) return null;
    PropertiesService.getUserProperties().setProperty("auth_session", JSON.stringify(user));
    return user;
  } catch (e) {
    Logger.log("verifyPin error: " + e.toString());
    return null;
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
    const action = payload.action;
    const args = payload.args || [];
    const token = payload.token || '';

    switch (action) {
      case 'verifyPin': {
        const user = authenticatePin_(args[0]);
        if (!user) return jsonResponse_({ ok: true, result: null });
        return jsonResponse_({ ok: true, result: { user: user, token: createApiSession_(user) } });
      }
      case 'getSessionUser':
        return jsonResponse_({ ok: true, result: getApiSession_(token) });
      case 'logout':
        revokeApiSession_(token);
        return jsonResponse_({ ok: true, result: true });
      case 'getSystemSettings':
        return jsonResponse_({ ok: true, result: getSystemSettings() });
    }

    const session = requireApiSession_(token);

    switch (action) {
      case 'saveSystemSetting':
        return jsonResponse_({ ok: true, result: saveSystemSetting(args[0], args[1], session) });
      case 'getProjects':
        return jsonResponse_({ ok: true, result: getProjects(session) });
      case 'saveProject':
        return jsonResponse_({ ok: true, result: saveProject(args[0], session) });
      case 'deleteProject':
        return jsonResponse_({ ok: true, result: deleteProject(args[0], session) });
      case 'getUsers':
        return jsonResponse_({ ok: true, result: getUsers(session) });
      case 'saveUserBackend':
        return jsonResponse_({ ok: true, result: saveUserBackend(args[0], session) });
      case 'deleteUserBackend':
        return jsonResponse_({ ok: true, result: deleteUserBackend(args[0], session) });
      case 'uploadFile':
        return jsonResponse_({ ok: true, result: uploadFile(args[0], args[1], session) });
      case 'deleteFile':
        return jsonResponse_({ ok: true, result: deleteFile(args[0], session) });
      default:
        throw new Error('Unsupported action: ' + action);
    }
  } catch (error) {
    Logger.log('doPost error: ' + error.toString());
    return jsonResponse_({ ok: false, error: error.message || String(error) });
  }
}

// --- Settings Storage ---
function saveSystemSetting(key, value, session) {
  checkAuth(session);
  PropertiesService.getScriptProperties().setProperty(key, value);
  cacheRemove_("sys_settings");
  SpreadsheetApp.flush();
  return true;
}

function getSystemSettings() {
  // ไม่ใส่ checkAuth — Branding ต้องโหลดได้ตอนหน้า Login
  const cached = cacheGet_("sys_settings");
  if (cached) return cached;

  const props = PropertiesService.getScriptProperties().getProperties();
  let logoUrl = props.logoUrl || "";

  if (logoUrl.includes("drive.google.com")) {
    const match = logoUrl.match(/id=([^&]+)/) || logoUrl.match(/\/d\/(.+?)\//);
    if (match && match[1]) {
      logoUrl = "https://lh3.googleusercontent.com/d/" + match[1];
    }
  }

  const result = {
    logoUrl: logoUrl,
    siteName: props.siteName || "NIEM",
    adminPin: props.adminPin || "",
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

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(p.id)) {
        rowIndex = i + 1;
        break;
      }
    }

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
function getUsers(session) {
  checkAuth(session);

  const cached = cacheGet_("users");
  if (cached) return cached;

  const sheet = getSheet_(SHEET_USERS);
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  const data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
  const users = [];

  for (let i = 0; i < data.length; i++) {
    if (!data[i][0]) continue;
    users.push({
      id:    String(data[i][0]),
      name:  String(data[i][1]),
      role:  String(data[i][2]),
      email: String(data[i][3]),
      phone: String(data[i][4]),
      pin:   String(data[i][5])
    });
  }

  cachePut_("users", users);
  return users;
}

function saveUserBackend(userData, session) {
  checkAuth(session);
  const lock = LockService.getDocumentLock();
  try { lock.waitLock(10000); } catch (e) { throw new Error("System busy"); }

  try {
    const sheet = getSheet_(SHEET_USERS);
    const data = sheet.getDataRange().getValues();
    let rowIndex = -1;

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(userData.id)) {
        rowIndex = i + 1;
        break;
      }
    }

    const rowData = [
      userData.id,
      userData.name,
      userData.role,
      userData.email,
      userData.phone || '-',
      userData.pin
    ];

    if (rowIndex > -1) {
      sheet.getRange(rowIndex, 1, 1, 6).setValues([rowData]);
    } else {
      sheet.appendRow(rowData);
    }

    cacheRemove_("users");
    SpreadsheetApp.flush();
    return true;
  } catch (e) {
    Logger.log("saveUserBackend error: " + e.toString());
    throw new Error("บันทึกผู้ใช้ล้มเหลว: " + e.message);
  } finally {
    lock.releaseLock();
  }
}

function deleteUserBackend(userId, session) {
  checkAuth(session);
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
  const headersUsers = ["UserID", "Name", "Role", "Email", "Phone", "PIN"];
  sheetUsers.getRange(1, 1, 1, headersUsers.length)
    .setValues([headersUsers]).setFontWeight("bold")
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
