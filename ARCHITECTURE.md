# GA Real Estate Study — Architecture Reference

A complete technical breakdown of this application as it actually exists on branch
`feat/nocturne-redesign`.

> **Read this first, not `README.md`.** The README describes v1 and is stale — see
> [§16 Documentation map](#16-documentation-map). This document was written by reading the
> source, and every formula and line reference in it was verified against the code.

## 0. Current state (read this first)

The numbered sections below (§1–§16) were written for the **single-user MLO app** and are kept
as history: they explain why the code is shaped the way it is. Where they disagree with this
section, **this section wins**. Everything here was checked against the code on
`feat/georgia-real-estate`.

### What the app is now
A multi-user study app for the **Georgia Real Estate Licensing Course** (RealEstateU v.2). Admins
paste lesson text and invite students; students study with per-user progress. Course facts
(name, prompt context, progress label) live in `lib/course.ts`.

### Shape
- **Route group `app/(app)/`** holds every signed-in page. Its client layout mounts
  `CourseProvider` (`lib/course-context.tsx`) and `AppNav` **once**: sections, lesson summaries
  (no source text), completion and due counts load once and are shared. Lesson rows stay current
  over Realtime; progress is re-read on navigation. Pages no longer mount their own nav.
- **Public pages** outside the group: `/sign-in`, `/invite/[token]`, `/forgot-password`,
  `/reset-password`, `/auth/callback` (live again — password-reset links: `token_hash` +
  `verifyOtp`, or PKCE `code`; `next` restricted to same-site paths).
- **Nav** (`components/AppNav.tsx`, `CourseTree.tsx`): collapsible desktop rail with a course tree
  modelled on the RealEstateU sidebar; phone bottom bar with a Course sheet. Lesson pages have
  previous/next (`LessonPager.tsx`).

### Data model (migrations 010–013)
- `profiles.role` admin/student, column-locked so users can't promote themselves; `is_admin()`.
- Content (`sections`, `lessons`, `flashcards`, `questions`) readable by all signed-in users,
  writable by admins only. `lessons.user_id` → `created_by` (nullable, `ON DELETE SET NULL`).
- Per-user study state: `card_progress` (SM-2), `lesson_progress` (completion), `attempts`.
  A card is due when its `card_progress.due_at` has passed, or it was never reviewed **and** its
  lesson is completed (`due_cards()`); a lesson's Cards tab introduces its own new cards.
- Study reads are SQL functions — `study_cards`, `due_cards`, `due_counts`, `section_stats` —
  because the course holds thousands of cards and PostgREST caps responses at 1,000 rows.
- `lessons` adds `lesson_number`, `kind` (prose / infographic / quiz / document), `has_source`
  (generated column), `depth_content`, and the generation-control columns below.
- `sections` adds `chapter_number`, `allow_generated_depth` (false for statute chapters
  2, 3, 10, 17, 24). `exam_weight` holds **course-completion** weights (share of lessons), not exam
  weights; swapping in real weights is an `UPDATE`.
- `invites` (012): `sha256(token)` only, status derived from timestamps, admin-only RLS. Accounts
  are created only by `/api/invites/accept` (service role, `auth.admin.createUser`) after a
  single conditional `UPDATE … RETURNING` claims the invite. `utils/supabase/admin.ts` is
  `server-only`.
- The textbook subsystem (`textbook_chunks`, `search_textbook`, 007/008) is gone.

### Generation (`app/api/generate`, `generate-depth`; migration 013)
- Admin-only; reads the lesson from the DB, never the request body. Prompts are **source-only**:
  drilled content must be verifiable (see the comment in the route). "Going deeper" is a separate
  text column, generated on demand, never drilled.
- **Cooperative cancellation by run id.** The client calls `queue_generation()` (stamps a run id;
  a reset deletes earlier output) before firing the route. The route writes each chunk through
  `save_generated_chunk()`, which inserts only if the run is current and not cancelled, under a row
  lock. `generation_tick()` every 5s refreshes a heartbeat and aborts the Anthropic call on Stop.
  `request_generation_cancel()` stops; `clear_lesson()` empties a lesson (the undo for a wrong paste).
- `contentStatus()` (`lib/db-types.ts`): empty / generating / cancelling / cancelled / failed /
  **stalled** (no heartbeat for 2 minutes) / ready. The old 3-minute client timeouts are gone.

### Progress math
`lib/progress.ts`: per chapter, accuracy × coverage (lessons answered in ÷ countable lessons),
weighted by `exam_weight`. Chapters with no answers contribute 0. Displayed as "Course progress".

### UI
Lesson Read tab: course text (box on ≥768px, collapse on phones; `?source=box|collapse` overrides)
→ "Going deeper" → actions; at xl, a 660px reading column with a sticky 340px rail. Home: Today
cards, Where you stand, and a course map. Section page: the handoff's table (Lesson / Contents /
Status / Due). Ingest fills the next empty seeded lesson. The Level/streak display was removed —
those values are never written (§13).

### Still open
Chapter quizzes (direct question entry), the Chapter 31 math generator, primary-source entry for
statute chapters, and wiring or deleting the unused gamification code.

---

## Table of contents

