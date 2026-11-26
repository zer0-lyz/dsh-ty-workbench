// Manual local processing only. No Tianyuan commands are invoked here.
import { constants } from 'node:fs';
import { access, copyFile, link, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const formats = {
  detail: 'appraisal-detail-print-format/scripts/adjust_appraisal_detail_print.py',
  declare: 'appraisal-declaration-print-format/scripts/adjust_appraisal_declaration_print.py',
};
const restoreScript = 'asset-link-restore/scripts/restore_links.py';
const inside = (root, p) => { const r = relative(root, p); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep)); };
const errorText = e => String(e?.stderr || e?.message || e).trim().slice(-3000);

async function run(bin, args, onSpawn, cancel) {
  const child = exec(bin, args, { timeout: 300000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (typeof onSpawn === 'function') { try { onSpawn(child); } catch { /* 注册失败不影响运行 */ } }
  try {
    await child;
  } catch (e) {
    // 子进程被「终止任务」杀掉时，把底层 kill 报错替换成语义明确的「导出已取消」。
    if (typeof cancel === 'function' && cancel()) {
      const err = new Error('导出已取消');
      err.cancelled = true;
      throw err;
    }
    throw e;
  }
}
async function exists(p) { try { await access(p); return true; } catch { return false; } }
async function scriptsFor(restore, format, kind) {
  const candidates = [process.env.TIANYUAN_PRINT_SKILLS_DIR,
    join(homedir(), '.tianyuan-workbench', 'dependencies', '天源评估系统', 'print-format-skills'),
    join(homedir(), 'Projects', 'tianyuan-workbench-release-20261001', 'skills')].filter(Boolean);
  for (const dir of candidates) {
    if ((!restore || await exists(join(dir, restoreScript))) && (!format || await exists(join(dir, formats[kind])))) return dir;
  }
  throw new Error('未找到所需处理脚本，请设置 TIANYUAN_PRINT_SKILLS_DIR');
}
async function collect(root) {
  const found = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        // Check again before descending; never intentionally follow a directory symlink.
        const st = await lstat(p);
        if (st.isDirectory() && !st.isSymbolicLink() && inside(root, await realpath(p))) await walk(p);
      } else if (e.isFile() && /\.(xlsx|xlsm)$/i.test(e.name)) found.push(p);
    }
  }
  await walk(root);
  return found.sort();
}
async function copySource(src, dest) {
  // O_NOFOLLOW rejects an input file replaced by a symlink between discovery and open.
  const fd = await open(src, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (!(await fd.stat()).isFile()) throw new Error('源文件不是普通文件');
    const out = await open(dest, 'wx', 0o600);
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      for (;;) {
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        let offset = 0;
        while (offset < bytesRead) {
          const { bytesWritten } = await out.write(buffer, offset, bytesRead - offset, null);
          if (!bytesWritten) throw new Error('写入临时副本失败');
          offset += bytesWritten;
        }
      }
    } finally { await out.close(); }
  } finally { await fd.close(); }
}

/**
 * sourcePath/outputDir must be absolute existing paths. No implicit operation is selected.
 * Errors in setup reject; file errors are returned independently. Publication is per file,
 * not a transaction across files or between a workbook and its optional report.
 */
