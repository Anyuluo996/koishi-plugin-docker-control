/**
 * 常量定义
 */

// 默认请求超时时间 (毫秒)
export const DEFAULT_TIMEOUT = 5000

// 默认重试间隔 (毫秒)
export const RETRY_INTERVAL = 5000

// SSH 连接超时 (毫秒)
export const SSH_TIMEOUT = 5000

// 最大重试次数
export const MAX_RETRY_COUNT = 3

// 监控重连间隔 (毫秒)
export const MONITOR_RETRY_INTERVAL = 30000

// Docker Events 监听间隔 (毫秒)
export const EVENTS_RECONNECT_INTERVAL = 5000

// 日志行数默认
export const DEFAULT_LOG_LINES = 100

// 节点状态枚举
export const NodeStatus = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  ERROR: 'error',
} as const

export type NodeStatusType = typeof NodeStatus[keyof typeof NodeStatus]

// 容器操作类型
export const ContainerAction = {
  START: 'start',
  STOP: 'stop',
  RESTART: 'restart',
  CREATE: 'create',
  DIE: 'die',
} as const

export type ContainerActionType = typeof ContainerAction[keyof typeof ContainerAction]
