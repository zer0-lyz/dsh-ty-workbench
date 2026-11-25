import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

// CLI 和工作台 MCP 使用独立凭据；这里只检查本地文件，不返回凭据或授权链接。
//
// 跨平台要点（此前只按 POSIX 写死，Windows 上必然探测失败）：
//   1. PATH 的分隔符在 Windows 是 ';'，用 path.delimiter 而不是字面 ':'；
//      否则 'C:\\Windows;D:\\tycpv' 会被盘符里的冒号切成 'C' 和 '\\Windows;D' 两段。
//   2. Windows 的可执行体带扩展名（tycpv.cmd / .exe），裸名 tycpv 不存在，
//      要按 PATHEXT 逐个展开。
//   3. Node 20+ 出于 CVE-2024-27980 不再允许直接 spawn .cmd/.bat（EINVAL），
//      必须经 cmd.exe /c 转一层。
//   4. token.secret.json 的 provider 在 Windows 是 'windows-dpapi'（不是 'plain-file'），
//      密文由本机 DPAPI 加密，Node 侧解不出明文，不能再用 base64url 解码判断有效性。
const WIN = process.platform === 'win32';
const EXTS = WIN
  ? String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(s => s.trim()).filter(Boolean)
  : [''];

function isFile(p) {
  try { return statSync(p).isFile(); } catch (_) { return false; }
}

// 把目录展开成该平台可能的可执行文件名
function expandDir(dir) {
  if (!dir) return [];
  // 已经指向具体文件就原样返回（不能只看扩展名：PATH 里有 `.bin` 这种以点结尾的目录，
  // 按扩展名判断会把整个目录跳过）
  if (isFile(dir)) return [dir];
  return WIN ? EXTS.map(e => join(dir, 'tycpv' + e)) : [join(dir, 'tycpv')];
}

// 常见安装位置（PATH 之外）。Windows 安装包默认落在 %LOCALAPPDATA% 或用户自选目录，
// 用户自选目录一般会写进 PATH，所以这里只补标准位置，不硬编码盘符。
function defaultDirs() {
  const home = homedir();
  if (WIN) {
    const out = [];
    if (process.env.LOCALAPPDATA) out.push(join(process.env.LOCALAPPDATA, 'tycpv'), join(process.env.LOCALAPPDATA, 'Programs', 'tycpv'));
    if (process.env.ProgramFiles) out.push(join(process.env.ProgramFiles, 'tycpv'));
    if (process.env['ProgramFiles(x86)']) out.push(join(process.env['ProgramFiles(x86)'], 'tycpv'));
    out.push(join(home, 'tycpv'));
    return out;
  }
  return ['/usr/local/bin', '/opt/homebrew/bin', join(home, '.local', 'bin'), '/usr/bin'];
}

