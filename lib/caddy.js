// Caddy Admin API 封装
import fs from 'node:fs/promises';

const ADMIN = process.env.CADDY_ADMIN || 'http://127.0.0.1:2019';
const CADDYFILE = process.env.CADDYFILE || '/etc/caddy/Caddyfile';

async function api(path, opts = {}) {
  const res = await fetch(`${ADMIN}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Host': 'localhost:2019',
      'Origin': 'http://localhost:2019',
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Caddy API ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** 读取完整配置 */
export async function getConfig() {
  return api('/config/');
}

/** 列出所有反代路由 */
export async function listRoutes() {
  const cfg = await getConfig();
  const servers = cfg?.apps?.http?.servers || {};
  const out = [];
  for (const [srvName, srv] of Object.entries(servers)) {
    for (const [idx, route] of (srv.routes || []).entries()) {
      const hosts = route.match?.flatMap(m => m.host || []) || [];
      const ups = [];
      const walk = (handles) => {
        for (const h of handles || []) {
          if (h.handler === 'reverse_proxy') {
            for (const u of h.upstreams || []) ups.push(u.dial);
          }
          if (h.routes) walk(h.routes.flatMap(r => r.handle));
        }
      };
      walk(route.handle);
      if (hosts.length || ups.length) {
        out.push({ server: srvName, index: idx, hosts, upstreams: ups,
                   listen: srv.listen, protocols: srv.protocols });
      }
    }
  }
  return out;
}

/** 服务状态 */
export async function status() {
  let running = false, cfgVersion = null;
  try {
    cfgVersion = await api('/config/');
    running = true;
  } catch {}
  return { running, admin: ADMIN, caddyfile: CADDYFILE,
           configLoaded: running };
}

/** 校验 Caddyfile */
export async function validate(file = CADDYFILE) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    await run('caddy', ['validate', '--config', file], { timeout: 20000 });
    return { valid: true };
  } catch (e) {
    return { valid: false, error: (e.stderr || e.message || '').slice(0, 800) };
  }
}

/** 重载（先校验，失败不动） */
export async function reload() {
  const v = await validate();
  if (!v.valid) return { reloaded: false, reason: 'validation_failed', detail: v.error };
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    await run('systemctl', ['reload', 'caddy'], { timeout: 30000 });
    return { reloaded: true };
  } catch (e) {
    return { reloaded: false, reason: 'reload_failed', detail: (e.stderr || e.message || '').slice(0, 500) };
  }
}

/** 新增路由（写 Caddyfile 片段 + reload） */
export async function addRoute({ domain, upstream, tls = true }) {
  const block = `
# --- auto-added ${new Date().toISOString()} ---
${domain} {
\tbind ::
${tls ? '\ttls /etc/caddy/ssl/wildcard.crt /etc/caddy/ssl/wildcard.key\n' : ''}\treverse_proxy ${upstream} {
\t\ttransport http {
\t\t\tread_timeout 24h
\t\t\twrite_timeout 24h
\t\t}
\t}
}
`;
  const cur = await fs.readFile(CADDYFILE, 'utf8');
  if (cur.includes(`\n${domain} {`)) {
    throw new Error(`域名 ${domain} 已存在`);
  }
  const bak = `${CADDYFILE}.bak.${Date.now()}`;
  await fs.copyFile(CADDYFILE, bak);
  await fs.writeFile(CADDYFILE, cur + block, 'utf8');
  const v = await validate();
  if (!v.valid) {
    await fs.copyFile(bak, CADDYFILE);
    await fs.unlink(bak).catch(() => {});
    throw new Error(`配置校验失败，已回滚: ${v.error}`);
  }
  const r = await reload();
  if (!r.reloaded) {
    await fs.copyFile(bak, CADDYFILE);
    throw new Error(`reload 失败，已回滚: ${r.detail}`);
  }
  return { added: true, domain, upstream, backup: bak };
}

/** 删除路由 */
export async function removeRoute({ domain }) {
  const cur = await fs.readFile(CADDYFILE, 'utf8');
  const re = new RegExp(`\\n# --- auto-added[^\\n]*---\\n${domain.replace(/\./g, '\\.')} \\{[\\s\\S]*?\\n\\}\\n`, 'm');
  if (!re.test(cur)) throw new Error(`未找到可删除的自动添加路由: ${domain}（手动添加的需手工删除）`);
  const bak = `${CADDYFILE}.bak.${Date.now()}`;
  await fs.copyFile(CADDYFILE, bak);
  await fs.writeFile(CADDYFILE, cur.replace(re, '\n'), 'utf8');
  const v = await validate();
  if (!v.valid) { await fs.copyFile(bak, CADDYFILE); throw new Error(`校验失败已回滚: ${v.error}`); }
  const r = await reload();
  if (!r.reloaded) { await fs.copyFile(bak, CADDYFILE); throw new Error(`reload 失败已回滚: ${r.detail}`); }
  return { removed: true, domain, backup: bak };
}
