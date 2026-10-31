// IPv6 DDNS（Cloudflare）
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const API = 'https://api.cloudflare.com/client/v4';
const DDNS_CFG = process.env.DDNS_CONFIG || '/etc/caddy-mcp/ddns.json';

async function cfg() {
  return JSON.parse(await fs.readFile(DDNS_CFG, 'utf8'));
}

/** 取本机固定公网 IPv6 */
export async function currentIPv6(iface) {
  const { stdout } = await run('ip', ['-6', 'addr', 'show', 'dev', iface, 'scope', 'global'],
    { timeout: 8000 });
  const lines = stdout.split('\n').filter(l =>
    l.includes('inet6') && !l.includes('temporary') && !l.includes('deprecated'));
  for (const l of lines) {
    const m = /inet6\s+([0-9a-f:]+)/.exec(l);
    if (m && !m[1].startsWith('fd') && !m[1].startsWith('fe80')) return m[1];
  }
  return null;
}

async function cf(path, opts = {}) {
  const token = process.env.CF_API_TOKEN;
  if (!token) throw new Error('缺少 CF_API_TOKEN');
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json();
  if (!j.success) throw new Error(`CF API: ${JSON.stringify(j.errors).slice(0, 300)}`);
  return j.result;
}

/** DDNS 状态 */
export async function status() {
  const c = await cfg();
  const ip = await currentIPv6(c.iface);
  const zones = await cf(`/zones?name=${c.zone}`);
  const zoneId = zones?.[0]?.id;
  const rows = [];
  for (const rec of c.records || []) {
    const list = await cf(`/zones/${zoneId}/dns_records?name=${rec.name}&type=AAAA`);
    const cur = list?.[0]?.content || null;
    rows.push({ name: rec.name, dns: cur, local: ip, synced: cur === ip });
  }
  return { iface: c.iface, ipv6: ip, zone: c.zone, records: rows };
}

/** 同步 DDNS */
export async function sync() {
  const c = await cfg();
  const ip = await currentIPv6(c.iface);
  if (!ip) throw new Error('未获取到公网 IPv6');
  const zones = await cf(`/zones?name=${c.zone}`);
  const zoneId = zones?.[0]?.id;
  if (!zoneId) throw new Error(`Zone ${c.zone} 不存在`);
  const results = [];
  for (const rec of c.records || []) {
    const list = await cf(`/zones/${zoneId}/dns_records?name=${rec.name}&type=AAAA`);
    const existing = list?.[0];
    const body = JSON.stringify({
      type: 'AAAA', name: rec.name, content: ip,
      ttl: 120, proxied: rec.proxied ?? false,
    });
    if (existing) {
      if (existing.content === ip) { results.push({ name: rec.name, action: 'unchanged', ip }); continue; }
      await cf(`/zones/${zoneId}/dns_records/${existing.id}`,
        { method: 'PUT', body });
      results.push({ name: rec.name, action: 'updated', from: existing.content, to: ip });
    } else {
      await cf(`/zones/${zoneId}/dns_records`, { method: 'POST', body });
      results.push({ name: rec.name, action: 'created', ip });
    }
  }
  return { iface: c.iface, ipv6: ip, results };
}
