/**
 * 缓存管理器
 * 用于缓存 Docker 查询结果，减少重复查询
 */
import type { CacheEntry, CacheConfig, CacheStats } from '../types/enhanced'
import { nodeLogger } from '../utils/logger'

/**
 * 缓存管理器
 */
export class CacheManager {
  private cache: Map<string, CacheEntry> = new Map()
  private config: CacheConfig
  private cleanupTimer: NodeJS.Timeout | null = null
  private hitCount = 0
  private missCount = 0

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      defaultTTL: config.defaultTTL ?? 30000,
      cleanupInterval: config.cleanupInterval ?? 60000,
      maxCacheSize: config.maxCacheSize ?? 1000,
    }

    if (this.config.enabled) {
      this.startCleanup()
    }
  }

  /**
   * 获取缓存
   */
  async get<T>(key: string): Promise<T | null> {
    if (!this.config.enabled) return null

    const entry = this.cache.get(key)

    if (!entry) {
      this.missCount++
      return null
    }

    // 检查是否过期
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      this.missCount++
      nodeLogger.debug(`[缓存] 命中已过期: ${key}`)
      return null
    }

    // 更新访问信息
    entry.accessCount++
    this.hitCount++

    nodeLogger.debug(`[缓存] 命中: ${key} (访问次数: ${entry.accessCount})`)
    return entry.value as T
  }

  /**
   * 设置缓存
   */
  set<T>(key: string, value: T, ttl?: number, tags: string[] = []): void {
    if (!this.config.enabled) return

    const effectiveTTL = ttl ?? this.config.defaultTTL

    // 检查缓存大小
    if (this.cache.size >= this.config.maxCacheSize) {
      this.evictLRU()
    }

    const entry: CacheEntry<T> = {
      value,
      expiresAt: Date.now() + effectiveTTL,
      tags,
      createdAt: Date.now(),
      accessCount: 0,
    }

    this.cache.set(key, entry)
    nodeLogger.debug(`[缓存] 设置: ${key} (TTL: ${effectiveTTL}ms, 标签: ${tags.join(',')})`)
  }

  /**
   * 使缓存失效
   */
  invalidate(pattern: string): void {
    if (!this.config.enabled) return

    let deletedCount = 0

    if (pattern.includes('*')) {
      // 通配符模式
      const regex = new RegExp(pattern.replace(/\*/g, '.*'))
      for (const key of this.cache.keys()) {
        if (regex.test(key)) {
          this.cache.delete(key)
          deletedCount++
        }
      }
    } else {
      // 精确匹配
      if (this.cache.delete(pattern)) {
        deletedCount = 1
      }
    }

    if (deletedCount > 0) {
      nodeLogger.debug(`[缓存] 失效: ${pattern} (删除 ${deletedCount} 条)`)
    }
  }

  /**
   * 按标签失效
   */
  invalidateByTag(tag: string): void {
    if (!this.config.enabled) return

    let deletedCount = 0

    for (const [key, entry] of this.cache.entries()) {
      if (entry.tags.includes(tag)) {
        this.cache.delete(key)
        deletedCount++
      }
    }

    if (deletedCount > 0) {
      nodeLogger.debug(`[缓存] 按标签失效: ${tag} (删除 ${deletedCount} 条)`)
    }
  }

  /**
   * LRU 淘汰策略
   */
  private evictLRU(): void {
    let oldestKey: string | null = null
    let oldestAccessCount = Infinity
    let oldestCreatedAt = Infinity

    for (const [key, entry] of this.cache.entries()) {
      // 优先淘汰访问次数少的
      if (entry.accessCount < oldestAccessCount) {
        oldestKey = key
        oldestAccessCount = entry.accessCount
        oldestCreatedAt = entry.createdAt
      } else if (entry.accessCount === oldestAccessCount && entry.createdAt < oldestCreatedAt) {
        // 访问次数相同时，淘汰创建时间早的
        oldestKey = key
        oldestCreatedAt = entry.createdAt
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey)
      nodeLogger.debug(`[缓存] LRU 淘汰: ${oldestKey}`)
    }
  }

  /**
   * 启动清理任务
   */
  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup()
    }, this.config.cleanupInterval)
  }

  /**
   * 清理过期缓存
   */
  private cleanup(): void {
    const now = Date.now()
    let deletedCount = 0

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key)
        deletedCount++
      }
    }

    if (deletedCount > 0) {
      nodeLogger.debug(`[缓存] 清理过期缓存: ${deletedCount} 条 (当前: ${this.cache.size})`)
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): CacheStats {
    const total = this.hitCount + this.missCount
    const hitRate = total > 0 ? this.hitCount / total : 0

    return {
      size: this.cache.size,
      hitRate,
      hitCount: this.hitCount,
      missCount: this.missCount,
    }
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear()
    this.hitCount = 0
    this.missCount = 0
    nodeLogger.info('[缓存] 缓存已清空')
  }

  /**
   * 停止清理任务
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  /**
   * 获取缓存大小
   */
  size(): number {
    return this.cache.size
  }

  /**
   * 检查是否启用
   */
  isEnabled(): boolean {
    return this.config.enabled
  }
}

/**
 * 缓存装饰器工厂
 */
export function Cache(
  ttl = 30000,
  tags: string[] = [],
  keyGenerator?: (...args: any[]) => string
) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value
    const cacheManagerSymbol = Symbol('cacheManager')

    descriptor.value = async function (...args: any[]) {
      // 获取缓存管理器实例
      let cacheManager = (this as any)[cacheManagerSymbol]
      if (!cacheManager) {
        cacheManager = new CacheManager()
        ;(this as any)[cacheManagerSymbol] = cacheManager
      }

      if (!cacheManager.isEnabled()) {
        return await originalMethod.apply(this, args)
      }

      // 生成缓存键
      let cacheKey: string
      if (keyGenerator) {
        cacheKey = keyGenerator(...args)
      } else {
        cacheKey = `${target.constructor.name}:${propertyKey}:${JSON.stringify(args)}`
      }

      // 尝试从缓存获取
      const cached = await cacheManager.get(cacheKey)
      if (cached !== null) {
        return cached
      }

      // 执行原方法
      const result = await originalMethod.apply(this, args)

      // 存入缓存
      cacheManager.set(cacheKey, result, ttl, tags)

      return result
    }

    return descriptor
  }
}

/**
 * 缓存失效辅助函数
 */
export class CacheInvalidator {
  constructor(private cacheManager: CacheManager) {}

  /**
   * 失效容器相关缓存
   */
  invalidateContainers(nodeId: string): void {
    this.cacheManager.invalidateByTag(`containers:${nodeId}`)
  }

  /**
   * 失效镜像相关缓存
   */
  invalidateImages(nodeId: string): void {
    this.cacheManager.invalidateByTag(`images:${nodeId}`)
  }

  /**
   * 失效系统信息缓存
   */
  invalidateSystemInfo(nodeId: string): void {
    this.cacheManager.invalidateByTag(`system:${nodeId}`)
  }

  /**
   * 失效节点所有缓存
   */
  invalidateNode(nodeId: string): void {
    this.cacheManager.invalidate(`${nodeId}:*`)
  }

  /**
   * 失效所有缓存
   */
  invalidateAll(): void {
    this.cacheManager.clear()
  }
}
