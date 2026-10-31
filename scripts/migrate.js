// 一次性迁移：把现有 Caddyfile 转成 sites.json
// 用法: node scripts/migrate.js [--dry-run]

import fs from 'node:fs/promises';
import { render } from '../lib/generator.js';
import { validateSites } from '../lib/validator.js';
import { dryRun, apply } from '../lib/apply.js';

const DRY = process.argv.includes('--dry-run');

// 当前生产配置（orca6 + caddy 两个站点）
const initial = {
  version: 1,
  servers: [
    {
      id: 'srv_8886',
      listen: ':8886',
      port: 8886,
      enableTLS: true,
      tlsCert: '/etc/caddy/ssl/wildcard.crt',
      tlsKey: '/etc/caddy/ssl/wildcard.key',
      httpProtocols: ['h1'],
      enabled: true,
      rules: [
        {
          id: 'rule_orca6',
          domains: ['orca6.king.nyc.mn'],
          upstreams: ['localhost:6768'],
          lbPolicy: '',
          timeouts: { read: '24h', write: '24h' },
          accessLog: {
            enabled: true,
            file: '/var/log/caddy/orca6-access.log',
            level: 'INFO',
          },
          basicAuth: null,
          ipFilter: { mode: 'none', list: [] },
          uaFilter: { mode: 'none', list: [] },
          realIP: { enabled: true, header: 'X-Real-IP' },
          remark: 'Orca Agent 服务',
          enabled: true,
        },
        {
          id: 'rule_caddy',
          domains: ['caddy.king.nyc.mn'],
          upstreams: ['localhost:3100'],
          lbPolicy: '',
          timeouts: { read: '300s', write: '300s' },
          accessLog: {
            enabled: true,
            file: '/var/log/caddy/mcp-access.log',
            level: 'INFO',
          },
          basicAuth: null,
          ipFilter: { mode: 'none', list: [] },
          uaFilter: { mode: 'none', list: [] },
          realIP: { enabled: true, header: 'X-Real-IP' },
          remark: 'MCP 控制台',
          enabled: true,
        },
      ],
    },
  ],
};

async function main() {
  console.log('=== 1. 结构校验 ===');
  const errs = validateSites(initial);
  if (errs.length) {
    console.error('❌ 校验失败:');
    errs.forEach(e => console.error('   -', e));
    process.exit(1);
  }
  console.log('✅ 通过');

  console.log('\n=== 2. 生成的 Caddyfile ===');
  const content = render(initial);
  console.log(content);

  console.log('=== 3. 干跑校验 ===');
  const dr = await dryRun(initial);
  if (!dr.ok) {
    console.error(`❌ ${dr.stage} 阶段失败:`);
    (dr.errors || []).forEach(e => console.error('   -', e));
    process.exit(1);
  }
  console.log(`✅ Caddy 校验通过（${dr.bytes} 字节）`);

  if (DRY) {
    console.log('\n[--dry-run] 未实际应用');
    return;
  }

  console.log('\n=== 4. 应用（原子替换 + reload）===');
  try {
    const r = await apply(initial);
    console.log('✅ 已应用');
    console.log('   Caddyfile:', r.caddyfile);
    console.log('   sites.json:', r.sitesJson);
    console.log('   备份:', r.backup || '(无原文件)');
  } catch (e) {
    console.error('❌ 应用失败:', e.message);
    (e.details || []).forEach(d => console.error('   -', d));
    process.exit(1);
  }
}

main().catch(e => {
  console.error('异常:', e);
  process.exit(1);
});
