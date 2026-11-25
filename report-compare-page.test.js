// 报告比对页的渲染 / 交互回归测试。
//
// 为什么需要它：client.js 是 preact h() 无 JSX 的单文件前端，没有构建步骤，
// 也没有任何在浏览器外验证它的办法 —— 而这一页最容易踩的坑恰好只有真渲染才暴露：
//   · Table(props) 内部直接读 props.rows.length，传 null 就崩；
//   · Empty(t) 只吃第一个参数，h(Empty, null, '文案') 会把 props 当标题；
//   · 写回闸门一旦写漏，用户就会在"还有没定位的改动"时按下写回。
// 所以这里用一个最小 React shim（真的跑 hooks）把组件真实渲染一遍，
// 再核对写回请求体只包含勾选项、身份一律由宿主凭据决定。
//
// 本轮改版的重点：页面不再要求先手动导出基线。
// 「原版」由宿主当场从线上取，所以测试里要盯住三件事：
//   1. 前端不能自己编 companyId/reportType/attachId —— 只能从下拉和版本列表来；
//   2. 写回必须带 compareToken（宿主侧哈希的唯一凭据），不带就写不了；
//   3. 页面任何状态下都不该出现"先去导出"的措辞。
//
// 只读 client.js，不联网，不碰任何真实项目数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, 'client.js');

// ---------- 最小 React shim ----------
function makeRuntime() {
  let hooks = [];
  let hookIndex = 0;
  let effects = [];
  let rerenderWanted = false;

  const createElement = (type, props, ...children) => ({
    $$el: true,
    type,
    props: {
      ...(props || {}),
      children: children.length ? (children.length === 1 ? children[0] : children) : (props && props.children),
    },
  });

  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

  const React = {
    createElement,
    Fragment: 'Fragment',
    useState(init) {
      const i = hookIndex++;
      if (!(i in hooks)) hooks[i] = { v: typeof init === 'function' ? init() : init };
      const slot = hooks[i];
      const set = v => { slot.v = typeof v === 'function' ? v(slot.v) : v; rerenderWanted = true; };
      return [slot.v, set];
    },
    useEffect(fn, deps) {
      const i = hookIndex++;
      const key = 'e' + i;
      const prev = hooks[key];
      if (!prev || !deps || !same(prev.deps, deps)) { hooks[key] = { deps }; effects.push(fn); }
    },
    useMemo(fn, deps) {
      const i = hookIndex++;
      const key = 'm' + i;
      const prev = hooks[key];
      if (!prev || !deps || !same(prev.deps, deps)) hooks[key] = { v: fn(), deps };
      return hooks[key].v;
    },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    // client.js 顶层 class WbErrorBoundary extends React.Component 在模块求值时立即执行，
    // shim 必须提供基类（测试里不渲染它，只要存在即可）。
    Component: function WbErrorBoundaryShim(props) { return null; },
    useRef(init) {
      const i = hookIndex++;
      if (!(i in hooks)) hooks[i] = { current: init };
      return hooks[i];
    },
  };

  return {
    React,
    get rerenderWanted() { return rerenderWanted; },
    reset() { hooks = []; hookIndex = 0; effects = []; rerenderWanted = false; },
    beginRender() { hookIndex = 0; effects = []; rerenderWanted = false; },
    takeEffects() { const out = effects.slice(); effects = []; return out; },
  };
}

class FakeFileReader {
  readAsDataURL() {
    // 组件只关心 dataURL 里逗号之后的部分
    setTimeout(() => { this.result = 'data:application/octet-stream;base64,QUJD'; this.onload && this.onload(); }, 0);
  }
}

