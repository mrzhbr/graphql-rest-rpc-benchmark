# Postgres benchmark run

Remote host: `potsdam`

Dataset:

```json
{
  "users": 100000,
  "posts": 1000000,
  "comments": 5000000,
  "postsPerUser": 10,
  "commentsPerPost": 5
}
```

Seed command:

```bash
DATABASE_URL=postgresql://benchmark@localhost:55432/graphql_benchmark \
  SCALE=medium npm run db:seed
```

Benchmark command:

```bash
DATABASE_URL=postgresql://benchmark@localhost:55432/graphql_benchmark \
  CONNECTIONS=25 DURATION=8 npm run bench:db
```

Output:

```text
> graphql-rest-rpc-benchmark@0.1.0 bench:db
> tsx scripts/bench-db.ts

[db-server]
> graphql-rest-rpc-benchmark@0.1.0 db:dev
> tsx src/dbServer.ts

[db-server] Postgres benchmark API listening on http://localhost:4001
connections=25 duration=8s

▶ DB REST flat users
DB REST flat users                   req/s=572.4     lat.avg=43.03ms     p99=78.00ms    errors=0    timeouts=0

▶ DB GraphQL flat users
DB GraphQL flat users                req/s=561.1     lat.avg=43.96ms     p99=80.00ms    errors=0    timeouts=0

▶ DB RPC nested feed
DB RPC nested feed                   req/s=384.6     lat.avg=64.35ms    p99=103.00ms    errors=0    timeouts=0

▶ DB GraphQL nested + DataLoader
DB GraphQL nested + DataLoader       req/s=187.4    lat.avg=131.93ms    p99=191.00ms    errors=0    timeouts=0

▶ DB GraphQL nested naive
DB GraphQL nested naive               req/s=24.4    lat.avg=967.53ms   p99=1192.00ms    errors=0    timeouts=0
```

Quick read:

- Flat GraphQL is very close to flat REST once every request pays a real DB
  query cost.
- Naive nested GraphQL collapses under real DB I/O: it is about 15.7x slower
  than the fixed RPC endpoint here.
- DataLoader rescues the N+1 problem: it is about 7.7x faster than naive nested
  GraphQL here.
- The hand-written RPC fetch plan still wins on this fixed shape because it has
  no generic GraphQL traversal/field-dispatch layer.
