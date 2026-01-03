/**
 * 容器控制指令
 * docker.start / stop / restart / exec
 */
import { Command, Context } from 'koishi'
import { commandLogger } from '../utils/logger'
import { generateResultHtml, generateInspectHtml, renderToImage } from '../utils/render'

/**
 * 格式化容器搜索结果
 */
function formatSearchResults(
  results: Array<{ node: any; container: any; success: boolean; error?: string }>,
  operation: string
): string {
  const lines: string[] = []
  let successCount = 0
  let failCount = 0

  for (const r of results) {
    const status = r.success ? '✅' : '❌'
    const name = r.container.Names?.[0]?.replace('/', '') || r.container.Id?.slice(0, 8) || '?'

    if (r.success) {
      successCount++
      lines.push(`${status} ${r.node.name}: ${name}`)
    } else {
      failCount++
      lines.push(`${status} ${r.node.name}: ${name} - ${r.error}`)
    }
  }

  const summary = `共 ${results.length} 个，成功 ${successCount}，失败 ${failCount}`
  return [summary, ...lines].join('\n')
}

/**
 * 注册控制指令
 */
export function registerControlCommands(
  ctx: Context,
  getService: () => any,
  config?: any
): void {
  const useImageOutput = config?.imageOutput === true
  /**
   * 启动容器
   */
  ctx
    .command('docker.start <selector> <container>', '启动容器')
    .alias('docker启动', '容器启动', 'docker开启', '容器开启')
    .option('async', '-a 异步执行，不等待结果', { fallback: false })
    .action(async ({ options }, selector, container) => {
      commandLogger.debug(`docker.start 被调用: selector=${selector}, container=${container}`)
      const service = getService()
      if (!service) {
        commandLogger.debug('服务未初始化')
        return 'Docker 服务未初始化'
      }

      try {
        if (container === '*') {
          commandLogger.debug('批量启动容器')
          // 批量操作
          const results = await service.operateContainers(
            selector,
            container,
            'start'
          )

          if (useImageOutput && ctx.puppeteer) {
            const html = generateResultHtml(results, '批量启动结果')
            return await renderToImage(ctx, html)
          }

          return formatSearchResults(results, '启动')
        }

        // 单个容器
        commandLogger.debug(`查找容器: ${container} 在 ${selector}`)
        const { node, container: found } = await service.findContainer(
          selector,
          container
        )
        commandLogger.debug(`找到容器: ${found.Names[0]} 在节点 ${node.name}`)

        await node.startContainer(found.Id)
        commandLogger.debug(`容器已启动: ${found.Id}`)

        if (useImageOutput && ctx.puppeteer) {
          const results = [{ node, container: found, success: true }]
          const html = generateResultHtml(results, '启动成功')
          return await renderToImage(ctx, html)
        }

        const name = found.Names[0]?.replace('/', '') || found.Id.slice(0, 8)
        return `✅ ${node.name}: ${name} 已启动`
      } catch (e: any) {
        commandLogger.error(`启动容器失败: ${e.message}`)
        if (useImageOutput && ctx.puppeteer) {
          // 尝试构造一个失败的结果用于渲染，虽然这里可能没有 node/container 信息
          // 如果找不到容器，e 可能是 "找不到容器"
          return `❌ 启动失败: ${e.message}`
        }
        return `❌ 启动失败: ${e.message}`
      }
    })

  /**
   * 停止容器
   */
  ctx
    .command('docker.stop <selector> <container>', '停止容器')
    .alias('docker停止', '容器停止', 'docker关闭', '容器关闭')
    .option('async', '-a 异步执行，不等待结果', { fallback: false })
    .action(async ({ options }, selector, container) => {
      commandLogger.debug(`docker.stop 被调用: selector=${selector}, container=${container}`)
      const service = getService()
      if (!service) {
        commandLogger.debug('服务未初始化')
        return 'Docker 服务未初始化'
      }

      try {
        if (container === '*') {
          commandLogger.debug('批量停止容器')
          // 批量操作
          const results = await service.operateContainers(
            selector,
            container,
            'stop'
          )

          if (useImageOutput && ctx.puppeteer) {
            const html = generateResultHtml(results, '批量停止结果')
            return await renderToImage(ctx, html)
          }

          return formatSearchResults(results, '停止')
        }

        commandLogger.debug(`查找容器: ${container} 在 ${selector}`)
        const { node, container: found } = await service.findContainer(
          selector,
          container
        )
        commandLogger.debug(`找到容器: ${found.Names[0]} 在节点 ${node.name}`)

        await node.stopContainer(found.Id)
        commandLogger.debug(`容器已停止: ${found.Id}`)

        if (useImageOutput && ctx.puppeteer) {
          const results = [{ node, container: found, success: true }]
          const html = generateResultHtml(results, '停止成功')
          return await renderToImage(ctx, html)
        }

        const name = found.Names[0]?.replace('/', '') || found.Id.slice(0, 8)
        return `✅ ${node.name}: ${name} 已停止`
      } catch (e: any) {
        commandLogger.error(`停止容器失败: ${e.message}`)
        return `❌ 停止失败: ${e.message}`
      }
    })

  /**
   * 重启容器
   */
  ctx
    .command('docker.restart <selector> <container>', '重启容器')
    .alias('docker重启', '容器重启')
    .option('async', '-a 异步执行，不等待结果', { fallback: false })
    .action(async ({ options }, selector, container) => {
      commandLogger.debug(`docker.restart 被调用: selector=${selector}, container=${container}`)
      const service = getService()
      if (!service) {
        commandLogger.debug('服务未初始化')
        return 'Docker 服务未初始化'
      }

      try {
        if (container === '*') {
          commandLogger.debug('批量重启容器')
          // 批量操作
          const results = await service.operateContainers(
            selector,
            container,
            'restart'
          )

          if (useImageOutput && ctx.puppeteer) {
            const html = generateResultHtml(results, '批量重启结果')
            return await renderToImage(ctx, html)
          }

          return formatSearchResults(results, '重启')
        }

        commandLogger.debug(`查找容器: ${container} 在 ${selector}`)
        const { node, container: found } = await service.findContainer(
          selector,
          container
        )
        commandLogger.debug(`找到容器: ${found.Names[0]} 在节点 ${node.name}`)

        await node.restartContainer(found.Id)
        commandLogger.debug(`容器已重启: ${found.Id}`)

        if (useImageOutput && ctx.puppeteer) {
          const results = [{ node, container: found, success: true }]
          const html = generateResultHtml(results, '重启成功')
          return await renderToImage(ctx, html)
        }

        const name = found.Names[0]?.replace('/', '') || found.Id.slice(0, 8)
        return `✅ ${node.name}: ${name} 已重启`
      } catch (e: any) {
        commandLogger.error(`重启容器失败: ${e.message}`)
        return `❌ 重启失败: ${e.message}`
      }
    })

  /**
   * 查看容器详情
   */
  ctx
    .command('docker.inspect <selector> <container>', '查看容器详情')
    .alias('docker详情', '容器详情', 'docker检查', '容器检查')
    .action(async (_, selector, container) => {
      const service = getService()
      if (!service) {
        return 'Docker 服务未初始化'
      }

      try {
        const { node, container: found } = await service.findContainer(
          selector,
          container
        )

        const info = await node.getContainer(found.Id)

        if (useImageOutput && ctx.puppeteer) {
          const html = generateInspectHtml(node.name, info)
          return await renderToImage(ctx, html)
        }

        const lines = [
          `名称: ${info.Name.replace('/', '')}`,
          `ID: ${info.Id.slice(0, 12)}`,
          `镜像: ${info.Config.Image}`,
          `状态: ${info.State.Status} (运行中: ${info.State.Running})`,
          `创建时间: ${new Date(info.Created).toLocaleString()}`,
          `启动时间: ${info.State.StartedAt}`,
          `重启次数: ${info.RestartCount || 0}`,
        ]

        if (info.State.Health) {
          lines.push(`健康状态: ${info.State.Health.Status}`)
        }

        return lines.join('\n')
      } catch (e: any) {
        commandLogger.error(`查看详情失败: ${e.message}`)
        return `❌ 查看失败: ${e.message}`
      }
    })

  /**
   * 执行命令
   */
  ctx
    .command('docker.exec <selector> <container> <cmd>', '在容器内执行命令')
    .option('timeout', '-t <seconds> 超时时间(秒)', { fallback: 30 })
    .action(async ({ options }, selector, container, cmd) => {
      const service = getService()
      if (!service) {
        return 'Docker 服务未初始化'
      }

      if (!cmd) {
        return '请输入要执行的命令'
      }

      commandLogger.info(`[${selector}] 执行命令: "${cmd}"`)

      try {
        const { node, container: found } = await service.findContainer(
          selector,
          container
        )

        const result = await node.execContainer(found.Id, [
          '/bin/sh',
          '-c',
          cmd,
        ])

        const name = found.Names[0]?.replace('/', '') || found.Id.slice(0, 8)

        if (result.output.trim()) {
          return `=== ${node.name}: ${name} ===\n${result.output}`
        } else {
          return `✅ ${node.name}: ${name} - 命令执行完成（无输出）`
        }
      } catch (e: any) {
        commandLogger.error(`执行命令失败: ${e.message}`)
        return `❌ 执行失败: ${e.message}`
      }
    })
}
