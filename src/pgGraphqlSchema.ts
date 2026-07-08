import DataLoader from "dataloader";
import {
	GraphQLBoolean,
	GraphQLInt,
	GraphQLList,
	GraphQLNonNull,
	GraphQLObjectType,
	GraphQLSchema,
	GraphQLString,
} from "graphql";
import type { Comment, User } from "./data.js";
import type { DbPost, PgStore } from "./pgStore.js";

export interface PgResolverMetrics {
	rootResolvers: number;
	fieldResolvers: number;
	defaultFieldResolvers: number;
}

export interface PgLoaders {
	usersById: DataLoader<string, User | null>;
	postsByUserId(limit: number): DataLoader<string, DbPost[]>;
	commentsByPostId(limit: number): DataLoader<string, Comment[]>;
}

export interface PgGraphQLContext {
	role: "user" | "admin";
	store: PgStore;
	maxUsersLimit: number;
	maxPostLimit: number;
	maxCommentLimit: number;
	loaders: PgLoaders | null;
	metrics: PgResolverMetrics;
}

function clampLimit(
	value: number | null | undefined,
	fallback: number,
	max: number,
): number {
	return Math.min(Math.max(value ?? fallback, 0), max);
}

export function createPgLoaders(store: PgStore): PgLoaders {
	const postLoadersByLimit = new Map<number, DataLoader<string, DbPost[]>>();
	const commentLoadersByLimit = new Map<
		number,
		DataLoader<string, Comment[]>
	>();

	return {
		usersById: new DataLoader<string, User | null>((ids) =>
			store.getUsersByIds(ids),
		),
		postsByUserId(limit) {
			let loader = postLoadersByLimit.get(limit);
			if (!loader) {
				loader = new DataLoader<string, DbPost[]>((userIds) =>
					store.getPostsByUserIds(userIds, limit),
				);
				postLoadersByLimit.set(limit, loader);
			}
			return loader;
		},
		commentsByPostId(limit) {
			let loader = commentLoadersByLimit.get(limit);
			if (!loader) {
				loader = new DataLoader<string, Comment[]>((postIds) =>
					store.getCommentsByPostIds(postIds, limit),
				);
				commentLoadersByLimit.set(limit, loader);
			}
			return loader;
		},
	};
}

export function createPgSchema(): GraphQLSchema {
	let UserType: GraphQLObjectType<User, PgGraphQLContext>;
	let PostType: GraphQLObjectType<DbPost, PgGraphQLContext>;
	let CommentType: GraphQLObjectType<Comment, PgGraphQLContext>;

	CommentType = new GraphQLObjectType<Comment, PgGraphQLContext>({
		name: "Comment",
		fields: () => ({
			id: { type: new GraphQLNonNull(GraphQLString) },
			body: { type: new GraphQLNonNull(GraphQLString) },
			createdAt: { type: new GraphQLNonNull(GraphQLString) },
			author: {
				type: UserType,
				resolve(comment, _args, ctx) {
					ctx.metrics.fieldResolvers += 1;
					return ctx.loaders
						? ctx.loaders.usersById.load(comment.authorId)
						: ctx.store.getUserById(comment.authorId);
				},
			},
		}),
	});

	PostType = new GraphQLObjectType<DbPost, PgGraphQLContext>({
		name: "Post",
		fields: () => ({
			id: { type: new GraphQLNonNull(GraphQLString) },
			title: { type: new GraphQLNonNull(GraphQLString) },
			body: { type: new GraphQLNonNull(GraphQLString) },
			createdAt: { type: new GraphQLNonNull(GraphQLString) },
			comments: {
				type: new GraphQLNonNull(
					new GraphQLList(new GraphQLNonNull(CommentType)),
				),
				args: { limit: { type: GraphQLInt } },
				resolve(post, args: { limit?: number | null }, ctx) {
					ctx.metrics.fieldResolvers += 1;
					const limit = clampLimit(args.limit, 5, ctx.maxCommentLimit);
					return ctx.loaders
						? ctx.loaders.commentsByPostId(limit).load(post.id)
						: ctx.store.getCommentsByPostId(post.id, limit);
				},
			},
			author: {
				type: UserType,
				resolve(post, _args, ctx) {
					ctx.metrics.fieldResolvers += 1;
					return ctx.loaders
						? ctx.loaders.usersById.load(post.authorId)
						: ctx.store.getUserById(post.authorId);
				},
			},
		}),
	});

	UserType = new GraphQLObjectType<User, PgGraphQLContext>({
		name: "User",
		fields: () => ({
			id: { type: new GraphQLNonNull(GraphQLString) },
			name: { type: new GraphQLNonNull(GraphQLString) },
			plan: { type: new GraphQLNonNull(GraphQLString) },
			email: {
				type: GraphQLString,
				description:
					"Admin-only field to illustrate per-field GraphQL authorization.",
				resolve(user, _args, ctx) {
					ctx.metrics.fieldResolvers += 1;
					return ctx.role === "admin" ? user.email : null;
				},
			},
			posts: {
				type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PostType))),
				args: { limit: { type: GraphQLInt } },
				resolve(user, args: { limit?: number | null }, ctx) {
					ctx.metrics.fieldResolvers += 1;
					const limit = clampLimit(args.limit, 10, ctx.maxPostLimit);
					return ctx.loaders
						? ctx.loaders.postsByUserId(limit).load(user.id)
						: ctx.store.getPostsByUserId(user.id, limit);
				},
			},
		}),
	});

	const QueryType = new GraphQLObjectType<unknown, PgGraphQLContext>({
		name: "Query",
		fields: {
			users: {
				type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(UserType))),
				args: { limit: { type: GraphQLInt } },
				resolve(_source, args: { limit?: number | null }, ctx) {
					ctx.metrics.rootResolvers += 1;
					return ctx.store.listUsers(
						clampLimit(args.limit, 50, ctx.maxUsersLimit),
					);
				},
			},
			user: {
				type: UserType,
				args: { id: { type: new GraphQLNonNull(GraphQLString) } },
				resolve(_source, args: { id: string }, ctx) {
					ctx.metrics.rootResolvers += 1;
					return ctx.loaders
						? ctx.loaders.usersById.load(args.id)
						: ctx.store.getUserById(args.id);
				},
			},
			health: {
				type: new GraphQLNonNull(GraphQLBoolean),
				resolve() {
					return true;
				},
			},
		},
	});

	return new GraphQLSchema({ query: QueryType });
}
