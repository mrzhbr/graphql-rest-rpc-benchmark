import { spawn, type ChildProcess } from "node:child_process";

export interface StartedServer {
	baseUrl: string;
	stop(): Promise<void>;
}

async function waitForHealth(
	baseUrl: string,
	timeoutMs = 15_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;

	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${baseUrl}/health`);
			if (response.ok) return;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	throw new Error(
		`DB server at ${baseUrl} did not become healthy. Last error: ${String(lastError)}`,
	);
}

function stopChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null)
		return Promise.resolve();

	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			resolve();
		}, 2_000);

		child.once("exit", () => {
			clearTimeout(timeout);
			resolve();
		});
		child.kill("SIGTERM");
	});
}

export async function startDbBenchmarkServer(
	port = 4001,
): Promise<StartedServer> {
	const baseUrl = `http://localhost:${port}`;

	if (process.env.USE_EXISTING_SERVER === "1") {
		await waitForHealth(baseUrl);
		return { baseUrl, stop: async () => undefined };
	}

	const child = spawn("npm", ["run", "db:dev"], {
		env: { ...process.env, PORT: String(port) },
		stdio: ["ignore", "pipe", "pipe"],
	});

	child.stdout.on("data", (chunk) =>
		process.stderr.write(`[db-server] ${String(chunk)}`),
	);
	child.stderr.on("data", (chunk) =>
		process.stderr.write(`[db-server] ${String(chunk)}`),
	);

	await waitForHealth(baseUrl);
	return {
		baseUrl,
		stop: () => stopChild(child),
	};
}
