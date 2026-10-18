import { SETTINGS_TABS, SETTINGS_TAB_LABELS, type SettingsTab } from '../lib/routes';
import { useAuth } from '../auth/AuthContext';
import { Empty, ErrorNotice, Loading, SelectField } from '../components/ui';
import { useResource } from '../lib/hooks';
import { useState } from 'react';
import { HoursTab } from './HoursTab';
import { KioskTab } from './KioskTab';
import { ModeTab } from './ModeTab';
import { ResourcesTab } from './ResourcesTab';
import { ServicesTab } from './ServicesTab';
import { StaffTab } from './StaffTab';
import { SubscriptionTab } from './SubscriptionTab';

const LOCATION_TABS: readonly SettingsTab[] = ['resource', 'jam', 'kiosk', 'langganan'];

export function SettingsPage({ tab }: { tab: SettingsTab }) {
  const { api } = useAuth();
  const locations = useResource('locations', () => api.locations());
  const [chosen, setChosen] = useState('');
  const list = locations.data ?? [];
  const location = list.find((l) => l.id === chosen) ?? list[0];

  let body;
  if (LOCATION_TABS.includes(tab)) {
    if (locations.loading) body = <Loading />;
    else if (location === undefined) body = <Empty>Belum ada lokasi.</Empty>;
    else {
      const id = location.id;
      body = (
        <>
          <SelectField label="Lokasi" value={id} onChange={(e) => setChosen(e.target.value)}>
            {list.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </SelectField>
          {tab === 'resource' ? <ResourcesTab key={id} locationId={id} /> : null}
          {tab === 'jam' ? <HoursTab key={id} locationId={id} /> : null}
          {tab === 'kiosk' ? <KioskTab key={id} locationId={id} /> : null}
          {tab === 'langganan' ? <SubscriptionTab key={id} locationId={id} /> : null}
        </>
      );
    }
  } else if (tab === 'layanan') body = <ServicesTab />;
  else if (tab === 'mode') body = <ModeTab />;
  else body = <StaffTab />;

  return (
    <div className="stack">
      <h2>Pengaturan</h2>
      <nav aria-label="Bagian pengaturan" className="tabs">
        {SETTINGS_TABS.map((t) => (
          <a
            key={t}
            href={`#/pengaturan/${t}`}
            aria-current={t === tab ? 'page' : undefined}
            className={t === tab ? 'tab active' : 'tab'}
          >
            {SETTINGS_TAB_LABELS[t]}
          </a>
        ))}
      </nav>
      <ErrorNotice message={locations.error} />
      {body}
    </div>
  );
}
