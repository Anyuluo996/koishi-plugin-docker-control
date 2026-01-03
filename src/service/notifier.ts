/**
 * 通知器
 * 负责组装消息模板并调用 Bot 发送
 */
import { Context } from 'koishi'
import type {
  NotificationEventType,
  NotificationConfig,
} from '../types'
import { notifierLogger } from '../utils/logger'

/**
 * 事件消息模板
 */
const EVENT_TEMPLATES: Record<string, string> = {
  // 容器生命周期
  'container.start': '容器已启动',
  'container.stop': '容器已停止',
  'container.restart': '容器已重启',
  'container.die': '容器已异常退出',
  'container.create': '容器已创建',
  'container.destroy': '容器已销毁',
  // 健康检查
  'container.health_status': '容器健康状态变更',
  'health_status: healthy': '容器健康检查通过',
  'health_status: unhealthy': '容器健康检查失败',
  // exec 事件
  'exec_create': '执行命令',
  'exec_start': '开始执行',
  'exec_die': '执行结束',
  // 节点事件
  'node.online': '节点已上线',
  'node.offline': '节点已离线',
  'node.error': '节点发生错误',
  // 附加/分离
  'attach': '容器已附加',
  'detach': '容器已分离',
  'kill': '容器已被终止',
  'oom': '内存不足',
  'pause': '容器已暂停',
  'unpause': '容器已恢复',
}

/**
 * 容器状态 Emoji
 */
const STATUS_EMOJI: Record<string, string> = {
  running: '🟢',
  stopped: '🔴',
  restarting: '🟡',
  paused: '🟣',
  created: '⚪',
}

/**
 * 事件级别
 */
const EVENT_LEVEL: Record<string, 'info' | 'warning' | 'error'> = {
  'container.start': 'info',
  'container.stop': 'info',
  'container.restart': 'info',
  'container.die': 'error',
  'container.health_status': 'warning',
  'node.online': 'info',
  'node.offline': 'warning',
  'node.error': 'error',
}

export class Notifier {
  /** Koishi Context */
  private readonly ctx: Context
  /** 通知配置 */
  private readonly config: NotificationConfig

  constructor(ctx: Context, config: NotificationConfig) {
    this.ctx = ctx
    this.config = config
  }

  /**
   * 发送通知
   */
  async send(eventType: NotificationEventType, data: any): Promise<void> {
    // 检查是否启用
    if (!this.config?.enabled) {
      notifierLogger.debug(`通知已禁用`)
      return
    }

    // 检查事件是否需要通知
    if (!this.config?.events?.includes(eventType)) {
      notifierLogger.debug(`事件 ${eventType} 不在通知列表中`)
      return
    }

    // 检查通知级别
    const level = EVENT_LEVEL[eventType]
    if (this.config.level === 'error' && level !== 'error') {
      notifierLogger.debug(`事件级别 ${level} 被通知级别过滤`)
      return
    }

    // 构建消息
    const message = this.buildMessage(eventType, data)
    notifierLogger.debug(`准备发送通知: ${eventType} -> ${message}`)

    // 发送到所有目标群组
    const channels = await this.getTargetChannels()
    notifierLogger.debug(`目标群组: ${JSON.stringify(channels)}`)
    for (const channel of channels) {
      try {
        const bot = this.ctx.bots.find(b => b.sid === channel.botId)
        if (bot) {
          await bot.sendMessage(channel.channelId, message)
          notifierLogger.debug(`通知已发送: ${channel.channelId}`)
        } else {
          notifierLogger.debug(`找不到 bot: ${channel.botId}`)
        }
      } catch (e) {
        notifierLogger.error(`通知发送失败: ${e}`)
      }
    }
  }

  /**
   * 构建消息
   */
  private buildMessage(eventType: NotificationEventType, data: any): string {
    const template = EVENT_TEMPLATES[eventType] || '未知事件'

    const parts: string[] = []

    // 节点信息
    if (data.nodeName) {
      parts.push(`【${data.nodeName}】`)
    }

    // 容器信息
    if (data.containerName) {
      const emoji = this.getContainerEmoji(data)
      parts.push(`${emoji} ${data.containerName}`)
    }

    // 事件描述
    parts.push(template)

    // 额外信息
    if (data.action && !template.includes(data.action)) {
      parts.push(`(${data.action})`)
    }

    if (data.attributes?.image) {
      parts.push(`\n镜像: ${data.attributes.image}`)
    }

    if (data.attributes?.exitCode !== undefined) {
      parts.push(`\n退出码: ${data.attributes.exitCode}`)
    }

    // 组合消息
    return parts.join(' ')
  }

  /**
   * 获取容器状态 Emoji
   */
  private getContainerEmoji(data: any): string {
    const status = data.attributes?.status || data.action
    return STATUS_EMOJI[status] || '📦'
  }

  /**
   * 获取目标频道
   */
  private async getTargetChannels(): Promise<
    Array<{ botId: string; channelId: string }>
  > {
    const channels: Array<{ botId: string; channelId: string }> = []

    if (!this.config?.targetGroups?.length) {
      return channels
    }

    // 获取所有群组频道
    try {
      const allChannels = await this.ctx.database.get('channel', {
        platform: 'onebot',
      })

      for (const groupId of this.config.targetGroups) {
        const channel = allChannels.find((c: any) => c.id === groupId)
        if (channel) {
          channels.push({
            botId: channel.assignee || '',
            channelId: groupId,
          })
        }
      }
    } catch (e) {
      notifierLogger.warn(`获取频道列表失败: ${e}`)
    }

    return channels
  }

  /**
   * 发送自定义消息
   */
  async notifyCustom(
    content: string,
    targets?: string[]
  ): Promise<void> {
    const channels = targets || this.config.targetGroups

    for (const groupId of channels) {
      try {
        // 发送消息给所有机器人的对应群组
        for (const bot of this.ctx.bots.values()) {
          await bot.sendMessage(groupId, content)
        }
      } catch (e) {
        notifierLogger.error(`自定义通知发送失败: ${e}`)
      }
    }
  }
}
