// sites.json → Caddyfile 生成器
// 纯函数，无副作用，同样输入必得同样输出（便于 diff 与 golden file 测试）
//
// 关键约束（均经 caddy validate 实测得出）：
// 1. log 不能放在 handle 块内 → "directive 'log' is not an ordered HTTP handler"
// 2. log 不能放在 route 块内  → "only handler directives can be used in routes"
// 3. log 只能放在站点级     → 故采用「每 server 一份日志」，
//                             靠 JSON 日志里的 request.host 字段区分域名，
//                             由 MCP 的 access_log_query 工具做过滤
// 4. header_up X-Forwarded-For 是默认行为，显式写会产生 warn → 不写
// 5. 真实 IP：当前 IPv6 直连场景 {remote_host} 即客户端真实地址（已实测）；
//    若将来走 CDN/反代，需在全局 servers 块加 trusted_proxies 并改用 {client_ip}

/** 渲染完整 Caddyfile */
export function render(sites) {
  const lines = [];
  const servers = (sites.servers || []).filter(s => s.enabled !== false);
  const first = servers[0];

  // ── 全局块 ──
  lines.push('{');
  if (first) lines.push(`\thttps_port ${first.port}`);
  lines.push('\tauto_https disable_redirects');
  lines.push('\tadmin 127.0.0.1:2019');
  lines.push('');
  lines.push('\tservers {');
  const protos = (first && first.httpProtocols) || ['h1'];
  lines.push(`\t\tprotocols ${protos.join(' ')}`);
  lines.push('\t}');
  lines.push('}');

  // ── 每个 server ──
  for (const srv of servers) {
    lines.push('');
    lines.push(`${srv.listen} {`);
    lines.push('\tbind ::');
    if (srv.enableTLS) {
      lines.push(`\ttls ${srv.tlsCert} ${srv.tlsKey}`);
    }

    // 站点级日志（唯一合法位置）
    const logFile = srv.accessLog?.file || `/var/log/caddy/port-${srv.port}-access.log`;
    lines.push('\tlog {');
    lines.push(`\t\toutput file ${logFile}`);
    lines.push(`\t\tlevel ${srv.accessLog?.level || 'INFO'}`);
    lines.push('\t\tformat json');
    lines.push('\t}');

    const rules = (srv.rules || []).filter(r => r.enabled !== false);
    if (!rules.length) {
      lines.push('');
      lines.push('\trespond "no route" 404');
    }
    for (const rule of rules) {
      lines.push('');
      lines.push(...renderRule(rule));
    }
    lines.push('}');
  }

  return lines.join('\n') + '\n';
}

/** 渲染单条子规则 */
function renderRule(rule) {
  const out = [];
  const tag = rule.id;
  const I = '\t';
  const II = '\t\t';
  const III = '\t\t\t';
  const IV = '\t\t\t\t';

  out.push(`${I}# ── ${tag}${rule.remark ? ' ── ' + rule.remark : ''}`);
  out.push(`${I}@${tag} host ${rule.domains.join(' ')}`);
  out.push(`${I}handle @${tag} {`);

  // Basic Auth
  if (rule.basicAuth && rule.basicAuth.user && rule.basicAuth.hash) {
    out.push(`${II}basic_auth {`);
    out.push(`${III}${rule.basicAuth.user} ${rule.basicAuth.hash}`);
    out.push(`${II}}`);
  }

  // IP 过滤
  const ipf = rule.ipFilter || { mode: 'none', list: [] };
  if (ipf.mode !== 'none' && ipf.list && ipf.list.length) {
    if (ipf.mode === 'whitelist') {
      out.push(`${II}@${tag}_ipblocked not remote_ip ${ipf.list.join(' ')}`);
    } else {
      out.push(`${II}@${tag}_ipblocked remote_ip ${ipf.list.join(' ')}`);
    }
    out.push(`${II}respond @${tag}_ipblocked "Forbidden" 403`);
  }

  // UA 过滤（黑名单）
  const uaf = rule.uaFilter || { mode: 'none', list: [] };
  if (uaf.mode !== 'none' && uaf.list && uaf.list.length) {
    const pattern = uaf.list.map(escapeRegex).join('|');
    out.push(`${II}@${tag}_uablocked header_regexp User-Agent (?i)(${pattern})`);
    out.push(`${II}respond @${tag}_uablocked "Forbidden" 403`);
  }

  // 反向代理
  out.push(`${II}reverse_proxy ${rule.upstreams.join(' ')} {`);
  if (rule.upstreams.length > 1) {
    out.push(`${III}lb_policy ${rule.lbPolicy || 'round_robin'}`);
  }
  const t = rule.timeouts || {};
  if (t.read || t.write) {
    out.push(`${III}transport http {`);
    if (t.read) out.push(`${IV}read_timeout ${t.read}`);
    if (t.write) out.push(`${IV}write_timeout ${t.write}`);
    out.push(`${III}}`);
  }
  if (rule.realIP && rule.realIP.enabled) {
    const hdr = rule.realIP.header || 'X-Real-IP';
    out.push(`${III}header_up ${hdr} {remote_host}`);
  }
  out.push(`${II}}`);

  out.push(`${I}}`);
  return out;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