function loadClient(fetchImpl) {
  const runtime = makeRuntime();
  const source = fs.readFileSync(CLIENT, 'utf8');
  const marker = '    const module = { exports: {} }, exports = module.exports;';
  const anchored = source.replace(marker, marker + '\n    exports.__test = { ReportComparePage, Table, Btn, Sel, Empty };');
  assert.notEqual(anchored, source, 'client.js 的模块尾部注入点变了，测试需要同步调整');

  const noop = () => {};
  const documentShim = {
    addEventListener: noop,
    removeEventListener: noop,
    createElement: () => ({ style: {}, appendChild: noop, click: noop, setAttribute: noop }),
    body: { appendChild: noop, removeChild: noop },
    documentElement: { style: {} },
    head: { appendChild: noop },
    querySelector: () => null,
  };
  let mod = null;
  const windowShim = {
    __ModuleLoader__: { load(def) { mod = def.factory(n => { if (n === 'react') return runtime.React; throw new Error('unexpected require: ' + n); }); } },
    addEventListener: noop,
    removeEventListener: noop,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    innerWidth: 1400,
    innerHeight: 900,
    location: { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1' },
  };
  const BlobShim = class { constructor(parts) { this.parts = parts; } };
  const URLShim = { createObjectURL: () => 'blob:test', revokeObjectURL: noop };

  const run = new Function(
    'window', 'document', 'localStorage', 'fetch', 'navigator', 'confirm', 'alert',
    'setTimeout', 'clearTimeout', 'FileReader', 'Blob', 'URL', 'src',
    'eval(src);',
  );
  run(windowShim, documentShim, windowShim.localStorage, fetchImpl, { userAgent: 'node' },
    () => true, noop, setTimeout, clearTimeout, FakeFileReader, BlobShim, URLShim, anchored);

  assert.ok(mod, 'client.js 没有注册模块');
  return { runtime, api: mod.__test, source };
}

// ---------- 渲染与遍历助手 ----------
function mount(runtime, Component, props) {
  for (let round = 0; round < 40; round++) {
    runtime.beginRender();
    const tree = Component(props);
    const pending = runtime.takeEffects();
    for (const fn of pending) fn();
    if (!runtime.rerenderWanted) return tree;
  }
  throw new Error('渲染在 40 轮内没有收敛（可能存在 setState 死循环）');
}

// 页面里用的是函数式基础组件；它们不碰 hooks，可以在页面渲染完成后安全再展开一层。
function makeWalker(api) {
  const safe = new Set([api.Table, api.Btn, api.Sel, api.Empty]);
  function expand(node, depth = 0) {
    if (depth > 20) throw new Error('expand depth exceeded');
    if (node == null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(n => expand(n, depth + 1));
    if (!node.$$el) return node;
    const kids = expand(node.props && node.props.children, depth + 1);
    if (typeof node.type === 'function' && safe.has(node.type)) return expand(node.type(node.props), depth + 1);
    return { ...node, props: { ...node.props, children: kids } };
  }
  function collect(node, acc = []) {
    if (node == null || node === false || typeof node === 'string' || typeof node === 'number') return acc;
    if (Array.isArray(node)) { node.forEach(n => collect(n, acc)); return acc; }
    if (!node.$$el) return acc;
    acc.push(node);
    collect(node.props && node.props.children, acc);
    return acc;
  }
  function textOf(node) {
    if (node == null || node === false) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join('');
    if (!node.$$el) return '';
    return textOf(node.props && node.props.children);
  }
  return {
    tree: node => expand(node),
    nodes: (node, pred) => collect(expand(node)).filter(pred),
    buttons: node => collect(expand(node)).filter(n => n.type === 'button'),
    button(node, label) {
      const all = collect(expand(node)).filter(n => n.type === 'button');
      const hit = all.find(n => textOf(n).includes(label));
      assert.ok(hit, '找不到按钮「' + label + '」，现有：' + all.map(n => textOf(n)).join(' | '));
      return hit;
    },
    checkboxes: node => collect(expand(node)).filter(n => n.type === 'input' && n.props && n.props.type === 'checkbox'),
    text: node => textOf(expand(node)),
    byClass(node, cls) {
      const hit = collect(expand(node)).find(n => n.props && String(n.props.className || '').split(/\s+/).includes(cls));
      assert.ok(hit, '找不到 .' + cls);
      return hit;
    },
  };
}

// ---------- 场景数据 ----------
const PROJECT_ID = '100000000000001';
const COMPANY_ID = '100000000000002';
const COMPANY_NAME = '测试公司';
const ATTACH_ID = '900000000000010';
const TOKEN = '11111111-2222-3333-4444-555555555555';

const flush = () => new Promise(r => setTimeout(r, 0));

function versionsReply(list) {
  return { ok: true, versions: list || [{ attachId: ATTACH_ID, version: '5', updatedAt: '2026-11-23T01:02:03.000Z', creator: '张三' }] };
}

function compareResult(over = {}) {
  const changes = over.changes || [
    { type: 'candidate_change', baseline: { kind: 'paragraph', path: [0], text: '原句一', unsupported: false }, modified: { kind: 'paragraph', path: [0], text: '改句一', unsupported: false } },
    { type: 'candidate_change', baseline: { kind: 'paragraph', path: [1], text: '原句二', unsupported: false }, modified: { kind: 'paragraph', path: [1], text: '改句二', unsupported: false } },
  ];
  const locate = over.locate || {
    available: true,
    counts: { located: 2, refused: 0 },
    located: changes.map((c, i) => ({
      index: i,
      baselineText: c.baseline.text,
      modifiedText: c.modified.text,
      unsupported: false,
      candidate: { itemId: '90000000000000' + i, itemIndex: [0], blockIndex: i },
      matchedBy: 'exact',
      writebackAllowed: false,
      requiresHumanReview: true,
    })),
    refused: [],
    writeChannel: {
      available: true,
      endpoint: 'POST /ty/api/report/config/item/content/save',
      locking: '写前 acquire，写后 release',
      blocking: ['写回是整节点覆盖。', '写前会重新抓线上节点树核对哈希。', '含变量、图片或附件的节点不写。'],
      requiresHumanReview: true,
    },
  };
  return { ok: true, readOnly: true, changes, locate, report: { writebackAllowed: false }, baseline: { warnings: [] }, modified: { warnings: [] }, ...over };
}

function makeFetch() {
  const calls = [];
  let routes = [];
  const impl = async (url, opts) => {
    const u = String(url);
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: u, body, method: (opts && opts.method) || 'GET' });
    const hit = routes.find(r => u.includes(r.match));
    if (!hit) throw new Error('未预期的请求：' + u);
    const payload = typeof hit.reply === 'function' ? hit.reply(body, u) : hit.reply;
    return {
      ok: (hit.status || 200) < 400,
      status: hit.status || 200,
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    };
  };
  return { impl, calls, set(list) { routes = list; }, reset() { calls.length = 0; } };
}

