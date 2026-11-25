import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { openShell } from './opener.js';

/**
 * 数据工具宿主半侧：/api/workbench/dt/*
 *
 * 背景（2026-11-21）：client.js 早就移植了「数据工具」的 7 个子面板，但宿主一直没注册
 * 对应的 /dt/* 路由。未命中的请求落到 connection.fetch 的兜底，返回的是纯文本
 * "not found"（不是 JSON），前端 r.json() 于是抛出
 *   Unexpected token 'o', "not found" is not valid JSON
 * —— 这就是「行政区加载失败」的真正原因，与浙江土地市场网的网络无关。
 *
 * 本模块把这些路由补齐，并且**任何失败都回 JSON**（never 让前端去解析纯文本），
 * 数据源能用的走真实实现，依赖缺失的（opencli / playwright）回可读的错误码，
 * 不用 404 假装能用。
 */

const DT_REV = 'rev22';

function json(data, status) {
  const body = JSON.stringify(data === undefined ? null : data);
  return new Response(body, {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(Buffer.byteLength(body)),
    },
  });
}

function fail(error, extra, status) {
  // 默认 500：异常分支不能再回 200，否则前端只能靠 ok:false 猜，日志里也看不出是失败的请求
  return json({ ok: false, error: String(error || '未知错误'), ...(extra || {}) }, status || 500);
}

// ---------- 评估工具箱安装位置（数据工具的实现来源） ----------
function toolboxRoot() {
  const candidates = [
    process.env.DSH_DT_TOOLBOX,
    process.env.TIANYUAN_RUNTIME_DIR,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'AppraisalToolbox') : '',
    join(homedir(), 'AppData', 'Local', 'AppraisalToolbox'),
    '/Applications/AppraisalToolbox.app/Contents/Resources',
    join(homedir(), 'Library', 'Application Support', 'AppraisalToolbox'),
  ].filter(Boolean);
  return candidates.find(p => existsSync(join(p, 'skills'))) || '';
}

function pythonBin() {
  const root = toolboxRoot();
  const exe = process.platform === 'win32'
    ? join(root, 'runtime', 'python-portable', 'python.exe')
    : join(root, 'runtime', 'python-portable', 'bin', 'python3');
  const candidates = [process.env.DSH_DT_PYTHON, root && exe, 'python3', 'python'].filter(Boolean);
  for (const c of candidates) {
    if (!isAbsolute(c)) return c;               // 交给 PATH 解析
    if (existsSync(c)) return c;
  }
  return 'python3';
}

// 地图配置与工具箱同址：读者（python 脚本）靠 TIANYUAN_MAP_CONFIG_PATH 找它
function mapConfigPath() {
  return process.env.DSH_DT_MAP_CONFIG || join(homedir(), '.tianyuan-workbench', 'map-config.json');
}

