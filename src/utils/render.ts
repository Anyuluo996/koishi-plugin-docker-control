import { Context, h } from 'koishi'
import type { ContainerInfo } from '../types'

// 基础样式
const STYLE = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    min-height: 100vh;
    padding: 24px;
    color: #e2e8f0;
    line-height: 1.5;
  }
  .wrapper {
    max-width: 800px;
    margin: 0 auto;
    background: rgba(30, 41, 59, 0.7);
    backdrop-filter: blur(12px);
    border-radius: 16px;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }
  .header {
    background: rgba(51, 65, 85, 0.5);
    padding: 16px 24px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .header-title {
    font-size: 18px;
    font-weight: 600;
    color: #f8fafc;
  }
  .header-badge {
    font-size: 12px;
    padding: 4px 12px;
    border-radius: 9999px;
    background: rgba(255, 255, 255, 0.1);
    color: #cbd5e1;
  }
  .content {
    padding: 24px;
  }
  
  /* 表格/列表样式 */
  .list-item {
    display: grid;
    grid-template-columns: 48px 2fr 1.5fr 1fr;
    gap: 16px;
    padding: 16px;
    border-radius: 8px;
    align-items: center;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    transition: background 0.2s;
  }
  .list-item:last-child {
    border-bottom: none;
  }
  .list-item:hover {
    background: rgba(255, 255, 255, 0.05);
  }
  .list-header {
    font-size: 13px;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0 16px 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    margin-bottom: 8px;
  }
  
  /* 状态样式 */
  .status-icon { font-size: 20px; }
  .name-col { font-weight: 500; color: #fff; }
  .meta-col { font-size: 13px; color: #94a3b8; font-family: 'SF Mono', Monaco, monospace; }
  .tag {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
    background: rgba(255, 255, 255, 0.1);
  }
  
  /* Inspect 详情样式 */
  .detail-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 20px;
  }
  .detail-card {
    background: rgba(0, 0, 0, 0.2);
    border-radius: 12px;
    padding: 20px;
    border: 1px solid rgba(255, 255, 255, 0.05);
  }
  .detail-item {
    margin-bottom: 12px;
  }
  .detail-item:last-child { margin-bottom: 0; }
  .detail-label {
    font-size: 13px;
    color: #94a3b8;
    margin-bottom: 4px;
  }
  .detail-value {
    font-size: 15px;
    color: #e2e8f0;
    font-family: 'SF Mono', Monaco, monospace;
    word-break: break-all;
  }
  .detail-value.highlight {
    color: #60a5fa;
  }
  .detail-span {
    grid-column: 1 / -1;
  }
  .detail-span .detail-value {
    white-space: pre-wrap;
    font-size: 13px;
    line-height: 1.6;
  }

  /* 操作结果样式 */
  .result-card {
    display: flex;
    align-items: center;
    padding: 16px;
    background: rgba(255, 255, 255, 0.03);
    border-radius: 8px;
    margin-bottom: 12px;
    border-left: 4px solid #64748b;
  }
  .result-card.success { border-left-color: #4ade80; background: rgba(74, 222, 128, 0.1); }
  .result-card.error { border-left-color: #f87171; background: rgba(248, 113, 113, 0.1); }
  .result-icon {
    font-size: 24px;
    margin-right: 16px;
  }
  .result-info { flex: 1; }
  .result-title { font-weight: 600; margin-bottom: 4px; }
  .result-msg { font-size: 13px; color: #cbd5e1; }
`

interface RenderOptions {
  title?: string
  width?: number
  height?: number
}

/**
 * 包装 HTML
 */
function wrapHtml(content: string, style: string = STYLE): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>${style}</style>
</head>
<body>
  <div class="wrapper">
    ${content}
  </div>
</body>
</html>`
}

/**
 * 通用渲染函数：将 HTML 转换为图片
 */
export async function renderToImage(ctx: Context, html: string, options: RenderOptions = {}): Promise<string> {
  if (!ctx.puppeteer) {
    throw new Error('未安装 koishi-plugin-puppeteer 插件')
  }

  return ctx.puppeteer.render(html, async (page, next) => {
    // 1. 设置初始视口
    await page.setViewport({
      width: options.width || 800,
      height: options.height || 100,
      deviceScaleFactor: 2
    })

    // 2. 等待内容渲染
    const body = await page.$('body')
    const wrapper = await page.$('.wrapper')

    // 3. 获取实际内容的高度
    const boundingBox = await wrapper?.boundingBox() || await body?.boundingBox()

    if (boundingBox) {
      // 调整视口高度以匹配内容
      await page.setViewport({
        width: options.width || 800,
        height: Math.ceil(boundingBox.height) + 100,
        deviceScaleFactor: 2
      })

      // 重新获取 clip (因为视口变化可能导致重绘)
      const finalClip = await wrapper?.boundingBox() || await body?.boundingBox()

      if (finalClip) {
        const buffer = await page.screenshot({ clip: finalClip })
        return h.image(buffer, 'image/png').toString()
      }
    }

    // Fallback
    const buffer = await page.screenshot({ fullPage: true })
    return h.image(buffer, 'image/png').toString()
  })
}

/**
 * 生成容器列表 HTML
 */
export function generateListHtml(
  data: Array<{ node: any; containers: ContainerInfo[] }>,
  title: string = '容器列表'
): string {
  let stats = { running: 0, stopped: 0, total: 0 }

  const content = data.map(({ node, containers }) => {
    const nodeStats = {
      running: containers.filter(c => c.State === 'running').length,
      total: containers.length
    }
    stats.running += nodeStats.running
    stats.total += nodeStats.total
    stats.stopped += (nodeStats.total - nodeStats.running)

    const listItems = containers.length === 0
      ? `<div style="padding: 20px; text-align: center; color: #64748b;">(暂无容器)</div>`
      : containers.map(c => {
        const isRunning = c.State === 'running'
        const icon = isRunning ? '🟢' : (c.State === 'stopped' ? '🔴' : '⚪')
        const name = c.Names[0]?.replace('/', '') || 'Unknown'
        const shortId = c.Id.slice(0, 12)
        const image = c.Image.split('/').pop() || c.Image

        return `
          <div class="list-item">
            <div class="status-icon">${icon}</div>
            <div class="name-col">
              <div>${name}</div>
              <div style="font-size:12px; opacity:0.6; margin-top:2px;">${c.Status}</div>
            </div>
            <div class="meta-col">
              <div>ID: ${shortId}</div>
              <div style="color: #64748b; margin-top:2px;">${image}</div>
            </div>
            <div style="text-align: right;">
              <span class="tag" style="background: ${isRunning ? 'rgba(74, 222, 128, 0.1); color: #4ade80' : 'rgba(248, 113, 113, 0.1); color: #f87171'}">${c.State}</span>
            </div>
          </div>
        `
      }).join('')

    return `
      <div style="margin-bottom: 24px;">
        <div style="padding: 12px 16px; background: rgba(0,0,0,0.2); border-radius: 8px 8px 0 0; font-weight: 500; border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; justify-content: space-between;">
          <span>📦 ${node.name}</span>
          <span style="font-size: 13px; opacity: 0.7;">${nodeStats.running} / ${nodeStats.total} 运行中</span>
        </div>
        <div style="background: rgba(0,0,0,0.1); border-radius: 0 0 8px 8px;">
          ${listItems}
        </div>
      </div>
    `
  }).join('')

  const header = `
    <div class="header">
      <div class="header-title">${title}</div>
      <div class="header-badge">Total: ${stats.running} running / ${stats.total} total</div>
    </div>
  `

  return wrapHtml(header + '<div class="content">' + content + '</div>')
}

/**
 * 生成操作结果 HTML (启动/停止/重启)
 */
export function generateResultHtml(
  results: Array<{ node: any; container?: any; success: boolean; error?: string }>,
  title: string
): string {
  const successCount = results.filter(r => r.success).length
  const failCount = results.length - successCount

  const items = results.map(r => {
    const isSuccess = r.success
    const icon = isSuccess ? '✅' : '❌'
    const name = r.container?.Names?.[0]?.replace('/', '') || r.container?.Id?.slice(0, 8) || 'Unknown'
    const message = r.error || (isSuccess ? '操作成功' : '操作失败')

    return `
      <div class="result-card ${isSuccess ? 'success' : 'error'}">
        <div class="result-icon">${icon}</div>
        <div class="result-info">
          <div class="result-title">${r.node.name}: ${name}</div>
          <div class="result-msg">${message}</div>
        </div>
      </div>
    `
  }).join('')

  const header = `
    <div class="header">
      <div class="header-title">${title}</div>
      <div class="header-badge" style="background: ${failCount > 0 ? 'rgba(248, 113, 113, 0.2); color: #fca5a5' : 'rgba(74, 222, 128, 0.2); color: #86efac'}">
        成功: ${successCount} | 失败: ${failCount}
      </div>
    </div>
  `

  return wrapHtml(header + '<div class="content">' + items + '</div>')
}

/**
 * 生成详情 HTML
 */
export function generateInspectHtml(
  nodeName: string,
  info: any,
  stats?: {
    cpuPercent: string
    memoryUsage: string
    memoryLimit: string
    memoryPercent: string
    networkIn: string
    networkOut: string
    blockIn: string
    blockOut: string
    pids: string
  } | null,
  ports?: string[]
): string {
  const name = info.Name.replace('/', '')
  const shortId = info.Id.slice(0, 12)
  const isRunning = info.State.Running

  // 网络信息
  const networks = info.NetworkSettings?.Networks
  const networkInfo = networks && Object.keys(networks).length > 0
    ? Object.entries(networks).map(([name, net]) => {
        const n = net as any
        const ip = n.IPAddress || '-'
        const gateway = n.Gateway || '-'
        return `  ${name}: ${ip} (GW: ${gateway})`
      }).join('\n')
    : '-'

  // 环境变量
  const envVars = info.Config?.Env || []
  const envDisplay = envVars.length > 0
    ? envVars.slice(0, 10).map(e => {
        const [key, ...val] = e.split('=')
        return `  ${key}=${val.join('=').slice(0, 50)}${val.join('=').length > 50 ? '...' : ''}`
      }).join('\n') + (envVars.length > 10 ? `\n  ... (共 ${envVars.length} 个)` : '')
    : '-'

  // 重启策略
  const restartPolicy = info.HostConfig?.RestartPolicy
  const restartDisplay = restartPolicy
    ? `${restartPolicy.Name}${restartPolicy.Name !== 'no' ? ` (最大 ${restartPolicy.MaximumRetryCount} 次重试)` : ''}`
    : 'no'

  // 挂载目录
  const mounts = info.Mounts || []
  const mountsDisplay = mounts.length > 0
    ? mounts.map((m) => {
        const mount = m as any
        return `  ${mount.Source} → ${mount.Destination} (${mount.Type})`
      }).join('\n')
    : '-'

  // 端口映射
  const portsDisplay = ports && ports.length > 0
    ? ports.join('\n')
    : '-'

  // 判断容器是否运行
  const containerRunning = info.State.Running

  // 性能数据
  const statsDisplay = stats
    ? containerRunning
      ? `
        <div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin-top: 8px;">
          <div style="background: rgba(0,0,0,0.15); padding: 6px 4px; border-radius: 6px; text-align: center;">
            <div style="font-size: 9px; color: #cbd5e1; margin-bottom: 2px;">CPU</div>
            <div style="font-size: 13px; font-weight: 600; color: ${parseCpuColor(stats.cpuPercent)}">${stats.cpuPercent}</div>
          </div>
          <div style="background: rgba(0,0,0,0.15); padding: 6px 4px; border-radius: 6px; text-align: center;">
            <div style="font-size: 9px; color: #cbd5e1; margin-bottom: 2px;">内存</div>
            <div style="font-size: 13px; font-weight: 600; color: #60a5fa">${stats.memoryUsage}</div>
            <div style="font-size: 9px; color: #cbd5e1;">/ ${stats.memoryLimit}</div>
          </div>
          <div style="background: rgba(0,0,0,0.15); padding: 6px 4px; border-radius: 6px; text-align: center;">
            <div style="font-size: 9px; color: #cbd5e1; margin-bottom: 2px;">网络</div>
            <div style="font-size: 13px; font-weight: 600; color: #60a5fa">${stats.networkIn ? formatNetwork(stats.networkIn) : '-'}</div>
          </div>
          <div style="background: rgba(0,0,0,0.15); padding: 6px 4px; border-radius: 6px; text-align: center;">
            <div style="font-size: 9px; color: #cbd5e1; margin-bottom: 2px;">IO</div>
            <div style="font-size: 13px; font-weight: 600; color: #f472b6">${stats.blockIn}</div>
            <div style="font-size: 9px; color: #cbd5e1;">↓ ${stats.blockOut}↑</div>
          </div>
          <div style="background: rgba(0,0,0,0.15); padding: 6px 4px; border-radius: 6px; text-align: center;">
            <div style="font-size: 9px; color: #94a3b8; margin-bottom: 2px;">进程</div>
            <div style="font-size: 13px; font-weight: 600; color: #a78bfa">${stats.pids}</div>
          </div>
        </div>
      `
      : `
        <div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin-top: 8px;">
          <div style="background: rgba(0,0,0,0.1); padding: 6px 4px; border-radius: 6px; text-align: center; opacity: 0.6;">
            <div style="font-size: 9px; color: #cbd5e1; margin-bottom: 2px;">CPU</div>
            <div style="font-size: 13px; font-weight: 600; color: #94a3b8;">-</div>
          </div>
          <div style="background: rgba(0,0,0,0.1); padding: 6px 4px; border-radius: 6px; text-align: center; opacity: 0.6;">
            <div style="font-size: 9px; color: #cbd5e1; margin-bottom: 2px;">内存</div>
            <div style="font-size: 13px; font-weight: 600; color: #94a3b8;">-</div>
          </div>
          <div style="background: rgba(0,0,0,0.1); padding: 6px 4px; border-radius: 6px; text-align: center; opacity: 0.6;">
            <div style="font-size: 9px; color: #cbd5e1; margin-bottom: 2px;">网络</div>
            <div style="font-size: 13px; font-weight: 600; color: #94a3b8;">-</div>
          </div>
          <div style="background: rgba(0,0,0,0.1); padding: 6px 4px; border-radius: 6px; text-align: center; opacity: 0.6;">
            <div style="font-size: 9px; color: #cbd5e1; margin-bottom: 2px;">IO</div>
            <div style="font-size: 13px; font-weight: 600; color: #94a3b8;">-</div>
          </div>
          <div style="background: rgba(0,0,0,0.1); padding: 6px 4px; border-radius: 6px; text-align: center; opacity: 0.6;">
            <div style="font-size: 9px; color: #cbd5e1; margin-bottom: 2px;">进程</div>
            <div style="font-size: 13px; font-weight: 600; color: #a78bfa">${stats.pids}</div>
          </div>
        </div>
        <div style="font-size: 9px; color: #f59e0b; margin-top: 6px;">⚠ 容器已停止，无法获取实时监控数据</div>
      `
    : '<span style="color: #64748b; font-size: 11px;">(获取失败)</span>'

  const items = [
    { label: '容器名称', value: name, span: false },
    { label: '容器 ID', value: info.Id, span: false },
    { label: '镜像', value: info.Config.Image, span: false },
    { label: '状态', value: info.State.Status, highlight: true, span: false },
    { label: '创建时间', value: new Date(info.Created).toLocaleString(), span: false },
    { label: '启动时间', value: new Date(info.State.StartedAt).toLocaleString(), span: false },
    { label: '重启策略', value: restartDisplay, span: false },
    { label: '重启次数', value: String(info.RestartCount), span: false },
    { label: '性能监控', value: statsDisplay, span: true, isHtml: true },
    { label: '端口映射', value: portsDisplay, span: true },
    { label: '网络', value: networkInfo, span: true },
    { label: '环境变量', value: envDisplay, span: true },
    { label: '挂载目录', value: mountsDisplay, span: true },
  ]

  if (info.State.Health) {
    items.push({ label: '健康状态', value: info.State.Health.Status, highlight: true, span: false })
  }

  const gridItems = items.map(item => `
    <div class="detail-item ${item.span ? 'detail-span' : ''}">
      <div class="detail-label">${item.label}</div>
      <div class="detail-value ${item.highlight ? 'highlight' : ''}">${item.isHtml ? item.value : item.value.replace(/\n/g, '<br>')}</div>
    </div>
  `).join('')

  const header = `
    <div class="header">
      <div class="header-title">容器详情</div>
      <div class="header-badge">${nodeName}</div>
    </div>
  `

  const body = `
    <div class="content">
      <div class="detail-card">
        <div style="display: flex; align-items: center; margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.1);">
          <div style="font-size: 32px; margin-right: 16px;">${isRunning ? '🟢' : '🔴'}</div>
          <div>
            <div style="font-size: 20px; font-weight: 600;">${name}</div>
            <div style="font-size: 13px; color: #94a3b8; font-family: monospace;">${shortId}</div>
          </div>
        </div>
        <div class="detail-grid">
          ${gridItems}
        </div>
      </div>
    </div>
  `

  return wrapHtml(header + body)
}

/**
 * 根据 CPU 使用率返回颜色
 */
function parseCpuColor(cpuPercent: string): string {
  const value = parseFloat(cpuPercent.replace('%', ''))
  if (isNaN(value)) return '#94a3b8'
  if (value < 30) return '#4ade80'
  if (value < 60) return '#facc15'
  if (value < 80) return '#fb923c'
  return '#f87171'
}

/**
 * 根据内存使用率返回颜色
 */
function parseMemColor(memPercent: string): string {
  const value = parseFloat(memPercent.replace('%', ''))
  if (isNaN(value)) return '#94a3b8'
  if (value < 50) return '#60a5fa'
  if (value < 70) return '#facc15'
  if (value < 85) return '#fb923c'
  return '#f87171'
}

/**
 * 格式化网络流量显示
 */
function formatNetwork(bytes: string): string {
  const num = parseFloat(bytes)
  if (isNaN(num)) return '-'
  if (num < 1024) return bytes + 'B/s'
  if (num < 1024 * 1024) return (num / 1024).toFixed(1) + 'KB/s'
  return (num / 1024 / 1024).toFixed(2) + 'MB/s'
}

/**
 * 生成节点列表 HTML
 */
export function generateNodesHtml(
  nodes: any[]
): string {
  // 兼容字段名称
  const getStatus = (n: any) => n.status || n.Status || 'unknown'
  const getName = (n: any) => n.name || n.Name || 'Unknown'
  const getId = (n: any) => n.id || n.ID || n.Id || '-'

  const onlineCount = nodes.filter(n => getStatus(n) === 'connected').length
  const totalCount = nodes.length

  const listItems = nodes.map(n => {
    const status = getStatus(n)
    const isOnline = status === 'connected' || status === 'running'
    const isConnecting = status === 'connecting'
    const icon = isOnline ? '🟢' : (isConnecting ? '🟡' : '🔴')
    const tags = (n.tags || []).map((t: string) => `<span class="tag">@${t}</span>`).join(' ')

    return `
      <div class="list-item">
        <div class="status-icon">${icon}</div>
        <div class="name-col">
          <div>${getName(n)}</div>
          <div style="font-size:12px; opacity:0.6; margin-top:2px;">${getId(n)}</div>
        </div>
        <div class="meta-col">
          <div style="color: ${isOnline ? '#4ade80' : (isConnecting ? '#facc15' : '#f87171')}">${status}</div>
        </div>
        <div>${tags}</div>
      </div>
    `
  }).join('')

  const header = `
    <div class="header">
      <div class="header-title">节点列表</div>
      <div class="header-badge" style="background: rgba(74, 222, 128, 0.1); color: #4ade80">在线: ${onlineCount} / ${totalCount}</div>
    </div>
  `

  return wrapHtml(header + '<div class="content"><div style="background: rgba(0,0,0,0.2); border-radius: 8px;">' + listItems + '</div></div>')
}

/**
 * 生成节点详情 HTML
 */
export function generateNodeDetailHtml(
  node: any,
  version: any,
  systemInfo?: any
): string {
  // 兼容字段名称 (处理大小写不一致的问题)
  // 优先从 config 获取名称，因为 node 对象可能是 DockerNode 实例
  const nodeName = node.config?.name || node.name || node.Name || 'Unknown'
  const nodeId = node.id || node.ID || node.Id || node.config?.id || '-'
  const nodeStatus = node.status || node.Status || 'unknown'
  const nodeTags = node.tags || node.config?.tags || []
  const isOnline = nodeStatus === 'connected' || nodeStatus === 'running'

  // 解析系统信息 (兼容不同字段格式)
  const cpuCores = systemInfo?.NCPU || systemInfo?.Ncpu || systemInfo?.ncpu || '-'
  const memoryTotal = systemInfo?.MemTotal ? formatBytes(systemInfo.MemTotal) : '-'
  // 如果没有 MemAvailable，则只显示总内存
  const memoryDisplay = systemInfo?.MemAvailable !== undefined
    ? `${formatBytes(systemInfo.MemAvailable)} / ${memoryTotal}`
    : memoryTotal !== '-' ? memoryTotal : '-'

  // 基础信息
  const items = [
    { label: '节点名称', value: nodeName },
    { label: '节点 ID', value: nodeId },
    { label: '状态', value: nodeStatus, highlight: isOnline },
    { label: '标签', value: (nodeTags || []).join(', ') || '(无)' },
  ]

  // 系统资源信息
  items.push(
    { label: 'CPU', value: `${cpuCores} 核心` },
    { label: '内存', value: memoryDisplay },
    { label: '容器数量', value: String(node.containerCount ?? node.Containers ?? node.containers ?? '-') },
    { label: '镜像数量', value: String(node.imageCount ?? node.Images ?? node.images ?? '-') },
  )

  // 集群信息
  if (node.cluster || node.Swarm?.NodeID) {
    items.push({ label: '集群', value: node.cluster || 'Swarm Mode' })
  }

  // 版本信息
  if (version) {
    items.push(
      { label: 'Docker 版本', value: version.Version || version.version || '-' },
      { label: 'API 版本', value: version.ApiVersion || version.ApiVersion || '-' },
      { label: '操作系统', value: `${version.Os || version.Os || 'unknown'} (${version.Arch || version.Arch || 'unknown'})` },
      { label: '内核版本', value: version.KernelVersion || version.KernelVersion || '-' }
    )
  }

  const gridItems = items.map(item => `
    <div class="detail-item">
      <div class="detail-label">${item.label}</div>
      <div class="detail-value ${item.highlight ? 'highlight' : ''}">${item.value}</div>
    </div>
  `).join('')

  const header = `
    <div class="header">
      <div class="header-title">节点详情</div>
      <div class="header-badge">${nodeName}</div>
    </div>
  `

  const body = `
    <div class="content">
      <div class="detail-card">
        <div style="display: flex; align-items: center; margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.1);">
          <div style="font-size: 32px; margin-right: 16px;">${isOnline ? '🟢' : '🔴'}</div>
          <div>
            <div style="font-size: 20px; font-weight: 600;">${nodeName}</div>
            <div style="font-size: 13px; color: #94a3b8; font-family: monospace;">${nodeId}</div>
          </div>
        </div>
        <div class="detail-grid">
          ${gridItems}
        </div>
      </div>
    </div>
  `

  return wrapHtml(header + body)
}

/**
 * 生成日志 HTML
 */
export function generateLogsHtml(
  nodeName: string,
  containerName: string,
  logs: string,
  lineCount: number
): string {
  // 限制日志行数，避免过长
  const maxLines = 150
  const allLines = logs.split('\n')
  const totalLines = allLines.length
  const displayLines = allLines.slice(-maxLines)
  const displayLogs = displayLines.join('\n')
  const displayLineCount = displayLines.length

  // 逐行渲染，带行号和高亮
  const logLines = displayLines.map((line, idx) => {
    const lineNum = totalLines - displayLineCount + idx + 1
    return `<span class="line-num">${lineNum.toString().padStart(5, ' ')}</span><span class="line-content">${highlightLogContent(line)}</span>`
  }).join('\n')

  const header = `
    <div class="header">
      <div class="header-title">📋 容器日志</div>
      <div class="header-badge">${nodeName}/${containerName}</div>
    </div>
  `

  const body = `
    <div class="content">
      <div style="margin-bottom: 12px; font-size: 13px; color: #94a3b8; display: flex; justify-content: space-between;">
        <span>显示第 ${totalLines - displayLineCount + 1} - ${totalLines} 行</span>
        <span>共 ${totalLines} 行</span>
      </div>
      <div class="log-container">
        <div class="log-lines">${logLines}</div>
      </div>
    </div>
  `

  // 添加日志专用样式
  const logStyle = `
    .log-container {
      background: rgba(0, 0, 0, 0.3);
      border-radius: 8px;
      padding: 16px;
      overflow: visible;
    }
    .log-lines {
      font-family: 'SF Mono', Monaco, 'Courier New', monospace;
      font-size: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-all;
      color: #e2e8f0;
    }
    .line-num {
      color: #475569;
      margin-right: 12px;
      user-select: none;
      display: inline-block;
      min-width: 35px;
      text-align: right;
      border-right: 1px solid #334155;
      padding-right: 8px;
    }
    .line-content {
      color: #e2e8f0;
    }

    /* 高亮样式 */
    .hl-date { color: #64748b; }
    .hl-ip { color: #22d3ee; }
    .hl-string { color: #a5f3fc; opacity: 0.9; }
    .hl-error { color: #ef4444; font-weight: bold; background: rgba(239, 68, 68, 0.1); padding: 0 4px; border-radius: 2px; }
    .hl-warn { color: #f59e0b; font-weight: bold; }
    .hl-info { color: #3b82f6; font-weight: bold; }
    .hl-debug { color: #94a3b8; }
  `

  return wrapHtml(header + body, STYLE + logStyle)
}

/**
 * 格式化字节为可读格式
 */
function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '-'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

/**
 * HTML 转义
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * 处理日志高亮
 */
function highlightLogContent(text: string): string {
  // 1. 先进行基础的 HTML 转义
  let html = escapeHtml(text)

  // 2. 定义高亮规则 (注意顺序：先匹配复杂的，再匹配简单的)

  // [时间戳] YYYY-MM-DD HH:mm:ss 或 ISO8601
  html = html.replace(
    /(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/g,
    '\x1f$1\x1f'
  )

  // [IP地址] 简单的 IPv4 匹配
  html = html.replace(
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    '\x1f$&\x1f'
  )

  // [日志等级 - Error/Fail] 红色
  html = html.replace(
    /(\b(ERROR|ERR|FATAL|CRITICAL|FAIL|FAILED|EXCEPTION)\b|\[(ERROR|ERR)\])/gi,
    '\x1f$1\x1f'
  )

  // [日志等级 - Warn] 黄色
  html = html.replace(
    /(\b(WARN|WARNING)\b|\[(WARN|WARNING)\])/gi,
    '\x1f$1\x1f'
  )

  // [日志等级 - Info] 蓝色
  html = html.replace(
    /(\b(INFO|INFORMATION)\b|\[(INFO)\])/gi,
    '\x1f$1\x1f'
  )

  // [日志等级 - Debug/Trace] 灰色
  html = html.replace(
    /(\b(DEBUG|TRACE)\b|\[(DEBUG|TRACE)\])/gi,
    '\x1f$1\x1f'
  )

  // [引用/字符串] "xxx" 或 'xxx'
  html = html.replace(
    /(".*?"|'.*?')/g,
    '\x1f$1\x1f'
  )

  // 3. 将占位符替换回 HTML 标签
  html = html
    .replace(/\x1f(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\x1f/g, '<span class="hl-date">$1</span>')
    .replace(/\x1f((?:\d{1,3}\.){3}\d{1,3})\x1f/g, '<span class="hl-ip">$1</span>')
    .replace(/\x1f((?:\[[^\]]*\]|\w+))\x1f/g, (match, p1) => {
      const lower = p1.toLowerCase()
      if (lower.includes('error') || lower.includes('fatal') || lower.includes('fail') || lower.includes('exception')) {
        return `<span class="hl-error">${p1}</span>`
      }
      if (lower.includes('warn')) {
        return `<span class="hl-warn">${p1}</span>`
      }
      if (lower.includes('info')) {
        return `<span class="hl-info">${p1}</span>`
      }
      if (lower.includes('debug') || lower.includes('trace')) {
        return `<span class="hl-debug">${p1}</span>`
      }
      if (p1.startsWith('"') || p1.startsWith("'")) {
        return `<span class="hl-string">${p1}</span>`
      }
      return p1
    })

  return html
}

/**
 * 生成执行结果 HTML
 */
export function generateExecHtml(
  nodeName: string,
  containerName: string,
  command: string,
  output: string,
  exitCode: number
): string {
  const isSuccess = exitCode === 0
  const statusIcon = isSuccess ? '✅' : '❌'

  const header = `
    <div class="header">
      <div class="header-title">🔧 命令执行</div>
      <div class="header-badge">${nodeName}/${containerName}</div>
    </div>
  `

  const body = `
    <div class="content">
      <div style="
        background: rgba(0, 0, 0, 0.2);
        border-radius: 8px;
        padding: 16px;
        margin-bottom: 16px;
      ">
        <div style="font-size: 13px; color: #94a3b8; margin-bottom: 8px;">执行命令</div>
        <div style="
          font-family: 'SF Mono', Monaco, monospace;
          font-size: 13px;
          color: #60a5fa;
          background: rgba(96, 165, 250, 0.1);
          padding: 8px 12px;
          border-radius: 4px;
        ">${command}</div>
      </div>

      <div style="
        background: rgba(0, 0, 0, 0.3);
        border-radius: 8px;
        padding: 16px;
        font-family: 'SF Mono', Monaco, 'Courier New', monospace;
        font-size: 12px;
        line-height: 1.6;
        max-height: 300px;
        overflow-y: auto;
        white-space: pre-wrap;
        word-break: break-all;
        color: #e2e8f0;
      ">${output || '(无输出)'}</div>

      <div style="margin-top: 16px; display: flex; align-items: center; gap: 8px;">
        <span style="font-size: 20px;">${statusIcon}</span>
        <span style="color: ${isSuccess ? '#4ade80' : '#f87171'}">
          退出码: ${exitCode}
        </span>
      </div>
    </div>
  `

  return wrapHtml(header + body)
}

/**
 * 生成 Docker Compose 配置 HTML
 */
export function generateComposeHtml(
  nodeName: string,
  containerName: string,
  projectName: string,
  filePath: string,
  serviceCount: number,
  composeContent: string
): string {
  // 对内容进行语法高亮
  const highlightedContent = highlightYaml(composeContent)

  const header = `
    <div class="header">
      <div class="header-title">Docker Compose</div>
      <div class="header-badge">${nodeName}/${containerName}</div>
    </div>
  `

  const body = `
    <div class="content">
      <div class="detail-card" style="margin-bottom: 20px;">
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px;">
          <div class="detail-item">
            <div class="detail-label">项目名称</div>
            <div class="detail-value highlight">${projectName}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">服务数量</div>
            <div class="detail-value">${serviceCount} 个</div>
          </div>
          <div class="detail-item" style="grid-column: 1 / -1;">
            <div class="detail-label">文件路径</div>
            <div class="detail-value" style="font-size: 13px;">${filePath}</div>
          </div>
        </div>
      </div>

      <div style="
        background: rgba(0, 0, 0, 0.3);
        border-radius: 8px;
        padding: 16px;
        font-family: 'SF Mono', Monaco, 'Courier New', monospace;
        font-size: 12px;
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-all;
      ">${highlightedContent}</div>
    </div>
  `

  // 添加 YAML 高亮样式
  const yamlStyle = `
    .yaml-key { color: #60a5fa; }
    .yaml-string { color: #a5f3fc; }
    .yaml-number { color: #f472b6; }
    .yaml-boolean { color: #fbbf24; }
    .yaml-null { color: #94a3b8; }
    .yaml-comment { color: #64748b; font-style: italic; }
    .yaml-bracket { color: #f87171; }
  `

  return wrapHtml(header + body, STYLE + yamlStyle)
}

/**
 * 简单的 YAML 语法高亮
 */
function highlightYaml(content: string): string {
  // HTML 转义
  let html = escapeHtml(content)

  // 高亮键名 (冒号前的单词)
  html = html.replace(
    /^([a-zA-Z0-9_-]+):(\s*)$/gm,
    '<span class="yaml-key">$1</span>:<br>'
  )

  // 高亮带引号的字符串
  html = html.replace(
    /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,
    '<span class="yaml-string">$1</span>'
  )

  // 高亮数字
  html = html.replace(
    /\b(\d+\.?\d*)\b/g,
    '<span class="yaml-number">$1</span>'
  )

  // 高亮布尔值
  html = html.replace(
    /\b(true|false|yes|no|on|off)\b/gi,
    '<span class="yaml-boolean">$1</span>'
  )

  // 高亮 null
  html = html.replace(
    /\bnull\b/gi,
    '<span class="yaml-null">null</span>'
  )

  // 高亮注释
  html = html.replace(
    /#.*$/gm,
    '<span class="yaml-comment">$&</span>'
  )

  // 高亮括号
  html = html.replace(
    /([\[\]{}()])/g,
    '<span class="yaml-bracket">$1</span>'
  )

  return html
}

/**
 * 生成镜像列表 HTML
 */
export function generateImagesHtml(
  data: Array<{ node: any; images: Array<{ Id: string; Repository: string; Tag: string; Size: string; Created: string }> }>,
  title: string = '镜像列表'
): string {
  let stats = { total: 0, totalSize: 0 }

  const content = data.map(({ node, images }) => {
    const nodeStats = {
      total: images.length
    }
    stats.total += nodeStats.total

    const listItems = images.length === 0
      ? `<div style="padding: 20px; text-align: center; color: #64748b;">(暂无镜像)</div>`
      : images.map(img => {
        const shortId = img.Id.slice(0, 12)
        const isNone = img.Repository === '<none>' || img.Tag === '<none>'
        const icon = isNone ? '📦' : '🐳'
        const fullName = `${img.Repository}:${img.Tag}`

        return `
          <div class="list-item">
            <div class="status-icon">${icon}</div>
            <div class="name-col">
              <div>${fullName}</div>
              <div style="font-size:12px; opacity:0.6; margin-top:2px;">${img.Created}</div>
            </div>
            <div class="meta-col">
              <div>ID: ${shortId}</div>
              <div style="color: #64748b; margin-top:2px;">${img.Size}</div>
            </div>
            <div style="text-align: right;">
              <span class="tag" style="background: ${isNone ? 'rgba(100, 116, 139, 0.1); color: #94a3b8' : 'rgba(96, 165, 250, 0.1); color: #60a5fa'}">${isNone ? 'dangling' : 'ok'}</span>
            </div>
          </div>
        `
      }).join('')

    return `
      <div style="margin-bottom: 24px;">
        <div style="padding: 12px 16px; background: rgba(0,0,0,0.2); border-radius: 8px 8px 0 0; font-weight: 500; border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; justify-content: space-between;">
          <span>📦 ${node.name}</span>
          <span style="font-size: 13px; opacity: 0.7;">${nodeStats.total} 个镜像</span>
        </div>
        <div style="background: rgba(0,0,0,0.1); border-radius: 0 0 8px 8px;">
          ${listItems}
        </div>
      </div>
    `
  }).join('')

  const header = `
    <div class="header">
      <div class="header-title">${title}</div>
      <div class="header-badge">Total: ${stats.total} images</div>
    </div>
  `

  return wrapHtml(header + '<div class="content">' + content + '</div>')
}

/**
 * 生成网络列表 HTML
 */
export function generateNetworksHtml(
  data: Array<{ node: any; networks: Array<{ Id: string; Name: string; Driver: string; Scope: string; Subnet: string; Gateway: string }> }>,
  title: string = '网络列表'
): string {
  let stats = { total: 0 }

  const content = data.map(({ node, networks }) => {
    const nodeStats = {
      total: networks.length
    }
    stats.total += nodeStats.total

    const listItems = networks.length === 0
      ? `<div style="padding: 20px; text-align: center; color: #64748b;">(暂无网络)</div>`
      : networks.map(net => {
        const shortId = net.Id.slice(0, 12)
        const icon = net.Driver === 'bridge' ? '🌉' : net.Driver === 'overlay' ? '🔗' : net.Driver === 'host' ? '🏠' : net.Driver === 'none' ? '🚫' : '🌐'

        return `
          <div class="list-item">
            <div class="status-icon">${icon}</div>
            <div class="name-col">
              <div>${net.Name}</div>
              <div style="font-size:12px; opacity:0.6; margin-top:2px;">${net.Subnet !== '-' ? `子网: ${net.Subnet}` : net.Scope}</div>
            </div>
            <div class="meta-col">
              <div>ID: ${shortId}</div>
              <div style="color: #64748b; margin-top:2px;">${net.Gateway !== '-' ? `网关: ${net.Gateway}` : net.Driver}</div>
            </div>
            <div style="text-align: right;">
              <span class="tag" style="background: rgba(167, 139, 250, 0.1); color: #a78bfa">${net.Driver}</span>
            </div>
          </div>
        `
      }).join('')

    return `
      <div style="margin-bottom: 24px;">
        <div style="padding: 12px 16px; background: rgba(0,0,0,0.2); border-radius: 8px 8px 0 0; font-weight: 500; border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; justify-content: space-between;">
          <span>🌐 ${node.name}</span>
          <span style="font-size: 13px; opacity: 0.7;">${nodeStats.total} 个网络</span>
        </div>
        <div style="background: rgba(0,0,0,0.1); border-radius: 0 0 8px 8px;">
          ${listItems}
        </div>
      </div>
    `
  }).join('')

  const header = `
    <div class="header">
      <div class="header-title">${title}</div>
      <div class="header-badge">Total: ${stats.total} networks</div>
    </div>
  `

  return wrapHtml(header + '<div class="content">' + content + '</div>')
}

/**
 * 生成存储卷列表 HTML
 */
export function generateVolumesHtml(
  data: Array<{ node: any; volumes: Array<{ Name: string; Driver: string; Scope: string; Mountpoint: string; Size: string }> }>,
  title: string = '存储卷列表'
): string {
  let stats = { total: 0 }

  const content = data.map(({ node, volumes }) => {
    const nodeStats = {
      total: volumes.length
    }
    stats.total += nodeStats.total

    const listItems = volumes.length === 0
      ? `<div style="padding: 20px; text-align: center; color: #64748b;">(暂无存储卷)</div>`
      : volumes.map(vol => {
        const icon = vol.Driver === 'local' ? '💾' : '📀'

        return `
          <div class="list-item">
            <div class="status-icon">${icon}</div>
            <div class="name-col">
              <div>${vol.Name}</div>
              <div style="font-size:12px; opacity:0.6; margin-top:2px;">${vol.Mountpoint !== '-' ? vol.Mountpoint.slice(0, 40) + (vol.Mountpoint.length > 40 ? '...' : '') : vol.Scope}</div>
            </div>
            <div class="meta-col">
              <div>${vol.Driver}</div>
              <div style="color: #64748b; margin-top:2px;">${vol.Size !== '-' ? vol.Size : vol.Scope}</div>
            </div>
            <div style="text-align: right;">
              <span class="tag" style="background: rgba(244, 114, 182, 0.1); color: #f472b6">${vol.Driver}</span>
            </div>
          </div>
        `
      }).join('')

    return `
      <div style="margin-bottom: 24px;">
        <div style="padding: 12px 16px; background: rgba(0,0,0,0.2); border-radius: 8px 8px 0 0; font-weight: 500; border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; justify-content: space-between;">
          <span>💾 ${node.name}</span>
          <span style="font-size: 13px; opacity: 0.7;">${nodeStats.total} 个存储卷</span>
        </div>
        <div style="background: rgba(0,0,0,0.1); border-radius: 0 0 8px 8px;">
          ${listItems}
        </div>
      </div>
    `
  }).join('')

  const header = `
    <div class="header">
      <div class="header-title">${title}</div>
      <div class="header-badge">Total: ${stats.total} volumes</div>
    </div>
  `

  return wrapHtml(header + '<div class="content">' + content + '</div>')
}
