/**
 * Docker 节点类 - 通过 SSH 执行 docker 命令
 */
import { Random } from 'koishi'
import Dockerode, { DockerOptions, NetworkInspectInfo, ContainerInspectInfo } from 'dockerode'
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
  /** Dockerode 实例 (用于 API 调用) */
  private dockerode: Dockerode | null = null
  /** Docker API 是否可用 */
  private dockerApiAvailable = false
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

        // 初始化 Dockerode (用于 API 调用)
        this.initDockerode()

        this.status = NodeStatus.CONNECTED
        nodeLogger.info(`[${this.name}] 连接成功 (SSH + ${this.dockerApiAvailable ? 'Docker API' : 'SSH 命令模式'})`)

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
    this.dockerode = null
    this.dockerApiAvailable = false

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
   * 获取镜像列表
   */
  async listImages(): Promise<Array<{
    Id: string
    Repository: string
    Tag: string
    Size: string
    Created: string
  }>> {
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
   */
  async listNetworks(): Promise<Array<{
    Id: string
    Name: string
    Driver: string
    Scope: string
    Subnet: string
    Gateway: string
  }>> {
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
   */
  async listVolumes(): Promise<Array<{
    Name: string
    Driver: string
    Scope: string
    Mountpoint: string
    Size: string
  }>> {
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
   * 流程：重命名旧容器 -> 创建新容器 -> 启动新容器 -> 停止并删除旧容器
   */
  async recreateContainer(
    containerId: string,
    options: { env?: string[]; portBindings?: Record<string, any> } = {},
    updateImage = false
  ): Promise<{ success: boolean; newId?: string; error?: string }> {
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

    // 2. 重命名旧容器（保持运行状态，以便回滚）
    const tempName = `${containerName}_old_${Random.id(4)}`
    try {
      await container.rename({ name: tempName })
    } catch (e: any) {
      nodeLogger.warn(`[${this.name}] 重命名容器失败: ${e.message}`)
    }

    let newContainerId: string | undefined

    try {
      // 3. 创建新容器
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

      const newContainer = await this.dockerode.createContainer(createOptions)
      newContainerId = newContainer.id

      // 4. 启动新容器
      await newContainer.start()

      // 5. 新容器成功运行，停止并删除旧容器
      const oldContainer = this.dockerode.getContainer(originalContainerId)
      try {
        // 尝试停止旧容器
        await oldContainer.stop({ t: 0 })
      } catch (e: any) {
        // 如果已经停止或不存在，忽略错误
        if (!e.message.includes('already stopped') && !e.message.includes('No such container')) {
          nodeLogger.warn(`[${this.name}] 停止旧容器失败: ${e.message}`)
        }
      }

      try {
        // 删除旧容器
        await oldContainer.remove({ force: true })
      } catch (e: any) {
        // 如果已经删除，忽略错误
        if (!e.message.includes('No such container')) {
          nodeLogger.warn(`[${this.name}] 删除旧容器失败: ${e.message}`)
        }
      }

      return { success: true, newId: newContainerId }

    } catch (e: any) {
      nodeLogger.error(`[${this.name}] 重建容器失败，尝试回滚: ${e.message}`)

      // 回滚逻辑：删除失败的新容器，重命名并启动旧容器
      try {
        // 如果创建了新容器，先删除
        if (newContainerId) {
          try {
            const failedNewContainer = this.dockerode.getContainer(newContainerId)
            await failedNewContainer.remove({ force: true })
          } catch (removeError: any) {
            nodeLogger.warn(`[${this.name}] 删除失败的新容器时出错: ${removeError.message}`)
          }
        }

        // 重命名旧容器回原名称
        const oldContainer = this.dockerode.getContainer(originalContainerId)
        await oldContainer.rename({ name: containerName })

        // 如果旧容器原本是运行状态，尝试启动
        if (wasRunning) {
          try {
            await oldContainer.start()
          } catch (startError: any) {
            // 启动失败，可能是因为容器已经停止
            nodeLogger.warn(`[${this.name}] 启动旧容器失败: ${startError.message}`)
          }
        }

        return { success: false, error: `更新失败，已回滚: ${e.message}` }
      } catch (rollbackError: any) {
        return { success: false, error: `更新失败且回滚失败(需人工干预): ${e.message} -> ${rollbackError.message}` }
      }
    }
  }

  /**
   * 初始化 Dockerode
   * 根据配置决定连接本地 Socket 还是通过 SSH 连接远程
   */
  private initDockerode(): void {
    try {
      let dockerOptions: DockerOptions

      // 判断是否是本地节点
      const isLocal = this.config.host === '127.0.0.1' || this.config.host === 'localhost'

      if (isLocal) {
        // 本地连接
        dockerOptions = {
          socketPath: '/var/run/docker.sock',
        }
      } else {
        // === 远程 SSH 连接配置 ===

        // 1. 构建 ssh2 的连接参数
        const sshOpts: any = {
          host: this.config.host,
          port: this.config.port || 22,
          username: this.credential.username,
          readyTimeout: 20000, // 连接超时
        }

        // 2. 根据认证类型注入凭证
        if (this.credential.authType === 'password' && this.credential.password) {
          sshOpts.password = this.credential.password
        } else if (this.credential.privateKey) {
          // 关键：私钥通常需要去掉首尾多余空白，否则 ssh2 解析会失败
          sshOpts.privateKey = this.credential.privateKey.trim()
          if (this.credential.passphrase) {
            sshOpts.passphrase = this.credential.passphrase
          }
        }

        // 3. 构建 Dockerode 配置
        // 重点：必须使用 sshOptions 属性包裹 ssh 配置，否则 dockerode 可能无法正确透传凭证
        dockerOptions = {
          protocol: 'ssh',
          host: this.config.host,
          port: this.config.port || 22,
          username: this.credential.username,
          sshOptions: sshOpts, // <--- 这里是修复的关键
        } as any
      }

      this.dockerode = new Dockerode(dockerOptions)

      // 测试连接是否真正可用
      this.dockerode.ping().then(() => {
        this.dockerApiAvailable = true
        nodeLogger.debug(`[${this.name}] Docker API 连接成功 (${isLocal ? 'Local' : 'SSH'})`)
      }).catch((e: any) => {
        this.dockerApiAvailable = false
        // 详细记录错误原因，方便排查
        nodeLogger.warn(`[${this.name}] Docker API 连接失败: ${e.message} (将降级使用 SSH 命令)`)
      })
    } catch (e) {
      this.dockerode = null
      this.dockerApiAvailable = false
      nodeLogger.debug(`[${this.name}] Dockerode 初始化异常: ${e}`)
    }
  }

  /**
   * 列出容器 (优先使用 API)
   */
  async listContainers(all = true): Promise<ContainerInfo[]> {
    // 方式 1: 尝试使用 Docker API
    if (this.dockerode && this.dockerApiAvailable) {
      try {
        const containers = await this.dockerode.listContainers({ all })

        // 转换 Dockerode 的返回格式
        return containers.map(c => ({
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
      } catch (e: any) {
        nodeLogger.warn(`[${this.name}] API listContainers 失败，降级到 SSH: ${e.message}`)
      }
    }

    // 方式 2: SSH 命令行回退
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
   */
  async getContainerPorts(containerId: string): Promise<string[]> {
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
