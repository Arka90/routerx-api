import { describe, it, expect } from "vitest";
import { analyze } from "../domain/analyzer";

describe("Network Diagnosis", () => {

  it("detects DNS failure", () => {
    const result = analyze({
      dns: null,
      tcp: null,
      tls: null,
      ttfb: null,
      statusCode: null,
      
    });

    expect(result.reason).toBe("DNS_FAILURE");
  });

  it("detects server crash", () => {
    const result = analyze({
      dns: 20,
      tcp: 40,
      tls: 80,
      ttfb: 120,
      statusCode: 500,
    
    });

    expect(result.reason).toBe("SERVER_ERROR");
  });

  it("detects slow backend", () => {
    const result = analyze({
      dns: 20,
      tcp: 40,
      tls: 80,
      ttfb: 2500,
      statusCode: 200,

    });

    expect(result.reason).toBe("BACKEND_LATENCY");
  });

});
