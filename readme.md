# koishi-plugin-docker-control

Koishi 插件 - 通过 SSH 管理远程 Docker 容器

## 简介

通过 SSH 连接管理远程 Docker 容器，支持容器列表、启动、停止、重启、日志查看、命令执行等功能。

## 快速开始

### 1. 配置节点

在 Koishi 控制台配置 SSH 凭证和 Docker 节点。

### 2. 订阅容器通知

```
# 订阅指定节点的指定容器
docker.subscribe yun myapp

# 订阅指定节点的所有容器
docker.subscribe yun all

# 订阅所有节点的指定容器
docker.subscribe all myapp

# 订阅所有容器的所有事件
docker.subscribe all all

# 只监听启动和停止事件
docker.subscribe all all -e start,stop
```

### 3. 查看订阅

```
docker.subscriptions
```

### 4. 取消订阅

```
docker.unsubscribe <订阅ID>
```

## 指令说明

### 基础指令

| 指令 | 说明 |
|------|------|
| `docker.ls` | 列出所有节点容器 |
| `docker.ls <selector>` | 列出指定节点容器 |
| `docker.ls -a` | 列出所有容器（含已停止） |
| `docker.ls -f image` | 图片格式输出 |

### 控制指令

| 指令 | 说明 |
|------|------|
| `docker.start <selector> <container>` | 启动容器 |
| `docker.stop <selector> <container>` | 停止容器 |
| `docker.restart <selector> <container>` | 重启容器 |
| `docker.inspect <selector> <container>` | 查看容器详情 |

### 日志与执行

| 指令 | 说明 |
|------|------|
| `docker.logs <container>` | 查看容器日志（自动搜索） |
| `docker.logs <container> <node>` | 查看指定节点容器日志 |
| `docker.logs <container> -n 100` | 查看最近 100 行日志 |
| `docker.exec <selector> <container> <cmd>` | 在容器内执行命令 |

### 订阅指令

| 指令 | 说明 |
|------|------|
| `docker.subscribe <node> <container>` | 订阅容器通知 |
| `docker.subscriptions` | 查看当前订阅 |
| `docker.unsubscribe <id>` | 取消订阅 |

## 参数说明

- **selector**: 节点选择器，支持节点 ID、节点名称或 `@标签`
- **container**: 容器名称或 ID（支持模糊匹配）
- **-n**: 日志行数限制
- **-a**: 显示所有容器（含已停止）
- **-f**: 输出格式（simple/detail/json/image）
- **-e**: 监听的事件类型（start/stop/restart/die）

## 配置项

- **debug**: 调试模式
- **imageOutput**: 图片格式输出
- **defaultLogLines**: 默认日志行数
