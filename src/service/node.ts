/**
 * Docker 节点类 - 通过 SSH 执行 docker 命令
 */
import { Random } from 'koishi'
import type {
  NodeConfig,
  ContainerInfo,
  DockerEvent,
  NodeStatusType,
  CredentialConfig,
  ComposeFileInfo,
  ContainerComposeInfo,
} from '../types'
import { NodeStatus, RETRY_INTERVAL, MAX_RETRY_COUNT, EVENTS_POLL_INTERVAL, CONTAINER_POLL_INTERVAL } from '../constants'
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
  /** 用于事件去重: 记录 "ID:Action:Time" -> Timestamp */
  private eventDedupMap: Map<string, number> = new Map()
  /** [新增] 实例唯一标识，用于判断是否存在多实例冲突 */
  private instanceId = Random.id(4)

  constructor(config: NodeConfig, credential: CredentialConfig, debug = false) {
    this.config = config
    this.credential = credential
    this.debug = debug
  }

  /**
   * 连接到 Docker (带重试)
   * 前 3 次失败后每 1 分钟重试一次，直到成功
   */
  async connect(): Promise<void> {
    if (this.status === NodeStatus.CONNECTING) {
      nodeLogger.warn(`[${this.name}] 节点正在连接中，跳过`)
      return
    }

    this.status = NodeStatus.CONNECTING
    let attempt = 0
    const MAX_INITIAL_ATTEMPTS = 3  // 前 3 次快速重试
    const LONG_RETRY_INTERVAL = 60000  // 1 分钟

    while (true) {
      attempt++
      const isInitialAttempts = attempt <= MAX_INITIAL_ATTEMPTS
      const currentInterval = isInitialAttempts ? RETRY_INTERVAL : LONG_RETRY_INTERVAL

      if (isInitialAttempts) {
        nodeLogger.info(`[${this.name}] 连接尝试 ${attempt}/${MAX_INITIAL_ATTEMPTS}...`)
      } else {
        nodeLogger.info(`[${this.name}] 连接尝试 ${attempt} (每 ${LONG_RETRY_INTERVAL / 1000} 秒重试)...`)
      }

      try {
        // 创建 connector
        const connector = new DockerConnector(this.config, { credentials: [this.credential], nodes: [this.config] } as any)
        this.connector = connector

        // 测试 SSH 连接和 docker 命令
        await connector.exec('docker version --format "{{.Server.Version}}"')

        // 标记连接可用，允许事件流自动重连
        connector.setConnected(true)

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
        const lastError = error instanceof Error ? error : new Error(String(error))
        nodeLogger.warn(`[${this.name}] 连接失败: ${lastError.message}`)

        // 清理连接
        this.connector?.dispose()
        this.connector = null

        // 等待后重试
        nodeLogger.info(`[${this.name}] ${currentInterval / 1000} 秒后重试...`)
        await new Promise(resolve => setTimeout(resolve, currentInterval))
      }
    }
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
  async execContainer(containerId: string, cmd: string): Promise<{ output: string; exitCode: number }> {
    if (!this.connector) throw new Error('未连接')
    return this.connector.execContainer(containerId, cmd)
  }

  /**
   * 获取 Docker 版本信息
   */
  async getVersion(): Promise<{ Version: string; ApiVersion: string; Os: string; Arch: string; KernelVersion: string }> {
    if (!this.connector) throw new Error('未连接')
    const output = await this.connector.exec('docker version --format "{{json .Server}}"')
    const info = JSON.parse(output)
    return {
      Version: info.Version || 'unknown',
      ApiVersion: info.ApiVersion || 'unknown',
      Os: info.Os || 'unknown',
      Arch: info.Arch || 'unknown',
      KernelVersion: info.KernelVersion || 'unknown',
    }
  }

  /**
   * 获取系统信息 (CPU、内存)
   */
  async getSystemInfo(): Promise<{ NCPU: number; MemTotal: number; MemAvailable?: number } | null> {
    if (!this.connector) return null
    try {
      // 使用 execWithExitCode 避免非零退出码抛出异常
      const result = await this.connector.execWithExitCode('docker info --format "{{.NCPU}} {{.MemTotal}} {{.MemAvailable}}"')
      nodeLogger.debug(`[${this.name}] docker info 输出: "${result.output}", 退出码: ${result.exitCode}`)
      // docker info 可能返回退出码 1 但仍有输出（权限问题），只要有输出就解析
      if (!result.output.trim()) {
        nodeLogger.warn(`[${this.name}] docker info 输出为空`)
        return null
      }
      const parts = result.output.trim().split(/\s+/)
      if (parts.length >= 2) {
        return {
          NCPU: parseInt(parts[0]) || 0,
          MemTotal: parseInt(parts[1]) || 0,
          MemAvailable: parts[2] ? parseInt(parts[2]) : undefined,
        }
      }
      return null
    } catch (e) {
      nodeLogger.warn(`[${this.name}] 获取系统信息异常: ${e}`)
      return null
    }
  }

  /**
   * 获取容器数量
   */
  async getContainerCount(): Promise<{ running: number; total: number }> {
    if (!this.connector) throw new Error('未连接')
    try {
      const running = await this.connector.exec('docker ps -q | wc -l')
      const total = await this.connector.exec('docker ps -aq | wc -l')
      return {
        running: parseInt(running.trim()) || 0,
        total: parseInt(total.trim()) || 0,
      }
    } catch {
      return { running: 0, total: 0 }
    }
  }

  /**
   * 获取镜像数量
   */
  async getImageCount(): Promise<number> {
    if (!this.connector) throw new Error('未连接')
    try {
      const output = await this.connector.exec('docker images -q | wc -l')
      return parseInt(output.trim()) || 0
    } catch {
      return 0
    }
  }

  /**
   * 获取容器的 Docker Compose 信息
   * 通过标签 com.docker.compose.project.config_files 获取 compose 文件路径
   */
  async getContainerComposeInfo(containerId: string): Promise<ContainerComposeInfo | null> {
    if (!this.connector) throw new Error('未连接')

    try {
      // 使用 docker inspect 获取容器标签
      const output = await this.connector.exec(`docker inspect ${containerId} --format "{{json .Config.Labels}}"`)
      if (!output.trim()) {
        return null
      }

      const labels = JSON.parse(output) as Record<string, string>

      // 获取 compose 项目名称和配置文件路径
      const projectName = labels['com.docker.compose.project'] || ''
      const configFiles = labels['com.docker.compose.project.config_files'] || ''

      if (!projectName || !configFiles) {
        return null
      }

      return {
        containerId,
        containerName: labels['com.docker.compose.container-number'] || '',
        projectName,
        composeFilePath: configFiles,
      }
    } catch (e) {
      nodeLogger.warn(`[${this.name}] 获取容器 ${containerId} 的 compose 信息失败: ${e}`)
      return null
    }
  }

  /**
   * 获取容器的 Docker Compose 文件信息
   * 读取并解析 compose 文件
   */
  async getComposeFileInfo(containerId: string): Promise<ComposeFileInfo | null> {
    if (!this.connector) throw new Error('未连接')

    try {
      const composeInfo = await this.getContainerComposeInfo(containerId)
      if (!composeInfo) {
        return null
      }

      const filePath = composeInfo.composeFilePath
      const originalPath = filePath

      // 尝试读取文件 (支持 Windows 路径自动转换)
      const content = await this.connector.readFile(filePath)

      // 统计服务数量 (简单的 yaml 解析)
      const serviceCount = this.countServices(content)

      return {
        originalPath,
        effectivePath: filePath,
        usedWslPath: false, // 实际是否使用了 WSL 路径在内部处理
        content,
        projectName: composeInfo.projectName,
        serviceCount,
      }
    } catch (e: any) {
      nodeLogger.warn(`[${this.name}] 获取 compose 文件信息失败: ${e.message}`)
      return null
    }
  }

  /**
   * 统计 compose 文件中的服务数量
   */
  private countServices(content: string): number {
    // 简单的正则匹配 services: 下面的服务名
    const servicePattern = /^[a-zA-Z0-9_-]+:\s*$/gm
    const matches = content.match(servicePattern)
    return matches ? matches.length : 0
  }

  /**
   * 获取容器详细信息 (docker inspect)
   */
  async getContainer(containerId: string): Promise<any> {
    if (!this.connector) throw new Error('未连接')
    const output = await this.connector.exec(`docker inspect ${containerId}`)
    const info = JSON.parse(output)
    return Array.isArray(info) ? info[0] : info
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
   * 启动监控 (容器状态轮询 + 事件流监听)
   */
  private startMonitoring(): void {
    this.stopMonitoring()

    // 初始化容器状态快照
    this.initializeContainerStates()

    // 事件流监听：使用 docker events 流式获取
    this.startEventStream()

    // 状态监控：每 60 秒检查容器状态并检测变更
    // (用于捕获可能遗漏的状态变化，以及启动时的初始状态)
    this.monitorTimer = setInterval(async () => {
      if (this.status !== NodeStatus.CONNECTED) return

      try {
        const containers = await this.listContainers(true)
        this.checkContainerStateChanges(containers)
      } catch (e) {
        nodeLogger.warn(`[${this.name}] 监控失败: ${e}`)
      }
    }, CONTAINER_POLL_INTERVAL)

    nodeLogger.info(`[${this.name}] 监控已启动 (事件流 + 每 ${CONTAINER_POLL_INTERVAL / 1000} 秒状态检查)`)
  }

  /**
   * 启动 Docker 事件流监听
   */
  private startEventStream(): void {
    if (!this.connector) return

    // 防止并发启动：使用 _startingStream 标志
    if ((this as any)._startingStream) {
      nodeLogger.debug(`[${this.name}] 事件流正在启动中，跳过`)
      return
    }
    ;(this as any)._startingStream = true

    // 检查是否已有活跃的流
    if ((this as any)._activeStreamCount > 0) {
      nodeLogger.debug(`[${this.name}] 已有 ${(this as any)._activeStreamCount} 个活跃事件流，跳过启动`)
      ;(this as any)._startingStream = false
      return
    }

    ;(this as any)._activeStreamCount = (this as any)._activeStreamCount || 0
    ;(this as any)._activeStreamCount++

    nodeLogger.debug(`[${this.name}] 启动事件流 (活跃数: ${(this as any)._activeStreamCount})`)

    this.connector.startEventStream((line) => {
      this.handleEventLine(line)
    }).then((stop) => {
      ;(this as any)._eventStreamStop = stop
      ;(this as any)._startingStream = false
      nodeLogger.debug(`[${this.name}] 事件流回调已注册`)
    }).catch((err) => {
      ;(this as any)._activeStreamCount--
      ;(this as any)._startingStream = false
      nodeLogger.warn(`[${this.name}] 事件流启动失败: ${err.message}，5秒后重试`)
      setTimeout(() => this.startEventStream(), 5000)
    })
  }

  /**
   * 处理事件流中的一行数据
   */
  private handleEventLine(line: string): void {
    try {
      const rawEvent = JSON.parse(line)
      const { Type: type, Action: action, Actor: actor, time, timeNano } = rawEvent

      // 只处理容器相关事件
      if (type !== 'container') return
      if (!CONTAINER_ACTIONS.includes(action)) return

      const containerId = actor?.ID
      const containerName = actor?.Attributes?.name

      // [去重逻辑] 使用 timeNano (纳秒) 确保唯一性
      const eventTimeNano = timeNano || (time ? time * 1e9 : Date.now() * 1e6)
      const dedupKey = `${containerId}:${action}:${eventTimeNano}`
      const lastTime = this.eventDedupMap.get(dedupKey)
      const now = Date.now()

      // 100ms 内收到完全相同的事件则忽略
      if (lastTime && (now - lastTime < 100)) {
        return
      }
      this.eventDedupMap.set(dedupKey, now)

      // 清理
      if (this.eventDedupMap.size > 200) this.eventDedupMap.clear()

      // 跳过无法识别名称的容器
      if (!containerName || containerName === 'unknown') return

      const image = actor?.Attributes?.image

      // [关键] 对于 die 和 stop，都标记为 stopped，保持状态同步
      if (actor?.ID) {
        const inferredState = (action === 'start' || action === 'restart') ? 'running' : 'stopped'
        this.lastContainerStates.set(actor.ID, inferredState)
      }

      const event: DockerEvent = {
        Type: type,
        Action: action,
        Actor: {
          ID: actor?.ID || '',
          Attributes: {
            name: containerName,
            image: image || '',
          },
        },
        scope: 'local',
        time: time ? time * 1000 : Date.now(),
        timeNano: timeNano || Date.now() * 1e6,
      }

      nodeLogger.debug(`[${this.name}#${this.instanceId}] 事件流: ${containerName} ${action}`)
      this.emitEvent(event)
    } catch (e) {
      // 忽略非 JSON 行
    }
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
   * 检测容器状态变更并发送通知
   */
  private checkContainerStateChanges(containers: ContainerInfo[]): void {
    const runningCount = containers.filter(c => c.State === 'running').length
    nodeLogger.debug(`[${this.name}] 监控: ${runningCount} 个容器运行中`)

    for (const c of containers) {
      const lastState = this.lastContainerStates.get(c.Id)
      const currentState = c.State

      // 状态发生变化
      if (lastState !== undefined && lastState !== currentState) {
        const containerName = c.Names[0]?.replace('/', '') || c.Id.slice(0, 8)

        // 推断操作类型
        let action: string
        if (lastState !== 'running' && currentState === 'running') {
          action = 'start'
        } else if (lastState === 'running' && currentState !== 'running') {
          action = 'stop'
        } else {
          action = currentState
        }

        nodeLogger.info(`[${this.name}] 状态变更: ${containerName} ${lastState} -> ${currentState}`)

        // 发送事件通知
        const event: DockerEvent = {
          Type: 'container',
          Action: action,
          Actor: {
            ID: c.Id,
            Attributes: {
              name: containerName,
              image: c.Image,
            },
          },
          scope: 'local',
          time: Date.now(),
          timeNano: Date.now() * 1e6,
        }

        this.emitEvent(event)
      }

      // 更新状态快照
      this.lastContainerStates.set(c.Id, currentState)
    }
  }

  /**
   * 轮询 Docker 事件
   */
  private async pollEvents(): Promise<void> {
    if (!this.connector) return

    try {
      // 查询指定时间之后的事件
      // 查询指定时间之后的事件 - 使用 JSON 格式以避免解析问题
      const since = new Date(this.lastEventTime).toISOString()
      const output = await this.connector.exec(`docker events --since "${since}" --format "{{json .}}" --filter "type=container"`)

      this.lastEventTime = Date.now()

      if (!output.trim()) return

      const lines = output.split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const rawEvent = JSON.parse(line)
          const { Type: type, Action: action, Actor: actor, time, timeNano } = rawEvent

          // 只处理容器相关事件
          if (type !== 'container') continue
          if (!CONTAINER_ACTIONS.includes(action)) continue

          const containerName = actor?.Attributes?.name
          const image = actor?.Attributes?.image

          // 跳过无法识别名称的容器
          if (!containerName || containerName === 'unknown') continue

          const event: DockerEvent = {
            Type: type,
            Action: action,
            Actor: {
              ID: actor?.ID || '',
              Attributes: {
                name: containerName,
                image: image || '',
              },
            },
            scope: 'local',
            time: time ? time * 1000 : Date.now(), // docker event time is usually unix timestamp (seconds)
            timeNano: timeNano || Date.now() * 1e6,
          }

          nodeLogger.debug(`[${this.name}] 事件: ${containerName} ${action}`)
          this.emitEvent(event)
        } catch (e) {
          nodeLogger.warn(`[${this.name}] 解析事件失败: ${e} (Line: ${line})`)
        }
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
    // 停止状态轮询
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer)
      this.monitorTimer = null
    }
    // 停止事件流
    if ((this as any)._eventStreamStop) {
      ;(this as any)._eventStreamStop()
      ;(this as any)._eventStreamStop = null
    }
    // 重置事件流计数
    ;(this as any)._activeStreamCount = 0
    // 重置启动标志
    ;(this as any)._startingStream = false
    // 停止重试定时器
    if (this.eventTimer) {
      clearTimeout(this.eventTimer)
      this.eventTimer = null
    }
    // 标记连接断开，防止自动重连
    if (this.connector) {
      this.connector.setConnected(false)
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
