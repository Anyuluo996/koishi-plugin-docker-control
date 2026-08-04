/**
 * Docker 服务主类
 * 管理所有 Docker 节点
 */
import { Context } from 'koishi'
import type { DockerEvent, DockerControlConfig, ContainerInfo, NodeConfig } from '../types'
import { DockerNode } from './node'
import { logger } from '../utils/logger'
import { PermissionManager } from './permission-manager'
import { AuditLogger } from './audit-logger'
import { ReconnectManager } from './reconnect-manager'

export class DockerService {
  /** Koishi Context */
  private readonly ctx: Context
  /** 节点映射 */
  private nodes: Map<string, DockerNode> = new Map()
  /** 配置 */
  private readonly config: DockerControlConfig
  /** 全局事件回调集合 - 事件中转站 */
  private eventCallbacks: Set<(event: DockerEvent, nodeId: string) => void> = new Set()

  // v0.1.0 新增服务实例
  public permissionManager?: PermissionManager
  public auditLogger?: AuditLogger
  public reconnectManager?: ReconnectManager

  constructor(ctx: Context, config: DockerControlConfig) {
    this.ctx = ctx
    this.config = config
  }

  /**
   * 清理节点配置
   */
  private cleanNodeConfig(nodeConfig: NodeConfig): NodeConfig {
    // 创建配置副本以避免修改原始配置
    const cleaned = { ...nodeConfig }

    // 验证并清理端口
    if (typeof cleaned.port === 'string') {
      const portStr = cleaned.port as string
      if (portStr.includes('.') || portStr.includes(':')) {
        logger.warn(`节点 ${cleaned.name} 检测到异常端口配置: "${portStr}"，已自动修正为 22`)
        ;(cleaned as any).port = 22
      } else {
        const parsed = parseInt(portStr, 10)
        if (!isNaN(parsed) && parsed >= 1 && parsed <= 65535) {
          ;(cleaned as any).port = parsed
        } else {
          logger.error(`节点 ${cleaned.name} 端口值无效: "${portStr}"，已自动修正为 22`)
          ;(cleaned as any).port = 22
        }
      }
    } else if (typeof cleaned.port !== 'number' || cleaned.port < 1 || cleaned.port > 65535) {
      logger.error(`节点 ${cleaned.name} 端口类型或值异常: ${cleaned.port}，已自动修正为 22`)
      ;(cleaned as any).port = 22
    }

    return cleaned
  }

  /**
   * 初始化所有节点
   */
  async initialize(): Promise<void> {
    logger.debug('初始化 Docker 服务...')

    const nodeConfigs = this.config.nodes || []
    const credentials = this.config.credentials || []

    for (const nodeConfig of nodeConfigs) {
      // 查找对应的凭证
      const credential = credentials.find(c => c.id === nodeConfig.credentialId)
      if (!credential) {
        logger.warn(`节点 ${nodeConfig.name} 找不到凭证 ${nodeConfig.credentialId}，跳过`)
        continue
      }

      // 清理和验证端口配置
      const cleanedNodeConfig = this.cleanNodeConfig(nodeConfig)

      const node = new DockerNode(this.ctx, cleanedNodeConfig, credential, this.config.debug)

      // 【关键修复】创建节点时，立即绑定事件转发
      // 无论 index.ts 何时调用 onNodeEvent，这里都会把事件转发给 eventCallbacks
      node.onEvent((event) => {
        this.dispatchGlobalEvent(event, node.id)
      })

      this.nodes.set(nodeConfig.id, node)
      logger.debug(`节点已创建: ${nodeConfig.name} (${nodeConfig.id})`)
    }

    this.logNodeList()

    // 连接所有节点
    const promises: Promise<void>[] = []

    for (const node of this.nodes.values()) {
      promises.push(
        node.connect().catch((e) => {
          logger.warn(`节点 ${node.name} 连接失败: ${e}`)
          // 如果连接失败且启用了自动重连，开始重连
          if (this.reconnectManager) {
            this.handleNodeDisconnection(node)
          }
        })
      )
    }

    await Promise.allSettled(promises)

    const online = [...this.nodes.values()].filter(
      (n) => n.status === 'connected'
    ).length
    const offline = [...this.nodes.values()].filter(
      (n) => n.status === 'error' || n.status === 'disconnected'
    ).length

    logger.info(`✅ 连接完成: ${online} 在线, ${offline} 离线`)

    // v0.1.0 新增: 为所有节点设置断线监听
    this.setupReconnectHandlers()
  }

  /**
   * 设置自动重连处理器
   */
  private setupReconnectHandlers(): void {
    if (!this.reconnectManager) {
      logger.debug('自动重连未启用，跳过重连处理器设置')
      return
    }

    logger.debug('设置节点自动重连监听器...')

    // 监听所有节点的事件
    for (const node of this.nodes.values()) {
      node.onEvent((event) => {
        // 监听节点离线事件
        if (event.Type === 'node' && event.Action === 'offline') {
          logger.warn(`节点 ${node.name} (${node.id}) 已离线，触发自动重连`)
          this.handleNodeDisconnection(node)
        }
      })
    }
  }

