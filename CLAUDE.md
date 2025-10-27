# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Next.js 15.5.5 application with TypeScript, React 19, and Tailwind CSS 4. It uses the App Router architecture (not Pages Router).

## Common Commands

### Development
- `npm run dev` - Start development server with Turbopack (runs on http://localhost:3000)
- `npm run build` - Build production application with Turbopack
- `npm start` - Start production server (must run `npm run build` first)
- `npm run lint` - Run ESLint to check code quality

### Important Build Details
- This project uses **Turbopack** as the bundler (specified in build and dev scripts)
- TypeScript strict mode is enabled
- ESLint uses Next.js config with `next/core-web-vitals` and `next/typescript` presets

## Architecture

### Data Storage
- Uses SQLite for settings persistence
- Database location: `MY_DATA_DIR/.app/mylifedb/database.sqlite`
- `MY_DATA_DIR` environment variable sets the base data directory (defaults to `./data`)
- Database is automatically created and initialized on first use
- Uses `better-sqlite3` for synchronous database operations

### App Router Structure
- Uses Next.js App Router located in `src/app/`
- Root layout in `src/app/layout.tsx` handles:
  - Geist font loading (sans and mono variants)
  - Global CSS imports
  - HTML structure with font CSS variables
- Main page is `src/app/page.tsx`

### Styling
- Tailwind CSS 4 with PostCSS plugin (`@tailwindcss/postcss`)
- Global styles in `src/app/globals.css` with:
  - CSS custom properties for theming (`--background`, `--foreground`)
  - Automatic dark mode via `prefers-color-scheme`
  - Tailwind theme inline configuration with font variables
- Geist font family used via CSS variables (`--font-geist-sans`, `--font-geist-mono`)

### UI Components (shadcn/ui)
**IMPORTANT:** This project uses shadcn/ui components. Follow these rules:

1. **Adding New Components**:
   - ALWAYS use the official shadcn CLI: `npx shadcn@latest add <component-name>`
   - Example: `npx shadcn@latest add tabs`
   - NEVER create shadcn components manually

2. **Available Components**: Check https://ui.shadcn.com/docs/components for available components

3. **Why Use CLI**:
   - Automatically installs required dependencies (e.g., @radix-ui packages)
   - Ensures correct component structure and styling
   - Maintains consistency with project configuration

### TypeScript Configuration
- Path alias: `@/*` maps to `./src/*`
- Module resolution: bundler
- Strict mode enabled
- Target: ES2017

### ESLint Configuration
- Uses flat config format (eslint.config.mjs)
- Ignores: `node_modules`, `.next`, `out`, `build`, `next-env.d.ts`

## Development Server

**IMPORTANT:** Do NOT run `npm run dev` in the terminal. The user already has a development server running. Assume the server is always running at http://localhost:3000.

## Git Workflow

**IMPORTANT:** Do NOT create git commits automatically. Only commit when explicitly instructed by the user with commands like "commit it" or "commit this".

## Design Preferences

- **Minimal Borders**: Avoid using too many dividers and borders in the UI. Keep the design clean and minimal.
