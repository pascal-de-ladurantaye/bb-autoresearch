// With several bench hosts the segment takes the worst host's MDE; the
// report's headline must describe that host, not whichever came first.
import { describe, expect, it } from "vitest";
import { headlineOutcome } from "../src/calibration.ts";

describe("calibration headline", () => {
  it("is the host whose MDE the segment takes", () => {
    const quiet = { mde: 0.015, report: "win threshold on the CI lower bound: 1.50%" };
    const noisy = { mde: 0.0157, report: "win threshold on the CI lower bound: 1.57%" };
    expect(headlineOutcome([quiet, noisy])).toBe(noisy);
    expect(headlineOutcome([noisy, quiet])).toBe(noisy);
    expect(headlineOutcome([quiet])).toBe(quiet);
    // Ties keep the first host.
    const twin = { ...quiet };
    expect(headlineOutcome([quiet, twin])).toBe(quiet);
  });
});
