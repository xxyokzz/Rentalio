"use client";

import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";

type OptionRecord = { value: string; label: string; disabled: boolean };

type MenuPosition = {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
};

const MENU_GAP = 6;
const VIEWPORT_MARGIN = 12;
const MENU_MAX_HEIGHT = 320;

/**
 * Membaca <option> dan <optgroup> dari children agar komponen ini bisa dipakai
 * sebagai pengganti langsung <select> tanpa mengubah pemanggil.
 */
function collectOptions(children: ReactNode, out: OptionRecord[] = []): OptionRecord[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === "option") {
      const props = (
        child as ReactElement<{
          value?: string | number;
          disabled?: boolean;
          children?: ReactNode;
        }>
      ).props;
      const label = (
        typeof props.children === "string" || typeof props.children === "number"
          ? String(props.children)
          : Children.toArray(props.children).join("")
      ).trim();
      out.push({
        value: String(props.value ?? label),
        label,
        disabled: Boolean(props.disabled),
      });
      return;
    }
    if (child.type === "optgroup") {
      const props = (child as ReactElement<{ children?: ReactNode }>).props;
      collectOptions(props.children, out);
    }
  });
  return out;
}

/**
 * Dropdown kustom: tombol bergaya panel dengan daftar opsi mengambang yang
 * dirender ke body (portal), sehingga tidak terpotong dialog atau panel
 * bergulir. Navigasi keyboard mengikuti pola combobox + listbox.
 */
export function Select({
  children,
  className,
  id,
  name,
  value,
  defaultValue,
  onChange,
  disabled,
  required,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const listId = `${controlId}-listbox`;

  const options = useMemo(() => collectOptions(children), [children]);
  const selectedIndex = options.findIndex((option) => option.value === String(value ?? defaultValue ?? ""));

  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [position, setPosition] = useState<MenuPosition | null>(null);

  const measure = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
    const spaceAbove = rect.top - MENU_GAP - VIEWPORT_MARGIN;
    const placeAbove = spaceBelow < 180 && spaceAbove > spaceBelow;
    const available = Math.max(120, placeAbove ? spaceAbove : spaceBelow);
    setPosition({
      left: Math.min(
        Math.max(VIEWPORT_MARGIN, rect.left),
        Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN),
      ),
      width: rect.width,
      maxHeight: Math.min(MENU_MAX_HEIGHT, available),
      ...(placeAbove
        ? { bottom: window.innerHeight - rect.top + MENU_GAP }
        : { top: rect.bottom + MENU_GAP }),
    });
  }, []);

  // Tutup saat pengguna menggulir atau mengubah ukuran jendela; menu fixed
  // tidak boleh tertinggal dari tombolnya.
  useEffect(() => {
    if (!open) return;
    measure();

    const closeOnViewportChange = (event: Event) => {
      if (menuRef.current && event.target instanceof Node && menuRef.current.contains(event.target)) {
        return;
      }
      setOpen(false);
    };
    window.addEventListener("scroll", closeOnViewportChange, true);
    window.addEventListener("resize", closeOnViewportChange);
    return () => {
      window.removeEventListener("scroll", closeOnViewportChange, true);
      window.removeEventListener("resize", closeOnViewportChange);
    };
  }, [measure, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listId, open]);

  const openMenu = () => {
    const fallback = options.findIndex((option) => !option.disabled);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : Math.max(0, fallback));
    setOpen(true);
  };

  const moveActive = (step: 1 | -1) => {
    if (options.length === 0) return;
    setActiveIndex((current) => {
      let next = current;
      for (let attempt = 0; attempt < options.length; attempt += 1) {
        next = (next + step + options.length) % options.length;
        if (!options[next]?.disabled) return next;
      }
      return current;
    });
  };

  const commit = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    if (option.value !== String(value ?? defaultValue ?? "")) {
      onChange?.({
        target: { value: option.value, name },
      } as unknown as ChangeEvent<HTMLSelectElement>);
    }
    setOpen(false);
    buttonRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) openMenu();
        else moveActive(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!open) openMenu();
        else moveActive(-1);
        break;
      case "Home":
        if (open) {
          event.preventDefault();
          setActiveIndex(0);
        }
        break;
      case "End":
        if (open) {
          event.preventDefault();
          setActiveIndex(options.length - 1);
        }
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (open) commit(activeIndex);
        else openMenu();
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          setOpen(false);
        }
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  };

  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  // Sisa props berasal dari SelectHTMLAttributes; hanya atribut yang juga valid
  // untuk <button> yang dipakai (id, name, data-*, aria-*, onFocus, dsb.).
  const buttonProps = rest as unknown as ButtonHTMLAttributes<HTMLButtonElement>;

  return (
    <div className="select-control" ref={containerRef}>
      <button
        {...buttonProps}
        ref={buttonRef}
        type="button"
        id={controlId}
        className={`select ${className ?? ""}`}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        aria-required={required || undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={handleKeyDown}
      >
        <span className={`select-value ${selected ? "" : "is-placeholder"}`}>
          {selected?.label ?? "Pilih opsi"}
        </span>
        <svg
          className="select-chevron"
          width="15"
          height="15"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m4 6.5 4 4 4-4" />
        </svg>
      </button>

      {name ? (
        <input
          type="hidden"
          name={name}
          value={value ?? defaultValue ?? ""}
          disabled={disabled}
        />
      ) : null}

      {open && position && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              className="select-menu"
              id={listId}
              role="listbox"
              tabIndex={-1}
              aria-labelledby={controlId}
              style={{
                left: position.left,
                width: position.width,
                top: position.top,
                bottom: position.bottom,
                maxHeight: position.maxHeight,
              }}
            >
              {options.map((option, index) => {
                const isSelected = option.value === String(value ?? defaultValue ?? "");
                return (
                  <div
                    key={`${option.value}-${index}`}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={option.disabled || undefined}
                    className="select-option"
                    data-active={index === activeIndex || undefined}
                    data-selected={isSelected || undefined}
                    onPointerDown={(event) => event.preventDefault()}
                    onPointerMove={() => setActiveIndex(index)}
                    onClick={() => commit(index)}
                  >
                    <span>{option.label}</span>
                    {isSelected ? (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.9"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="m3.5 8.5 3 3 6-7" />
                      </svg>
                    ) : null}
                  </div>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