  /**
   * 处理节点断线连接
   */
  private async handleNodeDisconnection(node: DockerNode): Promise<void> {
    if (!this.reconnectManager) return

    try {
      logger.debug(`开始重连节点 ${node.name}...`)
      await this.reconnectManager.reconnect(node)
      logger.info(`✅ 节点 ${node.name} 重连成功`)
    } catch (e) {
      logger.error(`节点 ${node.name} 重连失败: ${e.message}`)
    }
  }

  /**
   * 【新增】内部方法：分发全局事件
   * 将节点事件转发给所有注册的全局回调
   */
  private dispatchGlobalEvent(event: DockerEvent, nodeId: string) {
    for (const callback of this.eventCallbacks) {
      try {
        callback(event, nodeId)
      } catch (e) {
        logger.error(`事件回调执行错误: ${e}`)
      }
    }
  }

  getNode(id: string): DockerNode | undefined {
    return this.nodes.get(id)
  }

  getNodeByName(name: string): DockerNode | undefined {
    return [...this.nodes.values()].find((n) => n.name === name)
  }

  getNodesByTag(tag: string): DockerNode[] {
    return [...this.nodes.values()].filter((n) => n.tags.includes(tag))
  }

  getNodesBySelector(selector: string): DockerNode[] {
    if (selector === 'all' || !selector) {
      return [...this.nodes.values()]
    }

    if (selector.startsWith('@')) {
      const tag = selector.slice(1)
      return this.getNodesByTag(tag)
    }

    const node = this.getNode(selector) || this.getNodeByName(selector)
    return node ? [node] : []
  }

  getAllNodes(): DockerNode[] {
    return [...this.nodes.values()]
  }

  getOnlineNodes(): DockerNode[] {
    return [...this.nodes.values()].filter((n) => n.status === 'connected')
  }

  getOfflineNodes(): DockerNode[] {
    return [...this.nodes.values()].filter(
      (n) => n.status === 'error' || n.status === 'disconnected'
    )
  }

  /**
   * 搜索容器
   */
  async findContainer(
    nodeId: string,
    containerIdOrName: string
  ): Promise<{ node: DockerNode; container: ContainerInfo }> {
    const node = this.getNode(nodeId)
    if (!node) {
      throw new Error(`节点不存在: ${nodeId}`)
    }

    const containers = await node.listContainers(true)

    let container = containers.find((c) => c.Id.startsWith(containerIdOrName))

    if (!container) {
      container = containers.find((c) =>
        c.Names.some((n) => n.replace('/', '') === containerIdOrName)
      )
    }

    if (!container) {
      container = containers.find((c) =>
        c.Names.some((n) => n.includes(containerIdOrName))
      )
    }

    if (!container) {
      throw new Error(`找不到容器: ${containerIdOrName}`)
    }

    return { node, container }
  }

  /**
   * 在所有节点上搜索容器
   */
  async findContainerGlobal(
    containerIdOrName: string
  ): Promise<Array<{ node: DockerNode; container: ContainerInfo }>> {
    const results: Array<{ node: DockerNode; container: ContainerInfo }> = []

    for (const node of this.getOnlineNodes()) {
      try {
        const containers = await node.listContainers(true)
        let container = containers.find((c) =>
          c.Id.startsWith(containerIdOrName)
        )

        if (!container) {
          container = containers.find((c) =>
            c.Names.some((n) => n.replace('/', '') === containerIdOrName)
          )
        }

        if (container) {
          results.push({ node, container })
        }
      } catch (e) {
        logger.warn(`[${node.name}] 搜索容器失败: ${e}`)
      }
    }

    return results
  }

  /**
   * 批量操作容器
   */
  async operateContainers(
    nodeSelector: string,
    containerSelector: string,
    operation: 'start' | 'stop' | 'restart'
  ): Promise<Array<{ node: DockerNode; container: ContainerInfo; success: boolean; error?: string }>> {
    const nodes = this.getNodesBySelector(nodeSelector)
    const results: Array<{
      node: DockerNode
      container: ContainerInfo
      success: boolean
      error?: string
    }> = []

    for (const node of nodes) {
      if (node.status !== 'connected') {
        continue
      }

      try {
        const { container } = await this.findContainer(node.id, containerSelector)

        switch (operation) {
          case 'start':
            await node.startContainer(container.Id)
            break
          case 'stop':
            await node.stopContainer(container.Id)
            break
          case 'restart':
            await node.restartContainer(container.Id)
            break
        }

        results.push({ node, container, success: true })
      } catch (e: any) {
        results.push({
          node,
          container: { Id: '', Names: [], State: 'stopped' } as ContainerInfo,
          success: false,
          error: e.message,
        })
      }
    }

    return results
  }

