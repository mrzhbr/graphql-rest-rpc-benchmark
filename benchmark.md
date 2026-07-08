# Benchmark run

Command:

```bash
npm run bench
```

Output:

```text
> graphql-rest-rpc-benchmark@0.1.0 bench
> tsx scripts/bench.ts

[server]
> graphql-rest-rpc-benchmark@0.1.0 dev
> tsx src/server.ts

[server] Benchmark API listening on http://localhost:4000
connections=25 duration=8s

▶ REST flat users
REST flat users                  req/s=23542.0      lat.avg=0.55ms      p99=2.00ms    errors=0    timeouts=0

▶ GraphQL flat users
GraphQL flat users                req/s=7528.5      lat.avg=3.12ms      p99=6.00ms    errors=0    timeouts=0

▶ RPC nested feed
RPC nested feed                    req/s=851.3     lat.avg=28.93ms     p99=56.00ms    errors=0    timeouts=0

▶ GraphQL nested + DataLoader
GraphQL nested + DataLoader        req/s=293.9     lat.avg=84.16ms    p99=165.00ms    errors=0    timeouts=0

▶ GraphQL nested naive
GraphQL nested naive               req/s=468.9     lat.avg=52.66ms    p99=102.00ms    errors=0    timeouts=0
```
