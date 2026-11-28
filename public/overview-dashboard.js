(function () {
  'use strict';

  let showAllPriorities = false;
  let searchTimer = null;
  let lastAdminName = 'Admin';
  let lastAdminRole = 'Administrator';
  let currentPriorities = [];
  let cachedStudentLimit = null;

  const TAB_TITLES = {
    'tab-overview': null,
    'tab-students': 'Students',
    'tab-classes': 'Classes & Sections',
    'tab-attendance': 'Attendance',
    'tab-stats': 'Attendance Stats',
    'tab-announcements': 'Announcements',
    'tab-qr-attendance': 'QR Staff Attendance',
    'tab-fees': 'Fees',
    'tab-teachers': 'Teachers',
    'tab-coordinators': 'Coordinators',
    'tab-complaints': 'Complaints',
    'tab-branches': 'Branches',
    'tab-settings': 'Settings',
  };

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatPKR(num) {
    const n = Number(num) || 0;
    if (n >= 1000000) return 'PKR ' + (n / 1000000).toFixed(2) + 'M';
    return 'PKR ' + Math.round(n).toLocaleString('en-PK');
  }

  function greetingForHour(h) {
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }

  function extractFirstName(fullName) {
    const cleaned = String(fullName || 'Admin')
      .replace(/\([^)]*\)/g, '')
      .replace(/^(mr|mrs|ms|miss|dr|prof)\.?\s+/i, '')
      .trim();
    const first = cleaned.split(/\s+/)[0] || 'Admin';
    return first.charAt(0).toUpperCase() + first.slice(1);
  }

  function initials(name) {
    const cleaned = String(name || 'Admin').replace(/\([^)]*\)/g, '').trim();
    const parts = cleaned.split(/\s+/);
    return parts.slice(0, 2).map(p => (p[0] ? p[0].toUpperCase() : '')).join('') || 'AD';
  }

  function shortDateLabel(isoDate) {
    if (!isoDate) return '';
    const d = new Date(isoDate + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function buildGauge(pct, totalPills) {
    const count = totalPills || 10;
    const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
    const filled = clamped === 0 ? 0 : Math.max(1, Math.round((clamped / 100) * count));
    let html = '<div class="ov-gauge" aria-hidden="true">';
    for (let i = 0; i < count; i++) {
      html += `<div class="ov-gauge-pill ${i < filled ? 'filled' : 'empty'}"></div>`;
    }
    html += '</div>';
    return html;
  }

  function updateHeaderForTab(tabId) {
    const titleEl = document.getElementById('ovGreeting');
    const active = tabId || 'tab-overview';
    const customTitle = TAB_TITLES[active];
    if (titleEl) {
      if (customTitle) {
        titleEl.textContent = customTitle;
      } else {
        const now = new Date();
        titleEl.textContent = `${greetingForHour(now.getHours())}, ${extractFirstName(lastAdminName)}`;
      }
    }
  }

  function navigateToTarget(tab, href, searchValue) {
    if (tab && typeof window.switchTab === 'function') {
      window.switchTab(tab, false);
      if (searchValue) {
        setTimeout(() => {
          const inputId = tab === 'tab-students' ? 'studentSearchInput'
            : tab === 'tab-teachers' ? 'teacherSearchInput'
            : null;
          if (inputId) {
            const el = document.getElementById(inputId);
            if (el) {
              el.value = searchValue;
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
          }
        }, 80);
      }
      return;
    }
    if (href) {
      window.location.href = href;
    }
  }

  function consolidatePriorities(rawPriorities) {
    const list = Array.isArray(rawPriorities) ? rawPriorities : [];
    const seen = new Set();
    const out = [];
    const hasUnassigned = list.some(p => p && p.id === 'unassigned-classes');

    const actionLabels = {
      'unassigned-classes': 'Assign',
      'unmarked-attendance': 'Mark',
      'overdue-fees': 'Review',
      'absent-today': 'View',
      'pending-complaints': 'Review',
    };

    for (const item of list) {
      if (!item || !item.id) continue;
      if (item.id === 'teacher-coverage' || (item.id === 'timetable-unplaced' && hasUnassigned)) {
        continue;
      }
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push({
        ...item,
        actionLabel: actionLabels[item.id] || 'Open',
      });
    }
    return out;
  }

  function getReadNotifs() {
    try {
      return new Set(JSON.parse(localStorage.getItem('eye-read-notifs') || '[]'));
    } catch (_) {
      return new Set();
    }
  }

  function saveReadNotifs(set) {
    try {
      localStorage.setItem('eye-read-notifs', JSON.stringify(Array.from(set)));
    } catch (_) {}
  }

  function renderNotifications(priorities) {
    currentPriorities = priorities || [];
    const readSet = getReadNotifs();
    const unread = currentPriorities.filter(p => !readSet.has(p.id));

    const dot = document.getElementById('notifBadgeDot');
    if (dot) {
      if (unread.length > 0) {
        dot.textContent = unread.length > 9 ? '9+' : String(unread.length);
        dot.style.display = 'inline-flex';
      } else {
        dot.style.display = 'none';
      }
    }

    const listEl = document.getElementById('notifPanelList');
    if (!listEl) return;

    if (unread.length === 0) {
      listEl.innerHTML = `<div class="ov-empty" style="padding:16px;"><i class="fas fa-circle-check"></i><span>You're all caught up</span></div>`;
      return;
    }

    listEl.innerHTML = unread.map(n => `
      <button type="button" class="eye-notif-item" data-notif-id="${esc(n.id)}"
        ${n.targetTab ? `data-nav-tab="${esc(n.targetTab)}"` : ''}
        ${n.targetHref ? `data-nav-href="${esc(n.targetHref)}"` : ''}>
        <div class="eye-notif-item-title">${esc(n.title)}</div>
        <div class="eye-notif-item-desc">${esc(n.meta || 'Needs attention')} · Just now</div>
      </button>`).join('');
  }

  function syncYearSelector(data) {
    const sel = document.getElementById('academicYearSelect');
    if (!sel) return;
    const years = Array.isArray(data.availableYears) && data.availableYears.length > 0
      ? data.availableYears
      : [data.currentAcademicYear || '2026-27'];

    const urlYear = new URLSearchParams(window.location.search).get('year');
    const savedYear = urlYear || localStorage.getItem('eye-selected-year') || data.selectedYear || years[0];
    const activeYear = years.includes(savedYear) ? savedYear : years[0];

    sel.innerHTML = years.map(y => `<option value="${esc(y)}">${esc(y)}</option>`).join('');
    sel.value = activeYear;
    window.appData = window.appData || {};
    window.appData.selectedYear = activeYear;
    localStorage.setItem('eye-selected-year', activeYear);

    const trendYearSel = document.getElementById('trendYearSelect');
    if (trendYearSel) {
      trendYearSel.innerHTML = years.map(y => `<option value="${esc(y)}">${esc(y)}</option>`).join('');
      trendYearSel.value = activeYear;
    }

    const settingsYearsList = document.getElementById('settingsYearsList');
    if (settingsYearsList) {
      settingsYearsList.innerHTML = years.map(y => `
        <span class="btn btn-sm ${y === activeYear ? 'btn-primary' : 'btn-secondary'}" style="cursor:default;">
          ${esc(y)}${y === data.currentAcademicYear ? ' (Current)' : ''}
        </span>`).join('');
    }
  }

  function renderHeaderMeta(data, consolidatedPriorities) {
    lastAdminName = data.adminName || 'Admin';
    lastAdminRole = data.adminRole === 'super_admin' ? 'Super administrator' : 'Administrator';

    const activePanel = document.querySelector('.tab-content.active');
    updateHeaderForTab(activePanel ? activePanel.id : 'tab-overview');

    const schoolEl = document.getElementById('sidebarSchoolName');
    if (schoolEl && data.schoolName) schoolEl.textContent = data.schoolName;

    const logoEl = document.getElementById('sidebarBrandLogo');
    if (logoEl && data.schoolName) logoEl.textContent = initials(data.schoolName);

    const railAvatar = document.getElementById('railAvatar');
    if (railAvatar) railAvatar.textContent = initials(lastAdminName);

    const railMenuName = document.getElementById('railMenuName');
    if (railMenuName) railMenuName.textContent = extractFirstName(lastAdminName);

    const railMenuRole = document.getElementById('railMenuRole');
    if (railMenuRole) railMenuRole.textContent = lastAdminRole;

    const settingsSchool = document.getElementById('settingsSchoolName');
    if (settingsSchool && data.schoolName) settingsSchool.textContent = data.schoolName;

    syncYearSelector(data);
    renderNotifications(consolidatedPriorities);
  }

  function renderKpis(data, priorities) {
    const el = document.getElementById('ovKpiGrid');
    if (!el) return;
    data = data || {};
    data.students = data.students || {};
    data.attendance = data.attendance || {};
    data.fees = data.fees || {};

    const stuCount = data.students.active || 0;
    const stuLimit = cachedStudentLimit || 500;
    const stuPct = stuLimit > 0 ? Math.round((stuCount / stuLimit) * 100) : 50;
    const stuSub = `${data.students.classCount} classes · ${data.students.newThisMonth} new this month`;

    const attPct = data.attendance.pctToday;
    const attMarked = data.attendance.markedTotal > 0;
    const attVal = attMarked && attPct !== null ? `${attPct}%` : 'Not marked';
    const attGaugePct = attMarked && attPct !== null ? attPct : 0;

    let feeVal = 'Disabled';
    let feePct = 0;
    let feeAction = '';
    if (data.fees && data.fees.enabled) {
      if (data.fees.expected > 0) {
        const fpct = data.fees.collectionPct;
        feePct = fpct !== null ? fpct : 0;
        feeVal = fpct !== null ? `${fpct}%` : formatPKR(data.fees.collected);
      } else {
        feeVal = 'No dues';
        feeAction = `<button type="button" class="ov-black-pill-btn" data-nav-tab="tab-fees">Set up fees</button>`;
      }
    }

    const priCount = priorities.length;

    el.innerHTML = `
      <div class="ov-kpi-card" data-nav-tab="tab-students" style="cursor:pointer;">
        <div>
          <div class="ov-kpi-top">
            <span class="ov-kpi-title">Total students</span>
            <span class="ov-kpi-icon" aria-hidden="true"><i class="fas fa-user-graduate"></i></span>
          </div>
          <div class="ov-kpi-value-row">
            <span class="ov-kpi-value">${stuCount.toLocaleString()}</span>
            <span class="ov-kpi-denom">/ ${stuLimit.toLocaleString()}</span>
          </div>
        </div>
        ${buildGauge(stuPct, 10)}
        <div class="ov-kpi-sub">${esc(stuSub)}</div>
      </div>

      <div class="ov-kpi-card is-lime">
        <div>
          <div class="ov-kpi-top">
            <span class="ov-kpi-title">Attendance today</span>
            <span class="ov-kpi-icon" aria-hidden="true"><i class="fas fa-clipboard-check"></i></span>
          </div>
          <div class="ov-kpi-value" style="${!attMarked ? 'font-size:28px;' : ''}">${esc(attVal)}</div>
        </div>
        ${attMarked ? buildGauge(attGaugePct, 10) : ''}
        <button type="button" class="ov-black-pill-btn" data-nav-tab="tab-attendance">Mark attendance</button>
      </div>

      <div class="ov-kpi-card">
        <div>
          <div class="ov-kpi-top">
            <span class="ov-kpi-title">Fee collection</span>
            <span class="ov-kpi-icon" aria-hidden="true"><i class="fas fa-wallet"></i></span>
          </div>
          <div class="ov-kpi-value" style="${data.fees && data.fees.enabled && data.fees.expected === 0 ? 'font-size:28px;' : ''}">${esc(feeVal)}</div>
        </div>
        ${data.fees.enabled && data.fees.expected > 0 ? buildGauge(feePct, 10) : ''}
        ${feeAction || `<div class="ov-kpi-sub">${data.fees && data.fees.enabled ? `${formatPKR(data.fees.collected)} collected` : 'Fees disabled'}</div>`}
      </div>

      <div class="ov-kpi-card is-black" onclick="document.getElementById('ovPriorityCard')?.scrollIntoView({behavior:'smooth'})" style="cursor:pointer;">
        <div>
          <div class="ov-kpi-top">
            <span class="ov-kpi-title">Open priorities</span>
            <span class="ov-kpi-icon" aria-hidden="true"><i class="fas fa-circle-exclamation"></i></span>
          </div>
          <div class="ov-kpi-value">${priCount}</div>
        </div>
        ${priCount > 0 ? buildGauge(Math.min(100, priCount * 20), 10) : ''}
      </div>`;
  }

  function renderPriorityInbox(priorities) {
    const el = document.getElementById('ovPriorityCard');
    if (!el) return;
    const shown = showAllPriorities ? priorities : priorities.slice(0, 5);

    const listHtml = shown.length > 0
      ? shown.map(item => `
          <div class="ov-inbox-item">
            <div class="ov-inbox-left">
              <span class="ov-severity-dot ${esc(item.severity)}" aria-hidden="true"></span>
              <div style="min-width:0;">
                <div class="ov-inbox-title">${esc(item.title)}</div>
                <div class="ov-inbox-meta">${esc(item.meta)}</div>
              </div>
            </div>
            <button type="button" class="ov-inbox-btn"
              ${item.targetTab ? `data-nav-tab="${esc(item.targetTab)}"` : ''}
              ${item.targetHref ? `data-nav-href="${esc(item.targetHref)}"` : ''}>
              ${esc(item.actionLabel)}
            </button>
          </div>`).join('')
      : `<div class="ov-empty">
           <i class="fas fa-circle-check"></i>
           <span>All clear — no open operational priorities.</span>
           <button type="button" class="ov-empty-action" data-nav-tab="tab-classes">Review classes</button>
         </div>`;

    el.innerHTML = `
      <div class="ov-card-head">
        <div class="ov-card-title">Priority inbox</div>
        ${priorities.length > 5 ? `<button type="button" class="ov-card-action" id="ovTogglePrioritiesBtn">${showAllPriorities ? 'Show less' : 'View all'}</button>` : ''}
      </div>
      <div class="ov-inbox-list">${listHtml}</div>`;

    const toggleBtn = document.getElementById('ovTogglePrioritiesBtn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        showAllPriorities = !showAllPriorities;
        renderPriorityInbox(priorities);
      });
    }
  }

  function renderQuickActions(data) {
    const el = document.getElementById('ovQuickActionsCard');
    if (!el) return;
    const f = data.features || {};

    const actions = [];
    if (f.student_management !== false) actions.push({ label: 'Add student', icon: 'fa-plus', tab: 'tab-students' });
    if (f.fees) actions.push({ label: 'Receive fee', icon: 'fa-receipt', href: '/voucher-generator.html#collect' });
    if (f.attendance !== false) actions.push({ label: 'Mark attendance', icon: 'fa-clipboard-check', tab: 'tab-attendance' });
    if (f.fees) actions.push({ label: 'Fee voucher', icon: 'fa-file-invoice-dollar', href: '/voucher-generator.html#generate' });
    actions.push({ label: 'Manage classes', icon: 'fa-book-open', tab: 'tab-classes' });
    if (f.teacher_management !== false) actions.push({ label: 'Add staff', icon: 'fa-user-plus', tab: 'tab-teachers' });
    if (actions.length < 6) actions.push({ label: 'Create exam', icon: 'fa-calendar-plus', href: '/datesheet.html' });

    el.innerHTML = `
      <div class="ov-card-head">
        <div class="ov-card-title">Quick actions</div>
      </div>
      <div class="ov-actions-grid">
        ${actions.slice(0, 6).map(a => `
          <button type="button" class="ov-action-btn"
            ${a.tab ? `data-nav-tab="${esc(a.tab)}"` : ''}
            ${a.href ? `data-nav-href="${esc(a.href)}"` : ''}>
            <span class="ov-action-left">
              <span class="ov-action-circle" aria-hidden="true"><i class="fas ${esc(a.icon)}"></i></span>
              <span>${esc(a.label)}</span>
            </span>
            <i class="fas fa-arrow-right ov-action-arrow" aria-hidden="true"></i>
          </button>`).join('')}
      </div>`;
  }

  function renderAttendanceTrend(data) {
    const el = document.getElementById('ovTrendCard');
    if (!el) return;
    const trend = data.attendance.trend || [];
    const markedToday = data.attendance.markedTotal > 0;
    const activeYear = data.selectedYear || '2026-27';

    if (trend.length === 0) {
      el.innerHTML = `
        <div class="ov-card-head">
          <div class="ov-card-title">Attendance trend</div>
          <button type="button" class="ov-card-action" data-nav-tab="tab-stats">View report</button>
        </div>
        <div class="ov-empty">
          <i class="fas fa-chart-simple"></i>
          <span>No attendance records for ${esc(activeYear)} yet.</span>
          <button type="button" class="ov-empty-action" data-nav-tab="tab-attendance">Mark attendance</button>
        </div>`;
      return;
    }

    const todayIso = new Date().toISOString().slice(0, 10);
    const trendByDate = {};
    trend.forEach(d => { trendByDate[d.date] = d; });

    // Last 8 calendar days ending today. Days without attendance records
    // render as dashed ghost pills — no invented data.
    const days = [];
    const cursor = new Date();
    for (let i = 7; i >= 0; i--) {
      const dt = new Date(cursor);
      dt.setDate(dt.getDate() - i);
      const isoD = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
      days.push({ iso: isoD, d: trendByDate[isoD] || null });
    }

    const barsHtml = days.map((day, idx) => {
      const isToday = day.iso === todayIso || (!trendByDate[todayIso] && idx === days.length - 1 && markedToday);
      const lbl = shortDateLabel(day.iso) || day.iso;
      if (!day.d) {
        return `
        <div class="ov-day ov-day-ghost" aria-hidden="true">
          <span class="ov-day-pill ghost"><i class="ov-ghost-dot"></i></span>
          <span class="ov-day-label">${esc(lbl)}</span>
        </div>`;
      }
      const pct = Math.max(0, Math.min(100, Number(day.d.pct) || 0));
      return `
        <button type="button" class="ov-day ${isToday ? 'today' : ''}" aria-label="${esc(day.iso)}: ${day.d.pct}% present">
          <span class="ov-day-bubble">${esc(String(day.d.pct))}%</span>
          <span class="ov-day-pill">
            <span class="ov-day-fill" style="height:${pct}%"></span>
            <i class="ov-dot-lime" style="bottom:${pct}%" aria-hidden="true"></i>
            <i class="ov-dot-top" aria-hidden="true"></i>
          </span>
          <span class="ov-day-label">${esc(lbl)}</span>
        </button>`;
    }).join('');

    let footerClass = 'neutral';
    let footerIcon = 'fa-clock';
    let footerMsg = 'Attendance not marked yet';
    if (markedToday) {
      if (data.attendance.absentToday > 0) {
        footerClass = 'warn';
        footerIcon = 'fa-circle-exclamation';
        footerMsg = `${data.attendance.absentToday} student${data.attendance.absentToday === 1 ? '' : 's'} absent today`;
      } else {
        footerClass = 'ok';
        footerIcon = 'fa-circle-check';
        footerMsg = 'No absences today';
      }
    }

    el.innerHTML = `
      <div class="ov-card-head">
        <div class="ov-card-title">Attendance trend</div>
        <div style="display:flex;align-items:center;gap:14px;">
          <span class="ov-legend"><i class="ov-legend-dot lime"></i>Present<i class="ov-legend-dot dark"></i>Absent</span>
          <select id="trendYearSelect" class="ov-card-action" aria-label="Trend academic year" onchange="window.onYearSelectChanged(this.value)">
            <option value="${esc(activeYear)}">${esc(activeYear)}</option>
          </select>
          <button type="button" class="ov-card-action" data-nav-tab="tab-stats">Report</button>
        </div>
      </div>
      <div class="ov-trend-chart">
        <div class="ov-chart-y" aria-hidden="true"><span>100%</span><span>75%</span><span>50%</span><span>25%</span><span>0%</span></div>
        <div class="ov-chart-plot">${barsHtml}</div>
      </div>
      <div class="ov-trend-footer ${footerClass}">
        <i class="fas ${footerIcon}" aria-hidden="true"></i>
        <span>${esc(footerMsg)}</span>
      </div>`;
  }

  function renderSchedule(data) {
    const el = document.getElementById('ovScheduleCard');
    if (!el) return;
    const items = data.schedule || [];

    const bodyHtml = items.length > 0
      ? `<div class="ov-schedule-list">
          ${items.map(s => `
            <div class="ov-schedule-row" style="cursor:pointer"
              ${s.tab ? `data-nav-tab="${esc(s.tab)}"` : ''}
              ${s.href ? `data-nav-href="${esc(s.href)}"` : ''}>
              <div class="ov-schedule-time">${esc(s.time)}</div>
              <div class="ov-schedule-title">${esc(s.title)}</div>
              <div class="ov-schedule-dept">${esc(s.department)}</div>
            </div>`).join('')}
         </div>`
      : `<div class="ov-empty">
           <i class="fas fa-calendar"></i>
           <span>No upcoming exams or school notices posted yet.</span>
           <button type="button" class="ov-empty-action" data-nav-href="/datesheet.html">Add datesheet</button>
         </div>`;

    el.innerHTML = `
      <div class="ov-card-head">
        <div class="ov-card-title">Campus schedule</div>
        <button type="button" class="ov-card-action" data-nav-tab="tab-announcements">Post notice</button>
      </div>
      ${bodyHtml}`;
  }

  function renderEmptyYearState(data) {
    const fallbackYear = data.currentAcademicYear || '2026-27';
    const selYear = data.selectedYear || '2025-26';
    const kpiEl = document.getElementById('ovKpiGrid');
    if (kpiEl) {
      kpiEl.innerHTML = `
        <div class="ov-card" style="grid-column:1 / -1;">
          <div class="ov-empty">
            <i class="fas fa-calendar-xmark"></i>
            <span>No records for ${esc(selYear)}.</span>
            <button type="button" class="ov-empty-action" onclick="window.onYearSelectChanged('${esc(fallbackYear)}')">Back to ${esc(fallbackYear)}</button>
          </div>
        </div>`;
    }
    const priEl = document.getElementById('ovPriorityCard');
    const qaEl = document.getElementById('ovQuickActionsCard');
    const trEl = document.getElementById('ovTrendCard');
    const scEl = document.getElementById('ovScheduleCard');
    if (priEl) priEl.innerHTML = '';
    if (qaEl) qaEl.innerHTML = '';
    if (trEl) trEl.innerHTML = '';
    if (scEl) scEl.innerHTML = '';
  }

  function bindOverviewNavClicks() {
    const root = document.getElementById('tab-overview');
    if (!root || root.dataset.navBound) return;
    root.dataset.navBound = '1';
    root.addEventListener('click', (e) => {
      const target = e.target.closest('[data-nav-tab], [data-nav-href]');
      if (!target) return;
      const tab = target.getAttribute('data-nav-tab');
      const href = target.getAttribute('data-nav-href');
      navigateToTarget(tab, href);
    });
  }

  function onYearSelectChanged(year) {
    if (!year) return;
    window.appData = window.appData || {};
    window.appData.selectedYear = year;
    localStorage.setItem('eye-selected-year', year);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('year', year);
      window.history.replaceState({}, '', url.toString());
    } catch (_) {}
    loadOverviewDashboard();
  }

  async function loadOverviewDashboard() {
    const overviewTab = document.getElementById('tab-overview');
    if (!overviewTab) return;

    const errBanner = document.getElementById('ovErrorBanner');
    if (errBanner) errBanner.style.display = 'none';

    const branchId = window.appData?.selectedBranchId || 'all';
    const urlYear = new URLSearchParams(window.location.search).get('year');
    const yearEl = document.getElementById('academicYearSelect');
    const year = urlYear || (yearEl && yearEl.value) || localStorage.getItem('eye-selected-year') || '';

    try {
      if (cachedStudentLimit === null) {
        window.apiFetch('/api/auth/capacity')
          .then(r => (r.ok ? r.json() : {}))
          .then(cap => {
            if (cap && Number(cap.student_limit) > 0) cachedStudentLimit = Number(cap.student_limit);
          })
          .catch(() => {});
      }

      const qs = new URLSearchParams({ branch_id: String(branchId) });
      if (year) qs.set('year', String(year));
      const res = await window.apiFetch(`/api/dashboard/overview?${qs.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const priorities = consolidatePriorities(data.priorities);

      renderHeaderMeta(data, priorities);
      if (data.yearHasData === false) {
        renderEmptyYearState(data);
        return;
      }
      renderKpis(data, priorities);
      renderPriorityInbox(priorities);
      renderQuickActions(data);
      renderAttendanceTrend(data);
      syncYearSelector(data);
      renderSchedule(data);
      bindOverviewNavClicks();
    } catch (err) {
      console.error('Overview load error:', err);
      if (errBanner) {
        errBanner.style.display = 'flex';
        errBanner.innerHTML = `
          <div>
            <div style="font-weight:600;">Could not load live school overview</div>
            <div style="font-size:12px;color:var(--ink-2);">${esc(err.message || 'Network or server error')}</div>
          </div>
          <button type="button" class="ov-retry-btn" onclick="window.loadOverviewDashboard()">Retry</button>`;
      }
    }
  }

  function setupGlobalSearch() {
    const input = document.getElementById('globalSearchInput');
    const panel = document.getElementById('globalSearchResults');
    if (!input || !panel) return;

    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.focus();
        input.select();
      }
      if (e.key === 'Escape' && panel.classList.contains('open')) {
        panel.classList.remove('open');
        input.blur();
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && panel.classList.contains('open')) {
        const first = panel.querySelector('.eye-search-item');
        if (first) {
          e.preventDefault();
          first.click();
        }
      }
    });

    input.addEventListener('input', () => {
      const q = input.value.trim();
      clearTimeout(searchTimer);
      if (q.length < 2) {
        panel.classList.remove('open');
        panel.innerHTML = '';
        return;
      }
      searchTimer = setTimeout(async () => {
        try {
          const branchId = window.appData?.selectedBranchId || 'all';
          const res = await window.apiFetch(`/api/dashboard/search?q=${encodeURIComponent(q)}&branch_id=${encodeURIComponent(branchId)}`);
          if (!res.ok) return;
          const data = await res.json();
          const items = data.results || [];
          if (items.length === 0) {
            panel.innerHTML = `<div class="ov-empty" style="padding:14px;"><i class="fas fa-magnifying-glass"></i><span>No results for "${esc(q)}"</span></div>`;
          } else {
            const groups = {};
            for (const r of items) {
              const g = r.type === 'Teacher' ? 'Staff' : r.type === 'Student' ? 'Students' : r.type === 'Class' ? 'Classes' : 'Receipts';
              if (!groups[g]) groups[g] = [];
              groups[g].push(r);
            }
            panel.innerHTML = Object.entries(groups).map(([groupName, rows]) => `
              <div class="eye-search-group">${esc(groupName)}</div>
              ${rows.map(r => `
                <button type="button" class="eye-search-item" data-tab="${esc(r.targetTab)}" data-search="${esc(r.searchValue)}">
                  <div>
                    <div style="font-weight:600;font-size:13px">${esc(r.title)}</div>
                    <div style="font-size:12px;color:var(--ink-2)">${esc(r.subtitle)}</div>
                  </div>
                </button>`).join('')}
            `).join('');
          }
          panel.classList.add('open');
        } catch (e) {
          console.error('Global search error:', e);
        }
      }, 250);
    });

    panel.addEventListener('click', (e) => {
      const btn = e.target.closest('.eye-search-item');
      if (!btn) return;
      panel.classList.remove('open');
      navigateToTarget(btn.dataset.tab, null, btn.dataset.search);
    });

    document.addEventListener('click', (e) => {
      if (!input.contains(e.target) && !panel.contains(e.target)) {
        panel.classList.remove('open');
      }
    });
  }

  function setupBellAndRailMenus() {
    const bellBtn = document.getElementById('notifBellBtn');
    const notifPanel = document.getElementById('notifPanel');
    const markAllBtn = document.getElementById('markAllNotifsReadBtn');
    if (bellBtn && notifPanel) {
      bellBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        notifPanel.classList.toggle('open');
        document.getElementById('railAccountMenu')?.classList.remove('open');
      });
      notifPanel.addEventListener('click', (e) => {
        const item = e.target.closest('.eye-notif-item');
        if (!item) return;
        const readSet = getReadNotifs();
        readSet.add(item.dataset.notifId);
        saveReadNotifs(readSet);
        renderNotifications(currentPriorities);
        notifPanel.classList.remove('open');
        navigateToTarget(item.dataset.navTab, item.dataset.navHref);
      });
      if (markAllBtn) {
        markAllBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const readSet = getReadNotifs();
          currentPriorities.forEach(p => readSet.add(p.id));
          saveReadNotifs(readSet);
          renderNotifications(currentPriorities);
        });
      }
    }

    const railAvatarBtn = document.getElementById('railAvatarBtn');
    const railMenu = document.getElementById('railAccountMenu');
    if (railAvatarBtn && railMenu) {
      railAvatarBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        railMenu.classList.toggle('open');
        notifPanel?.classList.remove('open');
      });
    }

    document.addEventListener('click', (e) => {
      if (notifPanel && !notifPanel.contains(e.target) && e.target !== bellBtn) {
        notifPanel.classList.remove('open');
      }
      if (railMenu && !railMenu.contains(e.target) && e.target !== railAvatarBtn) {
        railMenu.classList.remove('open');
      }
    });
  }

  function setupSidebarShell() {
    const shell = document.getElementById('eyeShell');
    const toggleBtn = document.getElementById('eyeSidebarToggleBtn');
    if (toggleBtn && shell) {
      if (window.innerWidth > 960 && localStorage.getItem('eye-sidebar-collapsed') !== '0') {
        shell.classList.add('sidebar-collapsed');
      }
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.innerWidth <= 960) {
          shell.classList.toggle('mobile-drawer-open');
        } else {
          shell.classList.toggle('sidebar-collapsed');
          localStorage.setItem('eye-sidebar-collapsed', shell.classList.contains('sidebar-collapsed') ? '1' : '0');
        }
      });
      document.addEventListener('click', (e) => {
        const sidebar = document.getElementById('eyeSidebar');
        if (shell.classList.contains('mobile-drawer-open') && sidebar && !sidebar.contains(e.target) && !toggleBtn.contains(e.target)) {
          shell.classList.remove('mobile-drawer-open');
        }
      });
    }

    const yearSel = document.getElementById('academicYearSelect');
    if (yearSel) {
      yearSel.addEventListener('change', () => {
        onYearSelectChanged(yearSel.value);
      });
    }
  }

  window.updateHeaderForTab = updateHeaderForTab;
  window.loadOverviewDashboard = loadOverviewDashboard;
  window.onYearSelectChanged = onYearSelectChanged;

  document.addEventListener('DOMContentLoaded', () => {
    setupSidebarShell();
    setupGlobalSearch();
    setupBellAndRailMenus();
    loadOverviewDashboard();
  });
})();
