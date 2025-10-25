import type { SessionContext } from './types';

export interface PendingSessionStoreOptions {
  ttlMs: number;
  dispose: (connectionId: string, session: SessionContext) => Promise<void> | void;
}

interface PendingEntry {
  session: SessionContext;
  timeout: ReturnType<typeof setTimeout>;
}

export interface PendingSessionStore {
  add: (connectionId: string, session: SessionContext) => void;
  take: (connectionId: string) => SessionContext | undefined;
  flushAll: () => Promise<void>;
  size: () => number;
}

export function createPendingSessionStore(
  options: PendingSessionStoreOptions
): PendingSessionStore {
  const entries = new Map<string, PendingEntry>();

  function remove(connectionId: string): void {
    const existing = entries.get(connectionId);
    if (!existing) return;
    clearTimeout(existing.timeout);
    entries.delete(connectionId);
  }

  async function dispose(connectionId: string, entry: PendingEntry): Promise<void> {
    remove(connectionId);
    try {
      await options.dispose(connectionId, entry.session);
    } catch (error) {
      console.error(`[${connectionId}] Failed to dispose pending session:`, error);
    }
  }

  function add(connectionId: string, session: SessionContext): void {
    remove(connectionId);

    const timeout = setTimeout(() => {
      const entry = entries.get(connectionId);
      if (!entry) return;
      dispose(connectionId, entry);
    }, options.ttlMs);

    entries.set(connectionId, { session, timeout });
  }

  function take(connectionId: string): SessionContext | undefined {
    const entry = entries.get(connectionId);
    if (!entry) return undefined;
    clearTimeout(entry.timeout);
    entries.delete(connectionId);
    return entry.session;
  }

  async function flushAll(): Promise<void> {
    const pending = Array.from(entries.entries());
    entries.clear();
    await Promise.all(
      pending.map(([connectionId, entry]) => {
        clearTimeout(entry.timeout);
        return options.dispose(connectionId, entry.session);
      })
    );
  }

  return {
    add,
    take,
    flushAll,
    size: () => entries.size,
  };
}
