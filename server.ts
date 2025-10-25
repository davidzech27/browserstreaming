import { chromium, type Browser, type BrowserContext, type Page, type CDPSession, type Frame } from 'playwright';
import { file } from 'bun';
import type { ServerWebSocket } from 'bun';
import { NetworkCache } from './src/clone/NetworkCache';
import { cloneSession } from './src/clone/CloneOrchestrator';
import { capturePageSnapshot } from './src/clone/StateSnapshot';
import type { SessionContext, RecordedEvent } from './src/clone/types';
import { createPendingSessionStore } from './src/clone/PendingSessionStore';

const PORT = 3000;

// Custom WebSocket type with connection ID
interface WebSocketWithId extends ServerWebSocket {
  connectionId: string;
}

// CDP screencast frame event type
interface ScreencastFrameEvent {
  data: string;
  metadata: {
    width: number;
    height: number;
  };
  sessionId: number;
}

// Quality tier configuration
interface StreamQuality {
  quality: number;
  fps: number;
}

const MACBOOK_VIEWPORT = {
  width: 1512,
  height: 982,
};

const QUALITY_TIERS: Record<string, StreamQuality> = {
  background: {
    quality: 45,
    fps: 5,
  },
  secondary: {
    quality: 70,
    fps: 15,
  },
  primary: {
    quality: 85,
    fps: 30,
  },
};

// Store active contexts per connection
const contexts = new Map<string, SessionContext>();
const PENDING_SESSION_TTL_MS = 60_000;
const pendingSessions = createPendingSessionStore({
  ttlMs: PENDING_SESSION_TTL_MS,
  dispose: disposeSession,
});

// Shared browser instance
let sharedBrowser: Browser | null = null;

type QualityTierName = keyof typeof QUALITY_TIERS;

function normalizeResponseHeaders(headers?: Array<{ name: string; value: string }> | Record<string, string>): Record<string, string> {
  if (!headers) return {};
  if (!Array.isArray(headers)) {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      normalized[key.toLowerCase()] = value;
    }
    return normalized;
  }

  const normalized: Record<string, string> = {};
  for (const header of headers) {
    if (!header?.name) continue;
    normalized[header.name.toLowerCase()] = header.value ?? '';
  }
  return normalized;
}

async function enableNetworkCapture(connectionId: string, session: SessionContext): Promise<void> {
  if (session.networkCaptureEnabled) {
    return;
  }

  session.networkCaptureEnabled = true;

  const networkCdp = session.networkCdp ?? await session.context.newCDPSession(session.page);
  session.networkCdp = networkCdp;

  await networkCdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*', requestStage: 'Response' }],
  });

  const listener = async (event: any) => {
    const { requestId, request, responseStatusCode, responseHeaders } = event;

    const isRedirect = typeof responseStatusCode === 'number'
      && responseStatusCode >= 300
      && responseStatusCode < 400;
    const headersAvailable = Array.isArray(responseHeaders) ? responseHeaders.length > 0 : !!responseHeaders;

    if (isRedirect || !headersAvailable) {
      try {
        await networkCdp.send('Fetch.continueRequest', { requestId });
      } catch {
        // Request might have already been handled
      }
      return;
    }

    try {
      const bodyResult = await networkCdp.send('Fetch.getResponseBody', { requestId });

      const cacheKey = session.networkCache.getCacheKey({
        method: request.method,
        url: request.url,
        headers: request.headers,
        postData: request.postData,
      });

      const body = Buffer.from(
        bodyResult.body,
        bodyResult.base64Encoded ? 'base64' : 'utf8'
      );

      const normalizedHeaders = normalizeResponseHeaders(responseHeaders);
      const mimeType = normalizedHeaders['content-type'] || 'text/html';

      session.networkCache.set(cacheKey, {
        requestId,
        url: request.url,
        method: request.method,
        requestHeaders: request.headers,
        postData: request.postData,
        status: responseStatusCode || 200,
        responseHeaders: normalizedHeaders,
        body,
        mimeType,
        resourceType: event.resourceType || 'other',
        timestamp: Date.now(),
      });
    } catch (error) {
      console.warn(`[${connectionId}] Failed to cache response for ${request?.url}:`, error);
    }

    try {
      await networkCdp.send('Fetch.continueRequest', { requestId });
    } catch {
      // Request might have already been handled
    }
  };

  session.networkCaptureListener = listener;
  networkCdp.on('Fetch.requestPaused', listener);
}

