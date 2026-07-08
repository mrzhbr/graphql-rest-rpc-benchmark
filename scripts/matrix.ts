import { mkdir, writeFile } from "node:fs/promises";
import autocannon from "autocannon";
import { NESTED_FEED_QUERY } from "../src/queries.js";
import { startBenchmarkServer } from "./serverProcess.js";

interface Scenario {
	users: number;
	posts: number;
	comments: number;
}

interface Variant {
	name: string;
	request(baseUrl: string, scenario: Scenario): autocannon.Options;
}

interface Row {
	scenario: Scenario;
	variant: string;
	requestsPerSecond: number;
	averageLatencyMs: number;
	p99LatencyMs: number;
	errors: number;
	timeouts: number;
}

const DEFAULT_SCENARIOS: Scenario[] = [
	{ users: 5, posts: 5, comments: 3 },
	{ users: 20, posts: 10, comments: 5 },
	{ users: 50, posts: 10, comments: 5 },
	{ users: 50, posts: 20, comments: 8 },
];

const VARIANTS: Variant[] = [
	{
		name: "RPC nested feed",
		request(baseUrl, scenario) {
			return {
				url: `${baseUrl}/rpc/feed?users=${scenario.users}&posts=${scenario.posts}&comments=${scenario.comments}`,
			};
		},
	},
	{
		name: "GraphQL DataLoader",
		request(baseUrl, scenario) {
			return graphqlRequest(`${baseUrl}/graphql`, scenario);
		},
	},
	{
		name: "GraphQL naive",
		request(baseUrl, scenario) {
			return graphqlRequest(`${baseUrl}/graphql?loader=0`, scenario);
		},
	},
];

function graphqlRequest(url: string, scenario: Scenario): autocannon.Options {
	return {
		url,
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			query: NESTED_FEED_QUERY,
			variables: {
				users: scenario.users,
				posts: scenario.posts,
				comments: scenario.comments,
			},
		}),
	};
}

async function runVariant(
	baseUrl: string,
	scenario: Scenario,
	variant: Variant,
): Promise<Row> {
	process.stderr.write(
		`▶ ${variant.name} users=${scenario.users} posts=${scenario.posts} comments=${scenario.comments}\n`,
	);
	const result = await autocannon({
		connections: Number(process.env.CONNECTIONS ?? 10),
		duration: Number(process.env.DURATION ?? 5),
		...variant.request(baseUrl, scenario),
	});

	return {
		scenario,
		variant: variant.name,
		requestsPerSecond: result.requests.average,
		averageLatencyMs: result.latency.average,
		p99LatencyMs: result.latency.p99,
		errors: result.errors,
		timeouts: result.timeouts,
	};
}

function scenarioLabel({ users, posts, comments }: Scenario): string {
	return `${users} users × ${posts} posts × ${comments} comments`;
}

function markdownTable(rows: readonly Row[]): string {
	const lines = [
		"| Scenario | Variant | Req/s | Avg latency | P99 latency | Errors | Timeouts |",
		"| --- | --- | ---: | ---: | ---: | ---: | ---: |",
	];

	for (const row of rows) {
		lines.push(
			`| ${scenarioLabel(row.scenario)} | ${row.variant} | ${row.requestsPerSecond.toFixed(1)} | ${row.averageLatencyMs.toFixed(2)} ms | ${row.p99LatencyMs.toFixed(2)} ms | ${row.errors} | ${row.timeouts} |`,
		);
	}

	return lines.join("\n");
}

function ratiosTable(rows: readonly Row[]): string {
	const lines = [
		"| Scenario | RPC / GraphQL DataLoader throughput | DataLoader / naive throughput |",
		"| --- | ---: | ---: |",
	];

	for (const scenario of DEFAULT_SCENARIOS) {
		const matching = rows.filter(
			(row) =>
				row.scenario.users === scenario.users &&
				row.scenario.posts === scenario.posts &&
				row.scenario.comments === scenario.comments,
		);
		const rpc = matching.find((row) => row.variant === "RPC nested feed");
		const loader = matching.find((row) => row.variant === "GraphQL DataLoader");
		const naive = matching.find((row) => row.variant === "GraphQL naive");

		lines.push(
			`| ${scenarioLabel(scenario)} | ${ratio(rpc?.requestsPerSecond, loader?.requestsPerSecond)} | ${ratio(loader?.requestsPerSecond, naive?.requestsPerSecond)} |`,
		);
	}

	return lines.join("\n");
}

function ratio(left: number | undefined, right: number | undefined): string {
	if (!left || !right) return "n/a";
	return `${(left / right).toFixed(2)}×`;
}

async function main(): Promise<void> {
	const server = await startBenchmarkServer(Number(process.env.PORT ?? 4000));
	try {
		const rows: Row[] = [];
		for (const scenario of DEFAULT_SCENARIOS) {
			for (const variant of VARIANTS) {
				rows.push(await runVariant(server.baseUrl, scenario, variant));
			}
		}

		const timestamp = new Date().toISOString().replaceAll(":", "-");
		const outputPath = `results/matrix-${timestamp}.md`;
		const markdown = `# Benchmark matrix\n\nconnections=${process.env.CONNECTIONS ?? 10} duration=${process.env.DURATION ?? 5}s\n\n## Results\n\n${markdownTable(rows)}\n\n## Ratios\n\n${ratiosTable(rows)}\n`;

		await mkdir("results", { recursive: true });
		await writeFile(outputPath, markdown);
		console.log(markdown);
		console.log(`\nWrote ${outputPath}`);
	} finally {
		await server.stop();
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
