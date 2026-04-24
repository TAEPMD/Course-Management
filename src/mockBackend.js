/**
 * mockBackend.js — Development Mock Backend
 * Used ONLY when running via Vite dev server (not GAS)
 */

export const mockBackend = {
  users: [
    { id: 'U-001', name: 'Administrator', role: 'Admin', email: 'admin@niem.go.th', phone: '-', pin: '68009' }
  ],

  verifyPin(pin) {
    const user = this.users.find(u => u.pin === pin);
    return Promise.resolve(user ? { ...user } : null);
  },

  getProjects() {
    const stored = localStorage.getItem('dev_projects');
    return Promise.resolve(stored ? JSON.parse(stored) : []);
  }
};
