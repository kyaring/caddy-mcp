// Token 认证 + 审计日志
import fs from 'node:fs/promises';

const TOKENS_FILE = process.env.TOKENS_FILE || '/etc/caddy-mcp/tokens.json';
const AUDIT_LOG = process.env.AUDIT_LOG || '/var/log/caddy-mcp/audit.log';

let cache = null, cacheTime = 0;

async function loadTokens() {
  if (cache && Date.now() - cacheTime < 30000) return cache;
  const raw = JSON.parse(await fs.readFile(TOKENS_FILE, 'utf8'));
  cache = raw.tokens || [];
  cacheTime = Date.now();
  return cache;
}

/** 校验 token，返回 scopes 或 null */
export async function verify(token) {
  if (!token) return null;
  const list = await loadTokens();
  const hit = list.find(t => t.token === token);
  return hit ? { name: hit.name, scopes: hit.scopes } : null;
}

/** 检查 scope */
export function hasScope(identity, scope) {
  return identity?.scopes?.includes(scope) ?? false;
}

/** 写审计日志 */
export async function audit(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  try { await fs.appendFile(AUDIT_LOG, line, 'utf8'); } catch {}
}
