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

// ==================== 完整配置 Schema ====================

export const ConfigSchema = Schema.object({
  requestTimeout: Schema.number()
    .default(30000)
    .description('全局请求超时 (毫秒)'),
  debug: Schema.boolean().default(false).description('调试模式'),
  credentials: Schema.array(CredentialSchema)
    .default([])
    .description('SSH 凭证列表'),
  nodes: Schema.array(NodeSchema)
    .default([])
    .description('Docker 节点列表'),
  notification: NotificationSchema
    .description('通知配置'),
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
