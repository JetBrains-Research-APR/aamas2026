# Supabase setup

Step-by-step notes for wiring this site to Supabase Auth (Google sign-in) +
the `user_state` table so each attendee's stars and "boring" marks follow
them across devices.

The schema migration and the `user_state` row-level security policies are
already applied (via the supabase MCP migration tool — see
`/users/{user_id}` row layout below). What remains is the OAuth client
setup, which is only reachable from the Supabase and Google Cloud web
consoles.

Open both consoles in side-by-side tabs before starting — Stage B and
Stage C bounce between them.

## Stage A — Rotate the JWT Secret

Mechanical, no after-effects on the app. Do this any time the secret has
been pasted somewhere it shouldn't have been (chat logs, screenshots).

1. https://supabase.com/dashboard → the project (`aamas2026`).
2. Left sidebar → **Project Settings** (gear icon at the bottom).
3. **API** in the settings submenu.
4. Scroll down to the **JWT Settings** card → **Generate a new secret**
   (or "Rotate"). Confirm.
5. Wait ~20 seconds while it propagates.

This invalidates any existing JWTs. Since nothing in the app uses the JWT
secret directly, the only effect is that any user sessions are forcibly
re-issued — fine if no one has signed in yet.

## Stage B — Create the Google OAuth client

### B.1. Pick / create a Google Cloud project

1. https://console.cloud.google.com.
2. Top bar → project picker → **New Project**.
3. Project name: `aamas2026-auth` (or any readable name). Location: "No
   organization" is fine. **Create**.
4. After ~10 seconds, switch to the new project via the project picker.
   The top bar should display `aamas2026-auth`.

### B.2. Configure the OAuth consent screen

1. Burger menu (☰) → **APIs & Services** → **OAuth consent screen**.
2. **User Type**: **External** → **Create**.
3. **App information**:
   - App name: `AAMAS 2026 Schedule`
   - User support email: yours
   - App logo: skip
4. **App domain**: leave blank.
5. **Authorized domains** → **+ Add domain** → `jbr-apr.com`. (Google
   already trusts `github.io`.)
6. **Developer contact information**: your email → **Save and continue**.
7. **Scopes**: skip (defaults `email`, `profile`, `openid` are enough) →
   **Save and continue**.
8. **Test users**: add your Google email plus anyone else who needs to
   sign in while the app is in "Testing" state → **Save and continue**.
9. **Summary** → **Back to Dashboard**.

The app will stay in **Testing** indefinitely — Test users sign in
normally. Publish later from this same page (button **Publish app**) to
allow any Google user.

### B.3. Create the OAuth 2.0 Client ID

1. Burger menu → **APIs & Services** → **Credentials**.
2. **+ Create credentials** → **OAuth client ID**.
3. **Application type**: **Web application**.
4. **Name**: `Supabase auth client`.
5. **Authorized JavaScript origins** → **+ Add URI** for each (no
   trailing slashes):
   - `https://aamas2026.jbr-apr.com`
   - `https://jetbrains-research-apr.github.io`
   - `http://localhost:8000` (optional, for local testing)
6. **Authorized redirect URIs**: leave empty for now — Stage C.3 fills
   this in.
7. **Create**. A modal shows:
   - **Client ID** (ends in `.apps.googleusercontent.com`)
   - **Client secret** (starts with `GOCSPX-…`)

   Copy both. They can be re-retrieved any time by clicking the client
   name in the Credentials list.

## Stage C — Wire the Google client into Supabase

### C.1. Enable the Google provider

1. Supabase dashboard → the project.
2. Left sidebar → **Authentication** (lock icon).
3. Inner sidebar → **Sign In / Providers** (or just "Providers").
4. Click **Google** in the list to expand its card.
5. Toggle **"Enable Sign in with Google"** to ON.

### C.2. Paste credentials and grab the callback URL

1. Paste:
   - **Client IDs**: the Google **Client ID** from B.3
   - **Client Secret**: the Google **Client secret** from B.3
2. Copy the **Callback URL (for OAuth)** shown just below those fields.
   Looks like
   `https://ansxkxeyymseplguydft.supabase.co/auth/v1/callback`.
3. Click **Save** (bottom right of the Google card).

### C.3. Paste the callback URL back into Google

1. Google Cloud Console → **APIs & Services → Credentials**.
2. Click the **Supabase auth client** entry.
3. **Authorized redirect URIs** → **+ Add URI** → paste the Supabase
   callback URL from C.2.
4. **Save**.

## Stage D — Configure the Supabase redirect allowlist

Tells Supabase which URLs it's willing to bounce the user back to after
Google sign-in completes.

1. Supabase → **Authentication** → inner sidebar → **URL Configuration**.
2. **Site URL**: `https://aamas2026.jbr-apr.com`
3. **Redirect URLs** (one per line — the `**` glob covers all paths and
   hash-fragments under that origin):
   ```
   https://aamas2026.jbr-apr.com/**
   https://jetbrains-research-apr.github.io/**
   http://localhost:8000/**
   ```
4. **Save**.

## Stage E — Aggregate counts function

Per-user RLS on `user_state` blocks the client from running a `count(*)`
across rows, which is what we need to display "how many people starred
this" under each event button. The fix is a `security definer` function
that returns only aggregate counts (no per-user data) and is granted to
`authenticated` only — signed-out users still can't call it.

Apply via the Supabase SQL editor (or the supabase MCP migration tool,
the same way the original schema was applied):

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

After applying, verify in **Database → Functions** that the function
exists, and confirm the `anon` role has no execute privilege (the
`revoke` line above takes care of that — the function should only show
`authenticated` in its permissions list).

## Verification

Open an **incognito window** (no leftover sessions) and:

1. Navigate to https://aamas2026.jbr-apr.com (or the github.io URL).
2. Top-right of the title row → gold "Sign in with Google" pill.
3. Click. Google OAuth picker → choose your account → approve.
4. Redirect back to the schedule. Pill replaced with
   `[avatar] [your email] sign out`.
5. Star a paper. In Supabase → **Table Editor** → `user_state` → one row
   with your `user_id`, the paper's ID in the `starred` array.
6. Open a different browser, sign in with the same Google account. After
   a brief flash of the localStorage state, the same star appears.

When something fails, the useful diagnostic is the browser console
(DevTools → Console tab) — Supabase errors show up there with full
context.

## Data shape reference

For anyone touching the SQL or the client persistence layer later:

```sql
create table user_state (
  user_id    uuid primary key references auth.users on delete cascade,
  starred    text[] not null default '{}',
  boring     text[] not null default '{}',
  updated_at timestamptz not null default now()
);

alter table user_state enable row level security;

create policy "users read own"   on user_state for select using  (auth.uid() = user_id);
create policy "users insert own" on user_state for insert with check (auth.uid() = user_id);
create policy "users update own" on user_state for update using  (auth.uid() = user_id)
                                                  with check (auth.uid() = user_id);
```

The client (`app.js`) rewrites the whole row on every toggle —
fire-and-forget — because write volume is too low to bother with
incremental `array_append` RPCs. See `handleAuthChange` in `app.js` for
the merge-on-sign-in semantics (presence-favouring union; no deletions
propagated).
