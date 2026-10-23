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

type SelectFieldProps = FieldProps &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children' | 'onChange' | 'value'> & {
    children?: ReactNode;
    value?: string | number | readonly string[];
    onChange?: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  };

interface SelectOption {
  value: string;
  label: string;
}

const CheckIcon = () => (
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
    aria-hidden="true"
  >
    <polyline points="20 6 9 17 4 12"></polyline>
  </svg>
);

/**
 * Dropdown kustom dengan pola select-only combobox (WAI-ARIA APG): trigger
 * `role="combobox"`, daftar `role="listbox"`, fokus tetap di trigger dan opsi
 * aktif dikomunikasikan lewat aria-activedescendant. onChange dipanggil tepat
 * sekali per pilihan.
 */
export function SelectField({
  label,
  hint,
  hideLabel = false,
  children,
  value,
  onChange,
  disabled,
  id: idProp,
  name,
  required,
  'aria-describedby': describedByProp,
  'aria-invalid': ariaInvalid,
}: SelectFieldProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const labelId = `${id}-label`;
  const valueId = `${id}-value`;
  const listId = `${id}-list`;
  const hintId = `${id}-hint`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const typed = useRef<{ text: string; timer?: ReturnType<typeof setTimeout> }>({ text: '' });

  const options: SelectOption[] = [];
  React.Children.forEach(children, (child) => {
    if (React.isValidElement<{ value?: string | number; children?: ReactNode }>(child)) {
      options.push({
        value: String(child.props.value ?? ''),
        label: String(child.props.children ?? child.props.value ?? ''),
      });
    }
  });

  const current = value === undefined ? '' : String(value);
  const selectedIndex = options.findIndex((opt) => opt.value === current);
  const displayLabel = options[selectedIndex]?.label ?? options[0]?.label ?? '— Pilih —';
  const isDisabled = disabled === true || options.length === 0;
  const lastIndex = options.length - 1;

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const el = document.getElementById(`${id}-opt-${active}`);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [open, active, id]);

  useEffect(() => {
    const t = typed.current;
    return () => clearTimeout(t.timer);
  }, []);

  const openMenu = (index?: number) => {
    setActive(index ?? (selectedIndex >= 0 ? selectedIndex : 0));
    setOpen(true);
  };

  const choose = (index: number) => {
    const opt = options[index];
    setOpen(false);
    triggerRef.current?.focus();
    if (opt === undefined || opt.value === current) return;
    onChange?.({
      target: { value: opt.value, name },
      currentTarget: { value: opt.value, name },
    } as unknown as React.ChangeEvent<HTMLSelectElement>);
  };

  const typeahead = (char: string): number => {
    const t = typed.current;
    clearTimeout(t.timer);
    t.text += char.toLowerCase();
    t.timer = setTimeout(() => {
      t.text = '';
    }, 500);
    const from = open ? active : Math.max(selectedIndex, 0);
    const shift = t.text.length > 1 ? 0 : 1;
    for (let step = 0; step < options.length; step += 1) {
      const i = (from + shift + step) % options.length;
      if (options[i]?.label.toLowerCase().startsWith(t.text)) return i;
    }
    return -1;
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (isDisabled || event.ctrlKey || event.metaKey) return;
    const { key } = event;
    if (!open) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
        event.preventDefault();
        openMenu();
      } else if (key === 'Home' || key === 'End') {
        event.preventDefault();
        openMenu(key === 'Home' ? 0 : lastIndex);
      } else if (key.length === 1 && !event.altKey) {
        event.preventDefault();
        const hit = typeahead(key);
        if (hit >= 0) openMenu(hit);
      }
      return;
    }
    switch (key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive((i) => Math.min(i + 1, lastIndex));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
        break;
      case 'Home':
        event.preventDefault();
        setActive(0);
        break;
      case 'End':
        event.preventDefault();
        setActive(lastIndex);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        choose(active);
        break;
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        if (key.length === 1 && !event.altKey) {
          event.preventDefault();
          const hit = typeahead(key);
          if (hit >= 0) setActive(hit);
        }
    }
  };

  const describedBy = [describedByProp, hint ? hintId : undefined].filter(Boolean).join(' ');

  return (
    <div className="field" ref={containerRef}>
      <label id={labelId} htmlFor={id} className={hideLabel ? 'visually-hidden' : undefined}>
        {label}
      </label>

      <div
        className={`custom-select-wrapper ${open ? 'is-open' : ''} ${disabled ? 'is-disabled' : ''}`}
      >
        <button
          type="button"
          role="combobox"
          id={id}
          ref={triggerRef}
          className="custom-select-trigger"
          disabled={isDisabled}
          onClick={() => (open ? setOpen(false) : openMenu())}
          onKeyDown={onKeyDown}
          onKeyUp={(event) => {
            if (event.key === ' ') event.preventDefault();
          }}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open ? `${id}-opt-${active}` : undefined}
          aria-labelledby={`${labelId} ${valueId}`}
          aria-describedby={describedBy || undefined}
          aria-invalid={ariaInvalid}
          aria-required={required ? true : undefined}
        >
          <span id={valueId} className="custom-select-value">
            {displayLabel}
          </span>
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
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>

        {open && options.length > 0 && (
          <ul id={listId} className="custom-select-menu" role="listbox" aria-labelledby={labelId}>
            {options.map((opt, index) => {
              const isSelected = index === selectedIndex;
              return (
                <li
                  key={opt.value}
                  id={`${id}-opt-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  className={`custom-select-option ${isSelected ? 'selected' : ''} ${index === active ? 'active' : ''}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(index)}
                >
                  <span className="option-label">{opt.label}</span>
                  {isSelected && <CheckIcon />}
                </li>
              );
            })}
          </ul>
        )}

        {name ? <input type="hidden" name={name} value={current} /> : null}
      </div>

      {hint ? (
        <small id={hintId} className="muted">
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
