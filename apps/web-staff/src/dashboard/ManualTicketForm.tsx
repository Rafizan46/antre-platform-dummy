import { waPhoneSchema } from '@antre/shared-types';
import { useState, type FormEvent } from 'react';

import type { Service } from '../api/schemas';
import { SelectField, TextField } from '../components/ui';

export interface ManualTicketValues {
  serviceId: string;
  customerName: string;
  customerPhone?: string;
}

export function ManualTicketForm({
  services,
  busy,
  onSubmit,
}: {
  services: Service[];
  busy: boolean;
  onSubmit(values: ManualTicketValues): Promise<boolean>;
}) {
  const active = services.filter((s) => s.is_active);
  const [serviceId, setServiceId] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const chosen = active.some((s) => s.id === serviceId) ? serviceId : (active[0]?.id ?? '');

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') return setProblem('Nama pelanggan wajib diisi.');
    const digits = phone.trim();
    if (digits !== '' && !waPhoneSchema.safeParse(digits).success) {
      return setProblem(
        'Nomor WhatsApp harus berupa angka dengan kode negara, mis. 6281234567890.',
      );
    }
    setProblem(null);
    const ok = await onSubmit({
      serviceId: chosen,
      customerName: trimmed,
      customerPhone: digits === '' ? undefined : digits,
    });
    if (ok) {
      setName('');
      setPhone('');
    }
  }

  return (
    <form className="card form-row" onSubmit={(event) => void submit(event)} noValidate>
      <h3>Tiket manual</h3>
      <SelectField label="Layanan" value={chosen} onChange={(e) => setServiceId(e.target.value)}>
        {active.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </SelectField>
      <TextField
        label="Nama pelanggan"
        value={name}
        maxLength={100}
        onChange={(e) => setName(e.target.value)}
      />
      <TextField
        label="Nomor WhatsApp (opsional)"
        inputMode="numeric"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
      />
      {problem !== null ? (
        <p className="notice notice-error" role="alert">
          {problem}
        </p>
      ) : null}
      <button type="submit" className="primary" disabled={busy || chosen === ''}>
        Buat tiket
      </button>
    </form>
  );
}
