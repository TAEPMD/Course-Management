/** Project accounting UI — double-entry GL, statements and reconciliation. */
import { state } from './state.js';
import * as gas from '../gas.js';
import { escapeHTML, escapeJsAttr, formatCurrency } from '../utils/format.js';
import {
  CHART_OF_ACCOUNTS,
  buildProjectJournals,
  getAccount,
  getAccountingControl,
  validateJournal,
} from '../utils/accounting.js';

const canManageAccounting = () => ['Admin', 'Staff'].includes(state.currentUserRole);
const todayISO = () => new Date().toISOString().slice(0, 10);
const journalId = () => `jnl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function ensureAccounting(project) {
  if (!project.accounting || typeof project.accounting !== 'object') project.accounting = {};
  if (!Array.isArray(project.accounting.journals)) project.accounting.journals = [];
  if (!Array.isArray(project.accounting.reconciliations)) project.accounting.reconciliations = [];
  return project.accounting;
}

function denyAccounting() {
  Swal.fire({ icon: 'error', title: 'ไม่มีสิทธิ์บันทึกบัญชี', text: 'ลงรายการ ปิดงวด และกระทบยอดได้เฉพาะ Admin หรือ Staff' });
}

async function persistAccounting() {
  const project = state.currentProject;
  if (!project) return;
  project.updatedAt = new Date().toISOString();
  await gas.saveProject(project);
}

function accountOptions(selected = '') {
  const groups = [
    ['asset', 'สินทรัพย์'], ['liability', 'หนี้สิน'], ['equity', 'ทุน'], ['income', 'รายได้'], ['expense', 'ค่าใช้จ่าย'],
  ];
  return groups.map(([type, label]) => `
    <optgroup label="${label}">
      ${CHART_OF_ACCOUNTS.filter(account => account.type === type).map(account => `
        <option value="${account.code}" ${account.code === selected ? 'selected' : ''}>${account.code} — ${escapeHTML(account.name)}</option>`).join('')}
    </optgroup>`).join('');
}

function accountRows(rows, emptyText) {
  return rows.length
    ? rows.map(row => `<div class="account-statement-row"><span>${row.code} ${escapeHTML(row.name)}</span><b>${formatCurrency(row.balance)}</b></div>`).join('')
    : `<p class="account-empty">${emptyText}</p>`;
}

function journalLinesLabel(journal) {
  return journal.lines.map(item => {
    const account = getAccount(item.account);
    const side = Number(item.debit || 0) > 0 ? 'Dr' : 'Cr';
    const amount = Number(item.debit || item.credit || 0);
    return `${side} ${item.account} ${account?.name || ''} ${formatCurrency(amount)}`;
  }).join(' • ');
}

export async function setAccountingOpeningBalance() {
  const project = state.currentProject;
  if (!project) return;
  if (!canManageAccounting()) return denyAccounting();
  const accounting = ensureAccounting(project);
  const { value } = await Swal.fire({
    title: 'กำหนดยอดยกมาบัญชีโครงการ',
    html: `
      <div class="swal-account-form">
        <label><span>วันที่ยอดยกมา</span><input id="swal-account-opening-date" type="date" value="${escapeHTML(accounting.openingDate || todayISO())}"></label>
        <label><span>เงินสดและเงินฝากยกมา</span><input id="swal-account-opening" type="number" min="0" step="0.01" value="${Number(accounting.openingCash || 0)}"></label>
        <p>ระบบจะลงบัญชี Dr เงินฝากธนาคาร / Cr เงินทุนโครงการให้อัตโนมัติ</p>
      </div>`,
    showCancelButton: true,
    confirmButtonText: 'บันทึกยอดยกมา', cancelButtonText: 'ยกเลิก',
    preConfirm: () => ({
      date: document.getElementById('swal-account-opening-date')?.value || '',
      amount: Math.max(0, Number(document.getElementById('swal-account-opening')?.value) || 0),
    }),
  });
  if (!value) return;
  accounting.openingDate = value.date;
  accounting.openingCash = value.amount;
  accounting.updatedAt = new Date().toISOString();
  accounting.updatedBy = state.currentUserName || 'ไม่ระบุผู้ใช้';
  await persistAccounting();
  renderAccounting(project);
}

export async function addAccountingJournal() {
  const project = state.currentProject;
  if (!project) return;
  if (!canManageAccounting()) return denyAccounting();
  const accounting = ensureAccounting(project);
  const { value } = await Swal.fire({
    title: 'ลงสมุดรายวันปรับปรุง',
    width: 720,
    html: `
      <div class="swal-account-form">
        <div class="swal-account-two">
          <label><span>วันที่ลงบัญชี</span><input id="swal-journal-date" type="date" value="${todayISO()}"></label>
          <label><span>เลขอ้างอิง</span><input id="swal-journal-ref" type="text" placeholder="JV-001"></label>
        </div>
        <label><span>คำอธิบายรายการ</span><input id="swal-journal-desc" type="text" placeholder="เช่น ตั้งค่าใช้จ่ายค้างจ่ายปลายงวด"></label>
        <div class="swal-account-two">
          <label><span>บัญชีเดบิต</span><select id="swal-journal-debit">${accountOptions('5102')}</select></label>
          <label><span>บัญชีเครดิต</span><select id="swal-journal-credit">${accountOptions('2200')}</select></label>
        </div>
        <label><span>จำนวนเงิน</span><input id="swal-journal-amount" type="number" min="0.01" step="0.01" placeholder="0.00"></label>
        <p>รายการจะบันทึกได้เมื่อเดบิตเท่ากับเครดิตเท่านั้น</p>
      </div>`,
    showCancelButton: true,
    confirmButtonText: 'Post รายการ', cancelButtonText: 'ยกเลิก', focusConfirm: false,
    preConfirm: () => {
      const date = document.getElementById('swal-journal-date')?.value || '';
      const debitAccount = document.getElementById('swal-journal-debit')?.value || '';
      const creditAccount = document.getElementById('swal-journal-credit')?.value || '';
      const amount = Math.max(0, Number(document.getElementById('swal-journal-amount')?.value) || 0);
      if (accounting.closedThrough && date <= accounting.closedThrough) return Swal.showValidationMessage(`งวดบัญชีถึงวันที่ ${accounting.closedThrough} ถูกปิดแล้ว`);
      if (debitAccount === creditAccount) return Swal.showValidationMessage('บัญชีเดบิตและเครดิตต้องไม่ใช่บัญชีเดียวกัน');
      const journal = {
        id: journalId(), date,
        ref: document.getElementById('swal-journal-ref')?.value.trim() || '',
        description: document.getElementById('swal-journal-desc')?.value.trim() || '',
        source: 'manual', status: 'posted',
        postedAt: new Date().toISOString(), postedBy: state.currentUserName || 'ไม่ระบุผู้ใช้',
        lines: [{ account: debitAccount, debit: amount, credit: 0 }, { account: creditAccount, debit: 0, credit: amount }],
      };
      const check = validateJournal(journal);
      if (!check.valid) return Swal.showValidationMessage(check.errors.join(' • '));
      return journal;
    },
  });
  if (!value) return;
  accounting.journals.push(value);
  accounting.updatedAt = new Date().toISOString();
  await persistAccounting();
  renderAccounting(project);
}

export async function voidAccountingJournal(id) {
  const project = state.currentProject;
  if (!project || !canManageAccounting()) return denyAccounting();
  const accounting = ensureAccounting(project);
  const journal = accounting.journals.find(item => item.id === id);
  if (!journal || journal.status === 'voided') return;
  if (accounting.closedThrough && journal.date <= accounting.closedThrough) {
    return Swal.fire({ icon: 'error', title: 'ยกเลิกไม่ได้', text: 'รายการอยู่ในงวดที่ปิดบัญชีแล้ว ให้ลงรายการกลับบัญชีในงวดปัจจุบันแทน' });
  }
  const result = await Swal.fire({ icon: 'warning', title: 'ยกเลิกรายการบัญชี?', text: journal.description, showCancelButton: true, confirmButtonText: 'ยืนยันยกเลิก', cancelButtonText: 'กลับ' });
  if (!result.isConfirmed) return;
  journal.status = 'voided';
  journal.voidedAt = new Date().toISOString();
  journal.voidedBy = state.currentUserName || 'ไม่ระบุผู้ใช้';
  await persistAccounting();
  renderAccounting(project);
}

export async function reconcileBankAccount() {
  const project = state.currentProject;
  if (!project) return;
  if (!canManageAccounting()) return denyAccounting();
  const accounting = ensureAccounting(project);
  const control = getAccountingControl(project);
  const { value } = await Swal.fire({
    title: 'Bank Reconciliation',
    html: `
      <div class="swal-account-form">
        <p class="swal-account-book">ยอดตามบัญชี <b>${formatCurrency(control.bank)} บาท</b></p>
        <label><span>วันที่ Statement</span><input id="swal-reconcile-date" type="date" value="${todayISO()}"></label>
        <label><span>ยอดตาม Bank Statement</span><input id="swal-reconcile-balance" type="number" step="0.01" value="${control.bank}"></label>
        <label><span>หมายเหตุ/รายการค้างกระทบยอด</span><input id="swal-reconcile-note" type="text" placeholder="เช่น ค่าธรรมเนียมธนาคารยังไม่ลงบัญชี"></label>
      </div>`,
    showCancelButton: true,
    confirmButtonText: 'บันทึกกระทบยอด', cancelButtonText: 'ยกเลิก',
    preConfirm: () => {
      const statementBalance = Number(document.getElementById('swal-reconcile-balance')?.value);
      if (!Number.isFinite(statementBalance)) return Swal.showValidationMessage('กรุณาระบุยอดตาม Statement');
      return {
        id: `rec-${Date.now().toString(36)}`,
        date: document.getElementById('swal-reconcile-date')?.value || todayISO(),
        bookBalance: control.bank, statementBalance,
        difference: Math.round((statementBalance - control.bank) * 100) / 100,
        note: document.getElementById('swal-reconcile-note')?.value.trim() || '',
        reconciledAt: new Date().toISOString(), reconciledBy: state.currentUserName || 'ไม่ระบุผู้ใช้',
      };
    },
  });
  if (!value) return;
  accounting.reconciliations.push(value);
  accounting.reconciliations = accounting.reconciliations.slice(-24);
  await persistAccounting();
  renderAccounting(project);
}

export async function closeAccountingPeriod() {
  const project = state.currentProject;
  if (!project) return;
  if (!canManageAccounting()) return denyAccounting();
  const accounting = ensureAccounting(project);
  const { value: date } = await Swal.fire({
    icon: 'warning', title: 'ปิดงวดบัญชี',
    text: 'รายการก่อนหรือเท่ากับวันที่ปิดงวดจะไม่สามารถแก้ไขหรือยกเลิกได้',
    input: 'date', inputValue: accounting.closedThrough || todayISO(),
    showCancelButton: true, confirmButtonText: 'ยืนยันปิดงวด', cancelButtonText: 'ยกเลิก',
    inputValidator: value => !value ? 'กรุณาระบุวันที่ปิดงวด' : undefined,
  });
  if (!date) return;
  accounting.closedThrough = date;
  accounting.closedAt = new Date().toISOString();
  accounting.closedBy = state.currentUserName || 'ไม่ระบุผู้ใช้';
  await persistAccounting();
  renderAccounting(project);
}

export function exportAccountingReport() {
  const project = state.currentProject;
  if (!project) return;
  const control = getAccountingControl(project);
  const journals = buildProjectJournals(project);
  const rows = [
    ['รายงานบัญชีโครงการ'], ['โครงการ', project.name || project.id || '-'], ['วันที่ออกรายงาน', new Date().toLocaleString('th-TH')],
    [], ['งบทดลอง'], ['รหัสบัญชี', 'ชื่อบัญชี', 'เดบิต', 'เครดิต', 'คงเหลือ'],
    ...control.trial.rows.map(row => [row.code, row.name, row.debit, row.credit, row.balance]),
    ['รวม', '', control.trial.debit, control.trial.credit, ''],
    [], ['งบรายได้และค่าใช้จ่าย'], ['รายได้', control.income.total], ['ค่าใช้จ่าย', control.expenses.total], ['รายได้สูง/(ต่ำ)กว่าค่าใช้จ่าย', control.surplus],
    [], ['งบฐานะการเงิน'], ['สินทรัพย์', control.assets.total], ['หนี้สิน', control.liabilities.total], ['ทุนและผลสะสม', control.equity.total], ['ผลต่างสมการบัญชี', control.equationDifference],
    [], ['สมุดรายวันทั่วไป'], ['วันที่', 'เลขอ้างอิง', 'คำอธิบาย', 'แหล่งที่มา', 'บัญชี', 'เดบิต', 'เครดิต'],
  ];
  journals.forEach(journal => journal.lines.forEach(item => rows.push([
    journal.date, journal.ref, journal.description, journal.source, `${item.account} ${getAccount(item.account)?.name || ''}`, item.debit || 0, item.credit || 0,
  ])));
  const csv = rows.map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${project.id || 'project'}-accounting-${todayISO()}.csv`;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function renderAccounting(projectValue) {
  const project = projectValue || state.currentProject;
  const panel = document.getElementById('accounting-panel');
  if (!project || !panel) return;
  const accounting = ensureAccounting(project);
  const control = getAccountingControl(project);
  const journals = buildProjectJournals(project);
  const canManage = canManageAccounting();
  const equationOk = Math.abs(control.equationDifference) < .01;
  const reconciliation = control.latestReconciliation;

  panel.innerHTML = `
    <section class="accounting-shell">
      <header class="accounting-head">
        <div>
          <span>PROJECT ACCOUNTING</span>
          <h4>บัญชีโครงการและการควบคุมทางการเงิน</h4>
          <p>ระบบบัญชีคู่ที่เชื่อมรายการงบประมาณอัตโนมัติ พร้อมงบทดลอง งบการเงิน และกระทบยอดธนาคาร</p>
        </div>
        <div class="accounting-head-actions">
          <span class="accounting-health ${control.tone}"><i class="fa-solid fa-shield-halved"></i>Accounting Health ${control.score}/100</span>
          ${accounting.closedThrough ? `<span class="accounting-closed"><i class="fa-solid fa-lock"></i>ปิดงวดถึง ${escapeHTML(accounting.closedThrough)}</span>` : ''}
          <button onclick="app.setAccountingOpeningBalance()" ${canManage ? '' : 'disabled'}><i class="fa-solid fa-wallet"></i>ยอดยกมา</button>
          <button onclick="app.addAccountingJournal()" class="primary" ${canManage ? '' : 'disabled'}><i class="fa-solid fa-plus"></i>ลงรายการปรับปรุง</button>
          <button onclick="app.reconcileBankAccount()" ${canManage ? '' : 'disabled'}><i class="fa-solid fa-building-columns"></i>กระทบยอด</button>
          <button onclick="app.closeAccountingPeriod()" ${canManage ? '' : 'disabled'}><i class="fa-solid fa-lock"></i>ปิดงวด</button>
          <button onclick="app.exportAccountingReport()"><i class="fa-solid fa-file-export"></i>CSV</button>
        </div>
      </header>

      <div class="accounting-kpi-grid">
        <article><span><i class="fa-solid fa-building-columns"></i>เงินฝากตามบัญชี</span><strong>${formatCurrency(control.bank)}</strong><small>บัญชี 1100</small></article>
        <article class="${control.payable > 0 ? 'watch' : ''}"><span><i class="fa-solid fa-file-invoice-dollar"></i>เจ้าหนี้คงค้าง</span><strong>${formatCurrency(control.payable)}</strong><small>บัญชี 2100</small></article>
        <article><span><i class="fa-solid fa-file-signature"></i>ภาระผูกพันนอก GL</span><strong>${formatCurrency(control.openCommitments)}</strong><small>อนุมัติ/ก่อหนี้ที่ยังไม่วางบิล</small></article>
        <article class="${control.surplus < 0 ? 'risk' : 'good'}"><span><i class="fa-solid fa-chart-line"></i>รายได้สูง/(ต่ำ)กว่าค่าใช้จ่าย</span><strong>${formatCurrency(control.surplus)}</strong><small>ผลการดำเนินงานโครงการ</small></article>
        <article class="${equationOk ? 'good' : 'risk'}"><span><i class="fa-solid fa-scale-balanced"></i>สมการบัญชี</span><strong>${equationOk ? 'สมดุล' : formatCurrency(control.equationDifference)}</strong><small>สินทรัพย์ = หนี้สิน + ทุน</small></article>
      </div>

      <div class="accounting-equation ${equationOk ? 'good' : 'risk'}">
        <div><span>สินทรัพย์</span><strong>${formatCurrency(control.assets.total)}</strong></div><i class="fa-solid fa-equals"></i>
        <div><span>หนี้สิน</span><strong>${formatCurrency(control.liabilities.total)}</strong></div><i class="fa-solid fa-plus"></i>
        <div><span>ทุนและผลสะสม</span><strong>${formatCurrency(control.equity.total)}</strong></div>
      </div>

      <div class="accounting-statements">
        <article class="account-statement-card">
          <div class="account-card-head"><span><i class="fa-solid fa-chart-column"></i></span><div><strong>งบรายได้และค่าใช้จ่าย</strong><small>Project Income Statement</small></div></div>
          <h6>รายได้</h6>${accountRows(control.income.rows, 'ยังไม่มีรายได้ที่รับรู้')}
          <div class="account-statement-total"><span>รวมรายได้</span><b>${formatCurrency(control.income.total)}</b></div>
          <h6>ค่าใช้จ่าย</h6>${accountRows(control.expenses.rows, 'ยังไม่มีค่าใช้จ่ายที่รับรู้')}
          <div class="account-statement-total"><span>รวมค่าใช้จ่าย</span><b>${formatCurrency(control.expenses.total)}</b></div>
          <div class="account-statement-result ${control.surplus < 0 ? 'risk' : ''}"><span>รายได้สูง/(ต่ำ)กว่าค่าใช้จ่าย</span><b>${formatCurrency(control.surplus)}</b></div>
        </article>
        <article class="account-statement-card">
          <div class="account-card-head"><span><i class="fa-solid fa-landmark"></i></span><div><strong>งบฐานะการเงิน</strong><small>Statement of Financial Position</small></div></div>
          <h6>สินทรัพย์</h6>${accountRows(control.assets.rows, 'ยังไม่มีสินทรัพย์')}
          <div class="account-statement-total"><span>รวมสินทรัพย์</span><b>${formatCurrency(control.assets.total)}</b></div>
          <h6>หนี้สิน</h6>${accountRows(control.liabilities.rows, 'ไม่มีหนี้สินคงค้าง')}
          <div class="account-statement-total"><span>รวมหนี้สิน</span><b>${formatCurrency(control.liabilities.total)}</b></div>
          <h6>ทุนและผลการดำเนินงาน</h6>${accountRows(control.equity.rows, 'ยังไม่มียอดทุนยกมา')}
          <div class="account-statement-row"><span>ผลการดำเนินงานงวดปัจจุบัน</span><b>${formatCurrency(control.surplus)}</b></div>
          <div class="account-statement-result"><span>รวมหนี้สินและทุน</span><b>${formatCurrency(control.liabilities.total + control.equity.total)}</b></div>
        </article>
      </div>

      <article class="account-table-card">
        <div class="account-card-head"><span><i class="fa-solid fa-table-list"></i></span><div><strong>งบทดลอง</strong><small>Trial Balance — เดบิตต้องเท่ากับเครดิต</small></div><em class="${control.trial.balanced ? 'good' : 'risk'}">${control.trial.balanced ? 'Balanced' : 'Unbalanced'}</em></div>
        <div class="account-table-scroll"><table><thead><tr><th>รหัส</th><th>ชื่อบัญชี</th><th>ประเภท</th><th class="number">เดบิต</th><th class="number">เครดิต</th><th class="number">คงเหลือ</th></tr></thead><tbody>
          ${control.trial.rows.map(row => `<tr><td><code>${row.code}</code></td><td>${escapeHTML(row.name)}</td><td>${row.type}</td><td class="number">${formatCurrency(row.debit)}</td><td class="number">${formatCurrency(row.credit)}</td><td class="number strong">${formatCurrency(row.balance)}</td></tr>`).join('') || '<tr><td colspan="6" class="account-empty-cell">ยังไม่มีรายการบัญชี</td></tr>'}
          <tr class="account-table-total"><td colspan="3">รวม</td><td class="number">${formatCurrency(control.trial.debit)}</td><td class="number">${formatCurrency(control.trial.credit)}</td><td></td></tr>
        </tbody></table></div>
      </article>

      <div class="accounting-bottom-grid">
        <article class="account-table-card">
          <div class="account-card-head"><span><i class="fa-solid fa-book"></i></span><div><strong>สมุดรายวันทั่วไป</strong><small>${journals.length} รายการ — เชื่อมจากงบประมาณและรายการปรับปรุง</small></div></div>
          <div class="account-journal-list">
            ${journals.slice(-30).reverse().map(journal => `
              <div class="account-journal-row">
                <span class="account-source ${journal.source}">${journal.source === 'budget' ? 'AUTO' : 'JV'}</span>
                <div><strong>${escapeHTML(journal.description)}</strong><small>${escapeHTML(journal.date || '-')} • ${escapeHTML(journal.ref || 'ไม่มีเลขอ้างอิง')}</small><p>${escapeHTML(journalLinesLabel(journal))}</p></div>
                ${journal.source === 'manual' && canManage ? `<button onclick="app.voidAccountingJournal('${escapeJsAttr(journal.id)}')" title="ยกเลิกรายการ"><i class="fa-solid fa-ban"></i></button>` : ''}
              </div>`).join('') || '<p class="account-empty">ยังไม่มีรายการบัญชี</p>'}
          </div>
        </article>
        <article class="account-reconcile-card ${reconciliation && Math.abs(control.reconciliationDifference) < .01 ? 'good' : 'watch'}">
          <div class="account-card-head"><span><i class="fa-solid fa-building-columns"></i></span><div><strong>Bank Reconciliation</strong><small>กระทบยอดบัญชีกับ Statement</small></div></div>
          ${reconciliation ? `
            <div class="account-reconcile-result"><span>วันที่ Statement</span><b>${escapeHTML(reconciliation.date)}</b></div>
            <div class="account-reconcile-result"><span>ยอดตามบัญชี</span><b>${formatCurrency(reconciliation.bookBalance)}</b></div>
            <div class="account-reconcile-result"><span>ยอดตามธนาคาร</span><b>${formatCurrency(reconciliation.statementBalance)}</b></div>
            <div class="account-reconcile-diff"><span>ผลต่าง</span><strong>${formatCurrency(reconciliation.difference)}</strong></div>
            ${reconciliation.note ? `<p>${escapeHTML(reconciliation.note)}</p>` : ''}
          ` : '<p class="account-empty">ยังไม่เคยกระทบยอดธนาคาร</p>'}
        </article>
      </div>
    </section>`;
}
