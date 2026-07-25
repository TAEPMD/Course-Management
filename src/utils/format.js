/**
 * utils/format.js
 * Formatting utilities
 */

export function formatCurrency(n) {
  return new Intl.NumberFormat('th-TH', { style: 'decimal', maximumFractionDigits: 0 }).format(n || 0);
}

export function escapeHTML(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
