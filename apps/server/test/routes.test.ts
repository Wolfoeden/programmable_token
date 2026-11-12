import { afterEach, expect, it, vi } from "vitest";
import { RouteClient } from "../src/routes.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("retries transient route misses and retains reported destinations outside the local airport catalogue", async () => {
  const base = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(base);
  const fetch = vi.fn().mockResolvedValueOnce(new Response("not found", { status: 404 })).mockResolvedValueOnce(new Response(JSON.stringify({ response: { flightroute: {
    callsign_iata: "RG123", origin: { icao_code: "OMDB" }, destination: { icao_code: "ZZZZ" },
  } } })));
  vi.stubGlobal("fetch", fetch);
  const client = new RouteClient("https://route-provider.invalid");
  expect(await client.lookup("REG123")).toBe(null);
  clock.mockReturnValue(base + 1000);
  expect(await client.lookup("REG123")).toBe(null);
  expect(fetch).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(base + 30_001);
  expect(await client.lookup("REG123")).toMatchObject({ flightNumber: "RG123", origin: "OMDB", destination: "ZZZZ" });
  expect(fetch).toHaveBeenCalledTimes(2);
});
