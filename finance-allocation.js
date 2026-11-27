// 财务资料分配后台。调用方必须从可信项目数据（而不是前端请求）提供 companyFolders，
// 值为该项目实际使用的公司目录名；projectRoot 同样必须由可信项目记录解析。
// API: scanFinanceAllocation({projectRoot}) -> {sourceDir, files}
//      resolveFinanceAllocation({projectRoot, companyFolders, selections}) -> 只读预检
//      copyFinanceAllocation({projectRoot, companyFolders, selections}) -> 再预检后执行
// selections: [{name, size, hash, dev, ino, company, category}]，前五项直接来自扫描。
// 整批预检失败时不创建目录、不复制；执行中失败逐项返回，不承诺事务原子性。
// Node 没有可移植 openat/mkdirat：lstat + O_NOFOLLOW 无法防御有权限的本机进程
// 在检查和系统调用之间替换祖先目录。调用方必须保证项目目录不被不可信进程并发修改。
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FIN_STATEMENT_DIR, AUDIT_REPORT_DIR, TB_DIR, AUX_DIR, GL_DIR } from './folders.js';

export const FINANCE_CATEGORIES = Object.freeze([FIN_STATEMENT_DIR, AUDIT_REPORT_DIR, TB_DIR, AUX_DIR, GL_DIR]);
const BASE = ['02现场资料', '企业提供资料', '00财务资料'];
const UNASSIGNED = '00未分配财务资料';
export const MAX_FINANCE_FILE_BYTES = 100 * 1024 * 1024;
const hashOf = data => createHash('sha256').update(data).digest('hex');
function segment(s) {
  if (typeof s !== 'string' || !s || s === '.' || s === '..' || /[\\/\0]/.test(s) || path.isAbsolute(s)) throw new Error('无效路径组件');
  return s;
}
function rootPath(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) throw new Error('项目根目录必须是绝对路径');
  return path.resolve(root);
}
async function directories(dir, allowMissing = false) {
  const parsed = path.parse(dir);
  let current = parsed.root, missing = false;
  for (const part of dir.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (missing) continue;
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`目录不是安全的普通目录: ${current}`);
    } catch (e) {
      if (e.code === 'ENOENT' && allowMissing) missing = true;
      else throw e;
    }
  }
  return !missing;
}
async function ensureDirectories(dir) {
  const parsed = path.parse(dir);
  let current = parsed.root;
  for (const part of dir.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await fs.mkdir(current); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`目录不是安全的普通目录: ${current}`);
  }
}
async function readSource(file) {
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('源文件不是普通文件');
  const h = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await h.stat({ bigint: true });
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('源文件身份已改变');
    if (stat.size > BigInt(MAX_FINANCE_FILE_BYTES)) throw new Error(`源文件超过大小上限 ${MAX_FINANCE_FILE_BYTES} 字节`);
    // 限量分块读取，避免文件在 fstat 后增长导致 readFile 无界分配内存。
    const chunks = [];
    let length = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_FINANCE_FILE_BYTES + 1 - length));
      const { bytesRead } = await h.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > MAX_FINANCE_FILE_BYTES) throw new Error(`源文件超过大小上限 ${MAX_FINANCE_FILE_BYTES} 字节`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks, length);
    const after = await h.stat({ bigint: true });
    if (stat.size !== after.size || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs || BigInt(bytes.length) !== after.size) throw new Error('读取期间源文件已改变');
    return { bytes, size: Number(after.size), hash: hashOf(bytes), dev: String(after.dev), ino: String(after.ino) };
  } finally { await h.close(); }
}
function sourceDir(root) { return path.join(root, ...BASE, UNASSIGNED); }
function same(a, b) { return a.size === b.size && a.hash === b.hash && a.dev === b.dev && a.ino === b.ino; }

export async function scanFinanceAllocation({ projectRoot }) {
  const root = rootPath(projectRoot), dir = sourceDir(root);
  if (!(await directories(dir, true))) return { sourceDir: dir, files: [] };
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    try {
      segment(name);
      const { bytes, ...metadata } = await readSource(path.join(dir, name));
      files.push({ name, ...metadata });
    } catch (e) {
      files.push({ name, error: e.message });
    }
  }
  return { sourceDir: dir, files };
}

export async function resolveFinanceAllocation({ projectRoot, companyFolders, selections }) {
  const root = rootPath(projectRoot);
  if (!Array.isArray(companyFolders) || !companyFolders.length) throw new Error('缺少可信项目公司目录名单');
  const allowed = new Set(companyFolders.map(segment));
  if (!Array.isArray(selections) || !selections.length) throw new Error('请选择源文件');
  const dir = sourceDir(root);
  await directories(dir);
  const destinations = new Set(), items = [];
  for (const selection of selections) {
    const { name, company, category, size, hash, dev, ino } = selection || {};
    segment(name); segment(company); segment(category);
    if (!allowed.has(company) || company === UNASSIGNED) throw new Error('公司不在可信项目名单中');
    if (!FINANCE_CATEGORIES.includes(category)) throw new Error('无效财务分类');
    if (!Number.isSafeInteger(size) || size < 0 || !/^[0-9a-f]{64}$/.test(hash || '') || !/^\d+$/.test(dev || '') || !/^\d+$/.test(ino || '')) throw new Error('缺少有效的扫描快照');
    const source = path.join(dir, name), destDir = path.join(root, ...BASE, company, category), destination = path.join(destDir, name);
    if (destinations.has(destination)) throw new Error(`批次目标冲突: ${destination}`);
    destinations.add(destination);
    const actual = await readSource(source);
    if (!same(actual, { size, hash, dev, ino })) throw new Error(`源文件与扫描快照不一致: ${name}`);
    await directories(destDir, true);
    try { await fs.lstat(destination); throw new Error(`目标已存在: ${destination}`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    items.push({ name, company, category, size, hash, dev, ino, source, destDir, destination });
  }
  return { items };
}

export async function copyFinanceAllocation(args) {
  // 总是重新全批预检，不能信任客户端提交的预检结果或目标路径。
  const { items } = await resolveFinanceAllocation(args);
  const results = [];
  for (const item of items) {
    let out;
    try {
      await directories(path.dirname(item.source));
      const current = await readSource(item.source);
      if (!same(current, item)) throw new Error('源文件与扫描快照不一致');
      await ensureDirectories(item.destDir);
      out = await fs.open(item.destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await out.writeFile(current.bytes);
      await out.close(); out = undefined;
      const copied = await readSource(item.destination);
      if (copied.size !== item.size || copied.hash !== item.hash) throw new Error('目标回读校验失败');
      results.push({ ...item, success: true });
    } catch (e) {
      if (out) await out.close().catch(() => {});
      // 失败时不删除任何文件：部分写入可能留在目标目录，供人工检查。
      results.push({ ...item, success: false, error: e.message });
    }
  }
  return { results };
}
