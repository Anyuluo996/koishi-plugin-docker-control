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
      width: options.width || 1200,
      height: options.height || 100,
      deviceScaleFactor: 2
    })

    // 2. 等待页面和样式完全加载
    try {
      await page.waitForSelector('body', { timeout: 5000 })
      // 等待所有 CSS 样式应用完成
      await page.evaluateHandle('document.fonts.ready')
      // 额外等待确保渲染完成
      await page.waitForTimeout(100)
    } catch (e) {
      // 忽略超时错误
    }

    // 3. 等待内容渲染
    const body = await page.$('body')
    const wrapper = await page.$('.wrapper')
    const container = await page.$('.container')

    // 4. 获取实际内容的高度
    const boundingBox = await container?.boundingBox() || await wrapper?.boundingBox() || await body?.boundingBox()

    if (boundingBox) {
      // 调整视口高度以匹配内容
      await page.setViewport({
        width: options.width || 1200,
        height: Math.ceil(boundingBox.height) + 100,
        deviceScaleFactor: 2
      })

      // 重新获取 clip (因为视口变化可能导致重绘)
      const finalClip = await container?.boundingBox() || await wrapper?.boundingBox() || await body?.boundingBox()

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
 * 生成容器列表 HTML（现代化）
 */
export function generateListHtml(
  data: Array<{ node: any; containers: ContainerInfo[] }>,
  title: string = '容器列表'
): string {
  let stats = { running: 0, stopped: 0, total: 0 }

  // 收集所有容器的列表项
  const allListItems = data.flatMap(({ node, containers }) => {
    const nodeStats = {
      running: containers.filter(c => c.State === 'running').length,
      total: containers.length
    }
    stats.running += nodeStats.running
    stats.total += nodeStats.total
    stats.stopped += (nodeStats.total - nodeStats.running)

    if (containers.length === 0) return []

    return containers.map(c => {
      const isRunning = c.State === 'running'
      const name = c.Names[0]?.replace('/', '') || 'Unknown'
      const shortId = c.Id.slice(0, 12)
      const image = c.Image.split('/').pop() || c.Image
      const firstChar = name.charAt(0).toUpperCase()

      // 根据状态选择渐变色
      let gradient = 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
      if (c.State === 'stopped') {
        gradient = 'linear-gradient(135deg, #f87171 0%, #dc2626 100%)'
      } else if (c.State === 'paused' || c.State === 'restarting') {
        gradient = 'linear-gradient(135deg, #fbbf24 0%, #d97706 100%)'
      } else if (c.State === 'created') {
        gradient = 'linear-gradient(135deg, #64748b 0%, #475569 100%)'
      }

      return `
        <div class="list-item">
          <div class="item-icon" style="background: ${gradient};">${firstChar}</div>
          <div class="item-info">
            <div class="item-name">${name}</div>
            <div class="item-sub">${c.Status}</div>
          </div>
          <div class="item-meta">
            <div class="meta-id">ID: ${shortId}</div>
            <div class="meta-image">${image}</div>
          </div>
          <div class="status-badge ${isRunning ? 'badge-running' : 'badge-stopped'}">
            ${isRunning ? 'Running' : 'Stopped'}
          </div>
        </div>
      `
    })
  })

  const totalRunning = stats.running
  const totalCount = stats.total

  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        :root {
            --bg-body: #0f172a;
            --bg-card: #1e293b;
            --bg-card-hover: #2a3850;
            --text-main: #f1f5f9;
            --text-muted: #94a3b8;
            --text-dim: #64748b;
            --primary: #38bdf8;
            --success: #4ade80;
            --danger: #f87171;
            --warning: #fbbf24;
            --border: #334155;
            --font-mono: 'JetBrains Mono', Consolas, monospace;
            --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            background-color: var(--bg-body);
            color: var(--text-main);
            font-family: var(--font-sans);
            padding: 2rem;
            line-height: 1.5;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
        }

        .section-header {
            margin: 0 0 1.5rem;
            padding-bottom: 0.75rem;
            border-bottom: 1px solid var(--border);
            color: var(--primary);
            font-size: 1.3rem;
            font-weight: bold;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        /* 容器列表卡片 */
        .list-card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 12px;
            overflow: hidden;
        }

        .list-header-bar {
            padding: 1rem 1.5rem;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: rgba(0,0,0,0.2);
        }

        .list-item {
            display: flex;
            align-items: center;
            padding: 1rem 1.5rem;
            border-bottom: 1px solid var(--border);
            transition: background 0.2s;
            gap: 1.5rem;
        }
        .list-item:last-child { border-bottom: none; }
        .list-item:hover { background: var(--bg-card-hover); }

        .item-icon {
            width: 40px;
            height: 40px;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            color: #fff;
            flex-shrink: 0;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }

        .item-info { flex: 1; }
        .item-name { font-weight: 600; font-size: 1rem; margin-bottom: 2px; }
        .item-sub { font-size: 0.85rem; color: var(--text-muted); }

        .item-meta {
            text-align: right;
            min-width: 150px;
        }
        .meta-id { font-family: var(--font-mono); font-size: 0.8rem; color: var(--text-dim); }
        .meta-image { font-family: var(--font-mono); font-size: 0.8rem; color: var(--text-muted); }

        .status-badge {
            padding: 4px 10px;
            border-radius: 6px;
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        .badge-running {
            background: rgba(74, 222, 128, 0.1);
            color: var(--success);
            border: 1px solid rgba(74, 222, 128, 0.2);
        }
        .badge-stopped {
            background: rgba(248, 113, 113, 0.1);
            color: var(--danger);
            border: 1px solid rgba(248, 113, 113, 0.2);
        }

        .empty-state {
            padding: 3rem;
            text-align: center;
            color: var(--text-muted);
            font-size: 0.95rem;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="section-header">
            <span>${title}</span>
            <span style="font-size: 0.9rem; font-weight: normal; color: var(--text-muted)">
                Running: ${totalRunning} / Total: ${totalCount}
            </span>
        </div>

        ${allListItems.length > 0 ? `
        <div class="list-card">
            <div class="list-header-bar">
                <span style="font-weight: bold">Container Name</span>
                <span style="font-size: 0.85rem; color: var(--text-muted)">Status</span>
            </div>
            ${allListItems.join('')}
        </div>
        ` : `
        <div class="list-card">
            <div class="empty-state">暂无容器</div>
        </div>
        `}
    </div>
</body>
</html>
  `

  return html
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
  const fullId = info.Id
  const isRunning = info.State.Running

  // 解析 CPU 百分比用于进度条
  const cpuValue = stats?.cpuPercent ? parseFloat(stats.cpuPercent.replace('%', '')) : 0
  const memValue = stats?.memoryPercent ? parseFloat(stats.memoryPercent.replace('%', '')) : 0

  // 网络信息
  const networks = info.NetworkSettings?.Networks
  const networkEntries = networks && Object.keys(networks).length > 0
    ? Object.entries(networks).map(([netName, net]) => {
        const n = net as any
        const ip = n.IPAddress || '-'
        const gateway = n.Gateway || '-'
        return { name: netName, ip, gateway }
      })
    : []
  const firstNetwork = networkEntries[0]

  // 端口映射标签
  const portTags = ports && ports.length > 0
    ? ports.map(port => {
        const match = port.match(/(.+)\s+->\s+(.+)/)
        if (match) {
          return `<div class="port-tag">${match[1]} <span class="port-arrow">→</span> ${match[2]}</div>`
        }
        return `<div class="port-tag">${port}</div>`
      }).join('')
    : '<div style="color: var(--text-muted); font-size: 0.9rem;">无端口映射</div>'

  // 挂载目录
  const mounts = info.Mounts || []
  const mountItems = mounts.length > 0
    ? mounts.slice(0, 6).map((m) => {
        const mount = m as any
        const source = mount.Source || ''
        const dest = mount.Destination || ''
        const type = mount.Type || 'bind'
        const displaySource = source.length > 40 ? source.slice(0, 40) + '...' : source
        return `
          <div class="mount-item">
            <span class="mount-source">${displaySource}</span>
            <span class="mount-arrow">→</span>
            <span class="mount-dest">${dest}</span>
            <span class="mount-mode">${type}</span>
          </div>
        `
      }).join('')
    : '<div style="color: var(--text-muted); font-size: 0.9rem;">无挂载目录</div>'

  // 环境变量
  const envVars = info.Config?.Env || []
  const envDisplay = envVars.length > 0
    ? envVars.slice(0, 15).join('\n') + (envVars.length > 15 ? `\n... (共 ${envVars.length} 个)` : '')
    : '(无环境变量)'

  // 重启策略
  const restartPolicy = info.HostConfig?.RestartPolicy
  const restartDisplay = restartPolicy?.Name
    ? `${restartPolicy.Name.charAt(0).toUpperCase() + restartPolicy.Name.slice(1)} (最大 ${restartPolicy.MaximumRetryCount || 0} 次)`
    : 'No'

  // 性能监控卡片
  const metricsCards = stats && isRunning ? `
    <div class="metric-card">
      <div class="metric-title">CPU 使用率</div>
      <div class="metric-value">${stats.cpuPercent}</div>
      <div class="progress-bg"><div class="progress-fill" style="width: ${Math.min(cpuValue, 100)}%;"></div></div>
    </div>
    <div class="metric-card">
      <div class="metric-title">内存使用</div>
      <div class="metric-value">${stats.memoryUsage}</div>
      <div class="metric-sub">/ ${stats.memoryLimit}</div>
      <div class="progress-bg"><div class="progress-fill" style="width: ${Math.min(memValue, 100)}%;"></div></div>
    </div>
    <div class="metric-card">
      <div class="metric-title">网络 I/O</div>
      <div class="metric-value">${formatNetwork(stats.networkIn || '0')}</div>
      <div class="metric-sub">↓ ${formatNetwork(stats.networkIn || '0')} / ↑ ${formatNetwork(stats.networkOut || '0')}</div>
    </div>
    <div class="metric-card">
      <div class="metric-title">磁盘 I/O</div>
      <div class="metric-value">${stats.blockIn || '-'}</div>
      <div class="metric-sub">↓ ${stats.blockIn || '-'} / ↑ ${stats.blockOut || '-'}</div>
    </div>
    <div class="metric-card">
      <div class="metric-title">进程数</div>
      <div class="metric-value" style="color: var(--text-main)">${stats.pids}</div>
    </div>
  ` : `
    <div class="metric-card" style="grid-column: 1 / -1; opacity: 0.5;">
      <div class="metric-title">性能监控</div>
      <div class="metric-value" style="font-size: 1.2rem;">${isRunning ? '数据加载中...' : '容器已停止'}</div>
    </div>
  `

  // HTML 内容
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>容器详情 - ${name}</title>
    <style>
        :root {
            --bg-body: #0f172a;
            --bg-card: #1e293b;
            --bg-card-hover: #334155;
            --text-main: #f1f5f9;
            --text-muted: #94a3b8;
            --primary: #38bdf8;
            --success: #4ade80;
            --danger: #f87171;
            --border: #334155;
            --font-mono: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
            --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            background-color: var(--bg-body);
            color: var(--text-main);
            font-family: var(--font-sans);
            line-height: 1.5;
            padding: 2rem;
            min-height: 100vh;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
        }

        /* 顶部头部区域 */
        .header {
            display: flex;
            align-items: center;
            gap: 1.5rem;
            margin-bottom: 2rem;
            background: var(--bg-card);
            padding: 1.5rem;
            border-radius: 16px;
            border: 1px solid var(--border);
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
        }

        .avatar-placeholder {
            width: 64px;
            height: 64px;
            background: linear-gradient(135deg, ${isRunning ? '#4ade80 0%, #3b82f6 100%' : '#f87171 0%, #dc2626 100%'});
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            font-weight: bold;
            color: white;
            box-shadow: 0 0 15px rgba(56, 189, 248, 0.3);
        }

        .header-info h1 {
            font-size: 1.8rem;
            font-weight: 700;
            margin-bottom: 0.25rem;
            display: flex;
            align-items: center;
            gap: 1rem;
        }

        .status-badge {
            font-size: 0.875rem;
            background: rgba(74, 222, 128, 0.15);
            color: var(--success);
            padding: 0.2rem 0.8rem;
            border-radius: 9999px;
            border: 1px solid rgba(74, 222, 128, 0.3);
            display: inline-flex;
            align-items: center;
            gap: 0.4rem;
        }

        .status-dot {
            width: 8px;
            height: 8px;
            background-color: var(--success);
            border-radius: 50%;
            display: inline-block;
            box-shadow: 0 0 8px var(--success);
        }

        .short-id {
            font-family: var(--font-mono);
            color: var(--text-muted);
            font-size: 0.9rem;
            background: rgba(0,0,0,0.2);
            padding: 2px 8px;
            border-radius: 4px;
        }

        /* 网格布局 */
        .dashboard-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 1.5rem;
            margin-bottom: 2rem;
        }

        .card {
            background: var(--bg-card);
            border-radius: 12px;
            padding: 1.5rem;
            border: 1px solid var(--border);
        }

        .card-title {
            color: var(--text-muted);
            font-size: 0.85rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            margin-bottom: 1rem;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        /* 基础信息列表 */
        .info-list {
            display: flex;
            flex-direction: column;
            gap: 1rem;
        }

        .info-item {
            display: flex;
            flex-direction: column;
            gap: 0.25rem;
        }

        .info-label {
            font-size: 0.85rem;
            color: var(--text-muted);
        }

        .info-value {
            font-family: var(--font-mono);
            font-size: 0.95rem;
            word-break: break-all;
        }

        /* 性能监控卡片 */
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            gap: 1rem;
            margin-bottom: 2rem;
        }

        .metric-card {
            background: var(--bg-card);
            padding: 1.5rem;
            border-radius: 12px;
            border: 1px solid var(--border);
            text-align: center;
            transition: transform 0.2s, border-color 0.2s;
            position: relative;
            overflow: hidden;
        }

        .metric-card:hover {
            border-color: var(--primary);
            transform: translateY(-2px);
        }

        .metric-title {
            color: var(--text-muted);
            font-size: 0.85rem;
            margin-bottom: 0.5rem;
        }

        .metric-value {
            font-size: 1.5rem;
            font-weight: 700;
            color: var(--primary);
        }

        .metric-sub {
            font-size: 0.75rem;
            color: var(--text-muted);
            margin-top: 0.25rem;
        }

        /* 进度条模拟 */
        .progress-bg {
            height: 4px;
            background: #334155;
            border-radius: 2px;
            margin-top: 10px;
            width: 100%;
            overflow: hidden;
        }
        .progress-fill {
            height: 100%;
            background: var(--primary);
            border-radius: 2px;
        }

        /* 端口映射 Tag */
        .port-tag {
            display: inline-flex;
            align-items: center;
            background: rgba(56, 189, 248, 0.1);
            color: var(--primary);
            padding: 4px 10px;
            border-radius: 6px;
            font-family: var(--font-mono);
            font-size: 0.9rem;
            margin-right: 0.5rem;
            margin-bottom: 0.5rem;
            border: 1px solid rgba(56, 189, 248, 0.2);
        }
        .port-arrow { color: var(--text-muted); margin: 0 6px; }

        /* 挂载目录 */
        .mount-list {
            display: flex;
            flex-direction: column;
            gap: 0.8rem;
        }
        .mount-item {
            background: rgba(0,0,0,0.2);
            padding: 0.75rem;
            border-radius: 8px;
            font-family: var(--font-mono);
            font-size: 0.85rem;
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            border-left: 3px solid var(--primary);
        }
        .mount-source { color: var(--text-main); }
        .mount-arrow { color: var(--text-muted); margin: 0 10px; }
        .mount-dest { color: var(--primary); }
        .mount-mode {
            margin-left: auto;
            font-size: 0.75rem;
            color: var(--text-muted);
            background: #334155;
            padding: 2px 6px;
            border-radius: 4px;
        }

        /* 环境变量 */
        .env-block {
            background: #000;
            padding: 1rem;
            border-radius: 8px;
            font-family: var(--font-mono);
            font-size: 0.85rem;
            color: #d1d5db;
            white-space: pre-wrap;
            line-height: 1.6;
            max-height: 200px;
            overflow-y: auto;
            border: 1px solid #334155;
        }

        /* 节点标识 */
        .node-tag {
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: var(--bg-card);
            padding: 8px 16px;
            border-radius: 8px;
            border: 1px solid var(--border);
            font-size: 0.85rem;
            color: var(--text-muted);
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- 头部信息 -->
        <header class="header">
            <div class="avatar-placeholder">${name.charAt(0).toUpperCase()}</div>
            <div class="header-info">
                <h1>
                    ${name}
                    <span class="status-badge">
                        <span class="status-dot" style="background-color: ${isRunning ? 'var(--success)' : 'var(--danger)'}; box-shadow: 0 0 8px ${isRunning ? 'var(--success)' : 'var(--danger)'};"></span>
                        ${isRunning ? 'Running' : 'Stopped'}
                    </span>
                </h1>
                <div class="short-id">ID: ${shortId} • 节点: ${nodeName}</div>
            </div>
        </header>

        <!-- 性能监控 (Metrics) -->
        <section class="metrics-grid">
            ${metricsCards}
        </section>

        <!-- 详细信息网格 -->
        <div class="dashboard-grid">
            <!-- 左侧：基础属性 -->
            <div class="card">
                <div class="card-title">
                    <svg style="width:18px;height:18px;vertical-align:text-bottom;stroke-width:2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                    基础信息
                </div>
                <div class="info-list">
                    <div class="info-item">
                        <span class="info-label">镜像 (Image)</span>
                        <span class="info-value" style="color: var(--primary)">${info.Config.Image}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">完整 ID</span>
                        <span class="info-value" style="font-size: 0.8rem; color: var(--text-muted)">${fullId}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">创建时间</span>
                        <span class="info-value">${new Date(info.Created).toLocaleString('zh-CN')}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">启动时间</span>
                        <span class="info-value">${new Date(info.State.StartedAt).toLocaleString('zh-CN')}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">重启策略</span>
                        <span class="info-value">${restartDisplay}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">重启次数</span>
                        <span class="info-value">${info.RestartCount}</span>
                    </div>
                </div>
            </div>

            <!-- 中间：网络与端口 -->
            <div class="card">
                <div class="card-title">
                    <svg style="width:18px;height:18px;vertical-align:text-bottom;stroke-width:2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M2 12h20"></path><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
                    网络配置
                </div>
                <div class="info-list">
                    ${networkEntries.length > 0 ? `
                    <div class="info-item">
                        <span class="info-label">网络模式</span>
                        <span class="info-value">${firstNetwork.name}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">IP 地址</span>
                        <span class="info-value">${firstNetwork.ip} (GW: ${firstNetwork.gateway})</span>
                    </div>
                    ` : ''}
                    <div class="info-item" style="margin-top: 1rem;">
                        <span class="info-label" style="margin-bottom: 0.5rem">端口映射</span>
                        <div>${portTags}</div>
                    </div>
                </div>
            </div>

            <!-- 右侧：挂载与环境 -->
            <div class="card" style="grid-column: 1 / -1;">
                <div class="card-title">
                    <svg style="width:18px;height:18px;vertical-align:text-bottom;stroke-width:2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                    存储挂载 (Volume Mounts)
                </div>
                <div class="mount-list">${mountItems}</div>
            </div>

            <!-- 环境变量 -->
            <div class="card" style="grid-column: 1 / -1;">
                <div class="card-title">
                    <svg style="width:18px;height:18px;vertical-align:text-bottom;stroke-width:2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg>
                    环境变量 (Environment)
                </div>
                <div class="env-block">${envDisplay}</div>
            </div>
        </div>
    </div>
    <div class="node-tag">🖥️ ${nodeName}</div>
</body>
</html>
  `

  return html
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
 * 格式化网络流量显示（累计流量，不是速度）
 */
function formatNetwork(bytes: string): string {
  const num = parseFloat(bytes)
  if (isNaN(num)) return '-'

  if (num === 0) return '0B'
  if (num < 1024) return num.toFixed(0) + 'B'
  if (num < 1024 * 1024) return (num / 1024).toFixed(2) + 'KB'
  if (num < 1024 * 1024 * 1024) return (num / 1024 / 1024).toFixed(2) + 'MB'
  return (num / 1024 / 1024 / 1024).toFixed(2) + 'GB'
}

/**
 * 生成节点列表 HTML（现代化）
 */
export function generateNodesHtml(nodes: any[]): string {
  const onlineCount = nodes.filter(n => {
    const status = n.status || n.Status || 'unknown'
    return status === 'connected' || status === 'running'
  }).length
  const totalCount = nodes.length

  const listItems = nodes.map(n => {
    const status = n.status || n.Status || 'unknown'
    const isOnline = status === 'connected' || status === 'running'
    const isConnecting = status === 'connecting'

    const name = n.name || n.Name || 'Unknown'
    const id = n.id || n.ID || n.Id || '-'
    const tags = (n.tags || []).slice(0, 2)

    return `
      <div class="node-card" style="opacity: ${isOnline ? 1 : isConnecting ? 0.6 : 0.4}">
        <div class="node-left">
          <div class="node-avatar">
            <span class="status-dot ${isOnline ? 'green' : isConnecting ? 'yellow' : 'red'}"></span>
          </div>
          <div>
            <div style="font-weight: bold; font-size: 1.1rem">${name}</div>
            <div style="font-size: 0.85rem; color: var(--text-muted)">${id.slice(0, 8)}</div>
            ${tags.length > 0 ? `<div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;">${tags.map(t => `@${t}`).join(' ')}</div>` : ''}
          </div>
        </div>
        <div class="node-status-text" style="color: ${isOnline ? 'var(--success)' : isConnecting ? 'var(--warning)' : 'var(--danger)'}">
          ${status}
        </div>
      </div>
    `
  }).join('')

  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>节点列表</title>
    <style>
        :root {
            --bg-body: #0f172a;
            --bg-card: #1e293b;
            --text-main: #f1f5f9;
            --text-muted: #94a3b8;
            --success: #4ade80;
            --warning: #fbbf24;
            --danger: #f87171;
            --border: #334155;
            --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            background-color: var(--bg-body);
            color: var(--text-main);
            font-family: var(--font-sans);
            padding: 2rem;
            line-height: 1.5;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
        }

        .section-header {
            margin: 0 0 1.5rem;
            padding-bottom: 0.75rem;
            border-bottom: 1px solid var(--border);
            color: var(--success);
            font-size: 1.3rem;
            font-weight: bold;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .status-dot {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            display: inline-block;
            box-shadow: 0 0 10px currentColor;
        }
        .status-dot.green { background-color: var(--success); color: var(--success); }
        .status-dot.yellow { background-color: var(--warning); color: var(--warning); }
        .status-dot.red { background-color: var(--danger); color: var(--danger); }

        .node-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
            gap: 1rem;
        }

        .node-card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 1.5rem;
            display: flex;
            align-items: center;
            justify-content: space-between;
            transition: transform 0.2s, border-color 0.2s;
        }
        .node-card:hover {
            transform: translateY(-2px);
            border-color: var(--success);
        }

        .node-left { display: flex; align-items: center; gap: 1rem; }
        .node-avatar {
            width: 48px;
            height: 48px;
            background: #334155;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .node-status-text {
            font-family: monospace;
            font-size: 0.9rem;
            font-weight: 600;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="section-header">
            <span>节点列表</span>
            <span class="status-badge" style="font-size: 0.9rem; font-weight: normal; background: rgba(74, 222, 128, 0.1); color: var(--success); padding: 4px 12px; border-radius: 6px;">
                在线: ${onlineCount} / ${totalCount}
            </span>
        </div>

        <div class="node-grid">
            ${listItems}
        </div>
    </div>
</body>
</html>
  `

  return html
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
 * 生成日志 HTML（现代化）
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
  const displayLineCount = displayLines.length

  // 逐行渲染，带行号和高亮
  const logLines = displayLines.map((line, idx) => {
    const lineNum = totalLines - displayLineCount + idx + 1
    return `<div class="log-line">
      <span class="log-num">${lineNum}</span>
      <span class="log-content">${highlightLogContentModern(line)}</span>
    </div>`
  }).join('')

  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>容器日志 - ${containerName}</title>
    <style>
        :root {
            --bg-body: #0f172a;
            --bg-terminal: #111827;
            --bg-card: #1e293b;
            --text-main: #f1f5f9;
            --text-muted: #94a3b8;
            --text-dim: #64748b;
            --primary: #38bdf8;
            --success: #4ade80;
            --warning: #fbbf24;
            --danger: #f87171;
            --border: #334155;
            --font-mono: 'JetBrains Mono', Consolas, monospace;
            --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            background-color: var(--bg-body);
            color: var(--text-main);
            font-family: var(--font-sans);
            padding: 2rem;
            line-height: 1.5;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
        }

        .section-header {
            margin: 0 0 1.5rem;
            padding-bottom: 0.75rem;
            border-bottom: 1px solid var(--border);
            color: var(--primary);
            font-size: 1.3rem;
            font-weight: bold;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .terminal-window {
            background: var(--bg-terminal);
            border: 1px solid var(--border);
            border-radius: 12px;
            font-family: var(--font-mono);
            font-size: 0.85rem;
            color: #d1d5db;
            overflow: hidden;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3);
        }

        .terminal-header {
            background: var(--bg-card);
            padding: 0.8rem 1.5rem;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            font-size: 0.9rem;
            color: var(--text-muted);
        }

        .terminal-body {
            padding: 1rem 0;
            overflow-y: visible;
        }

        .log-line {
            display: flex;
            padding: 2px 1.5rem;
            line-height: 1.5;
            transition: background 0.1s;
        }
        .log-line:hover { background: rgba(255,255,255,0.05); }

        .log-num {
            color: #4b5563;
            min-width: 50px;
            text-align: right;
            margin-right: 20px;
            user-select: none;
            font-size: 0.8rem;
        }

        .log-content { white-space: pre-wrap; word-break: break-all; }

        /* 日志高亮 */
        .log-warn { color: var(--warning); font-weight: 500; }
        .log-error { color: var(--danger); font-weight: 600; background: rgba(239, 68, 68, 0.1); padding: 0 4px; border-radius: 2px; }
        .log-info { color: var(--primary); font-weight: 500; }
        .log-debug { color: var(--text-dim); }
        .log-ip { color: #22d3ee; }
        .log-time { color: #64748b; margin-right: 8px; }
        .log-date { color: #64748b; }
        .log-string { color: #a5f3fc; opacity: 0.9; }
    </style>
</head>
<body>
    <div class="container">
        <div class="section-header">
            <span>📋 容器日志</span>
            <div style="font-family: var(--font-mono); font-size: 0.9rem; background: var(--bg-card); padding: 6px 12px; border-radius: 6px;">
                ${nodeName}/${containerName}
            </div>
        </div>

        <div class="terminal-window">
            <div class="terminal-header">
                <span>显示第 ${totalLines - displayLineCount + 1} - ${totalLines} 行</span>
                <span>共 ${totalLines} 行</span>
            </div>
            <div class="terminal-body">
                ${logLines}
            </div>
        </div>
    </div>
</body>
</html>
  `

  return html
}

/**
 * 高亮日志内容（现代化版本）
 */
function highlightLogContentModern(text: string): string {
  // HTML 转义
  let html = escapeHtml(text)

  // 时间戳高亮
  html = html.replace(
    /(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/g,
    '<span class="log-date">$1</span>'
  )

  // IP 地址高亮
  html = html.replace(
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    '<span class="log-ip">$&</span>'
  )

  // 日志等级高亮
  html = html.replace(
    /(\b(ERROR|ERR|FATAL|CRITICAL|FAIL|FAILED|EXCEPTION)\b)/gi,
    '<span class="log-error">$1</span>'
  )

  html = html.replace(
    /(\b(WARN|WARNING)\b)/gi,
    '<span class="log-warn">$1</span>'
  )

  html = html.replace(
    /(\b(INFO|INFORMATION)\b)/gi,
    '<span class="log-info">$1</span>'
  )

  html = html.replace(
    /(\b(DEBUG|TRACE)\b)/gi,
    '<span class="log-debug">$1</span>'
  )

  // 字符串高亮（匹配 HTML 转义后的引号）
  html = html.replace(
    /(&quot;[^&]*&quot;|&#x27;[^&]*&#x27;)/g,
    '<span class="log-string">$1</span>'
  )

  return html
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
 * 生成 Docker Compose 配置 HTML（现代化）
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
  const highlightedContent = highlightYamlModern(composeContent)

  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Docker Compose - ${projectName}</title>
    <style>
        :root {
            --bg-body: #0f172a;
            --bg-card: #1e293b;
            --bg-editor: #1e1e1e;
            --text-main: #f1f5f9;
            --text-muted: #94a3b8;
            --text-dim: #64748b;
            --primary: #38bdf8;
            --success: #4ade80;
            --border: #334155;
            --font-mono: 'JetBrains Mono', Consolas, monospace;
            --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            background-color: var(--bg-body);
            color: var(--text-main);
            font-family: var(--font-sans);
            padding: 2rem;
            line-height: 1.5;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
        }

        .section-header {
            margin: 0 0 1.5rem;
            padding-bottom: 0.75rem;
            border-bottom: 1px solid var(--border);
            color: var(--success);
            font-size: 1.3rem;
            font-weight: bold;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .editor-container {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3);
        }

        .editor-meta {
            padding: 1.5rem;
            border-bottom: 1px solid var(--border);
            display: flex;
            flex-wrap: wrap;
            gap: 2.5rem;
            background: rgba(0,0,0,0.1);
        }

        .meta-group h4 {
            font-size: 0.8rem;
            color: var(--text-muted);
            margin-bottom: 0.5rem;
            font-weight: normal;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        .meta-group p {
            font-family: var(--font-mono);
            color: var(--text-main);
            font-size: 0.95rem;
        }
        .meta-group p.highlight { color: var(--primary); }

        .code-window {
            background: var(--bg-editor);
            padding: 1.5rem;
            font-family: var(--font-mono);
            font-size: 0.9rem;
            line-height: 1.6;
            overflow-x: auto;
            position: relative;
        }

        /* YAML 语法高亮 (VS Code Dark 风格) */
        .yaml-comment { color: #6a9955; }
        .yaml-key { color: #9cdcfe; }
        .yaml-string { color: #ce9178; }
        .yaml-number { color: #b5cea8; }
        .yaml-boolean { color: #569cd6; }
        .yaml-null { color: #569cd6; }
        .yaml-bracket { color: #ffd700; }
        .yaml-line {
            display: flex;
            line-height: 1.6;
        }
        .yaml-line-numbers {
            min-width: 40px;
            color: #555;
            text-align: right;
            margin-right: 20px;
            user-select: none;
            font-size: 0.8rem;
            opacity: 0.5;
        }
        .yaml-line-content {
            flex: 1;
            white-space: pre-wrap;
            word-break: break-all;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="section-header">
            <span>Docker Compose</span>
            <div style="font-family: var(--font-mono); font-size: 0.9rem; background: var(--bg-card); padding: 6px 12px; border-radius: 6px;">
                ${nodeName}/${containerName}
            </div>
        </div>

        <div class="editor-container">
            <div class="editor-meta">
                <div class="meta-group">
                    <h4>项目名称</h4>
                    <p class="highlight">${projectName}</p>
                </div>
                <div class="meta-group">
                    <h4>服务数量</h4>
                    <p>${serviceCount} <span style="color: var(--success)">↑</span></p>
                </div>
                <div class="meta-group" style="flex: 1; min-width: 300px;">
                    <h4>文件路径</h4>
                    <p style="color: var(--text-muted); font-size: 0.85rem;">${filePath}</p>
                </div>
            </div>

            <div class="code-window">
                ${highlightedContent}
            </div>
        </div>
    </div>
</body>
</html>
  `

  return html
}

/**
 * YAML 语法高亮（现代化版本）
 */
function highlightYamlModern(content: string): string {
  // 按行处理原始内容（未转义）
  const lines = content.split('\n')
  const processedLines = lines.map((line, index) => {
    // 先 HTML 转义整行
    let processedLine = escapeHtml(line)

    // 高亮注释（优先处理）
    if (processedLine.trim().startsWith('#')) {
      return `<div class="yaml-line">
        <span class="yaml-line-numbers">${index + 1}</span>
        <span class="yaml-line-content"><span class="yaml-comment">${processedLine}</span></span>
      </div>`
    }

    // 高亮键名 (行首或缩进后的键名，后面紧跟冒号)
    // 注意：只在非注释行中处理
    if (!processedLine.trim().startsWith('#')) {
      // 先匹配并临时保护已存在的 HTML 标签
      const htmlTags: string[] = []
      processedLine = processedLine.replace(/(&lt;\/?[\w\s="'-]*&gt;|<[\w\s="'-]*>)/g, (match) => {
        htmlTags.push(match)
        return `__HTML_TAG_${htmlTags.length - 1}__`
      })

      // 高亮键名（带冒号的键名）
      processedLine = processedLine.replace(
        /^(\s*)([a-zA-Z0-9_-]+)(\s*):/gm,
        '$1<span class="yaml-key">$2</span>$3:'
      )

      // 高亮带引号的字符串
      processedLine = processedLine.replace(
        /(&quot;(?:[^&]|&amp;|&quot;)*&quot;|&#x27;(?:[^&]|&amp;|&#x27;)*&#x27;)/g,
        '<span class="yaml-string">$1</span>'
      )

      // 高亮数字
      processedLine = processedLine.replace(
        /\b(\d+\.?\d*)\b/g,
        '<span class="yaml-number">$1</span>'
      )

      // 高亮布尔值
      processedLine = processedLine.replace(
        /\b(true|false|yes|no|on|off)\b/gi,
        '<span class="yaml-boolean">$1</span>'
      )

      // 高亮 null
      processedLine = processedLine.replace(
        /\bnull\b/gi,
        '<span class="yaml-null">null</span>'
      )

      // 高亮列表标记
      processedLine = processedLine.replace(
        /^(\s*)(-)(\s)/gm,
        '$1<span class="yaml-bracket">$2</span>$3'
      )

      // 恢复 HTML 标签
      processedLine = processedLine.replace(
        /__HTML_TAG_(\d+)__/g,
        (_, index) => htmlTags[parseInt(index)]
      )
    }

    return `<div class="yaml-line">
      <span class="yaml-line-numbers">${index + 1}</span>
      <span class="yaml-line-content">${processedLine || ' '}</span>
    </div>`
  })

  return processedLines.join('')
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

/**
 * 生成集群信息 HTML
 */
export function generateSwarmInfoHtml(
  nodeName: string,
  swarmInfo: { id: string; name: string; createdAt: string; updatedAt: string }
): string {
  const header = `
    <div class="header">
      <div class="header-title">🐋 Swarm 集群</div>
      <div class="header-badge">${nodeName}</div>
    </div>
  `

  const body = `
    <div class="content">
      <div class="detail-card">
        <div class="detail-grid">
          <div class="detail-item">
            <div class="detail-label">集群 ID</div>
            <div class="detail-value highlight">${swarmInfo.id}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">集群名称</div>
            <div class="detail-value">${swarmInfo.name}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">创建时间</div>
            <div class="detail-value">${swarmInfo.createdAt}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">更新时间</div>
            <div class="detail-value">${swarmInfo.updatedAt}</div>
          </div>
        </div>
      </div>
    </div>
  `

  return wrapHtml(header + body)
}

/**
 * 生成集群节点列表 HTML
 */
export function generateSwarmNodesHtml(
  data: Array<{ node: any; swarmNodes: Array<{
    ID: string
    Hostname: string
    Status: { State: string; Addr: string }
    Availability: string
    Role: string
    ManagerStatus?: { Leader: boolean; Reachability: string } | null
  }> }>,
  title: string = '集群节点'
): string {
  let stats = { total: 0, managers: 0, workers: 0, ready: 0 }

  const content = data.map(({ node, swarmNodes }) => {
    const nodeStats = {
      total: swarmNodes.length,
      managers: swarmNodes.filter(n => n.Role === 'Manager').length,
      workers: swarmNodes.filter(n => n.Role === 'Worker').length,
      ready: swarmNodes.filter(n => n.Status.State === 'ready').length
    }
    stats.total += nodeStats.total
    stats.managers += nodeStats.managers
    stats.workers += nodeStats.workers
    stats.ready += nodeStats.ready

    const listItems = swarmNodes.length === 0
      ? `<div style="padding: 20px; text-align: center; color: #64748b;">(暂无节点)</div>`
      : swarmNodes.map(n => {
        const shortId = n.ID.slice(0, 12)
        const isLeader = n.ManagerStatus?.Leader
        const icon = isLeader ? '👑' : n.Role === 'Manager' ? '🎛️' : '👷'
        const statusIcon = n.Status.State === 'ready' ? '🟢' : '🔴'

        // 可用性状态颜色
        const availabilityColor = n.Availability === 'active' ? '#4ade80' :
                                  n.Availability === 'pause' ? '#facc15' : '#94a3b8'

        return `
          <div class="list-item">
            <div class="status-icon">${icon}</div>
            <div class="name-col">
              <div>${n.Hostname}</div>
              <div style="font-size:12px; opacity:0.6; margin-top:2px;">${n.Status.Addr}</div>
            </div>
            <div class="meta-col">
              <div>ID: ${shortId}</div>
              <div style="color: #64748b; margin-top:2px;">
                ${statusIcon} ${n.Status.State}
                ${n.ManagerStatus?.Reachability ? ` | ${n.ManagerStatus.Reachability}` : ''}
              </div>
            </div>
            <div style="text-align: right;">
              <div class="tag" style="background: rgba(96, 165, 250, 0.1); color: #60a5fa">${n.Role}</div>
              <div class="tag" style="background: rgba(${availabilityColor}, 0.1); color: ${availabilityColor}; margin-top: 4px;">${n.Availability}</div>
            </div>
          </div>
        `
      }).join('')

    return `
      <div style="margin-bottom: 24px;">
        <div style="padding: 12px 16px; background: rgba(0,0,0,0.2); border-radius: 8px 8px 0 0; font-weight: 500; border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; justify-content: space-between;">
          <span>🐋 ${node.name}</span>
          <span style="font-size: 13px; opacity: 0.7;">${nodeStats.managers}M/${nodeStats.workers}W | ${nodeStats.ready} Ready</span>
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
      <div class="header-badge">Total: ${stats.total} | ${stats.managers}M/${stats.workers}W | ${stats.ready} Ready</div>
    </div>
  `

  return wrapHtml(header + '<div class="content">' + content + '</div>')
}

/**
 * 生成集群服务列表 HTML
 */
export function generateSwarmServicesHtml(
  data: Array<{ node: any; services: Array<{
    ID: string
    Name: string
    Replicas: string
    Image: string
    Ports: string
  }> }>,
  title: string = '集群服务'
): string {
  let stats = { total: 0, replicas: 0 }

  const content = data.map(({ node, services }) => {
    const nodeStats = {
      total: services.length,
      replicas: 0
    }

    // 计算副本总数
    services.forEach(s => {
      if (s.Replicas !== 'global' && s.Replicas !== '-') {
        const parts = s.Replicas.split('/')
        const running = parseInt(parts[1]) || 0
        nodeStats.replicas += running
      }
    })

    stats.total += nodeStats.total
    stats.replicas += nodeStats.replicas

    const listItems = services.length === 0
      ? `<div style="padding: 20px; text-align: center; color: #64748b;">(暂无服务)</div>`
      : services.map(s => {
        const shortId = s.ID.slice(0, 12)
        const icon = '🔧'
        const imageName = s.Image.split('@')[0] // 移除 digest 部分

        // 解析副本状态
        let replicaStatus = '-'
        let replicaColor = '#94a3b8'
        if (s.Replicas !== 'global' && s.Replicas !== '-') {
          const parts = s.Replicas.split('/')
          const running = parseInt(parts[0]) || 0
          const total = parseInt(parts[1]) || 0
          if (running === total) {
            replicaColor = '#4ade80'
          } else if (running > 0) {
            replicaColor = '#facc15'
          } else {
            replicaColor = '#f87171'
          }
          replicaStatus = `${running}/${total}`
        } else if (s.Replicas === 'global') {
          replicaColor = '#60a5fa'
          replicaStatus = 'global'
        }

        return `
          <div class="list-item">
            <div class="status-icon">${icon}</div>
            <div class="name-col">
              <div>${s.Name}</div>
              <div style="font-size:12px; opacity:0.6; margin-top:2px;">${imageName}</div>
            </div>
            <div class="meta-col">
              <div>ID: ${shortId}</div>
              <div style="color: #64748b; margin-top:2px;">${s.Ports !== '-' ? s.Ports : '无端口映射'}</div>
            </div>
            <div style="text-align: right;">
              <span class="tag" style="background: rgba(${replicaColor}, 0.1); color: ${replicaColor}">${replicaStatus}</span>
            </div>
          </div>
        `
      }).join('')

    return `
      <div style="margin-bottom: 24px;">
        <div style="padding: 12px 16px; background: rgba(0,0,0,0.2); border-radius: 8px 8px 0 0; font-weight: 500; border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; justify-content: space-between;">
          <span>🐋 ${node.name}</span>
          <span style="font-size: 13px; opacity: 0.7;">${nodeStats.total} 个服务 | ${nodeStats.replicas} 个副本</span>
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
      <div class="header-badge">Total: ${stats.total} services | ${stats.replicas} replicas</div>
    </div>
  `

  return wrapHtml(header + '<div class="content">' + content + '</div>')
}

/**
 * 生成集群任务列表 HTML
 */
export function generateSwarmTasksHtml(
  data: Array<{ node: any; serviceName: string; tasks: Array<{
    ID: string
    Slot: string
    Status: { State: string; Since: string }
    DesiredState: string
    NodeID: string
  }> }>,
  title: string
): string {
  let stats = { total: 0, running: 0, failed: 0 }

  const content = data.map(({ node, serviceName, tasks }) => {
    const nodeStats = {
      total: tasks.length,
      running: 0,
      failed: 0
    }

    tasks.forEach(t => {
      if (t.Status.State === 'running') nodeStats.running++
      if (t.Status.State === 'failed') nodeStats.failed++
    })

    stats.total += nodeStats.total
    stats.running += nodeStats.running
    stats.failed += nodeStats.failed

    const listItems = tasks.length === 0
      ? `<div style="padding: 20px; text-align: center; color: #64748b;">(暂无任务)</div>`
      : tasks.map(t => {
        const shortId = t.ID.slice(0, 12)
        const statusIcon = t.Status.State === 'running' ? '🟢' :
                          t.Status.State === 'pending' ? '⏳' :
                          t.Status.State === 'failed' ? '❌' :
                          t.Status.State === 'complete' ? '✅' : '⚪'

        const statusColor = t.Status.State === 'running' ? '#4ade80' :
                           t.Status.State === 'pending' ? '#facc15' :
                           t.Status.State === 'failed' ? '#f87171' :
                           t.Status.State === 'complete' ? '#60a5fa' : '#94a3b8'

        return `
          <div class="list-item">
            <div class="status-icon">${statusIcon}</div>
            <div class="name-col">
              <div>Slot ${t.Slot}</div>
              <div style="font-size:12px; opacity:0.6; margin-top:2px;">${t.Status.Since}</div>
            </div>
            <div class="meta-col">
              <div>ID: ${shortId}</div>
              <div style="color: #64748b; margin-top:2px;">Node: ${t.NodeID}</div>
            </div>
            <div style="text-align: right;">
              <span class="tag" style="background: rgba(${statusColor}, 0.1); color: ${statusColor}">${t.Status.State}</span>
            </div>
          </div>
        `
      }).join('')

    return `
      <div style="margin-bottom: 24px;">
        <div style="padding: 12px 16px; background: rgba(0,0,0,0.2); border-radius: 8px 8px 0 0; font-weight: 500; border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; justify-content: space-between;">
          <span>🐋 ${node.name} - ${serviceName}</span>
          <span style="font-size: 13px; opacity: 0.7;">${nodeStats.running}/${nodeStats.total} Running</span>
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
      <div class="header-badge">Total: ${stats.total} | ${stats.running} Running | ${stats.failed} Failed</div>
    </div>
  `

  return wrapHtml(header + '<div class="content">' + content + '</div>')
}
