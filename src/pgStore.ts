import type { Comment, StoreCounter, StoreStats, User } from "./data.js";
import { pool } from "./db.js";

export interface DbPost {
	id: string;
	authorId: string;
	title: string;
	body: string;
	createdAt: string;
}

export interface PgStore {
	stats(): StoreStats;
	resetStats(): void;
	listUsers(limit?: number): Promise<User[]>;
	getUsersByIds(ids: readonly string[]): Promise<Array<User | null>>;
	getUserById(id: string): Promise<User | null>;
	getPostsByUserId(userId: string, limit?: number): Promise<DbPost[]>;
	getPostsByUserIds(
		userIds: readonly string[],
		limit?: number,
	): Promise<DbPost[][]>;
	getCommentsByPostId(postId: string, limit?: number): Promise<Comment[]>;
	getCommentsByPostIds(
		postIds: readonly string[],
		limit?: number,
	): Promise<Comment[][]>;
}

interface UserRow {
	id: string;
	name: string;
	email: string;
	plan: User["plan"];
}

interface PostRow {
	id: string;
	author_id: string;
	title: string;
	body: string;
	created_at: string;
}

interface CommentRow {
	id: string;
	post_id: string;
	author_id: string;
	body: string;
	created_at: string;
}

function toUser(row: UserRow): User {
	return { id: row.id, name: row.name, email: row.email, plan: row.plan };
}

function toPost(row: PostRow): DbPost {
	return {
		id: row.id,
		authorId: row.author_id,
		title: row.title,
		body: row.body,
		createdAt: row.created_at,
	};
}

function toComment(row: CommentRow): Comment {
	return {
		id: row.id,
		postId: row.post_id,
		authorId: row.author_id,
		body: row.body,
		createdAt: row.created_at,
	};
}

function groupRows<T>(
	rows: readonly T[],
	getKey: (row: T) => string,
): Map<string, T[]> {
	const grouped = new Map<string, T[]>();
	for (const row of rows) {
		const value = getKey(row);
		const bucket = grouped.get(value);
		if (bucket) bucket.push(row);
		else grouped.set(value, [row]);
	}
	return grouped;
}

export function createPgStore(): PgStore {
	const counters = new Map<string, StoreCounter>();

	function count(operation: string, rowsRead = 0): void {
		const current = counters.get(operation) ?? { calls: 0, rows: 0 };
		current.calls += 1;
		current.rows += rowsRead;
		counters.set(operation, current);
	}

	return {
		stats() {
			return Object.fromEntries(
				[...counters.entries()].map(([name, value]) => [name, { ...value }]),
			);
		},
		resetStats() {
			counters.clear();
		},
		async listUsers(limit = 50) {
			const result = await pool.query<UserRow>(
				"select id::text, name, email, plan from users order by id limit $1",
				[limit],
			);
			count("listUsers", result.rowCount ?? 0);
			return result.rows.map(toUser);
		},
		async getUsersByIds(ids) {
			const uniqueIds = [...new Set(ids.map(String))];
			if (uniqueIds.length === 0) return [];
			const result = await pool.query<UserRow>(
				"select id::text, name, email, plan from users where id = any($1::bigint[])",
				[uniqueIds],
			);
			count("getUsersByIds", result.rowCount ?? 0);
			const byId = new Map(result.rows.map((row) => [row.id, toUser(row)]));
			return uniqueIds.map((id) => byId.get(id) ?? null);
		},
		async getUserById(id) {
			const users = await this.getUsersByIds([id]);
			count("getUserById", users[0] ? 1 : 0);
			return users[0] ?? null;
		},
		async getPostsByUserId(userId, limit = 10) {
			const result = await pool.query<PostRow>(
				`select id::text, author_id::text, title, body, created_at::text
				 from posts
				 where author_id = $1
				 order by id
				 limit $2`,
				[userId, limit],
			);
			count("getPostsByUserId", result.rowCount ?? 0);
			return result.rows.map(toPost);
		},
		async getPostsByUserIds(userIds, limit = 10) {
			const uniqueIds = [...new Set(userIds.map(String))];
			if (uniqueIds.length === 0) return [];
			const result = await pool.query<PostRow>(
				`select id::text, author_id::text, title, body, created_at::text
				 from (
				   select posts.*, row_number() over (partition by author_id order by id) as rn
				   from posts
				   where author_id = any($1::bigint[])
				 ) ranked
				 where rn <= $2
				 order by author_id, id`,
				[uniqueIds, limit],
			);
			count("getPostsByUserIds", result.rowCount ?? 0);
			const grouped = groupRows(result.rows, (row) => row.author_id);
			return uniqueIds.map((id) => (grouped.get(id) ?? []).map(toPost));
		},
		async getCommentsByPostId(postId, limit = 5) {
			const result = await pool.query<CommentRow>(
				`select id::text, post_id::text, author_id::text, body, created_at::text
				 from comments
				 where post_id = $1
				 order by id
				 limit $2`,
				[postId, limit],
			);
			count("getCommentsByPostId", result.rowCount ?? 0);
			return result.rows.map(toComment);
		},
		async getCommentsByPostIds(postIds, limit = 5) {
			const uniqueIds = [...new Set(postIds.map(String))];
			if (uniqueIds.length === 0) return [];
			const result = await pool.query<CommentRow>(
				`select id::text, post_id::text, author_id::text, body, created_at::text
				 from (
				   select comments.*, row_number() over (partition by post_id order by id) as rn
				   from comments
				   where post_id = any($1::bigint[])
				 ) ranked
				 where rn <= $2
				 order by post_id, id`,
				[uniqueIds, limit],
			);
			count("getCommentsByPostIds", result.rowCount ?? 0);
			const grouped = groupRows(result.rows, (row) => row.post_id);
			return uniqueIds.map((id) => (grouped.get(id) ?? []).map(toComment));
		},
	};
}
