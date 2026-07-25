/**
 * modules/settings.js — System Settings, Logo, Permissions Save
 */
import { state } from './state.js';
import { hasPermission } from './permissions.js';
import { applyPermissions, renderPermissionsTable } from './permissions.js';
import { renderMasterDataLists, addMasterItem, saveMasterDataToCloud, loadMasterDataFromCloud } from './masterData.js';
import { hideAllViews, setHeader, updateNavActive } from './auth.js';
import * as gas from '../gas.js';

export function showSettings() {
  if (!hasPermission('settings')) {
    Swal.fire({ icon: 'warning', title: 'ไม่มีสิทธิ์เข้าถึง', text: 'เฉพาะ Admin เท่านั้น', confirmButtonColor: '#1e3a8a' }); return;
  }
  hideAllViews(); setHeader('Settings');
  document.getElementById('view-settings')?.classList.remove('hidden');
  updateNavActive('nav-settings');
  renderMasterDataLists();
  renderPermissionsTable();
}

export async function saveSettings() {
  const siteName  = document.getElementById('input-site-name')?.value.trim();
  const logoFile  = document.getElementById('logo-file-input')?.files?.[0];

  if (siteName) {
    await gas.saveSystemSetting('siteName', siteName);
    const nameEls = document.querySelectorAll('#display-site-name, #login-site-name');
    nameEls.forEach(el => { if (el) el.innerText = siteName; });
  }
  if (logoFile) await uploadLogo(logoFile);

  Swal.fire({ icon: 'success', title: 'บันทึก Settings สำเร็จ', timer: 1500, showConfirmButton: false });
}

