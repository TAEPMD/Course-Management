/**
 * modules/users.js — User Management
 */
import { state } from './state.js';
import { hasPermission } from './permissions.js';
import { hideAllViews, setHeader, updateNavActive } from './auth.js';
import { escapeHTML, escapeJsAttr } from '../utils/format.js';
import * as gas from '../gas.js';

export async function showUsers() {
  if (!hasPermission('users')) {
    Swal.fire({ icon: 'warning', title: 'ไม่มีสิทธิ์เข้าถึง', text: 'เฉพาะ Admin เท่านั้น', confirmButtonColor: '#1e3a8a' }); return;
  }
  hideAllViews(); setHeader('User Management');
  document.getElementById('view-users')?.classList.remove('hidden');
  updateNavActive('nav-users');
  await loadUsers();
}

export async function loadUsers() {
  Swal.fire({ title: 'LOADING USERS...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
  try {
    state.users = await gas.getUsers() || [];
  } catch (e) {
    state.users = [];
    Swal.fire({ icon: 'error', title: 'โหลด Users ล้มเหลว', text: e.message });
    return;
  }
  Swal.close();
  renderUserTable();
}

function _roleColor(role) {
  return role === 'Admin' ? 'text-rose-700 bg-rose-50' : role === 'Instructor' ? 'text-teal-700 bg-teal-50' : 'text-blue-700 bg-blue-50';
}

function renderUserCards() {
  const list = document.getElementById('users-card-list');
  if (!list) return;
  if (!state.users.length) {
    list.innerHTML = `<p class="p-8 text-center text-gray-300 font-bold text-sm">ไม่มีผู้ใช้งาน</p>`;
    return;
  }
  list.innerHTML = state.users.map(u => `
    <div class="mobile-list-card">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 text-xs font-bold shrink-0">
          ${escapeHTML(String(u.name || '').substring(0, 2).toUpperCase())}</div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <p class="font-bold text-gray-800 text-sm truncate">${escapeHTML(u.name)}</p>
            <span class="px-2 py-0.5 rounded-lg text-[10px] font-bold shrink-0 ${_roleColor(u.role)}">${escapeHTML(u.role)}</span>
          </div>
          <p class="text-xs text-gray-400 truncate">${escapeHTML(u.email || '-')} • ${escapeHTML(u.id)}</p>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button onclick="window._editUser('${escapeJsAttr(u.id)}')" class="w-9 h-9 inline-flex items-center justify-center rounded-xl bg-blue-50 text-blue-600 active:bg-blue-100 transition" aria-label="แก้ไขผู้ใช้"><i class="fa-solid fa-pen-to-square text-sm"></i></button>
          <button onclick="window._deleteUser('${escapeJsAttr(u.id)}')" class="w-9 h-9 inline-flex items-center justify-center rounded-xl bg-rose-50 text-rose-500 active:bg-rose-100 transition" aria-label="ลบผู้ใช้"><i class="fa-solid fa-trash text-sm"></i></button>
        </div>
      </div>
    </div>`).join('');
}

export function renderUserTable() {
  renderUserCards();
  // expose handlers to global scope (needed for inline HTML buttons)
  window._editUser   = editUser;
  window._deleteUser = deleteUser;

  const tbody = document.getElementById('users-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!state.users.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-gray-300 font-bold">ไม่มีผู้ใช้งาน</td></tr>`;
    return;
  }
  state.users.forEach(u => {
    const roleColor = _roleColor(u.role);
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-50/50 transition-colors';
    tr.innerHTML = `
      <td class="px-6 py-4 text-xs font-mono text-gray-400">${escapeHTML(u.id)}</td>
      <td class="px-6 py-4"><div class="flex items-center space-x-3">
        <div class="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 text-xs font-bold">
          ${escapeHTML(String(u.name || '').substring(0, 2).toUpperCase())}</div>
        <div><p class="font-bold text-gray-800 text-sm">${escapeHTML(u.name)}</p>
          <p class="text-xs text-gray-400">${escapeHTML(u.email)}</p></div></div></td>
      <td class="px-6 py-4">
        <span class="px-2 py-1 rounded-lg text-xs font-bold ${roleColor}">${escapeHTML(u.role)}</span>
        ${u.status === 'disabled' ? '<span class="ml-1 px-2 py-1 rounded-lg text-[10px] font-bold text-slate-500 bg-slate-100">ระงับ</span>' : ''}
      </td>
      <td class="px-6 py-4 text-xs text-gray-500">${escapeHTML(u.email || '-')}</td>
      <td class="px-6 py-4">
        <div class="flex items-center justify-end space-x-2">
          <button onclick="window._editUser('${escapeJsAttr(u.id)}')" class="p-2 text-blue-500 hover:bg-blue-50 rounded-xl transition"><i class="fa-solid fa-pen-to-square text-sm"></i></button>
          <button onclick="window._deleteUser('${escapeJsAttr(u.id)}')" class="p-2 text-red-400 hover:bg-red-50 rounded-xl transition"><i class="fa-solid fa-trash text-sm"></i></button>
        </div></td>`;
    tbody.appendChild(tr);
  });
}

export function showUserModal(userData) {
  const modal = document.getElementById('user-modal');
  if (!modal) return;
  const isEdit = !!userData?.id;
  modal.classList.remove('hidden');
  document.getElementById('user-modal-title').innerText = isEdit ? 'แก้ไขผู้ใช้' : 'เพิ่มผู้ใช้ใหม่';
  document.getElementById('modal-user-id').value       = userData?.id       || `U-${String(Date.now()).slice(-4)}`;
  document.getElementById('modal-user-name').value     = userData?.name     || '';
  document.getElementById('modal-user-email').value    = userData?.email    || '';
  document.getElementById('modal-user-username').value = userData?.username || '';
  // PIN ถูกเก็บเป็น hash — ดึงกลับมาแสดงไม่ได้ และไม่จำเป็นต้องกรอกถ้าไม่เปลี่ยน
  const pinField = document.getElementById('modal-user-pin');
  if (pinField) {
    pinField.value = '';
    pinField.placeholder = isEdit ? 'เว้นว่าง = ใช้ PIN เดิม' : 'ตัวเลข 6-10 หลัก';
  }
  const hint = document.getElementById('modal-user-pin-hint');
  if (hint) {
    hint.textContent = isEdit
      ? 'เว้นว่างไว้ถ้าไม่ต้องการเปลี่ยน · ระบบเก็บเป็นค่า hash จึงดู PIN เดิมไม่ได้'
      : 'ห้ามเลขซ้ำทั้งหมดหรือเรียงกัน · ระบบเก็บเป็นค่า hash เท่านั้น';
  }
  const roleSelect = document.getElementById('modal-user-role');
  if (roleSelect) roleSelect.value = userData?.role || 'Staff';
  const statusSelect = document.getElementById('modal-user-status');
  if (statusSelect) statusSelect.value = userData?.status === 'disabled' ? 'disabled' : 'active';
}

export function closeUserModal() {
  document.getElementById('user-modal')?.classList.add('hidden');
}

export async function saveUser() {
  const userData = {
    id:       document.getElementById('modal-user-id')?.value.trim(),
    name:     document.getElementById('modal-user-name')?.value.trim(),
    role:     document.getElementById('modal-user-role')?.value,
    email:    document.getElementById('modal-user-email')?.value.trim(),
    username: document.getElementById('modal-user-username')?.value.trim(),
    status:   document.getElementById('modal-user-status')?.value || 'active',
    phone:    '-',
    pin:      document.getElementById('modal-user-pin')?.value.trim()
  };
  const isExisting = state.users.some(u => u.id === userData.id);

  if (!userData.name) { Swal.fire('ข้อมูลไม่ครบ', 'กรุณากรอกชื่อ-สกุล', 'warning'); return; }
  if (!userData.username && !userData.email) {
    Swal.fire('ข้อมูลไม่ครบ', 'ต้องมีชื่อผู้ใช้หรืออีเมลอย่างน้อยหนึ่งอย่างเพื่อใช้ล็อกอิน', 'warning'); return;
  }
  if (!isExisting && !userData.pin) { Swal.fire('ข้อมูลไม่ครบ', 'ผู้ใช้ใหม่ต้องกำหนด PIN', 'warning'); return; }
  if (userData.pin && !/^\d{6,10}$/.test(userData.pin)) {
    Swal.fire('PIN ไม่ถูกต้อง', 'PIN ต้องเป็นตัวเลข 6-10 หลัก', 'warning'); return;
  }
  try {
    await gas.saveUserBackend(userData);
    closeUserModal();
    await loadUsers();
    Swal.fire({ icon: 'success', title: 'บันทึกแล้ว', toast: true, position: 'top-end', timer: 1500, showConfirmButton: false });
  } catch (e) {
    Swal.fire({ icon: 'error', title: 'บันทึกล้มเหลว', text: e.message });
  }
}

export function editUser(id) {
  const user = state.users.find(u => u.id === id);
  if (user) showUserModal(user);
}

export async function deleteUser(id) {
  const result = await Swal.fire({ title: 'ยืนยันการลบ?', icon: 'warning', showCancelButton: true, confirmButtonColor: '#ef4444', confirmButtonText: 'ลบ', cancelButtonText: 'ยกเลิก' });
  if (!result.isConfirmed) return;
  try {
    await gas.deleteUserBackend(id);
    await loadUsers();
    Swal.fire({ icon: 'success', title: 'ลบแล้ว', toast: true, position: 'top-end', timer: 1200, showConfirmButton: false });
  } catch (e) {
    Swal.fire({ icon: 'error', title: 'ลบล้มเหลว', text: e.message });
  }
}
