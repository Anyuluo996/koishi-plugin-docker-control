/**
 * SSH 连接器 - 通过 SSH 执行 docker 命令
 */
import { Client, ClientChannel, ConnectConfig } from 'ssh2'
import type { NodeConfig, CredentialConfig, DockerControlConfig } from '../types'
import { SSH_TIMEOUT } from '../constants'
import { getCredentialById } from '../config'
import { connectorLogger } from '../utils/logger'

export class DockerConnector {
  private sshClient: Client | null = null

  constructor(
    private config: NodeConfig,
    private fullConfig: DockerControlConfig
  ) { }

  /**
   * 执行 SSH 命令
   */
  async exec(command: string): Promise<string> {
    let lastError: any

    // 自动重试一次
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.execInternal(command)
      } catch (err: any) {
        lastError = err
        const msg = err.message || ''

        // 如果是 SSH 通道打开失败，或者是连接已结束，则强制重连
        if (msg.includes('Channel open failure') || msg.includes('Client ended') || msg.includes('Socket ended')) {
          connectorLogger.warn(`[${this.config.name}] SSH 连接异常 (${msg})，尝试重连...`)
          this.dispose() // 强制销毁当前连接
          continue // 重试
        }

        // 其他错误直接抛出
        throw err
      }
    }

    throw lastError
  }

  private async execInternal(command: string): Promise<string> {
    const client = await this.getConnection()

    connectorLogger.debug(`[${this.config.name}] 执行命令: ${command}`)

    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) {
          connectorLogger.debug(`[${this.config.name}] 命令执行错误: ${err.message}`)
          reject(err)
          return
        }

        let stdout = ''
        let stderr = ''

        stream.on('close', (code: number, signal: string) => {
          connectorLogger.debug(`[${this.config.name}] 命令完成: code=${code}, signal=${signal}`)
          // 显式结束 stream 防止 channel 泄露
          try {
            stream.end()
          } catch (e) {
            // 可能已经关闭，忽略错误
          }
          if (stderr.includes('Error') || stderr.includes('error')) {
            reject(new Error(stderr.trim()))
          } else {
            resolve(stdout.trim())
          }
        })

        stream.on('data', (data: Buffer) => {
          stdout += data.toString()
        })

        stream.on('err', (data: Buffer) => {
          stderr += data.toString()
        })
      })
    })
  }

  /**
   * 执行 docker ps 获取容器列表
   */
  async listContainers(all = true): Promise<string> {
    const flag = all ? '-a' : ''
    // 使用双引号包裹 format，以兼容 Windows CMD
    return this.exec(`docker ps -a --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}" ${flag}`)
  }

  /**
   * 执行 docker start
   */
  async startContainer(containerId: string): Promise<void> {
    await this.exec(`docker start ${containerId}`)
  }

  /**
   * 执行 docker stop
   */
  async stopContainer(containerId: string, timeout = 10): Promise<void> {
    await this.exec(`docker stop -t ${timeout} ${containerId}`)
  }

  /**
   * 执行 docker restart
   */
  async restartContainer(containerId: string, timeout = 10): Promise<void> {
    await this.exec(`docker restart -t ${timeout} ${containerId}`)
  }

  /**
   * 获取容器日志
   */
  async getLogs(containerId: string, tail = 100): Promise<string> {
    return this.exec(`docker logs --tail ${tail} ${containerId} 2>&1`)
  }

  /**
   * 执行容器内命令
   */
  async execContainer(containerId: string, cmd: string): Promise<string> {
    // 使用 docker exec 需要处理引号
    const escapedCmd = cmd.replace(/'/g, "'\\''")
    return this.exec(`docker exec ${containerId} sh -c '${escapedCmd}'`)
  }

  /**
   * 监听 Docker 事件流
   * @param callback 每行事件数据的回调
   * @returns 停止监听的方法
   */
  async startEventStream(callback: (line: string) => void): Promise<() => void> {
    const client = await this.getConnection()

    connectorLogger.debug(`[${this.config.name}] 正在启动事件流监听...`)

    return new Promise((resolve, reject) => {
      client.exec(`docker events --format "{{json .}}" --filter "type=container"`, (err, stream) => {
        if (err) {
          connectorLogger.error(`[${this.config.name}] 启动事件流失败: ${err.message}`)
          reject(err)
          return
        }

        connectorLogger.info(`[${this.config.name}] Docker 事件流已连接`)
        let buffer = ''
        let closed = false

        const stop = () => {
          if (!closed) {
            closed = true
            // [新增] 强制销毁流，防止僵尸连接
            try {
              stream.unpipe()
              stream.destroy()
              // 清理引用
              ;(this as any)._eventStream = null
            } catch (e) {
              // 可能已经关闭，忽略错误
            }
            connectorLogger.debug(`[${this.config.name}] 主动停止事件流`)
          }
        }

        stream.on('close', (code: any, signal: any) => {
          if (!closed) {
            closed = true
            connectorLogger.warn(`[${this.config.name}] 事件流意外断开 (Code: ${code}, Signal: ${signal})`)
          }
        })

        stream.on('data', (data: Buffer) => {
          buffer += data.toString()

          // 按行处理，解决 TCP 粘包问题
          let newlineIndex
          while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIndex).trim()
            buffer = buffer.slice(newlineIndex + 1)
            if (line) {
              callback(line)
            }
          }
        })

        stream.stderr.on('data', (data: Buffer) => {
          connectorLogger.debug(`[${this.config.name}] 事件流 stderr: ${data.toString().trim()}`)
        })

        // 存储引用
        ;(this as any)._eventStream = stream

        resolve(stop)
      })
    })
  }

  private connected = true

  /**
   * 标记连接状态
   */
  setConnected(status: boolean): void {
    this.connected = status
  }

  /**
   * 销毁连接
   */
  dispose() {
    if (this.sshClient) {
      this.sshClient.end()
      this.sshClient = null
    }
  }

  /**
   * 获取 SSH 连接
   */
  private async getConnection(): Promise<Client> {
    if (!this.sshClient) {
      this.sshClient = await this.createConnection()
    }
    return this.sshClient
  }

  /**
   * 创建 SSH 连接
   */
  private async createConnection(): Promise<Client> {
    const credential = this.getCredential()
    if (!credential) {
      throw new Error(`凭证不存在: ${this.config.credentialId}`)
    }

    connectorLogger.info(`[${this.config.name}] 正在连接到 ${this.config.host}:${this.config.port}`)
    connectorLogger.debug(`[${this.config.name}] 用户名: ${credential.username}, 认证方式: ${credential.authType}`)

    return new Promise((resolve, reject) => {
      const conn = new Client()

      conn.on('ready', () => {
        connectorLogger.info(`[${this.config.name}] SSH 连接成功`)
        resolve(conn)
      })

      conn.on('error', (err: any) => {
        connectorLogger.error(`[${this.config.name}] SSH 连接失败: ${err.message}`)
        conn.end()
        reject(err)
      })

      conn.on('close', () => {
        connectorLogger.debug(`[${this.config.name}] SSH 连接关闭`)
      })

      conn.on('banner', (msg: string) => {
        connectorLogger.debug(`[${this.config.name}] SSH Banner: ${msg.trim()}`)
      })

      const connectConfig: ConnectConfig = {
        host: this.config.host,
        port: this.config.port,
        username: credential.username,
        readyTimeout: SSH_TIMEOUT,
        timeout: SSH_TIMEOUT,
        tryKeyboard: true,
        ...this.buildAuthOptions(credential),
      }

      conn.connect(connectConfig)
    })
  }

  /**
   * 构建认证选项
   */
  private buildAuthOptions(credential: CredentialConfig): Partial<ConnectConfig> {
    const options: Partial<ConnectConfig> = {}

    if (credential.authType === 'password') {
      options.password = credential.password
    } else {
      if (credential.privateKey) {
        options.privateKey = Buffer.from(credential.privateKey, 'utf8')
      }
      if (credential.passphrase) {
        options.passphrase = credential.passphrase
      }
    }

    return options
  }

  /**
   * 获取凭证配置
   */
  private getCredential(): CredentialConfig | undefined {
    return getCredentialById(this.fullConfig, this.config.credentialId)
  }
}
