import { useState, type FormEvent } from 'react';

import type { Resource, Service } from '../api/schemas';
import { useAuth } from '../auth/AuthContext';
import { CheckField, Empty, ErrorNotice, Loading, TextField } from '../components/ui';
import { useAction, useResource } from '../lib/hooks';

function ResourceForm({
  initial,
  services,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: { name: string; type: string; active: boolean; serviceIds: string[] };
  services: Service[];
  busy: boolean;
  submitLabel: string;
  onSubmit(values: {
    name: string;
    type: string | null;
    active: boolean;
    serviceIds: string[];
  }): Promise<boolean>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [type, setType] = useState(initial.type);
  const [active, setActive] = useState(initial.active);
  const [serviceIds, setServiceIds] = useState(initial.serviceIds);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === '') return setProblem('Nama resource wajib diisi.');
    setProblem(null);
    const ok = await onSubmit({
      name: name.trim(),
      type: type.trim() === '' ? null : type.trim(),
      active,
      serviceIds,
    });
    if (ok && onCancel === undefined) {
      setName('');
      setType('');
      setServiceIds([]);
    }
  }

  const toggle = (id: string, on: boolean) =>
    setServiceIds((ids) => (on ? [...ids, id] : ids.filter((x) => x !== id)));

  return (
    <form className="card form-row" onSubmit={(event) => void submit(event)} noValidate>
      <TextField label="Nama resource" value={name} onChange={(e) => setName(e.target.value)} />
      <TextField
        label="Tipe (opsional)"
        hint="Mis. loket, kursi, lapangan"
        value={type}
        onChange={(e) => setType(e.target.value)}
      />
      <fieldset>
        <legend>Layanan yang dilayani</legend>
        {services.length === 0 ? <span className="muted">Belum ada layanan.</span> : null}
        {services.map((service) => (
          <CheckField
            key={service.id}
            label={service.name}
            checked={serviceIds.includes(service.id)}
            onChange={(e) => toggle(service.id, e.target.checked)}
          />
        ))}
      </fieldset>
      <CheckField label="Aktif" checked={active} onChange={(e) => setActive(e.target.checked)} />
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

export function ResourcesTab({ locationId }: { locationId: string }) {
  const { api } = useAuth();
  const resources = useResource(locationId, () => api.resources(locationId));
  const services = useResource('services', () => api.services());
  const action = useAction();
  const [editing, setEditing] = useState<string | null>(null);
  const serviceList = services.data ?? [];

  const refresh = async (work: () => Promise<unknown>) => {
    const ok = await action.run(work);
    if (ok) {
      setEditing(null);
      resources.reload();
    }
    return ok;
  };
  const serviceNames = (resource: Resource) =>
    resource.service_ids
      .map((id) => serviceList.find((s) => s.id === id)?.name)
      .filter((n): n is string => n !== undefined)
      .join(', ') || 'Belum ada layanan';

  return (
    <div className="stack">
      <ErrorNotice message={action.error ?? resources.error} />
      {resources.loading ? <Loading /> : null}
      {resources.data?.length === 0 ? <Empty>Belum ada resource di lokasi ini.</Empty> : null}
      <ul className="plain-list">
        {resources.data?.map((resource) => (
          <li key={resource.id} className="card">
            {editing === resource.id ? (
              <ResourceForm
                initial={{
                  name: resource.name,
                  type: resource.resource_type ?? '',
                  active: resource.is_active,
                  serviceIds: resource.service_ids,
                }}
                services={serviceList}
                busy={action.busy}
                submitLabel="Simpan"
                onSubmit={(v) =>
                  refresh(() =>
                    api.updateResource(resource.id, {
                      name: v.name,
                      resource_type: v.type,
                      is_active: v.active,
                      service_ids: v.serviceIds,
                    }),
                  )
                }
                onCancel={() => setEditing(null)}
              />
            ) : (
              <div className="row-between">
                <div>
                  <strong>{resource.name}</strong>{' '}
                  <span className="badge">{resource.is_active ? 'Aktif' : 'Nonaktif'}</span>
                  <div className="muted">{serviceNames(resource)}</div>
                </div>
                <div className="inline-form">
                  <button type="button" onClick={() => setEditing(resource.id)}>
                    Ubah
                  </button>
                  <button
                    type="button"
                    disabled={action.busy}
                    onClick={() =>
                      void refresh(() =>
                        api.updateResource(resource.id, { is_active: !resource.is_active }),
                      )
                    }
                  >
                    {resource.is_active ? 'Nonaktifkan' : 'Aktifkan'}
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      <h3>Resource baru</h3>
      <ResourceForm
        initial={{ name: '', type: '', active: true, serviceIds: [] }}
        services={serviceList}
        busy={action.busy}
        submitLabel="Buat resource"
        onSubmit={(v) =>
          refresh(() =>
            api.createResource({
              location_id: locationId,
              name: v.name,
              resource_type: v.type,
              is_active: v.active,
              service_ids: v.serviceIds,
            }),
          )
        }
      />
    </div>
  );
}
