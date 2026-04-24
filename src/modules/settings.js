/**
 * modules/settings.js — System Settings, Logo, Permissions Save
 */
import { state } from './state.js';
import { hasPermission } from './permissions.js';
import { applyPermissions, renderPermissionsTable } from './permissions.js';
import { renderMasterDataLists, addMasterItem } from './masterData.js';
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
  const adminPin  = document.getElementById('input-admin-pin')?.value.trim();
  const logoFile  = document.getElementById('logo-file-input')?.files?.[0];

  if (siteName) {
    await gas.saveSystemSetting('siteName', siteName);
    const nameEls = document.querySelectorAll('#display-site-name, #login-site-name');
    nameEls.forEach(el => { if (el) el.innerText = siteName; });
  }
  if (adminPin) {
    if (!/^\d{5}$/.test(adminPin)) { Swal.fire('ข้อผิดพลาด', 'PIN ต้องเป็นตัวเลข 5 หลัก', 'warning'); return; }
    await gas.saveSystemSetting('adminPin', adminPin);
    document.getElementById('input-admin-pin').value = '';
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
        const url = await gas.uploadFile(data, selectedFile.name);
        await gas.saveSystemSetting('logoUrl', url);
        _applyLogo(url);
        Swal.fire({ icon: 'success', title: 'อัปโหลดโลโก้สำเร็จ', timer: 1500, showConfirmButton: false });
      } catch (err) {
        // Dev mode — use local data URL
        await gas.saveSystemSetting('logoUrl', e.target.result);
        _applyLogo(e.target.result);
        Swal.fire({ icon: 'success', title: 'บันทึกโลโก้สำเร็จ', timer: 1500, showConfirmButton: false });
      }
      resolve();
    };
    reader.readAsDataURL(selectedFile);
  });
}

function _applyLogo(url) {
  ['logo-img','header-logo-img','login-logo-img'].forEach(id => {
    const img = document.getElementById(id);
    if (img) { img.src = url; img.classList.remove('hidden'); }
  });
  ['logo-icon','header-logo-icon','login-logo-icon'].forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
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
  if (typeof google !== 'undefined' && google.script) {
    google.script.run.saveSystemSetting('permissions', JSON.stringify(perms));
  }
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

export function loadDarkMode() {
  if (localStorage.getItem('dark_mode') === 'true') {
    document.body.classList.add('dark');
    const icon = document.querySelector('#dark-mode-toggle i');
    if (icon) { icon.classList.remove('fa-moon'); icon.classList.add('fa-sun'); }
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
  } catch (e) {
    // Use localStorage fallback in dev
    const s = JSON.parse(localStorage.getItem('system_settings') || '{}');
    if (s.siteName) document.querySelectorAll('#display-site-name').forEach(el => { el.innerText = s.siteName; });
  }
}

// Re-export addMasterItem for HTML access
export { addMasterItem };
