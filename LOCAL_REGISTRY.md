# Running the registry against a local copy of the corpus

Tests, fixes, measurements and experiments run here, never against production
(REGISTRY_MIGRATION_DECISIONS.md D25). Everything stays on this machine and costs nothing against the
Turso quota.

> ⚠ **Any `npm run` script that loads `.env` runs against production** — `dev`, `seed`, `rescore`,
> `migrate`, `add-repo`, `refresh-stats`, `delist`, `parity:api`. `.env` holds the production
> `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. Everything below passes the database explicitly instead.

`sqld` is the server Turso runs, and it counts rows read and written with the same accounting Turso
bills. That makes it the way to measure what a change costs before shipping it: every number in
REGISTRY_MIGRATION_FINDINGS.md §16 came from it.

## Setup

```bash
# 1. Copy the built corpus. `cp -c` is an APFS clone: instant, and no extra disk until written.
cp -c build/registry.db /tmp/registry-local.db

# 2. Bring it to the live schema. file: URLs only — these scripts never read .env this way.
npx tsx scripts/prepare-corpus-db.ts --url file:/tmp/registry-local.db
npx tsx scripts/migrate.ts --url file:/tmp/registry-local.db

# 3. Serve it on loopback. The directory must hold only the `data` link; sqld lays it out itself on first
#    start, and fails if dbs/default already exists. sqld comes with `brew install tursodatabase/tap/turso`.
#    Prefer it to `turso dev`, which binds 0.0.0.0 with no auth.
mkdir -p /tmp/registry-sqld && ln -s /tmp/registry-local.db /tmp/registry-sqld/data
sqld --no-welcome --http-listen-addr 127.0.0.1:8081 --admin-listen-addr 127.0.0.1:8082 -d /tmp/registry-sqld

# 4. Run the API against it, with the database set explicitly. src/index.ts binds 127.0.0.1 unless HOST says otherwise.
TURSO_DATABASE_URL=http://127.0.0.1:8081 AUTH_JWT_SECRET=local-only npx tsx src/index.ts
```

The CLI and the site can use it too: `SKILLDEX_REGISTRY_URL=http://127.0.0.1:3000/v1` for skilldex-cli,
`REGISTRY_URL` for Skilldex-web.

## Measuring a change

```bash
# Cumulative rows read and written, and the statements that read the most.
curl -s http://127.0.0.1:8082/v1/namespaces/default/stats | jq '{rows_read_count, rows_written_count, top_queries}'
```

Take the counters before and after one request, with nothing else touching the database, and the
difference is that request's cost. To compare against the code before a change, serve the old commit
beside the new one on another port against the same database:
`git archive <commit> | tar -x -C /tmp/registry-old`, symlink `node_modules`, and run it with
`PORT=3001`.

## What a local copy does not tell you

- **Latency.** There is no network hop, no contention and no CDN. Query cost transfers; timings do not.
- **Production's data after the 2026-09-06 cutover** — the official skillsets, publishes, install
  counts. Read its costs as production's; do not read its rows as production's.
