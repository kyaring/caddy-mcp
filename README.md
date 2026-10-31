# caddy-mcp

Caddy 反向代理管理服务，提供 MCP 协议接口，供 AI Agent 与自动化脚本管理 Caddy 配置。

## 功能

- **反向代理管理**：增删改查、动态生效（写配置 → 校验 → reload → 失败回滚）
- **证书管理**：查询到期时间、手动续签（基于 acme.sh）
- **IPv6 DDNS**：自动同步 AAAA 记录（Cloudflare API）
- **远程节点**：通过 SSH 管理其他机器上的 Caddy
- **权限分级**：read / write / admin 三档 Bearer Token
- **审计日志**：所有写操作留痕

## 架构

```
Agent / 脚本
    │ HTTPS + Bearer Token
    ▼
Caddy（TLS 终结 + 反代）
    │
    ▼
caddy-mcp (Node.js :3100)
    ├── Caddy Admin API (:2019)  ← 读配置、校验
    ├── /etc/caddy/Caddyfile     ← 写配置、reload
    ├── acme.sh                  ← 证书签发/续签
    └── Cloudflare API           ← DDNS
```

## 目录约定

| 用途 | 路径 |
|---|---|
| 代码（本仓库） | `/home/orca/projects/caddy-mcp` |
| 运行目录（部署后） | `/opt/caddy-mcp` |
| 配置（含密钥，不入库） | `/etc/caddy-mcp/` |
| Caddy 配置 | `/etc/caddy/Caddyfile` |
| 证书 | `/etc/caddy/ssl/` |
| 日志 | `/var/log/caddy-mcp/` |

## 安装

```bash
git clone https://github.com/kyaring/caddy-mcp.git
cd caddy-mcp
sudo ./scripts/install.sh
```

`install.sh` 会：
1. 复制代码到 `/opt/caddy-mcp`
2. 安装依赖（`npm install --omit=dev`）
3. 从 `config/*.example.json` 生成 `/etc/caddy-mcp/*.json`（若不存在）
4. 创建并启动 systemd 服务 `caddy-mcp`

**安装后必须手动编辑**：
- `/etc/caddy-mcp/tokens.json` — 填入真实 Token
- `/etc/caddy-mcp/ddns.json` — 填入实际域名
- `/etc/caddy-mcp/config.json` — 按需调整

## MCP 接入

```json
{
  "mcpServers": {
    "caddy": {
      "transport": "http",
      "url": "https://caddy.example.com:8886",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

## 工具清单

### 本机管理

| 工具 | 权限 | 说明 |
|---|---|---|
| `caddy_status` | read | 服务状态、Admin API 可达性 |
| `caddy_routes_list` | read | 列出所有反代路由 |
| `caddy_certs_list` | read | 证书列表 + 到期天数 |
| `ddns_status` | read | DDNS 同步状态 |
| `caddy_config_validate` | read | 校验 Caddyfile 语法 |
| `caddy_route_add` | write | 新增反代 |
| `caddy_route_remove` | write | 删除反代 |
| `ddns_sync` | write | 手动同步 DDNS |
| `cert_issue` | admin | 申请证书 |
| `cert_renew` | admin | 续签证书 |
| `caddy_reload` | admin | 重载配置 |

### 远程节点

| 工具 | 权限 | 说明 |
|---|---|---|
| `remote_nodes_list` | read | 列出纳管节点 |
| `remote_status` | read | 远程节点状态 |
| `remote_routes_list` | read | 远程节点路由 |
| `remote_route_add` | write | 远程新增反代 |
| `remote_reload` | admin | 远程重载 |

## 权限模型

| Scope | 能力 |
|---|---|
| `read` | 只读查询 |
| `write` | 增删反代、同步 DDNS |
| `admin` | 证书签发、配置重载 |

## 安全设计

- **传输**：MCP 走 HTTPS，Token 通过 `Authorization: Bearer` 传递
- **认证**：Token 存 `/etc/caddy-mcp/tokens.json`（600 权限）
- **写操作**：先备份 → 校验 → 应用 → 失败自动回滚
- **审计**：所有写操作记入 `/var/log/caddy-mcp/audit.log`，含时间、Token 名、参数、结果

## 设计文档

详见 [`docs/规则-子规则两层模型设计方案.md`](docs/规则-子规则两层模型设计方案.md)

## 已知限制

- 当前为扁平结构（每域名一个 Caddy 站点块），尚未实现「端口规则 - 子规则」两层模型
- 多后端负载均衡未实现
- Basic Auth / IP 过滤 / UA 过滤未实现

以上均在两层模型设计中，待实施。

## License

MIT
