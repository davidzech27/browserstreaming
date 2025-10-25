import { describe, it, expect } from 'bun:test';
import { EventEmitter } from 'events';
import type { CDPSession } from 'playwright';
import { setupCacheInterception } from '../src/clone/CloneOrchestrator';
import { NetworkCache } from '../src/clone/NetworkCache';
import type { CachedResponse } from '../src/clone/types';

class FakeCDP extends EventEmitter {
  public sendCalls: Array<{ method: string; params?: any }> = [];

  async send(method: string, params?: any): Promise<any> {
    this.sendCalls.push({ method, params });
    return {};
  }

  off(eventName: string | symbol, listener: (...args: any[]) => void): this {
    this.removeListener(eventName, listener);
    return this;
  }
}

function createCachedResponse(): CachedResponse {
  return {
    requestId: 'req-1',
    url: 'https://example.com/',
    method: 'GET',
    requestHeaders: {
      'content-type': 'text/html',
      accept: 'text/html',
      authorization: '',
      cookie: '',
    },
    status: 200,
    responseHeaders: {
      'content-type': 'text/html',
    },
    body: Buffer.from('<html></html>'),
    mimeType: 'text/html',
    resourceType: 'document',
    timestamp: Date.now(),
  };
}

describe('CloneOrchestrator cache interception', () => {
  it('serves cached responses and tears down listeners on cleanup', async () => {
    const fakeCdp = new FakeCDP();
    const cache = new NetworkCache();
    const cacheKey = cache.getCacheKey({
      method: 'GET',
      url: 'https://example.com/',
      headers: {
        'content-type': 'text/html',
        accept: 'text/html',
        authorization: '',
        cookie: '',
      },
    });
    cache.set(cacheKey, createCachedResponse());

    const cleanup = await setupCacheInterception(fakeCdp as unknown as CDPSession, cache);

    fakeCdp.emit('Fetch.requestPaused', {
      requestId: 'intercept-1',
      request: {
        method: 'GET',
        url: 'https://example.com/',
        headers: {
          'content-type': 'text/html',
          accept: 'text/html',
          authorization: '',
          cookie: '',
        },
      },
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(fakeCdp.sendCalls.some(call => call.method === 'Fetch.fulfillRequest')).toBe(true);

    fakeCdp.emit('Fetch.requestPaused', {
      requestId: 'intercept-2',
      request: {
        method: 'GET',
        url: 'https://example.com/miss',
        headers: {},
      },
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(fakeCdp.sendCalls.some(call => call.method === 'Fetch.continueRequest')).toBe(true);

    const callCountBeforeCleanup = fakeCdp.sendCalls.length;
    await cleanup();
    expect(fakeCdp.sendCalls.at(-1)?.method).toBe('Fetch.disable');

    fakeCdp.emit('Fetch.requestPaused', {
      requestId: 'after-cleanup',
      request: {
        method: 'GET',
        url: 'https://example.com/',
        headers: {},
      },
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(fakeCdp.sendCalls.length).toBe(callCountBeforeCleanup + 1);
  });
});