const STORE_PROPS = {
  s: { work: { ty: { cachedProjects: [{ id: PROJECT_ID, projectName: '测试项目' }] } }, settings: {} },
  toast: () => {},
};

// 常规路由：项目→公司、公司+类型→版本、比对返回结果 + 凭据
function defaultRoutes(result) {
  return [
    { match: '/ty/report-companies', reply: { ok: true, companies: [{ id: COMPANY_ID, name: COMPANY_NAME, types: [1, 2, 3] }], via: 'browser', typesKnown: true } },
    { match: '/ty/report-versions', reply: versionsReply() },
    { match: '/ty/report-compare-live', reply: { ok: true, result, compareToken: TOKEN, baseline: { version: '5', attachId: ATTACH_ID, companyName: COMPANY_NAME } } },
  ];
}

// 把页面推进到「已选公司/版本 + 已完成比对」。
// 项目确认改成了两段式：先在下拉里选项目，再点「确认项目」——确认前不发天源请求。
async function driveToResult(api, runtime, fetch, W, result, props = STORE_PROPS) {
  fetch.set(defaultRoutes(result));
  await driveToConfirmed(api, runtime, fetch, W, props);
  // 项目已确认 → 公司列表 → 版本列表，每步都是一个异步 effect
  for (let i = 0; i < 8; i++) { await flush(); mount(runtime, api.ReportComparePage, props); }

  let tree = mount(runtime, api.ReportComparePage, props);
  W.nodes(tree, n => n.type === 'input' && n.props && n.props.type === 'file')[0]
    .props.onChange({ target: { files: [{ name: '改稿.docx', size: 1024 }], value: 'x' } });
  tree = mount(runtime, api.ReportComparePage, props);

  W.button(tree, '开始比对').props.onClick();
  for (let i = 0; i < 6; i++) { await flush(); mount(runtime, api.ReportComparePage, props); }
  return mount(runtime, api.ReportComparePage, props);
}

// 只推进到「项目已确认」（公司列表已读取）。模拟：下拉选项目 → 点「确认项目」。
async function driveToConfirmed(api, runtime, fetch, W, props = STORE_PROPS) {
  mount(runtime, api.ReportComparePage, props);
  let tree = mount(runtime, api.ReportComparePage, props);
  const sel = W.nodes(tree, n => n.type === 'select')[0];
  assert.ok(sel, '项目下拉应存在');
  sel.props.onChange({ target: { value: PROJECT_ID } });
  tree = mount(runtime, api.ReportComparePage, props);
  // 确认前不得发任何天源请求
  assert.equal(fetch.calls.some(c => c.url.includes('/ty/report-companies')), false,
    '确认项目之前不能读取公司列表');
  W.button(tree, '确认项目').props.onClick();
  for (let i = 0; i < 8; i++) { await flush(); mount(runtime, api.ReportComparePage, props); }
  return mount(runtime, api.ReportComparePage, props);
}

