# Reda Logistics

Mobile-first delivery operations app for Reda Logistics. Replaces Google Sheets + Make.com + WhatsApp coordination.

See [`reda_prd.md`](./reda_prd.md), [`reda_system_design_doc.md`](./reda_system_design_doc.md), and [`reda_phased_plan.md`](./reda_phased_plan.md).

## Repo layout

```
.
├── mobile/                  # Expo (React Native) app
├── supabase/
│   ├── functions/           # edge functions (later)
│   └── migrations/          # empty by design — see "Schema workflow" below
├── scripts/
│   └── supabase-cli.mjs     # cross-platform wrapper for `supabase` CLI
├── .github/workflows/       # CI
└── *.md                     # PRD, system design, phased plan
```

## First-time setup

Prereqs: Node 20+, Git.

```bash
# 1. Install root deps (just dotenv-cli + the wrapper helper)
npm install

# 2. Install mobile app deps
cd mobile && npm install && cd ..

# 3. Fill in env files
cp .env.example .env                    # CLI creds (project ref, db password, access token)
cp mobile/.env.example mobile/.env.local # mobile app creds (URL, publishable key)

# 4. Generate TypeScript types from your existing Supabase schema
npm run gen:types
```

## Schema workflow

The Supabase dashboard is the **source of truth** for the schema. Make changes directly in the dashboard's SQL editor.

After any schema change:

```bash
npm run gen:types
```

This regenerates `mobile/src/types/database.gen.ts` so the app stays in sync. Commit the regenerated file alongside whatever code change relied on the new schema.

**Why not git-tracked migrations?** Tried it. Needs Docker on Windows, and for a solo build at this stage the friction outweighs the reproducibility. We can snapshot the schema later with `supabase db pull` once Docker is on the machine.

## Daily commands

```bash
# Mobile app
cd mobile
npm run start       # Expo dev server
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run format      # prettier --write

# After schema change in the Supabase dashboard
npm run gen:types   # from repo root
```

## Conventions

- **Two Supabase projects, never one** (when prod time comes). Dev is what this repo links to. Prod is provisioned separately before cutover (Phase 7 of the plan).
- **Never commit `.env` or `mobile/.env.local`.** Only the `.example` versions live in git.
- **No `sb_secret_…` key in the mobile app.** Publishable key only — RLS enforces access. CI fails the build if it sees `service_role` or `sb_secret_` in `mobile/`.
- **After schema changes:** run `gen:types`, commit the regenerated file with the code change.
