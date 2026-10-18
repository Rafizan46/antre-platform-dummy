// Kiosk TV screen (FR-REALTIME-02/03): counters with the number being called, the recent calls,
// live over SSE with automatic reconnect, chime + TTS for each new call, and full screen mode.
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { RealtimeUpdate } from '@antre/messaging/realtime';

import { createAnnouncer, type Announcer } from './announce';
import { applySnapshot, applyUpdate, emptyBoard, isAnnouncement, type BoardState } from './board';
import { connectRealtime, type ConnectionStatus } from './connection';
import type { KioskIdentity } from './token';

type Action =
  { kind: 'snapshot'; updates: RealtimeUpdate[] } | { kind: 'update'; update: RealtimeUpdate };

function reducer(state: BoardState, action: Action): BoardState {
  return action.kind === 'snapshot'
    ? applySnapshot(action.updates)
    : applyUpdate(state, action.update);
}

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: 'Menghubungkan…',
  open: 'Terhubung',
  reconnecting: 'Menyambung ulang…',
  stopped: 'Terputus',
};

export function KioskBoard(props: {
  board: BoardState;
  status: ConnectionStatus;
  audioEnabled: boolean;
  onActivate?: () => void;
}) {
  const { board, status } = props;
  const latest = board.recent[0];
  return (
    <div className="kiosk">
      <header className="kiosk-header">
        <h1>Nomor Antrean</h1>
        <span className={`kiosk-status kiosk-status-${status}`}>{STATUS_TEXT[status]}</span>
      </header>
      <main className="kiosk-main">
        <section className="kiosk-counters" aria-label="Loket">
          {board.counters.length === 0 ? (
            <p className="kiosk-empty">Belum ada panggilan.</p>
          ) : (
            board.counters.map((counter) => (
              <article
                key={counter.resource}
                className={`kiosk-counter${
                  latest !== undefined && latest.resource === counter.resource
                    ? ' kiosk-latest'
                    : ''
                }${counter.status === 'CALLED' || counter.status === 'SERVING' ? '' : ' kiosk-done'}`}
              >
                <h2>{counter.resource}</h2>
                <p className="kiosk-number">{counter.ticketNumber}</p>
              </article>
            ))
          )}
        </section>
        <aside className="kiosk-recent" aria-label="Panggilan terakhir">
          <h2>Panggilan terakhir</h2>
          <ol>
            {board.recent.map((call) => (
              <li key={`${call.at}-${call.ticketNumber}-${call.resource}`}>
                <strong>{call.ticketNumber}</strong> {call.resource}
                {call.isRecall ? ' (ulang)' : ''}
              </li>
            ))}
          </ol>
        </aside>
      </main>
      {!props.audioEnabled && (
        <button type="button" className="kiosk-activate" onClick={props.onActivate}>
          Ketuk untuk mengaktifkan suara dan layar penuh
        </button>
      )}
    </div>
  );
}

export function KioskApp(props: { identity: KioskIdentity | null; baseUrl: string }) {
  const [board, dispatch] = useReducer(reducer, emptyBoard);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [audioEnabled, setAudioEnabled] = useState(false);
  const announcer = useRef<Announcer | null>(null);
  const identity = props.identity;

  useEffect(() => {
    if (identity === null) return undefined;
    announcer.current = createAnnouncer();
    const connection = connectRealtime(
      { baseUrl: props.baseUrl, locationId: identity.locationId, token: identity.token },
      {
        onSnapshot: (updates) => dispatch({ kind: 'snapshot', updates }),
        onUpdate: (update) => {
          dispatch({ kind: 'update', update });
          if (isAnnouncement(update)) announcer.current?.announce(update);
        },
        onStatus: setStatus,
      },
    );
    return () => connection.stop();
  }, [identity, props.baseUrl]);

  const activate = useMemo(
    () => () => {
      announcer.current?.unlock();
      setAudioEnabled(true);
      document.documentElement.requestFullscreen?.().catch(() => undefined);
    },
    [],
  );

  if (identity === null) {
    return (
      <div className="kiosk kiosk-setup">
        <h1>Layar Kiosk belum dipasang</h1>
        <p>
          Buka halaman ini dengan <code>kiosk.html?token=…</code> memakai token Kiosk yang dibuat
          pemilik usaha untuk lokasi ini.
        </p>
      </div>
    );
  }
  return (
    <KioskBoard board={board} status={status} audioEnabled={audioEnabled} onActivate={activate} />
  );
}
