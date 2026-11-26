#!/usr/bin/env node
/**
 * 提交前自检：在「不启动宿主」的前提下，把 apply() 完整跑一遍。
 *
 * 存在理由（真实踩过的坑）：
 *   49fc435 在 apply() 末尾加了内置技能注册块，用了从未 import 的 `path`，
 *   于是抛 ReferenceError: path is not defined。Cordis 把整个 entry 判为 failed，
 *   连带回滚该 entry 之前注册的 82 条 /api/workbench/* 路由。
 *   表面上只是「导出按钮灰了、报 Unexpected token 'o', "not found"」，
 *   实际是插件整条挂了。package.json 原来没有任何 lint / 自检，这个错误一路溜进生产。
 *
 * 检查项：
 *   1. 模块能被 import（语法 / 顶层求值 / 具名导入符号是否存在）
 *   2. apply() 不抛异常（能抓到 path is not defined 这类 ReferenceError）
 *   3. 三段 effect 都执行到（API 路由 / agent tools / 内置技能）
 *   4. 路由实际注册数 > 0（防止「跑通了但一条都没注册」）
 *   5. 内置技能 SKILL.md 的 frontmatter 能解析出 name + description
 *
 * 用法：npm run check        （或 node scripts/check.mjs）
 * 退出码：0 通过，1 失败。任何一项失败都会打印具体原因。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

let failed = 0;
const fail = (msg) => { failed++; console.error('  ✗ ' + msg); };
const ok = (msg) => console.log('  ✓ ' + msg);

// ───────────────────────── 1. import ─────────────────────────
console.log('[1/6] 模块导入');
let mod;
try {
  mod = await import(join(ROOT, 'index.js'));
} catch (e) {
  console.error('  ✗ 模块无法 import：' + (e && e.message));
  console.error(String(e && e.stack || e).split('\n').slice(0, 8).join('\n'));
  process.exit(1);
}
if (typeof mod.apply !== 'function') fail('没有导出 apply 函数');
else ok('导出 apply / inject / name 正常（name=' + mod.name + '）');

// ───────────────────────── 2. 构造最小 ctx ─────────────────────────
// 只实现 apply() 真正会碰到的接口；缺哪个补哪个，宁可多给也不要让「没实现」
// 被误判成插件 bug。
const logs = [];
const registered = [];          // { path, methods }
const effects = [];             // { label, dispose }
const skillRegs = [];

const logger = {
  info: (...a) => logs.push(['info', ...a].join(' ')),
  warn: (...a) => logs.push(['warn', ...a].join(' ')),
  error: (...a) => logs.push(['error', ...a].join(' ')),
  debug: (...a) => logs.push(['debug', ...a].join(' ')),
};

const ctx = {
  logger,
  root: {},
  // 宿主服务注入：skills 必须给（否则技能注册块直接 return，测不出问题）
  get(name) {
    if (name === 'skills') {
      return { register: (s) => { skillRegs.push(s); }, list: () => skillRegs.slice() };
    }
    if (name === 'tools') return { register: (t) => { registered.push({ tool: t && t.name }); return () => {}; } };
    return null;
  },
  // 路由注册通道：宿主是通过 connection.fetch.register 暴露的
  connection: {
    fetch: {
      register(route) {
        if (!route || !route.path) throw new Error('register: route.path 缺失');
        if (!Array.isArray(route.methods) || !route.methods.length) throw new Error('register: ' + route.path + ' 缺少 methods');
        if (registered.some(r => r.path === route.path)) throw new Error('already registered: ' + route.path);
        registered.push({ path: route.path, methods: route.methods.slice(), fetch: route.fetch });
        return () => { const i = registered.findIndex(r => r.path === route.path); if (i >= 0) registered.splice(i, 1); };
      },
    },
  },
  effect(fn, label) {
    const dispose = fn();
    effects.push({ label, dispose });
    return () => { try { if (typeof dispose === 'function') dispose(); } catch (_) {} };
  },
  on() {}, off() {}, emit() {},
};

// apply() 的路由 owner 认领表挂在 globalThis 上，模拟一个干净的宿主进程
delete globalThis.__dshWorkbenchRouteOwners;
globalThis.__dshWorkbenchRouteOwners = new Map();

// ───────────────────────── 3. 跑 apply() ─────────────────────────
console.log('[2/6] apply() 执行');
try {
  mod.apply(ctx);
  ok('apply() 未抛异常');
} catch (e) {
  console.error('  ✗ apply() 抛异常：' + (e && e.constructor && e.constructor.name) + ': ' + (e && e.message));
  console.error(String(e && e.stack || e).split('\n').slice(0, 10).join('\n'));
  console.error('\n  → 这正是线上表现：entry 判 failed，之前注册的路由被整体回滚，');
  console.error('    前端只会看到宿主兜底的 404 "not found"（JSON.parse 报 Unexpected token）。');
  process.exit(1);
}

// ───────────────────────── 4. effect 覆盖 ─────────────────────────
console.log('[3/6] effect 段落');
const labels = effects.map(e => e.label);
for (const want of ['workbench: API routes', 'workbench: agent tools', 'workbench: bundled skill registration']) {
  if (labels.includes(want)) ok(want);
  else fail('缺少 effect：' + want + '（实际：' + labels.join(' | ') + '）');
}

// ───────────────────────── 5. 路由数 ─────────────────────────
console.log('[4/6] 路由注册');
const routeCount = registered.filter(r => typeof r.path === 'string' && r.path.startsWith('/api/workbench')).length;
if (routeCount > 0) ok('已注册 ' + routeCount + ' 条 /api/workbench/* 路由');
else fail('一条 /api/workbench/* 路由都没注册上');

// 导出链路依赖的关键路由，缺一条就说明有回归
const critical = [
  '/api/workbench/ping',
  '/api/workbench/ty/status',
  '/api/workbench/ty/cli/status',
  '/api/workbench/ty/export',
  '/api/workbench/ty/export/progress',
  '/api/workbench/ty/browser/export',
  '/api/workbench/ty/native/export',
  '/api/workbench/ty/report-build',
];
const paths = new Set(registered.map(r => r.path));
const missing = critical.filter(p => !paths.has(p));
if (missing.length === 0) ok('导出链路关键路由齐全（' + critical.length + ' 条）');
else fail('缺少关键路由：\n      ' + missing.join('\n      '));

// ───────────────────────── 6. 内置技能 ─────────────────────────
console.log('[5/6] 内置技能');
if (skillRegs.length === 0) {
  fail('内置技能未注册（skills 服务缺失或 SKILL.md 读不到）');
} else {
  const s = skillRegs[0];
  if (s.name && s.description) ok('已注册内置技能 ' + s.name);
  else fail('内置技能缺 name/description');
}
// 直接校验磁盘上的 SKILL.md，避免「注册了但 frontmatter 其实残缺」
try {
  const raw = readFileSync(join(ROOT, 'skills', 'tianyuan-query', 'SKILL.md'), 'utf8');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!fm) fail('skills/tianyuan-query/SKILL.md 缺 frontmatter');
  else if (!/^name:\s*\S/m.test(fm[1]) || !/^description:\s*\S/m.test(fm[1])) fail('SKILL.md frontmatter 缺 name 或 description');
  else ok('SKILL.md frontmatter 完整');
} catch (e) {
  fail('skills/tianyuan-query/SKILL.md 读取失败：' + e.message);
}

// ───────────── 包名与 client factory id 一致性 ─────────────
// 踩过两次的坑（b0bce42 / 609c425）：宿主 dsh-client-modules 的
// locatePkgJson → nearestPackage 要求 Loader 引用的名字与真实 package.json
// 的 name 逐字相等，否则 resolveMeta 返回 null，client bundle 被静默丢弃，
// 侧栏入口整个不出现，而宿主路由照旧注册、接口全正常——极难定位。
// 这里把「package.json name / client.js factory id / 自带 cordis.patch.yml」
// 三处锁死，任一处漂移就在自检阶段报出来。
console.log('[6/6] 包名与 client factory id');
try {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const pkgName = pkg.name;
  if (typeof pkgName !== 'string' || !pkgName) fail('package.json 缺 name');

  const firstClientLines = readFileSync(join(ROOT, 'client.js'), 'utf8').split('\n', 4).join('\n');
  const idMatch = /id:\s*'([^']+)'/.exec(firstClientLines);
  if (!idMatch) fail('client.js 前几行找不到 factory id');
  else if (idMatch[1] !== pkgName) fail('client.js factory id「' + idMatch[1] + '」≠ package.json name「' + pkgName + '」');
  else ok('client.js factory id 与包名一致：' + pkgName);

  const patchText = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
  const patchNames = [...patchText.matchAll(/^\s*-?\s*name:\s*'?([^'\n]+)'?\s*$/gm)].map(m => m[1].trim());
  const stray = patchNames.filter(n => n !== pkgName);
  if (stray.length) fail('cordis.patch.yml 引用了非本包名：' + stray.join('、'));
  else ok('cordis.patch.yml 引用的包名一致');

  // exports 必须提供 "./client"，否则宿主读不到 client bundle
  const exportsDecl = pkg.exports || {};
  if (exportsDecl['./client'] !== './client.js') fail('package.json exports 缺少 "./client": "./client.js"');
  else ok('exports ./client 指向 client.js');
} catch (e) {
  fail('包名一致性校验异常：' + e.message);
}

// ───────────────────────── 汇总 ─────────────────────────
// dispose 走一遍，顺带验证清理逻辑不会抛
for (const e of effects) {
  try { if (typeof e.dispose === 'function') e.dispose(); } catch (err) {
    console.error('  ! effect 清理抛异常（' + e.label + '）：' + (err && err.message));
  }
}

if (failed) {
  // 把 apply() 内部吞掉的 warn/error 全打出来。插件为了「不连坐路由」会把
  // 附加能力的异常降级成日志，如果不回显，自检只能报「内置技能未注册」，
  // 真实原因（比如 path is not defined）就藏起来了——那正是修这个 bug 时踩的坑。
  const noisy = logs.filter(l => /^\[?(warn|error)\]?/i.test(l));
  if (noisy.length) {
    console.error('\n  apply() 内部日志（真实原因通常在这里）：');
    for (const l of noisy) console.error('    ' + l);
  }
  console.error('\n✗ 自检未通过：' + failed + ' 项失败');
  process.exit(1);
}
console.log('\n✓ 自检通过（路由 ' + routeCount + ' 条、effect ' + effects.length + ' 段、内置技能 ' + skillRegs.length + ' 个）');
