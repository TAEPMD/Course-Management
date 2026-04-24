/**
 * modules/users.js — User Management
 */
import { state } from './state.js';
import { hasPermission } from './permissions.js';
import { hideAllViews, setHeader, updateNavActive } from './auth.js';
import { escapeHTML } from '../utils/format.js';
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

export function renderUserTable() {
  const tbody = document.getElementById('users-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!state.users.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-gray-300 font-bold">ไม่มีผู้ใช้งาน</td></tr>`;
    return;
  }
  state.users.forEach(u => {
    const roleColor = u.role === 'Admin' ? 'text-red-600 bg-red-50' : u.role === 'Instructor' ? 'text-purple-600 bg-purple-50' : 'text-blue-600 bg-blue-50';
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-50/50 transition-colors';
    tr.innerHTML = `
      <td class="px-6 py-4 text-xs font-mono text-gray-400">${escapeHTML(u.id)}</td>
      <td class="px-6 py-4"><div class="flex items-center space-x-3">
        <div class="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 text-xs font-bold">
          ${u.name.substring(0,2).toUpperCase()}</div>
        <div><p class="font-bold text-gray-800 text-sm">${escapeHTML(u.name)}</p>
          <p class="text-xs text-gray-400">${escapeHTML(u.email)}</p></div></div></td>
      <td class="px-6 py-4"><span class="px-2 py-1 rounded-lg text-xs font-bold ${roleColor}">${escapeHTML(u.role)}</span></td>
      <td class="px-6 py-4 text-xs text-gray-500">${escapeHTML(u.email || '-')}</td>
      <td class="px-6 py-4">
        <div class="flex items-center justify-end space-x-2">
          <button onclick="window._editUser('${u.id}')" class="p-2 text-blue-500 hover:bg-blue-50 rounded-xl transition"><i class="fa-solid fa-pen-to-square text-sm"></i></button>
          <button onclick="window._deleteUser('${u.id}')" class="p-2 text-red-400 hover:bg-red-50 rounded-xl transition"><i class="fa-solid fa-trash text-sm"></i></button>
        </div></td>`;
    tbody.appendChild(tr);
  });

  // expose handlers to global scope (needed for inline HTML buttons)
  window._editUser   = editUser;
  window._deleteUser = deleteUser;
}

export function showUserModal(userData) {
  const modal = document.getElementById('user-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  document.getElementById('user-modal-title').innerText = userData?.id ? 'แก้ไขผู้ใช้' : 'เพิ่มผู้ใช้ใหม่';
  document.getElementById('modal-user-id').value    = userData?.id    || `U-${String(Date.now()).slice(-4)}`;
  document.getElementById('modal-user-name').value  = userData?.name  || '';
  document.getElementById('modal-user-email').value = userData?.email || '';
  document.getElementById('modal-user-pin').value   = userData?.pin   || '';
  const roleSelect = document.getElementById('modal-user-role');
  if (roleSelect) roleSelect.value = userData?.role || 'Staff';
}

export function closeUserModal() {
  document.getElementById('user-modal')?.classList.add('hidden');
}

export async function saveUser() {
  const userData = {
    id:    document.getElementById('modal-user-id')?.value.trim(),
    name:  document.getElementById('modal-user-name')?.value.trim(),
    role:  document.getElementById('modal-user-role')?.value,
    email: document.getElementById('modal-user-email')?.value.trim(),
    phone: '-',
    pin:   document.getElementById('modal-user-pin')?.value.trim()
  };
  if (!userData.name || !userData.pin) { Swal.fire('ข้อมูลไม่ครบ', 'กรุณากรอกชื่อและ PIN', 'warning'); return; }
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
