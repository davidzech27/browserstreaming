import type { Browser } from 'playwright';
import type { ServerWebSocket } from 'bun';
import {
  createSession,
  closeSession,
  getSession,
  getConnectionSessions,
  QUALITY_TIERS,
} from './session-manager';

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

// Handle all WebSocket messages
export async function handleMessage(
  ws: ServerWebSocket,
  message: string | Buffer,
  connectionId: string,
  sharedBrowser: Browser
): Promise<void> {
  const data = JSON.parse(message.toString());

  try {
    switch (data.type) {
      // Session lifecycle management
      case 'createSession': {
        const tier = data.tier || 'primary';
        const sessionId = await createSession(connectionId, ws, sharedBrowser, tier);
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
        const sessionIds = Array.from(getConnectionSessions(connectionId) || []);
        ws.send(JSON.stringify({
          type: 'sessionList',
          sessions: sessionIds,
        }));
        break;
      }

      // All other commands require a sessionId
      case 'navigate': {
        const { sessionId, url } = data;
        const session = getSession(sessionId);

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

          // Use domcontentloaded for reliability (doesn't wait for all images/resources)
          // This is much more reliable for complex sites like Google
          await session.page.goto(normalizedUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
          });

          // Try to wait for load event with a short timeout
          await session.page.waitForLoadState('load', { timeout: 5000 }).catch(() => {
            console.log(`[${connectionId}][${sessionId}] Load event timeout - page may have many resources`);
          });

          // Wait for network to be mostly idle (max 2 connections)
          // This ensures dynamic content has loaded
          await session.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {
            console.log(`[${connectionId}][${sessionId}] Network idle timeout - continuing anyway`);
          });

          // Get the actual final URL (includes path, query, and any redirects)
          const actualUrl = session.page.url();
          console.log(`[${connectionId}][${sessionId}] Final URL: ${actualUrl}`);

          ws.send(JSON.stringify({
            type: 'navigationComplete',
            sessionId,
            url: actualUrl,
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
        const session = getSession(sessionId);

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
        const session = getSession(sessionId);

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
        const session = getSession(sessionId);

        if (!session || session.connectionId !== connectionId) {
          break;
        }

        // Map to CDP event type
        const cdpType = data.type === 'keyDown' ? 'keyDown' : 'keyUp';

        // Prepare CDP key event parameters
        const keyEventParams: any = {
          type: cdpType,
          modifiers: data.modifiers || 0,
        };

        // Set key and code if provided
        if (data.key) {
          keyEventParams.key = data.key;
        }
        if (data.code) {
          keyEventParams.code = data.code;
        }

        // Only include text for keyDown events with printable characters
        // Do NOT include text for keyUp or for special keys (arrows, etc.)
        if (cdpType === 'keyDown' && data.text) {
          keyEventParams.text = data.text;
        }

        // For special keys, we need unmodifiedText to be empty string
        // This helps arrow keys, backspace, etc. work correctly
        if (cdpType === 'keyDown' && !data.text) {
          keyEventParams.unmodifiedText = '';
        }

        console.log(`[${connectionId}][${sessionId}] Key event: ${cdpType} key="${data.key}" code="${data.code}" text="${data.text || '(none)'}"`);

        await session.cdp.send('Input.dispatchKeyEvent', keyEventParams);
        break;
      }

      // Paste
      case 'paste': {
        const { sessionId } = data;
        const session = getSession(sessionId);

        if (!session || session.connectionId !== connectionId) {
          break;
        }

        await session.cdp.send('Input.insertText', {
          text: data.text,
        });
        break;
      }

      // Get scroll position
      case 'getScrollPosition': {
        const { sessionId } = data;
        const session = getSession(sessionId);

        if (!session || session.connectionId !== connectionId) {
          break;
        }

        try {
          const scrollPos = await session.page.evaluate(() => ({
            x: window.scrollX,
            y: window.scrollY
          }));

          ws.send(JSON.stringify({
            type: 'scrollPosition',
            sessionId,
            scrollX: scrollPos.x,
            scrollY: scrollPos.y,
          }));
        } catch (error) {
          console.error(`[${connectionId}][${sessionId}] Error getting scroll position:`, error);
        }
        break;
      }

      // Set scroll position
      case 'setScrollPosition': {
        const { sessionId, scrollX, scrollY } = data;
        const session = getSession(sessionId);

        if (!session || session.connectionId !== connectionId) {
          break;
        }

        try {
          // Wait for the page to be ready (navigation complete)
          await session.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {
            console.log(`[${connectionId}][${sessionId}] DOMContentLoaded timeout during scroll`);
          });

          // Get current scroll position to check if we need to update
          const currentScroll = await session.page.evaluate(() => ({
            x: window.scrollX,
            y: window.scrollY
          }));

          // Only scroll if the position is different
          if (currentScroll.x !== scrollX || currentScroll.y !== scrollY) {
            // Disable smooth scrolling and scroll instantly
            await session.page.evaluate((scroll: { x: number; y: number }) => {
              // Save original scroll behavior
              const htmlElement = document.documentElement;
              const bodyElement = document.body;
              const originalHtmlBehavior = htmlElement.style.scrollBehavior;
              const originalBodyBehavior = bodyElement.style.scrollBehavior;

              // Force instant scrolling
              htmlElement.style.scrollBehavior = 'auto';
              bodyElement.style.scrollBehavior = 'auto';

              // Scroll instantly
              window.scrollTo({
                left: scroll.x,
                top: scroll.y,
                behavior: 'auto'
              });

              // Restore original behavior
              htmlElement.style.scrollBehavior = originalHtmlBehavior;
              bodyElement.style.scrollBehavior = originalBodyBehavior;
            }, { x: scrollX, y: scrollY });

            // Verify scroll completed
            const finalScroll = await session.page.evaluate(() => ({
              x: window.scrollX,
              y: window.scrollY
            }));

            if (finalScroll.x !== scrollX || finalScroll.y !== scrollY) {
              console.log(`[${connectionId}][${sessionId}] Scroll position mismatch - requested (${scrollX}, ${scrollY}), got (${finalScroll.x}, ${finalScroll.y})`);
            }

            // Send scroll complete confirmation
            ws.send(JSON.stringify({
              type: 'scrollComplete',
              sessionId,
              scrollX: finalScroll.x,
              scrollY: finalScroll.y,
            }));
          } else {
            // Scroll position didn't change, still send confirmation
            ws.send(JSON.stringify({
              type: 'scrollComplete',
              sessionId,
              scrollX: currentScroll.x,
              scrollY: currentScroll.y,
            }));
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          // Only log if it's not a navigation-related error (which is expected during replay)
          if (!errorMessage.includes('Execution context was destroyed') &&
              !errorMessage.includes('Navigation')) {
            console.error(`[${connectionId}][${sessionId}] Error setting scroll position:`, error);
          }
        }
        break;
      }

      // Dynamic quality tier switching
      case 'setQualityTier': {
        const { sessionId } = data;
        const session = getSession(sessionId);

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
        const session = getSession(sessionId);

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

      // Get current URL from a session
      case 'getCurrentUrl': {
        const { sessionId } = data;
        const session = getSession(sessionId);

        if (!session || session.connectionId !== connectionId) {
          ws.send(JSON.stringify({
            type: 'error',
            message: `Invalid session: ${sessionId}`,
          }));
          break;
        }

        try {
          const currentUrl = session.page.url();
          console.log(`[${connectionId}][${sessionId}] Current URL: ${currentUrl}`);

          ws.send(JSON.stringify({
            type: 'currentUrl',
            sessionId,
            url: currentUrl,
          }));
        } catch (error) {
          console.error(`[${connectionId}][${sessionId}] Error getting current URL:`, error);
          ws.send(JSON.stringify({
            type: 'error',
            sessionId,
            message: 'Failed to get current URL',
          }));
        }
        break;
      }

      // Set resolution dynamically
      case 'setResolution': {
        const { sessionId, width, height } = data;
        const session = getSession(sessionId);

        if (!session || session.connectionId !== connectionId) {
          ws.send(JSON.stringify({
            type: 'error',
            message: `Invalid session: ${sessionId}`,
          }));
          break;
        }

        try {
          console.log(`[${connectionId}][${sessionId}] Updating resolution to ${width}x${height}`);

          // Update viewport size
          await session.page.setViewportSize({ width, height });

          // Restart screencast with new resolution
          const tier = QUALITY_TIERS[session.currentTier];
          const everyNthFrame = Math.max(1, Math.round(30 / tier.fps));

          await session.cdp.send('Page.stopScreencast');
          await session.cdp.send('Page.startScreencast', {
            format: 'jpeg',
            quality: tier.quality,
            maxWidth: width,
            maxHeight: height,
            everyNthFrame: everyNthFrame,
          });

          ws.send(JSON.stringify({
            type: 'resolutionChanged',
            sessionId,
            width,
            height,
          }));
        } catch (error) {
          console.error(`[${connectionId}][${sessionId}] Error setting resolution:`, error);
          ws.send(JSON.stringify({
            type: 'error',
            sessionId,
            message: 'Failed to set resolution',
          }));
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
}
