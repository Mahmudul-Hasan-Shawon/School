/* ============================================================================
 *  ERP PORTAL CONTROLLER
 *
 *  Three portals share one shell. The role selected on the landing screen is
 *  sent with the login request, which tells the backend which of the three
 *  user sheets to read — that is what keeps sign-in fast.
 *
 *  SET THIS BEFORE DEPLOYING
 * ========================================================================== */

const API_URL = 'https://script.google.com/macros/s/AKfycbwCwkdlR947fZidu9d4_rxoeC9MO8AZiQ0ZJjAsTp2lMOQeeuE0temgAUHHNl8EaEx-CA/exec';

/* --------------------------------------------------------------------------
 *  Transport note
 *  Apps Script cannot answer a CORS preflight, so requests stay "simple":
 *  POST + text/plain + JSON body. The session token travels in the body — a
 *  custom Authorization header would trigger a preflight and every call fails.
 *
 *  The token lives in sessionStorage, not localStorage: it dies with the tab.
 * ------------------------------------------------------------------------ */

const State = {
  token: null, role: null, user: null, permissions: [], school: {},
  canChangePassword: false, mustChangePassword: false, isSuperAdmin: false,
  lookups: null, view: 'dashboard',
  marks: {}, fees: {}
};

const ROLE_META = {
  STUDENT: { label: 'Student', bn: 'শিক্ষার্থী', hint: 'Normally your admission number, e.g. 2026-0001' },
  TEACHER: { label: 'Teacher', bn: 'শিক্ষক', hint: 'The username issued by the office, e.g. arif.hossain' },
  ADMIN:   { label: 'Admin',   bn: 'প্রশাসক', hint: 'The administrator username' }
};

/* =========================================================================
 * 1. UTILITIES
 * ========================================================================= */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/** Everything from the sheet is escaped before it touches innerHTML. */
function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Notice bodies are typed with line breaks; keep them. */
function escLines(v) { return esc(v).replace(/\n/g, '<br>'); }

function money(n) {
  return '৳' + Number(n || 0).toLocaleString('en-BD',
    { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function can(code) { return State.permissions.indexOf(code) >= 0; }

let veilCount = 0;
function veil(on) {
  veilCount = Math.max(0, veilCount + (on ? 1 : -1));
  $('#veil').hidden = veilCount === 0;
}

let toastTimer;
function toast(message, kind = 'info') {
  const el = $('#toast');
  const accent = kind === 'error' ? 'border-terra' : kind === 'success' ? 'border-moss' : 'border-ink';
  el.className = 'fixed bottom-6 right-6 z-[60] max-w-sm px-5 py-4 text-sm card rise border-l-4 ' + accent;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

/* =========================================================================
 * 2. API CLIENT
 * ========================================================================= */

async function api(action, payload = {}, opts = {}) {
  if (API_URL.indexOf('PASTE_YOUR_DEPLOYMENT_ID') >= 0) {
    throw new Error('API_URL is not configured in erp.js.');
  }
  if (opts.quiet !== true) veil(true);

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action, token: State.token }, payload)),
      redirect: 'follow'
    });

    if (!res.ok) throw new Error('The server returned ' + res.status + '. Please try again.');

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error('Unexpected response from the server. Check the deployment settings.');
    }

    if (!json.ok) {
      const code = json.error && json.error.code;
      if (code === 'UNAUTHENTICATED' || code === 'SESSION_EXPIRED' || code === 'ACCOUNT_DISABLED') {
        hardLogout(json.error.message);
      }
      const err = new Error((json.error && json.error.message) || 'Request failed.');
      err.code = code;
      throw err;
    }
    return json.data;

  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error('Could not reach the server. Check your connection, and that the web app ' +
        'is deployed with access set to "Anyone".');
    }
    throw err;
  } finally {
    if (opts.quiet !== true) veil(false);
  }
}

/* =========================================================================
 * 3. ROLE SELECTION AND LOGIN
 * ========================================================================= */

function chooseRole(role) {
  State.role = role;
  const meta = ROLE_META[role];

  $('#roleScreen').hidden = true;
  $('#loginScreen').hidden = false;
  $('#loginError').hidden = true;
  $('#loginRoleLabel').textContent = meta.label + ' portal';
  $('#loginHeading').textContent = meta.label + ' sign-in';
  $('#loginHeadingBn').textContent = meta.bn;
  $('#usernameHint').textContent = meta.hint;
  $('#username').value = '';
  $('#password').value = '';
  setTimeout(() => $('#username').focus(), 60);
}

function backToRoles() {
  State.role = null;
  $('#loginScreen').hidden = true;
  $('#roleScreen').hidden = false;
}

function showLoginError(message) {
  const box = $('#loginError');
  box.textContent = message;
  box.hidden = false;
}

function saveSession(d) {
  State.token = d.token;
  State.role = d.user.role;
  State.user = d.user;
  State.permissions = d.permissions || [];
  State.school = d.school || {};
  State.canChangePassword = !!d.canChangePassword;
  State.mustChangePassword = !!d.mustChangePassword;
  State.isSuperAdmin = !!d.isSuperAdmin;
  sessionStorage.setItem('erp_token', d.token);
}

function hardLogout(message) {
  State.token = null;
  State.user = null;
  State.permissions = [];
  sessionStorage.removeItem('erp_token');
  $('#appShell').hidden = true;
  $('#loginScreen').hidden = true;
  $('#roleScreen').hidden = false;
  if (message) toast(message, 'error');
}

async function doLogin(e) {
  e.preventDefault();
  $('#loginError').hidden = true;

  const username = $('#username').value.trim();
  const password = $('#password').value;
  if (!username || !password) return showLoginError('Enter both your username and password.');

  const btn = $('#loginBtn');
  btn.disabled = true;
  $('#loginBtnText').textContent = 'Signing in…';

  try {
    const data = await api('auth.login', { role: State.role, username, password });
    saveSession(data);
    $('#password').value = '';
    await enterApp();
  } catch (err) {
    showLoginError(err.message);
  } finally {
    btn.disabled = false;
    $('#loginBtnText').textContent = 'Sign in';
  }
}

async function doLogout() {
  try { await api('auth.logout', {}, { quiet: true }); } catch (e) { /* log out locally anyway */ }
  hardLogout();
}

/* =========================================================================
 * 4. NAVIGATION
 * ========================================================================= */

