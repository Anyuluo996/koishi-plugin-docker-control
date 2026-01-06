/**
 * 权限管理指令
 * 管理用户权限和角色
 */
import { Context } from 'koishi'
import { commandLogger } from '../utils/logger'

/**
 * 注册权限管理指令
 */
export function registerPermissionCommands(
  ctx: Context,
  getService: () => any
): void {
  /**
   * 查看用户权限
   */
  ctx
    .command('docker.permission.user <userId>', '查看用户权限')
    .alias('查看权限', '用户权限')
    .action(async (_, userId) => {
      const service = getService()
      if (!service) {
        return 'Docker 服务未初始化'
      }

      if (!service.permissionManager) {
        return '权限管理功能未启用'
      }

      if (!userId) {
        return '请提供用户ID'
      }

      try {
        const platform = 'unknown'
        const userPermission = await service.permissionManager.getUserPermission(userId, platform)

        if (!userPermission) {
          return `用户 ${userId} 没有特殊权限配置，使用默认角色`
        }

        const lines = [
          `=== 用户权限: ${userId} ===`,
          `平台: ${userPermission.platform}`,
          `角色: ${(userPermission.roles || []).join(', ') || '无'}`,
          ''
        ]

        if (userPermission.nodePermissions && Object.keys(userPermission.nodePermissions).length > 0) {
          lines.push('节点权限:')
          for (const [nodeId, perms] of Object.entries(userPermission.nodePermissions)) {
            const permArray = Array.isArray(perms) ? perms : []
            lines.push(`  ${nodeId}: ${permArray.join(', ')}`)
          }
        }

        lines.push('')
        lines.push(`创建时间: ${new Date(userPermission.createdAt).toLocaleString()}`)
        lines.push(`更新时间: ${new Date(userPermission.updatedAt).toLocaleString()}`)

        return lines.join('\n')
      } catch (e: any) {
        commandLogger.error(`查询用户权限失败: ${e.message}`)
        return `❌ 查询失败: ${e.message}`
      }
    })

  /**
   * 设置用户角色
   */
  ctx
    .command('docker.permission.setrole', '设置用户角色')
    .alias('设置角色', '添加角色')
    .action(async (_, userId, ...args) => {
      const service = getService()
      if (!service) {
        return 'Docker 服务未初始化'
      }

      if (!service.permissionManager) {
        return '权限管理功能未启用'
      }

      if (!userId || args.length === 0) {
        return '请提供用户ID和角色列表'
      }

      try {
        const platform = 'unknown'

        // 最后一个参数是角色列表
        const roles = args
        for (const role of roles) {
          await service.permissionManager.assignRole(userId, platform, role)
        }

        return `✅ 已为用户 ${userId} 设置角色: ${roles.join(', ')}`
      } catch (e: any) {
        commandLogger.error(`设置用户角色失败: ${e.message}`)
        return `❌ 设置失败: ${e.message}`
      }
    })

  /**
   * 添加节点权限
   */
  ctx
    .command('docker.permission.addnode', '添加节点权限')
    .alias('添加节点权限')
    .action(async (_, userId, nodeId, ...permissions) => {
      const service = getService()
      if (!service) {
        return 'Docker 服务未初始化'
      }

      if (!service.permissionManager) {
        return '权限管理功能未启用'
      }

      if (!userId || !nodeId || permissions.length === 0) {
        return '请提供用户ID、节点ID和权限列表'
      }

      try {
        const platform = 'unknown'

        for (const permission of permissions) {
          await service.permissionManager.grantNodePermission(userId, platform, nodeId, permission)
        }

        return `✅ 已为用户 ${userId} 添加节点 ${nodeId} 的权限: ${permissions.join(', ')}`
      } catch (e: any) {
        commandLogger.error(`添加节点权限失败: ${e.message}`)
        return `❌ 添加失败: ${e.message}`
      }
    })

  /**
   * 移除节点权限
   */
  ctx
    .command('docker.permission.removenode', '移除节点权限')
    .alias('移除节点权限')
    .action(async (_, userId, nodeId, ...permissions) => {
      const service = getService()
      if (!service) {
        return 'Docker 服务未初始化'
      }

      if (!service.permissionManager) {
        return '权限管理功能未启用'
      }

      if (!userId || !nodeId || permissions.length === 0) {
        return '请提供用户ID、节点ID和权限列表'
      }

      try {
        const platform = 'unknown'

        for (const permission of permissions) {
          await service.permissionManager.revokeNodePermission(userId, platform, nodeId, permission)
        }

        return `✅ 已移除用户 ${userId} 在节点 ${nodeId} 的权限: ${permissions.join(', ')}`
      } catch (e: any) {
        commandLogger.error(`移除节点权限失败: ${e.message}`)
        return `❌ 移除失败: ${e.message}`
      }
    })

  /**
   * 列出所有角色
   */
  ctx
    .command('docker.permission.roles', '列出所有角色')
    .alias('角色列表', '列出角色')
    .action(async () => {
      const service = getService()
      if (!service) {
        return 'Docker 服务未初始化'
      }

      if (!service.permissionManager) {
        return '权限管理功能未启用'
      }

      try {
        const roles = service.permissionManager.getAllRoles()
        const lines = ['=== 角色列表 ===', '']

        for (const role of roles) {
          lines.push(`${role.id} - ${role.name}`)
          lines.push(`  描述: ${role.description}`)
          lines.push(`  权限: ${role.permissions.join(', ')}`)
          lines.push('')
        }

        return lines.join('\n')
      } catch (e: any) {
        commandLogger.error(`列出角色失败: ${e.message}`)
        return `❌ 查询失败: ${e.message}`
      }
    })

  /**
   * 检查权限
   */
  ctx
    .command('docker.permission.check <userId> <resource> <action>', '检查用户权限')
    .alias('检查权限')
    .option('nodeId', '-n <nodeId> 节点ID')
    .action(async ({ options }, userId, resource, action) => {
      const service = getService()
      if (!service) {
        return 'Docker 服务未初始化'
      }

      if (!service.permissionManager) {
        return '权限管理功能未启用'
      }

      if (!userId || !resource || !action) {
        return '请提供用户ID、资源和操作'
      }

      try {
        const platform = 'unknown'
        const hasPermission = await service.permissionManager.checkPermission(
          userId,
          platform,
          resource,
          action,
          options.nodeId
        )

        return hasPermission
          ? `✅ 用户 ${userId} 有 ${resource}.${action} 权限`
          : `❌ 用户 ${userId} 没有 ${resource}.${action} 权限`
      } catch (e: any) {
        commandLogger.error(`检查权限失败: ${e.message}`)
        return `❌ 检查失败: ${e.message}`
      }
    })
}
