// 文件夹模板：项目文件夹骨架的可配置参数页（与「报告格式」页同一思路）。
// 数据模型是一棵目录树：
//   { version: 1, groups: [ { name, children: [ { name, children? } ] } ] }
// 约束：
//   - 这棵树只描述「固定骨架」（01前期资料 / 02现场资料 / 03评估底稿 / 04项目归档 及其子目录）；
//   - 每家被评估单位的 00财务资料/<公司>、02基础类/<公司>/…、03资产基础法/<公司>/<科目>、
//     04收益法 / 05市场法 子目录仍由 folders.js 的规则按公司+方法+科目动态补齐，不进模板；
//   - 建目录是幂等补齐：改模板只影响之后新建的目录，已存在的目录不会被删掉。
// 持久化：~/.tycpv/folder-template.json（缺省即内置默认，文件不存在 = 用默认）。

import { open, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { STATIC_DIRS, MGMT_FOLDER, MGMT_CATEGORIES, BASIC_CATEGORIES, INCOME_CHILDREN, AB_SUBJECTS, abFoldersFor, abExtraFolders, FIN_STATEMENT_DIR, AUDIT_REPORT_DIR, TB_DIR, AUX_DIR, GL_DIR } from './folders.js';

export const FOLDER_TEMPLATE_PATH = join(homedir(), '.tycpv', 'folder-template.json');
export const MAX_FOLDER_TEMPLATE_BYTES = 256 * 1024;

class FolderTemplateError extends Error {}
function fail(message) { throw new FolderTemplateError(message); }

// 内置默认树（与 folders.js 的 STATIC_DIRS + 管理类底稿完全一致）
function defaultTreeFromPaths() {
  const root = { name: '', children: [] };
  const ensure = (parts) => {
    let cur = root;
    parts.forEach(seg => {
      if (!seg) return;
      let next = cur.children.find(c => c.name === seg);
      if (!next) { next = { name: seg, children: [] }; cur.children.push(next); }
      cur = next;
    });
  };
  STATIC_DIRS.forEach(p => ensure(p.split('/')));
  ensure(MGMT_FOLDER.split('/'));
  MGMT_CATEGORIES.forEach(cat => ensure(MGMT_FOLDER.split('/').concat(cat)));
  // 完整模板树：企业提供资料下五个方法段全部展开（用户要求——模板页就是全部目录的全集，
  // 生成项目时按公司勾选的方法/科目从这个全集里过滤加载，不在此处动态拼）。
  ['00财务资料', '02基础类', '03资产基础法', '04收益法', '05市场法'].forEach(seg => {
    ensure(['02现场资料', '企业提供资料', seg]);
    if (seg === '00财务资料') [FIN_STATEMENT_DIR, AUDIT_REPORT_DIR, TB_DIR, AUX_DIR, GL_DIR].forEach(d => ensure(['02现场资料', '企业提供资料', seg, d]));
    if (seg === '02基础类') BASIC_CATEGORIES.forEach(cat => ensure(['02现场资料', '企业提供资料', seg, cat]));
    if (seg === '04收益法') INCOME_CHILDREN.forEach(ch => ensure(['02现场资料', '企业提供资料', seg, ch]));
    if (seg === '03资产基础法') AB_SUBJECTS.forEach(def => {
      const subjBase = ['02现场资料', '企业提供资料', seg, def.folder];
      ensure(subjBase);
      ensure(subjBase.concat('查证资料'));
      abExtraFolders(def.folder).forEach(x => ensure(subjBase.concat(x)));
      (def.children || []).forEach(ch => {
        const chBase = subjBase.concat(ch);
        ensure(chBase);
        ensure(chBase.concat('查证资料'));
        ensure(chBase.concat('其他'));
      });
    });
  });
  // 通用递归序列化：固定三层 map 会把第 4 层（如 04收益法/07折现率）丢掉
  const ser = n => {
    const out = { name: n.name };
    if (n.children && n.children.length) out.children = n.children.map(ser);
    return out;
  };
  return { version: 1, groups: root.children.map(ser) };
}
export const DEFAULT_FOLDER_TEMPLATE = defaultTreeFromPaths();

function validSeg(t) {
  if (typeof t !== 'string') return false;
  const s = t.trim();
  return !!s && !/[\\/:*?"<>|\u0000-\u001f]/.test(s) && s.length <= 120 && !/^[.\s]+$/.test(s);
}

// 校验 + 规范化（trim 每级名字）
export function validateFolderTemplate(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) fail('模板必须是对象');
  if (t.version !== 1) fail('模板 version 必须为 1');
  if (!Array.isArray(t.groups)) fail('模板 groups 必须是数组');
  if (t.groups.length > 60) fail('一级目录最多 60 个');
  let count = 0;
  const walk = (node, depth, path) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) fail(path + ' 必须是对象');
    if (!validSeg(node.name)) fail(path + '.name 不合法（不能含 / \\ : * ? " < > | 等字符）');
    count += 1;
    if (count > 400) fail('目录总数最多 400 个');
    if (depth > 5) fail('目录层级最多 5 层');
    if ('children' in node) {
      if (!Array.isArray(node.children)) fail(path + '.children 必须是数组');
      node.children.forEach((c, i) => walk(c, depth + 1, path + '/' + node.name));
    }
  };
  const seen = new Set();
  t.groups.forEach((g, i) => {
    walk(g, 1, 'groups[' + i + ']');
    if (seen.has(g.name)) fail('一级目录重复：' + g.name);
    seen.add(g.name);
  });
  return { version: 1, groups: t.groups };
}

