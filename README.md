# The AI Office

A pixel office of AI agents. You hire agents, give them tickets, watch their screens while they work, review their pull requests, and boss them around through Jarvis, including from Siri on your iPhone.

Everyone who signs in gets their own private office. Agents run on Claude (Opus 5.5) using the site owner's Claude API key, with a daily allowance per person.

## What's in here

| Path | What it is |
|---|---|
| `public/index.html` | The office itself: floor, CEO office, board, details panel, Jarvis |
| `public/runtime.js` | Sign-in, saving, live updates, screenshots and downloads |
| `api/sample.js` | Where agents and Jarvis ask Claude for work |
| `api/jarvis.js` | The Siri shortcut's address |
| `api/config.js` | Public settings the page needs to sign people in |
| `supabase/schema.sql` | The database setup, pasted once into Supabase |
| `dev/server.mjs` | A local test server (`OFFICE_DEV=1 npm run dev`) with a stand-in Claude |

## Put it online (one time)

1. **Supabase.** Create a free project at supabase.com. Open **SQL Editor**, paste all of `supabase/schema.sql`, and press **Run**.
2. **Vercel.** At vercel.com, choose **Add New > Project**, pick this GitHub repository, and press **Deploy**. Leave the build settings as they are.
3. **Settings.** In Vercel, open the project's **Settings > Environment Variables** and add:
   - `ANTHROPIC_API_KEY`: from console.anthropic.com, API Keys
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`: from Supabase, **Project Settings > API** (the service role key is the secret one; it only ever lives in Vercel)
   - Optional `OWNER_EMAIL`: your email, to lock in who owns the site. Without it, the first person to sign in becomes the owner.
   - Optional `DAILY_JARVIS_CALLS`: Jarvis commands per person per day (default 100).

   Then open **Deployments** and choose **Redeploy** so the settings take effect.
4. **Sign-in links.** In Supabase, open **Authentication > URL Configuration** and set **Site URL** to your Vercel address, for example `https://ai-office.vercel.app`.

Open your Vercel address, enter your email, and click the link that arrives. **Sign in yourself first:** the first person to sign in becomes the owner.

## Who can use it

The site is invite-only. As the owner, open **Account > People** to add someone's email and set how many tickets they get per month (empty means unlimited). Each time an agent works on a ticket or a revision counts as one ticket. Anyone not on the list sees an "Invite only" screen. Removing someone blocks them but keeps their office data.

If you update the site and `supabase/schema.sql` changed, paste it into the SQL Editor and run it again. It's safe to re-run.

Supabase's built-in email sends only a few sign-in emails per hour. That's fine for a small group because people stay signed in. For more, connect your own email service under **Authentication > Emails** in Supabase.

## Siri

In the office, open **Account**. It makes your private Jarvis key and shows the exact Shortcuts steps. Name the shortcut "Jarvis" and say "Hey Siri, Jarvis". Tickets that Jarvis creates from your phone start as soon as your office is open on any device.

## Costs

Agents use your Claude API key, so every ticket costs a little. The People list and each person's monthly tickets are your guard rails. Supabase and Vercel are free at this size.
