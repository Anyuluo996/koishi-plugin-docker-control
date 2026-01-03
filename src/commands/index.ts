/**
 * 指令注册入口
 */
import { Context } from 'koishi'
import type { DockerControlConfig } from '../types'
import { registerListCommand } from './list'
import { registerControlCommands } from './control'
import { registerLogsCommand } from './logs'
import { generateNodesHtml, generateNodeDetailHtml, renderToImage } from '../utils/render'

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
        const version = await node.getVersion()

        if (useImageOutput && ctx.puppeteer) {
          const html = generateNodeDetailHtml(node, version)
          return await renderToImage(ctx, html)
        }

        const lines = [
          `=== ${node.name} ===`,
          `ID: ${node.id}`,
          `状态: ${node.status}`,
          `标签: ${node.tags.join(', ') || '无'}`,
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

        const result = await node.execContainer(c.Id, cmd.split(' '))

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
   * 交互式执行 (返回结果，不支持实时交互)
   */
  ctx
    .command('docker.shell <container> <cmd>', '在容器中执行命令(交互式)')
    .alias('dockershell', '容器shell')
    .option('node', '-n <node> 指定节点', { fallback: '' })
    .option('timeout', '-t <seconds> 超时时间', { fallback: 30 })
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

        const results = await service.findContainerGlobal(container)

        if (results.length === 0) {
          return `未找到容器: ${container}`
        }

        const { node, container: c } = results[0]

        if (c.State !== 'running') {
          return `容器 ${container} 未运行`
        }

        const result = await node.execContainer(c.Id, cmd.split(' '))

        return [
          `=== ${node.name}/${c.Names[0]?.replace('/', '') || c.Id.slice(0, 8)} ===`,
          `> ${cmd}`,
          ``,
          result.output || '(无输出)',
          ``,
          `[退出码: ${result.exitCode}]`,
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
      '  docker.ls [节点]           - 列出容器',
      '  docker.start <容器>        - 启动容器',
      '  docker.stop <容器>         - 停止容器',
      '  docker.restart <容器>      - 重启容器',
      '  docker.logs <容器> [-t 行数] - 查看日志',
      '  docker.find <容器>         - 搜索容器',
      '  docker.exec <容器> <命令>  - 执行命令',
      '  docker.shell <容器> <命令> - 交互式执行',
      '',
      '【节点选择器】',
      '  all        - 所有节点',
      '  @标签      - 指定标签的节点',
      '  节点ID/名称 - 指定单个节点',
      '',
      '【通知事件类型】',
      '  container.start/stop/restart/die',
      '  container.health_status',
      '  node.online/offline/error',
    ].join('\n')
  })
}