type RemovableEmitter = CDPSession & {
  off?: (event: string, listener: (...args: any[]) => void) => void;
};

function removeListener<T extends (...args: any[]) => void>(
  emitter: CDPSession,
  event: string,
  listener?: T
): void {
  if (!listener) return;
  const target = emitter as RemovableEmitter;
  if (typeof target.off === 'function') {
    target.off(event, listener);
  } else {
    emitter.removeListener(event, listener);
  }
}

async function forceInitialFrame(connectionId: string, session: SessionContext): Promise<void> {
  // Try to force Chrome to produce a BeginFrame via the headless experimental API.
  try {
    await session.cdp.send('HeadlessExperimental.beginFrame', {
      frameTimeTicks: Date.now(),
      interval: 16,
      noDisplayUpdates: false,
      screenshot: {
        format: 'jpeg',
        quality: 10,
      },
    });
    return;
  } catch (error) {
    console.warn(`[${connectionId}] beginFrame kick failed:`, error);
  }

  // Fallback: take a tiny screenshot to dirty the compositor.
  try {
    await session.cdp.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 10,
      clip: {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        scale: 1,
      },
      optimizeForSpeed: true,
    });
    return;
  } catch (error) {
    console.warn(`[${connectionId}] captureScreenshot kick failed:`, error);
  }

  // Last resort: jiggle viewport dimensions by 1px.
  const viewport = session.page.viewportSize();
  if (!viewport) {
    return;
  }

  try {
    await session.page.setViewportSize({
      width: viewport.width,
      height: Math.max(1, viewport.height - 1),
    });
    await session.page.setViewportSize(viewport);
  } catch (error) {
    console.warn(`[${connectionId}] Viewport jiggle failed:`, error);
  }
}

const SCREENCAST_FIRST_FRAME_TIMEOUT_MS = 2_500;
const MAX_SCREENCAST_RESTARTS = 3;

function clearScreencastStartupTimer(session: SessionContext): void {
  if (session.screencastStartupTimeout) {
    clearTimeout(session.screencastStartupTimeout);
    session.screencastStartupTimeout = undefined;
  }
}

async function ensurePageActive(connectionId: string, session: SessionContext): Promise<void> {
  try {
    await session.page.bringToFront();
  } catch {
    // bringToFront is a noop in headless but safe to ignore
  }

  try {
    await session.cdp.send('Page.bringToFront');
  } catch {
    // Some Chromium builds may not support this command in headless
  }

  try {
    await session.cdp.send('Page.setWebLifecycleState', { state: 'active' });
  } catch {
    // Some Chromium builds might not support this; ignore
  }
}

