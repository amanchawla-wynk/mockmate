import { useCallback, useEffect, useRef, useState } from 'react';
import { serverApi } from '../api/client';
import type { RequestLogEntry } from '../api/types';

interface UseLogsOptions {
  enabled?: boolean;
  pollIntervalMs?: number;
}

interface UseLogsReturn {
  logs: RequestLogEntry[];
  loading: boolean;
  error: string | null;
  paused: boolean;
  setPaused: (paused: boolean) => void;
  refresh: () => Promise<void>;
  clear: () => Promise<void>;
}

export function useLogs(options: UseLogsOptions = {}): UseLogsReturn {
  const { enabled = true, pollIntervalMs = 1000 } = options;

  const [logs, setLogs] = useState<RequestLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  const timerRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await serverApi.logs();
      setLogs(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load logs');
    } finally {
      setLoading(false);
    }
  }, []);

  const clear = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      await serverApi.clearLogs();
      setLogs([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear logs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (paused) return;

    // Refresh immediately, then start polling.
    refresh();

    timerRef.current = window.setInterval(() => {
      // Avoid noisy polling when tab is hidden.
      if (document.visibilityState === 'hidden') return;
      refresh();
    }, pollIntervalMs);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enabled, paused, pollIntervalMs, refresh]);

  return {
    logs,
    loading,
    error,
    paused,
    setPaused,
    refresh,
    clear,
  };
}
