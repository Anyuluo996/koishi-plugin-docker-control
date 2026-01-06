/**
 * 审计日志管理器
 * 记录所有 Docker 操作，便于审计和故障排查
 */
import { Context } from 'koishi'
import type { AuditLog, AuditLogData, AuditLogFilter, AuditConfig } from '../types/enhanced'
import { nodeLogger } from '../utils/logger'

/**
 * 审计日志管理器
 */
export class AuditLogger {
  constructor(private ctx: Context, private config: AuditConfig) {
    this.registerTables()
    // 启动定时清理任务
    this.startCleanup()
  }

  /**
   * 注册数据库表
   */
  private registerTables(): void {
    this.ctx.model.extend('docker_audit_logs', {
      id: 'unsigned',
      timestamp: 'integer',
      platform: 'string',
      userId: 'string',
      userName: 'string',
      channelId: 'string',
      action: 'string',
      parameters: 'json',
      result: 'string',
      errorMessage: 'text',
      duration: 'integer',
      nodeId: 'string',
      containerId: 'string',
      metadata: 'json',
    }, {
      autoInc: true,
      primary: 'id',
    })
  }

  /**
   * 记录操作日志
   */
  async log(data: AuditLogData): Promise<void> {
    if (!this.config.enabled) return

    try {
      const session = data.session
      const log: Partial<AuditLog> = {
        timestamp: Date.now(),
        platform: session?.platform || 'unknown',
        userId: session?.userId || session?.event?.user?.id || 'unknown',
        userName: session?.event?.user?.name || session?.userId || 'unknown',
        channelId: session?.eventId || 'unknown',
        action: data.action,
        parameters: this.sanitizeParameters(data.args || []),
        result: data.result,
        errorMessage: data.errorMessage,
        duration: data.duration,
        nodeId: data.nodeId,
        containerId: data.containerId,
        metadata: data.metadata || {},
      }

      await this.ctx.database.create('docker_audit_logs', log as any)

      nodeLogger.debug(`[审计] ${log.action} - ${log.result} (${log.duration}ms)`)
    } catch (error) {
      nodeLogger.error(`[审计] 记录失败: ${error}`)
    }
  }

  /**
   * 查询日志
   */
  async query(filter: AuditLogFilter = {}): Promise<AuditLog[]> {
    const where: any = {}

    if (filter.userId) {
      where.userId = filter.userId
    }

    if (filter.action) {
      where.action = filter.action
    }

    if (filter.result) {
      where.result = filter.result
    }

    if (filter.nodeId) {
      where.nodeId = filter.nodeId
    }

    if (filter.startTime || filter.endTime) {
      where.timestamp = {}
      if (filter.startTime) {
        where.timestamp.$gte = filter.startTime
      }
      if (filter.endTime) {
        where.timestamp.$lte = filter.endTime
      }
    }

    const logs = await this.ctx.model.get('docker_audit_logs', where, {
      limit: filter.limit || 50,
      offset: filter.offset || 0,
      sort: { timestamp: 'desc' },
    })

    return logs as AuditLog[]
  }

  /**
   * 导出日志 (CSV 格式)
   */
  async export(filter: AuditLogFilter = {}): Promise<Buffer> {
    const logs = await this.query({ ...filter, limit: 10000 })

    const headers = [
      '时间',
      '平台',
      '用户ID',
      '用户名',
      '频道',
      '操作',
      '参数',
      '结果',
      '错误信息',
      '耗时(ms)',
      '节点',
      '容器',
    ]

    const rows = logs.map((log) => [
      new Date(log.timestamp).toLocaleString(),
      log.platform,
      log.userId,
      log.userName || '',
      log.channelId,
      log.action,
      JSON.stringify(log.parameters),
      log.result,
      log.errorMessage || '',
      log.duration.toString(),
      log.nodeId || '',
      log.containerId || '',
    ])

    const csv = [headers.join(','), ...rows.map((row) => row.map((cell) => `"${cell}"`).join(','))].join('\n')

    return Buffer.from(csv, 'utf-8')
  }

  /**
   * 清理旧日志
   */
  async cleanup(daysToKeep?: number): Promise<number> {
    const retentionDays = daysToKeep ?? this.config.retentionDays
    const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000

    try {
      const logs = await this.ctx.model.get('docker_audit_logs', {
        timestamp: { $lt: cutoffTime },
      })

      let deletedCount = 0
      for (const log of logs) {
        await this.ctx.model.remove('docker_audit_logs', { id: log.id })
        deletedCount++
      }

      if (deletedCount > 0) {
        nodeLogger.info(`[审计] 清理 ${deletedCount} 条旧日志 (保留 ${retentionDays} 天)`)
      }

      return deletedCount
    } catch (error) {
      nodeLogger.error(`[审计] 清理失败: ${error}`)
      return 0
    }
  }

  /**
   * 启动定时清理任务
   */
  private startCleanup(): void {
    // 每天凌晨 2 点清理
    const now = new Date()
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(2, 0, 0, 0)

    const delay = tomorrow.getTime() - now.getTime()

    setTimeout(() => {
      this.cleanup()
      // 每 24 小时执行一次
      setInterval(() => this.cleanup(), 24 * 60 * 60 * 1000)
    }, delay)
  }

  /**
   * 脱敏参数
   */
  private sanitizeParameters(args: any[]): Record<string, any> {
    const sanitized: Record<string, any> = {}

    for (const arg of args) {
      if (typeof arg === 'object' && arg !== null) {
        for (const [key, value] of Object.entries(arg)) {
          if (this.config.sensitiveFields.some((field) => key.includes(field))) {
            sanitized[key] = '***REDACTED***'
          } else {
            sanitized[key] = value
          }
        }
      }
    }

    return sanitized
  }

  /**
   * 获取统计信息
   */
  async getStats(filter: AuditLogFilter = {}): Promise<{
    total: number
    success: number
    failure: number
    avgDuration: number
  }> {
    const logs = await this.query(filter)

    const total = logs.length
    const success = logs.filter((log) => log.result === 'success').length
    const failure = logs.filter((log) => log.result === 'failure').length
    const avgDuration = total > 0
      ? Math.round(logs.reduce((sum, log) => sum + log.duration, 0) / total)
      : 0

    return { total, success, failure, avgDuration }
  }
}

/**
 * 审计日志辅助函数
 */
export function withAuditLog(
  auditLogger: AuditLogger,
  action: string,
  session: any,
  fn: () => Promise<string>,
  metadata?: Record<string, any>
): Promise<string> {
  const startTime = Date.now()

  return fn()
    .then(async (result) => {
      await auditLogger.log({
        action,
        result: 'success',
        duration: Date.now() - startTime,
        session,
        metadata,
      })
      return result
    })
    .catch(async (error) => {
      await auditLogger.log({
        action,
        result: 'failure',
        errorMessage: error.message,
        duration: Date.now() - startTime,
        session,
        metadata,
      })
      throw error
    })
}
