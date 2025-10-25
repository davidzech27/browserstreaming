import type { Browser, BrowserContext, Page, CDPSession } from 'playwright';
import type { ServerWebSocket } from 'bun';

// Browser session interface
export interface BrowserSession {
  sessionId: string;
  connectionId: string;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  currentTier: string;
}

// Quality tier configuration
export interface StreamQuality {
  width: number;
  height: number;
  quality: number;
  fps: number;
}

export const QUALITY_TIERS: Record<string, StreamQuality> = {
  background: {
    width: 2880,
    height: 1800,
    quality: 50,
    fps: 1,
  },
  secondary: {
    width: 2880,
    height: 1800,
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

// CDP screencast frame event type
interface ScreencastFrameEvent {
  data: string;
  metadata: {
    width: number;
    height: number;
  };
  sessionId: number;
}

// Store all active sessions by sessionId
const sessions = new Map<string, BrowserSession>();

// Track which sessions belong to which connection
const connectionSessions = new Map<string, Set<string>>();

// Export getters for the maps
export function getSession(sessionId: string): BrowserSession | undefined {
  return sessions.get(sessionId);
}

export function getAllSessions(): Map<string, BrowserSession> {
  return sessions;
}

export function getConnectionSessions(connectionId: string): Set<string> | undefined {
  return connectionSessions.get(connectionId);
}

export function initializeConnection(connectionId: string): void {
  connectionSessions.set(connectionId, new Set());
}

export function cleanupConnection(connectionId: string): void {
  connectionSessions.delete(connectionId);
}

// Helper function to create a new browser session
export async function createSession(
  connectionId: string,
  ws: ServerWebSocket,
  sharedBrowser: Browser,
  tier: string = 'primary'
): Promise<string> {
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

  // Listen for URL changes (navigation events)
  page.on('framenavigated', (frame) => {
    // Only send updates for the main frame
    if (frame === page.mainFrame()) {
      const newUrl = frame.url();
      console.log(`[${connectionId}][${sessionId}] URL changed to: ${newUrl}`);
      ws.send(JSON.stringify({
        type: 'urlChanged',
        sessionId: sessionId,
        url: newUrl,
      }));
    }
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
export async function closeSession(sessionId: string): Promise<void> {
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

// Close all sessions for a connection
export async function closeAllSessionsForConnection(connectionId: string): Promise<void> {
  const sessionIds = connectionSessions.get(connectionId);

  if (sessionIds && sessionIds.size > 0) {
    console.log(`[${connectionId}] Cleaning up ${sessionIds.size} session(s)`);

    const closePromises = Array.from(sessionIds).map(sessionId => closeSession(sessionId));
    await Promise.all(closePromises);
  }

  connectionSessions.delete(connectionId);
}