export async function runManualWorkflow(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options 必须是对象');
  const allowed = new Set(['sourcePath', 'outputDir', 'kind', 'restoreFormulas', 'applyFormat', 'onProgress', 'cancel', 'onSpawn']);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new TypeError('不支持的参数：' + key);
  const { sourcePath, outputDir, kind } = options;
  if (typeof sourcePath !== 'string' || !isAbsolute(sourcePath) || typeof outputDir !== 'string' || !isAbsolute(outputDir)) throw new TypeError('sourcePath 和 outputDir 必须是绝对路径');
  if (!Object.hasOwn(formats, kind)) throw new TypeError('kind 必须是 detail 或 declare');
  for (const key of ['restoreFormulas', 'applyFormat']) if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new TypeError(key + ' 必须是布尔值');
  if (options.onProgress !== undefined && typeof options.onProgress !== 'function') throw new TypeError('onProgress 必须是函数');
  if (options.cancel !== undefined && typeof options.cancel !== 'function') throw new TypeError('cancel 必须是函数');
  if (options.onSpawn !== undefined && typeof options.onSpawn !== 'function') throw new TypeError('onSpawn 必须是函数');
  const restore = options.restoreFormulas === true, format = options.applyFormat === true;
  if (kind === 'declare' && (restore || !format)) throw new TypeError('申报表只允许 applyFormat');
  if (!restore && !format) throw new TypeError('至少选择一项处理');
  const sourceStat = await lstat(sourcePath);
  if (sourceStat.isSymbolicLink()) throw new Error('不支持符号链接源路径');
  const outputStat = await lstat(outputDir);
  if (outputStat.isSymbolicLink() || !outputStat.isDirectory()) throw new Error('outputDir 必须是现有普通目录');
  const srcReal = await realpath(sourcePath), outReal = await realpath(outputDir);
  let files;
  if (sourceStat.isDirectory()) files = await collect(srcReal);
  else if (sourceStat.isFile() && /\.(xlsx|xlsm)$/i.test(sourcePath)) files = [srcReal];
  else throw new Error('源必须是目录或 xlsx/xlsm 文件');
  const root = sourceStat.isDirectory() ? srcReal : dirname(srcReal);
  const skills = await scriptsFor(restore, format, kind);
  const venvPython = join(homedir(), '.dsh', 'workbench-venv', 'bin', 'python3');
  const py = process.env.WORKBENCH_PYTHON || (await exists(venvPython) ? venvPython : 'python3');
  const outDir = await mkdtemp(join(outReal, 'manual-workflow-'));
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const cancel = typeof options.cancel === 'function' ? options.cancel : null;
  const onSpawn = typeof options.onSpawn === 'function' ? options.onSpawn : null;
  const results = [];
  for (const [fi, src] of files.entries()) {
    if (cancel && cancel()) throw new Error('导出已取消');
    if (onProgress) { try { onProgress({ done: fi, total: files.length, file: basename(src), msg: '正在整理：' + basename(src) }); } catch { /* 进度回调失败不影响处理 */ } }
    let temp, reportPath = null, outputPath = null;
    const stages = [];
    try {
      temp = await mkdtemp(join(outDir, '.stage-'));
      const name = basename(src), ext = extname(name), stem = name.slice(0, -ext.length);
      // 当前恢复脚本输出 xlsx 且未保留 VBA，不能用于含宏工作簿。
      if (restore && ext.toLowerCase() === '.xlsm') throw new Error('公式恢复暂不支持 xlsm：现有脚本不能保证保留宏；可仅选择格式整理');
      const stage = join(temp, name);
      // Reject paths that were redirected outside the selected directory after enumeration.
      if (!inside(root, await realpath(src))) throw new Error('源路径已越过选定目录');
      await copySource(src, stage);
      if (restore) {
        await run(py, [join(skills, restoreScript), stage], onSpawn, cancel);
        if (cancel && cancel()) throw new Error('导出已取消');
        const generated = join(temp, stem + '_链接恢复' + ext);
        if (!(await exists(generated))) throw new Error('恢复公式没有产出工作簿');
        // Use the generated file directly; do not replace any existing file.
        await copyFile(generated, stage, 0);
        stages.push('restore_formulas');
      }
      // 申报脚本跳过自带插删行（--skip-fill），格式动作保留。
      if (format) {
        const fmtArgs = [join(skills, formats[kind]), stage, '--no-backup'];
        if (kind === 'declare') fmtArgs.push('--skip-fill');
        await run(py, fmtArgs, onSpawn, cancel); stages.push('apply_format');
        if (cancel && cancel()) throw new Error('导出已取消');
      }
      const verify = async p => run(py, ['-c', 'import sys,zipfile; sys.exit(0 if zipfile.ZipFile(sys.argv[1]).testzip() is None else 2)', p], onSpawn, cancel);
      await verify(stage);
      const report = join(temp, stem + '_链接恢复对比报告.xlsx');
      const hasReport = restore && await exists(report);
      if (hasReport) await verify(report);
      const rel = relative(root, src);
      const dest = resolve(outDir, rel);
      if (!inside(outDir, dest)) throw new Error('输出路径越界');
      await mkdir(dirname(dest), { recursive: true });
      // Link is atomic and fails on existing paths, including symlinks. Staging is on the same filesystem.
      if (hasReport) {
        const reportDest = join(dirname(dest), stem + '_链接恢复对比报告-' + basename(temp).slice(7) + '.xlsx');
        await link(report, reportDest);
        reportPath = reportDest;
      }
      await link(stage, dest);
      outputPath = dest;
      results.push({ ok: true, sourcePath: src, outputPath, reportPath, reason: null, stages });
    } catch (e) {
      results.push({ ok: false, sourcePath: src, outputPath, reportPath, reason: errorText(e), stages });
    } finally {
      if (temp) { try { await rm(temp, { recursive: true, force: true }); } catch { /* staged leftovers remain inside the batch */ } }
    }
  }
  const successCount = results.filter(r => r.ok).length;
  return { ok: successCount > 0, outDir, total: results.length, successCount, failedCount: results.length - successCount, results };
}