const NAV = {
  dashboard: { label: 'Dashboard',  crumb: 'Overview',     icon: 'M3 12l9-9 9 9M5 10v10h14V10' },
  students:  { label: 'Students',   crumb: 'Register',     icon: 'M17 20v-2a4 4 0 00-4-4H7a4 4 0 00-4 4v2M10 8a3 3 0 100-6 3 3 0 000 6M21 20v-2a4 4 0 00-3-3.87' },
  teachers:  { label: 'Teachers',   crumb: 'Staff',        icon: 'M12 14l9-5-9-5-9 5 9 5zM12 14v7M5 11v5a7 3 0 0014 0v-5' },
  marks:     { label: 'Mark entry', crumb: 'Examinations', icon: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z' },
  results:   { label: 'My results', crumb: 'Examinations', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.6L19 8.4V19a2 2 0 01-2 2z' },
  fees:      { label: 'Fees',       crumb: 'Finance',      icon: 'M12 2v20M17 5H9.5a3.5 3.5 0 100 7h5a3.5 3.5 0 110 7H6' },
  notices:   { label: 'Notices',    crumb: 'Bulletin',     icon: 'M11 5.9L6 9H3v6h3l5 3.1V5.9zM16 8a5 5 0 010 8' },
  website:   { label: 'Website',    crumb: 'Public site',  icon: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 010 18M12 3a15 15 0 000 18' },
  profile:   { label: 'Profile',    crumb: 'Account',      icon: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21v-1a6 6 0 016-6h4a6 6 0 016 6v1' }
};

const NAV_BY_ROLE = {
  ADMIN:   ['dashboard', 'students', 'teachers', 'marks', 'fees', 'notices', 'website', 'profile'],
  TEACHER: ['dashboard', 'students', 'marks', 'notices', 'profile'],
  STUDENT: ['dashboard', 'results', 'fees', 'notices', 'profile']
};

function buildNav() {
  const keys = NAV_BY_ROLE[State.role] || ['dashboard', 'profile'];
  $('#navList').innerHTML = keys.map(key => {
    const n = NAV[key];
    return `<li><button data-view="${key}"
        class="nav-link w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left
               hover:text-paper-card transition">
        <svg class="w-[18px] h-[18px] shrink-0" fill="none" stroke="currentColor"
             stroke-width="1.6" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="${n.icon}"/></svg>
        <span>${esc(n.label)}</span></button></li>`;
  }).join('');

  $$('#navList [data-view]').forEach(b => b.addEventListener('click', () => go(b.dataset.view)));
  $$('.nav-jump').forEach(b => b.addEventListener('click', () => go(b.dataset.view)));
}

function go(view) {
  if (!NAV[view]) view = 'dashboard';
  State.view = view;

  $$('.view').forEach(s => { s.hidden = s.dataset.view !== view; });
  $$('#navList .nav-link').forEach(b => b.classList.toggle('active', b.dataset.view === view));

  $('#pageTitle').textContent = NAV[view].label;
  $('#crumb').textContent = NAV[view].crumb;
  $('#mobileTitle').textContent = NAV[view].label;
  closeSidebar();
  window.scrollTo({ top: 0, behavior: 'smooth' });

  const loader = {
    dashboard: loadDashboard, students: loadStudentsView, teachers: loadTeachers,
    marks: loadMarksView, results: loadResultsView, fees: loadFees,
    notices: loadNotices, website: loadWebsite, profile: loadProfile
  }[view];

  if (loader) loader().catch(err => toast(err.message, 'error'));
}

function openSidebar() { $('#sidebar').classList.remove('-translate-x-full'); $('#scrim').hidden = false; }
function closeSidebar() { $('#sidebar').classList.add('-translate-x-full'); $('#scrim').hidden = true; }

/* =========================================================================
 * 5. APP BOOT
 * ========================================================================= */

async function enterApp() {
  $('#roleScreen').hidden = true;
  $('#loginScreen').hidden = true;
  $('#appShell').hidden = false;

  $('#sidebarSchool').textContent = State.school.nameEnglish || 'School';
  $('#sidebarPortal').textContent = ROLE_META[State.role].label.toUpperCase() + ' PORTAL';
  $('#navUser').textContent = State.user.displayName || State.user.username;
  $('#navRole').textContent = ROLE_META[State.role].label;
  $('#todayLabel').textContent = new Date().toLocaleDateString('en-GB',
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  $('#stuAdd').hidden = !can('STUDENT_CREATE');
  $('#noticeAdminBar').hidden = !can('NOTICE_MANAGE');
  $('#feeAdmin').hidden = !can('FEES_VIEW');

  buildNav();

  try {
    State.lookups = await api('lookups.get', {}, { quiet: true });
    $('#yearLabel').textContent = 'Session ' + labelFor(State.lookups.academicYears,
      'AcademicYearID', State.lookups.academicYearId, 'SessionName');
    fillSelectors();
  } catch (err) {
    toast(err.message, 'error');
  }

  // Anyone still on the password the office issued lands on Profile, not the
  // dashboard. A nudge, not a gate — locking them out mid-change is worse.
  if (State.mustChangePassword && State.canChangePassword) {
    go('profile');
    const n = $('#pwNotice');
    n.textContent = 'This is your first sign-in. Please replace the password you were given ' +
      'with one only you know.';
    n.hidden = false;
  } else {
    go('dashboard');
  }
}

function labelFor(list, idKey, id, labelKey) {
  const row = (list || []).find(r => r[idKey] === id);
  return row ? row[labelKey] : id;
}

function classLabel(id) {
  return labelFor(State.lookups && State.lookups.classes, 'ClassID', id, 'ClassNameEnglish');
}

function sectionLabel(id) {
  const s = ((State.lookups && State.lookups.sections) || []).find(x => x.SectionID === id);
  return s ? s.SectionName : id;
}

function subjectLabel(id) {
  return labelFor(State.lookups && State.lookups.subjects, 'SubjectID', id, 'SubjectNameEnglish');
}

function fillSelectors() {
  const L = State.lookups;
  if (!L) return;

  const classOpts = L.classes
    .map(c => `<option value="${esc(c.ClassID)}">${esc(c.ClassNameEnglish)}</option>`).join('');

  const stu = $('#stuClass');
  if (stu) stu.innerHTML = '<option value="">All classes</option>' + classOpts;
  const mk = $('#mkClass');
  if (mk) mk.innerHTML = '<option value="">Select class</option>' + classOpts;

  ['#stuSection', '#mkSection'].forEach(sel => {
    const el = $(sel);
    if (el) el.innerHTML = '<option value="">Select section</option>';
  });

  const subj = $('#mkSubject');
  if (subj) {
    subj.innerHTML = '<option value="">Select subject</option>' +
      L.subjects.map(s => `<option value="${esc(s.SubjectID)}">${esc(s.SubjectNameEnglish)}</option>`).join('');
  }

  [['#stuClass', '#stuSection'], ['#mkClass', '#mkSection']].forEach(([cSel, sSel]) => {
    const cEl = $(cSel), sEl = $(sSel);
    if (!cEl || !sEl) return;
    cEl.addEventListener('change', () => {
      sEl.innerHTML = '<option value="">Select section</option>' + L.sections
        .filter(s => s.ClassID === cEl.value)
        .map(s => `<option value="${esc(s.SectionID)}">Section ${esc(s.SectionName)}</option>`).join('');
    });
  });
}

/* =========================================================================
 * 6. DASHBOARD
 * ========================================================================= */

const TONES = ['text-ink', 'text-terra', 'text-moss', 'text-gold'];

function statTile(label, value, tone) {
  return `<div class="card p-5 ${tone || 'text-ink'}">
    <p class="font-mono text-[10px] tracking-[.16em] uppercase text-ink-mute mb-2">${esc(label)}</p>
    <p class="font-display text-3xl leading-none">${esc(value)}</p></div>`;
}

async function loadDashboard() {
  const [dash, notices] = await Promise.all([
    api('dashboard.get'),
    api('notices.list', {}, { quiet: true }).catch(() => ({ notices: [] }))
  ]);

  $('#statGrid').innerHTML = dash.metrics.length
    ? dash.metrics.map((m, i) => {
        let v = m.value;
        if (m.type === 'CURRENCY') v = money(m.value);
        else if (m.type === 'PERCENT') v = Number(m.value).toFixed(1) + '%';
        else if (m.type === 'NUMBER') v = Number(m.value).toLocaleString();
        return `<div class="rise" style="animation-delay:${i * 45}ms">
          ${statTile(m.label, v, TONES[i % TONES.length])}</div>`;
      }).join('')
    : `<div class="card p-6 sm:col-span-2 xl:col-span-4 text-sm text-ink-mute">
         No metrics yet. Run <span class="font-mono">refreshDashboard()</span> in Apps Script.</div>`;

  $('#dashNotices').innerHTML = notices.notices.length
    ? notices.notices.slice(0, 5).map(n => `
        <article class="pb-4 border-b border-rule last:border-0 last:pb-0">
          <div class="flex items-start justify-between gap-3">
            <h3 class="font-display text-lg leading-snug">${esc(n.Title)}</h3>
            ${priorityPill(n.Priority)}
          </div>
          <p class="text-sm text-ink-soft mt-1 leading-relaxed">${escLines(String(n.Body).slice(0, 240))}</p>
          <p class="font-mono text-[10px] text-ink-mute mt-2">${esc(n.PublishDate)}</p>
        </article>`).join('')
    : '<p class="text-sm text-ink-mute">No notices at the moment.</p>';

  const rows = [];
  const x = dash.extra || {};
  if (x.latestGPA !== undefined) {
    rows.push(['Latest GPA', Number(x.latestGPA).toFixed(2)]);
    rows.push(['Grade', x.latestGrade]);
    rows.push(['Position in section', x.latestPosition]);
  }
  if (x.outstanding !== undefined) rows.push(['Outstanding fees', money(x.outstanding)]);
  if (x.assignments !== undefined) rows.push(['Subject assignments', x.assignments]);
  if (x.classes !== undefined) rows.push(['Classes taught', x.classes]);
  rows.push(['Portal', ROLE_META[State.role].label]);
  rows.push(['Signed in as', State.user.displayName || State.user.username]);

  $('#dashExtra').innerHTML = rows.filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `<div class="flex justify-between gap-4 pb-2 border-b border-rule last:border-0">
      <dt class="text-ink-mute">${esc(k)}</dt><dd class="font-medium text-right">${esc(v)}</dd></div>`).join('');
}

function priorityPill(p) {
  const map = { Urgent: 'bg-terra text-paper-card', High: 'bg-terra-light text-terra',
                Normal: 'bg-paper-deep text-ink-soft', Low: 'bg-paper-deep text-ink-mute' };
  return `<span class="pill shrink-0 ${map[p] || map.Normal}">${esc(p || 'Normal')}</span>`;
}

/* =========================================================================
 * 7. STUDENTS
 * ========================================================================= */

async function loadStudentsView() {
  if (State.role === 'STUDENT' || !$('#stuBody').children.length) await loadStudents();
}

async function loadStudents() {
  try {
    const data = await api('students.list', {
      classId: $('#stuClass').value, sectionId: $('#stuSection').value,
      search: $('#stuSearch').value.trim(), page: 1, pageSize: 120
    });

    $('#stuBody').innerHTML = data.rows.length
      ? data.rows.map(s => `
          <tr class="border-b border-rule/60">
            <td class="px-5 py-3 font-mono text-xs">${esc(s.RollNumber)}</td>
            <td class="px-5 py-3 font-medium">${esc(s.EnglishName)}</td>
            <td class="px-5 py-3 hidden md:table-cell font-display">${esc(s.BanglaName)}</td>
            <td class="px-5 py-3 hidden sm:table-cell font-mono text-xs">${esc(s.AdmissionNumber)}</td>
            <td class="px-5 py-3 text-xs">${esc(classLabel(s.CurrentClassID))} · ${esc(sectionLabel(s.CurrentSectionID))}</td>
            <td class="px-5 py-3 text-right">
              <button data-student="${esc(s.StudentID)}"
                class="stu-view text-xs text-terra font-semibold hover:underline">View</button></td>
          </tr>`).join('')
      : '<tr><td colspan="6" class="px-5 py-10 text-center text-sm text-ink-mute">No students matched.</td></tr>';

    $('#stuMeta').textContent = data.total + ' student' + (data.total === 1 ? '' : 's');
    $$('.stu-view').forEach(b => b.addEventListener('click', () => showStudent(b.dataset.student)));
  } catch (err) {
    $('#stuBody').innerHTML =
      `<tr><td colspan="6" class="px-5 py-10 text-center text-sm text-terra">${esc(err.message)}</td></tr>`;
  }
}

async function showStudent(studentId) {
  try {
    const data = await api('students.get', { studentId });
    const s = data.student;
    const rows = [
      ['Admission no.', s.AdmissionNumber], ['Bangla name', s.BanglaName],
      ['Gender', s.Gender], ['Date of birth', s.DateOfBirth],
      ['Blood group', s.BloodGroup], ['Religion', s.Religion],
      ['Class', classLabel(s.CurrentClassID)], ['Section', sectionLabel(s.CurrentSectionID)],
      ['Roll number', s.RollNumber], ['Status', s.StudentStatus],
      ['Phone', s.Phone], ['Address', s.Address],
      ['Guardian', s.GuardianName], ['Relationship', s.GuardianRelationship],
      ['Guardian phone', s.GuardianPhone],
      ['Second guardian', s.Guardian2Name], ['Second phone', s.Guardian2Phone]
    ].filter(([, v]) => v !== undefined && v !== '' && v !== null);

    const enrol = (data.enrollments || [])
      .sort((a, b) => (a.AcademicYearID < b.AcademicYearID ? 1 : -1));

    openModal(s.EnglishName, `
      <dl class="grid gap-x-8 gap-y-2.5 sm:grid-cols-2 text-sm">
        ${rows.map(([k, v]) => `<div class="flex justify-between gap-4 pb-2 border-b border-rule">
          <dt class="text-ink-mute shrink-0">${esc(k)}</dt>
          <dd class="text-right font-medium">${esc(v)}</dd></div>`).join('')}
      </dl>
      ${enrol.length ? `
        <h3 class="font-display text-lg mt-7 mb-3 pb-2 rule-double">Academic history</h3>
        <table class="data w-full text-sm"><thead><tr class="border-b border-rule">
          <th class="text-left py-2">Session</th><th class="text-left py-2">Class</th>
          <th class="text-left py-2">Section</th><th class="text-left py-2">Roll</th>
          <th class="text-left py-2">Status</th></tr></thead>
          <tbody>${enrol.map(e => `<tr class="border-b border-rule/60">
            <td class="py-2 font-mono text-xs">${esc(labelFor(State.lookups.academicYears,
              'AcademicYearID', e.AcademicYearID, 'SessionName'))}</td>
            <td class="py-2">${esc(classLabel(e.ClassID))}</td>
            <td class="py-2">${esc(sectionLabel(e.SectionID))}</td>
            <td class="py-2 font-mono text-xs">${esc(e.RollNumber)}</td>
            <td class="py-2 text-xs">${esc(e.Status)}</td></tr>`).join('')}
          </tbody></table>` : ''}`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function field(name, label, type, value) {
  return `<div>
    <label class="block text-[11px] font-mono tracking-[.14em] uppercase text-ink-mute mb-1.5">${esc(label)}</label>
    <input name="${esc(name)}" type="${type}" value="${esc(value || '')}"
           class="w-full bg-paper-card border border-rule px-3 py-2.5 text-sm"></div>`;
}

function select(name, label, options, value) {
  return `<div>
    <label class="block text-[11px] font-mono tracking-[.14em] uppercase text-ink-mute mb-1.5">${esc(label)}</label>
    <select name="${esc(name)}" class="w-full bg-paper-card border border-rule px-3 py-2.5 text-sm">
      ${options.map(o => `<option value="${esc(o)}" ${o === value ? 'selected' : ''}>${esc(o || '—')}</option>`).join('')}
    </select></div>`;
}

function textarea(name, label, rows, value) {
  return `<div>
    <label class="block text-[11px] font-mono tracking-[.14em] uppercase text-ink-mute mb-1.5">${esc(label)}</label>
    <textarea name="${esc(name)}" rows="${rows}"
      class="w-full bg-paper-card border border-rule px-3 py-2.5 text-sm">${esc(value || '')}</textarea></div>`;
}

function openNewStudentForm() {
  const L = State.lookups;
  openModal('New admission', `
    <form id="nsForm" class="space-y-4" novalidate>
      <div id="nsError" hidden class="px-4 py-3 text-sm bg-terra-light border-l-4 border-terra"></div>
      <div class="grid gap-4 sm:grid-cols-2">
        ${field('EnglishName', 'Name (English) *', 'text')}
        ${field('BanglaName', 'Name (Bangla) *', 'text')}
        ${select('Gender', 'Gender *', ['Male', 'Female', 'Other'])}
        ${field('DateOfBirth', 'Date of birth *', 'date')}
        ${field('BirthRegistrationNumber', 'Birth registration no.', 'text')}
        ${select('BloodGroup', 'Blood group', ['', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'])}
        <div>
          <label class="block text-[11px] font-mono tracking-[.14em] uppercase text-ink-mute mb-1.5">Class *</label>
          <select name="CurrentClassID" class="w-full bg-paper-card border border-rule px-3 py-2.5 text-sm">
            <option value="">Select</option>
            ${L.classes.map(c => `<option value="${esc(c.ClassID)}">${esc(c.ClassNameEnglish)}</option>`).join('')}
          </select></div>
        <div>
          <label class="block text-[11px] font-mono tracking-[.14em] uppercase text-ink-mute mb-1.5">Section *</label>
          <select name="CurrentSectionID" class="w-full bg-paper-card border border-rule px-3 py-2.5 text-sm">
            <option value="">Select a class first</option></select></div>
        ${field('RollNumber', 'Roll number *', 'number')}
        ${field('GuardianName', 'Guardian name *', 'text')}
        ${select('GuardianRelationship', 'Relationship *',
          ['Father', 'Mother', 'Brother', 'Sister', 'Uncle', 'Aunt', 'Grandfather', 'Grandmother', 'Other'])}
        ${field('GuardianPhone', 'Guardian phone *', 'tel')}
        ${field('Address', 'Address', 'text')}
        ${field('Upazila', 'Upazila', 'text')}
        ${field('District', 'District', 'text')}
      </div>
      <label class="flex items-start gap-3 pt-2 cursor-pointer">
        <input type="checkbox" name="createAccount" class="mt-1">
        <span class="text-sm"><span class="font-medium">Create a student login</span>
          <span class="block text-xs text-ink-mute">Username is the admission number.
            A password is generated and shown once.</span></span></label>
      <div class="flex gap-3 pt-2">
        <button type="submit"
          class="flex-1 bg-ink text-paper-card py-3 text-sm font-semibold hover:bg-ink-soft transition">
          Admit student</button>
        <button type="button" id="nsCancel"
          class="px-6 border border-rule text-sm hover:bg-paper-deep transition">Cancel</button>
      </div></form>`);

  const form = $('#nsForm');
  form.querySelector('[name="CurrentClassID"]').addEventListener('change', ev => {
    form.querySelector('[name="CurrentSectionID"]').innerHTML = '<option value="">Select</option>' +
      L.sections.filter(s => s.ClassID === ev.target.value)
        .map(s => `<option value="${esc(s.SectionID)}">Section ${esc(s.SectionName)}</option>`).join('');
  });
  $('#nsCancel').addEventListener('click', closeModal);
  form.addEventListener('submit', submitNewStudent);
}

async function submitNewStudent(e) {
  e.preventDefault();
  const form = e.target;
  const data = {};
  new FormData(form).forEach((v, k) => { data[k] = String(v).trim(); });
  data.createAccount = form.querySelector('[name="createAccount"]').checked;

  const required = ['EnglishName', 'BanglaName', 'Gender', 'DateOfBirth', 'CurrentClassID',
    'CurrentSectionID', 'RollNumber', 'GuardianName', 'GuardianPhone'];
  const missing = required.filter(f => !data[f]);
  if (missing.length) {
    const box = $('#nsError');
    box.textContent = 'Please complete: ' + missing.join(', ');
    box.hidden = false;
    return;
  }

  try {
    const res = await api('students.create', { data });
    closeModal();
    if (res.account) showCredentials('Student admitted', res.account);
    else toast('Admitted — ' + res.admissionNumber, 'success');
    loadStudents();
  } catch (err) {
    const box = $('#nsError');
    box.textContent = err.message;
    box.hidden = false;
  }
}

/* =========================================================================
 * 8. TEACHERS AND ACCOUNTS
 * ========================================================================= */

async function loadTeachers() {
  try {
    const [list, accounts] = await Promise.all([
      api('teachers.list'),
      api('accounts.status', {}, { quiet: true }).catch(() => null)
    ]);

    const acc = {};
    if (accounts) accounts.teachers.forEach(t => { acc[t.id] = t; });

    $('#tchMeta').textContent = accounts
      ? `${list.rows.length} staff · ${accounts.teachersWithoutAccount} without a login · ` +
        `${accounts.studentsWithoutAccount} students without a login`
      : `${list.rows.length} staff`;

    $('#tchBody').innerHTML = list.rows.length
      ? list.rows.map(t => {
          const a = acc[t.TeacherID];
          return `<tr class="border-b border-rule/60">
            <td class="px-5 py-3 font-mono text-xs">${esc(t.EmployeeID)}</td>
            <td class="px-5 py-3"><span class="font-medium">${esc(t.EnglishName)}</span>
              <span class="block font-display text-xs text-ink-mute">${esc(t.BanglaName)}</span></td>
            <td class="px-5 py-3 hidden md:table-cell text-xs">${esc(t.Designation)}</td>
            <td class="px-5 py-3 hidden lg:table-cell text-xs">${esc(t.Specialization || '')}</td>
            <td class="px-5 py-3">${a && a.username
              ? `<span class="font-mono text-xs">${esc(a.username)}</span>` +
                (a.active ? '' : ' <span class="pill bg-paper-deep text-ink-mute">off</span>')
              : '<span class="pill bg-gold-light text-gold">no login</span>'}</td>
            <td class="px-5 py-3 text-right whitespace-nowrap">${a && a.username
              ? `<button data-u="${esc(a.username)}"
                   class="tch-reset text-xs text-terra font-semibold hover:underline">Reset</button>`
              : `<button data-t="${esc(t.TeacherID)}"
                   class="tch-issue text-xs text-moss font-semibold hover:underline">Create login</button>`}
            </td></tr>`;
        }).join('')
      : '<tr><td colspan="6" class="px-5 py-10 text-center text-sm text-ink-mute">No staff records.</td></tr>';

    $$('.tch-reset').forEach(b =>
      b.addEventListener('click', () => resetAccount('TEACHER', b.dataset.u)));
    $$('.tch-issue').forEach(b =>
      b.addEventListener('click', () => issueAccount('TEACHER', b.dataset.t)));
  } catch (err) {
    $('#tchBody').innerHTML =
      `<tr><td colspan="6" class="px-5 py-10 text-center text-sm text-terra">${esc(err.message)}</td></tr>`;
  }
}

/**
 * A generated password exists in readable form exactly once — here. It is
 * stored only as a hash and cannot be recovered, so the dialog says so and
 * closes with a deliberate confirmation rather than a passive ✕.
 */
function showCredentials(title, account) {
  openModal(title, `
    <div class="px-4 py-3 mb-5 text-sm bg-gold-light border-l-4 border-gold">
      Write this down now. The password is stored only as a hash and cannot be shown again.
      If it is lost, reset the account.
    </div>
    <dl class="space-y-3">
      <div class="flex justify-between gap-4 pb-2 border-b border-rule">
        <dt class="text-ink-mute">Portal</dt>
        <dd class="font-semibold">${esc(ROLE_META[account.role] ? ROLE_META[account.role].label : account.role)}</dd></div>
      <div class="flex justify-between gap-4 pb-2 border-b border-rule">
        <dt class="text-ink-mute">Username</dt>
        <dd class="font-mono text-lg select-all">${esc(account.username)}</dd></div>
      <div class="flex justify-between gap-4 pb-2 border-b border-rule">
        <dt class="text-ink-mute">Password</dt>
        <dd class="font-mono text-lg select-all">${esc(account.password)}</dd></div>
    </dl>
    <p class="text-xs text-ink-mute mt-4">
      They will be asked to choose their own password at first sign-in, if their account allows it.</p>
    <button id="credDone"
      class="w-full mt-6 bg-ink text-paper-card py-3 text-sm font-semibold hover:bg-ink-soft transition">
      I have written it down</button>`);
  $('#credDone').addEventListener('click', closeModal);
}

async function issueAccount(role, personId) {
  try {
    const account = await api('accounts.create', { role, personId });
    showCredentials('Login created', account);
    if (State.view === 'teachers') loadTeachers();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function resetAccount(role, username) {
  if (!confirm(`Reset the password for "${username}"? Their current password stops working immediately.`)) return;
  try {
    showCredentials('Password reset', await api('accounts.reset', { role, username }));
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function showAccountsPanel() {
  try {
    const d = await api('accounts.status');
    openModal('Login accounts', `
      <div class="grid gap-4 sm:grid-cols-2 mb-6">
        ${statTile('Staff without a login', d.teachersWithoutAccount,
          d.teachersWithoutAccount ? 'text-terra' : 'text-moss')}
        ${statTile('Students without a login', d.studentsWithoutAccount,
          d.studentsWithoutAccount ? 'text-terra' : 'text-moss')}
      </div>
      ${d.studentsMissing.length ? `
        <h3 class="font-display text-lg mb-2 pb-2 rule-double">Students awaiting a login</h3>
        <p class="text-xs text-ink-mute mb-3">Showing ${d.studentsMissing.length}. For the whole
          school at once, run <span class="font-mono">createStudentAccounts()</span> in Apps Script.</p>
        <div class="max-h-80 overflow-y-auto"><table class="data w-full text-sm"><tbody>
          ${d.studentsMissing.map(s => `<tr class="border-b border-rule/60">
            <td class="py-2 font-mono text-xs">${esc(s.admissionNumber)}</td>
            <td class="py-2">${esc(s.name)}</td>
            <td class="py-2 text-right"><button data-s="${esc(s.id)}"
              class="acc-issue text-xs text-moss font-semibold hover:underline">Create login</button></td>
          </tr>`).join('')}
        </tbody></table></div>`
        : '<p class="text-sm text-ink-mute">Every active student has a login.</p>'}`);

    $$('.acc-issue').forEach(b =>
      b.addEventListener('click', () => issueAccount('STUDENT', b.dataset.s)));
  } catch (err) {
    toast(err.message, 'error');
  }
}

const DESIGNATIONS = ['Head Teacher', 'Assistant Head Teacher', 'Senior Teacher',
  'Assistant Teacher', 'Trainee Teacher', 'Office Staff'];

function openNewTeacherForm() {
  openModal('New teacher', `
    <form id="ntForm" class="space-y-4" novalidate>
      <div id="ntError" hidden class="px-4 py-3 text-sm bg-terra-light border-l-4 border-terra"></div>
      <div class="grid gap-4 sm:grid-cols-2">
        ${field('EnglishName', 'Name (English) *', 'text')}
        ${field('BanglaName', 'Name (Bangla) *', 'text')}
        ${select('Gender', 'Gender *', ['Male', 'Female', 'Other'])}
        ${field('Phone', 'Phone *', 'tel')}
        ${field('JoiningDate', 'Joining date *', 'date')}
        ${select('Designation', 'Designation *', DESIGNATIONS)}
        ${field('EmployeeID', 'Employee ID (auto if blank)', 'text')}
        ${field('DateOfBirth', 'Date of birth', 'date')}
        ${field('Department', 'Department', 'text')}
        ${field('Specialization', 'Main subject', 'text')}
        ${field('Qualification', 'Qualification', 'text')}
        ${field('Email', 'Email (contact only)', 'email')}
        ${field('NIDNumber', 'NID number', 'text')}
        ${field('Address', 'Address', 'text')}
      </div>
      <label class="flex items-start gap-3 pt-2 cursor-pointer">
        <input type="checkbox" name="createAccount" checked class="mt-1">
        <span class="text-sm"><span class="font-medium">Create a teacher login</span>
          <span class="block text-xs text-ink-mute">Username is built from their name,
            never from their email. A password is generated and shown once.</span></span></label>
      ${field('Username', 'Username (leave blank to auto-generate)', 'text')}
      <div class="flex gap-3 pt-2">
        <button type="submit"
          class="flex-1 bg-ink text-paper-card py-3 text-sm font-semibold hover:bg-ink-soft transition">
          Add teacher</button>
        <button type="button" id="ntCancel"
          class="px-6 border border-rule text-sm hover:bg-paper-deep transition">Cancel</button>
      </div></form>`);

  $('#ntCancel').addEventListener('click', closeModal);
  $('#ntForm').addEventListener('submit', submitNewTeacher);
}

async function submitNewTeacher(e) {
  e.preventDefault();
  const form = e.target;
  const data = {};
  new FormData(form).forEach((v, k) => { data[k] = String(v).trim(); });
  data.createAccount = form.querySelector('[name="createAccount"]').checked;

  const required = ['EnglishName', 'BanglaName', 'Gender', 'Phone', 'JoiningDate', 'Designation'];
  const missing = required.filter(f => !data[f]);
  if (missing.length) {
    const box = $('#ntError');
    box.textContent = 'Please complete: ' + missing.join(', ');
    box.hidden = false;
    return;
  }

  try {
    const res = await api('teachers.create', { data });
    closeModal();
    if (res.account) showCredentials('Teacher added', res.account);
    else toast('Added — ' + res.employeeId, 'success');
    loadTeachers();
  } catch (err) {
    const box = $('#ntError');
    box.textContent = err.message;
    box.hidden = false;
  }
}

/* =========================================================================
 * 9. MARK ENTRY
 * ========================================================================= */

async function loadMarksView() {
  if ($('#mkExam').children.length) return;
  try {
    const d = await api('exams.list', {}, { quiet: true });
    $('#mkExam').innerHTML = '<option value="">Select exam</option>' +
      d.exams.map(e => `<option value="${esc(e.ExamID)}">${esc(e.ExamName)}</option>`).join('');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function loadMarkSheet() {
  const examId = $('#mkExam').value, classId = $('#mkClass').value;
  const sectionId = $('#mkSection').value, subjectId = $('#mkSubject').value;
  if (!examId || !classId || !sectionId || !subjectId) {
    return toast('Choose an exam, class, section and subject.', 'error');
  }

  try {
    const d = await api('marks.sheet', { examId, classId, sectionId, subjectId });
    State.marks = { examId, classId, sectionId, subjectId,
                    scheduleId: d.examScheduleId, max: d.maximumMarks, pass: d.passMarks };

    $('#mkPanel').hidden = false;
    $('#mkMeta').textContent = `${classLabel(classId)} · Section ${sectionLabel(sectionId)} · ` +
      `${subjectLabel(subjectId)} · out of ${d.maximumMarks}, pass ${d.passMarks}`;

    $('#mkBody').innerHTML = d.students.map(s => {
      const m = d.marks[s.StudentID] || {};
      const locked = m.Status === 'Verified' || m.Status === 'Published';
      return `<tr class="border-b border-rule/60" data-student="${esc(s.StudentID)}">
        <td class="px-5 py-2.5 font-mono text-xs">${esc(s.RollNumber)}</td>
        <td class="px-5 py-2.5"><span class="font-medium">${esc(s.EnglishName)}</span>
          <span class="block font-display text-xs text-ink-mute">${esc(s.BanglaName)}</span></td>
        <td class="px-5 py-2.5">
          <input type="number" min="0" max="${esc(d.maximumMarks)}" step="0.5" placeholder="—"
                 value="${esc(m.MarksObtained)}" ${locked ? 'disabled' : ''}
                 class="mk-input w-28 bg-paper-card border border-rule px-3 py-1.5 text-sm font-mono
                        ${locked ? 'opacity-50' : ''}"></td>
        <td class="px-5 py-2.5"><span class="mk-grade font-mono text-sm">${esc(m.Grade || '')}</span>
          ${locked ? '<span class="pill bg-paper-deep text-ink-mute ml-2">locked</span>' : ''}</td>
      </tr>`;
    }).join('');

    $$('#mkBody .mk-input').forEach(inp => {
      inp.addEventListener('input', () => {
        const cell = inp.closest('tr').querySelector('.mk-grade');
        cell.textContent = inp.value === ''
          ? '' : gradePreview(Number(inp.value) / State.marks.max * 100);
      });
    });
  } catch (err) {
    $('#mkPanel').hidden = true;
    toast(err.message, 'error');
  }
}

/** Preview only. The server recomputes from GRADE_SCALE on save. */
function gradePreview(pct) {
  const scale = (State.lookups && State.lookups.gradeScale) || [];
  const band = scale.find(g => pct >= Number(g.MinPercentage) && pct <= Number(g.MaxPercentage));
  return band ? band.Grade : '';
}

async function saveMarks() {
  const records = [];
  for (const row of $$('#mkBody tr')) {
    const input = row.querySelector('.mk-input');
    if (!input || input.disabled) continue;
    const raw = input.value.trim();
    if (raw !== '') {
      const n = Number(raw);
      if (isNaN(n) || n < 0 || n > State.marks.max) {
        input.focus();
        return toast(`Marks must be between 0 and ${State.marks.max}.`, 'error');
      }
    }
    records.push({ studentId: row.dataset.student, marksObtained: raw === '' ? '' : Number(raw) });
  }
  if (!records.length) return toast('Nothing to save.', 'error');

  try {
    const res = await api('marks.save', {
      examId: State.marks.examId, examScheduleId: State.marks.scheduleId,
      classId: State.marks.classId, sectionId: State.marks.sectionId,
      subjectId: State.marks.subjectId, records
    });
    toast(`Saved — ${res.created} new, ${res.updated} updated.`, 'success');
    loadMarkSheet();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* =========================================================================
 * 10. RESULTS (student)
 * ========================================================================= */

async function loadResultsView() {
  if ($('#resExam').children.length) return;
  try {
    const d = await api('exams.list', {}, { quiet: true });
    $('#resExam').innerHTML = d.exams.length
      ? '<option value="">Select an examination</option>' +
        d.exams.map(e => `<option value="${esc(e.ExamID)}">${esc(e.ExamName)}</option>`).join('')
      : '<option value="">No results published yet</option>';
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function loadResult() {
  const examId = $('#resExam').value;
  if (!examId) return toast('Choose an examination.', 'error');

  try {
    const d = await api('results.get', { examId });
    const c = d.reportCard;

    $('#resPanel').innerHTML = `
      ${c ? `<div class="grid gap-4 sm:grid-cols-4 mb-6">
        ${statTile('GPA', Number(c.GPA).toFixed(2), 'text-terra')}
        ${statTile('Grade', c.OverallGrade, 'text-moss')}
        ${statTile('Marks', `${c.ObtainedMarks} / ${c.TotalMarks}`, 'text-ink')}
        ${statTile('Position', c.Position || '—', 'text-gold')}</div>` : ''}
      <div class="card overflow-hidden">
        <h2 class="font-display text-xl px-5 py-4 border-b border-rule">Subject results</h2>
        <div class="overflow-x-auto"><table class="data w-full text-sm">
          <thead><tr class="border-b border-rule">
            <th class="text-left px-5 py-3">Subject</th>
            <th class="text-right px-5 py-3">Marks</th>
            <th class="text-right px-5 py-3">%</th>
            <th class="text-left px-5 py-3">Grade</th>
            <th class="text-left px-5 py-3">GP</th>
            <th class="text-left px-5 py-3">Result</th></tr></thead>
          <tbody>${d.subjects.length ? d.subjects.map(s => `
            <tr class="border-b border-rule/60">
              <td class="px-5 py-3"><span class="font-medium">${esc(s.SubjectName)}</span>
                <span class="block font-display text-xs text-ink-mute">${esc(s.SubjectNameBangla)}</span></td>
              <td class="px-5 py-3 text-right font-mono">${esc(s.MarksObtained)} / ${esc(s.MaximumMarks)}</td>
              <td class="px-5 py-3 text-right font-mono">${esc(s.Percentage)}</td>
              <td class="px-5 py-3 font-semibold">${esc(s.Grade)}</td>
              <td class="px-5 py-3 font-mono">${esc(s.GradePoint)}</td>
              <td class="px-5 py-3"><span class="pill ${s.PassFail === 'Pass'
                ? 'bg-moss-light text-moss' : 'bg-terra-light text-terra'}">${esc(s.PassFail)}</span></td>
            </tr>`).join('')
            : '<tr><td colspan="6" class="px-5 py-10 text-center text-sm text-ink-mute">No marks recorded.</td></tr>'}
          </tbody></table></div>
        ${c && c.Remarks ? `<p class="px-5 py-4 border-t border-rule text-sm text-ink-soft">
          <span class="font-mono text-[10px] tracking-wider uppercase text-ink-mute">Remarks</span><br>
          ${esc(c.Remarks)}</p>` : ''}
      </div>`;
  } catch (err) {
    $('#resPanel').innerHTML =
      `<div class="card p-8 text-center text-sm text-ink-mute">${esc(err.message)}</div>`;
  }
}

/* =========================================================================
 * 11. FEES
 * ========================================================================= */

async function loadFees() {
  if (State.role === 'ADMIN') return loadInvoices();

  try {
    const d = await api('fees.get');
    const billed = d.invoices.reduce((s, i) => s + Number(i.TotalAmount || 0), 0);
    const paid = d.invoices.reduce((s, i) => s + Number(i.PaidAmount || 0), 0);

    $('#feeSummary').innerHTML = [
      statTile('Total billed', money(billed), 'text-ink'),
      statTile('Paid', money(paid), 'text-moss'),
      statTile('Outstanding', money(d.totalDue), d.totalDue > 0 ? 'text-terra' : 'text-moss')
    ].join('');

    $('#invHeading').textContent = 'My invoices';
    $('#invBody').innerHTML = d.invoices.length
      ? d.invoices.map(i => `<tr class="border-b border-rule/60">
          <td class="px-5 py-3 font-mono text-xs">${esc(i.InvoiceNumber)}</td>
          <td class="px-5 py-3 text-xs">${esc(i.Particulars)}</td>
          <td class="px-5 py-3 text-right font-mono">${money(i.BalanceAmount)}</td>
          <td class="px-5 py-3">${invoicePill(i.Status)}</td>
          <td></td></tr>`).join('')
      : '<tr><td colspan="5" class="px-5 py-10 text-center text-sm text-ink-mute">No invoices.</td></tr>';

    renderPayments(d.payments);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function loadInvoices() {
  try {
    const d = await api('invoices.list', {
      status: $('#invStatus').value, search: $('#invSearch').value.trim()
    });

    const billed = d.rows.reduce((s, i) => s + Number(i.TotalAmount || 0), 0);
    const paid = d.rows.reduce((s, i) => s + Number(i.PaidAmount || 0), 0);
    const due = d.rows.reduce((s, i) => s + Number(i.BalanceAmount || 0), 0);

    $('#feeSummary').innerHTML = [
      statTile('Billed (shown)', money(billed), 'text-ink'),
      statTile('Collected (shown)', money(paid), 'text-moss'),
      statTile('Outstanding (shown)', money(due), due > 0 ? 'text-terra' : 'text-moss')
    ].join('');

    $('#invHeading').textContent = `Invoices — showing ${d.shown} of ${d.total}`;
    $('#invBody').innerHTML = d.rows.length
      ? d.rows.map(i => `<tr class="border-b border-rule/60">
          <td class="px-5 py-3"><span class="font-mono text-xs">${esc(i.InvoiceNumber)}</span>
            <span class="block text-xs text-ink-mute">${esc(i.StudentName)}</span></td>
          <td class="px-5 py-3 text-xs">${esc(i.Particulars)}</td>
          <td class="px-5 py-3 text-right font-mono">${money(i.BalanceAmount)}</td>
          <td class="px-5 py-3">${invoicePill(i.Status)}</td>
          <td class="px-5 py-3 text-right">${Number(i.BalanceAmount) > 0 && i.Status !== 'Cancelled'
            ? `<button data-inv="${esc(i.InvoiceID)}" data-bal="${esc(i.BalanceAmount)}"
                 data-name="${esc(i.StudentName)}"
                 class="pay-btn text-xs text-terra font-semibold hover:underline">Take payment</button>`
            : ''}</td></tr>`).join('')
      : '<tr><td colspan="5" class="px-5 py-10 text-center text-sm text-ink-mute">No invoices matched.</td></tr>';

    $('#payBody').innerHTML =
      '<tr><td colspan="4" class="px-5 py-10 text-center text-sm text-ink-mute">' +
      'Open a student record to see their payment history.</td></tr>';

    $$('.pay-btn').forEach(b => b.addEventListener('click', () =>
      openPaymentForm(b.dataset.inv, Number(b.dataset.bal), b.dataset.name)));
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderPayments(payments) {
  $('#payBody').innerHTML = payments.length
    ? payments.map(p => `<tr class="border-b border-rule/60">
        <td class="px-5 py-3 font-mono text-xs">${esc(p.ReceiptNumber)}</td>
        <td class="px-5 py-3 font-mono text-xs">${esc(p.PaymentDate)}</td>
        <td class="px-5 py-3">${esc(p.PaymentMethod)}</td>
        <td class="px-5 py-3 text-right font-mono">${money(p.Amount)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="px-5 py-10 text-center text-sm text-ink-mute">No payments recorded.</td></tr>';
}

function invoicePill(status) {
  const map = { Paid: 'bg-moss-light text-moss', Unpaid: 'bg-paper-deep text-ink-soft',
                PartiallyPaid: 'bg-gold-light text-gold', Overdue: 'bg-terra-light text-terra',
                Cancelled: 'bg-paper-deep text-ink-mute' };
  return `<span class="pill ${map[status] || map.Unpaid}">${esc(status)}</span>`;
}

function openPaymentForm(invoiceId, balance, studentName) {
  const methods = (State.lookups && State.lookups.paymentMethods) || ['Cash'];
  openModal('Record a payment', `
    <form id="payForm" class="space-y-4" novalidate>
      <div id="payError" hidden class="px-4 py-3 text-sm bg-terra-light border-l-4 border-terra"></div>
      <p class="text-sm text-ink-soft">${esc(studentName)} · outstanding
        <span class="font-mono font-semibold">${money(balance)}</span></p>
      ${field('amount', 'Amount (BDT) *', 'number', balance)}
      ${select('method', 'Payment method *', methods, 'Cash')}
      ${field('reference', 'Transaction reference (not needed for cash)', 'text')}
      ${field('notes', 'Notes', 'text')}
      <div class="flex gap-3 pt-2">
        <button type="submit"
          class="flex-1 bg-terra text-paper-card py-3 text-sm font-semibold hover:brightness-110 transition">
          Record payment</button>
        <button type="button" id="payCancel"
          class="px-6 border border-rule text-sm hover:bg-paper-deep transition">Cancel</button>
      </div></form>`);

  $('#payCancel').addEventListener('click', closeModal);
  $('#payForm').addEventListener('submit', async e => {
    e.preventDefault();
    const d = {};
    new FormData(e.target).forEach((v, k) => { d[k] = String(v).trim(); });
    try {
      const res = await api('payments.create', {
        invoiceId, amount: Number(d.amount), method: d.method,
        reference: d.reference, notes: d.notes
      });
      closeModal();
      toast(`Receipt ${res.receiptNumber} · balance now ${money(res.newBalance)}`, 'success');
      loadInvoices();
    } catch (err) {
      const box = $('#payError');
      box.textContent = err.message;
      box.hidden = false;
    }
  });
}

/* =========================================================================
 * 12. NOTICES  (bilingual — nothing special needed, the sheet is Unicode)
 * ========================================================================= */

async function loadNotices() {
  try {
    const d = await api('notices.list');
    $('#noticeList').innerHTML = d.notices.length
      ? d.notices.map((n, i) => `
          <article class="card p-6 rise" style="animation-delay:${i * 40}ms">
            <div class="flex items-start justify-between gap-3 mb-2">
              <h2 class="font-display text-xl leading-snug">${esc(n.Title)}</h2>
              ${priorityPill(n.Priority)}
            </div>
            <p class="text-sm text-ink-soft leading-relaxed">${escLines(n.Body)}</p>
            <div class="flex flex-wrap items-center gap-3 mt-4 pt-3 border-t border-rule">
              <span class="font-mono text-[10px] tracking-wider text-ink-mute">
                ${esc(n.PublishDate)} · ${esc(n.Audience)}</span>
              ${String(n.IsPublic).toUpperCase() === 'TRUE'
                ? '<span class="pill bg-moss-light text-moss">on website</span>' : ''}
              ${String(n.Status) !== 'Published'
                ? `<span class="pill bg-paper-deep text-ink-mute">${esc(n.Status)}</span>` : ''}
              ${can('NOTICE_MANAGE')
                ? `<button data-n="${esc(n.NoticeID)}"
                     class="notice-edit ml-auto text-xs text-terra font-semibold hover:underline">Edit</button>` : ''}
            </div></article>`).join('')
      : '<div class="card p-10 text-center text-sm text-ink-mute lg:col-span-2">No notices right now.</div>';

    $$('.notice-edit').forEach(b => b.addEventListener('click', () => {
      const n = d.notices.find(x => x.NoticeID === b.dataset.n);
      if (n) openNoticeForm(n);
    }));
  } catch (err) {
    toast(err.message, 'error');
  }
}

function openNoticeForm(existing) {
  const n = existing || {};
  const L = State.lookups;
  openModal(existing ? 'Edit notice' : 'New notice', `
    <form id="noForm" class="space-y-4" novalidate>
      <div id="noError" hidden class="px-4 py-3 text-sm bg-terra-light border-l-4 border-terra"></div>
      <p class="text-xs text-ink-mute">
        Type in Bangla, English, or both in the same sentence — the sheet stores Unicode
        and the portal renders Bengali correctly.</p>
      ${field('Title', 'Title *', 'text', n.Title)}
      ${textarea('Body', 'Body *', 7, n.Body)}
      <div class="grid gap-4 sm:grid-cols-2">
        ${select('Audience', 'Audience *', ['All', 'Students', 'Teachers', 'Specific Class'], n.Audience)}
        <div>
          <label class="block text-[11px] font-mono tracking-[.14em] uppercase text-ink-mute mb-1.5">
            Class (if class-specific)</label>
          <select name="ClassID" class="w-full bg-paper-card border border-rule px-3 py-2.5 text-sm">
            <option value="">—</option>
            ${L.classes.map(c => `<option value="${esc(c.ClassID)}"
              ${c.ClassID === n.ClassID ? 'selected' : ''}>${esc(c.ClassNameEnglish)}</option>`).join('')}
          </select></div>
        ${select('Priority', 'Priority', ['Low', 'Normal', 'High', 'Urgent'], n.Priority || 'Normal')}
        ${select('Status', 'Status', ['Draft', 'Published', 'Archived'], n.Status || 'Published')}
        ${field('PublishDate', 'Publish date', 'date', n.PublishDate || todayISO())}
        ${field('ExpiryDate', 'Expiry date (blank = never)', 'date', n.ExpiryDate)}
        ${field('AttachmentURL', 'Attachment URL', 'url', n.AttachmentURL)}
      </div>
      <div class="flex flex-wrap gap-6 pt-1">
        <label class="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" name="IsPublic"
            ${String(n.IsPublic).toUpperCase() === 'TRUE' ? 'checked' : ''}>
          Show on the public website</label>
        <label class="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" name="IsPinned"
            ${String(n.IsPinned).toUpperCase() === 'TRUE' ? 'checked' : ''}>
          Pin to the top</label>
      </div>
      <div class="flex gap-3 pt-2">
        <button type="submit"
          class="flex-1 bg-ink text-paper-card py-3 text-sm font-semibold hover:bg-ink-soft transition">
          ${existing ? 'Save changes' : 'Publish notice'}</button>
        <button type="button" id="noCancel"
          class="px-6 border border-rule text-sm hover:bg-paper-deep transition">Cancel</button>
      </div></form>`);

  $('#noCancel').addEventListener('click', closeModal);
  $('#noForm').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const data = {};
    new FormData(form).forEach((v, k) => { data[k] = String(v).trim(); });
    data.IsPublic = form.querySelector('[name="IsPublic"]').checked;
    data.IsPinned = form.querySelector('[name="IsPinned"]').checked;

    if (!data.Title || !data.Body) {
      const box = $('#noError');
      box.textContent = 'Title and body are both required.';
      box.hidden = false;
      return;
    }
    try {
      await api('notices.save', { noticeId: n.NoticeID || '', data });
      closeModal();
      toast('Notice saved.', 'success');
      loadNotices();
    } catch (err) {
      const box = $('#noError');
      box.textContent = err.message;
      box.hidden = false;
    }
  });
}

/* =========================================================================
 * 13. WEBSITE CONTENT
 * ========================================================================= */

async function loadWebsite() {
  try {
    const d = await api('web.list');
    $('#webList').innerHTML = d.blocks.map(b => `
      <article class="card p-5">
        <div class="flex items-center justify-between gap-3 mb-2">
          <span class="pill bg-paper-deep text-ink-soft">${esc(b.Section)}</span>
          <span class="font-mono text-[10px] text-ink-mute">${esc(b.SectionKey)}</span>
        </div>
        <h3 class="font-display text-lg leading-snug">${esc(b.Title) || '<em>no title</em>'}</h3>
        <p class="text-sm text-ink-soft mt-1 leading-relaxed">${escLines(String(b.Body || '').slice(0, 200))}</p>
        <div class="flex items-center gap-3 mt-4 pt-3 border-t border-rule">
          ${String(b.IsVisible).toUpperCase() === 'TRUE'
            ? '<span class="pill bg-moss-light text-moss">visible</span>'
            : '<span class="pill bg-paper-deep text-ink-mute">hidden</span>'}
          <button data-c="${esc(b.ContentID)}"
            class="web-edit ml-auto text-xs text-terra font-semibold hover:underline">Edit</button>
        </div></article>`).join('');

    $$('.web-edit').forEach(btn => btn.addEventListener('click', () => {
      const b = d.blocks.find(x => x.ContentID === btn.dataset.c);
      if (b) openWebForm(b);
    }));
  } catch (err) {
    toast(err.message, 'error');
  }
}

function openWebForm(b) {
  openModal('Edit website block', `
    <form id="webForm" class="space-y-4" novalidate>
      <div id="webError" hidden class="px-4 py-3 text-sm bg-terra-light border-l-4 border-terra"></div>
      <div class="grid gap-4 sm:grid-cols-2">
        ${select('Section', 'Section *',
          ['Hero', 'About', 'Feature', 'Facility', 'Stat', 'Contact', 'Footer'], b.Section)}
        ${field('SectionKey', 'Key *', 'text', b.SectionKey)}
      </div>
      ${field('Title', 'Title', 'text', b.Title)}
      ${textarea('Body', 'Body', 5, b.Body)}
      <div class="grid gap-4 sm:grid-cols-2">
        ${field('ImageURL', 'Image URL', 'url', b.ImageURL)}
        ${field('LinkURL', 'Link URL', 'url', b.LinkURL)}
        ${field('SortOrder', 'Sort order', 'number', b.SortOrder)}
      </div>
      <label class="flex items-center gap-2 text-sm cursor-pointer">
        <input type="checkbox" name="IsVisible"
          ${String(b.IsVisible).toUpperCase() === 'TRUE' ? 'checked' : ''}> Visible on the website</label>
      <div class="flex gap-3 pt-2">
        <button type="submit"
          class="flex-1 bg-ink text-paper-card py-3 text-sm font-semibold hover:bg-ink-soft transition">
          Save</button>
        <button type="button" id="webCancel"
          class="px-6 border border-rule text-sm hover:bg-paper-deep transition">Cancel</button>
      </div></form>`);

  $('#webCancel').addEventListener('click', closeModal);
  $('#webForm').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const data = {};
    new FormData(form).forEach((v, k) => { data[k] = String(v).trim(); });
    data.IsVisible = form.querySelector('[name="IsVisible"]').checked;
    try {
      await api('web.save', { contentId: b.ContentID, data });
      closeModal();
      toast('Saved. The public site updates within a few minutes.', 'success');
      loadWebsite();
    } catch (err) {
      const box = $('#webError');
      box.textContent = err.message;
      box.hidden = false;
    }
  });
}

/* =========================================================================
 * 14. PROFILE
 * ========================================================================= */

async function loadProfile() {
  const x = State.user.extra || {};
  const rows = [
    ['Name', State.user.displayName], ['Username', State.user.username],
    ['Portal', ROLE_META[State.role].label]
  ];
  if (x.banglaName) rows.push(['Bangla name', x.banglaName]);
  if (x.admissionNumber) rows.push(['Admission no.', x.admissionNumber]);
  if (x.classId) rows.push(['Class', classLabel(x.classId)]);
  if (x.sectionId) rows.push(['Section', sectionLabel(x.sectionId)]);
  if (x.rollNumber) rows.push(['Roll number', x.rollNumber]);
  if (x.employeeId) rows.push(['Employee ID', x.employeeId]);
  if (x.designation) rows.push(['Designation', x.designation]);

  $('#profileBody').innerHTML = rows.filter(([, v]) => v).map(([k, v]) =>
    `<div class="flex justify-between gap-4 pb-2 border-b border-rule">
      <dt class="text-ink-mute">${esc(k)}</dt>
      <dd class="font-medium text-right">${esc(v)}</dd></div>`).join('');

  // CanChangePassword is a per-account column, not a role rule.
  $('#pwForm').hidden = !State.canChangePassword;
  $('#pwLocked').hidden = State.canChangePassword;
}

async function changePassword(e) {
  e.preventDefault();
  const current = $('#pwCurrent').value;
  const next = $('#pwNew').value;
  const confirmPw = $('#pwConfirm').value;

  if (!current || !next) return toast('Fill in both password fields.', 'error');
  if (next.length < 8) return toast('New password must be at least 8 characters.', 'error');
  if (next !== confirmPw) return toast('The two new passwords do not match.', 'error');

  try {
    await api('auth.changePassword', { currentPassword: current, newPassword: next });
    $('#pwForm').reset();
    State.mustChangePassword = false;
    $('#pwNotice').hidden = true;
    toast('Password updated.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* =========================================================================
 * 15. MODAL
 * ========================================================================= */

function openModal(title, html) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modal').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  $('#modal').hidden = true;
  $('#modalBody').innerHTML = '';
  document.body.style.overflow = '';
}

/* =========================================================================
 * 16. WIRING
 * ========================================================================= */

document.addEventListener('DOMContentLoaded', () => {
  $$('.role-pick').forEach(b => b.addEventListener('click', () => chooseRole(b.dataset.role)));
  $('#backToRoles').addEventListener('click', backToRoles);
  $('#loginForm').addEventListener('submit', doLogin);

  $('#logoutBtn').addEventListener('click', doLogout);
  $('#mobileLogout').addEventListener('click', doLogout);
  $('#menuToggle').addEventListener('click', openSidebar);
  $('#scrim').addEventListener('click', closeSidebar);

  $('#modalClose').addEventListener('click', closeModal);
  $('#modalScrim').addEventListener('click', closeModal);
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeModal(); });

  $('#stuLoad').addEventListener('click', () => loadStudents());
  $('#stuSearch').addEventListener('keydown', ev => { if (ev.key === 'Enter') loadStudents(); });
  $('#stuAdd').addEventListener('click', openNewStudentForm);

  $('#tchAdd').addEventListener('click', openNewTeacherForm);
  $('#tchAccounts').addEventListener('click', showAccountsPanel);

  $('#mkLoad').addEventListener('click', loadMarkSheet);
  $('#mkSave').addEventListener('click', saveMarks);

  $('#resLoad').addEventListener('click', loadResult);

  $('#invLoad').addEventListener('click', loadInvoices);
  $('#invSearch').addEventListener('keydown', ev => { if (ev.key === 'Enter') loadInvoices(); });

  $('#noticeAdd').addEventListener('click', () => openNoticeForm(null));
  $('#pwForm').addEventListener('submit', changePassword);

  // Restore a session if the tab was only reloaded.
  const stored = sessionStorage.getItem('erp_token');
  if (stored) {
    State.token = stored;
    api('auth.me', {}, { quiet: true })
      .then(d => { saveSession(d); return enterApp(); })
      .catch(() => hardLogout());
  }
});
