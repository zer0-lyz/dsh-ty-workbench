// Explicit ownership for existing company folders. No name-based discovery or automatic migration.
// Root and its ancestors must not be concurrently replaced by an untrusted local process:
// Node has no portable openat/renameat interface for anchoring every operation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';

const FILE = '.company-folder-ownership.json';
const LOCK = '.company-folder-ownership.lock';
const BASE = ['02现场资料', '企业提供资料', '00财务资料'];
const RESERVED = '00未分配财务资料';
const key = s => s.normalize('NFC').toLocaleLowerCase('en-US');
function id(value, label) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 200) throw new Error(`无效${label}`);
  return value;
}
function segment(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/:*?"<>|\u0000-\u001f]/.test(value) || /[. ]$/.test(value) || value.length > 180 || key(value) === key(RESERVED)) throw new Error('无效或保留的公司目录段');
  return value;
}
async function safeDirectory(dir) {
  if (!path.isAbsolute(dir)) throw new Error('项目根目录必须为绝对路径');
  const resolved = path.resolve(dir), parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const st = await fs.lstat(current);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`目录不是安全的普通目录: ${current}`);
  }
  return resolved;
}
async function folderIdentity(folder) {
  await safeDirectory(folder);
  const stat = await fs.lstat(folder, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('公司目录不是安全的普通目录');
  return { folderDev: String(stat.dev), folderIno: String(stat.ino) };
}
function sameIdentity(binding, identity) {
  return binding.folderDev === identity.folderDev && binding.folderIno === identity.folderIno;
}
function validate(data, projectId) {
  if (!data || data.version !== 1 || data.projectId !== projectId || !Array.isArray(data.bindings)) throw new Error('公司目录清单无效或项目身份不匹配');
  const ids = new Set(), names = new Set();
  for (const b of data.bindings) {
    if (!b || typeof b !== 'object') throw new Error('公司目录清单无效');
    const cid = id(b.companyId, '公司ID'), dir = segment(b.folder);
    if (typeof b.name !== 'string' || !b.name.trim()) throw new Error('公司名称无效');
    const legacy = b.folderDev === undefined && b.folderIno === undefined;
    if (!legacy && (!/^\d+$/.test(b.folderDev || '') || !/^\d+$/.test(b.folderIno || ''))) throw new Error('公司目录身份信息无效');
    if (ids.has(cid) || names.has(key(dir))) throw new Error('公司目录清单存在冲突');
    ids.add(cid); names.add(key(dir));
  }
  return data;
}
async function readManifest(root, projectId) {
  const file = path.join(root, FILE);
  let h;
  try {
    h = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await h.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('公司目录清单不是有效普通文件');
    return validate(JSON.parse(await h.readFile('utf8')), projectId);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  } finally { if (h) await h.close(); }
}

// Purely read-only: reports name drift but never follows a name to a folder.
export async function inspectCompanyFolders({ projectRoot, projectId, companies = [] }) {
  const root = await safeDirectory(projectRoot);
  id(projectId, '项目ID');
  if (!Array.isArray(companies)) throw new Error('公司名单无效');
  const manifest = await readManifest(root, projectId);
  const inputIds = new Set();
  const rows = [];
  for (const c of companies) {
    const cid = id(c?.companyId, '公司ID');
    if (inputIds.has(cid)) throw new Error('公司ID重复');
    inputIds.add(cid);
    if (typeof c.name !== 'string' || !c.name.trim()) throw new Error('公司名称无效');
    const binding = manifest?.bindings.find(b => b.companyId === cid);
    if (!binding) { rows.push({ companyId: cid, name: c.name, status: 'unbound' }); continue; }
    let status = binding.name === c.name ? 'bound' : 'name_changed';
    try {
      const identity = await folderIdentity(path.join(root, ...BASE, binding.folder));
      if (binding.folderDev === undefined && binding.folderIno === undefined) status = 'identity_unverified';
      else if (!sameIdentity(binding, identity)) status = 'folder_changed';
    } catch (e) { if (e.code === 'ENOENT') status = 'folder_missing'; else throw e; }
    rows.push({ companyId: cid, name: c.name, recordedName: binding.name, folder: binding.folder, status });
  }
  return { projectId, manifestExists: !!manifest, rows, bindings: manifest?.bindings || [] };
}

// Explicit human confirmation binds one *existing* folder. Does not move or create company folders.
// Each caller must independently verify projectRoot belongs to projectId before calling.
export async function bindCompanyFolder({ projectRoot, projectId, companyId, name, folder, confirmText }) {
  if (confirmText !== '确认绑定公司目录') throw new Error('缺少明确确认');
  id(projectId, '项目ID'); id(companyId, '公司ID'); segment(folder);
  if (typeof name !== 'string' || !name.trim()) throw new Error('公司名称无效');
  const root = await safeDirectory(projectRoot);
  const lock = path.join(root, LOCK);
  await fs.mkdir(lock); // exclusive; a stale lock requires manual investigation, never auto-remove it
  let temp;
  try {
    const base = await safeDirectory(path.join(root, ...BASE));
    const identity = await folderIdentity(path.join(base, folder));
    const entries = await fs.readdir(base);
    if (entries.filter(x => key(x) === key(folder)).length !== 1 || !entries.includes(folder)) throw new Error('公司目录名称存在歧义');
    const existing = await readManifest(root, projectId);
    const data = existing || { version: 1, projectId, bindings: [] };
    const prior = data.bindings.find(b => b.companyId === companyId);
    if (prior && prior.folder !== folder) throw new Error('公司已绑定其他目录，不能自动重绑');
    if (data.bindings.some(b => b.companyId !== companyId && key(b.folder) === key(folder))) throw new Error('目录已绑定其他公司');
    if (prior && prior.name !== name) throw new Error('公司名称变更需单独核实，禁止自动更新');
    if (prior && !sameIdentity(prior, identity)) throw new Error('公司目录身份未确认或已变化');
    if (prior) return { ...prior, alreadyBound: true };
    const binding = { companyId, name, folder, ...identity };
    data.bindings.push(binding);
    temp = path.join(root, `${FILE}.${randomUUID()}.tmp`);
    const h = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await h.writeFile(JSON.stringify(data, null, 2) + '\n'); await h.sync(); } finally { await h.close(); }
    if (existing) {
      await fs.rename(temp, path.join(root, FILE));
      temp = undefined;
    } else {
      // Hard-link publication fails if another writer created the manifest meanwhile.
      await fs.link(temp, path.join(root, FILE));
      await fs.unlink(temp);
      temp = undefined;
    }
    return { ...binding, alreadyBound: false };
  } finally {
    if (temp) await fs.unlink(temp).catch(() => {});
    await fs.rmdir(lock);
  }
}

