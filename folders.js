// 项目文件夹模板：与 D:\天源评估\【模板】项目文件夹 对齐。
// 客户端只传「公司 + 评估方法 + 有金额的财务科目」，目录怎么摆全在这里决定，
// 这样规则只有一份，宿主路由 / 自动化 / 测试都走同一个 planner。
//
// 规则（用户口径）：
//   1) 01前期资料 / 02现场资料 / 03评估底稿 / 04项目归档 是固定骨架；
//   2) 管理类资料只有一份（一个项目一套，不按公司拆），落在 03评估底稿/管理类底稿/<分类>；
//   3) 财务类资料（00财务资料）与基础类资料（02基础类）**每家公司一套**，
//      分类在前、公司在后：00财务资料/<公司>、02基础类/<公司>/<分类>，
//      与 03资产基础法/<公司>/<科目> 的写法一致；
//      00财务资料/<公司> 下固定一个 01财务报表 子夹：客户给的各期报表原件放这里，
//      「导入报表」按这个夹扫描解析（见 FIN_STATEMENT_DIR）；
//   4) 03资产基础法 / 04收益法 / 05市场法 只在该公司选了对应方法时生成；
//   5) 资产基础法下的科目子目录，只给「财务报表里有金额」的科目建。

export const STATIC_DIRS = [
  '01前期资料/参考资料',
  '01前期资料/待整理资料',
  '01前期资料/行业研究',
  '02现场资料/业务委托合同',
  '02现场资料/企业提供资料/00财务资料',
  '02现场资料/企业提供资料/01管理类',
  '02现场资料/现场勘察照片',
  '03评估底稿/一级复核/01-报告、说明、明细表',
  '03评估底稿/一级复核/02-底稿',
  '03评估底稿/一级复核/03-复核意见',
  '03评估底稿/一级复核/04-财务报表、审定数据',
  '03评估底稿/二级复核',
  '03评估底稿/三级复核',
  '03评估底稿/送签发',
  '04项目归档/01-报告、说明、明细表',
  '04项目归档/02-底稿',
  '04项目归档/03-复核意见',
  '04项目归档/04-财务报表、审定数据',
];

// 收益法子目录是固定的（模板里 01~07），不按金额增减
export const INCOME_CHILDREN = [
  '01主营业务收入成本',
  '02销售费用',
  '03管理费用',
  '04研发费用',
  '05税金',
  '06非经',
  '07折现率',
];

// 基础类资料的分类（每家公司一份，落在 02基础类/<公司>/<分类>）。
// 必须与 client.js 的 BASIC_CATALOG 分类保持一致；改一边就要改另一边。
export const BASIC_CATEGORIES = [
  '公司基础资料',
  '财务资料',
  '评估申报与核实资料',
  '行业与宏观分析资料',
];

// 管理类底稿的分类：一个项目一套，落在 03评估底稿/管理类底稿/<分类>。
// 必须与 client.js 的 MGMT_CATALOG 分类保持一致。
export const MGMT_CATEGORIES = [
  '程序文件',
  '合同与依据文件',
  '技术文件',
  '沟通记录类文件',
  '审核与交付文件',
  '定稿成果文件',
];

// 管理类底稿落在 03评估底稿 下（与 一级复核 / 二级复核 / 三级复核 / 送签发 并列）
export const MGMT_FOLDER = '03评估底稿/管理类底稿';

// 财务报表原件夹：每家公司 00财务资料/<公司> 下的固定子夹，客户给的各期报表（月报/年报、
// 审定报表、报表附注）放这里，「导入报表」就扫这个夹里的 xlsx/xls/xlsm 自动解析。
export const FIN_STATEMENT_DIR = '01财务报表';
// 审计报告夹：每家公司 00财务资料/<公司> 下的固定子夹，事务所出具的审计报告 PDF/word 放这里。
export const AUDIT_REPORT_DIR = '02审计报告';
// 认定是「报表原件」的扩展名，与 finance_scan.py 的 EXTS 保持一致
// （csv 不在内：报表得靠工作表结构认「项目 + 行次」表头，纯文本 csv 没有这个概念）
export const FIN_STATEMENT_EXTS = ['.xlsx', '.xlsm', '.xls'];

