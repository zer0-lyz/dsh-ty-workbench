// folder-template.js 回归测试（不联网、不碰真实 ~/.tycpv/folder-template.json）：
//   1) 内置默认树与 folders.js 骨架一致（STATIC_DIRS + 管理类底稿全部可达）
//   2) 树 → 路径：先父后子、无重复
//   3) 公司段：按方法/金额生成（资产基础法只建有金额科目；收益法 01~07；市场法一层）
//   4) 校验：非法字符目录名 / 超层级 / 一级目录重复 / 非 version 1 → 拒绝
//   5) 请求三态：GET 默认 isDefault=true → POST 保存 → DELETE 恢复默认（用临时文件）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATIC_DIRS, MGMT_FOLDER, MGMT_CATEGORIES } from './folders.js';
import {
  DEFAULT_FOLDER_TEMPLATE, treeToPaths, folderTemplatePlan, validateFolderTemplate,
  folderTemplateRequest,
} from './folder-template.js';

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'ftpl-')), 'folder-template.json');

test('默认树覆盖全部静态骨架与管理类分类', () => {
  const paths = new Set(treeToPaths(DEFAULT_FOLDER_TEMPLATE));
  for (const p of STATIC_DIRS) assert.ok(paths.has(p), '缺静态目录 ' + p);
  assert.ok(paths.has(MGMT_FOLDER));
  for (const cat of MGMT_CATEGORIES) assert.ok(paths.has(MGMT_FOLDER + '/' + cat));
});

test('树转路径先父后子且无重复', () => {
  const paths = treeToPaths(DEFAULT_FOLDER_TEMPLATE);
  assert.equal(new Set(paths).size, paths.length, '路径有重复');
  paths.forEach(p => {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      assert.ok(paths.includes(parts.slice(0, i).join('/')), '父目录不在计划里：' + parts.slice(0, i).join('/'));
    }
  });
});

test('公司段按方法与金额生成', () => {
  const plan = folderTemplatePlan(DEFAULT_FOLDER_TEMPLATE, [{
    name: '测试公司',
    methods: { whole: ['资产基础法', '收益法'] },
    subjects: [{ name: '货币资金', amount: 100 }, { name: '固定资产', amount: 0 }, { name: '存货', amount: '1,234.56' }],
  }]);
  const own = plan.filter(p => p.includes('测试公司'));
  assert.ok(own.includes('02现场资料/企业提供资料/00财务资料/测试公司'));
  assert.ok(own.includes('02现场资料/企业提供资料/02基础类/测试公司/公司基础资料'));
  assert.ok(own.includes('02现场资料/企业提供资料/03资产基础法/测试公司/01货币资金'), '有金额科目应建目录');
  assert.ok(!own.some(p => p.includes('03资产基础法/测试公司/12固定资产')), '金额为 0 的科目不应建目录');
  assert.ok(own.includes('02现场资料/企业提供资料/03资产基础法/测试公司/07存货'), '有金额的存货科目应建目录');
  assert.ok(own.includes('02现场资料/企业提供资料/04收益法/测试公司/07折现率'));
  assert.ok(!own.some(p => p.includes('05市场法/测试公司')), '没选市场法不应建');
});

test('校验拒绝非法模板', () => {
  assert.throws(() => validateFolderTemplate({ version: 2, groups: [] }), /version/);
  assert.throws(() => validateFolderTemplate({ version: 1, groups: [{ name: 'a/b' }] }), /不合法/);
  assert.throws(() => validateFolderTemplate({ version: 1, groups: [{ name: 'x' }, { name: 'x' }] }), /重复/);
  const deep = { version: 1, groups: [] };
  let cur = deep.groups;
  for (let i = 0; i < 7; i += 1) { const n = { name: 'L' + i, children: [] }; cur.push(n); cur = n.children; }
  assert.throws(() => validateFolderTemplate(deep), /层级/);
});

test('请求三态：GET 默认 → POST 保存 → DELETE 恢复', async () => {
  const file = tmpFile();
  const g1 = await (await folderTemplateRequest(new Request('http://x/t'), file)).json();
  assert.equal(g1.ok, true); assert.equal(g1.isDefault, true);
  const tpl = { version: 1, groups: [{ name: '99自定义', children: [] }] };
  const p = await (await folderTemplateRequest(new Request('http://x/t', { method: 'POST', body: JSON.stringify({ template: tpl }), headers: { 'content-type': 'application/json' } }), file)).json();
  assert.equal(p.ok, true);
  const g2 = await (await folderTemplateRequest(new Request('http://x/t'), file)).json();
  assert.equal(g2.isDefault, false);
  assert.deepEqual(g2.template.groups.map(x => x.name), ['99自定义']);
  const d = await (await folderTemplateRequest(new Request('http://x/t', { method: 'DELETE' }), file)).json();
  assert.equal(d.ok, true); assert.equal(d.isDefault, true);
});
