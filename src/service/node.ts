/**
 * Docker 节点类 - 通过 SSH 执行 docker 命令
 */
import { Random, Context } from 'koishi'
import Dockerode, { DockerOptions, NetworkInspectInfo, ContainerInspectInfo } from 'dockerode'
import http from 'http'
import { Client as SshClient } from 'ssh2'
import type {
  NodeConfig,
  ContainerInfo,
  DockerEvent,
  NodeStatusType,
  CredentialConfig,
  ComposeFileInfo,
  ContainerComposeInfo,
} from '../types'
import { NodeStatus, RETRY_INTERVAL, MAX_RETRY_COUNT, EVENTS_POLL_INTERVAL, CONTAINER_POLL_INTERVAL, API_HEALTH_CHECK_INTERVAL, DEGRADED_POLL_INTERVAL } from '../constants'
import { DockerConnector } from './connector'
import { nodeLogger } from '../utils/logger'

// Compose 缓存数据库记录类型
interface ComposeCacheRecord {
  id: string
  containerId: string
  filePath: string
  content: string
  projectName: string
  serviceCount: number
  mtime: number
  updatedAt: number
}

// 容器事件类型映射
const CONTAINER_ACTIONS = ['start', 'stop', 'restart', 'die', 'create', 'destroy', 'pause', 'unpause', 'health_status']

export class DockerNode {
  /** 节点配置 */
  public readonly config: NodeConfig
  /** 节点状态 */
  public status: NodeStatusType = NodeStatus.DISCONNECTED
  /** Koishi Context (用于数据库操作) */
  private readonly ctx: Context
  /** SSH 连接器 (Fallback用) */
  private connector: DockerConnector | null = null
  /** 持久化 SSH 客户端 (API用) */
  private sshClient: SshClient | null = null
  /** Dockerode 实例 (用于 API 调用) */
  private dockerode: Dockerode | null = null
  /** Docker API 是否可用 */
  private dockerApiAvailable = false
  /** 监控定时器 (容器状态轮询) */
  private monitorTimer: NodeJS.Timeout | null = null
  /** 事件监控定时器 (docker events) */
  private eventTimer: NodeJS.Timeout | null = null
  /** API健康检查定时器 */
  private healthCheckTimer: NodeJS.Timeout | null = null
  /** 降级轮询定时器 */
  private degradedPollTimer: NodeJS.Timeout | null = null
  /** 是否处于降级模式 */
  private isDegradedMode = false
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

  constructor(ctx: Context, config: NodeConfig, credential: CredentialConfig, debug = false) {
    this.ctx = ctx
    this.config = config
    this.credential = credential
    this.debug = debug

    // 注册数据库表
    this.ctx.model.extend('docker_compose_cache', {
      id: 'string',
      containerId: 'string',
      filePath: 'string',
      content: 'text',
      projectName: 'string',
      serviceCount: 'integer',
      mtime: 'integer',
      updatedAt: 'integer',
    }, {
      autoInc: false,
      primary: 'id',
    })
  }

  /**
   * 连接到 Docker (带重试)
   * 优化：优先尝试 API 连接，成功则不再建立多余的 SSH 命令行连接
   */
  async connect(): Promise<void> {
    if (this.status === NodeStatus.CONNECTING) {
      nodeLogger.warn(`[${this.name}] 节点正在连接中，跳过`)
      return
    }

    // 连接前先验证和清理配置
    this.validateAndCleanConfig()

    this.status = NodeStatus.CONNECTING
    let attempt = 0
    const MAX_INITIAL_ATTEMPTS = 3  // 前 3 次快速重试
    const LONG_RETRY_INTERVAL = 60000  // 1 分钟

    while (true) {
      attempt++
      const isInitialAttempts = attempt <= MAX_INITIAL_ATTEMPTS
      const currentInterval = isInitialAttempts ? RETRY_INTERVAL : LONG_RETRY_INTERVAL

      if (isInitialAttempts) {
        nodeLogger.debug(`[${this.name}] 连接尝试 ${attempt}/${MAX_INITIAL_ATTEMPTS}...`)
      } else {
        nodeLogger.debug(`[${this.name}] 连接尝试 ${attempt} (每 ${LONG_RETRY_INTERVAL / 1000} 秒重试)...`)
      }

      try {
        // === 优化策略：完全依赖 Docker API，不预创建 connector ===
        // 只有在 API 真正失败时，才创建 connector 并建立 SSH 连接

        // 1. 先尝试初始化 Docker API（不创建 connector）
        // 这可能会产生 1-2 个 SSH 连接（ping + getEvents）
        await this.initDockerode()

        // 2. 只有当 API 不可用时，才创建 connector 并降级到 SSH 命令
        if (!this.dockerApiAvailable) {
          nodeLogger.warn(`[${this.name}] Docker API 不可用，创建 connector 并降级到 SSH 命令...`)
          const connector = new DockerConnector(this.config, { credentials: [this.credential], nodes: [this.config] } as any)
          this.connector = connector

          // 测试 SSH 命令（这会建立第 1 个 SSH 连接）
          await connector.exec('docker version --format "{{.Server.Version}}"')
          nodeLogger.debug(`[${this.name}] ⚠ 已启用 SSH 命令模式`)
        } else {
          // API 可用：创建一个懒加载的 connector（不立即连接）
          // 只有当真正需要执行 SSH 命令时才建立连接
          const connector = new DockerConnector(this.config, { credentials: [this.credential], nodes: [this.config] } as any)
          this.connector = connector
          // 标记为 connected（但实际 SSH 连接尚未建立）
          connector.setConnected(true)
          nodeLogger.debug(`[${this.name}] ✅ Connector 已创建（懒加载模式，使用时才连接）`)
        }

        this.status = NodeStatus.CONNECTED
        const mode = this.dockerApiAvailable ? 'Docker API (SSH隧道复用)' : 'SSH 命令模式'
        nodeLogger.info(`[${this.name}] ✅ 连接成功 [模式: ${mode}]`)

        // 启动监控 (此时 API 已就绪，startEventStream 会复用 API 连接，不会产生新登录)
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
        nodeLogger.warn(`[${this.name}] ❌ 连接失败: ${lastError.message}`)

        // 清理连接
        this.disposeSshClient()
        this.connector?.dispose()
        this.connector = null
        this.dockerode = null // 确保清理

        // 等待后重试
        nodeLogger.debug(`[${this.name}] ${currentInterval / 1000} 秒后重试...`)
        await new Promise(resolve => setTimeout(resolve, currentInterval))
      }
    }
  }

  /**
   * 验证和清理配置
   */
  private validateAndCleanConfig(): void {
    // 检查并修正端口配置
    const originalPort = this.config.port
    let cleanedPort: number | string = this.config.port

    if (typeof this.config.port === 'string') {
      const portStr = this.config.port as string
      // 检测异常：端口包含 IP 地址或特殊字符
      if (portStr.includes('.') || portStr.includes(':')) {
        nodeLogger.warn(`[${this.name}] 检测到异常端口配置: "${portStr}"，已自动修正为 22`)
        cleanedPort = 22
      } else {
        const parsed = parseInt(portStr, 10)
        if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
          nodeLogger.error(`[${this.name}] 端口值无效: "${portStr}"，已自动修正为 22`)
          cleanedPort = 22
        } else {
          cleanedPort = parsed
        }
      }
    } else if (typeof this.config.port !== 'number' || this.config.port < 1 || this.config.port > 65535) {
      nodeLogger.error(`[${this.name}] 端口类型或值异常: ${this.config.port} (${typeof this.config.port})，已自动修正为 22`)
      cleanedPort = 22
    }

