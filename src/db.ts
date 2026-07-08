import pg from "pg";

const { Pool } = pg;

export const DATABASE_URL =
	process.env.DATABASE_URL ??
	"postgresql://benchmark@localhost:5432/graphql_benchmark";

export const pool = new Pool({
	connectionString: DATABASE_URL,
	max: Number(process.env.PG_POOL_SIZE ?? 20),
});

export async function closePool(): Promise<void> {
	await pool.end();
}

export async function pingDatabase(): Promise<boolean> {
	const result = await pool.query<{ ok: number }>("select 1 as ok");
	return result.rows[0]?.ok === 1;
}
