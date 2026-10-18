import { createServiceRequestSchema, type CreateServiceRequest } from '@antre/shared-types';
import { useState, type FormEvent } from 'react';

import type { Service } from '../api/schemas';
import { useAuth } from '../auth/AuthContext';
import { CheckField, Empty, ErrorNotice, Loading, TextField, formatRupiah } from '../components/ui';
import { useAction, useResource } from '../lib/hooks';

export interface ServiceFormValues {
  name: string;
  prefix: string;
  duration: string;
  price: string;
  requiresDp: boolean;
  dpAmount: string;
  active: boolean;
}

export const EMPTY_SERVICE: ServiceFormValues = {
  name: '',
  prefix: '',
  duration: '15',
  price: '0',
  requiresDp: false,
  dpAmount: '',
  active: true,
};

function toValues(service: Service): ServiceFormValues {
  return {
    name: service.name,
    prefix: service.ticket_prefix,
    duration: String(service.avg_duration_min),
    price: String(service.price),
    requiresDp: service.requires_dp,
    dpAmount: service.dp_amount === null ? '' : String(service.dp_amount),
    active: service.is_active,
  };
}

/** Validates the form with the shared create schema (the same fields are accepted by PATCH). */
export function buildServicePayload(values: ServiceFormValues) {
  return createServiceRequestSchema.safeParse({
    name: values.name.trim(),
    ticket_prefix: values.prefix.trim().toUpperCase(),
    avg_duration_min: Number(values.duration),
    price: Number(values.price),
    requires_dp: values.requiresDp,
    dp_amount: values.requiresDp ? Number(values.dpAmount) : null,
    is_active: values.active,
  });
}

export function ServiceForm({
  initial,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: ServiceFormValues;
  busy: boolean;
  submitLabel: string;
  onSubmit(payload: CreateServiceRequest): Promise<boolean>;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const set = <K extends keyof ServiceFormValues>(key: K, value: ServiceFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = buildServicePayload(values);
    if (!parsed.success) {
      setProblem(
        'Periksa isian: nama wajib, prefiks 1-3 huruf besar, durasi 1-1440 menit, harga bukan negatif, dan nominal DP harus positif bila DP diwajibkan.',
      );
      return;
    }
    setProblem(null);
    if (await onSubmit(parsed.data)) setValues(initial);
  }

  return (
    <form className="card form-row" onSubmit={(event) => void submit(event)} noValidate>
      <TextField
        label="Nama layanan"
        value={values.name}
        onChange={(e) => set('name', e.target.value)}
      />
      <TextField
        label="Prefiks tiket"
        hint="1-3 huruf besar, mis. A"
        maxLength={3}
        value={values.prefix}
        onChange={(e) => set('prefix', e.target.value)}
      />
      <TextField
        label="Durasi rata-rata (menit)"
        type="number"
        min={1}
        value={values.duration}
        onChange={(e) => set('duration', e.target.value)}
      />
      <TextField
        label="Harga (Rp)"
        type="number"
        min={0}
        value={values.price}
        onChange={(e) => set('price', e.target.value)}
      />
      <CheckField
        label="Wajib DP"
        checked={values.requiresDp}
        onChange={(e) => set('requiresDp', e.target.checked)}
      />
      {values.requiresDp ? (
        <TextField
          label="Nominal DP (Rp)"
          type="number"
          min={1}
          value={values.dpAmount}
          onChange={(e) => set('dpAmount', e.target.value)}
        />
      ) : null}
      <CheckField
        label="Aktif"
        checked={values.active}
        onChange={(e) => set('active', e.target.checked)}
      />
      <ErrorNotice message={problem} />
      <div className="inline-form">
        <button type="submit" className="primary" disabled={busy}>
          {submitLabel}
        </button>
        {onCancel ? (
          <button type="button" onClick={onCancel}>
            Batal
          </button>
        ) : null}
      </div>
    </form>
  );
}

export function ServicesTab() {
  const { api } = useAuth();
  const services = useResource('services', () => api.services());
  const action = useAction();
  const [editing, setEditing] = useState<string | null>(null);

  const refresh = async (work: () => Promise<unknown>) => {
    const ok = await action.run(work);
    if (ok) {
      setEditing(null);
      services.reload();
    }
    return ok;
  };

  return (
    <div className="stack">
      <ErrorNotice message={action.error ?? services.error} />
      {services.loading ? <Loading /> : null}
      {services.data?.length === 0 ? (
        <Empty>Belum ada layanan. Buat layanan pertama Anda.</Empty>
      ) : null}
      <ul className="plain-list">
        {services.data?.map((service) => (
          <li key={service.id} className="card">
            {editing === service.id ? (
              <ServiceForm
                initial={toValues(service)}
                busy={action.busy}
                submitLabel="Simpan"
                onSubmit={(payload) => refresh(() => api.updateService(service.id, payload))}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <div className="row-between">
                <div>
                  <strong>
                    {service.name} ({service.ticket_prefix})
                  </strong>{' '}
                  <span className="badge">{service.is_active ? 'Aktif' : 'Nonaktif'}</span>
                  <div className="muted">
                    {service.avg_duration_min} mnt, {formatRupiah(service.price)}
                    {service.dp_amount !== null ? `, DP ${formatRupiah(service.dp_amount)}` : ''}
                  </div>
                </div>
                <div className="inline-form">
                  <button type="button" onClick={() => setEditing(service.id)}>
                    Ubah
                  </button>
                  <button
                    type="button"
                    disabled={action.busy}
                    onClick={() =>
                      void refresh(() =>
                        api.updateService(service.id, { is_active: !service.is_active }),
                      )
                    }
                  >
                    {service.is_active ? 'Nonaktifkan' : 'Aktifkan'}
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      <h3>Layanan baru</h3>
      <ServiceForm
        initial={EMPTY_SERVICE}
        busy={action.busy}
        submitLabel="Buat layanan"
        onSubmit={(payload) => refresh(() => api.createService(payload))}
      />
    </div>
  );
}