async function startScreencast(
  connectionId: string,
  session: SessionContext,
  ws: WebSocketWithId,
  tierName: QualityTierName,
  options?: { preserveRestartCounter?: boolean }
): Promise<void> {
  const tier = QUALITY_TIERS[tierName] ?? QUALITY_TIERS.primary;
  const everyNthFrame = Math.max(1, Math.round(30 / tier.fps));

  removeListener(session.cdp, 'Page.screencastFrame', session.screencastListener);
  removeListener(session.cdp, 'Page.screencastVisibilityChanged', session.screencastVisibilityListener);
  clearScreencastStartupTimer(session);

  if (!options?.preserveRestartCounter) {
    session.screencastRestartAttempts = 0;
  }

  await ensurePageActive(connectionId, session);

  const handler = async (event: any) => {
    clearScreencastStartupTimer(session);
    session.screencastRestartAttempts = 0;

    const frameEvent = event as unknown as ScreencastFrameEvent;
    try {
      ws.send(JSON.stringify({
        type: 'frame',
        data: frameEvent.data,
        metadata: frameEvent.metadata,
      }));
    } catch (error) {
      console.warn(`[${connectionId}] Failed to send frame:`, error);
      return;
    }

    try {
      await session.cdp.send('Page.screencastFrameAck', {
        sessionId: frameEvent.sessionId,
      });
    } catch (error) {
      console.warn(`[${connectionId}] Failed to ack frame:`, error);
    }
  };

  const visibilityHandler = (event: { visible: boolean }) => {
    if (event?.visible === false) {
      console.warn(`[${connectionId}] Screencast target hidden, forcing active state...`);
      ensurePageActive(connectionId, session).catch(error => {
        console.error(`[${connectionId}] Failed to reactivate page:`, error);
      });
    }
  };

  session.screencastListener = handler;
  session.screencastVisibilityListener = visibilityHandler;
  session.currentQualityTier = tierName;
  session.cdp.on('Page.screencastFrame', handler);
  session.cdp.on('Page.screencastVisibilityChanged', visibilityHandler);

  function scheduleStartupWatchdog(): void {
    clearScreencastStartupTimer(session);
    session.screencastStartupTimeout = setTimeout(() => {
      const attempts = (session.screencastRestartAttempts ?? 0) + 1;
      session.screencastRestartAttempts = attempts;
      if (attempts > MAX_SCREENCAST_RESTARTS) {
        console.error(`[${connectionId}] Screencast failed to start after ${attempts} attempts`);
        clearScreencastStartupTimer(session);
        return;
      }

      console.warn(`[${connectionId}] Screencast produced no frames after ${SCREENCAST_FIRST_FRAME_TIMEOUT_MS}ms, retrying (attempt ${attempts})`);
      startScreencast(connectionId, session, ws, tierName, { preserveRestartCounter: true }).catch(error => {
        console.error(`[${connectionId}] Screencast restart failed:`, error);
      });
    }, SCREENCAST_FIRST_FRAME_TIMEOUT_MS);
  }

  try {
    await session.cdp.send('Page.stopScreencast');
  } catch {
    // Ignore if no screencast
  }

  await session.cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: tier.quality,
    maxWidth: MACBOOK_VIEWPORT.width,
    maxHeight: MACBOOK_VIEWPORT.height,
    everyNthFrame,
  });

  await forceInitialFrame(connectionId, session);

  scheduleStartupWatchdog();
}

async function cleanupScreencast(session: SessionContext): Promise<void> {
  removeListener(session.cdp, 'Page.screencastFrame', session.screencastListener);
  removeListener(session.cdp, 'Page.screencastVisibilityChanged', session.screencastVisibilityListener);
  session.screencastListener = undefined;
  session.screencastVisibilityListener = undefined;
  clearScreencastStartupTimer(session);
  session.screencastRestartAttempts = 0;
  try {
    await session.cdp.send('Page.stopScreencast');
  } catch {
    // Already stopped
  }
}

async function disposeSession(connectionId: string, session: SessionContext): Promise<void> {
  try {
    await cleanupScreencast(session);
  } catch (error) {
    console.warn(`[${connectionId}] Failed to stop screencast:`, error);
  }

  if (session.navigationListener) {
    try {
      session.page.off('framenavigated', session.navigationListener);
    } catch {
      // ignore
    }
    session.navigationListener = undefined;
  }

  if (session.networkCdp) {
    removeListener(session.networkCdp, 'Fetch.requestPaused', session.networkCaptureListener);
    try {
      await session.networkCdp.send('Fetch.disable');
    } catch {
      // already disabled or session gone
    }
    try {
      await session.networkCdp.detach();
    } catch (error) {
      console.warn(`[${connectionId}] Failed to detach network CDP session:`, error);
    }
  }
  session.networkCaptureListener = undefined;

  try {
    await session.cdp.detach();
  } catch (error) {
    console.warn(`[${connectionId}] Failed to detach CDP session:`, error);
  }

  try {
    await session.page.close();
  } catch (error) {
    console.warn(`[${connectionId}] Failed to close page:`, error);
  }

  if (session.ownsContext) {
    try {
      await session.context.close();
    } catch (error) {
      console.warn(`[${connectionId}] Failed to close context:`, error);
    }
  }
}

