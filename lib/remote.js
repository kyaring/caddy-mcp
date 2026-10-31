// 远程 Caddy 管理（通过 SSH 管理路由器上的 Caddy）
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// 从环境变量读取远程节点配置
function nodes() {
  const raw = process.env.REMOTE_NODES || '[]';
  try { return JSON.parse(raw); } catch { return []; }
}

/** SSH 执行命令 */
async function ssh(node, cmd, timeout = 30000) {
  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=10',
    '-o', 'BatchMode=yes',
    `${node.user || 'root'}@${node.host}`,
    cmd,
  ];
  try {
    const { stdout, stderr } = await run('ssh', args, { timeout, maxBuffer: 2 * 1024 * 1024 });
    return { ok: true, out: stdout, err: stderr };
  } catch (e) {
    return { ok: false, err: (e.stderr || e.message || '').slice(0, 600) };
  }
}

/** 列出配置的远程节点 */
export function listNodes() {
  return nodes().map(n => ({ name: n.name, host: n.host, caddyfile: n.caddyfile || '/etc/caddy/Caddyfile' }));
}

/** 查远程 Caddy 状态 */
export async function remoteStatus(name) {
  const n = nodes().find(x => x.name === name);
  if (!n) throw new Error(`节点 ${name} 未配置`);
  const r = await ssh(n, 'ps | grep -c "[c]addy" ; echo "---" ; df -h /overlay 2>/dev/null | tail -1 ; echo "---" ; free -m 2>/dev/null | head -2');
  return { node: name, host: n.host, output: r.ok ? r.out : r.err, reachable: r.ok };
}

/** 查远程路由（解析 Caddyfile） */
export async function remoteRoutes(name) {
  const n = nodes().find(x => x.name === name);
  if (!n) throw new Error(`节点 ${name} 未配置`);
  const f = n.caddyfile || '/etc/caddy/Caddyfile';
  const r = await ssh(n, `cat ${f} 2>/dev/null`);
  if (!r.ok) throw new Error(r.err);
  // 简单解析：域名 { ... reverse_proxy xxx }
  const out = [];
  const blocks = r.out.split(/\n(?=\S+ \{)/);
  for (const b of blocks) {
    const m = /^([\w.*-]+(?:\.[\w.*-]+)+)\s*\{/.exec(b.trim());
    if (!m) continue;
    const up = /reverse_proxy\s+([^\s{]+)/.exec(b);
    out.push({ domain: m[1], upstream: up ? up[1] : null });
  }
  return { node: name, routes: out };
}

/** 在远程节点新增反代（追加到 Caddyfile + reload） */
export async function remoteAddRoute({ name, domain, upstream, certBase }) {
  const n = nodes().find(x => x.name === name);
  if (!n) throw new Error(`节点 ${name} 未配置`);
  const f = n.caddyfile || '/etc/caddy/Caddyfile';
  const cert = certBase || '/etc/caddy/ssl/wildcard';
  const block = [
    '',
    `# --- auto-added ${new Date().toISOString()} ---`,
    `${domain} {`,
    '\tbind ::',
    `\ttls ${cert}.crt ${cert}.key`,
    `\treverse_proxy ${upstream} {`,
    '\t\ttransport http {',
    '\t\t\tread_timeout 24h',
    '\t\t\twrite_timeout 24h',
    '\t\t}',
    '\t}',
    '}',
    '',
  ].join('\n');

  // 1. 检查是否已存在
  const check = await ssh(n, `grep -c "^${domain} {" ${f} 2>/dev/null || echo 0`);
  if (parseInt(check.out.trim()) > 0) throw new Error(`域名 ${domain} 已存在于 ${name}`);

  // 2. 备份
  await ssh(n, `cp ${f} ${f}.bak.$(date +%s)`);

  // 3. 追加（用 base64 避免转义问题）
  const b64 = Buffer.from(block).toString('base64');
  const append = await ssh(n, `echo '${b64}' | base64 -d >> ${f}`);
  if (!append.ok) throw new Error(`写入失败: ${append.err}`);

  // 4. 校验
  const valid = await ssh(n, `caddy validate --config ${f} 2>&1 | tail -3`);
  if (valid.out && /error|invalid/i.test(valid.out)) {
    await ssh(n, `cp ${f}.bak.* ${f} 2>/dev/null || true`);
    throw new Error(`校验失败，已回滚: ${valid.out.slice(0, 300)}`);
  }

  // 5. 重载
  const reload = await ssh(n, n.reloadCmd || '/etc/init.d/caddy reload 2>/dev/null || pkill -HUP caddy || caddy reload --config ' + f);
  return { node: name, added: true, domain, upstream, reload: reload.ok ? 'ok' : reload.err };
}

/** 重载远程 Caddy */
export async function remoteReload(name) {
  const n = nodes().find(x => x.name === name);
  if (!n) throw new Error(`节点 ${name} 未配置`);
  const f = n.caddyfile || '/etc/caddy/Caddyfile';
  const v = await ssh(n, `caddy validate --config ${f} 2>&1 | tail -2`);
  if (/error|invalid/i.test(v.out || '')) {
    return { node: name, reloaded: false, reason: 'validation_failed', detail: v.out };
  }
  const r = await ssh(n, n.reloadCmd || 'caddy reload --config ' + f);
  return { node: name, reloaded: r.ok, detail: r.ok ? 'ok' : r.err };
}
