import { Database } from "bun:sqlite";
import * as path from "node:path";
import type { Todo } from "$src/app";

// Use a consistent path relative to the project root where the fixture runs.
const dbPath = path.resolve(process.cwd(), "db.sqlite");
const db = new Database(dbPath, { create: true });

// Initialize the database schema
db.run(
	"CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT)",
);

export function addTodo(text: string) {
	db.run("INSERT INTO todos (text) VALUES (?)", [text]);
}

export function getTodos() {
	// Using query().all() which is the standard way to fetch all results in bun:sqlite
	return db
		.query("SELECT id, text FROM todos ORDER BY id DESC")
		.all() as Todo[];
}

export function getTodo(id: number) {
	return db.prepare(`SELECT id, text FROM todos WHERE id = ?`).all(id).at(0) as
		| Todo
		| undefined;
}

/**
 * Clears all todo items.
 */
export function clearTodos() {
	db.run("DELETE FROM todos; delete from sqlite_sequence where name='todos';");
}

export { db };