function ensureScrollAccumulator(session: SessionContext): void {
  if (!session.scrollAccumulator) {
    session.scrollAccumulator = {
      deltaX: 0,
      deltaY: 0,
      lastX: 0,
      lastY: 0,
      lastModifiers: 0,
      lastFlush: Date.now(),
    };
  }

  if (!session.mouseMoveAccumulator) {
    session.mouseMoveAccumulator = {
      lastX: 0,
      lastY: 0,
      lastButton: 'none',
      lastModifiers: 0,
      lastFlush: Date.now(),
    };
  }
}

function resetEventRecording(session: SessionContext): void {
  session.eventLog = [];
  session.sessionStartTime = Date.now();

  if (session.scrollAccumulator) {
    session.scrollAccumulator.deltaX = 0;
    session.scrollAccumulator.deltaY = 0;
    session.scrollAccumulator.lastFlush = Date.now();
  }

  if (session.mouseMoveAccumulator) {
    session.mouseMoveAccumulator.lastFlush = Date.now();
  }
}

function bindNavigationReset(session: SessionContext): void {
  if (session.navigationListener) {
    return;
  }

  session.lastNavigatedUrl = session.page.url();

  const handler = (frame: Frame) => {
    if (frame.parentFrame()) {
      return;
    }

    const newUrl = frame.url();
    if (newUrl === session.lastNavigatedUrl) {
      return;
    }

    session.lastNavigatedUrl = newUrl;
    resetEventRecording(session);
  };

  session.navigationListener = handler;
  session.page.on('framenavigated', handler);
}

function fireAndForgetInput(connectionId: string, promise: Promise<unknown>): void {
  promise.catch(error => {
    console.error(`[${connectionId}] Input dispatch failed:`, error);
  });
}

async function createSessionForConnection(connectionId: string): Promise<SessionContext> {
  if (!sharedBrowser) {
    throw new Error('Shared browser not initialized');
  }

  const context = await sharedBrowser.newContext({
    viewport: { width: MACBOOK_VIEWPORT.width, height: MACBOOK_VIEWPORT.height },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    deviceScaleFactor: 2,
    hasTouch: false,
    colorScheme: 'light',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const page = await context.newPage();

  await page.addInitScript(() => {
    const chromeWindow = window as Window & { chrome?: Record<string, unknown> };

    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
    });

    chromeWindow.chrome = {
      runtime: {},
      loadTimes: function () { },
      csi: function () { },
      app: {},
    };

    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', length: 1 },
        { name: 'Chrome PDF Viewer', length: 1 },
        { name: 'Native Client', length: 1 },
      ],
    });

    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });

    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission as PermissionState } as PermissionStatus)
        : originalQuery(parameters)
    );
  });

  const cdp = await context.newCDPSession(page);
  const networkCdp = await context.newCDPSession(page);

  const session: SessionContext = {
    context,
    page,
    cdp,
    networkCdp,
    networkCache: new NetworkCache(),
    eventLog: [],
    sessionStartTime: Date.now(),
    isRecording: true,
    scrollAccumulator: {
      deltaX: 0,
      deltaY: 0,
      lastX: 0,
      lastY: 0,
      lastModifiers: 0,
      lastFlush: Date.now(),
    },
    mouseMoveAccumulator: {
      lastX: 0,
      lastY: 0,
      lastButton: 'none',
      lastModifiers: 0,
      lastFlush: Date.now(),
    },
    currentQualityTier: 'primary',
    ownsContext: true,
  };

  resetEventRecording(session);
  bindNavigationReset(session);
  await enableNetworkCapture(connectionId, session);
  return session;
}
// Launch shared browser on startup
async function initBrowser() {
  console.log('Launching shared browser...');
  sharedBrowser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  console.log('Shared browser ready');
}

