/**
 * 统一日志模块
 * 提供带命名空间的日志器，支持调试模式
 */
import { Logger } from 'koishi'

// 主日志器
export const logger = new Logger('docker-control')

// 子日志器工厂
function createSubLogger(name: string): Logger {
  return logger.extend(name)
}

// 子日志器
export const nodeLogger = createSubLogger('node')
export const connectorLogger = createSubLogger('connector')
export const monitorLogger = createSubLogger('monitor')
export const notifierLogger = createSubLogger('notifier')
export const commandLogger = createSubLogger('command')

/**
 * 创建带命名空间的日志器
 */
export function createLogger(name: string): Logger {
  return createSubLogger(name)
}

/**
 * 格式化日志消息
 */
export function formatMessage(message: string, ...args: any[]): string {
  if (args.length === 0) return message
  try {
    return args.length > 1
      ? message.replace(/\{(\d+)\}/g, (_, index) => String(args[index] || ''))
      : String(args[0])
  } catch {
    return message
  }
}

/**
 * 节点操作日志 - 便捷方法
 */
export const node = {
  info: (nodeName: string, message: string, ...args: any[]) =>
    nodeLogger.info(`[${nodeName}] ${formatMessage(message, ...args)}`),
  warn: (nodeName: string, message: string, ...args: any[]) =>
    nodeLogger.warn(`[${nodeName}] ${formatMessage(message, ...args)}`),
  error: (nodeName: string, message: string, ...args: any[]) =>
    nodeLogger.error(`[${nodeName}] ${formatMessage(message, ...args)}`),
  debug: (nodeName: string, message: string, ...args: any[]) =>
    nodeLogger.debug(`[${nodeName}] ${formatMessage(message, ...args)}`),
}

/**
 * 连接器日志 - 便捷方法
 */
export const connector = {
  info: (nodeName: string, message: string, ...args: any[]) =>
    connectorLogger.info(`[${nodeName}] ${formatMessage(message, ...args)}`),
  warn: (nodeName: string, message: string, ...args: any[]) =>
    connectorLogger.warn(`[${nodeName}] ${formatMessage(message, ...args)}`),
  error: (nodeName: string, message: string, ...args: any[]) =>
    connectorLogger.error(`[${nodeName}] ${formatMessage(message, ...args)}`),
  debug: (nodeName: string, message: string, ...args: any[]) =>
    connectorLogger.debug(`[${nodeName}] ${formatMessage(message, ...args)}`),
}

/**
 * 监控日志 - 便捷方法
 */
export const monitor = {
  info: (nodeName: string, message: string, ...args: any[]) =>
    monitorLogger.info(`[${nodeName}] ${formatMessage(message, ...args)}`),
  warn: (nodeName: string, message: string, ...args: any[]) =>
    monitorLogger.warn(`[${nodeName}] ${formatMessage(message, ...args)}`),
  error: (nodeName: string, message: string, ...args: any[]) =>
    monitorLogger.error(`[${nodeName}] ${formatMessage(message, ...args)}`),
  debug: (nodeName: string, message: string, ...args: any[]) =>
    monitorLogger.debug(`[${nodeName}] ${formatMessage(message, ...args)}`),
}

/**
 * 通知日志 - 便捷方法
 */
export const notify = {
  info: (message: string, ...args: any[]) =>
    notifierLogger.info(formatMessage(message, ...args)),
  warn: (message: string, ...args: any[]) =>
    notifierLogger.warn(formatMessage(message, ...args)),
  error: (message: string, ...args: any[]) =>
    notifierLogger.error(formatMessage(message, ...args)),
  debug: (message: string, ...args: any[]) =>
    notifierLogger.debug(formatMessage(message, ...args)),
  success: (message: string, ...args: any[]) =>
    notifierLogger.info(`✓ ${formatMessage(message, ...args)}`),
}

/**
 * 指令日志 - 便捷方法
 */
export const command = {
  info: (message: string, ...args: any[]) =>
    commandLogger.info(formatMessage(message, ...args)),
  warn: (message: string, ...args: any[]) =>
    commandLogger.warn(formatMessage(message, ...args)),
  error: (message: string, ...args: any[]) =>
    commandLogger.error(formatMessage(message, ...args)),
  debug: (message: string, ...args: any[]) =>
    commandLogger.debug(formatMessage(message, ...args)),
}
