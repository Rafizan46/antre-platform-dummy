import { useState } from 'react';

import type { Checkout } from '../api/schemas';
import { useAuth } from '../auth/AuthContext';
import { ErrorNotice, Loading, formatDateTime, formatRupiah } from '../components/ui';
import { useAction, useResource } from '../lib/hooks';

const PLAN_LABELS = { FREE: 'Gratis', PAID_LOCATION: 'Berbayar per lokasi' } as const;

export function SubscriptionTab({ locationId }: { locationId: string }) {
  const { api } = useAuth();
  const overview = useResource(locationId, () => api.billing(locationId));
  const action = useAction();
  const [checkout, setCheckout] = useState<Checkout | null>(null);

  async function upgrade() {
    const ok = await action.run(async () => setCheckout(await api.checkout(locationId)));
    if (ok) overview.reload();
  }

  if (overview.loading && overview.data === undefined) return <Loading />;
  const data = overview.data;
  if (!data) return <ErrorNotice message={overview.error} />;
  const { subscription, usage } = data;
  const percent = Math.min(usage.percent_used ?? 0, 100);

  return (
    <div className="stack card">
      <ErrorNotice message={action.error ?? overview.error} />
      <p>
        Paket: <strong>{PLAN_LABELS[subscription.plan_code]}</strong>{' '}
        <span className="badge">
          {subscription.status === 'ACTIVE' ? 'Aktif' : 'Menunggu pembayaran'}
        </span>
      </p>
      {subscription.current_period_end ? (
        <p className="muted">Periode berakhir {formatDateTime(subscription.current_period_end)}.</p>
      ) : null}
      <h3>Pemakaian bulan {usage.period_month}</h3>
      {usage.monthly_ticket_quota === null ? (
        <p>{usage.ticket_count} tiket (tanpa batas).</p>
      ) : (
        <>
          <progress
            value={percent}
            max={100}
            aria-label="Pemakaian kuota tiket"
            className={usage.exhausted ? 'danger' : ''}
          />
          <p>
            {usage.ticket_count} dari {usage.monthly_ticket_quota} tiket terpakai, sisa{' '}
            {usage.remaining}.
          </p>
          {usage.exhausted ? (
            <p className="notice notice-error" role="alert">
              Kuota habis: tiket dan reservasi baru ditolak sampai paket di-upgrade.
            </p>
          ) : null}
        </>
      )}
      {subscription.pending_payment_ref && !checkout ? (
        <p>
          Menunggu pembayaran, ref <code>{subscription.pending_payment_ref}</code>
          {subscription.pending_expires_at
            ? ` (berlaku sampai ${formatDateTime(subscription.pending_expires_at)})`
            : ''}
          .
        </p>
      ) : null}
      <div>
        <button
          type="button"
          className="primary"
          disabled={action.busy}
          onClick={() => void upgrade()}
        >
          {subscription.plan_code === 'PAID_LOCATION' ? 'Perpanjang paket' : 'Upgrade ke berbayar'}
        </button>
      </div>
      {checkout ? (
        <div className="stack" role="status">
          <h3>Instruksi pembayaran (simulasi)</h3>
          <p>
            Ref pembayaran: <code>{checkout.payment.payment_ref}</code>
          </p>
          <p>
            Nominal {formatRupiah(checkout.payment.amount)}, berlaku sampai{' '}
            {formatDateTime(checkout.payment.expires_at)}.
          </p>
          <p>{checkout.payment.instructions}</p>
          <label htmlFor="qris-payload">Isi QRIS simulasi</label>
          <input id="qris-payload" readOnly value={checkout.payment.qris_payload} />
        </div>
      ) : null}
    </div>
  );
}
