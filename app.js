'use strict';

// ---------------- Constants ----------------
const STAR_KEY = 'aamas2026:starred';
const DATA_URL = 'program-merged.json';

// Map full day strings -> short tab labels and date keys.
const DAY_LABELS = {
  'Monday, 25 May':    { short: 'Mon 25', date: '2026-05-25' },
  'Tuesday, 26 May':   { short: 'Tue 26', date: '2026-05-26' },
  'Wednesday, 27 May': { short: 'Wed 27', date: '2026-05-27' },
  'Thursday, 28 May':  { short: 'Thu 28', date: '2026-05-28' },
  'Friday, 29 May':    { short: 'Fri 29', date: '2026-05-29' },
};

// ---------------- State ----------------
const state = {
  data: [],            // augmented PROGRAM_DATA with stable IDs
  starred: new Set(),  // string IDs
  activeDay: 'All',    // 'All' or one of the day strings
  search: '',
  starredOnly: false,
  hidePast: false,
};

// ---------------- DOM helpers ----------------
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// ---------------- Time / past-event helpers ----------------
// "Hide past" uses the user's local clock. For attendees that's Cyprus time
// (matching the schedule); remote viewers in other zones get a best-effort
// approximation — same compromise as the existing "today" tab highlighting.
function getNowContext() {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { today, nowMin: d.getHours() * 60 + d.getMinutes() };
}

