/**
 * modules/masterData.js — Master Data Management (Category / Audience / Assessment)
 */
import { escapeHTML } from '../utils/format.js';
import * as gas from '../gas.js';

const DEFAULTS = {
  category: [
    { value: 'basic',      label: 'Basic Life Support (BLS)' },
    { value: 'advanced',   label: 'Advanced Life Support (ALS/ACLS)' },
    { value: 'trauma',     label: 'Trauma & Technical Rescue' },
    { value: 'management', label: 'Management & Leadership' },
  ],
  audience: [
    { value: 'doctor',    label: 'แพทย์ (Doctor)' },
    { value: 'nurse',     label: 'พยาบาลวิชาชีพ (RN / EN)' },
    { value: 'paramedic', label: 'นักปฏิบัติการฉุกเฉินการแพทย์ (Paramedic)' },
    { value: 'emt',       label: 'พนักงานฉุกเฉินการแพทย์ (AEMT / EMT)' },
    { value: 'all',       label: 'บุคลากรทางการแพทย์ทุกระดับ' },
  ],
  assessment: [
    { value: 'mcq',        label: 'ข้อสอบปรนัย (MCQ) แบบ Pre/Post-test' },
    { value: 'osce',       label: 'สอบปฏิบัติทักษะ (OSCE)' },
    { value: 'scenario',   label: 'ประเมินจากสถานการณ์จำลอง (Simulation)' },
    { value: 'attendance', label: 'พิจารณาจากเวลาเข้าร่วม (Attendance Only)' },
  ],
};

export function getMasterData() {
  const saved = JSON.parse(localStorage.getItem('master_data') || 'null');
  return saved || JSON.parse(JSON.stringify(DEFAULTS));
}

export function saveMasterData(data) {
  localStorage.setItem('master_data', JSON.stringify(data));
}

// Auto-generate a stable slug from a label string
function toSlug(label) {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 16);
  return (base || 'item') + '_' + Date.now().toString(36);
}

export function populateDropdown(selectId, type, selectedValue) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const md = getMasterData();
  sel.innerHTML = '';
  (md[type] || []).forEach(item => {
    const opt = document.createElement('option');
    opt.value       = item.value;
    opt.textContent = item.label;
    if (item.value === selectedValue) opt.selected = true;
    sel.appendChild(opt);
  });
}

export function renderMasterDataLists() {
  const md = getMasterData();
  ['category', 'audience', 'assessment'].forEach(type => {
    const container = document.getElementById(`master-${type}-list`);
    if (!container) return;
    container.innerHTML = '';

    if (!md[type]?.length) {
      container.innerHTML = `<p class="text-xs text-gray-400 italic py-1">ยังไม่มีรายการ</p>`;
      return;
    }

    (md[type] || []).forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'master-row group flex items-center gap-2 p-2.5 bg-gray-50 dark:bg-slate-700/40 rounded-xl border border-gray-100 dark:border-slate-600 transition-all';
      row.dataset.type = type;
      row.dataset.idx  = idx;

      row.innerHTML = `
        <!-- View mode -->
        <div class="view-mode flex items-center gap-2 w-full">
          <span class="flex-1 text-sm font-medium text-gray-700 dark:text-gray-200 leading-snug">${escapeHTML(item.label)}</span>
          <button class="btn-edit-master w-7 h-7 flex items-center justify-center text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded-lg transition opacity-0 group-hover:opacity-100" title="แก้ไข">
            <i class="fa-solid fa-pen text-xs"></i>
          </button>
          <button class="btn-remove-master w-7 h-7 flex items-center justify-center text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition opacity-0 group-hover:opacity-100" title="ลบ">
            <i class="fa-solid fa-trash text-xs"></i>
          </button>
        </div>
        <!-- Edit mode -->
        <div class="edit-mode hidden items-center gap-2 w-full">
          <input class="input-modern flex-1 text-sm py-1.5" value="${escapeHTML(item.label)}" placeholder="ชื่อ...">
          <button class="btn-save-master w-7 h-7 flex items-center justify-center text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 rounded-lg transition" title="บันทึก">
            <i class="fa-solid fa-check text-xs"></i>
          </button>
          <button class="btn-cancel-master w-7 h-7 flex items-center justify-center text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-600 rounded-lg transition" title="ยกเลิก">
            <i class="fa-solid fa-xmark text-xs"></i>
          </button>
        </div>
      `;
      container.appendChild(row);
    });
  });

  _bindMasterEvents();
}

