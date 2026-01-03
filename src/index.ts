/**
 * 插件入口 - 简化版，只支持 SSH 直连模式
 */
import { Context, Logger, Schema } from 'koishi'
import type { DockerControlConfig, NodeConfig, CredentialConfig, NotificationConfig } from './types'
import { logger, nodeLogger, connectorLogger, monitorLogger, notifierLogger, commandLogger } from './utils/logger'
import { DockerService } from './service'
import { MonitorManager } from './service/monitor'
import { Notifier } from './service/notifier'
import { registerCommands } from './commands'

export const name = 'docker-control'

// 声明 puppeteer 为可选依赖
export const inject = {
  required: ['database'],
  optional: ['puppeteer'],
}

// Puppeteer 类型扩展
declare module 'koishi' {
  interface Context {
    puppeteer?: {
      render: (html: string, callback?: (page: any, next: (handle?: any) => Promise<string>) => Promise<string>) => Promise<string>
    }
  }
}

// 导出配置 Schema
export const Config = Schema.object({
  requestTimeout: Schema.number().default(30000).description('请求超时 (毫秒)'),
  debug: Schema.boolean().default(false).description('调试模式'),
  imageOutput: Schema.boolean().default(false).description('使用图片格式输出容器列表'),
  defaultLogLines: Schema.number().default(100).description('默认日志显示的行数'),
  credentials: Schema.array(Schema.object({
    id: Schema.string().required(),
    name: Schema.string().required(),
    username: Schema.string().default('root'),
    authType: Schema.union(['key', 'password'] as const).default('key'),
    password: Schema.string().role('secret'),
    privateKey: Schema.string().role('textarea'),
    passphrase: Schema.string().role('secret'),
  })).description('SSH 凭证列表'),
  nodes: Schema.array(Schema.object({
    id: Schema.string().required(),
    name: Schema.string().required(),
    tags: Schema.array(Schema.string()).default([]),
    host: Schema.string().required().description('SSH 主机地址'),
    port: Schema.number().default(22).description('SSH 端口'),
    credentialId: Schema.string().required().description('SSH 凭证 ID'),
  })).description('Docker 节点列表'),
  notification: Schema.object({
    enabled: Schema.boolean().default(false),
    level: Schema.union(['all', 'error', 'none'] as const).default('all'),
    targetGroups: Schema.array(Schema.string()).default([]),
    events: Schema.array(Schema.string()).default(['container.start', 'container.stop', 'container.restart', 'container.die']),
  }).description('通知配置'),
})

export function apply(ctx: Context, config: DockerControlConfig) {
  // 安全检查
  if (!config) {
    logger.info('Docker Control 配置未定义，跳过加载')
    return
  }

  // 验证配置
  const errors: string[] = []
  const credentialIds = new Set(config.credentials?.map(c => c.id) || [])
  for (const node of config.nodes || []) {
    if (!credentialIds.has(node.credentialId)) {
      errors.push(`节点 ${node.name} 引用的凭证 ${node.credentialId} 不存在`)
    }
  }
  if (errors.length > 0) {
    logger.warn('配置验证失败:')
    for (const error of errors) {
      logger.warn(`  - ${error}`)
    }
  }

  // 如果没有配置节点，直接跳过初始化
  if (!config.nodes || config.nodes.length === 0) {
    logger.info('Docker Control 未配置任何节点，跳过初始化')
    registerCommands(ctx, () => null)
    return
  }

  // 创建服务实例
  const dockerService = new DockerService(ctx, config)
  const monitorManager = new MonitorManager()
  const notifier = new Notifier(ctx, config.notification || { enabled: false, level: 'all', targetGroups: [], events: [] })

  // 监听节点事件
  const eventUnsub = dockerService.onNodeEvent((event) => {
    notifier.send(event.Type as any, event)
  })

  // 插件就绪时初始化（使用 setTimeout 确保 ctx 完全初始化）
  setTimeout(() => {
    dockerService.initialize()
      .then(() => {
        logger.info('Docker Control 插件初始化完成')
      })
      .catch((e: any) => {
        logger.error(`初始化失败: ${e?.message || e}`)
      })
  }, 0)

  // 注册指令
  registerCommands(ctx, () => dockerService, config)

  // 调试指令
  if (config.debug) {
    // 设置所有日志器级别为 DEBUG
    logger.level = 0
    nodeLogger.level = 0
    connectorLogger.level = 0
    monitorLogger.level = 0
    notifierLogger.level = 0
    commandLogger.level = 0
    logger.info('[DEBUG] 调试模式已启用')

    ctx.command('docker.debug', '调试指令').action(async () => {
      const nodes = dockerService.getAllNodes()
      const online = dockerService.getOnlineNodes()

      const lines: string[] = [
        '=== Docker Control 调试信息 ===',
        `节点总数: ${nodes.length}`,
        `在线节点: ${online.length}`,
        `离线节点: ${nodes.length - online.length}`,
        '',
      ]

      lines.push('--- 节点详情 ---')
      for (const n of nodes) {
        const status = n.status === 'connected' ? '🟢' : n.status === 'connecting' ? '🟡' : '🔴'
        lines.push(`${status} ${n.name} (${n.id})`)
        lines.push(`   状态: ${n.status}`)
        lines.push(`   标签: ${n.tags.join(', ') || '(无)'}`)
      }

      return lines.join('\n')
    })
  }

  logger.info('Docker Control 插件已加载')
}
