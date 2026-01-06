/**
 * 自动重连管理器
 * 实现指数退避重连策略
 */
import type { DockerNode } from './node'
import type { ReconnectConfig } from '../types/enhanced'
import { nodeLogger } from '../utils/logger'

/**
 * 重连管理器
 */
export class ReconnectManager {
  private reconnectAttempts: Map<string, number> = new Map()
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map()
  private reconnecting: Set<string> = new Set()

  constructor(private config: ReconnectConfig) {}

  /**
   * 尝试重连
   */
  async reconnect(node: DockerNode): Promise<void> {
    const nodeId = node.id

    if (!this.config.enabled) {
      throw new Error('重连功能未启用')
    }

    // 检查是否正在重连中
    if (this.reconnecting.has(nodeId)) {
      nodeLogger.debug(`[重连] 节点 ${nodeId} 正在重连中，跳过`)
      return
    }

    const attempts = this.reconnectAttempts.get(nodeId) || 0

    if (attempts >= this.config.maxAttempts) {
      const error = `达到最大重试次数 (${this.config.maxAttempts})`
      nodeLogger.error(`[重连] 节点 ${nodeId} ${error}`)
      this.reconnecting.delete(nodeId)
      throw new Error(error)
    }

    // 标记为重连中
    this.reconnecting.add(nodeId)

    // 计算退避时间
    const backoff = Math.min(
      this.config.initialDelay * Math.pow(2, attempts),
      this.config.maxDelay
    )

    this.reconnectAttempts.set(nodeId, attempts + 1)

    nodeLogger.info(`[重连] 节点 ${nodeId} 尝试重连 (${attempts + 1}/${this.config.maxAttempts})，${backoff}ms 后开始`)

    // 等待退避时间
    await new Promise((resolve) => setTimeout(resolve, backoff))

    try {
      await node.reconnect()
      this.reconnectAttempts.set(nodeId, 0) // 重置计数
      this.reconnecting.delete(nodeId)
      nodeLogger.info(`[重连] 节点 ${nodeId} 重连成功`)

      // 取消待定的重连定时器
      this.cancel(nodeId)
    } catch (error) {
      nodeLogger.warn(`[重连] 节点 ${nodeId} 重连失败: ${error.message}`)

      // 计划下次重试
      const timer = setTimeout(async () => {
        try {
          await this.reconnect(node)
        } catch (e) {
          // 已经在 reconnect 中处理错误
        }
      }, backoff)

      this.reconnectTimers.set(nodeId, timer)
      this.reconnecting.delete(nodeId)

      throw error
    }
  }

  /**
   * 取消重连
   */
  cancel(nodeId: string): void {
    const timer = this.reconnectTimers.get(nodeId)
    if (timer) {
      clearTimeout(timer)
      this.reconnectTimers.delete(nodeId)
      nodeLogger.debug(`[重连] 取消节点 ${nodeId} 的重连定时器`)
    }
    this.reconnectAttempts.delete(nodeId)
    this.reconnecting.delete(nodeId)
  }

  /**
   * 重置重连计数
   */
  reset(nodeId: string): void {
    this.reconnectAttempts.delete(nodeId)
    this.reconnecting.delete(nodeId)
  }

  /**
   * 清理所有资源
   */
  cleanup(): void {
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer)
    }
    this.reconnectTimers.clear()
    this.reconnectAttempts.clear()
    this.reconnecting.clear()
  }

  /**
   * 获取重连状态
   */
  getStatus(nodeId: string): {
    attempts: number
    reconnecting: boolean
  } {
    return {
      attempts: this.reconnectAttempts.get(nodeId) || 0,
      reconnecting: this.reconnecting.has(nodeId),
    }
  }
}
