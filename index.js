import { Buffer } from 'node:buffer';
import { readFile, mkdir, mkdtemp, writeFile, rm, readdir, copyFile, rename, realpath, stat, link } from 'node:fs/promises';
import { writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join, sep, dirname, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openShell } from './opener.js';
// 这里的内部 import 一律不带查询串：宿主插件模块一旦被 Cordis 求值就缓存，
// 给其中一个加 ?v= 只会让 library.js 出现两份实例（scanner/kbqa 走的是另一份），
// refresh() 清不到同一份缓存。宿主半侧改完请重启 DSH，见 README「已知限制」。
import * as ty from './tianyuan.js';
import * as tyWeb from './tianyuan-web.js';
import * as tySession from './tianyuan-session.js';
// 报告导出只走 opencli（用户真实浏览器）一条通道。
// 报告导出与同步填表都只走 opencli（用户真实浏览器）一条通道；
// ego 独立窗口引擎（原 report-ego.js）已于 2026-11-23 完整移除。
import * as rb from './report-browser.js';
import { createCliAuth } from './cli-auth.js';
import { runManualWorkflow } from './export-workflow.js';
const cliAuth = createCliAuth();
import * as lib from './library.js';
import * as kbqa from './kbqa.js';
import * as scanner from './scanner.js';
import * as store from './store.js';
import { planProjectFolders } from './folders.js';
import { folderTemplateRequest, readFolderTemplate, folderTemplatePlan } from './folder-template.js';
import * as archive from './archive.js';
import { archiveReportBaseline } from './report-baseline.js';
import { listBaselines, compareUpload, compareAgainstLive, readManifestForWriteback } from './report-compare-service.js';
import { applyWriteback, readContents } from './report-writeback.js';
import { collectContentItemIds, FULL_CONTENT_CHUNK, MAX_FULL_ITEMS } from './report-online-full.js';
import { buildOnlineSnapshot } from './report-online-snapshot.js';
import { buildData as tySyncData, runSync as tySyncRun, resolveOpencliRoot, openSyncSpace } from './tysync.js';

const name = 'workbench';
const inject = ['connection'];
// llm / agentDefaultModel 用可选方式取（ctx.get），不作为硬依赖，缺了就降级为纯检索摘要
const optional = ['llm', 'agentDefaultModel'];
const PREFIX = '/api/workbench';
// 只允许额外打开本宿主进程本次实际创建的输出批次，不开放任意路径。
const exportBatchDirs = new Set();
function rememberExportBatch(dir) {
  exportBatchDirs.add(dir);
  if (exportBatchDirs.size > 100) exportBatchDirs.delete(exportBatchDirs.values().next().value);
}
// 导出进度快照：前端用随机 jobId 轮询，任务结束即删除。
const exportProgress = new Map();

// 「不导出基线」那条路的现场凭据。
//
// 比对时宿主当场抓了线上节点树，算出 astSha256；写回时必须拿同一个哈希核对并发。
// 这个哈希绝不能由前端保管——前端传什么就等于让前端决定"线上没变过"。
// 所以比对成功后在宿主内存里存一份，只把随机 token 发给前端，写回时凭 token 取回。
// 15 分钟过期、最多留 20 条；过期后要么重新比对，要么走归档基线那条路。
const liveCompareTokens = new Map();
const LIVE_TOKEN_TTL_MS = 15 * 60 * 1000;
const LIVE_TOKEN_MAX = 20;
function putLiveToken(entry) {
  if (liveCompareTokens.size >= LIVE_TOKEN_MAX) {
    let oldestKey = null; let oldestAt = Infinity;
    for (const [k, v] of liveCompareTokens) if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
    if (oldestKey) liveCompareTokens.delete(oldestKey);
  }
  const token = randomUUID();
  liveCompareTokens.set(token, { at: Date.now(), ...entry });
  return token;
}
function takeLiveToken(token, projectId) {
  const key = String(token || '');
  if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error('比对凭据无效，请重新比对');
  const entry = liveCompareTokens.get(key);
  if (!entry) throw new Error('比对凭据已失效，请重新比对一次');
  if (Date.now() - entry.at > LIVE_TOKEN_TTL_MS) { liveCompareTokens.delete(key); throw new Error('比对凭据已过期（15 分钟），请重新比对一次'); }
  // 凭据绑定项目：A 项目的凭据不能拿去写 B 项目。
  if (String(entry.projectId) !== String(projectId)) throw new Error('比对凭据与项目不匹配');
  return entry;
}

// 用系统默认浏览器打开授权页。渲染进程里 window.open 会被 Electron 主窗口的
// window-open 策略 deny（只对 https 调 shell.openExternal 且不返回窗口），
// 右侧栏 openTab 又要求已挂载的对话会话——工作台占满主区时并不满足。
// 因此把「打开外部页面」交给宿主进程执行，这是唯一稳定可用的通道。
// 仅允许天源授权相关域名，避免变成任意命令执行入口。
const OPEN_ALLOW = ['mcp.zhrdc.net', 'auth.zhrdc.net', 'excel.zhrdc.net', 'ty.zhrdc.net'];

function openInSystemBrowser(target) {
  let u;
  try { u = new URL(String(target || '')); } catch (e) { return { ok: false, error: '链接格式不正确' }; }
  if (u.protocol !== 'https:') return { ok: false, error: '只允许 https 链接' };
  if (!OPEN_ALLOW.includes(u.hostname)) return { ok: false, error: '不允许打开该域名：' + u.hostname };
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', u.href] : [u.href];
  return new Promise(resolve => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', () => resolve({ ok: false, error: '无法打开系统浏览器' }));
      child.once('spawn', () => { child.unref(); resolve({ ok: true }); });
    } catch (_) { resolve({ ok: false, error: '无法打开系统浏览器' }); }
  });
}

function json(data, status) {
  const body = JSON.stringify(data);
  return new Response(body, { status: status || 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': String(Buffer.byteLength(body)) } });
}

// ---------- 项目文件夹 / 上传的文件名 ----------
// 名称由浏览器半侧算好（<项目编号> <项目简称>），宿主只做「不许越界」的清洗：
// 去掉 Windows 非法字符、不许 . / ..、不许绝对路径与盘符，避免拼出库外的路径。
const MAX_UPLOAD = 200 * 1024 * 1024;      // 单个扫描件 200 MB 上限
const BAD_SEGMENT = /[<>:"/\\|?*\x00-\x1f]/g;
function cleanSegment(s, max) {
  return String(s == null ? '' : s)
    .replace(BAD_SEGMENT, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, max || 120);
}
function safeFolderName(s) {
  const raw = String(s == null ? '' : s).trim();
  // 文件夹名就是一层目录：带分隔符、或本身就是 . / .. 的，直接拒绝而不是悄悄改名
  if (!raw || raw === '.' || raw === '..' || /[\\/]/.test(raw)) return '';
  const n = cleanSegment(raw, 160);
  return (n && n !== '.' && n !== '..') ? n : '';
}
function safeSubParts(s) {
  const raw = String(s == null ? '' : s).split(/[\\/]+/).filter(x => x !== '');
  if (!raw.length) return null;
  if (raw.some(p => p === '.' || p === '..')) return null;
  const parts = raw.map(x => cleanSegment(x, 80)).filter(Boolean);
  return parts.length ? parts : null;
}
function safeFileSegment(s) {
  // Windows 上文件名末尾的点和空格会被吞掉，保存前先去掉
  const n = cleanSegment(s, 160).replace(/[.\s]+$/, '');
  return (n && n !== '.' && n !== '..') ? n : '';
}

// ---------- 企业信息补全（企查查·企业工商 MCP） ----------
// 浏览器半侧填公司名称时问这里；宿主已连上 dsh-mcp-connector 的「企查查·企业工商」
// （serverName=qcc-company），工具注册名是 mcp__qcc-company__*。这里只读不写、只查工商登记信息。
// 工具结果的结构各版本不完全一样（content / result / output / value 都可能挂），
// 这里按「先找正文、再找包装、最后兜底」的顺序取文本，取不到就把原始结构带进报错，方便定位。
function collectStrings(node, out, depth) {
  if (node == null || depth > 4 || out.length > 40) return;
  if (typeof node === 'string') { if (node.trim()) out.push(node); return; }
  if (Array.isArray(node)) { node.forEach(x => collectStrings(x, out, depth + 1)); return; }
  if (typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (['callId', 'rootCallId', 'id', 'name', 'schema', 'arguments', 'type', 'token', 'parent'].includes(k)) continue;
    collectStrings(v, out, depth + 1);
  }
}

function hostToolText(res) {
  const first = Array.isArray(res) ? res[0] : (res && Array.isArray(res.results) ? res.results[0] : res);
  const shape = (() => { try { return JSON.stringify(first == null ? res : first).slice(0, 240); } catch (e) { return String(first); } })();
  if (!first || typeof first !== 'object') throw new Error('工具没有返回结果：' + shape);

  // dsh-tools 的批量结果是 { callId, result: <ToolExecutionResult> }，正文在 result 里；
  // 也兼容直接把结果当元素的形态。
  const body = (first.result && typeof first.result === 'object') ? first.result : first;

  const texts = [];
  collectStrings(body.content, texts, 0);
  if (!texts.length) {
    for (const k of ['output', 'value', 'data', 'text', 'result']) {
      if (body[k] != null) collectStrings(body[k], texts, 0);
    }
  }
  const text = texts.join('\n').trim();
  const failed = body.isError === true || (!body.content && !texts.length && body.error);
  if (failed) throw new Error(text || ((body.error && body.error.message) || '工具调用失败') + '：' + shape);
  if (text) return text;
  throw new Error('工具返回空结果：' + shape);
}

async function callHostTool(ctx, tool, args, timeoutMs) {
  const tools = ctx && typeof ctx.get === 'function' ? ctx.get('tools') : null;
  if (!tools || typeof tools.execute !== 'function') throw new Error('宿主没有可用的 tools 服务');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
  try {
    const res = await tools.execute({
      calls: [{
        type: 'tool-call',
        id: 'wb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        name: tool,
        arguments: JSON.stringify(args || {}),
      }],
      signal: ctrl.signal,
    });
    return hostToolText(res);
  } finally { clearTimeout(timer); }
}

function parseFirstJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const at = raw.search(/[\[{]/);
  if (at < 0) return null;
  try { return JSON.parse(raw.slice(at)); } catch (e) { return null; }
}

function mapQccCompany(d, fallbackName) {
  const pick = (...keys) => {
    for (const k of keys) {
      const v = d && d[k];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  };
  return {
    name: pick('企业名称', 'name') || String(fallbackName || ''),
    shortName: pick('企业简称', '简称'),
    creditCode: pick('统一社会信用代码'),
    entType: pick('企业类型'),
    address: pick('注册地址', '企业地址', '地址'),
    capital: pick('注册资本'),
    legalRep: pick('法定代表人'),
    business: pick('经营范围'),
    source: 'qcc',
  };
}

// ---------- 委托人简称：按名称生成（优先大模型，失败退回规则） ----------
const SHORTNAME_SYSTEM = [
  '你是资产评估机构的企业信息助理。用户给一个企业全称，你要给出这家企业常用的简称。',
  '规则：去掉行政区划（省/市/县/区）、去掉「集团/股份/有限/责任/公司」等组织形式后缀；',
  '保留最能识别这家企业的字号与主业词，一般 2-10 个汉字；不要引号、不要解释、不要标点。',
  '只输出简称本身，一行。',
].join('');

function ruleShortName(name) {
  let s = String(name || '').trim().replace(/\s+/g, '');
  s = s.replace(/[（(][^）)]*[）)]/g, '');
  // 去掉开头的行政区划：XX省 / XX市 / XX自治区 ...
  for (let i = 0; i < 2; i += 1) {
    const next = s.replace(/^[\u4e00-\u9fa5]{2,8}?(省|市|自治区|自治州|地区|盟)/, '');
    if (next && next !== s) s = next; else break;
  }
  // 去掉组织形式后缀（从长到短）
  const tails = ['股份有限公司', '有限责任公司', '集团有限公司', '集团股份有限公司', '有限公司', '分公司', '集团', '公司', '合伙企业', '个人独资企业', '事务所'];
  for (const t of tails) {
    if (s.length > t.length + 1 && s.endsWith(t)) { s = s.slice(0, -t.length); break; }
  }
  s = s.replace(/[\s·・,，.。]+$/g, '');
  return s.slice(0, 12);
}

function defaultModelSelection(ctx) {
  try {
    const svc = safeService(ctx, 'agentDefaultModel');
    if (svc && typeof svc.currentSelection === 'function') {
      const s = svc.currentSelection();
      if (s && s.provider && s.model) return s;
    }
  } catch (e) { /* 没有默认模型就走规则 */ }
  return null;
}

// 选一个可用的模型：优先 DSH 的默认模型；没配就从 llm 已注册的 provider 里挑第一个能用的模型。
// （桌面端有时把模型放在会话/预设里，agentDefaultModel 是空的，这时不能直接判「没有模型」。）
async function resolveModel(ctx) {
  const sel = defaultModelSelection(ctx);
  if (sel && sel.provider && sel.model) return sel;
  const llm = readLlm(ctx);
  if (!llm || typeof llm.listProviders !== 'function') return null;
  let providers = [];
  try { providers = await llm.listProviders(); } catch (e) { return null; }
  for (const p of providers || []) {
    const id = p && (p.id || p.provider);
    if (!id) continue;
    try {
      const models = typeof llm.listModels === 'function' ? await llm.listModels(id) : [];
      const first = (models || [])[0];
      if (first && first.id) return { provider: id, model: first.id };
    } catch (e) { /* 换下一个 provider */ }
  }
  return null;
}

// 可选模型清单（问答下拉 / 合同解析下拉共用）
async function listModelChoices(ctx) {
  const llm = readLlm(ctx);
  let current = defaultModelSelection(ctx);
  if (!llm || typeof llm.listProviders !== 'function') {
    return { ok: false, providers: [], current: null,
      error: '没有可用的 llm 服务' + await modelDiagnostics(ctx) };
  }
  const providers = [];
  let all = [];
  try { all = (await llm.listProviders()) || []; } catch (e) { all = []; }
  for (const p of all) {
    const id = p && (p.id || p.provider);
    if (!id) continue;
    let models = [];
    try { models = (await llm.listModels(id)) || []; } catch (e) { models = []; }
    providers.push({
      id,
      name: (p && p.name) || id,
      models: models.map(m => ({ id: m && m.id, name: (m && m.name) || (m && m.id) })).filter(m => m.id),
    });
  }
  if (!current) {
    // 默认模型没配时，下拉里也要能选到东西：退回第一个可用模型
    const first = providers.find(p => p.models.length);
    if (first) current = { provider: first.id, model: first.models[0].id };
  }
  return { ok: true, providers, current: current && current.provider ? current : null };
}

// 出错时把「到底缺什么」写进消息，省得来回猜
async function modelDiagnostics(ctx) {
  const llm = readLlm(ctx);
  const sel = defaultModelSelection(ctx);
  let providers = [];
  try { providers = llm && typeof llm.listProviders === 'function' ? await llm.listProviders() : []; } catch (e) {}
  const seen = ['llm', 'agents', 'agentPresets', 'agentDefaultModel', 'tools'].map(k => {
    let ok = false;
    try { ok = !!safeService(ctx, k); } catch (e) { ok = false; }
    return k + (ok ? '+' : '-');
  }).join(',');
  return '（llm=' + (llm ? '有' : '无')
    + '，默认模型=' + (sel && sel.provider ? sel.provider + '/' + sel.model : '未设置')
    + '，可用提供方=' + (providers || []).map(p => (p && (p.id || p.provider)) || '?').join(',')
    + '，可见服务=' + seen + '）';
}

async function llmShortName(ctx, name) {
  const llm = readLlm(ctx);
  const sel = await resolveModel(ctx);
  if (!llm || !sel) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let out = '';
  try {
    for await (const chunk of llm.stream({
      provider: sel.provider,
      model: sel.model,
      system: SHORTNAME_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: '企业全称：' + name }] }],
      temperature: 0.1,
      maxTokens: 40,
      purpose: 'workbench-company-shortname',
      signal: ctrl.signal,
    })) {
      if (chunk && chunk.type === 'text-delta') out += chunk.text;
      else if (chunk && chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') return null;
    }
  } catch (e) {
    return null;
  } finally { clearTimeout(timer); }
  const line = String(out || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean)[0] || '';
  const clean = line.replace(/[「」“”"'\s]/g, '').replace(/[：:].*$/, '');
  if (!clean || clean.length > 20 || clean === name) return null;
  return clean;
}

// 查询一家公司的工商登记信息；简称/不完整名会先过一次实体识别
async function qccLookupCompany(ctx, name) {
  let text;
  try {
    text = await callHostTool(ctx, 'mcp__qcc-company__get_company_registration_info', { searchKey: name });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (!/未匹配|不存在|未找到|没有找到|not found|no match/i.test(msg)) throw e;
    const candText = await callHostTool(ctx, 'mcp__qcc-company__get_company_by_query', { searchKey: name });
    const parsed = parseFirstJson(candText);
    const list = Array.isArray(parsed) ? parsed
      : (parsed && (parsed.公司列表 || parsed.list || parsed.candidates || parsed.items)) || [];
    if (!Array.isArray(list) || list.length !== 1) {
      throw new Error('企查查没匹配到唯一主体，请填写完整企业名称');
    }
    const one = list[0] || {};
    const code = one['统一社会信用代码'] || one.creditCode || '';
    if (!code) throw new Error('企查查匹配结果里没有统一社会信用代码');
    text = await callHostTool(ctx, 'mcp__qcc-company__get_company_registration_info', { searchKey: code });
  }
  const data = parseFirstJson(text);
  if (!data || typeof data !== 'object') throw new Error('企查查返回的内容无法解析');
  return { ok: true, company: mapQccCompany(data, name) };
}

// ---------- 合同扫描件 / Word 解析（MinerU + 本地 python 取文） ----------
// 取文顺序：本地 python（pdf/docx/txt，快且不出本机）→ 文本太少或取不到就交给 MinerU CLI（扫描件/图片）。
// macOS 移植：原表只有 python / 写死的 Anaconda 路径，macOS 上通常只有 python3。
// 优先使用工作台专用 venv（见 python/requirements.txt 的依赖清单）。
const WORKBENCH_VENV_PY = join(homedir(), '.dsh', 'workbench-venv',
  ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python3']));
const PYTHON_CANDIDATES = [
  process.env.DSH_WORKBENCH_PYTHON,
  WORKBENCH_VENV_PY,
  'python3',
  'python',
  ...(process.platform === 'win32' ? ['D:\\Anaconda3\\python.exe'] : []),
].filter(Boolean);
const MINERU_CMD = process.env.DSH_WORKBENCH_MINERU || join(homedir(), 'AppData', 'Roaming', 'npm', 'mineru-open-api.cmd');

function runCli(exe, args, timeoutMs, extraEnv) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.MINERU_TOKEN;
    // Windows 上 python 的 stdout 默认是 cp936，Node 按 utf8 读会把中文读成乱码；
    // 强制 UTF-8 后 JSON 里的中文才不会被写坏（脚本本身也用了 ASCII 转义兜底）。
    env.PYTHONIOENCODING = 'utf-8';
    env.PYTHONUTF8 = '1';                  // 本机注入过期的 MINERU_TOKEN，会盖掉 config.yaml 里的有效 token
    if (extraEnv) Object.assign(env, extraEnv);
    const isBatch = /\.(cmd|bat)$/i.test(exe);
    const cmd = isBatch ? (process.env.ComSpec || 'cmd.exe') : exe;
    const argv = isBatch ? ['/c', exe, ...args] : args;
    let child;
    try { child = spawn(cmd, argv, { env, windowsHide: true }); } catch (e) { reject(e); return; }
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (e) {} reject(new Error('解析超时（' + Math.round(timeoutMs / 1000) + 's）')); }, timeoutMs);
    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
  });
}

async function pythonText(file) {
  const script = fileURLToPath(new URL('./parse_doc.py', import.meta.url));
  let lastErr = null;
  for (const py of PYTHON_CANDIDATES) {
    try {
      const r = await runCli(py, [script, file], 30000);
      if (r.code !== 0) { lastErr = new Error((r.stderr || '').slice(0, 200) || ('python 退出码 ' + r.code)); continue; }
      const j = parseFirstJson(r.stdout);
      if (!j) { lastErr = new Error('取文脚本输出无法解析'); continue; }
      if (!j.ok) { lastErr = new Error(j.error || '取文失败'); continue; }
      return String(j.text || '');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('没有可用的 python');
}


// 天源原生报告导出：交给 report-native.py（playwright 驱动），复用持久化浏览器登录态。
// 全程页面内 fetch，不读取/导出任何 Cookie；脚本最后一行输出 @@DSH_NATIVE@@<JSON>。
const NATIVE_PROFILE_DIR = join(homedir(), '.tianyuan-workbench', 'pw-profile');
async function runNativeEngine(params) {
  const script = fileURLToPath(new URL('./report-native.py', import.meta.url));
  const payload = JSON.stringify({ profileDir: NATIVE_PROFILE_DIR, ...params });
  const timeout = params && params.action === 'probe' ? 180000 : Math.max(600000, ((params.items || []).length) * 660000);
  let lastErr = null;
  for (const py of PYTHON_CANDIDATES) {
    try {
      const r = await runCli(py, [script, payload], timeout);
      const line = String(r.stdout || '').split(/\r?\n/).reverse().find(l => l.indexOf('@@DSH_NATIVE@@') === 0);
      if (!line) { lastErr = new Error((r.stderr || '').slice(-400) || ('引擎无输出，退出码 ' + r.code)); continue; }
      try { return JSON.parse(line.slice('@@DSH_NATIVE@@'.length)); }
      catch (e) { lastErr = new Error('引擎输出解析失败：' + line.slice(0, 200)); continue; }
    } catch (e) { lastErr = e; }
  }
  return { ok: false, code: 'ENGINE_FAIL', msg: String((lastErr && lastErr.message) || '引擎执行失败') };
}

// 给已下载的原生 docx 套用「报告格式」页的表格参数（原地改写，内容不动）。
// 复用「评估工具箱」的表格设置脚本（format_word_tables.py）——它对表头识别、
// 列宽分配、边框、对齐的处理都经过实机验证，比自研算法可靠。
// 脚本自己会返回 {"ok":false,...}，调用方把原因原样显示，不假装成功。
function toolboxTableFormatScript() {
  const explicit = process.env.TIANYUAN_TABLE_FORMAT_SCRIPT;
  if (explicit && existsSync(explicit)) return explicit;
  const home = homedir();
  const guesses = [
    join(home, '.tianyuan-workbench/projects/天源评估系统/skills/table-format/scripts/format_word_tables.py'),
    join(home, 'Library/Application Support/天源评估系统/skills/table-format/scripts/format_word_tables.py'),
  ];
  for (const g of guesses) if (existsSync(g)) return g;
  return null;
}

// 把「报告格式」页的 table 段翻译成工具箱脚本认的 FORMAT_RULES 键。
// 只映射语义完全对应的项，其余留空让工具箱用自己的预设——不做无依据的猜测。
function toolboxRulesFromReportFormat(cfg) {
  const out = {};
  const t = (cfg && cfg.table) || {};
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const sz = num(t.size_half_points);
  if (sz && sz > 0) out.fontSizePt = sz / 2;
  if (typeof t.font === 'string' && t.font.trim()) out.fontEastAsia = t.font.trim();
  if (typeof t.ascii_font === 'string' && t.ascii_font.trim()) out.fontLatin = t.ascii_font.trim();
  const minRow = num(t.min_row_height_twips);
  if (minRow && minRow > 0) out.minimumRowHeightCm = +(minRow / 567).toFixed(3); // 1cm = 567 twips
  if (typeof t.repeat_header === 'boolean') out.repeatHeader = t.repeat_header;
  if (typeof t.numeric_align_right === 'boolean') out.numericAlignment = t.numeric_align_right ? 'right' : 'left';
  if (typeof t.autofit === 'boolean') out.fitToWindow = t.autofit;
  if (typeof t.single_line === 'boolean') out.lineSpacing = t.single_line ? 1.0 : 1.5;
  if (typeof t.clear_shading === 'boolean') out.clearShading = t.clear_shading;
  const b = t.border || {};
  const pt = (edge) => { const s = num((b[edge] || {}).size); return s && s > 0 ? s / 8 : null; }; // sz 单位 1/8 磅
  const topPt = pt('top'), botPt = pt('bottom');
  if (topPt || botPt) out.topBottomBorderPt = Math.max(topPt || 0, botPt || 0);
  const inHPt = pt('insideH'), inVPt = pt('insideV');
  if (inHPt || inVPt) out.insideBorderPt = Math.max(inHPt || 0, inVPt || 0);
  const side = b.left || b.right;
  if (side && String(side.style || '').toLowerCase() === 'nil') out.leftRightBorder = 'none';
  return out;
}

/**
 * 抓取导出时点的线上节点树，供基线归档使用。
 * 只读、失败不影响导出：拿不到快照就是 `not_captured`，不猜、不补。
 */
async function captureOnlineNodes({ projectId, companyId, reportType }) {
  const args = { projectId: String(projectId), companyId: String(companyId), reportType: Number(reportType) };
  const res = await ty.callTool('export_report_full_json', args);
  if (res && res.isError) throw new Error('读取线上节点失败：' + hostToolText(res).slice(0, 200));
  const data = res && res.data;
  if (!data || typeof data !== 'object') throw new Error('读取线上节点失败：返回为空');
  return { document: data, capturedAt: new Date().toISOString() };
}

/**
 * 用网页 content/batch 抓一遍节点的**完整版**正文（含 attrs/marks），供基线归档。
 *
 * 为什么必须走浏览器而不是 MCP：MCP 的 export_report_full_json 给的是精简版，
 * 剥掉了 attrs 与 marks，拿它写回天源会直接报 content.attrs is null。
 *
 * 失败不抛到导出流程之外：拿不到完整版就把基线降级为「没有完整版」，
 * 记录原因，绝不拿精简版冒充。返回 { items, capturedAt } 或抛错由调用侧捕获。
 */
async function captureOnlineFullNodes({ projectId, companyId, reportType, document }) {
  const ids = collectContentItemIds(document);
  if (!ids.length) throw new Error('线上节点里没有可抓取正文的内容节点');
  if (ids.length > MAX_FULL_ITEMS) throw new Error('内容节点数量超过上限（' + ids.length + '），完整版快照未保存');
  await rb.openTyHost(projectId);
  const items = [];
  for (let i = 0; i < ids.length; i += FULL_CONTENT_CHUNK) {
    const chunk = ids.slice(i, i + FULL_CONTENT_CHUNK);
    const rows = await readContents({ projectId, companyId, itemIds: chunk });
    const byId = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row && row.itemId != null) byId.set(String(row.itemId), row);
    }
    for (const id of chunk) {
      const row = byId.get(id);
      // 缺一个就不存：残缺的完整版会让回溯时误以为原文就是这样。
      if (!row || row.text == null) throw new Error('节点 ' + id + ' 没有返回正文，完整版快照未保存');
      items.push({ itemId: id, itemType: row.itemType ?? null, text: row.text });
    }
  }
  return { items, capturedAt: new Date().toISOString(), expectedItemCount: ids.length };
}

/**
 * 天源会话的两个来源：宿主 Cookie 直调，或借用户浏览器的登录态。
 *
 * 为什么必须两条腿走路：tianyuan-session.js 的 cookie 只存在宿主进程内存里，
 * 唯一注入点是 /ty/native/session（要求用户手粘 tk/sid），而工作台前端从来没调过它。
 * 于是「用户在浏览器里明明登录了」这件事宿主并不知道，hasSession() 恒为 false。
 * 用户不应该为了用这个模块再扫码一次——浏览器已经登着，就走浏览器通道。
 */
function hasHostSession() { return tySession.hasSession(); }

/** 报告列表：优先宿主 Cookie，没有会话就走浏览器。 */
async function liveListReports(projectId) {
  if (hasHostSession()) {
    try {
      return await tySession.listReports(String(projectId));
    } catch (e) {
      // 宿主 cookie 可能已过期：清掉后继续用浏览器通道，不把用户挡在门外。
      if (!e || e.code !== 'UNAUTHENTICATED') throw e;
      tySession.clearSession();
    }
  }
  const rows = await rb.listReports(String(projectId));
  return rows.map(r => ({
    ...r,
    version: Number(r.version) || 0,
    attachId: r.attachId ? String(r.attachId) : null,
    updatedAt: r.updatedAt || '',
    creator: r.creator || '',
  }));
}