// ---------- 测试 ----------
test('不再要求先导出：整页不出现"导出基线"这类措辞', () => {
  const fetch = makeFetch();
  fetch.set(defaultRoutes(compareResult()));
  const { api, runtime } = loadClient(fetch.impl);
  const W = makeWalker(api);
  const tree = mount(runtime, api.ReportComparePage, { s: {}, toast: () => {} });
  const text = W.text(tree);
  assert.doesNotMatch(text, /本地导出基线/);
  assert.doesNotMatch(text, /导出一次报告就会自动归档/, '旧流程那句引导必须彻底消失');
  assert.match(text, /不需要你事先导出/, '要把"不用先导出"明确写出来，否则用户不知道流程变了');
  assert.match(text, /先选项目/);
});

test('cachedProjects 不是数组时也不崩', () => {
  const fetch = makeFetch();
  fetch.set([]);
  const { api, runtime } = loadClient(fetch.impl);
  for (const bad of [{ work: { ty: { cachedProjects: null } } }, {}, { work: null }]) {
    mount(runtime, api.ReportComparePage, { s: bad, toast: () => {} });
  }
});

test('Table 必须传数组 rows —— candidateTable 的兜底依赖这个前提', () => {
  const fetch = makeFetch();
  fetch.set([]);
  const { api, runtime } = loadClient(fetch.impl);
  assert.doesNotThrow(() => mount(runtime, api.Table, { cols: ['a'], rows: [] }));
  assert.throws(() => mount(runtime, api.Table, { cols: ['a'], rows: null }));
});

test('公司列表来自 get_project_companies，单公司自动选中；确认前不发天源请求', async () => {
  const fetch = makeFetch();
  const { api, runtime } = loadClient(fetch.impl);
  const W = makeWalker(api);
  fetch.set(defaultRoutes(compareResult()));
  await driveToConfirmed(api, runtime, fetch, W);
  for (let i = 0; i < 8; i++) { await flush(); mount(runtime, api.ReportComparePage, STORE_PROPS); }
  const tree = mount(runtime, api.ReportComparePage, STORE_PROPS);

  const call = fetch.calls.find(c => c.url.includes('/ty/report-companies'));
  assert.ok(call, '确认项目后应通过 /ty/report-companies 取公司列表（要带 reportConfigList）');
  assert.match(call.url, new RegExp('projectId=' + PROJECT_ID));
  assert.match(W.text(tree), new RegExp(COMPANY_NAME), '公司名应出现在页面上');
});

test('公司没配置报告类型时：说清楚，不给可点的「重新生成」', async () => {
  // 真实场景：天源里有些公司 reportConfigList 为空（连「评估报告」都没建）。
  // 这时线上必然 0 个版本，若还放开三个类型 + 可点的「重新生成」，
  // 用户只会反复点到失败。
  const fetch = makeFetch();
  fetch.set([
    { match: '/ty/report-companies', reply: { ok: true, companies: [{ id: COMPANY_ID, name: COMPANY_NAME, types: [] }], via: 'browser', typesKnown: true } },
    { match: '/ty/report-versions', reply: { ok: true, versions: [], user: null, via: 'browser' } },
  ]);
  const { api, runtime } = loadClient(fetch.impl);
  const W = makeWalker(api);
  await driveToConfirmed(api, runtime, fetch, W);
  for (let i = 0; i < 8; i++) { await flush(); mount(runtime, api.ReportComparePage, STORE_PROPS); }
  const tree = mount(runtime, api.ReportComparePage, STORE_PROPS);
  const text = W.text(tree);
  assert.match(text, /还没有配置任何报告类型/, '应明确提示这家公司没配置报告类型');
  // 「重新生成」必须被禁用：没有类型可生成，点它必然是失败
  const regen = W.nodes(tree, n => n.type === 'button' && /重新生成/.test(W.text(n)))[0];
  assert.ok(regen, '「重新生成」按钮应仍在页面上（让用户知道有这个能力）');
  assert.equal(regen.props.disabled, true, '没配置任何报告类型时「重新生成」必须禁用');
});

