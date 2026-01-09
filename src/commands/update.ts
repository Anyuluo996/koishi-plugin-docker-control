/**
 * 容器更新相关指令（检查更新、备份、修改环境变量）
 */
import { Context } from 'koishi'
import { commandLogger } from '../utils/logger'

export function registerUpdateCommands(
  ctx: Context,
  getService: () => any
) {
  // 1. 检查更新指令
  ctx.command('docker.check <node> <container>', '检查容器镜像更新')
    .alias('容器检查更新', '容器检测更新', '检测更新', '检查更新')
    .action(async ({ session }, nodeSelector, container) => {
      commandLogger.debug(`docker.check 被调用: node=${nodeSelector}, container=${container}`)
      const service = getService()
      if (!service) return '❌ 服务未初始化'

      const nodes = service.getNodesBySelector(nodeSelector || '')
      if (nodes.length === 0) return `❌ 未找到节点: ${nodeSelector}`
      const node = nodes[0]

      if (node.status !== 'connected') {
        return `❌ 节点未连接: ${node.name}`
      }

      // 查找容器
      const containers = await node.listContainers(true)
      const target = containers.find(c => c.Names[0]?.replace('/', '') === container || c.Id.startsWith(container))
      if (!target) return `❌ 未找到容器: ${container}`

      await session?.send(`🔍 正在检查镜像更新: ${target.Image}...`)

      try {
        const result = await node.checkImageUpdate(target.Id)

        if (result.hasUpdate) {
          return [
            `🟢 发现新版本!`,
            `镜像: ${result.image}`,
            `当前ID: ${result.currentId.slice(0, 12)}`,
            `最新ID: ${result.remoteId.slice(0, 12)}`,
            '',
            `💡 发送 "容器更新 ${node.name} ${target.Names[0].replace('/', '')}" 进行更新`
          ].join('\n')
        } else {
          return `⚪ 当前已是最新版本 (${result.currentId.slice(0, 12)})`
        }
      } catch (e: any) {
        commandLogger.error(`检查更新失败: ${e.message}`)
        return `❌ 检查失败: ${e.message}`
      }
    })

  // 2. 更新容器指令
  ctx.command('docker.update <node> <container>', '更新容器到最新镜像')
    .alias('容器更新', '更新')
    .option('backup', '-b 备份当前容器 (创建镜像)')
    .action(async ({ session, options }, nodeSelector, container) => {
      commandLogger.debug(`docker.update 被调用: node=${nodeSelector}, container=${container}, backup=${options?.backup}`)
      const service = getService()
      if (!service) return '❌ 服务未初始化'

      const nodes = service.getNodesBySelector(nodeSelector || '')
      if (nodes.length === 0) return `❌ 未找到节点: ${nodeSelector}`
      const node = nodes[0]

      if (node.status !== 'connected') {
        return `❌ 节点未连接: ${node.name}`
      }

      const containers = await node.listContainers(true)
      const target = containers.find(c => c.Names[0]?.replace('/', '') === container || c.Id.startsWith(container))
      if (!target) return `❌ 未找到容器: ${container}`

      const containerName = target.Names[0].replace('/', '')
      await session?.send(`🚀 开始更新流程: ${containerName}`)

      try {
        // 1. 检查镜像是否有更新
        await session?.send(`🔍 正在检查镜像更新...`)
        const checkResult = await node.checkImageUpdate(target.Id)

        if (!checkResult.hasUpdate) {
          return `⚪ 当前已是最新版本\n当前镜像 ID: ${checkResult.currentId.slice(0, 12)}`
        }

        await session?.send(`🟢 发现新版本！\n当前: ${checkResult.currentId.slice(0, 12)}\n最新: ${checkResult.remoteId.slice(0, 12)}`)

        // 2. 备份 (如果指定了 -b)
        if (options?.backup) {
          await session?.send(`📦 正在备份...`)
          const backupResult = await node.backupContainer(target.Id)
          if (backupResult.success) {
            await session?.send(`✅ ${backupResult.reason}: ${backupResult.backupTag}`)
          } else {
            await session?.send(`⚠️ ${backupResult.reason}: ${backupResult.backupTag}`)
          }
        }

        // 3. 拉取最新镜像（此时镜像已经在 checkImageUpdate 中拉取完成）
        await session?.send(`✅ 镜像已就绪，开始更新容器...`)

        // 4. 重建容器
        await session?.send(`🔄 正在重建容器...`)
        const result = await node.recreateContainer(target.Id, {}, true)

        if (result.success) {
          const messages = [
            `✅ 更新成功!`,
            `新容器 ID: ${result.newId?.slice(0, 12)}`,
            ``,
            `📦 旧容器已保留: ${result.oldContainerName}`,
            `💡 请手动检查并删除旧容器: docker rm ${result.oldContainerName}`
          ]
          return messages.join('\n')
        } else {
          return `❌ 更新失败: ${result.error}`
        }
      } catch (e: any) {
        commandLogger.error(`更新容器失败: ${e.message}`)
        return `❌ 操作异常: ${e.message}`
      }
    })

  // 3. 修改环境变量指令
  ctx.command('docker.set <node> <container> [-e]', '修改容器环境变量')
    .alias('容器设置', '容器修改', '设置环境变量', '修改环境变量')
    .option('env', '-e <env> 设置环境变量 (KEY=VALUE)')
    .action(async ({ session, options }, nodeSelector, container) => {
      commandLogger.debug(`docker.set 被调用: node=${nodeSelector}, container=${container}, env=${options?.env}`)
      const service = getService()
      if (!service) return '❌ 服务未初始化'

      // 检查参数
      if (!options?.env) {
        return '⚠️ 请使用 -e KEY=VALUE 指定环境变量\n例如: 容器设置 yun redis -e PORT=6380 -e PASS=123\n    或: 容器设置 yun redis -e PORT=6380,PASS=123'
      }

      const nodes = service.getNodesBySelector(nodeSelector || '')
      if (nodes.length === 0) return `❌ 未找到节点: ${nodeSelector}`
      const node = nodes[0]

      if (node.status !== 'connected') {
        return `❌ 节点未连接: ${node.name}`
      }

      const containers = await node.listContainers(true)
      const target = containers.find(c => c.Names[0]?.replace('/', '') === container || c.Id.startsWith(container))
      if (!target) return `❌ 未找到容器: ${container}`

      const containerName = target.Names[0].replace('/', '')
      await session?.send(`📝 正在修改环境变量并重建容器 ${containerName}...`)

      try {
        // 解析环境变量（支持多个 -e 参数通过逗号分隔）
        const envList = options.env.split(',').map((e: string) => e.trim()).filter(Boolean)

        // 调用 node.ts 中的重建方法，传入新的环境变量数组
        const result = await node.recreateContainer(target.Id, {
          env: envList
        })

        if (result.success) {
          const messages = [
            `✅ 修改成功!`,
            `新容器 ID: ${result.newId?.slice(0, 12)}`,
            ``,
            `📦 旧容器已保留: ${result.oldContainerName}`,
            `💡 请手动检查并删除旧容器: docker rm ${result.oldContainerName}`
          ]
          return messages.join('\n')
        } else {
          return `❌ 修改失败: ${result.error}`
        }
      } catch (e: any) {
        commandLogger.error(`修改环境变量失败: ${e.message}`)
        return `❌ 操作异常: ${e.message}`
      }
    })

  // 4. 备份容器指令
  ctx.command('docker.backup <node> <container> [tag]', '备份容器为镜像')
    .alias('容器备份', '备份')
    .action(async (_, nodeSelector, container, tag) => {
      commandLogger.debug(`docker.backup 被调用: node=${nodeSelector}, container=${container}, tag=${tag}`)
      const service = getService()
      if (!service) return '❌ 服务未初始化'

      const nodes = service.getNodesBySelector(nodeSelector || '')
      if (nodes.length === 0) return `❌ 未找到节点: ${nodeSelector}`
      const node = nodes[0]

      if (node.status !== 'connected') {
        return `❌ 节点未连接: ${node.name}`
      }

      const containers = await node.listContainers(true)
      const target = containers.find(c => c.Names[0]?.replace('/', '') === container || c.Id.startsWith(container))
      if (!target) return `❌ 未找到容器: ${container}`

      try {
        const result = await node.backupContainer(target.Id, tag)
        if (result.success) {
          return `✅ ${result.reason}: ${result.backupTag}`
        } else {
          return `⚠️ ${result.reason}: ${result.backupTag}\n💡 如需覆盖，请使用不同的标签名`
        }
      } catch (e: any) {
        commandLogger.error(`备份容器失败: ${e.message}`)
        return `❌ 备份失败: ${e.message}`
      }
    })
}
