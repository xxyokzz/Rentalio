import { describe, expect, it } from "vitest";
import { simulateDamageFee, type DamageFeeSimulationInput } from "./damage-fee-simulation";

const BASE: DamageFeeSimulationInput = {
  enabled: true,
  severity: "MINOR",
  quantity: 1,
  categoryId: "",
  amounts: { minor: "25000", moderate: "75000", severe: "200000" },
  maxAmount: "",
  categoryAmounts: {},
};

describe("simulateDamageFee", () => {
  it("memakai nominal umum dikali jumlah item", () => {
    const result = simulateDamageFee({ ...BASE, severity: "SEVERE", quantity: 2 });
    expect(result.source).toBe("GENERAL");
    expect(result.rate).toBe("200000");
    expect(result.rawAmount).toBe("400000");
    expect(result.amount).toBe("400000");
    expect(result.capped).toBe(false);
  });

  it("memakai override kategori sepenuhnya, termasuk nominal Rp0", () => {
    const categoryAmounts = {
      "cat-1": { minor: "10000", moderate: "0", severe: "50000" },
    };
    const overridden = simulateDamageFee({
      ...BASE,
      categoryId: "cat-1",
      severity: "SEVERE",
      categoryAmounts,
    });
    expect(overridden.source).toBe("CATEGORY");
    expect(overridden.amount).toBe("50000");

    const zero = simulateDamageFee({
      ...BASE,
      categoryId: "cat-1",
      severity: "MODERATE",
      categoryAmounts,
    });
    expect(zero.amount).toBeNull();
    expect(zero.notice).toBe("ZERO");
  });

  it("memotong usulan ke plafon dan menandai capped", () => {
    const result = simulateDamageFee({ ...BASE, severity: "SEVERE", quantity: 3, maxAmount: "500000" });
    expect(result.rawAmount).toBe("600000");
    expect(result.amount).toBe("500000");
    expect(result.capped).toBe(true);
    expect(result.maxAmount).toBe("500000");
  });

  it("membedakan sebab usulan kosong: saklar mati, jumlah kosong, nominal Rp0", () => {
    expect(simulateDamageFee({ ...BASE, enabled: false }).notice).toBe("DISABLED");
    expect(simulateDamageFee({ ...BASE, quantity: 0 }).notice).toBe("NO_QUANTITY");
    expect(simulateDamageFee({ ...BASE, quantity: Number.NaN }).notice).toBe("NO_QUANTITY");
    expect(simulateDamageFee({ ...BASE, quantity: Number.NaN }).amount).toBeNull();
    expect(simulateDamageFee({ ...BASE, amounts: { ...BASE.amounts, minor: "0" } }).notice).toBe(
      "ZERO",
    );
  });

  it("override kategori tetap berlaku saat nominalnya Rp0 (tidak kembali ke umum)", () => {
    const zero = simulateDamageFee({
      ...BASE,
      categoryId: "cat-1",
      categoryAmounts: { "cat-1": { minor: "0", moderate: "0", severe: "0" } },
    });
    expect(zero.source).toBe("CATEGORY");
    expect(zero.rate).toBe("0");
    expect(zero.amount).toBeNull();
    expect(zero.notice).toBe("ZERO");
  });
});
