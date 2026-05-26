# Show aggregate ★ / 👎 counts under each event button

## Context

Today every attendee marks events as starred or boring in isolation: the
buttons reflect the current user's own state only. The goal is to surface
social signal — a small "how many people marked this" number under each
button (e.g. "12 others starred this keynote").

Design choices already settled with the requester:

- **Count semantics**: total people including the viewer (not "others
  only"). Simpler queries; the viewer can mentally subtract their own.
- **Zero display**: hide the number when the count is 0 (less visual
  noise).
- **Visibility**: counts are shown to signed-in users only. Signed-out
  users see the buttons but no number. (Counts aren't private, but
  treating them as a sign-in benefit is consistent with how cloud sync
  already works.)
- **Refresh**: fetched once on page load (after sign-in) and bumped
  optimistically when the viewer toggles their own mark. No realtime
  channel — other users' new marks show up on the next reload.

## Backend — new Supabase function

The `user_state` table already exists with `starred text[]` / `boring
text[]` columns and per-user RLS (`auth.uid() = user_id`). That RLS
blocks aggregation from the client, so a `security definer` SQL function
is needed to expose only aggregate counts. The function returns counts
grouped by `item_id` — no per-user data leaks out — and is granted to
`authenticated` only.

```sql
create or replace function public.item_mark_counts()
returns table (item_id text, stars bigint, borings bigint)
language sql
security definer
stable
set search_path = public
as $$
  select
    item_id,
    count(*) filter (where kind = 'star')   as stars,
    count(*) filter (where kind = 'boring') as borings
  from (
    select unnest(starred) as item_id, 'star'::text   as kind from public.user_state
    union all
    select unnest(boring)  as item_id, 'boring'::text as kind from public.user_state
  ) t
  group by item_id;
$$;

revoke all on function public.item_mark_counts() from public, anon;
grant execute on function public.item_mark_counts() to authenticated;
```

This needs to be applied via the Supabase SQL editor (or the Supabase
MCP migration tool, as the original schema was). Add a new **"Stage E —
aggregate counts function"** section to `supabase-setup.md` documenting
the SQL above, in the same style as the existing stages.

## Frontend — `app.js`

### State

Add one new field next to `state.starred` / `state.boring`:

```js
markCounts: new Map(),  // item_id -> { stars: number, borings: number }
```

### Fetch

New function near the existing cloud-sync helpers:

```js
async function fetchMarkCounts() {
  if (!state.uid) { state.markCounts = new Map(); return; }
  const { data, error } = await supabase.rpc('item_mark_counts');
  if (error) { console.warn('item_mark_counts failed:', error); return; }
  state.markCounts = new Map(
    (data || []).map((r) => [r.item_id, { stars: Number(r.stars), borings: Number(r.borings) }]),
  );
}
```

Call sites:

- At the end of `handleAuthChange` after the user_state merge — `await
  fetchMarkCounts();` before the final `render()` (which already runs
  there and will pick up the new counts).
- On sign-out (the `!user` branch in `handleAuthChange`) — clear
  `state.markCounts` and re-render so counts disappear from the UI.

### Render — `starButton` / `boringButton`

Restructure each button so the glyph and count are siblings inside it.
This keeps every existing call site (`session-head`, `paper`, `tt-card`,
`tt-group-item`, `tt-col-header`) unchanged.

```js
function starButton(id, isHeading = false) {
  if (isHeading) return '';
  const on = state.starred.has(id);
  const cnt = state.uid ? (state.markCounts.get(id)?.stars || 0) : 0;
  const countHTML = cnt > 0 ? `<span class="mark-count">${cnt}</span>` : '';
  return `<button class="star ${on ? 'on' : ''}" data-star-id="${esc(id)}" aria-label="${on ? 'Unstar' : 'Star'}">`
       + `<span class="mark-glyph">${on ? '★' : '☆'}</span>${countHTML}</button>`;
}
```

Mirror change for `boringButton` (count read is `.borings`, glyph stays
`👎`).

### Optimistic update — toggle handlers

In `wireEvents()`, the star click handler currently does
`starBtn.textContent = on ? '★' : '☆'`, which would wipe the count span.
Replace those lines with a small refresh helper that re-renders the
button's outer HTML using the same template, AFTER bumping the local
count:

```js
function bumpCount(id, kind, delta) {
  const cur = state.markCounts.get(id) || { stars: 0, borings: 0 };
  cur[kind] = Math.max(0, cur[kind] + delta);
  state.markCounts.set(id, cur);
}
```

In the star click handler, after `toggleStar(id)`:

```js
bumpCount(id, 'stars', on ? 1 : -1);
starBtn.outerHTML = starButton(id);
```

`outerHTML` replaces the node so the existing `classList.toggle` /
`textContent` / `setAttribute` lines can be dropped. Event delegation on
`#program` keeps clicks working after the swap.

Equivalent change in the boring branch (`bumpCount(id, 'borings', ...)`).

Signed-out users: `state.uid` is null → `cnt` is 0 → no `.mark-count`
span is emitted. Nothing else needs to gate.

## Frontend — `app.css`

Make the buttons stack glyph above count. The existing `.star` /
`.boring` rules need a small addition; absolutely-positioned timetable
variants need a tweak so the count doesn't get clipped.

Add near the existing `.star` block:

```css
.star, .boring {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  line-height: 1;
}

.mark-count {
  font-size: 9px;
  font-weight: 500;
  color: var(--text-faint);
  margin-top: 1px;
}

.star.on .mark-count { color: var(--accent); }
.boring.on .mark-count { color: var(--text); }
```

Timetable buttons (`.tt-card .star`, `.tt-group-item .star`, plus the
boring counterparts) are `position: absolute; top: 2px;` inside small
cards. The count adds ~10px of height below the glyph; that's within the
card's reserved right-margin column and should not visually collide with
the body text. If it does collide during verification (esp. inside
`.tt-group-item`), the fallback is to hide counts in those contexts:

```css
.tt-card .mark-count,
.tt-group-item .mark-count { display: none; }
```

This is listed as a contingency, not a default — verify first.

## Files touched

- `supabase-setup.md` — new Stage E section with the SQL above
- `app.js` — `state` init (`markCounts`), new `fetchMarkCounts`,
  `bumpCount`, modified `starButton` / `boringButton`, modified click
  handlers in `wireEvents`, two new call sites in `handleAuthChange`
- `app.css` — column-flex on `.star` / `.boring`, new `.mark-count`
  rule, optional contingency for timetable contexts

No changes to `program.json`, `program-merged.json`, or the Python
pipeline.

## Verification

1. Apply the SQL in the Supabase dashboard SQL editor; confirm the
   function appears under Database → Functions and that the `anon` role
   has no execute privilege.
2. `python3 -m http.server` → http://localhost:8000/ in two different
   browsers (or one incognito).
3. Sign in with Google in both. In browser A, star one main-track paper
   and mark another as 👎. Reload browser B → the same two items show
   "1" under the relevant button.
4. In browser B, star the same paper as A → the count under that star
   becomes "2" immediately (optimistic), and persists on reload.
5. Unstar in A → reload B → count goes back to "1".
6. Sign out in B → counts disappear from every button (zero-count =
   nothing rendered).
7. Visit signed-out — same: no counts anywhere. Star button still works
   as a localStorage-only mark, just without a count.
8. Eyeball the timetable view (Workshops slot, "Parallel workshops"
   toggle on) on Monday/Friday to confirm counts don't visually collide
   with card body text. Apply the contingency CSS above only if needed.

## Open questions / room for follow-up

- **Privacy ceiling**: counts of 1 trivially identify the one person who
  marked it (if the viewer also marked it, the count is 2 — same logic).
  Acceptable for a conference-program use case but worth flagging in case
  the requirement changes.
- **Realtime**: if "counts feel stale" comes up later, switching to a
  Supabase Realtime subscription on `user_state` is a small follow-up —
  the count map structure already supports incremental updates.
- **Listing markers**: a natural next step is "show who starred this" on
  hover/tap. Would need a separate RPC and a presence policy (opt-in?).
