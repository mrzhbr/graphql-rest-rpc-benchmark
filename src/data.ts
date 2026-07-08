export interface User {
	id: string;
	name: string;
	email: string;
	plan: "free" | "pro" | "enterprise";
}

export interface Post {
	id: string;
	authorId: string;
	title: string;
	body: string;
	createdAt: string;
}

export interface Comment {
	id: string;
	postId: string;
	authorId: string;
	body: string;
	createdAt: string;
}

export interface StoreCounter {
	calls: number;
	rows: number;
}

export type StoreStats = Record<string, StoreCounter>;

export interface DataStore {
	stats(): StoreStats;
	resetStats(): void;
	listUsers(limit?: number): User[];
	getUsersByIds(ids: readonly string[]): Array<User | null>;
	getUserById(id: string): User | null;
	getPostsByUserId(userId: string, limit?: number): Post[];
	getPostsByUserIds(userIds: readonly string[], limit?: number): Post[][];
	getCommentsByPostId(postId: string, limit?: number): Comment[];
	getCommentsByPostIds(postIds: readonly string[], limit?: number): Comment[][];
	getPostById(id: string): Post | null;
}

interface DataOptions {
	users?: number;
	postsPerUser?: number;
	commentsPerPost?: number;
	seed?: number;
}

interface Rows {
	users: User[];
	posts: Post[];
	comments: Comment[];
}

const DEFAULT_SEED = 42;

function mulberry32(seed: number): () => number {
	return function random(): number {
		let t = (seed += 0x6d2b79f5);
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(items: readonly T[], random: () => number): T {
	const item = items[Math.floor(random() * items.length)];
	if (item === undefined) throw new Error("Cannot pick from an empty list.");
	return item;
}

function makeRows({
	users = 500,
	postsPerUser = 20,
	commentsPerPost = 8,
	seed = DEFAULT_SEED,
}: DataOptions = {}): Rows {
	const random = mulberry32(seed);
	const names = [
		"Ada",
		"Grace",
		"Linus",
		"Margaret",
		"Barbara",
		"Edsger",
		"Donald",
		"Radia",
		"Tim",
		"Katherine",
	] as const;
	const topics = [
		"graphql",
		"rest",
		"rpc",
		"caching",
		"security",
		"dx",
		"benchmarking",
		"schemas",
	] as const;
	const plans = ["free", "pro", "enterprise"] as const;

	const userRows: User[] = Array.from({ length: users }, (_, i) => ({
		id: String(i + 1),
		name: `${pick(names, random)} ${i + 1}`,
		email: `user${i + 1}@example.test`,
		plan: random() > 0.82 ? plans[2] : random() > 0.45 ? plans[1] : plans[0],
	}));

	const postRows: Post[] = [];
	const commentRows: Comment[] = [];
	let postId = 1;
	let commentId = 1;

	for (const user of userRows) {
		for (let p = 0; p < postsPerUser; p += 1) {
			const post: Post = {
				id: String(postId++),
				authorId: user.id,
				title: `${pick(topics, random)} notes ${p + 1} by ${user.name}`,
				body: `A short synthetic post about ${pick(topics, random)} and API design.`,
				createdAt: new Date(
					Date.UTC(2025, 0, 1 + (postId % 28), postId % 24),
				).toISOString(),
			};
			postRows.push(post);

			for (let c = 0; c < commentsPerPost; c += 1) {
				const commenter = pick(userRows, random);
				commentRows.push({
					id: String(commentId++),
					postId: post.id,
					authorId: commenter.id,
					body: `Comment ${c + 1} on post ${post.id} from ${commenter.name}`,
					createdAt: new Date(
						Date.UTC(2025, 1, 1 + (commentId % 28), commentId % 24),
					).toISOString(),
				});
			}
		}
	}

	return { users: userRows, posts: postRows, comments: commentRows };
}

function groupBy<T>(
	rows: readonly T[],
	getKey: (row: T) => string,
): Map<string, T[]> {
	const grouped = new Map<string, T[]>();
	for (const row of rows) {
		const key = getKey(row);
		const bucket = grouped.get(key);
		if (bucket) bucket.push(row);
		else grouped.set(key, [row]);
	}
	return grouped;
}

export function createDataStore(options: DataOptions = {}): DataStore {
	const rows = makeRows(options);
	const usersById = new Map(rows.users.map((user) => [user.id, user]));
	const postsById = new Map(rows.posts.map((post) => [post.id, post]));
	const postsByUser = groupBy(rows.posts, (post) => post.authorId);
	const commentsByPost = groupBy(rows.comments, (comment) => comment.postId);
	const counters = new Map<string, StoreCounter>();

	function count(operation: string, rowsRead = 0): void {
		const current = counters.get(operation) ?? { calls: 0, rows: 0 };
		current.calls += 1;
		current.rows += rowsRead;
		counters.set(operation, current);
	}

	function limited<T>(rowsToSlice: readonly T[], limit?: number): T[] {
		return rowsToSlice.slice(0, Math.max(0, limit ?? rowsToSlice.length));
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
		listUsers(limit = 50) {
			const result = limited(rows.users, limit);
			count("listUsers", result.length);
			return result;
		},
		getUsersByIds(ids) {
			const uniqueIds = [...new Set(ids.map(String))];
			count("getUsersByIds", uniqueIds.length);
			return uniqueIds.map((id) => usersById.get(id) ?? null);
		},
		getUserById(id) {
			count("getUserById", 1);
			return usersById.get(String(id)) ?? null;
		},
		getPostsByUserId(userId, limit = 10) {
			const result = limited(postsByUser.get(String(userId)) ?? [], limit);
			count("getPostsByUserId", result.length);
			return result;
		},
		getPostsByUserIds(userIds, limit = 10) {
			const uniqueIds = [...new Set(userIds.map(String))];
			const grouped = new Map<string, Post[]>();
			let rowsRead = 0;
			for (const id of uniqueIds) {
				const result = limited(postsByUser.get(id) ?? [], limit);
				rowsRead += result.length;
				grouped.set(id, result);
			}
			count("getPostsByUserIds", rowsRead);
			return uniqueIds.map((id) => grouped.get(id) ?? []);
		},
		getCommentsByPostId(postId, limit = 5) {
			const result = limited(commentsByPost.get(String(postId)) ?? [], limit);
			count("getCommentsByPostId", result.length);
			return result;
		},
		getCommentsByPostIds(postIds, limit = 5) {
			const uniqueIds = [...new Set(postIds.map(String))];
			const grouped = new Map<string, Comment[]>();
			let rowsRead = 0;
			for (const id of uniqueIds) {
				const result = limited(commentsByPost.get(id) ?? [], limit);
				rowsRead += result.length;
				grouped.set(id, result);
			}
			count("getCommentsByPostIds", rowsRead);
			return uniqueIds.map((id) => grouped.get(id) ?? []);
		},
		getPostById(id) {
			count("getPostById", 1);
			return postsById.get(String(id)) ?? null;
		},
	};
}
