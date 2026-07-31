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

# 4. Generate TypeScript types from the schema (read the caveat under
#    "Schema workflow" first — this currently targets the old Cloud project)
npm run gen:types
```

## Schema workflow

The **self-hosted box is the source of truth** for the schema. Studio is stopped there (trimmed to free memory), so there is no SQL editor — apply changes with `psql` inside the database container:

```bash
scp scripts/your-change.sql root@<box>:/tmp/
ssh root@<box> 'docker cp /tmp/your-change.sql supabase-db:/tmp/ \
  && docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f /tmp/your-change.sql'
```

Changes live as idempotent `create or replace` scripts in `scripts/` (untracked — they are working files, not history). Wrap each in `begin; … rollback;` with `commit;` commented out, so the first run is a dry run you can read before committing it. Capture the previous definition into `tools/live-defs/` first — that directory _is_ tracked, and it is the only record of what a function looked like before you changed it.

After any schema change, `mobile/src/types/database.gen.ts` needs to match:

```bash
npm run gen:types
```

> ⚠️ **`gen:types` is currently pointed at the wrong database.** It runs `supabase gen types --project-id $SUPABASE_PROJECT_REF`, which is the decommissioned Cloud project, and `>`-redirects over the types file — so it truncates the target _before_ the CLI runs. If Cloud still answers you get types for the wrong database; if it has been deleted you get an empty file. The types are already ~38 functions behind the box, which is why `rpcUntyped()` exists in `mobile/src/lib/supabase.ts`. Until this is repointed at the box (`--db-url` over an SSH tunnel, since the box does not publish 5432), either hand-add the changed signatures or call through `rpcUntyped`.

Commit the updated types file alongside whatever code change relied on the new schema.

**Why not git-tracked migrations?** Tried it. Needs Docker on Windows, and for a solo build at this stage the friction outweighs the reproducibility. We can snapshot the schema later with `supabase db pull` once Docker is on the machine.

## Daily commands

```bash
# Mobile app
cd mobile
npm run start       # Expo dev server
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run format      # prettier --write

# After a schema change on the box — see the gen:types caveat above
npm run gen:types   # from repo root
```

## Conventions

- **Two Supabase projects, never one** (when prod time comes). Dev is what this repo links to. Prod is provisioned separately before cutover (Phase 7 of the plan).
- **Never commit `.env` or `mobile/.env.local`.** Only the `.example` versions live in git.
- **No `sb_secret_…` key in the mobile app.** Publishable key only — RLS enforces access. CI fails the build if it sees `service_role` or `sb_secret_` in `mobile/`.
- **After schema changes:** run `gen:types`, commit the regenerated file with the code change.
