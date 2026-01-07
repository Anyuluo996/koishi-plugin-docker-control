/**
 * Docker Compose 命令 - 展示和发送 docker compose 配置
 */
import { Context, h } from 'koishi'
import type { DockerControlConfig } from '../types'
import { renderToImage, generateComposeHtml } from '../utils/render'
import { connectorLogger } from '../utils/logger'

type GetService = () => any

/**
 * 注册 docker.compose 命令
 */
export function registerComposeCommand(
  ctx: Context,
  getService: GetService,
  config?: DockerControlConfig
): void {
  const useImageOutput = config?.imageOutput === true

  ctx
    .command('docker.compose <node> <container>', '展示 Docker Compose 配置')
    .alias('dockercompose', 'compose', 'docker-compose')
    .option('download', '-d 直接发送 compose 文件(base64编码)')
    .option('image', '-i 强制使用图片展示')
    .option('text', '-t 强制使用文字展示')
    .action(async ({ options, session }, nodeSelector, container) => {
      const service = getService()
      if (!service) {
        return 'Docker 服务未初始化'
      }

      if (!nodeSelector || !container) {
        return '请指定节点和容器: docker.compose <节点> <容器>'
      }

      // 获取节点
      const nodes = service.getNodesBySelector(nodeSelector)
      if (nodes.length === 0) {
        return `未找到节点: ${nodeSelector}`
      }

      const node = nodes[0]

      if (node.status !== 'connected') {
        return `节点 ${node.name} 未连接`
      }

      // 查找容器
      let containers
      try {
        containers = await node.listContainers(true)
      } catch (e: any) {
        return `获取容器列表失败: ${e.message}`
      }

      // 支持容器名称或 ID 前缀匹配
      const targetContainer = containers.find(c =>
        c.Names[0]?.replace('/', '') === container ||
        c.Id.startsWith(container)
      )

      if (!targetContainer) {
        return `未找到容器: ${container}`
      }

      try {
        // 获取 compose 文件信息
        const composeInfo = await node.getComposeFileInfo(targetContainer.Id)

        if (!composeInfo) {
          return `容器 ${container} 不是由 Docker Compose 启动，或无法找到 compose 文件`
        }

        // 如果指定了 -d 参数，作为文件发送
        if (options.download) {
          try {
            const filename = `${composeInfo.projectName}-docker-compose.yaml`
            const buffer = Buffer.from(composeInfo.content, 'utf-8')

            // 1. 构建 Data URI 字符串
            // 使用 application/octet-stream 以避免适配器自作聪明改文件名
            const dataUri = 'data:application/octet-stream;base64,' + buffer.toString('base64')

            // === 方案 A: 优先尝试使用 assets 服务上传 ===
            if (ctx.assets) {
              try {
                connectorLogger.debug(`[compose] 正在通过 assets 上传文件: ${filename}`)

                // 传入 Data URI 字符串
                const url = await ctx.assets.upload(dataUri, filename)
                connectorLogger.info(`[compose] Assets 上传成功: ${url}`)

                // 直接发送 URL，文件名由 assets 插件的 URL 决定
                return h.file(url)
              } catch (e: any) {
                connectorLogger.warn(`[compose] Assets 上传失败，尝试降级: ${e.message}`)
              }
            }

            // === 方案 B: 降级方案 ===
            // 失败后直接发送 Data URI
            connectorLogger.debug(`[compose] 发送 DataURI (降级): filename=${filename}`)

            return h.file(dataUri, {
              filename: filename,
              name: filename,
            })
          } catch (e: any) {
            connectorLogger.error(`[compose] 生成文件失败: ${e.message}`)
            return `生成文件失败: ${e.message}`
          }
        }

        // 判断使用图片还是文字展示
        // -i 强制图片，-t 强制文字，都没指定则根据配置
        const forceImage = options.image
        const forceText = options.text
        const shouldUseImage = forceImage || (!forceText && useImageOutput && ctx.puppeteer)

        if (shouldUseImage) {
          try {
            const html = generateComposeHtml(
              node.name,
              container,
              composeInfo.projectName,
              composeInfo.originalPath,
              composeInfo.serviceCount,
              composeInfo.content
            )
            return await renderToImage(ctx, html)
          } catch (e: any) {
            // 如果图片渲染失败，回退到文字
            if (e.message?.includes('puppeteer')) {
              return [
                `=== Docker Compose: ${composeInfo.projectName} ===`,
                `节点: ${node.name}`,
                `容器: ${container}`,
                `文件路径: ${composeInfo.originalPath}`,
                `服务数量: ${composeInfo.serviceCount}`,
                '',
                '--- compose.yaml ---',
                '',
                composeInfo.content,
              ].join('\n')
            }
            throw e
          }
        }

        // 文字展示
        return [
          `=== Docker Compose: ${composeInfo.projectName} ===`,
          `节点: ${node.name}`,
          `容器: ${container}`,
          `文件路径: ${composeInfo.originalPath}`,
          `服务数量: ${composeInfo.serviceCount}`,
          '',
          '--- compose.yaml ---',
          '',
          composeInfo.content,
        ].join('\n')
      } catch (e: any) {
        return `获取 compose 配置失败: ${e.message}`
      }
    })

  /**
   * 更新 compose 缓存命令
   */
  ctx
    .command('docker.compose.update <node> <container>', '手动更新 compose 文件缓存')
    .alias('compose.update')
    .action(async (_, nodeSelector, container) => {
      const service = getService()
      if (!service) {
        return 'Docker 服务未初始化'
      }

      if (!nodeSelector || !container) {
        return '请指定节点和容器: docker.compose.update <节点> <容器>'
      }

      // 获取节点
      const nodes = service.getNodesBySelector(nodeSelector)
      if (nodes.length === 0) {
        return `未找到节点: ${nodeSelector}`
      }

      const node = nodes[0]

      if (node.status !== 'connected') {
        return `节点 ${node.name} 未连接`
      }

      // 查找容器
      let containers
      try {
        containers = await node.listContainers(true)
      } catch (e: any) {
        return `获取容器列表失败: ${e.message}`
      }

      // 支持容器名称或 ID 前缀匹配
      const targetContainer = containers.find(c =>
        c.Names[0]?.replace('/', '') === container ||
        c.Id.startsWith(container)
      )

      if (!targetContainer) {
        return `未找到容器: ${container}`
      }

      // 更新缓存
      const result = await node.updateComposeCache(targetContainer.Id)
      return result.message
    })

  /**
   * 清除 compose 缓存命令
   */
  ctx
    .command('docker.compose.clear [node] [container]', '清除 compose 文件缓存')
    .alias('compose.clear')
    .action(async (_, nodeSelector, container) => {
      const service = getService()
      if (!service) {
        return 'Docker 服务未初始化'
      }

      if (!nodeSelector) {
        // 清除所有缓存
        let totalCleared = 0
        const nodes = service.getAllNodes()

        for (const node of nodes) {
          const result = await node.clearComposeCache()
          totalCleared += result.cleared
        }

        return totalCleared > 0
          ? `已清除所有节点的 compose 缓存 (共 ${totalCleared} 条)`
          : '没有需要清除的缓存'
      }

      // 获取节点
      const nodes = service.getNodesBySelector(nodeSelector)
      if (nodes.length === 0) {
        return `未找到节点: ${nodeSelector}`
      }

      const node = nodes[0]

      if (!container) {
        // 清除指定节点的所有缓存
        const result = await node.clearComposeCache()
        return result.message
      }

      // 查找容器
      let containers
      try {
        containers = await node.listContainers(true)
      } catch (e: any) {
        return `获取容器列表失败: ${e.message}`
      }

      // 支持容器名称或 ID 前缀匹配
      const targetContainer = containers.find(c =>
        c.Names[0]?.replace('/', '') === container ||
        c.Id.startsWith(container)
      )

      if (!targetContainer) {
        return `未找到容器: ${container}`
      }

      // 清除指定容器的缓存
      const result = await node.clearComposeCache(targetContainer.Id)
      return result.message
    })
}

