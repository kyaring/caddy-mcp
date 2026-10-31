// IPv6 DDNS（Cloudflare）
// 参数模型参考 Lucky（module/ddns/ddnsgo/ddns.go）：
//   Intervals:        检查间隔，30~3600 秒（默认 60）
//   FirstCheckDelay:  首次延迟，0~3600 秒（默认 0）
//   ForceInterval:    强制更新间隔，60~360000 秒（默认 3600 = 1 小时）
//                    即使本地 IP 未变，也强制解析 DNS 实际值并比对，不一致就更新
//
// 关键改进（相对旧实现）：
//   旧实现只比对「网卡 IP vs DNS 记录」，DNS 被外部改动时会漏更新
//   新实现增加 ForceInterval，定期强制校验 DNS 实际解析值

import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const API = 'https://api.cloudflare.com/client/v4';
const DDNS_CFG = process.env.DDNS_CONFIG || '/etc/caddy-mcp/ddns.json';
const STATE_FILE = process.env.DDNS_STATE || '/var/lib/caddy-mcp/ddns-state.json';

// 默认值（对齐 Lucky 的兜底逻辑）
const DEFAULTS = {
  intervals: 60,          // 检查间隔 60 秒
  firstCheckDelay: 0,
  forceInterval: 3600,    // 1 小时强制校验一次
};
const LIMITS = {
  intervals: { min: 30, max: 3600 },
  firstCheckDelay: { min: 0, max: 3600 },
  forceInterval: { min: 60, max: 360000 },
};

/** 读取并规范化配置 */
async function cfg() {
  const raw = JSON.parse(await fs.readFile(DDNS_CFG, 'utf8'));
  const clamp = (v, k) => {
    const n = Number(v);
    const d = DEFAULTS[k];
    if (!Number.isFinite(n)) return d;
    const { min, max } = LIMITS[k];
    return Math.min(Math.max(n, min), max);
  };
  return {
    ...raw,
    intervals: clamp(raw.intervals, 'intervals'),
    firstCheckDelay: clamp(raw.firstCheckDelay, 'firstCheckDelay'),
    forceInterval: clamp(raw.forceInterval, 'forceInterval'),
  };
}