export function createCliAuth({ home = homedir(), spawnProcess = spawn, paths = null, open = null } = {}) {
  let child = null, state = 'idle', reason = '', timer = null, output = '', authUrl = '';

  // 显式覆盖 TYCPV_BIN → 调用方传入 → 常见目录 → PATH，按顺序取第一个真实存在的文件
  function candidates() {
    const out = [];
    if (process.env.TYCPV_BIN) out.push(process.env.TYCPV_BIN);
    if (Array.isArray(paths)) out.push(...paths);
    for (const dir of defaultDirs()) out.push(...expandDir(dir));
    for (const dir of String(process.env.PATH || '').split(delimiter).filter(Boolean)) out.push(...expandDir(dir));
    return out;
  }
  const binary = () => candidates().find(isFile) || '';

  // 读取本地凭据；不返回任何密文或明文 token
  function readCredential() {
    const dir = join(home, '.tycpv');
    const secretPath = join(dir, 'token.secret.json');
    if (!existsSync(secretPath)) return { present: false, provider: '', expiresAt: null, tokenUsable: false, account: '' };
    let auth = {}, secret = {};
    try { auth = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8')) || {}; } catch (_) {}
    try { secret = JSON.parse(readFileSync(secretPath, 'utf8')) || {}; } catch (_) {}
    const provider = String(secret.provider || '');
    let tokenUsable = false;
    if (provider === 'plain-file') {
      // 明文存储：base64url 能解出非空内容才算可用
      try { tokenUsable = !!Buffer.from(String(secret.value || ''), 'base64url').toString('utf8').trim(); } catch (_) {}
    } else if (provider === 'windows-dpapi' || provider === 'macos-keychain' || provider === 'keychain') {
      // 平台密钥库加密：密文非空即视为"有本地凭据"，真实有效性交给 expiresAt 与 CLI 自己校验
      tokenUsable = typeof secret.value === 'string' && secret.value.trim().length > 0;
    } else {
      tokenUsable = typeof secret.value === 'string' && secret.value.trim().length > 0;
    }
    return {
      present: true,
      provider,
      expiresAt: auth.expiresAt || null,
      tokenUsable,
      account: (auth.user && (auth.user.fullName || auth.user.userName)) || '',
    };
  }

  function localStatus() {
    const bin = binary();
    if (!bin) {
      return {
        installed: false, authenticated: false, state: 'unavailable',
        reason: '未找到 tycpv：已检查 TYCPV_BIN、常见安装目录与 PATH；可把环境变量 TYCPV_BIN 指向 tycpv（Windows 为 tycpv.cmd）',
        binPath: '', provider: '', expiresAt: null, authUrl: '',
      };
    }
    const cred = readCredential();
    const expired = !!cred.expiresAt && (!Number.isFinite(Date.parse(cred.expiresAt)) || Date.parse(cred.expiresAt) <= Date.now());
    const authenticated = cred.tokenUsable && !expired;
    const live = child ? state : (state === 'failed' || state === 'starting' || state === 'waiting' ? state : (authenticated ? 'authenticated' : state));
    return {
      installed: true,
      authenticated,
      state: live,
      reason,
      binPath: bin,
      provider: cred.provider,
      account: cred.account,
      expiresAt: cred.expiresAt,
      expired,
      authUrl,
    };
  }

  function extractUrl(text) {
    for (const raw of String(text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').match(/https?:\/\/[^\s"'<>]+/gi) || []) {
      try {
        const u = new URL(raw.replace(/[),.;]+$/, ''));
        if (u.protocol !== 'https:') continue;
        const host = u.hostname.toLowerCase();
        if (!(host === 'mcp.zhrdc.net' || host.endsWith('.zhrdc.net'))) continue;
        const path = u.pathname.toLowerCase();
        if (path.includes('connect') || path.includes('authorize') || path.includes('oauth') || u.searchParams.size >= 3) return u.toString();
      } catch (_) {}
    }
    return '';
  }

  function launch(bin) {
    // .cmd/.bat 必须经 cmd.exe，直接 spawn 会被 Node 拒绝（EINVAL）
    const isBatch = WIN && /\.(cmd|bat)$/i.test(bin);
    const cmd = isBatch ? (process.env.ComSpec || 'cmd.exe') : bin;
    const args = isBatch ? ['/c', bin, 'login'] : ['login'];
    return spawnProcess(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, windowsHide: true });
  }

  function start() {
    const bin = binary();
    if (!bin) return { ok: false, ...localStatus() };
    if (child) return { ok: true, ...localStatus() };
    // 即使文件存在也交给 CLI 自己验证远端状态，避免损坏或失效凭据阻止重新授权。
    state = 'starting'; reason = ''; output = ''; authUrl = '';
    try { child = launch(bin); }
    catch (_) { state = 'failed'; reason = '无法启动 CLI 授权，请在终端运行 tycpv login'; return { ok: false, ...localStatus() }; }
    const active = child;
    const onData = chunk => {
      output = (output + String(chunk)).slice(-32768);
      const url = extractUrl(output);
      if (!url || state !== 'starting') return;
      output = ''; state = 'waiting'; authUrl = url;
      // tycpv 自己会打开浏览器；这里只在调用方显式注入 open 时才补开，
      // 避免同一个授权地址被打开两次。没打开时把地址交给界面，由用户点开。
      if (open) { try { open(url); } catch (_) {} }
    };
    active.stdout?.on('data', onData); active.stderr?.on('data', onData);
    active.once('error', () => { if (child !== active) return; child = null; state = 'failed'; reason = 'CLI 启动失败，请在终端运行 tycpv login'; clearTimeout(timer); });
    active.once('close', code => {
      if (child !== active) return;
      child = null; clearTimeout(timer);
      const after = localStatus();
      const ok = code === 0 && after.authenticated;
      state = ok ? 'authenticated' : 'failed';
      reason = ok ? '' : 'CLI 授权未完成或进程已退出（退出码 ' + code + '）';
    });
    timer = setTimeout(() => { if (child !== active) return; child = null; state = 'failed'; reason = 'CLI 授权等待超时，请重试'; active.kill(); }, 5 * 60 * 1000);
    timer.unref?.();
    return { ok: true, ...localStatus() };
  }

  function dispose() { if (timer) clearTimeout(timer); if (child) { child.kill(); child = null; } }

  return { status: localStatus, start, dispose };
}