// 资产基础法科目：目录名（与模板编号一致）+ 命中关键字（科目余额表里的叫法）
export const AB_SUBJECTS = [
  { folder: '01货币资金', keys: ['货币资金', '库存现金', '银行存款', '其他货币资金'] },
  { folder: '02交易性金融资产', keys: ['交易性金融资产', '以公允价值计量且其变动计入当期损益的金融资产'] },
  { folder: '03应收票据', keys: ['应收票据'] },
  { folder: '04应收账款', keys: ['应收账款', '应收帐款'] },
  { folder: '05预付款项', keys: ['预付款项', '预付账款', '预付帐款', '预付'] },
  { folder: '06其他应收款', keys: ['其他应收款'] },
  { folder: '07存货', keys: ['存货', '原材料', '库存商品', '在产品', '半成品', '周转材料', '发出商品', '委托加工物资', '低值易耗品'] },
  { folder: '08合同资产', keys: ['合同资产'] },
  { folder: '09其他流动资产', keys: ['其他流动资产'] },
  { folder: '10长期股权投资', keys: ['长期股权投资'] },
  { folder: '11投资性房地产', keys: ['投资性房地产'] },
  {
    folder: '12固定资产', keys: ['固定资产'],
    children: ['01房屋建筑物和构筑物', '02机器设备和电子设备', '03车辆'],
  },
  { folder: '13在建工程', keys: ['在建工程'] },
  { folder: '14使用权资产', keys: ['使用权资产'] },
  { folder: '15无形资产', keys: ['无形资产'], children: ['01土地使用权', '02其他无形资产'] },
  { folder: '16研发支出', keys: ['研发支出', '开发支出'] },
  { folder: '17长期待摊费用', keys: ['长期待摊费用'] },
  { folder: '18递延所得税资产', keys: ['递延所得税资产'] },
  { folder: '19其他非流动资产', keys: ['其他非流动资产'] },
  { folder: '20短期借款', keys: ['短期借款'] },
  { folder: '21交易性金融负债', keys: ['交易性金融负债'] },
  { folder: '22应付票据', keys: ['应付票据'] },
  { folder: '23应付账款', keys: ['应付账款', '应付帐款'] },
  { folder: '24预收款项', keys: ['预收款项', '预收账款', '预收帐款'] },
  { folder: '25合同负债', keys: ['合同负债'] },
  { folder: '26应付职工薪酬', keys: ['应付职工薪酬', '应付工资', '应付福利费'] },
  { folder: '27应交税费', keys: ['应交税费', '应交税金'] },
  { folder: '28其他应付款', keys: ['其他应付款'] },
  { folder: '29一年内到期的非流动负债', keys: ['一年内到期的非流动负债', '一年内到期'] },
  { folder: '30其他流动负债', keys: ['其他流动负债'] },
  { folder: '31长期借款', keys: ['长期借款'] },
  { folder: '32递延收益', keys: ['递延收益'] },
];

