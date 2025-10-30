# Repository Guidelines

This project is a Next.js 15 (App Router) + React 19 + TypeScript app with local-first storage (SQLite + filesystem).

## Project Structure & Module Organization
- `src/app` — routes, layouts, pages, API routes (App Router)
- `src/components` — UI components; primitives in `src/components/ui` follow shadcn patterns
- `src/lib` — domain logic (`db`, `fs`, `ai`, `task-queue`, `utils`, `config`)
- `src/types` — shared TypeScript types
- `docs` — product/technical design docs
- `data/` — user data (gitignored). Path alias: `@/*` → `./src/*` (e.g., `import { cn } from '@/lib/utils'`).

## Build, Test, and Development Commands
- `npm run dev` — start dev server with Turbopack (http://localhost:3000)
- `npm run build` — production build (Turbopack)
- `npm start` — run built app
- `npm run lint` — run ESLint checks
Example: check task queue status `curl http://localhost:3000/api/tasks/stats`.

## Coding Style & Naming Conventions
- TypeScript strict; module resolution via bundler; keep imports using `@/` alias
- Indentation: 2 spaces; semicolons; single quotes in TS/TSX
- Components: PascalCase files (e.g., `EntryCard.tsx`); hooks/functions camelCase
- UI primitives under `components/ui` use shadcn style (lowercase filenames)
- Linting: Flat ESLint config in `eslint.config.mjs` (Next core-web-vitals); fix or justify warnings before merge

## Testing Guidelines
- No test runner configured yet. When adding tests: prefer Vitest + React Testing Library
- Place tests alongside sources or under `src/` with `*.test.ts[x]`
- Aim for meaningful coverage of lib logic and API handlers; snapshot UI sparingly

## Commit & Pull Request Guidelines
- Prefer Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:` (examples in history: `fix(build): ...`)
- PRs must include: clear description, linked issues, screenshots for UI, API change notes, and docs/README updates when applicable
- Keep PRs focused and small; run `npm run lint` before opening

## Security & Configuration Tips
- Environment: copy `.env.example` → `.env.local`. Var: `MY_DATA_DIR` (defaults to `./data`)
- Never commit `data/` or `.env*` (see `.gitignore`)
- SQLite lives under `MY_DATA_DIR/.app/mylifedb/database.sqlite`

## Agent-Specific Instructions
- Do not auto-commit; only commit on explicit request
- Add shadcn components via CLI: `npx shadcn@latest add <component>`
- Avoid deep relative imports; use `@/`
