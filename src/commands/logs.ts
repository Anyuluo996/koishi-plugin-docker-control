/**
 * 日志指令
 * docker.logs <node> <container>
 */
import { Context } from 'koishi'
import type { DockerControlConfig } from '../types'
import { commandLogger } from '../utils/logger'
import { generateLogsHtml, renderToImage } from '../utils/render'

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
  const useImageOutput = config?.imageOutput === true

  ctx
    .command('docker.logs <node> <container>', '查看容器日志')
    .alias('容器日志', '查看日志', '日志')
    .option('lines', '-n <lines:number> 显示最后 N 行')
    .option('timestamp', '-t 显示时间戳')
    .option('all', '-a 显示全部（不截断）')
    .action(async ({ options }, node, container) => {
      commandLogger.debug(`docker.logs 被调用: node=${node}, container=${container}, lines=${options.lines}, timestamp=${options.timestamp}`)
      const service = getService()
      if (!service) {
        commandLogger.debug('服务未初始化')
        return 'Docker 服务未初始化'
      }

      // 参数校验
      if (!node || !container) {
        return '请指定节点和容器\n用法示例:\n  docker.logs @web my-app -n 50\n  docker.logs all my-app'
      }

      // 确定日志行数 (优先级: 命令行参数 > 全局配置 > 默认值)
      const tail = options.lines || config?.defaultLogLines || 100
      const showTimestamp = options.timestamp || false
      const showAll = options.all || false
      commandLogger.debug(`日志参数: tail=${tail}, showTimestamp=${showTimestamp}, showAll=${showAll}`)

      try {
        // 查找节点
        const nodes = service.getNodesBySelector(node)
        if (nodes.length === 0) {
          commandLogger.debug(`找不到节点: ${node}`)
          return `找不到节点: ${node}`
        }

        // 在节点上查找容器
        const { node: targetNode, container: containerInfo } = await service.findContainer(
          nodes[0].id,
          container
        )

        if (!targetNode || !containerInfo) {
          return '未能获取容器信息'
        }

        // 获取日志
        const logs = await targetNode.getContainerLogs(containerInfo.Id, showAll ? 10000 : tail)

        if (!logs || !logs.trim()) {
          return `${targetNode.name}: ${getContainerName(containerInfo)} - 无日志`
        }

        // 格式化输出
        const lines = logs.split('\n').filter(l => l.length > 0)
        const displayLines = !showAll && lines.length > tail ? lines.slice(-tail) : lines

        // 移除 ANSI 颜色代码
        const cleanLogs = displayLines.map(line =>
          line.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
        ).join('\n')

        // 图片渲染模式
        if (useImageOutput && ctx.puppeteer && !showAll) {
          const html = generateLogsHtml(targetNode.name, getContainerName(containerInfo), cleanLogs, displayLines.length)
          // 根据行数动态计算高度：header 80px + header 80px + 每行 25px + padding
          const estimatedHeight = 200 + displayLines.length * 25
          return await renderToImage(ctx, html, { height: Math.max(estimatedHeight, 800) })
        }

        return `=== ${targetNode.name}: ${getContainerName(containerInfo)} (${showAll ? '全部' : `最后 ${displayLines.length} 行`}) ===\n${cleanLogs}`

      } catch (e: any) {
        commandLogger.error(e)
        return `获取日志失败: ${e.message}`
      }
    })
}
