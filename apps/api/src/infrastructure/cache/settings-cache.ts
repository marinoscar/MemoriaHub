/**
 * Settings Cache
 *
 * A simple in-memory cache with TTL for system settings and user preferences.
 * Designed for self-hosted deployments where a single API instance is typical.
 *
 * Features:
 * - Time-based expiration (TTL)
 * - Pattern-based invalidation
 * - Automatic cleanup on access
 * - No external dependencies
 *
 * For multi-instance deployments, consider adding PostgreSQL LISTEN/NOTIFY
 * for cache invalidation across instances.
 */

import { logger } from '../logging/logger.js';

/**
 * Cache entry with value and expiration time
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  createdAt: number;
}

/**
 * Cache statistics for monitoring
 */
interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  invalidations: number;
  evictions: number;
}

/**
 * Settings cache class with TTL support
 */
class SettingsCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    sets: 0,
    invalidations: 0,
    evictions: 0,
  };

  // Default TTL: 5 minutes
  private readonly defaultTTL: number;
  // Maximum entries to prevent memory issues
  private readonly maxEntries: number;

  constructor(options?: { defaultTTLMs?: number; maxEntries?: number }) {
    this.defaultTTL = options?.defaultTTLMs ?? 5 * 60 * 1000;
    this.maxEntries = options?.maxEntries ?? 1000;
  }

  /**
   * Get a value from the cache
   * @returns The cached value or undefined if not found/expired
   */
  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.misses++;
      this.stats.evictions++;
      return undefined;
    }

    this.stats.hits++;
    return entry.value as T;
  }

  /**
   * Set a value in the cache
   * @param key Cache key
   * @param value Value to cache
   * @param ttlMs Optional TTL in milliseconds (overrides default)
   */
  set<T>(key: string, value: T, ttlMs?: number): void {
    // Enforce max entries limit
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      this.evictOldest();
    }

    const now = Date.now();
    this.cache.set(key, {
      value,
      expiresAt: now + (ttlMs ?? this.defaultTTL),
      createdAt: now,
    });
    this.stats.sets++;
  }

  /**
   * Get a value from cache, or compute and store it if not present
   * @param key Cache key
   * @param factory Function to compute the value if not cached
   * @param ttlMs Optional TTL in milliseconds
   */
  async getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    ttlMs?: number
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) {
      return cached;
    }

    const value = await factory();
    this.set(key, value, ttlMs);
    return value;
  }

  /**
   * Invalidate a specific key
   */
  invalidate(key: string): boolean {
    const deleted = this.cache.delete(key);
    if (deleted) {
      this.stats.invalidations++;
      logger.debug({ key }, 'Cache key invalidated');
    }
    return deleted;
  }

  /**
   * Invalidate all keys matching a pattern (prefix match)
   * @param pattern Key prefix to match
   * @returns Number of keys invalidated
   */
  invalidatePattern(pattern: string): number {
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.startsWith(pattern)) {
        this.cache.delete(key);
        count++;
      }
    }
    if (count > 0) {
      this.stats.invalidations += count;
      logger.debug({ pattern, count }, 'Cache keys invalidated by pattern');
    }
    return count;
  }

  /**
   * Clear all cached entries
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    logger.info({ clearedEntries: size }, 'Cache cleared');
  }

  /**
   * Get current cache statistics
   */
  getStats(): CacheStats & { size: number; hitRate: number } {
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      size: this.cache.size,
      hitRate: total > 0 ? this.stats.hits / total : 0,
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0,
      evictions: 0,
    };
  }

  /**
   * Evict the oldest entry to make room for new ones
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.stats.evictions++;
      logger.debug({ key: oldestKey }, 'Cache entry evicted (max entries reached)');
    }
  }

  /**
   * Clean up expired entries (run periodically if needed)
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.stats.evictions += cleaned;
      logger.debug({ cleaned }, 'Expired cache entries cleaned up');
    }

    return cleaned;
  }
}

// =============================================================================
// Cache Key Helpers
// =============================================================================

/**
 * Cache key prefixes for different types of settings
 */
export const CacheKeys = {
  /** System settings by category */
  systemSettings: (category: string) => `system:${category}`,

  /** All system settings */
  allSystemSettings: () => 'system:all',

  /** User preferences by user ID */
  userPreferences: (userId: string) => `user:${userId}:preferences`,

  /** Feature flags (frequently accessed) */
  featureFlags: () => 'system:features',
} as const;

/**
 * Cache key patterns for invalidation
 */
export const CachePatterns = {
  /** All system settings */
  allSystemSettings: 'system:',

  /** All user preferences */
  allUserPreferences: 'user:',

  /** Specific user's data */
  userSpecific: (userId: string) => `user:${userId}:`,
} as const;

// =============================================================================
// Singleton Instance
// =============================================================================

/**
 * Singleton settings cache instance
 *
 * Configuration:
 * - Default TTL: 5 minutes
 * - Max entries: 1000
 *
 * For system settings (rarely change): Use longer TTL
 * For user preferences (more frequent): Use default TTL
 */
export const settingsCache = new SettingsCache({
  defaultTTLMs: 5 * 60 * 1000, // 5 minutes
  maxEntries: 1000,
});

// =============================================================================
// Cache TTL Constants
// =============================================================================

/**
 * TTL values for different types of settings
 */
export const CacheTTL = {
  /** System settings rarely change - cache for 10 minutes */
  systemSettings: 10 * 60 * 1000,

  /** Feature flags are frequently checked - cache for 5 minutes */
  featureFlags: 5 * 60 * 1000,

  /** User preferences change more often - cache for 2 minutes */
  userPreferences: 2 * 60 * 1000,

  /** Short TTL for testing */
  short: 30 * 1000,
} as const;
