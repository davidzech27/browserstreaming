import type { BrowserContext, Page, CDPSession, Frame } from 'playwright';
import { NetworkCache } from './NetworkCache';

/**
 * Resource timing information
 */
export interface ResourceTiming {
  requestTime: number;
  proxyStart: number;
  proxyEnd: number;
  dnsStart: number;
  dnsEnd: number;
  connectStart: number;
  connectEnd: number;
  sslStart: number;
  sslEnd: number;
  sendStart: number;
  sendEnd: number;
  receiveHeadersEnd: number;
}

/**
 * Cached network response
 */
export interface CachedResponse {
  // Request identifiers
  requestId: string;
  url: string;
  method: string;

  // Request details
  requestHeaders: Record<string, string>;
  postData?: string;  // For POST/PUT requests

  // Response details
  status: number;
  statusText?: string;
  responseHeaders: Record<string, string>;
  body: Buffer;  // Store as Buffer to handle binary data
  mimeType: string;

  // Metadata
  resourceType: string;  // document, script, stylesheet, image, etc.
  timestamp: number;
  timing?: ResourceTiming;  // Optional: preserve timing info
}

/**
 * Recorded user interaction event
 */
export interface RecordedEvent {
  type: string;  // 'mousePressed', 'keyDown', 'scroll', etc.
  timestamp: number;  // Absolute timestamp
  relativeTime: number;  // Time since session start (for replay)
  data: any;  // Event-specific data
}

/**
 * Enhanced mouse event with element targeting info
 */
export interface EnhancedMouseEvent extends RecordedEvent {
  data: {
    x: number;
    y: number;
    button: string;
    clickCount: number;
    modifiers: number;
    // Element info for fallback
    targetElement?: {
      selector: string;
      tagName: string;
      textContent: string;
    };
  };
}

/**
 * Complete page state snapshot
 */
export interface PageSnapshot {
  // Basic info
  url: string;
  timestamp: number;

  // Viewport
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
  };
}

/**
 * Complete clone manifest - everything needed to recreate a page
 */
export interface CloneManifest {
  networkCacheSnapshot: {
    entries: Array<{ key: string; response: CachedResponse }>;
  };
  eventLog: RecordedEvent[];
  snapshot: PageSnapshot;
}

/**
 * Clone options
 */
export interface CloneOptions {
  playbackSpeed?: number;  // 1.0 = real-time, 2.0 = 2x speed, 0 = instant
  skipAnimations?: boolean;
}

/**
 * Clone progress stages
 */
export type CloneStage = 'initializing' | 'loading' | 'replaying' | 'complete' | 'failed';

/**
 * Session context with cloning capabilities
 */
export interface SessionContext {
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  networkCdp?: CDPSession;
  networkCache: NetworkCache;
  eventLog: RecordedEvent[];
  sessionStartTime: number;
  isRecording: boolean;  // Whether network/event recording is active
  scrollAccumulator?: {  // For aggregating scroll deltas
    deltaX: number;
    deltaY: number;
    lastX: number;
    lastY: number;
    lastModifiers: number;
    lastFlush: number;
  };
  mouseMoveAccumulator?: {  // For aggregating mouse movements
    lastX: number;
    lastY: number;
    lastButton: string;
    lastModifiers: number;
    lastFlush: number;
  };
  currentQualityTier?: string;
  screencastListener?: (event: any) => void;
  screencastVisibilityListener?: (event: any) => void;
  screencastStartupTimeout?: ReturnType<typeof setTimeout>;
  screencastRestartAttempts?: number;
  networkCaptureListener?: (event: any) => void;
  networkCaptureEnabled?: boolean;
  ownsContext: boolean;
  navigationListener?: (frame: Frame) => void;
  lastNavigatedUrl?: string;
}

/**
 * Cache key for deduplication
 */
export interface CacheKey {
  method: string;
  url: string;
  headers: Record<string, string>;
  postData?: string;
}
