import { Database } from "bun:sqlite";
import * as path from "node:path";
import type { Todo } from "$src/app";

// Use a consistent path relative to the project root where the fixture runs.
const dbPath = path.resolve(process.cwd(), "db.sqlite");
const db = new Database(dbPath, { create: true });

// Initialize the database schema
db.run(
	"CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, slug TEXT)",
);

function slugify(text: string): string {
	return text.trim().replace(/\s+/g, " ").replace(/ /g, "-").toLowerCase();
}

export function addTodo(text: string) {
	const slug = slugify(text);

	db.run("INSERT INTO todos (text, slug) VALUES (?, ?)", [text, slug]);
}

export function getTodos() {
	// Using query().all() which is the standard way to fetch all results in bun:sqlite
	return db
		.query("SELECT id, text, slug FROM todos ORDER BY id DESC")
		.all() as Todo[];
}

export function getTodo(id: number) {
	return db
		.prepare(`SELECT id, text, slug FROM todos WHERE id = ?`)
		.all(id)
		.at(0) as Todo | undefined;
}

export function getTodoFromSlug(slug: string) {
	return db
		.prepare(`SELECT id, text, slug FROM todos WHERE slug = ?`)
		.all(slug)
		.at(0) as Todo | undefined;
}

/**
 * Clears all todo items.
 */
export function clearTodos() {
	db.run("DELETE FROM todos; delete from sqlite_sequence where name='todos';");
}

export { db };
