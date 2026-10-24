// Load-test the fixture app with wrk, one scenario after another, then print a summary.
//   bun run stress
// Env: STRESS_DURATION (seconds, default 60), STRESS_CPUS (workers, default 2),
//      STRESS_THREADS (wrk threads, default 4), STRESS_CONNECTIONS (default 512),
//      STRESS_PORT (default 3100), STRESS_SKIP_BUILD=1 (reuse fixtures/build)
import { rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const fixtures = join(root, "fixtures");
const num = (name: string, fallback: number) =>
	Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback;
const DURATION = num("STRESS_DURATION", 60);
const CPUS = num("STRESS_CPUS", 2);
const THREADS = num("STRESS_THREADS", 4);
const CONNECTIONS = num("STRESS_CONNECTIONS", 512);
const PORT = num("STRESS_PORT", 3100);
const base = `http://127.0.0.1:${PORT}`;

const scenarios = [
	{ name: "SSR, no caching", path: "/ssr/page", status: 200 },
	{ name: "SSR, trivial load", path: "/ssr/trivial", status: 200 },
	{ name: "SSR, ssrCache (2s)", path: "/ssr/cached", status: 200 },
	{ name: "SSG, prerendered", path: "/no-isr/page", status: 200 },
	{ name: "ISR, prerender = auto", path: "/isr/page", status: 200 },
	{ name: "Static asset", path: "/favicon.png", status: 200 },
	{ name: "Interceptor, honeypot (451)", path: "/wp-login.php", status: 451 },
	{ name: "Interceptor, shared rate limit", path: "/limited", status: 200 },
] as const;

function run(cmd: string[], label: string) {
	const result = Bun.spawnSync({
		cmd,
		cwd: fixtures,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(`[${label}] failed:\n${result.stderr.toString()}`);
	}
}

if (!Bun.which("wrk")) throw new Error("wrk is required: install it first");

if (process.env.STRESS_SKIP_BUILD !== "1") {
	console.log("Building fixtures...");
	rmSync(join(fixtures, "build"), { recursive: true, force: true });
	rmSync(join(fixtures, "db.sqlite"), { force: true });
	run(["bun", "run", "--bun", "prepare"], "prepare");
	run(["bun", "src/scripts/prep.ts"], "migrate");
	run(["bun", "run", "--bun", "build"], "build");
}

const server = Bun.spawn({
	cmd: ["bun", "build/index.js"],
	cwd: fixtures,
	// The SSR route logs on every request; at benchmark rates that would dominate.
	stdout: "ignore",
	stderr: "inherit",
	env: {
		...process.env,
		PORT: String(PORT),
		HOST: "127.0.0.1",
		CPUS: String(CPUS),
	},
});

async function cleanup() {
	server.kill();
	await server.exited;
}
process.on("SIGINT", () => cleanup().then(() => process.exit(130)));

type Result = {
	name: string;
	rps: number;
	avg: string;
	p99: string;
	errors: number;
};
const results: Result[] = [];

try {
	for (let i = 0; ; i++) {
		if (i === 100) throw new Error("server did not become ready");
		try {
			if ((await fetch(`${base}/no-isr/page`)).ok) break;
		} catch {}
		await Bun.sleep(100);
	}

	console.log(
		`\n${CPUS} worker(s), wrk ${THREADS} threads / ${CONNECTIONS} connections / ${DURATION}s per scenario\n`,
	);
	for (const scenario of scenarios) {
		const probe = await fetch(base + scenario.path);
		if (probe.status !== scenario.status) {
			throw new Error(
				`${scenario.path} answered ${probe.status}, expected ${scenario.status}`,
			);
		}
		await probe.arrayBuffer();

		process.stdout.write(`${scenario.name} (${scenario.path}) ... `);
		const wrk = Bun.spawnSync({
			cmd: [
				"wrk",
				`-t${THREADS}`,
				`-c${CONNECTIONS}`,
				`-d${DURATION}s`,
				"--latency",
				base + scenario.path,
			],
			stdout: "pipe",
			stderr: "pipe",
		});
		const out = wrk.stdout.toString();
		const rps = Number(out.match(/Requests\/sec:\s+([\d.]+)/)?.[1]);
		if (!Number.isFinite(rps))
			throw new Error(`wrk failed:\n${out}${wrk.stderr}`);
		// Responses that are not the scenario's expected status (451 is expected for the honeypot).
		const non2xx = Number(
			out.match(/Non-2xx or 3xx responses:\s+(\d+)/)?.[1] ?? 0,
		);
		const sockets = out.match(
			/Socket errors: connect (\d+), read (\d+), write (\d+), timeout (\d+)/,
		);
		const result = {
			name: scenario.name,
			rps,
			avg: out.match(/Latency\s+(\S+)/)?.[1] ?? "?",
			p99: out.match(/99%\s+(\S+)/)?.[1] ?? "?",
			errors:
				(scenario.status === 200 ? non2xx : 0) +
				(sockets ? sockets.slice(1).reduce((a, b) => a + Number(b), 0) : 0),
		};
		results.push(result);
		console.log(
			`${Math.round(rps).toLocaleString("en")} req/s · ${result.avg} avg`,
		);
	}
} finally {
	await cleanup();
	rmSync(join(fixtures, "db.sqlite"), { force: true });
}

console.log(
	`\n| Scenario | Req/s | Avg latency | p99 | Errors |\n|---|---|---|---|---|`,
);
for (const r of results) {
	console.log(
		`| ${r.name} | ${Math.round(r.rps).toLocaleString("en")} | ${r.avg} | ${r.p99} | ${r.errors} |`,
	);
}
