// 三层校验：L1 结构 / L2 语义 / L3 格式
// 返回错误数组，空数组表示通过

const DOMAIN_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const UPSTREAM_RE = /^([\w.-]+|\[[0-9a-fA-F:]+\])(:\d{1,5})?$/;
const DURATION_RE = /^\d+(\.\d+)?(ns|us|ms|s|m|h)$/;
const ID_RE = /^[a-z][a-z0-9_]{1,63}$/i;
const BCRYPT_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const LB_POLICIES = ['round_robin', 'random', 'least_conn', 'first', 'ip_hash', 'uri_hash', 'header', 'cookie'];

export function validateSites(sites) {
  const errors = [];

  // ── L1 结构 ──
  if (!sites || typeof sites !== 'object') return ['sites 必须是对象'];
  if (!Array.isArray(sites.servers)) return ['servers 必须是数组'];
  if (!sites.servers.length) return ['servers 不能为空'];

  const seenPorts = new Set();
  const seenServerIds = new Set();
  const seenDomains = new Map();
  const seenRuleIds = new Set();

  for (const [si, srv] of sites.servers.entries()) {
    const at = `servers[${si}]`;

    if (!srv.id || !ID_RE.test(srv.id)) errors.push(`${at}.id 缺失或格式非法`);
    else if (seenServerIds.has(srv.id)) errors.push(`${at}.id 重复: ${srv.id}`);
    else seenServerIds.add(srv.id);

    if (typeof srv.port !== 'number' || srv.port < 1 || srv.port > 65535) {
      errors.push(`${at}.port 必须是 1-65535 的数字`);
    } else if (seenPorts.has(srv.port)) {
      errors.push(`${at}.port 重复: ${srv.port}`);
    } else seenPorts.add(srv.port);

    if (typeof srv.listen !== 'string' || !srv.listen.startsWith(':')) {
      errors.push(`${at}.listen 必须形如 ":8886"`);
    }

    // TLS
    if (srv.enableTLS) {
      if (!srv.tlsCert) errors.push(`${at} 启用 TLS 但缺 tlsCert`);
      if (!srv.tlsKey) errors.push(`${at} 启用 TLS 但缺 tlsKey`);
    }

    // 协议
    if (srv.httpProtocols) {
      if (!Array.isArray(srv.httpProtocols) || !srv.httpProtocols.length) {
        errors.push(`${at}.httpProtocols 必须是非空数组`);
      } else {
        for (const p of srv.httpProtocols) {
          if (!['h1', 'h2', 'h2c', 'h3'].includes(p)) {
            errors.push(`${at}.httpProtocols 含非法值: ${p}`);
          }
        }
      }
    }

    // 子规则
    if (!Array.isArray(srv.rules)) {
      errors.push(`${at}.rules 必须是数组`);
      continue;
    }

    for (const [ri, rule] of srv.rules.entries()) {
      const rat = `${at}.rules[${ri}]`;

      if (!rule.id || !ID_RE.test(rule.id)) errors.push(`${rat}.id 缺失或格式非法`);
      else if (seenRuleIds.has(rule.id)) errors.push(`${rat}.id 重复: ${rule.id}`);
      else seenRuleIds.add(rule.id);

      // 域名
      if (!Array.isArray(rule.domains) || !rule.domains.length) {
        errors.push(`${rat}.domains 不能为空`);
      } else {
        for (const d of rule.domains) {
          if (!DOMAIN_RE.test(d)) {
            errors.push(`${rat} 域名格式非法: ${d}`);
            continue;
          }
          if (seenDomains.has(d)) {
            errors.push(`域名重复: ${d}（已在 ${seenDomains.get(d)} 中使用）`);
          } else {
            seenDomains.set(d, rule.id);
          }
        }
      }

      // 上游
      if (!Array.isArray(rule.upstreams) || !rule.upstreams.length) {
        errors.push(`${rat}.upstreams 不能为空`);
      } else {
        for (const u of rule.upstreams) {
          if (!UPSTREAM_RE.test(u)) errors.push(`${rat} 上游格式非法: ${u}`);
        }
        if (rule.upstreams.length > 1) {
          if (!rule.lbPolicy) errors.push(`${rat} 多后端必须指定 lbPolicy`);
          else if (!LB_POLICIES.includes(rule.lbPolicy)) {
            errors.push(`${rat}.lbPolicy 非法值: ${rule.lbPolicy}`);
          }
        }
      }

      // 超时
      if (rule.timeouts) {
        for (const k of ['read', 'write']) {
          const v = rule.timeouts[k];
          if (v && !DURATION_RE.test(v)) {
            errors.push(`${rat}.timeouts.${k} 格式非法: ${v}（应形如 24h / 300s）`);
          }
        }
      }

      // Basic Auth
      if (rule.basicAuth) {
        if (!rule.basicAuth.user) errors.push(`${rat}.basicAuth.user 缺失`);
        if (!rule.basicAuth.hash) errors.push(`${rat}.basicAuth.hash 缺失`);
        else if (!BCRYPT_RE.test(rule.basicAuth.hash)) {
          errors.push(`${rat}.basicAuth.hash 必须是 bcrypt 格式（$2a$/$2b$/$2y$ 开头）`);
        }
      }

      // IP 过滤
      if (rule.ipFilter) {
        if (!['none', 'whitelist', 'blacklist'].includes(rule.ipFilter.mode)) {
          errors.push(`${rat}.ipFilter.mode 必须是 none/whitelist/blacklist`);
        }
        if (rule.ipFilter.mode !== 'none') {
          if (!Array.isArray(rule.ipFilter.list) || !rule.ipFilter.list.length) {
            errors.push(`${rat}.ipFilter.list 不能为空`);
          } else {
            for (const cidr of rule.ipFilter.list) {
              if (!isValidCidr(cidr)) errors.push(`${rat}.ipFilter 非法 CIDR: ${cidr}`);
            }
          }
        }
      }

      // UA 过滤
      if (rule.uaFilter) {
        if (!['none', 'blacklist'].includes(rule.uaFilter.mode)) {
          errors.push(`${rat}.uaFilter.mode 必须是 none/blacklist`);
        }
        if (rule.uaFilter.mode !== 'none') {
          if (!Array.isArray(rule.uaFilter.list) || !rule.uaFilter.list.length) {
            errors.push(`${rat}.uaFilter.list 不能为空`);
          }
        }
      }

      // 日志
      if (rule.accessLog && rule.accessLog.enabled) {
        if (!rule.accessLog.file) errors.push(`${rat}.accessLog.file 缺失`);
        if (rule.accessLog.level && !['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(rule.accessLog.level)) {
          errors.push(`${rat}.accessLog.level 非法: ${rule.accessLog.level}`);
        }
      }
    }
  }

  return errors;
}

/** 简易 CIDR 校验（IPv4 / IPv6） */
function isValidCidr(s) {
  if (typeof s !== 'string') return false;
  const [addr, bits] = s.split('/');
  if (!addr) return false;
  if (bits !== undefined) {
    const n = Number(bits);
    if (!Number.isInteger(n) || n < 0) return false;
  }
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) {
    const parts = addr.split('.').map(Number);
    if (parts.some(p => p > 255)) return false;
    if (bits !== undefined && Number(bits) > 32) return false;
    return true;
  }
  // IPv6（宽松校验）
  if (/^[0-9a-fA-F:]+$/.test(addr) && addr.includes(':')) {
    if (bits !== undefined && Number(bits) > 128) return false;
    return true;
  }
  return false;
}
