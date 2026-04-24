/**
 * gas.js — Google Apps Script Bridge Layer
 *
 * ชั้นกลางสำหรับเรียก GAS functions
 * ถ้าอยู่ใน GAS environment → เรียก google.script.run
 * ถ้าอยู่ใน Dev (Vite) environment → เรียก mockBackend
 */

import { mockBackend } from './mockBackend.js';

const isGAS = () => typeof google !== 'undefined' && google.script;

/**
 * Wraps google.script.run into a Promise
 */
function gasRun(funcName, ...args) {
  return new Promise((resolve, reject) => {
    let runner = google.script.run
      .withSuccessHandler(resolve)
      .withFailureHandler(reject);
    runner[funcName](...args);
  });
}

// --- Auth ---
export async function verifyPin(pin) {
  if (isGAS()) return gasRun('verifyPin', pin);
  return mockBackend.verifyPin(pin);
}

export async function getSessionUser() {
  if (isGAS()) return gasRun('getSessionUser');
  return null;
}

export async function logout() {
  if (isGAS()) return gasRun('logout');
}

// --- Settings ---
export async function getSystemSettings() {
  if (isGAS()) return gasRun('getSystemSettings');
  return JSON.parse(localStorage.getItem('system_settings') || '{}');
}

export async function saveSystemSetting(key, value) {
  if (isGAS()) return gasRun('saveSystemSetting', key, value);
  const settings = JSON.parse(localStorage.getItem('system_settings') || '{}');
  settings[key] = value;
  localStorage.setItem('system_settings', JSON.stringify(settings));
  return true;
}

// --- Projects ---
export async function getProjects() {
  if (isGAS()) return gasRun('getProjects');
  return mockBackend.getProjects();
}

export async function saveProject(project) {
  if (isGAS()) return gasRun('saveProject', project);
  // Dev: store in localStorage
  const projects = JSON.parse(localStorage.getItem('dev_projects') || '[]');
  const idx = projects.findIndex(p => p.id === project.id);
  if (idx > -1) projects[idx] = project;
  else projects.unshift(project);
  localStorage.setItem('dev_projects', JSON.stringify(projects));
  return true;
}

export async function deleteProject(projectId) {
  if (isGAS()) return gasRun('deleteProject', projectId);
  const projects = JSON.parse(localStorage.getItem('dev_projects') || '[]');
  localStorage.setItem('dev_projects', JSON.stringify(projects.filter(p => p.id !== projectId)));
  return true;
}

// --- Users ---
export async function getUsers() {
  if (isGAS()) return gasRun('getUsers');
  return mockBackend.users.map(u => ({ ...u }));
}

export async function saveUserBackend(userData) {
  if (isGAS()) return gasRun('saveUserBackend', userData);
  const idx = mockBackend.users.findIndex(u => u.id === userData.id);
  if (idx > -1) mockBackend.users[idx] = userData;
  else mockBackend.users.push(userData);
  return true;
}

export async function deleteUserBackend(userId) {
  if (isGAS()) return gasRun('deleteUserBackend', userId);
  mockBackend.users = mockBackend.users.filter(u => u.id !== userId);
  return true;
}

// --- File Upload ---
export async function uploadFile(base64Data, filename) {
  if (isGAS()) return gasRun('uploadFile', base64Data, filename);
  throw new Error('Upload requires Google Apps Script — not available in Dev mode');
}
