import { chromium, type Browser } from 'playwright';
import { file } from 'bun';
import type { ServerWebSocket } from 'bun';
import { initializeConnection, cleanupConnection, closeAllSessionsForConnection } from './session-manager';
import { handleMessage } from './message-handlers';

const PORT = 3000;

// Custom WebSocket type with connection ID
interface WebSocketWithId extends ServerWebSocket {
  connectionId: string;
}

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

      // Initialize empty session set for this connection
      initializeConnection(connectionId);

      ws.send(JSON.stringify({
        type: 'connected',
        connectionId,
        message: 'Ready to create sessions',
      }));
    },

    async message(ws, message) {
      const wsWithId = ws as WebSocketWithId;
      const connectionId = wsWithId.connectionId;

      if (!sharedBrowser) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Browser not initialized',
        }));
        return;
      }

      await handleMessage(ws, message, connectionId, sharedBrowser);
    },

    async close(ws) {
      const wsWithId = ws as WebSocketWithId;
      const connectionId = wsWithId.connectionId;
      console.log(`[${connectionId}] WebSocket disconnected`);

      // Close all sessions for this connection
      await closeAllSessionsForConnection(connectionId);

      // Remove connection tracking
      cleanupConnection(connectionId);
    },
  },
});

// Initialize browser and start server
await initBrowser();
console.log(`Server running at http://localhost:${PORT}`);
