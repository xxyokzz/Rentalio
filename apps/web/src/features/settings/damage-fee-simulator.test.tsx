import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DamageFeeSimulator } from "./damage-fee-simulator";

afterEach(cleanup);

const categories = [{ id: "cat-1", name: "Kamera" }];
const categoryAmounts = {
  "cat-1": { minor: "10000", moderate: "30000", severe: "50000" },
};

describe("DamageFeeSimulator", () => {
  it("menghitung usulan dari nominal umum, lalu override kategori dan plafon", () => {
    render(
      <DamageFeeSimulator
        enabled
        amounts={{ minor: "25000", moderate: "75000", severe: "200000" }}
        maxAmount="40000"
        categories={categories}
        categoryAmounts={categoryAmounts}
      />,
    );

    // Default: ringan, satu item, nominal umum.
    expect(screen.getByLabelText("Jumlah item simulator")).toHaveValue("1");
    expect(screen.getAllByText("Rp 25.000").length).toBeGreaterThan(0);
    expect(screen.getByText(/Memakai nominal umum/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Kategori simulator"));
    fireEvent.click(screen.getByRole("option", { name: "Kamera" }));
    expect(screen.getByText(/menggantikan nominal umum/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Tingkat kondisi simulator"));
    fireEvent.click(screen.getByRole("option", { name: "Parah" }));
    fireEvent.change(screen.getByLabelText("Jumlah item simulator"), {
      target: { value: "2" },
    });

    // 50.000 × 2 = 100.000 dipotong plafon 40.000.
    expect(screen.getAllByText("Rp 50.000").length).toBeGreaterThan(0);
    expect(screen.getByText("Rp 100.000")).toBeTruthy();
    expect(screen.getByText(/dipotong ke plafon/)).toBeTruthy();
  });

  it("menjelaskan override Rp0 kategori bukan pengembalian ke nominal umum", () => {
    render(
      <DamageFeeSimulator
        enabled
        amounts={{ minor: "25000", moderate: "75000", severe: "200000" }}
        maxAmount=""
        categories={categories}
        categoryAmounts={{ "cat-1": { minor: "10000", moderate: "0", severe: "50000" } }}
      />,
    );

    fireEvent.click(screen.getByLabelText("Kategori simulator"));
    fireEvent.click(screen.getByRole("option", { name: "Kamera" }));
    fireEvent.click(screen.getByLabelText("Tingkat kondisi simulator"));
    fireEvent.click(screen.getByRole("option", { name: "Sedang" }));

    // Nominal umum sedang 75.000 tidak boleh dipakai saat kategori Rp0.
    expect(screen.queryByText("Rp 75.000")).toBeNull();
    expect(screen.getByText(/bukan kembali ke nominal umum/)).toBeTruthy();
  });

  it("menjelaskan bahwa tidak ada usulan saat denda nonaktif", () => {
    render(
      <DamageFeeSimulator
        enabled={false}
        amounts={{ minor: "25000", moderate: "75000", severe: "200000" }}
        maxAmount=""
        categories={[]}
        categoryAmounts={{}}
      />,
    );

    expect(screen.getByText(/Denda kerusakan nonaktif/)).toBeTruthy();
  });
});
