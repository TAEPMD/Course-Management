/**
 * utils/format.js
 * Formatting utilities
 */

export function formatCurrency(n) {
  return new Intl.NumberFormat('th-TH', { style: 'decimal', maximumFractionDigits: 0 }).format(n || 0);
}

export function formatDate(dateStr) {
  if (!dateStr) return '-';
  try {
    return new Date(dateStr).toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return dateStr; }
}

export function escapeHTML(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export async function hashPIN(pin) {
  const encoder = new TextEncoder();
  const data = encoder.encode(pin);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export function generateId(prefix, count, year) {
  const y = year || (new Date().getFullYear() + 543).toString().slice(-2);
  return `${prefix}-${y}-${String(count + 1).padStart(2, '0')}`;
}