function _bindMasterEvents() {
  // Edit
  document.querySelectorAll('.btn-edit-master').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.master-row');
      row.querySelector('.view-mode').classList.add('hidden');
      const em = row.querySelector('.edit-mode');
      em.classList.remove('hidden');
      em.classList.add('flex');
      em.querySelector('input').focus();
    });
  });

  // Cancel edit
  document.querySelectorAll('.btn-cancel-master').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.master-row');
      row.querySelector('.view-mode').classList.remove('hidden');
      const em = row.querySelector('.edit-mode');
      em.classList.add('hidden');
      em.classList.remove('flex');
    });
  });

  // Save edit — Enter key also saves
  document.querySelectorAll('.edit-mode input').forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.closest('.master-row').querySelector('.btn-save-master').click();
      if (e.key === 'Escape') input.closest('.master-row').querySelector('.btn-cancel-master').click();
    });
  });

  document.querySelectorAll('.btn-save-master').forEach(btn => {
    btn.addEventListener('click', () => {
      const row      = btn.closest('.master-row');
      const type     = row.dataset.type;
      const idx      = parseInt(row.dataset.idx);
      const newLabel = row.querySelector('.edit-mode input').value.trim();
      if (!newLabel) return;
      const md = getMasterData();
      md[type][idx].label = newLabel;
      saveMasterData(md);
      renderMasterDataLists();
    });
  });

  // Delete
  document.querySelectorAll('.btn-remove-master').forEach(btn => {
    btn.addEventListener('click', () => {
      const row  = btn.closest('.master-row');
      const type = row.dataset.type;
      const idx  = parseInt(row.dataset.idx);
      Swal.fire({
        title: 'ลบรายการนี้?',
        icon:  'warning',
        showCancelButton:    true,
        confirmButtonColor:  '#ef4444',
        cancelButtonText:    'ยกเลิก',
        confirmButtonText:   'ลบ',
      }).then(r => {
        if (!r.isConfirmed) return;
        const md = getMasterData();
        md[type].splice(idx, 1);
        saveMasterData(md);
        renderMasterDataLists();
      });
    });
  });
}

export function addMasterItem(type) {
  const labelEl = document.getElementById(`input-new-${type}-label`);
  const label   = labelEl?.value.trim();
  if (!label) {
    Swal.fire({ icon: 'warning', title: 'กรุณากรอกชื่อ', toast: true, position: 'top-end', timer: 1800, showConfirmButton: false });
    return;
  }
  const md    = getMasterData();
  const value = toSlug(label);
  md[type].push({ value, label });
  saveMasterData(md);
  labelEl.value = '';
  labelEl.focus();
  renderMasterDataLists();
  Swal.fire({ icon: 'success', title: 'เพิ่มสำเร็จ', toast: true, position: 'top-end', timer: 1200, showConfirmButton: false });
}

export async function saveMasterDataToCloud() {
  const btn = document.getElementById('btn-save-master-cloud');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>กำลังบันทึก...'; }
  try {
    const md = getMasterData();
    await gas.saveSystemSetting('master_data', md);
    Swal.fire({ icon: 'success', title: 'บันทึกไปยัง Google Sheets แล้ว', toast: true, position: 'top-end', timer: 2000, showConfirmButton: false });
  } catch (e) {
    gas.notifyApiError('บันทึกไม่สำเร็จ', e);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up mr-2"></i>บันทึกไปยัง Google Sheets'; }
  }
}

export async function loadMasterDataFromCloud() {
  try {
    const settings = await gas.getSystemSettings();
    if (settings?.master_data && typeof settings.master_data === 'object') {
      saveMasterData(settings.master_data);
    }
  } catch {}
}