// 金额解析：允许 1,234.56 / ￥1,234 / (1,234) / 空 / 文本；解析不出来当「没有金额」
export function amountOf(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let t = String(v).trim();
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  t = t.replace(/[,，\s￥¥元]/g, '');
  if (!/^[-+]?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

function subjectName(row) {
  if (row == null) return '';
  if (typeof row === 'string') return row.trim();
  return String(row.name == null ? '' : row.name).trim();
}

function subjectAmount(row) {
  if (row == null || typeof row !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(row, 'amount')) return amountOf(row.amount);
  return null;
}

// 有金额的科目名（供前端提示 / 排错用）
export function nonZeroSubjectNames(subjects) {
  const out = [];
  (Array.isArray(subjects) ? subjects : []).forEach(row => {
    const n = subjectName(row);
    if (!n) return;
    const a = subjectAmount(row);
    if (a != null && Math.abs(a) > 0) out.push(n);
  });
  return out;
}

// 命中哪些资产基础法科目目录（只在有金额时命中）
export function abFoldersFor(subjects) {
  const rows = (Array.isArray(subjects) ? subjects : [])
    .map(row => ({ name: subjectName(row), amount: subjectAmount(row) }))
    .filter(x => x.name && x.amount != null && Math.abs(x.amount) > 0);
  const hits = [];
  AB_SUBJECTS.forEach(def => {
    const hit = rows.some(r => def.keys.some(k => r.name.indexOf(k) >= 0));
    if (hit) hits.push(def);
  });
  return hits;
}

// 资产基础法科目夹的天源同构子目录：每个科目必有「查证资料」，再按科目类型加专用夹
// （与天源系统 get_project_file_list 实测结构一致：现金→盘点、借款→担保、存货→科目通用文件、
//   权属/实物/税类→其他；带明细 children 的科目在明细层各配 查证资料+其他）。
export function abExtraFolders(folder) {
  const t = String(folder || '');
  if (t === '01货币资金') return ['盘点'];
  if (t === '07存货') return ['科目通用文件'];
  if (t === '20短期借款' || t === '31长期借款') return ['担保'];
  if (t === '11投资性房地产' || t === '13在建工程' || t === '18递延所得税资产' || t === '27应交税费') return ['其他'];
  return [];
}

function safeSeg(name) {
  const t = String(name == null ? '' : name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return t.slice(0, 80) || '未命名公司';
}

function uniqSeg(seg, used) {
  const n = (used.get(seg) || 0) + 1;
  used.set(seg, n);
  return n === 1 ? seg : seg + '(' + n + ')';
}

// 把「公司 + 方法 + 科目」翻成相对目录列表（不含项目根目录）
export function planProjectFolders(input) {
  const companies = (input && Array.isArray(input.companies)) ? input.companies : [];
  const out = [];
  const seen = new Set();
  const push = p => { if (p && !seen.has(p)) { seen.add(p); out.push(p); } };
  STATIC_DIRS.forEach(push);
  // 管理类底稿：一个项目一套，落在 03评估底稿/管理类底稿/<分类>
  push(MGMT_FOLDER);
  MGMT_CATEGORIES.forEach(cat => push(MGMT_FOLDER + '/' + safeSeg(cat)));

  const used = new Map();
  companies.forEach(c => {
    const name = String((c && c.name) || '').trim();
    if (!name) return;
    const seg = uniqSeg(safeSeg(c.name), used);
    const base = '02现场资料/企业提供资料/';
    // 财务类资料 + 基础类资料：每家公司一套（分类在前、公司在后）
    push(base + '00财务资料/' + seg);
    // 报表原件夹：公司夹下固定一层，导入报表就按这个夹扫描
    push(base + '00财务资料/' + seg + '/' + FIN_STATEMENT_DIR);
    push(base + '00财务资料/' + seg + '/' + AUDIT_REPORT_DIR);
    push(base + '02基础类/' + seg);
    BASIC_CATEGORIES.forEach(cat => push(base + '02基础类/' + seg + '/' + safeSeg(cat)));

    const m = (c && c.methods) || {};
    const whole = Array.isArray(m.whole) ? m.whole : [];
    const has = x => whole.indexOf(x) >= 0;

    if (has('资产基础法')) {
      push(base + '03资产基础法/' + seg);
      abFoldersFor(c.subjects).forEach(def => {
        const subjBase = base + '03资产基础法/' + seg + '/' + def.folder;
        push(subjBase);
        push(subjBase + '/查证资料');
        abExtraFolders(def.folder).forEach(x => push(subjBase + '/' + x));
        (def.children || []).forEach(ch => {
          const chBase = subjBase + '/' + ch;
          push(chBase);
          push(chBase + '/查证资料');
          push(chBase + '/其他');
        });
      });
    }
    if (has('收益法')) {
      INCOME_CHILDREN.forEach(ch => push(base + '04收益法/' + seg + '/' + ch));
    }
    if (has('市场法')) {
      push(base + '05市场法/' + seg);
    }
  });
  return out;
}

export default { STATIC_DIRS, INCOME_CHILDREN, AB_SUBJECTS, BASIC_CATEGORIES, MGMT_CATEGORIES, MGMT_FOLDER, amountOf, planProjectFolders, abFoldersFor, abExtraFolders, nonZeroSubjectNames };
