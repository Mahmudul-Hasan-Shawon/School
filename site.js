/* ============================================================================
 *  PUBLIC WEBSITE CONTROLLER
 *
 *  Reads SCHOOL_INFO, WEB_CONTENT, public NOTICES and the staff list through a
 *  single `public.site` call. The backend caches that payload for five minutes
 *  and this page caches it in sessionStorage, so a repeat visit paints without
 *  waiting on Apps Script at all.
 *
 *  SET THIS BEFORE DEPLOYING
 * ========================================================================== */

const API_URL = 'https://script.google.com/macros/s/AKfycbwCwkdlR947fZidu9d4_rxoeC9MO8AZiQ0ZJjAsTp2lMOQeeuE0temgAUHHNl8EaEx-CA/exec';

/* ------------------------------------------------------------------ utils */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/** Everything from the sheet is escaped before it touches innerHTML. */
function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Preserve the line breaks admins type into a notice body. */
function escLines(v) { return esc(v).replace(/\n/g, '<br>'); }

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return esc(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function showError(message) {
  const el = $('#errBanner');
  el.textContent = message;
  el.hidden = false;
}

/* ------------------------------------------------------------------- load */

async function fetchSite() {
  // Paint instantly from the last visit, then refresh in the background.
  const cached = sessionStorage.getItem('site_payload');
  if (cached) {
    try {
      render(JSON.parse(cached));
      $('#veil').hidden = true;
    } catch (e) { /* fall through to a live fetch */ }
  }

  if (API_URL.indexOf('PASTE_YOUR_DEPLOYMENT_ID') >= 0) {
    $('#veil').hidden = true;
    showError('API_URL is not configured in site.js.');
    return;
  }

  try {
    // A plain GET, so the browser and any CDN in front can cache it.
    const res = await fetch(API_URL + '?action=public.site', { redirect: 'follow' });
    if (!res.ok) throw new Error('The server returned ' + res.status + '.');

    const json = await res.json();
    if (!json.ok) throw new Error((json.error && json.error.message) || 'Request failed.');

    sessionStorage.setItem('site_payload', JSON.stringify(json.data));
    render(json.data);
  } catch (err) {
    if (!cached) {
      showError('Could not load the site content. ' +
        (err instanceof TypeError
          ? 'Check that the web app is deployed with access set to "Anyone".'
          : err.message));
    }
  } finally {
    $('#veil').hidden = true;
  }
}

/* ----------------------------------------------------------------- render */

function render(d) {
  const school = d.school || {};
  const content = d.content || {};

  const nameEn = school.SchoolNameEnglish || 'School';
  const nameBn = school.SchoolNameBangla || nameEn;

  document.title = nameEn;
  $('#navNameBn').textContent = nameBn;
  $('#navNameEn').textContent = nameEn;
  $('#footName').textContent = '© ' + new Date().getFullYear() + ' ' + nameEn;
  $('#topEiin').textContent = school.EIIN ? 'EIIN ' + school.EIIN : '';

  if (school.Phone) {
    const a = $('#topPhone');
    a.textContent = school.Phone;
    a.href = 'tel:' + String(school.Phone).replace(/\s/g, '');
  }
  if (school.Email) {
    const a = $('#topEmail');
    a.textContent = school.Email;
    a.href = 'mailto:' + school.Email;
  }

  // ---- hero
  const hero = (content.Hero || [])[0] || {};
  $('#heroTitle').textContent = hero.Title || nameBn;
  $('#heroBody').textContent = hero.Body || d.tagline || '';
  $('#heroMotto').textContent = school.MottoBangla || school.MottoEnglish || '';
  $('#heroAdmission').hidden = !d.admissionOpen;

// ---- stats
$('#statGrid').innerHTML = (content.Stat || []).map(s => `
  <div>
    <dt class="font-roboto font-bold text-4xl text-terra leading-none">${esc(s.Title)}</dt>
    <dd class="mt-1.5 text-xs text-ink-mute">${esc(s.Body)}</dd>
  </div>`).join('');

  // ---- about
  const about = (content.About || [])[0] || {};
  if (about.Title) $('#aboutTitle').textContent = about.Title;
  $('#aboutBody').textContent = about.Body || '';
  $('#headMessage').textContent = school.HeadTeacherMessage || '';
  $('#headName').textContent = school.HeadTeacherName
    ? school.HeadTeacherName + ' — Head Teacher' : '';

  // ---- features
  $('#featureGrid').innerHTML = (content.Feature || []).map((f, i) => `
    <article class="bg-ink p-8 rise" style="animation-delay:${i * 70}ms">
      <span class="font-mono text-[11px] text-terra">0${i + 1}</span>
      <h3 class="font-display text-2xl mt-3 mb-3">${esc(f.Title)}</h3>
      <p class="text-sm text-paper-card/60 leading-relaxed">${esc(f.Body)}</p>
      ${f.LinkURL ? `<a href="${esc(f.LinkURL)}"
        class="inline-block mt-4 text-xs font-semibold text-terra hover:underline">Learn more →</a>` : ''}
    </article>`).join('');

  // ---- facilities
  $('#facilityGrid').innerHTML = (content.Facility || []).map((f, i) => `
    <article class="card p-6 rise" style="animation-delay:${i * 60}ms">
      <h3 class="font-display text-xl mb-2">${esc(f.Title)}</h3>
      <p class="text-sm text-ink-soft leading-relaxed">${esc(f.Body)}</p>
    </article>`).join('');

  // ---- notices
  const notices = d.notices || [];
  $('#noticeList').innerHTML = notices.length
    ? notices.slice(0, d.noticesOnHomepage * 2 || 8).map((n, i) => `
        <article class="card p-6 notice-item rise" style="animation-delay:${i * 50}ms">
          <div class="flex items-start justify-between gap-3 mb-2">
            <h3 class="font-display text-xl leading-snug">${esc(n.Title)}</h3>
            ${priorityPill(n.Priority, n.IsPinned)}
          </div>
          <p class="text-sm text-ink-soft leading-relaxed">${escLines(n.Body)}</p>
          <div class="flex items-center gap-4 mt-4 pt-3 border-t border-rule">
            <span class="font-mono text-[10px] tracking-wider text-ink-mute">
              ${formatDate(n.PublishDate)}</span>
            ${n.AttachmentURL ? `<a href="${esc(n.AttachmentURL)}" target="_blank" rel="noopener"
              class="text-xs font-semibold text-terra hover:underline">Attachment</a>` : ''}
          </div>
        </article>`).join('')
    : '<p class="text-sm text-ink-mute lg:col-span-2">No public notices at the moment.</p>';

  // ---- ticker: duplicated once so the marquee loops seamlessly
  if (notices.length) {
    const items = notices.slice(0, 6)
      .map(n => `<span class="shrink-0">${esc(n.Title)}</span>`).join('');
    $('#tickerTrack').innerHTML = items + items;
    $('#ticker').hidden = false;
  }

  // ---- staff
  const staff = d.staff || [];
  $('#staffGrid').innerHTML = staff.length
    ? staff.map((t, i) => `
        <article class="card p-5 text-center rise" style="animation-delay:${i * 40}ms">
          <div class="w-16 h-16 mx-auto mb-4 rounded-full bg-paper-deep border border-rule
                      flex items-center justify-center font-display text-2xl text-terra">
            ${esc(initials(t.EnglishName))}
          </div>
          <h3 class="font-semibold text-[15px] leading-tight">${esc(t.EnglishName)}</h3>
          <p class="font-display text-sm text-ink-mute mt-0.5">${esc(t.BanglaName)}</p>
          <p class="mt-2 text-xs text-terra font-semibold">${esc(t.Designation)}</p>
          <p class="text-xs text-ink-mute mt-1">${esc(t.Specialization || '')}</p>
        </article>`).join('')
    : '<p class="text-sm text-ink-mute">Staff list coming soon.</p>';

  // ---- contact
  const rows = [
    ['ঠিকানা / Address',
      [school.AddressLine, school.Upazila, school.District, school.Division]
        .filter(Boolean).join(', ')],
    ['ফোন / Phone', school.Phone],
    ['ইমেইল / Email', school.Email],
    ['EIIN', school.EIIN]
  ];
  (content.Contact || []).forEach(c => rows.push([c.Title, c.Body]));

  $('#contactList').innerHTML = rows.filter(([, v]) => v).map(([k, v]) => `
    <div class="pb-4 border-b border-paper-card/15">
      <dt class="font-mono text-[10px] tracking-[.16em] uppercase text-paper-card/40 mb-1">${esc(k)}</dt>
      <dd>${esc(v)}</dd>
    </div>`).join('');
}

function priorityPill(priority, pinned) {
  const map = {
    Urgent: 'bg-terra text-paper-card', High: 'bg-terra-light text-terra',
    Normal: 'bg-paper-deep text-ink-soft', Low: 'bg-paper-deep text-ink-mute'
  };
  const cls = map[priority] || map.Normal;
  const label = String(pinned).toUpperCase() === 'TRUE' ? 'Pinned' : (priority || 'Normal');
  return `<span class="shrink-0 text-[11px] tracking-wide px-2.5 py-1 rounded-full
                       font-semibold ${cls}">${esc(label)}</span>`;
}

function initials(name) {
  const parts = String(name || '')
    .replace(/^(Md\.|Most\.|Mst\.|Mrs\.|Mr\.|Ms\.|Dr\.)\s*/i, '')
    .trim().split(/\s+/);
  return ((parts[0] || '')[0] || '' ) + ((parts[parts.length - 1] || '')[0] || '');
}

/* ------------------------------------------------------------------ wiring */

document.addEventListener('DOMContentLoaded', () => {
  // Mobile menu open/close is handled entirely by the inline script in
  // index.html (it also closes the menu on an outside click). A second
  // listener here was toggling `hidden` a second time on every click,
  // which cancelled the first toggle out and made the button look broken.
  $$('.mob').forEach(a => a.addEventListener('click', () => { $('#mobileMenu').hidden = true; }));
  fetchSite();
});