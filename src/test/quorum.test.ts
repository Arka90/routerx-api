import { describe, it, expect } from "vitest";
import { advanceRegionState, evaluateQuorum } from "../modules/monitor/quorum";
import type { MonitorRegionState } from "../modules/regions/region.service";

function state(
  region: string,
  status: MonitorRegionState["status"]
): MonitorRegionState {
  return {
    monitor_id: 1,
    region,
    status,
    consecutive_failures: 0,
    consecutive_successes: 0,
    last_checked_at: null,
    last_root_cause: null,
    last_detail: null,
  };
}

const THRESHOLDS = { failureThreshold: 3, recoveryThreshold: 2 };

describe("region state", () => {
  it("does not flip to DOWN before the threshold", () => {
    let current = { status: "UP" as const, consecutive_failures: 0, consecutive_successes: 5 };

    const first = advanceRegionState(current, true, false, THRESHOLDS);
    expect(first.status).toBe("UP");
    expect(first.consecutive_failures).toBe(1);

    const second = advanceRegionState(first, true, false, THRESHOLDS);
    expect(second.status).toBe("UP");

    const third = advanceRegionState(second, true, false, THRESHOLDS);
    expect(third.status).toBe("DOWN");
  });

  it("marks DEGRADED rather than DOWN for a slow check", () => {
    let current = { status: "UP" as const, consecutive_failures: 2, consecutive_successes: 0 };

    expect(advanceRegionState(current, true, true, THRESHOLDS).status).toBe("DEGRADED");
  });

  it("needs consecutive successes to recover", () => {
    const down = { status: "DOWN" as const, consecutive_failures: 4, consecutive_successes: 0 };

    const first = advanceRegionState(down, false, false, THRESHOLDS);
    expect(first.status).toBe("DOWN");
    expect(first.consecutive_successes).toBe(1);

    expect(advanceRegionState(first, false, false, THRESHOLDS).status).toBe("UP");
  });

  it("resets the failure streak on any success", () => {
    const failing = { status: "UP" as const, consecutive_failures: 2, consecutive_successes: 0 };

    expect(advanceRegionState(failing, false, false, THRESHOLDS).consecutive_failures).toBe(0);
  });
});

describe("quorum", () => {
  const regions = ["eu-west", "us-east", "ap-south"];

  it("stays up when one region of three is failing and two must agree", () => {
    const result = evaluateQuorum({
      states: [state("eu-west", "DOWN"), state("us-east", "UP"), state("ap-south", "UP")],
      regions,
      confirmations: 2,
      current: "UP",
    });

    // This is the whole point: one vantage point cannot distinguish "the site
    // is down" from "our path to the site is down".
    expect(result.verdict).toBe("UP");
    expect(result.failingRegions).toEqual(["eu-west"]);
  });

  it("goes down once the required number of regions agree", () => {
    const result = evaluateQuorum({
      states: [state("eu-west", "DOWN"), state("us-east", "DOWN"), state("ap-south", "UP")],
      regions,
      confirmations: 2,
      current: "UP",
    });

    expect(result.verdict).toBe("DOWN");
    expect(result.failingRegions).toHaveLength(2);
  });

  it("reports DOWN rather than DEGRADED when the failures are mixed", () => {
    const result = evaluateQuorum({
      states: [state("eu-west", "DEGRADED"), state("us-east", "DOWN"), state("ap-south", "UP")],
      regions,
      confirmations: 2,
      current: "UP",
    });

    expect(result.verdict).toBe("DOWN");
  });

  it("reports DEGRADED when every failing region is only slow", () => {
    const result = evaluateQuorum({
      states: [
        state("eu-west", "DEGRADED"),
        state("us-east", "DEGRADED"),
        state("ap-south", "UP"),
      ],
      regions,
      confirmations: 2,
      current: "UP",
    });

    expect(result.verdict).toBe("DEGRADED");
  });

  it("holds DOWN until every region is healthy again", () => {
    const partial = evaluateQuorum({
      states: [state("eu-west", "DOWN"), state("us-east", "UP"), state("ap-south", "UP")],
      regions,
      confirmations: 2,
      current: "DOWN",
    });

    // Recovering on a quorum would flap back to healthy while a region still
    // cannot reach the site.
    expect(partial.verdict).toBe("DOWN");

    const clear = evaluateQuorum({
      states: [state("eu-west", "UP"), state("us-east", "UP"), state("ap-south", "UP")],
      regions,
      confirmations: 2,
      current: "DOWN",
    });

    expect(clear.verdict).toBe("UP");
  });

  it("cannot require more agreement than there are regions", () => {
    const result = evaluateQuorum({
      states: [state("default", "DOWN")],
      regions: ["default"],
      confirmations: 3,
      current: "UP",
    });

    expect(result.required).toBe(1);
    expect(result.verdict).toBe("DOWN");
  });

  it("ignores a region the monitor no longer runs in", () => {
    const result = evaluateQuorum({
      states: [state("eu-west", "UP"), state("retired-region", "DOWN")],
      regions: ["eu-west"],
      confirmations: 1,
      current: "UP",
    });

    expect(result.verdict).toBe("UP");
  });

  it("stays unconfirmed until at least one region has reported", () => {
    const result = evaluateQuorum({
      states: [state("eu-west", "UNCONFIRMED")],
      regions: ["eu-west"],
      confirmations: 1,
      current: "UNCONFIRMED",
    });

    expect(result.verdict).toBe("UNCONFIRMED");
  });

  it("does not let a region that has never reported hold up recovery", () => {
    const result = evaluateQuorum({
      states: [state("eu-west", "UP"), state("us-east", "UNCONFIRMED")],
      regions: ["eu-west", "us-east"],
      confirmations: 1,
      current: "DOWN",
    });

    expect(result.verdict).toBe("UP");
  });

  it("behaves exactly as single-vantage checking when there is one region", () => {
    const down = evaluateQuorum({
      states: [state("default", "DOWN")],
      regions: ["default"],
      confirmations: 1,
      current: "UP",
    });

    expect(down.verdict).toBe("DOWN");

    const up = evaluateQuorum({
      states: [state("default", "UP")],
      regions: ["default"],
      confirmations: 1,
      current: "DOWN",
    });

    expect(up.verdict).toBe("UP");
  });
});
