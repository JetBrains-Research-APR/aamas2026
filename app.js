'use strict';

// ---------------- Constants ----------------
const STAR_KEY = 'aamas2026:starred';
const BORING_KEY = 'aamas2026:boring';
const PREFS_KEY = 'aamas2026:prefs';
const PREF_FIELDS = ['starredOnly', 'hidePast', 'nextWindow', 'timetable', 'hideBoring'];
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
  boring: new Set(),   // string IDs marked "not interested"
  activeDay: 'All',    // 'All' or one of the day strings
  search: '',
  starredOnly: false,
  hidePast: false,
  nextWindow: false,
  timetable: false,
  hideBoring: false,
};

const NEXT_WINDOW_MIN = 120;

// ---------------- DOM helpers ----------------
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// ---------------- Time-based filters ("Hide past" + "Next 2 hours") ----------------
// Both filters use the user's local clock. For attendees that's Cyprus time
// (matching the schedule); remote viewers in other zones get a best-effort
// approximation — same compromise as the existing "today" tab highlighting.
function getNowContext() {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { today, nowMin: d.getHours() * 60 + d.getMinutes() };
}

function getDayDate(day) {
  return (DAY_LABELS[day.day] || {}).date || null;
}

// Pull a {start,end} minute range out of a string like "Morning · 10:45–12:30"
// or "8:45-9:15". For single-time entries ("8:45"), assume a 30-minute event.
function parseTimeRange(s) {
  if (!s) return null;
  const ms = [...String(s).matchAll(/(\d{1,2})[:h.](\d{2})/g)];
  if (!ms.length) return null;
  const toMin = (m) => {
    const h = parseInt(m[1], 10), mn = parseInt(m[2], 10);
    return (h > 23 || mn > 59) ? null : h * 60 + mn;
  };
  const start = toMin(ms[0]);
  if (start == null) return null;
  let end = ms.length >= 2 ? toMin(ms[ms.length - 1]) : null;
  if (end == null || end <= start) end = start + 30;
  return { start, end };
}

// Bundle the active time filters into one object (or null if neither is on).
// "Next 2 hours" is strictly stricter than "Hide past", so when both are on
// the window logic takes over and hidePast becomes redundant.
function buildTimeFilter() {
  if (!state.hidePast && !state.nextWindow) return null;
  return {
    now: getNowContext(),
    hidePast: state.hidePast,
    windowMin: state.nextWindow ? NEXT_WINDOW_MIN : null,
  };
}

// Core predicate: does an event on dayDate occupying [startMin, endMin] pass
// the active time filter? Null start/end mean "unknown time" → keep visible
// (we don't want untimed entries hidden by accident).
function rangePasses(dayDate, startMin, endMin, tf) {
  if (!tf) return true;
  if (!dayDate) return true;
  const t = tf.now;
  if (dayDate < t.today) return false;
  if (tf.windowMin != null) {
    if (dayDate > t.today) return false;
    if (startMin == null || endMin == null) return true;
    return startMin < t.nowMin + tf.windowMin && endMin > t.nowMin;
  }
  // hidePast only
  if (dayDate > t.today) return true;
  return endMin == null || endMin > t.nowMin;
}

function dayPasses(day, tf) {
  if (!tf) return true;
  const dd = getDayDate(day);
  if (!dd) return true;
  if (dd < tf.now.today) return false;
  if (tf.windowMin != null && dd > tf.now.today) return false;
  return true;
}

function slotPasses(slot, dayDate, tf) {
  const r = parseTimeRange(slot.slot);
  return rangePasses(dayDate, r?.start ?? null, r?.end ?? null, tf);
}

function paperPasses(p, dayDate, slotRange, tf) {
  if (!tf) return true;
  const r = parseTimeRange(p.time);
  if (r) return rangePasses(dayDate, r.start, r.end, tf);
  // Untimed paper: inherit the enclosing slot's range when available, so that
  // a main-track session whose papers have no individual times still survives
  // when its "Morning · 10:45–12:30" slot is currently active.
  if (slotRange) return rangePasses(dayDate, slotRange.start, slotRange.end, tf);
  return rangePasses(dayDate, null, null, tf);
}