// Explicitly re-confirm a name change, never changing the folder or moving data.
// The caller must obtain currentName from trusted persistent project data and
// compare it with the human-confirmed name before calling.
export async function reconfirmCompanyFolderName({ projectRoot, projectId, companyId, currentName, expectedName, folder, confirmText }) {
  if (confirmText !== '确认更新公司目录归属名称') throw new Error('缺少明确确认');
  id(projectId, '项目ID'); id(companyId, '公司ID'); segment(folder);
  if (typeof currentName !== 'string' || !currentName.trim() || typeof expectedName !== 'string' || !expectedName.trim() || currentName === expectedName) throw new Error('公司新旧名称无效或没有变化');
  const root = await safeDirectory(projectRoot);
  const lock = path.join(root, LOCK);
  await fs.mkdir(lock);
  let temp;
  try {
    const data = await readManifest(root, projectId);
    const binding = data?.bindings.find(b => b.companyId === companyId);
    if (!binding || binding.name !== expectedName || binding.folder !== folder) throw new Error('公司目录归属已变化，请重新查询');
    const base = await safeDirectory(path.join(root, ...BASE));
    const identity = await folderIdentity(path.join(base, folder));
    const entries = await fs.readdir(base);
    if (entries.filter(x => key(x) === key(folder)).length !== 1 || !entries.includes(folder)) throw new Error('公司目录名称存在歧义');
    if (!sameIdentity(binding, identity)) throw new Error('公司目录身份未确认或已变化');
    binding.name = currentName;
    temp = path.join(root, `${FILE}.${randomUUID()}.tmp`);
    const h = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await h.writeFile(JSON.stringify(data, null, 2) + '\n'); await h.sync(); } finally { await h.close(); }
    await fs.rename(temp, path.join(root, FILE));
    temp = undefined;
    return { ...binding };
  } finally {
    if (temp) await fs.unlink(temp).catch(() => {});
    await fs.rmdir(lock);
  }
}

