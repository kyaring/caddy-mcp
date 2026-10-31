#!/usr/bin/env node
// Caddy MCP Server — HTTP 传输，供 agent 调用
import http from 'node:http';
import { z } from 'zod';
import * as caddy from './lib/caddy.js';
import * as cert from './lib/cert.js';
import * as ddns from './lib/ddns.js';
import * as auth from './lib/auth.js';
import * as remote from './lib/remote.js';

const PORT = Number(process.env.PORT || 3100);
const HOST = process.env.HOST || '127.0.0.1';

// ---------- 工具定义 ----------
const TOOLS = {
  // ===== 只读 =====
  caddy_status: {
    scope: 'read',
    desc: '查询 Caddy 服务状态（是否运行、Admin API 可达性、配置文件路径）',
    schema: {},
    run: async () => await caddy.status(),
  },
  caddy_routes_list: {
    scope: 'read',
    desc: '列出所有反向代理路由（域名 → 上游地址）',
    schema: {},
    run: async () => ({ routes: await caddy.listRoutes() }),
  },
  caddy_certs_list: {
    scope: 'read',
    desc: '列出所有 TLS 证书：域名、到期时间、剩余天数',
    schema: {},
    run: async () => ({ certs: await cert.listCerts() }),
  },
  ddns_status: {
    scope: 'read',
    desc: '查询 DDNS 状态：本机 IPv6、DNS 记录值、是否已同步',
    schema: {},
    run: async () => await ddns.status(),
  },
  caddy_config_validate: {
    scope: 'read',
    desc: '校验当前 Caddyfile 语法是否正确',
    schema: {},
    run: async () => await caddy.validate(),
  },

  // ===== 可写 =====
  caddy_route_add: {
    scope: 'write',
    desc: '新增反向代理。会自动备份、校验、失败回滚',
    schema: {
      domain: z.string().describe('域名，如 blog.king.nyc.mn'),
      upstream: z.string().describe('上游地址，如 192.168.20.180:8080 或 localhost:3000'),
      tls: z.boolean().optional().describe('是否启用 TLS，默认 true'),
    },
    run: async (args) => await caddy.addRoute(args),
  },
  caddy_route_remove: {
    scope: 'write',
    desc: '删除自动添加的反向代理（仅限本工具添加的，手动添加的需手工删除）',
    schema: {
      domain: z.string().describe('要删除的域名'),
      confirm: z.literal(true).describe('必须传 true 以确认删除'),
    },
    run: async (args) => await caddy.removeRoute(args),
  },
  ddns_sync: {
    scope: 'write',
    desc: '立即同步 DDNS：把 DNS AAAA 记录更新为本机当前 IPv6',
    schema: {},
    run: async () => await ddns.sync(),
  },

  // ===== 远程节点（路由器等）=====
  remote_nodes_list: {
    scope: 'read',
    desc: '列出所有纳管的远程 Caddy 节点（路由器等）',
    schema: {},
    run: async () => ({ nodes: remote.listNodes() }),
  },
  remote_status: {
    scope: 'read',
    desc: '查询远程节点状态：进程、磁盘、内存',
    schema: { name: z.string().describe('节点名') },
    run: async (a) => await remote.remoteStatus(a.name),
  },
  remote_routes_list: {
    scope: 'read',
    desc: '列出远程节点的反向代理规则',
    schema: { name: z.string().describe('节点名') },
    run: async (a) => await remote.remoteRoutes(a.name),
  },
  remote_route_add: {
    scope: 'write',
    desc: '在远程节点新增反向代理（自动备份、校验、失败回滚）',
    schema: {
      name: z.string().describe('节点名'),
      domain: z.string().describe('域名'),
      upstream: z.string().describe('上游地址'),
      certBase: z.string().optional().describe('证书路径前缀，默认 /etc/caddy/ssl/wildcard'),
    },
    run: async (a) => await remote.remoteAddRoute(a),
  },
  remote_reload: {
    scope: 'admin',
    desc: '重载远程节点 Caddy 配置（先校验）',
    schema: { name: z.string().describe('节点名') },
    run: async (a) => await remote.remoteReload(a.name),
  },

  // ===== 管理 =====
  cert_issue: {
    scope: 'admin',
    desc: '申请新证书（DNS-01 via Cloudflare）。1 小时内只能申请一次',
    schema: {
      domains: z.union([z.string(), z.array(z.string())]).describe('域名或域名数组'),
    },
    run: async (args) => await cert.issueCert(args),
  },
  cert_renew: {
    scope: 'admin',
    desc: '续签所有证书（acme.sh --cron）',
    schema: {},
    run: async () => await cert.renewAll(),
  },
  caddy_reload: {
    scope: 'admin',
    desc: '重载 Caddy 配置（先校验，失败则不动）',
    schema: {},
    run: async () => await caddy.reload(),
  },
};

// ---------- HTTP 处理 ----------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function handleRpc(req, res, body) {
  const { id, method, params } = body || {};
  if (method === 'initialize') {
    return send(res, 200, { jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'caddy-mcp', version: '1.0.0' },
    }});
  }
  if (method === 'tools/list') {
    return send(res, 200, { jsonrpc: '2.0', id, result: {
      tools: Object.entries(TOOLS).map(([name, t]) => ({
        name, description: t.desc,
        inputSchema: { type: 'object', properties: {}, required: [] },
      })),
    }});
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    const tool = TOOLS[name];
    if (!tool) return send(res, 200, { jsonrpc: '2.0', id,
      error: { code: -32601, message: `未知工具: ${name}` } });

    const identity = req._identity;
    if (!auth.hasScope(identity, tool.scope)) {
      await auth.audit({ token: identity?.name, tool: name, result: 'forbidden', required: tool.scope });
      return send(res, 200, { jsonrpc: '2.0', id,
        error: { code: -32003, message: `权限不足：需要 ${tool.scope} scope` } });
    }

    try {
      const out = await tool.run(args);
      await auth.audit({ token: identity.name, tool: name, args, result: 'ok' });
      return send(res, 200, { jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
      }});
    } catch (e) {
      await auth.audit({ token: identity?.name, tool: name, args, result: 'error', error: e.message.slice(0, 300) });
      return send(res, 200, { jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: `错误: ${e.message}` }],
        isError: true,
      }});
    }
  }
  send(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, service: 'caddy-mcp' });
  }
  // Bearer 认证
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
  const identity = await auth.verify(token);
  if (!identity) {
    await auth.audit({ token: null, ip: req.socket.remoteAddress, result: 'unauthorized' });
    return send(res, 401, { error: 'unauthorized' });
  }
  req._identity = identity;

  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) { req.destroy(); return; }
  }
  let body;
  try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid json' }); }
  await handleRpc(req, res, body);
});

server.listen(PORT, HOST, () => {
  console.log(`[caddy-mcp] listening on http://${HOST}:${PORT}`);
  console.log(`[caddy-mcp] tools: ${Object.keys(TOOLS).length}`);
});
