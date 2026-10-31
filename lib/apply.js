// 原子应用：临时文件校验 → 原子替换 → reload → 失败回滚
// 采用审核意见 C.1.2：正式文件在校验通过前从不被改动

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { render } from './generator.js';
import { validateSites } from './validator.js';

const run = promisify(execFile);

const CADDYFILE = process.env.CADDYFILE || '/etc/caddy/Caddyfile';
const SITES_JSON = process.env.SITES_JSON || '/etc/caddy-mcp/sites.json';
const BACKUP_DIR = process.env.BACKUP_DIR || '/etc/caddy-mcp/backups';
const LOCK_FILE = process.env.LOCK_FILE || '/var/lock/caddy-mcp.lock';
const KEEP_BACKUPS = 10;

/** 基于 O_EXCL 的互斥锁 */
async function acquireLock(timeoutMs = 30000) {
  const start = Date.now();
  const lockPath = `${LOCK_FILE}.pid`;
  while (Date.now() - start < timeoutMs) {
    try {
      const fh = await fs.open(lockPath, 'wx');
      await fh.writeFile(String(process.pid));
      return async () => {
        await fh.close();
        await fs.unlink(lockPath).catch(() => {});
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 检查是否陈旧锁（进程已死）
      try {
        const pid = parseInt(await fs.readFile(lockPath, 'utf8'), 10);
        if (pid && !isAlive(pid)) {
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
  }
  throw new Error(`获取锁超时（${timeoutMs}ms）：${lockPath}`);
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 校验 Caddyfile（可指定路径） */
async function caddyValidate(file) {
  try {
    await run('caddy', ['validate', '--adapter', 'caddyfile', '--config', file], { timeout: 20000 });
    return { valid: true };
  } catch (e) {
    return { valid: false, error: (e.stderr || e.message || '').slice(0, 1500) };
  }
}

/** reload Caddy */
async function caddyReload() {
  try {
    await run('systemctl', ['reload', 'caddy'], { timeout: 30000 });
    return { reloaded: true };
  } catch (e) {
    return { reloaded: false, error: (e.stderr || e.message || '').slice(0, 800) };
  }
}

/** 清理旧备份，只保留最近 N 份 */
async function pruneBackups() {
  try {
    const files = (await fs.readdir(BACKUP_DIR))
      .filter(f => f.startsWith('caddyfile-'))
      .sort();
    while (files.length > KEEP_BACKUPS) {
      const old = files.shift();
      await fs.unlink(path.join(BACKUP_DIR, old)).catch(() => {});
    }
  } catch {}
}

/**
 * 应用配置
 * 流程：校验 JSON → 渲染 → 写临时文件 → caddy validate 临时文件
 *      → 原子 rename 替换正式文件 → reload → 保存 JSON
 * 任一步失败：正式文件从未被改动（或已回滚），JSON 不保存
 */
export async function apply(sites, opts = {}) {
  // 1. JSON 结构校验
  const errs = validateSites(sites);
  if (errs.length) {
    const e = new Error(`配置校验失败（${errs.length} 项）`);
    e.details = errs;
    throw e;
  }

  const release = await acquireLock();
  try {
    // 2. 渲染
    const content = render(sites);

    // 3. 写临时文件（同目录，保证 rename 是原子的）
    const tmp = `${CADDYFILE}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, content, { encoding: 'utf8', mode: 0o644 });

    // 4. 校验临时文件
    const v = await caddyValidate(tmp);
    if (!v.valid) {
      await fs.unlink(tmp).catch(() => {});
      const e = new Error('Caddy 配置校验失败，正式文件未改动');
      e.details = [v.error];
      throw e;
    }

    // 5. 备份当前正式文件
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(BACKUP_DIR, `caddyfile-${stamp}`);
    let hadOriginal = true;
    try {
      await fs.copyFile(CADDYFILE, backup);
      // 同时备份 sites.json（成对保存，见审核建议 C.3.2）
      try { await fs.copyFile(SITES_JSON, `${backup}.sites.json`); } catch {}
    } catch (e) {
      if (e.code === 'ENOENT') hadOriginal = false;
      else throw e;
    }

    // 6. 原子替换
    await fs.rename(tmp, CADDYFILE);

    // 7. reload
    const r = await caddyReload();
    if (!r.reloaded) {
      // 回滚
      if (hadOriginal) await fs.copyFile(backup, CADDYFILE);
      const e = new Error('Caddy reload 失败，已回滚');
      e.details = [r.error];
      throw e;
    }

    // 8. 保存 JSON（最后一步，确保一致）
    await fs.mkdir(path.dirname(SITES_JSON), { recursive: true });
    const jsonTmp = `${SITES_JSON}.tmp.${process.pid}`;
    await fs.writeFile(jsonTmp, JSON.stringify(sites, null, 2), 'utf8');
    await fs.rename(jsonTmp, SITES_JSON);

    await pruneBackups();

    return {
      applied: true,
      caddyfile: CADDYFILE,
      sitesJson: SITES_JSON,
      backup: hadOriginal ? backup : null,
      bytes: content.length,
    };
  } finally {
    await release();
  }
}

/** 读取当前 sites.json */
export async function loadSites() {
  try {
    const raw = await fs.readFile(SITES_JSON, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/** 只校验，不应用 */
export async function dryRun(sites) {
  const errs = validateSites(sites);
  if (errs.length) return { ok: false, stage: 'schema', errors: errs };

  const content = render(sites);
  const tmp = `${CADDYFILE}.dryrun.${process.pid}`;
  await fs.writeFile(tmp, content, 'utf8');
  const v = await caddyValidate(tmp);
  await fs.unlink(tmp).catch(() => {});

  return v.valid
    ? { ok: true, bytes: content.length }
    : { ok: false, stage: 'caddy', errors: [v.error] };
}

/** 回滚到指定备份 */
export async function rollback(backupFile) {
  const release = await acquireLock();
  try {
    const v = await caddyValidate(backupFile);
    if (!v.valid) throw new Error(`备份文件本身校验失败: ${v.error}`);

    await fs.copyFile(backupFile, CADDYFILE);
    const r = await caddyReload();
    if (!r.reloaded) throw new Error(`回滚后 reload 失败: ${r.error}`);

    // 同步回滚 sites.json
    try {
      const sj = `${backupFile}.sites.json`;
      await fs.copyFile(sj, SITES_JSON);
    } catch {}

    return { rolledBack: true, from: backupFile };
  } finally {
    await release();
  }
}

/** 列出可用备份 */
export async function listBackups() {
  try {
    const files = (await fs.readdir(BACKUP_DIR))
      .filter(f => f.startsWith('caddyfile-') && !f.endsWith('.sites.json'))
      .sort()
      .reverse();
    return files.map(f => path.join(BACKUP_DIR, f));
  } catch {
    return [];
  }
}
