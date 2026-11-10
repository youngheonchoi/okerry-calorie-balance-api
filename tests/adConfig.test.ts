import { describe, expect, it, vi } from "vitest";
import { createAdConfigHandlers } from "../src/lib/adConfigHandlers";

const origin = "https://okerry-calorie-balance.private-apps.tossmini.com";
describe("public export ad configuration", () => {
  it("returns the export group with exact CORS and no-store, without user identity or DB access", async () => {
    const handlers = createAdConfigHandlers(() => " ait.export-test ");
    const response = handlers.GET(
      new Request("https://api.example.com/api/ads", {
        headers: { Origin: origin },
      }),
    );
    expect(await response.json()).toEqual({
      status: "ok",
      exportRewardedAdGroupId: "ait.export-test",
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("returns null until the dedicated export group is configured", async () => {
    const response = createAdConfigHandlers(() => "").GET(
      new Request("https://api.example.com/api/ads"),
    );
    expect(await response.json()).toEqual({
      status: "ok",
      exportRewardedAdGroupId: null,
    });
  });
  it("rejects an unknown browser origin before reading configuration", () => {
    const read = vi.fn(() => "group");
    const response = createAdConfigHandlers(read).GET(
      new Request("https://api.example.com/api/ads", {
        headers: { Origin: "https://untrusted.example" },
      }),
    );
    expect(response.status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });
});