test('版本列表：显示线上已生成版本，并标明最新/旧版', async () => {
  const fetch = makeFetch();
  fetch.set([
    { match: '/ty/report-companies', reply: { ok: true, companies: [{ id: COMPANY_ID, name: COMPANY_NAME, types: [1, 2, 3] }], via: 'browser', typesKnown: true } },
    { match: '/ty/report-versions', reply: versionsReply([
      { attachId: '900000000000011', version: '6', updatedAt: '2026-11-23T02:00:00.000Z', creator: '李四' },
      { attachId: ATTACH_ID, version: '5', updatedAt: '2026-11-23T01:00:00.000Z', creator: '张三' },
    ]) },
  ]);
  const { api, runtime } = loadClient(fetch.impl);
  const W = makeWalker(api);
  await driveToConfirmed(api, runtime, fetch, W);
  for (let i = 0; i < 8; i++) { await flush(); mount(runtime, api.ReportComparePage, STORE_PROPS); }
  const tree = mount(runtime, api.ReportComparePage, STORE_PROPS);

  const q = fetch.calls.find(c => c.url.includes('/ty/report-versions'));
  assert.ok(q, '应查询版本列表');
  assert.match(q.url, new RegExp('companyId=' + COMPANY_ID));
  assert.match(q.url, /reportType=1/);
  const text = W.text(tree);
  assert.match(text, /V6/);
  assert.match(text, /V5/);
  assert.match(text, /最新/);
  assert.match(text, /旧版/);
});

test('比对请求体：公司/类型来自下拉，不传 attachId 表示用最新版', async () => {
  const fetch = makeFetch();
  const { api, runtime } = loadClient(fetch.impl);
  const W = makeWalker(api);
  await driveToResult(api, runtime, fetch, W, compareResult());

  const call = fetch.calls.find(c => c.url.includes('/ty/report-compare-live'));
  assert.ok(call, '应发出比对请求');
  assert.equal(call.body.projectId, PROJECT_ID);
  assert.equal(call.body.companyId, COMPANY_ID);
  assert.equal(call.body.reportType, '1');
  assert.equal(call.body.attachId, undefined, '没显式选版本时不能自己编一个 attachId');
  assert.equal(call.body.filename, '改稿.docx');
  assert.ok(call.body.base64, 'base64 不应为空');
  assert.equal(fetch.calls.some(c => c.url.includes('/ty/report-compare') && !c.url.includes('-live')), false, '不该再走旧的基线比对接口');
});

test('全部定位唯一：可逐条勾选、二次确认前不发写回请求', async () => {
  const fetch = makeFetch();
  const { api, runtime } = loadClient(fetch.impl);
  const W = makeWalker(api);
  const tree0 = await driveToResult(api, runtime, fetch, W, compareResult());

  const boxes = W.checkboxes(tree0);
  assert.ok(boxes.length >= 2, '每个候选改动都该有勾选框，实际 ' + boxes.length);
  assert.equal(boxes[0].props.disabled, false, '定位唯一的行不该 disabled');
  assert.equal(W.button(tree0, '写回线上').props.disabled, true, '一处没勾时写回按钮必须 disabled');

  boxes[0].props.onChange();
  let tree = mount(runtime, api.ReportComparePage, STORE_PROPS);
  const wb = W.button(tree, '写回线上');
  assert.equal(wb.props.disabled, false, '勾选后写回按钮应可点');
  assert.match(W.text(wb), /1 处/);

  wb.props.onClick();
  tree = mount(runtime, api.ReportComparePage, STORE_PROPS);
  assert.equal(fetch.calls.some(c => c.url.includes('/ty/report-writeback')), false, '二次确认前不得发写回请求');
  assert.match(W.text(W.button(tree, '确认写回')), /1 处/);
});

test('写回请求体：confirm=true、带 compareToken、只含勾选项', async () => {
  const fetch = makeFetch();
  const { api, runtime } = loadClient(fetch.impl);
  const W = makeWalker(api);
  let tree = await driveToResult(api, runtime, fetch, W, compareResult());

  W.checkboxes(tree)[0].props.onChange();
  tree = mount(runtime, api.ReportComparePage, STORE_PROPS);
  W.button(tree, '写回线上').props.onClick();
  tree = mount(runtime, api.ReportComparePage, STORE_PROPS);

  fetch.set([
    ...defaultRoutes(compareResult()),
    { match: '/ty/report-writeback-live', reply: { ok: true, result: { applied: [{ itemId: '900000000000000', blockIndex: 0, original: '原句一', written: '改句一' }], skipped: [], failed: [], treeSha256Before: 'x', treeSha256After: 'x' } } },
  ]);
  W.button(tree, '确认写回').props.onClick();
  for (let i = 0; i < 4; i++) { await flush(); mount(runtime, api.ReportComparePage, STORE_PROPS); }
  tree = mount(runtime, api.ReportComparePage, STORE_PROPS);

  const call = fetch.calls.find(c => c.url.includes('/ty/report-writeback-live'));
  assert.ok(call, '应发出写回请求');
  const body = call.body;
  assert.equal(body.confirm, true);
  assert.equal(body.compareToken, TOKEN, '必须带宿主发的比对凭据，否则拿不到并发校验哈希');
  assert.equal(body.projectId, PROJECT_ID);
  assert.equal(body.locate.located.length, 1, '只应提交勾选的那 1 条');
  assert.equal(body.locate.located[0].index, 0);
  // 身份类字段一律不由前端提交：宿主从凭据里取。
  assert.equal(body.companyId, undefined, 'companyId 不该由前端指定');
  assert.equal(body.reportType, undefined, 'reportType 不该由前端指定');

  const text = W.text(tree);
  assert.match(text, /已写/, '写回后应逐条显示结果');
  assert.match(text, /900000000000000/, '结果应带节点 id');
});