export async function uploadLogo(file) {
  const selectedFile = file || document.getElementById('logo-file-input')?.files?.[0];
  if (!selectedFile) {
    Swal.fire('ยังไม่ได้เลือกไฟล์', 'กรุณาเลือกไฟล์โลโก้ก่อนอัปโหลด', 'warning');
    return;
  }

  if (!selectedFile.type?.startsWith('image/')) {
    Swal.fire('ไฟล์ไม่ถูกต้อง', 'กรุณาเลือกไฟล์รูปภาพเท่านั้น', 'warning');
    return;
  }

  if (selectedFile.size > 2 * 1024 * 1024) {
    Swal.fire('ไฟล์ใหญ่เกินไป', 'กรุณาเลือกไฟล์ขนาดไม่เกิน 2MB', 'warning');
    return;
  }

  const reader = new FileReader();
  return new Promise(resolve => {
    reader.onload = async e => {
      const data = e.target.result.split(',')[1];
      try {
        Swal.fire({ title: 'กำลังอัปโหลดโลโก้...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        const url = normalizeLogoUrl(await gas.uploadFile(data, selectedFile.name));
        await gas.saveSystemSetting('logoUrl', url);
        _applyLogo(url);
        Swal.fire({ icon: 'success', title: 'อัปโหลดโลโก้สำเร็จ', timer: 1500, showConfirmButton: false });
      } catch (err) {
        Swal.fire({ icon: 'error', title: 'อัปโหลดโลโก้ไม่สำเร็จ', text: err.message });
      }
      resolve();
    };
    reader.readAsDataURL(selectedFile);
  });
}

function normalizeLogoUrl(url) {
  const value = String(url || '').trim();
  const match = value.match(/[?&]id=([^&]+)/) || value.match(/\/d\/([^/?#]+)/);
  return match?.[1] ? `https://lh3.googleusercontent.com/d/${match[1]}` : value;
}

function _applyLogo(url) {
  const normalizedUrl = normalizeLogoUrl(url);
  ['logo-img','header-logo-img','login-logo-img'].forEach(id => {
    const img = document.getElementById(id);
    if (img) {
      img.onload = () => {
        img.classList.remove('hidden');
        document.getElementById(id.replace('img', 'icon'))?.classList.add('hidden');
      };
      img.onerror = () => {
        img.classList.add('hidden');
        document.getElementById(id.replace('img', 'icon'))?.classList.remove('hidden');
      };
      img.src = normalizedUrl;
    }
  });
}

export function previewLogo(event) {
  const f = event.target.files?.[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = e => {
    const preview = document.getElementById('preview-logo');
    const icon    = document.getElementById('preview-icon');
    if (preview) { preview.src = e.target.result; preview.classList.remove('hidden'); }
    if (icon) icon.classList.add('hidden');
  };
  reader.readAsDataURL(f);
}

export function savePermissions() {
  const rows  = document.querySelectorAll('#permissions-table-body tr');
  const perms = {};
  rows.forEach(row => {
    const role = row.dataset.role;
    if (!role) return;
    perms[role] = {};
    row.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      perms[role][cb.dataset.page] = cb.checked;
    });
  });
  // Admin always full
  perms['Admin'] = { dashboard:true, annual:true, monthly:true, weekly:true, users:true, settings:true };
  const settings = JSON.parse(localStorage.getItem('system_settings') || '{}');
  settings.permissions = perms;
  localStorage.setItem('system_settings', JSON.stringify(settings));
  gas.saveSystemSetting('permissions', JSON.stringify(perms))
    .catch(err => console.warn('Permission sync skipped:', err?.message || err));
  applyPermissions();
  Swal.fire({ icon: 'success', title: 'บันทึกสิทธิ์สำเร็จ', text: 'สิทธิ์การเข้าถึงถูกอัปเดตแล้ว', timer: 1500, showConfirmButton: false });
}

export function simulateRole(role) {
  state.currentUserRole = role;
  applyPermissions();
}

export function toggleDarkMode() {
  document.body.classList.toggle('dark');
  const isDark = document.body.classList.contains('dark');
  localStorage.setItem('dark_mode', isDark);
  const icon = document.querySelector('#dark-mode-toggle i');
  if (icon) {
    icon.classList.toggle('fa-moon', !isDark);
    icon.classList.toggle('fa-sun', isDark);
  }
}

const VISUAL_PREF_KEY = 'visual_control_settings';
const VISUAL_CLASS_MAP = {
  contrast: 'visual-contrast',
  compact: 'visual-compact',
  focus: 'visual-focus'
};

function getVisualPrefs() {
  try {
    return JSON.parse(localStorage.getItem(VISUAL_PREF_KEY) || '{}');
  } catch {
    return {};
  }
}

function updateVisualControlButtons(prefs) {
  Object.keys(VISUAL_CLASS_MAP).forEach(key => {
    const btn = document.querySelector(`[data-visual-mode="${key}"]`);
    if (!btn) return;
    const active = Boolean(prefs[key]);
    btn.classList.toggle('visual-control-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

function applyVisualPrefs(prefs = getVisualPrefs()) {
  Object.entries(VISUAL_CLASS_MAP).forEach(([key, className]) => {
    document.body.classList.toggle(className, Boolean(prefs[key]));
  });
  updateVisualControlButtons(prefs);
}

export function loadVisualControls() {
  applyVisualPrefs();
}

export function toggleVisualControlPanel() {
  const panel = document.getElementById('visual-control-panel');
  if (!panel) return;
  const isHidden = panel.classList.toggle('hidden');
  document.getElementById('visual-control-toggle')?.setAttribute('aria-expanded', String(!isHidden));
}

export function setVisualMode(mode) {
  if (mode === 'reset') {
    localStorage.removeItem(VISUAL_PREF_KEY);
    applyVisualPrefs({});
    return;
  }
  if (!VISUAL_CLASS_MAP[mode]) return;
  const prefs = getVisualPrefs();
  prefs[mode] = !prefs[mode];
  localStorage.setItem(VISUAL_PREF_KEY, JSON.stringify(prefs));
  applyVisualPrefs(prefs);
}

export function loadDarkMode() {
  if (localStorage.getItem('dark_mode') === 'true') {
    document.body.classList.add('dark');
    const icon = document.querySelector('#dark-mode-toggle i');
    if (icon) { icon.classList.remove('fa-moon'); icon.classList.add('fa-sun'); }
  }
}

function applyBranding(settings) {
  if (settings?.siteName) {
    document.querySelectorAll('#display-site-name, #login-site-name').forEach(el => { el.innerText = settings.siteName; });
    document.querySelector('title').innerText = settings.siteName + ' - Project Management';
  }
  if (settings?.logoUrl) _applyLogo(settings.logoUrl);
}

/** โหลดเฉพาะชื่อระบบ/โลโก้สำหรับหน้า Login — ไม่ต้องมี session */
export async function loadPublicBranding() {
  try {
    applyBranding(await gas.getPublicSettings());
  } catch (e) {
    console.warn('Branding could not be loaded:', e.message);
  }
}

export async function loadSettings() {
  try {
    const settings = await gas.getSystemSettings();
    if (settings.siteName) {
      document.querySelectorAll('#display-site-name, #login-site-name').forEach(el => { el.innerText = settings.siteName; });
      document.querySelector('title').innerText = settings.siteName + ' - Project Management';
    }
    if (settings.logoUrl) _applyLogo(settings.logoUrl);
    // Load master data from cloud if available
    await loadMasterDataFromCloud();
  } catch (e) {
    console.warn('Production settings could not be loaded:', e.message);
  }
}

// Re-export for HTML access via window.app
export { addMasterItem, saveMasterDataToCloud };
