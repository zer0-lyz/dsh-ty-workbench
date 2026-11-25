// [合并补丁] 同事 PR #2（d094749）的 index.js/client.js 引用了本模块，
// 但 vehicle-upload.js 未随分支提交 —— 缺它整个插件加载失败（ERR_MODULE_NOT_FOUND）。
// 先按调用点签名（index.js:2039 uploadCerts / index.js:2092 readCerts）提供最小占位实现，
// 保证插件可加载、路由可响应；车辆权证上传/读取的真实逻辑等同事补交后替换。
export async function uploadCerts({ projectId, companyId, dir, items = [], dryRun = false, overwrite = false, log = () => {} } = {}) {
  log('[占位] vehicle-upload.js 未随同事分支提交，上传功能暂不可用');
  return { ok: false, uploaded: [], skipped: items.map(it => ({ ...it, reason: '功能未实现（vehicle-upload.js 缺失）' })), error: 'vehicle-upload.js 缺失：同事 PR #2 未提交该模块' };
}
export async function readCerts({ projectId, companyId, log = () => {} } = {}) {
  log('[占位] vehicle-upload.js 未随同事分支提交，读取功能暂不可用');
  return { ok: false, subjectCode: '', rows: [], items: [], error: 'vehicle-upload.js 缺失：同事 PR #2 未提交该模块' };
}
