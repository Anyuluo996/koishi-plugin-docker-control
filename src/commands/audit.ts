/**
 * 审计日志指令
 * 查询和管理审计日志
 */
import { Context } from 'koishi'
import { commandLogger } from '../utils/logger'

/**
 * 注册审计日志指令
 */
export function registerAuditCommands(
  ctx: Context,
  getService: () => any
): void {
  /**
   * 查询审计日志
   */
  ctx
    .command('docker.audit.log', '查看审计日志')
    .alias('审计日志', '日志审计')
    .option('user', '-u <userId> 按用户ID筛选')
    .option('action', '-a <action> 按操作类型筛选')
    .option('result', '-r <result> 按结果筛选 (success/failure)')
    .option('limit', '-l <count> 限制返回条数', { fallback: 20 })
    .action(async ({ options }) => {
      const service = getService()
      if (!service) {
        return 'Docker 服务未初始化'
      }

      if (!service.auditLogger) {
        return '审计日志功能未启用'
      }

      try {
        const filter: any = {
          limit: options.limit || 20
        }

        if (options.user) filter.userId = options.user
        if (options.action) filter.action = options.action
        if (options.result) filter.result = options.result

        const logs = await service.auditLogger.query(filter)

        if (logs.length === 0) {
          return '没有找到符合条件的审计日志'
        }

        const lines = [`=== 审计日志 (最近 ${logs.length} 条) ===`, '']

        for (const log of logs) {
          const status = log.result === 'success' ? '✅' : '❌'
          const time = new Date(log.timestamp).toLocaleString()
          const duration = log.duration ? `${log.duration}ms` : '-'

          lines.push(
            `${status} ${time}`,
            `  用户: ${log.userName || log.userId} (${log.platform})`,
            `  操作: ${log.action}`,
            `  结果: ${log.result}`,
            `  耗时: ${duration}`,
            log.nodeId ? `  节点: ${log.nodeId}` : '',
            log.containerId ? `  容器: ${log.containerId.slice(0, 12)}` : '',
            log.errorMessage ? `  错误: ${log.errorMessage}` : '',
            ''
          )
        }

        return lines.filter(Boolean).join('\n')
      } catch (e: any) {
        commandLogger.error(`查询审计日志失败: ${e.message}`)
        return `❌ 查询失败: ${e.message}`
      }
    })

  /**
   * 获取审计日志统计
   */
  ctx
    .command('docker.audit.stats', '审计日志统计')
    .alias('审计统计', '日志统计')
    .action(async () => {
      const service = getService()
      if (!service) {
        return 'Docker 服务未初始化'
      }

      if (!service.auditLogger) {
        return '审计日志功能未启用'
      }

      try {
        const stats = await service.auditLogger.getStats()

        return [
          '=== 审计日志统计 ===',
          `总操作数: ${stats.total}`,
          `成功: ${stats.success}`,
          `失败: ${stats.failure}`,
          `平均耗时: ${stats.avgDuration}ms`
        ].join('\n')
      } catch (e: any) {
        commandLogger.error(`获取审计统计失败: ${e.message}`)
        return `❌ 获取失败: ${e.message}`
      }
    })

  /**
   * 清理旧日志
   */
  ctx
    .command('docker.audit.cleanup', '清理旧审计日志')
    .alias('清理审计日志', '清理日志')
    .option('days', '-d <days> 保留天数', { fallback: null })
    .action(async ({ options }) => {
      const service = getService()
      if (!service) {
        return 'Docker 服务未初始化'
      }

      if (!service.auditLogger) {
        return '审计日志功能未启用'
      }

      try {
        const deletedCount = await service.auditLogger.cleanup(options.days)
        return `✅ 已清理 ${deletedCount} 条旧日志`
      } catch (e: any) {
        commandLogger.error(`清理审计日志失败: ${e.message}`)
        return `❌ 清理失败: ${e.message}`
      }
    })

  /**
   * 导出审计日志
   */
  ctx
    .command('docker.audit.export', '导出审计日志')
    .alias('导出审计日志', '导出日志')
    .action(async () => {
      const service = getService()
      if (!service) {
        return 'Docker 服务未初始化'
      }

      if (!service.auditLogger) {
        return '审计日志功能未启用'
      }

      if (!ctx.assets) {
        return '❌ 需要assets插件支持才能导出文件'
      }

      try {
        const csv = await service.auditLogger.export()
        const filename = `audit-logs-${Date.now()}.csv`
        const url = await ctx.assets.upload(csv, filename)

        return `✅ 审计日志已导出: ${url}`
      } catch (e: any) {
        commandLogger.error(`导出审计日志失败: ${e.message}`)
        return `❌ 导出失败: ${e.message}`
      }
    })
}
