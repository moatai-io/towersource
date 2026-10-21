import { useCallback, useEffect, useRef, useState } from 'react';
import { loadSecretariat, readSecretariatProposal, updateSecretariatEnabled, type SecretariatSnapshot } from './secretariat-api';

type Operation = { kind: 'toggle' } | { kind: 'read'; id: string };

export function useSecretariat() {
  const [snapshot, setSnapshot] = useState<SecretariatSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [operationError, setOperationError] = useState<Operation | null>(null);
  const loadController = useRef<AbortController | null>(null);
  const mutationController = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setLoadError(false);
    try {
      const result = await loadSecretariat(controller.signal);
      if (!controller.signal.aborted && mounted.current) setSnapshot(result);
    } catch {
      if (!controller.signal.aborted && mounted.current) setLoadError(true);
    } finally {
      if (!controller.signal.aborted && mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      loadController.current?.abort();
      mutationController.current?.abort();
    };
  }, [refresh]);

  const mutate = useCallback(async (next: Operation, enabled?: boolean) => {
    if (mutationController.current) return;
    const controller = new AbortController();
    mutationController.current = controller;
    setOperation(next);
    setOperationError(null);
    try {
      if (next.kind === 'toggle') await updateSecretariatEnabled(enabled === true, controller.signal);
      else await readSecretariatProposal(next.id, controller.signal);
      if (!controller.signal.aborted && mounted.current) await refresh();
    } catch {
      if (!controller.signal.aborted && mounted.current) setOperationError(next);
    } finally {
      if (mutationController.current === controller) mutationController.current = null;
      if (!controller.signal.aborted && mounted.current) setOperation(null);
    }
  }, [refresh]);

  const setEnabled = useCallback((enabled: boolean) => mutate({ kind: 'toggle' }, enabled), [mutate]);
  const markRead = useCallback((id: string) => mutate({ kind: 'read', id }), [mutate]);
  return { snapshot, loading, loadError, operation, operationError, refresh, setEnabled, markRead };
}
