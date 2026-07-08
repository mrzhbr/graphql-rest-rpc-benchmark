import { FLAT_USERS_QUERY } from "../src/queries.js";
import { startBenchmarkServer } from "./serverProcess.js";

async function main(): Promise<void> {
	const server = await startBenchmarkServer(Number(process.env.PORT ?? 4000));
	try {
		const restUrl = `${server.baseUrl}/rest/users?limit=10`;
		const firstRest = await fetch(restUrl);
		const etag = firstRest.headers.get("etag");
		const secondRest = await fetch(restUrl, {
			headers: etag ? { "if-none-match": etag } : {},
		});

		console.log("REST URL-addressable cache behavior");
		console.log({
			firstStatus: firstRest.status,
			cacheControl: firstRest.headers.get("cache-control"),
			etag,
			conditionalStatus: secondRest.status,
		});

		const graphqlBody = JSON.stringify({
			query: FLAT_USERS_QUERY,
			variables: { limit: 10 },
		});
		const firstGraphql = await fetch(`${server.baseUrl}/graphql`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: graphqlBody,
		});
		const secondGraphql = await fetch(`${server.baseUrl}/graphql`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: graphqlBody,
		});

		console.log("\nGraphQL POST default behavior");
		console.log({
			firstStatus: firstGraphql.status,
			firstCacheControl: firstGraphql.headers.get("cache-control"),
			firstEtag: firstGraphql.headers.get("etag"),
			secondStatus: secondGraphql.status,
			secondCacheControl: secondGraphql.headers.get("cache-control"),
		});
	} finally {
		await server.stop();
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
