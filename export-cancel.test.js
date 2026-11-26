// 导出任务终止（cancel）回归测试（不联网、不碰真实 Cookie）：
//   1) cancel 路由对未知 jobId → 404，不误伤任何任务
//   2) runManualWorkflow cancel: () => true → 抛「导出已取消」，不启动任何子进程
//   3) cancel/onSpawn 类型错误被拒绝
//   4) 手动整理路由 + 慢速 python（WORKBENCH_PYTHON stub）→ 中途 cancel：
//      响应 400「导出已取消」，进度快照保留 cancelled，再次 cancel 返回 404
//   5) 正常完成的任务：进度快照被删除（不残留）
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ status: 200, text: async () => '{"code":200,"data":[]}', headers: new Map([['content-type','application/json']]) });
after(() => { globalThis.fetch = realFetch; });

const routes = [];
const mod = await import('./index.js');
mod.apply({
  connection: { fetch: { register: (r) => { routes.push(r); return () => {}; } } },
  logger: { warn: () => {}, info: () => {} },
  effect: (fn) => fn(),
});

const manualRoute = routes.find(r => r.path === '/api/workbench/ty/export/manual');
const cancelRoute = routes.find(r => r.path === '/api/workbench/ty/export/cancel');
const progressRoute = routes.find(r => r.path === '/api/workbench/ty/export/progress');
assert.ok(manualRoute && cancelRoute && progressRoute, 'manual/cancel/progress 路由均已注册');
const wf = await import('./export-workflow.js');

const req = (route, body) => route.fetch({ json: async () => body, url: 'http://127.0.0.1/x' });
const getProgress = async jobId => (await progressRoute.fetch({ json: async () => null, url: 'http://127.0.0.1/x?jobId=' + jobId })).json();
const jsonRes = async p => { const r = await p; return { status: r.status, body: await r.json() }; };

test('cancel 路由：未知 jobId 返回 404', async () => {
  const r = await jsonRes(req(cancelRoute, { jobId: 'no-such-job' }));
  assert.equal(r.status, 404);
  assert.equal(r.body.ok, false);
});

test('runManualWorkflow：cancel 为函数且返回 true → 抛「导出已取消」且不启动子进程', async () => {
  const outRoot = mkdtempSync(join(tmpdir(), 'ty-cancel-'));
  const outDir = join(outRoot, 'out');
  mkdirSync(outDir);
  const src = join(outRoot, 'a.xlsx');
  writeFileSync(src, 'not-a-real-xlsx-but-lstat-only');   // cancel 在任何脚本运行前触发
  let spawned = 0;
  await assert.rejects(
    wf.runManualWorkflow({
      sourcePath: src, outputDir: outDir, kind: 'declare', applyFormat: true,
      cancel: () => true,
      onSpawn: () => { spawned += 1; },
    }),
    /导出已取消/,
  );
  assert.equal(spawned, 0, '取消生效前不应启动任何子进程');
  rmSync(outRoot, { recursive: true, force: true });
});

test('runManualWorkflow：cancel/onSpawn 类型错误被拒绝', async () => {
  const outRoot = mkdtempSync(join(tmpdir(), 'ty-cancel-type-'));
  await assert.rejects(
    wf.runManualWorkflow({ sourcePath: join(outRoot, 'a.xlsx'), outputDir: outRoot, kind: 'detail', restoreFormulas: true, cancel: 'yes' }),
    /cancel 必须是函数/,
  );
  await assert.rejects(
    wf.runManualWorkflow({ sourcePath: join(outRoot, 'a.xlsx'), outputDir: outRoot, kind: 'detail', restoreFormulas: true, onSpawn: 1 }),
    /onSpawn 必须是函数/,
  );
  rmSync(outRoot, { recursive: true, force: true });
});

test('手动整理路由 + 慢速 python：中途 cancel → 400 已取消、进度保留 cancelled、可重复终止返回 404', { timeout: 60000 }, async () => {
  // 慢速 python stub：任何调用睡 30 秒，保证窗口足够点击 cancel。必须带 shebang（execFile 直接执行）。
  const stubDir = mkdtempSync(join(tmpdir(), 'ty-slowpy-'));
  const stubPy = join(stubDir, 'slowpython.py');
  writeFileSync(stubPy, '#!/usr/bin/env python3\nimport time\ntime.sleep(30)\n');
  chmodSync(stubPy, 0o755);
  const realPython = process.env.WORKBENCH_PYTHON;
  process.env.WORKBENCH_PYTHON = stubPy;
  try {
    const outRoot = mkdtempSync(join(tmpdir(), 'ty-cancel-e2e-'));
    const outDir = join(outRoot, 'out');
    mkdirSync(outDir);
    const srcDir = join(outRoot, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'b1.xlsx'), 'slow-1');
    writeFileSync(join(srcDir, 'b2.xlsx'), 'slow-2');   // 两份文件：第 1 份被杀后循环顶部取消，抛「导出已取消」

    const jobId = 'cancel-e2e-01';
    const pending = jsonRes(req(manualRoute, { jobId, sourcePath: srcDir, outputDir: outDir, kind: 'declare', applyFormat: true }));
    await new Promise(r => setTimeout(r, 2000));   // 等第 1 份进入处理循环
    const progBefore = await getProgress(jobId);
    assert.equal(progBefore.stage, 'process', '取消前应处于处理阶段');

    const c = await jsonRes(req(cancelRoute, { jobId }));
    assert.equal(c.status, 200);
    assert.equal(c.body.ok, true);

    const done = await pending;   // jsonRes 已在创建 pending 时完成解析
    assert.equal(done.status, 400);
    assert.match(done.body.error, /导出已取消/);

    const prog = await getProgress(jobId);
    assert.equal(prog.stage, 'cancelled');
    assert.equal(prog.msg, '已取消');

    const again = await jsonRes(req(cancelRoute, { jobId }));
    assert.equal(again.status, 404);

    rmSync(outRoot, { recursive: true, force: true });
  } finally {
    if (realPython === undefined) delete process.env.WORKBENCH_PYTHON; else process.env.WORKBENCH_PYTHON = realPython;
    rmSync(stubDir, { recursive: true, force: true });
  }
});

test('正常完成的任务：进度快照被删除', { timeout: 60000 }, async () => {
  // 即退 stub python：所有 run 调用立即成功（declare+applyFormat 不校验产出物，走完整收尾）。
  const stubDir = mkdtempSync(join(tmpdir(), 'ty-fastpy-'));
  const stubPy = join(stubDir, 'fastpython.py');
  writeFileSync(stubPy, '#!/usr/bin/env python3\n');
  chmodSync(stubPy, 0o755);
  const realPython = process.env.WORKBENCH_PYTHON;
  process.env.WORKBENCH_PYTHON = stubPy;
  try {
    const outRoot = mkdtempSync(join(tmpdir(), 'ty-ok-e2e-'));
    const outDir = join(outRoot, 'out');
    mkdirSync(outDir);
    const src = join(outRoot, 'c.xlsx');
    writeFileSync(src, 'fast');
    const jobId = 'ok-e2e-0001';
    const r = await jsonRes(req(manualRoute, { jobId, sourcePath: src, outputDir: outDir, kind: 'declare', applyFormat: true }));
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.deepEqual(await getProgress(jobId), { stage: 'unknown' }, '完成的任务应删除进度快照');
    rmSync(outRoot, { recursive: true, force: true });
  } finally {
    if (realPython === undefined) delete process.env.WORKBENCH_PYTHON; else process.env.WORKBENCH_PYTHON = realPython;
    rmSync(stubDir, { recursive: true, force: true });
  }
});
