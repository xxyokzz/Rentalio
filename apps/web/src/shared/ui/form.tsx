"use client";

import { useId, useState } from "react";
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { Select } from "./select";

interface FieldProps {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}

export function Field({ label, htmlFor, hint, error, required, children }: FieldProps) {
  const hintId = hint ? `${htmlFor}-hint` : undefined;
  const errorId = error ? `${htmlFor}-error` : undefined;
  return (
    <div className="field">
      <label className="label" htmlFor={htmlFor}>
        {label}
        {required ? (
          <span className="required" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {children}
      {hint ? (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface BaseInputProps {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  wrapperClassName?: string;
  showPasswordToggle?: boolean;
}

function describedBy(id: string, hint?: string, error?: string): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

export function TextInput({
  label,
  hint,
  error,
  required,
  wrapperClassName,
  className,
  id,
  type,
  showPasswordToggle = true,
  ...rest
}: BaseInputProps & InputHTMLAttributes<HTMLInputElement>) {
  const generated = useId();
  const inputId = id ?? generated;
  const [showPassword, setShowPassword] = useState(false);
  const isPassword = type === "password";
  const effectiveType = isPassword && showPasswordToggle ? (showPassword ? "text" : "password") : type;

  return (
    <div className={`field ${wrapperClassName ?? ""}`}>
      <label className="label" htmlFor={inputId}>
        {label}
        {required ? (
          <span className="required" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {isPassword && showPasswordToggle ? (
        <div className="input-password-wrap">
          <input
            {...rest}
            id={inputId}
            type={effectiveType}
            required={required}
            className={`input ${className ?? ""}`}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy(inputId, hint, error)}
          />
          <button
            type="button"
            className="password-toggle-btn"
            onClick={() => setShowPassword((prev) => !prev)}
            aria-label={showPassword ? "Sembunyikan password" : "Tampilkan password"}
            title={showPassword ? "Sembunyikan password" : "Tampilkan password"}
          >
            {showPassword ? (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                <line x1="2" y1="2" x2="22" y2="22" />
              </svg>
            ) : (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </button>
        </div>
      ) : (
        <input
          {...rest}
          id={inputId}
          type={type}
          required={required}
          className={`input ${className ?? ""}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(inputId, hint, error)}
        />
      )}
      {hint ? (
        <p className="hint" id={`${inputId}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={`${inputId}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function SelectInput({
  label,
  hint,
  error,
  required,
  wrapperClassName,
  className,
  id,
  children,
  ...rest
}: BaseInputProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className={`field ${wrapperClassName ?? ""}`}>
      <label className="label" htmlFor={inputId}>
        {label}
        {required ? (
          <span className="required" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      <Select
        {...rest}
        id={inputId}
        required={required}
        className={`select ${className ?? ""}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(inputId, hint, error)}
      >
        {children}
      </Select>
      {hint ? (
        <p className="hint" id={`${inputId}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={`${inputId}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TextArea({
  label,
  hint,
  error,
  required,
  wrapperClassName,
  className,
  id,
  ...rest
}: BaseInputProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className={`field ${wrapperClassName ?? ""}`}>
      <label className="label" htmlFor={inputId}>
        {label}
        {required ? (
          <span className="required" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      <textarea
        {...rest}
        id={inputId}
        required={required}
        className={`textarea ${className ?? ""}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(inputId, hint, error)}
      />
      {hint ? (
        <p className="hint" id={`${inputId}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={`${inputId}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function CheckboxField({
  label,
  hint,
  error,
  checked,
  onChange,
  disabled,
  name,
}: {
  label: ReactNode;
  hint?: string;
  error?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  name?: string;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label className="checkbox" htmlFor={id}>
        <input
          id={id}
          name={name}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      {hint ? (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
