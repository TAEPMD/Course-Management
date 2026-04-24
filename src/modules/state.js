/**
 * modules/state.js — Centralized Application State
 */

export const state = {
  pinInput: '',
  isLoggingIn: false,
  projects: [],
  users: [],
  currentProject: null,
  currentUserRole: null,
  currentUserName: null,
  currentWeekStart: new Date()
};