  private logNodeList(): void {
    logger.debug('=== Docker 节点列表 ===')
    for (const node of this.nodes.values()) {
      const tags = node.tags.length > 0 ? ` [@${node.tags.join(' @')}]` : ''
      logger.debug(`  - ${node.name} (${node.id})${tags}`)
    }
    logger.debug('======================')
  }

  /**
   * 【关键修复】注册全局事件监听
   * 不再遍历节点，而是添加到全局回调列表
   * 无论节点何时创建，事件都能通过 dispatchGlobalEvent 转发
   */
  onNodeEvent(callback: (event: DockerEvent, nodeId: string) => void): () => void {
    this.eventCallbacks.add(callback)

    // 返回取消订阅函数
    return () => {
      this.eventCallbacks.delete(callback)
    }
  }

  /**
   * 移除节点并彻底清理相关资源
   * - 断开 SSH 连接、停止监控、清理事件回调
   * - 取消该节点在 ReconnectManager 中的重连
   * - 清空该节点在连接池中的所有连接
   * - 通知 monitor 清理该节点的状态
   *
   * 返回 true 表示节点存在并已移除；false 表示节点不存在
   */
  async removeNode(nodeId: string): Promise<boolean> {
    const node = this.nodes.get(nodeId)
    if (!node) {
      logger.debug(`removeNode: 节点 ${nodeId} 不存在，跳过`)
      return false
    }

    logger.info(`移除节点 ${node.name} (${nodeId})，清理所有相关资源...`)

    // 1. 取消该节点在 ReconnectManager 中的重连/重试
    if (this.reconnectManager) {
      try {
        this.reconnectManager.cancel(nodeId)
      } catch (e) {
        logger.warn(`取消节点 ${nodeId} 重连时出错: ${(e as Error).message}`)
      }
    }

    // 2. 释放在连接池中该节点的连接（如果有连接池使用的话）
    // 注意：当前连接池的使用点在 connector 中通过私有方法管理，
    // 这一步主要清空内部缓存池中残留的连接对象
    try {
      const pool: any = (this as any).connectionPool
      if (pool && typeof pool.clearNode === 'function') {
        await pool.clearNode(nodeId)
      }
    } catch (e) {
      logger.warn(`清空节点 ${nodeId} 连接池时出错: ${(e as Error).message}`)
    }

    // 3. 断开节点（内部会 stopMonitoring、关闭 SSH、清理 dockerode）
    try {
      await node.dispose()
    } catch (e) {
      logger.warn(`断开节点 ${nodeId} 时出错: ${(e as Error).message}`)
    }

    // 4. 从 Map 中移除节点引用
    this.nodes.delete(nodeId)

    // 5. 通知 monitor 清理该节点的状态
    try {
      const monitor: any = (this as any).monitorManager
      if (monitor && typeof monitor.removeNodeStates === 'function') {
        monitor.removeNodeStates(nodeId)
      }
    } catch (e) {
      logger.warn(`清理节点 ${nodeId} 监控状态时出错: ${(e as Error).message}`)
    }

    logger.info(`✅ 节点 ${node.name} (${nodeId}) 已移除`)
    return true
  }

  /**
   * 同步当前配置与已加载节点，移除配置中已不存在的节点
   * @param newNodeConfigs 最新的节点配置列表
   * @returns 被移除的节点 ID 列表
   */
  async syncNodesWithConfig(newNodeConfigs: NodeConfig[]): Promise<string[]> {
    const newIds = new Set(newNodeConfigs.map(n => n.id))
    const removedIds: string[] = []

    for (const existingId of [...this.nodes.keys()]) {
      if (!newIds.has(existingId)) {
        removedIds.push(existingId)
      }
    }

    for (const id of removedIds) {
      await this.removeNode(id)
    }

    if (removedIds.length > 0) {
      logger.info(`配置同步完成，已移除 ${removedIds.length} 个节点: ${removedIds.join(', ')}`)
    }

    return removedIds
  }

  async stopAll(): Promise<void> {
    for (const node of this.nodes.values()) {
      await node.dispose()
    }
    this.nodes.clear()
    this.eventCallbacks.clear()
    logger.debug('Docker 服务已停止')
  }

  /**
   * 获取所有在线节点的容器聚合
   */
  async getAggregatedContainers(all = true): Promise<Array<{ node: DockerNode; containers: ContainerInfo[] }>> {
    const results: Array<{ node: DockerNode; containers: ContainerInfo[] }> = []

    for (const node of this.getOnlineNodes()) {
      try {
        const containers = await node.listContainers(all)
        results.push({ node, containers })
      } catch (e) {
        logger.warn(`[${node.name}] 获取容器列表失败: ${e}`)
        results.push({ node, containers: [] })
      }
    }

    return results
  }
}
