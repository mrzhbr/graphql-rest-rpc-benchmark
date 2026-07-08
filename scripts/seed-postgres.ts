import { closePool, pool } from "../src/db.js";

interface Scale {
	users: number;
	postsPerUser: number;
	commentsPerPost: number;
}

const SCALE_PRESETS: Record<string, Scale> = {
	small: { users: 10_000, postsPerUser: 10, commentsPerPost: 5 },
	medium: { users: 100_000, postsPerUser: 10, commentsPerPost: 5 },
	large: { users: 1_000_000, postsPerUser: 10, commentsPerPost: 5 },
};

function scaleFromEnv(): Scale {
	const fallback = SCALE_PRESETS.small;
	if (!fallback) throw new Error("Missing small scale preset.");
	const preset = SCALE_PRESETS[process.env.SCALE ?? "small"] ?? fallback;
	return {
		users: Number(process.env.USERS ?? preset.users),
		postsPerUser: Number(process.env.POSTS_PER_USER ?? preset.postsPerUser),
		commentsPerPost: Number(
			process.env.COMMENTS_PER_POST ?? preset.commentsPerPost,
		),
	};
}

async function exec(label: string, sql: string, params: unknown[] = []) {
	const started = process.hrtime.bigint();
	process.stderr.write(`▶ ${label}\n`);
	await pool.query(sql, params);
	const seconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
	process.stderr.write(`  done in ${seconds.toFixed(1)}s\n`);
}

async function main(): Promise<void> {
	const scale = scaleFromEnv();
	const posts = scale.users * scale.postsPerUser;
	const comments = posts * scale.commentsPerPost;

	console.log(
		JSON.stringify(
			{
				users: scale.users,
				posts,
				comments,
				postsPerUser: scale.postsPerUser,
				commentsPerPost: scale.commentsPerPost,
			},
			null,
			2,
		),
	);

	await exec(
		"drop old schema",
		"drop table if exists comments, posts, users cascade",
	);
	await exec(
		"create users",
		`
		create unlogged table users (
			id bigint primary key,
			name text not null,
			email text not null,
			plan text not null check (plan in ('free', 'pro', 'enterprise'))
		)
	`,
	);
	await exec(
		"create posts",
		`
		create unlogged table posts (
			id bigint primary key,
			author_id bigint not null references users(id),
			title text not null,
			body text not null,
			created_at timestamptz not null
		)
	`,
	);
	await exec(
		"create comments",
		`
		create unlogged table comments (
			id bigint primary key,
			post_id bigint not null references posts(id),
			author_id bigint not null references users(id),
			body text not null,
			created_at timestamptz not null
		)
	`,
	);

	await exec(
		"insert users",
		`
		insert into users (id, name, email, plan)
		select
			id,
			'User ' || id,
			'user' || id || '@example.test',
			case
				when id % 23 = 0 then 'enterprise'
				when id % 5 = 0 then 'pro'
				else 'free'
			end
		from generate_series(1, $1::bigint) id
		`,
		[scale.users],
	);

	await exec(
		"insert posts",
		`
		insert into posts (id, author_id, title, body, created_at)
		select
			((user_id - 1) * $2::bigint + post_number) as id,
			user_id as author_id,
			'Post ' || post_number || ' by user ' || user_id,
			'Synthetic relational benchmark post body for user ' || user_id,
			timestamp '2025-01-01' + (((user_id + post_number) % 365) || ' days')::interval
		from generate_series(1, $1::bigint) user_id
		cross join generate_series(1, $2::bigint) post_number
		`,
		[scale.users, scale.postsPerUser],
	);

	await exec(
		"insert comments",
		`
		insert into comments (id, post_id, author_id, body, created_at)
		select
			((post_id - 1) * $3::bigint + comment_number) as id,
			post_id,
			(((post_id * 7919 + comment_number * 104729) % $1::bigint) + 1) as author_id,
			'Comment ' || comment_number || ' on post ' || post_id,
			timestamp '2025-02-01' + (((post_id + comment_number) % 365) || ' days')::interval
		from generate_series(1, $2::bigint) post_id
		cross join generate_series(1, $3::bigint) comment_number
		`,
		[scale.users, posts, scale.commentsPerPost],
	);

	await exec(
		"index posts by author",
		"create index posts_author_id_id_idx on posts(author_id, id)",
	);
	await exec(
		"index comments by post",
		"create index comments_post_id_id_idx on comments(post_id, id)",
	);
	await exec(
		"index comments by author",
		"create index comments_author_id_idx on comments(author_id)",
	);
	await exec("analyze", "analyze");

	console.log("Seed complete.");
}

main()
	.catch((error: unknown) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => {
		void closePool();
	});
