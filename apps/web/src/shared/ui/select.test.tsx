import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Select } from "./select";

afterEach(cleanup);

function renderSelect(onChange = vi.fn()) {
  render(
    <Select value="a" onChange={onChange}>
      <option value="a">Aktif</option>
      <option value="b">Selesai</option>
      <option value="c" disabled>
        Dibatalkan
      </option>
    </Select>,
  );
  return onChange;
}

describe("Select", () => {
  it("menampilkan nilai terpilih sebagai combobox", () => {
    renderSelect();
    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("Aktif");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("membuka daftar opsi dan memilih lewat klik", () => {
    const onChange = renderSelect();
    fireEvent.click(screen.getByRole("combobox"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: "Selesai" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((onChange.mock.calls[0]?.[0] as { target: { value: string } }).target.value).toBe("b");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("mendukung navigasi keyboard dan melewati opsi nonaktif", () => {
    const onChange = renderSelect();
    const trigger = screen.getByRole("combobox");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    // Aktif -> Selesai -> (Dibatalkan dilewati) -> Aktif
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect((onChange.mock.calls[0]?.[0] as { target: { value: string } }).target.value).toBe("b");
  });

  it("menutup daftar dengan Escape tanpa memilih", () => {
    const onChange = renderSelect();
    const trigger = screen.getByRole("combobox");

    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "Escape" });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
