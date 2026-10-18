import type { RealtimeUpdate } from '@antre/messaging/realtime';
import { useCallback, useEffect, useRef, useState } from 'react';

import { describeError } from '../api/errors';
import {
  connectRealtime,
  type ConnectionOptions,
  type ConnectionStatus,
} from '../kiosk/connection';

export interface ResourceState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload(): void;
  /** Replaces the data locally (optimistic patch from a realtime update). */
  setData(next: T): void;
}

/**
 * Loads data with a fetcher; reloads when `key` changes. A null key means "do not load".
 * The fetcher may change every render (it is read through a ref).
 */
export function useResource<T>(key: string | null, fetcher: () => Promise<T>): ResourceState<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(key !== null);
  const [version, setVersion] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (key === null) return undefined;
    let current = true;
    fetcherRef.current().then(
      (result) => {
        if (!current) return;
        setDataState(result);
        setError(null);
        setLoading(false);
      },
      (failure: unknown) => {
        if (!current) return;
        setError(describeError(failure));
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [key, version]);

  // A new key shows the loading state again until the data arrives.
  useEffect(() => {
    if (key !== null) {
      setLoading(true);
      setDataState(undefined);
    }
  }, [key]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const setData = useCallback((next: T) => setDataState(next), []);
  return { data, error, loading, reload, setData };
}

export interface LiveFeed {
  status: ConnectionStatus;
}

/** Subscribes to the realtime stream of a location; reconnects by itself (kiosk/connection). */
export function useRealtimeFeed(
  options: Pick<ConnectionOptions, 'baseUrl' | 'createEventSource'> & {
    locationId: string | null;
    token: string | null;
  },
  onUpdate: (update: RealtimeUpdate) => void,
  onSnapshot?: () => void,
): LiveFeed {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const updateRef = useRef(onUpdate);
  updateRef.current = onUpdate;
  const snapshotRef = useRef(onSnapshot);
  snapshotRef.current = onSnapshot;
  const { baseUrl, createEventSource, locationId, token } = options;

  useEffect(() => {
    if (locationId === null || token === null) return undefined;
    const connection = connectRealtime(
      { baseUrl, locationId, token, createEventSource },
      {
        onSnapshot: () => snapshotRef.current?.(),
        onUpdate: (update) => updateRef.current(update),
        onStatus: setStatus,
      },
    );
    return () => connection.stop();
  }, [baseUrl, createEventSource, locationId, token]);

  return { status };
}

export interface ActionState {
  busy: boolean;
  error: string | null;
  setError(message: string | null): void;
  /** Runs a mutation; resolves true on success. Errors become Indonesian messages. */
  run(work: () => Promise<unknown>): Promise<boolean>;
}

export function useAction(): ActionState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (failure) {
      setError(describeError(failure));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}
