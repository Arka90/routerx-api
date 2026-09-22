# Upgrading to Postgres + workspaces

This release replaces SQLite with Postgres and introduces workspaces, so it
is the one upgrade that needs a plan rather than a `git push`. Budget about
fifteen minutes of downtime for a small dataset.

Nothing here is destructive to the old database — the import reads
`routerx.db` read-only and never writes to it. Keep it until you are happy.

## What changes for existing users

| Before | After |
| --- | --- |
| Monitors belong to a user | Monitors belong to a **workspace**; each existing user gets a personal one, as owner |
| Login issues a 7-day JWT that cannot be revoked | Login opens a **server-side session** that can be revoked from Settings |
| Alerts go to the monitor owner by email | Alerts go to the workspace's **notification channels** (an email channel is seeded automatically, so behaviour is unchanged until you add more) |
| Any status below 500 counted as up | **Any 2xx or 3xx** counts as up unless you say otherwise — see the note below |
| Failure thresholds were constants for everyone | Per-monitor **alert policy** |

Everyone is signed out by the upgrade and signs in again with a fresh login
code. Outstanding codes are deliberately not imported.

### The status-code change is a real behaviour change

A monitor whose URL returns `404` was previously reported as **up**, because
only a 5xx counted as a failure. It is now **down**. If you are deliberately
watching an endpoint that returns a 4xx, set its expected status codes before
you cut over, or it will page you.

## Steps

1. **Set the new variables.** Compare your `.env` with `.env.example`. The
   new required ones are `DATABASE_URL`, `POSTGRES_PASSWORD` and `APP_URL`
   (used to build invite links and the "open monitor" button in alerts, so it
   must be the address people actually visit). The API refuses to start
   without `DATABASE_URL` or `JWT_SECRET`.

   In GitHub Actions, add `POSTGRES_PASSWORD` and `APP_URL` as repository
   secrets.

2. **Back up the old database.**

   ```
   docker compose cp api:/app/data/routerx.db ./routerx-backup.db
   ```

3. **Deploy.** `docker compose up -d --build` brings up Postgres alongside
   the existing services. The api applies migrations before it opens its
   listener, so the schema is in place before anything serves a request.

4. **Import.** With the containers running:

   ```
   docker compose run --rm \
     -v $(pwd)/routerx-backup.db:/tmp/routerx.db:ro \
     -e SQLITE_PATH=/tmp/routerx.db \
     api node dist/scripts/migrate-from-sqlite.js
   ```

   It prints what it imported and a row count per table. It is safe to re-run
   — every insert skips rows that already exist — so a partial run can just
   be repeated.

5. **Check.** `curl https://your-api/health/ready` should return `200` with
   both `database` and `redis` reporting `ok`. Then sign in and confirm your
   monitors are listed.

6. **Afterwards.** Once you are confident, `better-sqlite3` can be dropped
   from `dependencies` — it is only still there so the import script can run
   inside the production image.

## Rolling back

The previous release is a `git revert` away and the old SQLite volume is
untouched, so rolling back costs only the monitoring data collected in the
meantime. The one thing that does not roll back is workspace membership:
invitations accepted after the upgrade will not exist in the old schema.

## Notes for a managed Postgres

The schema needs the `citext` extension, which every managed provider I know
of allows. Set `DATABASE_SSL=true` for a provider that requires TLS, and drop
the `postgres` service from `docker-compose.yml`.

---

# Upgrading to status pages, plans, and multi-region

This release is additive. Nothing about how existing monitors are checked
changes unless you opt in, and there is no data migration.

## What is new

| | |
| --- | --- |
| **Public status pages** | A page per workspace at `/status/<slug>`, with 90 days of per-component uptime, incident history and email subscribers. Unpublished by default. |
| **Incident updates** | Post a narrative on an incident — investigating / identified / monitoring / resolved. Public updates appear on any status page carrying that monitor; internal ones do not. |
| **Plans and quotas** | Monitor, member, channel, status page, region and check-interval limits per plan, plus per-plan probe retention. |
| **Multi-region probing** | Checks from several vantage points, with a configurable number of regions that must agree before an incident opens. See [MULTI-REGION.md](MULTI-REGION.md). |

## What you need to do

**Nothing is required.** The defaults preserve current behaviour exactly:

- Every existing workspace is **grandfathered** — unlimited, regardless of
  plan — and `ENFORCE_QUOTAS` is `false`, so nothing is refused either way.
  Usage and limits are reported from day one, so you can look at real numbers
  before deciding.
- Every monitor keeps `confirmations = 1`, which is single-vantage checking,
  and there is one region (`default`) until you deploy a second worker.
- Billing endpoints return `503` until `STRIPE_SECRET_KEY` is set. The rest of
  the app does not care.

## When you do want to turn things on

**Quotas.** Look at `GET /billing` for a workspace first. Then set
`ENFORCE_QUOTAS=true` and clear `grandfathered` on the subscriptions you
actually want limited:

```sql
UPDATE subscriptions SET grandfathered = false WHERE org_id = 42;
```

Going over a limit returns `402` with a message naming the limit. Nothing is
deleted or paused — existing monitors above the limit keep running; only
creating more is refused.

**Billing.** Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and the two
price ids, and point a Stripe webhook at `POST /billing/webhook` for
`checkout.session.completed`, `customer.subscription.*`. The endpoint verifies
the signature and rejects anything unsigned, stale, or replayed.

This path has not been exercised against live Stripe — the signature
verification and the idempotency are unit-tested, but the first real checkout
is the first real test. Run one in Stripe's test mode before pointing anyone
at a pricing page.

**Multi-region.** See [MULTI-REGION.md](MULTI-REGION.md). Deploy a worker
elsewhere with `REGION` set, restart the API so existing monitors fan out to
it, then raise `confirmations` on the monitors you want double-checked.

## Retention changes with plans

Probe history is now pruned per plan (7 / 30 / 90 days) rather than by a
single instance-wide setting. Grandfathered workspaces and any workspace with
no subscription row keep using `PROBE_RETENTION_DAYS`.
