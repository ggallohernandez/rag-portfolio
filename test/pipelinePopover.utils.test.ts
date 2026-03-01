import { describe, expect, it } from "vitest";
import {
  buildHistogramLineData,
  formatBytes,
  formatPercent,
  formatUsd,
  safeText,
  toNumber
} from "../lib/pipelinePopover.js";

describe("pipeline popover utils", () => {
  it("formats bytes and currency", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(2048)).toBe("2.00 KB");
    expect(formatUsd(0.123456)).toBe("$0.1235");
    expect(formatPercent(32.129)).toBe("32.13%");
  });

  it("shapes histogram bins for chart", () => {
    const data = buildHistogramLineData([
      { range_label: "0-99", count: 2 },
      { range_label: "100-199", count: 5 }
    ]);

    expect(data).toEqual([
      { range: "0-99", count: 2 },
      { range: "100-199", count: 5 }
    ]);
  });

  it("handles fallback coercion and text", () => {
    expect(toNumber("12.5")).toBe(12.5);
    expect(toNumber("abc", 7)).toBe(7);
    expect(safeText("")).toBe("Not available.");
    expect(safeText("hello")).toBe("hello");
  });
});
