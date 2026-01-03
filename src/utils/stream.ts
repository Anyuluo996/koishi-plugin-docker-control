/**
 * 流处理工具
 */

/**
 * 将 Stream 转换为字符串
 */
export async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []

  return new Promise((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => {
      const buffer = Buffer.concat(chunks)
      resolve(buffer.toString('utf8'))
    })
    stream.on('error', reject)
  })
}

/**
 * 将字符串转换为 Stream
 */
export function stringToStream(
  content: string,
  encoding: BufferEncoding = 'utf8'
): NodeJS.ReadableStream {
  const { Readable } = require('stream') as typeof import('stream')
  return Readable.from([Buffer.from(content, encoding)])
}

/**
 * 合并多个 Stream
 */
export function mergeStreams(
  streams: NodeJS.ReadableStream[]
): NodeJS.ReadableStream {
  const { Readable, PassThrough } = require('stream') as typeof import('stream')

  const output = new PassThrough()

  let pending = streams.length

  if (pending === 0) {
    output.end()
    return output
  }

  for (const stream of streams) {
    stream.on('data', (chunk: Buffer) => output.write(chunk))
    stream.on('end', () => {
      pending--
      if (pending === 0) {
        output.end()
      }
    })
    stream.on('error', (err: Error) => {
      output.destroy(err)
    })
  }

  return output
}

/**
 * 限流 Stream
 * 控制数据输出的速度
 */
export function throttleStream(
  stream: NodeJS.ReadableStream,
  maxBytesPerSecond: number
): NodeJS.ReadableStream {
  const { PassThrough } = require('stream') as typeof import('stream')
  const output = new PassThrough()

  let bytesWritten = 0
  let lastTime = Date.now()

  const checkThrottle = () => {
    const now = Date.now()
    const elapsed = now - lastTime
    if (elapsed >= 1000) {
      bytesWritten = 0
      lastTime = now
    }
  }

  stream.on('data', (chunk: Buffer) => {
    checkThrottle()

    if (bytesWritten + chunk.length > maxBytesPerSecond) {
      // 需要限流，延迟写入
      const delay = Math.ceil(
        ((bytesWritten + chunk.length - maxBytesPerSecond) /
          maxBytesPerSecond) *
          1000
      )

      setTimeout(() => {
        output.write(chunk)
      }, delay)
    } else {
      output.write(chunk)
    }

    bytesWritten += chunk.length
  })

  stream.on('end', () => output.end())
  stream.on('error', (err: Error) => output.destroy(err))

  return output
}

/**
 * 解码 Stream (处理 ANSI 转义码)
 */
export function decodeStream(
  stream: NodeJS.ReadableStream
): NodeJS.ReadableStream {
  const { PassThrough } = require('stream') as typeof import('stream')
  const output = new PassThrough()

  let buffer = ''

  stream.on('data', (chunk: Buffer) => {
    // 解码 UTF-8
    const text = chunk.toString('utf8')
    buffer += text

    // 按行处理
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      // 移除 ANSI 转义码
      const cleanLine = line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
      output.write(cleanLine + '\n')
    }
  })

  stream.on('end', () => {
    if (buffer) {
      output.write(buffer)
    }
    output.end()
  })

  stream.on('error', (err: Error) => output.destroy(err))

  return output
}

/**
 * 截取 Stream 的最后 N 行
 */
export function tailStream(
  stream: NodeJS.ReadableStream,
  maxLines: number
): NodeJS.ReadableStream {
  const { PassThrough } = require('stream') as typeof import('stream')
  const output = new PassThrough()

  const lines: string[] = []

  stream.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    const newLines = text.split('\n')

    // 将新行加入队列
    if (lines.length > 0) {
      lines[lines.length - 1] += newLines[0]
      lines.push(...newLines.slice(1))
    } else {
      lines.push(...newLines)
    }

    // 保持最大行数
    while (lines.length > maxLines + 1) {
      lines.shift()
    }
  })

  stream.on('end', () => {
    // 输出保留的行
    if (lines.length > 1) {
      output.write(lines.slice(1).join('\n'))
    }
    output.end()
  })

  stream.on('error', (err: Error) => output.destroy(err))

  return output
}
