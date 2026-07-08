import { INTROSPECTION_PROBE, NESTED_FEED_QUERY } from "../src/queries.js";
import { startBenchmarkServer } from "./serverProcess.js";

async function main(): Promise<void> {
	const server = await startBenchmarkServer(Number(process.env.PORT ?? 4000));
	try {
		const rest = await fetch(`${server.baseUrl}/rest/users?limit=3&debug=1`);
		console.log(
			"REST /rest/users:",
			rest.status,
			rest.headers.get("cache-control"),
		);
		console.log(await rest.text());

		const rpc = await fetch(
			`${server.baseUrl}/rpc/feed?users=2&posts=2&comments=2&debug=1`,
		);
		console.log(
			"\nRPC /rpc/feed:",
			rpc.status,
			rpc.headers.get("cache-control"),
		);
		console.log(await rpc.text());

		const graphql = await fetch(`${server.baseUrl}/graphql`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				query: NESTED_FEED_QUERY,
				variables: { users: 2, posts: 2, comments: 2 },
			}),
		});
		console.log(
			"\nGraphQL nested:",
			graphql.status,
			graphql.headers.get("cache-control"),
		);
		console.log(JSON.stringify(await graphql.json(), null, 2));

		const introspection = await fetch(`${server.baseUrl}/graphql`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query: INTROSPECTION_PROBE }),
		});
		console.log("\nGraphQL introspection probe:", introspection.status);
		console.log(JSON.stringify(await introspection.json(), null, 2));
	} finally {
		await server.stop();
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
