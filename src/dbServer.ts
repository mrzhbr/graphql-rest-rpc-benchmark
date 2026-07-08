import express, { type Request, type Response } from "express";
import {
	defaultFieldResolver,
	execute,
	Kind,
	NoSchemaIntrospectionCustomRule,
	parse,
	specifiedRules,
	validate,
	type DocumentNode,
	type FragmentDefinitionNode,
	type GraphQLResolveInfo,
	type SelectionSetNode,
	type ValidationRule,
} from "graphql";
import type { Comment, User } from "./data.js";
import { closePool, pingDatabase } from "./db.js";
import {
	createPgLoaders,
	createPgSchema,
	type PgGraphQLContext,
} from "./pgGraphqlSchema.js";
import { createPgStore, type DbPost } from "./pgStore.js";

const PORT = Number(process.env.PORT ?? 4001);
const MAX_GRAPHQL_DEPTH = Number(process.env.MAX_GRAPHQL_DEPTH ?? 6);
const ALLOW_INTROSPECTION = process.env.ALLOW_INTROSPECTION === "1";

type Role = "user" | "admin";
type PublicUser = Pick<User, "id" | "name" | "plan"> &
	Partial<Pick<User, "email">>;

const store = createPgStore();
const schema = createPgSchema();
const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

function firstQueryParam(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && typeof value[0] === "string") return value[0];
	return undefined;
}

function numberQueryParam(
	req: Request,
	name: string,
	fallback: number,
): number {
	const raw = firstQueryParam(req.query[name]);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	return Number.isFinite(value) ? value : fallback;
}

function roleFromRequest(req: Request): Role {
	return req.header("x-role") === "admin" ? "admin" : "user";
}

function serializeUser(user: User, role: Role = "user"): PublicUser {
	return {
		id: user.id,
		name: user.name,
		plan: user.plan,
		...(role === "admin" ? { email: user.email } : {}),
	};
}

function maxDepthFromSelection(
	selectionSet: SelectionSetNode | undefined,
	fragments: ReadonlyMap<string, FragmentDefinitionNode>,
	seenFragments = new Set<string>(),
): number {
	if (!selectionSet) return 0;

	let maxDepth = 0;
	for (const selection of selectionSet.selections) {
		if (selection.kind === Kind.FIELD) {
			maxDepth = Math.max(
				maxDepth,
				1 +
					maxDepthFromSelection(
						selection.selectionSet,
						fragments,
						seenFragments,
					),
			);
		} else if (selection.kind === Kind.INLINE_FRAGMENT) {
			maxDepth = Math.max(
				maxDepth,
				maxDepthFromSelection(selection.selectionSet, fragments, seenFragments),
			);
		} else if (selection.kind === Kind.FRAGMENT_SPREAD) {
			const fragmentName = selection.name.value;
			if (seenFragments.has(fragmentName)) continue;
			const fragment = fragments.get(fragmentName);
			if (fragment) {
				seenFragments.add(fragmentName);
				maxDepth = Math.max(
					maxDepth,
					maxDepthFromSelection(
						fragment.selectionSet,
						fragments,
						seenFragments,
					),
				);
				seenFragments.delete(fragmentName);
			}
		}
	}
	return maxDepth;
}

function maxOperationDepth(document: DocumentNode): number {
	const fragments = new Map<string, FragmentDefinitionNode>();
	for (const definition of document.definitions) {
		if (definition.kind === Kind.FRAGMENT_DEFINITION)
			fragments.set(definition.name.value, definition);
	}

	return Math.max(
		0,
		...document.definitions
			.filter((definition) => definition.kind === Kind.OPERATION_DEFINITION)
			.map((definition) =>
				maxDepthFromSelection(definition.selectionSet, fragments),
			),
	);
}

