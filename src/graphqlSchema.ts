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
import type { Comment, DataStore, Post, User } from "./data.js";

export interface ResolverMetrics {
	rootResolvers: number;
	fieldResolvers: number;
	defaultFieldResolvers: number;
}

export interface Loaders {
	usersById: DataLoader<string, User | null>;
	postsByUserId(limit: number): DataLoader<string, Post[]>;
	commentsByPostId(limit: number): DataLoader<string, Comment[]>;
}

export interface GraphQLContext {
	role: "user" | "admin";
	store: DataStore;
	defaultPostLimit: number;
	defaultCommentLimit: number;
	maxUsersLimit: number;
	maxPostLimit: number;
	maxCommentLimit: number;
	loaders: Loaders | null;
	metrics: ResolverMetrics;
}

function clampLimit(
	value: number | null | undefined,
	fallback: number,
	max: number,
): number {
	return Math.min(Math.max(value ?? fallback, 0), max);
}

export function createLoaders(store: DataStore): Loaders {
	const postLoadersByLimit = new Map<number, DataLoader<string, Post[]>>();
	const commentLoadersByLimit = new Map<
		number,
		DataLoader<string, Comment[]>
	>();

	return {
		usersById: new DataLoader<string, User | null>(async (ids) =>
			store.getUsersByIds(ids),
		),
		postsByUserId(limit) {
			let loader = postLoadersByLimit.get(limit);
			if (!loader) {
				loader = new DataLoader<string, Post[]>(async (userIds) =>
					store.getPostsByUserIds(userIds, limit),
				);
				postLoadersByLimit.set(limit, loader);
			}
			return loader;
		},
		commentsByPostId(limit) {
			let loader = commentLoadersByLimit.get(limit);
			if (!loader) {
				loader = new DataLoader<string, Comment[]>(async (postIds) =>
					store.getCommentsByPostIds(postIds, limit),
				);
				commentLoadersByLimit.set(limit, loader);
			}
			return loader;
		},
	};
}

export function createSchema(): GraphQLSchema {
	let UserType: GraphQLObjectType<User, GraphQLContext>;
	let PostType: GraphQLObjectType<Post, GraphQLContext>;
	let CommentType: GraphQLObjectType<Comment, GraphQLContext>;

	CommentType = new GraphQLObjectType<Comment, GraphQLContext>({
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

	PostType = new GraphQLObjectType<Post, GraphQLContext>({
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
					const limit = clampLimit(
						args.limit,
						ctx.defaultCommentLimit,
						ctx.maxCommentLimit,
					);
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

	UserType = new GraphQLObjectType<User, GraphQLContext>({
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
					const limit = clampLimit(
						args.limit,
						ctx.defaultPostLimit,
						ctx.maxPostLimit,
					);
					return ctx.loaders
						? ctx.loaders.postsByUserId(limit).load(user.id)
						: ctx.store.getPostsByUserId(user.id, limit);
				},
			},
		}),
	});

	const QueryType = new GraphQLObjectType<unknown, GraphQLContext>({
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
