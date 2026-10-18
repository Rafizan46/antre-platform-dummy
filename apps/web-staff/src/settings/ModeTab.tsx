import {
  SERVICE_MODES,
  updateTenantSettingsRequestSchema,
  type ServiceMode,
} from '@antre/shared-types';
import { useEffect, useState, type FormEvent } from 'react';

import type { TenantSettings } from '../api/schemas';
import { useAuth } from '../auth/AuthContext';
import {
  CheckField,
  ErrorNotice,
  InfoNotice,
  Loading,
  SelectField,
  TextField,
} from '../components/ui';
import { useAction, useResource } from '../lib/hooks';

const MODE_LABELS: Record<ServiceMode, string> = {
  WALK_IN: 'Antrean langsung (walk-in)',
  RESERVATION: 'Reservasi slot',
  BOTH: 'Keduanya',
};

export function buildSettingsPayload(
  current: TenantSettings,
  form: {
    mode: ServiceMode;
    showWait: boolean;
    accent: string;
    resourceLabel: string;
    ticketLabel: string;
    greeting: string;
  },
) {
  const labels = {
    ...(form.resourceLabel.trim() ? { resource: form.resourceLabel.trim() } : {}),
    ...(form.ticketLabel.trim() ? { ticket: form.ticketLabel.trim() } : {}),
  };
  return updateTenantSettingsRequestSchema.safeParse({
    service_mode: form.mode,
    show_wait_estimate: form.showWait,
    branding: {
      ...(current.branding.logo_url ? { logo_url: current.branding.logo_url } : {}),
      ...(form.accent ? { accent_color: form.accent } : {}),
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
      ...(form.greeting.trim() ? { wa_greeting: form.greeting.trim() } : {}),
    },
  });
}

export function ModeTab() {
  const { api } = useAuth();
  const settings = useResource('settings', () => api.settings());
  const action = useAction();
  const [form, setForm] = useState({
    mode: 'BOTH' as ServiceMode,
    showWait: true,
    accent: '',
    resourceLabel: '',
    ticketLabel: '',
    greeting: '',
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const data = settings.data;
    if (!data) return;
    setForm({
      mode: data.service_mode,
      showWait: data.show_wait_estimate,
      accent: data.branding.accent_color ?? '',
      resourceLabel: data.branding.labels?.resource ?? '',
      ticketLabel: data.branding.labels?.ticket ?? '',
      greeting: data.branding.wa_greeting ?? '',
    });
  }, [settings.data]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    const current = settings.data;
    if (!current) return;
    const parsed = buildSettingsPayload(current, form);
    if (!parsed.success) {
      setProblem('Periksa isian: warna harus berformat #RRGGBB dan label maksimal 40 karakter.');
      return;
    }
    setProblem(null);
    if (await action.run(() => api.updateSettings(parsed.data))) {
      setSaved(true);
      settings.reload();
    }
  }

  if (settings.loading && settings.data === undefined) return <Loading />;
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  return (
    <form className="stack card" onSubmit={(event) => void submit(event)} noValidate>
      <ErrorNotice message={problem ?? action.error ?? settings.error} />
      {saved ? <InfoNotice>Pengaturan disimpan.</InfoNotice> : null}
      <SelectField
        label="Mode layanan"
        value={form.mode}
        onChange={(e) => set('mode', e.target.value as ServiceMode)}
      >
        {SERVICE_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {MODE_LABELS[mode]}
          </option>
        ))}
      </SelectField>
      <CheckField
        label="Tampilkan estimasi waktu tunggu ke pelanggan"
        checked={form.showWait}
        onChange={(e) => set('showWait', e.target.checked)}
      />
      <h3>Branding</h3>
      <TextField
        label="Warna aksen"
        hint="Format #RRGGBB, mis. #0F766E. Kosongkan untuk bawaan."
        value={form.accent}
        onChange={(e) => set('accent', e.target.value)}
      />
      <TextField
        label="Sebutan resource"
        hint="Mis. Loket, Kursi"
        maxLength={40}
        value={form.resourceLabel}
        onChange={(e) => set('resourceLabel', e.target.value)}
      />
      <TextField
        label="Sebutan tiket"
        hint="Mis. Nomor antrean"
        maxLength={40}
        value={form.ticketLabel}
        onChange={(e) => set('ticketLabel', e.target.value)}
      />
      <TextField
        label="Sapaan WhatsApp"
        maxLength={500}
        value={form.greeting}
        onChange={(e) => set('greeting', e.target.value)}
      />
      <button type="submit" className="primary" disabled={action.busy}>
        Simpan pengaturan
      </button>
    </form>
  );
}
