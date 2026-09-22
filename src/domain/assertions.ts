export type AssertionType = "none" | "contains" | "not_contains" | "json_path";

export interface AssertionConfig {
  assertion_type: AssertionType;
  assertion_value: string | null;
  expected_status_codes: number[];
}

export interface AssertionInput {
  statusCode: number | null;
  body: string | null;
}

export interface AssertionResult {
  passed: boolean;
  /** Human-readable reason, suitable for an alert body. Null when passed. */
  failure: string | null;
}

/**
 * Resolve a dot/bracket path such as `data.items[0].status` against a parsed
 * JSON document.
 *
 * Deliberately not a full JSONPath implementation — no filters, wildcards or
 * recursive descent. Those are what make an expression language worth
 * attacking, and a status endpoint check does not need them.
 */
export function resolveJsonPath(document: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);

  let current: unknown = document;

  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;

    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }

    if (typeof current !== "object") return undefined;

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/**
 * An empty expected_status_codes means "any 2xx or 3xx".
 *
 * This is stricter than the behaviour it replaces, where only a 5xx counted
 * as down and a 404 was reported as healthy. For an uptime monitor, a page
 * that 404s is not up.
 */
function statusAccepted(statusCode: number | null, expected: number[]): boolean {
  if (statusCode === null) return false;
  if (expected.length > 0) return expected.includes(statusCode);
  return statusCode >= 200 && statusCode < 400;
}

export function evaluateAssertions(
  config: AssertionConfig,
  input: AssertionInput
): AssertionResult {
  if (!statusAccepted(input.statusCode, config.expected_status_codes)) {
    const expectation =
      config.expected_status_codes.length > 0
        ? `expected ${config.expected_status_codes.join(" or ")}`
        : "expected a 2xx or 3xx";

    return {
      passed: false,
      failure: `HTTP ${input.statusCode ?? "no response"} (${expectation})`,
    };
  }

  const { assertion_type: type, assertion_value: value } = config;

  if (type === "none" || !value) {
    return { passed: true, failure: null };
  }

  const body = input.body ?? "";

  switch (type) {
    case "contains":
      return body.includes(value)
        ? { passed: true, failure: null }
        : { passed: false, failure: `Response body does not contain "${value}"` };

    case "not_contains":
      return body.includes(value)
        ? { passed: false, failure: `Response body contains "${value}"` }
        : { passed: true, failure: null };

    case "json_path": {
      // "path=expected", or just "path" to assert the value is present.
      const separator = value.indexOf("=");
      const path = separator === -1 ? value : value.slice(0, separator);
      const expected = separator === -1 ? null : value.slice(separator + 1);

      let document: unknown;

      try {
        document = JSON.parse(body);
      } catch {
        return { passed: false, failure: "Response body is not valid JSON" };
      }

      const actual = resolveJsonPath(document, path.trim());

      if (actual === undefined) {
        return { passed: false, failure: `JSON path "${path.trim()}" not found in response` };
      }

      if (expected === null) return { passed: true, failure: null };

      const actualText = typeof actual === "string" ? actual : JSON.stringify(actual);

      return actualText === expected.trim()
        ? { passed: true, failure: null }
        : {
            passed: false,
            failure: `JSON path "${path.trim()}" was ${actualText}, expected ${expected.trim()}`,
          };
    }

    default:
      return { passed: true, failure: null };
  }
}
