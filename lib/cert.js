// 证书管理（基于 acme.sh）
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CERT_DIR = process.env.CERT_DIR || '/etc/caddy/ssl';
const ACME_HOME = process.env.ACME_HOME || '/root/.acme.sh';

/** 解析 PEM 证书 */
async function parseCert(file) {
  try {
    const { stdout } = await run('openssl', ['x509', '-in', file, '-noout',
      '-subject', '-enddate', '-ext', 'subjectAltName'], { timeout: 8000 });
    const subject = /subject=\s*(.+)/.exec(stdout)?.[1]?.trim();
    const end = /notAfter=(.+)/.exec(stdout)?.[1]?.trim();
    const sans = [...stdout.matchAll(/DNS:([^\s,]+)/g)].map(m => m[1]);
    const expiresAt = end ? new Date(end) : null;
    const daysLeft = expiresAt ? Math.floor((expiresAt - Date.now()) / 86400000) : null;
    return { subject, domains: sans, expiresAt: expiresAt?.toISOString(), daysLeft };
  } catch (e) {
    return { error: e.message.slice(0, 200) };
  }
}

/** 列出所有证书 */
export async function listCerts() {
  const out = [];
  let files = [];
  try { files = await fs.readdir(CERT_DIR); } catch { return out; }
  for (const f of files.filter(x => x.endsWith('.crt'))) {
    const info = await parseCert(path.join(CERT_DIR, f));
    out.push({ file: f, ...info });
  }
  return out.sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));
}

/** 申请证书（DNS-01 via Cloudflare） */
export async function issueCert({ domains, useWildcard = false }) {
  const list = Array.isArray(domains) ? domains : [domains];
  if (!list.length) throw new Error('domains 不能为空');
  // 限流：检查最近是否刚申请过
  const lockFile = '/tmp/caddy-mcp-cert.lock';
  try {
    const st = await fs.stat(lockFile);
    if (Date.now() - st.mtimeMs < 3600_000) {
      throw new Error('证书申请限流：1 小时内只能申请一次');
    }
  } catch (e) { if (!e.message.includes('限流')) throw e; }
  await fs.writeFile(lockFile, String(Date.now()));

  const args = ['--issue', '--dns', 'dns_cf'];
  for (const d of list) args.push('-d', d);
  args.push('--server', 'letsencrypt');

  const env = { ...process.env, CF_Token: process.env.CF_API_TOKEN || '' };
  if (!env.CF_Token) throw new Error('缺少 CF_API_TOKEN 环境变量');

  try {
    const { stdout, stderr } = await run(`${ACME_HOME}/acme.sh`, args, {
      timeout: 180000, env, maxBuffer: 4 * 1024 * 1024,
    });
    return { issued: true, domains: list, log: (stdout + stderr).slice(-800) };
  } catch (e) {
    return { issued: false, domains: list, error: (e.stderr || e.stdout || e.message).slice(-1200) };
  }
}

/** 续签（检查所有已签证书） */
export async function renewAll() {
  const env = { ...process.env, CF_Token: process.env.CF_API_TOKEN || '' };
  try {
    const { stdout, stderr } = await run(`${ACME_HOME}/acme.sh`, ['--cron', '--home', ACME_HOME], {
      timeout: 300000, env, maxBuffer: 4 * 1024 * 1024,
    });
    return { renewed: true, log: (stdout + stderr).slice(-1000) };
  } catch (e) {
    return { renewed: false, error: (e.stderr || e.message).slice(-800) };
  }
}
