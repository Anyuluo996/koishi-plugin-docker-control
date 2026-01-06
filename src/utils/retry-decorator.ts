/**
 * 重试装饰器
 * 为异步方法提供自动重试功能
 */
import type { RetryConfig } from '../types/enhanced'
import { nodeLogger } from '../utils/logger'

/**
 * 重试装饰器
 */
export function Retry(options: Partial<RetryConfig> = {}) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value

    const config: RetryConfig = {
      maxAttempts: options.maxAttempts ?? 3,
      initialDelay: options.initialDelay ?? 1000,
      maxDelay: options.maxDelay ?? 10000,
      retryableErrors: options.retryableErrors ?? [
        'ETIMEDOUT',
        'ECONNRESET',
        'SSH_TIMEOUT',
        'Channel open failure',
        'Client ended',
        'Socket ended',
      ],
    }

    descriptor.value = async function (...args: any[]) {
      let lastError: Error

      for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
        try {
          return await originalMethod.apply(this, args)
        } catch (error) {
          lastError = error

          // 检查是否可重试
          const isRetryable = config.retryableErrors.some((pattern) =>
            error.message.includes(pattern)
          )

          if (!isRetryable) {
            nodeLogger.debug(
              `[重试] 错误不可重试: ${error.message}`
            )
            throw error
          }

          // 最后一次尝试失败，不再重试
          if (attempt === config.maxAttempts - 1) {
            nodeLogger.error(
              `[重试] 达到最大重试次数 (${config.maxAttempts}): ${error.message}`
            )
            throw error
          }

          // 计算退避时间
          const backoff = Math.min(
            config.initialDelay * Math.pow(2, attempt),
            config.maxDelay
          )

          const className = (this as any).constructor?.name || 'Unknown'
          const methodName = propertyKey

          nodeLogger.warn(
            `[重试] ${className}.${methodName} 失败，${backoff}ms 后重试 (${attempt + 1}/${config.maxAttempts}): ${error.message}`
          )

          await new Promise((resolve) => setTimeout(resolve, backoff))
        }
      }

      throw lastError
    }

    return descriptor
  }
}

/**
 * 幂等性装饰器
 * 防止相同操作重复执行
 */
export function Idempotent(
  keyGenerator?: (...args: any[]) => string
) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value
    const ongoing = new Map<string, Promise<any>>()

    descriptor.value = async function (...args: any[]) {
      // 生成唯一键
      let key: string
      if (keyGenerator) {
        key = keyGenerator(...args)
      } else {
        key = `${target.constructor.name}:${propertyKey}:${JSON.stringify(args)}`
      }

      // 检查是否有相同操作正在进行
      const ongoingPromise = ongoing.get(key)
      if (ongoingPromise) {
        nodeLogger.debug(`[幂等] 操作正在进行，等待完成: ${key}`)
        return ongoingPromise
      }

      // 执行操作
      const promise = originalMethod.apply(this, args)
        .finally(() => {
          // 完成后清理
          ongoing.delete(key)
        })

      ongoing.set(key, promise)
      return promise
    }

    return descriptor
  }
}