// 树 → 相对路径列表（建目录顺序：先父后子，深度优先）
export function treeToPaths(t) {
  const out = [];
  const walk = (node, prefix) => {
    const p = prefix ? prefix + '/' + node.name : node.name;
    out.push(p);
    (node.children || []).forEach(c => walk(c, p));
  };
  (t.groups || []).forEach(g => walk(g, ''));
  return out;
}

// 公司相关目录：每家公司一套（00财务资料/<公司>、02基础类/<公司>/<分类>、
// 03资产基础法/<公司>/<有金额的科目>、04收益法/<公司>/01~07、05市场法/<公司>）。
// 规则与 folders.js planProjectFolders 的公司段一致；方法没有选的目录不建。
function companyPaths(companies, template) {
  const rows = Array.isArray(companies) ? companies : [];
  const out = [];
  const seen = new Set();
  const push = p => { if (p && !seen.has(p)) { seen.add(p); out.push(p); } };
  const safeSeg = name => {
    const t2 = String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '');
    return t2.slice(0, 80) || '未命名公司';
  };
  // 完整模板树里的方法段全集：生成时按「公司勾的方法 + 有金额科目」从中过滤，
  // 不再动态拼科目夹（模板树就是目录全集，单一事实来源）。
  const segPrefix = '02现场资料/企业提供资料/';
  const full = treeToPaths(template || DEFAULT_FOLDER_TEMPLATE).filter(p => p.startsWith(segPrefix));
  const keep = full.filter(p => {
    const rest = p.slice(segPrefix.length);
    if (rest.startsWith('03资产基础法/')) {
      // 资产基础法段：保留 03资产基础法 本身；科目夹只留有金额科目对应的；
      // 科目夹下的 查证资料/类型子夹/明细 全部跟随其科目夹
      const segs = rest.split('/');
      if (segs.length === 1) return true;
      const subjFolder = segs[1];
      return subjectsOf(companies, subjFolder);
    }
    return true;
  });
  const used = new Map();
  rows.forEach(c => {
    const name = String((c && c.name) || '').trim();
    if (!name) return;
    const n = (used.get(safeSeg(name)) || 0) + 1;
    used.set(safeSeg(name), n);
    const seg = n === 1 ? safeSeg(name) : safeSeg(name) + '(' + n + ')';
    const base = '02现场资料/企业提供资料/';
    push(base + '00财务资料/' + seg);
    // 报表原件夹（公司级固定一层）：客户给的各期报表放这里，「导入报表」扫这个夹
    push(base + '00财务资料/' + seg + '/' + FIN_STATEMENT_DIR);
    push(base + '00财务资料/' + seg + '/' + AUDIT_REPORT_DIR);
    push(base + '00财务资料/' + seg + '/' + TB_DIR);
    push(base + '00财务资料/' + seg + '/' + AUX_DIR);
    push(base + '00财务资料/' + seg + '/' + GL_DIR);
    push(base + '02基础类/' + seg);
    BASIC_CATEGORIES.forEach(cat => push(base + '02基础类/' + seg + '/' + cat));
    const m = (c && c.methods) || {};
    const whole = Array.isArray(m.whole) ? m.whole : [];
    const has = x => whole.indexOf(x) >= 0;
    if (has('资产基础法')) {
      push(base + '03资产基础法/' + seg);
      // 科目夹从完整模板树里取（<公司> 段替换），不再动态拼——与模板页所见一致
      const kept = keep.filter(p => p.startsWith(segPrefix + '03资产基础法/'));
      kept.forEach(p => {
        const rest = p.slice((segPrefix + '03资产基础法/').length);
        // 跳过全集里的「03资产基础法」一级本身（上面已 push 过公司段父目录）
        if (!rest) return;
        push(base + '03资产基础法/' + seg + '/' + rest);
      });
    }
    if (has('收益法')) INCOME_CHILDREN.forEach(ch => push(base + '04收益法/' + seg + '/' + ch));
    if (has('市场法')) push(base + '05市场法/' + seg);
  });
  return out;
}

