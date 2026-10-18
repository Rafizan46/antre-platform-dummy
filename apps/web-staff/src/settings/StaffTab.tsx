import { STAFF_ROLES, createStaffRequestSchema, type StaffRole } from '@antre/shared-types';
import { useState, type FormEvent } from 'react';

import { useAuth } from '../auth/AuthContext';
import { Empty, ErrorNotice, Loading, SelectField, TextField } from '../components/ui';
import { ROLE_LABELS } from '../lib/actions';
import { useAction, useResource } from '../lib/hooks';

export function StaffTab() {
  const { api, session } = useAuth();
  const users = useResource('users', () => api.users());
  const action = useAction();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<StaffRole>('STAFF_CALLER');
  const [problem, setProblem] = useState<string | null>(null);

  async function create(event: FormEvent) {
    event.preventDefault();
    const parsed = createStaffRequestSchema.safeParse({ email, password, role });
    if (!parsed.success) {
      setProblem('Isi email yang valid dan kata sandi minimal 8 karakter.');
      return;
    }
    setProblem(null);
    if (await action.run(() => api.createStaff(parsed.data))) {
      setEmail('');
      setPassword('');
      users.reload();
    }
  }

  const change = async (work: () => Promise<unknown>) => {
    if (await action.run(work)) users.reload();
  };

  return (
    <div className="stack">
      <ErrorNotice message={action.error ?? users.error} />
      {users.loading ? <Loading /> : null}
      {users.data?.length === 0 ? <Empty>Belum ada pengguna.</Empty> : null}
      <ul className="plain-list">
        {users.data?.map((user) => {
          const isStaff = user.role === 'STAFF_CALLER' || user.role === 'STAFF_CASHIER';
          return (
            <li key={user.id} className="card row-between">
              <div>
                <strong>{user.email}</strong>{' '}
                <span className="badge">{ROLE_LABELS[user.role]}</span>{' '}
                {user.is_active ? null : <span className="badge">Nonaktif</span>}
                {user.id === session?.user.id ? <span className="muted"> (Anda)</span> : null}
              </div>
              {isStaff ? (
                <div className="inline-form">
                  <label htmlFor={`role-${user.id}`} className="visually-hidden">
                    Peran {user.email}
                  </label>
                  <select
                    id={`role-${user.id}`}
                    value={user.role}
                    disabled={action.busy}
                    onChange={(e) =>
                      void change(() =>
                        api.updateStaff(user.id, { role: e.target.value as StaffRole }),
                      )
                    }
                  >
                    {STAFF_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={action.busy}
                    onClick={() =>
                      void change(() => api.updateStaff(user.id, { is_active: !user.is_active }))
                    }
                  >
                    {user.is_active ? 'Nonaktifkan' : 'Aktifkan'}
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <h3>Staf baru</h3>
      <form className="card form-row" onSubmit={(event) => void create(event)} noValidate>
        <TextField
          label="Email staf"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextField
          label="Kata sandi awal"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <SelectField
          label="Peran"
          value={role}
          onChange={(e) => setRole(e.target.value as StaffRole)}
        >
          {STAFF_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </SelectField>
        <ErrorNotice message={problem} />
        <button type="submit" className="primary" disabled={action.busy}>
          Tambah staf
        </button>
      </form>
    </div>
  );
}
