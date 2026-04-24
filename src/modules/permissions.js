/**
 * modules/permissions.js — Role-based Permission System
 */

import { state } from './state.js';

const DEFAULT_PERMISSIONS = {
  Admin:      { dashboard: true,  annual: true,  monthly: true,  weekly: true,  users: true,  settings: true  },
  Staff:      { dashboard: true,  annual: true,  monthly: true,  weekly: true,  users: false, settings: false },
  Instructor: { dashboard: true,  annual: false, monthly: true,  weekly: true,  users: false, settings: false },
  Trainee:    { dashboard: true,  annual: false, monthly: false, weekly: true,  users: false, settings: false }
};

export function getDefaultPermissions() {
  return JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS));
}

export function getPermissions() {
  const settings = JSON.parse(localStorage.getItem('system_settings') || '{}');
  return settings.permissions || getDefaultPermissions();
}

export function hasPermission(page) {
  const role = state.currentUserRole || 'Admin';
  if (role === 'Admin') return true;
  const perms = getPermissions();
  return perms[role]?.[page] !== false;
}

export function applyPermissions() {
  const role = state.currentUserRole || 'Admin';
  const name = state.currentUserName || 'Administrator';
  const perms = getPermissions();
  const rolePerms = perms[role] || {};

  // Update sidebar user info
  const nameEl = document.getElementById('sidebar-user-name');
  if (nameEl) nameEl.innerText = name;
  const avatarEl = document.getElementById('sidebar-role-avatar');
  if (avatarEl) avatarEl.innerText = name.substring(0, 2).toUpperCase();
  const roleSimulator = document.getElementById('role-simulator');
  if (roleSimulator) roleSimulator.value = role;

  // Show/hide nav items based on permissions
  const navMap = {
    'nav-annual':   'annual',
    'nav-monthly':  'monthly',
    'nav-weekly':   'weekly',
    'nav-users':    'users',
    'nav-settings': 'settings'
  };
  Object.entries(navMap).forEach(([navId, page]) => {
    const btn = document.getElementById(navId);
    if (!btn) return;
    const allowed = role === 'Admin' || rolePerms[page] !== false;
    btn.classList.toggle('hidden', !allowed);
  });
}

export function renderPermissionsTable() {
  const tbody = document.getElementById('permissions-table-body');
  if (!tbody) return;
  const perms = getPermissions();
  const defaults = getDefaultPermissions();
  const ROLES = ['Admin', 'Staff', 'Instructor', 'Trainee'];
  const PAGES = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'annual',    label: 'Annual' },
    { key: 'monthly',   label: 'Monthly' },
    { key: 'weekly',    label: 'Weekly' },
    { key: 'users',     label: 'Users' },
    { key: 'settings',  label: 'Settings' }
  ];
  tbody.innerHTML = '';
  ROLES.forEach(role => {
    const tr = document.createElement('tr');
    tr.dataset.role = role;
    tr.className = 'hover:bg-slate-50/50 transition-colors';
    const roleColor = role === 'Admin'
      ? 'text-red-600 bg-red-50'
      : role === 'Instructor'
      ? 'text-purple-600 bg-purple-50'
      : 'text-blue-600 bg-blue-50';
    let html = `<td class="py-4 pr-4"><span class="px-3 py-1 rounded-lg text-xs font-bold ${roleColor}">${role}</span></td>`;
    PAGES.forEach(page => {
      const isAdmin = role === 'Admin';
      const saved = perms[role]?.[page.key];
      const checked = isAdmin ? true : (saved !== undefined ? saved : defaults[role]?.[page.key] !== false);
      html += `<td class="py-4 text-center">
        <input type="checkbox" data-page="${page.key}"
          ${checked ? 'checked' : ''}
          ${isAdmin ? 'disabled title="Admin มีสิทธิ์ทุกหน้าเสมอ"' : ''}
          class="w-4 h-4 accent-blue-600 ${isAdmin ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}">
      </td>`;
    });
    tr.innerHTML = html;
    tbody.appendChild(tr);
  });
}
