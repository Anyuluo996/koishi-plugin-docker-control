/**
 * 列出容器指令
 * docker.ls - 支持集群视图和图片渲染
 */
import { Command, Context, Fragment, h, Session } from 'koishi'
import type { ContainerInfo } from '../types'
import { commandLogger } from '../utils/logger'

export function registerListCommand(ctx: Context, getService: () => any, config?: any): void {
  // 检查是否启用了图片输出
  const useImageOutput = config?.imageOutput === true

  ctx
    .command('docker.ls [selector]', '列出容器')
    .alias('docker列表', '容器列表', 'dockercs', '容器查看', 'docker查看')
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

        try {
          // 获取容器数据
          commandLogger.debug('获取容器数据...')
          const results = await getContainerResults(service, selector, all)
          commandLogger.debug(`获取到 ${results.length} 个节点`)
          if (results.length === 0) {
            return '未发现任何容器'
          }

          // 生成 HTML
          const html = generateHtml(results)
          // 渲染图片 (puppeteer.render 返回的是 h.image() 元素的字符串)
          commandLogger.debug('渲染图片中...')
          const imageElement = await ctx.puppeteer.render(html, async (page, next) => {
            await page.setViewport({ width: 600, height: 800 })
            const body = await page.$('body')
            const clip = await body.boundingBox()
            const buffer = await page.screenshot({ clip })
            return h.image(buffer, 'image/png').toString()
          })

          return imageElement
        } catch (e: any) {
          commandLogger.error(`图片渲染失败: ${e.message}`)
          return `错误: ${e.message}`
        }
      }

      // 文字模式
      try {
        const results = await getContainerResults(service, selector, all)
        if (results.length === 0) {
          return selector ? '所有指定节点均未连接' : '未发现任何容器'
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

/**
 * 生成 HTML 模板
 */
function generateHtml(results: Array<{ node: any; containers: ContainerInfo[] }>): string {
  const styles = `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      padding: 20px;
      color: #fff;
    }
    .container {
      max-width: 700px;
      margin: 0 auto;
    }
    .node-section {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      margin-bottom: 20px;
      overflow: hidden;
    }
    .node-header {
      background: rgba(79, 172, 254, 0.3);
      padding: 12px 16px;
      font-size: 16px;
      font-weight: 600;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }
    .table-header {
      display: grid;
      grid-template-columns: 40px 1fr 100px 1fr;
      gap: 10px;
      padding: 10px 16px;
      background: rgba(0, 0, 0, 0.2);
      font-size: 12px;
      color: rgba(255, 255, 255, 0.6);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .row {
      display: grid;
      grid-template-columns: 40px 1fr 100px 1fr;
      gap: 10px;
      padding: 10px 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      align-items: center;
      transition: background 0.2s;
    }
    .row:hover {
      background: rgba(255, 255, 255, 0.05);
    }
    .row:last-child {
      border-bottom: none;
    }
    .status {
      font-size: 18px;
      text-align: center;
    }
    .name {
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .id {
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 12px;
      color: rgba(255, 255, 255, 0.7);
    }
    .image {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.7);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .running { color: #4ade80; }
    .stopped { color: #f87171; }
    .other { color: #94a3b8; }
    .stats {
      display: flex;
      justify-content: center;
      gap: 20px;
      padding: 16px;
      color: rgba(255, 255, 255, 0.6);
      font-size: 13px;
    }
  `

  let html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${styles}</style></head><body>`
  html += `<div class="container">`

  let totalRunning = 0
  let totalStopped = 0

  for (const { node, containers } of results) {
    const running = containers.filter(c => c.State === 'running').length
    const stopped = containers.length - running
    totalRunning += running
    totalStopped += stopped

    html += `<div class="node-section">`
    html += `<div class="node-header">${node.name}</div>`

    // 表头
    html += `<div class="table-header">
      <span></span>
      <span>容器</span>
      <span>ID</span>
      <span>镜像</span>
    </div>`

    // 容器列表
    for (const c of containers) {
      const status = c.State
      const emoji = status === 'running' ? '🟢' : (status === 'stopped' ? '🔴' : '⚪')
      const name = c.Names[0]?.replace('/', '') || 'Unknown'
      const shortId = c.Id.slice(0, 8)

      let image = c.Image
      const parts = image.split('/')
      if (parts.length > 1) {
        image = parts[parts.length - 1]
      }

      html += `<div class="row">
        <span class="status">${emoji}</span>
        <span class="name" title="${name}">${name}</span>
        <span class="id">${shortId}</span>
        <span class="image" title="${image}">${image}</span>
      </div>`
    }

    // 统计
    html += `<div class="stats">运行中: ${running} | 已停止: ${stopped}</div>`
    html += `</div>`
  }

  // 总体统计
  html += `<div class="node-section">`
  html += `<div class="stats"><strong>总计:</strong> ${totalRunning} 运行中, ${totalStopped} 已停止</div>`
  html += `</div>`

  html += `</div></body></html>`

  return html
}
