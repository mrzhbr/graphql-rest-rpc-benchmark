# GraphQL vs REST/RPC benchmark playground

A small TypeScript project for building hands-on intuition around REST/RPC vs
GraphQL. It exposes the same deterministic in-memory data model through three
API shapes:

- REST: `GET /rest/users`
- RPC-style REST: `GET /rpc/feed`
- GraphQL: `POST /graphql`

The goal is not to model a production database. The store is intentionally
in-memory and deterministic so the experiment highlights API-layer costs:
GraphQL parsing, validation, recursive field execution, resolver dispatch,
DataLoader batching, URL cacheability, query depth limits, introspection, and
per-field authorization.

## What happened in this repo

This was built as a learning benchmark for these questions:

1. What is the fixed overhead of GraphQL for a flat list compared with a direct
   REST handler?
2. How does a hand-written nested RPC endpoint compare with GraphQL on a nested
   fan-out response?
3. How much does DataLoader reduce backing-store calls, and what overhead does
   it add when the backing store is only in-memory?
4. What does REST-style URL caching look like compared with default GraphQL
   POST behavior?
5. Where do GraphQL security controls show up: introspection, query depth, and
   per-field authorization?

The latest benchmark output is saved in [`benchmark.md`](benchmark.md). On this
machine, with `CONNECTIONS=25` and `DURATION=8`, it produced:

| Case | Requests/sec | Avg latency | P99 latency |
| --- | ---: | ---: | ---: |
| REST flat users | 23,542.0 | 0.55 ms | 2 ms |
| GraphQL flat users | 7,528.5 | 3.12 ms | 6 ms |
| RPC nested feed | 851.3 | 28.93 ms | 56 ms |
| GraphQL nested + DataLoader | 293.9 | 84.16 ms | 165 ms |
| GraphQL nested naive | 468.9 | 52.66 ms | 102 ms |

Interpretation caveat: because this benchmark uses an in-memory store,
DataLoader can be slower than naive resolvers. That is useful: it separates
DataLoader's batching benefit from its Promise/batching overhead.

A Postgres-backed run on `potsdam` with 100k users, 1M posts, and 5M comments is
saved in [`benchmark-postgres.md`](benchmark-postgres.md). In that run, flat
GraphQL was close to flat REST because DB I/O dominated, while DataLoader made
nested GraphQL about 7.7x faster than naive nested GraphQL. The fixed RPC fetch
plan still won for the one bespoke nested shape.

## Requirements

- Node.js 20+
- npm

## Install

```bash
npm install
```

## Run the server

```bash
npm run dev
```

The server listens on `http://localhost:4000` by default. Override with:

```bash
PORT=5000 npm run dev
```

## Run the experiments

In another terminal:

```bash
npm run smoke
npm run bench
npm run bench:matrix
npm run cache
```

Useful benchmark knobs:

```bash
CONNECTIONS=50 DURATION=15 npm run bench
NESTED_USERS=50 NESTED_POSTS=10 NESTED_COMMENTS=5 npm run bench
FLAT_USERS=200 npm run bench
CONNECTIONS=10 DURATION=5 npm run bench:matrix
```

## Postgres benchmark mode

The in-memory benchmark intentionally isolates GraphQL execution overhead. To
see the effect of real relational I/O, use the Postgres mode.

Start Postgres:

```bash
npm run db:up
```

Security note: the Compose file uses Postgres trust auth for convenience, but
binds the database port to `127.0.0.1` only. Do not change it to a public bind
address unless you also configure real credentials/firewalling.

If port 5432 is already in use, choose another host port and point the app at
it:

```bash
POSTGRES_PORT=55432 npm run db:up
DATABASE_URL=postgresql://benchmark@localhost:55432/graphql_benchmark npm run db:seed
```

Seed a synthetic relational data set:

```bash
npm run db:seed
```

Default `SCALE=small` creates 10k users, 100k posts, and 500k comments. Larger
presets are available:

```bash
SCALE=medium npm run db:seed  # 100k users, 1M posts, 5M comments
SCALE=large npm run db:seed   # 1M users, 10M posts, 50M comments
```

Or choose exact values:

```bash
USERS=200000 POSTS_PER_USER=10 COMMENTS_PER_POST=5 npm run db:seed
```

Run the Postgres-backed API on port 4001:

```bash
npm run db:dev
```

Run the Postgres benchmark:

```bash
npm run bench:db
```

Useful remote-compute flow:

```bash
rsync -az --delete --exclude node_modules --exclude .git \
  --exclude dist --exclude results ./ frankenthal:~/graphql-rest-rpc-benchmark/
ssh frankenthal 'cd ~/graphql-rest-rpc-benchmark && zsh -lc "npm install && POSTGRES_PORT=55432 npm run db:up && DATABASE_URL=postgresql://benchmark@localhost:55432/graphql_benchmark SCALE=medium npm run db:seed && DATABASE_URL=postgresql://benchmark@localhost:55432/graphql_benchmark npm run bench:db"'
```

Use `potsdam` instead of `frankenthal` if that host is free. The benchmark
`DATABASE_URL` examples contain no password; they rely on the local-only trusted
Postgres container above.

## API examples

### REST: fixed flat shape

```bash
curl 'http://localhost:4000/rest/users?limit=5&debug=1'
```

This returns a fixed user shape. With `debug=1`, it also includes the backing
store counters, for example `listUsers: { calls: 1, rows: 5 }`.

### RPC-style REST: fixed nested fetch plan

```bash
curl 'http://localhost:4000/rpc/feed?users=2&posts=2&comments=2&debug=1'
```

