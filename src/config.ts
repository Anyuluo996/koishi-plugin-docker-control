/**
 * 配置定义 - 简化版，只支持 SSH 直连模式
 */
import { Schema } from 'koishi'
import type {
  DockerControlConfig,
  CredentialConfig,
  NodeConfig,
  NotificationConfig,
} from './types'

// ==================== 凭证 Schema ====================

export const CredentialSchema: Schema<CredentialConfig> = Schema.object({
  id: Schema.string().required().description('凭证 ID (唯一标识)'),
  name: Schema.string().required().description('凭证名称 (用于显示)'),
  username: Schema.string().default('root').description('SSH 用户名'),
  authType: Schema.union(['key', 'password'] as const)
    .role('radio')
    .default('key')
    .description('认证方式'),
  password: Schema.string().role('secret').description('SSH 密码'),
  privateKey: Schema.string().role('textarea').description('私钥 (PEM 格式)'),
  passphrase: Schema.string().role('secret').description('私钥密码'),
})

// ==================== 通知 Schema ====================

const NotificationEventSchema = Schema.array(Schema.string())
  .default([
    'container.start',
    'container.stop',
    'container.restart',
    'container.die',
  ])

export const NotificationSchema = Schema.object({
  enabled: Schema.boolean().default(false).description('是否启用通知'),
  level: Schema.union(['all', 'error', 'none'] as const)
    .default('all')
    .description('通知级别'),
  targetGroups: Schema.array(Schema.string())
    .default([])
    .description('通知的群组 ID 列表'),
  events: NotificationEventSchema
    .description('通知的事件类型'),
})

// ==================== 节点 Schema ====================

export const NodeSchema: Schema<NodeConfig> = Schema.object({
  id: Schema.string().required().description('节点 ID (唯一标识)'),
  name: Schema.string().required().description('节点名称 (用于显示)'),
  tags: Schema.array(Schema.string())
    .default([])
    .description('标签 (用于集群操作)'),
  host: Schema.string().required().description('SSH 主机地址'),
  port: Schema.number().default(22).description('SSH 端口'),
  credentialId: Schema.string().required().description('SSH 凭证 ID'),
})

// ==================== 增强功能 Schema ====================

const ConnectionPoolSchema = Schema.object({
  enabled: Schema.boolean().default(true).description('启用连接池'),
  maxConnectionsPerNode: Schema.number().default(5).description('每个节点最大连接数'),
  minConnectionsPerNode: Schema.number().default(1).description('每个节点最小连接数'),
  connectionTimeout: Schema.number().default(30000).description('连接超时 (毫秒)'),
  idleTimeout: Schema.number().default(300000).description('空闲连接超时 (毫秒)'),
  healthCheckInterval: Schema.number().default(60000).description('健康检查间隔 (毫秒)'),
})

const CacheSchema = Schema.object({
  enabled: Schema.boolean().default(true).description('启用缓存'),
  defaultTTL: Schema.number().default(30000).description('默认缓存时间 (毫秒)'),
  cleanupInterval: Schema.number().default(60000).description('清理间隔 (毫秒)'),
  maxCacheSize: Schema.number().default(1000).description('最大缓存条目数'),
})

const PermissionSchema = Schema.object({
  enabled: Schema.boolean().default(false).description('启用权限控制'),
  defaultRole: Schema.union(['viewer', 'operator', 'admin'] as const)
    .default('viewer')
    .description('默认角色'),
  adminUsers: Schema.array(Schema.string()).default([]).description('管理员用户 ID 列表'),
})

const AuditSchema = Schema.object({
  enabled: Schema.boolean().default(true).description('启用审计日志'),
  retentionDays: Schema.number().default(90).description('日志保留天数'),
  sensitiveFields: Schema.array(Schema.string()).default(['password', 'privateKey', 'passphrase']).description('敏感字段列表'),
})

const ReconnectSchema = Schema.object({
  enabled: Schema.boolean().default(true).description('启用自动重连'),
  maxAttempts: Schema.number().default(10).description('最大重试次数'),
  initialDelay: Schema.number().default(1000).description('初始重试延迟 (毫秒)'),
  maxDelay: Schema.number().default(60000).description('最大重试延迟 (毫秒)'),
  heartbeatInterval: Schema.number().default(30000).description('心跳检测间隔 (毫秒)'),
})

const RetrySchema = Schema.object({
  maxAttempts: Schema.number().default(3).description('最大重试次数'),
  initialDelay: Schema.number().default(1000).description('初始重试延迟 (毫秒)'),
  maxDelay: Schema.number().default(10000).description('最大重试延迟 (毫秒)'),
})

// ==================== 完整配置 Schema ====================

export const ConfigSchema = Schema.object({
  requestTimeout: Schema.number()
    .default(30000)
    .description('全局请求超时 (毫秒)'),
  debug: Schema.boolean().default(false).description('调试模式'),
  imageOutput: Schema.boolean().default(false).description('使用图片格式输出'),
  defaultLogLines: Schema.number().default(100).description('默认日志显示的行数'),

  // 增强功能
  connectionPool: ConnectionPoolSchema.description('连接池配置'),
  cache: CacheSchema.description('缓存配置'),
  permissions: PermissionSchema.description('权限控制配置'),
  audit: AuditSchema.description('审计日志配置'),
  reconnect: ReconnectSchema.description('自动重连配置'),
  retry: RetrySchema.description('错误重试配置'),

  // 原有配置
  credentials: Schema.array(CredentialSchema)
    .default([])
    .description('SSH 凭证列表'),
  nodes: Schema.array(NodeSchema)
    .default([])
    .description('Docker 节点列表'),
  notification: NotificationSchema
    .description('通知配置'),

  // 监控策略
  monitor: Schema.object({
    debounceWait: Schema.number().default(60000).description('容器意外停止后等待重启的时间 (ms)'),
    flappingWindow: Schema.number().default(300000).description('检测抖动/频繁重启的时间窗口 (ms)'),
    flappingThreshold: Schema.number().default(3).description('时间窗口内允许的最大状态变更次数'),
  }).description('监控策略设置'),
})

// ==================== 辅助函数 ====================

export function getCredentialById(
  config: DockerControlConfig,
  id: string
): CredentialConfig | undefined {
  return config.credentials?.find((c) => c.id === id)
}

export function getNodeById(
  config: DockerControlConfig,
  id: string
): NodeConfig | undefined {
  return config.nodes?.find((n) => n.id === id)
}

export function getNodesByTag(
  config: DockerControlConfig,
  tag: string
): NodeConfig[] {
  return config.nodes?.filter((n) => n.tags.includes(tag)) || []
}

export function validateConfig(config: DockerControlConfig): string[] {
  const errors: string[] = []

  if (!config.nodes) return errors

  for (const node of config.nodes) {
    if (!getCredentialById(config, node.credentialId)) {
      errors.push(`节点 ${node.name} 引用的凭证 ${node.credentialId} 不存在`)
    }
  }

  return errors
}
