import { useState } from 'react';

import type { KioskToken } from '../api/schemas';
import { useAuth } from '../auth/AuthContext';
import { ErrorNotice, InfoNotice, formatDateTime } from '../components/ui';
import { useAction } from '../lib/hooks';

/** kiosk.html?token=... on the same origin; the page moves the token out of the address bar. */
export function kioskLink(origin: string, token: string): string {
  return `${origin}/kiosk.html?token=${encodeURIComponent(token)}`;
}

export function KioskTab({ locationId }: { locationId: string }) {
  const { api } = useAuth();
  const action = useAction();
  const [issued, setIssued] = useState<KioskToken | null>(null);
  const [revoked, setRevoked] = useState(false);

  async function create() {
    setRevoked(false);
    await action.run(async () => setIssued(await api.createKioskToken(locationId)));
  }
  async function revoke() {
    if (!window.confirm('Cabut semua token kiosk lokasi ini? Layar TV yang aktif akan terputus.')) {
      return;
    }
    if (await action.run(() => api.revokeKioskTokens(locationId))) {
      setIssued(null);
      setRevoked(true);
    }
  }

  const link = issued ? kioskLink(window.location.origin, issued.token) : null;
  return (
    <div className="stack card">
      <p>
        Token kiosk berlaku 30 hari dan dipakai layar TV untuk menampilkan nomor yang dipanggil.
        Buka tautan di perangkat TV sekali saja; token tersimpan di perangkat itu.
      </p>
      <ErrorNotice message={action.error} />
      {revoked ? <InfoNotice>Semua token kiosk lokasi ini dicabut.</InfoNotice> : null}
      <div className="inline-form">
        <button
          type="button"
          className="primary"
          disabled={action.busy}
          onClick={() => void create()}
        >
          Buat token kiosk
        </button>
        <button type="button" disabled={action.busy} onClick={() => void revoke()}>
          Cabut semua token
        </button>
      </div>
      {issued && link ? (
        <div className="stack">
          <p>
            Token dibuat, berlaku sampai {formatDateTime(issued.expires_at)}. Tautan ini hanya
            ditampilkan sekarang; simpan dengan aman.
          </p>
          <label htmlFor="kiosk-link">Tautan kiosk</label>
          <input id="kiosk-link" readOnly value={link} onFocus={(e) => e.target.select()} />
          <a href={link} target="_blank" rel="noreferrer">
            Buka kiosk di tab baru
          </a>
        </div>
      ) : null}
    </div>
  );
}
