/**
 * 权限检查工具
 * 提供便捷的权限检查装饰器和中间件
 */
import type { Session } from 'koishi'
import type { PermissionManager } from '../service/permission-manager'

/**
 * 权限检查配置
 */
export interface PermissionCheckOptions {
  /** 权限管理器实例 */
  permissionManager: PermissionManager
  /** 资源类型 (如: container, node, image) */
  resource: string
  /** 操作类型 (如: start, stop, view, delete) */
  action: string
  /** 是否需要节点ID (可选) */
  nodeIdGetter?: (args: any[]) => string | undefined
  /** 自定义错误消息 (可选) */
  errorMessage?: string
}

/**
 * 权限检查结果
 */
export interface PermissionCheckResult {
  /** 是否有权限 */
  allowed: boolean
  /** 错误消息 (如果没有权限) */
  error?: string
}

/**
 * 从参数中提取节点ID
 */
function extractNodeId(session: Session, nodeIdGetter?: (args: any[]) => string): string | undefined {
  if (nodeIdGetter) {
    return nodeIdGetter([])
  }

  // 从 session 中尝试获取 selector 参数
  // 这里需要根据实际的命令参数结构来调整
  return undefined
}

/**
 * 检查用户权限
 */
export async function checkPermission(
  session: Session,
  options: PermissionCheckOptions
): Promise<PermissionCheckResult> {
  const { permissionManager, resource, action, nodeIdGetter } = options

  // 如果权限系统未启用，允许所有操作
  if (!permissionManager) {
    return { allowed: true }
  }

  const userId = session.userId || session.event?.user?.id
  const platform = session.platform

  if (!userId) {
    return {
      allowed: false,
      error: '无法识别用户身份'
    }
  }

  // 尝试提取节点ID
  const nodeId = extractNodeId(session, nodeIdGetter)

  try {
    // 检查权限
    const hasPermission = await permissionManager.checkPermission(
      userId,
      platform,
      resource,
      action,
      nodeId
    )

    if (!hasPermission) {
      const defaultError = `权限不足: 需要 ${resource}.${action} 权限`
      return {
        allowed: false,
        error: options.errorMessage || defaultError
      }
    }

    return { allowed: true }
  } catch (error) {
    return {
      allowed: false,
      error: `权限检查失败: ${error.message}`
    }
  }
}

/**
 * 权限检查中间件 - 用于命令拦截
 */
export function withPermissionCheck(options: PermissionCheckOptions) {
  return async (
    session: Session,
    next: () => Promise<void>
  ): Promise<void> => {
    const result = await checkPermission(session, options)

    if (!result.allowed) {
      // 如果没有权限，发送错误消息并阻止命令执行
      await session.send(result.error || '权限不足')
      return
    }

    // 有权限，继续执行命令
    await next()
  }
}

/**
 * 快捷方法：检查容器操作权限
 */
export function requireContainerPermission(
  permissionManager: PermissionManager,
  action: 'start' | 'stop' | 'restart' | 'exec' | 'delete' | 'view'
) {
  return withPermissionCheck({
    permissionManager,
    resource: 'container',
    action
  })
}

/**
 * 快捷方法：检查节点操作权限
 */
export function requireNodePermission(
  permissionManager: PermissionManager,
  action: 'view' | 'manage' | 'delete'
) {
  return withPermissionCheck({
    permissionManager,
    resource: 'node',
    action
  })
}

/**
 * 快捷方法：检查镜像操作权限
 */
export function requireImagePermission(
  permissionManager: PermissionManager,
  action: 'view' | 'delete' | 'pull'
) {
  return withPermissionCheck({
    permissionManager,
    resource: 'image',
    action
  })
}

/**
 * 权限检查包装器 - 用于包装异步函数
 */
export function withPermissionWrapper<T extends any[], R>(
  fn: (...args: T) => Promise<R>,
  options: PermissionCheckOptions
): (...args: T) => Promise<R> {
  return async (...args: T): Promise<R> => {
    // 从 args 中提取 session (通常在第一个参数或特定的位置)
    // 这里假设 session 在 args 中，具体位置根据实际调用情况调整
    const session = args[0] as any as Session

    if (!session) {
      throw new Error('Session not found in arguments')
    }

    const result = await checkPermission(session, options)

    if (!result.allowed) {
      throw new Error(result.error || '权限不足')
    }

    return fn(...args)
  }
}
