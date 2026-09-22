import type { MonitorRegionState } from "../regions/region.service";

export type RegionVerdict = "UP" | "DOWN" | "DEGRADED" | "UNCONFIRMED";
export type GlobalVerdict = "UP" | "DOWN" | "DEGRADED" | "UNCONFIRMED";

export interface QuorumInput {
  states: MonitorRegionState[];
  /** Regions the monitor is currently checked from. */
  regions: string[];
  /** How many regions must independently be failing. */
  confirmations: number;
  /** What the monitor is reported as right now. */
  current: GlobalVerdict | "MAINTENANCE";
}

export interface QuorumResult {
  verdict: GlobalVerdict;
  failingRegions: string[];
  /** How many regions had to agree, given how many are actually reporting. */
  required: number;
}

const FAILING: RegionVerdict[] = ["DOWN", "DEGRADED"];

/**
 * Decide the monitor's overall verdict from what each region reports.
 *
 * Two rules, and the asymmetry between them is deliberate:
 *
 *  - It goes down only when at least `confirmations` regions have each
 *    independently reached their failure threshold. One vantage point cannot
 *    distinguish "the site is down" from "the path between us and the site is
 *    down", and paging someone for the second is how alerting gets ignored.
 *
 *  - It comes back up only when *no* region is still failing. Recovering on a
 *    quorum would flap a monitor back to healthy while a region is still
 *    unable to reach it.
 *
 * Between those two — some regions failing, but not enough to confirm — the
 * previous verdict stands. A persistent single-region failure therefore stays
 * invisible at the top level by design; it is shown per region instead.
 */
export function evaluateQuorum(input: QuorumInput): QuorumResult {
  const relevant = input.states.filter((state) => input.regions.includes(state.region));

  // Cannot need more agreement than there are regions to give it.
  const required = Math.max(1, Math.min(input.confirmations, input.regions.length));

  const failing = relevant.filter((state) => FAILING.includes(state.status));
  const failingRegions = failing.map((state) => state.region);

  if (failing.length >= required) {
    const anyDown = failing.some((state) => state.status === "DOWN");
    return { verdict: anyDown ? "DOWN" : "DEGRADED", failingRegions, required };
  }

  if (failing.length === 0) {
    // Every region that has reported is healthy. A region that has never
    // reported is not evidence of anything, so it does not hold recovery up.
    const reporting = relevant.filter((state) => state.status !== "UNCONFIRMED");
    if (reporting.length > 0) {
      return { verdict: "UP", failingRegions: [], required };
    }

    return { verdict: "UNCONFIRMED", failingRegions: [], required };
  }

  // Some regions are failing, but not enough to confirm. Hold the line.
  const held = input.current === "MAINTENANCE" ? "UNCONFIRMED" : input.current;

  return { verdict: held, failingRegions, required };
}

/**
 * Fold one check result into a region's running streaks.
 *
 * A region flips to failing only once it has seen `failureThreshold`
 * consecutive failures, and back to UP after `recoveryThreshold` successes,
 * so each vantage point debounces on its own before it gets a vote.
 */
export function advanceRegionState(
  previous: Pick<
    MonitorRegionState,
    "status" | "consecutive_failures" | "consecutive_successes"
  >,
  failed: boolean,
  degraded: boolean,
  thresholds: { failureThreshold: number; recoveryThreshold: number }
): Pick<MonitorRegionState, "status" | "consecutive_failures" | "consecutive_successes"> {
  if (failed) {
    const failures = previous.consecutive_failures + 1;

    return {
      consecutive_failures: failures,
      consecutive_successes: 0,
      status:
        failures >= thresholds.failureThreshold
          ? degraded
            ? "DEGRADED"
            : "DOWN"
          : previous.status,
    };
  }

  const successes = previous.consecutive_successes + 1;
  const wasFailing = FAILING.includes(previous.status);

  return {
    consecutive_failures: 0,
    consecutive_successes: successes,
    status:
      !wasFailing || successes >= thresholds.recoveryThreshold ? "UP" : previous.status,
  };
}