function readMapConfig() {
  try {
    const raw = JSON.parse(readFileSync(mapConfigPath(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (e) { return {}; }
}

function maskSecret(v) {
  const s = String(v || '');
  return s ? '•'.repeat(Math.max(4, s.length - 4)) + s.slice(-4) : '';
}

function mapConfigSummary(extra) {
  const stored = readMapConfig();
  const amap = stored.amap && typeof stored.amap === 'object' ? stored.amap : {};
  const baidu = stored.baidu && typeof stored.baidu === 'object' ? stored.baidu : {};
  // 百度两家能力用两套凭证，且都可以从环境变量直接生效（skill 的既定口径）：
  //   普通 webapi -> BMAP_WEBAPI_AK（query 参数 ak）
  //   Agent Plan -> BAIDU_MAP_AUTH_TOKEN（Header: Authorization: Bearer <SK>）
  // 环境变量也算「已配置」，但要单独标出来，免得用户在面板里以为没存上。
  const baiduWebApiAkFromEnv = Boolean(process.env.BMAP_WEBAPI_AK);
  const baiduAgentPlanSkFromEnv = Boolean(process.env.BAIDU_MAP_AUTH_TOKEN);
  const baiduWebApiAk = baidu.webApiAk || (baiduWebApiAkFromEnv ? process.env.BMAP_WEBAPI_AK : '');
  const baiduAgentPlanSk = baidu.agentPlanSk || (baiduAgentPlanSkFromEnv ? process.env.BAIDU_MAP_AUTH_TOKEN : '');
  return {
    ok: true,
    ...(extra || {}),
    amap: {
      enabled: amap.enabled === true,
      configured: Boolean(amap.enabled && amap.webKey),
      webKeyConfigured: Boolean(amap.webKey),
      webKeyMasked: maskSecret(amap.webKey),
      securityConfigured: Boolean(amap.securityJsCode),
    },
    baidu: {
      enabled: baidu.enabled === true,
      configured: Boolean(baidu.enabled && (baiduWebApiAk || baiduAgentPlanSk)),
      webApiAkConfigured: Boolean(baiduWebApiAk),
      webApiAkMasked: maskSecret(baiduWebApiAk),
      webApiAkFromEnv: baiduWebApiAkFromEnv && !baidu.webApiAk,
      agentPlanSkConfigured: Boolean(baiduAgentPlanSk),
      agentPlanSkMasked: maskSecret(baiduAgentPlanSk),
      agentPlanSkFromEnv: baiduAgentPlanSkFromEnv && !baidu.agentPlanSk,
    },
    // 旧字段保留：rev21 的客户端读的是这几个扁平键，别把已发布的读取路径弄坏
    configured: Boolean(amap.enabled && amap.webKey),
    webKeyConfigured: Boolean(amap.webKey),
    enabled: amap.enabled === true,
    webKeyMasked: maskSecret(amap.webKey),
    path: mapConfigPath(),
  };
}

// 把地图配置里的百度凭证桥接给子进程：python 侧的 skill 读的是
// BMAP_WEBAPI_AK / BAIDU_MAP_AUTH_TOKEN，面板里存的值不落到环境变量就没人用得上。
// 高德走 TIANYUAN_MAP_CONFIG_PATH（沿用工具箱既有约定，amap_support.py 自己读文件）。
function mapConfigEnv() {
  const stored = readMapConfig();
  const baidu = stored.baidu && typeof stored.baidu === 'object' ? stored.baidu : {};
  const extra = { TIANYUAN_MAP_CONFIG_PATH: mapConfigPath() };
  if (baidu.webApiAk && !process.env.BMAP_WEBAPI_AK) extra.BMAP_WEBAPI_AK = String(baidu.webApiAk);
  if (baidu.agentPlanSk && !process.env.BAIDU_MAP_AUTH_TOKEN) extra.BAIDU_MAP_AUTH_TOKEN = String(baidu.agentPlanSk);
  return extra;
}

function defaultOutputDir(sub) {
  return join(homedir(), 'Documents', '天源评估', '个人工作台', '数据工具输出', sub);
}

function ensureDir(p) {
  const dir = String(p || '').trim();
  if (!dir) return '';
  const abs = resolve(dir);
  try {
    if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
  } catch (e) {
    // EPERM/EACCES 是「这个目录不让写」，不是「路径写错了」；分开说，用户才知道该改哪一个
    throw new Error('无法创建输出目录：' + abs + '（' + String((e && (e.code || e.message)) || e) + '）。'
      + '请换一个当前用户可以写入的目录，例如 ' + join(homedir(), 'Documents') + ' 下的子目录。');
  }
  return statSync(abs).isDirectory() ? abs : '';
}

// ---------- 子进程 + 行协议 ----------
function spawnLines(command, args, opts) {
  let child;
  try {
    child = spawn(command, args, { windowsHide: true, ...opts });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  const handle = { child, closed: false, exitCode: null };
  return { ok: true, handle };
}

function collectLines(handle, onLine) {
  return new Promise((resolvePromise) => {
    const { child } = handle;
    const r1 = createInterface({ input: child.stdout });
    const r2 = createInterface({ input: child.stderr });
    r1.on('line', line => onLine(String(line), 'stdout'));
    r2.on('line', line => onLine(String(line), 'stderr'));
    child.on('error', (e) => {
      if (handle.closed) return;
      handle.closed = true;
      resolvePromise({ ok: false, error: String((e && e.message) || e) });
    });
    child.on('close', (code, signal) => {
      if (handle.closed) return;
      handle.closed = true;
      handle.exitCode = code;
      resolvePromise({ ok: true, code, signal: signal || null });
    });
  });
}

// ---------- 任务表（前端按 1.5s 轮询同名 status） ----------
const tasks = new Map();

function newTask(key) {
  const t = {
    key,
    status: 'running',
    percent: 0,
    message: '',
    error: '',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    progress: [],
    result: null,
    handle: null,
    paused: false,
    stopRequested: false,
  };
  tasks.set(key, t);
  return t;
}

function pushProgress(task, entry) {
  if (!task || task.status !== 'running') return;
  if (task.paused && entry.kind !== 'stderr') return;
  task.progress.push({ at: new Date().toISOString(), ...entry });
  if (task.progress.length > 400) task.progress.splice(0, task.progress.length - 400);
}

function finishTask(task, status, payload) {
  if (!task || task.status !== 'running') return;
  task.status = status;
  task.percent = status === 'done' ? 100 : Math.max(0, Number(payload && payload.percent) || task.percent || 0);
  task.message = (payload && (payload.message || payload.reason)) || task.message;
  task.error = status === 'failed' ? String((payload && (payload.reason || payload.error)) || task.error || '任务失败') : '';
  task.result = payload || null;
  task.finishedAt = new Date().toISOString();
}

function taskView(task) {
  if (!task) return null;
  const { handle, ...rest } = task;
  return rest;
}

function stopTask(task) {
  if (!task || task.status !== 'running' || !task.handle) return false;
  task.stopRequested = true;
  try { task.handle.child.kill(); } catch (e) { /* 已退出 */ }
  return true;
}

// ---------- 浙江土地市场网：行政区 ----------
const ZJ_DISTRICT_URLS = [
  'https://www.zjzrzyjy.com/trade/uniportal/index/districtList',
  'https://www.zjzrzyjy.com/trade/uniread/index/districtList',
  'https://www.zjzrzyjy.com/trade/view/preApply/preAnnouncement/districtList',
];

const ZJ_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Referer': 'https://www.zjzrzyjy.com/landView/land-bidding',
};

function normalizeZjRegion(node, depth) {
  if (!node || typeof node !== 'object') return null;
  const code = String(node.districtCode || node.code || '').trim();
  const name = String(node.districtName || node.name || '').trim();
  if (!code || !name) return null;
  const kids = Array.isArray(node.children) ? node.children : [];
  return {
    code,
    name,
    children: depth >= 3 ? [] : kids.map(k => normalizeZjRegion(k, depth + 1)).filter(Boolean),
  };
}

let zjRegionCache = null;
let zjRegionCacheAt = 0;

async function loadZjRegions(force) {
  if (!force && zjRegionCache && Date.now() - zjRegionCacheAt < 30 * 60 * 1000) return zjRegionCache;
  const errors = [];
  for (const url of ZJ_DISTRICT_URLS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      let resp;
      try {
        resp = await fetch(url, { headers: ZJ_HEADERS, signal: ctrl.signal });
      } finally { clearTimeout(timer); }
      if (!resp.ok) { errors.push(url + ' → HTTP ' + resp.status); continue; }
      const ct = String(resp.headers.get('content-type') || '');
      const text = await resp.text();
      if (!/json/i.test(ct) && !text.trim().startsWith('{')) {
        errors.push(url + ' → 返回内容不是 JSON');
        continue;
      }
      let payload;
      try { payload = JSON.parse(text); } catch (e) { errors.push(url + ' → JSON 解析失败'); continue; }
      if (payload && payload.code !== undefined && Number(payload.code) !== 0) {
        errors.push(url + ' → 业务码 ' + payload.code + ' ' + (payload.message || ''));
        continue;
      }
      const list = Array.isArray(payload && payload.data) ? payload.data : [];
      const regions = list.map(n => normalizeZjRegion(n, 0)).filter(Boolean);
      if (!regions.length) { errors.push(url + ' → 行政区为空'); continue; }
      zjRegionCache = regions;
      zjRegionCacheAt = Date.now();
      return regions;
    } catch (e) {
      errors.push(url + ' → ' + String((e && e.message) || e));
    }
  }
  const err = new Error('浙江土地市场网行政区接口全部不可用：' + errors.join('；'));
  err.details = errors;
  throw err;
}

// ---------- 阿里拍卖/租赁用的全国行政区目录 ----------
let catalogCache = null;

function loadRegionCatalog() {
  if (catalogCache) return catalogCache;
  const root = toolboxRoot();
  const candidates = [
    root && join(root, 'extension', 'src', 'data', 'china-regions.js'),
    root && join(root, 'extension', 'data', 'china-regions.js'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const text = readFileSync(file, 'utf8');
      const start = text.indexOf('[');
      const end = text.lastIndexOf(']');
      if (start < 0 || end <= start) continue;
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed) && parsed.length) { catalogCache = parsed; return catalogCache; }
    } catch (e) { /* 换下一个候选 */ }
  }
  catalogCache = [];
  return catalogCache;
}

// ---------- 历史结果 ----------
function readHistoryFile(file) {
  const raw = readFileSync(file, 'utf8');
  const payload = JSON.parse(raw);
  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  const outputs = (payload && payload.outputs) || {};
  const dir = dirname(file);
  return {
    payload,
    recordCount: items.length,
    request: (payload && payload.request) || {},
    outputs,
    htmlPath: outputs.html ? join(dir, outputs.html) : '',
    mapPath: outputs.map ? join(dir, outputs.map) : '',
    excelPath: outputs.excel ? join(dir, outputs.excel) : '',
  };
}

function listHistory(dir) {
  const abs = String(dir || '').trim();
  if (!abs || !isAbsolute(abs) || !existsSync(abs) || !statSync(abs).isDirectory()) {
    return { ok: false, error: '历史目录无效或不存在：' + (abs || '(空)') };
  }
  const items = [];
  for (const name of readdirSync(abs)) {
    if (!/_history\.json$/i.test(name)) continue;
    const full = join(abs, name);
    let recordCount = 0;
    let label = name.replace(/_history\.json$/i, '');
    try {
      const info = readHistoryFile(full);
      recordCount = info.recordCount;
      const bucket = info.request && (info.request.county || info.request.district || info.request.location);
      if (bucket) label = label + ' · ' + bucket;
    } catch (e) { continue; }
    items.push({
      path: full,
      name,
      label,
      recordCount,
      modified: statSync(full).mtime.toISOString(),
    });
  }
  items.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
  return { ok: true, directory: abs, items };
}

// ---------- 土地抓取任务 ----------
const LAND_KEY = 'land';

function landRequestFromBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const outputDirectory = ensureDir(b.outputDirectory) || ensureDir(defaultOutputDir('浙江土地成交公示'));
  if (!outputDirectory) throw new Error('无法创建输出目录');
  const uses = Array.isArray(b.landUses) ? b.landUses.filter(x => typeof x === 'string') : [];
  const request = {
    district: String(b.district || ''),
    county: String(b.county || ''),
    location: String(b.location || ''),
    startDate: String(b.startDate || ''),
    endDate: String(b.endDate || ''),
    landUses: uses,
    generateMap: b.generateMap !== false,
    maxPages: Math.max(1, Math.min(200, Number(b.maxPages) || 200)),
    outputDirectory,
    provinceWide: b.provinceWide === undefined
      ? (!b.district && !b.county && !String(b.location || '').trim())
      : b.provinceWide === true,
  };
  if (b.historyPath) {
    request.historyPath = String(b.historyPath);
    request.historyRefresh = b.historyRefresh !== false;
  }
  return request;
}

