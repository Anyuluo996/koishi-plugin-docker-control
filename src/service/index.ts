/**
 * Docker 服务主类
 * 管理所有 Docker 节点
 */
import { Context } from 'koishi'
import type { DockerEvent, DockerControlConfig, ContainerInfo } from '../types'
import { DockerNode } from './node'
import { logger } from '../utils/logger'

export class DockerService {
  /** Koishi Context */
  private readonly ctx: Context
  /** 节点映射 */
  private nodes: Map<string, DockerNode> = new Map()
  /** 配置 */
  private readonly config: DockerControlConfig

  constructor(ctx: Context, config: DockerControlConfig) {
    this.ctx = ctx
    this.config = config
  }

  /**
   * 初始化所有节点
   */
  async initialize(): Promise<void> {
    logger.info('初始化 Docker 服务...')

    const nodeConfigs = this.config.nodes || []
    const credentials = this.config.credentials || []

    for (const nodeConfig of nodeConfigs) {
      // 查找对应的凭证
      const credential = credentials.find(c => c.id === nodeConfig.credentialId)
      if (!credential) {
        logger.warn(`节点 ${nodeConfig.name} 找不到凭证 ${nodeConfig.credentialId}，跳过`)
        continue
      }

      const node = new DockerNode(nodeConfig, credential, this.config.debug)
      this.nodes.set(nodeConfig.id, node)
      logger.info(`节点已创建: ${nodeConfig.name} (${nodeConfig.id})`)
    }

    this.logNodeList()

    // 连接所有节点
    const promises: Promise<void>[] = []

    for (const node of this.nodes.values()) {
      promises.push(
        node.connect().catch((e) => {
          logger.warn(`节点 ${node.name} 连接失败: ${e}`)
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

    logger.info(`连接完成: ${online} 在线, ${offline} 离线`)
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
    logger.info('=== Docker 节点列表 ===')
    for (const node of this.nodes.values()) {
      const tags = node.tags.length > 0 ? ` [@${node.tags.join(' @')}]` : ''
      logger.info(`  - ${node.name} (${node.id})${tags}`)
    }
    logger.info('======================')
  }

  onNodeEvent(callback: (event: DockerEvent) => void): () => void {
    const unsubscribers: (() => void)[] = []

    for (const node of this.nodes.values()) {
      unsubscribers.push(node.onEvent(callback))
    }

    return () => {
      for (const unsub of unsubscribers) {
        unsub()
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const node of this.nodes.values()) {
      await node.dispose()
    }
    this.nodes.clear()
    logger.info('Docker 服务已停止')
  }
}
