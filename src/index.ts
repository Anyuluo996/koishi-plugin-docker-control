/**
 * 插件入口 - 支持订阅机制的 Docker 管理插件
 */
import { Context, Logger, Schema } from 'koishi'
import type { DockerControlConfig } from './types'
import { logger, nodeLogger, commandLogger } from './utils/logger'
import { DockerService } from './service'
import { MonitorManager } from './service/monitor'
import { registerCommands } from './commands'

export const name = 'docker-control'

export const inject = {
  required: ['database'],
  optional: ['puppeteer', 'assets'],
}

// 订阅记录类型定义
interface DockerControlSubscription {
  id: number
  platform: string
  channelId: string
  nodeId: string
  containerPattern: string
  eventTypes: string
  enabled: boolean
  createdAt: number
}

// Puppeteer 类型扩展
declare module 'koishi' {
  interface Context {
    puppeteer?: {
      render: (html: string, callback?: (page: any, next: (handle?: any) => Promise<string>) => Promise<string>) => Promise<string>
    }
    assets?: {
      upload: (data: string | Buffer, filename: string) => Promise<string>
    }
  }

  interface Tables {
    'docker_control_subscriptions': DockerControlSubscription
  }
}

// 导出配置 Schema
export const Config = Schema.object({
  requestTimeout: Schema.number().default(30000).description('请求超时 (毫秒)'),
  debug: Schema.boolean().default(false).description('调试模式'),
  imageOutput: Schema.boolean().default(false).description('使用图片格式输出容器列表和操作结果'),
  defaultLogLines: Schema.number().default(100).description('默认日志显示的行数'),
  // 监控策略
  monitor: Schema.object({
    debounceWait: Schema.number().default(60000).description('容器意外停止后等待重启的时间 (ms)，在此期间恢复不发送通知'),
    flappingWindow: Schema.number().default(300000).description('检测抖动/频繁重启的时间窗口 (ms)'),
    flappingThreshold: Schema.number().default(3).description('时间窗口内允许的最大状态变更次数，超过则报警'),
  }).description('监控策略设置'),
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
})

// 事件消息模板
const EVENT_MESSAGES: Record<string, string> = {
  'container.start': '已启动',
  'container.stop': '已停止',
  'container.restart': '已重启',
  'container.die': '已异常退出',
  'container.flapping': '运行状态不稳定 (频繁重启)',
}

// 订阅记录类型
type SubscriptionRecord = DockerControlSubscription

