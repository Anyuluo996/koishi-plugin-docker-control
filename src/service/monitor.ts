/**
 * 监控器 - 智能事件处理
 * 实现防抖、抖动检测
 */
import type { DockerEvent, ContainerInfo } from '../types'
import { DockerNode } from './node'
import { monitorLogger } from '../utils/logger'

// 容器状态记录
interface ContainerState {
  // 防抖定时器：用于延迟发送 Stop/Die 事件
  stopTimer?: NodeJS.Timeout
  // 状态变更历史：用于检测频繁重启 (存储时间戳)
  history: number[]
  // 上次启动时间，用于屏蔽紧随其后的 restart 事件
  lastStartTime?: number
  // 容器名称：用于容器更新时跨容器ID追踪
  containerName?: string
}

// 处理后的事件数据结构
export interface ProcessedEvent {
  eventType: string // 'container.start', 'container.flapping', 'container.upgraded'
  action: string    // 'start', 'stop', 'die', 'flapping', 'upgraded'
  nodeId: string
  nodeName: string
  containerId: string
  containerName: string
  timestamp: number
}

export class MonitorManager {
  /** 容器状态映射: nodeId -> containerId -> State */
  private states: Map<string, Map<string, ContainerState>> = new Map()
  /** 容器名称映射: nodeId -> containerName -> containerId，用于容器更新时跨容器ID追踪 */
  private nameIndex: Map<string, Map<string, string>> = new Map()
  /** 全局回调 */
  private callback?: (event: ProcessedEvent) => void

  constructor(
    private config: {
      debounceWait?: number
      flappingWindow?: number
      flappingThreshold?: number
    } = {}
  ) {}

  /**
   * 处理原始 Docker 事件
   */
  processEvent(node: DockerNode, event: DockerEvent): void {
    if (event.Type !== 'container') return

    const action = event.Action
    // 只关注核心生命周期事件
    if (!['start', 'die', 'stop', 'restart'].includes(action)) return

    const containerId = event.Actor.ID
    const containerName = event.Actor.Attributes?.name || 'unknown'

    // 获取容器状态存储（同时更新名称索引）
    const state = this.getContainerState(node.id, containerId, containerName)
    const now = Date.now()

    // ---------------------------------------------------------
    // 0. 屏蔽 restart 冗余事件
    // 如果收到 restart，且距离上次 start 只有不到 3秒，说明是连在一起的，忽略 restart
    // ---------------------------------------------------------
    if (action === 'restart') {
      if (state.lastStartTime && (now - state.lastStartTime < 3000)) {
        monitorLogger.debug(`[${node.name}] ${containerName} 忽略冗余 restart (刚启动)`)
        return
      }
    }

    // 1. 记录历史用于抖动检测
    state.history.push(now)
    this.cleanHistory(state, now)

    // 2. 抖动检测 (Flapping)
    const threshold = this.config.flappingThreshold || 3
    if (state.history.length > threshold) {
      monitorLogger.warn(`[${node.name}] ${containerName} 频繁重启 (Flapping)`)

      // 如果正在防抖等待中，立即清除定时器
      if (state.stopTimer) {
        clearTimeout(state.stopTimer)
        state.stopTimer = undefined
      }

      // 清空历史，避免重复触发 Flapping 报警
      state.history = []

      // 发出 Flapping 事件
      this.emit({
        eventType: 'container.flapping',
        action: 'flapping',
        nodeId: node.id,
        nodeName: node.name,
        containerId,
        containerName,
        timestamp: now
      })
      return
    }

    // 3. 防抖逻辑
    const debounceWait = this.config.debounceWait || 60000

    if (action === 'die' || action === 'stop') {
      // [关键修复] 如果已经有一个定时器在跑了，说明已经处理了 stop/die，
      // 不要再重复打印日志或重置定时器了。
      if (state.stopTimer) {
        monitorLogger.debug(`[${node.name}] ${containerName} 收到 ${action}，但已在等待停止确认中 (忽略)`)
        return
      }

      monitorLogger.debug(`[${node.name}] ${containerName} 已停止 (${action})，等待 ${debounceWait}ms 后检查容器状态...`)

      state.stopTimer = setTimeout(async () => {
        state.stopTimer = undefined

        // 检查是否有同名容器正在运行（容器升级场景）
        const hasRunningContainer = await checkIfContainerRunning(node, containerName)

        if (hasRunningContainer) {
          // 有同名容器正在运行，说明是容器升级
          monitorLogger.info(`[${node.name}] ${containerName} 容器升级：检测到同名容器正在运行`)
          this.emit({
            eventType: 'container.upgraded',
            action: 'upgraded',
            nodeId: node.id,
            nodeName: node.name,
            containerId,
            containerName,
            timestamp: Date.now()
          })
        } else {
          // 没有同名容器运行，说明是真正的异常退出
          monitorLogger.info(`[${node.name}] ${containerName} 容器异常退出：未检测到同名容器运行`)
          this.emit({
            eventType: `container.die`, // 统一使用 die
            action: 'die',
            nodeId: node.id,
            nodeName: node.name,
            containerId,
            containerName,
            timestamp: Date.now()
          })
        }

        // 清理名称索引
        this.clearNameIndex(node.id, containerName)
      }, debounceWait)

    } else if (action === 'start' || action === 'restart') {
      // [关键] 记录启动时间，用于屏蔽后续的 restart
      state.lastStartTime = now

      // [新功能] 检查是否有同名的旧容器正在等待防抖
      const oldContainerId = this.getContainerIdByName(node.id, containerName)
      if (oldContainerId && oldContainerId !== containerId) {
        const oldState = this.getContainerStateById(node.id, oldContainerId)
        if (oldState?.stopTimer) {
          clearTimeout(oldState.stopTimer)
          oldState.stopTimer = undefined
          monitorLogger.info(`[${node.name}] ${containerName} 容器更新：取消旧容器 ${oldContainerId.slice(0, 12)} 的退出通知`)
          // 清理旧容器的状态
          this.removeContainerState(node.id, oldContainerId)
        }
      }

      if (state.stopTimer) {
        // 在防抖时间内恢复：取消报警
        clearTimeout(state.stopTimer)
        state.stopTimer = undefined
        monitorLogger.info(`[${node.name}] ${containerName} 在防抖时间内恢复，通知已抑制`)
      } else {
        // 这是一个"干净"的启动（比如手动启动一个已停止很久的容器）
        this.emit({
          eventType: `container.${action}`,
          action: action,
          nodeId: node.id,
          nodeName: node.name,
          containerId,
          containerName,
          timestamp: now
        })
      }
    }
  }

