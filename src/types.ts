/**
 * 类型定义 - 简化版，只支持 SSH 直连模式
 */

export type AuthType = 'key' | 'password'

export type NodeStatusType = 'disconnected' | 'connecting' | 'connected' | 'error'

export type ContainerStatusType = 'running' | 'stopped' | 'paused' | 'restarting' | 'created'

// ==================== 凭证配置 ====================

export interface CredentialConfig {
  id: string
  name: string
  username: string
  authType: AuthType
  password?: string
  privateKey?: string
  passphrase?: string
}

// ==================== 节点配置 ====================

export interface NodeConfig {
  id: string
  name: string
  tags: string[]
  host: string
  port: number
  credentialId: string
}

// ==================== 通知配置 ====================

export interface NotificationConfig {
  enabled: boolean
  level: 'all' | 'error' | 'none'
  targetGroups: string[]
  events: NotificationEventType[]
}

export type NotificationEventType =
  | 'container.start'
  | 'container.stop'
  | 'container.restart'
  | 'container.die'
  | 'container.health_status'
  | 'node.online'
  | 'node.offline'
  | 'node.error'

// ==================== 监控策略配置 ====================

export interface MonitorConfig {
  debounceWait: number  // 防抖等待时间 (ms)
  flappingWindow: number  // 抖动检测时间窗口 (ms)
  flappingThreshold: number  // 抖动阈值 (次数)
}

// ==================== 完整配置 ====================

export interface DockerControlConfig {
  requestTimeout: number
  debug: boolean
  imageOutput: boolean
  defaultLogLines: number
  monitor: MonitorConfig
  credentials: CredentialConfig[]
  nodes: NodeConfig[]
  notification: NotificationConfig

  // 增强功能配置
  connectionPool?: {
    enabled: boolean
    maxConnectionsPerNode: number
    minConnectionsPerNode: number
    connectionTimeout: number
    idleTimeout: number
    healthCheckInterval: number
  }
  cache?: {
    enabled: boolean
    defaultTTL: number
    cleanupInterval: number
    maxCacheSize: number
  }
  permissions?: {
    enabled: boolean
    defaultRole: 'viewer' | 'operator' | 'admin'
    adminUsers: string[]
  }
  audit?: {
    enabled: boolean
    retentionDays: number
    sensitiveFields: string[]
  }
  reconnect?: {
    enabled: boolean
    maxAttempts: number
    initialDelay: number
    maxDelay: number
    heartbeatInterval: number
  }
  retry?: {
    maxAttempts: number
    initialDelay: number
    maxDelay: number
  }
}

// ==================== Docker 类型 ====================

export interface ContainerInfo {
  Id: string
  Names: string[]
  Image: string
  ImageID: string
  Command: string
  Created: number
  Ports: Array<{
    PrivatePort: number
    PublicPort: number
    Type: string
  }>
  Labels: Record<string, string>
  State: ContainerStatusType
  Status: string
  HostConfig: {
    NetworkMode: string
  }
  NetworkSettings: {
    Networks: Record<string, {
      IPAddress: string
      Gateway: string
      MacAddress: string
    }>
  }
}

// ==================== 事件类型 ====================

export interface DockerEvent {
  Type: string
  Action: string
  Actor: {
    ID: string
    Attributes: Record<string, string>
  }
  scope: 'local' | 'swarm'
  time: number
  timeNano: number
}

// ==================== 订阅配置 ====================

export interface SubscriptionConfig {
  /** 订阅 ID */
  id?: number
  /** 平台 (onebot 等) */
  platform: string
  /** 频道 ID (群组号或用户号) */
  channelId: string
  /** 节点 ID (空表示所有节点) */
  nodeId?: string
  /** 容器名称模式 (空表示所有容器，支持 * 通配符) */
  containerPattern?: string
  /** 推送的事件类型 */
  eventTypes: string[]
  /** 是否启用 */
  enabled: boolean
  /** 创建时间 */
  createdAt?: number
}

// ==================== Compose 类型 ====================

export interface ComposeFileInfo {
  /** 原始路径 (Windows 路径或 WSL 路径) */
  originalPath: string
  /** 实际使用的路径 (尝试转换后的路径) */
  effectivePath: string
  /** 是否使用了 WSL 路径转换 */
  usedWslPath: boolean
  /** Compose 文件内容 */
  content: string
  /** 所属项目名称 */
  projectName: string
  /** 容器数量 */
  serviceCount: number
}

export interface ContainerComposeInfo {
  /** 容器 ID */
  containerId: string
  /** 容器名称 */
  containerName: string
  /** 所属 Docker Compose 项目 */
  projectName: string
  /** Compose 文件路径 */
  composeFilePath: string
}
