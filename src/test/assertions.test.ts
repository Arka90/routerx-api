import { describe, it, expect } from "vitest";
import { evaluateAssertions, resolveJsonPath } from "../domain/assertions";

const base = {
  assertion_type: "none" as const,
  assertion_value: null,
  expected_status_codes: [] as number[],
};

describe("status code expectations", () => {
  it("accepts any 2xx or 3xx by default", () => {
    for (const status of [200, 201, 204, 301, 302, 399]) {
      expect(evaluateAssertions(base, { statusCode: status, body: null }).passed).toBe(true);
    }
  });

  it("treats a 404 as a failure", () => {
    // The behaviour this replaces called anything below 500 healthy, so a
    // page that had 404'd for a week reported 100% uptime.
    const result = evaluateAssertions(base, { statusCode: 404, body: null });

    expect(result.passed).toBe(false);
    expect(result.failure).toContain("404");
  });

  it("treats a 500 as a failure", () => {
    expect(evaluateAssertions(base, { statusCode: 500, body: null }).passed).toBe(false);
  });

  it("honours an explicit list, including one that allows a 404", () => {
    const config = { ...base, expected_status_codes: [404] };

    expect(evaluateAssertions(config, { statusCode: 404, body: null }).passed).toBe(true);
    expect(evaluateAssertions(config, { statusCode: 200, body: null }).passed).toBe(false);
  });

  it("fails when there was no response at all", () => {
    expect(evaluateAssertions(base, { statusCode: null, body: null }).passed).toBe(false);
  });
});

describe("body assertions", () => {
  it("passes when the body contains the expected text", () => {
    const config = { ...base, assertion_type: "contains" as const, assertion_value: "healthy" };

    expect(
      evaluateAssertions(config, { statusCode: 200, body: "status: healthy" }).passed
    ).toBe(true);
  });

  it("catches a 200 that renders an error page", () => {
    const config = { ...base, assertion_type: "contains" as const, assertion_value: "healthy" };

    const result = evaluateAssertions(config, {
      statusCode: 200,
      body: "<h1>Internal Server Error</h1>",
    });

    expect(result.passed).toBe(false);
    expect(result.failure).toContain("healthy");
  });

  it("supports not_contains", () => {
    const config = {
      ...base,
      assertion_type: "not_contains" as const,
      assertion_value: "Exception",
    };

    expect(
      evaluateAssertions(config, { statusCode: 200, body: "all good" }).passed
    ).toBe(true);
    expect(
      evaluateAssertions(config, { statusCode: 200, body: "NullPointerException" }).passed
    ).toBe(false);
  });
});

describe("json_path assertions", () => {
  const body = JSON.stringify({
    status: "ok",
    data: { items: [{ state: "ready" }, { state: "pending" }] },
    count: 2,
  });

  it("matches a value at a path", () => {
    const config = {
      ...base,
      assertion_type: "json_path" as const,
      assertion_value: "status=ok",
    };

    expect(evaluateAssertions(config, { statusCode: 200, body }).passed).toBe(true);
  });

  it("reports the actual value when it differs", () => {
    const config = {
      ...base,
      assertion_type: "json_path" as const,
      assertion_value: "status=degraded",
    };

    const result = evaluateAssertions(config, { statusCode: 200, body });

    expect(result.passed).toBe(false);
    expect(result.failure).toContain("ok");
  });

  it("walks array indexes", () => {
    const config = {
      ...base,
      assertion_type: "json_path" as const,
      assertion_value: "data.items[1].state=pending",
    };

    expect(evaluateAssertions(config, { statusCode: 200, body }).passed).toBe(true);
  });

  it("passes on presence alone when no expected value is given", () => {
    const config = {
      ...base,
      assertion_type: "json_path" as const,
      assertion_value: "data.items[0].state",
    };

    expect(evaluateAssertions(config, { statusCode: 200, body }).passed).toBe(true);
  });

  it("fails on a missing path rather than silently passing", () => {
    const config = {
      ...base,
      assertion_type: "json_path" as const,
      assertion_value: "data.missing.deep",
    };

    expect(evaluateAssertions(config, { statusCode: 200, body }).passed).toBe(false);
  });

  it("fails when the body is not JSON", () => {
    const config = {
      ...base,
      assertion_type: "json_path" as const,
      assertion_value: "status=ok",
    };

    const result = evaluateAssertions(config, { statusCode: 200, body: "<html>" });

    expect(result.passed).toBe(false);
    expect(result.failure).toContain("JSON");
  });

  it("coerces non-string values for comparison", () => {
    const config = {
      ...base,
      assertion_type: "json_path" as const,
      assertion_value: "count=2",
    };

    expect(evaluateAssertions(config, { statusCode: 200, body }).passed).toBe(true);
  });
});

describe("resolveJsonPath", () => {
  it("returns undefined rather than throwing on a nonsense path", () => {
    expect(resolveJsonPath({ a: 1 }, "a.b.c.d")).toBeUndefined();
    expect(resolveJsonPath(null, "a")).toBeUndefined();
    expect(resolveJsonPath({ a: [1] }, "a[9]")).toBeUndefined();
  });
});
