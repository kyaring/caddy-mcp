// golden file 测试：固化 generator 输出，任何改动都要 diff 确认
// 用法: node test/generator.test.js [--update]

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../lib/generator.js';
import { validateSites } from '../lib/validator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(__dirname, 'golden', 'basic.caddyfile');
const UPDATE = process.argv.includes('--update');

// 基准配置：覆盖所有特性
const fixture = {
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
      accessLog: { file: '/var/log/caddy/port-8886-access.log', level: 'INFO' },
      rules: [
        {
          id: 'rule_simple',
          domains: ['simple.example.com'],
          upstreams: ['localhost:6768'],
          timeouts: { read: '24h', write: '24h' },
          basicAuth: null,
          ipFilter: { mode: 'none', list: [] },
          uaFilter: { mode: 'none', list: [] },
          realIP: { enabled: true, header: 'X-Real-IP' },
          remark: '简单反代',
          enabled: true,
        },
        {
          id: 'rule_multi_upstream',
          domains: ['lb.example.com'],
          upstreams: ['10.0.0.1:8080', '10.0.0.2:8080'],
          lbPolicy: 'round_robin',
          timeouts: { read: '60s', write: '60s' },
          basicAuth: null,
          ipFilter: { mode: 'none', list: [] },
          uaFilter: { mode: 'none', list: [] },
          realIP: { enabled: false },
          remark: '负载均衡',
          enabled: true,
        },
        {
          id: 'rule_with_auth',
          domains: ['secure.example.com'],
          upstreams: ['localhost:3000'],
          timeouts: { read: '300s', write: '300s' },
          basicAuth: {
            user: 'admin',
            hash: '$2a$14$K3BqJw43ex6BgCri0/xPduC/gmDtrUpR8mo5ExNq.HKzGrujIkHR.',
          },
          ipFilter: { mode: 'whitelist', list: ['192.168.20.0/24'] },
          uaFilter: { mode: 'blacklist', list: ['bot', 'crawler'] },
          realIP: { enabled: true, header: 'X-Real-IP' },
          remark: '带认证与过滤',
          enabled: true,
        },
        {
          id: 'rule_disabled',
          domains: ['off.example.com'],
          upstreams: ['localhost:9999'],
          timeouts: {},
          basicAuth: null,
          ipFilter: { mode: 'none', list: [] },
          uaFilter: { mode: 'none', list: [] },
          realIP: { enabled: false },
          remark: '已禁用，不应出现在输出中',
          enabled: false,
        },
      ],
    },
  ],
};

async function main() {
  console.log('=== 1. 结构校验 ===');
  const errs = validateSites(fixture);
  if (errs.length) {
    console.error('❌ 校验失败:');
    errs.forEach(e => console.error('   -', e));
    process.exit(1);
  }
  console.log('✅ 通过');

  console.log('\n=== 2. 生成 ===');
  const actual = render(fixture);
  console.log(`   输出 ${actual.length} 字节`);

  // 检查禁用的规则不应出现
  if (actual.includes('off.example.com')) {
    console.error('❌ 已禁用的规则出现在输出中');
    process.exit(1);
  }
  console.log('✅ 禁用规则已排除');

  if (UPDATE) {
    await fs.mkdir(path.dirname(GOLDEN), { recursive: true });
    await fs.writeFile(GOLDEN, actual, 'utf8');
    console.log(`\n✅ 已更新 golden file: ${GOLDEN}`);
    return;
  }

  console.log('\n=== 3. 对比 golden file ===');
  let expected;
  try {
    expected = await fs.readFile(GOLDEN, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error(`❌ golden file 不存在: ${GOLDEN}`);
      console.error('   首次运行请加 --update 生成');
      process.exit(1);
    }
    throw e;
  }

  if (actual === expected) {
    console.log('✅ 输出与 golden file 一致');
    return;
  }

  console.error('❌ 输出与 golden file 不一致\n');
  const aLines = actual.split('\n');
  const eLines = expected.split('\n');
  const max = Math.max(aLines.length, eLines.length);
  let diffCount = 0;
  for (let i = 0; i < max && diffCount < 20; i++) {
    if (aLines[i] !== eLines[i]) {
      console.error(`  行 ${i + 1}:`);
      console.error(`    期望: ${JSON.stringify(eLines[i])}`);
      console.error(`    实际: ${JSON.stringify(aLines[i])}`);
      diffCount++;
    }
  }
  console.error(`\n如确认改动符合预期，运行: node test/generator.test.js --update`);
  process.exit(1);
}

main().catch(e => {
  console.error('异常:', e);
  process.exit(1);
});
