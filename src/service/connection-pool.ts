/**
 * SSH 连接池管理
 * 复用 SSH 连接，减少连接创建开销
 */
import { Client } from 'ssh2'
import type { NodeConfig, CredentialConfig } from '../types'
import type { SSHConnectionConfig, ConnectionPoolConfig } from '../types/enhanced'
import { connectorLogger } from '../utils/logger'

/**
 * SSH 连接封装
 */
class SSHConnection {
  id: string
  sshClient: Client | null = null
  nodeId: string
  createdAt: number
  lastUsedAt: number
  inUse: boolean
  commandCount: number
  isHealthy: boolean

  constructor(nodeId: string) {
    this.id = `conn-${nodeId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    this.nodeId = nodeId
    this.createdAt = Date.now()
    this.lastUsedAt = Date.now()
    this.inUse = false
    this.commandCount = 0
    this.isHealthy = true
  }

  /**
   * 标记为使用中
   */
  acquire(): void {
    this.inUse = true
    this.lastUsedAt = Date.now()
  }

  /**
   * 释放连接
   */
  release(): void {
    this.inUse = false
    this.lastUsedAt = Date.now()
  }

  /**
   * 检查是否过期
   */
  isExpired(idleTimeout: number): boolean {
    if (this.inUse) return false
    const idleTime = Date.now() - this.lastUsedAt
    return idleTime > idleTimeout
  }

  /**
   * 检查是否超过最大命令数
   */
  isExhausted(maxCommands: number): boolean {
    return this.commandCount >= maxCommands
  }

  /**
   * 增加命令计数
   */
  incrementCommandCount(): void {
    this.commandCount++
  }

  /**
   * 设置客户端
   */
  setClient(client: Client): void {
    this.sshClient = client
  }

  /**
   * 关闭连接
   */
  async close(): Promise<void> {
    if (this.sshClient) {
      return new Promise((resolve) => {
        this.sshClient!.end()
        this.sshClient = null
        resolve()
      })
    }
  }
}

/**
 * SSH 连接池管理器
 */
export class SSHConnectionPool {
  private pools: Map<string, SSHConnection[]> = new Map()
  private config: ConnectionPoolConfig
  private cleanupTimer: NodeJS.Timeout | null = null
  private healthCheckTimer: NodeJS.Timeout | null = null

  constructor(config: ConnectionPoolConfig) {
    this.config = config
    this.startCleanup()
    this.startHealthCheck()
  }

  /**
   * 获取连接
   */
  async acquire(
    nodeId: string,
    createConnection: () => Promise<Client>
  ): Promise<Client> {
    if (!this.config.enabled) {
      return await createConnection()
    }

    const pool = this.getOrCreatePool(nodeId)

    // 查找可用的连接
    const availableConnection = pool.find(
      (conn) => !conn.inUse && conn.isHealthy && conn.sshClient
    )

    if (availableConnection) {
      connectorLogger.debug(`[连接池] 复用连接: ${availableConnection.id}`)
      availableConnection.acquire()
      return availableConnection.sshClient!
    }

    // 检查是否达到最大连接数
    const activeCount = pool.filter((conn) => conn.inUse).length
    if (activeCount >= this.config.maxConnectionsPerNode) {
      connectorLogger.warn(`[连接池] 节点 ${nodeId} 连接池已满 (${activeCount}/${this.config.maxConnectionsPerNode})`)
      // 等待可用连接
      return await this.waitForAvailableConnection(nodeId, createConnection)
    }

    // 创建新连接
    connectorLogger.debug(`[连接池] 创建新连接: ${nodeId} (${activeCount + 1}/${this.config.maxConnectionsPerNode})`)
    const client = await createConnection()

    const connection = new SSHConnection(nodeId)
    connection.setClient(client)
    connection.acquire()

    pool.push(connection)
    return client
  }

  /**
   * 释放连接
   */
  release(nodeId: string, client: Client): void {
    if (!this.config.enabled) {
      client.end()
      return
    }

    const pool = this.pools.get(nodeId)
    if (!pool) return

    const connection = pool.find((conn) => conn.sshClient === client)
    if (connection) {
      connection.release()
      connectorLogger.debug(`[连接池] 释放连接: ${connection.id}`)
    }
  }

  /**
   * 等待可用连接
   */
  private async waitForAvailableConnection(
    nodeId: string,
    createConnection: () => Promise<Client>,
    maxWait = 5000
  ): Promise<Client> {
    const startTime = Date.now()

    while (Date.now() - startTime < maxWait) {
      const pool = this.pools.get(nodeId)
      if (!pool) break

      const availableConnection = pool.find(
        (conn) => !conn.inUse && conn.isHealthy && conn.sshClient
      )

      if (availableConnection) {
        availableConnection.acquire()
        return availableConnection.sshClient!
      }

      // 等待 100ms 后重试
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    // 超时后创建新连接
    connectorLogger.warn(`[连接池] 等待连接超时,创建新连接: ${nodeId}`)
    const client = await createConnection()

    const connection = new SSHConnection(nodeId)
    connection.setClient(client)
    connection.acquire()

    const pool = this.getOrCreatePool(nodeId)
    pool.push(connection)

    return client
  }

  /**
   * 获取或创建连接池
   */
  private getOrCreatePool(nodeId: string): SSHConnection[] {
    let pool = this.pools.get(nodeId)
    if (!pool) {
      pool = []
      this.pools.set(nodeId, pool)
    }
    return pool
  }

  /**
   * 清理空闲连接
   */
  private startCleanup(): void {
    if (!this.config.enabled) return

    this.cleanupTimer = setInterval(() => {
      this.cleanupIdleConnections()
    }, this.config.idleTimeout / 2) // 清理间隔为空闲超时的一半
  }

  /**
   * 清理空闲连接
   */
  private cleanupIdleConnections(): void {
    for (const [nodeId, pool] of this.pools.entries()) {
      const beforeCount = pool.length

      // 移除过期且未使用的连接
      const activePool = pool.filter(
        (conn) => !conn.isExpired(this.config.idleTimeout) || conn.inUse
      )

      // 关闭被移除的连接
      for (const conn of pool) {
        if (!activePool.includes(conn)) {
          conn.close().catch((e) => {
            connectorLogger.warn(`[连接池] 关闭连接失败: ${e.message}`)
          })
        }
      }

      this.pools.set(nodeId, activePool)

      const afterCount = activePool.length
      if (beforeCount !== afterCount) {
        connectorLogger.debug(`[连接池] 清理节点 ${nodeId}: ${beforeCount} -> ${afterCount}`)
      }
    }
  }

  /**
   * 启动健康检查
   */
  private startHealthCheck(): void {
    if (!this.config.enabled) return

    this.healthCheckTimer = setInterval(() => {
      this.healthCheck()
    }, this.config.healthCheckInterval)
  }

  /**
   * 健康检查
   */
  private async healthCheck(): Promise<void> {
    // TODO: 实现健康检查逻辑
    // 可以通过执行简单命令 (如 echo) 来检查连接是否健康
  }

  /**
   * 获取连接池统计信息
   */
  getStats(): {
    totalConnections: number
    activeConnections: number
    idleConnections: number
    maxConnectionsPerNode: number
    idleTimeout: number
    connections: Record<string, { total: number; active: number; idle: number }>
  } {
    let totalConnections = 0
    let activeConnections = 0
    let idleConnections = 0
    const connections: Record<string, { total: number; active: number; idle: number }> = {}

    for (const [nodeId, pool] of this.pools.entries()) {
      const active = pool.filter((conn) => conn.inUse).length
      const idle = pool.filter((conn) => !conn.inUse).length

      connections[nodeId] = {
        total: pool.length,
        active,
        idle,
      }

      totalConnections += pool.length
      activeConnections += active
      idleConnections += idle
    }

    return {
      totalConnections,
      activeConnections,
      idleConnections,
      maxConnectionsPerNode: this.config.maxConnectionsPerNode,
      idleTimeout: this.config.idleTimeout,
      connections,
    }
  }

  /**
   * 清空所有连接
   */
  async closeAll(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
    }

    for (const pool of this.pools.values()) {
      for (const conn of pool) {
        await conn.close()
      }
    }

    this.pools.clear()
    connectorLogger.info('[连接池] 所有连接已关闭')
  }

  /**
   * 清空指定节点的连接池
   */
  async clearNode(nodeId: string): Promise<void> {
    const pool = this.pools.get(nodeId)
    if (!pool) return

    for (const conn of pool) {
      await conn.close()
    }

    this.pools.delete(nodeId)
    connectorLogger.info(`[连接池] 节点 ${nodeId} 连接池已清空`)
  }
}