test('存在未定位改动时整体禁止写回，并说明是哪一条卡住', async () => {
  const fetch = makeFetch();
  const { api, runtime } = loadClient(fetch.impl);
  const W = makeWalker(api);
  const changes = [
    { type: 'candidate_change', baseline: { text: 'A原', unsupported: false }, modified: { text: 'A改', unsupported: false } },
    { type: 'candidate_change', baseline: { text: 'B原', unsupported: false }, modified: { text: 'B改', unsupported: false } },
  ];
  const locate = {
    available: true,
    counts: { located: 1, refused: 1 },
    located: [{ index: 0, baselineText: 'A原', modifiedText: 'A改', unsupported: false, candidate: { itemId: '1', blockIndex: 0 }, matchedBy: 'exact', writebackAllowed: false, requiresHumanReview: true }],
    refused: [{ index: 1, baselineText: 'B原', modifiedText: 'B改', unsupported: false, reason: 'baseline text appears more than once; cannot locate uniquely' }],
    writeChannel: { available: true, endpoint: 'X', locking: 'Y', blocking: ['b1'], requiresHumanReview: true },
  };
  const tree = await driveToResult(api, runtime, fetch, W, compareResult({ changes, locate }));

  assert.match(W.text(tree), /还有 1 处改动无法唯一定位/);
  assert.equal(W.button(tree, '写回线上').props.disabled, true, '有未定位项时写回按钮必须 disabled');
  assert.equal(W.checkboxes(tree).some(b => !b.props.disabled), false, '有未定位项时所有勾选框都应 disabled');
});

test('含变量/图片的行置灰不可勾选，且必须可见（未配对内容单独成表）', async () => {
  const fetch = makeFetch();
  const { api, runtime } = loadClient(fetch.impl);
  const W = makeWalker(api);
  const changes = [
    { type: 'candidate_change', baseline: { text: 'A原', unsupported: false }, modified: { text: 'A改', unsupported: false } },
    { type: 'unpaired', baseline: [{ text: '含变量的段落', unsupported: true }], modified: [{ text: '含变量的段落改了', unsupported: true }], reason: 'ambiguous' },
  ];
  const locate = {
    available: true,
    counts: { located: 1, refused: 1 },
    located: [{ index: 0, baselineText: 'A原', modifiedText: 'A改', unsupported: false, candidate: { itemId: '1', blockIndex: 0 }, matchedBy: 'exact', writebackAllowed: false, requiresHumanReview: true }],
    refused: [{ index: 1, baselineText: '含变量的段落', modifiedText: '含变量的段落改了', unsupported: true, reason: 'unpaired block is not uniquely locatable' }],
    writeChannel: { available: true, endpoint: 'X', locking: 'Y', blocking: ['b1'], requiresHumanReview: true },
  };
  const tree = await driveToResult(api, runtime, fetch, W, compareResult({ changes, locate }));
  const text = W.text(tree);

  assert.match(text, /未配对内容/, '未配对内容必须单独成表且可见');
  assert.match(text, /含变量/, '应标注含变量/图片');
  assert.match(text, /不能写回/);
  assert.equal(W.checkboxes(tree).some(b => !b.props.disabled), false, '所有勾选框都应 disabled');
});

test('没有线上定位信息时：只做 Word 对 Word 比对，闸门给出对应原因', async () => {
  const fetch = makeFetch();
  const { api, runtime } = loadClient(fetch.impl);
  const W = makeWalker(api);
  const locate = { available: false, reason: 'baseline has no online snapshot', located: [], refused: [], counts: { located: 0, refused: 0 } };
  const tree = await driveToResult(api, runtime, fetch, W, compareResult({ locate }));
  assert.match(W.text(tree), /这次比对没有拿到线上节点快照/);
  assert.equal(W.button(tree, '写回线上').props.disabled, true);
});

