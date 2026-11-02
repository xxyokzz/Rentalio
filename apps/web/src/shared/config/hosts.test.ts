import { describe, expect, it } from "vitest";
import {
  isPlatformHost,
  normalizeHostHeader,
  slugFromLocalhost,
  slugFromPlatformSubdomain,
} from "./hosts";

describe("normalizeHostHeader", () => {
  it("membuang port, spasi, huruf besar, dan titik akhir", () => {
    expect(normalizeHostHeader("  Demo.Rentalio.MY.ID:3001 ")).toBe("demo.rentalio.my.id");
    expect(normalizeHostHeader("sewa-kamera.example.com.")).toBe("sewa-kamera.example.com");
  });

  it("mengambil host pertama dari header berantai (X-Forwarded-Host)", () => {
    expect(normalizeHostHeader("sewa-kamera.com, proxy.internal")).toBe("sewa-kamera.com");
  });

  it("mengembalikan null untuk header kosong", () => {
    expect(normalizeHostHeader(undefined)).toBeNull();
    expect(normalizeHostHeader("   ")).toBeNull();
  });
});

describe("slugFromPlatformSubdomain", () => {
  it("membaca label pertama sebagai slug tenant", () => {
    expect(slugFromPlatformSubdomain("demo.rentalio.my.id")).toBe("demo");
    expect(slugFromPlatformSubdomain("sewa-kamera-bdg.rentalio.my.id")).toBe("sewa-kamera-bdg");
  });

  it("menolak domain platform sendiri, label reserved, dan subdomain bertingkat", () => {
    expect(slugFromPlatformSubdomain("rentalio.my.id")).toBeNull();
    expect(slugFromPlatformSubdomain("www.rentalio.my.id")).toBeNull();
    expect(slugFromPlatformSubdomain("app.rentalio.my.id")).toBeNull();
    expect(slugFromPlatformSubdomain("a.b.rentalio.my.id")).toBeNull();
  });

  it("tidak menebak slug dari domain non-platform", () => {
    expect(slugFromPlatformSubdomain("sewa-kamera.com")).toBeNull();
    expect(slugFromPlatformSubdomain("rentalio.my.id.evil.com")).toBeNull();
  });
});

describe("slugFromLocalhost", () => {
  it("mendukung {slug}.localhost untuk pengembangan", () => {
    expect(slugFromLocalhost("demo.localhost")).toBe("demo");
    expect(slugFromLocalhost("localhost")).toBeNull();
    expect(slugFromLocalhost("app.localhost")).toBeNull();
  });
});

describe("isPlatformHost", () => {
  it("membedakan host platform dari kandidat domain kustom", () => {
    expect(isPlatformHost("rentalio.my.id")).toBe(true);
    expect(isPlatformHost("demo.rentalio.my.id")).toBe(true);
    expect(isPlatformHost("localhost")).toBe(true);
    expect(isPlatformHost("127.0.0.1")).toBe(true);
  });

  it("domain kustom dan lookalike bukan host platform", () => {
    expect(isPlatformHost("sewa-kamera.com")).toBe(false);
    expect(isPlatformHost("rentalio.my.id.evil.com")).toBe(false);
    expect(isPlatformHost("demo.localhost.evil.com")).toBe(false);
  });
});
