# Cutting Room Ledger — deployment guide

This is a standalone React app (Vite). It needs a database (Supabase) and a host (Vercel or Netlify). Both have free tiers that are plenty for an internal team tool. Total time: ~15–20 minutes.

## 1. Create the database (Supabase)

1. Go to https://supabase.com, sign up, and create a new project (pick any name/region; save the database password it generates).
2. Once the project is ready, open **SQL Editor** in the left sidebar → **New query**.
3. Paste in the entire contents of `schema.sql` (included in this project) and click **Run**. This creates the `items`, `customers`, and `orders` tables.
4. Go to **Project Settings → API**. You'll need two values from this page in a minute:
   - **Project URL**
   - **anon public** key

## 2. Put the code on GitHub

1. Create a new (private is fine) repository on GitHub.
2. Push this project folder to it, e.g.:
   ```
   cd cutting-room-ledger
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```
   (`.env` is already git-ignored, so your Supabase keys won't be committed — you'll set them in Vercel instead.)

## 3. Deploy (Vercel)

1. Go to https://vercel.com, sign up/log in (GitHub login is easiest), click **Add New → Project**, and import the repo you just pushed.
2. Vercel will auto-detect Vite. Leave the build settings as default.
3. Before deploying, open **Environment Variables** and add:
   - `VITE_SUPABASE_URL` = the Project URL from step 1.4
   - `VITE_SUPABASE_ANON_KEY` = the anon public key from step 1.4
4. Click **Deploy**. In about a minute you'll get a live URL like `cutting-room-ledger.vercel.app` — that's what you share with your team.

(Netlify works the same way if you prefer it: import the repo, set the same two environment variables, build command `npm run build`, publish directory `dist`.)

## Running it locally first (optional but recommended)

```
npm install
cp .env.example .env      # then fill in your Supabase URL + anon key
npm run dev
```
Opens at http://localhost:5173.

## Important limitations to know about

- **No login.** The Manager/Sales Rep toggle in the app is just a view switch, not authentication. Anyone with the deployed URL can see and edit everything, including landed cost if they flip to Manager view. This is fine for a private link shared only with your team, but don't post the URL publicly. If you want real access control later, Supabase has built-in email/password auth that can be layered on — worth a follow-up project once the basics are working.
- **QuickBooks export stays CSV-based.** This app generates QuickBooks Online–compatible invoice CSVs for import, not a live push via the QuickBooks API. A live push would need a backend holding QuickBooks OAuth credentials — a reasonable next step once this version is running, but a separate build.
- **The data model is intentionally simple** (one JSON blob per item/customer/order row in Postgres) so the app logic could carry over unchanged from the prototype. It works well at small-team scale; if you ever want proper relational reporting (e.g. SQL queries across order line items), that's a schema redesign, not a rewrite of the app.
