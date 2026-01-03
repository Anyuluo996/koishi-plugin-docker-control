/**
 * Docker 节点类 - 通过 SSH 执行 docker 命令
 */
import type {
  NodeConfig,
  ContainerInfo,
  DockerEvent,
  NodeStatusType,
  CredentialConfig,
} from '../types'
import { NodeStatus, RETRY_INTERVAL, MAX_RETRY_COUNT } from '../constants'
import { DockerConnector } from './connector'
import { nodeLogger } from '../utils/logger'

// 容器事件类型映射
const CONTAINER_ACTIONS = ['start', 'stop', 'restart', 'die', 'create', 'destroy', 'pause', 'unpause', 'health_status']

export class DockerNode {
  /** 节点配置 */
  public readonly config: NodeConfig
  /** 节点状态 */
  public status: NodeStatusType = NodeStatus.DISCONNECTED
  /** SSH 连接器 */
  private connector: DockerConnector | null = null
  /** 监控定时器 (容器状态轮询) */
  private monitorTimer: NodeJS.Timeout | null = null
  /** 事件监控定时器 (docker events) */
  private eventTimer: NodeJS.Timeout | null = null
  /** 上次事件查询时间 */
  private lastEventTime: number = 0
  /** 上次容器状态快照 */
  private lastContainerStates: Map<string, string> = new Map()
  /** 事件回调 */
  private eventCallbacks: Set<(event: DockerEvent) => void> = new Set()
  /** Debug 模式 */
  private debug = false
  /** 凭证配置 */
  private credential: CredentialConfig

  constructor(config: NodeConfig, credential: CredentialConfig, debug = false) {
    this.config = config
    this.credential = credential
    this.debug = debug
  }

