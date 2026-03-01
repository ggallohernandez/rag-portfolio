import { describe, expect, it } from "vitest";
import { chatCostUsd, costFromPerMillion, embeddingCostUsd } from "../src/services/costing.js";

describe("costing helpers", () => {
  it("calculates per-million token cost deterministically", () => {
    expect(costFromPerMillion(0, 0.2)).toBe(0);
    expect(costFromPerMillion(1_000_000, 0.2)).toBe(0.2);
    expect(costFromPerMillion(500_000, 0.2)).toBe(0.1);
  });

  it("calculates embedding cost", () => {
    expect(embeddingCostUsd(1200, 0.02)).toBe(0.000024);
  });

  it("calculates chat input/output cost", () => {
    const cost = chatCostUsd(2000, 500, 0.15, 0.6);
    expect(cost).toBe(0.0006);
  });
});
