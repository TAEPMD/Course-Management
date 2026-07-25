/**
 * modules/state.js — Centralized Application State
 */

export const state = {
  pinInput: '',
  isLoggingIn: false,
  loginLockedUntil: 0,   // epoch ms — ระหว่างนี้หน้า Login ถูกล็อกชั่วคราว
  _idleReset: null,      // ตัว handler สำหรับ auto-logout เมื่อไม่มีการใช้งาน
  projects: [],
  users: [],
  currentProject: null,
  currentUserRole: null,
  currentUserName: null,
  currentUserId: null,
  currentWeekStart: new Date(),
  projectFilter: '',
  courseManagementFilter: {
    q: '',
    status: 'all',
    year: 'all',
    health: 'all'
  }
};
