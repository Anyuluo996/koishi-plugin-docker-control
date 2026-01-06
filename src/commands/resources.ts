/**
 * 资源列表指令（镜像、网络、存储卷）
 */
import { Context } from 'koishi'
import { commandLogger } from '../utils/logger'
import { generateImagesHtml, generateNetworksHtml, generateVolumesHtml, renderToImage } from '../utils/render'

export function registerResourceCommands(ctx: Context, getService: () => any, config?: any): void {
  // 检查是否启用了图片输出
  const useImageOutput = config?.imageOutput === true

  /**
   * 查看镜像列表
   */
  ctx
    .command('docker.images [selector]', '查看镜像列表')
    .alias('docker镜像', '镜像列表', 'docker镜像列表')
    .option('format', '-f <format> 输出格式: simple|image', {
      fallback: null, // 由 config.imageOutput 决定
    })
    .action(async ({ options }, selector) => {
      commandLogger.debug(`docker.images 被调用: selector=${selector}, format=${options.format}`)
      const service = getService()
      if (!service) {
        commandLogger.debug('服务未初始化')
        return 'Docker 服务未初始化'
      }

      if (!selector) {
        return '请指定节点名称、ID 或标签，或使用 "all" 列出全部镜像\n例如: docker.images @web 或 docker.images all'
      }

      const format = options.format || (useImageOutput ? 'image' : 'simple')

      // 图片渲染模式
      if (format === 'image') {
        commandLogger.debug('使用图片渲染模式')
        if (!ctx.puppeteer) {
          return '错误: 未安装 koishi-plugin-puppeteer 插件，无法使用图片渲染'
        }

        try {
          const nodes = service.getNodesBySelector(selector)
          if (nodes.length === 0) {
            return `未找到节点: ${selector}`
          }

          const results = []
          for (const node of nodes) {
            if (node.status !== 'connected') continue
            const images = await node.listImages()
            results.push({ node, images })
          }

          if (results.length === 0) {
            return '所有指定节点均未连接'
          }

          const html = generateImagesHtml(results, `镜像列表 (${selector})`)
          return await renderToImage(ctx, html)
        } catch (e: any) {
          commandLogger.error(`图片渲染失败: ${e.message}`)
          return `错误: ${e.message}`
        }
      }

      // 文字模式
      try {
        const nodes = service.getNodesBySelector(selector)
        if (nodes.length === 0) {
          return `未找到节点: ${selector}`
        }

        const lines: string[] = []

        for (const node of nodes) {
          if (node.status !== 'connected') {
            lines.push(`=== ${node.name} ===`)
            lines.push('  (未连接)')
            lines.push('')
            continue
          }

          const images = await node.listImages()
          lines.push(`=== ${node.name} (${images.length} 个镜像) ===`)

          if (images.length === 0) {
            lines.push('  (无镜像)')
          } else {
            for (const img of images) {
              const shortId = img.Id.slice(0, 12)
              const tag = img.Tag === '<none>' ? '<none>' : img.Tag
              lines.push(`  ${img.Repository}:${tag}`)
              lines.push(`    ID: ${shortId} | 大小: ${img.Size} | 创建: ${img.Created}`)
            }
          }
          lines.push('')
        }

        return lines.join('\n').trim()
      } catch (e: any) {
        commandLogger.error(`列出镜像失败: ${e.message}`)
        return `错误: ${e.message}`
      }
    })

  /**
   * 查看网络列表
   */
  ctx
    .command('docker.networks [selector]', '查看网络列表')
    .alias('docker网络', '网络列表', 'docker网络列表')
    .option('format', '-f <format> 输出格式: simple|image', {
      fallback: null, // 由 config.imageOutput 决定
    })
    .action(async ({ options }, selector) => {
      commandLogger.debug(`docker.networks 被调用: selector=${selector}, format=${options.format}`)
      const service = getService()
      if (!service) {
        commandLogger.debug('服务未初始化')
        return 'Docker 服务未初始化'
      }

      if (!selector) {
        return '请指定节点名称、ID 或标签，或使用 "all" 列出全部网络\n例如: docker.networks @web 或 docker.networks all'
      }

      const format = options.format || (useImageOutput ? 'image' : 'simple')

      // 图片渲染模式
      if (format === 'image') {
        commandLogger.debug('使用图片渲染模式')
        if (!ctx.puppeteer) {
          return '错误: 未安装 koishi-plugin-puppeteer 插件，无法使用图片渲染'
        }

        try {
          const nodes = service.getNodesBySelector(selector)
          if (nodes.length === 0) {
            return `未找到节点: ${selector}`
          }

          const results = []
          for (const node of nodes) {
            if (node.status !== 'connected') continue
            const networks = await node.listNetworks()
            results.push({ node, networks })
          }

          if (results.length === 0) {
            return '所有指定节点均未连接'
          }

          const html = generateNetworksHtml(results, `网络列表 (${selector})`)
          return await renderToImage(ctx, html)
        } catch (e: any) {
          commandLogger.error(`图片渲染失败: ${e.message}`)
          return `错误: ${e.message}`
        }
      }

      // 文字模式
      try {
        const nodes = service.getNodesBySelector(selector)
        if (nodes.length === 0) {
          return `未找到节点: ${selector}`
        }

        const lines: string[] = []

        for (const node of nodes) {
          if (node.status !== 'connected') {
            lines.push(`=== ${node.name} ===`)
            lines.push('  (未连接)')
            lines.push('')
            continue
          }

          const networks = await node.listNetworks()
          lines.push(`=== ${node.name} (${networks.length} 个网络) ===`)

          if (networks.length === 0) {
            lines.push('  (无网络)')
          } else {
            for (const net of networks) {
              const shortId = net.Id.slice(0, 12)
              lines.push(`  ${net.Name}`)
              lines.push(`    ID: ${shortId} | 驱动: ${net.Driver} | 范围: ${net.Scope}`)
              if (net.Subnet !== '-') {
                lines.push(`    子网: ${net.Subnet} | 网关: ${net.Gateway}`)
              }
            }
          }
          lines.push('')
        }

        return lines.join('\n').trim()
      } catch (e: any) {
        commandLogger.error(`列出网络失败: ${e.message}`)
        return `错误: ${e.message}`
      }
    })

  /**
   * 查看存储卷列表
   */
  ctx
    .command('docker.volumes [selector]', '查看存储卷列表')
    .alias('docker卷', 'docker存储卷', '存储卷列表', 'docker存储卷列表')
    .option('format', '-f <format> 输出格式: simple|image', {
      fallback: null, // 由 config.imageOutput 决定
    })
    .action(async ({ options }, selector) => {
      commandLogger.debug(`docker.volumes 被调用: selector=${selector}, format=${options.format}`)
      const service = getService()
      if (!service) {
        commandLogger.debug('服务未初始化')
        return 'Docker 服务未初始化'
      }

      if (!selector) {
        return '请指定节点名称、ID 或标签，或使用 "all" 列出全部存储卷\n例如: docker.volumes @web 或 docker.volumes all'
      }

      const format = options.format || (useImageOutput ? 'image' : 'simple')

      // 图片渲染模式
      if (format === 'image') {
        commandLogger.debug('使用图片渲染模式')
        if (!ctx.puppeteer) {
          return '错误: 未安装 koishi-plugin-puppeteer 插件，无法使用图片渲染'
        }

        try {
          const nodes = service.getNodesBySelector(selector)
          if (nodes.length === 0) {
            return `未找到节点: ${selector}`
          }

          const results = []
          for (const node of nodes) {
            if (node.status !== 'connected') continue
            const volumes = await node.listVolumes()
            results.push({ node, volumes })
          }

          if (results.length === 0) {
            return '所有指定节点均未连接'
          }

          const html = generateVolumesHtml(results, `存储卷列表 (${selector})`)
          return await renderToImage(ctx, html)
        } catch (e: any) {
          commandLogger.error(`图片渲染失败: ${e.message}`)
          return `错误: ${e.message}`
        }
      }

      // 文字模式
      try {
        const nodes = service.getNodesBySelector(selector)
        if (nodes.length === 0) {
          return `未找到节点: ${selector}`
        }

        const lines: string[] = []

        for (const node of nodes) {
          if (node.status !== 'connected') {
            lines.push(`=== ${node.name} ===`)
            lines.push('  (未连接)')
            lines.push('')
            continue
          }

          const volumes = await node.listVolumes()
          lines.push(`=== ${node.name} (${volumes.length} 个存储卷) ===`)

          if (volumes.length === 0) {
            lines.push('  (无存储卷)')
          } else {
            for (const vol of volumes) {
              lines.push(`  ${vol.Name}`)
              lines.push(`    驱动: ${vol.Driver} | 范围: ${vol.Scope}`)
              if (vol.Mountpoint !== '-') {
                lines.push(`    挂载点: ${vol.Mountpoint}`)
              }
              if (vol.Size !== '-') {
                lines.push(`    大小: ${vol.Size}`)
              }
            }
          }
          lines.push('')
        }

        return lines.join('\n').trim()
      } catch (e: any) {
        commandLogger.error(`列出存储卷失败: ${e.message}`)
        return `错误: ${e.message}`
      }
    })
}
