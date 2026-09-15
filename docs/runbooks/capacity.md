# Capacity

What this system can serve, measured rather than estimated, and where the
bottleneck actually is.

## Running the load test

```bash
# Start the stack, with the rate limit raised for the measurement.
RATE_LIMIT_GLOBAL=1000000 RATE_LIMIT_AUTH=100000 npm start   # in server/

npm run loadtest -- --duration=25 --concurrency=20           # in server/
```

Exit codes: `0` passed, `1` thresholds missed, `3` **inconclusive**, `2` could
not run.

Raising the ceiling is not optional and not a cheat. The in-process limiter is
keyed on client address; a load generator on one host is one address, so it
reaches the ceiling within a second and every number after that measures the
cost of being rejected. The tool refuses to report a pass when more than 5% of
requests came back 429 — it says INCONCLUSIVE and tells you to raise the limit.
That behaviour exists because the first run of this tool did the opposite:

```
62719 requests in 20s (3135.9/s)
p50 2.3ms   p95 7.9ms   p99 17.5ms   max 76.4ms
statuses 200:482  201:113  429:62124

Passed: p95 under 1500ms, p99 under 3000ms, no server errors.
```

Every number there is true. 99% of those requests never reached the database.

## Measured: one API process, one Postgres, four shared cores

Concurrency sweep, 12s each, mix of 5 list / 3 read / 2 write:

| concurrent users | throughput  | p50   | p95   | p99   |
|-----------------:|------------:|------:|------:|------:|
| 5                | 133 req/s   | 37ms  | 68ms  | 82ms  |
| 10               | 159 req/s   | 63ms  | 96ms  | 111ms |
| 20               | 153 req/s   | 130ms | 175ms | 191ms |
| 40               | 145 req/s   | 273ms | 345ms | 371ms |

Zero server errors throughout.

Read the shape, not the absolute numbers: **throughput is flat from five
concurrent users onward while latency scales linearly with concurrency.** That
is a saturated system. Past roughly five concurrent users, additional users do
not get served faster in aggregate — they queue, and each one waits longer.

## The bottleneck is API CPU, not the database

Worth stating because the plausible guess is wrong. The connection pool is 10
per task and every request takes a connection, so pool exhaustion is the obvious
suspect. Sampled during a 20-user run:

```
node   81.8% CPU        active Postgres backends: 3
node   80.0% CPU        active Postgres backends: 1
node   80.0% CPU        active Postgres backends: 3
node   70.0% CPU        active Postgres backends: 2
```

One Node process, single-threaded, near its one-core ceiling, while at most 3 of
10 pooled connections were busy. The database was idle by comparison. The cost
is in the process: AES-GCM sealing and unsealing of every deal payload, JSON at
both ends, and the hashing the audit trigger triggers.

Two consequences:

1. **The autoscaling signal in `infra/lib/platform.js` is the right one.** It
   scales on CPU at 60%, and CPU is genuinely what runs out. Had the bottleneck
   been connections, the service would have saturated without ever tripping the
   CPU target and the scaling would have looked broken while working exactly as
   configured.
2. **Scaling out works here.** A CPU-bound single-threaded process is the easy
   case: two tasks serve roughly twice as much. The Fargate task is 512 CPU
   units — half a vCPU — so the deployed per-task figure will be lower than the
   table above, and the `maxCapacity: 10` gives roughly 1,500 req/s of headroom
   at these response sizes.

## What this does NOT tell you

- It ran from one host against one process, both sharing four cores with the
  load generator, so the table understates what a dedicated task does.
- It says nothing about the ALB, the WAF, cross-AZ latency, or RDS with a
  working set that does not fit in memory — which is the failure mode that
  matters most and needs a real deployment with real data volume to find.
- The database held a few hundred deals. Query plans that are fine at that size
  are not evidence about a hundred thousand.
- **Nothing has been deployed to AWS.** These numbers are a local baseline for
  catching a regression that makes a request ten times more expensive. They are
  not a capacity model.

## Thresholds

In `server/src/admin/loadtest.js`:

- p95 under 1500ms
- p99 under 3000ms — what a person experiences on their worst save of the
  afternoon, and about where someone in an IC meeting starts refreshing
- **zero** server errors or dropped connections. A load test that tolerates a
  percentage of 5xx has decided in advance that some failures are acceptable,
  which is not a decision a load test gets to make.
