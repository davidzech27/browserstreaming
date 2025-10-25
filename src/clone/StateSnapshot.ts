import type { Page } from 'playwright';
import type { PageSnapshot } from './types';

/**
 * Capture the minimal state required to recreate a tab: URL + viewport metadata.
 */
export async function capturePageSnapshot(page: Page): Promise<PageSnapshot> {
  const viewport = page.viewportSize();

  if (!viewport) {
    throw new Error('Viewport size is not available');
  }

  return {
    url: page.url(),
    timestamp: Date.now(),
    viewport: {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 2,
    },
  };
}