The handler in `src/server.ts` explicitly fetches the whole response plan:

1. list users
2. batch posts for those users
3. batch comments for those posts
4. batch comment authors
5. assemble the response

This avoids a generic traversal engine, but the response shape is fixed by the
endpoint implementation.

### GraphQL: client-selected shape

```bash
curl -s 'http://localhost:4000/graphql' \
  -H 'content-type: application/json' \
  -d '{
    "query": "query { users(limit: 2) { id name posts(limit: 2) { id title comments(limit: 2) { id body author { id name plan } } } } }"
  }'
```

The GraphQL response includes an `extensions` object like:

```json
{
  "depth": 5,
  "loaders": true,
  "resolverMetrics": {
    "rootResolvers": 1,
    "fieldResolvers": 14,
    "defaultFieldResolvers": 54
  },
  "dataStore": {
    "listUsers": { "calls": 1, "rows": 2 },
    "getPostsByUserIds": { "calls": 1, "rows": 4 },
    "getCommentsByPostIds": { "calls": 1, "rows": 8 },
    "getUsersByIds": { "calls": 1, "rows": 8 }
  }
}
```

That is the main teaching tool: it shows both GraphQL field traversal and
backing-store access.

## DataLoader vs naive GraphQL

By default, GraphQL uses DataLoader:

```bash
curl -s 'http://localhost:4000/graphql' \
  -H 'content-type: application/json' \
  -d '{
    "query": "query { users(limit: 5) { id posts(limit: 3) { id comments(limit: 2) { id author { id name } } } } }"
  }'
```

Disable DataLoader with `loader=0`:

```bash
curl -s 'http://localhost:4000/graphql?loader=0' \
  -H 'content-type: application/json' \
  -d '{
    "query": "query { users(limit: 5) { id posts(limit: 3) { id comments(limit: 2) { id author { id name } } } } }"
  }'
```

Compare `extensions.dataStore` between the two responses. The DataLoader path
should use batched methods such as `getPostsByUserIds` and
`getCommentsByPostIds`; the naive path should use many per-object calls such as
`getPostsByUserId` and `getCommentsByPostId`.

## Benchmark matrix

For a broader sweep across nested fan-out sizes, run:

```bash
npm run bench:matrix
```

This executes RPC, GraphQL with DataLoader, and naive GraphQL against several
nested response sizes. It prints a markdown table and also writes a timestamped
report to `results/matrix-*.md`.

Use this when you want to see how the relative curves change as fan-out grows,
rather than only comparing one fixed nested query shape.

## Cache experiment

Run:

```bash
npm run cache
```

REST/RPC responses set `Cache-Control` and `ETag`, so conditional requests can
return `304 Not Modified`. GraphQL POST responses intentionally use
`Cache-Control: no-store` in this playground.

This is not saying GraphQL can never be cached. It is showing the default
contrast: REST resources are naturally URL-addressable, while GraphQL usually
needs extra conventions such as persisted queries or GraphQL-over-GET for
shared HTTP caching.

## Security experiments

### Per-field authorization

The GraphQL `email` field only resolves for admin requests:

```bash
curl -s 'http://localhost:4000/graphql' \
  -H 'content-type: application/json' \
  -d '{"query":"query { users(limit: 2) { id name email } }"}'

curl -s 'http://localhost:4000/graphql' \
  -H 'content-type: application/json' \
  -H 'x-role: admin' \
  -d '{"query":"query { users(limit: 2) { id name email } }"}'
```

### Introspection

GraphQL introspection is disabled by default. Enable it with:

```bash
ALLOW_INTROSPECTION=1 npm run dev
```

### Query depth

The default max GraphQL query depth is `6`. Lower it to force rejections:

```bash
MAX_GRAPHQL_DEPTH=3 npm run dev
```

Then run a nested query and observe the `Query depth ... exceeds max depth ...`
error.

## Scripts

- `npm run dev` — run the in-memory TypeScript server directly with `tsx`
- `npm run db:up` — start local Postgres with Docker Compose
- `npm run db:seed` — seed Postgres with synthetic relational data
- `npm run db:dev` — run the Postgres-backed server on port 4001
- `npm run typecheck` — TypeScript check without emitting
- `npm run build` — compile to `dist/`
- `npm start` — run compiled server
- `npm run smoke` — quick endpoint/security sanity check
- `npm run bench` — run in-memory autocannon comparisons
- `npm run bench:db` — run Postgres-backed autocannon comparisons
- `npm run bench:matrix` — sweep nested fan-out sizes and write a report
- `npm run cache` — demonstrate REST ETag vs GraphQL POST no-store behavior

## Project layout

```text
src/data.ts            deterministic in-memory store + counters
src/db.ts              Postgres connection pool
src/pgStore.ts         Postgres-backed store + counters
src/graphqlSchema.ts   in-memory GraphQL schema and DataLoader wiring
src/pgGraphqlSchema.ts Postgres GraphQL schema and DataLoader wiring
src/httpCache.ts       small JSON + ETag helper for REST/RPC responses
src/queries.ts         benchmark GraphQL query strings
src/server.ts          in-memory Express REST/RPC/GraphQL routes
src/dbServer.ts        Postgres-backed Express REST/RPC/GraphQL routes
scripts/bench.ts       in-memory autocannon benchmark runner
scripts/bench-db.ts    Postgres autocannon benchmark runner
scripts/seed-postgres.ts Postgres schema/data generator
scripts/matrix.ts      multi-scenario nested benchmark matrix
scripts/cache-demo.ts  REST ETag vs GraphQL POST cache demo
scripts/smoke.ts       quick sanity/security check
```
