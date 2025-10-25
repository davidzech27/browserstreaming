import type { Page, CDPSession } from 'playwright';
import type {
  CloneManifest,
  CloneOptions,
  CloneStage,
  RecordedEvent,
  SessionContext
} from './types';
import { capturePageSnapshot } from './StateSnapshot';
import { createHash } from 'crypto';
import { NetworkCache } from './NetworkCache';

const EVENTS_REQUIRING_DELAY = new Set(['mousePressed', 'mouseReleased', 'paste']);
const EVENT_DELAY_MS = 8;

export interface CloneProgress {
  stage: CloneStage;
  progress: number;
  message?: string;
}

export type ProgressCallback = (progress: CloneProgress) => void;

type TimingEntry = {
  label: string;
  durationMs: number;
};

function cloneRecordedEvent(event: RecordedEvent): RecordedEvent {
  const clonedData =
    event.data && typeof event.data === 'object'
      ? Array.isArray(event.data)
        ? [...event.data]
        : { ...event.data }
      : event.data;

  return {
    type: event.type,
    timestamp: event.timestamp,
    relativeTime: event.relativeTime,
    data: clonedData,
  };
}

async function measureTiming<T>(
  label: string,
  timings: TimingEntry[],
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  const result = await fn();
  timings.push({ label, durationMs: Date.now() - start });
  return result;
}

/**
 * Clone the given session into a new tab inside the same browser context.
 */
export async function cloneSession(
  sourceSession: SessionContext,
  options: CloneOptions = {},
  onProgress?: ProgressCallback
): Promise<SessionContext> {
  const startTime = Date.now();
  const timings: TimingEntry[] = [];
  const manifest = await measureTiming('manifest', timings, () => createManifest(sourceSession));

  const clonedCache = new NetworkCache();
  await measureTiming('cacheImport', timings, async () => {
    clonedCache.import(manifest.networkCacheSnapshot);
  });

  reportProgress(onProgress, 'initializing', 10, 'Opening tab in shared context');
  const target = await createTargetPage(sourceSession, manifest);
  let targetAttached = true;

  reportProgress(onProgress, 'loading', 15, 'Hydrating from cache');
  const teardown = await setupCacheInterception(target.cdp, clonedCache);

  try {
    reportProgress(onProgress, 'loading', 25, 'Navigating to page');
    await measureTiming('navigation', timings, () =>
      target.page.goto(manifest.snapshot.url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      })
    );

    if (manifest.eventLog.length > 0) {
      reportProgress(onProgress, 'replaying', 70, `Replaying ${manifest.eventLog.length} events`);
      await measureTiming('replay', timings, () =>
        replayEvents(target, manifest.eventLog, options)
      );
    }

    const elapsed = Date.now() - startTime;
    reportProgress(onProgress, 'complete', 100, `Clone complete in ${elapsed}ms`);
    const timingSummary = timings
      .map(entry => `${entry.label}=${entry.durationMs}ms`)
      .join(', ');
    console.log(`[cloneSession] Clone completed in ${elapsed}ms (${timingSummary})`);

    const clonedSession: SessionContext = {
      context: target.context,
      page: target.page,
      cdp: target.cdp,
      networkCdp: undefined,
      networkCache: clonedCache,
      eventLog: manifest.eventLog.map(cloneRecordedEvent),
      sessionStartTime: Date.now(),
      isRecording: true,
      ownsContext: false,
    };
    targetAttached = false;
    return clonedSession;
  } finally {
    await teardown();
    clonedCache.clear();
    if (targetAttached) {
      await disposeTarget(target);
    }
  }
}

async function createManifest(sourceSession: SessionContext): Promise<CloneManifest> {
  const snapshot = await capturePageSnapshot(sourceSession.page);

  return {
    networkCacheSnapshot: sourceSession.networkCache.export(),
    eventLog: [...sourceSession.eventLog],
    snapshot,
  };
}

async function createTargetPage(
  sourceSession: SessionContext,
  manifest: CloneManifest
): Promise<{ context: SessionContext['context']; page: Page; cdp: CDPSession }> {
  const page = await sourceSession.context.newPage();
  await page.setViewportSize({
    width: manifest.snapshot.viewport.width,
    height: manifest.snapshot.viewport.height,
  });

  const cdp = await sourceSession.context.newCDPSession(page);

  return {
    context: sourceSession.context,
    page,
    cdp,
  };
}

/**
 * Exported for testing.
 */
export async function setupCacheInterception(
  cdp: CDPSession,
  cache: NetworkCache
): Promise<() => Promise<void>> {
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*', requestStage: 'Request' }],
  });

  const handler = async (event: any) => {
    const { requestId, request } = event;
    const cacheKey = getCacheKey(request);
    const cached = cache.get(cacheKey);

    if (cached) {
      try {
        await cdp.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: cached.status,
          responseHeaders: Object.entries(cached.responseHeaders)
            .map(([name, value]) => ({ name, value })),
          body: cached.body.toString('base64'),
        });
        console.log(`[cloneSession] Served from cache: ${request.url}`);
      } catch (error) {
        console.error(`[cloneSession] Failed to serve from cache: ${request.url}`, error);
        await cdp.send('Fetch.continueRequest', { requestId });
      }
    } else {
      console.warn(`[cloneSession] Cache miss: ${request.url}`);
      await cdp.send('Fetch.continueRequest', { requestId });
    }
  };

  cdp.on('Fetch.requestPaused', handler);

  return async () => {
    removeListener(cdp, 'Fetch.requestPaused', handler);
    try {
      await cdp.send('Fetch.disable');
    } catch {
      // already disabled
    }
  };
}