// 公司 rows 里有没有任何一家：勾了资产基础法 && subjects 里有金额科目能映射到 subjFolder
function subjectsOf(companies, subjFolder) {
  const def = AB_SUBJECTS.filter(x => x.folder === subjFolder)[0];
  if (!def) return false;
  const rows = Array.isArray(companies) ? companies : [];
  return rows.some(c => {
    const whole = ((c && c.methods) || {}).whole;
    if (!Array.isArray(whole) || whole.indexOf('资产基础法') < 0) return false;
    return abFoldersFor(c.subjects).some(x => x.folder === subjFolder);
  });
}

// 建目录总计划：模板树（完整全集骨架）+ 公司相关目录（从全集按方法/科目过滤后落到 <公司> 段）
export function folderTemplatePlan(template, companies) {
  const all = treeToPaths(template || DEFAULT_FOLDER_TEMPLATE).concat(companyPaths(companies, template));
  // 模板全集与公司段必然重叠（固定目录两边都算了一遍），去重且保持先父后子顺序
  const seen = new Set();
  return all.filter(p => (seen.has(p) ? false : (seen.add(p), true)));
}

export async function readFolderTemplate(file = FOLDER_TEMPLATE_PATH) {
  let data;
  try { data = await readFile(file); } catch (e) { if (e.code === 'ENOENT') return structuredClone(DEFAULT_FOLDER_TEMPLATE); throw e; }
  if (data.length > MAX_FOLDER_TEMPLATE_BYTES) fail('模板文件过大');
  try {
    return validateFolderTemplate(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)));
  } catch (e) {
    if (e instanceof FolderTemplateError) throw e;
    fail('模板文件不是有效 JSON：' + String(e.message || e));
  }
}

export async function saveFolderTemplate(t, file = FOLDER_TEMPLATE_PATH) {
  const clean = validateFolderTemplate(t);
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, '.folder-template-' + randomBytes(16).toString('hex') + '.tmp');
  let handle;
  try {
    handle = await open(tmp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(clean, null, 2) + '\n', 'utf8');
    await handle.sync(); await handle.close(); handle = null;
    await rename(tmp, file);
  } finally { if (handle) await handle.close(); await unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  return clean;
}

// GET 读 / POST 存 / DELETE 恢复内置默认
export async function folderTemplateRequest(req, file = FOLDER_TEMPLATE_PATH) {
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  try {
    if (req.method === 'GET') return json({ ok: true, template: await readFolderTemplate(file), isDefault: !(await existsFile(file)) });
    if (req.method === 'DELETE') { await unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; }); return json({ ok: true, template: structuredClone(DEFAULT_FOLDER_TEMPLATE), isDefault: true }); }
    if (req.method !== 'POST') return json({ error: '方法不支持' }, 405);
    const length = req.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_FOLDER_TEMPLATE_BYTES)) return json({ error: '请求体过大或长度无效' }, 413);
    const reader = req.body?.getReader(); const chunks = []; let size = 0;
    if (reader) try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > MAX_FOLDER_TEMPLATE_BYTES) { await reader.cancel(); return json({ error: '请求体过大' }, 413); } chunks.push(value); } } finally { reader.releaseLock(); }
    let body; try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch (_) { fail('请求体不是有效 JSON'); }
    return json({ ok: true, isDefault: false, template: await saveFolderTemplate(body && body.template ? body.template : body, file) });
  } catch (e) {
    const msg = e instanceof FolderTemplateError ? e.message : String(e.message || e);
    return json({ error: msg }, e instanceof FolderTemplateError && req.method === 'POST' ? 400 : 500);
  }
}

async function existsFile(p) { try { await readFile(p); return true; } catch (e) { return false; } }
