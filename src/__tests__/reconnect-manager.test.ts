/**
 * 单元测试: ReconnectManager
 * 验证节点被取消/废弃后能立即停止重连
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { ReconnectManager } from '../service/reconnect-manager'

describe('ReconnectManager', () => {
  let manager: ReconnectManager

  beforeEach(() => {
    vi.useFakeTimers()
    manager = new ReconnectManager({
      enabled: true,
      maxAttempts: 10,
      initialDelay: 1000,
      maxDelay: 60000,
      heartbeatInterval: 30000,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('cancel', () => {
    it('应该清除节点的重连状态', () => {
      const nodeId = 'node-1'
      // 模拟一次重连尝试内部状态
      manager['reconnectAttempts'].set(nodeId, 1)

      manager.cancel(nodeId)

      expect(manager.getStatus(nodeId).attempts).toBe(0)
      expect(manager.getStatus(nodeId).reconnecting).toBe(false)
    })

    it('重复调用 cancel 不应抛错', () => {
      expect(() => manager.cancel('non-existent')).not.toThrow()
    })
  })

  describe('cleanup', () => {
    it('应清空所有 timer、attempts、reconnecting', () => {
      manager['reconnectAttempts'].set('a', 1)
      manager['reconnectAttempts'].set('b', 2)
      manager['reconnecting'].add('a')

      manager.cleanup()

      expect(manager.getStatus('a').attempts).toBe(0)
      expect(manager.getStatus('a').reconnecting).toBe(false)
      expect(manager.getStatus('b').attempts).toBe(0)
    })
  })

  describe('sleepOrCancel', () => {
    it('如果节点已被取消,立即返回 true', async () => {
      // 节点没有进入 reconnectAttempts,等同于已被取消
      const promise = (manager as any).sleepOrCancel(1000, 'node-x')
      const result = await promise
      expect(result).toBe(true)
    })

    it('等待 ms 后,如果节点未被取消,返回 false', async () => {
      const nodeId = 'node-y'
      manager['reconnectAttempts'].set(nodeId, 1)

      const promise = (manager as any).sleepOrCancel(1000, nodeId)
      // 推进 1000ms
      await vi.advanceTimersByTimeAsync(1100)
      const result = await promise
      expect(result).toBe(false)
    })

    it('等待期间节点被取消,应提前唤醒返回 true', async () => {
      // 此用例只能用真实 timer,因为 sleepOrCancel 内部用 500ms 轮询检测
      vi.useRealTimers()
      const nodeId = 'node-z'
      manager['reconnectAttempts'].set(nodeId, 1)

      const promise = (manager as any).sleepOrCancel(10000, nodeId)

      // 在 10000ms 等待期间内,节点被取消
      setTimeout(() => manager.cancel(nodeId), 50)

      const result = await promise
      expect(result).toBe(true)
    })
  })

  describe('reset', () => {
    it('应仅清除 attempts 和 reconnecting', () => {
      manager['reconnectAttempts'].set('a', 5)
      manager['reconnecting'].add('a')

      manager.reset('a')

      expect(manager.getStatus('a').attempts).toBe(0)
      expect(manager.getStatus('a').reconnecting).toBe(false)
    })
  })
})
