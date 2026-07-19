import { Database } from "bun:sqlite";
import * as path from "node:path";

// Use a consistent path relative to the project root where the fixture runs.
const dbPath = path.resolve(process.cwd(), "fixture.sqlite");
const db = new Database(dbPath, { create: true });

// Initialize the database schema
db.run(
	"CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT)",
);

/**
 * Adds a new todo item to the database.
 * @param {string} text
 */
export function addTodo(text: string) {
	db.run("INSERT INTO todos (text) VALUES (?)", [text]);
}

/**
 * Retrieves all todo items.
 * @returns {Promise<{id: number, text: string}[]>}
 */
export function getTodos() {
	// Using query().all() which is the standard way to fetch all results in bun:sqlite
	return db.query("SELECT id, text FROM todos ORDER BY id DESC").all();
}

/**
 * Clears all todo items.
 */
export function clearTodos() {
	db.run("DELETE FROM todos");
}

export { db };
