/**
 * 日志指令
 * docker.logs <container> [node]
 */
import { Context } from 'koishi'
import type { DockerControlConfig } from '../types'
import { commandLogger } from '../utils/logger'

/**
 * 获取容器名称
 */
function getContainerName(c: any): string {
  return c.Names[0]?.replace('/', '') || c.Id.slice(0, 8)
}

/**
 * 注册日志指令
 */
export function registerLogsCommand(
  ctx: Context,
  getService: () => any,
  config?: DockerControlConfig
): void {
  ctx
    .command('docker.logs <container> [node]', '查看容器日志')
    .option('lines', '-n <lines:number> 显示最后 N 行')
    .option('timestamp', '-t 显示时间戳')
    .action(async ({ options }, container, node) => {
      commandLogger.debug(`docker.logs 被调用: container=${container}, node=${node}, lines=${options.lines}, timestamp=${options.timestamp}`)
      const service = getService()
      if (!service) {
        commandLogger.debug('服务未初始化')
        return 'Docker 服务未初始化'
      }

      // 参数校验
      if (!container) {
        return '请指定容器名或ID\n用法示例:\n  docker.logs my-app\n  docker.logs my-app node-1 -n 50'
      }

      // 确定日志行数 (优先级: 命令行参数 > 全局配置 > 默认值)
      const tail = options.lines || config?.defaultLogLines || 100
      const showTimestamp = options.timestamp || false
      commandLogger.debug(`日志参数: tail=${tail}, showTimestamp=${showTimestamp}`)

      try {
        let targetNode: any = null
        let containerInfo: any = null

        // 查找容器逻辑
        if (node) {
          // 指定节点查找
          const nodes = service.getNodesBySelector(node)
          if (nodes.length === 0) {
            commandLogger.debug(`找不到节点: ${node}`)
            return `❌ 找不到节点: ${node}`
          }

          targetNode = nodes[0]
          commandLogger.debug(`在节点 ${targetNode.name} 中查找容器...`)
          const result = await service.findContainer(targetNode.id, container)
          containerInfo = result.container
        } else {
          // 全局模糊查找
          commandLogger.debug(`全局搜索容器: ${container}`)
          const results = await service.findContainerGlobal(container)
          if (results.length === 0) {
            commandLogger.debug(`找不到容器: ${container}`)
            return `❌ 找不到容器: ${container}`
          }

          // 优先返回 Running 的，如果没有则返回第一个
          const running = results.find(r => r.container.State === 'running')
          const target = running || results[0]

          targetNode = target.node
          containerInfo = target.container
        }

        if (!targetNode || !containerInfo) {
          return '❌ 未能获取容器信息'
        }

        // 获取日志
        const logs = await targetNode.getContainerLogs(containerInfo.Id, tail)

        if (!logs || !logs.trim()) {
          return `${targetNode.name}: ${getContainerName(containerInfo)} - 无日志`
        }

        // 格式化输出
        const lines = logs.split('\n').filter(l => l.length > 0)
        const displayLines = lines.length > tail ? lines.slice(-tail) : lines

        // 移除 ANSI 颜色代码
        const cleanLogs = displayLines.map(line =>
          line.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
        ).join('\n')

        return `=== ${targetNode.name}: ${getContainerName(containerInfo)} (最后 ${displayLines.length} 行) ===\n${cleanLogs}`

      } catch (e: any) {
        commandLogger.error(e)
        return `❌ 获取日志失败: ${e.message}`
      }
    })
}
