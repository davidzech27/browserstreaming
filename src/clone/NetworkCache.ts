import type { CachedResponse, CacheKey } from './types';
import { createHash } from 'crypto';

/**
 * Network response cache with intelligent deduplication
 */
export class NetworkCache extends Map {
  private cache: Map<string, CachedResponse>;
  private totalSize: number;
  private readonly maxSize: number;
  private readonly maxResponseSize: number;

  constructor(options?: { maxSize?: number; maxResponseSize?: number }) {
    super()
    this.cache = new Map();
    this.totalSize = 0;
    this.maxSize = options?.maxSize ?? 500 * 1024 * 1024;  // 500MB default
    this.maxResponseSize = options?.maxResponseSize ?? 10 * 1024 * 1024;  // 10MB per response
  }

  /**
   * Generate cache key from request details
   * Uses URL + method + critical headers for deduplication
   */
  getCacheKey(request: CacheKey): string {
    const criticalHeaders = ['content-type', 'accept', 'authorization', 'cookie'];
    const headerParts = criticalHeaders
      .map(h => {
        const value = request.headers[h] || request.headers[h.toLowerCase()] || '';
        return `${h}:${value}`;
      })
      .join('|');

    let key = `${request.method}:${request.url}:${headerParts}`;

    // Include POST data hash if present
    if (request.postData) {
      const postDataHash = createHash('sha256')
        .update(request.postData)
        .digest('hex')
        .substring(0, 16);
      key += `:${postDataHash}`;
    }

    return key;
  }

  /**
   * Check if response should be cached based on size and type
   */
  shouldCache(response: Partial<CachedResponse>): boolean {
    // Always cache essential resources
    const essentialTypes = ['document', 'script', 'stylesheet', 'xhr', 'fetch'];
    if (response.resourceType && essentialTypes.includes(response.resourceType)) {
      return true;
    }

    // Cache small resources
    if (response.body && response.body.length < this.maxResponseSize) {
      return true;
    }

    // Don't cache very large resources (videos, large downloads)
    return false;
  }

  /**
   * Store a response in cache
   */
  set(key: string, response: CachedResponse): boolean {
    // Check if we should cache this response
    if (!this.shouldCache(response)) {
      console.log(`[NetworkCache] Skipping cache for large resource: ${response.url} (${response.body.length} bytes)`);
      return false;
    }

    const responseSize = response.body.length;

    // Check if this key already exists and subtract old size
    const existingResponse = this.cache.get(key);
    const oldSize = existingResponse ? existingResponse.body.length : 0;

    // Check if adding this would exceed max cache size (accounting for replacement)
    const netSizeChange = responseSize - oldSize;
    if (this.totalSize + netSizeChange > this.maxSize) {
      console.warn(`[NetworkCache] Cache size limit reached (${this.totalSize} bytes), cannot cache ${response.url}`);
      return false;
    }

    // Store in cache and update total size
    this.cache.set(key, response);
    this.totalSize += netSizeChange;

    console.log(`[NetworkCache] Cached ${response.resourceType}: ${response.url} (${responseSize} bytes, total: ${this.totalSize} bytes)`);
    return true;
  }

  /**
   * Retrieve a response from cache
   */
  get(key: string): CachedResponse | undefined {
    return this.cache.get(key);
  }

  /**
   * Check if a key exists in cache
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Get all cached responses
   */
  getAll(): Map<string, CachedResponse> {
    return new Map(this.cache);
  }

  /**
   * Get cache statistics
   */
  getStats(): { entries: number; totalSize: number; sizeByType: Record<string, number> } {
    const sizeByType: Record<string, number> = {};

    for (const response of this.cache.values()) {
      const type = response.resourceType;
      sizeByType[type] = (sizeByType[type] || 0) + response.body.length;
    }

    return {
      entries: this.cache.size,
      totalSize: this.totalSize,
      sizeByType,
    };
  }

  /**
   * Clear the cache
   */
  clear(): void {
    this.cache.clear();
    this.totalSize = 0;
    console.log('[NetworkCache] Cache cleared');
  }

  /**
   * Remove specific entry from cache
   */
  delete(key: string): boolean {
    const response = this.cache.get(key);
    if (response) {
      this.totalSize -= response.body.length;
      this.cache.delete(key);
      return true;
    }
    return false;
  }

  /**
   * Export cache to plain object (for serialization)
   */
  export(): { entries: Array<{ key: string; response: CachedResponse }> } {
    const entries: Array<{ key: string; response: CachedResponse }> = [];

    for (const [key, response] of this.cache.entries()) {
      entries.push({ key, response });
    }

    return { entries };
  }

  /**
   * Import cache from plain object
   */
  import(data: { entries: Array<{ key: string; response: CachedResponse }> }): void {
    this.clear();

    for (const { key, response } of data.entries) {
      // Ensure body is a Buffer
      if (!(response.body instanceof Buffer)) {
        response.body = Buffer.from(response.body);
      }
      this.set(key, response);
    }

    console.log(`[NetworkCache] Imported ${data.entries.length} cached responses`);
  }

  /**
   * Clone this cache (creates a new cache with same entries)
   */
  clone(): NetworkCache {
    const newCache = new NetworkCache({
      maxSize: this.maxSize,
      maxResponseSize: this.maxResponseSize,
    });

    for (const [key, response] of this.cache.entries()) {
      // Deep clone the response
      newCache.set(key, {
        ...response,
        body: Buffer.from(response.body),
        requestHeaders: { ...response.requestHeaders },
        responseHeaders: { ...response.responseHeaders },
      });
    }

    return newCache;
  }
}
