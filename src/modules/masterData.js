/**
 * modules/masterData.js — Master Data Management (Category / Audience / Assessment)
 */
import { escapeHTML } from '../utils/format.js';

const DEFAULTS = {
  category: [
    { value: 'basic',      label: 'Basic Life Support (BLS)' },
    { value: 'advanced',   label: 'Advanced Life Support (ALS/ACLS)' },
    { value: 'trauma',     label: 'Trauma & Technical Rescue' },
    { value: 'management', label: 'Management & Leadership' }
  ],
  audience: [
    { value: 'doctor',    label: 'แพทย์ (Doctor)' },
    { value: 'nurse',     label: 'พยาบาลวิชาชีพ (RN / EN)' },
    { value: 'paramedic', label: 'นักปฏิบัติการฉุกเฉินการแพทย์ (Paramedic)' },
    { value: 'emt',       label: 'พนักงานฉุกเฉินการแพทย์ (AEMT / EMT)' },
    { value: 'all',       label: 'บุคลากรทางการแพทย์ทุกระดับ' }
  ],
  assessment: [
    { value: 'mcq',        label: 'ข้อสอบปรนัย (MCQ) แบบ Pre/Post-test' },
    { value: 'osce',       label: 'สอบปฏิบัติทักษะ (OSCE)' },
    { value: 'scenario',   label: 'ประเมินจากสถานการณ์จำลอง (Simulation)' },
    { value: 'attendance', label: 'พิจารณาจากเวลาเข้าร่วม (Attendance Only)' }
  ]
};

export function getMasterData() {
  const saved = JSON.parse(localStorage.getItem('master_data') || 'null');
  return saved || JSON.parse(JSON.stringify(DEFAULTS));
}

export function saveMasterData(data) {
  localStorage.setItem('master_data', JSON.stringify(data));
}

export function populateDropdown(selectId, type, selectedValue) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const md = getMasterData();
  sel.innerHTML = '';
  (md[type] || []).forEach(item => {
    const opt = document.createElement('option');
    opt.value = item.value;
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
    (md[type] || []).forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-2 p-2.5 bg-gray-50 rounded-xl border border-gray-100';
      row.innerHTML = `
        <span class="flex-1 text-sm font-medium text-gray-700">${escapeHTML(item.label)}</span>
        <span class="text-[10px] text-gray-400 bg-white px-2 py-0.5 rounded-lg border border-gray-100 font-mono">${escapeHTML(item.value)}</span>
        <button data-type="${type}" data-idx="${idx}" class="btn-remove-master w-7 h-7 flex items-center justify-center text-red-400 hover:bg-red-50 rounded-lg transition">
          <i class="fa-solid fa-trash text-xs"></i>
        </button>
      `;
      container.appendChild(row);
    });
  });

  // Bind remove buttons
  document.querySelectorAll('.btn-remove-master').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      const idx = parseInt(btn.dataset.idx);
      const md = getMasterData();
      md[type].splice(idx, 1);
      saveMasterData(md);
      renderMasterDataLists();
    });
  });
}

export function addMasterItem(type) {
  const label = document.getElementById(`input-new-${type}-label`)?.value.trim();
  const value = document.getElementById(`input-new-${type}-value`)?.value.trim();
  if (!label || !value) {
    Swal.fire('ข้อมูลไม่ครบ', 'กรุณากรอกทั้ง ชื่อ และ value', 'warning');
    return;
  }
  const md = getMasterData();
  if (md[type].some(x => x.value === value)) {
    Swal.fire('ซ้ำ', `value "${value}" มีอยู่แล้ว`, 'warning');
    return;
  }
  md[type].push({ value, label });
  saveMasterData(md);
  document.getElementById(`input-new-${type}-label`).value = '';
  document.getElementById(`input-new-${type}-value`).value = '';
  renderMasterDataLists();
  Swal.fire({ icon: 'success', title: 'เพิ่มสำเร็จ', toast: true, position: 'top-end', timer: 1200, showConfirmButton: false });
}