    // 更新配置
    if (cleanedPort !== originalPort) {
      (this.config as any).port = cleanedPort
      nodeLogger.info(`[${this.name}] 配置已修正: host="${this.config.host}", port=${cleanedPort}`)
    }
  }

  /**
   * 销毁 SSH 客户端
   */
  private disposeSshClient(): void {
    if (this.sshClient) {
      try {
        nodeLogger.debug(`[${this.name}] 销毁 SSH 主连接`)
        this.sshClient.end()
      } catch (e) {
        // 忽略销毁错误
      }
      this.sshClient = null
    }
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    this.stopMonitoring()
    this.clearTimers()

    this.disposeSshClient()
    this.connector?.dispose()
    this.connector = null
    this.dockerode = null
    this.dockerApiAvailable = false

    this.status = NodeStatus.DISCONNECTED

    // 触发离线事件
    this.emitEvent({
      Type: 'node',
      Action: 'offline',
      Actor: { ID: this.config.id, Attributes: {} },
      scope: 'local',
      time: Date.now(),
      timeNano: Date.now() * 1e6,
    })

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
   * 执行容器内命令
   * 优先使用 Docker API，失败时降级到 SSH 命令
   */
  async execContainer(containerId: string, cmd: string): Promise<{ output: string; exitCode: number }> {
    // 方式 1: 尝试使用 Docker API
    if (this.dockerode && this.dockerApiAvailable) {
      try {
        nodeLogger.debug(`[${this.name}] 使用 Docker API 执行容器命令: ${containerId.slice(0, 12)} ${cmd}`)
        const container = this.dockerode.getContainer(containerId)

        // 创建 exec 实例
        const exec = await container.exec({
          Cmd: ['/bin/sh', '-c', cmd],
          AttachStdout: true,
          AttachStderr: true,
        })

        // 启动并获取输出
        const stream = await exec.start({ Detach: false })

        return new Promise((resolve, reject) => {
          let output = ''
          let errorOutput = ''

          stream.on('data', (chunk: Buffer) => {
            output += chunk.toString()
          })

          stream.on('error', (chunk: Buffer) => {
            errorOutput += chunk.toString()
          })

          stream.on('end', async () => {
            try {
              const info = await exec.inspect()
              resolve({
                output: output || errorOutput,
                exitCode: info.ExitCode || 0
              })
            } catch (e) {
              reject(e)
            }
          })

          stream.on('error', (err: any) => {
            reject(err)
          })
        })
      } catch (e: any) {
        nodeLogger.warn(`[${this.name}] API execContainer 失败，降级到 SSH: ${e.message}`)
      }
    }

    // 方式 2: SSH 命令行回退
    nodeLogger.debug(`[${this.name}] 使用 SSH 命令执行容器命令: ${containerId.slice(0, 12)} ${cmd}`)
    if (!this.connector) throw new Error('未连接')
    return this.connector.execContainer(containerId, cmd)
  }

  /**
   * 获取 Docker 版本信息
   * 优先使用 Docker API，失败时降级到 SSH 命令
   */
  async getVersion(): Promise<{ Version: string; ApiVersion: string; Os: string; Arch: string; KernelVersion: string }> {
    // 方式 1: 尝试使用 Docker API
    if (this.dockerode && this.dockerApiAvailable) {
      try {
        nodeLogger.debug(`[${this.name}] 使用 Docker API 获取版本信息`)
        const info = await this.dockerode.version()
        return {
          Version: info.Version || 'unknown',
          ApiVersion: info.ApiVersion || 'unknown',
          Os: info.Os || 'unknown',
          Arch: info.Arch || 'unknown',
          KernelVersion: info.KernelVersion || 'unknown',
        }
      } catch (e: any) {
        nodeLogger.warn(`[${this.name}] API getVersion 失败，降级到 SSH: ${e.message}`)
      }
    }

    // 方式 2: SSH 命令行回退
    nodeLogger.debug(`[${this.name}] 使用 SSH 命令获取版本信息`)
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
   * 优先使用 Docker API，失败时降级到 SSH 命令
   */
  async getSystemInfo(): Promise<{ NCPU: number; MemTotal: number; MemAvailable?: number } | null> {
    // 方式 1: 尝试使用 Docker API
    nodeLogger.debug(`[${this.name}] getSystemInfo 调用: dockerode=${!!this.dockerode}, apiAvailable=${this.dockerApiAvailable}`)

    if (this.dockerode && this.dockerApiAvailable) {
      try {
        nodeLogger.debug(`[${this.name}] 使用 Docker API 获取系统信息`)
        const info = await this.dockerode.info()

        nodeLogger.debug(`[${this.name}] Docker API 返回: NCPU=${info.NCPU}, MemTotal=${info.MemTotal}, MemAvailable=${info.MemAvailable}`)

        const result = {
          NCPU: info.NCPU || 0,
          MemTotal: info.MemTotal || 0,
          MemAvailable: info.MemAvailable, // 可能不存在
        }

        nodeLogger.debug(`[${this.name}] 返回系统信息: NCPU=${result.NCPU}, MemTotal=${result.MemTotal}`)

        return result
      } catch (e: any) {
        nodeLogger.warn(`[${this.name}] API getSystemInfo 失败，降级到 SSH: ${e.message}`)
      }
    }

    // 方式 2: SSH 命令行回退
    nodeLogger.debug(`[${this.name}] 使用 SSH 命令获取系统信息`)
    if (!this.connector) {
      nodeLogger.warn(`[${this.name}] connector 不存在，无法获取系统信息`)
      return null
    }
    try {
      // 使用 JSON 格式获取完整信息，避免字段不存在导致的问题
      const result = await this.connector.execWithExitCode('docker info --format "{{json .}}"')
      nodeLogger.debug(`[${this.name}] docker info 输出长度: ${result.output.length}, 退出码: ${result.exitCode}`)

      if (!result.output.trim()) {
        nodeLogger.warn(`[${this.name}] docker info 输出为空`)
        return null
      }

      try {
        const info = JSON.parse(result.output)
        nodeLogger.debug(`[${this.name}] SSH docker info 解析: NCPU=${info.NCPU}, MemTotal=${info.MemTotal}, MemAvailable=${info.MemAvailable}`)

        const sshResult = {
          NCPU: info.NCPU || 0,
          MemTotal: info.MemTotal || 0,
          MemAvailable: info.MemAvailable, // 可能不存在
        }

        nodeLogger.debug(`[${this.name}] SSH 返回系统信息: NCPU=${sshResult.NCPU}, MemTotal=${sshResult.MemTotal}`)

        return sshResult
      } catch (parseError) {
        nodeLogger.warn(`[${this.name}] 解析 docker info JSON 失败: ${parseError}`)
        nodeLogger.warn(`[${this.name}] 原始输出: ${result.output.substring(0, 200)}`)
        return null
      }
    } catch (e) {
      nodeLogger.warn(`[${this.name}] 获取系统信息异常: ${e}`)
      return null
    }
  }

  /**
   * 获取容器数量
   * 优先使用 Docker API，失败时降级到 SSH 命令
   */
  async getContainerCount(): Promise<{ running: number; total: number }> {
    // 方式 1: 尝试使用 Docker API
    if (this.dockerode && this.dockerApiAvailable) {
      try {
        nodeLogger.debug(`[${this.name}] 使用 Docker API 获取容器数量`)
        const allContainers = await this.dockerode.listContainers({ all: true })
        const runningContainers = await this.dockerode.listContainers({ all: false })
        return {
          running: runningContainers.length,
          total: allContainers.length,
        }
      } catch (e: any) {
        nodeLogger.warn(`[${this.name}] API getContainerCount 失败，降级到 SSH: ${e.message}`)
      }
    }

    // 方式 2: SSH 命令行回退
    nodeLogger.debug(`[${this.name}] 使用 SSH 命令获取容器数量`)
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
   * 优先使用 Docker API，失败时降级到 SSH 命令
   */
  async getImageCount(): Promise<number> {
    // 方式 1: 尝试使用 Docker API
    if (this.dockerode && this.dockerApiAvailable) {
      try {
        nodeLogger.debug(`[${this.name}] 使用 Docker API 获取镜像数量`)
        const images = await this.dockerode.listImages()
        return images.length
      } catch (e: any) {
        nodeLogger.warn(`[${this.name}] API getImageCount 失败，降级到 SSH: ${e.message}`)
      }
    }

    // 方式 2: SSH 命令行回退
    nodeLogger.debug(`[${this.name}] 使用 SSH 命令获取镜像数量`)
    if (!this.connector) throw new Error('未连接')
    try {
      const output = await this.connector.exec('docker images -q | wc -l')
      return parseInt(output.trim()) || 0
    } catch {
      return 0
    }
  }

  /**
   * 获取镜像列表
   * 优先使用 Docker API，失败时降级到 SSH 命令
   */
  async listImages(): Promise<Array<{
    Id: string
    Repository: string
    Tag: string
    Size: string
    Created: string
  }>> {
    // 方式 1: 尝试使用 Docker API
    if (this.dockerode && this.dockerApiAvailable) {
      try {
        nodeLogger.debug(`[${this.name}] 使用 Docker API 获取镜像列表`)
        const images = await this.dockerode.listImages()

        return images.map(img => ({
          Id: img.Id || '',
          Repository: img.RepoTags?.[0] || '<none>',
          Tag: img.RepoTags?.[0]?.split(':')[1] || '<none>',
          Size: img.Size ? formatBytes(img.Size) : '-',
          Created: img.Created ? new Date(img.Created * 1000).toLocaleString() : '-',
        }))
      } catch (e: any) {
        nodeLogger.warn(`[${this.name}] API listImages 失败，降级到 SSH: ${e.message}`)
      }
    }

    // 方式 2: SSH 命令行回退
    nodeLogger.debug(`[${this.name}] 使用 SSH 命令获取镜像列表`)
    if (!this.connector || this.status !== NodeStatus.CONNECTED) {
      throw new Error(`节点 ${this.name} 未连接`)
    }

    // 使用 JSON 格式输出，便于解析
    const output = await this.connector.exec(
      'docker images --format "{{.ID}}|{{.Repository}}|{{.Tag}}|{{.Size}}|{{.CreatedAt}}"'
    )

    if (!output.trim()) return []

    return output.split('\n').filter(Boolean).map(line => {
      const parts = line.split('|')
      return {
        Id: parts[0] || '',
        Repository: parts[1] || '<none>',
        Tag: parts[2] || '<none>',
        Size: parts[3] || '-',
        Created: parts[4] || '-',
      }
    })
  }

  /**
   * 获取网络列表
   * 优先使用 Docker API，失败时降级到 SSH 命令
   */
  async listNetworks(): Promise<Array<{
    Id: string
    Name: string
    Driver: string
    Scope: string
    Subnet: string
    Gateway: string
  }>> {
    // 方式 1: 尝试使用 Docker API
    if (this.dockerode && this.dockerApiAvailable) {
      try {
        nodeLogger.debug(`[${this.name}] 使用 Docker API 获取网络列表`)
        const networks = await this.dockerode.listNetworks()

        const result = []
        for (const net of networks) {
          // 获取网络详细信息
          let subnet = '-'
          let gateway = '-'
          try {
            const details = await this.dockerode.getNetwork(net.Id!).inspect()
            if (details.IPAM?.Config?.[0]) {
              subnet = details.IPAM.Config[0].Subnet || '-'
              gateway = details.IPAM.Config[0].Gateway || '-'
            }
          } catch (e) {
            // 忽略 inspect 失败
          }

          result.push({
            Id: net.Id || '',
            Name: net.Name || '',
            Driver: net.Driver || '-',
            Scope: net.Scope || '-',
            Subnet: subnet,
            Gateway: gateway,
          })
        }

        return result
      } catch (e: any) {
        nodeLogger.warn(`[${this.name}] API listNetworks 失败，降级到 SSH: ${e.message}`)
      }
    }

    // 方式 2: SSH 命令行回退
    nodeLogger.debug(`[${this.name}] 使用 SSH 命令获取网络列表`)
    if (!this.connector || this.status !== NodeStatus.CONNECTED) {
      throw new Error(`节点 ${this.name} 未连接`)
    }

    const output = await this.connector.exec(
      'docker network ls --format "{{.ID}}|{{.Name}}|{{.Driver}}|{{.Scope}}"'
    )

    if (!output.trim()) return []

    const networks: Array<{
      Id: string
      Name: string
      Driver: string
      Scope: string
      Subnet: string
      Gateway: string
    }> = []

    for (const line of output.split('\n').filter(Boolean)) {
      const parts = line.split('|')
      const networkId = parts[0] || ''

      // 获取网络的详细信息（子网和网关）
      let subnet = '-'
      let gateway = '-'
      try {
        const inspectOutput = await this.connector.exec(
          `docker network inspect ${networkId} --format "{{range .IPAM.Config}}{{.Subnet}},{{.Gateway}}{{end}}"`
        )
        if (inspectOutput.trim()) {
          const configParts = inspectOutput.trim().split(',')
          subnet = configParts[0] || '-'
          gateway = configParts[1] || '-'
        }
      } catch {
        // 忽略 inspect 失败
      }

      networks.push({
        Id: networkId,
        Name: parts[1] || '',
        Driver: parts[2] || '-',
        Scope: parts[3] || '-',
        Subnet: subnet,
        Gateway: gateway,
      })
    }

    return networks
  }

  /**
   * 获取存储卷列表
   * 优先使用 Docker API (/system/df) 获取大小
   */
  async listVolumes(): Promise<Array<{
    Name: string
    Driver: string
    Scope: string
    Mountpoint: string
    Size: string
  }>> {
    // 方式 1: 尝试使用 Docker API (docker system df)
    // 这是获取卷大小最准确、最原生的方式
    if (this.dockerode && this.dockerApiAvailable) {
      try {
        nodeLogger.debug(`[${this.name}] 使用 Docker API 获取卷列表 (docker system df)`)
        const info = await this.dockerode.df()

        const volumes = info.Volumes || []

        return volumes.map((v: any) => ({
          Name: v.Name || '',
          Driver: v.Driver || 'local',
          Scope: v.Scope || 'local',
          Mountpoint: v.Mountpoint || '-',
          // UsageData.Size 是字节数
          Size: v.UsageData?.Size !== undefined ? formatBytes(v.UsageData.Size) : '-'
        }))
      } catch (e: any) {
        nodeLogger.warn(`[${this.name}] API listVolumes (df) 失败，降级到 SSH: ${e.message}`)
      }
    }

    // 方式 2: SSH 命令行回退
    nodeLogger.debug(`[${this.name}] 使用 SSH 命令获取存储卷列表`)
    if (!this.connector || this.status !== NodeStatus.CONNECTED) {
      throw new Error(`节点 ${this.name} 未连接`)
    }

    const output = await this.connector.exec(
      'docker volume ls --format "{{.Name}}|{{.Driver}}|{{.Scope}}"'
    )

    if (!output.trim()) return []

    const volumes: Array<{
      Name: string
      Driver: string
      Scope: string
      Mountpoint: string
      Size: string
    }> = []

    for (const line of output.split('\n').filter(Boolean)) {
      const parts = line.split('|')
      const volumeName = parts[0] || ''

      // 获取卷的详细信息（挂载点）
      let mountpoint = '-'
      try {
        const inspectOutput = await this.connector.exec(
          `docker volume inspect ${volumeName} --format "{{.Mountpoint}}"`
        )
        mountpoint = inspectOutput.trim() || '-'
      } catch {
        // 忽略 inspect 失败
      }

      // 尝试获取卷的大小（通过 du 命令）
      let size = '-'
      if (mountpoint !== '-') {
        try {
          const sizeOutput = await this.connector.exec(`du -sh ${mountpoint} 2>/dev/null | cut -f1`)
          size = sizeOutput.trim() || '-'
        } catch {
          // 忽略 du 命令失败
        }
      }

      volumes.push({
        Name: volumeName,
        Driver: parts[1] || 'local',
        Scope: parts[2] || 'local',
        Mountpoint: mountpoint,
        Size: size,
      })
    }

    return volumes
  }

  /**
   * 获取容器的 Docker Compose 信息
   * 通过标签 com.docker.compose.project.config_files 获取 compose 文件路径
   * 优先使用 Docker API，失败时降级到 SSH 命令
   */
  async getContainerComposeInfo(containerId: string): Promise<ContainerComposeInfo | null> {
    // 方式 1: 尝试使用 Docker API
    if (this.dockerode && this.dockerApiAvailable) {
      try {
        nodeLogger.debug(`[${this.name}] 使用 Docker API 获取容器 compose 信息: ${containerId.slice(0, 12)}`)
        const container = this.dockerode.getContainer(containerId)
        const info = await container.inspect()

        const labels = info.Config?.Labels as Record<string, string> | undefined
        if (!labels) {
          return null
        }

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
      } catch (e: any) {
        nodeLogger.warn(`[${this.name}] API 获取 compose 信息失败，降级到 SSH: ${e.message}`)
      }
    }

    // 方式 2: SSH 命令行回退
    nodeLogger.debug(`[${this.name}] 使用 SSH 命令获取容器 compose 信息: ${containerId.slice(0, 12)}`)
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
   * 优先从数据库读取缓存，未命中时才使用 SSH 读取并存储到数据库
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
      const cacheId = `${containerId}:${filePath}`

      // 从数据库查询缓存
      const cached = await this.ctx.model.get('docker_compose_cache', cacheId)
      const cachedRecord = Array.isArray(cached) ? cached[0] : cached

      if (cachedRecord) {
        nodeLogger.debug(`[${this.name}] 使用数据库缓存的 compose 文件: ${filePath}`)
        return {
          originalPath,
          effectivePath: filePath,
          usedWslPath: false,
          content: cachedRecord.content,
          projectName: cachedRecord.projectName,
          serviceCount: cachedRecord.serviceCount,
        }
      }

      // 数据库未命中，读取文件
      nodeLogger.debug(`[${this.name}] 从 SSH 读取 compose 文件: ${filePath}`)
      const content = await this.connector.readFile(filePath)

      // 统计服务数量 (简单的 yaml 解析)
      const serviceCount = this.countServices(content)

      // 获取文件修改时间
      const mtime = await this.connector.getFileModTime(filePath)

      // 存入数据库
      await this.ctx.model.create('docker_compose_cache', {
        id: cacheId,
        containerId,
        filePath,
        content,
        projectName: composeInfo.projectName,
        serviceCount,
        mtime,
        updatedAt: Date.now(),
      })

      nodeLogger.debug(`[${this.name}] compose 文件已存入数据库: ${filePath}`)

      return {
        originalPath,
        effectivePath: filePath,
        usedWslPath: false,
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
   * 手动更新 compose 文件缓存
   */
  async updateComposeCache(containerId: string): Promise<{ success: boolean; message: string }> {
    if (!this.connector) {
      return { success: false, message: '节点未连接' }
    }

    try {
      const composeInfo = await this.getContainerComposeInfo(containerId)
      if (!composeInfo) {
        return { success: false, message: '容器不是 compose 管理的' }
      }

      const filePath = composeInfo.composeFilePath
      const cacheId = `${containerId}:${filePath}`

      // 从 SSH 读取文件
      const content = await this.connector.readFile(filePath)

      // 统计服务数量
      const serviceCount = this.countServices(content)

      // 获取文件修改时间
      const mtime = await this.connector.getFileModTime(filePath)

      // 检查记录是否存在
      const existing = await this.ctx.model.get('docker_compose_cache', cacheId)
      const existingRecord = Array.isArray(existing) ? existing[0] : existing

      if (existingRecord) {
        // 更新现有记录
        await this.ctx.model.set('docker_compose_cache', cacheId, {
          content,
          projectName: composeInfo.projectName,
          serviceCount,
          mtime,
          updatedAt: Date.now(),
        })
      } else {
        // 创建新记录
        await this.ctx.model.create('docker_compose_cache', {
          id: cacheId,
          containerId,
          filePath,
          content,
          projectName: composeInfo.projectName,
          serviceCount,
          mtime,
          updatedAt: Date.now(),
        })
      }

      nodeLogger.info(`[${this.name}] compose 缓存已更新: ${filePath}`)
      return { success: true, message: `compose 文件已更新: ${filePath}` }
    } catch (e: any) {
      nodeLogger.error(`[${this.name}] 更新 compose 缓存失败: ${e.message}`)
      return { success: false, message: `更新失败: ${e.message}` }
    }
  }

  /**
   * 清除 compose 文件缓存
   */
  async clearComposeCache(containerId?: string): Promise<{ cleared: number; message: string }> {
    try {
      if (containerId) {
        // 清除特定容器的缓存
        // 由于我们使用的是组合 ID (containerId:filePath)，需要先查询所有记录再筛选
        const allRecords = await this.ctx.model.get('docker_compose_cache', {})
        const recordsArray = Array.isArray(allRecords) ? allRecords : [allRecords].filter(Boolean)
        const targetRecords = recordsArray.filter((r: ComposeCacheRecord) => r.containerId === containerId)

        if (targetRecords.length === 0) {
          return { cleared: 0, message: `未找到容器 ${containerId.slice(0, 12)} 的缓存` }
        }

        let cleared = 0
        for (const record of targetRecords) {
          await this.ctx.model.remove('docker_compose_cache', record.id)
          cleared++
        }

        nodeLogger.debug(`[${this.name}] 已清除容器 ${containerId.slice(0, 12)} 的 ${cleared} 条 compose 缓存`)
        return { cleared, message: `已清除容器 ${containerId.slice(0, 12)} 的 ${cleared} 条缓存` }
      } else {
        // 清除所有缓存（此节点的）
        const allRecords = await this.ctx.model.get('docker_compose_cache', {})
        const recordsArray = Array.isArray(allRecords) ? allRecords : [allRecords].filter(Boolean)
        let cleared = 0

        for (const record of recordsArray) {
          await this.ctx.model.remove('docker_compose_cache', record.id)
          cleared++
        }

        nodeLogger.debug(`[${this.name}] 已清除 ${cleared} 条 compose 缓存`)
        return { cleared, message: `已清除 ${cleared} 条缓存` }
      }
    } catch (e: any) {
      nodeLogger.error(`[${this.name}] 清除 compose 缓存失败: ${e.message}`)
      return { cleared: 0, message: `清除失败: ${e.message}` }
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
   * 优先使用 Docker API，失败时降级到 SSH 命令
   */
  async getContainer(containerId: string): Promise<any> {
    // 方式 1: 尝试使用 Docker API
    if (this.dockerode && this.dockerApiAvailable) {
      try {
        nodeLogger.debug(`[${this.name}] 使用 Docker API 获取容器详情: ${containerId.slice(0, 12)}`)
        const container = this.dockerode.getContainer(containerId)
        const info = await container.inspect()
        return info
      } catch (e: any) {
        nodeLogger.warn(`[${this.name}] API inspect 失败，降级到 SSH: ${e.message}`)
      }
    }

    // 方式 2: SSH 命令行回退
    nodeLogger.debug(`[${this.name}] 使用 SSH 命令获取容器详情: ${containerId.slice(0, 12)}`)
    if (!this.connector) throw new Error('未连接')
    const output = await this.connector.exec(`docker inspect ${containerId}`)
    const info = JSON.parse(output)
    return Array.isArray(info) ? info[0] : info
  }

  /**
   * 拉取镜像（智能模式，避免重复拉取）
   * @param image 镜像名称 (e.g. redis:latest)
   * @param force 是否强制拉取（忽略本地缓存）
   */
  async pullImage(image: string, force = false): Promise<{ pulled: boolean; reason: string }> {
    if (!this.dockerode || !this.dockerApiAvailable) {
      throw new Error('API 不可用，无法拉取镜像')
    }

    // 如果不强制拉取，先检查本地是否存在该镜像
    if (!force) {
      try {
        const localImage = this.dockerode.getImage(image)
        await localImage.inspect()
        return { pulled: false, reason: '镜像已存在于本地' }
      } catch {
        // 本地不存在，继续拉取
      }
    }

    const stream = await this.dockerode.pull(image)
    // 等待流结束 (Dockerode 返回的是一个 Stream，必须读完才算 Pull 完成)
    await new Promise((resolve, reject) => {
      this.dockerode!.modem.followProgress(stream, (err: any, res: any) => {
        if (err) reject(err)
        else resolve(res)
      })
    })
    return { pulled: true, reason: force ? '强制拉取' : '镜像不存在，已拉取' }
  }

  /**
   * 检查镜像是否有更新
   * 原理：对比容器当前使用的 ImageID 和拉取最新 tag 后的 ImageID
   */
  async checkImageUpdate(containerId: string): Promise<{ hasUpdate: boolean; currentId: string; remoteId: string; image: string }> {
    if (!this.dockerode || !this.dockerApiAvailable) {
      throw new Error('API 不可用')
    }

    const container = this.dockerode.getContainer(containerId)
    const info = await container.inspect()
    const imageName = info.Config.Image
    const currentImageId = info.Image // 本地正在使用的镜像 ID

    // 强制拉取最新镜像以检查更新
    await this.pullImage(imageName, true)

    // 获取 pull 之后该 tag 指向的最新 ID
    const newImage = this.dockerode.getImage(imageName)
    const newInspect = await newImage.inspect()
    const newImageId = newInspect.Id

    return {
      hasUpdate: currentImageId !== newImageId,
      currentId: currentImageId,
      remoteId: newImageId,
      image: imageName
    }
  }

  /**
   * 备份容器 (Commit)
   * 将当前容器保存为一个新镜像
   * @param containerId 容器 ID
   * @param tag 备份标签（可选）
   * @param skipExisting 是否跳过已存在的备份（通过哈希值判断）
   */
  async backupContainer(containerId: string, tag?: string, skipExisting = true): Promise<{ success: boolean; backupTag: string; reason: string }> {
    if (!this.dockerode || !this.dockerApiAvailable) throw new Error('API 不可用')

    const container = this.dockerode.getContainer(containerId)
    const info = await container.inspect()
    const name = info.Name.replace('/', '')
    const currentImageId = info.Image

    // 默认 Tag 格式: 容器名:backup-时间戳
    const backupTag = tag || `${name}:backup-${Math.floor(Date.now() / 1000)}`
    const [repo, tagName] = backupTag.split(':')

    // 检查是否已存在同名镜像且内容相同（通过哈希值判断）
    if (skipExisting) {
      try {
        const existingImage = this.dockerode.getImage(backupTag)
        const existingInfo = await existingImage.inspect()

        // 如果镜像的根文件系统 ID 与容器当前使用的镜像相同，说明内容没变
        if (existingInfo.Id === currentImageId) {
          return { success: false, backupTag, reason: '备份已存在且内容相同（哈希值一致）' }
        }
      } catch {
        // 不存在，继续创建备份
      }
    }

    await container.commit({
      repo: repo,
      tag: tagName || 'latest',
      comment: 'Backup by Docker Control Plugin',
      pause: true // 暂停容器以确保文件系统一致性
    })

    return { success: true, backupTag, reason: '备份已创建' }
  }

  /**
   * 重建/更新容器
   * 流程：停止旧容器 -> 重命名旧容器 -> 创建新容器 -> 启动新容器 -> 保留旧容器供手动清理
   */
  async recreateContainer(
    containerId: string,
    options: { env?: string[]; portBindings?: Record<string, any> } = {},
    updateImage = false
  ): Promise<{ success: boolean; newId?: string; oldContainerName?: string; error?: string }> {
    if (!this.dockerode || !this.dockerApiAvailable) throw new Error('API 不可用')

    const container = this.dockerode.getContainer(containerId)
    const info = await container.inspect()
    const containerName = info.Name.replace('/', '')
    const wasRunning = info.State.Running
    const originalContainerId = info.Id

    // 1. 准备配置
    const originalConfig = info.Config
    const originalHostConfig = info.HostConfig
    const networkingConfig = info.NetworkSettings.Networks

    // 确保使用 Tag 名 (如 redis:alpine) 而不是 ID
    const imageToUse = originalConfig.Image

    // 合并环境变量 (覆盖/追加模式)
    let newEnv = originalConfig.Env || []
    if (options.env && options.env.length > 0) {
      const envMap = new Map()
      // 先载入旧变量
      newEnv.forEach(e => {
        const parts = e.split('=')
        const k = parts[0]
        envMap.set(k, e)
      })
      // 覆盖新变量
      options.env.forEach(e => {
        const parts = e.split('=')
        const k = parts[0]
        envMap.set(k, e)
      })
      newEnv = Array.from(envMap.values())
    }

    // 2. 停止旧容器
    try {
      nodeLogger.debug(`[${this.name}] 正在停止旧容器 ${containerName}...`)
      await container.stop({ t: 10 }) // 给10秒优雅停止时间
    } catch (e: any) {
      nodeLogger.warn(`[${this.name}] 停止旧容器失败: ${e.message}`)
    }

    // 3. 重命名旧容器（保留供手动清理）
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const oldContainerName = `${containerName}_old_${timestamp}`
    try {
      await container.rename({ name: oldContainerName })
      nodeLogger.info(`[${this.name}] 旧容器已重命名为: ${oldContainerName}`)
    } catch (e: any) {
      nodeLogger.warn(`[${this.name}] 重命名容器失败: ${e.message}`)
      // 如果重命名失败，使用默认名称
      const oldContainerName = `${containerName}_old_${Random.id(4)}`
    }

    let newContainerId: string | undefined

    try {
      // 4. 创建新容器
      const createOptions = {
        name: containerName,
        Image: imageToUse,
        Env: newEnv,
        Cmd: originalConfig.Cmd,
        Entrypoint: originalConfig.Entrypoint,
        WorkingDir: originalConfig.WorkingDir,
        User: originalConfig.User,
        Tty: originalConfig.Tty,
        OpenStdin: originalConfig.OpenStdin,
        // 继承 HostConfig (端口映射、挂载卷、重启策略等)
        HostConfig: originalHostConfig,
        NetworkingConfig: {
          EndpointsConfig: networkingConfig
        }
      }

      nodeLogger.debug(`[${this.name}] 正在创建新容器 ${containerName}...`)
      const newContainer = await this.dockerode.createContainer(createOptions)
      newContainerId = newContainer.id

      // 5. 启动新容器
      nodeLogger.debug(`[${this.name}] 正在启动新容器 ${containerName}...`)
      await newContainer.start()

      nodeLogger.info(`[${this.name}] ✅ 容器更新成功！新容器 ID: ${newContainerId.slice(0, 12)}`)
      nodeLogger.info(`[${this.name}] 📦 旧容器已保留: ${oldContainerName}，请手动删除`)

      return { success: true, newId: newContainerId, oldContainerName }

    } catch (e: any) {
      nodeLogger.error(`[${this.name}] 重建容器失败，尝试回滚: ${e.message}`)

      // 回滚逻辑：删除失败的新容器，重命名并启动旧容器
      try {
        // 如果创建了新容器，先删除
        if (newContainerId) {
          try {
            const failedNewContainer = this.dockerode.getContainer(newContainerId)
            await failedNewContainer.remove({ force: true })
            nodeLogger.debug(`[${this.name}] 已删除失败的新容器`)
          } catch (removeError: any) {
            nodeLogger.warn(`[${this.name}] 删除失败的新容器时出错: ${removeError.message}`)
          }
        }

        // 重命名旧容器回原名称
        const oldContainer = this.dockerode.getContainer(originalContainerId)
        await oldContainer.rename({ name: containerName })
        nodeLogger.debug(`[${this.name}] 已将旧容器重命名回 ${containerName}`)

        // 如果旧容器原本是运行状态，尝试启动
        if (wasRunning) {
          try {
            await oldContainer.start()
            nodeLogger.info(`[${this.name}] ✅ 回滚成功，旧容器已恢复运行`)
          } catch (startError: any) {
            // 启动失败，可能是因为容器已经停止
            nodeLogger.warn(`[${this.name}] 启动旧容器失败: ${startError.message}`)
          }
        }

        return { success: false, error: `更新失败，已回滚: ${e.message}` }
      } catch (rollbackError: any) {
        nodeLogger.error(`[${this.name}] 回滚失败: ${rollbackError.message}`)
        return { success: false, error: `更新失败且回滚失败(需人工干预): ${e.message} -> ${rollbackError.message}` }
      }
    }
  }

  /**
   * 检查是否在 Swarm 模式
   */
  async isSwarmMode(): Promise<boolean> {
    if (!this.dockerode || !this.dockerApiAvailable) return false

    try {
      const info = await this.dockerode.info()
      return info.Swarm?.LocalNodeState === 'active'
    } catch {
      return false
    }
  }

  /**
   * 获取 Swarm 集群信息
   */
  async getSwarmInfo(): Promise<{ id: string; name: string; createdAt: string; updatedAt: string } | null> {
    if (!this.dockerode || !this.dockerApiAvailable) return null

    try {
      // 使用 dockerode 的 getSwarm 方法
      const swarmInfo = await this.dockerode.swarmInspect()
      return {
        id: swarmInfo.ID?.slice(0, 12) || '-',
        name: swarmInfo.Name || '-',
        createdAt: swarmInfo.CreatedAt ? new Date(swarmInfo.CreatedAt).toLocaleString() : '-',
        updatedAt: swarmInfo.UpdatedAt ? new Date(swarmInfo.UpdatedAt).toLocaleString() : '-'
      }
    } catch (e: any) {
      nodeLogger.debug(`[${this.name}] 获取 Swarm 信息失败: ${e.message}`)
      return null
    }
  }

  /**
   * 获取 Swarm 节点列表
   */
  async getSwarmNodes(): Promise<Array<{
    ID: string
    Hostname: string
    Status: { State: string; Addr: string }
    Availability: string
    Role: string
    ManagerStatus?: { Leader: boolean; Reachability: string } | null
  }>> {
    if (!this.dockerode || !this.dockerApiAvailable) return []

    try {
      const nodes = await this.dockerode.listNodes()
      return nodes.map(node => ({
        ID: node.ID || '',
        Hostname: node.Description?.Hostname || node.ID?.slice(0, 12) || '-',
        Status: {
          State: node.Status?.State || '-',
          Addr: node.Status?.Addr || '-'
        },
        Availability: node.Spec?.Availability || '-',
        Role: node.Spec?.Role || '-',
        ManagerStatus: node.ManagerStatus || null
      }))
    } catch (e: any) {
      nodeLogger.error(`[${this.name}] 获取 Swarm 节点列表失败: ${e.message}`)
      return []
    }
  }

  /**
   * 获取 Swarm 服务列表
   */
  async getSwarmServices(): Promise<Array<{
    ID: string
    Name: string
    Replicas: string
    Image: string
    Ports: string
  }>> {
    if (!this.dockerode || !this.dockerApiAvailable) return []

    try {
      const services = await this.dockerode.listServices()
      return services.map(service => {
        const spec: any = service.Spec || {}
        const taskTemplate: any = spec.TaskTemplate || {}
        const containerSpec: any = taskTemplate.ContainerSpec || {}

        // 尝试从多个位置获取镜像名称
        let image = containerSpec.Image || '-'
        if (image === '-' && spec.TaskSpec) {
          const taskSpec: any = spec.TaskSpec
          if (taskSpec.ContainerSpec) {
            image = taskSpec.ContainerSpec.Image || '-'
          }
        }

        // 解析副本数
        const mode: any = spec.Mode || {}
        const replicated = mode.Replicated
        const global = mode.Global
        let replicas = '-'
        if (replicated) {
          replicas = replicated.Replicas !== undefined ? String(replicated.Replicas) : '-'
        } else if (global) {
          replicas = 'global'
        }

        // 解析端口
        const endpointSpec: any = spec.EndpointSpec || {}
        const ports: any[] = endpointSpec.Ports || []
        const portStr = ports.length > 0
          ? ports.map((p: any) => `${p.PublishedPort}:${p.TargetPort}/${p.Protocol || 'tcp'}`).join(', ')
          : '-'

        return {
          ID: service.ID || '',
          Name: spec.Name || '-',
          Replicas: replicas,
          Image: image,
          Ports: portStr
        }
      })
    } catch (e: any) {
      nodeLogger.error(`[${this.name}] 获取 Swarm 服务列表失败: ${e.message}`)
      return []
    }
  }

  /**
   * 获取 Swarm 服务任务列表
   */
  async getSwarmTasks(serviceIdOrName?: string): Promise<Array<{
    ID: string
    Slot: string
    Status: { State: string; Since: string }
    DesiredState: string
    NodeID: string
  }>> {
    if (!this.dockerode || !this.dockerApiAvailable) return []

    try {
      const filters: any = {}
      if (serviceIdOrName) {
        filters.service = [serviceIdOrName]
      }

      const tasks = await this.dockerode.listTasks({ filters })
      return tasks.map(task => ({
        ID: task.ID || '',
        Slot: task.Slot !== undefined ? String(task.Slot) : '-',
        Status: {
          State: task.Status?.State || '-',
          Since: task.Status?.Timestamp ? new Date(task.Status.Timestamp).toLocaleString() : '-'
        },
        DesiredState: task.DesiredState || '-',
        NodeID: task.NodeID?.slice(0, 12) || '-'
      }))
    } catch (e: any) {
      nodeLogger.error(`[${this.name}] 获取 Swarm 任务列表失败: ${e.message}`)
      return []
    }
  }

  /**
   * 初始化 Dockerode
   * 建立唯一的 SSH 连接，并通过 `docker system dial-stdio` 复用连接
   */
  private async initDockerode(connector?: DockerConnector): Promise<void> {
    try {
      let dockerOptions: DockerOptions

      // 判断是否是本地节点
      const isLocal = this.config.host === '127.0.0.1' || this.config.host === 'localhost'

      if (isLocal) {
        // 本地连接：直接使用 Unix Socket
        this.dockerode = new Dockerode({ socketPath: '/var/run/docker.sock' })
        await this.dockerode.ping()
        this.dockerApiAvailable = true
        nodeLogger.info(`[${this.name}] ✅ Docker API 连接成功 (Local Socket)`)
        return
      }

      // === 远程 SSH 连接配置 (单连接复用方案) ===

      // 1. 关闭旧连接
      this.disposeSshClient()

      // 2. 准备 SSH 配置
      let portNumber = 22
      if (typeof this.config.port === 'number') {
        portNumber = this.config.port
      } else if (typeof this.config.port === 'string') {
        const parsed = parseInt(this.config.port as string, 10)
        if (!isNaN(parsed) && parsed > 0) {
          portNumber = parsed
        }
      }

      const sshConfig: any = {
        host: this.config.host,
        port: portNumber,
        username: this.credential.username,
        readyTimeout: 20000,
        keepaliveInterval: 10000, // 10秒心跳，防止被踢
        keepaliveCountMax: 3,
      }

      // 注入认证信息
      if (this.credential.authType === 'password' && this.credential.password) {
        sshConfig.password = this.credential.password
      } else if (this.credential.privateKey) {
        sshConfig.privateKey = this.credential.privateKey.trim()
        if (this.credential.passphrase) {
          sshConfig.passphrase = this.credential.passphrase
        }
      }

      nodeLogger.debug(`[${this.name}] 正在建立 SSH 主连接...`)

      // 3. 建立 SSH 连接
      this.sshClient = new SshClient()

      await new Promise<void>((resolve, reject) => {
        if (!this.sshClient) {
          return reject(new Error('SSH client initialization failed'))
        }

        const onReady = () => {
          this.sshClient?.removeListener('error', onError)
          resolve()
        }
        const onError = (err: Error) => {
          this.sshClient?.removeListener('ready', onReady)
          reject(err)
        }

        this.sshClient.on('ready', onReady).on('error', onError).connect(sshConfig)
      })

      // 监听连接断开，触发重连逻辑
      this.sshClient.on('close', () => {
        if (this.status === NodeStatus.CONNECTED) {
          nodeLogger.warn(`[${this.name}] SSH 主连接已断开，触发重连`)
          // 不直接调用 disconnect()，避免状态混乱
          // 让上层监控逻辑处理重连
        }
      })

      nodeLogger.debug(`[${this.name}] ✅ SSH 主连接建立成功 (单次登录，复用所有API请求)`)

      // 4. 创建自定义 Agent，劫持 createConnection
      // 这允许 dockerode 的所有请求都复用这一个 SSH 连接
      const agent = new http.Agent()
      agent.createConnection = (options, cb) => {
        nodeLogger.debug(`[${this.name}] 🔧 Agent.createConnection 被调用，复用 SSH 隧道`)

        // 使用 docker system dial-stdio 建立到 Docker Socket 的流
        // 这是官方 CLI 远程连接的标准方式，支持双向流
        if (!this.sshClient) {
          cb(new Error('SSH client not connected'), null as any)
          return null as any
        }

        this.sshClient.exec('docker system dial-stdio', (err, stream) => {
          if (err) {
            nodeLogger.warn(`[${this.name}] SSH dial-stdio 失败: ${err.message}`)
            return cb(err, null as any)
          }
          // stream 是双工流，可以直接作为 socket 使用
          nodeLogger.debug(`[${this.name}] ✅ SSH 隧道已建立`)
          cb(null, stream as any)
        })

        return null as any
      }

      // 5. 初始化 Dockerode
      // 使用 'http' 协议欺骗 dockerode 使用我们的 agent
      dockerOptions = {
        protocol: 'http',
        host: '127.0.0.1', // 这里的 host/port 会被 agent 忽略
        port: 2375,
        agent: agent,
      } as any

      nodeLogger.debug(`[${this.name}] 🔨 创建 Dockerode 实例 (使用自定义 Agent)`)
      this.dockerode = new Dockerode(dockerOptions)

      // 测试 API
      nodeLogger.debug(`[${this.name}] 🔍 测试 Docker API 连接...`)
      await this.dockerode.ping()
      this.dockerApiAvailable = true
      nodeLogger.debug(`[${this.name}] ✅ Docker API 隧道测试成功 (所有请求复用单条 SSH 连接)`)

    } catch (e: any) {
      this.disposeSshClient()
      this.dockerode = null
      this.dockerApiAvailable = false
      nodeLogger.warn(`[${this.name}] Docker API 隧道建立失败: ${e.message}`)
      throw e // 抛出错误让 connect 方法处理降级
    }
  }

  /**
   * 列出容器 (优先使用 API)
   */
  async listContainers(all = true): Promise<ContainerInfo[]> {
    // 方式 1: 尝试使用 Docker API
    if (this.dockerode && this.dockerApiAvailable) {
      try {
        nodeLogger.debug(`[${this.name}] 使用 Docker API 获取容器列表 (all=${all})`)
        const containers = await this.dockerode.listContainers({ all })
        nodeLogger.debug(`[${this.name}] Docker API 返回 ${containers.length} 个容器`)

        // 详细日志：记录前几个容器的信息
        if (containers.length > 0) {
          nodeLogger.debug(`[${this.name}] 容器列表示例: ${containers.slice(0, 2).map(c => c.Names[0]).join(', ')}`)
        }

        // 转换 Dockerode 的返回格式
        const result = containers.map(c => ({
          Id: c.Id,
          Names: c.Names,
          Image: c.Image,
          ImageID: c.ImageID,
          Command: c.Command,
          Created: c.Created,
          Ports: c.Ports,
          Labels: c.Labels,
          State: c.State as any,
          Status: c.Status,
          HostConfig: { NetworkMode: (c.HostConfig as any)?.NetworkMode || '' },
          NetworkSettings: { Networks: (c.NetworkSettings as any)?.Networks || {} },
        }))

        nodeLogger.debug(`[${this.name}] 转换后返回 ${result.length} 个容器`)
        return result
      } catch (e: any) {
        nodeLogger.warn(`[${this.name}] API listContainers 失败，降级到 SSH: ${e.message}`)
      }
    }

    // 方式 2: SSH 命令行回退
    nodeLogger.debug(`[${this.name}] 使用 SSH 命令获取容器列表`)
    if (!this.connector || this.status !== NodeStatus.CONNECTED) {
      throw new Error(`节点 ${this.name} 未连接`)
    }
    const output = await this.connector.listContainers(all)
    const parsed = this.parseContainerList(output)
    nodeLogger.debug(`[${this.name}] SSH 返回 ${parsed.length} 个容器`)
    return parsed
  }

  /**
   * 启动容器
   */
  async startContainer(containerId: string): Promise<void> {
    if (this.dockerode && this.dockerApiAvailable) {
      try {
        const container = this.dockerode.getContainer(containerId)
        await container.start()
        return
      } catch (e: any) {
        nodeLogger.warn(`[${this.name}] API startContainer 失败: ${e.message}`)
      }
    }
    // Fallback
    if (!this.connector) throw new Error('未连接')
    await this.connector.startContainer(containerId)
  }

  /**
   * 停止容器
   */
  async stopContainer(containerId: string, timeout = 10): Promise<void> {
    if (this.dockerode && this.dockerApiAvailable) {
      try {
        const container = this.dockerode.getContainer(containerId)
        await container.stop({ t: timeout })
        return
      } catch (e: any) {
        nodeLogger.warn(`[${this.name}] API stopContainer 失败: ${e.message}`)
      }
    }
    // Fallback
    if (!this.connector) throw new Error('未连接')
    await this.connector.stopContainer(containerId, timeout)
  }

  /**
   * 重启容器
   */
  async restartContainer(containerId: string, timeout = 10): Promise<void> {
    if (this.dockerode && this.dockerApiAvailable) {
      try {
        const container = this.dockerode.getContainer(containerId)
        await container.restart({ t: timeout })
        return
      } catch (e: any) {
        nodeLogger.warn(`[${this.name}] API restartContainer 失败: ${e.message}`)
      }
    }
    // Fallback
    if (!this.connector) throw new Error('未连接')
    await this.connector.restartContainer(containerId, timeout)
  }

  /**
   * 获取容器日志 (优先使用 API)
   */
  async getContainerLogs(containerId: string, tail = 100): Promise<string> {
    if (this.dockerode && this.dockerApiAvailable) {
      try {
        const container = this.dockerode.getContainer(containerId)
        const buffer = await container.logs({
          follow: false,
          stdout: true,
          stderr: true,
          tail: tail,
          timestamps: false,
        }) as Buffer

        return this.cleanDockerLogStream(buffer)
      } catch (e: any) {
        nodeLogger.warn(`[${this.name}] API getLogs 失败: ${e.message}`)
      }
    }

    // Fallback
    if (!this.connector) throw new Error('未连接')
    return this.connector.getLogs(containerId, tail)
  }

  /**
   * 清洗 Docker 日志流 (去除 8 字节头部)
   */
  private cleanDockerLogStream(buffer: Buffer): string {
    let offset = 0
    let output = ''

    while (offset < buffer.length) {
      // 头部结构: [STREAM_TYPE, 0, 0, 0, SIZE1, SIZE2, SIZE3, SIZE4]
      if (offset + 8 > buffer.length) break

      // 读取 payload 大小 (大端序)
      const size = buffer.readUInt32BE(offset + 4)

      // 移动到 payload 开始
      offset += 8

      if (offset + size > buffer.length) break

      // 读取实际内容
      output += buffer.subarray(offset, offset + size).toString('utf-8')
      offset += size
    }

    // 如果解析失败，直接转 string
    if (!output && buffer.length > 0) return buffer.toString('utf-8')
    return output
  }

  /**
   * 使用 Docker API 获取容器性能数据
   */
  private async getContainerStatsByApi(containerId: string): Promise<{
    cpuPercent: string
    memoryUsage: string
    memoryLimit: string
    memoryPercent: string
    networkIn: string
    networkOut: string
    blockIn: string
    blockOut: string
    pids: string
  } | null> {
    if (!this.dockerode || !this.dockerApiAvailable) {
      return null
    }

    try {
      const container = this.dockerode.getContainer(containerId)
      // stream: false 时，dockerode 直接返回解析好的 Object，而不是 Buffer 或 Stream
      const data = await container.stats({ stream: false }) as any

      // 内存使用量 (bytes)
      const memoryUsage = data.memory_stats?.usage || 0
      const memoryLimit = data.memory_stats?.limit || 0
      const memoryPercent = memoryLimit > 0 ? ((memoryUsage / memoryLimit) * 100).toFixed(2) + '%' : '0%'

      // CPU 使用率计算 (基于 cpu_delta / system_cpu_delta)
      const cpuUsage = data.cpu_stats?.cpu_usage?.total_usage || 0
      const systemUsage = data.cpu_stats?.system_cpu_usage || 0

      // 有些环境 online_cpus 不存在，回退到 percpu_usage 的长度
      const cpuCount = data.cpu_stats?.online_cpus || data.cpu_stats?.cpu_usage?.percpu_usage?.length || 1

      let cpuPercent = '0.00%'

      // 需要前一次的数据 (precpu_stats) 来计算差值
      if (data.precpu_stats?.cpu_usage?.total_usage !== undefined && data.precpu_stats?.system_cpu_usage !== undefined) {
        const cpuDelta = cpuUsage - data.precpu_stats.cpu_usage.total_usage
        const systemDelta = systemUsage - data.precpu_stats.system_cpu_usage

        if (systemDelta > 0 && cpuDelta > 0) {
          // 公式: (cpuDelta / systemDelta) * cpuCount * 100
          cpuPercent = ((cpuDelta / systemDelta) * cpuCount * 100).toFixed(2) + '%'
        }
      }

      // 网络流量 (bytes)
      const networks = data.networks || {}
      let networkIn = 0
      let networkOut = 0
      // 累加所有网卡的流量
      for (const net of Object.values(networks as Record<string, { rx_bytes: number; tx_bytes: number }>)) {
        networkIn += net.rx_bytes || 0
        networkOut += net.tx_bytes || 0
      }

      // Block IO (bytes)
      const blkioStats = data.blkio_stats || {}
      const ioServiceBytes = blkioStats.io_service_bytes_recursive || []
      let blockIn = 0
      let blockOut = 0
      for (const io of ioServiceBytes) {
        if (io.op === 'Read') blockIn += io.value || 0
        if (io.op === 'Write') blockOut += io.value || 0
      }

      // 进程数
      const pids = data.pids_stats?.current || '-'

      return {
        cpuPercent,
        memoryUsage: formatBytes(memoryUsage),
        memoryLimit: formatBytes(memoryLimit),
        memoryPercent,
        networkIn: formatBytes(networkIn),
        networkOut: formatBytes(networkOut),
        blockIn: formatBytes(blockIn),
        blockOut: formatBytes(blockOut),
        pids: String(pids),
      }
    } catch (e) {
      // 只有在调试模式下打印详细错误，防止刷屏
      if (this.debug) {
        nodeLogger.warn(`[${this.name}] Docker API 获取性能数据失败: ${e}`)
      }
      return null
    }
  }

  /**
   * 获取容器性能数据 (CPU、内存使用率)
   * 优先使用 Docker API，失败则降级到 SSH 命令
   */
  async getContainerStats(containerId: string): Promise<{
    cpuPercent: string
    memoryUsage: string
    memoryLimit: string
    memoryPercent: string
    networkIn: string
    networkOut: string
    blockIn: string
    blockOut: string
    pids: string
  } | null> {
    if (!this.connector) return null

    // 优先尝试 Docker API
    if (this.dockerApiAvailable) {
      const apiResult = await this.getContainerStatsByApi(containerId)
      if (apiResult) {
        nodeLogger.debug(`[${this.name}] Docker API 获取容器 ${containerId} 性能数据成功`)
        return apiResult
      }
      nodeLogger.debug(`[${this.name}] Docker API 获取容器 ${containerId} 性能数据失败，降级到 SSH`)
    }

    // 降级到 SSH 命令
    try {
      // 使用 execWithExitCode，因为停止的容器返回退出码 1
      const result = await this.connector.execWithExitCode(
        `docker stats --no-stream --no-trunc ${containerId} --format "{{.CPUPerc}}|{{.MemPerc}}|{{.MemUsage}}|{{.NetIn}}|{{.NetOut}}|{{.BlockIn}}|{{.BlockOut}}|{{.PIDs}}"`
      )

      nodeLogger.debug(`[${this.name}] SSH docker stats 输出: "${result.output}", 退出码: ${result.exitCode}`)

      // 如果没有输出（容器可能不存在或已停止），返回 null
      if (!result.output.trim()) {
        nodeLogger.debug(`[${this.name}] 容器 ${containerId} 性能数据为空，可能已停止`)
        return null
      }

      const parts = result.output.split('|')
      if (parts.length < 8) {
        nodeLogger.warn(`[${this.name}] 容器 ${containerId} 性能数据格式异常: "${result.output}"`)
        return null
      }

      // MemUsage 格式: "123.4MiB / 2GiB"，解析内存使用量和限制
      const memUsageParts = parts[2]?.split(' / ') || ['-', '-']

      return {
        cpuPercent: parts[0]?.trim() || '-',
        memoryPercent: parts[1]?.trim() || '-',
        memoryUsage: memUsageParts[0]?.trim() || '-',
        memoryLimit: memUsageParts[1]?.trim() || '-',
        networkIn: parts[3]?.trim() || '-',
        networkOut: parts[4]?.trim() || '-',
        blockIn: parts[5]?.trim() || '-',
        blockOut: parts[6]?.trim() || '-',
        pids: parts[7]?.trim() || '-',
      }
    } catch (e) {
      nodeLogger.warn(`[${this.name}] 获取容器 ${containerId} 性能数据失败: ${e}`)
      return null
    }
  }

  /**
   * 获取容器端口映射
   * 优先使用 Docker API，失败时降级到 SSH 命令
   */
  async getContainerPorts(containerId: string): Promise<string[]> {
    // 方式 1: 尝试使用 Docker API
    if (this.dockerode && this.dockerApiAvailable) {
      try {
        nodeLogger.debug(`[${this.name}] 使用 Docker API 获取容器端口: ${containerId.slice(0, 12)}`)
        const container = this.dockerode.getContainer(containerId)
        const info = await container.inspect()

        const portBindings = info.HostConfig.PortBindings
        if (!portBindings) return []

        const portStrings: string[] = []
        for (const [containerPort, bindings] of Object.entries(portBindings)) {
          const bindingArray = bindings as Array<{HostIp: string; HostPort: string}> | undefined
          if (bindingArray && bindingArray.length > 0) {
            for (const binding of bindingArray) {
              const hostIp = binding.HostIp || '0.0.0.0'
              const hostPort = binding.HostPort
              portStrings.push(`${hostIp}:${hostPort} -> ${containerPort}`)
            }
          }
        }

        return portStrings
      } catch (e: any) {
        nodeLogger.warn(`[${this.name}] API 获取端口失败，降级到 SSH: ${e.message}`)
      }
    }

    // 方式 2: SSH 命令行回退
    nodeLogger.debug(`[${this.name}] 使用 SSH 命令获取容器端口: ${containerId.slice(0, 12)}`)
    if (!this.connector) return []

    try {
      const output = await this.connector.exec(
        `docker inspect ${containerId} --format "{{json .HostConfig.PortBindings}}"`
      )

      if (!output.trim() || output === 'null') {
        return []
      }

      const portBindings = JSON.parse(output) as Record<string, Array<{ HostIp: string; HostPort: string }>>
      const portStrings: string[] = []

      for (const [containerPort, bindings] of Object.entries(portBindings)) {
        for (const binding of bindings) {
          if (binding.HostIp === '0.0.0.0' || binding.HostIp === '::') {
            portStrings.push(`${binding.HostPort}->${containerPort}`)
          } else {
            portStrings.push(`${binding.HostIp}:${binding.HostPort}->${containerPort}`)
          }
        }
      }

      return portStrings.sort()
    } catch (e) {
      nodeLogger.warn(`[${this.name}] 获取容器 ${containerId} 端口映射失败: ${e}`)
      return []
    }
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

    // 启动API健康检查
    this.startHealthCheck()

    nodeLogger.debug(`[${this.name}] 监控已启动 (事件流 + API健康检查)`)
  }

  /**
   * 启动 API 健康检查
   * DPanel模式：信任底层 Keep-Alive，不主动 Ping，只在操作报错时重连
   */
  private startHealthCheck(): void {
    // 方案：移除定时器，改为惰性检查
    // 底层 keepaliveInterval: 15s 的静默心跳已经足够防止断连
    // 主动 Ping 是产生日志的元凶，必须移除

    // 仅在启动时检查一次，确保 API 正常
    this.checkApiHealth()

    // 不再设置定时器，完全信任底层 TCP Keep-Alive
    /*
    this.healthCheckTimer = setInterval(async () => {
      await this.checkApiHealth()
    }, CHECK_INTERVAL)
    */

    nodeLogger.debug(`[${this.name}] API健康检查策略: 仅启动时检查 (依赖底层 TCP Keep-Alive 保活，无定时Ping)`)
  }

  /**
   * 检查 Docker API 健康状态
   */
  private async checkApiHealth(): Promise<void> {
    // 如果已经处于降级模式，尝试恢复
    if (this.isDegradedMode) {
      if (this.dockerode) {
        try {
          await this.dockerode.ping()
          nodeLogger.info(`[${this.name}] Docker API 已恢复，停止降级轮询`)
          this.dockerApiAvailable = true
          this.stopDegradedPolling()
        } catch (e) {
          nodeLogger.debug(`[${this.name}] Docker API 尚未恢复，继续降级模式`)
        }
      }
      return
    }

    // 如果不在降级模式，检查API是否失败
    if (this.dockerode && this.dockerApiAvailable) {
      try {
        await this.dockerode.ping()
        // API健康，无需操作
      } catch (e: any) {
        nodeLogger.error(`[${this.name}] ❌ Docker API 健康检查失败: ${e.message}`)
        nodeLogger.warn(`[${this.name}] ⚠ API失败后将进入降级模式，每${DEGRADED_POLL_INTERVAL / 1000}秒执行一次SSH命令`)
        this.dockerApiAvailable = false
        this.startDegradedPolling()
      }
    } else if (!this.dockerApiAvailable && !this.isDegradedMode) {
      // API不可用且未启动降级轮询，启动降级
      nodeLogger.warn(`[${this.name}] Docker API 不可用，启动降级轮询`)
      this.startDegradedPolling()
    }
  }

  /**
   * 启动降级轮询 (当API不可用时)
   */
  private startDegradedPolling(): void {
    if (this.isDegradedMode) {
      nodeLogger.debug(`[${this.name}] 已处于降级模式，跳过`)
      return
    }

    this.isDegradedMode = true

    // 立即执行一次轮询
    this.pollContainerStates()

    // 定期轮询容器状态
    this.degradedPollTimer = setInterval(async () => {
      await this.pollContainerStates()
    }, DEGRADED_POLL_INTERVAL)

    nodeLogger.warn(`[${this.name}] ⚠ 进入降级模式: 每${DEGRADED_POLL_INTERVAL / 1000}秒执行一次SSH命令查询容器状态`)
    nodeLogger.warn(`[${this.name}] ⚠ 这是产生频繁SSH登录记录的主要原因！建议修复Docker API连接以减少SSH使用`)
  }

  /**
   * 停止降级轮询
   */
  private stopDegradedPolling(): void {
    if (!this.isDegradedMode) {
      return
    }

    this.isDegradedMode = false

    if (this.degradedPollTimer) {
      clearInterval(this.degradedPollTimer)
      this.degradedPollTimer = null
    }

    nodeLogger.info(`[${this.name}] ✅ Docker API已恢复，停止降级轮询 (不再频繁执行SSH命令)`)
  }

  /**
   * 轮询容器状态 (用于降级模式)
   */
  private async pollContainerStates(): Promise<void> {
    if (this.status !== NodeStatus.CONNECTED) return

    try {
      nodeLogger.debug(`[${this.name}] 🔍 执行降级轮询: 使用SSH命令查询容器状态 (这会产生SSH登录记录)`)
      const containers = await this.listContainers(true)
      this.checkContainerStateChanges(containers)
      nodeLogger.debug(`[${this.name}] 降级轮询完成: 检查了 ${containers.length} 个容器`)
    } catch (e) {
      nodeLogger.warn(`[${this.name}] 降级轮询失败: ${e}`)
    }
  }

  /**
   * 启动 Docker 事件流监听
   * 优先使用 Docker API (长连接且有心跳)，失败降级到 SSH 命令
   */
  private async startEventStream(): Promise<void> {
    // 防止并发启动
    if ((this as any)._startingStream) {
      nodeLogger.debug(`[${this.name}] 事件流正在启动中，跳过`)
      return
    }
    ;(this as any)._startingStream = true

    // 清理旧的流
    if ((this as any)._eventStreamStop) {
      try {
        (this as any)._eventStreamStop()
        ;(this as any)._eventStreamStop = null
      } catch (e) {
        // 忽略清理错误
      }
    }

    nodeLogger.debug(`[${this.name}] 🚀 启动事件流监听...`)

    // === 方案 1: 优先使用 Docker API (dockerode) ===
    // 优点: 复用已有的 Keep-Alive 连接，不会因为静默被防火墙切断
    if (this.dockerode && this.dockerApiAvailable) {
      try {
        nodeLogger.debug(`[${this.name}] 尝试使用 Docker API 获取事件流`)
        nodeLogger.debug(`[${this.name}] 🔍 调用 dockerode.getEvents()`)
        const stream = await this.dockerode.getEvents({
          filters: { type: ['container'] }
        })
        nodeLogger.debug(`[${this.name}] ✅ getEvents() 成功返回流对象`)

        // 处理数据流
        stream.on('data', (chunk: Buffer) => {
          try {
            const lines = chunk.toString().split('\n').filter(Boolean)
            for (const line of lines) {
              this.handleEventLine(line)
            }
          } catch (e) {
            nodeLogger.debug(`[${this.name}] 处理事件数据失败: ${e}`)
          }
        })

        // 处理错误和断开
        const onStreamError = (err: any) => {
          if ((this as any)._startingStream === false) return // 已经手动停止
          nodeLogger.warn(`[${this.name}] API 事件流异常: ${err.message || 'Stream ended'}`)
          this.restartEventStream()
        }

        stream.on('error', onStreamError)
        stream.on('end', () => onStreamError(new Error('Stream ended')))
        stream.on('close', () => onStreamError(new Error('Stream closed')))

        // 保存停止函数
        ;(this as any)._eventStreamStop = () => {
          try {
            (stream as any).destroy?.()
            stream.off('error', onStreamError)
            stream.off('end', onStreamError)
            stream.off('close', onStreamError)
            stream.off('data', () => {})
          } catch (e) {
            // 忽略清理错误
          }
        }

        ;(this as any)._startingStream = false
        nodeLogger.debug(`[${this.name}] ✅ API 事件流已连接`)
        return
      } catch (e: any) {
        nodeLogger.warn(`[${this.name}] API 事件流启动失败: ${e.message}，降级到 SSH 命令`)
      }
    }

    // === 方案 2: 降级使用 SSH 命令行 ===
    // 只有 API 不可用时才走这里（可能因静默超时而频繁重连）
    if (!this.connector) {
      ;(this as any)._startingStream = false
      nodeLogger.warn(`[${this.name}] 无可用连接器，跳过事件流监听`)
      return
    }

    nodeLogger.warn(`[${this.name}] 使用 SSH 命令模式监听事件流 (注意: 可能因长时间静默被防火墙切断)`)

    this.connector.startEventStream((line) => {
      this.handleEventLine(line)
    }).then((stop) => {
      ;(this as any)._eventStreamStop = stop
      ;(this as any)._startingStream = false
      nodeLogger.info(`[${this.name}] ✅ SSH 事件流已连接 (注意: SSH模式下可能因静默超时而频繁重连)`)
    }).catch((err) => {
      ;(this as any)._startingStream = false
      nodeLogger.error(`[${this.name}] ❌ SSH 事件流启动失败: ${err.message}`)
      this.restartEventStream()
    })
  }

  /**
   * 重启事件流
   */
  private restartEventStream(): void {
    // 清理旧的流
    if ((this as any)._eventStreamStop) {
      try {
        (this as any)._eventStreamStop()
        ;(this as any)._eventStreamStop = null
      } catch (e) {
        // 忽略清理错误
      }
    }

    // 重置启动标志
    ;(this as any)._startingStream = false

    // 5秒后重试
    setTimeout(() => {
      if (this.status === NodeStatus.CONNECTED) {
        nodeLogger.info(`[${this.name}] 重新启动事件流...`)
        this.startEventStream()
      }
    }, 5000)
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
    // 停止健康检查
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
    }
    // 停止降级轮询
    this.stopDegradedPolling()
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
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
    }
    if (this.degradedPollTimer) {
      clearInterval(this.degradedPollTimer)
      this.degradedPollTimer = null
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

/**
 * 格式化字节为可读格式
 */
function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '-'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}