function parseEndMinutes(s) {
  if (!s) return null;
  const matches = [...String(s).matchAll(/(\d{1,2})[:h.](\d{2})/g)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  const h = parseInt(last[1], 10), m = parseInt(last[2], 10);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

function getDayDate(day) {
  return (DAY_LABELS[day.day] || {}).date || null;
}

function isDayPast(day, ctx) {
  const dd = getDayDate(day);
  return dd ? dd < ctx.today : false;
}

function isSlotPast(slot, dayDate, ctx) {
  if (!dayDate) return false;
  if (dayDate < ctx.today) return true;
  if (dayDate > ctx.today) return false;
  const end = parseEndMinutes(slot.slot);
  return end != null && end <= ctx.nowMin;
}

function isPaperPast(p, dayDate, ctx) {
  if (!dayDate) return false;
  if (dayDate < ctx.today) return true;
  if (dayDate > ctx.today) return false;
  const end = parseEndMinutes(p.time);
  return end != null && end <= ctx.nowMin;
}

// Hide a session whose timed papers are all past, so a finished all-day
// workshop (whose slot has no parseable time) doesn't render an empty card.
function isSessionPast(s, dayDate, ctx) {
  if (!dayDate) return false;
  if (dayDate < ctx.today) return true;
  if (dayDate > ctx.today) return false;
  const papers = s.papers || [];
  if (!papers.length) return false;
  let anyTimed = false, anyFuture = false;
  for (const p of papers) {
    const end = parseEndMinutes(p.time);
    if (end == null) { anyFuture = true; continue; } // untimed → assume future
    anyTimed = true;
    if (end > ctx.nowMin) anyFuture = true;
  }
  return anyTimed && !anyFuture;
}

// ---------------- Load + ID assignment ----------------
async function loadData() {
  const res = await fetch(DATA_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} loading ${DATA_URL}`);
  const data = await res.json();
  // Assign deterministic IDs to every session and paper
  data.forEach((day, di) => {
    day.slots.forEach((slot, sli) => {
      slot.sessions.forEach((sess, si) => {
        sess._id = `s::${di}::${sli}::${si}`;
        (sess.papers || []).forEach((p, pi) => {
          p._id = `p::${sess._id}::${pi}`;
        });
      });
    });
  });
  return data;
}

// ---------------- Star persistence ----------------
function loadStars() {
  try {
    const raw = localStorage.getItem(STAR_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveStars() {
  localStorage.setItem(STAR_KEY, JSON.stringify([...state.starred]));
}

function toggleStar(id) {
  if (state.starred.has(id)) state.starred.delete(id);
  else state.starred.add(id);
  saveStars();
}

// ---------------- Matching / filtering ----------------
function paperMatchesSearch(p, q) {
  if (!q) return true;
  const blob = [p.title, p.authors, p.session, p.track, p.area].join(' ').toLowerCase();
  return blob.includes(q);
}

function sessionMatchesSearch(s, q) {
  if (!q) return true;
  const blob = [s.display, s.code, s.track, s.chair, s.description].join(' ').toLowerCase();
  if (blob.includes(q)) return true;
  return (s.papers || []).some((p) => paperMatchesSearch(p, q));
}

function isSessionVisible(s) {
  const q = state.search;
  if (!sessionMatchesSearch(s, q)) return false;
  if (state.starredOnly) {
    const sessionStarred = state.starred.has(s._id);
    const anyPaperStarred = (s.papers || []).some(
      (p) => !p.is_heading && state.starred.has(p._id),
    );
    if (!sessionStarred && !anyPaperStarred) return false;
  }
  return true;
}

// ---------------- Rendering ----------------
function badgeHTML(text, cls) {
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

function starButton(id, isHeading = false) {
  if (isHeading) return '';
  const on = state.starred.has(id);
  return `<button class="star ${on ? 'on' : ''}" data-star-id="${esc(id)}" aria-label="${on ? 'Unstar' : 'Star'}">${on ? '★' : '☆'}</button>`;
}

function paperHTML(p) {
  if (p.is_heading) {
    return `<div class="paper heading">
      <div class="paper-time">${esc(p.time || '')}</div>
      <div class="paper-body">
        <div class="paper-title">${esc(p.title)}</div>
        ${p.authors ? `<div class="paper-authors">${esc(p.authors)}</div>` : ''}
      </div>
    </div>`;
  }
  const starred = state.starred.has(p._id);
  return `<div class="paper ${starred ? 'starred' : ''}">
    <div class="paper-time">${esc(p.time || '')}</div>
    <div class="paper-body">
      <div class="paper-title">${p.paper_id ? `<span class="paper-id">#${esc(p.paper_id)}</span>` : ''}${esc(p.title)}</div>
      ${p.authors ? `<div class="paper-authors">${esc(p.authors)}</div>` : ''}
    </div>
    ${starButton(p._id)}
  </div>`;
}

function sessionHTML(s, dayDate, ctx) {
  const starred = state.starred.has(s._id);
  const badges = [];
  if (s.track) badges.push(badgeHTML(s.track, 'track'));
  if (s.room) badges.push(badgeHTML(`Room: ${s.room}`, 'room'));
  if (s.code && s.code !== s.track) badges.push(badgeHTML(s.code, ''));

  const chair = s.chair ? `<div class="session-chair">Chair: ${esc(s.chair)}</div>` : '';
  const desc = s.description ? `<div class="session-desc">${esc(s.description)}</div>` : '';
  const notice = s.schedule_status
    ? `<div class="session-notice">Schedule ${esc(s.schedule_status)}.</div>`
    : '';
  const link = s.link
    ? `<div class="session-link"><a href="${esc(s.link)}" target="_blank" rel="noopener">↗ workshop site</a></div>`
    : '';

  const visiblePapers = (s.papers || [])
    .filter((p) => p.is_heading || paperMatchesSearch(p, state.search))
    .filter((p) => !ctx || !isPaperPast(p, dayDate, ctx));
  const papersHTML = visiblePapers.map(paperHTML).join('');

  // Collapsible body. Default-collapsed for very-long sessions (DC). When
  // "Starred only" is active we force-expand so users see what they kept.
  const totalCount = (s.papers || []).length;
  const itemNoun = totalCount === 1 ? 'item' : 'items';
  const isDC = s.track === 'Doctoral Consortium';
  const forceOpen = state.starredOnly || !!state.search;
  const openAttr = (forceOpen || !isDC) ? ' open' : '';

  const papersBlock = papersHTML
    ? `<details class="session-body"${openAttr}>
        <summary class="session-summary"><span class="caret">▸</span>${esc(totalCount)} ${itemNoun}</summary>
        <div class="papers">${papersHTML}</div>
      </details>`
    : '';

  return `<article class="session ${starred ? 'starred' : ''}">
    <div class="session-head">
      <div class="session-title">${esc(s.display || s.code || '(untitled session)')}</div>
      ${starButton(s._id)}
    </div>
    <div class="session-meta">${badges.join('')}</div>
    ${chair}
    ${desc}
    ${notice}
    ${link}
    ${papersBlock}
  </article>`;
}

function dayHTML(day) {
  const dayDate = getDayDate(day);
  const ctx = state.hidePast ? getNowContext() : null;
  const slots = ctx ? day.slots.filter((s) => !isSlotPast(s, dayDate, ctx)) : day.slots;
  let visibleSessions = 0;
  const slotsHTML = slots.map((slot) => {
    let sessions = slot.sessions.filter(isSessionVisible);
    if (ctx) sessions = sessions.filter((s) => !isSessionPast(s, dayDate, ctx));
    visibleSessions += sessions.length;
    if (!sessions.length) return '';
    return `<section class="slot">
      <h3 class="slot-heading">${esc(slot.slot)}</h3>
      <div class="session-grid">${sessions.map((s) => sessionHTML(s, dayDate, ctx)).join('')}</div>
    </section>`;
  }).join('');

  if (!visibleSessions) return { html: '', count: 0 };
  return {
    html: `<section class="day">
      <h2 class="day-heading">${esc(day.day)}</h2>
      ${slotsHTML}
    </section>`,
    count: visibleSessions,
  };
}

function renderTabs() {
  const today = new Date().toISOString().slice(0, 10);
  const tabs = [{ key: 'All', label: 'All days', date: null }];
  state.data.forEach((d) => {
    const meta = DAY_LABELS[d.day] || { short: d.day, date: null };
    tabs.push({ key: d.day, label: meta.short, date: meta.date });
  });
  $('#dayTabs').innerHTML = tabs.map((t) => {
    const isActive = t.key === state.activeDay;
    const isToday = t.date && t.date === today;
    return `<button class="day-tab ${isActive ? 'active' : ''} ${isToday ? 'today' : ''}" data-day="${esc(t.key)}">${esc(t.label)}</button>`;
  }).join('');
}

function render() {
  let days = state.activeDay === 'All'
    ? state.data
    : state.data.filter((d) => d.day === state.activeDay);
  if (state.hidePast) {
    const ctx = getNowContext();
    days = days.filter((d) => !isDayPast(d, ctx));
  }
  const parts = days.map(dayHTML);
  const html = parts.map((p) => p.html).join('');
  const total = parts.reduce((acc, p) => acc + p.count, 0);
  const root = $('#program');
  if (!html) {
    root.innerHTML = `<div class="empty">No sessions match the current filters.</div>`;
  } else {
    root.innerHTML = html;
  }
  $('#visibleCount').textContent = String(total);
  $('#starCount').textContent = String(state.starred.size);
  // Update active tab classes
  document.querySelectorAll('.day-tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.day === state.activeDay);
  });
}

// ---------------- Event wiring ----------------
function wireEvents() {
  // Day tabs (event delegation)
  $('#dayTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.day-tab');
    if (!btn) return;
    state.activeDay = btn.dataset.day;
    render();
    window.scrollTo({ top: 0, behavior: 'instant' });
  });

  // Search box
  let searchTimer;
  $('#searchBox').addEventListener('input', (e) => {
    const value = e.target.value.trim().toLowerCase();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = value;
      render();
    }, 80);
  });

  // Starred-only toggle
  $('#starredOnly').addEventListener('change', (e) => {
    state.starredOnly = e.target.checked;
    render();
  });

  // Hide-past toggle
  $('#hidePast').addEventListener('change', (e) => {
    state.hidePast = e.target.checked;
    render();
  });

  // Star button clicks (event delegation on the document)
  $('#program').addEventListener('click', (e) => {
    const btn = e.target.closest('.star');
    if (!btn) return;
    const id = btn.dataset.starId;
    if (!id) return;
    toggleStar(id);
    // Update the button immediately, then re-render counters / starred filter
    const on = state.starred.has(id);
    btn.classList.toggle('on', on);
    btn.textContent = on ? '★' : '☆';
    btn.setAttribute('aria-label', on ? 'Unstar' : 'Star');
    // Also toggle the .starred class on the enclosing card/row
    const card = btn.closest('.session, .paper');
    if (card) card.classList.toggle('starred', on);
    // Update counts; only re-render fully if starred-only is on
    $('#starCount').textContent = String(state.starred.size);
    if (state.starredOnly) render();
  });
}

// ---------------- Init ----------------
async function main() {
  try {
    state.starred = loadStars();
    state.data = await loadData();

    // Default day: today if within range, else 'All'
    const today = new Date().toISOString().slice(0, 10);
    const matchToday = state.data.find((d) => (DAY_LABELS[d.day] || {}).date === today);
    if (matchToday) state.activeDay = matchToday.day;

    $('#loadingMsg').hidden = true;
    renderTabs();
    render();
    wireEvents();
  } catch (err) {
    $('#loadingMsg').hidden = true;
    const e = $('#errorMsg');
    e.hidden = false;
    e.textContent = `Failed to load schedule: ${err.message}. If you opened this file directly, try running a local server (e.g. \`python3 -m http.server\`) and visiting http://localhost:8000/.`;
    console.error(err);
  }
}

main();
