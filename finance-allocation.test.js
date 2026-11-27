import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FIN_STATEMENT_DIR, TB_DIR } from './folders.js';
import { scanFinanceAllocation, resolveFinanceAllocation, copyFinanceAllocation, FINANCE_CATEGORIES, MAX_FINANCE_FILE_BYTES } from './finance-allocation.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'fin-alloc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = path.join(root, '02现场资料', '企业提供资料', '00财务资料');
  const source = path.join(base, '00未分配财务资料');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, '报表.xlsx'), 'original');
  const options = { projectRoot: root, companyFolders: ['公司甲'] };
  const scan = await scanFinanceAllocation(options);
  const selection = { ...scan.files[0], company: '公司甲', category: FIN_STATEMENT_DIR };
  return { root, base, source, options, selection };
}

test('扫描、只读预检和执行复制保留原件，分类引用 folders.js', async t => {
  const f = await fixture(t), args = { ...f.options, selections: [f.selection] };
  assert.deepEqual(FINANCE_CATEGORIES, [FIN_STATEMENT_DIR, '02审计报告', TB_DIR, '03辅助余额表', '04序时账']);
  await resolveFinanceAllocation(args);
  await assert.rejects(fs.stat(path.join(f.base, '公司甲')), { code: 'ENOENT' });
  const result = await copyFinanceAllocation(args);
  assert.equal(result.results[0].success, true);
  assert.equal(await fs.readFile(path.join(f.base, '公司甲', FIN_STATEMENT_DIR, '报表.xlsx'), 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(f.source, '报表.xlsx'), 'utf8'), 'original');
});

test('任何目标冲突整批拒绝，不创建其他目标', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, '第二.xlsx'), 'second');
  const scan = await scanFinanceAllocation(f.options);
  const selections = scan.files.map(x => ({ ...x, company: '公司甲', category: FIN_STATEMENT_DIR }));
  const target = path.join(f.base, '公司甲', FIN_STATEMENT_DIR);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, '第二.xlsx'), 'existing');
  await assert.rejects(copyFinanceAllocation({ ...f.options, selections }), /目标已存在/);
  await assert.rejects(fs.stat(path.join(target, '报表.xlsx')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(target, '第二.xlsx'), 'utf8'), 'existing');
  await assert.rejects(resolveFinanceAllocation({ ...f.options, selections: [f.selection, f.selection] }), /批次目标冲突/);
});

test('源文件哈希或身份改变拒绝整批', async t => {
  const f = await fixture(t), args = { ...f.options, selections: [f.selection] };
  await fs.writeFile(path.join(f.source, '报表.xlsx'), 'modified'); // same length
  await assert.rejects(copyFinanceAllocation(args), /快照不一致/);
  await assert.rejects(fs.stat(path.join(f.base, '公司甲')), { code: 'ENOENT' });
  await fs.unlink(path.join(f.source, '报表.xlsx'));
  await fs.writeFile(path.join(f.source, '报表.xlsx'), 'original');
  await assert.rejects(copyFinanceAllocation(args), /快照不一致/);
});

test('拒绝越界、伪造公司及分类', async t => {
  const f = await fixture(t);
  for (const changes of [{ name: '../x' }, { name: '/etc/passwd' }, { company: '../outside' }, { company: '公司乙' }, { category: '../outside' }, { category: '其他' }]) {
    await assert.rejects(resolveFinanceAllocation({ ...f.options, selections: [{ ...f.selection, ...changes }] }));
  }
  await assert.rejects(resolveFinanceAllocation({ ...f.options, companyFolders: [], selections: [f.selection] }), /可信/);
});

test('忽略源符号链接且拒绝源、目标及祖先符号链接', async t => {
  const f = await fixture(t);
  await fs.symlink(path.join(f.source, '报表.xlsx'), path.join(f.source, 'link.xlsx'));
  assert.deepEqual((await scanFinanceAllocation(f.options)).files.map(x => x.name), ['报表.xlsx']);
  await assert.rejects(resolveFinanceAllocation({ ...f.options, selections: [{ ...f.selection, name: 'link.xlsx' }] }), /普通文件/);
  await fs.symlink(f.root, path.join(f.base, '公司甲'));
  await assert.rejects(copyFinanceAllocation({ ...f.options, selections: [f.selection] }), /安全的普通目录/);
});

test('扫描隔离过大文件，其他文件仍可分配，执行也限制大小', async t => {
  const f = await fixture(t);
  const big = path.join(f.source, '过大.xlsx');
  const h = await fs.open(big, 'w');
  await h.truncate(MAX_FINANCE_FILE_BYTES + 1);
  await h.close();
  const scan = await scanFinanceAllocation(f.options);
  assert.match(scan.files.find(x => x.name === '过大.xlsx').error, /超过大小上限/);
  assert.equal(scan.files.find(x => x.name === '报表.xlsx').hash, f.selection.hash);
  const result = await copyFinanceAllocation({ ...f.options, selections: [f.selection] });
  assert.equal(result.results[0].success, true);
  const stat = await fs.stat(big, { bigint: true });
  await assert.rejects(resolveFinanceAllocation({ ...f.options, selections: [{ name: '过大.xlsx', company: '公司甲', category: TB_DIR, size: Number(stat.size), dev: String(stat.dev), ino: String(stat.ino), hash: '0'.repeat(64) }] }), /超过大小上限/);
});

test('并发分配同一文件不会覆盖，只有一个成功', async t => {
  const f = await fixture(t), args = { ...f.options, selections: [f.selection] };
  const attempts = await Promise.allSettled([copyFinanceAllocation(args), copyFinanceAllocation(args)]);
  const successes = attempts.filter(x => x.status === 'fulfilled').flatMap(x => x.value.results).filter(x => x.success);
  assert.equal(successes.length, 1);
  assert.equal(await fs.readFile(path.join(f.base, '公司甲', FIN_STATEMENT_DIR, '报表.xlsx'), 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(f.source, '报表.xlsx'), 'utf8'), 'original');
});
