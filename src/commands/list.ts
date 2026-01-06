/**
 * 列出容器指令
 * docker.ls - 支持集群视图和图片渲染
 */
import { Command, Context, Fragment, h, Session } from 'koishi'
import type { ContainerInfo } from '../types'
import { commandLogger } from '../utils/logger'
import { generateListHtml, renderToImage } from '../utils/render'

export function registerListCommand(ctx: Context, getService: () => any, config?: any): void {
  // 检查是否启用了图片输出
  const useImageOutput = config?.imageOutput === true

  ctx
    .command('docker.ls [selector]', '列出容器')
    .alias('容器列表', '查看容器', '列表')
    .option('all', '-a 列出所有容器，包括已停止', { fallback: false })
    .option('format', '-f <format> 输出格式: simple|detail|json|image', {
      fallback: null, // 由 config.imageOutput 决定
    })
    .action(async ({ options }, selector) => {
      commandLogger.debug(`docker.ls 被调用: selector=${selector}, all=${options.all}, format=${options.format}`)
      const service = getService()
      if (!service) {
        commandLogger.debug('服务未初始化')
        return 'Docker 服务未初始化'
      }

      const all = options.all ?? false
      // 如果未指定 format，使用配置的 imageOutput 设置
      const format = options.format || (useImageOutput ? 'image' : 'simple')
      commandLogger.debug(`列表参数: all=${all}, format=${format}`)

      // 图片渲染模式
      if (format === 'image') {
        commandLogger.debug('使用图片渲染模式')
        if (!ctx.puppeteer) {
          return '错误: 未安装 koishi-plugin-puppeteer 插件，无法使用图片渲染'
        }

        // 如果未指定节点，提示用户
        if (!selector) {
          return '请指定节点名称、ID 或标签，或使用 "all" 列出全部容器\n例如: docker.ls @web -f image 或 docker.ls all -f image'
        }

        try {
          // 获取容器数据
          commandLogger.debug('获取容器数据...')
          const results = await getContainerResults(service, selector, all)
          commandLogger.debug(`获取到 ${results.length} 个节点`)
          if (results.length === 0) {
            return '未发现任何容器'
          }

          // 生成并渲染
          const html = generateListHtml(results, `容器列表 (${selector})`)
          return await renderToImage(ctx, html)
        } catch (e: any) {
          commandLogger.error(`图片渲染失败: ${e.message}`)
          return `错误: ${e.message}`
        }
      }

      // 文字模式
      try {
        // 如果未指定节点，提示用户
        if (!selector) {
          return '请指定节点名称、ID 或标签，或使用 "all" 列出全部容器\n例如: docker.ls @web 或 docker.ls all'
        }

        const results = await getContainerResults(service, selector, all)
        if (results.length === 0) {
          return '所有指定节点均未连接'
        }

        const lines: string[] = []
        for (const { node, containers } of results) {
          lines.push(`=== ${node.name} ===`)
          if (containers.length === 0) {
            lines.push('  (无容器)')
          } else {
            for (const c of containers) {
              lines.push(formatContainerLine(c, format))
            }
          }
          lines.push('')
        }

        return lines.join('\n')
      } catch (e: any) {
        commandLogger.error(`列出容器失败: ${e.message}`)
        return `错误: ${e.message}`
      }
    })
}

/**
 * 获取容器数据
 */
async function getContainerResults(
  service: any,
  selector: string | undefined,
  all: boolean
): Promise<Array<{ node: any; containers: ContainerInfo[] }>> {
  const results: Array<{ node: any; containers: ContainerInfo[] }> = []

  if (selector) {
    const nodes = service.getNodesBySelector(selector)
    for (const node of nodes) {
      if (node.status !== 'connected') continue
      const containers = await node.listContainers(all)
      results.push({ node, containers })
    }
  } else {
    const aggregated = await service.getAggregatedContainers(all)
    for (const { node, containers } of aggregated) {
      if (node.status !== 'connected') continue
      results.push({ node, containers: containers || [] })
    }
  }

  return results
}

/**
 * 格式化输出单行容器信息
 */
function formatContainerLine(container: ContainerInfo, format: string): string {
  const status = container.State
  const emoji = status === 'running' ? '🟢' : (status === 'stopped' ? '🔴' : '⚪')

  const name = container.Names[0]?.replace('/', '') || 'Unknown'
  const shortId = container.Id.slice(0, 8)

  let image = container.Image
  const parts = image.split('/')
  if (parts.length > 1) {
    image = parts[parts.length - 1]
  }

  if (format === 'detail') {
    return `${emoji} **${name}**\n    ID: ${shortId}\n    Image: ${container.Image}\n    State: ${container.Status}`
  }

  // simple 模式：双行显示
  return `${emoji} ${name}\n    └ ${shortId} | ${image}`
}
