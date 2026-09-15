# Backup and restore

An untested backup is a belief. This procedure exists so the first restore is not
performed during an outage.

**RPO 5 minutes / RTO 2 hours** — the figures the DPA should commit to, derived
below. Do not quote them to a customer until the drill has been run against the
real instance at least once.

## What exists

- RDS automated backups, 30-day retention, point-in-time recovery to any second
  in that window (`infra/lib/platform.js`).
- Multi-AZ, so an availability-zone failure is a failover of seconds — **not a
  backup**. Multi-AZ replicates a `DROP TABLE` faithfully.
- The SPA bucket is versioned; a bad frontend deploy is a rollback.

## The failure this procedure is really for

Not hardware. The realistic disasters are a bad migration, a mistaken purge, or a
compromised credential — all of which Multi-AZ replicates instantly. Point-in-time
recovery to just before the event is the actual remedy.

## Restore

```sh
# 1. Restore to a NEW instance. Never in place: the damaged instance is evidence,
#    and an in-place restore destroys the ability to establish what happened.
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier <prod> \
  --target-db-instance-identifier cre-restore-$(date +%Y%m%d-%H%M) \
  --restore-time 2026-01-01T12:34:00Z \
  --db-subnet-group-name <isolated-subnet-group> \
  --vpc-security-group-ids <db-sg>

# 2. VERIFY BEFORE CUTTING OVER. A restore that comes back missing its roles or
#    its row level security policies looks healthy and has no tenant boundary.
psql "$RESTORED_URL" -f docs/runbooks/verify-restore.sql

# 3. Cut over by repointing DB_HOST and redeploying the service.
# 4. Keep the damaged instance until the post-incident review is written.
```

## The check that matters

Roles are **cluster-wide**, not per database. A restored snapshot brings the
tables, the policies and the grants; whether `app_user` and `auth_user` exist
with the right attributes depends on how the target was created. If they are
missing, the application cannot connect. If they exist with **different**
attributes — `BYPASSRLS`, or owning the tables — it connects and there is no
tenant isolation at all, silently.

`verify-restore.sql` asserts exactly that, and refuses rather than warns.

## Drill

**Quarterly, and before the first customer.** Restore to a scratch instance, run
the verification, run the server suite against it, then delete it. Record the
wall-clock time — that is where the RTO figure comes from, and it is the only
honest source for it.

The drill has not yet been run against real RDS. The procedure and its
verification have been exercised against a local Postgres restore, which
validates the SQL and the logic but not the AWS mechanics.
