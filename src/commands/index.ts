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
import { registerUpdateCommands } from './update'
import { registerClusterCommands } from './cluster'
import { registerAuditCommands } from './audit'
import { registerPermissionCommands } from './permission'
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
  registerUpdateCommands(ctx, getService)
  registerClusterCommands(ctx, getService, config)

  // v0.1.0 新增指令
  registerAuditCommands(ctx, getService)
  registerPermissionCommands(ctx, getService)

  // 注册辅助指令
  registerHelperCommands(ctx, getService, config)
}

/**
 * 注册辅助指令
 */
function registerHelperCommands(ctx: Context, getService: GetService, config?: any): void {
  const useImageOutput = config?.imageOutput === true

  /**
   * 诊断：查看节点原始配置
   */
  ctx.command('docker.debug.config', '查看节点原始配置（诊断用）')
    .action(async () => {
      const service = getService()
      if (!service) {
        return 'Docker 服务未初始化'
      }

      const nodes = service.getAllNodes()
      if (nodes.length === 0) {
        return '未配置任何节点'
      }

      const lines: string[] = []
      lines.push('=== 节点原始配置诊断 ===\n')

      for (const node of nodes) {
        const config = (node as any).config
        lines.push(`【${config.name}】`)
        lines.push(`  ID: ${config.id}`)
        lines.push(`  Host: ${config.host}`)
        lines.push(`  Port: ${config.port} (类型: ${typeof config.port})`)
        lines.push(`  Credential: ${config.credentialId}`)
        lines.push(`  Tags: ${config.tags.join(', ') || '(无)'}`)

        // 检测异常
        if (typeof config.port === 'string') {
          if (config.port.includes('.') || config.port.includes(':')) {
            lines.push(`  ⚠️  检测到异常端口配置: 包含IP地址或特殊字符`)
          }
        } else if (typeof config.port !== 'number') {
          lines.push(`  ⚠️  检测到异常端口类型: ${typeof config.port}`)
        }
        lines.push('')
      }

      return lines.join('\n')
    })

  /**
   * 查看节点列表
   */
  ctx.command('docker.nodes', '查看节点').alias('节点列表', '节点').action(async () => {
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
    .alias('节点详情', '查看节点')
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
    .alias('查找容器', '搜索', '查找')
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
    .alias('容器执行', '执行')
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
  ctx.command('docker.help', '查看帮助').alias('帮助').action(async () => {
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
      '【更新操作】',
      '  docker.check <节点> <容器> - 检查镜像更新',
      '  docker.update <节点> <容器> [-b] - 更新容器 (-b 备份)',
      '  docker.backup <节点> <容器> [tag] - 备份容器为镜像',
      '  docker.set <节点> <容器> -e KEY=VALUE - 修改环境变量',
      '',
      '【集群操作】',
      '  docker.cluster [节点]      - 查看 Swarm 集群信息',
      '  docker.cluster.nodes [节点] - 查看集群节点 [-f image]',
      '  docker.cluster.services [节点] - 查看集群服务 [-f image]',
      '  docker.cluster.ps <节点> <服务> - 查看服务任务 [-f image]',
      '',
      '【资源操作】',
      '  docker.images <节点>       - 查看镜像列表 [-f image]',
      '  docker.networks <节点>     - 查看网络列表 [-f image]',
      '  docker.volumes <节点>      - 查看存储卷列表 [-f image]',
      '',
      '【v0.1.0 审计日志】',
      '  docker.audit.log           - 查看审计日志 [-u 用户] [-a 操作] [-r 结果] [-l 条数]',
      '  docker.audit.stats         - 审计日志统计',
      '  docker.audit.cleanup       - 清理旧日志 [-d 天数]',
      '  docker.audit.export        - 导出审计日志 (CSV)',
      '',
      '【v0.1.0 权限管理】',
      '  docker.permission.user <userId>       - 查看用户权限',
      '  docker.permission.setrole <userId> <role...> - 设置用户角色',
      '  docker.permission.addnode <userId> <nodeId> <perm...> - 添加节点权限',
      '  docker.permission.removenode <userId> <nodeId> <perm...> - 移除节点权限',
      '  docker.permission.roles              - 列出所有角色',
      '  docker.permission.check <userId> <resource> <action> - 检查权限',
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
