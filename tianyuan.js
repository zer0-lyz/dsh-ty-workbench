import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Buffer } from 'node:buffer';

const ORIGIN = 'https://mcp.zhrdc.net';
const MCP_URL = ORIGIN + '/valuation-mcp';
const SOURCE = 'valuation';
const CALLBACK_PORT = 2424;
const REDIRECT_URI = 'http://127.0.0.1:' + CALLBACK_PORT + '/callback';
const STORE_PATH = join(homedir(), '.dsh', 'workbench-tianyuan.json');

let auth = null;            // { token, user, expiresAt, credential, createdAt }
let pending = null;         // { state, verifier, redirectUri, startedAt, timer, server }
let mcpSession = null;      // Mcp-Session-Id from initialize
let mcpSeq = 10;

// session 失效（远端重启/超时）时重置握手状态；callTool 层据此做一次重试。
function isSessionError(e) {
  const msg = String(e && e.message || '');
  return /no valid session|session.*(invalid|expired|失效)/i.test(msg) || (e && e.sessionInvalid === true);
}
// 瞬时网络错误（WAF/网关 400/502/503）：不带 session 语义，原样重试同一请求即可，不必 resetSession。
function isTransientError(e) { return e && e.transient === true; }
function resetSession() { mcpSession = null; }

async function loadAuth() {
  try {
    const raw = await readFile(STORE_PATH, 'utf8');
    const a = JSON.parse(raw);
    if (a && a.token) return a;
  } catch (e) {}
  return null;
}
async function saveAuth(a) {
  await mkdir(join(homedir(), '.dsh'), { recursive: true, mode: 0o700 });
  await writeFile(STORE_PATH, JSON.stringify(a, null, 2), { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') await chmod(STORE_PATH, 0o600);
}
async function postJson(url, body, headers) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const t = await r.text();
  let d = {}; try { d = JSON.parse(t); } catch (e) { d = { raw: t }; }
  return { ok: r.ok, status: r.status, data: d };
}

// ---------- PKCE OAuth ----------
export async function startLogin(credentialName) {
  if (pending) stopLogin();
  const state = randomBytes(18).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const reg = await postJson(ORIGIN + '/api/mcp/sources/' + SOURCE + '/cli/authorization-requests', {
    redirect_uri: REDIRECT_URI, state, code_challenge: challenge, code_challenge_method: 'S256',
    credential_name: credentialName || 'dsh-workbench on DeepSeek Harness', ttl_days: '7',
  });
  if (!reg.ok || !reg.data.authorizationUrl) throw new Error(reg.data.error || reg.data.message || ('预登记失败 HTTP ' + reg.status));
  // callback server
  const server = createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    if (u.pathname !== '/callback') { res.writeHead(404); res.end('Not found'); return; }
    const got = u.searchParams.get('state');
    const code = u.searchParams.get('code');
    const err = u.searchParams.get('error');
    const send = (ok, msg) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>天源授权</title><style>body{min-height:100vh;margin:0;display:grid;place-items:center;background:#f5f7fb;color:#16182f;font-family:"Microsoft YaHei UI",Arial,sans-serif}main{width:min(440px,90vw);padding:30px;border-radius:16px;background:#fff;box-shadow:0 18px 60px rgba(22,24,47,.12);text-align:center}h1{font-size:22px}p{color:#667085;line-height:1.7}</style></head><body><main><h1>' + (ok ? '授权完成' : '授权未完成') + '</h1><p>' + msg + '。可关闭此页，回到 个人工作台。</p></main></body></html>');
    };
    if (err) { send(false, '错误：' + err); return; }
    if (got !== state || !code) { send(false, 'state 不匹配或缺少 code'); return; }
    exchange(code, verifier).then(async a => {
      await saveAuth(a); auth = a; mcpSession = null;
      send(true, '已连接账号 ' + (a.user?.userName || a.user?.fullName || ''));
    }).catch(e => send(false, '换取令牌失败：' + e.message));
    // close server shortly after handling
    setTimeout(() => { try { server.close(); } catch (e) {} }, 1500);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(CALLBACK_PORT, '127.0.0.1', resolve);
  });
  const timer = setTimeout(() => { stopLogin(); }, 5 * 60 * 1000);
  if (timer.unref) timer.unref();
  pending = { state, verifier, redirectUri: REDIRECT_URI, startedAt: Date.now(), timer, server };
  return { authorizationUrl: reg.data.authorizationUrl, expiresAt: reg.data.expiresAt, redirectUri: REDIRECT_URI };
}
function stopLogin() {
  if (!pending) return;
  clearTimeout(pending.timer);
  try { pending.server.close(); } catch (e) {}
  pending = null;
}
export function stopLoginNow() { stopLogin(); }
async function exchange(code, verifier) {
  const r = await postJson(ORIGIN + '/api/mcp/sources/' + SOURCE + '/cli/token', {
    code, codeVerifier: verifier, redirectUri: REDIRECT_URI,
  });
  if (!r.ok || !r.data.token) throw new Error(r.data.error || r.data.message || ('换取 token 失败 HTTP ' + r.status));
  const d = r.data;
  return {
    token: d.token,
    user: d.user || {},
    credential: d.credential || {},
    expiresAt: d.expiresAt || null,
    createdAt: new Date().toISOString(),
  };
}
export async function status() {
  if (!auth) auth = await loadAuth();
  if (!auth || !auth.token) return { connected: false };
  const expires = auth.expiresAt ? Date.parse(auth.expiresAt) : null;
  const expired = expires !== null && (!Number.isFinite(expires) || Date.now() >= expires);
  return {
    connected: !expired,
    expired,
    user: auth.user || {},
    expiresAt: auth.expiresAt || null,
    createdAt: auth.createdAt || null,
    pending: !!pending,
  };
}
// 状态页的只读实测：不能仅凭本地有 token 就称为已连接。
export async function probeConnection() {
  const local = await status();
  if (!local.connected) return { connected: false, state: local.expired ? 'expired' : 'not_configured' };
  try {
    // 重新初始化会话，避免之前的 session id 过期后误报。
    mcpSession = null;
    const tools = await listTools();
    return { connected: true, state: 'connected', toolCount: tools.length };
  } catch (e) {
    mcpSession = null;
    const msg = String(e?.message || '');
    return { connected: false, state: /401|403|unauthoriz|forbidden/i.test(msg) ? 'unauthorized' : 'unavailable' };
  }
}
export async function setToken(token) {
  if (!token || !String(token).startsWith('zhmcp_')) throw new Error('token 格式不正确（应以 zhmcp_ 开头）');
  const next = { token: String(token).trim(), user: {}, expiresAt: null, createdAt: new Date().toISOString(), manual: true };
  await saveAuth(next); auth = next; mcpSession = null;
  return { ok: true };
}
export async function logout() {
  if (auth && auth.token) {
    try { await postJson(ORIGIN + '/api/mcp/sources/' + SOURCE + '/credentials/current/revoke', {}, { Authorization: 'Bearer ' + auth.token }); } catch (e) {}
  }
  auth = null; mcpSession = null; stopLogin();
  await saveAuth({});
  return { ok: true };
}