  /**
   * 注册处理后事件的回调
   */
  onProcessedEvent(callback: (event: ProcessedEvent) => void): () => void {
    this.callback = callback
    return () => { this.callback = undefined }
  }

  private emit(event: ProcessedEvent) {
    if (this.callback) {
      this.callback(event)
    }
  }

  private getContainerState(nodeId: string, containerId: string, containerName?: string): ContainerState {
    if (!this.states.has(nodeId)) {
      this.states.set(nodeId, new Map())
    }
    const nodeStates = this.states.get(nodeId)!

    if (!nodeStates.has(containerId)) {
      nodeStates.set(containerId, {
        history: [],
        containerName
      })
    }
    const state = nodeStates.get(containerId)!

    // 更新名称索引
    if (containerName) {
      if (!this.nameIndex.has(nodeId)) {
        this.nameIndex.set(nodeId, new Map())
      }
      this.nameIndex.get(nodeId)!.set(containerName, containerId)
      state.containerName = containerName
    }

    return state
  }

  private getContainerStateById(nodeId: string, containerId: string): ContainerState | undefined {
    const nodeStates = this.states.get(nodeId)
    return nodeStates?.get(containerId)
  }

  private getContainerIdByName(nodeId: string, containerName: string): string | undefined {
    const nameMap = this.nameIndex.get(nodeId)
    return nameMap?.get(containerName)
  }

  private removeContainerState(nodeId: string, containerId: string): void {
    const nodeStates = this.states.get(nodeId)
    if (nodeStates) {
      const state = nodeStates.get(containerId)
      if (state?.containerName) {
        const nameMap = this.nameIndex.get(nodeId)
        if (nameMap?.get(state.containerName) === containerId) {
          nameMap.delete(state.containerName)
        }
      }
      nodeStates.delete(containerId)
    }
  }

  private clearNameIndex(nodeId: string, containerName: string): void {
    const nameMap = this.nameIndex.get(nodeId)
    if (nameMap) {
      nameMap.delete(containerName)
    }
  }

  private cleanHistory(state: ContainerState, now: number) {
    const window = this.config.flappingWindow || 300000 // 默认 5分钟
    // 移除超出时间窗口的记录
    state.history = state.history.filter(t => now - t <= window)
  }
}

/**
 * 检查节点上是否有指定名称的容器正在运行
 * @param node Docker 节点
 * @param containerName 容器名称
 * @returns 是否有同名容器正在运行
 */
async function checkIfContainerRunning(node: DockerNode, containerName: string): Promise<boolean> {
  try {
    // 只检查运行中的容器
    const containers = await node.listContainers(false)
    // 检查是否有同名容器（容器名称格式可能为 /name 或 name）
    return containers.some(c =>
      c.Names.some(n => n === `/${containerName}` || n === containerName)
    )
  } catch (e) {
    monitorLogger.warn(`[${node.name}] 检查容器运行状态失败: ${e}`)
    return false
  }
}