test('比对结果没写回时会上报 dirty，写回后撤销（切页前的确认靠它）', async () => {
  const fetch = makeFetch();
  const { api, runtime } = loadClient(fetch.impl);
  const W = makeWalker(api);
  const seen = [];
  const props = { ...STORE_PROPS, onDirtyChange: v => seen.push(v) };

  fetch.set(defaultRoutes(compareResult()));
  let tree = mount(runtime, api.ReportComparePage, props);
  await driveToConfirmed(api, runtime, fetch, W, props);
  for (let i = 0; i < 8; i++) { await flush(); mount(runtime, api.ReportComparePage, props); }
  tree = mount(runtime, api.ReportComparePage, props);
  assert.equal(seen.includes(true), false, '刚进页面不该是脏的');

  W.nodes(tree, n => n.type === 'input' && n.props && n.props.type === 'file')[0]
    .props.onChange({ target: { files: [{ name: '改稿.docx', size: 1024 }], value: 'x' } });
  tree = mount(runtime, api.ReportComparePage, props);
  W.button(tree, '开始比对').props.onClick();
  for (let i = 0; i < 6; i++) { await flush(); mount(runtime, api.ReportComparePage, props); }
  tree = mount(runtime, api.ReportComparePage, props);
  assert.equal(seen[seen.length - 1], true, '有比对结果、还没写回时必须上报 dirty');

  W.checkboxes(tree)[0].props.onChange();
  tree = mount(runtime, api.ReportComparePage, props);
  W.button(tree, '写回线上').props.onClick();
  tree = mount(runtime, api.ReportComparePage, props);
  fetch.set([
    ...defaultRoutes(compareResult()),
    { match: '/ty/report-writeback-live', reply: { ok: true, result: { applied: [{ itemId: '900000000000000', blockIndex: 0, original: '原句一', written: '改句一' }], skipped: [], failed: [] } } },
  ]);
  W.button(tree, '确认写回').props.onClick();
  for (let i = 0; i < 4; i++) { await flush(); mount(runtime, api.ReportComparePage, props); }
  assert.equal(seen[seen.length - 1], false, '写回完成后不该再拦着用户切页');
});

test('宿主没回凭据时必须报错，不能假装能写回', async () => {
  const fetch = makeFetch();
  const { api, runtime } = loadClient(fetch.impl);
  const W = makeWalker(api);
  fetch.set([
    { match: '/ty/report-companies', reply: { ok: true, companies: [{ id: COMPANY_ID, name: COMPANY_NAME, types: [1, 2, 3] }], via: 'browser', typesKnown: true } },
    { match: '/ty/report-versions', reply: versionsReply() },
    // 少了 compareToken
    { match: '/ty/report-compare-live', reply: { ok: true, result: compareResult() } },
  ]);
  const props = STORE_PROPS;
  await driveToConfirmed(api, runtime, fetch, W, props);
  for (let i = 0; i < 8; i++) { await flush(); mount(runtime, api.ReportComparePage, props); }
  let tree = mount(runtime, api.ReportComparePage, props);
  W.nodes(tree, n => n.type === 'input' && n.props && n.props.type === 'file')[0]
    .props.onChange({ target: { files: [{ name: '改稿.docx', size: 1024 }], value: 'x' } });
  tree = mount(runtime, api.ReportComparePage, props);
  W.button(tree, '开始比对').props.onClick();
  for (let i = 0; i < 6; i++) { await flush(); mount(runtime, api.ReportComparePage, props); }
  tree = mount(runtime, api.ReportComparePage, props);

  assert.match(W.text(tree), /宿主没有返回比对凭据/);
  assert.equal(fetch.calls.some(c => c.url.includes('/ty/report-writeback')), false);
});

// ---------- 新版两段式：项目必须先确认，天源读取只在确认后发生 ----------
test('两段式：选了项目但没点「确认项目」时，不发天源请求，页面提示先确认', async () => {
  const fetch = makeFetch();
  fetch.set(defaultRoutes(compareResult()));
  const { api, runtime } = loadClient(fetch.impl);
  const W = makeWalker(api);
  mount(runtime, api.ReportComparePage, STORE_PROPS);
  let tree = mount(runtime, api.ReportComparePage, STORE_PROPS);
  const sel = W.nodes(tree, n => n.type === 'select')[0];
  assert.ok(sel, '项目下拉应存在');
  sel.props.onChange({ target: { value: PROJECT_ID } });
  for (let i = 0; i < 4; i++) { await flush(); mount(runtime, api.ReportComparePage, STORE_PROPS); }
  tree = mount(runtime, api.ReportComparePage, STORE_PROPS);

  // 宿主自己的 store/state 刷新允许存在；关键是不能碰任何 /ty/ 天源读取。
  assert.equal(fetch.calls.filter(c => c.url.includes('/ty/')).length, 0, '未确认前不应发出任何天源请求');
  assert.match(W.text(tree), /先选择并确认项目/, '页面应提示先确认项目');
  // 「开始比对」与文件选择必须不可用：天源数据还没读。
  const file = W.nodes(tree, n => n.type === 'input' && n.props && n.props.type === 'file')[0];
  assert.equal(file.props.disabled, true, '未确认项目前不能上传改稿');
  // 没有「确认写回/写回线上」按钮（没有比对结果），但有确认按钮
  W.button(tree, '确认项目');
});

