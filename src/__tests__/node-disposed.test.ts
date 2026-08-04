/**
 * 单元测试: DockerNode.disposed
 * 验证节点被 dispose 后 connect() 循环会立即退出
 *
 * DockerNode 在构造时会调用 ctx.model.extend (走 koishi mock)
 * 不会发起真实 SSH/Docker 连接
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { DockerNode } from '../service/node'
import { NodeStatus } from '../constants'

describe('DockerNode.disposed', () => {
  const config: any = {
    id: 'test-node',
    name: 'test',
    host: '127.0.0.1',
    port: 22,
    credentialId: 'cred-1',
    tags: [],
  }

  const credential: any = {
    id: 'cred-1',
    name: 'test-cred',
    authType: 'password',
    username: 'root',
    password: 'test',
  }

  // 走 mock:只提供 model.extend 等
  const ctx: any = {
    model: { extend: () => {} },
  }

  let node: DockerNode

  beforeEach(() => {
    node = new DockerNode(ctx, config, credential, false)
  })

  it('初始 disposed = false', () => {
    expect((node as any).disposed).toBe(false)
  })

  it('disconnect() 后 disposed = true', async () => {
    await node.disconnect()
    expect((node as any).disposed).toBe(true)
    expect(node.status).toBe(NodeStatus.DISCONNECTED)
  })

  it('dispose() 后 disposed = true', async () => {
    await node.dispose()
    expect((node as any).disposed).toBe(true)
  })

  it('disposed 后 connect() 应立即返回,不会进入连接循环', async () => {
    ;(node as any).disposed = true
    await node.connect()
    expect(node.status).toBe(NodeStatus.DISCONNECTED)
  })

  it('sleepOrDisposed 节点已废弃时立即返回 true', async () => {
    ;(node as any).disposed = true
    const start = Date.now()
    const result = await (node as any).sleepOrDisposed(10000)
    const elapsed = Date.now() - start
    expect(result).toBe(true)
    expect(elapsed).toBeLessThan(100)
  })

  it('sleepOrDisposed 等待期间被废弃应提前唤醒', async () => {
    const promise = (node as any).sleepOrDisposed(10000)
    setTimeout(() => {
      ;(node as any).disposed = true
    }, 600)
    const start = Date.now()
    const result = await promise
    const elapsed = Date.now() - start
    expect(result).toBe(true)
    expect(elapsed).toBeLessThan(2000)
  })
})