// Graceful shutdown
async function shutdown() {
  console.log('\nShutting down...');
  if (sharedBrowser) {
    await sharedBrowser.close();
  }
  await pendingSessions.flushAll();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

Bun.serve({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    // Handle WebSocket upgrade
    if (url.pathname === '/ws') {
      // Check if client is trying to attach to an existing session
      const sessionId = url.searchParams.get('sessionId');
      const upgraded = server.upgrade(req, {
        data: { sessionId }
      });
      if (!upgraded) {
        return new Response('WebSocket upgrade failed', { status: 500 });
      }
      return undefined;
    }

    // Serve static files
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = `./public${path}`;

    try {
      const f = file(filePath);
      return new Response(f);
    } catch {
      return new Response('Not found', { status: 404 });
    }
  },

  websocket: {
    async open(ws) {
      const wsWithId = ws as WebSocketWithId;
      const wsData = (ws.data ?? {}) as { sessionId?: string };
      const requestedSessionId = wsData.sessionId;

      let connectionId = requestedSessionId || crypto.randomUUID();
      let contextSession: SessionContext | undefined;

      if (requestedSessionId) {
        contextSession = pendingSessions.take(requestedSessionId);
        if (!contextSession) {
          console.warn(`[${requestedSessionId}] Requested session not found`);
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Requested session is no longer available',
          }));
          ws.close(1011, 'Session not found');
          return;
        }

        console.log(`[${requestedSessionId}] WebSocket attached to cloned session`);
      } else {
        console.log(`[${connectionId}] WebSocket connected`);
        contextSession = await createSessionForConnection(connectionId);
      }

      wsWithId.connectionId = connectionId;

      ensureScrollAccumulator(contextSession);
      bindNavigationReset(contextSession);
      contextSession.isRecording = true;
      await enableNetworkCapture(connectionId, contextSession);

      contextSession.currentQualityTier = contextSession.currentQualityTier || 'primary';
      contexts.set(connectionId, contextSession);

      await startScreencast(
        connectionId,
        contextSession,
        wsWithId,
        (contextSession.currentQualityTier as QualityTierName) || 'primary'
      );

      const viewport = contextSession.page.viewportSize();

      ws.send(JSON.stringify({
        type: 'ready',
        message: requestedSessionId ? 'Reconnected to existing browser context' : 'Browser context ready',
        connectionId,
        viewport,
      }));
    },

    async message(ws, message) {
      const wsWithId = ws as WebSocketWithId;
      const connectionId = wsWithId.connectionId;
      const contextSession = contexts.get(connectionId);

      const data = JSON.parse(message.toString());

      // Context might not be ready yet if messages arrive during setup (race condition)
      // This can happen when page refreshes and messages arrive before open() completes
      if (!contextSession) {
        console.warn(`[${connectionId}] Message received before context ready, ignoring: ${data.type}`);
        return;
      }

      const { page, cdp, eventLog, sessionStartTime, isRecording, scrollAccumulator, mouseMoveAccumulator } = contextSession;

      // Define which events are user interactions worth recording for replay
      const REPLAYABLE_EVENTS = new Set([
        'mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel',
        'keyDown', 'keyUp', 'paste'
      ]);

      // Record event if recording is enabled (with smart filtering)
      if (isRecording && REPLAYABLE_EVENTS.has(data.type)) {
        const AGGREGATE_INTERVAL = 100; // ms - interval for aggregating events

        // Aggregate mouse move events to reduce noise
        if (data.type === 'mouseMoved' && mouseMoveAccumulator) {
          const now = Date.now();

          // Update last position
          mouseMoveAccumulator.lastX = data.x;
          mouseMoveAccumulator.lastY = data.y;
          mouseMoveAccumulator.lastButton = data.button || 'none';
          mouseMoveAccumulator.lastModifiers = data.modifiers || 0;

          // Flush accumulated position if enough time passed
          if (now - mouseMoveAccumulator.lastFlush >= AGGREGATE_INTERVAL) {
            eventLog.push({
              type: 'mouseMoved',
              timestamp: now,
              relativeTime: now - sessionStartTime,
              data: {
                x: mouseMoveAccumulator.lastX,
                y: mouseMoveAccumulator.lastY,
                button: mouseMoveAccumulator.lastButton,
                modifiers: mouseMoveAccumulator.lastModifiers,
              },
            });

            // Reset flush timer
            mouseMoveAccumulator.lastFlush = now;
          }
        }
        // Aggregate scroll events to reduce noise
        else if (data.type === 'mouseWheel' && scrollAccumulator) {
          const now = Date.now();

          // Accumulate deltas
          scrollAccumulator.deltaX += data.deltaX || 0;
          scrollAccumulator.deltaY += data.deltaY || 0;
          scrollAccumulator.lastX = data.x;
          scrollAccumulator.lastY = data.y;
          scrollAccumulator.lastModifiers = data.modifiers || 0;

          // Flush accumulated scroll if enough time passed AND we have deltas
          if (now - scrollAccumulator.lastFlush >= AGGREGATE_INTERVAL) {
            // Only flush if we actually accumulated some scroll
            if (scrollAccumulator.deltaX !== 0 || scrollAccumulator.deltaY !== 0) {
              eventLog.push({
                type: 'mouseWheel',
                timestamp: now,
                relativeTime: now - sessionStartTime,
                data: {
                  x: scrollAccumulator.lastX,
                  y: scrollAccumulator.lastY,
                  deltaX: scrollAccumulator.deltaX,
                  deltaY: scrollAccumulator.deltaY,
                  modifiers: scrollAccumulator.lastModifiers,
                },
              });
            }

            // Reset accumulator
            scrollAccumulator.deltaX = 0;
            scrollAccumulator.deltaY = 0;
            scrollAccumulator.lastFlush = now;
          }
        }
        // Record actual user interaction events only
        else {
          eventLog.push({
            type: data.type,
            timestamp: Date.now(),
            relativeTime: Date.now() - sessionStartTime,
            data: data,
          });
        }
      }

      switch (data.type) {
        case 'navigate':
          console.log(`[${connectionId}] Navigating to: ${data.url}`);
          (async () => {
            try {
              await page.goto(data.url, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
              });
              ws.send(JSON.stringify({
                type: 'status',
                message: `Navigated to ${data.url}`,
              }));
            } catch (error) {
              console.error(`[${connectionId}] Navigation failed:`, error);
              ws.send(JSON.stringify({
                type: 'error',
                message: `Navigation failed: ${error}`,
              }));
            }
          })();
          break;

        // Raw CDP mouse events - perfect fidelity!
        case 'mousePressed':
        case 'mouseReleased':
        case 'mouseMoved':
          fireAndForgetInput(connectionId, cdp.send('Input.dispatchMouseEvent', {
            type: data.type,
            x: data.x,
            y: data.y,
            button: data.button,
            clickCount: data.clickCount || 1,
            modifiers: data.modifiers || 0,
          }));
          break;

        // Raw CDP wheel event - enables Ctrl+zoom, Shift+horizontal automatically!
        case 'mouseWheel':
          fireAndForgetInput(connectionId, cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: data.x,
            y: data.y,
            deltaX: data.deltaX || 0,
            deltaY: data.deltaY || 0,
            modifiers: data.modifiers || 0,
          }));
          break;

        // Raw CDP keyboard events
        case 'keyDown':
        case 'keyUp':
          fireAndForgetInput(connectionId, cdp.send('Input.dispatchKeyEvent', {
            type: data.type,
            key: data.key,
            code: data.code,
            text: data.text,
            modifiers: data.modifiers || 0,
          }));
          break;

        // Paste - use insertText CDP method
        case 'paste':
          fireAndForgetInput(connectionId, cdp.send('Input.insertText', {
            text: data.text,
          }));
          break;

        // Dynamic quality tier switching
        case 'setQualityTier':
          const tier = QUALITY_TIERS[data.tier];
          if (!tier) {
            console.warn(`[${connectionId}] Unknown quality tier: ${data.tier}`);
            break;
          }

          console.log(`[${connectionId}] Switching to ${data.tier} tier (${MACBOOK_VIEWPORT.width}x${MACBOOK_VIEWPORT.height} @ ${tier.quality}% quality, ${tier.fps} fps)`);

          await startScreencast(connectionId, contextSession, wsWithId, data.tier as QualityTierName);

          ws.send(JSON.stringify({
            type: 'qualityTierChanged',
            tier: data.tier,
            width: MACBOOK_VIEWPORT.width,
            height: MACBOOK_VIEWPORT.height,
          }));
          break;

        case 'cloneSession':
          console.log(`[${connectionId}] Cloning session...`);
          try {
            // Clone the current session
            const clonedSession = await cloneSession(
              contextSession,
              data.options || {},
              (progress) => {
                // Send progress updates
                ws.send(JSON.stringify({
                  type: 'cloneProgress',
                  stage: progress.stage,
                  progress: progress.progress,
                  message: progress.message,
                }));
              }
            );

            // Generate new connection ID for cloned session
            const clonedConnectionId = crypto.randomUUID();

            ensureScrollAccumulator(clonedSession);
            bindNavigationReset(clonedSession);
            clonedSession.currentQualityTier = 'primary';
            await enableNetworkCapture(clonedConnectionId, clonedSession);

            // Store cloned session until the client attaches
            pendingSessions.add(clonedConnectionId, clonedSession);

            ws.send(JSON.stringify({
              type: 'cloneCreated',
              targetConnectionId: clonedConnectionId,
              url: clonedSession.page.url(),
            }));

            console.log(`[${connectionId}] Clone created: ${clonedConnectionId}`);
          } catch (error) {
            console.error(`[${connectionId}] Clone failed:`, error);
            ws.send(JSON.stringify({
              type: 'error',
              message: `Clone failed: ${error}`,
            }));
          }
          break;

        case 'captureSnapshot':
          console.log(`[${connectionId}] Capturing snapshot...`);
          try {
            const snapshot = await capturePageSnapshot(page);
            const stats = contextSession.networkCache.getStats();

            ws.send(JSON.stringify({
              type: 'snapshotCaptured',
              snapshot: {
                url: snapshot.url,
                timestamp: snapshot.timestamp,
                viewport: snapshot.viewport,
              },
              cacheStats: stats,
            }));
          } catch (error) {
            console.error(`[${connectionId}] Snapshot failed:`, error);
            ws.send(JSON.stringify({
              type: 'error',
              message: `Snapshot failed: ${error}`,
            }));
          }
          break;

        case 'getCacheStats':
          const stats = contextSession.networkCache.getStats();
          ws.send(JSON.stringify({
            type: 'cacheStats',
            stats,
            eventsRecorded: eventLog.length,
          }));
          break;

        case 'toggleRecording':
          contextSession.isRecording = data.enabled ?? !contextSession.isRecording;
          ws.send(JSON.stringify({
            type: 'recordingStatus',
            isRecording: contextSession.isRecording,
            eventsRecorded: eventLog.length,
          }));
          break;

        default:
          console.warn(`[${connectionId}] Unknown message type: ${data.type}`);
      }
    },

    async close(ws) {
      const wsWithId = ws as WebSocketWithId;
      const connectionId = wsWithId.connectionId;
      console.log(`[${connectionId}] WebSocket disconnected`);

      const contextSession = contexts.get(connectionId);
      if (contextSession) {
        await disposeSession(connectionId, contextSession);
        contexts.delete(connectionId);
      }
    },
  },
});

// Initialize browser and start server
await initBrowser();
console.log(`Server running at http://localhost:${PORT}`);
