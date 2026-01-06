/**
 * 增强功能类型定义
 * 用于连接池、缓存、权限、审计等功能
 */

// ==================== 连接池类型 ====================

export interface SSHConnectionConfig {
  id: string
  sshClient: any
  nodeId: string
  createdAt: number
  lastUsedAt: number
  inUse: boolean
  commandCount: number
}

export interface ConnectionPoolConfig {
  enabled: boolean
  maxConnectionsPerNode: number
  minConnectionsPerNode: number
  connectionTimeout: number
  idleTimeout: number
  healthCheckInterval: number
}

// ==================== 缓存类型 ====================

export interface CacheEntry<T = any> {
  value: T
  expiresAt: number
  tags: string[]
  createdAt: number
  accessCount: number
}

export interface CacheConfig {
  enabled: boolean
  defaultTTL: number
  cleanupInterval: number
  maxCacheSize: number
}

export interface CacheStats {
  size: number
  hitRate: number
  missCount: number
  hitCount: number
}

// ==================== 权限类型 ====================

export interface Permission {
  id: string
  name: string
  description: string
  resource: 'node' | 'container' | 'image' | 'network' | 'volume'
  action: 'view' | 'start' | 'stop' | 'restart' | 'exec' | 'delete' | 'update' | 'create'
}

export interface Role {
  id: string
  name: string
  description?: string
  permissions: string[] // Permission ID 列表
}

export interface UserPermission {
  id: number
  platform: string
  userId: string
  roles: string[] // Role ID 列表
  nodePermissions: Record<string, string[]> // nodeId -> permissionIds
  createdAt: number
  updatedAt: number
}

export interface PermissionConfig {
  enabled: boolean
  defaultRole: 'viewer' | 'operator' | 'admin'
  adminUsers: string[]
}

// ==================== 审计日志类型 ====================

export interface AuditLog {
  id: number
  timestamp: number
  platform: string
  userId: string
  userName?: string
  channelId: string
  action: string // 命令名称
  parameters: Record<string, any> // 命令参数
  result: 'success' | 'failure'
  errorMessage?: string
  duration: number // 执行时长
  nodeId?: string
  containerId?: string
  metadata: Record<string, any>
}

export interface AuditLogData {
  action: string
  result: 'success' | 'failure'
  duration: number
  session?: any
  args?: any[]
  errorMessage?: string
  nodeId?: string
  containerId?: string
  metadata?: Record<string, any>
}

export interface AuditLogFilter {
  userId?: string
  action?: string
  result?: 'success' | 'failure'
  nodeId?: string
  limit?: number
  offset?: number
  startTime?: number
  endTime?: number
}

export interface AuditConfig {
  enabled: boolean
  retentionDays: number
  sensitiveFields: string[]
}

// ==================== 重连类型 ====================

export interface ReconnectConfig {
  enabled: boolean
  maxAttempts: number
  initialDelay: number
  maxDelay: number
  heartbeatInterval: number
}

// ==================== 重试类型 ====================

export interface RetryConfig {
  maxAttempts: number
  initialDelay: number
  maxDelay: number
  retryableErrors: string[]
}
