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
    // 设置适当的视口，高度设大一点以便 content 自适应，然后截图 clip
    await page.setViewport({
      width: options.width || 700,
      height: options.height || 1000,
      deviceScaleFactor: 2 // 高清渲染
    })

    // 等待内容渲染
    const body = await page.$('body')
    const wrapper = await page.$('.wrapper')

    // 获取 wrapper 的实际大小
    const clip = await wrapper?.boundingBox() || await body?.boundingBox()

    if (clip) {
      // 增加一点 padding 截图
      // clip.x -= 10
      // clip.y -= 10
      // clip.width += 20
      // clip.height += 20

      // 直接截取 content
      const buffer = await page.screenshot({ clip })
      return h.image(buffer, 'image/png').toString()
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
  info: any
): string {
  const name = info.Name.replace('/', '')
  const shortId = info.Id.slice(0, 12)
  const isRunning = info.State.Running

  const items = [
    { label: '容器名称', value: name },
    { label: '容器 ID', value: info.Id },
    { label: '镜像', value: info.Config.Image },
    { label: '状态', value: info.State.Status, highlight: true },
    { label: '创建时间', value: new Date(info.Created).toLocaleString() },
    { label: '启动时间', value: new Date(info.State.StartedAt).toLocaleString() },
    { label: '重启次数', value: info.RestartCount },
    { label: 'IP 地址', value: info.NetworkSettings?.IPAddress || '-' },
    { label: '平台', value: info.Platform || 'linux' },
    { label: '驱动', value: info.Driver },
  ]

  if (info.State.Health) {
    items.push({ label: '健康状态', value: info.State.Health.Status, highlight: true })
  }

  const gridItems = items.map(item => `
    <div class="detail-item">
      <div class="detail-label">${item.label}</div>
      <div class="detail-value ${item.highlight ? 'highlight' : ''}">${item.value}</div>
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
      <!--Mounts/Ports could be added here-->
    </div>
  `

  return wrapHtml(header + body)
}

/**
 * 生成节点列表 HTML
 */
export function generateNodesHtml(
  nodes: any[]
): string {
  const onlineCount = nodes.filter(n => n.status === 'connected').length
  const totalCount = nodes.length

  const listItems = nodes.map(n => {
    const isOnline = n.status === 'connected'
    const isConnecting = n.status === 'connecting'
    const icon = isOnline ? '🟢' : (isConnecting ? '🟡' : '🔴')
    const tags = n.tags.map((t: string) => `<span class="tag">@${t}</span>`).join(' ')

    return `
      <div class="list-item">
        <div class="status-icon">${icon}</div>
        <div class="name-col">
          <div>${n.name}</div>
          <div style="font-size:12px; opacity:0.6; margin-top:2px;">${n.id}</div>
        </div>
        <div class="meta-col">
          <div style="color: ${isOnline ? '#4ade80' : (isConnecting ? '#facc15' : '#f87171')}">${n.status}</div>
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
  version: any
): string {
  const isOnline = node.status === 'connected'

  // 基础信息
  const items = [
    { label: '节点名称', value: node.name },
    { label: '节点 ID', value: node.id },
    { label: '状态', value: node.status, highlight: isOnline },
    { label: '标签', value: node.tags.join(', ') || '(无)' },
  ]

  // 版本信息
  if (version) {
    items.push(
      { label: 'Docker 版本', value: version.Version },
      { label: 'API 版本', value: version.ApiVersion },
      { label: '操作系统', value: `${version.Os} (${version.Arch})` },
      { label: '内核版本', value: version.KernelVersion },
      { label: 'Go 版本', value: version.GoVersion },
      { label: 'Git Commit', value: version.GitCommit },
      { label: '构建时间', value: version.BuildTime }
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
      <div class="header-badge">${node.name}</div>
    </div>
  `

  const body = `
    <div class="content">
      <div class="detail-card">
        <div style="display: flex; align-items: center; margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.1);">
          <div style="font-size: 32px; margin-right: 16px;">${isOnline ? '🟢' : '🔴'}</div>
          <div>
            <div style="font-size: 20px; font-weight: 600;">${node.name}</div>
            <div style="font-size: 13px; color: #94a3b8; font-family: monospace;">${node.id}</div>
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
