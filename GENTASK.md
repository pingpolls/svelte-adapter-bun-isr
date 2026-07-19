# GENTASK.md — Project Handover

Created At 2026-07-19T18:30:00Z

## Project Overview
This project is developing `svelte-adapter-bun-isr`, a custom SvelteKit adapter designed to allow SvelteKit applications to utilize Bun as the build engine while manually implementing Incremental Static Regeneration (ISR) for specific routes, mimicking the functionality of the official SvelteKit Vercel ISR adapter.

## Current State
The project directory contains the library skeleton and configuration files. However, the actual application code (the SvelteKit project inside the `fixtures/` folder) is currently missing implementation. No SvelteKit adapter or ISR logic has been defined.

## Issues Identified
The primary issue is that the target application code needed for analysis is not present in the current directory. This prevents a full understanding of the desired integration points, project conventions, or potential architectural conflicts.

## Available Skills
The following skills are available for use: `biome-developer`, `brand-guidelines`, `bun`, `customize-opencode`, `doc-coauthoring`, `find-skills`, `gentask`, `kysely`, `module-architecture-svelte`, `postgres-pro`, `shadcn-svelte`, `skill-creator`, `svelte-code-writer`, `svelte-core-bestpractices`, `tailwind-design-system`, `taos-tailwind4`, `tdd`, `template-skill`, `tiptap`, `typescript-advanced-types`, `typescript-expert`, and `wrangler`.

## Goals
1.  Create a simple SvelteKit project in the `fixtures` folder.
2.  Implement a custom SvelteKit adapter built with Bun that allows building into a `.svelte-kit` output directory.
3.  Define two routes: `/with-isr` and `/without-isr`.
4.  Configure `/with-isr` to use `prerender=true` and `export revalidate: 5` and `/without-isr` to only use `export prerender = true`.
5.  Integrate Bun testing and Bun SQLite (`fixture.sqlite`) to simulate a simple todo list.
6.  Write a comprehensive test spec using `bun test` that covers:
    -   SvelteKit build success.
    -   Bun start simulation of the application.
    -   Initial check of both pages having an empty todo list.
    -   Simulating adding 3 items.
    -   Verification of both pages being empty (at initial state check).
    -   Waiting 10 seconds.
    -   Verification of 3 items on `/with-isr` (ISR hit).
    -   Verification of 0 items on `/without-isr` (Prerender cache).
    -   Stopping the server.
    -   Rebuilding the project and verifying the todo list has 3 items.
    -   Cleanup of build directories and SQLite records.

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

Please confirm these goals, issues, and the available skills list are accurate before proceeding. The next step is to generate PROMPT.md based on these details.
