import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectCompanyFolders, bindCompanyFolder, reconfirmCompanyFolderName, rebindMissingCompanyFolder, confirmCompanyFolderIdentity } from './company-folder-ownership.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'company-ownership-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = path.join(root, '02现场资料', '企业提供资料', '00财务资料');
  await fs.mkdir(path.join(base, '甲'), { recursive: true });
  await fs.mkdir(path.join(base, '乙'), { recursive: true });
  return { root, base };
}
const args = root => ({ projectRoot: root, projectId: 'p', companyId: '1', name: '甲公司', folder: '甲', confirmText: '确认绑定公司目录' });

test('existing folder is not auto-claimed; explicit binding survives rename', async t => {
  const { root } = await fixture(t);
  let v = await inspectCompanyFolders({ projectRoot: root, projectId: 'p', companies: [{ companyId: '1', name: '甲公司' }] });
  assert.equal(v.manifestExists, false); assert.equal(v.rows[0].status, 'unbound');
  await assert.rejects(bindCompanyFolder({ ...args(root), confirmText: '' }), /确认/);
  await bindCompanyFolder(args(root));
  assert.equal((await bindCompanyFolder(args(root))).alreadyBound, true);
  v = await inspectCompanyFolders({ projectRoot: root, projectId: 'p', companies: [{ companyId: '1', name: '新名称' }, { companyId: '2', name: '甲公司' }] });
  assert.deepEqual(v.rows.map(x => x.status), ['name_changed', 'unbound']);
  assert.equal(v.rows[0].folder, '甲');
  await assert.rejects(bindCompanyFolder({ ...args(root), name: '新名称' }), /名称变更/);
  await assert.rejects(bindCompanyFolder({ ...args(root), companyId: '2' }), /其他公司/);
  await assert.rejects(bindCompanyFolder({ ...args(root), folder: '乙' }), /其他目录/);
  await assert.rejects(inspectCompanyFolders({ projectRoot: root, projectId: 'another' }), /项目身份/);
});

test('missing and symlink targets are rejected and concurrent writers do not both acquire lock', async t => {
  const { root, base } = await fixture(t);
  await assert.rejects(bindCompanyFolder({ ...args(root), folder: '缺失' }), /ENOENT/);
  await fs.symlink(path.join(base, '甲'), path.join(base, '链接'));
  await assert.rejects(bindCompanyFolder({ ...args(root), folder: '链接' }), /普通目录/);
  const outcomes = await Promise.allSettled([bindCompanyFolder(args(root)), bindCompanyFolder({ ...args(root), companyId: '2', folder: '乙' })]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  const v = await inspectCompanyFolders({ projectRoot: root, projectId: 'p' });
  assert.equal(v.bindings.length, 1);
});

test('refuses manifest links, reserved names and invalid segments', async t => {
  const { root } = await fixture(t);
  await assert.rejects(bindCompanyFolder({ ...args(root), folder: '../bad' }), /目录段/);
  await assert.rejects(bindCompanyFolder({ ...args(root), folder: '00未分配财务资料' }), /目录段/);
  await fs.symlink(path.join(root, 'missing'), path.join(root, '.company-folder-ownership.json'));
  await assert.rejects(inspectCompanyFolders({ projectRoot: root, projectId: 'p' }));
});

test('名称变更与缺失重绑定均需确认并验证原值，绝不移动文件', async t => {
  const { root, base } = await fixture(t);
  await fs.writeFile(path.join(base, '甲', '样本.txt'), 'synthetic');
  await bindCompanyFolder(args(root));
  await bindCompanyFolder({ ...args(root), companyId: '2', name: '乙公司', folder: '乙' });
  const renameArgs = { projectRoot: root, projectId: 'p', companyId: '1', currentName: '新名称', expectedName: '甲公司', folder: '甲', confirmText: '确认更新公司目录归属名称' };
  for (const override of [{ confirmText: '' }, { expectedName: '伪造' }, { folder: '乙' }, { companyId: '9' }]) await assert.rejects(reconfirmCompanyFolderName({ ...renameArgs, ...override }));
  assert.equal((await reconfirmCompanyFolderName(renameArgs)).name, '新名称');
  await assert.rejects(reconfirmCompanyFolderName(renameArgs));
  const bindArgs = { projectRoot: root, projectId: 'p', companyId: '1', name: '新名称', previousFolder: '甲', folder: '乙', confirmText: '确认原目录缺失并重新绑定' };
  await assert.rejects(rebindMissingCompanyFolder(bindArgs), /原目录仍存在/);
  await fs.rename(path.join(base, '甲'), path.join(base, '移动的原目录'));
  await assert.rejects(rebindMissingCompanyFolder(bindArgs), /已绑定其他公司/);
  await fs.mkdir(path.join(base, '丙'));
  for (const override of [{ confirmText: '' }, { previousFolder: '错误' }, { name: '旧名称' }, { folder: '不存在' }]) await assert.rejects(rebindMissingCompanyFolder({ ...bindArgs, folder: '丙', ...override }));
  const result = await rebindMissingCompanyFolder({ ...bindArgs, folder: '丙' });
  assert.equal(result.folder, '丙');
  assert.equal(await fs.readFile(path.join(base, '移动的原目录', '样本.txt'), 'utf8'), 'synthetic');
  assert.deepEqual(await fs.readdir(path.join(base, '丙')), []);
});

test('旧清单和同名重建目录需独立人工确认身份', async t => {
  const { root, base } = await fixture(t);
  await bindCompanyFolder(args(root));
  const file = path.join(root, '.company-folder-ownership.json');
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  delete data.bindings[0].folderDev; delete data.bindings[0].folderIno;
  await fs.writeFile(file, JSON.stringify(data));
  const inspect = () => inspectCompanyFolders({ projectRoot: root, projectId: 'p', companies: [{ companyId: '1', name: '甲公司' }] });
  assert.equal((await inspect()).rows[0].status, 'identity_unverified');
  const confirm = { projectRoot: root, projectId: 'p', companyId: '1', expectedName: '甲公司', folder: '甲', confirmText: '确认该公司目录身份' };
  await assert.rejects(confirmCompanyFolderIdentity({ ...confirm, confirmText: '' }));
  await confirmCompanyFolderIdentity(confirm);
  assert.equal((await inspect()).rows[0].status, 'bound');
  await fs.rename(path.join(base, '甲'), path.join(base, '原目录'));
  await fs.mkdir(path.join(base, '甲'));
  assert.equal((await inspect()).rows[0].status, 'folder_changed');
  await assert.rejects(bindCompanyFolder(args(root)), /身份/);
  await assert.rejects(reconfirmCompanyFolderName({ ...confirm, currentName: '新名称', confirmText: '确认更新公司目录归属名称' }), /身份/);
  await confirmCompanyFolderIdentity(confirm);
  assert.equal((await inspect()).rows[0].status, 'bound');
});
