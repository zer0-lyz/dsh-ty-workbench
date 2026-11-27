// 路由安全测试：只使用临时目录与合成数据，不读取真实项目。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, realpath, access, rm, rename, readFile } from 'node:fs/promises';
import { scanFinanceAllocation } from './finance-allocation.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = await mkdtemp(join(await realpath(tmpdir()), 'unallocated-route-'));
process.env.DSH_WORKBENCH_CONFIG = join(tmp, 'nonexistent-config.json');
process.env.DSH_WORKBENCH_DATA_DIR = join(tmp, 'state');
process.env.DSH_WORKBENCH_PROJECTS_DIR = join(tmp, 'projects');
await mkdir(process.env.DSH_WORKBENCH_DATA_DIR);
const a = join(tmp, 'project-a'), b = join(tmp, 'project-b'), outside = join(tmp, 'outside');
await Promise.all([a, b, outside].map(p => mkdir(p)));
const state = { work: { projects: [{ id: 'a', folderPath: a }, { id: 'b', folderPath: b }], equity: { a: { companies: [{ id: 'c', name: '测试公司' }] } } } };
async function save() { await writeFile(join(process.env.DSH_WORKBENCH_DATA_DIR, '工作台数据.json'), JSON.stringify({ data: state })); }
await save();
const routes = [];
const mod = await import('./index.js');
mod.apply({ connection: { fetch: { register: r => { routes.push(r); return () => {}; } } }, logger: { warn() {}, info() {} }, effect: fn => fn() });
async function request(route, body) {
  const handler = routes.find(r => r.path === '/api/workbench/project/finance/unallocated-' + route);
  assert.ok(handler);
  const res = await handler.fetch(new Request('http://localhost/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}
async function absent(p) { await assert.rejects(access(p), { code: 'ENOENT' }); }
const rel = ['02现场资料', '企业提供资料', '00财务资料', '00未分配财务资料'];
after(async () => { await rm(tmp, { recursive: true, force: true }); });

test('四个路由均拒绝缺失、未知或项目与目录不匹配', async () => {
  for (const route of ['init', 'scan', 'preview', 'apply', 'ownership', 'bind', 'reconfirm-name', 'rebind-missing', 'confirm-folder-identity']) {
    for (const requestBody of [{ abs: a }, { projectId: 'missing', abs: a }, { projectId: 'a', abs: b }]) {
      const result = await request(route, { ...requestBody, confirmText: '确认分配财务资料' });
      assert.equal(result.status, 400, `${route} ${JSON.stringify(requestBody)}`);
    }
  }
  await absent(join(a, rel[0]));
  await absent(join(b, rel[0]));
});

test('正确绑定可初始化，重复初始化不删除已有内容', async () => {
  let result = await request('init', { projectId: 'a', abs: a });
  assert.equal(result.body.ok, true);
  const file = join(a, ...rel, 'synthetic.txt');
  await writeFile(file, 'synthetic');
  result = await request('init', { projectId: 'a', abs: a });
  assert.equal(result.body.ok, true);
  await access(file);
});

test('初始化拒绝项目根路径祖先及内部符号链接，不在链接目标创建子目录', async () => {
  const link = join(tmp, 'linked');
  await symlink(outside, link, 'dir');
  const nestedRoot = join(link, 'root');
  await mkdir(join(outside, 'root'));
  state.work.projects.push({ id: 'link', folderPath: nestedRoot });
  await save();
  let result = await request('init', { projectId: 'link', abs: nestedRoot });
  assert.equal(result.status, 400);
  await absent(join(outside, 'root', rel[0]));
  const innerRoot = join(tmp, 'inner');
  await mkdir(innerRoot);
  await symlink(outside, join(innerRoot, rel[0]), 'dir');
  state.work.projects.push({ id: 'inner', folderPath: innerRoot });
  await save();
  result = await request('init', { projectId: 'inner', abs: innerRoot });
  assert.equal(result.status, 400);
  await absent(join(outside, rel[1]));
});

test('解除绑定或重复 ID 后立即拒绝，不信任旧请求', async () => {
  state.work.projects[0].folderPath = '';
  await save();
  assert.equal((await request('init', { projectId: 'a', abs: a })).status, 400);
  state.work.projects[0].folderPath = a;
  state.work.projects.push({ id: 'a', folderPath: a });
  await save();
  assert.equal((await request('init', { projectId: 'a', abs: a })).status, 400);
  state.work.projects.pop();
  state.work.projects.push({ id: 'other', folderPath: a });
  await save();
  assert.equal((await request('init', { projectId: 'a', abs: a })).status, 400);
  state.work.projects.pop();
  await save();
});

test('归属查询只读，明确绑定后仅使用清单目录；改名或缺目录阻止', async () => {
  const base = join(a, ...rel.slice(0, 3));
  await mkdir(join(base, '人工选择目录'));
  await mkdir(join(base, '伪造名称'));
  const args = { projectId: 'a', abs: a };
  const snap = await scanFinanceAllocation({ projectRoot: a });
  const file = snap.files.find(f => f.name === 'synthetic.txt');
  const items = [{ name: file.name, sourceHash: file.hash, companyId: 'c', company: '伪造名称', category: '01财务报表' }];
  let r = await request('ownership', args);
  assert.equal(r.body.rows[0].status, 'unbound');
  assert.ok(r.body.folders.includes('人工选择目录'));
  await absent(join(a, '.company-folder-ownership.json'));
  r = await request('preview', { ...args, items });
  assert.equal(r.body.ok, false);
  r = await request('apply', { ...args, items, confirmText: '确认分配财务资料' });
  assert.equal(r.body.ok, false);
  await absent(join(base, '伪造名称', '01财务报表'));
  for (const body of [
    { companyId: 'c', folder: '人工选择目录' },
    { companyId: 'other', folder: '人工选择目录', confirmText: '确认绑定公司目录' },
    { companyId: 'c', folder: '不存在', confirmText: '确认绑定公司目录' },
  ]) assert.equal((await request('bind', { ...args, ...body })).status, 400);
  r = await request('bind', { ...args, companyId: 'c', folder: '人工选择目录', name: '伪造名称', confirmText: '确认绑定公司目录' });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.binding.name, '测试公司');
  r = await request('preview', { ...args, items });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.items[0].destination, join(base, '人工选择目录', '01财务报表', file.name));
  state.work.equity.a.companies[0].name = '改名公司';
  await save();
  r = await request('ownership', args);
  assert.equal(r.body.rows[0].status, 'name_changed');
  assert.equal((await request('preview', { ...args, items })).body.ok, false);
  assert.equal((await request('apply', { ...args, items, confirmText: '确认分配财务资料' })).body.ok, false);
  const renameArgs = { ...args, companyId: 'c', expectedName: '测试公司', currentName: '改名公司', folder: '人工选择目录', confirmText: '确认更新公司目录归属名称' };
  for (const bad of [{ currentName: '伪造' }, { expectedName: '伪造' }, { folder: '伪造名称' }, { confirmText: '' }, { companyId: 'unknown' }]) assert.equal((await request('reconfirm-name', { ...renameArgs, ...bad })).status, 400);
  assert.equal((await request('reconfirm-name', renameArgs)).body.ok, true);
  assert.equal((await request('reconfirm-name', renameArgs)).status, 400);
  const rebindArgs = { ...args, companyId: 'c', previousFolder: '人工选择目录', folder: '伪造名称', confirmText: '确认原目录缺失并重新绑定' };
  assert.equal((await request('rebind-missing', rebindArgs)).status, 400);
  await rename(join(base, '人工选择目录'), join(base, '暂存目录'));
  r = await request('ownership', args);
  assert.equal(r.body.rows[0].status, 'folder_missing');
  assert.equal((await request('apply', { ...args, items, confirmText: '确认分配财务资料' })).body.ok, false);
  for (const bad of [{ previousFolder: '伪造' }, { folder: '不存在' }, { confirmText: '' }, { companyId: 'unknown' }]) assert.equal((await request('rebind-missing', { ...rebindArgs, ...bad })).status, 400);
  assert.equal((await request('rebind-missing', rebindArgs)).body.ok, true);
  assert.deepEqual(await (await import('node:fs/promises')).readdir(join(base, '伪造名称')), []);
  r = await request('apply', { ...args, items, confirmText: '确认分配财务资料' });
  assert.equal(r.body.ok, true);
  assert.equal(await readFile(join(base, '伪造名称', '01财务报表', file.name), 'utf8'), 'synthetic');
  await absent(join(base, '暂存目录', '01财务报表'));
});

test('同名替换目录拒绝分配及单公司扫描，明确确认身份后恢复', async () => {
  const args = { projectId: 'a', abs: a, companyId: 'c' };
  const base = join(a, ...rel.slice(0, 3));
  const folder = join(base, '伪造名称');
  await rename(folder, join(base, '旧目录备份'));
  await mkdir(folder);
  let r = await request('ownership', args);
  assert.equal(r.body.rows[0].status, 'folder_changed');
  const file = (await scanFinanceAllocation({ projectRoot: a })).files.find(x => x.name === 'synthetic.txt');
  const items = [{ name: file.name, sourceHash: file.hash, companyId: 'c', category: '01财务报表' }];
  assert.equal((await request('apply', { ...args, items, confirmText: '确认分配财务资料' })).body.ok, false);
  async function direct(endpoint, body) {
    const handler = routes.find(x => x.path === '/api/workbench/project/finance/' + endpoint);
    const res = await handler.fetch(new Request('http://localhost/', { method: 'POST', body: JSON.stringify(body) }));
    return { status: res.status, body: await res.json() };
  }
  for (const endpoint of ['scan', 'ai-parse']) {
    assert.notEqual((await direct(endpoint, { ...args, company: '伪造名称', targets: [{ fileName: 'x.xlsx', sheet: 'x' }] })).body.ok, true);
    assert.notEqual((await direct(endpoint, { abs: a, company: '伪造名称' })).body.ok, true);
  }
  const confirm = { ...args, expectedName: '改名公司', currentName: '改名公司', folder: '伪造名称', confirmText: '确认该公司目录身份' };
  assert.equal((await request('confirm-folder-identity', { ...confirm, currentName: '假名' })).status, 400);
  assert.equal((await request('confirm-folder-identity', { ...confirm, confirmText: '' })).status, 400);
  assert.equal((await request('confirm-folder-identity', confirm)).body.ok, true);
  assert.equal((await request('ownership', args)).body.rows[0].status, 'bound');
  for (const endpoint of ['scan', 'ai-parse']) {
    for (const override of [{ projectId: 'b' }, { companyId: 'other' }, { abs: b }]) {
      assert.notEqual((await direct(endpoint, { ...args, ...override, targets: [{ fileName: 'x.xlsx', sheet: 'x' }] })).body.ok, true);
    }
  }
  await symlink(join(base, '旧目录备份'), join(folder, '01财务报表'), 'dir');
  for (const endpoint of ['scan', 'ai-parse']) assert.notEqual((await direct(endpoint, { ...args, targets: [{ fileName: 'x.xlsx', sheet: 'x' }] })).body.ok, true);
});
