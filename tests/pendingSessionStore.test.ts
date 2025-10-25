import { describe, it, expect } from 'bun:test';
import { createPendingSessionStore } from '../src/clone/PendingSessionStore';
import type { SessionContext } from '../src/clone/types';
import { NetworkCache } from '../src/clone/NetworkCache';

function createSession(): SessionContext {
  return {
    context: null as unknown as SessionContext['context'],
    page: null as unknown as SessionContext['page'],
    cdp: null as unknown as SessionContext['cdp'],
    networkCache: new NetworkCache(),
    eventLog: [],
    sessionStartTime: Date.now(),
    isRecording: true,
    ownsContext: true,
  };
}

describe('PendingSessionStore', () => {
  it('returns session if taken before expiry without disposing', async () => {
    const disposeCalls: Array<[string, SessionContext]> = [];
    const dispose = (id: string, session: SessionContext) => {
      disposeCalls.push([id, session]);
      return Promise.resolve();
    };
    const store = createPendingSessionStore({ ttlMs: 50, dispose });
    const session = createSession();

    store.add('abc', session);
    const result = store.take('abc');

    expect(result).toBe(session);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(disposeCalls.length).toBe(0);
  });

  it('disposes sessions that exceed ttl', async () => {
    const disposeCalls: Array<[string, SessionContext]> = [];
    const dispose = (id: string, session: SessionContext) => {
      disposeCalls.push([id, session]);
      return Promise.resolve();
    };
    const store = createPendingSessionStore({ ttlMs: 10, dispose });
    const session = createSession();

    store.add('expired', session);
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(disposeCalls.length).toBe(1);
    expect(disposeCalls[0][0]).toBe('expired');
  });

  it('flushAll disposes all remaining sessions immediately', async () => {
    const disposeCalls: Array<[string, SessionContext]> = [];
    const dispose = (id: string, session: SessionContext) => {
      disposeCalls.push([id, session]);
      return Promise.resolve();
    };
    const store = createPendingSessionStore({ ttlMs: 10, dispose });
    const sessionA = createSession();
    const sessionB = createSession();

    store.add('a', sessionA);
    store.add('b', sessionB);

    await store.flushAll();

    expect(disposeCalls.length).toBe(2);
    expect(store.size()).toBe(0);
  });
});