async function replayEvents(
  target: { page: Page; cdp: CDPSession },
  events: RecordedEvent[],
  options: CloneOptions
): Promise<void> {
  if (events.length === 0) {
    return;
  }

  const playbackSpeed = options.playbackSpeed ?? 0;
  const skipAnimations = options.skipAnimations ?? true;

  if (skipAnimations) {
    await target.page.evaluate(() => {
      const style = document.createElement('style');
      style.id = 'skip-animation'
      style.textContent = '* { animation-duration: 0s !important; transition: none !important; }';
      document.head.appendChild(style);
    });
  }

  const serializedEvents = [...events]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(cloneRecordedEvent);

  let lastTimestamp = serializedEvents[0]?.timestamp ?? 0;
  const pendingDispatches: Promise<void>[] = [];
  const BATCH_SIZE = 128;

  async function flushDispatches(): Promise<void> {
    if (pendingDispatches.length === 0) {
      return;
    }
    const batch = pendingDispatches.splice(0, pendingDispatches.length);
    await Promise.allSettled(batch);
  }

  for (const event of serializedEvents) {
    if (playbackSpeed > 0) {
      const delay = (event.timestamp - lastTimestamp) / playbackSpeed;
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    const isBatchable = event.type === 'mouseMoved' || event.type === 'mouseWheel';

    if (isBatchable) {
      const dispatchPromise = replayEvent(target, event).catch(error => {
        console.error('[cloneSession] Replay dispatch failed:', error);
      });
      pendingDispatches.push(dispatchPromise);

      if (pendingDispatches.length >= BATCH_SIZE) {
        await flushDispatches();
      }
    } else {
      await flushDispatches();
      await replayEvent(target, event);
    }

    if (EVENTS_REQUIRING_DELAY.has(event.type)) {
      await new Promise(resolve => setTimeout(resolve, EVENT_DELAY_MS));
    }

    lastTimestamp = event.timestamp;
  }

  await flushDispatches();

  if (skipAnimations) {
    await target.page.evaluate(() => {
      const style = document.getElementById('skip-animation');
      style?.remove()
    });
  }
}

async function replayEvent(
  target: { page: Page; cdp: CDPSession },
  event: RecordedEvent
): Promise<void> {
  try {
    switch (event.type) {
      case 'mousePressed':
      case 'mouseReleased':
      case 'mouseMoved':
        await target.cdp.send('Input.dispatchMouseEvent', {
          type: event.type,
          x: event.data.x,
          y: event.data.y,
          button: event.data.button,
          clickCount: event.data.clickCount || 1,
          modifiers: event.data.modifiers || 0,
        });
        break;
      case 'mouseWheel':
        await target.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: event.data.x,
          y: event.data.y,
          deltaX: event.data.deltaX || 0,
          deltaY: event.data.deltaY || 0,
          modifiers: event.data.modifiers || 0,
        });
        break;
      case 'keyDown':
      case 'keyUp':
        await target.cdp.send('Input.dispatchKeyEvent', {
          type: event.type,
          key: event.data.key,
          code: event.data.code,
          text: event.data.text,
          modifiers: event.data.modifiers || 0,
        });
        break;
      case 'paste':
        await target.cdp.send('Input.insertText', { text: event.data.text });
        break;
      default:
        console.warn(`[cloneSession] Unknown event type: ${event.type}`);
    }
  } catch (error) {
    console.error(`[cloneSession] Failed to replay event ${event.type}:`, error);
  }
}


function reportProgress(
  callback: ProgressCallback | undefined,
  stage: CloneStage,
  progress: number,
  message?: string
): void {
  if (callback) {
    callback({ stage, progress, message });
  }
  if (message) {
    console.log(`[cloneSession] [${stage}] ${message} (${progress}%)`);
  }
}

function getCacheKey(request: any): string {
  const criticalHeaders = ['content-type', 'accept', 'authorization', 'cookie'];
  const headerParts = criticalHeaders
    .map(h => {
      const value = request.headers[h] || request.headers[h.toLowerCase()] || '';
      return `${h}:${value}`;
    })
    .join('|');

  let key = `${request.method}:${request.url}:${headerParts}`;

  if (request.postData) {
    const postDataHash = createHash('sha256')
      .update(request.postData)
      .digest('hex')
      .substring(0, 16);
    key += `:${postDataHash}`;
  }

  return key;
}

type RemovableEmitter = CDPSession & {
  off?: (event: string, listener: (...args: any[]) => void) => void;
  removeListener: (event: string, listener: (...args: any[]) => void) => void;
};

function removeListener<T extends (...args: any[]) => void>(
  emitter: CDPSession,
  event: string,
  listener: T
): void {
  const target = emitter as RemovableEmitter;
  if (typeof target.off === 'function') {
    target.off(event, listener);
  } else {
    target.removeListener(event, listener);
  }
}

async function disposeTarget(target: { page: Page; cdp?: CDPSession }): Promise<void> {
  if (target.cdp) {
    try {
      await target.cdp.detach();
    } catch {
      // ignore
    }
  }
  try {
    await target.page.close();
  } catch {
    // ignore
  }
}
