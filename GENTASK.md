# GENTASK.md — Project Handover

Created At 2024-06-04T15:30:00Z

## Project Overview
The goal of this project is to develop a custom SvelteKit adapter for Bun that supports Incremental Static Regeneration (ISR) without relying on third-party production adapters (like `svelte-adapter-bun` or `@eslym/sveltekit-adapter-bun`). This will be achieved by creating a standalone Bun server implementation that integrates SvelteKit's build output and custom caching/revalidation logic.

The project will live within a `./fixtures` directory and will utilize Bun's native tools (`bun`, `bun test`) and SQLite (`fixture.sqlite`) for data simulation.

## Current State
- **Stack:** SvelteKit, Bun, TypeScript, SQLite.
- **Project Structure:** Will be initiated in `./fixtures`.
- **Build Process:** SvelteKit build output will be placed in `.svelte-kit`.
- **Key Components:**
  - Two routes: `/with-isr` and `/without-isr`.
  - Data Layer: Simulated ToDo list managed by `fixture.sqlite`.
- **Implementation Strategy:** The custom adapter must intercept the request flow and handle `export revalidate` logic for ISR, while supporting standard prerendering.
- **Code Quality:** Continuous enforcement of lint, TypeScript, and Biome rules throughout the development cycle.

## Issues Identified
- **Technical Debt/Complexity:** Implementing a custom adapter from scratch is highly complex. It requires deep knowledge of the SvelteKit adapter interface (specifically the factory returning `origin` and `decide`).
- **State Management:** Maintaining consistent state between different build/test cycles requires careful data cleanup of `fixture.sqlite`.
- **Testing:** The testing sequence is highly dependent on timing (waiting 10 seconds for ISR to trigger) and sequential state changes (build -> start -> simulate -> wait -> stop -> rebuild).

## Available Skills
The following agent skills are available and relevant for this task:
- `tdd`: Test-driven development. Use when the user wants to build features or fix bugs test-first, mentions "red-green-refactor", or wants integration tests.
- `find-skills`: Helps users discover and install agent skills when they ask questions like "how do I do X".
- `typescript-expert`: TypeScript and JavaScript expert with deep knowledge of type-level programming, performance optimization, monorepo management, migration strategies, and modern tooling.
- `typescript-advanced-types`: Master TypeScript's advanced type system including generics, conditional types, mapped types, template literals, and utility types for building type-safe applications.
- `shadcn-svelte`: Manages shadcn-svelte components and projects.
- `tailwind-design-system`: Build scalable design systems with Tailwind CSS v4, design tokens, component libraries, and responsive patterns.
- `kysely`: Guidelines for developing with Kysely, a type-safe TypeScript SQL query builder with autocompletion support.
- `postgres-pro`: Optimize PostgreSQL queries, configure replication, or implement advanced database features.
- `skill-creator`: Create new skills, modify and improve existing skills, and measure skill performance.
- `doc-coauthoring`: Guide users through a structured workflow for co-authoring documentation.
- `template-skill`: Reusable template for skills.
- `brand-guidelines`: Applies Anthropic's official brand colors and typography.
- `wrangler`: Cloudflare Workers CLI.
- `taos-tailwind4`: Adding scroll-triggered animations to a SvelteKit + Tailwind CSS project.
- `module-architecture-svelte`: Design features, refactoring, and enforcing separation of concerns in SvelteKit + TypeScript projects.
- `tiptap`: Helps coding agents integrate and work with the Tiptap rich text editor.
- `gentask`: (This skill) How to prepare a comprehensive project handover document (GENTASK.md).
- `bun`: Use when building, testing, or deploying JavaScript/TypeScript applications.
- `biome-developer`: General development best practices and common gotchas when working on Biome.

## Goals
1. Initialize a SvelteKit project in `./fixtures` with the specified build output (`.svelte-kit`).
2. Implement two routes: `/with-isr` (supporting `revalidate: 5`) and `/without-isr` (supporting standard prerendering).
3. Integrate Bun and SQLite (`fixture.sqlite`) to simulate a ToDo list backend.
4. Develop and implement a comprehensive test suite using `bun test` that validates the build, server operation, ISR logic, and data persistence across rebuild cycles.
5. Ensure all code adheres strictly to lint, TypeScript, and Biome best practices.

---

## Instructions for the AI Model

You are receiving this GENTASK.md from a user who wants you to generate a PROMPT.md for an
agentic coding harness (Claude Code, Cursor, etc.). Follow these steps:

1. **Read GENTASK.md carefully.** Understand the project state, issues, and goals.
2. **Generate PROMPT.md.** Once you have all the information you need, create a comprehensive,
 task-by-task PROMPT.md that the user can copy-paste into their agentic harness. Each task
 should be:
 - Clearly scoped and actionable
 - Include verification steps (commands to run, checks to perform)
 - Reference specific files and code locations
 - Follow the project's existing conventions and patterns (Bun, SvelteKit, Biome)
3. **Include a verification checklist** at the end of PROMPT.md so the user can confirm each
 task was completed correctly.

**NOTE TO MODEL:** The primary complexity is the custom adapter implementation. The PROMPT.md must first guide the model through setting up the core Bun server/adapter structure before tackling the business logic and testing.