test('两段式：确认后点「重新选择项目」会清空已读取的数据，回到未确认', async () => {
  const fetch = makeFetch();
  fetch.set(defaultRoutes(compareResult()));
  const { api, runtime } = loadClient(fetch.impl);
  const W = makeWalker(api);
  const tree0 = await driveToConfirmed(api, runtime, fetch, W);
  assert.match(W.text(tree0), /已确认/, '确认后应显示「已确认」标记');
  assert.ok(fetch.calls.some(c => c.url.includes('/ty/report-companies')), '确认后应已读取公司列表');

  const reset = W.button(tree0, '重新选择项目');
  reset.props.onClick();
  for (let i = 0; i < 4; i++) { await flush(); mount(runtime, api.ReportComparePage, STORE_PROPS); }
  const tree = mount(runtime, api.ReportComparePage, STORE_PROPS);
  const text = W.text(tree);
  assert.match(text, /未确认/, '应回到未确认状态');
  assert.doesNotMatch(text, new RegExp(COMPANY_NAME), '上一个项目的公司数据应被清空');
  // 下拉回到空草稿
  const sel = W.nodes(tree, n => n.type === 'select')[0];
  assert.equal(sel.props.value, '', '项目下拉应回到未选状态');
});

test('新增段落与删除段落必须单独成行，并说明是插/删而不是改字', async () => {
  const fetch = makeFetch();
  const { api, runtime } = loadClient(fetch.impl);
  const W = makeWalker(api);
  const changes = [
    {
      type: 'insertion',
      after: { kind: 'paragraph', path: [0], text: '市场法是指…', unsupported: false },
      before: null,
      modified: [{ kind: 'paragraph', path: [1], text: '这是线下新加的一段', unsupported: false }],
    },
    {
      type: 'deletion',
      after: null,
      before: null,
      baseline: [{ kind: 'paragraph', path: [2], text: '这段被删掉了', unsupported: false }],
    },
  ];
  const result = compareResult({
    changes,
    locate: {
      available: true,
      counts: { located: 2, refused: 0 },
      located: [
        {
          index: 0, kind: 'insertion', baselineText: '', modifiedText: '这是线下新加的一段', unsupported: false,
          candidate: { itemId: '900000000000020', itemIndex: [0], blockIndex: 2 },
          matchedBy: 'anchor exact', anchorFrom: 'after', writebackAllowed: false, requiresHumanReview: true,
        },
        {
          index: 1, kind: 'deletion', baselineText: '这段被删掉了', modifiedText: '', unsupported: false,
          candidate: { itemId: '900000000000021', itemIndex: [0], blockIndex: 0 },
          matchedBy: 'anchor exact', anchorFrom: 'self', deleteTexts: ['这段被删掉了'],
          writebackAllowed: false, requiresHumanReview: true,
        },
      ],
      refused: [],
      writeChannel: { available: true, blocking: ['写回是整节点覆盖。'], requiresHumanReview: true },
    },
  });
  const tree = await driveToResult(api, runtime, fetch, W, result);
  const text = W.text(tree);
  assert.match(text, /新增段落/, '插入行必须有「新增段落」标记');
  assert.match(text, /删除段落/, '删除行必须有「删除段落」标记');
  assert.match(text, /之后插入/, '插入行要说明插在哪一段之后');
  assert.match(text, /（删除）/, '删除行要在位置列标明是删除');
  assert.match(text, /这是线下新加的一段/, '新增内容必须可见');
  assert.match(text, /这段被删掉了/, '被删内容必须可见');

  // 两行都必须可勾选（都能写回），且写回条数按 2 处计
  const boxes = W.checkboxes(tree).filter(b => b.props.disabled === false);
  assert.ok(boxes.length >= 2, '新增与删除都该可勾选，实际可勾选 ' + boxes.length);
});
