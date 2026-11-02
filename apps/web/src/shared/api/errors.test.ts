import { describe, expect, it } from "vitest";
import {
  ApiRequestError,
  describeApiError,
  extractConflicts,
  isConflict,
  isForbidden,
  isRateLimited,
  isRestrictedTenant,
  isUnauthenticated,
} from "./errors";

describe("error helpers", () => {
  it("mengenali status dan kode kunci", () => {
    expect(isUnauthenticated(new ApiRequestError({ status: 401, code: "UNAUTHENTICATED", message: "" }))).toBe(true);
    expect(isForbidden(new ApiRequestError({ status: 403, code: "PERMISSION_DENIED", message: "" }))).toBe(true);
    expect(isConflict(new ApiRequestError({ status: 409, code: "AVAILABILITY_CONFLICT", message: "" }))).toBe(true);
    expect(isRateLimited(new ApiRequestError({ status: 429, code: "RATE_LIMITED", message: "" }))).toBe(true);
    expect(isRestrictedTenant(new ApiRequestError({ status: 403, code: "TENANT_RESTRICTED", message: "" }))).toBe(true);
  });

  it("tidak salah mengenali error non-API", () => {
    expect(isConflict(new Error("x"))).toBe(false);
    expect(isForbidden(null)).toBe(false);
  });
});

describe("describeApiError", () => {
  it("memberi langkah konkret untuk timeout tanpa klaim sukses", () => {
    const message = describeApiError(
      new ApiRequestError({ status: 0, code: "TIMEOUT", message: "x" }),
    );
    expect(message).toMatch(/periksa status transaksi/i);
  });

  it("menyebut masa tunggu untuk 429", () => {
    const message = describeApiError(
      new ApiRequestError({ status: 429, code: "RATE_LIMITED", message: "x", retryAfterSeconds: 30 }),
    );
    expect(message).toContain("30 detik");
  });

  it("menjelaskan mode terbatas tanpa menyamarkannya sebagai data kosong", () => {
    const message = describeApiError(
      new ApiRequestError({ status: 403, code: "TENANT_RESTRICTED", message: "x" }),
    );
    expect(message).toMatch(/langganan/i);
  });

  it("tidak membocorkan pesan internal untuk error tak dikenal", () => {
    expect(describeApiError("boom")).toMatch(/kesalahan tak terduga/i);
  });
});

describe("extractConflicts", () => {
  it("mengambil daftar konflik dari details", () => {
    const error = new ApiRequestError({
      status: 409,
      code: "AVAILABILITY_CONFLICT",
      message: "x",
      details: { conflicts: [{ allocationId: "a", productName: "Tenda", quantity: 1 }] },
    });
    expect(extractConflicts(error)).toHaveLength(1);
  });

  it("mengembalikan array kosong bila tidak ada details", () => {
    expect(extractConflicts(new ApiRequestError({ status: 409, code: "AVAILABILITY_CONFLICT", message: "x" }))).toEqual([]);
  });
});
