import { chromium, type Browser, type BrowserContext, type Page, type CDPSession } from 'playwright';
import { file } from 'bun';
import type { ServerWebSocket } from 'bun';

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
  width: number;
  height: number;
  quality: number;
  fps: number;
}

const QUALITY_TIERS: Record<string, StreamQuality> = {
  background: {
    width: 1920,
    height: 1200,
    quality: 50,
    fps: 1,
  },
  secondary: {
    width: 1920,
    height: 1200,
    quality: 75,
    fps: 15,
  },
  primary: {
    width: 2880,
    height: 1800,
    quality: 85,
    fps: 120,
  },
};

// Browser session interface
interface BrowserSession {
  sessionId: string;
  connectionId: string;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  currentTier: string;
}

// Store all active sessions by sessionId
const sessions = new Map<string, BrowserSession>();

// Track which sessions belong to which connection
const connectionSessions = new Map<string, Set<string>>();

// Shared browser instance
let sharedBrowser: Browser | null = null;

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
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Helper function to normalize and validate URLs
function normalizeUrl(url: string): string {
  let normalized = url.trim();

  // If no protocol specified, add https://
  if (!normalized.match(/^[a-zA-Z][a-zA-Z\d+\-.]*:/)) {
    normalized = 'https://' + normalized;
  }

  // Validate the URL
  try {
    new URL(normalized);
    return normalized;
  } catch (error) {
    throw new Error(`Invalid URL: ${url}`);
  }
}

// Helper function to create a new browser session
async function createSession(connectionId: string, ws: ServerWebSocket, tier: string = 'primary'): Promise<string> {
  if (!sharedBrowser) {
    throw new Error('Shared browser not initialized');
  }

  const sessionId = crypto.randomUUID();
  const selectedTier = QUALITY_TIERS[tier] || QUALITY_TIERS.primary;

  console.log(`[${connectionId}][${sessionId}] Creating new session with ${tier} tier`);

  // Create new context with anti-detection configuration
  const context = await sharedBrowser.newContext({
    viewport: { width: selectedTier.width, height: selectedTier.height },
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

  // Inject anti-detection scripts
  await page.addInitScript(() => {
    // Remove webdriver flag
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
    });

    // Add chrome object
    (window as any).chrome = {
      runtime: {},
      loadTimes: function() {},
      csi: function() {},
      app: {},
    };

    // Mock plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', length: 1 },
        { name: 'Chrome PDF Viewer', length: 1 },
        { name: 'Native Client', length: 1 },
      ],
    });

    // Fix languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });

    // Override permissions query
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters: any) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: (Notification as any).permission } as PermissionStatus) :
        originalQuery(parameters)
    );
  });

  // Get CDP session
  const cdp = await context.newCDPSession(page);

  // Start screencast
  const everyNthFrame = Math.max(1, Math.round(30 / selectedTier.fps));
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: selectedTier.quality,
    maxWidth: selectedTier.width,
    maxHeight: selectedTier.height,
    everyNthFrame: everyNthFrame,
  });

  // Listen for frames - include sessionId in frame data
  cdp.on('Page.screencastFrame', async (event) => {
    const frameEvent = event as unknown as ScreencastFrameEvent;
    ws.send(JSON.stringify({
      type: 'frame',
      sessionId: sessionId,
      data: frameEvent.data,
      metadata: frameEvent.metadata,
    }));

    // Acknowledge frame
    await cdp.send('Page.screencastFrameAck', {
      sessionId: frameEvent.sessionId,
    });
  });

  // Store session
  const session: BrowserSession = {
    sessionId,
    connectionId,
    context,
    page,
    cdp,
    currentTier: tier,
  };

  sessions.set(sessionId, session);
  connectionSessions.get(connectionId)?.add(sessionId);

  return sessionId;
}

// Helper function to close a session
async function closeSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    console.warn(`Session ${sessionId} not found`);
    return;
  }

  console.log(`[${session.connectionId}][${sessionId}] Closing session`);

  try {
    await session.cdp.detach();
    await session.context.close();
  } catch (error) {
    console.error(`[${session.connectionId}][${sessionId}] Error closing session:`, error);
  }

  // Remove from tracking
  sessions.delete(sessionId);
  connectionSessions.get(session.connectionId)?.delete(sessionId);
}