/** 提交生成任务：同样两条腿。返回 jobId（可能为空，调用方只用来提示）。 */
async function liveBuildReport(projectId, companyId, reportType) {
  if (hasHostSession()) {
    try {
      const out = await tySession.buildReport(String(projectId), String(companyId), Number(reportType));
      return out && out.jobId;
    } catch (e) {
      if (!e || e.code !== 'UNAUTHENTICATED') throw e;
      tySession.clearSession();
    }
  }
  return rb.buildReport(String(projectId), String(companyId), Number(reportType));
}

/** 下载附件原始字节：rb 返回 base64，宿主 cookie 返回 Buffer，这里统一成 Buffer。 */
async function liveDownloadDocx(attachId) {
  if (hasHostSession()) {
    try {
      const { buf } = await tySession.downloadAttachmentRaw(String(attachId));
      const chk = await tySession.validateDocx(buf);
      if (!chk.ok) throw new Error('下载文件校验失败：' + chk.reason);
      return buf;
    } catch (e) {
      if (!e || e.code !== 'UNAUTHENTICATED') throw e;
      tySession.clearSession();
    }
  }
  const out = await rb.downloadAttachment(String(attachId));
  const buf = Buffer.from(out.base64, 'base64');
  const chk = await tySession.validateDocx(buf);
  if (!chk.ok) throw new Error('下载文件校验失败：' + chk.reason);
  return buf;
}

/**
 * 把浏览器通道的错误翻成用户可以照着做的话。
 *
 * rb.* 抛的是 NOT_LOGGED_IN / BRIDGE_DISCONNECTED / NO_OPENCLI 这类机器码，
 * 直接丢给界面等于又是一句看不懂的提示。
 */
function explainBrowserError(e) {
  const code = (e && (e.code || e.message)) || '';
  const detail = (e && e.detail) ? String(e.detail).slice(0, 160) : '';
  const tail = detail ? '（' + detail + '）' : '';
  if (code === 'NOT_LOGGED_IN') {
    return '浏览器里的天源登录态读不到' + tail + '：请先在 Chrome 打开天源并确认已登录，再点「刷新」重读。';
  }
  if (code === 'BRIDGE_DISCONNECTED') return '连不上浏览器扩展（自动重连也失败了）：请确认 Chrome 正在运行、OpenCLI 扩展已启用，然后点「刷新」重试。';
  if (code === 'NO_OPENCLI') return '没找到 opencli（浏览器通道）：请安装 opencli，或在「设置」里配置宿主侧的 tk/sid 登录。';
  return '';
}

/**
 * 取「线上当前版本」的 DOCX 原始字节，用于不依赖归档基线的比对。
 *
 * attachId 可以来自用户在列表里的选择（旧版），也可以为空表示「取最新已生成版本」。
 * 不允许前端传任意 attachId 去下载别的东西：这里只接受 /^\d+$/ 的 attachId，
 * 且必须能在该项目该公司的报告列表里查到——否则就是绕开列表乱下载。
 */
async function fetchLiveReportDocx({ projectId, companyId, reportType, attachId }) {
  const rows = await liveListReports(projectId);
  const mine = rows.filter(r => String(r.companyId) === String(companyId)
    && Number(r.type) === Number(reportType)
    && r.attachId
    && Number(r.jobState) === 2);
  if (!mine.length) {
    const label = { 1: '评估报告', 2: '评估说明', 3: '长投说明' }[Number(reportType)] || '报告';
    throw new Error('线上还没有已生成的' + label + '（可能从未生成，请先在天源网页生成一次）');
  }
  let target = null;
  if (attachId != null && String(attachId) !== '') {
    // 用户选了某一版：必须在该公司该类型列表里，防止拿别人的 attachId 下载。
    target = mine.find(r => String(r.attachId) === String(attachId)) || null;
    if (!target) throw new Error('选择的版本不在该公司的报告列表里，已拒绝下载');
  } else {
    mine.sort((a, b) => Number(b.version) - Number(a.version));
    target = mine[0];
  }
  const buf = await liveDownloadDocx(target.attachId);
  return { buf, version: target.version, attachId: target.attachId, companyName: target.companyName || '' };
}

/**
 * 比对用的线上现场快照：节点树（定位用）+ 完整版正文（写回用）。
 *
 * 两者必须同批抓取，否则用户勾选写回时 astSha256 校验会误判"线上已变化"。
 */
async function captureLiveSnapshot({ projectId, companyId, reportType }) {
  const online = await captureOnlineNodes({ projectId, companyId, reportType });
  // 必须用 buildOnlineSnapshot 生成快照：定位器要的是 {identity, itemList}，
  // 直接塞原始导出（{basicInfo, itemList}）会因为查不到 identity 而全部拒定位。
  //
  // 这里不抓 content/batch 完整版：写回时 applyWriteback 会为每个节点重新读一次
  // 完整正文，比对阶段抓了也用不上，只会白白多几十个浏览器往返。
  const built = buildOnlineSnapshot({
    document: online.document,
    expected: { projectId, companyId, reportType },
    capturedAt: online.capturedAt,
  });
  return {
    online: built,          // { snapshot, evidence }
    astSha256: built.evidence.astSha256,
    itemCount: built.evidence.itemCount,
    capturedAt: online.capturedAt,
  };
}

