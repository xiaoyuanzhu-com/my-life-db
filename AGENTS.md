# Repository Guidelines

Use this guide to contribute consistently to the Next.js 15 + React 19 + TypeScript local-first app.

## Project Structure & Module Organization
- `src/app` — App Router routes, layouts, pages, API endpoints.
- `src/components` — UI components; shadcn primitives live in `src/components/ui` with lowercase filenames.
- `src/lib` — domain logic (db, fs, ai, task-queue, utils, config); prefer `@/` imports instead of deep relatives.
- `src/types` — shared TypeScript types.
- `docs` — product and technical design docs.
- `public` — static assets served as-is.
- `data/` — gitignored user data; path alias `@/*` points to `./src/*` (e.g., `import { cn } from '@/lib/utils'`).

## Build, Test, and Development Commands
- `npm run dev` — start the Turbopack dev server at http://localhost:3000.
- `npm run build` — produce a production bundle (Turbopack).
- `npm start` — run the built app.
- `npm run lint` — run ESLint (Next core-web-vitals). Example task check: `curl http://localhost:3000/api/tasks/stats`.

## Coding Style & Naming Conventions
- TypeScript strict; 2-space indent, semicolons, single quotes in TS/TSX.
- Components use PascalCase filenames (e.g., `EntryCard.tsx`); hooks and utilities use camelCase.
- Keep imports using `@/` alias; avoid deep relative paths.
- shadcn components follow project CLI: `npx shadcn@latest add <component>`.
- Fix or justify all lint warnings before merge.

## Testing Guidelines
- No runner is bundled yet; prefer Vitest + React Testing Library when adding tests.
- Place tests beside sources or under `src/` as `*.test.ts[x]`.
- Target meaningful coverage for `lib` logic and API handlers; use UI snapshots sparingly.

## Commit & Pull Request Guidelines
- Follow Conventional Commits (e.g., `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`); history examples include `fix(build): ...`.
- PRs should include a clear summary, linked issues, UI screenshots when relevant, API change notes, and doc/README updates.
- Keep PRs small and focused; run `npm run lint` before opening.

## Security & Configuration Tips
- Copy `.env.example` to `.env.local`; `MY_DATA_DIR` defaults to `./data`.
- Never commit `data/` or `.env*` (see `.gitignore`).
- SQLite lives under `MY_DATA_DIR/app/my-life-db/database.sqlite`.

## Agent-Specific Instructions
- Do not commit without explicit approval; permission is required for every commit.
- Use shadcn CLI for new primitives; avoid manual file stubbing.
- Never guess external API contracts; ask for specs when unclear.