async function executeGraphQL(req: Request, res: Response): Promise<void> {
	const started = process.hrtime.bigint();
	const query =
		req.method === "GET" ? firstQueryParam(req.query.query) : req.body?.query;
	const variables =
		req.method === "GET"
			? parseJsonParam(firstQueryParam(req.query.variables))
			: req.body?.variables;
	const operationName =
		req.method === "GET"
			? firstQueryParam(req.query.operationName)
			: req.body?.operationName;

	if (typeof query !== "string") {
		res
			.status(400)
			.json({ errors: [{ message: "Expected GraphQL query string." }] });
		return;
	}

	let document: DocumentNode;
	try {
		document = parse(query);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "GraphQL parse error.";
		res.status(400).json({ errors: [{ message }] });
		return;
	}

	const depth = maxOperationDepth(document);
	if (depth > MAX_GRAPHQL_DEPTH) {
		res.status(400).json({
			errors: [
				{
					message: `Query depth ${depth} exceeds max depth ${MAX_GRAPHQL_DEPTH}.`,
				},
			],
		});
		return;
	}

	const validationRules: readonly ValidationRule[] = ALLOW_INTROSPECTION
		? specifiedRules
		: [...specifiedRules, NoSchemaIntrospectionCustomRule];
	const validationErrors = validate(schema, document, validationRules);
	if (validationErrors.length > 0) {
		res.status(400).json({
			errors: validationErrors.map((error) => ({ message: error.message })),
		});
		return;
	}

	store.resetStats();
	const useLoaders = firstQueryParam(req.query.loader) !== "0";
	const contextValue: PgGraphQLContext = {
		role: roleFromRequest(req),
		store,
		maxUsersLimit: 500,
		maxPostLimit: 100,
		maxCommentLimit: 50,
		loaders: useLoaders ? createPgLoaders(store) : null,
		metrics: { rootResolvers: 0, fieldResolvers: 0, defaultFieldResolvers: 0 },
	};

	const result = await execute({
		schema,
		document,
		variableValues: variables,
		operationName,
		contextValue,
		fieldResolver(
			source: unknown,
			args: Record<string, unknown>,
			ctx: PgGraphQLContext,
			info: GraphQLResolveInfo,
		) {
			ctx.metrics.defaultFieldResolvers += 1;
			return defaultFieldResolver(source, args, ctx, info);
		},
	});

	const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
	res.set("Cache-Control", "no-store");
	res.json({
		...result,
		extensions: {
			...result.extensions,
			depth,
			loaders: useLoaders,
			elapsedMs: Number(elapsedMs.toFixed(3)),
			resolverMetrics: contextValue.metrics,
			dataStore: store.stats(),
		},
	});
}

function parseJsonParam(value: string | undefined): unknown {
	if (value === undefined || value === "") return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function getCommentGroupsByPostId(
	posts: readonly DbPost[],
	groups: readonly Comment[][],
): Map<string, Comment[]> {
	const grouped = new Map<string, Comment[]>();
	posts.forEach((post, index) => grouped.set(post.id, groups[index] ?? []));
	return grouped;
}

app.get("/health", async (_req, res) => {
	res.json({ ok: await pingDatabase() });
});

app.get("/rest/users", async (req, res) => {
	store.resetStats();
	const limit = Math.min(numberQueryParam(req, "limit", 50), 500);
	const users = (await store.listUsers(limit)).map((user) =>
		serializeUser(user, roleFromRequest(req)),
	);
	res.set("Cache-Control", "no-store");
	res.json({ users, _dataStore: store.stats() });
});

app.get("/rpc/feed", async (req, res) => {
	store.resetStats();
	const role = roleFromRequest(req);
	const userLimit = Math.min(numberQueryParam(req, "users", 20), 500);
	const postLimit = Math.min(numberQueryParam(req, "posts", 10), 100);
	const commentLimit = Math.min(numberQueryParam(req, "comments", 5), 50);

	const users = await store.listUsers(userLimit);
	const postsByUser = await store.getPostsByUserIds(
		users.map((user) => user.id),
		postLimit,
	);
	const allPosts = postsByUser.flat();
	const commentsByPost = await store.getCommentsByPostIds(
		allPosts.map((post) => post.id),
		commentLimit,
	);
	const commentsByPostId = getCommentGroupsByPostId(allPosts, commentsByPost);
	const allComments = commentsByPost.flat();
	const authorsById = new Map(
		(await store.getUsersByIds(allComments.map((comment) => comment.authorId)))
			.filter((author): author is User => author !== null)
			.map((author) => [author.id, serializeUser(author, role)]),
	);

	const payload = {
		users: users.map((user, userIndex) => ({
			...serializeUser(user, role),
			posts: (postsByUser[userIndex] ?? []).map((post) => ({
				id: post.id,
				title: post.title,
				comments: (commentsByPostId.get(post.id) ?? []).map((comment) => ({
					id: comment.id,
					body: comment.body,
					author: authorsById.get(comment.authorId) ?? null,
				})),
			})),
		})),
	};

	res.set("Cache-Control", "no-store");
	res.json({ ...payload, _dataStore: store.stats() });
});

app.get("/graphql", executeGraphQL);
app.post("/graphql", executeGraphQL);

app.use((req, res) => {
	res.status(404).json({ error: "not_found", path: req.path });
});

const server = app.listen(PORT, () => {
	console.log(`Postgres benchmark API listening on http://localhost:${PORT}`);
});

async function shutdown(): Promise<void> {
	server.close(async () => {
		await closePool();
		process.exit(0);
	});
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