/** 读写运行状态（记录上次强制校验时间） */
async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    return { lastForceCheck: 0, lastRun: 0 };
  }
}
async function saveState(s) {
  try {
    await fs.mkdir(STATE_FILE.replace(/\/[^/]+$/, ''), { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
  } catch {}
}

/**
 * 取本机固定公网 IPv6
 * 策略：只取 /64 前缀的 SLAAC 地址（前缀变更后自动跟随），
 *      排除 /128 静态地址（运营商换前缀后会失效但地址仍挂着）、
 *      temporary（隐私地址会变）、deprecated、ULA、link-local
 */
export async function currentIPv6(iface) {
  const { stdout } = await run('ip', ['-6', 'addr', 'show', 'dev', iface, 'scope', 'global'],
    { timeout: 8000 });
  const candidates = [];
  for (const l of stdout.split('\n')) {
    if (!l.includes('inet6')) continue;
    if (l.includes('temporary') || l.includes('deprecated')) continue;
    const m = /inet6\s+([0-9a-f:]+)\/(\d+)/.exec(l);
    if (!m) continue;
    const [, addr, prefix] = m;
    if (addr.startsWith('fd') || addr.startsWith('fe80')) continue;
    if (prefix !== '64') continue;
    candidates.push(addr);
  }
  return candidates[0] || null;
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

/**
 * 通过公共 DoH 解析，绕过本地 DNS 缓存
 * 注意：Cloudflare DoH 在本机需走 SOCKS 代理才能访问（裸连被拦）
 * 优先用 curl 走代理（环境变量 DOH_PROXY），失败时退回 node fetch 直连
 */
async function resolveViaDoH(name) {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=AAAA`;
  const proxy = process.env.DOH_PROXY || 'socks5h://192.168.20.189:1070';

  // 方式 1：curl + 代理（可靠性高）
  try {
    const args = ['-s', '--max-time', '12'];
    if (proxy) args.push('-x', proxy);
    args.push(url, '-H', 'accept: application/dns-json');
    const { stdout } = await run('curl', args, { timeout: 15000 });
    const j = JSON.parse(stdout);
    const answers = (j.Answer || []).filter(a => a.type === 28).map(a => a.data);
    if (answers.length) return answers;
  } catch {}

  // 方式 2：node fetch 直连（兜底）
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(10000),
    });
    const j = await res.json();
    return (j.Answer || []).filter(a => a.type === 28).map(a => a.data);
  } catch {
    return [];
  }
}

/** DDNS 状态（只读） */
export async function status() {
  const c = await cfg();
  const ip = await currentIPv6(c.iface);
  const zones = await cf(`/zones?name=${c.zone}`);
  const zoneId = zones?.[0]?.id;
  const state = await loadState();
  const rows = [];
  for (const rec of c.records || []) {
    const list = await cf(`/zones/${zoneId}/dns_records?name=${rec.name}&type=AAAA`);
    const apiVal = list?.[0]?.content || null;
    const dohVals = await resolveViaDoH(rec.name);
    rows.push({
      name: rec.name,
      api: apiVal,
      dns: dohVals[0] || null,
      local: ip,
      apiSynced: apiVal === ip,
      dnsSynced: dohVals.includes(ip),
    });
  }
  return {
    iface: c.iface,
    ipv6: ip,
    zone: c.zone,
    intervals: c.intervals,
    forceInterval: c.forceInterval,
    lastForceCheck: state.lastForceCheck
      ? new Date(state.lastForceCheck).toISOString() : null,
    records: rows,
  };
}

/**
 * 同步 DDNS
 * @param {object} opts
 * @param {boolean} [opts.force]  强制校验（忽略 ForceInterval 时间窗）
 * @param {boolean} [opts.dryRun] 只检查不写入
 */
export async function sync(opts = {}) {
  const c = await cfg();
  const ip = await currentIPv6(c.iface);
  if (!ip) throw new Error('未获取到公网 IPv6');

  const state = await loadState();
  const now = Date.now();
  const forceDue = opts.force || (now - (state.lastForceCheck || 0)) >= c.forceInterval * 1000;

  const zones = await cf(`/zones?name=${c.zone}`);
  const zoneId = zones?.[0]?.id;
  if (!zoneId) throw new Error(`Zone ${c.zone} 不存在`);

  const results = [];
  for (const rec of c.records || []) {
    const list = await cf(`/zones/${zoneId}/dns_records?name=${rec.name}&type=AAAA`);
    const existing = list?.[0];
    const apiVal = existing?.content || null;

    // 强制模式下额外用 DoH 校验 DNS 实际解析值
    let dnsVals = [];
    if (forceDue) dnsVals = await resolveViaDoH(rec.name);

    const needUpdate = apiVal !== ip || (forceDue && !dnsVals.includes(ip));

    if (!needUpdate) {
      results.push({ name: rec.name, action: 'unchanged', ip, dns: dnsVals[0] || null });
      continue;
    }

    if (opts.dryRun) {
      results.push({
        name: rec.name, action: 'would-update',
        from: apiVal, to: ip, dns: dnsVals[0] || null,
      });
      continue;
    }

    const body = JSON.stringify({
      type: 'AAAA', name: rec.name, content: ip,
      ttl: rec.ttl || 60, proxied: rec.proxied ?? false,
    });
    if (existing) {
      await cf(`/zones/${zoneId}/dns_records/${existing.id}`, { method: 'PUT', body });
      results.push({ name: rec.name, action: 'updated', from: apiVal, to: ip });
    } else {
      await cf(`/zones/${zoneId}/dns_records`, { method: 'POST', body });
      results.push({ name: rec.name, action: 'created', ip });
    }
  }

  const newState = { ...state, lastRun: now };
  if (forceDue && !opts.dryRun) newState.lastForceCheck = now;
  if (!opts.dryRun) await saveState(newState);

  return {
    iface: c.iface, ipv6: ip, forceChecked: forceDue,
    intervals: c.intervals, forceInterval: c.forceInterval,
    results,
  };
}

/** 首次延迟（供调度器使用） */
export async function firstDelayMs() {
  const c = await cfg();
  return c.firstCheckDelay * 1000;
}

/** 检查间隔（供调度器使用） */
export async function intervalMs() {
  const c = await cfg();
  return c.intervals * 1000;
}
