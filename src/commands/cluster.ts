/**
 * Docker Swarm 集群管理指令
 */
import { Context } from 'koishi'
import { commandLogger } from '../utils/logger'
import {
  generateSwarmInfoHtml,
  generateSwarmNodesHtml,
  generateSwarmServicesHtml,
  generateSwarmTasksHtml,
  renderToImage
} from '../utils/render'

export function registerClusterCommands(
  ctx: Context,
  getService: () => any,
  config?: any
) {
  const useImageOutput = config?.imageOutput === true

  /**
   * 查看集群信息
   */
  ctx.command('docker.cluster [selector]', '查看 Swarm 集群信息')
    .alias('集群', 'swarm', 'docker集群')
    .action(async (_, selector) => {
      commandLogger.debug(`docker.cluster 被调用: selector=${selector}`)
      const service = getService()
      if (!service) return '❌ 服务未初始化'

      const nodes = service.getNodesBySelector(selector || '')
      if (nodes.length === 0) return `❌ 未找到节点: ${selector}`

      const lines: string[] = []

      for (const node of nodes) {
        if (node.status !== 'connected') {
          lines.push(`=== ${node.name} ===`)
          lines.push('  (未连接)')
          lines.push('')
          continue
        }

        // 检查是否在 Swarm 模式
        const isSwarm = await node.isSwarmMode()
        if (!isSwarm) {
          lines.push(`=== ${node.name} ===`)
          lines.push('  (不在 Swarm 模式)')
          lines.push('')
          continue
        }

        const swarmInfo = await node.getSwarmInfo()
        if (!swarmInfo) {
          lines.push(`=== ${node.name} ===`)
          lines.push('  (无法获取集群信息)')
          lines.push('')
          continue
        }

        lines.push(`=== ${node.name} ===`)
        lines.push(`  集群 ID: ${swarmInfo.id}`)
        lines.push(`  集群名称: ${swarmInfo.name}`)
        lines.push(`  创建时间: ${swarmInfo.createdAt}`)
        lines.push(`  更新时间: ${swarmInfo.updatedAt}`)
        lines.push('')
      }

      return lines.join('\n').trim()
    })

  /**
   * 查看集群节点列表
   */
  ctx.command('docker.cluster.nodes [selector]', '查看 Swarm 集群节点')
    .alias('集群节点', 'swarm节点', 'swarm节点')
    .option('format', '-f <format> 输出格式: simple|image', { fallback: null })
    .action(async ({ options }, selector) => {
      commandLogger.debug(`docker.cluster.nodes 被调用: selector=${selector}, format=${options.format}`)
      const service = getService()
      if (!service) return '❌ 服务未初始化'

      const nodes = service.getNodesBySelector(selector || '')
      if (nodes.length === 0) return `❌ 未找到节点: ${selector}`

      const format = options.format || (useImageOutput ? 'image' : 'simple')

      // 图片渲染模式
      if (format === 'image') {
        if (!ctx.puppeteer) return '❌ 未安装 puppeteer 插件'

        try {
          const results = []
          for (const node of nodes) {
            if (node.status !== 'connected') continue

            const isSwarm = await node.isSwarmMode()
            if (!isSwarm) continue

            const swarmNodes = await node.getSwarmNodes()
            if (swarmNodes.length > 0) {
              results.push({ node, swarmNodes })
            }
          }

          if (results.length === 0) return '❌ 未找到任何 Swarm 集群节点'

          const html = generateSwarmNodesHtml(results, '集群节点')
          return await renderToImage(ctx, html)
        } catch (e: any) {
          commandLogger.error(`获取集群节点失败: ${e.message}`)
          return `❌ 错误: ${e.message}`
        }
      }

      // 文字模式
      const lines: string[] = []
      for (const node of nodes) {
        if (node.status !== 'connected') {
          lines.push(`=== ${node.name} ===`)
          lines.push('  (未连接)')
          lines.push('')
          continue
        }

        const isSwarm = await node.isSwarmMode()
        if (!isSwarm) {
          lines.push(`=== ${node.name} ===`)
          lines.push('  (不在 Swarm 模式)')
          lines.push('')
          continue
        }

        const swarmNodes = await node.getSwarmNodes()
        lines.push(`=== ${node.name} (${swarmNodes.length} 个节点) ===`)

        if (swarmNodes.length === 0) {
          lines.push('  (无节点)')
        } else {
          for (const n of swarmNodes) {
            const shortId = n.ID.slice(0, 12)
            const isLeader = n.ManagerStatus?.Leader ? ' 👑' : ''
            const statusIcon = n.Status.State === 'ready' ? '🟢' : '🔴'
            lines.push(`  ${isLeader}${n.Hostname} (${n.Role})`)
            lines.push(`    ID: ${shortId}`)
            lines.push(`    状态: ${statusIcon} ${n.Status.State} | 可用性: ${n.Availability}`)
            lines.push(`    地址: ${n.Status.Addr}`)
            if (n.ManagerStatus?.Reachability) {
              lines.push(`    管理可达性: ${n.ManagerStatus.Reachability}`)
            }
          }
        }
        lines.push('')
      }

      return lines.join('\n').trim()
    })

  /**
   * 查看集群服务列表
   */
  ctx.command('docker.cluster.services [selector]', '查看 Swarm 集群服务')
    .alias('集群服务', 'swarm服务', '集群services')
    .option('format', '-f <format> 输出格式: simple|image', { fallback: null })
    .action(async ({ options }, selector) => {
      commandLogger.debug(`docker.cluster.services 被调用: selector=${selector}, format=${options.format}`)
      const service = getService()
      if (!service) return '❌ 服务未初始化'

      const nodes = service.getNodesBySelector(selector || '')
      if (nodes.length === 0) return `❌ 未找到节点: ${selector}`

      const format = options.format || (useImageOutput ? 'image' : 'simple')

      // 图片渲染模式
      if (format === 'image') {
        if (!ctx.puppeteer) return '❌ 未安装 puppeteer 插件'

        try {
          const results = []
          for (const node of nodes) {
            if (node.status !== 'connected') continue

            const isSwarm = await node.isSwarmMode()
            if (!isSwarm) continue

            const services = await node.getSwarmServices()
            if (services.length > 0) {
              results.push({ node, services })
            }
          }

          if (results.length === 0) return '❌ 未找到任何 Swarm 服务'

          const html = generateSwarmServicesHtml(results, '集群服务')
          return await renderToImage(ctx, html)
        } catch (e: any) {
          commandLogger.error(`获取集群服务失败: ${e.message}`)
          return `❌ 错误: ${e.message}`
        }
      }

      // 文字模式
      const lines: string[] = []
      for (const node of nodes) {
        if (node.status !== 'connected') {
          lines.push(`=== ${node.name} ===`)
          lines.push('  (未连接)')
          lines.push('')
          continue
        }

        const isSwarm = await node.isSwarmMode()
        if (!isSwarm) {
          lines.push(`=== ${node.name} ===`)
          lines.push('  (不在 Swarm 模式)')
          lines.push('')
          continue
        }

        const services = await node.getSwarmServices()
        lines.push(`=== ${node.name} (${services.length} 个服务) ===`)

        if (services.length === 0) {
          lines.push('  (无服务)')
        } else {
          for (const s of services) {
            const shortId = s.ID.slice(0, 12)
            const imageName = s.Image.split('@')[0]
            lines.push(`  ${s.Name}`)
            lines.push(`    ID: ${shortId} | 副本: ${s.Replicas} | 镜像: ${imageName}`)
            if (s.Ports !== '-') {
              lines.push(`    端口: ${s.Ports}`)
            }
          }
        }
        lines.push('')
      }

      return lines.join('\n').trim()
    })

  /**
   * 查看集群服务任务
   */
  ctx.command('docker.cluster.ps <selector> <service>', '查看 Swarm 服务任务')
    .alias('集群任务', 'swarm任务', 'swarmps', '集群ps')
    .option('format', '-f <format> 输出格式: simple|image', { fallback: null })
    .action(async ({ options }, selector, serviceName) => {
      commandLogger.debug(`docker.cluster.ps 被调用: selector=${selector}, service=${serviceName}`)
      const service = getService()
      if (!service) return '❌ 服务未初始化'

      if (!serviceName) {
        return '⚠️ 请指定服务名称\n例如: 集群任务 yun my-service'
      }

      const nodes = service.getNodesBySelector(selector || '')
      if (nodes.length === 0) return `❌ 未找到节点: ${selector}`

      const format = options.format || (useImageOutput ? 'image' : 'simple')

      // 图片渲染模式
      if (format === 'image') {
        if (!ctx.puppeteer) return '❌ 未安装 puppeteer 插件'

        try {
          const results = []
          for (const node of nodes) {
            if (node.status !== 'connected') continue

            const isSwarm = await node.isSwarmMode()
            if (!isSwarm) continue

            const tasks = await node.getSwarmTasks(serviceName)
            if (tasks.length > 0) {
              results.push({ node, serviceName, tasks })
            }
          }

          if (results.length === 0) return `❌ 未找到服务 "${serviceName}" 的任务`

          const html = generateSwarmTasksHtml(results, `集群任务 - ${serviceName}`)
          return await renderToImage(ctx, html)
        } catch (e: any) {
          commandLogger.error(`获取集群任务失败: ${e.message}`)
          return `❌ 错误: ${e.message}`
        }
      }

      // 文字模式
      const lines: string[] = []
      for (const node of nodes) {
        if (node.status !== 'connected') {
          lines.push(`=== ${node.name} ===`)
          lines.push('  (未连接)')
          lines.push('')
          continue
        }

        const isSwarm = await node.isSwarmMode()
        if (!isSwarm) {
          lines.push(`=== ${node.name} ===`)
          lines.push('  (不在 Swarm 模式)')
          lines.push('')
          continue
        }

        const tasks = await node.getSwarmTasks(serviceName)
        lines.push(`=== ${node.name} (${tasks.length} 个任务) ===`)

        if (tasks.length === 0) {
          lines.push(`  (服务 "${serviceName}" 无任务或不存在)`)
        } else {
          for (const t of tasks) {
            const shortId = t.ID.slice(0, 12)
            const statusIcon = t.Status.State === 'running' ? '🟢' :
                              t.Status.State === 'pending' ? '⏳' :
                              t.Status.State === 'failed' ? '❌' : '⚪'
            lines.push(`  ${statusIcon} Slot ${t.Slot} | ${t.Status.State}`)
            lines.push(`    ID: ${shortId}`)
            lines.push(`    节点: ${t.NodeID} | 期望状态: ${t.DesiredState}`)
            lines.push(`    时间: ${t.Status.Since}`)
          }
        }
        lines.push('')
      }

      return lines.join('\n').trim()
    })
}
