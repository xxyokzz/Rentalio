import { describe, expect, it } from "vitest";
import {
  MAX_INSPECTION_ATTACHMENT_BYTES,
  validateInspectionFile,
} from "./inspection-attachments";

describe("validateInspectionFile", () => {
  it("menerima JPEG/PNG/WebP/PDF di bawah 10 MB", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp", "application/pdf"]) {
      expect(validateInspectionFile({ type, size: 2048 })).toBeNull();
    }
  });

  it("menolak tipe lain", () => {
    expect(validateInspectionFile({ type: "text/plain", size: 2048 })).toMatch(/JPEG/);
  });

  it("menolak file kosong", () => {
    expect(validateInspectionFile({ type: "image/jpeg", size: 0 })).toMatch(/kosong/);
  });

  it("menolak file di atas 10 MB", () => {
    expect(
      validateInspectionFile({ type: "image/jpeg", size: MAX_INSPECTION_ATTACHMENT_BYTES + 1 }),
    ).toMatch(/10 MB/);
  });
});
