import React, {
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

export function ErrorNotice({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p className="notice notice-error" role="alert">
      {message}
    </p>
  );
}

export function InfoNotice({ children }: { children: ReactNode }) {
  return (
    <p className="notice notice-info" role="status">
      {children}
    </p>
  );
}

export function Loading({ label = 'Memuat...' }: { label?: string }) {
  return (
    <p className="muted loading-text" role="status">
      <span className="loading-spinner"></span>
      {label}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

interface FieldProps {
  label: string;
  hint?: string;
  hideLabel?: boolean;
}

export function TextField({
  label,
  hint,
  ...input
}: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...input} />
      {hint ? (
        <small id={`${id}-hint`} className="muted">
          {hint}
        </small>
      ) : null}
    </div>
  );
}

export function SelectField({
  label,
  hint,
  hideLabel = false,
  children,
  value,
  onChange,
  disabled,
  ...select
}: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);

  // Extract option items from children safely with TypeScript generics
  const options: Array<{ value: string; label: string }> = [];
  React.Children.forEach(children, (child) => {
    if (
      React.isValidElement<{
        value?: string | number;
        children?: ReactNode;
      }>(child) &&
      child.props
    ) {
      options.push({
        value: String(child.props.value ?? ''),
        label: String(child.props.children ?? child.props.value ?? ''),
      });
    }
  });

  const selectedOption = options.find((opt) => String(opt.value) === String(value));
  const displayLabel = selectedOption
    ? selectedOption.label
    : options.length > 0 && options[0] !== undefined
      ? options[0].label
      : '— Pilih —';

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  // Handle option select
  const handleSelect = (val: string) => {
    setOpen(false);
    if (selectRef.current) {
      selectRef.current.value = val;
      const event = new Event('change', { bubbles: true });
      selectRef.current.dispatchEvent(event);
    }
    if (onChange) {
      const syntheticEvent = {
        target: { value: val },
        currentTarget: { value: val },
      } as React.ChangeEvent<HTMLSelectElement>;
      onChange(syntheticEvent);
    }
  };

  return (
    <div className="field" ref={containerRef}>
      <label htmlFor={id} className={hideLabel ? 'visually-hidden' : undefined}>
        {label}
      </label>

      <div
        className={`custom-select-wrapper ${open ? 'is-open' : ''} ${disabled ? 'is-disabled' : ''}`}
      >
        <button
          type="button"
          id={`${id}-btn`}
          className="custom-select-trigger"
          disabled={disabled || options.length === 0}
          onClick={() => setOpen((prev) => !prev)}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span className="custom-select-value">{displayLabel}</span>
          <svg
            className={`custom-select-chevron ${open ? 'rotate' : ''}`}
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>

        {open && options.length > 0 && (
          <ul className="custom-select-menu" role="listbox">
            {options.map((opt) => {
              const isSelected = String(opt.value) === String(value);
              return (
                <li
                  key={opt.value}
                  role="option"
                  aria-selected={isSelected}
                  className={`custom-select-option ${isSelected ? 'selected' : ''}`}
                  onClick={() => handleSelect(opt.value)}
                >
                  <span className="option-label">{opt.label}</span>
                  {isSelected && (
                    <svg
                      className="check-icon"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/* Hidden but accessible standard select for testing & form handlers */}
        <select
          id={id}
          ref={selectRef}
          value={value}
          disabled={disabled}
          onChange={onChange}
          className="visually-hidden"
          tabIndex={-1}
          aria-hidden="true"
          {...select}
        >
          {children}
        </select>
      </div>

      {hint ? (
        <small id={`${id}-hint`} className="muted">
          {hint}
        </small>
      ) : null}
    </div>
  );
}

export function CheckField({
  label,
  ...input
}: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className="field field-check">
      <input id={id} type="checkbox" {...input} />
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

export const formatTime = (iso: string, timeZone?: string) =>
  new Intl.DateTimeFormat('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(iso));

export const formatDateTime = (iso: string) =>
  new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));

export const formatRupiah = (amount: number) =>
  new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(amount);
