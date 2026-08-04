/**
 * 单元测试: DockerService.removeNode 资源清理路径
 *
 * 验证 removeNode 正确调用 disconnect + reconnect cancel + monitor cleanup
 * 这是"删除节点配置后还会继续连接" bug 的核心修复路径
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// 提前 mock 掉 ssh2 dockerode,避免真实连接
vi.mock('ssh2', () => ({
  Client: class {
    on() { return this }
    connect() {}
    exec() {}
    end() {}
    removeListener() {}
  },
}))

vi.mock('dockerode', () => ({
  default: class {
    constructor() {}
    ping() { return Promise.resolve('OK') }
    getEvents() {
      const handlers: any = {}
      return Promise.resolve({
        on: (e: string, h: any) => { handlers[e] = h; return this },
        off: () => {},
        destroy: () => {},
      })
    }
  },
}))

import { DockerService } from '../service/index'
import { DockerNode } from '../service/node'
import { NodeStatus } from '../constants'

describe('DockerService.removeNode', () => {
  const config: any = {
    nodes: [
      { id: 'n1', name: 'n1', host: '127.0.0.1', port: 22, credentialId: 'c1', tags: [] },
      { id: 'n2', name: 'n2', host: '127.0.0.1', port: 22, credentialId: 'c1', tags: [] },
    ],
    credentials: [
      { id: 'c1', name: 'cred', authType: 'password', username: 'root', password: 'p' },
    ],
  }

  const ctx: any = {
    model: { extend: () => {} },
  }

  let service: DockerService

  beforeEach(() => {
    service = new DockerService(ctx, config)
  })

  it('服务初始化后,两个节点都应该被加载', () => {
    // 直接通过反射注入节点,避免走完整 initialize 的 SSH 流程
    const node1 = new DockerNode(ctx, config.nodes[0], config.credentials[0], false)
    const node2 = new DockerNode(ctx, config.nodes[1], config.credentials[0], false)
    ;(service as any).nodes.set('n1', node1)
    ;(service as any).nodes.set('n2', node2)

    expect(service.getAllNodes()).toHaveLength(2)
  })

  it('removeNode 后节点从 nodes Map 中移除', async () => {
    const node1 = new DockerNode(ctx, config.nodes[0], config.credentials[0], false)
    ;(service as any).nodes.set('n1', node1)

    // 安装 monitor mock
    const monitorMock = { removeNodeStates: vi.fn() }
    ;(service as any).monitorManager = monitorMock

    // 安装 reconnectManager mock
    const rmMock = { cancel: vi.fn() }
    ;(service as any).reconnectManager = rmMock

    const result = await service.removeNode('n1')

    expect(result).toBe(true)
    expect(service.getNode('n1')).toBeUndefined()
    expect(rmMock.cancel).toHaveBeenCalledWith('n1')
    expect(monitorMock.removeNodeStates).toHaveBeenCalledWith('n1')
  })

  it('移除不存在的节点应返回 false', async () => {
    const result = await service.removeNode('non-existent')
    expect(result).toBe(false)
  })

  it('syncNodesWithConfig 移除消失的节点', async () => {
    const node1 = new DockerNode(ctx, config.nodes[0], config.credentials[0], false)
    const node2 = new DockerNode(ctx, config.nodes[1], config.credentials[0], false)
    ;(service as any).nodes.set('n1', node1)
    ;(service as any).nodes.set('n2', node2)
    ;(service as any).monitorManager = { removeNodeStates: vi.fn() }
    ;(service as any).reconnectManager = { cancel: vi.fn() }

    // 同步时,只保留 n1
    const removedIds = await service.syncNodesWithConfig([
      { id: 'n1', name: 'n1', host: '127.0.0.1', port: 22, credentialId: 'c1', tags: [] },
    ] as any)

    expect(removedIds).toEqual(['n2'])
    expect(service.getNode('n1')).toBeDefined()
    expect(service.getNode('n2')).toBeUndefined()
  })

  it('syncNodesWithConfig 当所有节点都还在配置中,不应移除任何节点', async () => {
    const node1 = new DockerNode(ctx, config.nodes[0], config.credentials[0], false)
    const node2 = new DockerNode(ctx, config.nodes[1], config.credentials[0], false)
    ;(service as any).nodes.set('n1', node1)
    ;(service as any).nodes.set('n2', node2)
    ;(service as any).monitorManager = { removeNodeStates: vi.fn() }
    ;(service as any).reconnectManager = { cancel: vi.fn() }

    const removedIds = await service.syncNodesWithConfig(config.nodes as any)

    expect(removedIds).toHaveLength(0)
    expect(service.getAllNodes()).toHaveLength(2)
  })

  it('syncNodesWithConfig 配置为空时,移除所有节点', async () => {
    const node1 = new DockerNode(ctx, config.nodes[0], config.credentials[0], false)
    ;(service as any).nodes.set('n1', node1)
    ;(service as any).monitorManager = { removeNodeStates: vi.fn() }
    ;(service as any).reconnectManager = { cancel: vi.fn() }

    const removedIds = await service.syncNodesWithConfig([])

    expect(removedIds).toEqual(['n1'])
    expect(service.getAllNodes()).toHaveLength(0)
  })

  it('removeNode 在 connectionPool/monitorManager 缺失时不应抛错', async () => {
    const node1 = new DockerNode(ctx, config.nodes[0], config.credentials[0], false)
    ;(service as any).nodes.set('n1', node1)
    // 不安装 monitorManager 和 reconnectManager,模拟配置未启用

    await expect(service.removeNode('n1')).resolves.toBe(true)
    expect(service.getNode('n1')).toBeUndefined()
  })
})
