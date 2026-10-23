import {
  BUSINESS_TYPES,
  LOCATION_TIMEZONES,
  registerRequestSchema,
  type BusinessType,
  type LocationTimezone,
} from '@antre/shared-types';
import { useState, type FormEvent } from 'react';

import { describeError } from '../api/errors';
import { useAuth } from '../auth/AuthContext';
import { ErrorNotice, InfoNotice, SelectField, TextField } from '../components/ui';

const BUSINESS_LABELS: Record<BusinessType, string> = {
  CLINIC: 'Klinik',
  SPORTS: 'Olahraga',
  BARBERSHOP: 'Barbershop',
  OTHER: 'Lainnya',
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);

export function RegisterPage() {
  const { api, login } = useAuth();
  const [form, setForm] = useState({
    tenantName: '',
    slug: '',
    businessType: 'OTHER' as BusinessType,
    adminPhone: '',
    locationName: '',
    locationCode: 'utama',
    timezone: 'Asia/Jakarta' as LocationTimezone,
    email: '',
    password: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = registerRequestSchema.safeParse({
      tenant: {
        name: form.tenantName.trim(),
        slug: form.slug || slugify(form.tenantName),
        business_type: form.businessType,
        admin_wa_phone: form.adminPhone.trim(),
      },
      location: {
        name: form.locationName.trim() || form.tenantName.trim(),
        code: form.locationCode,
        timezone: form.timezone,
      },
      owner: { email: form.email, password: form.password },
    });
    if (!parsed.success) {
      setError(
        'Periksa isian: nama bisnis, slug (huruf kecil, angka, tanda hubung), nomor WhatsApp admin (kode negara, tanpa +), email, dan kata sandi minimal 8 karakter.',
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.register(parsed.data);
      setDone(true);
      await login(parsed.data.owner.email, parsed.data.owner.password);
    } catch (failure) {
      setError(describeError(failure));
      setBusy(false);
    }
  }

  return (
    <main className="auth-page auth-page-wide">
      <form className="card auth-card stack" onSubmit={(event) => void submit(event)} noValidate>
        <div className="auth-header">
          <h1>Daftarkan bisnis</h1>
        </div>
        {done ? <InfoNotice>Pendaftaran berhasil. Masuk otomatis...</InfoNotice> : null}
        <ErrorNotice message={error} />
        <TextField
          label="Nama bisnis"
          value={form.tenantName}
          onChange={(e) => set('tenantName')(e.target.value)}
          autoFocus
        />
        <TextField
          label="Slug"
          hint="Huruf kecil, angka, dan tanda hubung. Kosongkan untuk dibuat dari nama bisnis."
          value={form.slug}
          onChange={(e) => set('slug')(e.target.value)}
        />
        <SelectField
          label="Jenis bisnis"
          value={form.businessType}
          onChange={(e) => set('businessType')(e.target.value)}
        >
          {BUSINESS_TYPES.map((type) => (
            <option key={type} value={type}>
              {BUSINESS_LABELS[type]}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Nomor WhatsApp admin"
          hint="Dengan kode negara, tanpa tanda +, mis. 6281234567890."
          inputMode="numeric"
          value={form.adminPhone}
          onChange={(e) => set('adminPhone')(e.target.value)}
        />
        <TextField
          label="Nama lokasi pertama"
          value={form.locationName}
          onChange={(e) => set('locationName')(e.target.value)}
        />
        <TextField
          label="Kode lokasi"
          value={form.locationCode}
          onChange={(e) => set('locationCode')(e.target.value)}
        />
        <SelectField
          label="Zona waktu"
          value={form.timezone}
          onChange={(e) => set('timezone')(e.target.value)}
        >
          {LOCATION_TIMEZONES.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Email pemilik"
          type="email"
          autoComplete="username"
          value={form.email}
          onChange={(e) => set('email')(e.target.value)}
        />
        <TextField
          label="Kata sandi"
          type="password"
          autoComplete="new-password"
          hint="Minimal 8 karakter."
          value={form.password}
          onChange={(e) => set('password')(e.target.value)}
        />
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Memproses...' : 'Daftar'}
        </button>
        <p className="auth-footer">
          Sudah punya akun? <a href="#/login">Masuk</a>
        </p>
      </form>
    </main>
  );
}
