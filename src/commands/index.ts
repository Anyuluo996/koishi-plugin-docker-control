/**
 * 指令注册入口
 */
import { Context } from 'koishi'
import type { DockerControlConfig } from '../types'
import { registerListCommand } from './list'
import { registerControlCommands } from './control'
import { registerLogsCommand } from './logs'
import { registerComposeCommand } from './compose'
import { registerResourceCommands } from './resources'
import { generateNodesHtml, generateNodeDetailHtml, generateExecHtml, renderToImage } from '../utils/render'

/**
 * 获取服务的回调类型
 */
type GetService = () => any

/**
 * 注册所有指令
 */
export function registerCommands(
  ctx: Context,
  getService: GetService,
  config?: DockerControlConfig
): void {
  // 注册各模块指令
  registerListCommand(ctx, getService, config)
  registerControlCommands(ctx, getService, config)
  registerLogsCommand(ctx, getService, config)
  registerComposeCommand(ctx, getService, config)
  registerResourceCommands(ctx, getService, config)

  // 注册辅助指令
  registerHelperCommands(ctx, getService, config)
}

/**
 * 注册辅助指令
 */
function registerHelperCommands(ctx: Context, getService: GetService, config?: any): void {
  const useImageOutput = config?.imageOutput === true
  /**
   * 查看节点列表
   */
  ctx.command('docker.nodes', '查看节点').alias('docker节点', '容器节点').action(async () => {
    const service = getService()
    if (!service) {
      return 'Docker 服务未初始化'
    }

    const nodes = service.getAllNodes()
    if (nodes.length === 0) {
      return '未配置任何节点'
    }

    const online = nodes.filter((n) => n.status === 'connected').length

    if (useImageOutput && ctx.puppeteer) {
      const html = generateNodesHtml(nodes)
      return await renderToImage(ctx, html)
    }

    const lines = ['=== Docker 节点 ===']
    for (const node of nodes) {
      const statusIcon =
        node.status === 'connected'
          ? '🟢'
          : node.status === 'connecting'
            ? '🟡'
            : '🔴'
      const tags = node.tags.length > 0 ? ` [@${node.tags.join(' @')}]` : ''
      lines.push(
        `${statusIcon} ${node.name} (${node.id})${tags} - ${node.status}`
      )
    }

    lines.push(`\n总计: ${nodes.length} 个节点，${online} 个在线`)

    return lines.join('\n')
  })

  /**
   * 查看节点详情
   */
  ctx
    .command('docker.node <selector>', '查看节点详情')
    .alias('docker节点详情', '容器节点详情')
    .action(async (_, selector) => {
      const service = getService()
      if (!service) {
        return 'Docker 服务未初始化'
      }

      const nodes = service.getNodesBySelector(selector)
      if (nodes.length === 0) {
        return `未找到节点: ${selector}`
      }

      const node = nodes[0]

      try {
        const [version, systemInfo, containerCount, imageCount] = await Promise.all([
          node.getVersion(),
          node.getSystemInfo(),
          node.getContainerCount(),
          node.getImageCount(),
        ])

        // 将容器和镜像数量添加到节点对象
        const nodeData = {
          ...node,
          containerCount: containerCount.total,
          imageCount: imageCount,
        }

        if (useImageOutput && ctx.puppeteer) {
          const html = generateNodeDetailHtml(nodeData, version, systemInfo)
          return await renderToImage(ctx, html)
        }

        const memoryUsed = systemInfo?.MemTotal && systemInfo?.MemAvailable !== undefined
          ? `${Math.round((1 - systemInfo.MemAvailable / systemInfo.MemTotal) * 100)}%`
          : '-'

        const nodeName = node.config?.name || node.name || node.Name || 'Unknown'
        const nodeId = node.id || node.ID || node.Id || node.config?.id || '-'

        const lines = [
          `=== ${nodeName} ===`,
          `ID: ${nodeId}`,
          `状态: ${node.status || node.Status || 'unknown'}`,
          `标签: ${node.tags?.join(', ') || node.config?.tags?.join(', ') || '无'}`,
          `CPU: ${systemInfo?.NCPU || '-'} 核心`,
          `内存: ${memoryUsed} (可用: ${systemInfo?.MemAvailable ? Math.round(systemInfo.MemAvailable / 1024 / 1024) + ' MB' : '-'})`,
          `容器: ${containerCount.running}/${containerCount.total} 运行中`,
          `镜像: ${imageCount} 个`,
          `Docker 版本: ${version.Version}`,
          `API 版本: ${version.ApiVersion}`,
          `操作系统: ${version.Os} (${version.Arch})`,
          `内核: ${version.KernelVersion}`,
        ]

        return lines.join('\n')
      } catch (e: any) {
        return `获取节点信息失败: ${e.message}`
      }
    })

  /**
   * 搜索容器
   */
  ctx
    .command('docker.find <container>', '搜索容器')
    .alias('docker查找', '容器查找', 'docker搜索', '容器搜索')
    .option('all', '-a 包含已停止的容器', { fallback: false })
    .action(async ({ options }, container) => {
      const service = getService()
      if (!service) {
        return 'Docker 服务未初始化'
      }

      try {
        const results = await service.findContainerGlobal(container)

        if (results.length === 0) {
          return `未在任何节点找到容器: ${container}`
        }

        const lines = [`找到 ${results.length} 个匹配:`]
        for (const { node, container: c } of results) {
          const status =
            c.State === 'running' ? '🟢' : '🔴'
          const name = c.Names[0]?.replace('/', '') || c.Id.slice(0, 8)
          lines.push(`${status} ${node.name}: ${name} (${c.Id.slice(0, 12)})`)
        }

        return lines.join('\n')
      } catch (e: any) {
        return `搜索失败: ${e.message}`
      }
    })

  /**
   * 执行命令 (一次性)
   */
  ctx
    .command('docker.exec <container> <cmd>', '在容器中执行命令')
    .alias('docker执行', '容器执行', 'dockerexec', 'dockercmd', 'docker命令', '容器命令')
    .option('node', '-n <node> 指定节点', { fallback: '' })
    .action(async ({ options }, container, cmd) => {
      const service = getService()
      if (!service) {
        return 'Docker 服务未初始化'
      }

      const nodeSelector = options.node || 'all'

      try {
        const nodes = service.getNodesBySelector(nodeSelector)
        if (nodes.length === 0) {
          return `未找到节点: ${nodeSelector}`
        }

        // 在匹配的节点上搜索容器
        const results = await service.findContainerGlobal(container)

        if (results.length === 0) {
          return `未找到容器: ${container}`
        }

        // 在第一个匹配的节点和容器上执行
        const { node, container: c } = results[0]

        if (c.State !== 'running') {
          return `容器 ${container} 未运行`
        }

        const result = await node.execContainer(c.Id, cmd)

        return [
          `=== 执行结果 ===`,
          `退出码: ${result.exitCode}`,
          '',
          result.output || '(无输出)',
        ].join('\n')
      } catch (e: any) {
        return `执行失败: ${e.message}`
      }
    })

  /**
   * 查看帮助
   */
  ctx.command('docker.help', '查看帮助').alias('docker帮助', 'docker帮助', '容器帮助').action(async () => {
    return [
      '=== Docker Control 帮助 ===',
      '',
      '【节点操作】',
      '  docker.nodes               - 查看节点列表',
      '  docker.node <节点>         - 查看节点详情',
      '',
      '【容器操作】',
      '  docker.ls <节点>           - 列出容器 [-f image]',
      '  docker.start <节点> <容器> - 启动容器',
      '  docker.stop <节点> <容器>  - 停止容器',
      '  docker.restart <节点> <容器> - 重启容器',
      '  docker.logs <节点> <容器> [-n 行数] - 查看日志',
      '  docker.inspect <节点> <容器> - 查看容器详情',
      '  docker.exec <节点> <容器> <命令> - 在容器内执行命令',
      '',
      '【资源操作】',
      '  docker.images <节点>       - 查看镜像列表 [-f image]',
      '  docker.networks <节点>     - 查看网络列表 [-f image]',
      '  docker.volumes <节点>      - 查看存储卷列表 [-f image]',
      '',
      '【节点选择器】',
      '  all        - 所有节点',
      '  @标签      - 指定标签的节点',
      '  节点ID/名称 - 指定单个节点',
      '',
      '【输出格式】',
      '  -f simple   - 文本格式（默认）',
      '  -f image    - 图片格式（需要 puppeteer 插件）',
      '',
      '【通知事件类型】',
      '  container.start/stop/restart/die',
      '  container.health_status',
      '  node.online/offline/error',
    ].join('\n')
  })
}