1. [What this app is](#1-what-this-app-is)
2. [Stack & configuration](#2-stack--configuration)
3. [Architecture at a glance](#3-architecture-at-a-glance)
4. [Route map](#4-route-map)
5. [Data model](#5-data-model)
6. [Migration history](#6-migration-history)
7. [The generation pipeline](#7-the-generation-pipeline)
8. [Spaced repetition](#8-spaced-repetition)
9. [Progress math](#9-progress-math)
10. [Design system](#10-design-system)
11. [Client-side patterns](#11-client-side-patterns)
12. [Module reference](#12-module-reference)
13. [Dead & vestigial code](#13-dead--vestigial-code)
14. [Known bugs & risks](#14-known-bugs--risks)
15. [Operational notes](#15-operational-notes)
16. [Documentation map](#16-documentation-map)

---

## 1. What this app is

**MLO Study** is a single-user, mobile-first study app for the **SAFE MLO Test — National
Component with Uniform State Content**, the NMLS licensing exam for mortgage loan originators.

The exam it targets: 120 questions (115 scored), 190 minutes, 75% to pass, roughly a 53%
first-attempt pass rate. Those numbers are not trivia — `115` and `86` are hardcoded constants that
drive the app's primary metric.

### The core loop

```
User pastes a lesson from a prep guide
        ↓
Source text is saved to the DB immediately (before any AI call)
        ↓
Claude generates: "why it matters" + N multiple-choice questions + flashcards
        ↓
User studies: reads Source, reviews flashcards on an SM-2 schedule, answers practice questions
        ↓
Dashboard converts answer accuracy into an estimated exam score against the 86-point pass line
```

### The design constraint that shaped it

Per `New Features CLAUDE.md`, the content source is a **RealEstateU Exam Prep Guide that expires**.
Once its 59 lessons are pasted in, this app becomes the permanent copy. Two consequences are visible
throughout the codebase:

- **Ingestion is optimized for bulk paste**, with a "paste next lesson" affordance to keep the user
  in flow — 59 lessons is a lot of pasting.
- **`source_content` is immutable.** Regenerating a lesson deletes and recreates its flashcards and
  questions but never touches the source. The source is the ground truth the user checks generated
  content against, because the original course had known-broken questions.

### What makes it more than a quiz app

Three things distinguish it from a generic flashcard tool:

1. **Question generation is exam-shaped, not generic.** Each section carries a `question_mix` ratio
   (factual / scenario / calculation) read from the database, and the prompt demands
   true-but-incomplete distractors — because the real exam's difficulty isn't obviously-wrong
   options, it's correct statements that don't answer what was asked.
2. **Progress is weighted by exam share, not lesson count.** Completing a Federal Laws lesson is
   worth more than a Uniform State Content lesson, because Federal Laws is more than double the
   exam. See [§9](#9-progress-math).
3. **Every generated card cites its source.** `source_anchor` holds a verbatim quote so the user can
   jump from a suspicious answer to the text behind it. (This feature is currently broken —
   see [§14](#14-known-bugs--risks).)

---

## 2. Stack & configuration

| Layer | Choice | Notes |
|---|---|---|
| Framework | **Next.js 16.2.10**, App Router | See the warning below |
| UI | **React 19.2.4** | |
| Language | **TypeScript 5**, strict | No generated DB types; schema types are hand-written |
| Styling | **Tailwind CSS v4** | CSS-first — there is no `tailwind.config.*` anywhere |
| Auth + DB | **Supabase** | Auth, Postgres, Realtime, Row Level Security |
| AI | **Anthropic `claude-sonnet-4-6`** | Server-side only, via `@anthropic-ai/sdk ^0.112.4` |
| Icons | `@phosphor-icons/react` | |
| Markdown | `react-markdown` + `remark-gfm` | Currently unused — see [§13](#13-dead--vestigial-code) |
| Deploy target | Vercel | |

> ⚠️ **`AGENTS.md` carries a standing instruction:** this Next.js version has breaking changes
> relative to model training data. Read the relevant guide in `node_modules/next/dist/docs/` before
> writing routing or data-fetching code, and heed deprecation notices.

### Config files

| File | Contents |
|---|---|
| [next.config.ts](next.config.ts) | **Empty.** No custom config at all. |
| [tsconfig.json](tsconfig.json) | Strict, `target: ES2017`, `moduleResolution: bundler`, `jsx: react-jsx`, path alias `@/* → ./*`, Next plugin. |
| [postcss.config.mjs](postcss.config.mjs) | Loads `@tailwindcss/postcss`. That's the whole Tailwind build. |
| [eslint.config.mjs](eslint.config.mjs) | Flat config: `eslint-config-next/core-web-vitals` + `/typescript`. |
| [middleware.ts](middleware.ts) | Auth gate + session refresh. See [§3](#3-architecture-at-a-glance). |

### Scripts

```bash
npm run dev     # next dev
npm run build   # next build
npm run start   # next start
npm run lint    # eslint
```

**There is no test script and no test files.** No Jest, Vitest, Playwright, or Cypress.

### Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | client, server, middleware, script | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client, server, middleware | Anon key; RLS does the real work |
| `ANTHROPIC_API_KEY` | `/api/generate`, retry script | Server-side only |
| `DATABASE_PASSWORD` | `scripts/retry-failed.mjs` only | Direct `psql` access, bypassing RLS |
| `LESSON_ID` | `scripts/retry-failed.mjs` only | Optional: retry a single lesson |

[.env.local.example](.env.local.example) lists only the first three. A real `.env` with live values
exists at the repo root — it is correctly gitignored and **not** committed, but see
[§14](#14-known-bugs--risks) for how the retry script handles it.

---

## 3. Architecture at a glance

The single most important structural fact about this codebase:

> **Every page is a client component. There are zero server actions, and
> `app/layout.tsx` is the only server component in the app.**

That one decision explains most of what follows: first paint is always a skeleton, all data fetching
happens after hydration, and **all authorization lives in Row Level Security** rather than in
server-side code.

### Path A — normal page load (7 of 9 routes)

```
Browser request
    ↓
middleware.ts ─── Supabase SSR session refresh
                  ├─ /sign-in or /auth/* → pass through
                  └─ no user → redirect /sign-in
    ↓
Server sends the client component shell
    ↓
Hydration → useEffect → supabase.auth.getUser()
    ↓
lib/db.ts (browser Supabase client)
    ↓
Postgres — RLS filters rows by auth.uid()
```

Authentication is enforced twice: once in middleware, then again per-page (each page re-checks
`getUser()` and pushes to `/sign-in`). Authorization is enforced *only* by RLS policies.

### Path B — content generation (the one server-side flow)

```
/ingest  ──POST (fire-and-forget, not awaited)──→  /api/generate
   │                                                    │
   │                                     Anthropic claude-sonnet-4-6
   │                                       (1..N chunked calls)
   │                                                    │
   │                                     utils/supabase/server.ts
   │                                       (cookie-bound, RLS applies)
   │                                                    ↓
   │                                        INSERT flashcards, questions
   │                                        UPDATE lessons.generated_at
   │                                                    │
   └──── Supabase Realtime: postgres_changes on lessons ←┘
         (client learns it finished by watching the DB row,
          not by awaiting the HTTP response)
```

This is the app's most distinctive pattern. Generation can take minutes and exceed a serverless
response window, so the client never waits on the response — it subscribes to its own `lessons` row
and reacts when `generated_at` appears. Full detail in [§7](#7-the-generation-pipeline).

### Middleware detail

[middleware.ts](middleware.ts) implements the standard `@supabase/ssr` cookie dance: `setAll`
rebuilds `supabaseResponse` so refreshed tokens land on the response, with the mandatory
"do not add code between `createServerClient` and `getUser()`" ordering.

- **Public allowlist:** `/sign-in`, `/auth/*`
- **Matcher excludes:** `_next/static`, `_next/image`, `favicon.ico`, and image extensions

Because the matcher does *not* exclude `/api/*`, **`/api/generate` sits behind the middleware auth
gate** — which is what makes it safe despite having no in-route auth check of its own.

---

## 4. Route map

Nine routes: 7 pages, 2 route handlers.

| URL | File | Type | Behavior |
|---|---|---|---|
| *(all)* | [app/layout.tsx](app/layout.tsx) | **Server** | Root layout. Inter font variable, metadata (`title: "MLO Study"`, favicon), viewport (`themeColor: #161826`, `maximumScale: 1`). Renders children only — **no nav shell here.** |
| `/` | [app/page.tsx](app/page.tsx) | Client | Dashboard. One `Promise.all` loads profile, sections, lessons, all flashcards, and 30 days of attempts; then computes global accuracy, per-section due counts and "secured" exam points. Renders the estimated-exam-score bar with a pass-threshold tick, a "Today" CTA, two suggested sections, and the "Where you stand" table. |
| `/sign-in` | [app/sign-in/page.tsx](app/sign-in/page.tsx) | Client | `signInWithPassword` → `router.push('/')`. The only screen without `AppNav`. **Sign-in only** — no sign-up and no password reset, despite what the README claims. |
| `/ingest` | [app/ingest/page.tsx](app/ingest/page.tsx) | Client | Add-lesson flow, driven by a `step` state machine (`form` → `saving` → `generating` → `done` \| `error`). Saves the lesson row **first**, then fires `/api/generate` without awaiting, then waits on Realtime. Shows live word count and a predicted question count using the same formula as the server. |
| `/sections/[slug]` | [app/sections/[slug]/page.tsx](app/sections/[slug]/page.tsx) | Client | Section overview. Lesson rows with derived status tags, per-lesson due counts, deep links into a lesson's Cards / Practice tab, and a **Regenerate** button. Redirects to `/` on an unknown slug. |
| `/lessons/[id]` | [app/lessons/[id]/page.tsx](app/lessons/[id]/page.tsx) | Client, **816 lines** | The main study screen — four tabs. See below. |
| `/review` | [app/review/page.tsx](app/review/page.tsx) | Client | Global cross-lesson SRS session: shuffled queue of every due card, tap to flip, Again / Got it, end-of-session stats, "all caught up" empty state. |
| `POST /api/generate` | [app/api/generate/route.ts](app/api/generate/route.ts) | Route handler | The AI pipeline. See [§7](#7-the-generation-pipeline). |
| `GET /auth/callback` | [app/auth/callback/route.ts](app/auth/callback/route.ts) | Route handler | PKCE `exchangeCodeForSession` → redirect. **Vestigial** — email+password needs no callback. Also builds its own server client inline rather than reusing `utils/supabase/server.ts`. |

### The lesson screen's four tabs

Tab state comes from `?tab=` on first render only (`?tab=flashcards` aliases to `cards`), then is
managed purely in local state.

| Tab | Contents |
|---|---|
| **Study** | "Why it matters" card, key facts (the first 4 flashcards), mark-complete button. |
| **Source** | The verbatim paste, run through a local `parseSource()` that classifies blocks into `heading` / `sub` / `list` / `note` / `paragraph` by heuristics (trailing colon, length, bullet ratio ≥ 50%). |
| **Cards** | In-lesson SM-2 flip review, scoped to this lesson's due cards. |
| **Practice** | MCQ with reveal, explanation, and a type filter (Factual / Scenario / Calc). Each answer writes an `attempts` row. |

A textbook search drawer is also available from the header, calling the `search_textbook` RPC.

### Conventions that are absent

**No `loading.tsx`, `error.tsx`, `not-found.tsx`, `template.tsx`, nested layouts, or route groups
anywhere.** Each page hand-rolls its own skeleton (inline `animate-pulse` divs) and error text.

Because there is no shared authenticated layout, **`<AppNav />` is manually mounted inside each of
the 5 authenticated pages**, and each repeats the same shell boilerplate:

```tsx
<div className="min-h-dvh bg-bg pb-24 md:pb-8">
  <AppNav />
  <div className="md:ml-56">
    <header …>…</header>
    <div className="max-w-2xl mx-auto px-5 py-6">…</div>
  </div>
</div>
```

`AppNav` also fetches its own data (sections, all flashcards for the due badge, profile — 3 queries),
so **every navigation re-runs those 3 queries**, duplicating work the destination page is already
doing. An `app/(app)/layout.tsx` route group is the clearest available refactor.

---

## 5. Data model

The live schema is `006_v2_rebuild.sql` plus three additive pieces. Everything numbered below 006 is
dead history — see [§6](#6-migration-history).

### Entity relationships

```
auth.users ──1:1── profiles            (created by trigger, read-only in practice)
     │         └── achievements        (never written)
     │
     ├──1:N── lessons ──N:1── sections (global, seeded, read-only)
     │            │
     │            ├──1:N── flashcards  (SM-2 state inline; NO user_id)
     │            └──1:N── questions   (NO user_id)
     │                          │
     └──────1:N── attempts ─────┘      (append-only)

textbook_chunks                        (global full-text corpus, unrelated to lessons)
```

### Tables

#### `sections` — fixed, seeded once, never user-editable

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `slug` | `text` UNIQUE | e.g. `federal-laws` |
| `name` | `text` | |
| `exam_weight` | `numeric` | `0.27` = 27% of the exam. **Drives all progress math.** |
| `sort_order` | `int` | Display order, deliberately *not* the same as weight order |
| `question_mix` | `jsonb` | `{ factual, scenario, calculation }` ratios |

Seeded with exactly five rows:

| slug | name | weight | sort | factual / scenario / calc |
|---|---|---|---|---|
| `federal-laws` | Federal Mortgage Related Laws | 0.24 | 1 | .50 / .50 / .00 |
| `origination-activities` | Mortgage Loan Origination Activities | 0.27 | 2 | .25 / .40 / .35 |
| `general-knowledge` | General Mortgage Knowledge | 0.20 | 3 | .55 / .35 / .10 |
| `ethics` | Ethics | 0.18 | 4 | .20 / .80 / .00 |
| `uniform-state` | Uniform State Content | 0.11 | 5 | .75 / .25 / .00 |

Display order follows the prep guide (Federal Laws first) while progress weighting uses
`exam_weight` — a deliberate separation called out in the v2 spec. Ethics is 80% scenario because
that's how the real exam tests it.

#### `lessons` — one row per paste

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `section_id` | `uuid` → `sections` CASCADE | |
| `user_id` | `uuid` → `auth.users` CASCADE | |
| `title` | `text` | |
| `sort_order` | `int` default 0 | |
| `source_content` | `text` NOT NULL default `''` | **The verbatim paste. Never overwritten by regeneration.** |
| `why_it_matters` | `text` null | Generated |
| `generated_at` | `timestamptz` null | null = generation not yet complete |
| `completed_at` | `timestamptz` null | null = not marked complete |
| `generation_chunk` | `int` null | Resume cursor (migration 009) |
| `created_at` | `timestamptz` | |

Index on `(user_id, section_id, sort_order)`.

#### `flashcards` — SM-2 state lives inline

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `lesson_id` | `uuid` → `lessons` CASCADE | |
| `front` | `text` | The **description or scenario** side |
| `back` | `text` | The **term, rule, or number** |
| `source_anchor` | `text` null | Short supporting quote from `source_content` |
| `ease` | `numeric` default 2.5 | |
| `interval_days` | `int` default 0 | |
| `due_at` | `timestamptz` null | **null = due now** (new or just lapsed) |
| `lapses` | `int` default 0 | |

Card direction is deliberate: description → term, because that's the direction the exam tests. The
v2 spec explicitly forbids term-first cards.

Note there is **no separate progress table** — v1 had `flashcard_progress`; v2 puts scheduling state
on the card itself, which works because this is a single-user-per-lesson app.

#### `questions`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `lesson_id` | `uuid` → `lessons` CASCADE | |
| `question_type` | `text` CHECK in (`factual`, `scenario`, `calculation`) | |
| `stem` | `text` | |
| `options` | `jsonb` | `string[4]` |
| `correct_index` | `int` | |
| `explanation` | `text` | Covers why right **and** why the best distractor fails |
| `source_anchor` | `text` null | |

Indexes on `(lesson_id)` and `(lesson_id, question_type)`.

#### `attempts` — append-only answer history

`question_id` → `questions` CASCADE, `user_id` → `auth.users` CASCADE, `chosen_index`, `correct`,
`answered_at`. Indexes on `(user_id, question_id)` and `(user_id, answered_at DESC)`.
Granted `SELECT, INSERT` only — no update or delete.

#### `textbook_chunks` — full-text corpus

| Column | Type | Notes |
|---|---|---|
| `page` | `int` | The **printed** page number, so results match the physical book |
| `part` | `int` | Chunk index within a page |
| `content` | `text` | |
| `tsv` | `tsvector` GENERATED ALWAYS STORED | `to_tsvector('english', content)` |
| `embedding` | `vector(1536)` | **Declared but never populated or queried** |

GIN index on `tsv`, btree on `page`. 1,101 chunks across 718 book pages.

```sql
search_textbook(q text, limit_n int default 8)
  RETURNS TABLE (page int, part int, content text, rank real)
```

Plain Postgres full-text search via `websearch_to_tsquery`, ordered by `ts_rank` then page.
**This is not RAG** — the corpus is never fed to the model. It's a manual "check this against the
textbook" lookup available in the lesson UI only. The `embedding` column is vestigial; the migration
header says it can be dropped if `pgvector` isn't available.

#### `profiles` and `achievements` — survivors from v1

`profiles`: PK `user_id`, `xp`, `level`, `current_streak`, `longest_streak`, `last_active_date`,
`daily_goal` (default 20), timestamps. `achievements`: `user_id`, `achievement_id`, `unlocked_at`,
`UNIQUE(user_id, achievement_id)`.

**Both are read but never written by the v2 app.** See [§13](#13-dead--vestigial-code).

### Row Level Security

Every table has RLS enabled, with explicit `GRANT`s to the `authenticated` role.

| Table | Policy |
|---|---|
| `sections` | `FOR SELECT TO authenticated USING (true)` — global shared data |
| `textbook_chunks` | `FOR SELECT TO authenticated USING (true)` — global shared data |
| `lessons` | `FOR ALL USING (auth.uid() = user_id)` |
| `attempts` | `FOR ALL USING (auth.uid() = user_id)` |
| `flashcards` | `FOR ALL USING (EXISTS (SELECT 1 FROM lessons WHERE lessons.id = flashcards.lesson_id AND lessons.user_id = auth.uid()))` |
| `questions` | same `EXISTS` pattern via `lessons` |

**`flashcards` and `questions` have no `user_id` column** — ownership is derived through a subquery
on the parent lesson. This has a direct consequence in application code: to fetch all of a user's
cards, `lib/db.ts` can't just filter on a column, so it uses a join-embed purely as a filter:

```ts
// lib/db.ts:207-213
.select('*, lessons!inner(user_id, section_id)')
.eq('lessons.user_id', userId)
// …then the nested `lessons` key is stripped off before returning
```

### Functions & triggers

- **`handle_new_user()`** — `SECURITY DEFINER SET search_path = ''`, inserts a `profiles` row
  `ON CONFLICT DO NOTHING`. Fires `AFTER INSERT ON auth.users`. **This is the only thing that ever
  creates a profile** — there is no application-side fallback, so if the trigger is missing, every
  page that reads `profile` silently renders nothing.
- **`set_updated_at()`** — BEFORE UPDATE triggers. Originally on three tables; 006 dropped two of
  them, so only `profiles_updated_at` survives.
- **`search_textbook()`** — described above.

No business logic lives in the database beyond these. Progress, mastery and scheduling are all
computed in TypeScript.

---

## 6. Migration history

Eleven files. **The numbering is misleading** — 006 is a hard reset, so everything before it is dead
history that exists only to keep the sequence replayable from scratch.

| File | Lines | Status | What it does |
|---|---|---|---|
| `001_initial_schema.sql` | 134 | ⚰️ mostly dead | v1 baseline: `profiles`, `flashcard_progress` (Leitner 1–5), `quiz_attempts`, `lesson_progress`, `achievements`, RLS, 2 functions + triggers. **`profiles` and `achievements` survive 006.** |
| `002_user_content.sql` | 57 | ⚰️ dead | v1 content: `user_modules`, `user_lessons`, `user_flashcards`, `user_quiz_questions`. |
| `003_lesson_refs.sql` | 10 | ⚰️ dead | Adds `chapter` + nullable `lesson_id` FKs. |
| `004_why_it_matters.sql` | 2 | ⚰️ dead | Adds `user_lessons.why_it_matters`. |
| `005a_three_level_schema.sql` | 75 | ⚰️ dead | Adds `user_sections` and a Module → Section → Lesson hierarchy. Back-fills orphaned `lesson_id`s by joining through `module_id` — repairing an application bug. **Ends in a verification `SELECT`, not a mutation.** |
| `005b_consolidate_data.sql` | 110 | ⚰️ dead | Large CTE collapsing "phantom" one-module-per-lesson rows into a single Module 1 / Section 1.1 per user. **Its destructive `DELETE` is deliberately commented out.** |
| `006_v2_rebuild.sql` | 178 | ✅ **live** | **The real schema.** Drops all v1 content + progress tables `CASCADE`, creates the five v2 tables, seeds the 5 exam sections. |
| `007_textbook_chunks.sql` | 27,030 | ⚠️ superseded, untracked | Creates `textbook_chunks` + `search_textbook()`, seeds **1,111** chunks. |
| `008_textbook_chunks.sql` | 24,153 | ✅ **live**, untracked | Same DDL, then `truncate` + reseed with **1,101** ligature-repaired chunks. |
| `009_chunked_generation.sql` | 6 | ✅ live | Adds `lessons.generation_chunk int` — the resume cursor. |

`005a` and `005b` are worth understanding as a pattern: they're **deliberately human-gated**. `005a`
ends with a `SELECT` so you inspect the result before proceeding, and `005b`'s destructive step is
commented out so you uncomment it only after verifying the consolidation was correct. That's a
two-step migration with a human in the loop, not an unfinished file.

### Why 007 and 008 share a name

`008` is a **v2 re-load of the same data**, not an additive migration. Both files run identical DDL
(`create extension vector`, `create table if not exists`, indexes, RLS policy,
`create or replace function`), then `truncate textbook_chunks` and re-insert in batches of ~150 rows.
So `008` is idempotent *and* supersedes `007`.

The reason is stated in `008`'s header: the source PDF's font drops `fi`/`fl`/`ff` ligatures,
producing `"Bene t"`, `"re nancing"`, and stray orphan `"fi"` lines. `008` repairs them with a
dictionary-checked rejoin. The artifact is visible in the very first data row:

```
007: (1, 0, 'fi'),          ← an orphan ligature fragment as its own chunk
     (1, 1, 'CFPB Roles…
008: (1, 0, 'CFPB Roles…    ← fragment gone, parts renumbered
```

The 10-chunk delta (1,111 → 1,101) is exactly these dropped orphan fragments, which also shifts
`part` numbering within pages.

> ⚠️ **`008` is the live state. Applying `007` after `008` silently regresses text quality** —
> neither file drops the other's artifacts, they just truncate and reseed. Verify with:
> ```sql
> select count(*) from textbook_chunks;                     -- expect 1101
> select page from search_textbook('refinancing tangible net benefit');
> -- "refinancing" must appear intact, not "re nancing"
> ```

Both textbook files are **untracked in git** — at ~1 MB each they were never committed. A fresh
clone will have a working app with a non-functional textbook search drawer.

---

## 7. The generation pipeline

`app/api/generate/route.ts` (267 lines) is the only substantial server-side logic in the app, and the
most intricate subsystem. It exists in its current form because of a specific failure.

### The problem it solves

Before commit `2e4c3fd`, the route made **one** Anthropic call for the entire lesson. Large pastes
blew past the 8,192 output-token ceiling mid-JSON, `JSON.parse` threw, and the whole lesson failed
with nothing saved. That commit rewrote the route into a chunked pipeline, added migration `009`,
and added `scripts/retry-failed.mjs` — which then recovered all 8 previously-failed lessons.

### Step by step

**1. Chunk the source.** `CHUNK_LIMIT = 8_000` characters, chosen so the model can emit complete
JSON within 8,192 output tokens.

`splitOnParagraphs(text, limit)` is a greedy backward-scan splitter. For each window it tries
`lastIndexOf('\n\n')`, falls back to `'\n'`, then `' '` — **rejecting any break that lands before
`limit / 4`** to avoid pathologically tiny chunks — and hard-cuts at `limit` as a last resort.

**2. Decide the question budget.**

```ts
// whole lesson
const totalQ = clamp(round(totalWords / 130), 12, 30)

// per chunk — proportional to word share, floored at 6
const chunkQuestions = Math.max(6, Math.round(totalQ * (chunkWords / totalWords)))
```

Roughly one question per 130 words, minimum 12, maximum 30. A dense RESPA lesson generating far more
than a short definitional one is correct behavior, not a bug. `/ingest` previews the same formula
client-side so the user sees the estimate before submitting.

**3. Pick a prompt by position.**

| | First chunk (or any single-chunk lesson) | Continuation chunks |
|---|---|---|
| `whyItMatters` | ✅ requested | ❌ omitted — already persisted |
| Questions | N, split by `question_mix` | N, split by `question_mix` |
| Flashcards | 8–20 | 6–14 |
| Framing | `Lesson: <title>` | `Lesson (continued): <title>` |

Both split N using the section's ratios: `f = round(n × mix.factual)`,
`s = round(n × mix.scenario)`, `c = n − f − s`. The mix is read from the database row, never
hardcoded.

Shared quality constraints in both prompts:

- Named fictional borrowers in scenario questions
- All four options plausible; wrong answers should be **true facts about related topics**
  (true-but-incomplete distractors)
- Don't always open with "Which of the following"
- Explanation must cover why the correct answer is right **and** why the best distractor fails
- Calculation questions must show full worked arithmetic
- `source_anchor` = verbatim quote of ≤30 words from the source

**4. Call the model.** `claude-sonnet-4-6`, `max_tokens: 8192`, system prompt + one user message.
No tool use, no streaming. The response is parsed with a fence-stripping `parseJSON`, then
shape-checked explicitly per branch — a bad shape throws into the same `catch` as an API error.

**5. Persist `whyItMatters` immediately** after chunk 0 succeeds, so a later chunk failure doesn't
lose it.

**6. Insert this chunk's output** — flashcards then questions, both mapped with
`source_anchor ?? null`. Content accumulates into the same `lesson_id` chunk by chunk, so **partial
progress is durable**.

**7. On success**, set `why_it_matters` + `generated_at`, then clear `generation_chunk = null`.
That UPDATE is what the Realtime subscribers are waiting on.

### The resume contract

This is the part worth reading carefully, because the semantics are load-bearing:

| `chunkFrom` | Meaning | Wipes existing content? |
|---|---|---|
| `0` (default) | Full restart | ✅ **Yes** — deletes all flashcards + questions for the lesson |
| `N > 0` | Resume from chunk N | ❌ No — appends to what survived |

On any failure:

```ts
await supabase.from('lessons').update({ generation_chunk: i }).eq('id', lessonId);
return NextResponse.json({ error: msg, failedChunk: i }, { status: 500 });
```

Earlier chunks' rows stay in the database, `generated_at` stays null (so `lessonStatus` still reports
`'generating'`), and `generation_chunk = i` records where to pick up.

> ⚠️ **Nothing in the UI ever sends `chunkFrom`.** The Regenerate button POSTs without it, so every
> UI retry is a full restart that deletes surviving chunks. The resume path that `009` and the
> failure cursor exist for is only reachable through `scripts/retry-failed.mjs`.

### Fire-and-forget + Realtime

Because generation can take minutes, the client never awaits the response:

```ts
// app/ingest/page.tsx — subscribe FIRST, then fire
const channel = supabase
  .channel(`ingest-gen-${lesson.id}`)
  .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'lessons', filter: `id=eq.${lesson.id}` },
      (payload) => { if (payload.new.generated_at) { cleanup(); setStep('done'); } })
  .subscribe();

timeoutRef.current = setTimeout(() => { /* 3-minute fallback */ }, 3 * 60 * 1000);

fetch('/api/generate', { method: 'POST', body: … }).catch(() => {});  // not awaited
```

Both `/ingest` and `/lessons/[id]` use this pattern, each with a `cleanup()` called from both the
success handler and the effect's return, plus a 3-minute timeout that synthesizes an error state.
Generation status is **derived from the DB row**, never mirrored in client state — that was the fix
in commit `b845c87`.

The ordering matters: the lesson row is saved *before* generation starts, so a failed API call can
never lose the user's paste.

### Known gaps in the pipeline

- **Continuation chunks get no prior-chunk context.** Each call sees only its own slice, so
  cross-chunk duplicate questions are possible and there's no dedup pass.
- **The route trusts the request body.** `sourceContent`, `title`, and `questionMix` all come from
  the caller rather than being re-read from the DB by `lessonId`.
- **`Lesson` type omits `generation_chunk`** even though 009 added it, so the route bypasses
  `lib/db.ts` and writes raw for those two updates — the only two Supabase calls in the route that
  don't go through the data layer.

---

## 8. Spaced repetition

`lib/srs.ts` (59 lines) — a simplified SM-2. Pure functions, no I/O, called client-side.

```ts
scheduleCard(card, correct)
```

**On failure:**

```
lapses += 1
ease = max(1.3, ease − 0.2)
interval_days = 0
due_at = now            ← relearn immediately, in this same session
```

**On success:**

```
interval_days:  0 → 1 → 6 → round(interval × ease)
ease = max(1.3, ease + 0.1)
due_at = now + interval_days
```

Supporting helpers: `isDue` (treats `due_at === null` as due, matching the schema's "null = new
card"), `filterDue`, `daysUntilDue`, and `shuffle` (Fisher–Yates on a copy).

### Two deliberate divergences from canonical SM-2

1. **Binary grading.** The UI offers only *Again* / *Got it*, not SuperMemo's 0–5 quality scale. This
   is a reasonable simplification for a two-button mobile card.
2. **Ease has no upper cap.** Canonical SM-2 derives ease from the quality grade and effectively
   bounds it; here it's incremented `+0.1` on *every* success with only a lower floor of 1.3. A card
   answered correctly 15 times reaches ease ≈ 4.0, and intervals then grow by 4× per review. Mature
   cards will drift toward very long intervals — worth knowing before the exam date matters.

---

## 9. Progress math

This is the app's primary metric, and the reason it isn't just a flashcard app.

```ts
// lib/db-types.ts
export const EXAM_SCORED_QUESTIONS = 115;  // scored questions on the SAFE MLO exam
export const PASS_THRESHOLD = 86;          // 75% of 115

estimatedScoredQuestions(section, accuracy) = accuracy × section.exam_weight × 115
```

On the dashboard:

| Quantity | Computation |
|---|---|
| `globalAccuracy` | correct ÷ total over **all attempts in the last 30 days** |
| `secured` (per section) | `globalAccuracy × exam_weight × 115` |
| `available` (per section) | `exam_weight × 115` |
| Total estimated score | `Σ secured` across sections |
| Pass-line tick position | `86 / 115` = **74.8%** |

Sections in both "Today" and "Where you stand" are sorted by `available − secured` — **largest gap
first**, so the ranking points at wherever the most exam points are still unclaimed.

### Why weight by exam share

Straight from the v2 spec: *"Completing a Federal Laws lesson must be worth more than a Uniform State
Content lesson, because Federal Laws is more than double the exam. Otherwise the user is rewarded
for grinding the cheapest section."* Federal Laws carries 0.24 of the exam vs. Uniform State Content
at 0.11, so per-lesson progress on the former moves the score more than twice as much.

The metric is chosen to map effort directly onto the 86-of-115 pass line, rather than reporting an
abstract completion percentage.

> ⚠️ **Simplification worth knowing:** `globalAccuracy` is a *single* number applied uniformly to
> every section. Per-section accuracy is never computed, so all five bars move together and the
> display can't tell you that you're strong on Ethics but weak on Federal Laws. Since the whole point
> of the "largest gap first" sort is to direct attention, this materially limits its usefulness —
> currently the ranking is driven almost entirely by `exam_weight`, not by actual weakness.
>
> The data to fix it already exists: `attempts` joins to `questions` joins to `lessons.section_id`.

---

## 10. Design system

The "Nocturne" dark theme, introduced in commit `8f8c651`. Everything lives in
[app/globals.css](app/globals.css) — 192 lines, and **there is no `tailwind.config.*` anywhere.**

### The double declaration is the mechanism

```css
:root          { --color-bg: #161826; --color-surface: #232532; … }  /* lines  4–22 */
@theme inline  { --color-bg: #161826; --color-surface: #232532; … }  /* lines 24–44 */
```

Identical values, declared twice, on purpose:

- **`:root`** makes `var(--color-surface)` resolvable in the inline
  `style={{ background: 'var(--color-surface)' }}` that appears on roughly 25 elements.
- **`@theme inline`** is what generates the Tailwind utilities — `bg-bg`, `text-fg`, `text-n500`,
  `border-divider`, `bg-dim`.

They must be kept in sync by hand.

> **Consequence for theming:** because `@theme inline` substitutes the *literal hex* into each
> utility rather than emitting `var(--color-x)`, overriding `:root` (via a `.dark` class,
> `data-theme`, or `prefers-color-scheme`) would change the inline-style colors but **not** the
> Tailwind utility colors. The app is dark-only by design — there is no toggle, no
> `prefers-color-scheme` block, and no theme provider anywhere. **Adding light mode requires
> de-`inline`-ing the theme block first.**
>
> This is a regression in capability from the previous "warm editorial" theme (commit `4bdcb92`),
> which used a non-inline `@theme` forwarding `var(--paper)` etc. and therefore had working dark
> mode. That theme also had Fraunces serif headings and a 3D card-flip transform, both removed.

### Tokens

| Group | Values |
|---|---|
| Semantic | `--color-bg #161826`, `--color-surface #232532`, `--color-fg #e9e9ed`, `--color-accent #9184d9` (blurple) |
| Derived | `--color-divider` = fg @ 16%, `--color-dim` = fg @ 8%, both via `color-mix(in srgb, …)` |
| Neutral ramp | `--color-n300 #cfd3e5` → `--color-n900 #292b31` (7 steps) |
| Accent ramp | `--color-accent-lo #f5f4ff`, `-hi #d2cefd`, `-md #b5abfc`, `-dk #423a6a` |

One token from the design handoff was never ported: `--color-surface-sunk` (`#1b1d2c`) survives as a
raw hex literal in `AppNav.tsx:52`, with sunk panels elsewhere substituting `var(--color-bg)` or
`var(--color-n900)`. There is also **no semantic error token** — sign-in errors use a hardcoded
`#e87d6e`.

### Component classes

Hand-ported into `globals.css`: `.btn` + `.btn-primary` / `.btn-secondary` / `.btn-block`, `.input`,
`.field > label`, `.seg` + `.seg-opt` + `.seg-opt.active`, `.tag` + `.tag-accent` / `.tag-neutral`,
`.row-rule`.

`.row-rule` is the theme's signature **fading divider** — a 1px bottom background painted as
`linear-gradient(to right, transparent, divider 48px, divider calc(100% − 48px), transparent)`, so
the rule fades out at both ends of a row instead of running edge to edge.

Globals also set `:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px }`, a
3px webkit scrollbar, `.pb-safe` for safe-area insets, and `.tabular-nums`.

### Rules the theme enforces

- **No solid accent fills.** Primary buttons are outlined — `1px solid accent`, transparent
  background, 12% accent tint on hover. The only exceptions are the nav count badges.
- **No drop shadows.** Depth comes from surface color plus hairline dividers.
- **Inter 400/500 only** — never bold past 500.
- **Study body copy** is 16px / 1.75–1.8 line height, capped at `62ch`, with `text-wrap: pretty`.
- 8px radius everywhere; Nocturne's 0.7× density spacing scale (2.8 / 5.6 / 8.4 / 11.2 / 16.8 / 22.4px).

### Typography, icons, responsive

- **Font:** Inter via `next/font/google`, `variable: '--font-inter'`, `display: 'swap'`, exposed to
  Tailwind as `--font-sans`. No weight subsetting is declared, so the full variable axis ships even
  though only 400/500 are used.
- **Icons:** `@phosphor-icons/react` — `House`, `Cards`, `Plus` (nav), `ArrowLeft`, `BookOpen`,
  `CheckCircle`. Active nav items switch to `weight="fill"`.
- **Responsive:** a single breakpoint, `md` (768px). `AppNav` renders as a fixed bottom tab bar below
  it and a fixed 224px (`w-56`) left rail at and above it; pages offset with `md:ml-56` and clear the
  bottom bar with `pb-24 md:pb-8`.

### Drift from the design handoff

`app/design_handoff_mlo_study_redesign/README.md` (304 lines) is a thorough spec, but parts of it are
aspirational. Verified gaps:

| Spec says | Reality |
|---|---|
| Token names `--color-text`, `--color-muted`, `--color-faint`, `--color-surface-sunk` | Renamed to `--color-fg`, `--color-n*`; `surface-sunk` never tokenized |
| "No emoji anywhere" | `AppNav.tsx:156` and `app/page.tsx:115` both render 🔥; `gamification.ts` carries 14 more |
| Two-column desktop layouts (660px reading column + sticky 340px context rail; 3-card Today grid; Section table; Ingest 320px right column) | **Not built.** Every page is a single `max-w-2xl mx-auto` column. `app/ingest/page.tsx:113` has a `md:flex-row` wrapper with only one child. |
| Card faces labeled "Description" / "Answer" | Labeled "Term" / "Answer" |
| `arrow-u-up-left` back icon | `ArrowLeft` |
| Error color `--color-accent-light` | Hardcoded `#e87d6e` |

---

## 11. Client-side patterns

**No state library, no context providers, no custom hooks, no reducers.** All state is local
`useState` in the page component. The only `createContext` in the repo is inside the unused
`MarkdownRenderer`.

### The one pattern, repeated six times

```tsx
const supabase = useMemo(() => createClient(), []);      // memoized browser client

useEffect(() => {
  supabase.auth.getUser().then(async ({ data: { user } }) => {
    if (!user) { router.push('/sign-in'); return; }
    const [a, b, c] = await Promise.all([db.getX(…), db.getY(…), db.getZ(…)]);
    setState(…);
    setLoading(false);
  });
}, [supabase, router]);
```

Consequences:

- **First paint is always a skeleton.** No page has server-rendered data.
- **Auth is checked twice** — middleware already redirected, then each page re-checks. `app/page.tsx`
  and `AppNav.tsx` silently `return` instead of redirecting, leaving a permanent skeleton if the
  session is somehow absent.
- `utils/supabase/server.ts` exists but **no page uses it** — only `/api/generate` and middleware.

### Derived, not stored

Consistently applied, and worth preserving: `lessonStatus(lesson)`, `filterDue(cards)`,
`estimatedScoredQuestions(section, accuracy)`, and `getLevelInfo(xp)` are all computed at render from
raw rows. Nothing caches a denormalized status.

```ts
// lib/db-types.ts — the app's central state machine
export function lessonStatus(lesson: Lesson): LessonStatus {
  if (!lesson.source_content) return 'empty';
  if (!lesson.generated_at)   return 'generating';
  if (lesson.completed_at)    return 'completed';
  return 'ready';
}
```

> ⚠️ This is why a **failed** generation is indistinguishable from an **in-flight** one — both are
> `'generating'`. That's what forces the 3-minute client timeouts, and it's exactly what
> `generation_chunk` exists to disambiguate server-side. `GeneratingState` doesn't read that column,
> so the signal is available but unused.

### Other notable patterns

- **Optimistic-ish updates.** `handleCardAnswer` in the lesson page writes to Supabase then patches
  local `cards` state; the review page doesn't patch at all, it just advances the index. Nothing uses
  `revalidatePath`, `revalidateTag`, or `router.refresh()`.
- **Tab state never reaches the URL.** The lesson page reads `?tab=` once into `useState` and then
  manages it locally, so tab position isn't shareable or back-button-navigable.
- **Imperative DOM access, once.** `scrollToAnchor()` uses `document.createTreeWalker` + `Range` +
  `window.getSelection()` inside a `setTimeout(…, 100)` to highlight a cited passage. It is
  currently broken — see [§14](#14-known-bugs--risks).
- Two `eslint-disable-next-line react-hooks/exhaustive-deps` suppressions, in `/ingest` and
  `/lessons/[id]`.

### Styling convention

A deliberate hybrid: **Tailwind utilities for layout, sizing and spacing** (heavily
arbitrary-value — `text-[13px]`, `leading-[1.75]`, `tracking-[-0.02em]`, `h-1.25`), and **inline
`style` with CSS vars for color** — even where a generated utility exists. `bg-surface` is never
used; `style={{ background: 'var(--color-surface)' }}` appears ~25 times. Component classes
(`.btn`, `.input`, `.seg`, `.tag`, `.field`) handle form controls, often with inline padding
overrides.

---

## 12. Module reference

### `lib/`

| File | Lines | Purpose |
|---|---|---|
| [lib/db.ts](lib/db.ts) | 342 | **The entire data-access layer.** Every function takes an injected `SupabaseClient`, so identical code runs from browser components and the server route. 24 exported functions across profiles, achievements, sections, lessons, flashcards, questions, attempts, and textbook search. |
| [lib/db-types.ts](lib/db-types.ts) | 125 | Hand-written types mirroring the SQL schema (no generated Supabase types). Row types, `QuestionMix`, `QuestionType`, the derived `lessonStatus()`, and the exam-progress constants + `estimatedScoredQuestions()`. |
| [lib/srs.ts](lib/srs.ts) | 59 | SM-2 scheduling. See [§8](#8-spaced-repetition). |
| [lib/gamification.ts](lib/gamification.ts) | 129 | Level thresholds, XP constants, streak computation, 14 achievement definitions. **~80% unused** — see [§13](#13-dead--vestigial-code). |

`lib/db.ts` has a uniform error convention worth calling out:

```ts
if (error) { console.error('[db] getAttempts', error.message); return []; }
```

Every function logs and returns a neutral value — `null`, `[]`, or `0` — and **never throws**. Only
`getProfile` special-cases anything (`PGRST116` "no rows" → `null`).

### `utils/supabase/`

| File | Purpose |
|---|---|
| [utils/supabase/client.ts](utils/supabase/client.ts) | `createBrowserClient` — 8 lines. Used by every page. |
| [utils/supabase/server.ts](utils/supabase/server.ts) | `createServerClient` bound to `next/headers` `cookies()`. `setAll` is try/catch-wrapped because Server Components can't set cookies; session refresh is deferred to middleware. Used only by `/api/generate`. |

### `components/`

| File | Lines | Purpose |
|---|---|---|
| [components/AppNav.tsx](components/AppNav.tsx) | 172 | The whole app shell in one client component: mobile bottom bar + desktop left rail. Self-fetching (sections, all flashcards for the due badge, profile). Owns `signOut()`. Nav is Home `/`, Review `/review`, Add `/ingest`. |
| [components/Skeleton.tsx](components/Skeleton.tsx) | 32 | Exports `Skeleton`, `CardSkeleton`, `HomeSkeleton`. **Only `CardSkeleton` is used.** |
| [components/MarkdownRenderer.tsx](components/MarkdownRenderer.tsx) | 106 | Full `react-markdown` + `remark-gfm` component map with an `OrderedCtx` context to distinguish ordered from unordered list styling. **Imported by nothing.** |

Local sub-components defined inline in pages: `StatusTag`, `EmptyState`, `CardReview`,
`GeneratingState`, and `Spinner` — the last **defined three separate times** (in
`/sections/[slug]`, `/lessons/[id]`, and `/ingest`).

### `scripts/`

[scripts/retry-failed.mjs](scripts/retry-failed.mjs) (352 lines) — standalone Node script that
retries lessons where `generated_at IS NULL`. Reaches Postgres through `execSync` + `psql` using
`DATABASE_PASSWORD`, **deliberately bypassing RLS**. Duplicates the route's `splitOnParagraphs`,
both prompt builders, and `parseModelJSON` as condensed copies with the same constants and math.
Crucially, it is the **only** caller that actually uses the resume cursor:
`generateLesson(lesson, lesson.generation_chunk ?? 0)`.

```bash
node scripts/retry-failed.mjs                   # all failed, small lessons first
node scripts/retry-failed.mjs --small-only      # only < 8k chars
node scripts/retry-failed.mjs --large-only      # only >= 8k chars
LESSON_ID=<uuid> node scripts/retry-failed.mjs  # one lesson
```

It finds work via `WHERE generated_at IS NULL AND source_content != ''` joined to `sections` for
`question_mix`, returned as `json_agg` "to avoid delimiter collisions with source_content", sleeps
1.5s between lessons for rate limits, and closes with an audit query for lessons that have source but
zero questions.

### Untracked directories

| Path | Contents |
|---|---|
| `app/assets/` | One 13 MB PDF — the SAFE textbook that `textbook_chunks` was extracted from. An odd place for a large binary (it sits inside the App Router tree, though it produces no route). |
| `app/design_handoff_mlo_study_redesign/` | The design spec: a 304-line `README.md` plus `prototypes/` — three `.dc.html` interactive prototypes, a `support.js` runtime, and the full upstream Nocturne token sheet. `MLO Study 1b.dc.html` is the definitive clickable spec. |
| `app/UI Redesign Direction Choice.zip` | The original 62 KB delivery archive — exactly the 7 files in the directory above. Redundant. |
| `supabase/.temp/` | Supabase CLI scratch (project ref, pooler URL). |

`.gitignore` covers `public/*.pdf` but not `app/**/*.pdf`, which is why the textbook shows as
untracked rather than ignored.

---

## 13. Dead & vestigial code

Roughly a third of the tracked source is no longer reachable. Listed explicitly so a future reader
doesn't mistake any of it for live code. Every entry below was grep-verified.

| What | Size | Why it's dead |
|---|---|---|
| **`content/`** (`types.ts`, `index.ts`, `mod-1.ts`) | 494 lines | v1's hardcoded content bundle — a `ContentPackage` for "Overview of Mortgage Lending" with markdown bodies, flashcards, quiz questions, and lookup helpers. **Grep for `@/content` across `app/`, `components/`, `lib/`, `utils/` returns zero hits.** v2 content comes from the database. |
| **Migrations `001`–`005b`** | ~390 lines SQL | Target v1 tables that `006` drops `CASCADE`. Only `profiles` and `achievements` from `001` survive. |
| **`app/auth/callback/route.ts`** | 36 lines | PKCE callback; email+password never hits it. The README says so outright. |
| **`components/MarkdownRenderer.tsx`** | 106 lines | Imported nowhere. The lesson page uses its own `parseSource()` block parser instead — the generated content isn't markdown, it's plain prose. |
| **`Skeleton`, `HomeSkeleton`** | — | Exported, never imported. Only `CardSkeleton` is used. |
| **`LessonWithCounts`, `SectionWithLessons`** | — | Declared in `db-types.ts`, never used. `app/page.tsx` builds equivalent shapes ad hoc with local `Map`s. |
| **`textbook_chunks.embedding`** | — | `vector(1536)` column, never populated or queried. Search is tsvector-based. |
| **Most of `lib/gamification.ts`** | ~100 of 129 lines | See below. |

### The gamification layer is display-only

The **only** consumers of `lib/gamification.ts` are `getLevelInfo` in `app/page.tsx:94` and
`AppNav.tsx:147`. Never called:

- `computeNewStreak()`
- All four XP constants (`XP_CARD_REVIEW`, `XP_CARD_CORRECT_BONUS`, `XP_QUESTION_ANSWERED`,
  `XP_QUESTION_CORRECT_BONUS`)
- All 14 achievement definitions and `findNewAchievements()`
- And from `lib/db.ts`: `upsertProfile`, `addAchievement`, `getUserAchievements`

> **Consequence worth stating outright: `profiles.xp` and `profiles.current_streak` are read and
> rendered but never written.** The v2 rebuild kept the gamification tables and helper library, but
> the new UI never re-wired the write paths. So the dashboard and nav rail permanently display
> **Level 1** and a **0-day streak**, and no achievement can ever unlock.

This is arguably intentional as a product decision — the design handoff explicitly cut the 14-badge
achievement grid, and the v2 spec warns against "anything that rewards speed over accuracy." But the
*display* of level and streak was left in, so the UI shows two metrics that are structurally frozen.
Either wire up the writes or remove the display; showing a permanent "Level 1" is the worst of the
three options.

---

## 14. Known bugs & risks

Each verified against the source, not inferred.

### 🐞 `scrollToAnchor` never runs

`sourceRef` is attached to a div rendered only inside `{tab === 'source' && …}`
([app/lessons/[id]/page.tsx:443](app/lessons/[id]/page.tsx#L443)). But `scrollToAnchor` is called
only from the **Cards** tab ([:561](app/lessons/[id]/page.tsx#L561)) and the **Practice** tab
([:677](app/lessons/[id]/page.tsx#L677)) — where the Source tab isn't mounted, so
`sourceRef.current` is `null` and the guard on
[line 226](app/lessons/[id]/page.tsx#L226) early-returns every single time:

```ts
function scrollToAnchor(anchor: string | null) {
  if (!anchor || !sourceRef.current) return;   // ← always returns here
  …
  setTab('source');                            // ← never reached
```

This kills the "jump from a suspicious answer to the source in one click" feature — which the v2 spec
called **non-negotiable**, specifically because the source course had multiple broken questions and
the user needs to verify generated content against the original.

*Fix shape:* switch to the Source tab first, then locate the anchor in a `useEffect` that runs once
`sourceRef` is populated — the tab switch and the DOM walk need to be separate renders.

### 🐞 `TextbookChunk` doesn't match its RPC

```ts
// lib/db.ts:326 — declared
type TextbookChunk = { id: string; content: string; heading: string | null;
                       chapter: string | null; chunk_index: number };

// search_textbook — actually returns
(page int, part int, content text, rank real)
```

Four of the five declared fields are `undefined` at runtime. Concretely: `chunk.id` is used as the
React key (so every result shares an `undefined` key) and `chunk.heading` never renders. Only
`content` is real. The type is a leftover from an earlier chunk-table design, and because the cast is
unchecked (`as TextbookChunk[]`) TypeScript can't catch it.

*Fix shape:* redefine the type as `{ page: number; part: number; content: string; rank: number }`,
key on `` `${page}-${part}` ``, and show the page number — which is more useful than `heading` anyway,
since it matches the printed book.

### 🐞 The UI can never resume a generation

Nothing ever sends `chunkFrom`, so every Regenerate is a full restart that deletes surviving chunks.
The resume machinery — migration `009`, the `generation_chunk` cursor, the `failedChunk` in the error
response — is only reachable via `scripts/retry-failed.mjs`.

*Fix shape:* have `/sections/[slug]` read `lesson.generation_chunk` and pass it as `chunkFrom` when
non-null, with an explicit "start over" option. This requires adding `generation_chunk` to the
`Lesson` type, which is missing it.

### ⚠️ A failed generation looks identical to an in-flight one

`lessonStatus` returns `'generating'` for both, which is why both the ingest and lesson pages carry
3-minute client timeouts to synthesize an error. `GeneratingState` renders a three-way
empty/error/generating branch but **doesn't read `generation_chunk`** — so the server-side signal that
would distinguish "failed at chunk 3" from "still working" exists and is ignored.

### ⚠️ `lib/db.ts` swallows every error

`console.error` + neutral return means an RLS denial, a network failure, and genuinely-empty data are
indistinguishable at every one of ~24 call sites. Failures surface as empty UI with no message. This
is the single biggest obstacle to debugging anything in this app.

### ⚠️ `/api/generate` trusts the request body

It takes `sourceContent`, `title`, and `questionMix` from the caller rather than re-reading them from
the database by `lessonId`, and has no in-route auth check — it relies on middleware for
authentication and RLS for authorization. The practical blast radius is small (a caller can generate
arbitrary content into *their own* lesson with an arbitrary mix), and RLS does prevent writing to
someone else's lesson. But re-reading the lesson server-side would be both safer and simpler.

### ⚠️ Secret hygiene

A real `.env` containing `DATABASE_PASSWORD` and `ANTHROPIC_API_KEY` sits at the repo root. **It is
correctly gitignored** — `.gitignore` has `.env*` with an `!.env*.example` exception — and it is
**not** committed. That part is fine. What's worth attention:

- `scripts/retry-failed.mjs` parses `../.env` by hand and passes the password on the **`psql` command
  line** (`PGPASSWORD="…" psql …`), where it's visible to `ps` and lands in shell history.
- That script interpolates values into SQL strings with only `'`-doubling for `why_it_matters`. It
  uses dollar-quoting correctly for the bulk JSON inserts, but the ad-hoc updates are string-built.

Both are acceptable-ish for a single-developer local maintenance script, and it's clearly written as
one. Worth knowing before it's ever run anywhere shared.

### Smaller items

- `/sign-in` has no sign-up or password-reset path despite the README describing sign-up. Accounts
  are created out-of-band through the Supabase dashboard.
- Lesson tab state never reaches the URL — tabs aren't shareable or back-navigable.
- `Spinner` is defined three times; `StatusTag` re-declares a `STATUS_LABEL` map that already exists
  at module scope in the same file.
- `AppNav` re-runs 3 Supabase queries on every navigation, duplicating the destination page's work.
- No tests of any kind.

---

## 15. Operational notes

### Local setup

```bash
npm install
cp .env.local.example .env.local   # then fill in the three values
npm run dev                        # http://localhost:3000
```

For local dev, turn **off** Supabase → Authentication → Providers → Email → "Confirm email", so
creating an account signs you in immediately with no confirmation email. Re-enable it for production.

Since `/sign-in` has no sign-up UI, create the first account through the Supabase dashboard. The
`handle_new_user` trigger creates the `profiles` row automatically.

### Migration order

Apply in filename order, with two caveats:

1. **Never re-run `006_v2_rebuild.sql`** on a database that has content — it drops tables `CASCADE`.
2. **`008` must be applied after `007`, or instead of it.** Both are idempotent (they truncate and
   reseed), but `007` after `008` regresses text quality. Applying only `008` is fine and preferred.

The textbook files are ~1 MB each — use the CLI, not the web SQL editor, which may hang:

```bash
supabase db push
# or
psql "$DATABASE_URL" -f supabase/migrations/008_textbook_chunks.sql
```

If `create extension vector` fails due to plan restrictions, enable "vector" under Database →
Extensions, or delete that line and the `embedding` column — nothing depends on it.

Verify:

```sql
select count(*) from textbook_chunks;  -- expect 1101
select page, left(content, 80) from search_textbook('processor exemption');
```

### Recovering failed generations

When a lesson shows "Generating" indefinitely, `generated_at` is null. Check for stuck lessons:

```sql
select l.title, length(l.source_content) as chars, l.generation_chunk, count(q.id) as questions
from lessons l left join questions q on q.lesson_id = l.id
where l.generated_at is null and l.source_content != ''
group by l.id, l.title
order by chars desc;
```

Then run the retry script, which **resumes from the stored cursor** rather than restarting (unlike
the UI's Regenerate button):

```bash
node scripts/retry-failed.mjs              # all, small first
node scripts/retry-failed.mjs --large-only # just the big ones
LESSON_ID=<uuid> node scripts/retry-failed.mjs
```

It reads `.env` directly and connects over `psql`, bypassing RLS — so it works regardless of session
state, and it prints per-chunk token usage plus a closing audit.

### Deployment

Vercel, framework preset auto-detected. Set `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `ANTHROPIC_API_KEY` in project settings. Set Supabase →
Authentication → URL Configuration → Site URL to the deployed origin so session cookies work.

---

## 16. Documentation map

Four markdown files exist besides this one. How far each can be trusted:

| File | What it is | Trust |
|---|---|---|
| **`ARCHITECTURE.md`** (this file) | Description of the code as it exists | ✅ Written from source, verified |
| [README.md](README.md) | Setup instructions + product summary | ⚠️ **Mixed.** Setup, deploy, and env-var sections are accurate. The **"Project Structure" section and feature list describe v1** — `learn/`, `flashcards/`, `practice/`, `add-lesson/`, `hooks/`, `lib/leitner.ts`, "Leitner 5-box", "14 achievement badges", "run migrations 001 and 002". None of that exists. |
| [New Features CLAUDE.md](New%20Features%20CLAUDE.md) | The **v2 rebuild spec** | ✅ Accurate as *intent*, and still the best statement of *why* the app is shaped this way — the two-level hierarchy, the immutable source, weighting by exam share, question-quality requirements, and the list of known weak areas to prioritize (TRID tolerance buckets, HOEPA vs. HPML, QM safe harbor bands, MIP vs. PMI). Read it for rationale. It is a spec, not a description — check claims against code. |
| `app/design_handoff_mlo_study_redesign/README.md` | The **visual redesign spec** | ⚠️ Accurate on intent, partly unbuilt. Token names no longer match `globals.css`, and the desktop two-column layouts were never implemented. See the drift table in [§10](#10-design-system). |
| [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md) | Agent instructions (`CLAUDE.md` just includes `AGENTS.md`) | ✅ Standing instruction: this Next.js version diverges from training data — read `node_modules/next/dist/docs/` before writing routing code. |

### Branch history

The shape of the code is easier to read with the rebuild sequence in mind:

```
1e4b771  Initial commit from Create Next App
4b10de9  Build MLO study app with AI-generated content workflow      ← v1
3ccacfd  Replace magic-link auth with email + password
4f396bc  Sidebar scope tree, lesson cards, Why It Matters
428ff22  Three-level Module → Section → Lesson hierarchy             ← abandoned
bf8ae0b  v2 rebuild — two-level schema, SM-2 SRS, weighted progress  ← current data model
b845c87  Derive generation state from DB row via Supabase Realtime
4bdcb92  Warm editorial theme with light + dark mode                 ← superseded
8f8c651  Nocturne dark redesign — all screens, AppNav shell, DS tokens
2e4c3fd  Chunked generation for large lessons with resume support
8f3ec84  Set custom favicon                                         ← HEAD (feat/nocturne-redesign)
```

Three rebuilds in one short history is why the dead-code inventory in [§13](#13-dead--vestigial-code)
is as long as it is: each rebuild added its layer without fully removing the last.