// A session passes if at least one of its timed papers passes. If no paper is
// timed, fall back to the slot range. This hides a finished all-day workshop
// (slot title has no time, all timed papers past) and keeps a workshop where
// only the next 2 hours' worth of talks remain.
function sessionPasses(s, dayDate, slotRange, tf) {
  if (!tf) return true;
  if (!dayDate || dayDate < tf.now.today) return rangePasses(dayDate, null, null, tf);
  const papers = s.papers || [];
  let anyTimed = false;
  for (const p of papers) {
    const r = parseTimeRange(p.time);
    if (!r) continue;
    anyTimed = true;
    if (rangePasses(dayDate, r.start, r.end, tf)) return true;
  }
  if (anyTimed) return false;
  if (slotRange) return rangePasses(dayDate, slotRange.start, slotRange.end, tf);
  return rangePasses(dayDate, null, null, tf);
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

// ---------------- "Boring" mark persistence ----------------
function loadBoring() {
  try {
    const raw = localStorage.getItem(BORING_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveBoring() {
  localStorage.setItem(BORING_KEY, JSON.stringify([...state.boring]));
}

function toggleBoring(id) {
  if (state.boring.has(id)) state.boring.delete(id);
  else state.boring.add(id);
  saveBoring();
}

// ---------------- Toggle persistence ----------------
function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    for (const k of PREF_FIELDS) {
      if (typeof p?.[k] === 'boolean') state[k] = p[k];
    }
  } catch {}
}

function savePrefs() {
  const p = {};
  for (const k of PREF_FIELDS) p[k] = state[k];
  localStorage.setItem(PREFS_KEY, JSON.stringify(p));
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
  if (state.hideBoring && state.boring.has(s._id)) return false;
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

function boringButton(id, isHeading = false) {
  if (isHeading) return '';
  const on = state.boring.has(id);
  return `<button class="boring ${on ? 'on' : ''}" data-boring-id="${esc(id)}" aria-label="${on ? 'Unmark boring' : 'Mark boring'}" title="${on ? 'Unmark as boring' : 'Mark as boring (hide when filter is on)'}">👎</button>`;
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
    ${boringButton(p._id)}
  </div>`;
}

function sessionHTML(s, dayDate, slotRange, tf) {
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
  // The title itself links out (see `titleHTML` below), so no separate row.
  const titleText = esc(s.display || s.code || '(untitled session)');
  const titleHTML = s.link
    ? `<a class="session-title-link" href="${esc(s.link)}" target="_blank" rel="noopener">${titleText} <span class="ext-icon" aria-hidden="true">↗</span></a>`
    : titleText;

  const visiblePapers = (s.papers || [])
    .filter((p) => p.is_heading || paperMatchesSearch(p, state.search))
    .filter((p) => paperPasses(p, dayDate, slotRange, tf))
    .filter((p) => p.is_heading || !state.hideBoring || !state.boring.has(p._id));
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
      <div class="session-title">${titleHTML}</div>
      ${starButton(s._id)}
      ${boringButton(s._id)}
    </div>
    <div class="session-meta">${badges.join('')}</div>
    ${chair}
    ${desc}
    ${notice}
    ${papersBlock}
  </article>`;
}

// Time-banded columns for the workshops slot. Each surviving workshop becomes
// a column; the day is divided into TT_BAND_MIN-minute bands and papers are
// grouped into the band their start time falls in. Each row's height grows to
// fit the densest column in that band — so cards stay readable even when many
// short talks land in the same window. Strict pixel-perfect time alignment is
// traded away for legibility; columns still align at band boundaries, and the
// card itself shows the precise start/end time. Workshops with zero usable
// papers (e.g. "schedule not yet published") drop out but remain in card view.
const TT_BAND_MIN = 30;

function timetableHTML(sessions, dayDate, slotRange, tf) {
  const cols = [];
  for (const s of sessions) {
    const items = [];
    for (const p of s.papers || []) {
      if (!(p.is_heading || paperMatchesSearch(p, state.search))) continue;
      if (!paperPasses(p, dayDate, slotRange, tf)) continue;
      if (!p.is_heading && state.hideBoring && state.boring.has(p._id)) continue;
      const r = parseTimeRange(p.time);
      if (!r) continue;
      items.push({ p, range: r });
    }
    if (items.length) cols.push({ session: s, items });
  }
  if (!cols.length) {
    return '<div class="tt-empty">No timed workshop entries match the current filters.</div>';
  }

  let lo = Infinity, hi = -Infinity;
  for (const c of cols) for (const { range } of c.items) {
    if (range.start < lo) lo = range.start;
    if (range.end > hi) hi = range.end;
  }
  lo = Math.floor(lo / TT_BAND_MIN) * TT_BAND_MIN;
  hi = Math.ceil(hi / TT_BAND_MIN) * TT_BAND_MIN;
  const bandCount = (hi - lo) / TT_BAND_MIN;
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  // For each column, bucket its items by band index of the start time.
  const buckets = cols.map(() => Array.from({ length: bandCount }, () => []));
  cols.forEach((c, ci) => {
    for (const item of c.items) {
      const bi = Math.min(bandCount - 1, Math.max(0, Math.floor((item.range.start - lo) / TT_BAND_MIN)));
      buckets[ci][bi].push(item);
    }
    buckets[ci].forEach((arr) => arr.sort((a, b) => a.range.start - b.range.start));
  });

  const headers = cols.map((c) => {
    const s = c.session;
    const starred = state.starred.has(s._id);
    const room = s.room ? `<div class="tt-col-room">${esc(s.room)}</div>` : '';
    const nameText = esc(s.display || s.code || '');
    const nameHTML = s.link
      ? `<a class="tt-col-name" href="${esc(s.link)}" target="_blank" rel="noopener">${nameText} <span class="ext-icon" aria-hidden="true">↗</span></a>`
      : `<span class="tt-col-name">${nameText}</span>`;
    return `<div class="tt-col-header${starred ? ' starred' : ''}">
      <div class="tt-col-title">
        ${nameHTML}
        ${starButton(s._id)}
        ${boringButton(s._id)}
      </div>
      ${room}
    </div>`;
  }).join('');

  // Within a band cell, group items that share an identical parsed time range.
  // This collapses things like "Poster Session" + 8 posters all marked 14:30–
  // 15:30 into one heading card with a <details> list, so a dense block doesn't
  // blow the row's height out.
  const groupItems = (items) => {
    const map = new Map();
    for (const it of items) {
      const key = `${it.range.start}-${it.range.end}`;
      let g = map.get(key);
      if (!g) { g = { heading: null, papers: [], time: it.p.time, range: it.range }; map.set(key, g); }
      if (it.p.is_heading && !g.heading) g.heading = it.p;
      else g.papers.push(it.p);
    }
    return [...map.values()].sort((a, b) => a.range.start - b.range.start);
  };

  const paperCard = (p) => {
    const cls = state.starred.has(p._id) ? 'tt-card starred' : 'tt-card';
    return `<div class="${cls}">
      <div class="tt-card-time">${esc(p.time || '')}</div>
      <div class="tt-card-title">${esc(p.title)}</div>
      ${p.authors ? `<div class="tt-card-authors">${esc(p.authors)}</div>` : ''}
      ${starButton(p._id)}
      ${boringButton(p._id)}
    </div>`;
  };

  const headingCard = (h) => `<div class="tt-card heading">
    <div class="tt-card-time">${esc(h.time || '')}</div>
    <div class="tt-card-title">${esc(h.title)}</div>
  </div>`;

  const groupCard = (g) => {
    const time = g.heading?.time || g.time || '';
    const title = g.heading?.title || `${g.papers.length} talks at ${time}`;
    const items = g.papers.map((p) => `
      <div class="tt-group-item${state.starred.has(p._id) ? ' starred' : ''}">
        <div class="tt-group-item-title">${esc(p.title)}</div>
        ${p.authors ? `<div class="tt-group-item-authors">${esc(p.authors)}</div>` : ''}
        ${starButton(p._id)}
        ${boringButton(p._id)}
      </div>`).join('');
    const noun = g.papers.length === 1 ? 'item' : 'items';
    return `<div class="tt-card heading">
      <div class="tt-card-time">${esc(time)}</div>
      <div class="tt-card-title">${esc(title)}</div>
      <details class="tt-group">
        <summary class="tt-group-summary">${g.papers.length} ${noun}</summary>
        <div class="tt-group-list">${items}</div>
      </details>
    </div>`;
  };

  const groupHTML = (g) => {
    if (!g.heading && g.papers.length === 1) return paperCard(g.papers[0]);
    if (g.heading && g.papers.length === 0) return headingCard(g.heading);
    return groupCard(g);
  };

  let rows = '';
  for (let bi = 0; bi < bandCount; bi++) {
    rows += `<div class="tt-band-label">${fmt(lo + bi * TT_BAND_MIN)}</div>`;
    for (let ci = 0; ci < cols.length; ci++) {
      const groups = groupItems(buckets[ci][bi]);
      rows += `<div class="tt-cell">${groups.map(groupHTML).join('')}</div>`;
    }
  }

  return `<div class="timetable" style="--col-count: ${cols.length}">
    <div class="tt-grid">
      <div class="tt-rail-header"></div>
      ${headers}
      ${rows}
    </div>
  </div>`;
}

function dayHTML(day, tf) {
  const dayDate = getDayDate(day);
  const slots = tf ? day.slots.filter((s) => slotPasses(s, dayDate, tf)) : day.slots;
  let visibleSessions = 0;
  const slotsHTML = slots.map((slot) => {
    const slotRange = parseTimeRange(slot.slot);
    let sessions = slot.sessions.filter(isSessionVisible);
    if (tf) sessions = sessions.filter((s) => sessionPasses(s, dayDate, slotRange, tf));
    visibleSessions += sessions.length;
    if (!sessions.length) return '';
    const isWorkshopsSlot = slot.slot === 'Workshops';
    const body = state.timetable && isWorkshopsSlot
      ? timetableHTML(sessions, dayDate, slotRange, tf)
      : `<div class="session-grid">${sessions.map((s) => sessionHTML(s, dayDate, slotRange, tf)).join('')}</div>`;
    return `<section class="slot">
      <h3 class="slot-heading">${esc(slot.slot)}</h3>
      ${body}
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
  const tf = buildTimeFilter();
  let days = state.activeDay === 'All'
    ? state.data
    : state.data.filter((d) => d.day === state.activeDay);
  if (tf) days = days.filter((d) => dayPasses(d, tf));
  const parts = days.map((d) => dayHTML(d, tf));
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

  // Toggles: bind each checkbox to its state field and sync its initial
  // `checked` from state (so loadPrefs values are reflected in the UI).
  const bindToggle = (id, key) => {
    const el = $('#' + id);
    el.checked = state[key];
    el.addEventListener('change', (e) => {
      state[key] = e.target.checked;
      savePrefs();
      render();
    });
  };
  bindToggle('starredOnly', 'starredOnly');
  bindToggle('hidePast', 'hidePast');
  bindToggle('nextWindow', 'nextWindow');
  bindToggle('timetable', 'timetable');
  bindToggle('hideBoring', 'hideBoring');

  // Star + boring button clicks (event delegation on the program root).
  $('#program').addEventListener('click', (e) => {
    const starBtn = e.target.closest('.star');
    if (starBtn) {
      const id = starBtn.dataset.starId;
      if (!id) return;
      toggleStar(id);
      const on = state.starred.has(id);
      starBtn.classList.toggle('on', on);
      starBtn.textContent = on ? '★' : '☆';
      starBtn.setAttribute('aria-label', on ? 'Unstar' : 'Star');
      const card = starBtn.closest('.session, .paper, .tt-card, .tt-col-header, .tt-group-item');
      if (card) card.classList.toggle('starred', on);
      $('#starCount').textContent = String(state.starred.size);
      if (state.starredOnly) render();
      return;
    }
    const boringBtn = e.target.closest('.boring');
    if (boringBtn) {
      const id = boringBtn.dataset.boringId;
      if (!id) return;
      toggleBoring(id);
      const on = state.boring.has(id);
      boringBtn.classList.toggle('on', on);
      boringBtn.setAttribute('aria-label', on ? 'Unmark boring' : 'Mark boring');
      // When the hide filter is active, the just-marked item should disappear
      // from view; the cheapest correct option is a full re-render.
      if (state.hideBoring) render();
    }
  });
}

// ---------------- Init ----------------
async function main() {
  try {
    state.starred = loadStars();
    state.boring = loadBoring();
    loadPrefs();
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
