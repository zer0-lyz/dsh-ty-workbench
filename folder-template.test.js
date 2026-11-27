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
import { STATIC_DIRS, MGMT_FOLDER, MGMT_CATEGORIES, planProjectFolders } from './folders.js';
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
  // 企业提供资料下五个方法段骨架：模板页能看到全貌（公司相关子目录仍由规则动态补齐）
  ['00财务资料', '02基础类', '03资产基础法', '04收益法', '05市场法'].forEach(seg => {
    assert.ok(paths.has('02现场资料/企业提供资料/' + seg), '缺方法段骨架 ' + seg);
  });
  assert.ok(paths.has('02现场资料/企业提供资料/04收益法/07折现率'), '收益法 01~07 固定子目录应在模板里');
});

test('folderTemplatePlan 去重且先父后子', () => {
  const plan = folderTemplatePlan(DEFAULT_FOLDER_TEMPLATE, [{
    name: '测试公司', methods: { whole: ['资产基础法'] }, subjects: [{ name: '货币资金', amount: 1 }],
  }]);
  assert.equal(new Set(plan).size, plan.length, '模板与公司段合并后有重复');
  const idx = plan.indexOf('02现场资料/企业提供资料/03资产基础法');
  const idxCo = plan.indexOf('02现场资料/企业提供资料/03资产基础法/测试公司/01货币资金');
  assert.ok(idx >= 0 && idxCo > idx, '先父后子顺序被破坏');
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
  assert.ok(own.includes('02现场资料/企业提供资料/03资产基础法/测试公司/01货币资金/查证资料'), '科目夹必有查证资料（天源同构）');
  assert.ok(own.includes('02现场资料/企业提供资料/03资产基础法/测试公司/01货币资金/盘点'), '货币资金配盘点夹');
  assert.ok(!own.some(p => p.includes('03资产基础法/测试公司/12固定资产')), '金额为 0 的科目不应建目录');
  assert.ok(own.includes('02现场资料/企业提供资料/03资产基础法/测试公司/07存货'), '有金额的存货科目应建目录');
  assert.ok(own.includes('02现场资料/企业提供资料/03资产基础法/测试公司/07存货/科目通用文件'), '存货配科目通用文件');
  assert.ok(!own.some(p => p.includes('03资产基础法/测试公司/07存货/其他')), '存货不配其他');
  // 固定资产带明细：明细层各配 查证资料+其他（对齐天源 房屋建筑物/车辆 等）
  const plan2 = folderTemplatePlan(DEFAULT_FOLDER_TEMPLATE, [{
    name: '测试公司',
    methods: { whole: ['资产基础法'] },
    subjects: [{ name: '固定资产', amount: 1 }],
  }]);
  const own2 = plan2.filter(p => p.includes('测试公司'));
  assert.ok(own2.includes('02现场资料/企业提供资料/03资产基础法/测试公司/12固定资产/01房屋建筑物和构筑物/查证资料'), '明细配查证资料');
  assert.ok(own2.includes('02现场资料/企业提供资料/03资产基础法/测试公司/12固定资产/01房屋建筑物和构筑物/其他'), '明细配其他');
  assert.ok(own.includes('02现场资料/企业提供资料/04收益法/测试公司/07折现率'));
  assert.ok(!own.some(p => p.includes('05市场法/测试公司')), '没选市场法不应建');
});

test('目录命名冲突不静默合并公司', () => {
  const examples = [
    ['甲', '甲', '甲(2)'],
    ['ABC', 'abc'],
    ['00未分配财务资料'],
  ];
  for (const names of examples) {
    const companies = names.map(name => ({ name }));
    assert.throws(() => folderTemplatePlan(DEFAULT_FOLDER_TEMPLATE, companies), /目录名称冲突/);
    assert.throws(() => planProjectFolders({ companies }), /目录名称冲突/);
  }
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