Bun.serve({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    // Handle WebSocket upgrade
    if (url.pathname === '/ws') {
      const upgraded = server.upgrade(req);
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
      const connectionId = crypto.randomUUID();
      wsWithId.connectionId = connectionId;

      console.log(`[${connectionId}] WebSocket connected`);

      // Initialize empty session set for this connection
      connectionSessions.set(connectionId, new Set());

      ws.send(JSON.stringify({
        type: 'connected',
        connectionId,
        message: 'Ready to create sessions',
      }));
    },

    async message(ws, message) {
      const wsWithId = ws as WebSocketWithId;
      const connectionId = wsWithId.connectionId;
      const data = JSON.parse(message.toString());

      try {
        switch (data.type) {
          // Session lifecycle management
          case 'createSession': {
            const tier = data.tier || 'primary';
            const sessionId = await createSession(connectionId, ws, tier);
            const selectedTier = QUALITY_TIERS[tier];

            ws.send(JSON.stringify({
              type: 'sessionCreated',
              sessionId,
              tier,
              width: selectedTier.width,
              height: selectedTier.height,
            }));
            console.log(`[${connectionId}][${sessionId}] Session created`);
            break;
          }

          case 'closeSession': {
            const { sessionId } = data;
            if (!sessionId) {
              ws.send(JSON.stringify({
                type: 'error',
                message: 'sessionId required for closeSession',
              }));
              break;
            }

            await closeSession(sessionId);
            ws.send(JSON.stringify({
              type: 'sessionClosed',
              sessionId,
            }));
            break;
          }

          case 'listSessions': {
            const sessionIds = Array.from(connectionSessions.get(connectionId) || []);
            ws.send(JSON.stringify({
              type: 'sessionList',
              sessions: sessionIds,
            }));
            break;
          }

          // All other commands require a sessionId
          case 'navigate': {
            const { sessionId, url } = data;
            const session = sessions.get(sessionId);

            if (!session || session.connectionId !== connectionId) {
              ws.send(JSON.stringify({
                type: 'error',
                message: `Invalid session: ${sessionId}`,
              }));
              break;
            }

            try {
              const normalizedUrl = normalizeUrl(url);
              console.log(`[${connectionId}][${sessionId}] Navigating to: ${normalizedUrl}`);
              await session.page.goto(normalizedUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
              });

              // Wait a bit more for dynamic content to load
              await new Promise(resolve => setTimeout(resolve, 500));

              ws.send(JSON.stringify({
                type: 'navigationComplete',
                sessionId,
                url: normalizedUrl,
              }));
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : 'Navigation failed';
              console.error(`[${connectionId}][${sessionId}] Navigation error:`, errorMessage);
              ws.send(JSON.stringify({
                type: 'error',
                sessionId,
                message: errorMessage,
              }));
            }
            break;
          }

          // Raw CDP mouse events
          case 'mousePressed':
          case 'mouseReleased':
          case 'mouseMoved': {
            const { sessionId } = data;
            const session = sessions.get(sessionId);

            if (!session || session.connectionId !== connectionId) {
              break;
            }

            await session.cdp.send('Input.dispatchMouseEvent', {
              type: data.type,
              x: data.x,
              y: data.y,
              button: data.button,
              clickCount: data.clickCount || 1,
              modifiers: data.modifiers || 0,
            });
            break;
          }

          // Raw CDP wheel event
          case 'mouseWheel': {
            const { sessionId } = data;
            const session = sessions.get(sessionId);

            if (!session || session.connectionId !== connectionId) {
              break;
            }

            await session.cdp.send('Input.dispatchMouseEvent', {
              type: 'mouseWheel',
              x: data.x,
              y: data.y,
              deltaX: data.deltaX || 0,
              deltaY: data.deltaY || 0,
              modifiers: data.modifiers || 0,
            });
            break;
          }

          // Raw CDP keyboard events
          case 'keyDown':
          case 'keyUp': {
            const { sessionId } = data;
            const session = sessions.get(sessionId);

            if (!session || session.connectionId !== connectionId) {
              break;
            }

            await session.cdp.send('Input.dispatchKeyEvent', {
              type: data.type,
              key: data.key,
              code: data.code,
              text: data.text,
              modifiers: data.modifiers || 0,
            });
            break;
          }

          // Paste
          case 'paste': {
            const { sessionId } = data;
            const session = sessions.get(sessionId);

            if (!session || session.connectionId !== connectionId) {
              break;
            }

            await session.cdp.send('Input.insertText', {
              text: data.text,
            });
            break;
          }

          // Dynamic quality tier switching
          case 'setQualityTier': {
            const { sessionId } = data;
            const session = sessions.get(sessionId);

            if (!session || session.connectionId !== connectionId) {
              ws.send(JSON.stringify({
                type: 'error',
                message: `Invalid session: ${sessionId}`,
              }));
              break;
            }

            const tier = QUALITY_TIERS[data.tier];
            if (!tier) {
              console.warn(`[${connectionId}][${sessionId}] Unknown quality tier: ${data.tier}`);
              break;
            }

            const tierEveryNthFrame = Math.max(1, Math.round(30 / tier.fps));
            console.log(`[${connectionId}][${sessionId}] Switching to ${data.tier} tier (${tier.width}x${tier.height} @ ${tier.quality}% quality, ${tier.fps} fps)`);

            // Stop current screencast
            await session.cdp.send('Page.stopScreencast');

            // Start screencast with new tier settings
            await session.cdp.send('Page.startScreencast', {
              format: 'jpeg',
              quality: tier.quality,
              maxWidth: tier.width,
              maxHeight: tier.height,
              everyNthFrame: tierEveryNthFrame,
            });

            session.currentTier = data.tier;

            ws.send(JSON.stringify({
              type: 'qualityTierChanged',
              sessionId,
              tier: data.tier,
              width: tier.width,
              height: tier.height,
            }));
            break;
          }

          // Request an immediate frame from a session
          case 'requestFrame': {
            const { sessionId } = data;
            const session = sessions.get(sessionId);

            if (!session || session.connectionId !== connectionId) {
              ws.send(JSON.stringify({
                type: 'error',
                message: `Invalid session: ${sessionId}`,
              }));
              break;
            }

            try {
              // Capture a screenshot using CDP
              const tier = QUALITY_TIERS[session.currentTier];
              const screenshot = await session.cdp.send('Page.captureScreenshot', {
                format: 'jpeg',
                quality: tier.quality,
                clip: {
                  x: 0,
                  y: 0,
                  width: tier.width,
                  height: tier.height,
                  scale: 1,
                },
              }) as { data: string };

              // Get viewport dimensions
              const viewport = session.page.viewportSize();

              ws.send(JSON.stringify({
                type: 'frame',
                sessionId: sessionId,
                data: screenshot.data,
                metadata: {
                  width: viewport?.width || tier.width,
                  height: viewport?.height || tier.height,
                },
              }));
            } catch (error) {
              console.error(`[${connectionId}][${sessionId}] Error capturing frame:`, error);
            }
            break;
          }

          default:
            console.warn(`[${connectionId}] Unknown message type: ${data.type}`);
        }
      } catch (error) {
        console.error(`[${connectionId}] Error handling message:`, error);
        ws.send(JSON.stringify({
          type: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
        }));
      }
    },

    async close(ws) {
      const wsWithId = ws as WebSocketWithId;
      const connectionId = wsWithId.connectionId;
      console.log(`[${connectionId}] WebSocket disconnected`);

      // Get all sessions for this connection
      const sessionIds = connectionSessions.get(connectionId);

      if (sessionIds && sessionIds.size > 0) {
        console.log(`[${connectionId}] Cleaning up ${sessionIds.size} session(s)`);

        // Close all sessions for this connection
        const closePromises = Array.from(sessionIds).map(sessionId => closeSession(sessionId));
        await Promise.all(closePromises);
      }

      // Remove connection tracking
      connectionSessions.delete(connectionId);
    },
  },
});

// Initialize browser and start server
await initBrowser();
console.log(`Server running at http://localhost:${PORT}`);
