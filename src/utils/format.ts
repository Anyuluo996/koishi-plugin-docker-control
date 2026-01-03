/**
 * 格式化工具
 */

/**
 * 格式化字节大小
 */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 B'

  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i]
}

/**
 * 格式化时间
 */
export function formatTime(
  timestamp: number | string | Date,
  format: 'iso' | 'local' | 'relative' = 'local'
): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp)

  switch (format) {
    case 'iso':
      return date.toISOString()
    case 'relative':
      return formatRelativeTime(date)
    case 'local':
    default:
      return date.toLocaleString('zh-CN')
  }
}

/**
 * 相对时间格式化
 */
export function formatRelativeTime(date: Date): string {
  const now = new Date()
  const diff = now.getTime() - date.getTime()

  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 60) {
    return '刚刚'
  } else if (minutes < 60) {
    return `${minutes} 分钟前`
  } else if (hours < 24) {
    return `${hours} 小时前`
  } else if (days < 7) {
    return `${days} 天前`
  } else {
    return date.toLocaleDateString('zh-CN')
  }
}

/**
 * 格式化容器状态
 */
export function formatContainerStatus(
  state: string,
  running: boolean
): string {
  if (running) {
    return `运行中 (${state})`
  }

  const statusMap: Record<string, string> = {
    exited: '已停止',
    stopped: '已停止',
    created: '已创建',
    paused: '已暂停',
    restarting: '重启中',
    dead: '已失效',
  }

  return statusMap[state.toLowerCase()] || state
}

/**
 * 截断字符串
 */
export function truncate(str: string, maxLength: number, suffix = '...'): string {
  if (str.length <= maxLength) {
    return str
  }
  return str.slice(0, maxLength - suffix.length) + suffix
}

/**
 * 移除 ANSI 颜色码
 */
export function stripAnsiCodes(str: string): string {
  return str.replace(/[\x1b\u001b[0-9;]*[a-zA-Z]/g, '')
}

/**
 * 格式化表格
 */
export function formatTable<T>(
  data: T[],
  columns: Array<{ key: keyof T; header: string; width: number }>
): string {
  if (data.length === 0) {
    return ''
  }

  const lines: string[] = []

  // 表头
  const header = columns
    .map((col) => col.header.padEnd(col.width))
    .join(' | ')
  lines.push(header)

  // 分隔线
  const separator = columns.map((col) => '-'.repeat(col.width)).join('-+-')
  lines.push(separator)

  // 数据行
  for (const row of data) {
    const line = columns
      .map((col) => {
        const value = String(row[col.key] ?? '')
        return value.slice(0, col.width).padEnd(col.width)
      })
      .join(' | ')
    lines.push(line)
  }

  return lines.join('\n')
}

/**
 * 颜色状态图标
 */
export function getStatusEmoji(status: string, running: boolean): string {
  if (running) {
    return '🟢'
  }

  const statusEmoji: Record<string, string> = {
    exited: '🔴',
    stopped: '🔴',
    created: '⚪',
    paused: '🟣',
    restarting: '🟡',
    dead: '⚫',
  }

  return statusEmoji[status.toLowerCase()] || '🔴'
}