  /**
   * 连接到 Docker (带重试)
   */
  async connect(): Promise<void> {
    if (this.status === NodeStatus.CONNECTING) {
      nodeLogger.warn(`[${this.name}] 节点正在连接中，跳过`)
      return
    }

    this.status = NodeStatus.CONNECTING
    let attempt = 0
    let lastError: Error | null = null

    while (attempt < MAX_RETRY_COUNT) {
      attempt++
      nodeLogger.info(`[${this.name}] 连接尝试 ${attempt}/${MAX_RETRY_COUNT}...`)

      try {
        // 创建 connector
        const connector = new DockerConnector(this.config, { credentials: [this.credential], nodes: [this.config] } as any)
        this.connector = connector

        // 测试 SSH 连接和 docker 命令
        await connector.exec('docker version --format "{{.Server.Version}}"')

        this.status = NodeStatus.CONNECTED
        nodeLogger.info(`[${this.name}] 连接成功`)

        // 启动监控
        this.startMonitoring()

        // 触发上线事件
        this.emitEvent({
          Type: 'node',
          Action: 'online',
          Actor: { ID: this.config.id, Attributes: {} },
          scope: 'local',
          time: Date.now(),
          timeNano: Date.now() * 1e6,
        })

        return
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error))
        nodeLogger.warn(`[${this.name}] 连接失败: ${lastError.message}`)

        // 清理连接
        this.connector?.dispose()
        this.connector = null

        // 如果还有重试次数，等待后重试
        if (attempt < MAX_RETRY_COUNT) {
          await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL))
        }
      }
    }

    // 所有重试都失败
    this.status = NodeStatus.ERROR
    nodeLogger.error(`[${this.name}] 连接失败，已重试 ${MAX_RETRY_COUNT} 次`)
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    this.stopMonitoring()
    this.clearTimers()

    this.connector?.dispose()
    this.connector = null

    this.status = NodeStatus.DISCONNECTED
    nodeLogger.info(`[${this.name}] 已断开连接`)
  }

  /**
   * 重新连接
   */
  async reconnect(): Promise<void> {
    await this.disconnect()
    await this.connect()
  }

  /**
   * 列出容器
   */
  async listContainers(all = true): Promise<ContainerInfo[]> {
    if (!this.connector || this.status !== NodeStatus.CONNECTED) {
      throw new Error(`节点 ${this.name} 未连接`)
    }

    const output = await this.connector.listContainers(all)
    return this.parseContainerList(output)
  }

  /**
   * 启动容器
   */
  async startContainer(containerId: string): Promise<void> {
    if (!this.connector) throw new Error('未连接')
    await this.connector.startContainer(containerId)
  }

  /**
   * 停止容器
   */
  async stopContainer(containerId: string, timeout = 10): Promise<void> {
    if (!this.connector) throw new Error('未连接')
    await this.connector.stopContainer(containerId, timeout)
  }

  /**
   * 重启容器
   */
  async restartContainer(containerId: string, timeout = 10): Promise<void> {
    if (!this.connector) throw new Error('未连接')
    await this.connector.restartContainer(containerId, timeout)
  }

  /**
   * 获取容器日志
   */
  async getContainerLogs(containerId: string, tail = 100): Promise<string> {
    if (!this.connector) throw new Error('未连接')
    return this.connector.getLogs(containerId, tail)
  }

  /**
   * 执行容器内命令
   */
  async execContainer(containerId: string, cmd: string): Promise<string> {
    if (!this.connector) throw new Error('未连接')
    return this.connector.execContainer(containerId, cmd)
  }

  /**
   * 解析 docker ps 输出
   */
  private parseContainerList(output: string): ContainerInfo[] {
    if (!output.trim()) return []

    return output.split('\n').filter(Boolean).map(line => {
      const parts = line.split('|')
      return {
        Id: parts[0] || '',
        Names: [parts[1] || ''],
        Image: parts[2] || '',
        State: this.mapState(parts[3] || ''),
        Status: parts[4] || '',
        ImageID: '',
        Command: '',
        Created: 0,
        Ports: [],
        Labels: {},
        HostConfig: { NetworkMode: '' },
        NetworkSettings: { Networks: {} },
      }
    })
  }

  /**
   * 映射容器状态
   */
  private mapState(state: string): 'running' | 'stopped' | 'paused' | 'restarting' | 'created' {
    const s = state.toLowerCase()
    if (s.includes('up') || s.includes('running')) return 'running'
    if (s.includes('exited') || s.includes('stopped')) return 'stopped'
    if (s.includes('paused')) return 'paused'
    if (s.includes('restarting')) return 'restarting'
    return 'created'
  }

  /**
   * 启动监控 (容器状态轮询 + 事件监听)
   */
  private startMonitoring(): void {
    this.stopMonitoring()

    // 初始化容器状态快照
    this.initializeContainerStates()

    // 事件监控：每 5 秒查询 docker events
    this.eventTimer = setInterval(async () => {
      if (this.status !== NodeStatus.CONNECTED) return
      await this.pollEvents()
    }, 5000)

    // 状态监控：每 30 秒检查容器状态作为备用
    this.monitorTimer = setInterval(async () => {
      if (this.status !== NodeStatus.CONNECTED) return

      try {
        const containers = await this.listContainers(false)
        const runningCount = containers.filter(c => c.State === 'running').length

        nodeLogger.debug(`[${this.name}] 监控: ${runningCount} 个容器运行中`)
      } catch (e) {
        nodeLogger.warn(`[${this.name}] 监控失败: ${e}`)
      }
    }, 30000)

    nodeLogger.info(`[${this.name}] 监控已启动`)
  }

  /**
   * 初始化容器状态快照
   */
  private async initializeContainerStates(): Promise<void> {
    try {
      const containers = await this.listContainers(true)
      this.lastContainerStates.clear()
      for (const c of containers) {
        this.lastContainerStates.set(c.Id, c.State)
      }
      this.lastEventTime = Date.now()
      nodeLogger.debug(`[${this.name}] 初始化状态快照: ${this.lastContainerStates.size} 个容器`)
    } catch (e) {
      nodeLogger.warn(`[${this.name}] 初始化状态快照失败: ${e}`)
    }
  }

  /**
   * 轮询 Docker 事件
   */
  private async pollEvents(): Promise<void> {
    if (!this.connector) return

    try {
      // 查询指定时间之后的事件
      const since = new Date(this.lastEventTime).toISOString()
      const output = await this.connector.exec(`docker events --since "${since}" --format "{{.Type}}|{{.Action}}|{{.Actor.ID}}|{{.Actor.Attributes.name}}|{{.Actor.Attributes.image}}|{{.time}}" --filter "type=container"`)

      this.lastEventTime = Date.now()

      if (!output.trim()) return

      const lines = output.split('\n').filter(Boolean)
      for (const line of lines) {
        const parts = line.split('|')
        if (parts.length < 6) continue

        const [type, action, actorId, containerName, image, timeStr] = parts

        // 只处理容器相关事件
        if (type !== 'container') continue
        if (!CONTAINER_ACTIONS.includes(action)) continue

        // 跳过无法识别名称的容器
        if (!containerName || containerName === 'unknown') continue

        const event: DockerEvent = {
          Type: type,
          Action: action,
          Actor: {
            ID: actorId,
            Attributes: {
              name: containerName,
              image: image || '',
            },
          },
          scope: 'local',
          time: parseInt(timeStr) || Date.now(),
          timeNano: (parseInt(timeStr) || Date.now()) * 1e6,
        }

        nodeLogger.debug(`[${this.name}] 事件: ${containerName} ${action}`)
        this.emitEvent(event)
      }
    } catch (e) {
      // 忽略事件查询错误（可能是没有新事件）
      nodeLogger.warn(`[${this.name}] 事件轮询失败: ${e}`)
    }
  }

  /**
   * 停止监控
   */
  private stopMonitoring(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer)
      this.monitorTimer = null
    }
    if (this.eventTimer) {
      clearInterval(this.eventTimer)
      this.eventTimer = null
    }
  }

  /**
   * 订阅事件
   */
  onEvent(callback: (event: DockerEvent) => void): () => void {
    this.eventCallbacks.add(callback)
    return () => this.eventCallbacks.delete(callback)
  }

  /**
   * 触发事件
   */
  private emitEvent(event: DockerEvent): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(event)
      } catch (e) {
        nodeLogger.error(`[${this.name}] 事件回调错误: ${e}`)
      }
    }
  }

  /**
   * 清理定时器
   */
  private clearTimers(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer)
      this.monitorTimer = null
    }
    if (this.eventTimer) {
      clearInterval(this.eventTimer)
      this.eventTimer = null
    }
  }

  /**
   * 销毁节点
   */
  async dispose(): Promise<void> {
    await this.disconnect()
    this.eventCallbacks.clear()
  }

  get name(): string { return this.config.name }
  get id(): string { return this.config.id }
  get tags(): string[] { return this.config.tags }
}
