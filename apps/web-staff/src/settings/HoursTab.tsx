import { putOperatingHoursRequestSchema } from '@antre/shared-types';
import { useEffect, useState, type FormEvent } from 'react';

import type { OperatingHours } from '../api/schemas';
import { useAuth } from '../auth/AuthContext';
import { CheckField, ErrorNotice, InfoNotice, Loading, TextField } from '../components/ui';
import { useAction, useResource } from '../lib/hooks';

// day_of_week 0 = Sunday (same as EXTRACT(DOW)); shown Monday first.
const DAYS = [
  { dow: 1, label: 'Senin' },
  { dow: 2, label: 'Selasa' },
  { dow: 3, label: 'Rabu' },
  { dow: 4, label: 'Kamis' },
  { dow: 5, label: 'Jumat' },
  { dow: 6, label: 'Sabtu' },
  { dow: 0, label: 'Minggu' },
];

interface DayRow {
  open: boolean;
  openTime: string;
  closeTime: string;
  breakStart: string;
  breakEnd: string;
}

const DEFAULT_ROW: DayRow = {
  open: false,
  openTime: '08:00',
  closeTime: '17:00',
  breakStart: '',
  breakEnd: '',
};

export function rowsFromHours(hours: OperatingHours): Record<number, DayRow> {
  const rows: Record<number, DayRow> = {};
  for (const { dow } of DAYS) rows[dow] = { ...DEFAULT_ROW };
  for (const day of hours.days) {
    rows[day.day_of_week] = {
      open: true,
      openTime: day.open_time,
      closeTime: day.close_time,
      breakStart: day.break_start ?? '',
      breakEnd: day.break_end ?? '',
    };
  }
  return rows;
}

export function buildHoursPayload(slotInterval: number, rows: Record<number, DayRow>) {
  return putOperatingHoursRequestSchema.safeParse({
    slot_interval_min: slotInterval,
    days: DAYS.filter(({ dow }) => rows[dow]?.open).map(({ dow }) => ({
      day_of_week: dow,
      open_time: rows[dow]!.openTime,
      close_time: rows[dow]!.closeTime,
      break_start: rows[dow]!.breakStart === '' ? null : rows[dow]!.breakStart,
      break_end: rows[dow]!.breakEnd === '' ? null : rows[dow]!.breakEnd,
    })),
  });
}

export function HoursTab({ locationId }: { locationId: string }) {
  const { api } = useAuth();
  const hours = useResource(locationId, () => api.operatingHours(locationId));
  const action = useAction();
  const [rows, setRows] = useState<Record<number, DayRow>>({});
  const [interval, setIntervalValue] = useState('60');
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (hours.data) {
      setRows(rowsFromHours(hours.data));
      setIntervalValue(String(hours.data.slot_interval_min));
    }
  }, [hours.data]);

  const patch = (dow: number, change: Partial<DayRow>) =>
    setRows((current) => ({ ...current, [dow]: { ...(current[dow] ?? DEFAULT_ROW), ...change } }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    const parsed = buildHoursPayload(Number(interval), rows);
    if (!parsed.success) {
      setProblem(
        'Jam tidak valid: jam tutup harus setelah jam buka, istirahat harus berada dalam jam buka dan diisi lengkap (mulai dan selesai), dan interval slot 1-1440 menit.',
      );
      return;
    }
    setProblem(null);
    if (await action.run(() => api.putOperatingHours(locationId, parsed.data))) {
      setSaved(true);
      hours.reload();
    }
  }

  if (hours.loading && hours.data === undefined) return <Loading />;
  return (
    <form className="stack" onSubmit={(event) => void submit(event)} noValidate>
      <ErrorNotice message={problem ?? action.error ?? hours.error} />
      {saved ? <InfoNotice>Jam operasional disimpan.</InfoNotice> : null}
      <TextField
        label="Interval slot (menit)"
        type="number"
        min={1}
        value={interval}
        onChange={(e) => setIntervalValue(e.target.value)}
      />
      <div className="table-scroll">
        <table className="table">
          <caption className="visually-hidden">Jam operasional per hari</caption>
          <thead>
            <tr>
              <th scope="col">Hari</th>
              <th scope="col">Buka</th>
              <th scope="col">Tutup</th>
              <th scope="col">Istirahat mulai</th>
              <th scope="col">Istirahat selesai</th>
            </tr>
          </thead>
          <tbody>
            {DAYS.map(({ dow, label }) => {
              const row = rows[dow] ?? DEFAULT_ROW;
              return (
                <tr key={dow}>
                  <th scope="row">
                    <CheckField
                      label={label}
                      checked={row.open}
                      onChange={(e) => patch(dow, { open: e.target.checked })}
                    />
                  </th>
                  {(['openTime', 'closeTime', 'breakStart', 'breakEnd'] as const).map((field) => (
                    <td key={field}>
                      <input
                        type="time"
                        aria-label={`${label}: ${
                          {
                            openTime: 'buka',
                            closeTime: 'tutup',
                            breakStart: 'istirahat mulai',
                            breakEnd: 'istirahat selesai',
                          }[field]
                        }`}
                        value={row[field]}
                        disabled={!row.open}
                        onChange={(e) => patch(dow, { [field]: e.target.value })}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button type="submit" className="primary" disabled={action.busy}>
        Simpan jam operasional
      </button>
    </form>
  );
}
