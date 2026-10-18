import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';

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
    <p className="muted" role="status">
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
  children,
  ...select
}: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} {...select}>
        {children}
      </select>
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
  new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', timeZone }).format(
    new Date(iso),
  );

export const formatDateTime = (iso: string) =>
  new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );

export const formatRupiah = (amount: number) =>
  new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(amount);
