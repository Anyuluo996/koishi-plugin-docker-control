/**
 * 增强功能常量定义
 */

// ==================== 权限定义 ====================

export const PERMISSIONS = {
  // 节点权限
  NODE_VIEW: { id: 'node.view', name: '查看节点', description: '查看节点信息和状态', resource: 'node' as const, action: 'view' as const },
  NODE_CONNECT: { id: 'node.connect', name: '连接节点', description: '连接到 Docker 节点', resource: 'node' as const, action: 'view' as const },

  // 容器权限
  CONTAINER_VIEW: { id: 'container.view', name: '查看容器', description: '查看容器列表和详情', resource: 'container' as const, action: 'view' as const },
  CONTAINER_START: { id: 'container.start', name: '启动容器', description: '启动已停止的容器', resource: 'container' as const, action: 'start' as const },
  CONTAINER_STOP: { id: 'container.stop', name: '停止容器', description: '停止运行中的容器', resource: 'container' as const, action: 'stop' as const },
  CONTAINER_RESTART: { id: 'container.restart', name: '重启容器', description: '重启容器', resource: 'container' as const, action: 'restart' as const },
  CONTAINER_EXEC: { id: 'container.exec', name: '执行命令', description: '在容器内执行命令', resource: 'container' as const, action: 'exec' as const },
  CONTAINER_DELETE: { id: 'container.delete', name: '删除容器', description: '删除容器', resource: 'container' as const, action: 'delete' as const },
  CONTAINER_UPDATE: { id: 'container.update', name: '更新容器', description: '更新容器配置或镜像', resource: 'container' as const, action: 'update' as const },
  CONTAINER_CREATE: { id: 'container.create', name: '创建容器', description: '创建新容器', resource: 'container' as const, action: 'create' as const },

  // 镜像权限
  IMAGE_VIEW: { id: 'image.view', name: '查看镜像', description: '查看镜像列表和详情', resource: 'image' as const, action: 'view' as const },
  IMAGE_PULL: { id: 'image.pull', name: '拉取镜像', description: '从仓库拉取镜像', resource: 'image' as const, action: 'update' as const },
  IMAGE_DELETE: { id: 'image.delete', name: '删除镜像', description: '删除镜像', resource: 'image' as const, action: 'delete' as const },
  IMAGE_BUILD: { id: 'image.build', name: '构建镜像', description: '构建 Docker 镜像', resource: 'image' as const, action: 'create' as const },

  // 网络权限
  NETWORK_VIEW: { id: 'network.view', name: '查看网络', description: '查看 Docker 网络列表', resource: 'network' as const, action: 'view' as const },
  NETWORK_CREATE: { id: 'network.create', name: '创建网络', description: '创建 Docker 网络', resource: 'network' as const, action: 'create' as const },
  NETWORK_DELETE: { id: 'network.delete', name: '删除网络', description: '删除 Docker 网络', resource: 'network' as const, action: 'delete' as const },

  // 存储卷权限
  VOLUME_VIEW: { id: 'volume.view', name: '查看存储卷', description: '查看存储卷列表', resource: 'volume' as const, action: 'view' as const },
  VOLUME_CREATE: { id: 'volume.create', name: '创建存储卷', description: '创建 Docker 存储卷', resource: 'volume' as const, action: 'create' as const },
  VOLUME_DELETE: { id: 'volume.delete', name: '删除存储卷', description: '删除 Docker 存储卷', resource: 'volume' as const, action: 'delete' as const },
}

// 预定义角色
export const ROLES = {
  ADMIN: {
    id: 'admin',
    name: '管理员',
    description: '拥有所有权限',
    permissions: Object.values(PERMISSIONS).map(p => p.id),
  },
  OPERATOR: {
    id: 'operator',
    name: '操作员',
    description: '可以操作容器和查看资源',
    permissions: [
      'node.view',
      'container.view', 'container.start', 'container.stop', 'container.restart', 'container.exec',
      'image.view',
      'network.view',
      'volume.view',
    ],
  },
  VIEWER: {
    id: 'viewer',
    name: '查看者',
    description: '只能查看资源',
    permissions: [
      'node.view',
      'container.view',
      'image.view',
      'network.view',
      'volume.view',
    ],
  },
}

// ==================== 默认配置 ====================

export const DEFAULT_CONNECTION_POOL_CONFIG = {
  enabled: true,
  maxConnectionsPerNode: 5,
  minConnectionsPerNode: 1,
  connectionTimeout: 30000,
  idleTimeout: 300000,
  healthCheckInterval: 60000,
}

export const DEFAULT_CACHE_CONFIG = {
  enabled: true,
  defaultTTL: 30000,
  cleanupInterval: 60000,
  maxCacheSize: 1000,
}

export const DEFAULT_PERMISSION_CONFIG = {
  enabled: true,
  defaultRole: 'viewer' as const,
  adminUsers: [] as string[],
}

export const DEFAULT_AUDIT_CONFIG = {
  enabled: true,
  retentionDays: 90,
  sensitiveFields: ['password', 'privateKey', 'passphrase'],
}

export const DEFAULT_RECONNECT_CONFIG = {
  enabled: true,
  maxAttempts: 10,
  initialDelay: 1000,
  maxDelay: 60000,
  heartbeatInterval: 30000,
}

export const DEFAULT_RETRY_CONFIG = {
  maxAttempts: 3,
  initialDelay: 1000,
  maxDelay: 10000,
  retryableErrors: ['ETIMEDOUT', 'ECONNRESET', 'SSH_TIMEOUT', 'Channel open failure'],
}
