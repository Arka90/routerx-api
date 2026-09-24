# Running probes in more than one region

A single vantage point cannot tell "the site is down" from "the path between
our worker and the site is down". Both look identical from one machine, and
paging someone for the second is how alerting gets ignored.

Adding a region is deploying another worker. There is no migration, no
registry to edit, and nothing to change on existing monitors.

## Adding one

Deploy the same image somewhere else — another VPS, another cloud region —
with the worker command and two extra variables:

```bash
REGION=eu-west
REGION_NAME="EU (Frankfurt)"
```

It needs to reach Postgres and Redis, and nothing else. On startup it
registers `eu-west`, then consumes only `monitor-check-eu-west`.

The API fans monitors out to every enabled region on its next boot, and
`upsertJobScheduler` is idempotent, so an API restart is how existing monitors
pick up the new region. Restart the API after the first worker in a new region
comes up, or wait for the next deploy.

## Requiring agreement

A monitor's alert policy has a **confirmations** setting: how many regions
must independently reach their failure threshold before an incident opens.

- `1` (the default) behaves exactly as a single vantage point did.
- `2` means two regions have to agree. A monitor that only one region cannot
  reach stays up, and the failing region is still visible on the monitor.

Recovery is deliberately asymmetric: it takes a quorum to go down, but **every**
region has to be healthy again to come back up. Recovering on a quorum would
flap a monitor back to green while a region still cannot reach it.

A persistent single-region failure therefore never reaches the top-level
status by design. It is shown per region on the monitor page, which is where
a routing problem belongs.

## Choosing regions per monitor

By default a monitor is checked from every enabled region. A monitor can name
a subset instead — useful for something only reachable from one network, or
to keep a noisy check off a paid region.

An empty list means "all enabled regions", so adding a region does not require
rewriting every monitor.

## What it costs

Every region multiplies outbound checks. Three regions at a 30-second interval
is six checks a minute per monitor. The plan limits cap how many regions a
workspace can spread a monitor across, for that reason.
