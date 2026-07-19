# GENTASK.md — Project Handover

Created At Sun Jul 19 2026

## Project Overview
The goal of this project, `svelte-adapter-bun-isr`, is to implement a custom SvelteKit adapter designed to run on Bun. Its primary function is to enable Incremental Static Regeneration (ISR) capabilities within SvelteKit by exporting the `revalidate` constant and managing the revalidation process using Bun, thereby avoiding reliance on the official Vercel adapter.

## Current State
*   **Project Structure:** The library resides in `svelte-adapter-bun-isr`. Fixtures for testing are located in the `fixtures/` subdirectory.
*   **Technology Stack:** SvelteKit, Bun (runtime/bundler), TypeScript, SQLite (via `fixture.sqlite`).
*   **Development Rules:** All lint, TypeScript, and Biome issues must be resolved immediately.
*   **Reference:** The implementation should consider existing capabilities in @risk-tolerance/svelte-adapter-bun and address known issues in SvelteKit regarding ISR/build output (e.g., sveltejs/kit#661).

## Issues Identified
*   The core challenge lies in creating a Bun-based mechanism to handle the time-based revalidation logic that SvelteKit's ISR requires.
*   The testing process involves simulating a server environment (bun start) and managing time-based checks (waiting 10 seconds for revalidation).
*   Database management is required using SQLite within the fixture setup to simulate data persistence during revalidation cycles.

## Available Skills
*   `biome-developer`: General development best practices and common gotchas when working on Biome.
*   `brand-guidelines`: Applies Anthropic's official brand colors and typography.
*   `bun`: Use when building, testing, or deploying JavaScript/TypeScript applications with Bun.
*   `customize-opencode`: Use when editing or creating opencode's own configuration.
*   `doc-coauthoring`: Guide users through a structured workflow for co-authoring documentation.
*   `find-skills`: Helps users discover and install agent skills.
*   `gentask`: How to prepare a comprehensive project handover document.
*   `kysely`: Guidelines for developing with Kysely, a type-safe TypeScript SQL query builder.
*   `module-architecture-svelte`: Use when designing new features or reviewing code structure in SvelteKit.
*   `postgres-pro`: Use when optimizing PostgreSQL queries (relevant for database concepts).
*   `shadcn-svelte`: Manages shadcn-svelte components and projects.
*   `skill-creator`: Create new skills.
*   `svelte-code-writer`: CLI tools for Svelte 5 documentation lookup and code analysis.
*   `svelte-core-bestpractices`: Guidance on writing fast, robust, modern Svelte code.
*   `tailwind-design-system`: Build scalable design systems with Tailwind CSS v4.
*   `taos-tailwind4`: Adding scroll-triggered animations using TAOS.
*   `tdd`: Test-driven development.
*   `tiptap`: Helps coding agents integrate with the Tiptap rich text editor.
*   `typescript-advanced-types`: Master TypeScript's advanced type system.
*   `typescript-expert`: TypeScript and JavaScript expert with deep knowledge of type-level programming.
*   `wrangler`: Cloudflare Workers CLI for deployment and management.

## Goals
1. Implement a custom SvelteKit adapter for Bun that enables ISR.
2. Create fixtures, including a simple SvelteKit project in `fixtures/`.
3. Implement two routes: `/without-isr` (standard prerendering) and `/with-isr` (custom ISR).
4. Ensure the custom logic handles revalidation using Bun for the `/with-isr` route.
5. Implement Bun tests covering the entire ISR flow: build, start, initial state check (empty), simulate activity (add 3 items to SQLite), wait 10 seconds, check revalidation state (3 items visible on `/with-isr`), stop server, rebuild, and verify final state (3 items on both pages).
6. Cleanup: Remove build directories and clear `fixture.sqlite` after testing.
7. Maintain project quality by ensuring all lint and type errors are fixed during development.

---

## Instructions for the AI Model

You are receiving this GENTASK.md from a user who wants you to generate a PROMPT.md for an agentic coding harness (Claude Code, Cursor, etc.). Follow these steps:

1. **Read GENTASK.md carefully.** Understand the project state, issues, and goals.
2. **Generate PROMPT.md.** Once you have all the information you need, create a comprehensive, task-by-task PROMPT.md that the user can copy-paste into their agentic harness. Each task should be:
   - Clearly scoped and actionable
   - Include verification steps (commands to run, checks to perform)
   - Reference specific files and code locations
   - Follow the project's existing conventions and patterns
3. **Include a verification checklist** at the end of PROMPT.md so the user can confirm each task was completed correctly.
