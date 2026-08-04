/**
 * 单元测试: MonitorManager.removeNodeStates
 * 验证清理节点状态 + 清除防抖定时器
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MonitorManager } from '../service/monitor'

describe('MonitorManager.removeNodeStates', () => {
  let monitor: MonitorManager

  beforeEach(() => {
    vi.useFakeTimers()
    monitor = new MonitorManager({ debounceWait: 60000 })
  })

  it('清理存在的节点状态', () => {
    const state = (monitor as any).getContainerState('node-1', 'container-1', 'web')
    state.stopTimer = setTimeout(() => {}, 1000)
    ;(monitor as any).states.set('node-1', new Map([['container-1', state]]))
    ;(monitor as any).nameIndex.set('node-1', new Map([['web', 'container-1']]))

    expect((monitor as any).states.has('node-1')).toBe(true)
    expect((monitor as any).nameIndex.has('node-1')).toBe(true)

    monitor.removeNodeStates('node-1')

    expect((monitor as any).states.has('node-1')).toBe(false)
    expect((monitor as any).nameIndex.has('node-1')).toBe(false)
  })

  it('清理不存在的节点不抛错', () => {
    expect(() => monitor.removeNodeStates('non-existent')).not.toThrow()
  })

  it('清理时清除所有 stopTimer', () => {
    const state1 = (monitor as any).getContainerState('node-1', 'c-1', 'web')
    const state2 = (monitor as any).getContainerState('node-1', 'c-2', 'db')
    state1.stopTimer = setTimeout(() => {}, 1000)
    state2.stopTimer = setTimeout(() => {}, 1000)

    expect(state1.stopTimer).toBeDefined()
    expect(state2.stopTimer).toBeDefined()

    monitor.removeNodeStates('node-1')

    expect(state1.stopTimer).toBeUndefined()
    expect(state2.stopTimer).toBeUndefined()
  })

  it('多个节点被独立清理', () => {
    const stateA = (monitor as any).getContainerState('node-a', 'c-1', 'web')
    const stateB = (monitor as any).getContainerState('node-b', 'c-2', 'db')
    stateA.stopTimer = setTimeout(() => {}, 1000)
    stateB.stopTimer = setTimeout(() => {}, 1000)

    monitor.removeNodeStates('node-a')

    expect((monitor as any).states.has('node-a')).toBe(false)
    expect((monitor as any).states.has('node-b')).toBe(true)
    expect(stateA.stopTimer).toBeUndefined()
    expect(stateB.stopTimer).toBeDefined()
  })

  it('清理无 stopTimer 的状态也不抛错', () => {
    const state = (monitor as any).getContainerState('node-1', 'c-1', 'web')
    state.stopTimer = undefined

    expect(() => monitor.removeNodeStates('node-1')).not.toThrow()
    expect((monitor as any).states.has('node-1')).toBe(false)
  })
})
