# AGENTS.md

rentalio — pnpm monorepo (Node 26.13.0, pnpm 12.18.0).

## Layout

- `apps/api` — NestJS + Prisma + PostgreSQL + S3 + Resend
- `apps/web`, `apps/admin` — Next.js 16 + React 19 + zod
- `database` — Prisma schema and migrations
- `packages/*`, `tests/*`, `scripts/*`, `docs/openapi.yaml`

## Commands

Prefer single-package commands over workspace-wide ones.

- Dev: `pnpm dev` | `pnpm api:dev` | `pnpm web:dev` | `pnpm admin:dev`
- Per package: `pnpm --filter @rentalio/<pkg> test|typecheck|lint|build`
- DB: `pnpm db:generate` | `pnpm db:migrate:dev` | `pnpm db:migrate`

## Context discipline

- `README.md` is ~63 KB. Never read it whole — grep for the section needed first.
- Prefer `grep`/`glob`; read only the needed line range with `offset`/`limit`.
- Do not re-read a file already read this session unless it changed.
- Filter command output (grep/`Select-String`, head/tail); avoid `pnpm -r` builds and full logs.
- Skip `node_modules/`, `pnpm-lock.yaml`, `screenshots/`, `.dev-logs/`, `.backups/` unless asked.
- Never print `.env` contents or secrets; use `.env.example` as reference.
- Keep replies short: no full-file dumps, no restating code.
