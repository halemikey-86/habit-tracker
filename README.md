# Quest Tracker

A two-player habit-building app: Spouse A (Coach) sets up phases, checklist
items, setback conditions, and rewards. Spouse B (Player) works through daily
checklists and walks a character across a map, one tic at a time.

## 1. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com) (free tier is fine).
2. Open **SQL Editor → New query**, paste in the contents of
   `supabase/schema.sql`, and run it.
3. At the bottom of that file, edit the two placeholder rows before running
   that block:
   ```sql
   insert into app_users (display_name, password_hash, role) values
     ('SpouseAName', crypt('SpouseAName0101', gen_salt('bf')), 'coach'),
     ('SpouseBName', crypt('SpouseBName0202', gen_salt('bf')), 'player')
   on conflict (display_name) do nothing;
   ```
   Replace `SpouseAName`/`SpouseAName0101` with the real name and
   `name+birthday` password each of you will type to log in. The plain
   password is never stored — only its hash.
4. Go to **Project Settings → API**. Copy the **Project URL** and the
   **anon public** key.
5. Open `config.js` in this project and paste them in:
   ```js
   window.HQ_CONFIG = {
     SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
     SUPABASE_ANON_KEY: "YOUR-ANON-PUBLIC-KEY"
   };
   ```

## 2. Push to GitHub

```bash
cd quest-tracker
git init
git add .
git commit -m "Initial quest tracker"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git push -u origin main
```

## 3. Connect Netlify

1. In Netlify: **Add new site → Import an existing project → GitHub**.
2. Pick the repo. Build command: leave blank. Publish directory: `.`
   (already set in `netlify.toml`, so Netlify should pick it up automatically).
3. Deploy. Every push to `main` will auto-redeploy from then on.

## How logging in works

There's no Supabase Auth here — `login()` is a Postgres function that checks
the name + password you typed against the hashed password stored in
`app_users`, and returns which role that login belongs to. The browser
remembers your session in `localStorage` so you don't have to log in every
visit; use the button in the header to log out (e.g. to switch which of you
is using a shared device).

## Security note

All the app's data tables (`phases`, `day_logs`, `rewards`, etc.) are open to
anyone holding your Supabase **anon key** — there's no per-row ownership
check, since there's no Supabase Auth session to check against. This is fine
for a small two-person app as long as you don't publish your Supabase URL/key
anywhere public (a private GitHub repo and a not-publicly-linked Netlify URL
is enough). If you ever want stronger isolation, the schema is structured so
it's a straightforward swap to Supabase Auth + row-level policies based on
`auth.uid()` later.

## Project structure

```
index.html          entry point
style.css            all visual styling
script.js            app logic + Supabase calls (ES module)
config.js            your Supabase URL/key (edit this)
assets/              character + map artwork
supabase/schema.sql  run this once in the Supabase SQL editor
netlify.toml         static-site deploy config
```

## Customizing once it's live

Everything else — phases, checklist items, setback conditions, rewards — is
edited from the **Setup** tab as Spouse A (Coach), no code changes needed.