async function applyDocxTableFormat(file) {
  const tbx = toolboxTableFormatScript();
  if (!tbx) throw new Error('没有找到「评估工具箱」的表格设置脚本 format_word_tables.py');
  let rules = {};
  try {
    const { readReportFormat } = await import('./report-format.js');
    rules = toolboxRulesFromReportFormat(await readReportFormat());
  } catch (e) { rules = {}; } // 配置读不到就全用工具箱预设
  const env = { ...process.env, PYTHONUNBUFFERED: '1' };
  if (Object.keys(rules).length) env.TIANYUAN_TABLE_FORMAT_CONFIG = JSON.stringify(rules);

  let lastErr = null;
  for (const py of PYTHON_CANDIDATES) {
    try {
      const r = await runCli(py, [tbx, file], 180000, env);
      // 脚本按 JSON Lines 输出，最后一条 saved 就是结果
      const lines = String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
      let saved = null; let failed = null;
      for (const line of lines) {
        let j = null; try { j = JSON.parse(line); } catch (e) { continue; }
        if (j.event === 'saved') saved = j;
        if (j.event === 'failed') failed = j;
      }
      if (r.code !== 0 || !saved) {
        lastErr = new Error(failed ? (failed.reason || '表格设置失败') : ((r.stderr || '').slice(-300) || ('python 退出码 ' + r.code)));
        continue;
      }
      return {
        ok: true,
        mode: 'toolbox',
        tables: saved.tableCount || 0,
        cells: saved.clearedShadingCells || 0,
        skippedAttachment: saved.skippedAttachmentTables || 0,
        skippedFormatted: saved.skippedFormattedTables || 0,
        clearedSummaryValues: saved.clearedSummaryValues || 0,
        reflowedUniformGrids: saved.reflowedUniformGrids || 0,
        repairedHeaderRows: saved.repairedHeaderRows || 0,
        rules,
      };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('没有可用的 python（需要 python-docx 与 lxml）');
}

// 正文西文字体归一：让正文里的数字不再落到 Times New Roman / Calibri。
// 只改 body 直接子段落，表格与页眉页脚一律不碰（表格的字体由表格设置自己管）。
async function applyBodyFontNormalize(file) {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'normalize_body_fonts.py');
  if (!existsSync(script)) throw new Error('没有找到正文字体脚本 normalize_body_fonts.py');
  let cfg = {};
  try {
    const { readReportFormat } = await import('./report-format.js');
    const cur = await readReportFormat();
    const body = (cur && cur.body) || {};
    cfg = { asciiFont: body.ascii_font || body.font || '宋体', eastAsiaFont: body.font || '宋体' };
  } catch (e) { cfg = { asciiFont: '宋体', eastAsiaFont: '宋体' }; }
  const env = { ...process.env, PYTHONUNBUFFERED: '1', TIANYUAN_BODY_FONT_CONFIG: JSON.stringify(cfg) };

  let lastErr = null;
  for (const py of PYTHON_CANDIDATES) {
    try {
      const r = await runCli(py, [script, file], 120000, env);
      const lines = String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
      let saved = null, failed = null;
      for (const line of lines) {
        let j = null; try { j = JSON.parse(line); } catch (e) { continue; }
        if (j.event === 'saved') saved = j;
        if (j.event === 'failed') failed = j;
      }
      if (r.code !== 0 || !saved) {
        lastErr = new Error(failed ? (failed.reason || '正文字体处理失败') : ((r.stderr || '').slice(-300) || ('python 退出码 ' + r.code)));
        continue;
      }
      return { ok: true, runs: saved.runs || 0, paragraphs: saved.paragraphs || 0, changed: !!saved.changed, asciiFont: cfg.asciiFont };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('没有可用的 python（需要 python-docx 与 lxml）');
}

// 股权信息批量导入 / 模板生成：交给 equity_import.py（openpyxl）。找不到 openpyxl 时
// 脚本自己会返回 {"ok":false,"error":...}，前端把原因原样显示，不假装成功。
async function financeScript(args) {
  const script = fileURLToPath(new URL('./finance_import.py', import.meta.url));
  let lastErr = null;
  for (const py of PYTHON_CANDIDATES) {
    try {
      const r = await runCli(py, [script, ...args], 60000);
      if (r.code !== 0) { lastErr = new Error((r.stderr || '').slice(0, 300) || ('python 退出码 ' + r.code)); continue; }
      const j = parseFirstJson(r.stdout);
      if (!j) { lastErr = new Error('财务资料脚本输出无法解析'); continue; }
      if (!j.ok) { lastErr = new Error(j.error || '财务资料脚本报错'); continue; }
      return j;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('没有可用的 python（需要 openpyxl）');
}

async function equityScript(args) {
  const script = fileURLToPath(new URL('./equity_import.py', import.meta.url));
  let lastErr = null;
  for (const py of PYTHON_CANDIDATES) {
    try {
      const r = await runCli(py, [script, ...args], 60000);
      if (r.code !== 0) { lastErr = new Error((r.stderr || '').slice(0, 300) || ('python 退出码 ' + r.code)); continue; }
      const j = parseFirstJson(r.stdout);
      if (!j) { lastErr = new Error('导入脚本输出无法解析'); continue; }
      if (!j.ok) { lastErr = new Error(j.error || '导入脚本报错'); continue; }
      return j;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('没有可用的 python（需要 openpyxl）');
}

async function mineruText(file) {
  const r = await runCli(MINERU_CMD, ['flash-extract', file], 180000);
  const text = String(r.stdout || '').trim();
  if (r.code !== 0 && !text) throw new Error((r.stderr || '').slice(0, 200) || ('MinerU 退出码 ' + r.code));
  if (!text) throw new Error('MinerU 没有返回内容');
  return text;
}

// 先本地取文，文本太少（扫描件）再用 MinerU；两边都失败才报错
async function extractDocumentText(file) {
  const ext = String(file).toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || '';
  const localOk = ['.pdf', '.docx', '.txt', '.md', '.csv'].includes(ext);
  let local = '';
  let localErr = null;
  if (localOk) {
    try { local = await pythonText(file); } catch (e) { localErr = e; }
  }
  if (local && local.replace(/\s+/g, '').length >= 40) return { text: local, via: 'python' };
  try {
    const ocr = await mineruText(file);
    if (ocr && ocr.trim()) return { text: ocr, via: 'mineru' };
  } catch (e) {
    if (local && local.trim()) return { text: local, via: 'python' };
    throw new Error('解析失败：' + String((e && e.message) || e) + (localErr ? '（本地取文也失败：' + localErr.message + '）' : ''));
  }
  if (local && local.trim()) return { text: local, via: 'python' };
  throw new Error('没有解析出文字内容');
}

// 企业一句话简介：先搜公开资料，再让模型压成一段话；搜不到就不填（返回空串）
const INTRO_SYSTEM = [
  '你是资产评估助理。根据给你的公开资料片段，用一段话（80~120 字）概括这家公司是做什么的。',
  '要求：直接说主营业务、产品/服务、所在行业与特色，不要客套话、不要「是一家…公司」这类空话、不要罗列资料原文。',
  '只输出这段话本身，不要标题、不要引号、不要解释。资料不足就说得简短，不要编造。',
].join('\n');

async function companyIntro(ctx, name) {
  const q = String(name || '').trim();
  if (!q) return '';
  let snippets = '';
  try {
    snippets = await callHostTool(ctx, 'web_search', { queries: [q + ' 公司简介 主营业务'] }, 30000);
  } catch (e) { snippets = ''; }
  snippets = String(snippets || '').replace(/\s+/g, ' ').trim().slice(0, 6000);
  if (!snippets) return '';                       // 没搜到就不填
  const llm = readLlm(ctx);
  if (!llm) return '';
  const sel = await resolveModel(ctx);
  if (!sel) return '';
  const r = await streamOnce(llm, {
    provider: sel.provider,
    model: sel.model,
    system: INTRO_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: '公司：' + q + '\n\n公开资料片段：\n' + snippets }] }],
    temperature: 0.3,
    maxTokens: 400,
    purpose: 'workbench-company-intro',
  }, 60000);
  const text = String(r.text || '').trim().replace(/^["'“”]+|["'“”]+$/g, '').replace(/\s+/g, ' ').trim();
  return text.slice(0, 240);
}

const CONTRACT_SHAPE = '{"project":{"shortName":"","baseDate":"","economicBehavior":"","objectReport":"","scopeReport":"","valueType":"","purposeReport":"","purpose":"","objectReport2":"","inOut":"","equityRatio":"","bizNature":""},"customer":{"name":"","shortName":"","creditCode":"","entType":"","address":"","capital":"","legalRep":"","business":"","relation":""},"entity":{"name":"","shortName":"","creditCode":"","entType":"","address":"","capital":"","legalRep":"","business":""},"contract":{"type":"","signDate":"","amountOriginal":"","amount":"","payMethod":"","reportSubmitAt":"","reportSubmitWay":"","reportCopies":"","statementCopies":""}}';

const CONTRACT_SYSTEM = [
  '你是资产评估机构的助理。给你一份「资产评估委托合同」（正文或 OCR 文本），你要提取结构化信息。',
  '只输出一个 JSON 对象：不要解释、不要前后缀、不要 markdown 代码块。没有的字段给空字符串，不要编造。',
  '值都用双引号字符串；不要输出数组以外的嵌套结构，不要输出注释；宁可留空也不要猜。',
  '日期一律 YYYY-MM-DD；份数只写数字；金额一律换成「元的阿拉伯数字，不带逗号、不带单位」（28万元 写成 280000）。',
  '字段：',
  '{',
  '  "project": {',
  '    "shortName": "", "baseDate": "", "economicBehavior": "",',
  '    "objectReport": "", "scopeReport": "", "valueType": "",',
  '    "purposeReport": "", "purpose": "", "objectReport2": "",',
  '    "inOut": "", "equityRatio": "", "bizNature": "", "purposeOther": ""',
  '  },',
  '  "customer": {"type": "法人组织|自然人", "name": "", "shortName": "", "creditCode": "", "entType": "", "address": "", "capital": "", "legalRep": "", "business": "", "relation": "", "idCard": "", "stateOwned": "是|否|", "listed": "是|否|"},',
  '  "entity": {"name": "", "shortName": "", "creditCode": "", "entType": "", "address": "", "capital": "", "legalRep": "", "business": "", "stateOwned": "是|否|", "listed": "是|否|"},',
  '  "contract": {"type": "框架协议|非框架协议|", "signDate": "", "serviceStart": "", "serviceEnd": "", "currency": "", "amountOriginal": "", "amount": "", "payMethod": "", "reportSubmitAt": "", "reportSubmitWay": "", "reportCopies": "", "statementCopies": "", "otherUsers": "", "purposeDetail": "", "secret": "是|否|"}',
  '}',
  '各字段说明：',
  '- customer 是委托人（甲方）；entity 是被评估单位（乙方要评估的对象，通常写在「委托事项/评估对象及范围」里）。',
  '- project.baseDate 评估基准日；economicBehavior 经济行为（如 拟转让股权 / 拟收购股权 / 商誉减值测试，注意保留「拟」字）；',
  '- project.objectReport / scopeReport 用报告口径的评估对象与评估范围（如 股东全部权益 / 全部资产和负债）；',
  '- project.valueType 价值类型（市场价值 / 投资价值 / 在用价值 / 清算价值 / 残余价值 / 可变现净值）；',
  '- project.purposeReport 评估目的-报备（取值见：抵债、计税、出资、改制、诉讼、其他等，按合同实际意思填最接近的）；',
  '- project.purpose 评估目的（如 股权/资产转让、商誉减值测试、以财务报告为目的的评估、发行股份购买资产 等）；',
  '- project.objectReport2 评估对象-报备（如 股东全部权益价值、单项资产-设备类、无形资产-商誉 等）；',
  '- project.inOut 资产置入/置出（置入 / 置出 / 不适用）；project.equityRatio 评估对象股权比例(%) 只写数字（如 100）；',
  '- project.bizNature 评估业务性质：国有资产评估业务 / 证券期货评估业务 / 其他评估业务；只有在明显能判断时才填。',
  '- stateOwned：该主体是否国有企业（国有独资/国有控股/全民所有制等，看合同里的企业类型描述）；listed：是否上市公司（有股票代码或写「上市公司」）。',
].join('\n');

// 找第一个「成对」的 {...}（字符串里的括号不算），模型前后多说了几句也能抠出来
function firstBalancedObject(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

// 尽力把模型输出解析成对象：去 ``` 代码块 → 成对括号 → 从后往前收
function parseModelJson(out) {
  const text = String(out || '').trim();
  const cleaned = text
    .replace(/^\s*```(?:json|JSON)?\s*/g, '')
    .replace(/\s*```\s*$/g, '')
    .trim();
  const tries = [];
  const bal = firstBalancedObject(cleaned);
  if (bal) tries.push(bal);
  if (cleaned !== text) { const bal2 = firstBalancedObject(text); if (bal2) tries.push(bal2); }
  for (const cand of tries) {
    try { return JSON.parse(cand); } catch (e) { /* 下一个 */ }
  }
  const legacy = pickJsonObject(cleaned);
  if (legacy) return legacy;
  return null;
}

function pickJsonObject(text) {
  const raw = String(text || '');
  const at = raw.indexOf('{');
  if (at < 0) return null;
  for (let end = raw.lastIndexOf('}'); end > at; end = raw.lastIndexOf('}', end - 1)) {
    try { return JSON.parse(raw.slice(at, end + 1)); } catch (e) { /* 继续往前收 */ }
  }
  return null;
}

function cleanFieldMap(obj, keys) {
  const out = {};
  keys.forEach(k => {
    const v = obj && obj[k];
    out[k] = v == null ? '' : String(v).trim();
  });
  return out;
}

// 跑一次流式：返回 { text, finishKind }
async function streamOnce(llm, args, timeoutMs) {
  let out = '';
  let finishKind = '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    for await (const chunk of llm.stream({ ...args, signal: ctrl.signal })) {
      if (!chunk) continue;
      if (chunk.type === 'text-delta') out += chunk.text;
      else if (chunk.type === 'finish' && chunk.reason) {
        if (chunk.reason.kind === 'error') {
          throw new Error('模型返回错误：' + ((chunk.reason.failure && chunk.reason.failure.message) || ''));
        }
        finishKind = chunk.reason.kind || '';
      }
    }
  } finally { clearTimeout(timer); }
  return { text: out, finishKind };
}

const CONTRACT_FIELD_LISTS = {
  project: ['shortName', 'baseDate', 'economicBehavior', 'objectReport', 'scopeReport', 'valueType', 'purposeReport', 'purpose', 'objectReport2', 'inOut', 'equityRatio', 'bizNature', 'purposeOther'],
  customer: ['type', 'name', 'shortName', 'creditCode', 'entType', 'address', 'capital', 'legalRep', 'business', 'relation', 'idCard', 'stateOwned', 'listed'],
  entity: ['name', 'shortName', 'creditCode', 'entType', 'address', 'capital', 'legalRep', 'business', 'stateOwned', 'listed'],
  contract: ['type', 'signDate', 'serviceStart', 'serviceEnd', 'currency', 'amountOriginal', 'amount', 'payMethod', 'reportSubmitAt', 'reportSubmitWay', 'reportCopies', 'statementCopies', 'otherUsers', 'purposeDetail', 'secret'],
};

function shapeFields(j) {
  const out = {};
  Object.keys(CONTRACT_FIELD_LISTS).forEach(k => { out[k] = cleanFieldMap(j[k], CONTRACT_FIELD_LISTS[k]); });
  return out;
}

// ---------- 规则兜底：模型不给力时，直接从合同正文里抠最可靠的几个字段 ----------
function ruleExtractFields(rawText) {
  const t = String(rawText || '').replace(/\r/g, '');
  const out = { project: {}, customer: {}, entity: {}, contract: {} };
  const first = (pairs) => {
    for (const [re, pick] of pairs) {
      const m = t.match(re);
      if (m) {
        const v = String((pick ? pick(m) : m[1]) || '').trim();
        if (v) return v;
      }
    }
    return '';
  };
  const cleanName = v => String(v || '')
    .replace(/[（(]以下简称[^）)]*[）)]/g, '')
    .replace(/[，,。;；:：].*$/, '')
    .replace(/\s+/g, '')
    .trim();
  const iso = (y, mo, d) => (y && mo && d) ? y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0') : '';
  const COMPANY = '[^\\n，。；]{2,50}?(?:有限责任公司|股份有限公司|有限公司|合伙企业|集团|事务所|中心|研究院)';
  const NAME = '([^\\n]{2,60})';

  // 甲方 = 委托人（合同模板写法很多，挨个试）
  const partyA = cleanName(first([
    [new RegExp('甲\\s*方[（(]委托人[）)][：:]\\s*' + NAME)],
    [new RegExp('委托人(?:名称)?[（(]甲\\s*方[)）][：:]\\s*' + NAME)],
    [new RegExp('委托人(?:名称)?[（(]甲方[)）][：:]\\s*' + NAME)],
    [new RegExp('委托人(?:名称)?[：:]\\s*' + NAME)],
    [new RegExp('甲\\s*方[（(]委托人[）)]\\s*[：:]\\s*' + NAME)],
    [new RegExp('甲\\s*方[：:]\\s*' + NAME)],
  ]));
  if (partyA) out.customer.name = partyA;

  const code18 = first([
    [/(?:统一社会信用代码|信用代码)[^\n0-9A-Z]{0,8}([0-9A-HJ-NPQRTUWXY]{18})/],
    [/(9[1-9][0-9A-HJ-NPQRTUWXY]{16})/],
  ]);
  if (code18) out.customer.creditCode = code18;

  const legalRep = first([[/(?:法定代表人|负责人)[：:]\s*([\u4e00-\u9fa5A-Za-z·]{2,10})/]])
    .replace(/^(联系人|电话|传真|地址|姓名)$/, '');
  if (legalRep && !/联系人|电话|传真|地址/.test(legalRep)) out.customer.legalRep = legalRep;

  const addr = first([[/(?:住\s*所|注册地址|地\s*址)[：:\s]*([^\n]{4,80})/]]);
  if (addr) out.customer.address = addr;

  const capital = first([[/(?:注册资本|注册资金)[：:\s]*([0-9.,]+\s*(?:万元|亿元|万|元))/]]);
  if (capital) out.customer.capital = capital.replace(/\s+/g, '');

  // 被评估单位：优先「（以下简称：被评估单位）」前面的公司名
  const entityRaw = first([
    [new RegExp('([^\\n，。；（）]{2,40})[（(]以下简称[：:]?\\s*被评估单位[）)]')],
    [/被评估单位(?:名称)?[：:]\s*([^\n]{4,60})/],
  ]).replace(/^(?:合并|对|拟|收购|购买|持有的|持有的)+/, '');
  const entityName = cleanName(entityRaw);
  if (entityName) out.entity.name = entityName;

  const purpose = first([[/评估目的[：:]\s*([^\n]{4,200})/]]);
  if (purpose) out.contract.purposeDetail = purpose.slice(0, 200);
  const object = first([[/评估对象(?:及范围)?[：:]\s*([^\n]{2,200})/]]);
  if (object) out.project.objectReport = object.split(/[。；;]/)[0].slice(0, 60);

  const base = t.match(/评估基准日[^\d]{0,12}(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (base) out.project.baseDate = iso(base[1], base[2], base[3]);

  const sign = t.match(/(?:签订(?:时间|日期)?|签署(?:时间|日期)?|签约日期)[：:\s]*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (sign) out.contract.signDate = iso(sign[1], sign[2], sign[3]);

  const amount = first([[
    /(?:合同)?(?:金额|价款|评估费|费用)[^0-9]{0,14}(?:人民币)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*元/,
  ]]);
  if (amount) out.contract.amount = amount.replace(/,/g, '');
  return out;
}

function countFields(f) {
  if (!f) return 0;
  let n = 0;
  ['project', 'customer', 'entity', 'contract'].forEach(k => {
    const g = f[k] || {};
    Object.keys(g).forEach(x => { if (String(g[x] || '').trim()) n += 1; });
  });
  return n;
}

// 模型结果优先，规则补空
function mergeFields(rule, model) {
  const out = {};
  ['project', 'customer', 'entity', 'contract'].forEach(k => {
    const a = (model && model[k]) || {};
    const b = (rule && rule[k]) || {};
    const one = {};
    CONTRACT_FIELD_LISTS[k].forEach(f => {
      const v = String(a[f] == null ? '' : a[f]).trim() || String(b[f] == null ? '' : b[f]).trim();
      one[f] = v;
    });
    out[k] = one;
  });
  return out;
}

async function extractContractFields(ctx, text, choice) {
  const clipped = String(text || '').slice(0, 30000);
  const rule = ruleExtractFields(clipped);          // 规则先跑一遍，模型失败也有兜底
  const ruleCount = countFields(rule);

  const llm = readLlm(ctx);
  if (!llm) {
    if (ruleCount) return { ...rule, _source: 'rule', _note: '没有可用的大模型，已按规则提取部分字段' };
    throw new Error('没有可用的大模型' + await modelDiagnostics(ctx));
  }
  let sel = null;
  if (choice && choice.provider && choice.model) sel = { provider: String(choice.provider), model: String(choice.model) };
  if (!sel) sel = await resolveModel(ctx);
  if (!sel) {
    if (ruleCount) return { ...rule, _source: 'rule', _note: '没有可用的大模型，已按规则提取部分字段' };
    throw new Error('没有可用的大模型' + await modelDiagnostics(ctx));
  }

  const base = { provider: sel.provider, model: sel.model, temperature: 0.1, purpose: 'workbench-contract-extract' };
  const first = await streamOnce(llm, {
    ...base,
    system: CONTRACT_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: '合同文本如下：\n' + clipped }] }],
    maxTokens: 4000,
  }, 120000);
  let parsed = parseModelJson(first.text);

  // 没输出正文（常见于会思考的模型把预算用在 reasoning 上）：换一条「只输出 JSON」的短路提示再试
  if (!parsed) {
    try {
      const retry = await streamOnce(llm, {
        ...base,
        temperature: 0,
        system: '只输出一个 JSON 对象，不要分析、不要解释、不要代码块。没有的字段给空字符串。',
        messages: [{ role: 'user', content: [{ type: 'text', text: '按这个结构输出 JSON：' + CONTRACT_SHAPE + '\n\n合同文本：\n' + clipped.slice(0, 20000) }] }],
        maxTokens: 4000,
      }, 120000);
      parsed = parseModelJson(retry.text);
    } catch (e) { /* 走兜底 */ }
  }

  // 还不行：让模型把上一次的输出修成合法 JSON
  if (!parsed) {
    const broken = String(first.text || '').trim().slice(0, 6000);
    if (broken) {
      try {
        const second = await streamOnce(llm, {
          ...base,
          system: '你是 JSON 修复器。只输出一个合法的 JSON 对象，不要解释、不要代码块；缺的字段给空字符串。',
          messages: [{ role: 'user', content: [{ type: 'text', text: '把下面的内容整理成合法 JSON（结构见字段名，不要新增字段）：\n' + broken }] }],
          maxTokens: 3000,
        }, 60000);
        parsed = parseModelJson(second.text);
      } catch (e) { /* 走兜底 */ }
    }
  }

  if (parsed) {
    const merged = mergeFields(rule, shapeFields(parsed));
    return { ...merged, _source: ruleCount ? 'mixed' : 'model' };
  }

  // 模型彻底不给结果：用规则结果顶上
  const body = String(first.text || '').trim();
  const why = body ? '模型输出不是合法 JSON' : '模型没有输出正文（可能都被思考吃掉了）';
  if (ruleCount) {
    return { ...rule, _source: 'rule', _note: why + '；已按规则从合同里提取 ' + ruleCount + ' 个字段，请核对' };
  }
  throw new Error(why + '；规则也没提取到内容' + (body ? '；原文前 240 字：' + body.slice(0, 240).replace(/\s+/g, ' ') : ''));
}

// 问答用：取宿主 llm 服务（可选依赖，缺失时返回 null）
// 安全取一个服务：ctx.get / ctx.xxx / root 三条路都试，任何一条抛错都不影响别条
function safeService(ctx, name) {
  const tries = [
    () => (typeof ctx.get === 'function' ? ctx.get(name) : null),
    () => ctx[name],
    () => (ctx.root && ctx.root !== ctx ? (typeof ctx.root.get === 'function' ? ctx.root.get(name) : ctx.root[name]) : null),
  ];
  for (const t of tries) {
    try { const v = t(); if (v) return v; } catch (e) { /* 下一条 */ }
  }
  return null;
}

// llm 服务在桌面端有时挂在「每个 agent 的预设作用域」里，根作用域看不到；
// 这时借一个活跃 agent 的作用域去取（agentPresets.serviceFor）。
function findLlm(ctx) {
  const direct = safeService(ctx, 'llm');
  if (direct && typeof direct.stream === 'function') return direct;
  try {
    const agents = safeService(ctx, 'agents');
    const presets = safeService(ctx, 'agentPresets');
    if (agents && presets && typeof agents.list === 'function' && typeof presets.serviceFor === 'function') {
      for (const a of agents.list() || []) {
        try {
          const svc = presets.serviceFor(a, 'llm');
          if (svc && typeof svc.stream === 'function') return svc;
        } catch (e) { /* 下一个 agent */ }
      }
    }
  } catch (e) { /* 借不到就算了 */ }
  return null;
}

function readLlm(ctx) {
  try { return findLlm(ctx); } catch (e) { return null; }
}

// 问答用：只把命中文件的精简信息发给浏览器，正文不回传（体积大）
function trimItems(items) {
  return (items || []).map(it => ({
    rel: it.rel, project: it.project, file: it.file, subdir: it.subdir,
    snippet: (it.snippet || '').slice(0, 400), score: Number((it.score || 0).toFixed(2)),
    chars: it.chars || it.totalChars || 0, where: it.where || '', scanned: !!it.scanned,
    wiki: !!it.wiki,     // 来自 _wiki 编译层的页面（项目页/主题页）
  }));
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function parseQuote(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const p = raw.split('~');
  if (p.length < 35) return null;
  return { market: p[0], name: p[1], code: p[2], price: num(p[3]), prevClose: num(p[4]), open: num(p[5]),
    // 36 成交量(手) · 37 成交额(万) · 38 换手率 · 39 市盈率(TTM) · 43 振幅 · 45 总市值(亿) · 46 市净率
    volume: num(p[36]), amount: num(p[37]), turnover: num(p[38]), pe: num(p[39]),
    change: num(p[31]), changePct: num(p[32]), high: num(p[33]), low: num(p[34]), time: p[30],
    amplitude: num(p[43]), marketCap: num(p[45]), pb: num(p[46]) };
}
function decodeUnicode(s) {
  return String(s || '').replace(/\\u([0-9a-fA-F]{4})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
}
async function getText(url, headers, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  try {
    const r = await fetch(url, { headers: headers || {}, signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error('upstream HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(timer); }
}
function decodeGbk(buf) {
  try { return new TextDecoder('gbk').decode(buf); } catch (e) { return Buffer.from(buf).toString('utf8'); }
}
async function getBuffer(url, headers, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  try {
    const r = await fetch(url, { headers: headers || {}, signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error('upstream HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  } finally { clearTimeout(timer); }
}

// ---------- 天源导出（HTTP 路由与 agent 工具共用的唯一实现） ----------
// 同一份逻辑既要给「工作 → 天源项目 → 导出」按钮用，也要给助手的工作台工具用。
// 按 dsh-doc 的 user-actions 约定：一处实现、两个调用方，不各写一份。
// 返回 { status, body }：status 是给路由用的 HTTP 码，工具只读 body。
const TY_EXPORT_KINDS = {
  detail: { sub: 'export-asset-detail-table', fmt: 'appraisal-detail-print-format/scripts/adjust_appraisal_detail_print.py', label: '明细表' },
  declare: { sub: 'export-asset-declare-table', fmt: 'appraisal-declaration-print-format/scripts/adjust_appraisal_declaration_print.py', label: '申报表' },
};

// ---------- 导出页脚配置 ----------
// 存独立 JSON（不进 工作台数据.json：那份数据由前端整体覆盖保存，页脚混进去
// 会被没带页脚字段的保存请求静默冲掉）。结构：{ [projectId]: { [companyId]: { preparer, date, appraisers } } }。
const FOOTER_FILE = '导出页脚.json';
function footerStorePath(dir) { return join(dir, FOOTER_FILE); }
function normalizeFooterEntry(v) {
  if (!v || typeof v !== 'object') return null;
  const s = x => (typeof x === 'string' ? x.slice(0, 200) : '');
  const entry = { preparer: s(v.preparer), date: s(v.date), appraisers: s(v.appraisers) };
  if (!entry.preparer && !entry.date && !entry.appraisers) return null;   // 三项全空视为未配置
  return entry;
}
async function readFooterStore() {
  const cfg = await store.config();
  const file = footerStorePath(cfg.dir);
  try {
    const j = JSON.parse(await readFile(file, 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('页脚配置不是有效的对象');
    return j;
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
}
async function writeFooterStore(next) {
  const cfg = await store.config();
  const file = footerStorePath(cfg.dir);
  await mkdir(cfg.dir, { recursive: true });
  const tmp = file + '.tmp';
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  try { if (existsSync(file)) await rename(file, file + '.bak'); } catch (_) {}
  await rename(tmp, file);
  return file;
}
// 页脚写入器：与 index.js 同目录，复用格式脚本同一 python（优先工作台 venv，退回系统 python3）。
const FOOTER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'footer_workbook.py');
const FILL_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'fill_print_height.py');
const SAFE_FILL_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'safe_fill_rows.py');

function tyExportSkillsDir() {
  return [
    process.env.TIANYUAN_PRINT_SKILLS_DIR,
    join(homedir(), '.tianyuan-workbench', 'dependencies', '天源评估系统', 'print-format-skills'),
    join(homedir(), 'Projects', 'tianyuan-workbench-release-20261001', 'skills'),
  ].filter(Boolean).find(c => existsSync(join(c, 'asset-link-restore', 'scripts', 'restore_links.py')));
}
async function walkXlsxFiles(dir, out) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) await walkXlsxFiles(p, out);
    else if (/\.xlsx$/i.test(ent.name)) out.add(p);
  }
}
async function runTyExport(b) {
  const KINDS = TY_EXPORT_KINDS;
  const skillsDir = tyExportSkillsDir();
  const walkXlsx = walkXlsxFiles;   // 局部别名，下方沿用了原路由里的变量名
  let outDir = null;
  try {
    const jobId = /^[A-Za-z0-9_-]{6,64}$/.test(String(b.jobId || '')) ? String(b.jobId) : '';
    const setProg = patch => { if (!jobId) return; if (exportProgress.size > 50) { let oldest = null; for (const [k, v] of exportProgress) if (!oldest || v.at < oldest.at) oldest = { k, at: v.at }; if (oldest) exportProgress.delete(oldest.k); } exportProgress.set(jobId, { at: Date.now(), ...patch }); };
    const clearProg = () => { if (jobId) exportProgress.delete(jobId); };
    const cfg = KINDS[String(b.kind || '')];
    if (!cfg) return { status: 400, body: { ok: false, error: 'kind 必须是 detail（明细表）或 declare（申报表）' } };
    const projectId = String(b.projectId || '').trim();
    if (!/^\d+$/.test(projectId)) return { status: 400, body: { ok: false, error: 'projectId 必须为天源数字项目 ID' } };
    const companyIds = String(b.companyIds || '').trim();
    if (companyIds && !/^\d+(,\d+)*$/.test(companyIds)) return { status: 400, body: { ok: false, error: 'companyIds 必须为数字逗号列表' } };
    // 浏览器插件的申报表流程只做申报表格式整理；公式恢复用于明细表。
    const restoreFormulas = b.kind === 'detail' && b.restoreFormulas !== false;
    const applyFormat = b.applyFormat !== false;
    if (!restoreFormulas && !applyFormat) return { status: 400, body: { ok: false, error: '恢复公式与设置格式至少启用一项' } };
    if (!skillsDir) return { status: 500, body: { ok: false, error: '未找到整理脚本目录（asset-link-restore/restore_links.py）；可设 TIANYUAN_PRINT_SKILLS_DIR 指向 print-format-skills' } };
    const linkScript = join(skillsDir, 'asset-link-restore', 'scripts', 'restore_links.py');
    const fmtScript = join(skillsDir, cfg.fmt);
    if (applyFormat && !existsSync(fmtScript)) return { status: 500, body: { ok: false, error: '未找到格式脚本：' + fmtScript } };

    const tycpv = [process.env.TYCPV_BIN, '/usr/local/bin/tycpv', '/opt/homebrew/bin/tycpv'].find(x => x && existsSync(x)) || 'tycpv';
    const pyBin = existsSync(WORKBENCH_VENV_PY) ? WORKBENCH_VENV_PY : 'python3';
    const verifyZip = (p) => runCli(pyBin, ['-c', 'import sys,zipfile; sys.exit(0 if zipfile.ZipFile(sys.argv[1]).testzip() is None else 2)', p], 120000);
    const tail = (s, n) => String(s || '').trim().split(/\r?\n/).filter(Boolean).slice(-n).join(' ｜ ');

    const st0 = await store.config();
    const folder = safeFolderName((String(b.projectCode || '') + ' ' + String(b.projectName || '')).trim()) || projectId;
    let outputRoot = join(st0.dir, '导出');
    if (b.outputDir != null && b.outputDir !== '') {
      if (typeof b.outputDir !== 'string' || !isAbsolute(b.outputDir)) return { status: 400, body: { ok: false, error: '输出目录必须是已存在的绝对路径' } };
      try {
        outputRoot = await realpath(b.outputDir);
        if (!(await stat(outputRoot)).isDirectory()) throw new Error('not a directory');
      } catch (_) { return { status: 400, body: { ok: false, error: '输出目录不存在或不是文件夹' } }; }
    }
    // 批次直接位于输出根目录；mkdtemp 原子创建，避免同一时刻的导出冲突。
    const batchTime = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    await mkdir(outputRoot, { recursive: true });
    outDir = await mkdtemp(join(outputRoot, folder + '-' + cfg.label + '-' + batchTime + '-'));
    rememberExportBatch(await realpath(outDir));
    setProg({ stage: 'export', msg: '正在调用 tycpv 导出（可能需要几分钟）…' });

    // 逐公司调用 CLI（各自独立输出目录）：公司 ID 与输出文件的对应关系才可靠，
    // 一次批量调用只有文件名，靠文件名猜公司属于猜测，禁止。
    const idList = companyIds ? companyIds.split(',') : [];
    const cliResults = [];
    if (!idList.length) {
      const args = [cfg.sub, '-p', projectId, '-o', outDir];
      const cli = await runCli(tycpv, args, 15 * 60 * 1000);
      if (cli.code !== 0) {
        clearProg();
        const why = tail(cli.stderr, 3) || tail(cli.stdout, 3);
        if (/缺少 MCP token|本地登录.*过期/i.test(why)) return { status: 401, body: { ok: false, outDir, error: 'CLI 没有可用凭据。请到「工作 → 连接设置」点击「授权 CLI」并完成浏览器登录；MCP 和 CLI 授权相互独立。' } };
        return { status: 502, body: { ok: false, outDir, error: 'tycpv 导出失败（退出码 ' + cli.code + '）。请检查 CLI 授权和项目权限。' } };
      }
      cliResults.push(outDir);
    } else {
      for (const [ci, cid] of idList.entries()) {
        const perDir = join(outDir, cid);
        await mkdir(perDir, { recursive: true });
        setProg({ stage: 'export', done: ci, total: idList.length, msg: '正在导出公司 ' + cid + '（' + (ci + 1) + '/' + idList.length + '）…' });
        const args = [cfg.sub, '-p', projectId, '-c', cid, '-o', perDir];
        const cli = await runCli(tycpv, args, 15 * 60 * 1000);
        if (cli.code !== 0) {
          const why = tail(cli.stderr, 3) || tail(cli.stdout, 3);
          if (/缺少 MCP token|本地登录.*过期/i.test(why)) return { status: 401, body: { ok: false, outDir, error: 'CLI 没有可用凭据。请到「工作 → 连接设置」点击「授权 CLI」并完成浏览器登录；MCP 和 CLI 授权相互独立。' } };
          // 非零退出不能以部分文件存在推断成功；保留批次供排查，不进入后处理。
          clearProg();
          return { status: 502, body: { ok: false, outDir, error: 'tycpv 导出公司 ' + cid + ' 失败（退出码 ' + cli.code + '）；已有文件可能不完整，未进行后处理：' + why } };
        }
        cliResults.push(perDir);
      }
    }
    const after = new Set(); await walkXlsx(outDir, after);
    const exported = [...after];

    if (!exported.length) { clearProg(); return { status: 500, body: { ok: false, outDir, error: 'tycpv 已退出但目录里没有新 xlsx：' + outDir } }; }
    setProg({ stage: 'process', done: 0, total: exported.length, file: '', msg: '开始逐个工作簿整理…' });

    // 页脚配置：按请求里的公司 ID 精确匹配；CLI 若按公司分了子目录（目录名是公司 ID），
    // 目录里的工作簿直接绑定该 ID；目录名对不上任何所选公司 ID 的工作簿不写页脚（不猜文件名）。
    const footerByCompany = new Map();
    const footerWarnings = [];
    if (b.applyFooters !== false) {
      try {
        const fstore = await readFooterStore();
        const projFooters = fstore[projectId] || {};
        if (!companyIds && Object.keys(projFooters).length) footerWarnings.push('未指定公司，无法可靠匹配公司页脚，本批次未写入页脚。');
        const wanted = new Set(companyIds ? companyIds.split(',') : []);
        for (const srcPath of exported) {
          const segs = relative(outDir, dirname(srcPath)).split(sep).filter(Boolean);
          // 只有逐公司 CLI 创建的第一层目录可证明身份；深层数字可能是项目编号。
          const compSeg = segs[0] && wanted.has(segs[0]) ? segs[0] : undefined;
          if (compSeg && normalizeFooterEntry(projFooters[compSeg])) {
            footerByCompany.set(srcPath, normalizeFooterEntry(projFooters[compSeg]));
          }
        }
      } catch (err) { footerWarnings.push('页脚配置读取失败，未写入页脚：' + String(err && err.message || err)); }
    }

    const results = [];
    for (const [fi, src] of exported.entries()) {
      // basename 而不是切 '/'：Windows 反斜杠路径会切出带盘符的非法文件名。
      const base = basename(src);
      const dot = base.lastIndexOf('.');
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : '';
      const dir = dirname(src);
      const stageStem = '.' + stem + '.tianyuan-workflow-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const stage = join(dir, stageStem + ext);
      const reportTemp = join(dir, stageStem + '_链接恢复对比报告.xlsx');
      const stages = [];
      const warnings = [...footerWarnings];
      let reportPath = null, reportLinked = false;
      setProg({ stage: 'process', done: fi, total: exported.length, file: stem, msg: '正在整理：' + stem });
      try {
        await copyFile(src, stage);
        if (restoreFormulas) {
          const r = await runCli(pyBin, [linkScript, stage], 5 * 60 * 1000);
          if (r.code !== 0) throw new Error('恢复公式失败：' + (tail(r.stderr, 3) || tail(r.stdout, 3) || ('退出码 ' + r.code)));
          const gen = join(dir, stageStem + '_链接恢复' + ext);
          if (!existsSync(gen)) throw new Error('恢复公式没有产出：' + gen);
          await rename(gen, stage);
          stages.push('restore_formulas');
          if (existsSync(reportTemp)) reportPath = join(dir, stem + '_链接恢复对比报告.xlsx');
        }
        if (applyFormat) {
          // 申报脚本的格式动作保留；其自带的正则平移插删行跳过（--skip-fill），
          // 增删行统一由下方 safe_fill_rows（结构规则 + LibreOffice 桥）完成。
          const fmtArgs = [fmtScript, stage, '--no-backup'];
          if (b.kind === 'declare') fmtArgs.push('--skip-fill');
          const r = await runCli(pyBin, fmtArgs, 5 * 60 * 1000);
          if (r.code !== 0) throw new Error('设置格式失败：' + (tail(r.stderr, 3) || tail(r.stdout, 3) || ('退出码 ' + r.code)));
          stages.push('apply_format');
        }
        // 页脚写入必须排在格式整理之后：申报格式脚本会清掉 right 页脚的评估人员模板，
        // 先写会被清空；restore 脚本不碰页脚，但同样在其后写入最稳妥。
        const footerInfo = footerByCompany.get(src);
        if (footerInfo) {
          const fargs = [FOOTER_SCRIPT, '--workbook', stage, '--kind', String(b.kind)];
          if (footerInfo.preparer) fargs.push('--preparer', footerInfo.preparer);
          if (footerInfo.date) fargs.push('--date', footerInfo.date);
          if (b.kind === 'detail' && footerInfo.appraisers) fargs.push('--appraisers', footerInfo.appraisers);
          const fr = await runCli(pyBin, fargs, 120000);
          if (fr.code !== 0) throw new Error('写入页脚失败：' + (tail(fr.stderr, 3) || tail(fr.stdout, 3) || ('退出码 ' + fr.code)));
          stages.push('footer');
        }
        // 打印页空白安全增删行：明细与申报同一逻辑，按通用结构规则执行；
        // 不确定即跳过并告警，不阻断导出。
        if (b.applyFill !== false) {
          const fillJavaHome = process.env.TY_FILL_JAVA_HOME || join(homedir(), '.tianyuan-workbench', 'dependencies', 'jdk-17', 'Contents', 'Home');
          const fillSoffice = '/Applications/LibreOffice.app/Contents/MacOS/soffice';
          const fillJars = '/Applications/LibreOffice.app/Contents/Resources/java';
          const fillBridge = join(dirname(fileURLToPath(import.meta.url)), 'tools', 'uno_bridge', 'row_bridge.py');
          const fillReady = existsSync(fillJavaHome) && existsSync(fillSoffice)
            && existsSync(fillJars) && existsSync(SAFE_FILL_SCRIPT) && existsSync(fillBridge);
          if (!fillReady) {
            warnings.push('自动增删行已暂停：缺少 LibreOffice/JDK 桥组件，未执行此步骤。');
          } else {
            const fillOut = join(dir, stageStem + '_filled.xlsx');
            const fargs = [SAFE_FILL_SCRIPT, '--workbook', stage, '--output', fillOut, '--kind', String(b.kind),
              '--java-home', fillJavaHome, '--soffice', fillSoffice, '--uno-jars', fillJars, '--bridge', fillBridge];
            const g = await runCli(pyBin, fargs, 600000);
            let parsed = null;
            try { parsed = JSON.parse((g.stdout || '').trim().split('\n').pop()); } catch (_) {}
            if (g.code === 0 && parsed && parsed.ok && Array.isArray(parsed.changed) && parsed.changed.length > 0) {
              await rename(fillOut, stage);
              const totalRows = parsed.changed.reduce((n, c) => n + (c.rows || 0), 0);
              stages.push('safe_fill_rows:' + parsed.changed.length + '表' + totalRows + '行');
              for (const c of parsed.changed) warnings.push(`自动增删行：${c.sheet} ${c.op === 'insert' ? '插入' : '删除'} ${c.rows} 空白行以填满打印页。`);
            } else {
              const reasons = parsed && Array.isArray(parsed.skipped)
                ? parsed.skipped.map(s => s.reason).filter(r => r && r !== 'unsupported_template').slice(0, 3).join('、') : '';
              try { await rm(fillOut, { force: true }); } catch (_) {}
              warnings.push('自动增删行已暂停：' + (g.code !== 0 ? ('执行失败 ' + g.code) : (reasons ? '工作表未匹配安全模板（' + reasons + '）' : '无符合安全条件的调整')) + '。');
            }
          }
        } else {
          warnings.push('打印页空白的自动增删行未启用。');
        }
        const v = await verifyZip(stage);
        if (v.code !== 0) throw new Error('文件校验失败（zip 结构异常）');
        // 报告先以不覆盖方式发布；若工作簿提交失败，撤销本次报告发布。
        if (reportPath) { await link(reportTemp, reportPath); reportLinked = true; }
        await rename(stage, src);
        if (reportLinked) { try { await rm(reportTemp); } catch (_) {} }
        results.push({ ok: true, sourcePath: src, outputPath: src, reportPath, stages, warnings });
      } catch (fe) {
        if (reportLinked) { try { await rm(reportPath); } catch (_) {} }
        try { if (existsSync(stage)) await rm(stage); } catch (e) {}
        try { if (existsSync(reportTemp)) await rm(reportTemp); } catch (e) {}
        results.push({ ok: false, sourcePath: src, reason: String((fe && fe.message) || fe) });
      }
    }
    const successCount = results.filter(r => r.ok).length;
    clearProg();
    return {
      status: 200,
      body: {
        ok: successCount > 0,
        kind: String(b.kind || ''), label: cfg.label, projectId,
        outDir, total: results.length, successCount, failedCount: results.length - successCount,
        results,
      },
    };
  } catch (e) {
    return { status: 500, body: { ok: false, ...(outDir ? { outDir } : {}), error: String((e && e.message) || e) } };
  }
}

// ---------- 助手对话（工作台页面内的浮动对话窗） ----------
//
// 设计取舍：**不在插件里自建 agent 循环**。
// 工作台需要的只是「带工作台上下文的问答 + 少量确定性动作」，走 llm.stream 单轮最稳；
// 自建 tool-call 循环风险很高——DeepSeek adapter 对 tool_use / tool_result 的配对顺序
// 极其敏感（`dsh-llm-deepseek/lib/index.js` 里 tool_result 必须紧跟对应 tool_use，否则直接
// 抛 `DeepSeek Messages tool calls need immediate results`），模型一旦漏调就整轮失败。
// 所以：模型只负责解释、建议、写文案；真正动数据的操作仍然留在按钮和确定性命令里。
const ASSISTANT_MAX_TURNS = 12;
const ASSISTANT_MAX_CHARS = 8000;

const ASSISTANT_SYSTEM = [
  '你是「个人工作台」内置的助手，服务对象是一位资产评估师。',
  '工作台里有：项目管理（承接→归档的阶段与工时）、文件库（项目资料检索与问答）、',
  '天源评估系统对接（MCP 与 tycpv CLI 两条独立授权通道）、明细表/申报表导出、报告格式整理。',
  '',
  '规则：',
  '1. 回答依据 = 下面给出的工作台上下文 + 你可以调用的只读工具返回结果 + 用户的话。上下文和工具结果都没写的具体数字，一律说「没有查到」，不要编。',
  '2. 查天源系统的项目、公司、评估结论、汇总数据时，直接调用提供的只读工具（先 get_my_projects 找到项目 ID，再查公司、再查汇总），不要让用户自己去系统里查。',
  '3. 你不执行任何写操作；提供的工具都是只读查询。用户要导出、改项目状态、改数据时，告诉他去哪个页面点哪个按钮。',
  '4. 回答用中文，简洁，优先给结论和下一步动作，不要写客套话。',
  '5. 涉及金额、日期、比例时原样引用工具结果或上下文里的值，不要换算或补全。',
].join('\n');

// 天源只读工具白名单：只放查询类 MCP 工具，写操作（execute_*/save_*/import）一律不放。
// schema 直接写简化版 JSON Schema，宿主 adapter 会原样透传给 provider。
const TY_TOOL_MAX_HOPS = 4;      // 一次提问最多跑几轮「模型→工具→模型」
const TY_TOOL_MAX_CHARS = 12000; // 单个工具结果回填给模型的最大字符数
const ASSISTANT_TOOLS = [
  {
    name: 'get_my_projects',
    description: '列出当前账号在天源评估系统里的全部项目（含项目 ID、编号、名称、评估对象、状态）。回答任何天源相关问题的第一步。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_project_companies',
    description: '列出某个天源项目下的公司（股权/被评估单位）列表，返回公司数字 ID。需要先有项目 ID。',
    parameters: { type: 'object', properties: { projectId: { type: 'integer', description: '天源数字项目 ID（get_my_projects 返回的 id）' } }, required: ['projectId'] },
  },
  {
    name: 'get_project_summary',
    description: '取天源项目汇总表：评估方法、整体评估价值、账面价值、增值额/增值率等合计数据。',
    parameters: { type: 'object', properties: { projectId: { type: 'integer', description: '天源数字项目 ID' } }, required: ['projectId'] },
  },
  {
    name: 'get_company_asset_based_approach_summary',
    description: '取某公司在本项目下资产基础法的汇总：账面价值、评估价值、增值额、增值率。',
    parameters: { type: 'object', properties: { projectId: { type: 'integer', description: '天源数字项目 ID' }, companyId: { type: 'integer', description: '公司数字 ID（get_project_companies 返回）' } }, required: ['projectId', 'companyId'] },
  },
];

// 把 MCP 工具结果压成模型能吃下的一小段 JSON 文本。get_my_projects 原始返回 25KB+，必须先瘦身。
function compactTyToolResult(name, res) {
  let data = res && res.data;
  if (data === null || data === undefined) {
    const sc = res && res.structuredContent;
    data = sc !== null && sc !== undefined ? sc : '';
  }
  if (name === 'get_my_projects' && Array.isArray(data)) {
    data = data.slice(0, 100).map(p => ({
      id: p && p.id,
      projectName: p && p.projectName,
      projectCode: p && p.projectCode,
      assessmentObject: p && p.assessmentObject,
      projectStatus: p && p.projectStatus,
    }));
  }
  let text;
  try { text = JSON.stringify(data); } catch (e) { text = String(data); }
  if (text.length > TY_TOOL_MAX_CHARS) text = text.slice(0, TY_TOOL_MAX_CHARS) + '…（结果过长已截断）';
  return JSON.stringify({ isError: !!(res && res.isError), data: text });
}

// 单个白名单工具的安全执行：名字必须在白名单内、参数必须是对象、异常兜底成错误文本。
async function callTyToolSafe(ctx, call) {
  const def = ASSISTANT_TOOLS.find(t => t.name === call.name);
  if (!def) return JSON.stringify({ error: '该工具不在只读白名单内，已拒绝执行：' + String(call.name) });
  let args = {};
  try { args = typeof call.arguments === 'string' ? (call.arguments ? JSON.parse(call.arguments) : {}) : (call.arguments || {}); }
  catch (e) { return JSON.stringify({ error: '工具参数不是合法 JSON：' + String((e && e.message) || e) }); }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return JSON.stringify({ error: '工具参数必须是对象' });
  try {
    const res = await ty.callTool(call.name, args);
    return compactTyToolResult(call.name, res);
  } catch (e) {
    return JSON.stringify({ error: '天源 MCP 调用失败：' + String((e && e.message) || e) });
  }
}

// 把工作台现状压成一段文本喂给模型。只读，不写盘，不含任何凭据。
async function assistantContext(ctx) {
  const lines = [];
  const today = new Date();
  const pad = n => String(n).padStart(2, '0');
  lines.push('当前日期：' + today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate()));
  try {
    const st = await store.readState();
    const work = (st && st.data && st.data.work) || {};
    const projects = Array.isArray(work.projects) ? work.projects : [];
    const logs = Array.isArray(work.logs) ? work.logs : [];
    const sumHours = logs.reduce((a, l) => a + (Number(l && l.hours) || 0), 0);
    lines.push('项目数：' + projects.length + '；工时记录：' + logs.length + ' 条，合计 ' + (Math.round(sumHours * 10) / 10) + ' 小时');
    if (projects.length) {
      lines.push('项目清单（编号 | 名称 | 客户 | 阶段 | 截止 | 天源ID）：');
      for (const p of projects.slice(0, 25)) {
        const hours = logs.filter(l => l && l.projectId === p.id).reduce((a, l) => a + (Number(l.hours) || 0), 0);
        lines.push('- ' + [p.code || '-', p.name || '-', p.client || '-', p.stage || '-', p.deadline || '-', p.tyId || '-'].join(' | ')
          + (hours ? ' | 已投入 ' + (Math.round(hours * 10) / 10) + 'h' : ''));
      }
      if (projects.length > 25) lines.push('（仅列出前 25 个，共 ' + projects.length + ' 个）');
    }
  } catch (e) {
    lines.push('项目数据读取失败：' + String((e && e.message) || e));
  }
  try {
    const s = await ty.status();
    lines.push('天源 MCP：' + (s && s.connected ? '已绑定' : (s && s.expired ? '授权已过期' : '未绑定'))
      + (s && s.expiresAt ? '，有效期至 ' + String(s.expiresAt).slice(0, 16).replace('T', ' ') : ''));
  } catch (e) { lines.push('天源 MCP：状态读取失败'); }
  try {
    const c = cliAuth.status();
    lines.push('tycpv CLI：' + (!c || !c.installed ? '未安装' : (c.authenticated ? '本地凭据有效' : '无有效本地凭据'))
      + (c && c.expiresAt ? '，至 ' + String(c.expiresAt).slice(0, 16).replace('T', ' ') : ''));
  } catch (e) { lines.push('tycpv CLI：状态读取失败'); }
  return lines.join('\n');
}

// 确定性命令：不花模型额度，直接返回结构化事实。用户在对话里打 / 开头即可。
async function assistantCommand(ctx, text) {
  const cmd = String(text || '').trim();
  if (!/^\//.test(cmd)) return null;
  // 先剥掉行首的 /，再切词；否则「/项目」会整体落进被丢弃的第 0 段，name 恒为 undefined。
  const [name, ...rest] = cmd.slice(1).split(/\s+/);
  const arg = rest.join(' ');
  if (name === '项目' || name === 'projects') {
    const st = await store.readState();
    const projects = ((st && st.data && st.data.work && st.data.work.projects) || []);
    if (!projects.length) return '工作台里还没有项目。到「工作 → 天源项目」添加，或从「天源同步」拉取。';
    const kw = arg.trim();
    const hit = kw ? projects.filter(p => [p.code, p.name, p.client].some(v => String(v || '').includes(kw))) : projects;
    if (!hit.length) return '没有匹配「' + kw + '」的项目。';
    return hit.slice(0, 30).map(p => '- ' + (p.code || '（无编号）') + ' ' + (p.name || '') +
      (p.stage ? '（' + p.stage + '）' : '') + (p.tyId ? ' · 天源ID ' + p.tyId : '')).join('\n');
  }
  if (name === '状态' || name === 'status') {
    return await assistantContext(ctx);
  }
  if (name === '导出' || name === 'export') {
    return [
      '导出我不代劳，需要你在界面上点——因为要选公司和确认输出位置：',
      '1. 打开「工作 → 天源项目」，找到目标项目；',
      '2. 在操作列点「导出明细表」或「导出申报表」；',
      '3. 在弹出的面板里勾选公司、确认输出目录，再点开始。',
      '明细表默认会恢复公式并设置打印格式；申报表只设置打印格式（不改公式），两者步骤不同。',
    ].join('\n');
  }
  return '可用命令：/项目 [关键词]、/状态、/导出。';
}

// 把一次对话跑成 SSE 流。前端用 fetch + ReadableStream 读，逐块渲染。
async function runAssistantChat(ctx, req) {
  const body = await req.json().catch(() => ({}));
  const raw = Array.isArray(body && body.messages) ? body.messages : [];
  const turns = [];
  for (const m of raw.slice(-ASSISTANT_MAX_TURNS)) {
    if (!m || typeof m.content !== 'string') continue;
    const text = m.content.trim();
    if (!text) continue;
    if (m.role === 'assistant') {
      // 历史里的 assistant 消息必须带 source（provider-adapter 会读 source.replayState，
      // 缺 source 会抛 `Cannot read properties of undefined (reading 'replayState')`，
      // pi-ai adapter 的 toPiAssistant 是无条件读取）。kind:'model' 且无 replayState 时
      // 各 adapter 都按「外来助手内容」降级处理，正好是我们要的纯文本历史。
      turns.push({
        role: 'assistant',
        content: [{ type: 'text', text: text.slice(0, ASSISTANT_MAX_CHARS) }],
        source: { kind: 'model', provider: 'workbench-history', model: 'text' },
      });
    } else {
      turns.push({ role: 'user', content: [{ type: 'text', text: text.slice(0, ASSISTANT_MAX_CHARS) }] });
    }
  }
  if (!turns.length) return json({ error: '缺少对话内容' }, 400);

  const encoder = new TextEncoder();
  const last = turns[turns.length - 1];
  const lastText = last.role === 'user' ? (last.content[0] && last.content[0].text) || '' : '';

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = obj => {
        if (closed) return;
        try { controller.enqueue(encoder.encode('data: ' + JSON.stringify(obj) + '\n\n')); } catch (e) { closed = true; }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        try { controller.enqueue(encoder.encode('data: [DONE]\n\n')); } catch (e) {}
        try { controller.close(); } catch (e) {}
      };
      try {
        send({ type: 'meta', stage: 'context' });

        // 确定性命令优先：不消耗模型，也不会被模型改写。
        const cmdOut = await assistantCommand(ctx, lastText);
        if (cmdOut !== null) {
          send({ type: 'text', text: cmdOut });
          send({ type: 'done', mode: 'command' });
          finish();
          return;
        }

        const llm = readLlm(ctx);
        if (!llm || typeof llm.stream !== 'function') {
          send({ type: 'error', message: '宿主没有可用的模型服务。' + (await modelDiagnostics(ctx)) });
          finish();
          return;
        }
        let selection = null;
        if (body && body.provider && body.model) selection = { provider: String(body.provider), model: String(body.model) };
        else selection = await resolveModel(ctx);
        if (!selection || !selection.provider || !selection.model) {
          send({ type: 'error', message: '没有可用的模型（可用提供方为空）。' + (await modelDiagnostics(ctx)) });
          finish();
          return;
        }

        send({ type: 'meta', stage: 'model', provider: selection.provider, model: selection.model });
        const contextText = await assistantContext(ctx);
        const system = ASSISTANT_SYSTEM + '\n\n【工作台上下文】\n' + contextText;

        const abort = new AbortController();
        const onAbort = () => { try { abort.abort(); } catch (e) {} };
        try { if (req.signal) req.signal.addEventListener('abort', onAbort); } catch (e) {}
        const timer = setTimeout(() => { try { abort.abort(); } catch (e) {} }, 180000);
        if (timer.unref) timer.unref();

        const baseOptions = {
          provider: selection.provider,
          model: selection.model,
          system,
          temperature: 0.3,
          maxTokens: 2400,
          signal: abort.signal,
          purpose: 'workbench-assistant-chat',
        };
        if (selection.reasoningEffort) baseOptions.reasoningEffort = selection.reasoningEffort;

        // 有界工具循环：模型可调用天源只读工具。finish 为 tool-calls 时逐个执行，
        // 结果以 role:'tool' 紧跟回填（DeepSeek adapter 要求 tool_result 必须紧跟
        // 对应 tool_use，顺序错会抛 `tool calls need immediate results`）。
        // 最多 TY_TOOL_MAX_HOPS 轮，防止模型无限递归调用。
        let text = '';
        let usage = null;
        const convo = turns.slice();
        try {
          for (let hop = 0; hop <= TY_TOOL_MAX_HOPS; hop += 1) {
            const options = Object.assign({}, baseOptions, { messages: convo, tools: ASSISTANT_TOOLS });
            let roundText = '';
            let finishKind = null;
            const calls = [];
            const callIndex = new Map();
            for await (const chunk of llm.stream(options)) {
              if (chunk.type === 'text-delta') {
                roundText += chunk.text;
                send({ type: 'text', text: chunk.text });
              } else if (chunk.type === 'tool-call-delta') {
                const i = chunk.index;
                let entry = callIndex.get(i);
                if (!entry) { entry = { id: chunk.id || '', name: chunk.name || '', arguments: '' }; callIndex.set(i, entry); }
                if (chunk.id) entry.id = chunk.id;
                if (chunk.name) entry.name = chunk.name;
                entry.arguments += chunk.argumentsDelta || '';
              } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'tool-call') {
                calls.push(chunk.block);
              } else if (chunk.type === 'usage') {
                usage = chunk.usage;
              } else if (chunk.type === 'finish') {
                const reason = chunk.reason;
                finishKind = reason && reason.kind;
                if (finishKind === 'error') {
                  const m = (reason.failure && reason.failure.message) || '模型返回错误';
                  send({ type: 'error', message: m });
                } else if (finishKind === 'aborted') {
                  send({ type: 'error', message: '本轮被中断（超时或取消）。' });
                }
              }
            }
            text += roundText;
            // 某些 adapter 只有 delta 没有 block-end：从累积的 delta 兜底拼出完整 tool-call。
            if (calls.length === 0 && callIndex.size > 0) {
              for (const entry of callIndex.values()) calls.push({ type: 'tool-call', id: entry.id || 'call-' + calls.length, name: entry.name, arguments: entry.arguments });
            }
            if (finishKind === 'error' || finishKind === 'aborted') break;
            if (finishKind !== 'tool-calls' || calls.length === 0) break;
            const content = [];
            if (roundText) content.push({ type: 'text', text: roundText });
            for (const c of calls) content.push({ type: 'tool-call', id: c.id, name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments || {}) });
            convo.push({ role: 'assistant', content, source: { kind: 'model', provider: selection.provider, model: selection.model } });
            for (const call of calls) {
              const label = ASSISTANT_TOOLS.find(t => t.name === call.name);
              send({ type: 'tool', name: call.name, label: label ? label.description : '' });
              const outText = await callTyToolSafe(ctx, call);
              convo.push({ role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: outText }] });
            }
          }
        } catch (e) {
          send({ type: 'error', message: '调用模型失败：' + String((e && e.message) || e) });
        } finally {
          clearTimeout(timer);
          try { if (req.signal) req.signal.removeEventListener('abort', onAbort); } catch (e) {}
        }
        send({ type: 'done', mode: 'model', provider: selection.provider, model: selection.model, usage: usage || null, chars: text.length });
        finish();
      } catch (e) {
        if (!closed) {
          try { controller.enqueue(encoder.encode('data: ' + JSON.stringify({ type: 'error', message: String((e && e.message) || e) }) + '\n\n')); } catch (_) {}
        }
        try { controller.close(); } catch (_) {}
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    },
  });
}

export function apply(ctx) {
  // 幂等：宿主半侧有两个 entry（主包 + 仅宿主的包装包）都会 apply，
  // 用下面的「路由归属表」保证同一路径只注册一次。
  //
  // 另有一条老经验：包装包改代码要用 ?rev=N 换模块 URL 才会重新求值，
  // 否则先跑完的主包（旧缓存代码，没有新增的 /lib/* 路由）会把新代码挡在门外，
  // 表现为重启后文件库仍报 404。
  const G = globalThis;
  // 版本号写进 ~/.dsh/workbench-host-applied.json 的 rev 字段，排障时用来确认
  // 运行中的进程到底加载了哪一版宿主代码。改了宿主逻辑就往上加一。
  const REV = 'rev58-generic-fill-declare';
  // 路由归属表：path -> 「注册它的那个 apply() 实例」的 token。
  //
  // 为什么不用「REV 布尔标记挡住第二次 apply」：宿主半侧有两个 entry（主包 + 仅宿主的
  // 包装包），启动时确实需要去重；但 HMR 重载是「先停止旧的、再启动新的」，若仍用布尔
  // 标记，同一版代码重载时新实例直接 return，而旧实例的路由已被 dispose —— 结果一条路由
  // 都不剩、整个文件库 404。改成按实例认领/释放，既能去重也能正确交接。
  G.__dshWorkbenchRouteOwners = G.__dshWorkbenchRouteOwners || new Map();
  const routes = [
    {
      // 项目下的被评估公司 **及每家公司配置了哪些报告类型**。
      //
      // 为什么不用 MCP 的 get_project_companies：那个只给公司名和 id，
      // 拿不到 reportConfigList，前端就只能无条件列出「报告/说明/长投」三选一。
      // 而天源里有的公司连「评估报告」这个类型都没建（reportConfigList 为空），
      // 用户选完只会看到「0 个版本」，还被告知「点重新生成」——必然失败。
      // 这里把真实配置带出来，界面上就能直说「这家公司没有配置报告类型」。
      path: PREFIX + '/ty/report-companies', methods: ['GET'], fetch: async (req) => {
        try {
          const u = new URL(req.url, 'http://127.0.0.1');
          const projectId = u.searchParams.get('projectId');
          if (!/^\d+$/.test(String(projectId || ''))) return json({ ok: false, error: 'projectId 必须为数字' }, 400);
          // 类型配置只有浏览器侧读得到（/ty/api/company/list 的 reportConfigList）。
          // 浏览器不可用时退回 MCP 拿公司名，types 给 null 表示"未知"——
          // 前端据此放开三个类型但仍然提示未能确认配置，不要假装知道。
          let companies = [];
          let via = 'browser';
          let typesKnown = true;
          try {
            const rows = await rb.listCompanyTypes(String(projectId));
            companies = rows.map(c => ({
              id: String(c.id),
              name: String(c.name || ''),
              types: Array.isArray(c.types) ? c.types.map(Number).filter(t => [1, 2, 3].includes(t)) : [],
            }));
          } catch (browserErr) {
            via = 'mcp';
            typesKnown = false;
            const res = await ty.callTool('get_project_companies', { projectId: Number(projectId) });
            const d = res && res.data;
            const list = Array.isArray(d) ? d : (d && (d.list || d.companies || d.data)) || [];
            companies = list.map(c => {
              const raw = c && (c.id != null ? c.id : c.companyId);
              return { id: raw == null ? '' : String(raw), name: String((c && (c.name || c.companyName)) || ''), types: null };
            }).filter(c => /^\d+$/.test(c.id));
            if (!companies.length) throw browserErr;
          }
          return json({ ok: true, companies, via, typesKnown });
        } catch (e) {
          const friendly = explainBrowserError(e);
          const code = (e && e.code === 'UNAUTHENTICATED') || friendly ? 401 : 500;
          return json({ ok: false, error: friendly || String(e.message || e), code: e && e.code }, code);
        }
      },
    },
    {
      // 该项目下「已生成、可下载」的报告版本清单，供「报告比对」选原版用。
      // 只读、只暴露版本与大小，不碰节点正文。
      path: PREFIX + '/ty/report-versions', methods: ['GET'], fetch: async (req) => {
        try {
          const u = new URL(req.url, 'http://127.0.0.1');
          const projectId = u.searchParams.get('projectId');
          const companyId = u.searchParams.get('companyId');
          const reportType = u.searchParams.get('reportType');
          if (!/^\d+$/.test(String(projectId || ''))) return json({ ok: false, error: 'projectId 必须为数字' }, 400);
          if (!/^\d+$/.test(String(companyId || ''))) return json({ ok: false, error: 'companyId 必须为数字' }, 400);
          if (!/^[123]$/.test(String(reportType || ''))) return json({ ok: false, error: 'reportType 只能是 1/2/3' }, 400);
          const rows = await liveListReports(projectId);
          const mine = rows
            .filter(r => String(r.companyId) === String(companyId) && Number(r.type) === Number(reportType) && r.attachId && Number(r.jobState) === 2)
            .map(r => ({ attachId: r.attachId, version: r.version, updatedAt: r.updatedAt, creator: r.creator }))
            .sort((a, b) => Number(b.version) - Number(a.version));
          return json({ ok: true, versions: mine, user: tySession.sessionUser(), via: hasHostSession() ? 'session' : 'browser' });
        } catch (e) {
          const friendly = explainBrowserError(e);
          const code = (e && e.code === 'UNAUTHENTICATED') || friendly ? 401 : 500;
          return json({ ok: false, error: friendly || String(e.message || e), code: e && e.code }, code);
        }
      },
    },
    {
      // 只提交「按当前节点重新出一版」的任务，不等结果。
      // 前端自己轮询 /ty/report-versions 等新版本出现——生成要 1-3 分钟，
      // 挂一个长连接等下去只会被浏览器或代理掐断。
      path: PREFIX + '/ty/report-build', methods: ['POST'], fetch: async (req) => {
        try {
          const raw = await req.text();
          const body = JSON.parse(raw);
          const projectId = String(body.projectId || '');
          const companyId = String(body.companyId || '');
          const reportType = String(body.reportType || '');
          if (!/^\d+$/.test(projectId)) return json({ ok: false, error: 'projectId 不合法' }, 400);
          if (!/^\d+$/.test(companyId)) return json({ ok: false, error: 'companyId 不合法' }, 400);
          if (!/^[123]$/.test(reportType)) return json({ ok: false, error: 'reportType 只能是 1/2/3' }, 400);
          const jobId = await liveBuildReport(projectId, companyId, reportType);
          return json({ ok: true, jobId });
        } catch (e) {
          const friendly = explainBrowserError(e);
          const code = (e && e.code === 'UNAUTHENTICATED') || friendly ? 401 : 400;
          return json({ ok: false, error: friendly || String(e.message || e), code: e && e.code }, code);
        }
      },
    },
    {
      // 不需要本地导出基线：当场取线上已生成版本当原版，跟上传改稿比。
      //
      // 原版可以指定 attachId（用户在版本列表里选了旧版），留空则取最新已生成版本。
      // 比对后把 astSha256 / 完整版正文留在宿主内存，只回传一个一次性 token；
      // 写回时凭 token 取，避免前端持有并发校验所需的哈希。
      path: PREFIX + '/ty/report-compare-live', methods: ['POST'], fetch: async (req) => {
        try {
          const length = Number(req.headers.get('content-length') || 0);
          if (length > 46 * 1024 * 1024) return json({ ok: false, error: '上传文件过大' }, 413);
          const raw = await req.text();
          if (Buffer.byteLength(raw, 'utf8') > 46 * 1024 * 1024) return json({ ok: false, error: '上传文件过大' }, 413);
          const body = JSON.parse(raw);
          const projectId = String(body.projectId || '');
          const companyId = String(body.companyId || '');
          const reportType = String(body.reportType || '');
          if (!/^\d+$/.test(projectId)) return json({ ok: false, error: 'projectId 不合法' }, 400);
          if (!/^\d+$/.test(companyId)) return json({ ok: false, error: 'companyId 不合法' }, 400);
          if (!/^[123]$/.test(reportType)) return json({ ok: false, error: 'reportType 只能是 1/2/3' }, 400);
          if (body.attachId != null && body.attachId !== '' && !/^\d+$/.test(String(body.attachId))) return json({ ok: false, error: 'attachId 不合法' }, 400);
          // 不再在这里挡「未登录」：会话可能只存在于用户的浏览器里，
          // 真正的可用性由下面的 liveListReports/liveDownloadDocx 现场判定，
          // 它们的错误会被 explainBrowserError 翻成可操作的提示。
          const config = await store.config();
          // 先取原版 DOCX：列表里查不到就中止，不去猜哪一份是"线上版本"。
          const live = await fetchLiveReportDocx({ projectId, companyId, reportType, attachId: body.attachId });
          // 再抓节点树与完整版正文（写回要用），与 DOCX 同批，保证哈希与正文一致。
          const snap = await captureLiveSnapshot({ projectId, companyId, reportType });
          const result = await compareAgainstLive({
            rootDir: config.dir,
            baselineBytes: live.buf,
            // snap.online 已经是 {snapshot, evidence}，与归档通道喂给定位器的形状一致。
            online: snap.online,
            filename: body.filename,
            base64: body.base64,
          });
          // 只留并发校验必需的东西。完整版正文（snap.full）不在这里存：
          // applyWriteback 写每个节点前会自己重读 content/batch，
          // 存下来既用不上，又会让 20 条凭据各占最多 64MB 内存。
          const token = putLiveToken({
            projectId, companyId, reportType,
            astSha256: snap.astSha256,
            baselineVersion: live.version,
            baselineAttachId: live.attachId,
            companyName: live.companyName,
          });
          return json({ ok: true, result, compareToken: token, baseline: { version: live.version, attachId: live.attachId, companyName: live.companyName } });
        } catch (e) {
          const friendly = explainBrowserError(e);
          return json({ ok: false, error: friendly || String(e.message || e), code: e && e.code }, friendly || (e && e.code === 'UNAUTHENTICATED') ? 401 : 400);
        }
      },
    },
    {
      // 写回（现场比对通道）。凭 compareToken 从宿主内存取回当时抓的完整版正文与哈希。
      //
      // 与归档基线那条路的区别只在于「完整版正文/hash 从哪来」，
      // 真正的写回逻辑仍然是同一个 applyWriteback——并发校验一步都不会少。
      path: PREFIX + '/ty/report-writeback-live', methods: ['POST'], fetch: async (req) => {
        try {
          const raw = await req.text();
          if (Buffer.byteLength(raw, 'utf8') > 4 * 1024 * 1024) return json({ ok: false, error: '请求过大' }, 413);
          const body = JSON.parse(raw);
          if (body.confirm !== true) return json({ ok: false, error: '写回需要显式确认' }, 400);
          const projectId = String(body.projectId || '');
          if (!/^\d+$/.test(projectId)) return json({ ok: false, error: 'projectId 不合法' }, 400);
          const entry = takeLiveToken(body.compareToken, projectId);
          const result = await applyWriteback({
            projectId: entry.projectId,
            companyId: entry.companyId,
            reportType: Number(entry.reportType),
            // 不伪造 manifest：直接把当场抓的摘要作为期望哈希。
            expectedSha256: entry.astSha256,
            locate: body.locate,
            confirm: true,
          });
          // 凭据一次性：写回成功即作废，同一批不允许重复提交。
          liveCompareTokens.delete(String(body.compareToken));
          return json({ ok: true, result });
        } catch (e) { return json({ ok: false, error: String(e.message || e) }, 400); }
      },
    },
    {
      path: PREFIX + '/ty/report-baselines', methods: ['GET'], fetch: async (req) => {
        try {
          const projectId = new URL(req.url).searchParams.get('projectId');
          if (!/^\d+$/.test(String(projectId || ''))) return json({ ok: false, error: 'projectId 必须为数字' }, 400);
          const config = await store.config();
          const baselines = await listBaselines({ rootDir: config.dir, projectId });
          return json({ ok: true, baselines });
        } catch (e) { return json({ ok: false, error: String(e.message || e) }, 500); }
      },
    },
    {
      path: PREFIX + '/ty/report-compare', methods: ['POST'], fetch: async (req) => {
        try {
          const length = Number(req.headers.get('content-length') || 0);
          if (length > 46 * 1024 * 1024) return json({ ok: false, error: '上传文件过大' }, 413);
          // buffered 后端无法限制框架预缓冲；解析前再次检查实际字节数，不能只信 Content-Length。
          const raw = await req.text();
          if (Buffer.byteLength(raw, 'utf8') > 46 * 1024 * 1024) return json({ ok: false, error: '上传文件过大' }, 413);
          const body = JSON.parse(raw);
          const config = await store.config();
          const result = await compareUpload({ rootDir: config.dir, baselineId: body.baselineId, filename: body.filename, base64: body.base64 });
          return json({ ok: true, result });
        } catch (e) { return json({ ok: false, error: String(e.message || e) }, 400); }
      },
    },
    {
      // 把比对结果写回线上报告节点。必须在界面上二次确认后才调，confirm 缺省即拒绝。
      path: PREFIX + '/ty/report-writeback', methods: ['POST'], fetch: async (req) => {
        try {
          const raw = await req.text();
          if (Buffer.byteLength(raw, 'utf8') > 4 * 1024 * 1024) return json({ ok: false, error: '请求过大' }, 413);
          const body = JSON.parse(raw);
          if (body.confirm !== true) return json({ ok: false, error: '写回需要显式确认' }, 400);
          if (!/^\d+$/.test(String(body.projectId || ''))) return json({ ok: false, error: 'projectId 不合法' }, 400);
          if (!/^\d+$/.test(String(body.companyId || ''))) return json({ ok: false, error: 'companyId 不合法' }, 400);
          if (!/^baseline-[A-Za-z0-9]{6}$/.test(String(body.baselineId || ''))) return json({ ok: false, error: 'baselineId 不合法' }, 400);
          const config = await store.config();
          const manifest = await readManifestForWriteback({ rootDir: config.dir, baselineId: body.baselineId });
          // projectId / companyId / reportType 一律以基线 manifest 为准。
          // 前端传什么只用来核对：对不上就拒，绝不用请求里的值去写别的公司。
          const meta = (manifest && manifest.metadata) || {};
          const wantProject = String(meta.projectId || '');
          const wantCompany = String(meta.companyId || '');
          const wantType = Number(meta.reportType);
          if (wantProject !== String(body.projectId)) return json({ ok: false, error: 'projectId 与基线不一致' }, 400);
          if (wantCompany !== String(body.companyId)) return json({ ok: false, error: 'companyId 与基线不一致' }, 400);
          if (!Number.isInteger(wantType) || wantType < 1) return json({ ok: false, error: '基线缺少有效的 reportType' }, 400);
          if (body.reportType != null && String(body.reportType) !== String(wantType)) return json({ ok: false, error: 'reportType 与基线不一致' }, 400);
          const result = await applyWriteback({
            projectId: wantProject,
            companyId: wantCompany,
            reportType: wantType,
            baseline: manifest,
            locate: body.locate,
            confirm: true,
          });
          return json({ ok: true, result });
        } catch (e) { return json({ ok: false, error: String(e.message || e) }, 400); }
      },
    },
    // 报告格式接口由独立宿主 bundle 注册，避免重复绑定。
    {
      path: PREFIX + '/quotes', methods: ['GET', 'HEAD'], fetch: async (req) => {
        try {
          const u = new URL(req.url);
          const codes = String(u.searchParams.get('codes') || '').split(',').map(x => x.trim()).filter(x => /^(sh|sz|hk|us|bj)[a-zA-Z0-9.]+$/.test(x)).slice(0, 80);
          if (!codes.length) return json({});
          const buf = await getBuffer('https://qt.gtimg.cn/q=' + codes.join(','), { 'Referer': 'https://gu.qq.com/', 'User-Agent': 'Mozilla/5.0' });
          const text = decodeGbk(buf);
          const out = {};
          const re = /v_([a-z0-9]+)="([^"]*)"/g;
          let m;
          while ((m = re.exec(text))) { const q = parseQuote(m[2]); if (q) out[m[1]] = q; }
          return json(out);
        } catch (e) { return json({ error: String(e.message || e) }, 502); }
      },
    },
    {
      path: PREFIX + '/search', methods: ['GET', 'HEAD'], fetch: async (req) => {
        try {
          const u = new URL(req.url);
          const q = String(u.searchParams.get('q') || '').trim();
          if (!q) return json([]);
          const body = await getText('https://smartbox.gtimg.cn/s3/?q=' + encodeURIComponent(q) + '&t=all', { 'Referer': 'https://gu.qq.com/', 'User-Agent': 'Mozilla/5.0' });
          const m = body.match(/v_hint="([^"]*)"/);
          const raw = m ? m[1] : '';
          if (!raw || raw.indexOf('NONE') === 0) return json([]);
          const items = raw.split('^').map(row => {
            const p = row.split('~');
            return { market: p[0], code: p[0] + p[1], rawCode: p[1], name: decodeUnicode(p[2] || ''), type: p[4] || '' };
          }).filter(x => x.code && x.name && ['GP-A', 'GP', 'FJ', 'LOF', 'ETF', 'ZS'].includes(x.type)).slice(0, 12);
          return json(items);
        } catch (e) { return json({ error: String(e.message || e) }, 502); }
      },
    },
    {
      path: PREFIX + '/proxy', methods: ['POST'], fetch: async (req) => {
        try {
          const b = await req.json();
          const url = String(b.url || '');
          if (!/^https?:\/\//.test(url)) return json({ error: '仅支持 http/https 地址' }, 400);
          const headers = Object.assign({ 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }, b.headers || {});
          const text = await getText(url, headers);
          try { return json(JSON.parse(text)); } catch (e) { return json({ error: '上游返回的不是 JSON', raw: text.slice(0, 2000) }, 502); }
        } catch (e) { return json({ error: String(e.message || e) }, 502); }
      },
    },
    {
      path: PREFIX + '/ping', methods: ['GET', 'HEAD'], fetch: () => json({ ok: true, name: 'dsh-workbench', at: new Date().toISOString() }),
    },
    {
      path: PREFIX + '/ty/status', methods: ['GET', 'HEAD'], fetch: async () => { try { return json(await ty.status()); } catch (e) { return json({ error: e.message }, 500); } },
    },
    {
      path: PREFIX + '/ty/probe', methods: ['POST'], fetch: async () => {
        try { return json(await ty.probeConnection()); }
        catch (_) { return json({ connected: false, state: 'unavailable' }); }
      },
    },
    {
      path: PREFIX + '/ty/cli/status', methods: ['GET', 'HEAD'], fetch: async () => json(cliAuth.status()),
    },
    {
      path: PREFIX + '/ty/cli/login', methods: ['POST'], fetch: async () => {
        const result = cliAuth.start();
        return json(result, result.ok ? 200 : 400);
      },
    },
    {
      path: PREFIX + '/ty/login', methods: ['POST'], fetch: async (req) => {
        try { const b = await req.json().catch(() => ({})); return json(await ty.startLogin(b.credentialName)); }
        catch (e) { return json({ error: e.message }, 500); }
      },
    },
    {
      path: PREFIX + '/ty/open', methods: ['POST'], fetch: async (req) => {
        try {
          const b = await req.json().catch(() => ({}));
          const r = await openInSystemBrowser(b.url);
          return json(r, r.ok ? 200 : 400);
        } catch (e) { return json({ error: String(e.message || e) }, 500); }
      },
    },
    {
      path: PREFIX + '/ty/logout', methods: ['POST'], fetch: async () => { try { return json(await ty.logout()); } catch (e) { return json({ error: e.message }, 500); } },
    },
    {
      path: PREFIX + '/ty/token', methods: ['POST'], fetch: async (req) => {
        try { const b = await req.json().catch(() => ({})); return json(await ty.setToken(b.token)); }
        catch (e) { return json({ error: e.message }, 400); }
      },
    },
    {
      path: PREFIX + '/ty/tools', methods: ['GET', 'HEAD'], fetch: async () => { try { return json(await ty.listTools()); } catch (e) { return json({ error: e.message }, 502); } },
    },
    {
      // 同步到线上（真填表）：把工作台项目按四组页签填进天源网页表单，新建 / 更新两条路径。
      // 走 opencli 驱动用户自己的 Chrome，复用其天源登录态；
      // 保存接口永远 HTTP 200，引擎靠保存后回读判断成败，失败原因进 mismatches。
      path: PREFIX + '/ty/sync', methods: ['POST'], fetch: async (req) => {
        const g = globalThis;
        if (g.__dshWorkbenchTySyncBusy) return json({ ok: false, code: 'BUSY', msg: '上一次同步还在跑，请等它结束' }, 409);
        try {
          const b = await req.json().catch(() => ({}));
          const rec = b.project || {};
          if (!rec.name && !rec.shortName) return json({ ok: false, code: 'BAD_INPUT', msg: '缺少项目数据' }, 400);
          const data = tySyncData(rec);
          const fieldCount = data.tabs.reduce((n, t) => n + t.fields.length, 0);
          if (!fieldCount) return json({ ok: false, code: 'EMPTY', msg: '这个项目还没有可同步的字段' }, 400);
          g.__dshWorkbenchTySyncBusy = true;
          // 单一通道：opencli 驱动用户自己的 Chrome（登录态天然可用）。
          const r = await tySyncRun(data, { timeoutMs: 300000 });
          return json({ ...r, engine: 'opencli', mode: data.mode, fieldCount, headerWarnings: data.warnings });
        } catch (e) {
          return json({ ok: false, code: 'SYNC_FAIL', msg: String(e.message || e) }, 500);
        } finally {
          g.__dshWorkbenchTySyncBusy = false;
        }
      },
    },
    {
      // 排障用：确认宿主解析到的 opencli 包根
      path: PREFIX + '/ty/sync/probe', methods: ['GET', 'HEAD'], fetch: () => json({ opencliRoot: resolveOpencliRoot(), engine: 'opencli' }),
    },
    {
      // 同步通道体检：打开天源首页看登录态。只读，不写任何数据。
      path: PREFIX + '/ty/sync/login', methods: ['GET', 'HEAD', 'POST'], fetch: async () => {
        try {
          const r = await openSyncSpace().catch((e) => ({ ok: false, msg: String(e.message || e) }));
          return json({
            ok: true,
            engine: 'opencli',
            ready: !!r.ok,
            loggedIn: !!r.loggedIn,
            url: r.url || '',
            code: r.code,
            msg: r.msg || '',
          });
        } catch (e) { return json({ ok: false, msg: String(e.message || e) }, 500); }
      },
    },
    {
      path: PREFIX + '/ty/call', methods: ['POST'], fetch: async (req) => {
        try {
          const b = await req.json().catch(() => ({}));
          if (!b.name) return json({ error: '缺少工具名' }, 400);
          return json(await ty.callTool(b.name, b.arguments || {}));
        } catch (e) { return json({ error: e.message }, 502); }
      },
    },
      {
        // 登录会话注入（方案 B 兜底）：用户从已登录浏览器复制 tk/sid 粘贴；凭据仅存本进程内存
        path: PREFIX + '/ty/native/session', methods: ['POST', 'DELETE'], fetch: async (req) => {
          try {
            if (req.method === 'DELETE') { tySession.clearSession(); return json({ ok: true, cleared: true }); }
            const b = await req.json().catch(() => ({}));
            const tk = String(b.tk || '').trim();
            const sid = String(b.sid || '').trim();
            // tk 是 UUID 形态（36 字符）或无连字符 hex；sid 为数字串。避免把敏感值写日志。
            if (!/^\S{20,200}$/.test(tk)) return json({ ok: false, error: 'tk 格式不符（20-200 字符）' }, 400);
            if (sid && !/^\S{8,200}$/.test(sid)) return json({ ok: false, error: 'sid 格式不符' }, 400);
            tySession.setSession({ tk, sid: sid || undefined });
            const p = await tySession.probeSession();
            return json(p.ok && p.logged ? { ok: true, logged: true, user: p.user } : { ok: false, logged: false, reason: p.reason || p.reason === 'no_cookie' ? '会话无效或已过期' : (p.reason || '未知') }, p.ok && p.logged ? 200 : 401);
          } catch (e) { return json({ ok: false, error: String(e.message || e) }, 500); }
        },
      },
      {
        // 列出项目下公司 + 各家可导出的文档类型（reportConfigList 权威来源）
        path: PREFIX + '/ty/browser/companies', methods: ['GET', 'HEAD'], fetch: async (req) => {
          try {
            const u = new URL(req.url, 'http://127.0.0.1');
            const projectId = u.searchParams.get('projectId');
            if (!/^\d+$/.test(String(projectId || ''))) return json({ ok: false, error: 'projectId 必须为数字' }, 400);
            if (!rb.resolveOpencliBin()) return json({ ok: false, code: 'NO_OPENCLI', error: '未找到 opencli（你的浏览器通道）' }, 503);
            const companies = await rb.listCompanies(projectId);
            return json({ ok: true, companies, engine: 'browser' });
          } catch (e) {
            const code = e && e.message === 'NOT_LOGGED_IN' ? 'NOT_LOGGED_IN'
              : e && e.message === 'BRIDGE_DISCONNECTED' ? 'BRIDGE_DISCONNECTED'
              : (e && e.message) || '';
            const status = code === 'NOT_LOGGED_IN' ? 401 : (code === 'BRIDGE_DISCONNECTED' ? 424 : 500);
            return json({ ok: false, code, error: (e && (e.detail || e.message)) || String(e) }, status);
          }
        },
      },
      {
        // 浏览器通道自检 / 自愈：扩展断连时重启 opencli daemon 并等扩展重连
        path: PREFIX + '/ty/browser/bridge', methods: ['GET', 'POST'], fetch: async (req) => {
          try {
            if (!rb.resolveOpencliBin()) return json({ ok: false, code: 'NO_OPENCLI', error: '未找到 opencli（你的浏览器通道）' }, 503);
            if (req.method === 'POST') {
              const r = await rb.recoverBridgeNow();
              if (r && r.ok) return json({ ok: true, recovered: true, ms: r.ms || 0 });
              return json({ ok: false, code: 'BRIDGE_DISCONNECTED', error: r && r.detail ? ('自动重连失败：' + r.detail) : '自动重连失败' }, 424);
            }
            const h = await rb.bridgeHealth();
            return h.ok ? json({ ok: true }) : json({ ok: false, code: 'BRIDGE_DISCONNECTED', error: h.detail || '扩展未连接' }, 424);
          } catch (e) {
            return json({ ok: false, error: String(e.message || e) }, 500);
          }
        },
      },
      {
        // 探测天源登录态 + 报告列表（不写文件）
        path: PREFIX + '/ty/browser/probe', methods: ['GET', 'HEAD'], fetch: async (req) => {
          try {
            const u = new URL(req.url, 'http://127.0.0.1');
            const projectId = u.searchParams.get('projectId');
            if (!/^\d+$/.test(String(projectId || ''))) return json({ ok: false, error: 'projectId 必须为数字' }, 400);
            if (!rb.resolveOpencliBin()) return json({ ok: true, logged: false, code: 'NO_OPENCLI', error: '未找到 opencli（你的浏览器通道）', engine: 'browser' });
            try {
              const reports = await rb.listReports(projectId);
              return json({ ok: true, logged: true, reports, engine: 'browser' });
            } catch (e) {
              const code = e && e.message === 'NOT_LOGGED_IN' ? 'NOT_LOGGED_IN'
                : e && e.message === 'BRIDGE_DISCONNECTED' ? 'BRIDGE_DISCONNECTED'
                : 'PROBE_FAILED';
              return json({ ok: true, logged: false, code, error: (e && (e.detail || e.message)) || '未登录', engine: 'browser' });
            }
          } catch (e) { return json({ ok: false, error: String(e.message || e) }, 500); }
        },
      },
      {
        // 报告/说明原生导出：只走 opencli（用户真实浏览器），共享其天源登录态。
        path: PREFIX + '/ty/browser/export', methods: ['POST'], fetch: async (req) => {
          try {
            const b = await req.json().catch(() => ({}));
            const jobId = /^[A-Za-z0-9_-]{6,64}$/.test(String(b.jobId || '')) ? String(b.jobId) : '';
            if (!jobId) return json({ ok: false, error: 'jobId 无效' }, 400);
            const projectId = String(b.projectId || '');
            if (!/^\d+$/.test(projectId)) return json({ ok: false, error: 'projectId 必须为数字' }, 400);
            const items = Array.isArray(b.items) ? b.items : [];
            if (!items.length) return json({ ok: false, error: '请至少选择一份文档' }, 400);
            const applyFormat = b.applyFormat !== false;   // 默认按「报告格式」页处理表格
            for (const it of items) {
              if (!it || !/^\d+$/.test(String(it.companyId || '')) || ![1, 2, 3].includes(Number(it.type))) return json({ ok: false, error: 'items 每项需数字 companyId 与 type(1/2/3)' }, 400);
              if (!['current', 'refresh'].includes(it.mode)) return json({ ok: false, error: 'mode 必须为 current 或 refresh' }, 400);
            }

            let outDir = '';
            if (b.outputDir) {
              if (typeof b.outputDir !== 'string' || !isAbsolute(b.outputDir)) return json({ ok: false, error: '输出目录必须是绝对路径' }, 400);
              try { outDir = await realpath(b.outputDir); if (!(await stat(outDir)).isDirectory()) throw new Error(); }
              catch (_) { return json({ ok: false, error: '输出目录不存在或不是文件夹' }, 400); }
            }
            if (!outDir) {
              const st = await store.config();
              const folder = safeFolderName((String(b.projectCode || '') + ' ' + String(b.projectName || '')).trim()) || projectId;
              outDir = join(st.dir, '导出', folder, '原生');
              await mkdir(outDir, { recursive: true });
            }
            const setProg = patch => { if (exportProgress.size > 50) { let oldest = null; for (const [k, v] of exportProgress) if (!oldest || v.at < oldest.at) oldest = { k, at: v.at }; if (oldest) exportProgress.delete(oldest.k); } exportProgress.set(jobId, { at: Date.now(), ...patch }); };
            setProg({ status: 'running', stage: 'running', total: items.length, done: 0, pct: 0, files: [], errors: [], outDir, message: '连接你的浏览器…' });

            (async () => {
              try {
                setProg({ status: 'running', stage: 'running', total: items.length, done: 0, pct: 0, files: [], errors: [], outDir, engine: 'browser', message: '正在驱动你的浏览器执行导出…' });
                const normItems = items.map(i => ({ companyId: String(i.companyId), companyName: i.companyName || '', type: Number(i.type), mode: i.mode }));
                if (!rb.resolveOpencliBin()) {
                  setProg({ status: 'failed', stage: 'failed', total: items.length, done: 0, pct: 0, files: [], errors: ['未找到 opencli（你的浏览器通道）。请安装 opencli 后重试。'], outDir, message: '缺少 opencli' });
                  return;
                }
                const r = await rb.exportReports({
                  projectId, items: normItems,
                  onLog: (m) => { const cur = exportProgress.get(jobId); if (cur) setProg({ ...cur, at: Date.now(), logs: [...(cur.logs || []), m].slice(-200) }); },
                  // 抓取阶段占总进度的 0~80%：下载完还要逐份校验、归正字体、排表格，
                  // 那段时间同样在等，不能让进度条停在 80% 装死。
                  onProgress: (p) => {
                    const cur = exportProgress.get(jobId); if (!cur) return;
                    const total = Math.max(1, Number(p.total) || normItems.length || 1);
                    const pct = Math.min(80, Math.round((Math.max(0, Number(p.done) || 0) / total) * 80));
                    setProg({ ...cur, at: Date.now(), stage: 'fetching', done: Math.max(0, Number(p.done) || 0), total, pct, message: p.message || cur.message });
                  },
                });
                if (!r || !r.ok) {
                  const notLogged = r && (r.code === 'NOT_LOGGED_IN' || r.code === 'BRIDGE_DISCONNECTED');
                  const bridgeDown = r && r.code === 'BRIDGE_DISCONNECTED';
                  const msg = bridgeDown
                    ? String((r && r.detail) || (r && r.msg) || '连不上浏览器')
                    : notLogged ? '你的浏览器未登录天源：请在浏览器里登录一次后重试'
                    : String((r && (r.msg || r.code || r.detail)) || '导出失败');
                  // 失败也代表作业结束：不要把进度条打回 0，否则用户看到「跑着跑着归零」。
                  // 抓取阶段的进度保留在 cur 里，界面按已推进到哪一步显示。
                  const curFail = exportProgress.get(jobId) || {};
                  setProg({ status: 'failed', stage: 'failed', total: items.length, done: curFail.done || 0, pct: (curFail.pct == null ? 0 : curFail.pct), files: [], errors: [msg], outDir, engine: 'browser', message: bridgeDown ? '连不上浏览器' : (notLogged ? '需要登录天源' : '导出失败'), logs: (r && r.logs) || [] });
                  return;
                }
                const files = []; const errors = Array.isArray(r.errors) ? r.errors.slice() : [];
                const fmtErrors = [];
                const totalFiles = (r.files || []).length;
                let procIndex = 0;
                for (const f of (r.files || [])) {
                  const curP = exportProgress.get(jobId);
                  if (curP) setProg({ ...curP, at: Date.now(), stage: 'writing', pct: 80 + Math.round((procIndex / Math.max(1, totalFiles)) * 20), message: '正在保存并排版第 ' + (procIndex + 1) + ' / ' + totalFiles + ' 份：' + (f.companyName || '') + ' ' + (({ 1: '评估报告', 2: '评估说明', 3: '长投说明' })[Number(f.type)] || '') });
                  procIndex += 1;
                  try {
                    const buf = Buffer.from(String(f.base64 || ''), 'base64');
                    // 产物完整性校验：不凭扩展名与退出码。完整解析 ZIP + 必需部件，
                    // 损坏 ZIP / 缺 document.xml / 非 OOXML 在这里拦截，不落盘。
                    const chk = await tySession.validateDocx(buf);
                    if (!chk.ok) { errors.push((f.fileName || '未知文件') + '：下载内容校验失败——' + chk.reason); continue; }
                    const p = join(outDir, f.fileName || ('report-' + Date.now() + '.docx'));
                    // 不覆盖发布：同名已存在时落成 -2/-3 序号
                    let finalPath = p;
                    let seq = 2;
                    while (existsSync(finalPath)) { finalPath = p.replace(/\.docx$/i, '-' + seq + '.docx'); seq++; }
                    const tmpPath = finalPath + '.part';
                    await writeFile(tmpPath, buf);
                    await rename(tmpPath, finalPath);
                    const rec = { file: finalPath, company: f.companyName, companyId: f.companyId, type: f.type, version: f.version, bytes: buf.length, formatted: false };
                    // 先归正文字体（只动正文段落），再处理表格（只动表格），两步互不影响。
                    try {
                      const bf = await applyBodyFontNormalize(finalPath);
                      rec.bodyNormalized = true;
                      rec.bodyRuns = bf.runs;
                      rec.bodyFont = bf.asciiFont;
                    } catch (e) {
                      fmtErrors.push((f.fileName || '未知文件') + '：正文字体未处理（' + String(e.message || e) + '）');
                    }
                    if (applyFormat) {
                      try {
                        const fm = await applyDocxTableFormat(finalPath);
                        rec.formatted = true;
                        rec.tables = fm.tables;
                        rec.cells = fm.cells;
                        rec.formatMode = fm.mode || 'toolbox';
                        rec.skippedAttachment = fm.skippedAttachment || 0;
                        rec.skippedFormatted = fm.skippedFormatted || 0;
                        rec.reflowedUniform = fm.reflowedUniformGrids || 0;
                        rec.repairedHeaderRows = fm.repairedHeaderRows || 0;
                      } catch (e) {
                        // 格式处理失败不丢文件：保留原件，错误单列
                        fmtErrors.push((f.fileName || '未知文件') + '：表格格式未处理（' + String(e.message || e) + '）');
                      }
                    }
                    // 以实际交付的格式处理后文件为比对基线，同时抓一份同批次的线上节点树：
                    // 只有这样才能在后续比对里说清"这处改动对应线上哪一段"。
                    try {
                      const cfg = await store.config();
                      let online = null;
                      let onlineError = '';
                      try {
                        online = await captureOnlineNodes({ projectId, companyId: f.companyId, reportType: f.type });
                      } catch (e) {
                        // 快照抓不到不影响导出，如实记录原因，基线降级为 not_captured。
                        onlineError = String(e.message || e);
                      }
                      let onlineFull = null;
                      let onlineFullError = '';
                      try {
                        onlineFull = online ? await captureOnlineFullNodes({ projectId, companyId: f.companyId, reportType: f.type, document: online.document }) : null;
                        if (!online) onlineFullError = '没有线上节点树，完整版快照未抓取';
                      } catch (e) {
                        // 完整版抓不到也不影响导出：基线降级为「没有完整版」。
                        onlineFullError = String(e.message || e);
                      }
                      const saved = await archiveReportBaseline({ rootDir: cfg.dir, sourcePath: finalPath, metadata: {
                        projectId, projectName: String(b.projectName || ''), companyId: String(f.companyId || ''),
                        companyName: String(f.companyName || ''), reportType: String(f.type || ''), version: String(f.version ?? ''),
                      }, online: online || undefined, onlineFull: onlineFull || undefined });
                      rec.baselineId = basename(dirname(saved.archiveDir));
                      rec.baselineSnapshot = saved.snapshotStatus;
                      rec.baselineFull = saved.fullStatus;
                      if (onlineError) rec.baselineOnlineError = onlineError;
                      if (onlineFullError) rec.baselineFullError = onlineFullError;
                    } catch (e) {
                      rec.baselineError = String(e.message || e);
                      fmtErrors.push((f.fileName || '未知文件') + '：导出成功，但比对基线保存失败（' + rec.baselineError + '）');
                    }
                    files.push(rec);
                  } catch (e) { errors.push((f.fileName || '未知文件') + '：写入失败 ' + String(e.message || e)); }
                }
                if (fmtErrors.length) errors.push(...fmtErrors);
                const okAll = errors.length === 0 && files.length > 0;
                const fmtOk = files.filter(f => f.formatted).length;
                const fmtTables = files.reduce((n, f) => n + (f.tables || 0), 0);
                const fmtSkipAtt = files.reduce((n, f) => n + (f.skippedAttachment || 0), 0);
                const fmtSkipDone = files.reduce((n, f) => n + (f.skippedFormatted || 0), 0);
                const fmtReflow = files.reduce((n, f) => n + (f.reflowedUniform || 0), 0);
                const fmtRepaired = files.reduce((n, f) => n + (f.repairedHeaderRows || 0), 0);
                const bodyOk = files.filter(f => f.bodyNormalized).length;
                const bodyRuns = files.reduce((n, f) => n + (f.bodyRuns || 0), 0);
                const bodyFont = (files.find(f => f.bodyFont) || {}).bodyFont || '宋体';
                let suffix = '';
                if (bodyOk) {
                  suffix += bodyRuns
                    ? '，正文数字已统一为「' + bodyFont + '」（' + bodyOk + ' 份、' + bodyRuns + ' 处）'
                    : '，正文西文字体本来就符合设置，未改动';
                }
                if (applyFormat && fmtOk) {
                  if (fmtTables) {
                    suffix += '，已按「报告格式」页的表格参数处理 ' + fmtOk + ' 份的表格（共 ' + fmtTables + ' 张表）';
                  } else {
                    suffix += '，' + fmtOk + ' 份的表格本来就已经符合「报告格式」页的参数，未做改动';
                  }
                  const skips = [];
                  if (fmtRepaired) skips.push('修回了 ' + fmtRepaired + ' 行被旧版误设成重复表头的数据行');
                  if (fmtReflow) skips.push(fmtReflow + ' 张原为等宽、已按内容重排列宽');
                  if (fmtSkipDone) skips.push(fmtSkipDone + ' 张已经排好、原样未动');
                  if (fmtSkipAtt) skips.push(fmtSkipAtt + ' 张附件里的 Word 表');
                  if (skips.length) suffix += '；' + skips.join('、');
                }
                setProg({
                  status: okAll ? 'done' : (files.length ? 'partial' : 'failed'), stage: okAll ? 'done' : (files.length ? 'partial' : 'failed'),
                  total: items.length, done: items.length, pct: 100, files, errors, outDir, applyFormat, engine: 'browser',
                  message: okAll ? ('完成：' + files.length + ' 份原生文档' + suffix) : (files.length ? ('部分完成：' + files.length + ' 份成功，' + errors.length + ' 项失败') : '导出失败'),
                  logs: r.logs || [],
                });
              } catch (e) {
                const curEx = exportProgress.get(jobId) || {};
                setProg({ status: 'failed', stage: 'failed', total: items.length, done: curEx.done || 0, pct: (curEx.pct == null ? 0 : curEx.pct), files: [], errors: [String(e.message || e)], outDir, message: '作业异常' });
              }
            })();
            return json({ ok: true, jobId, outDir });
          } catch (e) { return json({ ok: false, error: String(e.message || e) }, 500); }
        },
      },

      {
        // 打开有界面浏览器扫码登录天源；登录态写入持久化 profile
        path: PREFIX + '/ty/native/login', methods: ['POST'], fetch: async () => {
          try {
            const script = fileURLToPath(new URL('./report-native-login.py', import.meta.url));
            const payload = JSON.stringify({ profileDir: NATIVE_PROFILE_DIR });
            let lastErr = null;
            for (const py of PYTHON_CANDIDATES) {
              try {
                const r = await runCli(py, [script, payload], 540000);
                const line = String(r.stdout || '').split(/\r?\n/).reverse().find(l => l.indexOf('@@DSH_NATIVE@@') === 0);
                if (!line) { lastErr = new Error((r.stderr || '').slice(-300) || ('登录脚本无输出，退出码 ' + r.code)); continue; }
                return json(JSON.parse(line.slice('@@DSH_NATIVE@@'.length)));
              } catch (e) { lastErr = e; }
            }
            return json({ ok: false, error: String((lastErr && lastErr.message) || '登录失败') }, 500);
          } catch (e) { return json({ ok: false, error: String(e.message || e) }, 500); }
        },
      },
      // ─── 天源原生导出（Host 侧 Cookie 直调天源接口；会话由 ty/auth 注入）───
      {
        path: PREFIX + '/ty/native/probe', methods: ['GET', 'HEAD'], fetch: async () => {
          try { return json(await tySession.probeSession()); }
          catch (e) { return json({ ok: false, reason: String(e.message || e) }); }
        },
      },
      {
        path: PREFIX + '/ty/native/reports', methods: ['GET', 'HEAD'], fetch: async (req) => {
          try {
            const u = new URL(req.url, 'http://127.0.0.1');
            const projectId = u.searchParams.get('projectId');
            if (!/^\d+$/.test(String(projectId || ''))) return json({ ok: false, error: 'projectId 必须为数字' }, 400);
            const rows = await tySession.listReports(projectId);
            return json({ ok: true, reports: rows, user: tySession.sessionUser() });
          } catch (e) {
            const code = e && e.code === 'UNAUTHENTICATED' ? 401 : 500;
            return json({ ok: false, error: String(e.message || e), code: e && e.code }, code);
          }
        },
      },
      {
        // 原生批量作业：items=[{companyId, companyName, type, mode:'current'|'refresh'}]
        path: PREFIX + '/ty/native/export', methods: ['POST'], fetch: async (req) => {
          try {
            const b = await req.json().catch(() => ({}));
            const jobId = /^[A-Za-z0-9_-]{6,64}$/.test(String(b.jobId || '')) ? String(b.jobId) : '';
            if (!jobId) return json({ ok: false, error: 'jobId 无效' }, 400);
            const projectId = String(b.projectId || '');
            if (!/^\d+$/.test(projectId)) return json({ ok: false, error: 'projectId 必须为数字' }, 400);
            const items = Array.isArray(b.items) ? b.items : [];
            if (!items.length) return json({ ok: false, error: '请至少选择一份文档' }, 400);
            for (const it of items) {
              if (!it || !/^\d+$/.test(String(it.companyId || '')) || ![1, 2, 3].includes(Number(it.type))) return json({ ok: false, error: 'items 每项需数字 companyId 与 type(1/2/3)' }, 400);
              if (!['current', 'refresh'].includes(it.mode)) return json({ ok: false, error: 'mode 必须为 current 或 refresh' }, 400);
            }
            let outDir = '';
            if (b.outputDir) {
              if (typeof b.outputDir !== 'string' || !isAbsolute(b.outputDir)) return json({ ok: false, error: '输出目录必须是绝对路径' }, 400);
              try { outDir = await realpath(b.outputDir); if (!(await stat(outDir)).isDirectory()) throw new Error(); }
              catch (_) { return json({ ok: false, error: '输出目录不存在或不是文件夹' }, 400); }
            }
            if (!outDir) {
              const st = await store.config();
              const folder = safeFolderName((String(b.projectCode || '') + ' ' + String(b.projectName || '')).trim()) || projectId;
              outDir = join(st.dir, '导出', folder, '原生');
              await mkdir(outDir, { recursive: true });
            }
            const TYPE_LABEL = { 1: '评估报告', 2: '评估说明', 3: '长投说明' };
            const setProg = patch => { if (exportProgress.size > 50) { let oldest = null; for (const [k, v] of exportProgress) if (!oldest || v.at < oldest.at) oldest = { k, at: v.at }; if (oldest) exportProgress.delete(oldest.k); } exportProgress.set(jobId, { at: Date.now(), ...patch }); };
            setProg({ status: 'running', stage: 'running', total: items.length, done: 0, files: [], errors: [], outDir, message: '准备中…' });

            (async () => {
              const files = []; const errors = [];
              try {
                // 独立批次目录：绝不把旧导出误当本次结果，也绝不覆盖已有文件。
                // 同名公司、并发作业、重复任务都落在各自批次里，事后可区分。
                let batchDir = '';
                try {
                  batchDir = await mkdtemp(join(outDir, '批次-'));
                } catch (e) {
                  setProg({ status: 'failed', stage: 'failed', total: items.length, done: 0, files: [], errors: ['无法创建导出批次目录：' + String(e.message || e)], outDir, message: '导出失败' });
                  return;
                }
                try { rememberExportBatch(batchDir); } catch (_) {}
                // 提交前基线快照：refresh 模式靠它识别"新版本"。
                // 获取失败必须停该项——猜基线会把旧版本当成刚生成的下载回来。
                let before = [];
                try { before = await tySession.listReports(projectId); }
                catch (e) {
                  setProg({ status: 'failed', stage: 'failed', total: items.length, done: 0, files: [], errors: ['读取报告基线失败，已中止（refresh 模式无法区分新旧版本，不得猜测）：' + String(e.message || e)], outDir, message: '导出失败：读取报告基线失败' });
                  return;
                }
                // 每项作业记录自己的基线：同公司同类型重复任务时，
                // 第二项的基线已包含第一项生成的版本，不会互相误判。
                const baseline = new Map();
                for (const r0 of before) {
                  const key = String(r0.companyId) + ':' + Number(r0.type);
                  const v = Number(r0.version) || 0;
                  baseline.set(key, Math.max(baseline.get(key) || 0, v));
                }
                for (let i = 0; i < items.length; i++) {
                  const it = items[i];
                  const label = TYPE_LABEL[Number(it.type)];
                  const msg = m => setProg({ status: 'running', stage: 'running', total: items.length, done: i, files, errors, outDir, message: `[${i + 1}/${items.length}] ${it.companyName} · ${label}：${m}` });
                  try {
                    let attachId = null, version = null;
                    if (it.mode === 'refresh') {
                      const baseKey = String(it.companyId) + ':' + Number(it.type);
                      const baseVer = baseline.get(baseKey) || 0;
                      msg('提交生成任务…');
                      const build = await tySession.buildReport(projectId, it.companyId, Number(it.type));
                      msg(`任务 ${build.jobId} 已提交，等待生成（基线 V${baseVer}）…`);
                      // 轮询：最多 10 分钟，等待该公司该类型出现"更高版本且带 attachId"
                      const t0 = Date.now();
                      while (Date.now() - t0 < 600000) {
                        await new Promise(res => setTimeout(res, 8000));
                        const rows = await tySession.listReports(projectId);
                        const mine = rows.filter(r => r.companyId === it.companyId && r.type === Number(it.type) && Number(r.version) > baseVer && r.attachId && Number(r.jobState) === 2);
                        if (mine.length) {
                          mine.sort((a, b2) => Number(b2.version) - Number(a.version));
                          attachId = mine[0].attachId; version = mine[0].version;
                          // 同类型重复任务：后续项的基线提升到本次结果，避免再等旧值
                          baseline.set(baseKey, Math.max(baseVer, Number(version) || 0));
                          break;
                        }
                        const anyNew = rows.filter(r => r.companyId === it.companyId && r.type === Number(it.type) && Number(r.version) > baseVer);
                        msg(anyNew.length ? `新版本 ${anyNew[0].version} 生成中…` : '等待系统生成…');
                      }
                      if (!attachId) throw new Error('等待生成超时（10 分钟），请稍后在网页端查看任务状态');
                    } else {
                      msg('查询现有版本…');
                      const rows = await tySession.listReports(projectId);
                      const mine = rows.filter(r => r.companyId === it.companyId && r.type === Number(it.type) && r.attachId && Number(r.jobState) === 2);
                      if (!mine.length) throw new Error(`没有已生成的${label}（可能从未生成，请改用「生成新版本」）`);
                      mine.sort((a, b2) => Number(b2.version) - Number(a.version));
                      attachId = mine[0].attachId; version = mine[0].version;
                    }
                    msg(`下载 V${version}…`);
                    const { buf } = await tySession.downloadAttachmentRaw(attachId);
                    const chk = await tySession.validateDocx(buf);
                    if (!chk.ok) throw new Error('下载文件校验失败：' + chk.reason);
                    const safeName = String(it.companyName).replace(/[\/:*?"<>|]/g, '_');
                    // 不覆盖发布：目标名已存在时落成 -2/-3 序号，先写临时文件再原子改名
                    let outPath = join(batchDir, `${safeName}-${label}-V${version}.docx`);
                    let seq = 2;
                    while (existsSync(outPath)) { outPath = join(batchDir, `${safeName}-${label}-V${version}-${seq}.docx`); seq++; }
                    const tmpPath = outPath + '.part';
                    await writeFile(tmpPath, buf);
                    await rename(tmpPath, outPath);
                    const rec = { file: outPath, company: it.companyName, companyId: it.companyId, type: Number(it.type), version };
                    try {
                      const cfg = await store.config();
                      let online = null;
                      let onlineError = '';
                      try {
                        online = await captureOnlineNodes({ projectId, companyId: it.companyId, reportType: it.type });
                      } catch (e) {
                        onlineError = String(e.message || e);
                      }
                      let onlineFull = null;
                      let onlineFullError = '';
                      try {
                        onlineFull = online ? await captureOnlineFullNodes({ projectId, companyId: it.companyId, reportType: it.type, document: online.document }) : null;
                        if (!online) onlineFullError = '没有线上节点树，完整版快照未抓取';
                      } catch (e) {
                        onlineFullError = String(e.message || e);
                      }
                      const saved = await archiveReportBaseline({ rootDir: cfg.dir, sourcePath: outPath, metadata: {
                        projectId, projectName: String(b.projectName || ''), companyId: String(it.companyId || ''),
                        companyName: String(it.companyName || ''), reportType: String(it.type), version: String(version ?? ''),
                      }, online: online || undefined, onlineFull: onlineFull || undefined });
                      rec.baselineId = basename(dirname(saved.archiveDir));
                      rec.baselineSnapshot = saved.snapshotStatus;
                      rec.baselineFull = saved.fullStatus;
                      if (onlineError) rec.baselineOnlineError = onlineError;
                      if (onlineFullError) rec.baselineFullError = onlineFullError;
                    } catch (e) {
                      rec.baselineError = String(e.message || e);
                      errors.push(`${it.companyName} · ${label}：导出成功，但比对基线保存失败（${rec.baselineError}）`);
                    }
                    files.push(rec);
                    setProg({ status: 'running', stage: 'running', total: items.length, done: i + 1, files, errors, outDir, message: `[${i + 1}/${items.length}] 已完成 ${it.companyName} · ${label} V${version}` });
                  } catch (e) {
                    errors.push(`${it.companyName} · ${label}：${String(e.message || e)}`);
                    setProg({ status: 'running', stage: 'running', total: items.length, done: i + 1, files, errors, outDir, message: `[${i + 1}/${items.length}] 失败：${it.companyName} · ${label}` });
                  }
                }
                const okAll = errors.length === 0;
                setProg({ status: okAll ? 'done' : files.length ? 'partial' : 'failed', stage: okAll ? 'done' : files.length ? 'partial' : 'failed', total: items.length, done: items.length, files, errors, outDir, message: okAll ? `完成：${files.length} 份原生文档` : (files.length ? `部分完成：${files.length} 份成功，${errors.length} 项失败` : '导出失败') });
              } catch (e) {
                setProg({ status: 'failed', stage: 'failed', total: items.length, done: 0, files, errors: [...errors, String(e.message || e)], outDir, message: '作业异常：' + String(e.message || e) });
              }
            })();
            return json({ ok: true, jobId, outDir });
          } catch (e) { return json({ ok: false, error: String(e.message || e) }, 500); }
        },
      },

      // ─── 天源网页端导出（原生 docx，经工具箱浏览器 CDP）───
      {
        // 探测工具箱浏览器 + 天源登录态
        path: PREFIX + '/ty/web/probe', methods: ['GET', 'HEAD'], fetch: async () => {
          return json({ ok: false, logged: false, error: '网页端导出暂不可用：尚不能安全隔离浏览器并核验公司和报告版本。请使用本地 JSON 重建。' });
        },
      },
      {
        // 列出项目下所有公司及其可导出的文档类型
        path: PREFIX + '/ty/web/companies', methods: ['GET', 'HEAD', 'POST'], fetch: async (req) => {
          return json({ ok: false, error: '网页端导出暂不可用，已阻止操作共享浏览器。' }, 503);
          try {
            const u = new URL(req.url, 'http://127.0.0.1');
            let projectId = u.searchParams.get('projectId');
            if (!projectId && req.method === 'POST') { const b = await req.json().catch(() => ({})); projectId = b.projectId; }
            if (!/^\d+$/.test(String(projectId || ''))) return json({ ok: false, error: 'projectId 必须为数字' }, 400);
            return json({ ok: true, companies: await tyWeb.listCompanies(projectId) });
          } catch (e) { return json({ ok: false, error: String(e.message || e) }, 500); }
        },
      },
      {
        // 列出项目现有报告（类型/版本/状态）
        path: PREFIX + '/ty/web/reports', methods: ['GET', 'HEAD'], fetch: async (req) => {
          return json({ ok: false, error: '网页端导出暂不可用，已阻止操作共享浏览器。' }, 503);
          try {
            const u = new URL(req.url, 'http://127.0.0.1');
            const projectId = u.searchParams.get('projectId');
            if (!/^\d+$/.test(String(projectId || ''))) return json({ ok: false, error: 'projectId 必须为数字' }, 400);
            return json({ ok: true, reports: await tyWeb.listReports(projectId) });
          } catch (e) { return json({ ok: false, error: String(e.message || e) }, 500); }
        },
      },
      {
        // 启动网页端导出作业（异步，前端轮询 /ty/web/progress）
        // body: { jobId, projectId, items:[{companyName,type,mode:'current'|'refresh'}], outputDir }
        path: PREFIX + '/ty/web/export', methods: ['POST'], fetch: async (req) => {
          return json({ ok: false, error: '网页端导出暂不可用：无法可靠核验公司、版本及隔离共享浏览器。' }, 503);
          try {
            const b = await req.json().catch(() => ({}));
            const jobId = /^[A-Za-z0-9_-]{6,64}$/.test(String(b.jobId || '')) ? String(b.jobId) : '';
            if (!jobId) return json({ ok: false, error: 'jobId 无效' }, 400);
            const projectId = String(b.projectId || '');
            if (!/^\d+$/.test(projectId)) return json({ ok: false, error: 'projectId 必须为数字' }, 400);
            const items = Array.isArray(b.items) ? b.items : [];
            if (!items.length) return json({ ok: false, error: '请至少选择一份文档' }, 400);
            for (const it of items) {
              if (!it || typeof it.companyName !== 'string' || ![1, 2, 3].includes(Number(it.type))) return json({ ok: false, error: 'items 每项需 companyName 与 type(1/2/3)' }, 400);
              if (!['current', 'refresh'].includes(it.mode)) return json({ ok: false, error: 'items.mode 必须是 current 或 refresh' }, 400);
            }
            let outDir = '';
            if (b.outputDir) {
              if (typeof b.outputDir !== 'string' || !isAbsolute(b.outputDir)) return json({ ok: false, error: '输出目录必须是绝对路径' }, 400);
              try { outDir = await realpath(b.outputDir); if (!(await stat(outDir)).isDirectory()) throw new Error(); }
              catch (_) { return json({ ok: false, error: '输出目录不存在或不是文件夹' }, 400); }
            }
            if (!outDir) {
              const st = await store.config();
              const folder = safeFolderName((String(b.projectCode || '') + ' ' + String(b.projectName || '')).trim()) || projectId;
              outDir = join(st.dir, '导出', folder, '网页端');
              await mkdir(outDir, { recursive: true });
            }
            const setProg = patch => { exportProgress.set(jobId, { at: Date.now(), ...patch }); };
            setProg({ status: 'running', stage: 'running', total: items.length, done: 0, files: [], errors: [], outDir, message: '准备中…' });

            (async () => {
              const files = []; const errors = [];
              for (let i = 0; i < items.length; i++) {
                const it = items[i];
                const label = tyWeb.TYPE_LABEL[Number(it.type)];
                const kw = String(it.companyName).replace(/^浙江(省)?/, '').replace(/有限公司$/, '').replace(/股份/, '');
                try {
                  exportProgress.set(jobId, { at: Date.now(), status: 'running', stage: 'running', total: items.length, done: i, files, errors, outDir, message: `[${i + 1}/${items.length}] ${it.companyName} · ${label}：${it.mode === 'refresh' ? '生成新版本' : '取当前版本'}` });
                  let version = null;
                  if (it.mode === 'refresh') {
                    await tyWeb.generateDoc(projectId, it.companyName, Number(it.type), m => exportProgress.set(jobId, { at: Date.now(), status: 'running', stage: 'running', total: items.length, done: i, files, errors, outDir, message: `[${i + 1}/${items.length}] ${it.companyName} · ${label}：${m}` }));
                    const ready = await tyWeb.waitReady(projectId, kw, Number(it.type), { onProgress: m => exportProgress.set(jobId, { at: Date.now(), status: 'running', stage: 'running', total: items.length, done: i, files, errors, outDir, message: `[${i + 1}/${items.length}] ${it.companyName} · ${label}：${m}` }) });
                    version = ready.version;
                  } else {
                    // 取当前版本：从报告列表找最新已生成
                    const reports = await tyWeb.listReports(projectId);
                    const mine = reports.filter(r => r.type === Number(it.type) && r.name.includes(kw) && r.status === '已生成' && r.downloadable);
                    if (!mine.length) throw new Error(`没有可下载的${label}（可能从未生成，请改用「生成新版本」）`);
                    mine.sort((a, b) => Number(b.version) - Number(a.version));
                    version = mine[0].version;
                  }
                  const dl = await tyWeb.downloadDoc(projectId, Number(it.type), version, outDir);
                  files.push({ file: dl.file, name: dl.name, version: dl.version, company: it.companyName, type: Number(it.type) });
                  try { rememberExportBatch(outDir); } catch (_) {}
                  exportProgress.set(jobId, { at: Date.now(), status: 'running', stage: 'running', total: items.length, done: i + 1, files, errors, outDir, message: `[${i + 1}/${items.length}] 已完成 ${it.companyName} · ${label} V${version}` });
                } catch (e) {
                  errors.push(`${it.companyName} · ${label}：${String(e.message || e)}`);
                  exportProgress.set(jobId, { at: Date.now(), status: 'running', stage: 'running', total: items.length, done: i + 1, files, errors, outDir, message: `[${i + 1}/${items.length}] 失败：${it.companyName} · ${label}` });
                }
              }
              const okAll = errors.length === 0;
              exportProgress.set(jobId, { at: Date.now(), status: okAll ? 'done' : files.length ? 'partial' : 'failed', stage: okAll ? 'done' : files.length ? 'partial' : 'failed', total: items.length, done: items.length, files, errors, outDir, message: okAll ? `完成：${files.length} 份原生文档` : (files.length ? `部分完成：${files.length} 份成功，${errors.length} 项失败` : `失败：${errors.join('；')}`) });
            })();
            return json({ ok: true, jobId, outDir });
          } catch (e) { return json({ ok: false, error: String(e.message || e) }, 500); }
        },
      },
    {
      // 天源导出（v1 同步等待）：调本机 tycpv 导出资产基础法明细表/申报表，再逐个工作簿
      // 「恢复公式（asset-link-restore）→ 设置打印格式（appraisal-*-print-format）→ 校验 zip → 原子替换」。
      // 与浏览器插件 Native Helper 的 run_detail_table_workflow / run_declaration_table_workflow 同一套脚本与流程。
      // 报告/说明/长投 → 官方格式 Word（tycpv export-report-docx），支持类型多选串行导出。
      // body: { jobId, types:[1,2,3], projectId, companyIds?(逗号分隔,空=全部), projectCode?, projectName?, outputDir? }
      path: PREFIX + '/ty/report-docx', methods: ['POST'], fetch: async (req) => {
        try {
          const b = await req.json().catch(() => ({}));
          const jobId = /^[A-Za-z0-9_-]{6,64}$/.test(String(b.jobId || '')) ? String(b.jobId) : '';
          const setProg = patch => { if (!jobId) return; if (exportProgress.size > 50) { let oldest = null; for (const [k, v] of exportProgress) if (!oldest || v.at < oldest.at) oldest = { k, at: v.at }; if (oldest) exportProgress.delete(oldest.k); } exportProgress.set(jobId, { at: Date.now(), ...patch }); };
          const TYPE_NAMES = { 1: '评估报告', 2: '评估说明', 3: '长投说明' };
          const types = (Array.isArray(b.types) ? b.types : []).map(Number).filter(t => [1, 2, 3].includes(t));
          if (!types.length) return json({ ok: false, error: 'types 必须为 [1,2,3] 的非空子集（1 报告 2 说明 3 长投说明）' }, 400);
          const projectId = String(b.projectId || '').trim();
          if (!/^\d+$/.test(projectId)) return json({ ok: false, error: 'projectId 必须为天源数字项目 ID' }, 400);
          const companyIds = String(b.companyIds || '').trim();
          if (companyIds && !/^\d+(,\d+)*$/.test(companyIds)) return json({ ok: false, error: 'companyIds 必须为数字逗号列表' }, 400);
          if (!existsSync(join(homedir(), '.tycpv', 'token.secret.json'))) return json({ ok: false, error: 'tycpv 未登录：请先在工作台「天源对接」完成 CLI 授权' }, 400);
          const cli = [process.env.TYCPV_BIN, join(homedir(), '.local', 'bin', 'tycpv'), '/usr/local/bin/tycpv'].find(x => x && existsSync(x));
          if (!cli) return json({ ok: false, error: '未找到 tycpv CLI' }, 500);
          const tail = (s, n) => String(s || '').trim().split(/\r?\n/).filter(Boolean).slice(-n).join(' ｜ ');

          const st0 = await store.config();
          const folder = safeFolderName((String(b.projectCode || '') + ' ' + String(b.projectName || '')).trim()) || projectId;
          const outRoot = join(st0.dir, '导出', folder);
          const outRootParam = String(b.outputDir || '').trim();
          let root = outRoot;
          if (outRootParam) {
            if (!isAbsolute(outRootParam)) return json({ ok: false, error: '输出目录必须是绝对路径' }, 400);
            try { root = await realpath(outRootParam); if (!(await stat(root)).isDirectory()) throw new Error(); } catch (_) { return json({ ok: false, error: '输出目录不存在或不是文件夹' }, 400); }
          }

          setProg({ status: 'running', stage: 'running', message: '正在启动导出…', outDir: root });
          // 串行执行各类型；任一类型失败记录错误继续其余类型。
          (async () => {
            const files = [], errors = [];
            for (let typeIndex = 0; typeIndex < types.length; typeIndex++) {
              const t = types[typeIndex];
              const typeName = TYPE_NAMES[t];
              const basePct = Math.round((typeIndex / Math.max(1, types.length)) * 100);
              // 每次调用使用独立目录，绝不把上次遗留的 Word 当成本次产物。
              let outDir;
              try {
                const typeDir = join(root, typeName);
                await mkdir(typeDir, { recursive: true });
                outDir = await mkdtemp(join(typeDir, '批次-'));
              } catch (e) {
                errors.push(typeName + '：无法创建导出批次：' + String(e.message || e));
                continue;
              }
              exportProgress.set(jobId, { at: Date.now(), status: 'running', stage: 'running', outDir, pct: basePct, message: `正在导出「${typeName}」（拉取数据、变量并生成官方格式 Word）…` });
              const args = ['export-report-docx', '--project', projectId, '--type', String(t), '--out', outDir];
              if (companyIds) args.push('--company', companyIds); else args.push('--company-all');
              const res = await new Promise(resolve => {
                const child = spawn(cli, args, { stdio: ['ignore', 'pipe', 'pipe'] });
                let cout = '', cerr = '';
                child.stdout.on('data', d => { cout += d; const cur = exportProgress.get(jobId); if (cur) exportProgress.set(jobId, { ...cur, at: Date.now(), status: 'running', stage: 'running', outDir, pct: basePct, message: `「${typeName}」` + (tail(cout, 1) || '导出中…') }); });
                child.stderr.on('data', d => { cerr += d; });
                child.on('error', e => { cerr += String(e); });
                // 把 code 与输出一起返回，避免在 Promise 作用域外引用局部变量。
                child.on('close', code => resolve({ code, cout, cerr }));
              });
              if (res.code === 0) {
                try {
                  const produced = (await readdir(outDir, { withFileTypes: true })).filter(f => f.isFile() && /\.docx$/i.test(f.name));
                  if (!produced.length) errors.push(typeName + '：CLI 已退出但未生成 Word 文件');
                  else for (const f of produced) files.push(join(outDir, f.name));
                } catch (e) { errors.push(typeName + '：无法读取导出批次：' + String(e.message || e)); }
              } else errors.push(typeName + '：' + (tail(res.cerr || res.cout, 3) || ('退出码 ' + res.code)));
            }
            for (const f of files) {
              const dir = dirname(f);
              if (dir.startsWith(st0.dir) || dir.startsWith(root)) rememberExportBatch(dir);
            }
            const okAll = errors.length === 0;
            exportProgress.set(jobId, { at: Date.now(), status: okAll ? 'done' : files.length ? 'partial' : 'failed', stage: okAll ? 'done' : files.length ? 'partial' : 'failed', outDir: root, pct: 100, files, message: okAll ? `完成：生成 ${files.length} 份 Word` : (files.length ? `部分完成（${files.length} 份）。失败：${errors.join('；')}` : '导出失败：' + errors.join('；')) });
          })();
          return json({ ok: true, jobId, outDir: root });
        } catch (e) { return json({ ok: false, error: String(e.message || e) }, 500); }
        }
      },
      {
        // 天源导出（v1 同步等待）：调本机 tycpv 导出资产基础法明细表/申报表，再逐个工作簿
        // 「恢复公式（asset-link-restore）→ 设置打印格式（appraisal-*-print-format）→ 校验 zip → 原子替换」。
        // 实现在文件顶部的 runTyExport：助手的工作台工具走同一份，避免两处逻辑漂移。
        // body: { kind: 'detail'|'declare', projectId: '<数字>', projectCode?, projectName?, companyIds?, restoreFormulas?, applyFormat?, outputDir?, jobId? }
        path: PREFIX + '/ty/export', methods: ['POST'], fetch: async (req) => {
          const r = await runTyExport(await req.json().catch(() => ({})));
          return json(r.body, r.status);
        },
      },
    {
      // 前端轮询导出进度；无任务时返回 unknown。
      path: PREFIX + '/ty/export/progress', methods: ['GET'], fetch: async (req) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        const p = exportProgress.get(String(u.searchParams.get('jobId') || ''));
        return json(p ? { ...p } : { stage: 'unknown' });
      },
    },
    {
      // 导出页脚配置：按项目 × 公司存取（独立 JSON，不被前端整体保存冲掉）。
      // GET 与 POST 同 path：路由表按 path 去重（owners.has），必须合在一条路由里按 method 分发。
      path: PREFIX + '/ty/export/footers', methods: ['GET', 'POST'], fetch: async (req) => {
        try {
          if (req.method === 'GET') {
            const u = new URL(req.url, 'http://127.0.0.1');
            const projectId = String(u.searchParams.get('projectId') || '').trim();
            if (!/^\d+$/.test(projectId)) return json({ ok: false, error: 'projectId 必须为数字' }, 400);
            const fstore = await readFooterStore();
            const proj = fstore[projectId] || {};
            const footers = {};
            for (const [cid, v] of Object.entries(proj)) {
              const e = normalizeFooterEntry(v);
              if (e) footers[cid] = e;
            }
            return json({ ok: true, footers });
          }
          // POST：保存 { projectId, footers }
          const b = await req.json();
          const projectId = String(b.projectId || '').trim();
          if (!/^\d+$/.test(projectId)) return json({ ok: false, error: 'projectId 必须为数字' }, 400);
          if (!b.footers || typeof b.footers !== 'object' || Array.isArray(b.footers)) return json({ ok: false, error: 'footers 必须为 {公司ID:{preparer,date,appraisers}}' }, 400);
          const cleaned = {};
          for (const [cid, v] of Object.entries(b.footers)) {
            if (!/^\d+$/.test(String(cid))) return json({ ok: false, error: '公司 ID 必须为数字：' + String(cid) }, 400);
            const e = normalizeFooterEntry(v);
            if (e) cleaned[cid] = e;   // 三项全空的条目直接剔除（视为删除）
          }
          const fstore = await readFooterStore();
          if (Object.keys(cleaned).length) fstore[projectId] = cleaned;
          else delete fstore[projectId];   // 全部清空就移除该项目的配置
          await writeFooterStore(fstore);
          return json({ ok: true, saved: Object.keys(cleaned).length, file: FOOTER_FILE });
        } catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 500); }
      },
    },
    {
      path: PREFIX + '/ty/export/files', methods: ['POST'], fetch: async (req) => {
          try {
            const b = await req.json();
            if (typeof b.dir !== 'string' || !isAbsolute(b.dir)) return json({ ok: false, error: '请填写文件夹绝对路径' }, 400);
            const dir = await realpath(b.dir);
            if (!(await stat(dir)).isDirectory()) return json({ ok: false, error: '请选择文件夹' }, 400);
            const entries = await readdir(dir, { withFileTypes: true });
            const files = entries.filter(e => e.isFile() && /\.(xlsx|xlsm)$/i.test(e.name)).map(e => ({ name: e.name, path: join(dir, e.name) })).sort((a, b) => a.name.localeCompare(b.name));
            return json({ ok: true, dir, files: files.slice(0, 500), truncated: files.length > 500 });
          } catch (_) { return json({ ok: false, error: '无法读取该文件夹' }, 400); }
        },
      },
      {
        // 手动整理始终输出到独立批次，不覆盖用户选择的源工作簿。
        path: PREFIX + '/ty/export/manual', methods: ['POST'], fetch: async (req) => {
        try {
          const body = await req.json();
          const jobId = /^[A-Za-z0-9_-]{6,64}$/.test(String(body.jobId || '')) ? String(body.jobId) : '';
          const { jobId: _ignored, ...workflowOptions } = body;   // jobId 仅用于进度，不进入工作流参数
          const result = await runManualWorkflow({
            ...workflowOptions,
            onProgress: jobId ? p => exportProgress.set(jobId, { at: Date.now(), stage: 'process', ...p }) : undefined,
          });
          if (jobId) exportProgress.delete(jobId);
          if (result.outDir) rememberExportBatch(await realpath(result.outDir));
          return json(result);
        } catch (e) {
          return json({ ok: false, error: String(e?.message || e) }, 400);
        }
      },
    },
    {
      // 默认导出根及本次生成批次可打开，符号链接解析后检查边界。
      path: PREFIX + '/ty/export/open', methods: ['POST'], fetch: async (req) => {
        try {
          const b = await req.json().catch(() => ({}));
          if (typeof b.outDir !== 'string' || !isAbsolute(b.outDir)) return json({ ok: false, error: '导出目录无效' }, 400);
          const target = await realpath(b.outDir);
          const inside = (root, child) => {
            const rel = relative(root, child);
            return !!rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
          };
          let allowed = exportBatchDirs.has(target);
          if (!allowed) {
            try {
              const cfg = await store.config();
              const dataRoot = await realpath(cfg.dir);
              const exportRoot = await realpath(join(dataRoot, '导出'));
              allowed = inside(dataRoot, exportRoot) && inside(exportRoot, target);
            } catch (_) { /* 默认根不存在时仍可打开本次生成的自定义批次 */ }
          }
          if (!allowed || !(await stat(target)).isDirectory()) {
            return json({ ok: false, error: '只能打开工作台导出目录或本次生成的批次' }, 403);
          }
          const result = await openShell(target);
          return json(result, result.ok ? 200 : 500);
        } catch (_) { return json({ ok: false, error: '导出目录不存在或无法打开' }, 404); }
      },
    },
    {
      path: PREFIX + '/ty/projects', methods: ['GET', 'HEAD', 'POST'], fetch: async (req) => {
        try {
          const u = new URL(req.url);
          let body = {};
          if (req.method === 'POST') body = await req.json().catch(() => ({}));
          const tool = u.searchParams.get('tool') || body.tool || 'get_project_companies';
          const args = body.arguments || {};
          if (!Object.keys(args).length) {
            for (const [k, v] of u.searchParams) if (!['tool'].includes(k)) args[k] = v;
          }
          if (body.projectId) args.projectId = body.projectId;
          const out = await ty.callTool(tool, args);
          return json(out);
        } catch (e) { return json({ error: e.message }, 502); }
      },
    },
    {
      path: PREFIX + '/lib/overview', methods: ['GET', 'HEAD'], fetch: async () => {
        try { return json(await lib.overview()); } catch (e) { return json({ error: String(e.message || e) }, 500); }
      },
    },
    {
      path: PREFIX + '/lib/projects', methods: ['GET', 'HEAD'], fetch: async (req) => {
        try {
          const u = new URL(req.url);
          return json({ items: await lib.projects(u.searchParams.get('q') || '') });
        } catch (e) { return json({ error: String(e.message || e) }, 500); }
      },
    },
    {
      path: PREFIX + '/lib/dir', methods: ['GET', 'HEAD'], fetch: async (req) => {
        try {
          const u = new URL(req.url);
          return json(await lib.listDir(u.searchParams.get('path') || ''));
        } catch (e) { return json({ error: String(e.message || e) }, 500); }
      },
    },
    {
      path: PREFIX + '/lib/files', methods: ['GET', 'HEAD'], fetch: async (req) => {
        try {
          const u = new URL(req.url);
          // 不传 depth（或 depth<=0）= 展开到末级，这是「文件库」右栏的默认行为：
          // 底稿常在「项目\02 电子底稿\2-底稿\1-股权评估底稿\1-流资流负\xxx.xlsx」这种第 5、6 层
          const raw = u.searchParams.get('depth');
          const depth = raw == null || raw === '' ? 0 : Number(raw);
          return json(await lib.projectFiles(u.searchParams.get('path') || '', depth));
        } catch (e) { return json({ error: String(e.message || e) }, 500); }
      },
    },
    {
      path: PREFIX + '/lib/search', methods: ['GET', 'HEAD'], fetch: async (req) => {
        try {
          const u = new URL(req.url);
          return json(await lib.search(u.searchParams.get('q') || '', { limit: Number(u.searchParams.get('limit') || 30) }));
        } catch (e) { return json({ error: String(e.message || e) }, 500); }
      },
    },
    {
      path: PREFIX + '/lib/text', methods: ['GET', 'HEAD'], fetch: async (req) => {
        try {
          const u = new URL(req.url);
          return json(await lib.docText(u.searchParams.get('rel') || '', Number(u.searchParams.get('max') || 20000)));
        } catch (e) { return json({ error: String(e.message || e) }, 500); }
      },
    },
    {
      path: PREFIX + '/lib/open', methods: ['POST'], fetch: async (req) => {
        try {
          const b = await req.json().catch(() => ({}));
          const r = await lib.openPath(b.rel || '', !!b.reveal);
          return json(r, r.ok ? 200 : 400);
        } catch (e) { return json({ error: String(e.message || e) }, 500); }
      },
    },
    {
      path: PREFIX + '/lib/ask', methods: ['POST'], fetch: async (req) => {
        try {
          const b = await req.json().catch(() => ({}));
          const question = String(b.question || '').trim();
          if (!question) return json({ error: '缺少问题内容' }, 400);
          const topK = Math.max(3, Math.min(20, Number(b.topK) || 8));
          const items = await kbqa.retrieve(question, { topK });
          const useModel = b.useModel !== false;
          const llm = readLlm(ctx);
          if (!useModel) {
            return json({ answer: kbqa.fallbackAnswer(question, items), mode: 'retrieval',
              items: trimItems(items), usage: null, diag: '已关闭「用模型总结」' });
          }
          // 模型来源：请求里指定的（问答面板下拉）→ DSH 默认模型 → 第一个可用模型
          let selection = null;
          let selFrom = '';
          if (b.provider && b.model) {
            selection = { provider: String(b.provider), model: String(b.model) };
            selFrom = '面板选择';
          } else {
            selection = await resolveModel(ctx);
            selFrom = selection ? '默认/首个可用模型' : '';
          }
          if (!llm || !selection) {
            return json({
              answer: kbqa.fallbackAnswer(question, items), mode: 'retrieval',
              error: (!llm ? '插件作用域里取不到 llm 服务' : '没有可用的模型（可用提供方为空）'),
              diag: await modelDiagnostics(ctx), items: trimItems(items), usage: null,
            });
          }
          const out = await kbqa.ask(ctx, question, items, {
            topK, history: b.history, selection, llm,
          });
          if (!out.answer && out.error) {
            return json({ answer: kbqa.fallbackAnswer(question, items), mode: 'retrieval',
              error: out.error, diag: selFrom + ' · ' + selection.provider + '/' + selection.model,
              items: trimItems(items), usage: out.usage || null });
          }
          return json({ answer: out.answer, mode: 'model', model: out.model, provider: out.provider,
            usage: out.usage || null, items: trimItems(items), diag: selFrom });
        } catch (e) { return json({ error: String(e.message || e) }, 500); }
      },
    },
    {
      // 问答面板的模型下拉：可选模型清单（与合同解析共用同一套）
      path: PREFIX + '/lib/models', methods: ['GET', 'HEAD'], fetch: async () => {
        try {
          const r = await listModelChoices(ctx);
          return json(r, 200);
        } catch (e) { return json({ ok: false, providers: [], error: String(e.message || e) }, 200); }
      },
    },
    {
      // wiki 编译层：目录 + 单页正文
      path: PREFIX + '/lib/wiki', methods: ['GET', 'HEAD'], fetch: async (req) => {
        try {
          const entries = await kbqa.wikiIndex(true);
          const u = new URL(req.url);
          const kind = u.searchParams.get('kind') || '';
          const list = kind ? entries.filter(e => e.kind === kind) : entries;
          return json({ ok: true, total: list.length, counts:
            { projects: entries.filter(e => e.kind === 'projects').length,
              topics: entries.filter(e => e.kind === 'topics').length,
              years: entries.filter(e => e.kind === 'years').length },
          entries: list });
        } catch (e) { return json({ ok: false, error: String(e.message || e), entries: [] }, 200); }
      },
    },
    {
      path: PREFIX + '/lib/wiki/page', methods: ['GET', 'HEAD'], fetch: async (req) => {
        try {
          const u = new URL(req.url);
          // macOS 移植：原实现把 / 强制转成 \，非 Windows 下拼出的路径不存在。
          const rel = String(u.searchParams.get('rel') || '').replace(/[\\/]+/g, sep);
          const parts = rel.split(sep);
          if (
            parts.length !== 4 ||
            parts[0] !== '_wiki' || parts[1] !== 'wiki' ||
            !['projects', 'topics', 'years'].includes(parts[2]) ||
            !/^[^\\/]+\.md$/.test(parts[3])
          ) {
            return json({ ok: false, error: 'wiki 页面路径不合法' }, 400);
          }
          const abs = lib.resolveLibPath(rel);
          if (!abs) return json({ ok: false, error: '路径越界' }, 400);
          // wiki 页面不在知识库索引里，直接读文件（docText 只认索引进来的文件）
          const text = await readFile(abs, 'utf8');
          const max = Number(u.searchParams.get('max') || 60000);
          return json({ ok: true, rel, chars: text.length, text: text.slice(0, max) });
        } catch (e) { return json({ ok: false, error: String(e.message || e) }, 500); }
      },
    },
    {
      path: PREFIX + '/lib/retrieve', methods: ['GET', 'HEAD'], fetch: async (req) => {
        try {
          const u = new URL(req.url);
          const q = u.searchParams.get('q') || '';
          const items = await kbqa.retrieve(q, { topK: Number(u.searchParams.get('topK') || 8) });
          return json({ question: q, items: trimItems(items) });
        } catch (e) { return json({ error: String(e.message || e) }, 500); }
      },
    },
    {
      path: PREFIX + '/lib/scan', methods: ['GET', 'HEAD', 'POST'], fetch: async (req) => {
        try {
          const u = new URL(req.url);
          if (req.method === 'GET' || req.method === 'HEAD') {
            // GET = 只读状态；?preview=1 顺带列出磁盘上的项目（用于「有哪些新项目」预检）
            if (u.searchParams.get('preview')) return json({ ...scanner.status(), preview: await scanner.previewScan() });
            return json(scanner.status());
          }
          const b = await req.json().catch(() => ({}));
          if (b.cancel) return json(scanner.cancelScan(), 200);
          // POST = 启动扫描（立即返回，进度走 GET 轮询）。
          // 默认增量（只处理新增/变化），full=true 全量重抽。
          const r = await scanner.startScan({
            full: !!b.full, ocr: !!b.ocr, ocrLimit: b.ocrLimit, rebuild: !!b.rebuild,
            // Word 优先默认开：报告/说明有 Word 版就不再解析对应 PDF
            wordFirst: b.wordFirst !== false,
          });
          return json(r, r.ok ? 200 : 400);
        } catch (e) { return json({ error: String(e.message || e) }, 500); }
      },
    },
    {
      path: PREFIX + '/lib/scan/status', methods: ['GET', 'HEAD'], fetch: async () => {
        try { return json(scanner.status()); } catch (e) { return json({ error: String(e.message || e) }, 500); }
      },
    },
    {
      // 数据目录（工作台数据.json / 股票库）与项目目录（本地项目文件夹，默认 00项目ing）
      path: PREFIX + '/store', methods: ['GET', 'HEAD', 'POST'], fetch: async (req) => {
        try {
          if (req.method === 'GET' || req.method === 'HEAD') return json(await store.info());
          const b = await req.json().catch(() => ({}));
          const r = b.projectsDir != null ? await store.setProjectsDir(b.projectsDir) : await store.setDir(b.dir);
          return json({ ...(await store.info()), ...r }, r.ok ? 200 : 400);
        } catch (e) { return json({ error: String(e.message || e) }, 500); }
      },
    },
    {
      // which=projects 打开「本地项目」根目录（00项目ing）；不带时打开数据目录
      path: PREFIX + '/store/open', methods: ['POST'], fetch: async (req) => {
        try {
          const b = await req.json().catch(() => ({}));
          const r = b.which === 'projects' ? await store.openProjectsDir() : await store.openDir();
          return json(r, r.ok ? 200 : 400);
        } catch (e) { return json({ error: String(e.message || e) }, 500); }
      },
    },
    {
      // 本地项目文件夹：<项目目录>\\<项目编号 项目简称>，默认建出来并用资源管理器打开；open=false 时只建目录。
      // 项目目录默认 D:\\天源评估\\00项目ing；升级前建在数据目录下的老项目按目录查找、仍然复用，不会重复建。
      path: PREFIX + '/project/folder', methods: ['POST'], fetch: async (req) => {
        try {
          const b = await req.json().catch(() => ({}));
          const create = b.create !== false;
          const want = safeFolderName(b.folder || '');
          const legacy = safeFolderName(b.legacy || '');
          // 绑定过绝对路径的项目（folderPath）：直接用那个目录，不再按名字在项目根里找。
          // 这样项目可以放在任意位置（OneDrive、客户目录……），也能在根目录之外建。
          const absBound = String(b.abs || '').trim();
          // 兼容旧调用（只给 year + name）
          if (!want && !legacy && b.name) {
            const r = b.open === false
              ? await store.projectFolder(b.year, b.name, create)
              : await store.openProjectFolder(b.year, b.name, create);
            return json(r, r.ok ? 200 : 400);
          }
          if (!want && !legacy && !absBound) return json({ ok: false, error: '项目文件夹名不合法（先填项目编号与项目简称）' }, 400);
          const names = [want, legacy].filter(Boolean);
          // remove=true：删除项目时连文件夹一起删（只删一层目录，找不到就当本来就不存在）
          if (b.remove === true) {
            let hit = null;
            if (absBound) hit = await store.describeFolder(absBound, false);
            if (!hit || !hit.ok) {
              for (const n of names) { const h = await store.findProjectDir(n); if (h) { hit = h; break; } }
            }
            if (!hit || !hit.ok) {
              const { projectsDir } = await store.config();
              return json({ ok: true, removed: false, path: absBound || join(projectsDir, want || legacy), note: '文件夹本来就不存在' });
            }
            try {
              await rm(hit.path, { recursive: true, force: true });
              return json({ ok: true, removed: true, path: hit.path });
            } catch (e) {
              return json({ ok: false, error: '删除文件夹失败：' + String(e.message || e), path: hit.path }, 500);
            }
          }
          // 绑定的绝对路径优先；没有再按名字在项目根里找（新名字 <编号 简称> → 旧名字 <年份 项目名>）
          let hit = absBound ? await store.describeFolder(absBound, create) : null;
          // 绑定了绝对路径却用不了（路径是文件、没权限、create=false 且不存在）：直接报错，
          // 不要悄悄回落到项目根去建目录 —— 那会把底稿写到用户根本没指定的地方。
          if (absBound) {
            if (!hit || !hit.ok) return json({ ok: false, error: (hit && hit.error) || ('文件夹不可用：' + absBound) }, 400);
          } else {
            for (const n of names) { hit = await store.findProjectDir(n); if (hit) break; }
          }
          let created = false;
          if (!hit) {
            if (!create) {
              const { projectsDir } = await store.config();
              return json({ ok: false, error: '文件夹不存在：' + join(projectsDir, want || legacy) }, 400);
            }
            const r = await store.projectDir(want || legacy, true);
            if (!r.ok) return json({ ok: false, error: r.error }, 400);
            hit = r;
            created = true;
          }
          if (hit.created) created = true;
          const abs = hit.path;
          // sub=03底稿/管理类底稿/程序文件：项目界面里「打开文件夹」要能直接落到子目录
          const subParts = safeSubParts(Array.isArray(b.sub) ? b.sub.join('/') : String(b.sub || ''));
          const openTarget = subParts && subParts.length ? join(abs, ...subParts) : abs;
          if (openTarget !== abs) await mkdir(openTarget, { recursive: true });
          if (b.open !== false) {
            const o = await openShell(openTarget);
            if (!o.ok) return json({ ok: false, error: (o.error || '打开失败') + '；文件夹已建好：' + openTarget, path: openTarget }, 400);
          }
          return json({ ok: true, path: openTarget, name: hit.name, created, legacy: hit.name === legacy && legacy !== want, root: hit.root, bound: !!absBound, abs: abs });
        } catch (e) { return json({ ok: false, error: String(e.message || e) }, 500); }
      },
    },
    {
      // 新建一个项目文件夹并返回绝对路径（不打开）。
      // POST /project/folder/new { parent?, name, year?, code?, shortName?, sub? }
      //  - parent 给了就在 parent 下建（用户可以选到任意位置，比如 OneDrive 的客户目录）；
      //  - 没给就用「项目目录」根（00项目ing）；
      //  - name 省略时按「项目编号 项目简称」生成。
      // 只建目录、不改数据；前端拿到 path 后自己写进 project.folderPath。
      path: PREFIX + '/project/folder/new', methods: ['POST'], fetch: async (req) => {
        try {
          const b = await req.json().catch(() => ({}));
          const code = cleanSegment(b.code, 80);
          const shortName = cleanSegment(b.shortName || b.name, 120);
          // 命名必须和客户端 folderNameOf() 完全一致（<项目编号> <项目简称>，不带年份）：
          // 否则绑定后按名字回落查找会找不到「同一个」目录，出现两份项目文件夹。
          const autoName = b.name
            ? safeFolderName(b.name)
            : safeFolderName([code, shortName].filter(Boolean).join(' ') || '未命名项目');
          if (!autoName) return json({ ok: false, error: '文件夹名不合法' }, 400);
          const parentRaw = String(b.parent || '').trim();
          let parent = '';
          if (parentRaw) {
            const p = await store.describeFolder(parentRaw, true);
            if (!p || !p.ok) return json({ ok: false, error: (p && p.error) || '父目录不合法：' + parentRaw }, 400);
            parent = p.path;
          } else {
            parent = (await store.config()).projectsDir;
          }
          const target = join(parent, autoName);
          if (existsSync(target)) {
            const sub = safeSubParts(Array.isArray(b.sub) ? b.sub.join('/') : String(b.sub || ''));
            const abs = sub && sub.length ? join(target, ...sub) : target;
            if (abs !== target) await mkdir(abs, { recursive: true });
            return json({ ok: true, path: abs, dir: target, name: autoName, parent, existed: true, created: false });
          }
          const sub = safeSubParts(Array.isArray(b.sub) ? b.sub.join('/') : String(b.sub || ''));
          const abs = sub && sub.length ? join(target, ...sub) : target;
          await mkdir(abs, { recursive: true });
          return json({ ok: true, path: abs, dir: target, name: autoName, parent, existed: false, created: true });
        } catch (e) { return json({ ok: false, error: String(e.message || e) }, 500); }
      },
    },
    {
      // 探测一个绝对路径：是不是目录、里面有什么（绑定已有文件夹前先看一眼，避免绑错）
      // POST /project/folder/probe { path }
      path: PREFIX + '/project/folder/probe', methods: ['POST'], fetch: async (req) => {
        try {
          const b = await req.json().catch(() => ({}));
          const d = await store.describeFolder(b.path, false);
          if (!d) return json({ ok: false, error: '请填绝对路径，例如 ' + (await store.config()).projectsDir }, 400);
          if (!d.ok) return json({ ok: false, error: d.error, path: d.path, name: d.name }, 200);
          // 目录概况：一级子目录数与文件数，界面显示「已绑定 · 12 个子目录」这类提示
          let dirs = 0, files = 0, sample = [];
          try {
            const names = await readdir(d.path, { withFileTypes: true });
            for (const it of names) {
              if (it.isDirectory()) { dirs += 1; if (sample.length < 8) sample.push(it.name + '/'); }
              else files += 1;
            }
          } catch (e) { /* 读不了内容不算探测失败 */ }
          return json({ ok: true, path: d.path, name: d.name, parent: d.root, dirs, files, sample });
        } catch (e) { return json({ ok: false, error: String(e.message || e) }, 500); }
      },
    },
    {
      // 合同扫描件落盘：POST /project/upload?folder=<项目文件夹>&sub=02现场资料/业务委托合同&name=<文件名>
      // 请求体是文件原始字节（不走 base64，几十 MB 的扫描件也不至于把 JSON 撑爆）。
      path: PREFIX + '/project/upload', methods: ['POST'], fetch: async (req) => {
        try {
          const u = new URL(req.url || '/', 'http://workbench.local');
          const folder = safeFolderName(u.searchParams.get('folder'));
          const absBound = String(u.searchParams.get('abs') || '').trim();
          if (!folder && !absBound) return json({ ok: false, error: '项目文件夹名不合法（先填项目编号与项目简称）' }, 400);
          const subParts = safeSubParts(u.searchParams.get('sub'));
          if (!subParts) return json({ ok: false, error: '目标子目录不合法' }, 400);
          const fileName = safeFileSegment(u.searchParams.get('name'));
          if (!fileName) return json({ ok: false, error: '文件名为空或不合法' }, 400);
          const buf = Buffer.from(await req.arrayBuffer());
          if (!buf.length) return json({ ok: false, error: '文件内容为空' }, 400);
          if (buf.length > MAX_UPLOAD) return json({ ok: false, error: '文件超过 ' + Math.round(MAX_UPLOAD / 1048576) + ' MB，请先压缩' }, 400);
          // 绑定了绝对路径就用它；否则按名字找（老逻辑），找不到再建
          let base = absBound ? await store.describeFolder(absBound, true) : null;
          if (absBound && (!base || base.ok === false)) {
            return json({ ok: false, error: (base && base.error) || ('项目文件夹不可用：' + absBound) }, 400);
          }
          if (!base || base.ok === false) {
            const byName = await store.findProjectDir(folder);
            if (byName) base = { ok: true, ...byName };
            else if (folder) {
              const made = await store.projectDir(folder, true);
              if (!made.ok) return json({ ok: false, error: made.error }, 400);
              base = made;
            }
          }
          if (!base || base.ok === false) return json({ ok: false, error: (base && base.error) || '项目文件夹不存在' }, 400);
          const targetDir = join(base.path, ...subParts);
          await mkdir(targetDir, { recursive: true });
          const abs = join(targetDir, fileName);
          await writeFile(abs, buf);
          const result = { ok: true, path: abs, rel: abs.slice(base.root.length + 1), bytes: buf.length };
          // parse=1：顺手解析这份合同并抽成表单字段（解析失败不影响文件已经存好）
          if (u.searchParams.get('parse') === '1') {
            try {
              const doc = await extractDocumentText(abs);
              const fields = await extractContractFields(ctx, doc.text, {
                provider: u.searchParams.get('provider') || '',
                model: u.searchParams.get('model') || '',
              });
              result.parsed = { via: doc.via, chars: doc.text.length, fields };
            } catch (e) {
              result.parseError = String((e && e.message) || e).slice(0, 300);
            }
          }
          return json(result);
        } catch (e) { return json({ ok: false, error: String(e.message || e) }, 500); }
      },
    },
    {
      // 企业信息补全：POST /api/workbench/company/lookup { name }
      // 有企查查·企业工商连接就走 MCP；没连或查不到会带 error 返回，前端提示后仍可手填。
      path: PREFIX + '/company/lookup', methods: ['POST'], fetch: async (req) => {
        try {
          const b = await req.json().catch(() => ({}));
          const name = String(b.name || '').trim();
          if (!name) return json({ ok: false, error: '公司名称为空' }, 400);
          const r = await qccLookupCompany(ctx, name);
          return json(r, 200);
        } catch (e) { return json({ ok: false, error: String((e && e.message) || e).slice(0, 300) }, 400); }
      },
    },
    {
      // 委托人简称：按委托人名称生成。优先大模型，模型不可用/输出不像话时退回本地规则。
      path: PREFIX + '/company/shortname', methods: ['POST'], fetch: async (req) => {
        try {
          const b = await req.json().catch(() => ({}));
          const name = String(b.name || '').trim();
          if (!name) return json({ ok: false, error: '公司名称为空' }, 400);
          const ai = await llmShortName(ctx, name);
          if (ai) return json({ ok: true, shortName: ai, mode: 'model' });
          const rule = ruleShortName(name);
          if (!rule) return json({ ok: false, error: '按名称生成简称失败' }, 400);
          return json({ ok: true, shortName: rule, mode: 'rule' });
        } catch (e) { return json({ ok: false, error: String((e && e.message) || e).slice(0, 200) }, 400); }
      },
    },
    {
      // 企业一句话简介（搜索 + 模型压缩）：POST /company/intro { name }
      path: PREFIX + '/company/intro', methods: ['POST'], fetch: async (req) => {
        try {
          const body = (req.body && typeof req.body === 'object' && !(req.body instanceof ReadableStream))
            ? req.body
            : await req.json().catch(() => ({}));
          const name = String(body.name || '').trim();
          if (!name) return json({ ok: false, intro: '', error: '企业名称为空' }, 400);
          const intro = await companyIntro(ctx, name);
          return json({ ok: true, intro });
        } catch (e) { return json({ ok: false, intro: '', error: String((e && e.message) || e) }, 200); }
      },
    },
    {
      // 看看项目文件夹里已经有哪些合同文件 / markdown（打开「合同信息」时自动带出来）
      path: PREFIX + '/project/contract-files', methods: ['POST'], fetch: async (req) => {
        try {
          const b = await req.json().catch(() => ({}));
          const folder = safeFolderName(b.folder);
          const absBound = String(b.abs || '').trim();
          if (!folder && !absBound) return json({ ok: false, files: [], md: [], error: '项目文件夹名不合法' }, 400);
          const subParts = safeSubParts(b.sub || '02现场资料/业务委托合同');
          if (!subParts) return json({ ok: false, files: [], md: [], error: '子目录不合法' }, 400);
          let bound = absBound ? await store.describeFolder(absBound, false) : null;
          if (absBound && (!bound || bound.ok === false)) {
            return json({ ok: false, files: [], md: [], error: (bound && bound.error) || ('项目文件夹不可用：' + absBound) }, 200);
          }
          const hit = bound || await store.findProjectDir(folder);
          const root = hit ? hit.path : join((await store.config()).projectsDir, folder);
          const d = join(root, ...subParts);
          if (!existsSync(d)) return json({ ok: true, files: [], md: [], dir: d });
          const names = await readdir(d);
          const files = names.filter(n => /\.(pdf|docx?|jpe?g|png|bmp|tiff?)$/i.test(n)).sort();
          const md = names.filter(n => /\.md$/i.test(n)).sort();
          return json({ ok: true, files, md, dir: d, rel: (hit ? hit.name : folder) + sep + d.slice(root.length + 1) });
        } catch (e) { return json({ ok: false, files: [], md: [], error: String((e && e.message) || e).slice(0, 200) }, 200); }
      },
    },
    {
      // 合同两步：mode=md 只转 markdown（复用已有的），mode=fill 读 markdown 让模型填表
      path: PREFIX + '/project/parse', methods: ['POST'], fetch: async (req) => {
        try {
          const b = await req.json().catch(() => ({}));
          const mode = String(b.mode || 'all');
          const folder = safeFolderName(b.folder);
          const absBound = String(b.abs || '').trim();
          if (!folder && !absBound) return json({ ok: false, error: '项目文件夹名不合法（先填项目编号与项目简称）' }, 400);
          const subParts = safeSubParts(b.sub);
          if (!subParts) return json({ ok: false, error: '目标子目录不合法' }, 400);
          const fileName = safeFileSegment(b.name);
          if (!fileName) return json({ ok: false, error: '文件名为空或不合法' }, 400);
          const bound = absBound ? await store.describeFolder(absBound, false) : null;
          const hit = (bound && bound.ok) ? bound : await store.findProjectDir(folder);
          const root = hit ? hit.path : join((await store.config()).projectsDir, folder);
          const relPrefix = hit && hit.bound ? '' : (hit ? hit.name + sep : folder + sep);
          const abs = join(root, ...subParts, fileName);
          if (!existsSync(abs)) return json({ ok: false, error: '文件不存在，请先点「添加」：' + abs }, 400);
          const mdName = fileName.replace(/\.[^.]+$/, '') + '.md';
          const mdAbs = join(root, ...subParts, mdName);
          const mdRel = relPrefix + mdAbs.slice(root.length + 1);

          // 1) 转 markdown：已有且不比原文件旧就直接复用
          let text = '';
          let via = 'markdown';
          let reused = false;
          if (existsSync(mdAbs)) {
            try {
              const mdTime = statSync(mdAbs).mtimeMs;
              const srcTime = statSync(abs).mtimeMs;
              if (mdTime >= srcTime) { text = await readFile(mdAbs, 'utf8'); reused = true; }
            } catch (e) { /* 读不到就重新取文 */ }
          }
          if (!reused && mode !== 'fill') {
            const doc = await extractDocumentText(abs);
            text = String(doc.text || '');
            via = doc.via;
            await writeFile(mdAbs, '# ' + fileName + '\n\n' + text + '\n', 'utf8');
          }
          if (mode === 'md') {
            return json({ ok: true, via, reused, chars: String(text || '').length, md: mdRel });
          }
          if (mode === 'fill' && !String(text || '').trim()) {
            return json({ ok: false, error: '还没有 markdown：先点「转换为 md」', md: mdRel }, 400);
          }

          // 2) 让模型按 markdown 填表
          let fields = null;
          let fieldError = '';
          try {
            fields = await extractContractFields(ctx, text, { provider: b.provider, model: b.model });
          } catch (e) {
            fieldError = String((e && e.message) || e).slice(0, 300);
          }
          return json({ ok: true, via, reused, chars: String(text || '').length, md: mdRel, fields, fieldError });
        } catch (e) { return json({ ok: false, error: String((e && e.message) || e).slice(0, 300) }, 200); }
      },
    },
    {
      // 可用模型清单（合同解析用）：GET /company/models
      path: PREFIX + '/company/models', methods: ['GET', 'HEAD'], fetch: async () => {
        try {
          return json(await listModelChoices(ctx), 200);
        } catch (e) { return json({ ok: false, providers: [], error: String((e && e.message) || e) }, 200); }
      },
    },
    {
      path: PREFIX + '/store/state', methods: ['GET', 'HEAD', 'POST'], fetch: async (req) => {
        try {
          if (req.method === 'GET' || req.method === 'HEAD') return json(await store.readState());
          const b = await req.json().catch(() => ({}));
          const r = await store.writeState(b.data || {});
          return json(r, r.ok ? 200 : 400);
        } catch (e) { return json({ error: String(e.message || e) }, 500); }
      },
    },
    {
      // 股权信息批量导入：POST /project/equity/import?name=xx.xlsx（请求体是文件原始字节）
      path: PREFIX + '/project/equity/import', methods: ['POST'], fetch: async (req) => {
        try {
          const u = new URL(req.url || '/', 'http://workbench.local');
          const rawName = decodeURIComponent(u.searchParams.get('name') || 'import.xlsx');
          const name = safeFileSegment(rawName) || ('import-' + Date.now() + '.xlsx');
          const buf = Buffer.from(await req.arrayBuffer());
          if (!buf.length) return json({ ok: false, error: '文件内容为空' }, 400);
          if (buf.length > 8 * 1024 * 1024) return json({ ok: false, error: '文件超过 8 MB，请只留数据行' }, 400);
          const { dir } = await store.config();
          const tmpDir = join(dir, '.tmp');
          await mkdir(tmpDir, { recursive: true });
          const tmp = join(tmpDir, 'equity-' + Date.now() + '-' + name);
          await writeFile(tmp, buf);
          let out;
          try {
            out = await equityScript(['import', tmp]);
          } finally {
            try { await rm(tmp, { force: true }); } catch (e) {}
          }
          return json({ ok: true, rows: (out && out.rows) || [] });
        } catch (e) {
          return json({ ok: false, error: String((e && e.message) || e).slice(0, 300) }, 400);
        }
      },
    },
    {
      // 股权信息导入模板（xlsx）：GET /project/equity/template
      path: PREFIX + '/project/equity/template', methods: ['GET', 'HEAD'], fetch: async () => {
        try {
          const { dir } = await store.config();
          const tmpDir = join(dir, '.tmp');
          await mkdir(tmpDir, { recursive: true });
          const out = join(tmpDir, 'equity-template-' + Date.now() + '.xlsx');
          await equityScript(['template', out]);
          const buf = await readFile(out);
          try { await rm(out, { force: true }); } catch (e) {}
          return new Response(buf, {
            status: 200,
            headers: {
              'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'content-disposition': 'attachment; filename="company-import-template.xlsx"',
              'cache-control': 'no-store',
              'content-length': String(buf.length),
            },
          });
        } catch (e) {
          return json({ ok: false, error: String((e && e.message) || e).slice(0, 300) }, 500);
        }
      },
    },
    {
      // 财务资料导入（科目余额表 → 科目名 + 金额）：POST /project/finance/import?name=xx.xlsx（请求体是文件原始字节）
      path: PREFIX + '/project/finance/import', methods: ['POST'], fetch: async (req) => {
        try {
          const u = new URL(req.url || '/', 'http://workbench.local');
          const rawName = decodeURIComponent(u.searchParams.get('name') || 'import.xlsx');
          const name = safeFileSegment(rawName) || ('import-' + Date.now() + '.xlsx');
          const buf = Buffer.from(await req.arrayBuffer());
          if (!buf.length) return json({ ok: false, error: '文件内容为空' }, 400);
          if (buf.length > 8 * 1024 * 1024) return json({ ok: false, error: '文件超过 8 MB，请只留数据行' }, 400);
          const { dir } = await store.config();
          const tmpDir = join(dir, '.tmp');
          await mkdir(tmpDir, { recursive: true });
          const tmp = join(tmpDir, 'finance-' + Date.now() + '-' + name);
          await writeFile(tmp, buf);
          let out;
          try {
            out = await financeScript(['import', tmp]);
          } finally {
            try { await rm(tmp, { force: true }); } catch (e) {}
          }
          return json({ ok: true, rows: (out && out.rows) || [], sheet: (out && out.sheet) || '', header: (out && out.header) || 0 });
        } catch (e) {
          return json({ ok: false, error: String((e && e.message) || e).slice(0, 300) }, 400);
        }
      },
    },
    {
      // 项目文件夹模板：POST /project/folders/build { folder, companies:[{ name, methods:{whole,part}, subjects:[{name,amount}] }] }
      // 幂等：已存在的目录跳过，只报新建了多少。模板规则全在 folders.js（planProjectFolders）。
      path: PREFIX + '/project/folders/build', methods: ['POST'], fetch: async (req) => {
        try {
          const b = await req.json().catch(() => ({}));
          const folder = safeFolderName(b.folder || '');
          const absBound = String(b.abs || '').trim();
          if (!folder && !absBound) return json({ ok: false, error: '项目文件夹名不合法（先填项目编号与项目简称）' }, 400);
          let base = absBound ? await store.describeFolder(absBound, true) : null;
          if (absBound && (!base || base.ok === false)) {
            return json({ ok: false, error: (base && base.error) || ('项目文件夹不可用：' + absBound) }, 400);
          }
          if (!base || base.ok === false) {
            const byName = folder ? await store.findProjectDir(folder) : null;
            if (byName) base = { ok: true, ...byName };
            else if (folder) {
              const made = await store.projectDir(folder, true);
              if (!made.ok) return json({ ok: false, error: made.error }, 400);
              base = made;
            }
          }
          if (!base || base.ok === false) return json({ ok: false, error: (base && base.error) || '项目文件夹不存在' }, 400);
          const root = base.path;
          await mkdir(root, { recursive: true });
          // 目录计划：固定骨架取「文件夹模板」页保存的模板（没保存过用内置默认），
          // 公司相关目录（00财务资料/<公司> 等）仍按 folders.js 规则动态补齐。
          let plan;
          try {
            const tpl = await readFolderTemplate();
            plan = folderTemplatePlan(tpl, Array.isArray(b.companies) ? b.companies : []);
          } catch (e) {
            plan = planProjectFolders({ companies: Array.isArray(b.companies) ? b.companies : [] });
          }
          let created = 0;
          let existed = 0;
          for (const rel of plan) {
            const parts = safeSubParts(rel);
            if (!parts || !parts.length) continue;
            const abs = join(root, ...parts);
            if (existsSync(abs)) { existed += 1; continue; }
            await mkdir(abs, { recursive: true });
            created += 1;
          }
          return json({
            ok: true, root, total: plan.length, created, existed,
            companies: (Array.isArray(b.companies) ? b.companies : []).length,
            dirs: plan.slice(0, 80),
          });
        } catch (e) {
          return json({ ok: false, error: String((e && e.message) || e).slice(0, 300) }, 500);
        }
      },
    },
    {
      // 文件夹模板（参数设定页）：GET 读 / POST 存 / DELETE 恢复内置默认。
      // GET 返回 { ok, template, isDefault }：文件不存在时 isDefault=true 且返回内置默认树。
      // POST 体为 { template }；DELETE 删掉保存的模板文件（= 回内置默认）。规则见 folder-template.js。
      path: PREFIX + '/project/folders/template', methods: ['GET', 'POST', 'DELETE'], fetch: (req) => folderTemplateRequest(req),
    },
    {
      // 归档预览（只读）：POST /project/archive/preview { folder, code, shortName, name, year }
      // 返回项目里「04项目归档」的内容清单 + 目标目录，前端弹窗让用户确认后才 commit。
      path: PREFIX + '/project/archive/preview', methods: ['POST'], fetch: async (req) => {
        try {
          const b = await req.json().catch(() => ({}));
          const r = await archive.preview(b);
          return json(r, r.ok ? 200 : 400);
        } catch (e) { return json({ ok: false, error: String(e.message || e) }, 500); }
      },
    },
    {
      // 执行归档：POST /project/archive/commit
      // 整个项目文件夹移到 归档根\{年份}年\{项目编号 项目简称}；成功后就地触发一次增量扫描更新文件库。
      path: PREFIX + '/project/archive/commit', methods: ['POST'], fetch: async (req) => {
        try {
          const b = await req.json().catch(() => ({}));
          const r = await archive.commit(b);
          if (!r.ok) return json(r, 400);
          let scan = null;
          let scanError = '';
          try {
            scan = await scanner.startScan({ full: false, wordFirst: true });
            if (scan && scan.ok === false) { scanError = scan.error || '扫描未能启动'; scan = null; }
          } catch (e) { scanError = String((e && e.message) || e); }
          // 已有扫描在跑时，它可能已经遍历过刚归档的目录：等这一轮结束再补一轮增量扫描。
          // 用 globalThis 标记避免连续归档时排队多轮。
          let scanPending = false;
          if (scan && scan.already) {
            scanPending = true;
            const G = globalThis;
            if (!G.__dshWorkbenchArchiveRescan) {
              G.__dshWorkbenchArchiveRescan = true;
              Promise.resolve()
                .then(() => scanner.waitForScan())
                .then(() => scanner.startScan({ full: false, wordFirst: true }))
                .catch(() => {})
                .finally(() => { G.__dshWorkbenchArchiveRescan = false; });
            }
          }
          // 归档库缓存立刻失效：即使扫描还在跑，文件库的项目列表也会重新读磁盘
          try { lib.refresh(); } catch (e) {}
          return json({ ...r, scan, scanError, scanPending });
        } catch (e) { return json({ ok: false, error: String(e.message || e) }, 500); }
      },
    },
    {
      // 打开归档后的项目目录（只允许归档根之内）
      path: PREFIX + '/project/archive/open', methods: ['POST'], fetch: async (req) => {
        try {
          const b = await req.json().catch(() => ({}));
          const r = await archive.openArchived(b.rel || b.path || '');
          return json(r, r.ok ? 200 : 400);
        } catch (e) { return json({ ok: false, error: String(e.message || e) }, 500); }
      },
    },
    {
      // 工作台「助手」浮动对话窗的后端：SSE 流式回答，只读上下文 + 白名单命令
      path: PREFIX + '/assistant/chat', methods: ['POST'], fetch: async (req) => runAssistantChat(ctx, req),
    },
    {
      path: PREFIX + '/data/calendar', methods: ['GET', 'HEAD'], fetch: async () => {
        try {
          const raw = await readFile(new URL('./data/exam-calendar.json', import.meta.url), 'utf8');
          return new Response(raw, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
        } catch (e) { return json({ exams: [], error: String(e.message || e) }); }
      },
    },
  ];
  ctx.effect(() => {
    const reg = ctx.connection && ctx.connection.fetch;
    if (!reg || typeof reg.register !== 'function') {
      ctx.logger && ctx.logger.warn && ctx.logger.warn('[workbench] connection.fetch unavailable; proxy routes disabled');
      return () => {};
    }
    const owners = globalThis.__dshWorkbenchRouteOwners;
    const token = Symbol('workbench:' + REV);   // 每次 apply 一个，用于认领/释放
    const mine = [];                             // 本实例登记成功的路径
    const disposers = [];
    for (const r of routes) {
      // 另一个 entry 已经注册过同一路径 -> 跳过，避免「精确路径重复注册」抛错
      if (owners.has(r.path)) continue;
      try {
        disposers.push(reg.register({ path: r.path, methods: r.methods, requestBody: r.requestBody || 'buffered', fetch: r.fetch }));
        owners.set(r.path, token);
        mine.push(r.path);
      } catch (e) {
        ctx.logger && ctx.logger.warn && ctx.logger.warn('[workbench] 路由注册失败 ' + r.path + ': ' + (e && e.message));
      }
    }
    // 落一个「宿主代码版本 + 注册结果」标记文件：改完插件排障时，先看它就知道
    // 运行中的进程到底加载了哪一版代码、/lib/scan 有没有注册上。GUI 的 API 走
    // dsh-app:// 通道，外部没法用 curl 探活，这个文件是唯一稳定的外部证据。
    // 只在 Electron 宿主进程里写：本地测试脚本也是 node，会污染这份证据文件
    // （曾出现 marker 里的 pid 属于早已退出的测试进程，导致误判「宿主没重载」）。
    try {
      if (!process.versions.electron) throw new Error('not electron');
      writeFileSync(
        join(homedir(), '.dsh', 'workbench-host-applied.json'),
        JSON.stringify({
          rev: REV,
          at: new Date().toISOString(),
          pid: process.pid,
          electron: process.versions.electron || null,
          routes: routes.map(r => r.path),
          registered: mine,          // 本实例认领的（两个 entry 里通常只有一个非空）
          totalRegistered: owners.size,  // 全进程实际在册的路由数 —— 这才是「文件库可用吗」的答案
          allPaths: [...owners.keys()],  // 在册路径全集（含另一个 entry 认领的）
          disposers: disposers.length,
          // 本实例实际 import 到的 library.js 是哪一版：true = 带 resolveLibPath 的新版
          // （改完 library.js 却没重启时这里会是 false，能一眼看出代码没换）
          libRev: typeof lib.resolveLibPath === 'function' ? 'rev13' : 'old',
          // 数据落盘层（默认目录 / 配置文件路径）也在标记里露一眼，排障时不用反查代码
          // rev14 = store.js 里带 describeFolder/resolveProjectDir（绑定任意本地目录的那版）。
          // 这行是排障证据：宿主进程缓存了旧 store.js 时会显示 old/rev13，一眼看出绑定功能没生效。
          storeRev: typeof store.describeFolder === 'function' ? 'rev14-bind' : (typeof store.writeState === 'function' ? 'rev13' : 'old'),
          // macOS 移植：把实际解析到的 python 候选链露出来，取文/导入失败时能一眼定位
          python: PYTHON_CANDIDATES,
          serving: mine.length ? 'this-entry' : 'other-entry',
        }, null, 1),
        'utf8',
      );
    } catch (e) { /* 标记写失败不影响功能 */ }
    ctx.logger && ctx.logger.info && ctx.logger.info('[workbench] 已注册 ' + disposers.length + ' 条路由（含文件库 /lib/*）');
    return () => {
      for (const d of disposers) { try { d(); } catch (e) {} }
      if (mine.includes(PREFIX + '/ty/cli/login')) cliAuth.dispose();
      // 只释放自己认领的路径，别把另一个 entry 的路由从表里抹掉
      for (const p of mine) if (owners.get(p) === token) owners.delete(p);
    };
  }, 'workbench: API routes');

  // ---------- 面向助手的工作台工具 ----------
  // 工作台页面的「助手」模块复用 better-sidebar 的侧边对话；对话里的模型要能读工作台、
  // 触发导出，就得有对应的工具。用可选方式取 tools（ctx.get），拿不到就静默跳过 ——
  // 这个插件历史上曾因 inject 里写了不存在的服务而整条 entry 一直 pending。
  ctx.effect(() => {
    let tools = null;
    try { tools = typeof ctx.get === 'function' ? ctx.get('tools') : null; } catch (_) { tools = null; }
    if (!tools || typeof tools.register !== 'function') return () => {};
    const text = (obj) => [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }];
    const outSchema = { type: 'object' };
    const disposers = [];

    // 读工作台里的项目与工时；只读，不写数据。
    disposers.push(tools.register({
      name: 'workbench_projects',
      isConcurrencySafe: () => true,
      description: '列出个人工作台里的项目与工时记录。只读，不会修改任何数据。需要项目的天源数字 ID 时用这个（字段 tyId）。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '可选：按项目编号、名称或客户名过滤，不区分大小写。' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: '可选：最多返回多少个项目，默认 50。' },
        },
        additionalProperties: false,
      },
      output: { schema: outSchema, render: (_a, v) => text(v) },
      async execute(args) {
        const a = args && typeof args === 'object' ? args : {};
        const st = await store.readState();
        const data = (st && st.data) || {};
        const work = data.work || {};
        const projects = Array.isArray(work.projects) ? work.projects : [];
        const logs = Array.isArray(work.logs) ? work.logs : [];
        const kw = String(a.keyword || '').trim().toLowerCase();
        const limit = Number.isFinite(a.limit) ? Math.min(200, Math.max(1, a.limit)) : 50;
        const hit = kw
          ? projects.filter(p => [p.code, p.name, p.client].some(x => String(x || '').toLowerCase().includes(kw)))
          : projects;
        const hoursOf = id => logs.filter(l => l.projectId === id).reduce((n, l) => n + (Number(l.hours) || 0), 0);
        return {
          total: hit.length,
          returned: Math.min(hit.length, limit),
          projects: hit.slice(0, limit).map(p => ({
            id: p.id || null,
            code: p.code || null,
            name: p.name || null,
            client: p.client || null,
            stage: p.stage || null,
            deadline: p.deadline || null,
            baseDate: p.baseDate || null,
            budgetHours: Number(p.budgetHours) || 0,
            loggedHours: hoursOf(p.id),
            tyId: p.tyId || null,
          })),
          note: 'tyId 是天源系统的数字项目 ID，调用 workbench_export 时作为 projectId。',
        };
      },
    }));

    // 天源绑定状态：只报状态，绝不返回 token、Cookie 或授权链接。
    disposers.push(tools.register({
      name: 'workbench_status',
      isConcurrencySafe: () => true,
      description: '查看个人工作台与天源系统的绑定状态：MCP 是否连通（只报连通性与工具数）、CLI 本地凭据是否存在及到期时间。不会返回任何凭据内容。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: outSchema, render: (_a, v) => text(v) },
      async execute() {
        let mcp = { connected: false, state: 'unknown' };
        try { mcp = await ty.status(); } catch (_) {}
        let cli = { installed: false, authenticated: false, state: 'unknown' };
        try { cli = cliAuth.status(); } catch (_) {}
        // 天源直连接通路健康：MCP 可达性 + 可用工具数，让 Agent 一眼判断查询是否可用。
        let tianyuan = { mcpReachable: false, toolCount: 0, lastCheckedAt: new Date().toISOString(), note: '' };
        if (mcp.connected) {
          try {
            const list = await ty.listTools();
            tianyuan.mcpReachable = true;
            tianyuan.toolCount = Array.isArray(list) ? list.length : 0;
          } catch (e) {
            tianyuan.note = 'MCP 已配置但 tools/list 失败：' + String(e && e.message || e).slice(0, 120);
          }
        } else {
          tianyuan.note = 'MCP 未授权，先在「工作 → 连接设置」完成天源授权，或运行 tycpv login 刷新 CLI。';
        }
        return {
          mcp: { configured: !!mcp.connected, expired: !!mcp.expired, expiresAt: mcp.expiresAt || null, pending: !!mcp.pending },
          cli: { installed: !!cli.installed, authenticated: !!cli.authenticated, expiresAt: cli.expiresAt || null, state: cli.state || null, reason: cli.reason || '' },
          tianyuan,
          note: 'MCP 与 CLI 是两套独立凭据；本地凭据存在不等于远端授权仍然有效。二者都失效时，先在「工作 → 连接设置」重新授权。',
        };
      },
    }));

    // 天源直连查询三件套：拿 tyId → 拿评估结论 → 拿公司口径汇总表。
    // 数据纪律：聚合值逐字引用，禁止四舍五入/重算；refreshed=false 必须注明非最新口径。
    const tyAmount = v => (v === null || v === undefined) ? null : v; // 数值原样透传，不改口径

    // A1. 天源项目列表：用户问查天源项目/评估结论/导出天源表格时，先用本工具拿 tyId。
    disposers.push(tools.register({
      name: 'workbench_ty_projects',
      isConcurrencySafe: () => true,
      description: '查询天源评估系统里当前用户的全部评估项目（本地工作台之外的项目也在内）。用户提到查天源项目、查评估结论、导出天源表格时，先用本工具拿 tyId（数字项目 ID），不要去 OneDrive 目录翻文件。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '可选：按项目名或项目编号模糊过滤，不区分大小写。' },
        },
        additionalProperties: false,
      },
      output: { schema: outSchema, render: (_a, v) => text(v) },
      async execute(args) {
        const a = args && typeof args === 'object' ? args : {};
        const r = await ty.callTool('get_my_projects', {});
        const list = Array.isArray(r.data) ? r.data : [];
        const kw = String(a.keyword || '').trim().toLowerCase();
        const hit = kw
          ? list.filter(p => [p.projectName, p.projectCode].some(x => String(x || '').toLowerCase().includes(kw)))
          : list;
        return {
          ok: true,
          total: hit.length,
          projects: hit.map(p => ({
            tyId: p.id,
            projectCode: p.projectCode || null,
            projectName: p.projectName || null,
            department: p.executionDepartment || null,
            status: p.projectStatus ?? null,
            baseDate: p.evaluationBaseDate
              ? new Date(p.evaluationBaseDate).toISOString().slice(0, 10)
              : null,
          })),
          note: 'tyId 是天源数字项目 ID，后续用 workbench_ty_project_summary / workbench_ty_company_summary / workbench_export 时都作为 projectId 传入。',
        };
      },
    }));

    // A2. 项目汇总表：每家公司的最终评估结论。
    disposers.push(tools.register({
      name: 'workbench_ty_project_summary',
      isConcurrencySafe: () => true,
      description: '查询天源评估项目汇总表：每家公司的最终评估结论（评估价值/增减值/评估方法）。返回数值为元且逐字保留原始小数位，禁止四舍五入或换算成万元。refreshed=false 表示系统汇总未刷新，数据非最新底稿口径，回复时必须注明。',
      parameters: {
        type: 'object',
        properties: {
          tyId: { type: 'string', pattern: '^[0-9]+$', description: '天源数字项目 ID，来自 workbench_ty_projects 的 tyId 字段。' },
          detail: { type: 'boolean', description: '可选：默认精简输出（仅业务字段）。设为 true 时附完整远端返回（含 columnGroups 等元数据），体积大，仅在需要列 schema 时使用。' },
        },
        required: ['tyId'],
        additionalProperties: false,
      },
      output: { schema: outSchema, render: (_a, v) => text(v) },
      async execute(args) {
        const a = args && typeof args === 'object' ? args : {};
        const tyId = Number(String(a.tyId).trim());
        if (!Number.isInteger(tyId) || tyId <= 0) return { ok: false, reason: 'tyId 必须是天源数字项目 ID' };
        const r = await ty.callTool('get_project_summary', { projectId: tyId });
        const j = r.data;
        if (!j || typeof j !== 'object') return { ok: false, reason: 'get_project_summary 返回格式异常', raw: r.content };
        const rows = Array.isArray(j.rows) ? j.rows : [];
        const refreshed = !!(j.source && j.source.refreshed);
        // 精简输出：只留业务字段，过滤 columnGroups / metrics / warnings 等元数据（单次 3KB→几百字节）。
        // baseDate 摘自 filters（若远端有），其余元数据按需用 detail=true 取回。
        const filters = (j.filters && typeof j.filters === 'object') ? j.filters : {};
        const baseDate = filters.baseDate ?? filters.valuationDate ?? null;
        if (a.detail === true) {
          return { ok: true, projectId: tyId, projectName: j.projectName || null, refreshed,
            note: refreshed ? '系统汇总已刷新，为最新口径。' : '系统汇总未刷新（refreshed=false），数据为系统缓存口径，非最新底稿结果，回复时必须注明。',
            baseDate, companies: rows.map(row => ({ companyName: row.companyName || null })), full: j };
        }
        return {
          ok: true,
          projectId: tyId,
          projectName: j.projectName || null,
          refreshed,
          baseDate,
          note: refreshed
            ? '系统汇总已刷新，为最新口径。'
            : '系统汇总未刷新（refreshed=false），数据为系统缓存口径，非最新底稿结果，回复时必须注明。',
          companies: rows.map(row => ({
            companyName: row.companyName || null,
            shareholdingRatePercent: row.shareholdingRatePercent ?? null,
            valuationValue: tyAmount(row.valuationValue),
            valueAdded: tyAmount(row.valueAdded),
            finalMethod: row.finalMethod || null,
            status: row.statusName || row.status || null,
          })),
        };
      },
    }));

    // A3. 公司口径汇总表：资产基础法/收益法/市场法科目级汇总。
    disposers.push(tools.register({
      name: 'workbench_ty_company_summary',
      isConcurrencySafe: () => true,
      description: '查询天源项目下某家公司的评估方法汇总表（科目级结构化数据）。method: asset=资产基础法（默认）、income=收益法、market=市场法。需要先有 tyId；不确定 companyId 时可留空由系统返回全部公司。数值单位为元，逐字引用不换算。',
      parameters: {
        type: 'object',
        properties: {
          tyId: { type: 'string', pattern: '^[0-9]+$', description: '天源数字项目 ID。' },
          companyId: { type: 'string', pattern: '^[0-9]+$', description: '可选：公司数字 ID（来自 workbench_ty_export 上下文或 get_project_companies）。留空返回全部公司。' },
          method: { type: 'string', enum: ['asset', 'income', 'market'], description: '评估方法，默认 asset。' },
        },
        required: ['tyId'],
        additionalProperties: false,
      },
      output: { schema: outSchema, render: (_a, v) => text(v) },
      async execute(args) {
        const a = args && typeof args === 'object' ? args : {};
        const tyId = Number(String(a.tyId).trim());
        if (!Number.isInteger(tyId) || tyId <= 0) return { ok: false, reason: 'tyId 必须是天源数字项目 ID' };
        const method = ['income', 'market'].includes(a.method) ? a.method : 'asset';
        const remoteTool = {
          asset: 'get_company_asset_based_approach_summary',
          income: 'get_company_income_approach_summary',
          market: 'get_company_market_approach_summary',
        }[method];
        const call = {};
        if (a.companyId) call.companyId = Number(String(a.companyId).trim());
        const r = await ty.callTool(remoteTool, { projectId: tyId, ...call });
        return {
          ok: true,
          projectId: tyId,
          method,
          remoteTool,
          companyId: a.companyId ? Number(String(a.companyId).trim()) : null,
          data: r.data ?? r.content ?? null,
        };
      },
    }));

    // 触发天源导出：与页面按钮共用 runTyExport，避免两处逻辑漂移。
    disposers.push(tools.register({
      name: 'workbench_export',
      isConcurrencySafe: () => false,
      description: '从天源系统导出资产基础法明细表（detail）或申报表（declare），并逐个工作簿恢复公式、设置打印格式、校验后替换。会在本地新增导出批次目录，运行时间通常几十秒到几分钟。只对 tyId 已知的项目调用；不确定公司范围时不要传 companyIds，那会导出该项目下的全部公司。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['detail', 'declare'], description: 'detail 导出明细表（默认恢复公式并设置格式）；declare 导出申报表（设置申报表格式并做安全增删行，不恢复公式）。' },
          projectId: { type: 'string', pattern: '^[0-9]+$', description: '天源数字项目 ID，等于 workbench_projects 返回的 tyId。' },
          projectCode: { type: 'string', description: '可选：项目编号，仅用于拼输出目录名，例如「20261110001」。' },
          projectName: { type: 'string', description: '可选：项目简称，仅用于拼输出目录名。' },
          companyIds: { type: 'string', pattern: '^[0-9]+(,[0-9]+)*$', description: '可选：逗号分隔的公司数字 ID，只导出这些公司。留空则导出该项目下的全部公司。' },
          restoreFormulas: { type: 'boolean', description: '仅明细表有效，默认 true。设为 false 就跳过公式恢复。' },
          applyFormat: { type: 'boolean', description: '默认 true。设为 false 就跳过打印格式设置。明细表两项都关会被拒绝。' },
          outputDir: { type: 'string', description: '可选：已存在的绝对路径目录，导出批次会建在它下面。留空用工作台默认导出目录。' },
        },
        required: ['kind', 'projectId'],
        additionalProperties: false,
      },
      output: { schema: outSchema, render: (_a, v) => text(v) },
      async execute(args) {
        const r = await runTyExport(args && typeof args === 'object' ? args : {});
        const b = r.body || {};
        if (!b.ok && b.error) return { ok: false, error: b.error, outDir: b.outDir || null, results: b.results || [] };
        return b;
      },
    }));

    return () => { for (const d of disposers) { try { d(); } catch (_) {} } };
  }, 'workbench: agent tools');

  // ---------- 随插件分发的技能 ----------
  // 宿主的 skill 发现路径只扫文件系统目录（<dshHome>/skills 等），不扫 node_modules，
  // 所以打包进插件包的 SKILL.md 必须显式 register 才能被新会话的可用技能目录看到。
  // 参考 dsh-codex-style-computer-use 的做法：懒注入 ['skills']，缺失时降级为一行日志，
  // 不影响工具注册。用户在 <dshHome>/skills/tianyuan-query 有一份手工副本时，注册表按
  // 层级取优先级更高的那份，不会冲突。正文每次激活时从磁盘重读，不与包内文件漂移。
  ctx.effect(() => {
    let skills = null;
    try { skills = typeof ctx.get === 'function' ? ctx.get('skills') : null; } catch (_) { skills = null; }
    if (!skills || typeof skills.register !== 'function') return () => {};
    // 整段兜底：技能注册是附加能力，任何异常只降级为日志。
    // 绝不能让它把 apply() 抛穿——那会把本 entry 之前注册的 82 条路由一并回滚，
    // 前端只会看到宿主兜底的 404 "not found"（曾因 path 未导入踩过一次）。
    try {
      const skillDir = join(dirname(fileURLToPath(import.meta.url)), 'skills', 'tianyuan-query');
      const skillFile = join(skillDir, 'SKILL.md');
      let raw;
      try { raw = readFileSync(skillFile, 'utf8'); } catch (e) {
        ctx.logger && ctx.logger.warn && ctx.logger.warn('[workbench] 内置技能不可读: ' + e.message);
        return () => {};
      }
      // 读 frontmatter 的 name/description；缺任何一个都不注册（和宿主校验口径一致）。
      let name = '', desc = '';
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
      if (fm) {
        for (const line of fm[1].split(/\r?\n/)) {
          const m = /^(name|description):\s*(.*)$/.exec(line);
          if (m) { if (m[1] === 'name') name = m[2].trim(); else desc = m[2].trim(); }
        }
      }
      if (!name || !desc) {
        ctx.logger && ctx.logger.warn && ctx.logger.warn('[workbench] 内置技能缺 name/description frontmatter，未注册');
        return () => {};
      }
      try {
        skills.register({
          name,
          description: desc,
          source: 'bundled',
          content: raw.slice(fm ? fm[0].length : 0),
          resourceBase: { kind: 'directory', path: skillDir },
        });
        ctx.logger && ctx.logger.info && ctx.logger.info('[workbench] 已注册内置技能 ' + name);
      } catch (e) {
        ctx.logger && ctx.logger.warn && ctx.logger.warn('[workbench] 内置技能注册被拒 (' + name + '): ' + e.message);
      }
    } catch (e) {
      ctx.logger && ctx.logger.warn && ctx.logger.warn('[workbench] 内置技能注册异常，已跳过: ' + (e && e.message || e));
    }
    return () => {};
  }, 'workbench: bundled skill registration');
}
export { name, inject };

export { ruleExtractFields };   // 给测试用：规则兜底单独验证
