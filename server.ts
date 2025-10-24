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

// Store active contexts per connection
const contexts = new Map<string, { context: BrowserContext; page: Page; cdp: CDPSession }>();

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

      if (!sharedBrowser) {
        throw new Error('Shared browser not initialized');
      }

      // Create new context with anti-detection configuration
      const primaryTier = QUALITY_TIERS.primary;
      const context = await sharedBrowser.newContext({
        viewport: { width: primaryTier.width, height: primaryTier.height },
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

      // Start screencast with primary tier (best quality for initial load)
      const everyNthFrame = Math.max(1, Math.round(30 / primaryTier.fps));
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: primaryTier.quality,
        maxWidth: primaryTier.width,
        maxHeight: primaryTier.height,
        everyNthFrame: everyNthFrame,
      });

      // Listen for frames
      cdp.on('Page.screencastFrame', async (event) => {
        const frameEvent = event as unknown as ScreencastFrameEvent;
        ws.send(JSON.stringify({
          type: 'frame',
          data: frameEvent.data,
          metadata: frameEvent.metadata,
        }));

        // Acknowledge frame
        await cdp.send('Page.screencastFrameAck', {
          sessionId: frameEvent.sessionId,
        });
      });

      // Store context instance
      contexts.set(connectionId, { context, page, cdp });

      ws.send(JSON.stringify({
        type: 'status',
        message: 'Browser ready',
      }));
    },

    async message(ws, message) {
      const wsWithId = ws as WebSocketWithId;
      const connectionId = wsWithId.connectionId;
      const contextSession = contexts.get(connectionId);

      if (!contextSession) {
        throw new Error(`No context session found for ${connectionId}`);
      }

      const { page, cdp } = contextSession;

      const data = JSON.parse(message.toString());

      switch (data.type) {
        case 'navigate':
          console.log(`[${connectionId}] Navigating to: ${data.url}`);
          await page.goto(data.url, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
          });
          ws.send(JSON.stringify({
            type: 'status',
            message: `Navigated to ${data.url}`,
          }));
          break;

        // Raw CDP mouse events - perfect fidelity!
        case 'mousePressed':
        case 'mouseReleased':
        case 'mouseMoved':
          await cdp.send('Input.dispatchMouseEvent', {
            type: data.type,
            x: data.x,
            y: data.y,
            button: data.button,
            clickCount: data.clickCount || 1,
            modifiers: data.modifiers || 0,
          });
          break;

        // Raw CDP wheel event - enables Ctrl+zoom, Shift+horizontal automatically!
        case 'mouseWheel':
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: data.x,
            y: data.y,
            deltaX: data.deltaX || 0,
            deltaY: data.deltaY || 0,
            modifiers: data.modifiers || 0,
          });
          break;

        // Raw CDP keyboard events
        case 'keyDown':
        case 'keyUp':
          await cdp.send('Input.dispatchKeyEvent', {
            type: data.type,
            key: data.key,
            code: data.code,
            text: data.text,
            modifiers: data.modifiers || 0,
          });
          break;

        // Paste - use insertText CDP method
        case 'paste':
          await cdp.send('Input.insertText', {
            text: data.text,
          });
          break;

        // Dynamic quality tier switching
        case 'setQualityTier':
          const tier = QUALITY_TIERS[data.tier];
          if (!tier) {
            console.warn(`[${connectionId}] Unknown quality tier: ${data.tier}`);
            break;
          }

          const tierEveryNthFrame = Math.max(1, Math.round(30 / tier.fps));
          console.log(`[${connectionId}] Switching to ${data.tier} tier (${tier.width}x${tier.height} @ ${tier.quality}% quality, ${tier.fps} fps)`);

          // Stop current screencast
          await cdp.send('Page.stopScreencast');

          // Start screencast with new tier settings
          await cdp.send('Page.startScreencast', {
            format: 'jpeg',
            quality: tier.quality,
            maxWidth: tier.width,
            maxHeight: tier.height,
            everyNthFrame: tierEveryNthFrame,
          });

          ws.send(JSON.stringify({
            type: 'qualityTierChanged',
            tier: data.tier,
            width: tier.width,
            height: tier.height,
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
        try {
          await contextSession.cdp.detach();
          await contextSession.context.close();
        } catch (error) {
          console.error(`[${connectionId}] Error closing context:`, error);
        }
        contexts.delete(connectionId);
      }
    },
  },
});

// Initialize browser and start server
await initBrowser();
console.log(`Server running at http://localhost:${PORT}`);
