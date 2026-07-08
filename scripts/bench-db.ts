import autocannon from "autocannon";
import { FLAT_USERS_QUERY, NESTED_FEED_QUERY } from "../src/queries.js";
import { startDbBenchmarkServer } from "./dbServerProcess.js";

interface Case {
	name: string;
	options: autocannon.Options;
}

function graphqlPost(
	url: string,
	query: string,
	variables: Record<string, unknown>,
): autocannon.Options {
	return {
		url,
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ query, variables }),
	};
}

async function runCase(testCase: Case): Promise<autocannon.Result> {
	process.stderr.write(`\n▶ ${testCase.name}\n`);
	return autocannon({
		connections: Number(process.env.CONNECTIONS ?? 25),
		duration: Number(process.env.DURATION ?? 8),
		...testCase.options,
	});
}

function printResult(name: string, result: autocannon.Result): void {
	console.log(
		[
			name.padEnd(32),
			`req/s=${result.requests.average.toFixed(1)}`.padStart(14),
			`lat.avg=${result.latency.average.toFixed(2)}ms`.padStart(18),
			`p99=${result.latency.p99.toFixed(2)}ms`.padStart(14),
			`errors=${result.errors}`.padStart(10),
			`timeouts=${result.timeouts}`.padStart(12),
		].join("  "),
	);
}

async function main(): Promise<void> {
	const server = await startDbBenchmarkServer(Number(process.env.PORT ?? 4001));
	try {
		const flatUsers = Number(process.env.FLAT_USERS ?? 50);
		const nestedUsers = Number(process.env.NESTED_USERS ?? 20);
		const nestedPosts = Number(process.env.NESTED_POSTS ?? 10);
		const nestedComments = Number(process.env.NESTED_COMMENTS ?? 5);

		const cases: Case[] = [
			{
				name: "DB REST flat users",
				options: { url: `${server.baseUrl}/rest/users?limit=${flatUsers}` },
			},
			{
				name: "DB GraphQL flat users",
				options: graphqlPost(`${server.baseUrl}/graphql`, FLAT_USERS_QUERY, {
					limit: flatUsers,
				}),
			},
			{
				name: "DB RPC nested feed",
				options: {
					url: `${server.baseUrl}/rpc/feed?users=${nestedUsers}&posts=${nestedPosts}&comments=${nestedComments}`,
				},
			},
			{
				name: "DB GraphQL nested + DataLoader",
				options: graphqlPost(`${server.baseUrl}/graphql`, NESTED_FEED_QUERY, {
					users: nestedUsers,
					posts: nestedPosts,
					comments: nestedComments,
				}),
			},
			{
				name: "DB GraphQL nested naive",
				options: graphqlPost(
					`${server.baseUrl}/graphql?loader=0`,
					NESTED_FEED_QUERY,
					{
						users: nestedUsers,
						posts: nestedPosts,
						comments: nestedComments,
					},
				),
			},
		];

		console.log(
			`connections=${process.env.CONNECTIONS ?? 25} duration=${process.env.DURATION ?? 8}s`,
		);
		for (const testCase of cases) {
			const result = await runCase(testCase);
			printResult(testCase.name, result);
		}
	} finally {
		await server.stop();
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
