import { chromium, type Browser } from 'playwright';
import { file } from 'bun';
import type { ServerWebSocket } from 'bun';
import { initializeConnection, cleanupConnection, closeAllSessionsForConnection, getSession } from './session-manager';
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

    // Handle link click API
    if (url.pathname === '/api/click-element' && req.method === 'POST') {
      try {
        const body = await req.json();
        const { sessionId, elementId } = body;

        if (!sessionId || !elementId) {
          return new Response(JSON.stringify({ error: 'sessionId and elementId required (format: link-###)' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Get the session from session manager
        const session = getSession(sessionId);

        if (!session) {
          return new Response(JSON.stringify({ error: 'Session not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Parse the element ID to get index
        const match = elementId.match(/^link-(\d+)$/);
        if (!match) {
          return new Response(JSON.stringify({ error: 'Invalid elementId format. Use link-###' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const index = parseInt(match[1], 10);

        // Click the link
        const result = await session.page.evaluate((idx: number) => {
          const links = Array.from(document.querySelectorAll('a[href]'));
          if (idx < 0 || idx >= links.length) {
            return { success: false, error: `Link index ${idx} out of range (0-${links.length - 1})` };
          }

          const link = links[idx] as HTMLAnchorElement;
          const href = link.href;
          const text = link.textContent?.trim() || '';

          link.click();
          return { success: true, href, text };
        }, index);

        if (!result.success) {
          return new Response(JSON.stringify({ error: result.error }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        return new Response(JSON.stringify({
          success: true,
          elementId,
          href: result.href,
          text: result.text,
          message: `Clicked ${elementId}: ${result.text}`
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('Error clicking link:', error);
        return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Handle text extraction API
    if (url.pathname === '/api/extract-text' && req.method === 'POST') {
      try {
        const body = await req.json();
        const { sessionId } = body;

        if (!sessionId) {
          return new Response(JSON.stringify({ error: 'sessionId required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Get the session from session manager
        const session = getSession(sessionId);

        if (!session) {
          return new Response(JSON.stringify({ error: 'Session not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Extract text and links from the page
        const pageData = await session.page.evaluate(() => {
          // Get the page title
          const title = document.title;

          // Get the current URL
          const url = window.location.href;

          // Extract all text content (remove scripts, styles, etc.)
          const textElements = document.body.innerText;

          // Extract all links with their text and href
          const links = Array.from(document.querySelectorAll('a[href]')).map((link, index) => ({
            index, // Add index for API reference
            id: `link-${index}`, // Structured ID
            text: link.textContent?.trim() || '',
            href: link.getAttribute('href') || '',
            absoluteUrl: (link as HTMLAnchorElement).href // Resolved absolute URL
          })).filter(link => link.text || link.href); // Filter out empty links

          return {
            title,
            url,
            text: textElements,
            links,
            linkCount: links.length
          };
        });

        // Deduplicate links by URL and merge texts, keeping first index and ID
        const linkMap = new Map<string, { texts: Set<string>, firstIndex: number, firstId: string }>();

        for (const link of pageData.links) {
          if (!linkMap.has(link.absoluteUrl)) {
            linkMap.set(link.absoluteUrl, { texts: new Set(), firstIndex: link.index, firstId: link.id });
          }
          if (link.text) {
            linkMap.get(link.absoluteUrl)!.texts.add(link.text);
          }
        }

        // Create a compact link reference table with merged duplicates
        const uniqueLinks = Array.from(linkMap.entries());
        const linkTable = uniqueLinks.map(([url, data]) => {
          const textArray = Array.from(data.texts).filter(t => t.trim());

          // Use the first text, or show multiple if different
          let displayText = '';
          if (textArray.length === 0) {
            displayText = '[no text]';
          } else if (textArray.length === 1) {
            const text = textArray[0];
            displayText = text.substring(0, 60) + (text.length > 60 ? '...' : '');
          } else {
            // Show first text and count of alternatives
            const first = textArray[0].substring(0, 50) + (textArray[0].length > 50 ? '...' : '');
            displayText = `${first} (+${textArray.length - 1} variants)`;
          }

          return `[${data.firstId}] ${displayText} → ${url}`;
        }).join('\n');

        // Format response in LLM-friendly format
        const formattedResponse = {
          title: pageData.title,
          url: pageData.url,
          textContent: pageData.text,
          links: pageData.links,
          uniqueLinks: uniqueLinks.map(([url, data]) => ({
            url,
            firstIndex: data.firstIndex,
            firstId: data.firstId,
            texts: Array.from(data.texts)
          })),
          summary: {
            characterCount: pageData.text.length,
            totalLinks: pageData.linkCount,
            uniqueLinks: uniqueLinks.length
          },
          // LLM-friendly formatted text with numbered link references
          formatted: `# ${pageData.title}\n\nURL: ${pageData.url}\n\n## Content\n\n${pageData.text}\n\n## Links (${uniqueLinks.length} unique, ${pageData.linkCount} total)\n\n${linkTable}`
        };

        return new Response(JSON.stringify(formattedResponse, null, 2), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('Error extracting text:', error);
        return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
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
