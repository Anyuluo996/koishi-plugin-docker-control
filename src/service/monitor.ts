/**
 * 监控器
 * 处理 Docker Events 流与健康状态
 */
import type { DockerEvent, NotificationEventType } from '../types'
import { DockerNode } from './node'
import { monitorLogger } from '../utils/logger'

/**
 * 容器事件类型映射
 */
const EVENT_ACTION_MAP: Record<string, NotificationEventType> = {
  start: 'container.start',
  stop: 'container.stop',
  restart: 'container.restart',
  die: 'container.die',
  health_status: 'container.health_status',
}

/**
 * 防抖状态
 */
interface DebounceState {
  containerId: string
  action: string
  timer: NodeJS.Timeout
  count: number
}

export class DockerMonitor {
  /** 节点 */
  private readonly node: DockerNode
  /** 防抖状态映射 */
  private debounceMap: Map<string, DebounceState> = new Map()
  /** 防抖时间 (毫秒) */
  private readonly debounceTime: number
  /** 事件回调 */
  private eventCallback?: (event: NotificationEventType, data: any) => void

  constructor(node: DockerNode, options: { debounceTime?: number } = {}) {
    this.node = node
    this.debounceTime = options.debounceTime ?? 3000
  }

  /**
   * 开始监控
   */
  start(): void {
    this.node.onEvent((event) => {
      this.handleEvent(event)
    })
    monitorLogger.debug(`[${this.node.name}] 监控已启动`)
  }

  /**
   * 停止监控
   */
  stop(): void {
    this.clearDebounce()
    monitorLogger.debug(`[${this.node.name}] 监控已停止`)
  }

  /**
   * 设置事件回调
   */
  onEvent(callback: (event: NotificationEventType, data: any) => void): void {
    this.eventCallback = callback
  }

  /**
   * 处理事件
   */
  private handleEvent(event: DockerEvent): void {
    if (event.Type !== 'container') {
      return
    }

    const action = event.Actor.Attributes?.action || event.Action
    const containerName = event.Actor.Attributes?.name || 'unknown'
    const containerId = event.Actor.ID

    // 映射到通知事件类型
    const eventType = EVENT_ACTION_MAP[action]
    if (!eventType) {
      monitorLogger.debug(`[${this.node.name}] 忽略事件: ${action}`)
      return
    }

    // 防抖处理
    if (this.shouldDebounce(action, containerId)) {
      monitorLogger.debug(`[${this.node.name}] 事件防抖: ${containerName} ${action}`)
      return
    }

    const data = {
      nodeId: this.node.id,
      nodeName: this.node.name,
      containerId,
      containerName,
      action,
      attributes: event.Actor.Attributes,
      timestamp: event.time,
    }

    monitorLogger.debug(`[${this.node.name}] 事件: ${containerName} ${action}`)

    // 触发回调
    if (this.eventCallback) {
      try {
        this.eventCallback(eventType, data)
      } catch (e) {
        monitorLogger.error(`[${this.node.name}] 事件回调错误: ${e}`)
      }
    }
  }

  /**
   * 判断是否应该防抖
   */
  private shouldDebounce(action: string, containerId: string): boolean {
    // 只对 start+stop 这种连续操作进行防抖
    const debouncePairs: Record<string, string[]> = {
      stop: ['start'],
      start: ['stop'],
    }

    const opposingActions = debouncePairs[action]
    if (!opposingActions) {
      return false
    }

    const key = containerId
    const existing = this.debounceMap.get(key)

    if (existing && opposingActions.includes(existing.action)) {
      // 清除之前的防抖定时器
      clearTimeout(existing.timer)
      this.debounceMap.delete(key)

      // 合并为重启事件
      monitorLogger.debug(`[${this.node.name}] 检测到连续操作，合并为重启: ${containerId}`)
      return true // 阻止第二个事件
    }

    // 设置新的防抖状态
    const state: DebounceState = {
      containerId,
      action,
      timer: setTimeout(() => {
        this.debounceMap.delete(key)
      }, this.debounceTime),
      count: 1,
    }

    this.debounceMap.set(key, state)
    return false
  }

  /**
   * 清除所有防抖定时器
   */
  private clearDebounce(): void {
    for (const state of this.debounceMap.values()) {
      clearTimeout(state.timer)
    }
    this.debounceMap.clear()
  }
}

/**
 * 监控管理器
 * 管理所有节点的监控
 */
export class MonitorManager {
  /** 监控实例映射 */
  private monitors: Map<string, DockerMonitor> = new Map()
  /** 全局事件回调 */
  private globalCallback?: (event: NotificationEventType, data: any) => void

  /**
   * 注册节点监控
   */
  register(node: DockerNode): void {
    if (this.monitors.has(node.id)) {
      this.unregister(node.id)
    }

    const monitor = new DockerMonitor(node)
    monitor.onEvent((event, data) => {
      if (this.globalCallback) {
        this.globalCallback(event, data)
      }
    })

    monitor.start()
    this.monitors.set(node.id, monitor)
    monitorLogger.debug(`[${node.name}] 监控已注册`)
  }

  /**
   * 注销节点监控
   */
  unregister(nodeId: string): void {
    const monitor = this.monitors.get(nodeId)
    if (monitor) {
      monitor.stop()
      this.monitors.delete(nodeId)
      monitorLogger.debug(`节点 ${nodeId} 监控已注销`)
    }
  }

  /**
   * 设置全局事件回调
   */
  onEvent(callback: (event: NotificationEventType, data: any) => void): void {
    this.globalCallback = callback
  }

  /**
   * 停止所有监控
   */
  stopAll(): void {
    for (const [nodeId, monitor] of this.monitors) {
      monitor.stop()
    }
    this.monitors.clear()
    monitorLogger.debug('所有监控已停止')
  }
}
