import request from "supertest";
import app from "../app";
import { describe, it, expect } from "vitest";

describe("Health Endpoint", () => {

  it("returns ok", async () => {
    const res = await request(app).get("/health");

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("ok");
  });

});