// Explicitly rebind only after the previously recorded folder is actually absent.
export async function rebindMissingCompanyFolder({ projectRoot, projectId, companyId, name, previousFolder, folder, confirmText }) {
  if (confirmText !== '确认原目录缺失并重新绑定') throw new Error('缺少明确确认');
  id(projectId, '项目ID'); id(companyId, '公司ID'); segment(previousFolder); segment(folder);
  if (typeof name !== 'string' || !name.trim() || key(previousFolder) === key(folder)) throw new Error('公司名称或新旧目录无效');
  const root = await safeDirectory(projectRoot);
  const lock = path.join(root, LOCK);
  await fs.mkdir(lock);
  let temp;
  try {
    const data = await readManifest(root, projectId);
    const binding = data?.bindings.find(b => b.companyId === companyId);
    if (!binding || binding.name !== name || binding.folder !== previousFolder) throw new Error('公司名称或原目录归属已变化，请重新查询');
    const base = await safeDirectory(path.join(root, ...BASE));
    const entries = await fs.readdir(base);
    // Case/normalization equivalent entries, including broken symlinks, are not absent.
    if (entries.some(x => key(x) === key(previousFolder))) throw new Error('原目录仍存在，禁止重新绑定');
    try { await fs.lstat(path.join(base, previousFolder)); throw new Error('原目录仍存在，禁止重新绑定'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (data.bindings.some(b => b.companyId !== companyId && key(b.folder) === key(folder))) throw new Error('目录已绑定其他公司');
    const identity = await folderIdentity(path.join(base, folder));
    if (entries.filter(x => key(x) === key(folder)).length !== 1 || !entries.includes(folder)) throw new Error('公司目录名称存在歧义');
    binding.folder = folder;
    Object.assign(binding, identity);
    temp = path.join(root, `${FILE}.${randomUUID()}.tmp`);
    const h = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await h.writeFile(JSON.stringify(data, null, 2) + '\n'); await h.sync(); } finally { await h.close(); }
    await fs.rename(temp, path.join(root, FILE));
    temp = undefined;
    return { ...binding, previousFolder };
  } finally {
    if (temp) await fs.unlink(temp).catch(() => {});
    await fs.rmdir(lock);
  }
}

// Manual re-attestation is necessary for legacy manifests and replaced folders.
export async function confirmCompanyFolderIdentity({ projectRoot, projectId, companyId, expectedName, folder, confirmText }) {
  if (confirmText !== '确认该公司目录身份') throw new Error('缺少明确确认');
  id(projectId, '项目ID'); id(companyId, '公司ID'); segment(folder);
  if (typeof expectedName !== 'string' || !expectedName.trim()) throw new Error('公司旧名称无效');
  const root = await safeDirectory(projectRoot);
  const lock = path.join(root, LOCK);
  await fs.mkdir(lock);
  let temp;
  try {
    const data = await readManifest(root, projectId);
    const binding = data?.bindings.find(b => b.companyId === companyId);
    if (!binding || binding.name !== expectedName || binding.folder !== folder) throw new Error('公司目录归属已变化，请重新查询');
    const base = await safeDirectory(path.join(root, ...BASE));
    const identity = await folderIdentity(path.join(base, folder));
    const entries = await fs.readdir(base);
    if (entries.filter(x => key(x) === key(folder)).length !== 1 || !entries.includes(folder)) throw new Error('公司目录名称存在歧义');
    if (sameIdentity(binding, identity)) throw new Error('公司目录身份未变化，请重新查询');
    Object.assign(binding, identity);
    temp = path.join(root, `${FILE}.${randomUUID()}.tmp`);
    const h = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await h.writeFile(JSON.stringify(data, null, 2) + '\n'); await h.sync(); } finally { await h.close(); }
    await fs.rename(temp, path.join(root, FILE));
    temp = undefined;
    return { ...binding };
  } finally {
    if (temp) await fs.unlink(temp).catch(() => {});
    await fs.rmdir(lock);
  }
}
