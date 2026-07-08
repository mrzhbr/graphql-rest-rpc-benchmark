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
import { createDataStore, type Comment, type Post, type User } from "./data.js";
import {
	createLoaders,
	createSchema,
	type GraphQLContext,
} from "./graphqlSchema.js";
import { sendCacheableJson } from "./httpCache.js";

const PORT = Number(process.env.PORT ?? 4000);
const MAX_GRAPHQL_DEPTH = Number(process.env.MAX_GRAPHQL_DEPTH ?? 6);
const ALLOW_INTROSPECTION = process.env.ALLOW_INTROSPECTION === "1";
const DEFAULT_POST_LIMIT = Number(process.env.DEFAULT_POST_LIMIT ?? 10);
const DEFAULT_COMMENT_LIMIT = Number(process.env.DEFAULT_COMMENT_LIMIT ?? 5);

type Role = "user" | "admin";

type PublicUser = Pick<User, "id" | "name" | "plan"> &
	Partial<Pick<User, "email">>;

const store = createDataStore();
const schema = createSchema();
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
		res
			.status(400)
			.json({
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
		res
			.status(400)
			.json({
				errors: validationErrors.map((error) => ({ message: error.message })),
			});
		return;
	}

	store.resetStats();
	const useLoaders = firstQueryParam(req.query.loader) !== "0";
	const contextValue: GraphQLContext = {
		role: roleFromRequest(req),
		store,
		defaultPostLimit: DEFAULT_POST_LIMIT,
		defaultCommentLimit: DEFAULT_COMMENT_LIMIT,
		maxUsersLimit: 200,
		maxPostLimit: 50,
		maxCommentLimit: 25,
		loaders: useLoaders ? createLoaders(store) : null,
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
			ctx: GraphQLContext,
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

function includeDebug<T extends Record<string, unknown>>(
	req: Request,
	payload: T,
): T & { _dataStore?: unknown } {
	if (firstQueryParam(req.query.debug) !== "1") return payload;
	return { ...payload, _dataStore: store.stats() };
}

function getCommentGroupsByPostId(
	posts: readonly Post[],
	groups: readonly Comment[][],
): Map<string, Comment[]> {
	const grouped = new Map<string, Comment[]>();
	posts.forEach((post, index) => grouped.set(post.id, groups[index] ?? []));
	return grouped;
}

app.get("/health", (_req, res) => {
	res.json({ ok: true });
});

app.get("/rest/users", (req, res) => {
	store.resetStats();
	const limit = Math.min(numberQueryParam(req, "limit", 50), 200);
	const users = store
		.listUsers(limit)
		.map((user) => serializeUser(user, roleFromRequest(req)));
	sendCacheableJson(req, res, includeDebug(req, { users }), {
		maxAgeSeconds: 60,
	});
});

app.get("/rpc/feed", (req, res) => {
	store.resetStats();
	const role = roleFromRequest(req);
	const userLimit = Math.min(numberQueryParam(req, "users", 20), 200);
	const postLimit = Math.min(
		numberQueryParam(req, "posts", DEFAULT_POST_LIMIT),
		50,
	);
	const commentLimit = Math.min(
		numberQueryParam(req, "comments", DEFAULT_COMMENT_LIMIT),
		25,
	);

	const users = store.listUsers(userLimit);
	const postsByUser = store.getPostsByUserIds(
		users.map((user) => user.id),
		postLimit,
	);
	const allPosts = postsByUser.flat();
	const commentsByPost = store.getCommentsByPostIds(
		allPosts.map((post) => post.id),
		commentLimit,
	);
	const commentsByPostId = getCommentGroupsByPostId(allPosts, commentsByPost);
	const allComments = commentsByPost.flat();
	const authorsById = new Map(
		store
			.getUsersByIds(allComments.map((comment) => comment.authorId))
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

	sendCacheableJson(req, res, includeDebug(req, payload), {
		maxAgeSeconds: 30,
	});
});

app.get("/graphql", executeGraphQL);
app.post("/graphql", executeGraphQL);

app.use((req, res) => {
	res.status(404).json({ error: "not_found", path: req.path });
});

const server = app.listen(PORT, () => {
	console.log(`Benchmark API listening on http://localhost:${PORT}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
