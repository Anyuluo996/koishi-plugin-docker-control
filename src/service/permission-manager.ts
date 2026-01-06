/**
 * 权限管理器
 * 实现基于角色和资源的权限控制
 */
import { Context } from 'koishi'
import type { Permission, Role, UserPermission, PermissionConfig } from '../types/enhanced'
import { PERMISSIONS, ROLES } from '../constants/enhanced'

/**
 * 权限管理器
 */
export class PermissionManager {
  constructor(private ctx: Context, private config: PermissionConfig) {
    // 注册数据库表
    this.registerTables()
    // 初始化默认角色和权限
    this.initializeDefaults()
  }

  /**
   * 注册数据库表
   */
  private registerTables(): void {
    // 用户权限表
    this.ctx.model.extend('docker_user_permissions', {
      id: 'unsigned',
      platform: 'string',
      userId: 'string',
      roles: 'json',
      nodePermissions: 'json',
      createdAt: 'integer',
      updatedAt: 'integer',
    }, {
      autoInc: true,
      primary: 'id',
    })
  }

  /**
   * 初始化默认数据
   */
  private async initializeDefaults(): Promise<void> {
    // 这里可以初始化一些默认权限配置
    // 实际使用中，角色和权限定义在 constants.ts 中
  }

  /**
   * 检查权限
   */
  async checkPermission(
    userId: string,
    platform: string,
    resource: string,
    action: string,
    nodeId?: string
  ): Promise<boolean> {
    if (!this.config.enabled) {
      return true // 权限系统未启用，允许所有操作
    }

    // 检查是否是管理员
    if (this.config.adminUsers.includes(userId)) {
      return true
    }

    // 获取用户权限
    const userPermission = await this.getUserPermission(userId, platform)

    // 检查节点级权限
    if (nodeId) {
      const nodePerms = userPermission?.nodePermissions?.[nodeId] || []
      const requiredPermission = `${resource}.${action}`

      if (nodePerms.includes(requiredPermission)) {
        return true
      }
    }

    // 检查角色权限
    const userRoles = userPermission?.roles || []
    for (const roleId of userRoles) {
      const role = ROLES[roleId.toUpperCase() as keyof typeof ROLES]
      if (role && role.permissions.includes(`${resource}.${action}`)) {
        return true
      }
    }

    return false
  }

  /**
   * 获取用户权限记录
   */
  async getUserPermission(userId: string, platform: string): Promise<UserPermission | null> {
    const records = await this.ctx.model.get('docker_user_permissions', {
      platform,
      userId,
    })

    if (records.length === 0) {
      // 返回默认角色
      return {
        id: 0,
        platform,
        userId,
        roles: [this.config.defaultRole],
        nodePermissions: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
    }

    return records[0] as UserPermission
  }

  /**
   * 分配角色
   */
  async assignRole(userId: string, platform: string, roleId: string): Promise<void> {
    const userPermission = await this.getUserPermission(userId, platform)

    const roles = userPermission?.roles || []

    if (!roles.includes(roleId)) {
      roles.push(roleId)

      await this.ctx.model.set('docker_user_permissions', {
        platform,
        userId,
      }, {
        roles,
        updatedAt: Date.now(),
      })
    }
  }

  /**
   * 移除角色
   */
  async removeRole(userId: string, platform: string, roleId: string): Promise<void> {
    const userPermission = await this.getUserPermission(userId, platform)

    if (!userPermission) return

    const roles = userPermission.roles.filter((r) => r !== roleId)

    await this.ctx.model.set('docker_user_permissions', {
      platform,
      userId,
    }, {
      roles,
      updatedAt: Date.now(),
    })
  }

  /**
   * 授予节点权限
   */
  async grantNodePermission(
    userId: string,
    platform: string,
    nodeId: string,
    permissionId: string
  ): Promise<void> {
    const userPermission = await this.getUserPermission(userId, platform)

    let nodePermissions = userPermission?.nodePermissions || {}

    if (!nodePermissions[nodeId]) {
      nodePermissions[nodeId] = []
    }

    if (!nodePermissions[nodeId].includes(permissionId)) {
      nodePermissions[nodeId].push(permissionId)

      await this.ctx.model.set('docker_user_permissions', {
        platform,
        userId,
      }, {
        nodePermissions,
        updatedAt: Date.now(),
      })
    }
  }

  /**
   * 撤销节点权限
   */
  async revokeNodePermission(
    userId: string,
    platform: string,
    nodeId: string,
    permissionId: string
  ): Promise<void> {
    const userPermission = await this.getUserPermission(userId, platform)

    if (!userPermission?.nodePermissions?.[nodeId]) return

    const nodePermissions = userPermission.nodePermissions
    nodePermissions[nodeId] = nodePermissions[nodeId].filter((p) => p !== permissionId)

    await this.ctx.model.set('docker_user_permissions', {
      platform,
      userId,
    }, {
      nodePermissions,
      updatedAt: Date.now(),
    })
  }

  /**
   * 获取用户的所有权限列表
   */
  async getUserPermissions(userId: string, platform: string): Promise<Permission[]> {
    const userPermission = await this.getUserPermission(userId, platform)

    const permissions: Permission[] = []

    // 获取角色权限
    const userRoles = userPermission?.roles || []
    for (const roleId of userRoles) {
      const role = ROLES[roleId.toUpperCase() as keyof typeof ROLES]
      if (role) {
        for (const permId of role.permissions) {
          const perm = Object.values(PERMISSIONS).find((p) => p.id === permId)
          if (perm && !permissions.find((p) => p.id === perm.id)) {
            permissions.push(perm)
          }
        }
      }
    }

    return permissions
  }

  /**
   * 获取所有角色
   */
  getAllRoles(): Role[] {
    return Object.values(ROLES)
  }

  /**
   * 获取所有权限
   */
  getAllPermissions(): Permission[] {
    return Object.values(PERMISSIONS)
  }

  /**
   * 获取角色详情
   */
  getRole(roleId: string): Role | null {
    const role = ROLES[roleId.toUpperCase() as keyof typeof ROLES]
    return role || null
  }
}