export function apply(ctx: Context, config: DockerControlConfig) {
  // 表名
  const TABLE_NAME = 'docker_control_subscriptions'

  // 注册表结构
  ctx.model.extend(TABLE_NAME, {
    id: 'unsigned',
    platform: 'string',
    channelId: 'string',
    nodeId: 'string',
    containerPattern: 'string',
    eventTypes: 'text',
    enabled: 'boolean',
    createdAt: 'integer',
  }, {
    autoInc: true,
    primary: 'id',
  })

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
  // 传入监控配置
  const monitorManager = new MonitorManager(config.monitor || {})

  // 插件就绪时初始化（异步，不阻塞 Koishi 启动）
  setTimeout(() => {
    dockerService.initialize().catch((e: any) => {
      logger.error(`初始化失败: ${e?.message || e}`)
    })
  }, 0)

  // 注册基础指令
  registerCommands(ctx, () => dockerService, config)

  // ==================== 订阅指令 ====================
  ctx.command('docker.subscribe <node> <container>', '订阅容器状态变更通知')
    .alias('docker订阅', '订阅', '容器订阅')
    .option('events', '-e <events> 监听的事件类型，默认全部', { fallback: 'start,stop,restart,die' })
    .action(async ({ options, session }, nodeSelector, containerPattern) => {
      const { platform, channelId } = session

      // 检查服务是否可用
      if (!dockerService) {
        return '❌ Docker 服务未初始化'
      }

      // 验证必填参数
      if (!nodeSelector || !containerPattern) {
        return '❌ 缺少参数，用法: docker.subscribe <节点> <容器>\n   示例: docker.subscribe yun myapp\n   示例: docker.subscribe all all'
      }

      // 验证节点
      const nodes = dockerService.getNodesBySelector(nodeSelector)
      if (nodes.length === 0) {
        return `❌ 找不到节点: ${nodeSelector}`
      }

      const nodeId = nodeSelector === 'all' ? '' : nodes[0].id
      const eventTypes = options.events.split(',').map(e => e.trim()).filter(Boolean)
      const targetContainerPattern = containerPattern === 'all' ? '' : containerPattern

      // 查询是否已存在相同订阅
      const existing = await ctx.model.get(TABLE_NAME, {
        platform,
        channelId,
        nodeId,
        containerPattern: targetContainerPattern,
      })

      if (existing.length > 0) {
        // 更新已有订阅
        await ctx.model.set(TABLE_NAME, { id: existing[0].id }, {
          eventTypes: JSON.stringify(eventTypes),
          enabled: true,
        })
        logger.info(`更新订阅: ${platform}:${channelId} ${nodeId || '*'} ${targetContainerPattern || '*'}`)
      } else {
        // 创建新订阅
        await ctx.database.create(TABLE_NAME, {
          platform,
          channelId,
          nodeId,
          containerPattern: targetContainerPattern,
          eventTypes: JSON.stringify(eventTypes),
          enabled: true,
          createdAt: Date.now(),
        })
        logger.info(`创建订阅: ${platform}:${channelId} ${nodeId || '*'} ${targetContainerPattern || '*'}`)
      }

      const nodeDesc = nodeSelector === 'all' ? '所有节点' : nodes[0].name
      const containerDesc = containerPattern === 'all' ? '所有容器' : containerPattern

      return `✅ 已更新订阅\n   节点: ${nodeDesc}\n   容器: ${containerDesc}\n   事件: ${eventTypes.join(', ')}`
    })

  // 取消订阅
  ctx.command('docker.unsubscribe <id>', '取消订阅')
    .alias('docker取消订阅', '取消订阅')
    .action(async (_, id) => {
      const subId = Number(id)
      if (isNaN(subId) || subId <= 0) {
        return '❌ 请提供有效的订阅 ID，使用 docker订阅列表 查看'
      }
      await ctx.model.remove(TABLE_NAME, { id: subId })
      return `✅ 已取消订阅 ${subId}`
    })

  // 查看订阅列表
  ctx.command('docker.subscriptions', '查看当前订阅')
    .alias('docker订阅列表', '订阅列表')
    .action(async ({ session }) => {
      const { platform, channelId } = session
      const rows = await ctx.model.get(TABLE_NAME, { platform, channelId })

      if (rows.length === 0) {
        return '暂无订阅，使用 docker.subscribe <节点> <容器> 添加订阅'
      }

      const lines = ['=== 我的订阅 ===']
      for (const row of rows as SubscriptionRecord[]) {
        const nodeDesc = row.nodeId ? `(节点: ${row.nodeId})` : '(所有节点)'
        const containerDesc = row.containerPattern || '(所有容器)'
        const eventTypes = JSON.parse(row.eventTypes || '[]')
        lines.push(`[${row.id}] ${nodeDesc} ${containerDesc}`)
        lines.push(`    事件: ${eventTypes.join(', ')}`)
      }

      return lines.join('\n')
    })

  // ==================== 事件监听 ====================

  // 1. 将 DockerService 的原始事件喂给 MonitorManager
  dockerService.onNodeEvent((event, nodeId) => {
    const node = dockerService.getNode(nodeId)
    if (node) {
      monitorManager.processEvent(node, event)
    }
  })

  // 2. 监听 MonitorManager 处理后的"智能"事件
  const eventUnsub = monitorManager.onProcessedEvent(async (processedEvent) => {
    const { eventType, action, nodeName, containerName, nodeId } = processedEvent

    // [调试日志]
    commandLogger.debug(`[推送] 准备发送通知: [${nodeName}] ${containerName} -> ${action}`)

    // 获取所有订阅并发送通知
    const subs = await ctx.model.get(TABLE_NAME, {})

    if (subs.length === 0) {
      commandLogger.debug(`[推送] 无订阅`)
      return
    }

    for (const sub of subs as SubscriptionRecord[]) {
      if (!sub.enabled) continue

      // 1. 检查事件类型
      const eventTypes = JSON.parse(sub.eventTypes || '[]')

      // 特殊逻辑：如果订阅了 'restart' 或 'die'，通常也希望能收到 'flapping' 报警
      const effectiveEventTypes = [...eventTypes]
      if (effectiveEventTypes.includes('die') || effectiveEventTypes.includes('restart')) {
        effectiveEventTypes.push('flapping')
      }

      if (!effectiveEventTypes.includes(action)) {
        commandLogger.debug(`  - 订阅[${sub.id}] 忽略: 事件类型不匹配 (订阅: ${eventTypes.join(', ')}, 收到: ${action})`)
        continue
      }

      // 2. 检查节点匹配
      if (sub.nodeId && sub.nodeId !== nodeId) {
        commandLogger.debug(`  - 订阅[${sub.id}] 忽略: 节点不匹配`)
        continue
      }

      // 3. 检查容器名称匹配
      if (sub.containerPattern) {
        const pattern = sub.containerPattern
          .replace(/\*/g, '.*')
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        const regex = new RegExp(`^${pattern}$`, 'i')

        if (!regex.test(containerName)) {
          commandLogger.debug(`  - 订阅[${sub.id}] 忽略: 容器名不匹配`)
          continue
        }
      }

      // 构建消息
      const emoji: Record<string, string> = {
        start: '🟢',
        stop: '🔴',
        restart: '🟡',
        die: '⚠️',
        flapping: '💥',
        kill: '💀',
        health_status: '💚',
      }
      const actionText = EVENT_MESSAGES[eventType] || action
      const emojiChar = emoji[action] || '📦'
      const message = `${emojiChar} 【${nodeName}】${containerName} ${actionText}`

      // 发送
      try {
        const bots = ctx.bots.filter(b => b.platform === sub.platform)
        if (bots.length === 0) {
          commandLogger.warn(`  - 订阅[${sub.id}] 失败: 找不到平台 ${sub.platform} 的 Bot`)
          continue
        }
        for (const bot of bots) {
          await bot.sendMessage(sub.channelId, message)
          commandLogger.info(`[通知] 已推送到 ${sub.channelId}: ${message}`)
        }
      } catch (e) {
        commandLogger.error(`通知发送失败: ${e}`)
      }
    }
  })

  // ==================== 调试指令 ====================
  if (config.debug) {
    const debugLevel = (Logger as any).DEBUG || 4
    logger.level = debugLevel
    nodeLogger.level = debugLevel
    commandLogger.level = debugLevel
    logger.info(`[DEBUG] 调试模式已启用 (Level: ${debugLevel})`)

    ctx.command('docker.debug', '调试指令').action(async () => {
      const nodes = dockerService.getAllNodes()
      const online = dockerService.getOnlineNodes()
      const subs = await ctx.model.get(TABLE_NAME, {})

      const lines: string[] = [
        '=== Docker Control 调试信息 ===',
        `节点总数: ${nodes.length}`,
        `在线节点: ${online.length}`,
        `离线节点: ${nodes.length - online.length}`,
        `订阅总数: ${subs.length}`,
        '',
      ]

      lines.push('--- 节点详情 ---')
      for (const n of nodes) {
        const status = n.status === 'connected' ? '🟢' : n.status === 'connecting' ? '🟡' : '🔴'
        lines.push(`${status} ${n.name} (${n.id})`)
      }

      lines.push('')
      lines.push('--- 订阅列表 ---')
      for (const sub of subs as SubscriptionRecord[]) {
        lines.push(`[${sub.id}] ${sub.platform}:${sub.channelId} ${sub.nodeId || '*'} ${sub.containerPattern || '*'}`)
      }

      return lines.join('\n')
    })
  }

  logger.info('Docker Control 插件已加载')

  // 插件卸载时清理
  ctx.on('dispose', async () => {
    logger.info('Docker Control 插件正在卸载...')
    eventUnsub()
    await dockerService.stopAll()
  })
}