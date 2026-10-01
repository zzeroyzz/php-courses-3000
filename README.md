# GA Real Estate Study

A mobile-first study app for the Georgia Real Estate Licensing Course: an admin pastes each lesson, Claude generates sourced flashcards and practice questions, and every student studies with their own spaced-repetition schedule and progress.

> Parts of this README below still describe v1 and are stale. ARCHITECTURE.md is the accurate reference.

## Features

- **Add Lesson** — paste raw lesson text; Claude generates cleaned notes, flashcards, and quiz questions; review and edit before saving
- **Learn** — browse modules/lessons with markdown rendering, mark lessons as read, prev/next navigation
- **Flashcards** — tap-to-flip cards with a 5-box Leitner spaced-repetition system
- **Practice** — multiple-choice quizzes with immediate feedback and explanations; per-module or all-modules filter
- **Gamification** — XP, levels, daily streak, 14 achievement badges, per-module mastery %, daily goal ring
- **Auth** — email + password sign-in via Supabase; all progress syncs across devices

## Tech Stack

- [Next.js 16](https://nextjs.org) (App Router + TypeScript)
- [Tailwind CSS v4](https://tailwindcss.com)
- [Supabase](https://supabase.com) — Auth + Postgres with Row Level Security
- [Anthropic API](https://anthropic.com) — `claude-sonnet-4-6` for content generation (server-side only)
- Deploy target: [Vercel](https://vercel.com)

---

## Local Development

### 1. Prerequisites

- Node.js 18+
- A [Supabase](https://supabase.com) project (free tier is fine)
- An [Anthropic API key](https://console.anthropic.com)

### 2. Clone & install

```bash
git clone <your-repo-url>
cd php-courses-3000
npm install
```

### 3. Set up the database

In the Supabase dashboard → **SQL Editor**, run both migration files in order:

```
supabase/migrations/001_initial_schema.sql   # profiles, progress, achievements
supabase/migrations/002_user_content.sql     # user_modules, user_lessons, user_flashcards, user_quiz_questions
```

### 4. Configure environment variables

```bash
cp .env.local.example .env.local
```

Edit `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
ANTHROPIC_API_KEY=sk-ant-...
```

> `.env.local` is gitignored and never committed.

### 5. Disable email confirmation for local dev

By default Supabase requires users to confirm their email before they can sign in, which means every "Create account" attempt during development triggers a confirmation email — annoying when you're iterating quickly.

**To skip email confirmation locally:**

Supabase dashboard → **Authentication → Providers → Email** → toggle off **"Confirm email"**

With this off, creating an account immediately signs you in with no email sent.  
> Re-enable it for production if you want email verification.

### 6. Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Deploying to Vercel

### 1. Import into Vercel

Go to [vercel.com/new](https://vercel.com/new) and import your GitHub repo. Framework preset: **Next.js** (auto-detected).

### 2. Add Environment Variables

In Vercel → **Project Settings → Environment Variables**:

| Key | Value |
|-----|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Your Supabase anon public key |
| `ANTHROPIC_API_KEY` | Your Anthropic API key (server-side only) |

### 3. Configure Supabase for production

In Supabase → **Authentication → URL Configuration**:

- **Site URL**: `https://your-app.vercel.app`

> The auth callback route is no longer used (email+password doesn't need it), but setting Site URL correctly ensures Supabase session cookies work across your domain.

### 4. Deploy

Click **Deploy**. Vercel rebuilds automatically on every push to main.

---

## Project Structure

```
app/
  page.tsx                           # Home dashboard
  sign-in/page.tsx                   # Email + password sign-in / sign-up
  add-lesson/page.tsx                # AI content generation flow
  api/generate/route.ts              # Server-side Anthropic API route
  learn/page.tsx                     # Module list
  learn/[moduleId]/page.tsx          # Redirect to first lesson
  learn/[moduleId]/[lessonId]/       # Lesson viewer
  flashcards/page.tsx                # Leitner flashcard session
  practice/page.tsx                  # Multiple-choice quiz

components/                          # Shared UI components
hooks/                               # Data-fetching hooks (optimistic updates)
lib/
  db.ts                              # Typed data-access layer (all Supabase calls)
  db-types.ts                        # TypeScript types for DB schema
  gamification.ts                    # XP, levels, streaks, achievements
  leitner.ts                         # Spaced-repetition scheduling
utils/supabase/
  client.ts                          # Browser Supabase client
  server.ts                          # Server-side Supabase client (cookies)
supabase/migrations/                 # SQL migration files
middleware.ts                        # Auth protection + session refresh
```
