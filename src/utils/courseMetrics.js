const PLACEHOLDER_NAME_PATTERN = /ใหม่|รอก|กรอก|new/i;

export const FISCAL_MONTH_NAMES = [
  'ต.ค.', 'พ.ย.', 'ธ.ค.', 'ม.ค.', 'ก.พ.', 'มี.ค.',
  'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.'
];

export function clampNumber(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

export function getFiscalMonthRange(startMonth, endMonth) {
  const start = clampNumber(startMonth, 1, 12, 1);
  const end = clampNumber(endMonth, 1, 12, start);
  const months = [];
  let current = start;

  for (let i = 0; i < 12; i += 1) {
    months.push(current);
    if (current === end) break;
    current = current === 12 ? 1 : current + 1;
  }

  return months;
}

export function isFiscalMonthInRange(month, startMonth, endMonth) {
  return getFiscalMonthRange(startMonth, endMonth).includes(Number(month));
}

export function getProjectExpense(project) {
  return (project?.ledger || [])
    .filter(entry => entry?.type !== 'income' && entry?.status !== 'rejected')
    .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
}

export function getBudgetUsage(project) {
  const budget = Number(project?.budget || 0);
  const expense = getProjectExpense(project);
  return {
    budget,
    expense,
    remaining: budget - expense,
    pct: budget > 0 ? Math.round((expense / budget) * 100) : 0
  };
}

export function getBudgetControl(project) {
  const budget = Number(project?.budget || 0);
  const ledger = project?.ledger || [];
  const expense = getProjectExpense(project);
  const paid = ledger
    .filter(entry => entry?.type !== 'income' && entry?.status === 'paid')
    .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const pendingClaim = ledger
    .filter(entry => entry?.type !== 'income' && ['approved', 'obligated', 'claiming'].includes(entry?.status || 'requested'))
    .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const usagePct = budget > 0 ? Math.round((expense / budget) * 100) : 0;

  return {
    budget,
    expense,
    paid,
    pendingClaim,
    remaining: budget - expense,
    usagePct
  };
}

export function getProjectProgressInsight(project, now = new Date()) {
  const readiness = getProjectReadiness(project);
  const schedules = project?.schedules || [];
  const datedSessions = schedules.filter(session => Boolean(session.date));
  const completedSessions = datedSessions.filter(session => {
    const date = new Date(session.date);
    date.setHours(23, 59, 59, 999);
    return date < now;
  });
  const scheduleScore = datedSessions.length
    ? Math.round((completedSessions.length / datedSessions.length) * 100)
    : 0;

  const docsScore = (project?.docs || []).length ? 100 : 0;
  const budget = getBudgetControl(project);
  const budgetScore = budget.budget > 0
    ? Math.min(Math.round((budget.paid / budget.budget) * 100), 100)
    : 0;

  const suggested = Math.round(
    (readiness.score * 0.35) +
    (scheduleScore * 0.35) +
    (budgetScore * 0.20) +
    (docsScore * 0.10)
  );
  const manual = clampNumber(project?.progress, 0, 100, 0);

  return {
    manual,
    suggested,
    gap: manual - suggested,
    readinessScore: readiness.score,
    scheduleScore,
    budgetScore,
    docsScore,
    completedSessions: completedSessions.length,
    totalSessions: datedSessions.length
  };
}

export function getProjectHealthInsight(project, now = new Date()) {
  const readiness = getProjectReadiness(project);
  const progress = getProjectProgressInsight(project, now);
  const budget = getBudgetControl(project);
  const issues = [];
  const warnings = [];

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const overdueClaims = (project?.ledger || []).filter(entry => {
    if (entry?.type === 'income' || entry?.status === 'paid' || entry?.status === 'rejected') return false;
    if (!entry?.dueDate) return false;
    const due = new Date(entry.dueDate);
    due.setHours(0, 0, 0, 0);
    return due < today;
  }).length;
  const pendingClaims = (project?.ledger || []).filter(entry =>
    entry?.type !== 'income' && ['obligated', 'claiming'].includes(entry?.status || '')
  ).length;

  if (budget.usagePct >= 100) issues.push('งบประมาณถูกใช้/ผูกพันเกินแผน');
  else if (budget.usagePct >= 85) warnings.push('งบประมาณใกล้เต็มวงเงิน');
  if (overdueClaims > 0) issues.push(`มีรายการเบิกเกินกำหนด ${overdueClaims} รายการ`);
  if (pendingClaims > 0) warnings.push(`มีรายการรอเบิก/ผูกพัน ${pendingClaims} รายการ`);
  if (readiness.score < 60) issues.push('ข้อมูลหลักสูตรยังไม่พร้อม');
  else if (readiness.score < 85) warnings.push('ข้อมูลหลักสูตรยังไม่ครบถ้วน');
  if (progress.manual + 20 < progress.suggested) warnings.push('ความคืบหน้าที่บันทึกต่ำกว่าข้อมูลจริงมาก');
  if (progress.manual - 25 > progress.suggested) warnings.push('ความคืบหน้าที่บันทึกสูงกว่าหลักฐานประกอบ');
  if (progress.totalSessions === 0) warnings.push('ยังไม่มีกำหนดการอบรมที่ระบุวันที่');

  const level = issues.length ? 'off-track' : warnings.length ? 'at-risk' : 'on-track';
  return {
    level,
    label: level === 'off-track' ? 'มีปัญหา' : level === 'at-risk' ? 'มีความเสี่ยง' : 'ปกติ',
    tone: level === 'off-track' ? 'rose' : level === 'at-risk' ? 'amber' : 'emerald',
    icon: level === 'off-track' ? 'fa-circle-xmark' : level === 'at-risk' ? 'fa-triangle-exclamation' : 'fa-circle-check',
    issues,
    warnings,
    reasons: [...issues, ...warnings],
    readiness,
    progress,
    budget
  };
}

export function getProjectReadiness(project) {
  const checks = [
    {
      key: 'name',
      label: 'ชื่อหลักสูตร',
      done: Boolean(project?.name?.trim()) && !PLACEHOLDER_NAME_PATTERN.test(project.name)
    },
    { key: 'budget', label: 'งบประมาณ', done: Number(project?.budget || 0) > 0 },
    { key: 'people', label: 'จำนวนผู้เข้าอบรม', done: Number(project?.people || 0) > 0 },
    {
      key: 'schedule',
      label: 'รอบอบรม',
      done: (project?.schedules || []).some(session => Boolean(session.date))
    },
    { key: 'calendar', label: 'ช่วงดำเนินงาน', done: Boolean(project?.startMonth && project?.endMonth) },
    { key: 'category', label: 'ประเภท/กลุ่มเป้าหมาย', done: Boolean(project?.category && project?.audience) },
    { key: 'assessment', label: 'การประเมินผล', done: Boolean(project?.assessment) }
  ];

  const complete = checks.filter(check => check.done).length;
  const score = Math.round((complete / checks.length) * 100);
  const missing = checks.filter(check => !check.done).map(check => check.label);

  return {
    score,
    complete,
    total: checks.length,
    missing,
    label: score >= 85 ? 'พร้อมใช้งาน' : score >= 60 ? 'ต้องเติมข้อมูล' : 'ยังไม่พร้อม',
    tone: score >= 85 ? 'emerald' : score >= 60 ? 'amber' : 'rose'
  };
}

export function validateProject(project) {
  const errors = [];
  const name = project?.name?.trim() || '';
  const progress = clampNumber(project?.progress, 0, 100, 0);
  const startMonth = clampNumber(project?.startMonth, 1, 12, 1);
  const endMonth = clampNumber(project?.endMonth, 1, 12, startMonth);

  if (!name || PLACEHOLDER_NAME_PATTERN.test(name)) errors.push('กรุณาระบุชื่อหลักสูตรให้ชัดเจน');
  if (!String(project?.year || '').trim()) errors.push('กรุณาระบุปีงบประมาณ');
  if (Number(project?.budget || 0) < 0) errors.push('งบประมาณต้องไม่ติดลบ');
  if (Number(project?.people || 0) < 0) errors.push('จำนวนผู้เข้าอบรมต้องไม่ติดลบ');
  if (progress < 0 || progress > 100) errors.push('ความคืบหน้าต้องอยู่ระหว่าง 0-100%');
  if (!startMonth || !endMonth) errors.push('กรุณาระบุช่วงเดือนดำเนินงาน');

  return { errors, progress, startMonth, endMonth };
}
