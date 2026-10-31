// 访问日志查询（两层模型下，日志按 server 汇总，靠 host 字段过滤）
import fs from 'node:fs/promises';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';

const LOG_DIR = process.env.LOG_DIR || '/var/log/caddy';

/**
 * 查询访问日志
 * @param {object} opts
 * @param {string} [opts.host]      按域名过滤（前缀匹配，如 "orca6"）
 * @param {number} [opts.status]    按状态码过滤
 * @param {string} [opts.ip]        按客户端 IP 前缀过滤
 * @param {number} [opts.limit]     返回条数，默认 50
 * @param {string} [opts.file]      指定日志文件（默认自动找最新的 *-access.log）
 */
export async function queryAccessLog(opts = {}) {
  const limit = Math.min(Number(opts.limit) || 50, 1000);
  const file = opts.file || await findLatestLog();

  if (!file) {
    return { error: '未找到访问日志文件', searched: LOG_DIR };
  }

  const rows = [];
  // 从文件尾部读，避免大文件全量加载
  const stat = await fs.stat(file);
  const maxBytes = 8 * 1024 * 1024;
  const start = Math.max(0, stat.size - maxBytes);

  const stream = createReadStream(file, { start, encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const buffer = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!d.request) continue;   // 跳过非访问日志

    const req = d.request;
    const host = req.host || '';
    const ip = req.remote_ip || '';
    const status = d.status;

    if (opts.host && !host.startsWith(opts.host)) continue;
    if (opts.status && Number(opts.status) !== status) continue;
    if (opts.ip && !ip.startsWith(opts.ip)) continue;

    buffer.push({
      ts: d.ts ? new Date(d.ts * 1000).toISOString() : null,
      ip,
      host,
      method: req.method,
      uri: req.uri,
      status,
      duration_ms: d.duration ? Math.round(d.duration / 1e6) : null,
      ua: (req.headers?.['User-Agent'] || [''])[0].slice(0, 80),
    });
    if (buffer.length > limit * 4) buffer.splice(0, buffer.length - limit * 4);
  }

  // 取最后 limit 条
  const out = buffer.slice(-limit);
  return {
    file,
    total: out.length,
    filters: { host: opts.host || null, status: opts.status || null, ip: opts.ip || null },
    entries: out,
  };
}

/** 找最近的访问日志文件 */
async function findLatestLog() {
  try {
    const files = await fs.readdir(LOG_DIR);
    const candidates = files.filter(f => f.endsWith('-access.log'));
    if (!candidates.length) return null;
    let best = null, bestTime = 0;
    for (const f of candidates) {
      const st = await fs.stat(`${LOG_DIR}/${f}`);
      if (st.mtimeMs > bestTime) { bestTime = st.mtimeMs; best = `${LOG_DIR}/${f}`; }
    }
    return best;
  } catch {
    return null;
  }
}

/** 列出所有日志文件及大小 */
export async function listLogs() {
  try {
    const files = await fs.readdir(LOG_DIR);
    const out = [];
    for (const f of files) {
      const p = `${LOG_DIR}/${f}`;
      const st = await fs.stat(p);
      out.push({ file: f, size: st.size, mtime: st.mtime.toISOString() });
    }
    return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch {
    return [];
  }
}
