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
    return this.exec(`docker ps -a --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}' ${flag}`)
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
