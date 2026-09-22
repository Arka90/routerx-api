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