function landRun(body) {
  const running = tasks.get(LAND_KEY);
  if (running && running.status === 'running') return { ok: false, error: '已有土地抓取任务在运行中' };
  const root = toolboxRoot();
  if (!root) return { ok: false, error: '未找到评估工具箱安装目录（%LOCALAPPDATA%\\AppraisalToolbox），浙江土地市场网抓取不可用' };
  const script = join(root, 'skills', 'zj-land-publicity', 'land_publicity_runner.py');
  if (!existsSync(script)) return { ok: false, error: '缺少抓取脚本：' + script };

  let request;
  try { request = landRequestFromBody(body); }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }

  const task = newTask(LAND_KEY);
  task.message = '正在启动抓取进程…';
  pushProgress(task, { kind: 'progress', message: '输出目录：' + request.outputDirectory });

  const started = spawnLines(pythonBin(), ['-X', 'utf8', '-u', script, '--request-json', JSON.stringify(request)], {
    cwd: dirname(script),
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      ...mapConfigEnv(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!started.ok) {
    finishTask(task, 'failed', { reason: '无法启动 Python：' + started.error });
    return { ok: false, error: started.error };
  }
  task.handle = started.handle;

  let finalPayload = null;
  collectLines(started.handle, (line, stream) => {
    const text = line.trim();
    if (stream === 'stderr') {
      if (text) pushProgress(task, { kind: 'stderr', text });
      return;
    }
    if (text.startsWith('TY_LAND_PROGRESS:')) {
      let p;
      try { p = JSON.parse(text.slice('TY_LAND_PROGRESS:'.length)); } catch (e) { return; }
      task.percent = Math.max(task.percent, Number(p.percent) || 0);
      if (p.message) task.message = String(p.message);
      pushProgress(task, {
        kind: 'progress',
        message: String(p.message || ''),
        fetched: p.fetched,
        written: p.written,
      });
      return;
    }
    if (text.startsWith('TY_LAND_RESULT:')) {
      try { finalPayload = JSON.parse(text.slice('TY_LAND_RESULT:'.length)); } catch (e) { finalPayload = { ok: false, reason: '抓取结果解析失败' }; }
      return;
    }
    if (text) pushProgress(task, { kind: 'progress', message: text });
  }).then((exit) => {
    task.handle = null;
    if (task.stopRequested) {
      finishTask(task, 'failed', { reason: '任务已被终止' });
      return;
    }
    if (!exit.ok) { finishTask(task, 'failed', { reason: '抓取进程异常：' + exit.error }); return; }
    if (!finalPayload) {
      finishTask(task, 'failed', { reason: exit.code === 0 ? '抓取进程未返回结果（TY_LAND_RESULT 缺失）' : '抓取进程失败，退出码 ' + exit.code });
      return;
    }
    const result = {
      excelPath: finalPayload.excelPath || '',
      htmlPath: finalPayload.htmlPath || '',
      mapPath: finalPayload.mapPath || '',
      coordsPath: finalPayload.coordsPath || '',
      historyPath: finalPayload.historyPath || '',
      outputDirectory: request.outputDirectory,
      results: Array.isArray(finalPayload.results) ? finalPayload.results : [],
      fetchedCount: finalPayload.fetchedCount,
      filteredCount: finalPayload.filteredCount,
      writtenCount: finalPayload.writtenCount,
      querySignature: finalPayload.querySignature,
      historyMode: finalPayload.historyMode,
    };
    if (finalPayload.ok) {
      finishTask(task, 'done', { percent: 100, message: '已写出 ' + (result.writtenCount || 0) + ' 条', result });
    } else {
      finishTask(task, 'failed', {
        percent: finalPayload.percent,
        reason: String(finalPayload.reason || finalPayload.errorCode || '抓取失败'),
        result,
      });
    }
  });

  return { ok: true, started: true, request };
}

// ---------- 通用 Python 单文件任务（表格/底稿工具） ----------
const BATCH_TOOLS = {
  'table-format': { script: ['table-format', 'scripts', 'format_word_tables.py'], suffix: '-表格设置', accept: ['.docx'] },
  'detail-print-format': { script: ['appraisal-detail-print-format', 'scripts', 'adjust_appraisal_detail_print.py'], suffix: '-打印版', accept: ['.xlsx', '.xlsm'] },
  'declaration-print-format': { script: ['appraisal-declaration-print-format', 'scripts', 'adjust_appraisal_declaration_print.py'], suffix: '-申报表', accept: ['.xlsx', '.xlsm'] },
  'link-restore': { script: ['asset-link-restore', 'scripts', 'restore_links.py'], suffix: '-链接恢复', accept: ['.xlsx'] },
};

function collectFiles(inputPaths, accepts) {
  const out = [];
  const walk = (p, depth) => {
    if (out.length >= 500 || depth > 6) return;
    let st;
    try { st = statSync(p); } catch (e) { return; }
    if (st.isDirectory()) {
      let names = [];
      try { names = readdirSync(p); } catch (e) { return; }
      names.sort();
      for (const name of names) walk(join(p, name), depth + 1);
      return;
    }
    if (!st.isFile()) return;
    if (accepts && accepts.length && !accepts.includes(extname(p).toLowerCase())) return;
    out.push(p);
  };
  for (const raw of inputPaths) {
    const p = String(raw || '').trim();
    if (!p || !isAbsolute(p)) continue;
    walk(p, 0);
  }
  return out;
}

function batchRun(toolId, body) {
  const spec = BATCH_TOOLS[toolId];
  if (!spec) return { ok: false, error: '未知工具：' + toolId };
  const running = tasks.get(toolId);
  if (running && running.status === 'running') return { ok: false, error: '该工具已有任务在运行' };

  const root = toolboxRoot();
  if (!root) return { ok: false, error: '未找到评估工具箱安装目录，批量工具不可用' };
  const script = join(root, 'skills', ...spec.script);
  if (!existsSync(script)) return { ok: false, error: '缺少脚本：' + script };

  const b = body && typeof body === 'object' ? body : {};
  const outputMode = ['overwrite', 'copy_in_source', 'new_directory'].includes(b.outputMode) ? b.outputMode : 'copy_in_source';
  const files = collectFiles(Array.isArray(b.inputPaths) ? b.inputPaths : [], spec.accept);
  if (!files.length) return { ok: false, error: '没有找到可处理的文件（请填写 .' + spec.accept.join('/.') + ' 路径）' };
  let outputDir = '';
  if (outputMode === 'new_directory') {
    outputDir = ensureDir(b.outputDirectory);
    if (!outputDir) return { ok: false, error: '输出方式为「指定目录」时必须填写一个已存在的目录' };
  }

  const task = newTask(toolId);
  task.total = files.length;
  task.message = '共 ' + files.length + ' 个文件';
  pushProgress(task, { kind: 'progress', message: '共 ' + files.length + ' 个文件，输出方式：' + outputMode });

  (async () => {
    const results = [];
    for (let i = 0; i < files.length; i += 1) {
      const source = files[i];
      if (task.stopRequested) break;
      const destDir = outputMode === 'new_directory' ? outputDir : dirname(source);
      const ext = extname(source);
      const stem = basename(source, ext);
      const target = outputMode === 'overwrite'
        ? source
        : join(destDir, stem + spec.suffix + ext);
      const staging = join(destDir, '.' + stem + '.dt-' + process.pid + '-' + i + ext);
      task.percent = Math.round((i / files.length) * 100);
      task.message = '正在处理 ' + basename(source);
      pushProgress(task, { kind: 'progress', message: '正在处理 ' + basename(source) });
      try {
        copyFileSync(source, staging);
        const args = toolId === 'link-restore'
          ? ['-X', 'utf8', '-u', script, staging]
          : ['-X', 'utf8', '-u', script, staging, '--no-backup'];
        const started = spawnLines(pythonBin(), args, {
          cwd: dirname(script),
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', ...mapConfigEnv() },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (!started.ok) throw new Error('无法启动 Python：' + started.error);
        const exit = await collectLines(started.handle, (line, stream) => {
          const text = line.trim();
          if (!text) return;
          let message = text;
          try {
            const parsed = JSON.parse(text);
            if (parsed && parsed.event === 'formatted') message = '已设置 ' + (parsed.tableCount || 0) + ' 个表格';
            else if (parsed && parsed.event === 'saved') message = '已保存 ' + (parsed.fileName || basename(target));
          } catch (e) { /* 原文 */ }
          pushProgress(task, { kind: stream === 'stderr' ? 'stderr' : 'progress', message, text: stream === 'stderr' ? text : undefined });
        });
        if (!exit.ok) throw new Error(exit.error);
        if (exit.code !== 0) throw new Error('脚本退出码 ' + exit.code);
        if (outputMode === 'overwrite') {
          rmSync(source, { force: true });
        }
        renameSync(staging, target);
        results.push({ ok: true, sourcePath: source, outputPath: target, outputMode });
        pushProgress(task, { kind: 'progress', message: '完成 ' + basename(target) });
      } catch (e) {
        try { rmSync(staging, { force: true }); } catch (_) { /* 已清理 */ }
        results.push({ ok: false, sourcePath: source, error: String((e && e.message) || e) });
        pushProgress(task, { kind: 'progress', message: '失败 ' + basename(source) + '：' + String((e && e.message) || e) });
      }
    }
    task.percent = 100;
    const failed = results.filter(r => !r.ok).length;
    finishTask(task, failed === results.length ? 'failed' : 'done', {
      percent: 100,
      message: '完成 ' + (results.length - failed) + ' 个，失败 ' + failed + ' 个',
      reason: failed === results.length ? '全部文件处理失败' : '',
      result: { results, total: results.length, failed },
    });
  })();

  return { ok: true, started: true, total: files.length };
}

// ---------- 折旧摊销与资本性支出预测 ----------
const DEP_KEY = 'dep';

function depScript() {
  const root = toolboxRoot();
  return root ? join(root, 'skills', 'depreciation-capex-forecast', 'scripts', 'workflow.py') : '';
}

function depRun(kind, body) {
  const running = tasks.get(DEP_KEY);
  if (running && running.status === 'running') return { ok: false, error: '已有折旧任务在运行' };
  const script = depScript();
  if (!script || !existsSync(script)) return { ok: false, error: '缺少折旧摊销预测脚本（需要评估工具箱）' };
  const b = body && typeof body === 'object' ? body : {};
  const map = {
    prepare: ['prepare'],
    preflight: ['preflight', '--input', String(b.input || '')],
    run: ['run', '--input', String(b.input || '')],
  };
  let args = map[kind];
  if (!args) return { ok: false, error: '不支持的操作：' + kind };
  if (kind === 'prepare' && b.output) args = ['prepare', '--output', String(b.output)];
  if (kind === 'run' && b.withDetails) args = [...args, '--with-details'];
  if (kind !== 'prepare' && !b.input) return { ok: false, error: '请先填写工作簿路径' };

  const task = newTask(DEP_KEY);
  task.message = '正在执行 ' + kind;
  const started = spawnLines(pythonBin(), ['-X', 'utf8', '-u', script, ...args], {
    cwd: dirname(script),
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!started.ok) { finishTask(task, 'failed', { reason: started.error }); return { ok: false, error: started.error }; }
  task.handle = started.handle;
  let stdout = '';
  collectLines(started.handle, (line, stream) => {
    const text = line.trim();
    if (!text) return;
    if (stream === 'stdout') stdout += text + '\n';
    pushProgress(task, { kind: stream === 'stderr' ? 'stderr' : 'progress', message: text, text: stream === 'stderr' ? text : undefined });
  }).then((exit) => {
    task.handle = null;
    if (task.stopRequested) { finishTask(task, 'failed', { reason: '任务已被终止' }); return; }
    if (!exit.ok || exit.code !== 0) {
      finishTask(task, 'failed', { reason: '折旧任务失败（退出码 ' + (exit.code === undefined ? '?' : exit.code) + '）' });
      return;
    }
    let payload = null;
    for (const line of stdout.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try { payload = JSON.parse(t); } catch (e) { /* 非 JSON 行 */ }
    }
    finishTask(task, 'done', { percent: 100, message: '折旧任务完成', result: payload || { stdout } });
  });
  return { ok: true, started: true };
}

// ---------- 依赖浏览器驱动的数据源 ----------
const BROWSER_DEPS = {
  anjuke: { name: '安居客案例采集', need: 'playwright（Python 浏览器驱动）' },
  auction: { name: '阿里司法拍卖', need: 'opencli 浏览器命令行' },
  lease: { name: '阿里资产租赁', need: 'opencli 浏览器命令行' },
};

function browserDependencyError(mod) {
  const spec = BROWSER_DEPS[mod] || { name: mod, need: '浏览器驱动' };
  return {
    ok: false,
    code: 'DT_BROWSER_DRIVER_MISSING',
    error: spec.name + ' 需要 ' + spec.need + '，本机尚未安装，该数据源暂时不可用。'
      + '浙江土地市场网、运行历史、表格与底稿工具、折旧摊销预测不受影响。',
  };
}

function safeOpenPath(rawPath, reveal) {
  const p = String(rawPath || '').trim();
  if (!p || !isAbsolute(p)) return { ok: false, error: '路径无效（必须为绝对路径）' };
  if (!existsSync(p)) return { ok: false, error: '文件或目录不存在：' + p };
  return openShell(p, !!reveal).then(r => ({ ...(r || {}), path: p }));
}

const OPEN_URL_HOSTS = new Set([
  'www.zjzrzyjy.com', 'zjzrzyjy.com',
  'sf.taobao.com', 'zc-paimai.taobao.com', 'zc-item.taobao.com', 'www.taobao.com', 'paimai.taobao.com',
  'www.anjuke.com', 'anjuke.com', 'sh.anjuke.com', 'hz.anjuke.com',
]);

function openExternal(url) {
  let u;
  try { u = new URL(String(url || '')); } catch (e) { return Promise.resolve({ ok: false, error: '地址格式不正确' }); }
  if (u.protocol !== 'https:') return Promise.resolve({ ok: false, error: '只允许打开 https 地址' });
  if (!OPEN_URL_HOSTS.has(u.hostname)) {
    return Promise.resolve({ ok: false, error: '不在允许打开的域名白名单内：' + u.hostname });
  }
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', u.href] : [u.href];
  return new Promise((resolvePromise) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', () => resolvePromise({ ok: false, error: '无法打开系统浏览器' }));
      child.once('spawn', () => { try { child.unref(); } catch (e) { /* 已退出 */ } resolvePromise({ ok: true, url: u.href }); });
    } catch (e) {
      resolvePromise({ ok: false, error: '无法打开系统浏览器' });
    }
  });
}

function sourceUrlFor(mod, request) {
  const r = request && typeof request === 'object' ? request : {};
  const enc = (v) => encodeURIComponent(String(v == null ? '' : v));
  if (mod === 'auction') {
    const base = r.entry === 'zc' ? 'https://zc-paimai.taobao.com/list/' : 'https://sf.taobao.com/item_list.htm';
    const q = [];
    q.push('category=' + enc(r.propertyType === 'commercial' ? '50025969' : '50025968'));
    if (r.city) q.push('city=' + enc(r.city));
    if (r.keyword) q.push('q=' + enc(r.keyword));
    return { ok: true, url: base + '?' + q.join('&') };
  }
  if (mod === 'lease') {
    const q = [];
    if (r.city) q.push('city=' + enc(r.city));
    if (r.keyword) q.push('q=' + enc(r.keyword));
    return { ok: true, url: 'https://zc-paimai.taobao.com/list/?' + q.join('&') };
  }
  if (mod === 'land') return { ok: true, url: 'https://www.zjzrzyjy.com/landView/land-bidding' };
  return { ok: false, error: '不支持的来源模块：' + mod };
}

// ---------- 路由表 ----------
export function dataToolsRoutes(PREFIX) {
  const base = (PREFIX || '/api/workbench') + '/dt';
  const readJson = async (req) => {
    try { return (await req.json()) || {}; } catch (e) { return {}; }
  };

  return [
    {
      // 前端首次进入「数据工具」时取一次，用于拍卖/租赁的省市县三级联动
      path: base + '/regions', methods: ['GET', 'HEAD'], fetch: async () => {
        try {
          const catalog = loadRegionCatalog();
          if (!catalog.length) return json({ ok: false, catalog: [], error: '未找到全国行政区目录（需要评估工具箱的 china-regions 数据）' });
          return json({ ok: true, rev: DT_REV, catalog });
        } catch (e) { return fail(String((e && e.message) || e)); }
      },
    },

    {
      // 浙江土地市场网行政区：直接问官网，不做本地硬编码
      path: base + '/land/regions', methods: ['GET', 'HEAD'], fetch: async (req) => {
        try {
          const u = new URL(req.url, 'http://127.0.0.1');
          const regions = await loadZjRegions(u.searchParams.get('refresh') === '1');
          return json({ ok: true, regions, rev: DT_REV });
        } catch (e) {
          return fail(String((e && e.message) || e), { regions: [] });
        }
      },
    },

    {
      path: base + '/land/run', methods: ['POST'], fetch: async (req) => {
        try {
          const body = await readJson(req);
          const r = landRun(body);
          return r.ok ? json(r) : json(r, 400);
        } catch (e) { return fail(String((e && e.message) || e)); }
      },
    },
    {
      path: base + '/land/status', methods: ['GET', 'HEAD'], fetch: async () => json({ ok: true, task: taskView(tasks.get(LAND_KEY) || null) }),
    },
    {
      path: base + '/land/stop', methods: ['POST'], fetch: async () => {
        const ok = stopTask(tasks.get(LAND_KEY));
        return json({ ok: true, stopped: ok });
      },
    },
    {
      // runner 是单次同步请求，没有暂停点；不要假装暂停，直接说清楚
      path: base + '/land/pause', methods: ['POST'], fetch: async () => {
        const t = tasks.get(LAND_KEY);
        if (!t || t.status !== 'running') return json({ ok: false, error: '当前没有运行中的土地抓取任务' }, 400);
        return json({ ok: false, error: '土地抓取是一次连续请求，不支持暂停；可以点「终止任务」结束本次抓取' }, 400);
      },
    },
    {
      path: base + '/land/resume', methods: ['POST'], fetch: async () => {
        const t = tasks.get(LAND_KEY);
        if (!t || t.status !== 'running') return json({ ok: false, error: '当前没有运行中的土地抓取任务' }, 400);
        return json({ ok: true, resumed: true, message: '任务一直在运行，无需恢复' });
      },
    },

    {
      path: base + '/history/list', methods: ['POST'], fetch: async (req) => {
        try {
          const body = await readJson(req);
          const r = listHistory(body.directory);
          return json(r, r.ok ? 200 : 400);
        } catch (e) { return fail(String((e && e.message) || e)); }
      },
    },
    {
      path: base + '/history/load', methods: ['POST'], fetch: async (req) => {
        try {
          const body = await readJson(req);
          const p = String(body.path || '').trim();
          if (!p || !isAbsolute(p) || !existsSync(p)) return json({ ok: false, error: '历史文件不存在：' + (p || '(空)') }, 400);
          const info = readHistoryFile(p);
          const results = (info.payload.items || []).map((it, index) => {
            const rec = it && typeof it === 'object' ? it : {};
            return {
              index: index + 1,
              location: rec.location || (rec.record && rec.record.content) || '',
              landUse: rec.land_use || '',
              areaSqm: rec.area_sqm,
              areaMu: rec.area_mu,
              dealPrice: rec.deal_price,
              dealTotalPrice: rec.deal_total_price,
              startPrice: rec.start_price,
              startTotalPrice: rec.start_total_price,
              transferee: rec.transferee || '',
              releaseTime: (rec.record && rec.record.releaseTime) || '',
              detailUrl: rec.detail_url || '',
            };
          });
          return json({
            ok: true,
            path: p,
            recordCount: info.recordCount,
            results,
            request: info.request,
            outputs: info.outputs,
            htmlPath: info.htmlPath,
            mapPath: info.mapPath,
            excelPath: info.excelPath,
            generatedAt: (info.payload && info.payload.generatedAt) || '',
            sourceMode: (info.payload && info.payload.sourceMode) || '',
          });
        } catch (e) { return fail(String((e && e.message) || e)); }
      },
    },

    {
      path: base + '/open', methods: ['POST'], fetch: async (req) => {
        try {
          const body = await readJson(req);
          const r = await safeOpenPath(body.path, body.reveal);
          return json(r, r.ok ? 200 : 400);
        } catch (e) { return fail(String((e && e.message) || e)); }
      },
    },
    {
      path: base + '/open-url', methods: ['POST'], fetch: async (req) => {
        try {
          const body = await readJson(req);
          const r = await openExternal(body.url);
          return json(r, r.ok ? 200 : 400);
        } catch (e) { return fail(String((e && e.message) || e)); }
      },
    },
    {
      path: base + '/source-url', methods: ['POST'], fetch: async (req) => {
        try {
          const body = await readJson(req);
          const r = sourceUrlFor(String(body.mod || ''), body.request);
          return json(r, r.ok ? 200 : 400);
        } catch (e) { return fail(String((e && e.message) || e)); }
      },
    },
    {
      path: base + '/current-url', methods: ['POST'], fetch: async () => json({
        ok: false,
        error: '宿主进程无法读取浏览器当前地址；请在浏览器里直接复制链接，或使用「打开来源页」。',
      }, 400),
    },

    {
      // GET 与 POST 必须写在同一条路由里：index.js 的路由注册循环按「路径」去重
      // （if (owners.has(r.path)) continue），拆成两条的话后一条会被整条跳过，
      // POST 就落到 connection.fetch 的兜底 404 —— 早期「保存失败：HTTP 404」就是这么来的。
      path: base + '/map-config', methods: ['GET', 'HEAD', 'POST'], fetch: async (req) => {
        if (!req || req.method === 'GET' || req.method === 'HEAD') return json(mapConfigSummary());
        try {
          const body = await readJson(req);
          const file = mapConfigPath();
          const stored = readMapConfig();
          if (body.clear === true) {
            // 「恢复默认底图」只清高德那一段。整份删文件会把同一文件里的百度配置一起抹掉，
            // 用户点高德的按钮却丢了百度的 Key，属于不可接受的副作用。
            const keepBaidu = stored.baidu && typeof stored.baidu === 'object' ? stored.baidu : null;
            const emptied = {
              version: 2,
              updatedAt: new Date().toISOString(),
              amap: { enabled: false, webKey: '', securityJsCode: '' },
              ...(keepBaidu ? { baidu: keepBaidu } : {}),
            };
            mkdirSync(dirname(file), { recursive: true });
            const tmp0 = file + '.' + process.pid + '.tmp';
            writeFileSync(tmp0, JSON.stringify(emptied, null, 2) + '\n', 'utf8');
            renameSync(tmp0, file);
            return json(mapConfigSummary({ ok: true, cleared: true }));
          }
          const prevAmap = stored.amap && typeof stored.amap === 'object' ? stored.amap : {};
          const prevBaidu = stored.baidu && typeof stored.baidu === 'object' ? stored.baidu : {};
          const segAmap = body.amap && typeof body.amap === 'object' ? body.amap : null;
          const segBaidu = body.baidu && typeof body.baidu === 'object' ? body.baidu : null;
          if (!segAmap && !segBaidu) return json({ ok: false, error: '没有要保存的配置段（amap / baidu）' }, 400);

          // 两块分别保存：只覆盖本次提交的那一段，另一段原样保留（前端两个区块分开用，
          // 保存百度不能把高德清掉，反之亦然）。
          let nextAmap = prevAmap;
          if (segAmap) {
            const enabled = segAmap.enabled === true;
            const preserve = segAmap.preserveExisting === true;
            const webKey = String(segAmap.webKey || (preserve ? prevAmap.webKey : '')).trim().slice(0, 256);
            // 与 webKey 同一口径：留空 + preserveExisting 表示「沿用原值」，
            // 只有明确传了非空值才覆盖（否则用户只是想改 Key 却把安全密钥清掉了）。
            const securityInput = String(segAmap.securityJsCode || '').trim().slice(0, 128);
            const securityJsCode = securityInput || (preserve ? String(prevAmap.securityJsCode || '') : '');
            if (enabled && !webKey) return json({ ok: false, error: '启用官方高德底图时必须填写 Key' }, 400);
            nextAmap = { enabled, webKey, securityJsCode };
          }
          let nextBaidu = prevBaidu;
          if (segBaidu) {
            const enabled = segBaidu.enabled === true;
            const preserve = segBaidu.preserveExisting === true;
            const webApiAk = String(segBaidu.webApiAk || (preserve ? prevBaidu.webApiAk : '')).trim().slice(0, 256);
            const agentPlanSk = String(segBaidu.agentPlanSk || (preserve ? prevBaidu.agentPlanSk : '')).trim().slice(0, 512);
            if (enabled && !webApiAk && !agentPlanSk) {
              return json({ ok: false, error: '启用百度地图时至少要填一个凭证：Web 服务 AK（BMAP_WEBAPI_AK）或 Agent Plan SK（BAIDU_MAP_AUTH_TOKEN）' }, 400);
            }
            nextBaidu = { enabled, webApiAk, agentPlanSk };
          }
          const payload = {
            version: 2,
            updatedAt: new Date().toISOString(),
            amap: nextAmap,
            baidu: nextBaidu,
          };
          mkdirSync(dirname(file), { recursive: true });
          const tmp = file + '.' + process.pid + '.tmp';
          writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
          renameSync(tmp, file);
          return json(mapConfigSummary({ ok: true }));
        } catch (e) { return fail(String((e && e.message) || e)); }
      },
    },

    // 批量表格 / 底稿工具（table-format / detail-print-format / declaration-print-format / link-restore）
    ...Object.keys(BATCH_TOOLS).flatMap((toolId) => ([
      {
        path: base + '/' + toolId + '/run', methods: ['POST'], fetch: async (req) => {
          try {
            const body = await readJson(req);
            const r = batchRun(toolId, body);
            return json(r, r.ok ? 200 : 400);
          } catch (e) { return fail(String((e && e.message) || e)); }
        },
      },
      {
        path: base + '/' + toolId + '/status', methods: ['GET', 'HEAD'], fetch: async () => json({ ok: true, task: taskView(tasks.get(toolId) || null) }),
      },
      {
        path: base + '/' + toolId + '/stop', methods: ['POST'], fetch: async () => json({ ok: true, stopped: stopTask(tasks.get(toolId)) }),
      },
    ])),

    // 折旧摊销与资本性支出预测
    {
      path: base + '/dep/status', methods: ['GET', 'HEAD'], fetch: async () => json({ ok: true, task: taskView(tasks.get(DEP_KEY) || null) }),
    },
    {
      path: base + '/dep/read', methods: ['POST'], fetch: async (req) => {
        try {
          const body = await readJson(req);
          const script = depScript();
          if (!script || !existsSync(script)) return json({ ok: false, error: '缺少折旧摊销预测脚本' }, 400);
          const input = String(body.input || '');
          if (!input) return json({ ok: false, error: '请先填写工作簿路径' }, 400);
          const sub = String(body.sub || 'status');
          const args = sub === 'status'
            ? ['-X', 'utf8', '-u', script, 'status', '--input', input]
            : ['-X', 'utf8', '-u', script, 'read', '--input', input, '--sheet', sub === 'read' ? 'summary' : sub];
          const started = spawnLines(pythonBin(), args, {
            cwd: dirname(script),
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          if (!started.ok) return json({ ok: false, error: started.error }, 500);
          let out = '';
          const exit = await collectLines(started.handle, (line) => { out += line + '\n'; });
          if (!exit.ok || exit.code !== 0) return json({ ok: false, error: (out || '读取失败').slice(0, 2000) }, 400);
          const trimmed = out.trim();
          if (trimmed.startsWith('{')) {
            try { return json(JSON.parse(trimmed)); } catch (e) { /* 落回文本 */ }
          }
          return json({ ok: true, output: trimmed });
        } catch (e) { return fail(String((e && e.message) || e)); }
      },
    },
    {
      path: base + '/dep/prepare', methods: ['POST'], fetch: async (req) => { const b = await readJson(req); const r = depRun('prepare', b); return json(r, r.ok ? 200 : 400); },
    },
    {
      path: base + '/dep/preflight', methods: ['POST'], fetch: async (req) => { const b = await readJson(req); const r = depRun('preflight', b); return json(r, r.ok ? 200 : 400); },
    },
    {
      path: base + '/dep/run', methods: ['POST'], fetch: async (req) => { const b = await readJson(req); const r = depRun('run', b); return json(r, r.ok ? 200 : 400); },
    },
    {
      path: base + '/dep/stop', methods: ['POST'], fetch: async () => json({ ok: true, stopped: stopTask(tasks.get(DEP_KEY)) }),
    },

    // 依赖浏览器驱动的数据源：如实说明缺什么，而不是 404
    ...['anjuke', 'auction', 'lease'].flatMap((mod) => ([
      {
        path: base + '/' + mod + '/run', methods: ['POST'], fetch: async () => json(browserDependencyError(mod), 503),
      },
      {
        path: base + '/' + mod + '/status', methods: ['GET', 'HEAD'], fetch: async () => json({ ok: true, task: null, note: '该数据源依赖未安装，未启动任务' }),
      },
      {
        path: base + '/' + mod + '/stop', methods: ['POST'], fetch: async () => json({ ok: true, stopped: false }),
      },
      {
        path: base + '/' + mod + '/pause', methods: ['POST'], fetch: async () => json({ ok: false, error: '当前没有可暂停的任务' }, 400),
      },
      {
        path: base + '/' + mod + '/resume', methods: ['POST'], fetch: async () => json({ ok: false, error: '当前没有可恢复的任务' }, 400),
      },
      {
        // 前端有「重新导出 Excel」按钮；没有抓取结果时如实说清楚，不要回纯文本
        path: base + '/' + mod + '/export-excel', methods: ['POST'], fetch: async () => json({
          ok: false,
          code: 'DT_NO_RESULT_TO_EXPORT',
          error: '当前没有可导出的抓取结果。' + (BROWSER_DEPS[mod] ? BROWSER_DEPS[mod].name + '需要 ' + BROWSER_DEPS[mod].need + '，本机尚未安装。' : ''),
        }, 400),
      },
    ])),
  ];
}

export const DATA_TOOLS_REV = DT_REV;