// ---------- MCP JSON-RPC over Streamable HTTP ----------
function parseBody(text, contentType) {
  if (String(contentType || '').includes('text/event-stream') || text.includes('data:')) {
    const lines = text.split(String.fromCharCode(10));
    for (const ln of lines) {
      if (!ln.startsWith('data:')) continue;
      const payload = ln.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { return JSON.parse(payload); } catch (e) {}
    }
  }
  try { return JSON.parse(text); } catch (e) { return { raw: text }; }
}
async function ensureAuth() {
  if (!auth) auth = await loadAuth();
  if (!auth || !auth.token) throw new Error('尚未连接天源，请先在天源对接页完成授权');
  if (auth.expiresAt && Date.now() >= new Date(auth.expiresAt).getTime()) {
    throw new Error('天源授权已于 ' + auth.expiresAt + ' 过期，请重新授权');
  }
  return auth;
}
async function mcpRaw(method, params, id) {
  if (!auth || !auth.token) await ensureAuth();
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': 'Bearer ' + auth.token,
  };
  if (mcpSession) headers['Mcp-Session-Id'] = mcpSession;
  const body = { jsonrpc: '2.0', method, params: params || {} };
  if (id !== undefined) body.id = id;
  const r = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const sid = r.headers.get('mcp-session-id') || r.headers.get('Mcp-Session-Id');
  if (sid) mcpSession = sid;
  const text = await r.text();
  const data = parseBody(text, r.headers.get('content-type'));
  if (!r.ok && r.status !== 202) {
    const msg = (data && (data.error?.message || data.message)) || ('MCP HTTP ' + r.status);
    const e = new Error('MCP HTTP ' + r.status + ': ' + msg);
    // 远端 WAF/网关偶发 400/502/503（实测同一请求重试即过），标记为瞬时错误供 callTool 层退避重试；
    // 401/403 是凭据问题，不算瞬时，不标记。
    if (r.status === 400 || r.status === 502 || r.status === 503) e.transient = true;
    throw e;
  }
  return { data, status: r.status, sessionId: sid };
}
async function ensureInit() {
  if (mcpSession) return;
  const init = await mcpRaw('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-workbench', version: '1.0.0' } }, 1);
  if (init.data && init.data.error) throw new Error(init.data.error.message || 'initialize 失败');
  // notifications/initialized has no id
  try { await mcpRaw('notifications/initialized', {}, undefined); } catch (e) {}
}
export async function listTools() {
  await ensureInit();
  const r = await mcpRaw('tools/list', {}, ++mcpSeq);
  if (r.data && r.data.error) throw new Error(r.data.error.message || 'tools/list 失败');
  const tools = r.data?.result?.tools;
  if (!Array.isArray(tools)) throw new Error('MCP tools/list 响应格式无效');
  return tools.map(t => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || {} }));
}
export async function callTool(name, args) {
  // session 失效时自动重新 initialize 再试一次；瞬时网络错误（400/502/503）原样重试一次；
  // 仍失败则透传错误（不做推测数据补全）。
  for (let attempt = 0; attempt < 2; attempt++) {
    await ensureInit();
    try {
      const r = await mcpRaw('tools/call', { name, arguments: args || {} }, ++mcpSeq);
      if (r.data && r.data.error) {
        const msg = r.data.error.message || 'tools/call 失败';
        if (attempt === 0 && isSessionError({ message: msg })) { resetSession(); continue; }
        throw new Error(msg);
      }
      const result = r.data?.result || {};
      const texts = (result.content || []).filter(c => c.type === 'text').map(c => c.text);
      let parsed = null;
      if (texts.length) { try { parsed = JSON.parse(texts.join(String.fromCharCode(10))); } catch (e) { parsed = texts.join(String.fromCharCode(10)); } }
      return { content: result.content || [], structuredContent: result.structuredContent || null, data: parsed, isError: !!result.isError };
    } catch (e) {
      if (attempt === 0 && isSessionError(e)) { resetSession(); continue; }
      if (attempt === 0 && isTransientError(e)) { continue; }
      throw e;
    }
  }
}
export { STORE_PATH };
