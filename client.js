window.__ModuleLoader__.load({
  id: '@zer0_y/dsh-ty-workbench',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef, useCallback } = React;

    // ---------- constants ----------
    const NS = 'workbench';
    const PANEL_ID = 'workbench';
    let rightBar = null;   // ctx.sidebarRight, captured in apply()
    let workspacePicker = null; // optional DSH Host-native directory picker
    const STORE_KEY = 'dsh-workbench:v1';
    const PREFIX = '/api/workbench';   // same-origin host routes registered by index.js
    const TY_BASE = 'https://ty.zhrdc.net/project/my';
    // 天源项目页：/ty/operation/<项目ID>/equity/list 是项目级路由（ID 即 MCP get_my_projects 返回的 id）。
    const TY_APP = 'https://excel.zhrdc.net/ty/operation';
    const tyProjectUrl = tyId => {
      const id = String(tyId == null ? '' : tyId).trim();
      return /^\d+$/.test(id) ? TY_APP + '/' + id + '/equity/list' : TY_BASE;
    };

    // Exam catalogue. Dates are placeholders the user can edit in the UI;
    // DSH never guesses official registration windows.
    const EXAMS = [
      { id: 'cpv', name: '资产评估师', short: 'CPV', subjects: ['资产评估实务（一）', '资产评估相关知识'], note: '实务一 + 相关知识' },
      { id: 'cpa', name: '注册会计师', short: 'CPA', subjects: ['会计', '审计', '财务成本管理', '经济法', '税法', '公司战略与风险管理'], note: '专业阶段 6 科 + 综合阶段' },
      { id: 'intermediate-accounting', name: '中级会计师', short: '中级会计', subjects: ['中级会计实务', '财务管理', '经济法'], note: '2 年滚动有效' },
      { id: 'real-estate', name: '房地产估价师', short: '房估', subjects: ['房地产制度法规政策', '房地产估价原理与方法', '房地产估价基础与实务', '土地估价基础与实务'], note: '' },
      { id: 'mining-rights', name: '矿业权评估师', short: '矿业权', subjects: ['矿业权评估实务与案例', '矿业权评估相关法律法规', '地质与矿业工程基础', '财务会计'], note: '' },
      { id: 'intermediate-economist', name: '中级经济师', short: '中级经济', subjects: ['经济基础知识', '专业知识和实务'], note: '10 个专业方向选 1' },
      { id: 'futures-analyst', name: '期货投资分析', short: '期货分析', subjects: ['期货基础知识', '期货法律法规', '期货投资分析'], note: '须先通过从业两科' },
    ];

    const examName = id => ((EXAMS.find(x => x.id === id) || {}).name || id);

    // 内部复核拆成四步：一复 → 二复 → 三复 → 签发（签发是内部复核的最后一步，之后才出具报告）
    const PROJECT_STAGES = ['承接/立项', '现场调查', '评定估算', '报告初稿', '一复', '二复', '三复', '签发', '出具报告', '归档/收款'];
    const WORK_TYPES = ['现场勘察', '资料收集', '市场调研', '评定估算', '底稿编制', '报告撰写', '内部复核', '沟通协调', '差旅'];
    const ALERT_KINDS = { buy: '买入点', sell: '卖出点', stop: '止损点', pct: '涨跌幅' };

    // 天源 MCP 能力目录快照（35 个工具，抓自 tools/list）。
    // n=工具名 g=分组 m=模式(read/preflight/write) u=工作台已接入 d=说明 r=必填参数 p=全部参数
    const TY_MCP_TOOLS = [
    { n: "get_my_projects", g: "项目与人员", m: "read", u: 1, d: "获取当前用户的项目列表", r: [], p: [] },
    { n: "get_project_context", g: "项目与人员", m: "read", u: 1, d: "根据项目ID获取评估项目详情和上下文信息", r: ["projectId"], p: ["projectId"] },
    { n: "prepare_add_project_participants", g: "项目与人员", m: "preflight", d: "按登录名、工号或完整姓名精确查找人员，读取当前项目参与人员并生成添加预览。本工具不会修改项目；姓名存在歧义时会返回候选人员。", r: ["projectId","participantIdentifiers"], p: ["projectId","participantIdentifiers"] },
    { n: "execute_add_project_participants", g: "项目与人员", m: "write", d: "仅在用户已查看预检结果并明确确认后调用。执行时会复查项目上下文没有变化，再保留全部现有项目信息并追加参与人员。", r: ["confirmationToken","confirmed","confirmedProjectId","confirmedParticipantUserNames"], p: ["confirmationToken","confirmed","confirmedProjectId","confirmedParticipantUserNames"] },
    { n: "get_project_companies", g: "被评估公司与负责人", m: "read", u: 1, d: "根据项目ID获取该项目的股权（公司）信息", r: ["projectId"], p: ["projectId"] },
    { n: "prepare_set_company_managers", g: "被评估公司与负责人", m: "preflight", d: "按项目 ID、公司 ID 和项目成员登录名/完整姓名预检公司负责人设置。该工具只读取数据并生成确认预览，不会修改公司负责人。", r: ["projectId","companyIds","managerIdentifiers"], p: ["projectId","companyIds","managerIdentifiers"] },
    { n: "execute_set_company_managers", g: "被评估公司与负责人", m: "write", d: "仅在用户已查看预检结果并明确确认后调用。执行时会复查公司负责人未在预检后变化，再调用估值后端覆盖设置公司负责人。", r: ["confirmationToken","confirmed","confirmedProjectId","confirmedCompanyIds","confirmedManagerUserNames"], p: ["confirmationToken","confirmed","confirmedProjectId","confirmedCompanyIds","confirmedManagerUserNames"] },
    { n: "prepare_remove_company_managers", g: "被评估公司与负责人", m: "preflight", d: "按项目 ID、公司 ID 和当前负责人登录名/完整姓名预检删除公司负责人。该工具只读取数据并生成确认预览，不会修改公司负责人；清空负责人时传 clearAll=true。", r: ["projectId","companyIds"], p: ["projectId","companyIds","managerIdentifiers","clearAll"] },
    { n: "execute_remove_company_managers", g: "被评估公司与负责人", m: "write", d: "仅在用户已查看删除预检结果并明确确认后调用。执行时会复查公司负责人未在预检后变化，再调用估值后端全量更新接口写入删除后的负责人列表。", r: ["confirmationToken","confirmed","confirmedProjectId","confirmedClearAll","confirmedCompanyIds","confirmedRemovedManagerUserNames","confirmedRemainingManagerUserNames"], p: ["confirmationToken","confirmed","confirmedProjectId","confirmedClearAll","confirmedCompanyIds","confirmedRemovedManagerUserNames","confirmedRemainingManagerUserNames"] },
    { n: "get_company_asset_based_approach_subjects", g: "资产基础法底稿", m: "read", d: "获取指定公司的资产基础法科目代码、标准名称及公司重命名名称。查询底稿前科目不明确时应先调用本工具。", r: ["projectId","companyId"], p: ["projectId","companyId","keyword"] },
    { n: "get_asset_based_approach_draft_data", g: "资产基础法底稿", m: "read", d: "根据项目 ID、公司 ID 和科目名称，分页查询该公司的资产基础法普通底稿数据。不要猜测科目代码；工具会根据标准科目名称或公司重命名名称自动解析代码。", r: ["projectId","companyId","subjectName"], p: ["projectId","companyId","subjectName","pageNum","limit"] },
    { n: "get_user_held_asset_based_approach_draft_edit_locks", g: "底稿编辑锁", m: "read", d: "查询指定用户跨项目持有且仍有效的资产基础法底稿（含注释文件）编辑锁。仅具有识别系统管理员角色的用户可以调用。", r: ["holderUserId"], p: ["holderUserId"] },
    { n: "release_asset_based_approach_draft_edit_locks_by_user", g: "底稿编辑锁", m: "write", d: "按锁持有者批量释放资产基础法底稿（含注释文件）编辑锁。ALL 释放该用户持有的全部锁且不能传锁组合；SELECTED 仅释放指定组合。该操作会改变编辑锁状态，仅在用户明确要求释放后调用，并且仅限识别系统管理员。", r: ["holderUserId","releaseMode"], p: ["holderUserId","releaseMode","lockItemList"] },
    { n: "force_release_asset_based_approach_draft_edit_locks_by_scope", g: "底稿编辑锁", m: "write", d: "按项目、公司、科目组合强制释放资产基础法底稿（含注释文件）编辑锁。该操作会释放组合对应的有效锁，不区分当前持有者；仅在用户明确要求释放后调用，并且仅限识别系统管理员。", r: ["lockItemList"], p: ["lockItemList"] },
    { n: "prepare_asset_based_approach_draft_import", g: "资产基础法底稿", m: "preflight", d: "校验 Agent 从 Excel 解析出的资产基础法底稿申报数据，检查目标公司、科目权限、字段格式和覆盖风险，并生成用户确认预览。本工具不会获取编辑锁，也不会保存任何数据。", r: ["projectId","targetCompanyIds","sourceFileName","subjects"], p: ["projectId","targetCompanyIds","sourceFileName","sourceFileSha256","subjects"] },
    { n: "execute_asset_based_approach_draft_import", g: "资产基础法底稿", m: "write", d: "仅在用户已查看预检工具返回的公司、科目、行数和覆盖清单并明确确认后调用。凭证为短期一次性凭证；执行时会重新校验权限和覆盖状态、获取全部编辑锁、按科目向多家公司写入并释放编辑锁。", r: ["confirmationToken","confirmed"], p: ["confirmationToken","confirmed"] },
    { n: "prepare_financial_statement_report_import", g: "财务报表", m: "preflight", d: "校验 Agent 从 Excel 等文件解析出的资产负债表或利润表数据，支持单体/合并口径。工具会读取新财务报表配置、项目历史期间、标准科目、科目对照表和已有报表，生成最终保存接口请求体和用户确认预览；本工具不会保存数据。", r: ["projectId","companyId","statementType","reportMode","sheetList"], p: ["projectId","companyId","sourceFileName","statementType","reportMode","missingSubjectPolicy","includeRequestBody","sheetList"] },
    { n: "execute_financial_statement_report_import", g: "财务报表", m: "write", d: "仅在用户已查看预检工具返回的导入目标、年度、科目数量、跳过行和最终保存请求体并明确确认后调用。凭证为短期一次性凭证；执行前会重新预检，确认最终请求体未变化后才调用后端保存接口。", r: ["confirmationToken","confirmed"], p: ["confirmationToken","confirmed"] },
    { n: "get_financial_statement_reports", g: "财务报表", m: "read", d: "读取某项目某公司的财务报表数据，支持资产负债表、利润表以及单体/合并口径。工具会按财务报表页面逻辑读取参数、科目模板和已有报表，返回模拟前端 SpreadJS 的工作表数据视图，也可返回后端原始数据。", r: ["projectId","companyId"], p: ["projectId","companyId","statementType","reportMode","view","includeEmptySubjects"] },
    { n: "save_financial_statement_config", g: "财务报表", m: "write", d: "保存指定项目和公司的财务报表参数设置，包括报表口径、报表类型、显示期数、币种和金额单位。只修改传入的配置字段；省略字段沿用当前值，当前值为空时使用前端默认值：单体、一般企业、4 期、人民币（ID 1）、元。不保存资产负债表或利润表明细。工具会先查询当前配置：若查询结果包含配置 id，则自动按更新提交；若没有 id，则自动按新增提交。无需传入 id；查询返回的币种名称会按前端逻辑转换为币种 ID。仅在用户明确要求新增或修改参数后调用；查询配置或币种列表失败时不会调用保存接口。", r: ["projectId","companyId"], p: ["projectId","companyId","reportMode","modeId","reportPeriodNum","currency","unit"] },
    { n: "get_project_file_list", g: "项目文件与明细表", m: "read", u: 1, d: "获取当前用户可访问的指定评估项目文件列表，可按公司和关键词筛选。返回公司、目录路径、文件名称、大小、创建时间和创建人等信息。", r: ["projectId"], p: ["projectId","companyId","keyword","pageNum","pageSize"] },
    { n: "get_company_asset_based_approach_summary", g: "汇总表", m: "read", d: "获取指定项目、指定公司的资产基础法汇总表。返回结果会按前端 SpreadJS 页面补齐全部科目、展示层级和排序，并说明账面价值、评估价值、增值额、增值率及报表差异。", r: ["projectId","companyId"], p: ["projectId","companyId"] },
    { n: "get_company_income_approach_summary", g: "汇总表", m: "read", d: "获取指定项目、指定公司的收益法汇总表。默认返回前端“预测期结果”对应的紧凑数据，可按模型设定、历史数据、未来预测、永续期预测、预测期结果选择展示内容，并限制返回层级；需要逐期间配置时可选择详细模式。", r: ["projectId","companyId"], p: ["projectId","companyId","sections","responseMode","maxLevel"] },
    { n: "get_company_market_approach_summary", g: "汇总表", m: "read", d: "获取指定项目、指定公司的市场法汇总表。除汇总接口外还会核验市场法底稿，区分真实零值、尚未填写、底稿缺失以及汇总值不一致。", r: ["projectId","companyId"], p: ["projectId","companyId"] },
    { n: "get_project_summary", g: "汇总表", m: "read", d: "获取指定评估项目的项目汇总表。返回公司层级、股权比例、评估方法、整体评估原币价值、非整体评估本位币价值、最终评估价值及增值情况；可按公司主体、被投资单位或前端显示公司层级筛选。本工具只读取已有汇总结果，不触发刷新重算。", r: ["projectId"], p: ["projectId","parentCompanyIds","investeeCompanyIds","maxCompanyLevel"] },
    { n: "request_detail_table_export_api", g: "项目文件与明细表", m: "read", d: "为 tycpv-cli 明细表/申报表、估算二级文件和收益法二级文件下载转发受控的估值后端只读接口。收益法二级文件列表保留分页信息。业务 tk 只在 MCP server 内部使用，不返回给客户端。", r: ["method","path"], p: ["method","path","params","body"] },
    { n: "get_report_config", g: "报告配置与导出", m: "read", d: "读取某项目、公司和报告类型的报告配置基本信息及命名参数。", r: ["projectId","companyId","reportType"], p: ["projectId","companyId","reportType"] },
    { n: "get_long_term_report_config", g: "报告配置与导出", m: "read", d: "读取指定公司的长投说明配置 ID、基本信息、财务信息和核实信息。", r: ["projectId","companyId"], p: ["projectId","companyId"] },
    { n: "get_report_config_items", g: "报告配置与导出", m: "read", d: "查询报告配置节点树，可读取有效节点、回收站节点或条件过滤未通过的节点。", r: ["projectId","companyId","reportType"], p: ["projectId","companyId","reportType","itemSet"] },
    { n: "get_report_variables", g: "报告配置与导出", m: "read", d: "按变量名列表查询某项目和公司当前的报告变量值；可选择表格型变量是否以结构化对象返回。", r: ["projectId","companyId","variables"], p: ["projectId","companyId","variables","structuredTableVariable"] },
    { n: "export_report_full_json", g: "报告配置与导出", m: "read", d: "导出指定项目、公司和报告类型的 ReportFullExportVO JSON，包括报告基础信息、通过节点条件校验的有效节点树、去除格式但不填充变量值的节点正文及页眉页脚。节点条件配置会保留，条件校验未通过的节点及其子树不会导出。成功结果是可原样保存的裸 JSON，并附带建议文件名元数据。", r: ["projectId","companyId","reportType"], p: ["projectId","companyId","reportType"] },
    { n: "download_report_attachment", g: "报告配置与导出", m: "read", d: "根据附件 ID 下载单个通用附件。该接口可下载报告附件、资产基础法估算二级文件附件、收益法二级文件附件及其他 valuation 通用附件；成功结果包含文件元数据和标准 MCP embedded resource blob，Agent 应将 blob 按 Base64 解码后原样保存。", r: ["attachId"], p: ["attachId"] },
    { n: "get_estimation_second_file_list", g: "二级文件", m: "read", d: "分页查询指定项目和资产基础法科目下的估算二级文件列表。支持按文件名、评估方法、公司、创建人筛选，并返回后端分页信息。", r: ["projectId","subjectCode"], p: ["projectId","subjectCode","fileName","valuationTypeList","valuationTypeListJson","companyIdList","createUserName","creatorId","actorUserName","pageNum","limit"] },
    { n: "get_income_second_file_list", g: "二级文件", m: "read", d: "分页查询指定项目和公司的收益法通用二级文件列表。支持按二级文件名称、分组、节点、创建人和更新人筛选；列表结果包含二级文件 ID、名称、附件 URI 等信息。若需要附件 ID，请使用返回的二级文件 ID继续调用收益法二级文件详情 Tool，再调用通用附件下载 Tool 下载文件。", r: ["projectId","companyId"], p: ["projectId","companyId","name","groupName","nodeId","creatorUserName","updaterUserName","pageNum","limit"] },
    { n: "get_income_second_file_detail", g: "二级文件", m: "read", d: "查询指定项目、公司和收益法二级文件 ID 的详情，返回二级文件名称、主附件 attachId、附件 URI 以及单元格附件列表。拿到 attachId 后可调用通用附件下载 Tool 下载收益法二级文件主附件。", r: ["projectId","companyId","auxiliaryTableId"], p: ["projectId","companyId","auxiliaryTableId"] },
    ];
    // tycpv CLI 命令（D:\tycpv\tycpv.cmd，来自 tycpv --help），[命令, 作用]
    const TY_CLI_CMDS = [
      ["tycpv login", "打开浏览器登录并授权 tycpv-agent-cli"],
      ["tycpv logout", "退出登录并作废本机凭据"],
      ["tycpv import-asset-draft-data", "导入资产基础法底稿数据"],
      ["tycpv export-asset-detail-table", "导出资产基础法明细表"],
      ["tycpv export-asset-declare-table", "导出资产基础法申报表"],
      ["tycpv export-asset-summary-table", "导出资产基础法公司汇总表"],
      ["tycpv export-income-summary-table", "导出收益法公司汇总表"],
      ["tycpv export-report-full-json", "导出报告全量 JSON"],
      ["tycpv download-report-attachment", "按附件 ID 下载指定附件"],
      ["tycpv export-estimate-second-file", "下载资产基础法估算二级文件及其附件"],
      ["tycpv export-income-second-file", "下载收益法二级文件及其附件"],
    ];

    const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    function defaults() {
      const today = todayStr();
      return {
        version: 1,
        work: {
          projects: [
            { id: uid(), code: 'DEMO-001', name: '示例项目 · 某公司股东全部权益价值评估', client: '示例评估对象', type: '企业价值评估', baseDate: today, deadline: '', stage: '现场调查', budgetHours: 120, tyId: '', tyUrl: TY_BASE, note: '示例数据，可直接删除' },
          ],
          logs: [
            { id: uid(), projectId: '', date: today, hours: 4, type: '资料收集', task: '示例工时记录', billable: true, note: '' },
          ],
          equity: {},
          finance: {},
          ty: { baseUrl: TY_BASE, token: '', cookie: '', syncUrl: '', autoSync: false, lastSync: '', cachedProjects: [], cachedAt: '', cachedUser: '' },
        },
        study: {
          exams: EXAMS.map(e => ({ id: e.id, target: '', examDate: '', regStart: '', regEnd: '', remindDays: 7, active: true, hoursPerWeek: 4 })),
          plans: [],
        },
        stock: {
          watch: [
            { id: uid(), code: 'sh600519', name: '贵州茅台', market: 'sh', buyBelow: '', sellAbove: '', stopLoss: '', pctUp: '', pctDown: '', note: '示例自选股，可删除' },
            { id: uid(), code: 'sz000001', name: '平安银行', market: 'sz', buyBelow: '11.00', sellAbove: '13.50', stopLoss: '', pctUp: '', pctDown: '', note: '' },
          ],
          quotes: {}, updatedAt: '', pollSeconds: 60, alertsEnabled: false, nineTurnEnabled: true,
        },
        alerts: [],
        settings: { notify: true, notifySound: false, activeTab: 'overview',
          ui: { tab: 'work', subs: {}, openProjectId: '' },
          exportPrefs: { mode: 'auto', restoreFormulas: true, applyFormat: true, outputDir: '' },
        },
      };
    }

    // ---------- persistence ----------
    // 两级：localStorage 是快路径缓存（同步读、离线可用），磁盘上的
    // 「<数据目录>\工作台数据.json」才是正式数据（设置里可改目录，默认 D:\天源评估\个人工作台）。
    const SAVED_AT_KEY = STORE_KEY + ':savedAt';
    // 落盘状态：给「设置」页显示，同时让订阅者（界面）能刷新
    const hostSync = { status: 'idle', at: null, error: '', dir: '', file: '', exists: false };

    // 委托人：数据本体是 customers 数组（一个项目可以多个委托人），customer 只是第一个的别名。
    // 旧版天源导入只写了 customer，customers 还是 newProject() 里的空壳；而表单/保存一律读
    // customers，于是导入过来的委托人全被空壳顶掉（客户信息页签空白）。下面两个函数负责兜底：
    // 数组里没有任何有效委托人时，用 customer 补回去。
    const customerFilled = c => !!(c && (
      String(c.name == null ? '' : c.name).trim()
      || String(c.shortName == null ? '' : c.shortName).trim()
      || String(c.creditCode == null ? '' : c.creditCode).trim()));
    function projectCustomers(src) {
      const p = src || {};
      const list = Array.isArray(p.customers) ? p.customers.filter(Boolean) : [];
      if (list.some(customerFilled)) return list;
      if (customerFilled(p.customer)) return [p.customer];
      return list.length ? list : [p.customer || {}];
    }
    function repairCustomers(p) {
      if (!p || typeof p !== 'object') return p;
      const list = Array.isArray(p.customers) ? p.customers.filter(Boolean) : [];
      if (list.some(customerFilled)) return p;
      if (!customerFilled(p.customer)) return p;
      return { ...p, customers: [p.customer], customer: p.customer };
    }

    function normalizeState(saved) {
      const d = defaults();
      const src = saved && typeof saved === 'object' ? saved : {};
      const srcWork = src.work || {};
      return {
        version: 1,
        work: { ...d.work, ...srcWork, ty: { ...d.work.ty, ...(srcWork.ty || {}) },
          projects: (Array.isArray(srcWork.projects) && srcWork.projects.length ? srcWork.projects : d.work.projects).map(repairCustomers) },
        study: { ...d.study, ...(src.study || {}) },
        stock: (() => {
          const st = { ...d.stock, ...(src.stock || {}) };
          // 旧版只有「价格到点提醒」；本次把买入卖出提醒改为每日 13:00 神奇九转，
          // 首次加载旧数据时把价格提醒默认关掉（仍可在提醒设置里重新勾选）。
          if (src.stock && src.stock.nineTurnEnabled === undefined) st.alertsEnabled = false;
          st.nineTurnEnabled = st.nineTurnEnabled !== false;
          return st;
        })(),
        alerts: Array.isArray(src.alerts) ? src.alerts : [],
        settings: { ...d.settings, ...(src.settings || {}),
          // 跨会话记住「上次打开的界面」：当前页签、各页的子页签、打开中的项目、
          // 导出对话框的常用参数（输出目录/模式/处理选项）。
          ui: {
            tab: 'work', subs: {}, openProjectId: '',
            ...((src.settings && src.settings.ui) || {}),
          },
          exportPrefs: { mode: 'auto', restoreFormulas: true, applyFormat: true, outputDir: '',
            ...((src.settings && src.settings.exportPrefs) || {}) },
        },
      };
    }
    function loadState() {
      try {
        const raw = localStorage.getItem(STORE_KEY);
        if (!raw) return defaults();
        return normalizeState(JSON.parse(raw));
      } catch (e) { return defaults(); }
    }

    let hostSaveTimer = null;
    let pendingSave = null;
    let hostQueue = Promise.resolve();

    // 写盘串行化：两次改动相隔很近时，HTTP 完成顺序不保证，
    // 旧快照可能后到、把新状态盖掉（实测切目录后立刻勾选出现过）。
    // 这里排队按调用顺序写，最后一个 payload 永远是最后落地的。
    function pushState(s) {
      const send = () => fetch(PREFIX + '/store/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: s }),
      }).then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
        Object.assign(hostSync, { status: 'ok', at: d.savedAt || new Date().toISOString(), error: '', file: d.file || hostSync.file, dir: d.dir || hostSync.dir });
        return d;
      }).catch(e => {
        Object.assign(hostSync, { status: 'error', error: '写盘失败：' + ((e && e.message) || e) });
        throw e;
      });
      hostQueue = hostQueue.then(send, send);
      return hostQueue;
    }

    // 合并连续改动：换 tab、勾选框这类高频小改动不该每次都写一次文件
    function queueHostSave(s) {
      pendingSave = s;
      if (hostSaveTimer) return;
      hostSaveTimer = setTimeout(() => {
        const payload = pendingSave;
        hostSaveTimer = null; pendingSave = null;
        if (payload) pushState(payload).catch(() => {}).finally(() => listeners.forEach(fn => fn()));
      }, 800);
    }

    // 关页面 / 切到后台时，把还压在 800ms 防抖里的最后一份改动补出去：
    // 否则「改完立刻关窗口」会丢掉最后不到 1 秒的那次修改。
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const flushOnHide = () => {
        if (hostSaveTimer) { clearTimeout(hostSaveTimer); hostSaveTimer = null; }
        const payload = pendingSave; pendingSave = null;
        if (!payload) return;
        const body = JSON.stringify({ data: payload });
        try {
          if (navigator.sendBeacon) {
            navigator.sendBeacon(PREFIX + '/store/state', new Blob([body], { type: 'application/json' }));
            return;
          }
        } catch (e) { /* 退回 keepalive fetch */ }
        try { fetch(PREFIX + '/store/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }); } catch (e) {}
      };
      window.addEventListener('pagehide', flushOnHide);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushOnHide(); });
    }

    function saveState(s) {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(s));
        localStorage.setItem(SAVED_AT_KEY, new Date().toISOString());
      } catch (e) {}
      // 读盘回来之前不写磁盘：挂载时的自动任务（排课/提醒）会先 set 一次，
      // 若这时就把「默认值」写出去，会盖掉磁盘上的真实数据（清过缓存就中招）。
      if (hydrated) queueHostSave(s);
    }

    let hydrated = false;
    function finishHydrate() {
      if (hydrated) return;
      hydrated = true;
      // 磁盘上没有数据（首次运行）或本地更新：把最终状态写出去，让两边收敛
      queueHostSave(state);
      listeners.forEach(fn => fn());
    }

    // 启动时把磁盘副本读回来：两份都在时以 savedAt 新的那份为准，
    // 避免「清过浏览器缓存」或「换了端口」导致数据看起来倒退。
    function hydrateFromHost() {
      // 关键：这份时间戳必须在「React 挂载后的自动写」之前取。
      // 挂载时的排课/提醒 effect 会立刻 store.set 一次并刷新 SAVED_AT_KEY，
      // 若等 fetch 回来再读，本地时间永远是「刚刚」，磁盘数据就永远被判成旧的。
      let localAt = '';
      try { localAt = localStorage.getItem(SAVED_AT_KEY) || ''; } catch (e) {}
      return fetch(PREFIX + '/store/state', { cache: 'no-store' })
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (!d) { finishHydrate(); return; }
          Object.assign(hostSync, { dir: d.dir || '', file: d.file || '', exists: !!d.exists, at: d.savedAt || hostSync.at });
          if (!d.data) { finishHydrate(); return; }          // 磁盘还没有数据：保留 localStorage / 默认值
          const hostAt = d.savedAt || '';
          if (localAt && hostAt && hostAt <= localAt) { finishHydrate(); return; }   // 本地更新，不覆盖
          state = normalizeState(d.data);
          try {
            localStorage.setItem(STORE_KEY, JSON.stringify(state));
            localStorage.setItem(SAVED_AT_KEY, hostAt || new Date().toISOString());
          } catch (e) {}
          finishHydrate();
        })
        .catch(() => finishHydrate());
    }

    // single shared store with useSyncExternalStore-style subscription (React 18)
    let state = loadState();
    const listeners = new Set();
    const store = {
      get: () => state,
      set(updater) {
        state = typeof updater === 'function' ? updater(state) : updater;
        saveState(state);
        listeners.forEach(fn => fn());
      },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    };
    function useStore() {
      const [, force] = useState(0);
      useEffect(() => store.subscribe(() => force(n => n + 1)), []);
      return state;
    }
    const patch = (section, fn) => store.set(s => ({ ...s, [section]: typeof fn === 'function' ? fn(s[section]) : fn }));

    // 异步把磁盘副本并进来（不阻塞首屏：先渲染 localStorage/默认值，读回来后再刷新）
    hydrateFromHost();

    // ---------- helpers ----------
    const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const fmt = (v, d = 2) => v == null || v === '' ? '—' : Number(v).toFixed(d);
    const money = v => v == null || v === '' ? '—' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
    const esc = t => String(t == null ? '' : t);
    const dateDiff = (a, b) => Math.round((new Date(a + 'T00:00:00') - new Date(b + 'T00:00:00')) / 86400000);
    // YYYY-MM-DD 加 N 天，输入不合法返回空串（归档日 = 评估报告日 + 90 天用它）
    const datePlus = (s, days) => {
      const t = String(s == null ? '' : s).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return '';
      const d = new Date(t + 'T00:00:00');
      if (Number.isNaN(d.getTime())) return '';
      d.setDate(d.getDate() + Number(days || 0));
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    };
    const pct = (a, b) => b ? ((a - b) / b) * 100 : 0;

    function addAlert(s, kind, title, body, level) {
      const key = kind + '|' + title + '|' + body;
      if (s.alerts.some(a => a.key === key && !a.read)) return s;
      const item = { id: uid(), key, kind, title, body, level: level || 'info', at: new Date().toISOString(), read: false };
      return { ...s, alerts: [item, ...s.alerts].slice(0, 120) };
    }
    function browserNotify(title, body) {
      try {
        if (!state.settings.notify || typeof Notification === 'undefined') return;
        if (Notification.permission === 'granted') new Notification(title, { body, tag: 'dsh-workbench' });
        else if (Notification.permission !== 'denied') Notification.requestPermission().then(p => { if (p === 'granted') new Notification(title, { body }); });
      } catch (e) {}
    }

    // ---------- seed data from host (exam calendar) ----------
    // Retryable: one failed attempt (host route not ready, etc.) must never disable seeding forever.
    let seedInflight = null, seedDone = false, seedCounts = null;
    async function seedFromHost(force) {
      if (seedInflight) return seedInflight;
      if (seedDone && !force) return seedCounts;
      seedInflight = (async () => {
        let cal = null, errs = [];
        try { const r = await fetch(PREFIX + '/data/calendar'); if (r.ok) cal = await r.json(); else errs.push('calendar HTTP ' + r.status); }
        catch (e) { errs.push('calendar ' + ((e && e.message) || e)); }
        const nCal = cal && Array.isArray(cal.exams) ? cal.exams.length : 0;
        let filled = 0;
        store.set(st => {
          let next = st;
          if (nCal) {
            const byId = {};
            cal.exams.forEach(x => { if (x && x.id) byId[x.id] = x; });
            next = { ...next, study: { ...next.study, exams: next.study.exams.map(e => {
              const c = byId[e.id];
              if (!c) return e;
              filled += 1;
              if (e.userEdited) return e;
              return { ...e, regStart: c.regStart || '', regEnd: c.regEnd || '', examDate: c.examDate || '', examDateEnd: c.examDateEnd || '',
                calSource: c.confidence || 'unknown', calUrl: c.officialUrl || '', calNote: c.note || '', calGeneratedAt: cal.generatedAt || '' };
            }) } };
          }
          return next;
        });
        seedDone = nCal > 0;
        seedCounts = { calendar: nCal, filled, err: errs.join('; ') };
        return seedCounts;
      })();
      try { return await seedInflight; } finally { seedInflight = null; }
    }

    // ---------- Tencent quote API (JSONP) ----------
    function jsonp(url, timeout) {
      return new Promise((resolve, reject) => {
        const cb = 'dshwb_' + uid().replace(/[^a-z0-9]/gi, '');
        const sc = document.createElement('script');
        let done = false;
        const cleanup = () => { try { delete window[cb]; } catch (e) { window[cb] = undefined; } if (sc.parentNode) sc.parentNode.removeChild(sc); clearTimeout(timer); };
        const timer = setTimeout(() => { if (!done) { done = true; cleanup(); reject(new Error('timeout')); } }, timeout || 8000);
        window[cb] = data => { if (done) return; done = true; const v = data; cleanup(); resolve(v); };
        sc.onerror = () => { if (done) return; done = true; cleanup(); reject(new Error('network')); };
        sc.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
        (document.head || document.documentElement).appendChild(sc);
      });
    }
    function parseQuote(raw) {
      if (!raw || typeof raw !== 'string') return null;
      const p = raw.split('~');
      if (p.length < 35) return null;
      return { market: p[0], name: p[1], code: p[2], price: num(p[3]), prevClose: num(p[4]), open: num(p[5]),
        // 腾讯字段：36 成交量(手) · 37 成交额(万) · 38 换手率 · 39 市盈率(TTM) · 43 振幅 · 45 总市值(亿) · 46 市净率
        volume: num(p[36]), amount: num(p[37]), turnover: num(p[38]), pe: num(p[39]),
        change: num(p[31]), changePct: num(p[32]), high: num(p[33]), low: num(p[34]), time: p[30],
        amplitude: num(p[43]), marketCap: num(p[45]), pb: num(p[46]) };
    }
    async function fetchQuotes(codes) {
      const list = [...new Set(codes.filter(Boolean))];
      if (!list.length) return {};
      // qt.gtimg.cn returns JS assignments (v_sh600519="..."); CORS-free via <script>
      await jsonpScript('https://qt.gtimg.cn/q=' + list.join(','));
      const out = {};
      list.forEach(c => { const v = window['v_' + c]; if (typeof v === 'string') { const q = parseQuote(v); if (q) out[c] = q; } });
      return out;
    }
    function jsonpScript(url) {
      return new Promise((resolve, reject) => {
        const sc = document.createElement('script');
        sc.charset = 'GBK';
        const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 9000);
        function cleanup() { clearTimeout(timer); sc.onload = sc.onerror = null; if (sc.parentNode) sc.parentNode.removeChild(sc); }
        sc.onload = () => { cleanup(); resolve(); };
        sc.onerror = () => { cleanup(); reject(new Error('network')); };
        sc.src = url;
        (document.head || document.documentElement).appendChild(sc);
      });
    }
    async function searchStock(kw) {
      const data = await jsonp('https://smartbox.gtimg.cn/s3/?q=' + encodeURIComponent(kw) + '&t=all', 8000);
      const raw = typeof data === 'string' ? data : (data && data.hint ? data.hint : '');
      if (!raw || raw.indexOf('NONE') === 0) return [];
      return String(raw).split('^').map(row => {
        const p = row.split('~');
        return { market: p[0], code: p[0] + p[1], rawCode: p[1], name: decodeUnicode(p[2] || ''), type: p[4] || '' };
      }).filter(x => x.code && x.name && ['GP-A', 'GP', 'FJ', 'LOF', 'ETF', 'ZS'].includes(x.type)).slice(0, 12);
    }
    // 腾讯搜索对「深证指数」这类叫法会返回 NONE，且指数类型 ZS 以前被过滤掉；
    // 这里内置常用指数目录兜底，保证上证/深证等指数一定能搜到、加进自选。
    const INDEX_CATALOG = [
      { code: 'sh000001', name: '上证指数', aliases: ['上证指数', '上证综指', '上证综合指数', '沪指'] },
      { code: 'sz399001', name: '深证成指', aliases: ['深证成指', '深证指数', '深成指', '深指'] },
      { code: 'sz399006', name: '创业板指', aliases: ['创业板指', '创业板指数', '创指'] },
      { code: 'sh000688', name: '科创50', aliases: ['科创50', '科创板50', '科创50指数'] },
      { code: 'sh000300', name: '沪深300', aliases: ['沪深300', '沪深三百', 'hs300'] },
      { code: 'sh000905', name: '中证500', aliases: ['中证500', '中证五百'] },
      { code: 'sh000852', name: '中证1000', aliases: ['中证1000'] },
      { code: 'sh000016', name: '上证50', aliases: ['上证50', '上证五十'] },
      { code: 'bj899050', name: '北证50', aliases: ['北证50', '北证五十'] },
      { code: 'sz399330', name: '深证100', aliases: ['深证100'] },
    ];
    function matchIndexes(kw) {
      const q = String(kw == null ? '' : kw).trim().toLowerCase();
      if (!q) return [];
      return INDEX_CATALOG.filter(it => {
        if (q === it.code || q === it.code.slice(2)) return true;
        if (it.name.toLowerCase().includes(q) || q.includes(it.name.toLowerCase())) return true;
        return (it.aliases || []).some(a => a.toLowerCase().includes(q) || q.includes(a.toLowerCase()));
      }).map(it => ({ code: it.code, rawCode: it.code.slice(2), market: it.code.slice(0, 2), name: it.name, type: 'ZS' }));
    }
    function decodeUnicode(s) {
      return String(s || '').replace(/\\u([0-9a-fA-F]{4})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
    }

    // ---------- UI primitives (self-contained; host theme tokens only) ----------
    const css = [
      ".wb-root{--wb-accent:#1d4ed8;--wb-accent-hover:#1e40af;--wb-accent-soft:#e7effc;--wb-accent-soft-ink:#1d4ed8;--wb-warn-soft:#fff2e0;--wb-warn-ink:#a35b00;--wb-warn-border:#f0d6a8;--wb-danger-soft:#fdecea;--wb-danger-ink:#b63225;--wb-danger-border:#f0c2bc;--wb-ok-soft:#edf8f2;--wb-ok-border:#1b8a5a;--wb-ok-ink:#1b8a5a;--wb-surface-2:#fafbfc;--wb-chip-grey:#eef0f1;--wb-badge-bg:#b63225;--wb-badge-ink:#fff;height:100%;overflow:auto;box-sizing:border-box;padding:24px 28px 40px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);font-family:inherit;font-size:13px}",
      "body[data-ds-dark-theme] .wb-root{--wb-accent:#60a5fa;--wb-accent-hover:#93c5fd;--wb-accent-soft:#1c2a44;--wb-accent-soft-ink:#93c5fd;--wb-warn-soft:#3a2e1c;--wb-warn-ink:#ffb020;--wb-warn-border:#5c4620;--wb-danger-soft:#3d2422;--wb-danger-ink:#ff7b72;--wb-danger-border:#5e3330;--wb-ok-soft:#1b3427;--wb-ok-border:#4ed17e;--wb-ok-ink:#5ee08c;--wb-surface-2:#2c2c2e;--wb-chip-grey:#333335;--wb-badge-bg:#ff7b72;--wb-badge-ink:#151517}",
      ".wb-root *{box-sizing:border-box}",
      // 铺满可用宽度：原来的 max-width:1080px + 居中，在 1536/1920 这种宽窗口里
      // 两侧会各空出几百像素，而且窗口一过 1136px 内容就「卡住不动」，观感像没跟着窗口走。
      // 这里去掉上限只留内边距；卡片网格本身是 auto-fit minmax(230px,1fr)，会自动多排几列。
      ".wb-wrap{width:100%;max-width:none;margin:0}",
      ".wb-h1{font-size:20px;font-weight:650;margin:0 0 4px;color:var(--dsw-alias-label-primary,#1a1a1a)}",
      ".wb-sub{color:var(--dsw-alias-label-secondary,#666);font-size:12px;margin:0 0 20px}",
      ".wb-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1,#e3e6e8);margin-bottom:20px;flex-wrap:wrap}",
      ".wb-tab{border:0;background:transparent;padding:9px 14px;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-secondary,#666);border-bottom:2px solid transparent;margin-bottom:-1px;font-family:inherit}",
      ".wb-tab:hover{color:var(--dsw-alias-label-primary,#111)}",
      ".wb-tab.on{color:var(--dsw-alias-label-primary,#111);border-bottom-color:var(--wb-accent);font-weight:600}",
      ".wb-tab.scan-live{color:var(--wb-ok-ink)}",
      ".wb-tab.scan-live::after{content:\"\";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--wb-ok-ink);margin-left:5px;vertical-align:middle;animation:wb-pulse 1.2s ease-in-out infinite}",
      "@keyframes wb-pulse{0%,100%{opacity:1}50%{opacity:.25}}",
      ".wb-badge{display:inline-flex;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--wb-badge-bg);color:var(--wb-badge-ink);font-size:10px;align-items:center;justify-content:center;margin-left:5px;vertical-align:middle}",
      ".wb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;margin-bottom:16px}",
      ".wb-card{border:1px solid var(--dsw-alias-border-l1,#e3e6e8);border-radius:10px;padding:14px 16px;background:var(--wb-surface-2)}",
      ".wb-card h3{margin:0 0 8px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#111)}",
      ".wb-kpi{font-size:26px;font-weight:650;line-height:1.1;color:var(--wb-accent)}",
      ".wb-kpi-sub{font-size:11px;color:var(--dsw-alias-label-secondary,#666);margin-top:4px}",
      ".wb-sec{border:1px solid var(--dsw-alias-border-l1,#e3e6e8);border-radius:10px;padding:16px;margin-bottom:16px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".wb-sec-h{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap}",
      ".wb-sec-h h2{margin:0;font-size:14px;font-weight:650}",
      ".wb-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
      ".wb-btn{border:1px solid var(--dsw-alias-border-l1,#d8dcde);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#222);border-radius:7px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap}",
      ".wb-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f4f5)}",
      ".wb-btn.pri{background:var(--wb-accent);border-color:var(--wb-accent);color:#fff}",
      "body[data-ds-dark-theme] .wb-btn.pri{color:#0b1a2e}",
      ".wb-btn.pri:hover{background:var(--wb-accent-hover);border-color:var(--wb-accent-hover)}",
      ".wb-btn.danger{color:var(--wb-danger-ink);border-color:var(--wb-danger-border)}",
      ".wb-btn.sm{padding:3px 8px;font-size:11px}",
      ".wb-btn:disabled{opacity:.5;cursor:not-allowed}",
      ".wb-input,.wb-select,.wb-textarea{border:1px solid var(--dsw-alias-border-l1,#d8dcde);border-radius:7px;padding:6px 9px;font-size:12px;font-family:inherit;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#222);outline:none;min-width:0}",
      ".wb-input:focus,.wb-select:focus,.wb-textarea:focus{border-color:var(--wb-accent)}",
      ".wb-textarea{width:100%;resize:vertical;min-height:56px}",
      ".wb-label{font-size:11px;color:var(--dsw-alias-label-secondary,#666);display:block;margin-bottom:3px}",
      ".wb-table{width:100%;border-collapse:collapse;font-size:12px}",
      ".wb-table th{text-align:left;font-weight:600;color:var(--dsw-alias-label-secondary,#666);padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#e3e6e8);white-space:nowrap}",
      ".wb-table td{padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#eef0f1);vertical-align:middle}",
      ".wb-table tr:last-child td{border-bottom:0}",
      ".wb-table .muted{color:var(--dsw-alias-label-secondary,#888)}",
      ".wb-tag{display:inline-block;padding:2px 7px;border-radius:5px;background:var(--wb-accent-soft);color:var(--wb-accent-soft-ink);font-size:11px;white-space:nowrap}",
      ".wb-tag.warn{background:var(--wb-warn-soft);color:var(--wb-warn-ink)}",
      ".wb-tag.red{background:var(--wb-danger-soft);color:var(--wb-danger-ink)}",
      ".wb-tag.grey{background:var(--wb-chip-grey);color:var(--dsw-alias-label-secondary,#666)}",
      ".wb-up{color:#c0392b}.wb-down{color:#1b8a5a}",
      "body[data-ds-dark-theme] .wb-up{color:#ff7b72}",
      "body[data-ds-dark-theme] .wb-down{color:#4ed17e}",
      ".wb-empty{padding:26px;text-align:center;color:var(--dsw-alias-label-secondary,#888);font-size:12px}",
      ".wb-alert{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#e3e6e8);border-radius:8px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".wb-alert.warn{border-color:var(--wb-warn-border);background:var(--wb-warn-soft)}",
      ".wb-alert.danger{border-color:var(--wb-danger-border);background:var(--wb-danger-soft)}",
      ".wb-alert .t{font-size:12px;font-weight:600;flex:1}",
      ".wb-alert .b{font-size:11px;color:var(--dsw-alias-label-secondary,#666);margin-top:2px;line-height:1.5}",
      ".wb-alert .ts{font-size:10px;color:var(--dsw-alias-label-secondary,#999);white-space:nowrap}",
      ".wb-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px}",
      "body[data-ds-dark-theme] .wb-modal-mask{background:rgba(0,0,0,.6)}",
      ".wb-modal{width:min(620px,100%);max-height:88vh;overflow:auto;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#222);border-radius:12px;padding:20px;box-shadow:0 12px 40px rgba(0,0,0,.18)}",
      ".wb-modal h3{margin:0 0 16px;font-size:15px}",
      ".wb-form{display:grid;grid-template-columns:1fr 1fr;gap:12px}",
      ".wb-form .full{grid-column:1/-1}",
      ".wb-form-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}",
      ".wb-bar{height:6px;border-radius:3px;background:var(--wb-chip-grey);overflow:hidden;min-width:70px}",
      ".wb-bar i{display:block;height:100%;background:var(--dsw-alias-brand-primary,#4c6fff);border-radius:3px;transition:width .22s ease}",
      "@keyframes wb-pulse{0%,100%{opacity:.45}50%{opacity:1}}",
      ".wb-bar.pulse i{width:30% !important;animation:wb-pulse 1s ease-in-out infinite}",
      ".wb-bar>i{display:block;height:100%;background:var(--wb-accent)}",
      ".wb-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#888);line-height:1.6}",
      ".wb-link{color:var(--wb-accent);text-decoration:none}.wb-link:hover{text-decoration:underline}",
      ".wb-split{display:grid;grid-template-columns:1fr 1fr;gap:16px}",
      "@media(max-width:820px){.wb-split,.wb-form{grid-template-columns:1fr}}",
      // ---- 报告比对 ----
      ".rc-split{display:grid;grid-template-columns:300px minmax(0,1fr);gap:16px;align-items:start}",
      "@media(max-width:980px){.rc-split{grid-template-columns:1fr}}",
      ".rc-side{display:grid;gap:8px;position:sticky;top:8px}",
      ".rc-base{padding:9px 10px;border:1px solid var(--dsw-alias-border-l1,#e3e6e8);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);cursor:pointer;transition:border-color .15s ease,background .15s ease}",
      ".rc-base:hover{border-color:var(--wb-accent)}",
      ".rc-base.on{border-color:var(--wb-accent);background:var(--wb-accent-soft)}",
      ".rc-base-h{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:4px}",
      ".rc-base-t{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#1a1a1a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".rc-base-m{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}",
      ".rc-base-f{font-size:10.5px;color:var(--dsw-alias-label-secondary,#8a8f94);margin-top:4px;display:flex;justify-content:space-between;gap:6px}",
      ".rc-steps{display:flex;align-items:center;gap:0;margin:2px 0 14px;flex-wrap:wrap}",
      ".rc-step{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#8a8f94);padding:5px 12px 5px 8px;border-radius:16px;white-space:nowrap}",
      ".rc-step.on{background:var(--wb-accent-soft);color:var(--wb-accent);font-weight:600}",
      ".rc-step.done{color:var(--wb-ok-ink,#1b8a5a)}",
      ".rc-step-n{display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;border-radius:50%;font-size:10px;background:var(--wb-chip-grey);color:var(--dsw-alias-label-secondary,#8a8f94);flex:0 0 auto}",
      ".rc-step.on .rc-step-n{background:var(--wb-accent);color:#fff}",
      ".rc-step.done .rc-step-n{background:var(--wb-ok-ink,#1b8a5a);color:#fff}",
      ".rc-step-sep{width:14px;height:1px;background:var(--dsw-alias-border-l1,#dfe3e5);flex:0 0 auto}",
      ".rc-del{color:var(--wb-danger-ink,#b63225);text-decoration:line-through;text-decoration-thickness:1px;opacity:.85}",
      "body[data-ds-dark-theme] .rc-del{color:#ff9a8f}",
      ".rc-add{color:var(--wb-ok-ink,#1b8a5a)}",
      "body[data-ds-dark-theme] .rc-add{color:#5ee08c}",
      ".rc-cell{max-width:360px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55;font-size:11.5px}",
      ".rc-dim{opacity:.5}",
      ".rc-pos{font-family:Consolas,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary,#6b7076);white-space:nowrap}",
      ".rc-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;margin-top:12px;border:1px solid var(--dsw-alias-border-l1,#e3e6e8);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".rc-foot-sp{flex:1}",
      ".rc-result{font-size:11px;line-height:1.7;padding:5px 8px;border-radius:5px;margin-top:4px;display:flex;gap:8px;align-items:baseline}",
      ".rc-result.ok{background:var(--wb-ok-soft,#edf8f2);color:var(--wb-ok-ink,#1b8a5a)}",
      ".rc-result.skip{background:var(--wb-warn-soft,#fff2e0);color:var(--wb-warn-ink,#a35b00)}",
      ".rc-result.fail{background:var(--wb-danger-soft,#fdecea);color:var(--wb-danger-ink,#b63225)}",
      ".rc-result .id{font-family:Consolas,Menlo,monospace;font-size:10.5px;white-space:nowrap}",
  ].join('\n');

    // ---------- 报备表单样式（本地项目 / 新建项目） ----------
    const pfCss = [
      ".pf{border:1px solid var(--dsw-alias-border-l1,#e3e6e8);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);overflow:hidden}",
      ".pf-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#e3e6e8);background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".pf-title{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary,#1a1a1a)}",
      ".pf-actions{display:flex;gap:8px;align-items:center}",
      // 保存状态徽标：点「保存」不再跳回列表，所以要把「存没存上」写在标题条上
      ".pf-save-state{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;border-radius:13px;border:1px solid transparent;font-size:12px;line-height:1;white-space:nowrap;font-weight:400}",
      ".pf-save-state.ok{color:#1a7f37;background:#eaf7ee;border-color:#c6e6d2}",
      ".pf-save-state.ok::before{content:'✓';font-size:11px}",
      ".pf-save-state.dirty{color:#9a6700;background:#fdf7e6;border-color:#efe0b3}",
      ".pf-save-state.dirty::before{content:'●';font-size:8px}",
      ".pf-save-state.idle{color:#6b7280;background:#f3f4f6;border-color:#e5e7eb}",
      ".pf-save-state.idle::before{content:'○';font-size:9px}",
      ".pf-btn{border:1px solid #b9c9df;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);border-radius:3px;padding:5px 16px;font-size:13px;line-height:1.4;cursor:pointer;font-family:inherit;white-space:nowrap}",
      ".pf-btn:disabled{opacity:.55;cursor:not-allowed}",
      ".pf-btn:hover{background:rgba(47,127,240,.08);border-color:#2f7ff0;color:#2f7ff0}",
      ".pf-btn.pri{background:#2f7ff0;border-color:#2f7ff0;color:#fff}",
      ".pf-btn.pri:hover{background:#2a72d9;border-color:#2a72d9;color:#fff}",
      ".pf-btn.sm{padding:2px 9px;font-size:12px}",
      ".pf-btn.danger{color:#b63225;border-color:#e8c0ba}",
      ".pf-btn.danger:hover{background:rgba(182,50,37,.08);border-color:#b63225;color:#b63225}",
      ".pf-mini{border:1px solid #b9c9df;background:transparent;color:#2f7ff0;border-radius:3px;padding:0 8px;font-size:12px;cursor:pointer;white-space:nowrap;height:30px;font-family:inherit}",
      ".pf-mini:hover{background:rgba(47,127,240,.08)}",
      ".pf-tabs{display:flex;gap:0;padding:10px 14px 0;background:var(--dsw-alias-bg-layer-1,#fff);border-bottom:1px solid var(--dsw-alias-border-l1,#e3e6e8)}",
      ".pf-tab{border:1px solid #dcdfe6;border-bottom:0;background:#f5f7fa;color:#333;padding:6px 18px;font-size:13px;cursor:pointer;font-family:inherit;border-radius:3px 3px 0 0;margin-right:4px;margin-bottom:-1px}",
      ".pf-tab:hover{color:#2f7ff0}",
      ".pf-tab.on{background:#2f7ff0;border-color:#2f7ff0;color:#fff}",
      ".pf-body{padding:4px 14px 18px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".pf-sec{margin-top:14px}",
      ".pf-sec-t{display:flex;align-items:center;gap:7px;padding:6px 0 8px;border-bottom:1px solid var(--dsw-alias-border-l1,#e3e6e8);margin-bottom:8px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1a1a1a)}",
      ".pf-sec-t i{display:inline-block;width:3px;height:13px;background:#2f7ff0;border-radius:1px}",
      ".pf-table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:13px}",
      ".pf-table th.pf-l{width:178px;background:#f7f9fb;border:1px solid #e3e6e8;font-weight:400;color:#333;text-align:center;padding:7px 8px;line-height:1.4;word-break:break-all}",
      ".pf-table td.pf-v{border:1px solid #e3e6e8;padding:4px 6px;vertical-align:middle}",
      ".pf-req{color:#e5453c;margin-right:2px}",
      ".pf-in,.pf-sel,.pf-ta{width:100%;min-width:0;height:30px;border:1px solid #dcdfe6;border-radius:2px;padding:0 8px;font-size:13px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);outline:none;font-family:inherit;box-sizing:border-box}",
      ".pf-in:focus,.pf-sel:focus,.pf-ta:focus{border-color:#2f7ff0;box-shadow:0 0 0 2px rgba(47,127,240,.12)}",
      ".pf-ta{height:auto;min-height:54px;padding:5px 8px;resize:vertical;line-height:1.5}",
      ".pf-ro{background:#f7f9fb;color:#666}",
      ".pf-sec-x{margin-left:auto;display:flex;align-items:center;gap:8px}",
      ".pf-cmp{display:flex;align-items:center;gap:6px}",
      ".pf-cmp-in{position:relative;flex:1;min-width:0}",
      ".pf-cmp-tools{display:flex;align-items:center;gap:4px;flex:none}",
      ".pf-cmp-tools .pf-mini{height:24px;line-height:22px;padding:0 8px;font-size:12px;border-radius:4px;box-sizing:border-box}",
      ".pf-cmp-tools a.pf-mini{text-decoration:none;display:inline-flex;align-items:center;justify-content:center;border:1px solid #dcdfe6;background:#fff;color:var(--dsw-alias-label-primary,#1a1a1a)}",
      ".pf-cmp-tools a.pf-mini:hover{border-color:#2f7ff0;color:#2f7ff0}",
      "body[data-ds-dark-theme] .pf-cmp-tools a.pf-mini{background:#1f1f22;border-color:#3a3a3e;color:#e6e6e6}",
      ".pf-check{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#555;white-space:nowrap;cursor:pointer}",
      ".pf-check input{width:auto;height:auto;margin:0}",
      ".pf-cmp-list{position:absolute;z-index:30;left:0;right:0;top:calc(100% + 2px);background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid #dcdfe6;border-radius:4px;box-shadow:0 6px 18px rgba(0,0,0,.14);max-height:220px;overflow:auto}",
      ".pf-cmp-list button{display:block;width:100%;text-align:left;border:0;background:transparent;padding:6px 10px;font-size:12px;cursor:pointer;color:var(--dsw-alias-label-primary,#1a1a1a);font-family:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".pf-cmp-list button:hover{background:rgba(47,127,240,.1)}",
      ".pf-cmp-list b{font-weight:500}",
      ".pf-cmp-list span{color:#8a8a8a}",
      ".pf-cmp-busy{position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:12px;color:#2f7ff0;background:var(--dsw-alias-bg-layer-1,#fff);padding-left:6px}",
      ".pf-2{display:flex;gap:8px;align-items:center}",
      ".pf-2>.pf-in{flex:1;min-width:0}",
      ".pf-unit{color:#666;font-size:13px;white-space:nowrap}",
      ".pf-radio{display:flex;gap:18px;align-items:center;min-height:30px;font-size:13px;flex-wrap:wrap}",
      ".pf-radio label{display:inline-flex;align-items:center;gap:5px;cursor:pointer}",
      ".pf-tags{display:flex;flex-wrap:wrap;gap:6px;align-items:center;border:1px solid #dcdfe6;border-radius:2px;padding:3px 6px;min-height:30px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".pf-tag{display:inline-flex;align-items:center;gap:4px;background:#eaf2fe;color:#1d5fbf;border-radius:2px;padding:1px 6px;font-size:12px}",
      ".pf-tag button{border:0;background:transparent;color:#6a8fc4;cursor:pointer;padding:0;font-size:13px;line-height:1;font-family:inherit}",
      ".pf-tag-in{border:0;outline:0;background:transparent;flex:1;min-width:110px;font-size:13px;height:24px;color:inherit;font-family:inherit}",
      ".pf-presets{display:inline-flex;gap:4px}",
      ".pf-presets button{border:1px dashed #b9c9df;background:transparent;color:#2f7ff0;border-radius:2px;font-size:11px;padding:1px 6px;cursor:pointer;font-family:inherit}",
      ".pf-hint{color:var(--dsw-alias-label-secondary,#888);font-size:12px}",
      ".pf-foot-hint{margin:14px 0 2px;padding:8px 10px;border:1px dashed var(--dsw-alias-border-l1,#d8dcde);border-radius:4px;font-size:12px;color:var(--dsw-alias-label-secondary,#666)}",
      ".pf-foot-hint code{margin-left:4px;padding:1px 6px;border-radius:3px;background:rgba(47,127,240,.1);color:#2f7ff0;font-family:Consolas,monospace}",
      ".pf-folder{display:flex;gap:6px;align-items:center}",
      ".pf-folder .pf-in{flex:1;min-width:0;font-family:Consolas,monospace;font-size:12px}",
      ".pf-folder-acts{display:flex;flex-wrap:wrap;gap:6px;align-items:center}",
      ".pf-folder-chip{display:inline-flex;align-items:center;gap:4px;margin-right:6px;font-size:12px;padding:1px 8px;border-radius:10px;background:rgba(30,126,52,.12);color:#1e7e34;white-space:nowrap}",
      "body[data-ds-dark-theme] .pf-folder-chip{background:rgba(76,175,110,.18);color:#8fd6a5}",
      ".pf-info{display:inline-block;margin-left:4px;color:#2f7ff0;font-size:12px;cursor:help;font-weight:400}",
      ".pf-list{padding:14px 16px}",
      ".pf-list-h{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}",
      ".pf-list-t h2{margin:0 0 4px;font-size:15px;font-weight:600}",
      ".pf-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;align-items:center}",
      ".pf-table-wrap{overflow:auto;border:1px solid var(--dsw-alias-border-l1,#e3e6e8);border-radius:4px}",
      ".pf-table-wrap td:empty::after{content:'—';color:#c8ccd2;font-size:12px}",
      "body[data-ds-dark-theme] .pf-table-wrap td:empty::after{color:#55585e}",
      ".pf-grid{width:100%;border-collapse:collapse;font-size:13px}",
      ".pf-grid th{background:#f7f9fb;text-align:left;font-weight:600;color:#333;padding:9px 12px;border-bottom:1px solid #e3e6e8;white-space:nowrap}",
      ".pf-grid td{padding:9px 12px;border-bottom:1px solid #eef0f1;vertical-align:middle}",
      ".pf-grid tr:hover td{background:rgba(47,127,240,.03)}",
      ".pf-name{font-weight:600;color:#2f7ff0;cursor:pointer;word-break:break-all}",
      ".pf-name:hover{text-decoration:underline}",
      ".pf-name.muted{color:var(--dsw-alias-label-secondary,#888);cursor:pointer}",
      ".pf-name.muted:hover{text-decoration:none;color:#b45309}",
      ".pf-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary,#888);margin-top:2px}",
      ".pf-mono{font-family:Consolas,monospace;font-size:12px}",
      ".pf-empty{padding:34px;text-align:center;color:var(--dsw-alias-label-secondary,#888);font-size:13px}",
      "body[data-ds-dark-theme] .pf-table th.pf-l{background:#26262a;border-color:#3a3a3e;color:#ddd}",
      "body[data-ds-dark-theme] .pf-table td.pf-v{border-color:#3a3a3e}",
      "body[data-ds-dark-theme] .pf-in,body[data-ds-dark-theme] .pf-sel,body[data-ds-dark-theme] .pf-ta,body[data-ds-dark-theme] .pf-tags{background:#1f1f22;border-color:#3a3a3e;color:#eee}",
      "body[data-ds-dark-theme] .pf-ro{background:#26262a;color:#999}",
      "body[data-ds-dark-theme] .pf-cmp-list{background:#1f1f22;border-color:#3a3a3e}",
      "body[data-ds-dark-theme] .pf-check{color:#bbb}",
      "body[data-ds-dark-theme] .pf-cmp-list span{color:#9a9a9a}",
      "body[data-ds-dark-theme] .pf-cmp-busy{background:#1f1f22}",
      "body[data-ds-dark-theme] .pf-tab{background:#26262a;border-color:#3a3a3e;color:#ddd}",
      "body[data-ds-dark-theme] .pf-tab.on{background:#2f7ff0;border-color:#2f7ff0;color:#fff}",
      "body[data-ds-dark-theme] .pf-btn{background:#26262a;border-color:#4a5568;color:#ddd}",
      "body[data-ds-dark-theme] .pf-grid th{background:#26262a;color:#ddd;border-color:#3a3a3e}",
      "body[data-ds-dark-theme] .pf-grid td{border-color:#2f2f33}",
      "body[data-ds-dark-theme] .pf-sec-t{border-color:#3a3a3e}",
      "body[data-ds-dark-theme] .pf-head,body[data-ds-dark-theme] .pf-tabs{border-color:#3a3a3e;background:#1c1c1f}",
      "body[data-ds-dark-theme] .pf-body{background:#1c1c1f}",
      "body[data-ds-dark-theme] .pf-title,body[data-ds-dark-theme] .pf-sec-t,body[data-ds-dark-theme] .pf-list-t h2{color:#f2f2f2}",
      "body[data-ds-dark-theme] .pf-save-state.ok{background:#1b3427;border-color:#3f6b52;color:#5ee08c}",
      "body[data-ds-dark-theme] .pf-save-state.dirty{background:#3a2e1c;border-color:#5c4620;color:#ffb020}",
      "body[data-ds-dark-theme] .pf-save-state.idle{background:#26262a;border-color:#3a3a3e;color:#a0a0a8}",
      "body[data-ds-dark-theme] .pf-hint{color:#9aa0a6}",
      "body[data-ds-dark-theme] .pf-info{color:#6ea8ff}",
      "body[data-ds-dark-theme] .pf-name{color:#6ea8ff}",
      "@media(max-width:900px){.pf-table{table-layout:auto}.pf-table th.pf-l{width:120px}}",
    ].join('\n');

    function StyleTag() { return h('style', { 'data-wb': '1' }, css + String.fromCharCode(10) + pfCss + String.fromCharCode(10) + pwCss); }
    function Card(props) { return h('div', { className: 'wb-card' }, props.title && h('h3', null, props.title), props.children); }
    function Section(props) {
      return h('div', { className: 'wb-sec' }, h('div', { className: 'wb-sec-h' }, h('h2', null, props.title), props.actions || null), props.children);
    }
    function Field(props) {
      return h('label', { className: props.full ? 'full' : '' }, h('span', { className: 'wb-label' }, props.label), props.children);
    }
    function Inp(props) { return h('input', { className: 'wb-input', ...props }); }
    function Sel(props) { return h('select', { className: 'wb-select', ...props }, props.children); }
    function Btn(props) {
      const { variant, className, ...rest } = props;
      return h('button', { className: 'wb-btn ' + (variant ? variant : '') + ' ' + (className || ''), type: 'button', ...rest });
    }
    function Table(props) {
      return h('table', { className: 'wb-table' }, h('thead', null, h('tr', null, props.cols.map((c, i) => h('th', { key: i }, c)))),
        h('tbody', null, props.rows.length ? props.rows : h('tr', null, h('td', { colSpan: props.cols.length, className: 'wb-empty' }, '暂无数据'))));
    }
    function Modal(props) {
      useEffect(() => {
        const fn = e => { if (e.key === 'Escape') props.onClose(); };
        document.addEventListener('keydown', fn);
        return () => document.removeEventListener('keydown', fn);
      }, []);
      return h('div', { className: 'wb-modal-mask', onMouseDown: e => { if (e.target === e.currentTarget) props.onClose(); } },
        h('div', { className: 'wb-modal', style: props.style, role: 'dialog', 'aria-modal': 'true', 'aria-label': props.title }, h('h3', null, props.title), props.children));
    }
    function Empty(t) { return h('div', { className: 'wb-empty' }, t || '暂无数据'); }
    function Bar(v, max) {
      const p = max > 0 ? Math.min(100, Math.round((v / max) * 100)) : 0;
      return h('div', { className: 'wb-bar' }, h('i', { style: { width: p + '%' } }));
    }

    // ---------- overview ----------
    function Overview({ s, go }) {
      const w = s.work, st = s.study, sk = s.stock;
      const totalHours = w.logs.reduce((a, l) => a + (Number(l.hours) || 0), 0);
      const month = todayStr().slice(0, 7);
      const monthHours = w.logs.filter(l => String(l.date || '').startsWith(month)).reduce((a, l) => a + (Number(l.hours) || 0), 0);
      const activeProjects = w.projects.filter(p => p.stage !== '归档/收款').length;
      const upcoming = st.exams.filter(e => e.active && e.examDate && dateDiff(e.examDate, todayStr()) >= 0).sort((a, b) => a.examDate.localeCompare(b.examDate))[0];
      const planToday = st.plans.filter(p => p.date === todayStr());
      const unread = s.alerts.filter(a => !a.read).length;
      const hit = sk.watch.filter(x => { const q = sk.quotes[x.code]; return q && ((x.buyBelow && q.price <= Number(x.buyBelow)) || (x.sellAbove && q.price >= Number(x.sellAbove))); });
      return h('div', null,
        h('div', { className: 'wb-grid' },
          h(Card, null, h('div', { className: 'wb-kpi' }, activeProjects), h('div', { className: 'wb-kpi-sub' }, '进行中项目 · 共 ' + w.projects.length + ' 个')),
          h(Card, null, h('div', { className: 'wb-kpi' }, monthHours.toFixed(1) + ' h'), h('div', { className: 'wb-kpi-sub' }, '本月工时 · 累计 ' + totalHours.toFixed(1) + ' h')),
          h(Card, null, h('div', { className: 'wb-kpi', style: { color: upcoming && dateDiff(upcoming.examDate, todayStr()) <= 30 ? 'var(--dsw-alias-state-error-primary,#c0392b)' : undefined } }, upcoming ? dateDiff(upcoming.examDate, todayStr()) : '—'), h('div', { className: 'wb-kpi-sub' }, upcoming ? (examName(upcoming.id) + ' 距考试天数 · ' + upcoming.examDate) : '未设置考试日期')),
          h(Card, null, h('div', { className: 'wb-kpi', style: { color: hit.length ? 'var(--dsw-alias-state-error-primary,#c0392b)' : undefined } }, hit.length ? hit.length : '0'), h('div', { className: 'wb-kpi-sub' }, '买卖点已触发 · 自选 ' + sk.watch.length + ' 只')),
        ),
        h('div', { className: 'wb-split' },
          h(Section, { title: '今日待办', actions: h(Btn, { className: 'sm', onClick: () => go('study') }, '去学习') },
            planToday.length ? planToday.map(p => h('div', { key: p.id, className: 'wb-alert' },
              h('div', { style: { flex: 1 } }, h('div', { className: 't' }, p.title), h('div', { className: 'b' }, (EXAMS.find(e => e.id === p.examId) || {}).name + ' · ' + (p.minutes || 0) + ' 分钟'), p.done && h('span', { className: 'wb-tag' }, '已完成')))) : Empty('今天没有安排学习计划')),
          h(Section, { title: '最近提醒', actions: h(Btn, { className: 'sm', onClick: () => go('alerts') }, '提醒中心' + (unread ? ' (' + unread + ')' : '')) },
            s.alerts.length ? s.alerts.slice(0, 5).map(a => h('div', { key: a.id, className: 'wb-alert ' + (a.level || '') },
              h('div', { style: { flex: 1 } }, h('div', { className: 't' }, a.title), h('div', { className: 'b' }, a.body)))) : Empty('暂无提醒')),
        ),
        h(Section, { title: '快捷入口' }, h('div', { className: 'wb-row' },
          h(Btn, { variant: 'pri', onClick: () => go('work', 'projects') }, '本地项目'),
          h(Btn, { onClick: () => go('work', 'logs') }, '记工时'),
          h(Btn, { onClick: () => go('work', 'tylive') }, '天源项目'),
          h(Btn, { onClick: () => go('study') }, '学习规划'),
          h(Btn, { onClick: () => go('stock') }, '自选股行情'),
          h(Btn, { onClick: () => window.open(TY_BASE, '_blank', 'noopener') }, '天源项目列表'),
        )),
      );
    }

    // ---------- work: projects ----------
    // 项目管理改成「报备表单」样式：列表页 + 全屏表单页（基本信息 / 客户信息 / 被评估单位信息 / 合同信息）。
    // 表单结构照抄评估报备系统的版式：左侧浅灰标签格 + 右侧输入格，两列一行。
    const BIZ_TYPES = ['资产评估业务', '评估咨询业务', '集团内部复核', '外部复核', '矿业权评估业务'];
    const RISK_LEVELS = [['A', 'A · 高风险'], ['B', 'B · 中风险'], ['C', 'C · 低风险']];
    const VALUE_TYPE_GROUPS = [
      { group: '常用价值类型', items: ['市场价值', '投资价值', '清算价值', '残余价值', '在用价值'] },
      { group: '其他价值类型', items: ['公允价值', '预计未来现金流量的现值', '可收回金额', '公允价值减处置费用净额', '可变现净值'] },
    ];
    const PURPOSE_REPORTS = [
      'IPO上市', '公司制改建', '对外投资', '合并、分立、破产、清算、解散', '股东股权比例变动', '产权转让',
      '上市公司发行股份购买资产', '资产转让、置换、拍卖', '资产抵押/质押', '资产捐赠', '资产租赁',
      '资产补偿/损失补偿', '资产偿债', '资产涉讼', '资产收购', '接受抵债资产', '债转股', '债务重组及其他',
      '追溯评估', '复核报告', '了解价值', '财务会计报告目的', '计税价格评估', '认定报关价格', '其他',
    ];
    const PURPOSES = [
      '发行股份购买资产(含股权)', '发行股份与现金购买资产(含股权)', '现金购买资产(含股权)', '变更设立股份有限公司',
      '借壳上市', '股权/资产转让', '商誉减值测试', '长期股权投资减值测试',
      '除商誉/长投减值测试以外的以财务报告为目的的评估', '企业合并', '企业分立', '了解价值', '出资',
      '企业破产清算', '债务重组', '抵押担保', '增值扩股、其他', '其他',
    ];
    const BIZ_NATURES = ['国有资产评估业务', '境外资产评估业务', '证券期货评估业务', '司法评估业务', '金融资产评估业务', '含珠宝首饰的评估业务', '其他评估业务'];
    const MAJOR_RESTRUCT = ['是', '否', '不适用'];
    const OBJECT_REPORT_GROUPS = [
      { group: '企业价值', items: ['企业全部资产及负债', '股东全部权益价值', '股东部分权益价值'] },
      { group: '单项资产', items: ['房建类', '设备类', '存货类', '债权类', '其他单项资产'] },
      { group: '资产组合', items: ['实物资产组合', '实物资产与无形资产组合', '实物资产与权利义务组合', '无形资产与权利义务组合', '其他资产组合'] },
      { group: '无形资产', items: ['专利权', '专有技术', '著作权', '特许经营权', '商标权', '商誉', '土地使用权', '水域使用权', '海域使用权', '岸线使用权', '采矿权', '探矿权', '许可使用权', '无形资产组合', '其他无形资产'] },
      { group: '森林资源资产', items: ['林木所有权', '林木使用权', '林地使用权', '林木所有视便用权与林地使用权组合', '森林生态价值', '生态补偿价值'] },
      { group: '珠宝首饰艺术品', items: ['珠宝首饰艺术品'] },
      { group: '其他资产评估', items: ['碳排放权', '计税价格', '经营损失', '环境损失', '其他'] },
    ];
    const IN_OUT_OPTIONS = ['置入', '置出', '不适用'];
    const LEGACY_IN_OUT = ['不适宜'];   // 老数据里的「不适宜」统一改成「不适用」
    const DEPARTMENTS = ['一部', '二部', '三部'];
    // 团队预设（开源占位名，可在设置里自填真实团队成员）
    const PARTNERS = ['合伙人A'];
    const MANAGERS = ['经理A'];
    const MEMBER_PRESETS = ['成员A'];
    // 成员默认值：新建项目时带出来，仍可在表单里改成其他人
    const DEFAULT_DEPT = '三部';
    const DEFAULT_PARTNER = '合伙人A';
    const DEFAULT_MANAGERS = ['成员A', '经理A'];
    const DEFAULT_MANAGER = DEFAULT_MANAGERS[0];
    const DEFAULT_MEMBERS = ['成员A'];
    const DEFAULT_SIGNER1 = '经理A';
    const DEFAULT_SIGNER2 = '合伙人A';
    const CONTRACT_TYPES = ['框架协议', '非框架协议'];
    // 合同币种：按 IMF/央行统计口径的常见币种铺开（ECB 参考汇率覆盖的 30 种 + IMF 名单里其余常用的）。
    // 括号里是 ECB 三字母码；没有码的那些 ECB 不发布参考汇率 → 只能手填汇率，界面上会提示。
    const CURRENCIES = [
      '人民币',
      '美元', '欧元', '英镑', '日元', '港币',
      '澳元', '加拿大元', '瑞士法郎', '新西兰元', '新加坡元',
      '韩元', '印度卢比', '印尼盾', '马来西亚林吉特', '菲律宾比索', '泰铢',
      '越南盾', '巴基斯坦卢比', '孟加拉塔卡', '斯里兰卡卢比', '尼泊尔卢比', '蒙古图格里克',
      '俄罗斯卢布', '哈萨克斯坦坚戈', '土耳其里拉', '以色列谢克尔',
      '沙特里亚尔', '阿联酋迪拉姆', '卡塔尔里亚尔', '科威特第纳尔', '巴林第纳尔', '阿曼里亚尔',
      '南非兰特', '埃及镑', '尼日利亚奈拉', '肯尼亚先令', '摩洛哥迪拉姆',
      '巴西雷亚尔', '墨西哥比索', '阿根廷比索', '智利比索', '哥伦比亚比索', '秘鲁索尔',
      '捷克克朗', '波兰兹罗提', '匈牙利福林', '罗马尼亚列伊', '保加利亚列弗',
      '瑞典克朗', '挪威克朗', '丹麦克朗', '冰岛克朗', '塞尔维亚第纳尔', '乌克兰格里夫纳',
    ];
    // 币种 → ECB 三字母码。表里有码的能按基准日自动取官方汇率；没有的只能手填。
    const CURRENCY_CODES = {
      人民币: 'CNY', 美元: 'USD', 欧元: 'EUR', 英镑: 'GBP', 日元: 'JPY', 港币: 'HKD',
      澳元: 'AUD', 加拿大元: 'CAD', 瑞士法郎: 'CHF', 新西兰元: 'NZD', 新加坡元: 'SGD',
      韩元: 'KRW', 印度卢比: 'INR', 印尼盾: 'IDR', 马来西亚林吉特: 'MYR', 菲律宾比索: 'PHP', 泰铢: 'THB',
      以色列谢克尔: 'ILS',
      南非兰特: 'ZAR',
      巴西雷亚尔: 'BRL', 墨西哥比索: 'MXN',
      捷克克朗: 'CZK', 波兰兹罗提: 'PLN', 匈牙利福林: 'HUF', 罗马尼亚列伊: 'RON',
      瑞典克朗: 'SEK', 挪威克朗: 'NOK', 丹麦克朗: 'DKK', 冰岛克朗: 'ISK',
      土耳其里拉: 'TRY',
    };
    // 汇率：合同金额 = 合同原币金额 × 汇率（人民币 = 1）。
    // 估出来的是「折算参考值」，实际结算按合同约定的锁定汇率，所以表单里可手改，
    // 合同金额始终 = 原币金额 × 该汇率，自动重算，不做手填。
    // 汇率兜底值：网络取不到官方汇率时才用（约 2026 年中的水平，只为让金额算得出来，不追求精确）。
    // 能联网时一律以基准日的 ECB 参考汇率为准，这张表只做 rear guard。
    const FX_RATES = {
      人民币: 1, 美元: 6.67, 欧元: 7.35, 英镑: 8.8, 日元: 0.042, 港币: 0.85,
      澳元: 4.5, 加拿大元: 4.9, 瑞士法郎: 7.6, 新西兰元: 4.1, 新加坡元: 5.1,
      韩元: 0.0049, 印度卢比: 0.079, 印尼盾: 0.00042, 马来西亚林吉特: 1.5, 菲律宾比索: 0.115, 泰铢: 0.195,
      以色列谢克尔: 1.8, 南非兰特: 0.36, 巴西雷亚尔: 1.2, 墨西哥比索: 0.36,
      捷克克朗: 0.3, 波兰兹罗提: 1.7, 匈牙利福林: 0.018, 罗马尼亚列伊: 1.48,
      瑞典克朗: 0.63, 挪威克朗: 0.62, 丹麦克朗: 0.985, 冰岛克朗: 0.048, 土耳其里拉: 0.19,
    };
    const PAY_METHODS = ['一次性支付', '分期支付', '按进度支付'];
    const SUBMIT_WAYS = ['特快专递', '电子邮件', '现场领取', '邮寄'];
    const ENTITY_TYPES = ['有限责任公司', '股份有限公司', '国有企业', '外商投资企业', '合伙企业', '个人独资企业', '其他'];
    const CUSTOMER_RELATIONS = ['委托方即为被评估单位', '委托方为被评估单位股东', '委托方为被评估单位母公司', '委托方为被评估单位债权人', '其他'];
    const SECRET_OPTIONS = ['是', '否'];

    function projectYear(p) {
      const y = String((p && p.year) || '').trim();
      if (/^\d{4}$/.test(y)) return y;
      const fromDate = String((p && p.baseDate) || '').slice(0, 4);
      if (/^\d{4}$/.test(fromDate)) return fromDate;
      return String(new Date().getFullYear());
    }

    // ---- 项目编号 / 文件夹名 ----
    // 编号规则：年月日 + 三位流水，例如 20261115001。
    // 流水在「同一年」里递增，所以既带上了年月日，又不会和同年份的其他项目撞号。
    // 编号在表单里是可输入框，保存时再校验一次唯一性（见 ProjectForm.save）。
    const CODE_RE = /^(\d{8})(\d{3,})$/;
    function codeDatePrefix(d) {
      const t = d || new Date();
      return String(t.getFullYear())
        + String(t.getMonth() + 1).padStart(2, '0')
        + String(t.getDate()).padStart(2, '0');
    }
    function nextProjectCode(projects, d) {
      // 只跟「同一天」的编号比：没有就是 001，有了才 002、003…
      const prefix = codeDatePrefix(d);
      let max = 0;
      (projects || []).forEach(p => {
        const code = String((p && p.code) || '').trim();
        const m = CODE_RE.exec(code);
        if (!m || m[1] !== prefix) return;
        max = Math.max(max, Number(m[2]) || 0);
      });
      return prefix + String(max + 1).padStart(3, '0');
    }
    // 文件夹名里的非法字符（Windows）：<>:"/\|?* 与控制字符
    function cleanSegment(s) {
      return String(s == null ? '' : s)
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/^[.\s]+|[.\s]+$/g, '')
        .slice(0, 120);
    }
    // 项目文件夹：<项目编号> <项目简称>，与宿主 index.js 的建目录规则一致
    function folderNameOf(p) {
      const code = cleanSegment(p && p.code);
      const shortName = cleanSegment(p && (p.shortName || p.name));
      return [code, shortName].filter(Boolean).join(' ') || '未命名项目';
    }
    // 老版本建的是「年份 项目名」文件夹：打开时若新名字的目录不存在、老目录在，就用老的，
    // 避免升级后原来项目的文件夹突然「找不到」。
    function legacyFolderName(p) { return projectYear(p) + ' ' + cleanSegment(p && (p.name || p.shortName)); }

    // 绑定的本地文件夹绝对路径（没绑定就是空串）。
    // 有它的时候，所有「打开/写入/归档」都直接落到这个目录，不再按名字去项目根目录里找。
    function projectAbs(p) { return String((p && p.folderPath) || '').trim(); }
    // 界面上的文件夹标识：绑定了就显示绝对路径，没绑定显示自动生成的名字
    function projectFolderLabel(p) { return projectAbs(p) || folderNameOf(p); }

    // 目录选择器返回值统一成字符串路径：宿主不同版本可能给字符串，也可能给 {path}/{dir}。
    function dirOfPicked(v) {
      if (!v) return '';
      if (typeof v === 'string') return v.trim();
      const p2 = v.path || v.dir || v.directory || v.absolutePath || '';
      return String(p2 || '').trim();
    }
    async function pickDirectoryPath() {
      if (!workspacePicker) throw new Error('这个环境没有目录选择器，请手动粘贴绝对路径');
      const picked = await workspacePicker.pickDirectory();
      return dirOfPicked(picked);
    }

    // 选一个已存在的本地文件夹并绑定：先弹系统选目录，再探测一下里面有什么（避免绑错）。
    // 返回 { path, dirs, files } 或 null（用户取消）。失败抛错让调用方 toast。
    async function pickFolderToBind() {
      const picked = await pickDirectoryPath();
      if (!picked) return null;
      const r = await fetch(PREFIX + '/project/folder/probe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: picked }),
      });
      const d = await r.json().catch(() => ({}));
      if (!d.ok) throw new Error(d.error || '这个路径不可用：' + picked);
      return { path: d.path, dirs: d.dirs, files: d.files, name: d.name };
    }

    // 报告文号：资产评估业务「天源评报字〔年〕第4位」，评估咨询业务「天源咨报字〔年〕第5位」
    function nextReportNo(projects, kind) {
      const consult = kind === '咨询';
      const mark = consult ? '咨' : '评';
      const pad = consult ? 5 : 4;
      const y = String(new Date().getFullYear());
      const re = new RegExp('^天源' + mark + '报字〔(\\d{4})〕第(\\d+)号$');
      let max = 0;
      (projects || []).forEach(p => {
        const m = re.exec(String((p && p.reportNo) || ''));
        if (m && m[1] === y) max = Math.max(max, Number(m[2]) || 0);
      });
      return '天源' + mark + '报字〔' + y + '〕第' + String(max + 1).padStart(pad, '0') + '号';
    }

    // 其他报告使用人的默认值（合同里通常就写这一句）
    const DEFAULT_REPORT_USERS = '法律、行政法规规定的使用人';

    // 一个委托人的空壳（多委托人时每个元素都是这个结构）
    function emptyCustomer() {
      return { type: '法人组织', name: '', shortName: '', idCard: '', sameAsEntity: '', creditCode: '', entType: '', address: '', capital: '', legalRep: '', business: '', relation: '' };
    }

    function newProject(projects) {
      return {
        id: uid(),
        code: nextProjectCode(projects),
        ebsProject: '',
        acceptNo: '',
        name: '',
        shortName: '',
        risk: '',
        bizType: '资产评估业务',
        year: String(new Date().getFullYear()),
        baseDate: '',
        deadline: '',
        stage: '承接/立项',
        budgetHours: 0,
        economicBehavior: '',
        objectReport: '',
        scopeReport: '',
        valueType: '',
        purposeReport: '',
        purpose: '',
        bizNature: '',
        majorRestructure: '不适用',
        objectReport2: '',
        inOut: '不适用',
        equityRatio: '100',
        reportDate: '',
        reportNo: '',
        client: '',
        team: {
          dept: DEFAULT_DEPT, partner: DEFAULT_PARTNER,
          // managers 是「项目经理」标签框的真实数据；manager 只保留第一个，给列表/天源同步这些
          // 还在读字符串的地方用（老数据里只有 manager 字符串）。
          managers: [...DEFAULT_MANAGERS], manager: DEFAULT_MANAGER,
          members: [...DEFAULT_MEMBERS], signer1: DEFAULT_SIGNER1, signer2: DEFAULT_SIGNER2,
        },
        customer: emptyCustomer(),
        customers: [emptyCustomer()],
        purposeOther: '',
        entity: { name: '', shortName: '', legalRep: '', creditCode: '', entType: '', capital: '', address: '', business: '', intro: '' },
        contract: { type: '', signDate: '', serviceStart: '', serviceEnd: '', currency: '人民币', fxRate: '1', fxDate: '', fxRateTouched: false, amountOriginal: '', amount: '', payMethod: '', reportSubmitAt: '', reportSubmitWay: '特快专递', reportCopies: '4', statementCopies: '4', otherUsers: DEFAULT_REPORT_USERS, purposeDetail: '', attachment: '', attachmentPath: '', markdownPath: '', secret: '' },
        tyId: '',
        tyUrl: TY_BASE,
        // 绑定的本地文件夹（绝对路径）。空 = 没绑定，按「项目根 + 编号 简称」自动找/建；
        // 非空 = 强关联到用户指定的那个目录（可以放在项目根之外，比如 OneDrive 的客户目录）。
        folderPath: '',
        folderBoundAt: '',
        note: '',
      };
    }

    // 姓名列表：既接数组，也接「张三、李四」「张三,李四」这种老写法
    function nameList(v) {
      if (Array.isArray(v)) return v.map(x => String(x == null ? '' : x).trim()).filter(Boolean);
      return String(v == null ? '' : v).split(/[、,，;；\s]+/).map(x => x.trim()).filter(Boolean);
    }

    // 项目经理在列表/搜索/天源同步里当一个字符串用：多人时用「、」连起来
    function managerText(team) {
      const list = nameList(team && team.managers);
      if (list.length) return list.join('、');
      return String((team && team.manager) || '').trim();
    }

    // 成员默认值补位：空串/未填 → 默认值；已经有人的（比如换过项目经理）原样不动。
    // 老项目里 team 可能是天源导入时写进来的空串，不补的话打开表单这几格是空的。
    function fillTeamDefaults(team) {
      const t = { ...(team || {}) };
      if (!String(t.dept == null ? '' : t.dept).trim()) t.dept = DEFAULT_DEPT;
      if (!String(t.partner == null ? '' : t.partner).trim()) t.partner = DEFAULT_PARTNER;
      if (!String(t.manager == null ? '' : t.manager).trim()) t.manager = DEFAULT_MANAGER;
      if (!String(t.signer1 == null ? '' : t.signer1).trim()) t.signer1 = DEFAULT_SIGNER1;
      if (!String(t.signer2 == null ? '' : t.signer2).trim()) t.signer2 = DEFAULT_SIGNER2;
      return t;
    }

    // 项目经理/参与人员都是标签列表：老数据只有 manager 字符串，这里补出 managers 数组
    function normalizeTeam(team) {
      const t = fillTeamDefaults({ ...(team || {}) });
      const list = nameList(Array.isArray(t.managers) && t.managers.length ? t.managers : t.manager);
      t.managers = list.length ? list : [...DEFAULT_MANAGERS];
      t.manager = t.managers[0];      // 兼容只读 manager 的老代码路径
      t.members = nameList(t.members);
      if (!t.members.length) t.members = [...DEFAULT_MEMBERS];   // 参与人员没填时默认成员预设
      return t;
    }

    function normalizeProject(p) {
      const base = newProject([]);
      const src = p || {};
      // 归档日没填时按评估报告日 + 90 天给出来（报告日也没有就留空）
      const deadline = String(src.deadline == null ? '' : src.deadline).trim() || datePlus(src.reportDate, 90);
      // 委托人：老数据只有单个 customer，这里统一成 customers 数组（customer 留作第一个的别名）。
      // 「空壳不算数」的逻辑在 projectCustomers()：天源导入的历史记录 customers 是空壳、
      // 真正的委托人只写在 customer 上，照数组优先会把已导入的委托人全部丢掉。
      const srcCustomers = projectCustomers(src);
      const customers = srcCustomers.map(c => {
        const one = { ...emptyCustomer(), ...(c || {}) };
        one.capital = formatCapital(one.capital);
        return one;
      });
      // 服务期间起止日 = 合同签订日 ~ 归档日（没填过就按这两个日期带出来）
      const contract = { ...base.contract, ...(src.contract || {}) };
      // 汇率：老数据没有 fxRate，按币种补默认值；空串也补
      if (String(contract.fxRate == null ? '' : contract.fxRate).trim() === '') {
        const r = FX_RATES[String(contract.currency || '人民币').trim()];
        contract.fxRate = String(r == null ? 1 : r);
      }
      // 其他报告使用人空着就按默认值补（老数据也一样）
      if (!String(contract.otherUsers || '').trim()) contract.otherUsers = DEFAULT_REPORT_USERS;
      if (!String(contract.reportSubmitWay || '').trim()) contract.reportSubmitWay = '特快专递';
      if (!String(contract.serviceStart || '').trim()) contract.serviceStart = contract.signDate || '';
      if (!String(contract.serviceEnd || '').trim()) contract.serviceEnd = deadline || '';
      return {
        ...base,
        ...src,
        id: src.id || base.id,
        code: src.code || base.code,
        // 项目名称即项目简称：老数据里可能只有 name、没有 shortName（或者反过来），两边对齐，
        // 列表/工时/文件夹都读 name，简称为空时不会显示成空白。
        shortName: src.shortName || src.name || '',
        name: src.name || src.shortName || '',
        year: projectYear(src),
        // 股权比例 / 置入置出 的默认值对老数据也补（空串才补，填过的原样保留）
        equityRatio: String(src.equityRatio == null ? '' : src.equityRatio).trim() || '100',
        inOut: (() => {
          const v = String(src.inOut == null ? '' : src.inOut).trim();
          return v && !LEGACY_IN_OUT.includes(v) ? v : '不适用';   // 空着或老值「不适宜」都归到「不适用」
        })(),
        deadline,
        // 是否属于重大资产重组：没填就按「不适用」
        majorRestructure: String(src.majorRestructure == null ? '' : src.majorRestructure).trim() || '不适用',
        // 成员这几项有默认值：老数据里是空串的也按默认补上（新项目本来就预填），
        // 已经有人的（比如换过项目经理）原样保留。
        team: normalizeTeam({ ...base.team, ...(src.team || {}) }),
        customers,
        customer: customers[0],       // 兼容只读 customer 的老代码路径
        entity: { ...base.entity, ...(src.entity || {}), capital: formatCapital((src.entity || {}).capital) },
        contract,
        purposeOther: src.purposeOther || '',
      };
    }

    // 表单「保存状态」用：把一条项目记录压成字符串来比较，updatedAt 每次保存都变所以剔掉。
    // 只用来判断「相对上次保存有没有改过」，不参与落库、不进存档。
    function recordSig(rec) {
      try {
        const { updatedAt, ...rest } = rec || {};
        return JSON.stringify(rest);
      } catch (e) { return ''; }
    }

    // 汇率：传币种名或数字都行，返回数字；认不出来返回 null
    function toRate(v) {
      const s = String(v == null ? '' : v).trim();
      if (!s) return null;
      const n = Number(s);
      if (isFinite(n) && n > 0) return n;
      return Object.prototype.hasOwnProperty.call(FX_RATES, s) ? FX_RATES[s] : null;
    }

    // 合同金额 = 原币金额 × 汇率（折人民币），**始终由公式推导**，不再保留「手填值」。
    //
    // 之前有个 amountTouched 保护：用户动过合同金额就不再自动覆盖。
    // 实践下来是错的——切换币种（人民币→港币）时合同金额还停在原币数字上（100,000 元），
    // 看着像"没乘汇率"，实际是被那个标记挡住了。既然金额本来就是算出来的，
    // 就让它纯粹是结果：改原币金额/币种/汇率都重算，用户不需要也不应该手改它。
    function computeContractAmount(next) {
      const k = (next && next.contract) || {};
      const raw = String(k.amountOriginal == null ? '' : k.amountOriginal).replace(/[,\s]/g, '');
      if (!raw) return next;
      const m = raw.match(/([0-9]+(?:\.[0-9]+)?)\s*(亿元|亿|万元|万|元)?/);
      if (!m) return next;
      let n = Number(m[1]);
      if (!isFinite(n)) return next;
      const unit = m[2] || '';
      if (unit === '亿' || unit === '亿元') n = n * 100000000;
      else if (unit === '万' || unit === '万元') n = n * 10000;
      const rate = toRate(k.fxRate != null && String(k.fxRate).trim() !== '' ? k.fxRate : k.currency);
      if (rate == null) return next;
      const yuan = Math.round(n * rate * 100) / 100;
      // 记下这次折算用的汇率/日期，方便回头核对是哪个基准日、哪个源
      // 金额只存数字（单位由「合同币种」决定）：以前这里拼了「元」，同步到天源时
      // 「合同金额」那一栏只收数字，于是回读永远对不上「100,000 元」vs「100,000.00」。
      return { ...next, contract: { ...next.contract, amount: formatCapital(yuan.toFixed(2)), amountFxRate: String(rate), amountFxDate: String(k.fxDate || '') } };
    }

    // 把合同里的金额换成「元 + 千分位」：28万元 → 280,000 元；280000 → 280,000 元
    function toYuanAmount(v) {
      const raw = String(v == null ? '' : v).replace(/[,\s]/g, '');
      if (!raw) return '';
      const m = raw.match(/([0-9]+(?:\.[0-9]+)?)\s*(亿元|亿|万元|万|元)?/);
      if (!m) return String(v).trim();
      const num = Number(m[1]);
      if (!isFinite(num)) return String(v).trim();
      const unit = m[2] || '';
      if (!unit && !/^[0-9.]+$/.test(raw)) return String(v).trim();   // 不含单位又不是纯数字：原样保留
      let yuan = num;
      if (unit === '亿' || unit === '亿元') yuan = num * 100000000;
      else if (unit === '万' || unit === '万元') yuan = num * 10000;
      const fixed = Number.isInteger(yuan) ? String(yuan) : String(Math.round(yuan * 100) / 100);
      return formatCapital(fixed) + ' 元';
    }

    // 评估业务性质：委托人或被评估单位是国企 → 国有资产；上市公司/证券 → 证券期货；其余用模型判断
    const SOE_RE = /国有|全民所有制|国资委|国有资产|国有资本|国营/;
    function deriveBizNature(state, guess) {
      const list = Array.isArray(state && state.customers) ? state.customers : [];
      const people = list.concat([(state && state.entity) || {}]);
      const soe = people.some(c => c && (String(c.stateOwned || '').trim() === '是'
        || SOE_RE.test(String((c.entType || '') + ' ' + (c.name || '')))));
      if (soe) return '国有资产评估业务';
      const listed = people.some(c => c && String(c.listed || '').trim() === '是');
      if (listed) return '证券期货评估业务';
      const g = String(guess || '').trim();
      if (['国有资产评估业务', '境外资产评估业务', '证券期货评估业务', '司法评估业务', '金融资产评估业务', '含珠宝首饰的评估业务', '其他评估业务'].includes(g)) return g;
      return String((state && state.bizNature) || '').trim();
    }

    // 按 'a.b.0.c' 路径取值（和组件里的 setIn 配对）
    function getIn(obj, path) {
      return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    }

    // 注册资本之类「数字 + 单位」的文本：数字部分按千分位分组，单位原样保留
    // 例：1400万元 → 1,400万元；55000 → 55,000；2000.5万元 → 2,000.5万元
    function formatCapital(v) {
      const s = String(v == null ? '' : v).trim();
      if (!s) return '';
      const m = /^([0-9][0-9,，]*)(\.[0-9]+)?(.*)$/.exec(s);
      if (!m) return s;
      const intPart = m[1].replace(/[,，]/g, '');
      if (!intPart) return s;
      const dec = m[2] ? m[2].slice(0, 7) : '';       // 小数最多留 6 位
      const tail = m[3] ? m[3].trim() : '';
      const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return grouped + dec + tail;
    }

    // 简称兜底规则：宿主不可用时前端也能按名称生成（和宿主 index.js 的 ruleShortName 一致）
    function guessShortName(name) {
      let s = String(name == null ? '' : name).trim().replace(/\s+/g, '');
      s = s.replace(/[（(][^）)]*[）)]/g, '');
      for (let i = 0; i < 2; i += 1) {
        const next = s.replace(/^[\u4e00-\u9fa5]{2,8}?(省|市|自治区|自治州|地区|盟)/, '');
        if (next && next !== s) s = next; else break;
      }
      const tails = ['股份有限公司', '有限责任公司', '集团有限公司', '集团股份有限公司', '有限公司', '分公司', '集团', '公司', '合伙企业', '个人独资企业', '事务所'];
      for (const t of tails) {
        if (s.length > t.length + 1 && s.endsWith(t)) { s = s.slice(0, -t.length); break; }
      }
      return s.replace(/[\s·・,，.。]+$/g, '').slice(0, 12);
    }

    // ---------- 企业库（公司信息的本地库） ----------
    // 作用：填公司名称时把简称 / 社会信用代码 / 企业类型 / 住所 / 注册资本 / 法定代表人 / 经营范围
    // 一次补全。数据来自两处：① 本地已存过的项目（保存项目时自动入库）；② 库里没有的，
    // 走宿主 /company/lookup → 企查查·企业工商 取一次，取到就落库，下次离线也能用。
    const COMPANY_FIELDS = ['shortName', 'creditCode', 'entType', 'address', 'capital', 'legalRep', 'business'];
    function companyKey(c) {
      const code = String((c && c.creditCode) || '').trim().toUpperCase();
      if (code) return 'code:' + code;
      return 'name:' + String((c && c.name) || '').trim().toLowerCase();
    }
    function normalizeCompany(c) {
      const src = c || {};
      const out = { name: String(src.name || '').trim(), source: src.source === 'qcc' ? 'qcc' : 'local' };
      COMPANY_FIELDS.forEach(k => { out[k] = String(src[k] == null ? '' : src[k]).trim(); });
      out.updatedAt = src.updatedAt || new Date().toISOString();
      return out;
    }
    function upsertCompanies(list, incoming) {
      const map = new Map();
      (list || []).forEach(c => { if (c && String(c.name || '').trim()) map.set(companyKey(c), normalizeCompany(c)); });
      (incoming || []).forEach(c => {
        if (!c || !String(c.name || '').trim()) return;
        const key = companyKey(c);
        const prev = map.get(key) || {};
        const next = normalizeCompany({ ...prev, ...c });
        // 空值不许把库里已有的信息冲掉
        COMPANY_FIELDS.forEach(k => { if (!next[k] && prev[k]) next[k] = prev[k]; });
        next.updatedAt = new Date().toISOString();
        map.set(key, next);
      });
      return [...map.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
    }
    // 从项目里抽公司：委托人（法人组织才收）+ 被评估单位
    function companiesFromProjects(projects) {
      const out = [];
      (projects || []).forEach(p => {
        const c = (p && p.customer) || {};
        if (String(c.name || '').trim() && c.type !== '自然人') {
          out.push({ name: c.name, shortName: c.shortName, creditCode: c.creditCode, entType: c.entType, address: c.address, capital: c.capital, legalRep: c.legalRep, business: c.business, source: 'local' });
        }
        const e = (p && p.entity) || {};
        if (String(e.name || '').trim()) {
          out.push({ name: e.name, shortName: e.shortName, creditCode: e.creditCode, entType: e.entType, address: e.address, capital: e.capital, legalRep: e.legalRep, business: e.business, source: 'local' });
        }
      });
      return out;
    }
    function findCompany(list, name) {
      const q = String(name == null ? '' : name).trim().toLowerCase();
      if (!q) return null;
      const hit = (list || []).find(c => String(c.name || '').trim().toLowerCase() === q);
      if (hit) return hit;
      return (list || []).find(c => String(c.creditCode || '').trim().toLowerCase() === q) || null;
    }
    function searchCompanies(list, q) {
      const key = String(q == null ? '' : q).trim().toLowerCase();
      if (!key) return [];
      return (list || []).filter(c => String(c.name || '').toLowerCase().includes(key)
        || String(c.shortName || '').toLowerCase().includes(key)
        || String(c.creditCode || '').toLowerCase().includes(key)).slice(0, 6);
    }

    // --- 表单积木：标签格 / 输入格 ---
    const L = (t, req, hint) => ({ k: 'l', t, req: !!req, hint });
    const V = (c, span) => ({ k: 'v', c, span: span || 1 });

    function PfSection({ title, children, extra }) {
      return h('div', { className: 'pf-sec' },
        h('div', { className: 'pf-sec-t' },
          h('i', null), h('span', null, title),
          extra ? h('span', { className: 'pf-sec-x' }, extra) : null),
        children);
    }

    function PfTable({ rows }) {
      return h('table', { className: 'pf-table' }, h('tbody', null, rows.map((cells, i) => h('tr', { key: i },
        cells.map((cell, j) => cell.k === 'l'
          ? h('th', { key: j, className: 'pf-l' }, cell.req ? h('span', { className: 'pf-req' }, '*') : null, cell.t, cell.hint ? h('span', { className: 'pf-info', title: cell.hint }, 'ⓘ') : null)
          : h('td', { key: j, className: 'pf-v', colSpan: cell.span }, cell.c)),
      ))));
    }

    // 客户信息 → 被评估单位信息 的字段对应。
    // 客户信息里「与被评估单位是否一致」选「是」时，这 8 个字段两边保持一致。
    const CUSTOMER_ENTITY_FIELDS = ['name', 'shortName', 'legalRep', 'creditCode', 'entType', 'capital', 'address', 'business'];
    const SAME_ENTITY_RELATION = '委托人系被评估单位';
    // 合同扫描件固定落位：<项目文件夹>\02现场资料\业务委托合同\
    const CONTRACT_SCAN_SUB = '02现场资料/业务委托合同';

    // --- 全屏项目表单 ---
    function ProjectForm({ project, projects, companies, parseModel, onBack, onSave, toast }) {
      const [f, setF] = useState(() => (project ? normalizeProject(project) : newProject(projects)));
      const [tab, setTab] = useState('basic');
      const [fx, setFx] = useState(null);          // { date, base, rates:{CNY:6.66,...}, source } | { error }
      const [fxBusy, setFxBusy] = useState(false);
      const [upOpen, setUpOpen] = useState(false);   // 「同步到线上」清单弹窗
      const [upBusy, setUpBusy] = useState(false);   // 自动填表进行中
      const [upRes, setUpRes] = useState(null);      // 自动填表结果
      const [tyLogin, setTyLogin] = useState(null);  // 同步窗口登录态 {ok, loggedIn, url, space}
      const [tyLoginBusy, setTyLoginBusy] = useState(false);
      const [uploading, setUploading] = useState(false);
      const [parsing, setParsing] = useState(false);               // 正在让模型按 markdown 填表
      const [converting, setConverting] = useState(false);         // 正在把合同转成 markdown
      const [parseModels, setParseModels] = useState(null);        // [{id,name,models:[{id,name}]}]，null=还在读
      const [sug, setSug] = useState(null);        // 公司名称输入框的候选下拉：{ path }
      const [busyCmp, setBusyCmp] = useState('');  // 正在查企业库/企查查的那个字段（customer/entity）
      // 保存状态：点「保存」只落库、留在表单里（回列表要点「返回」），所以要把结果写在标题条上。
      const [savedAt, setSavedAt] = useState(0);       // 本次打开后最后一次保存成功的时间戳（0 = 还没存过）
      const [leaveAsk, setLeaveAsk] = useState(false); // 有未保存改动时点「返回」的确认弹窗
      const fRef = useRef(f);                      // 失焦回调里读最新表单值，避免闭包里拿到旧 state
      fRef.current = f;
      const isNew = !(project && project.id);

      // 合同解析用哪个模型：宿主报的可用清单 + 上次选的（settings.parseModel）
      useEffect(() => {
        let live = true;
        fetch(PREFIX + '/company/models')
          .then(r => r.json().catch(() => null))
          .then(d => { if (live) setParseModels(d && Array.isArray(d.providers) ? d.providers : []); })
          .catch(() => { if (live) setParseModels([]); });
        return () => { live = false; };
      }, []);
      const modelOptions = (parseModels || []).flatMap(p => (p.models || []).map(m => ({ provider: p.id, model: m.id, label: (p.name || p.id) + ' / ' + (m.name || m.id) })));
      const modelKey = (parseModel && parseModel.provider && parseModel.model)
        ? (parseModel.provider + '::' + parseModel.model)
        : (modelOptions[0] ? (modelOptions[0].provider + '::' + modelOptions[0].model) : '');
      const chosenModel = modelOptions.find(o => (o.provider + '::' + o.model) === modelKey) || modelOptions[0] || null;

      // 按 'a.b.0.c' 这种路径写值：沿途浅拷贝，数组保持数组（多委托人要按下标写）
      const setIn = (root, path, value) => {
        const keys = String(path).split('.');
        const cloneAt = v => (Array.isArray(v) ? [...v] : { ...(v || {}) });
        const next = cloneAt(root);
        let cur = next;
        for (let i = 0; i < keys.length - 1; i += 1) {
          cur[keys[i]] = cloneAt(cur[keys[i]]);
          cur = cur[keys[i]];
        }
        cur[keys[keys.length - 1]] = value;
        return next;
      };
      // 每次写入后统一处理派生关系：
      // 1) customers[0] 同步成 customer 别名（老代码/天源同步都读 customer）；
      // 2) 第一个委托人「与被评估单位一致 = 是」时，被评估单位跟着客户信息走。
      const syncDerived = next => {
        const list = Array.isArray(next.customers) ? next.customers : [];
        if (!list.length) return next;
        const c = list[0] || {};
        next.customer = c;
        if (c.type === '法人组织' && c.sameAsEntity === '是') {
          const e = { ...(next.entity || {}) };
          CUSTOMER_ENTITY_FIELDS.forEach(k => { e[k] = c[k] == null ? '' : c[k]; });
          next.entity = e;
        }
        return next;
      };
      // 从汇率表里取「1 单位该币种 = 多少人民币」
      // ECB 以 USD 为基准：rates[X] 表示 1 USD = X 单位 X 币，所以 1 X 币 = rates.CNY / rates[X]
      const rateFromFx = (cur) => {
        const name = String(cur || '人民币').trim();
        if (name === '人民币' || !name) return 1;
        const code = CURRENCY_CODES[name];
        if (!code) return null;                       // 该币种 ECB 不发布参考汇率 → 手填
        if (!fx || !fx.rates) return null;
        if (code === 'USD') return Number(fx.rates.CNY) || null;
        const r = Number(fx.rates[code]) || 0;
        const cny = Number(fx.rates.CNY) || 0;
        if (!r || !cny) return null;
        return Math.round((cny / r) * 1e6) / 1e6;   // 6 位小数够用，避免 0.04208400000001 这种尾巴
      };
      // 该币种能不能自动取汇率（界面上用来决定提示语）
      const fxSupported = (cur) => {
        const name = String(cur || '人民币').trim();
        return name === '人民币' || !!CURRENCY_CODES[name];
      };

      const setPath = (path, value) => setF(prev => {
        let next = setIn(prev, path, value);
        // 合同金额 = 合同原币金额 × 汇率（折人民币），永远是算出来的结果。
        // 触发点：改原币金额 / 改币种 / 改汇率 / 重新取到汇率，任一处变化都重算。
        if (path === 'contract.amount') {
          // 合同金额本身不接受手改（界面上也做成只读），直接按公式覆盖回去
          next = computeContractAmount(next);
        } else if (path === 'contract.amountOriginal') {
          next = computeContractAmount(next);
        } else if (path === 'contract.currency' || path === 'contract.fxRate') {
          // 换币种时优先用「基准日官方汇率」覆盖 fxRate，取不到才退回内置参考值
          if (path === 'contract.currency') {
            const official = rateFromFx(value);
            const r = official != null ? official : toRate(value);
            if (r != null) next.contract = { ...next.contract, fxRate: String(r), fxDate: (fx && fx.date) || '', fxRateTouched: false };
          } else {
            // 手动改汇率：记一笔，之后自动取回的官方汇率不再覆盖它
            next.contract = { ...next.contract, fxRateTouched: String(value == null ? '' : value).trim() !== '' };
          }
          next = computeContractAmount(next);
        }
        // 改评估基准日：日期一变，汇率要跟着重取（这里先按已拿到的汇率重算，useEffect 会再拉最新的）
        // 合同签订日变化 → 汇率日期跟着变（签约日优先，没填才用基准日），先按已拿到的汇率重算，
        // useEffect 会再按新日期拉一次最新汇率
        if (path === 'contract.signDate' || path === 'baseDate') {
          const official = rateFromFx((next.contract || {}).currency);
          if (official != null) next.contract = { ...next.contract, fxRate: String(official), fxDate: (fx && fx.date) || '' };
          next = computeContractAmount(next);
        }
        // 评估报告日 → 归档日（默认 +90 天）：归档日还空着、或正好是「旧报告日 + 90」时才自动跟
        if (path === 'reportDate') {
          const prevAuto = datePlus(prev.reportDate, 90);
          const cur = String(prev.deadline || '').trim();
          if (!cur || cur === prevAuto) next.deadline = datePlus(value, 90);
        }
        // 服务期间起止日 = 合同签订日 ~ 归档日（手改过的不会被覆盖）
        if (path === 'contract.signDate') {
          const start = String((prev.contract || {}).serviceStart || '').trim();
          const oldSign = String((prev.contract || {}).signDate || '').trim();
          if (!start || start === oldSign) next.contract.serviceStart = value;
        }
        if (path === 'deadline') {
          const end = String((prev.contract || {}).serviceEnd || '').trim();
          const oldDeadline = String(prev.deadline || '').trim();
          if (!end || end === oldDeadline) next.contract.serviceEnd = value;
        }
        // 委托人几处联动：自然人没有「是否一致」；第一个委托人选「是」时关系自动填
        if (String(path).startsWith('customers.')) {
          const parts = String(path).split('.');
          const idx = Number(parts[1]);
          if (Array.isArray(next.customers) && next.customers[idx]) {
            const c = next.customers[idx];
            const patch = {};
            if (parts[2] === 'type' && value !== '法人组织') {
              patch.sameAsEntity = '';
              if (c.relation === SAME_ENTITY_RELATION) patch.relation = '';
            }
            if (idx === 0 && parts[2] === 'sameAsEntity' && value === '是' && c.type === '法人组织') {
              patch.relation = SAME_ENTITY_RELATION;
            }
            if (Object.keys(patch).length) next.customers[idx] = { ...c, ...patch };
          }
        }
        return syncDerived(next);
      });
      const getVal = path => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), f);

      const inp = (path, opts) => h('input', { className: 'pf-in', value: getVal(path) == null ? '' : getVal(path), onChange: e => setPath(path, e.target.value), ...(opts || {}) });
      const dte = (path, ph) => h('input', { className: 'pf-in', type: 'date', value: getVal(path) || '', placeholder: ph || '', onChange: e => setPath(path, e.target.value) });
      const nmb = (path, opts) => h('input', { className: 'pf-in', type: 'number', value: getVal(path) == null ? '' : getVal(path), onChange: e => setPath(path, e.target.value), ...(opts || {}) });
      // 金额类文本输入：打字时光标在末尾就顺手分组，失焦时统一再格式化一次
      const capInp = (path, opts) => h('input', {
        className: 'pf-in',
        value: getVal(path) == null ? '' : getVal(path),
        onChange: e => {
          const el = e.target;
          const atEnd = el.selectionStart === el.value.length;
          setPath(path, atEnd ? formatCapital(el.value) : el.value);
        },
        onBlur: () => setPath(path, formatCapital(getVal(path))),
        ...(opts || {}),
      });
      const ta = (path, rows) => h('textarea', { className: 'pf-ta', rows: rows || 2, value: getVal(path) || '', onChange: e => setPath(path, e.target.value) });
      // 下拉里出现「不在选项表里的值」时补一项显示原文。天源同步过来的企业类型
      // （有限责任公司(非自然人投资或控股的法人独资)）、委托人关系（委托人拟收购被评估单位）
      // 都落不进本地选项表，不补这一项的话控件会显示「请选择」，看起来像数据没了。
      const sel = (path, items, ph, opts) => {
        const cur = getVal(path) == null ? '' : String(getVal(path));
        const known = (items || []).flatMap(o => (typeof o === 'string' ? [o] : Array.isArray(o) ? [String(o[0])] : (o.items || []).map(String)));
        return h('select', { className: 'pf-sel', ...(opts || {}), value: cur, onChange: e => setPath(path, e.target.value) },
          h('option', { value: '' }, ph || '请选择'),
          cur && !known.includes(cur) ? h('option', { key: '__raw', value: cur }, cur) : null,
          (items || []).map(o => {
            if (typeof o === 'string') return h('option', { key: o, value: o }, o);
            if (Array.isArray(o)) return h('option', { key: String(o[0]), value: o[0] }, o[1]);
            return h('optgroup', { key: o.group, label: o.group }, (o.items || []).map(x => h('option', { key: x, value: x }, x)));
          }));
      };
      const combo = (path, items, ph) => h('div', null,
        h('input', { className: 'pf-in', list: 'pf-dl-' + path.replace(/\./g, '-'), value: getVal(path) || '', placeholder: ph || '可输入关键字搜索或直接填写', onChange: e => setPath(path, e.target.value) }),
        h('datalist', { id: 'pf-dl-' + path.replace(/\./g, '-') }, (items || []).map(x => h('option', { key: x, value: x }))));
      const radio = (path, items) => h('div', { className: 'pf-radio' }, (items || []).map(it => {
        const [v, t] = Array.isArray(it) ? it : [it, it];
        return h('label', { key: v }, h('input', { type: 'radio', name: path, checked: getVal(path) === v, onChange: () => setPath(path, v) }), t);
      }));

      // 标签式姓名输入：项目经理与参与人员共用同一套交互（输入姓名回车加一个，× 删除，右侧可点 + 名字补回）
      const tagBox = (path, ph, presets) => {
        const list = nameList(getVal(path));
        const save = v => setPath(path, v);
        const add = v => { const s = String(v || '').trim(); if (!s) return; if (!list.includes(s)) save([...list, s]); };
        return h('div', { className: 'pf-tags' },
          list.map(m => h('span', { className: 'pf-tag', key: m }, m, h('button', { type: 'button', title: '移除', onClick: () => save(list.filter(x => x !== m)) }, '×'))),
          h('input', {
            className: 'pf-tag-in', placeholder: ph || '输入姓名后回车',
            onKeyDown: e => { if (e.key === 'Enter' || e.key === '，' || e.key === ',') { e.preventDefault(); add(e.target.value); e.target.value = ''; } },
          }),
          (presets || []).length
            ? h('span', { className: 'pf-presets' }, presets.filter(x => !list.includes(x)).map(x => h('button', { type: 'button', key: x, onClick: () => add(x) }, '+ ' + x)))
            : null);
      };
      const memberBox = tagBox('team.members', '输入姓名后回车', MEMBER_PRESETS);

      // 汇率取哪一天：优先「合同签订日期」，没填就用「评估基准日」兜底。
      // 合同金额是折算成人民币的，按签约当天的汇率更符合实际结算口径。
      const fxDateOf = (state) => {
        const k = (state && state.contract) || {};
        const sign = String(k.signDate || '').slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(sign)) return { date: sign, by: '合同签订日' };
        const base = String((state && state.baseDate) || '').slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(base)) return { date: base, by: '评估基准日' };
        return { date: '', by: '' };
      };
      // 按该日期取当天官方参考汇率（宿主 /fx → ECB）。日期变了就重取一次。
      // 拿不到不报错，界面显示「汇率未取到，可手填」——汇率只是折算参考，不该挡住填表。
      const fetchFx = async (date) => {
        const d = String(date || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { setFx(null); return; }
        setFxBusy(true);
        try {
          const r = await fetch(PREFIX + '/fx?date=' + d + '&base=USD');
          const j = await r.json().catch(() => null);
          setFx(j && j.ok ? j : { error: (j && (j.error || j.msg)) || ('HTTP ' + r.status) });
        } catch (e) {
          setFx({ error: String((e && e.message) || e) });
        } finally {
          setFxBusy(false);
        }
      };
      // 合同签订日（没填则评估基准日）变化时重取
      useEffect(() => {
        const d = fxDateOf(f).date;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
        let live = true;
        (async () => {
          setFxBusy(true);
          try {
            const r = await fetch(PREFIX + '/fx?date=' + d + '&base=USD');
            const j = await r.json().catch(() => null);
            if (live) setFx(j && j.ok ? j : { error: (j && (j.error || j.msg)) || ('HTTP ' + r.status) });
          } catch (e) {
            if (live) setFx({ error: String((e && e.message) || e) });
          } finally {
            if (live) setFxBusy(false);
          }
        })();
        return () => { live = false; };
      }, [f && f.contract && f.contract.signDate, f && f.baseDate]);

      // 汇率取回来后，用它刷新币种对应的 fxRate 并重算合同金额。
      // 汇率被手改过（fxRateTouched）就不动它；金额本身没有「手改」概念，永远跟着公式走。
      useEffect(() => {
        if (!fx || !fx.rates) return;
        const cur = String((f.contract || {}).currency || '人民币');
        const official = rateFromFx(cur);
        if (official == null) return;
        setF(prev => {
          const pk = prev.contract || {};
          if (pk.fxRateTouched) return prev;          // 手改过汇率就完全尊重手填
          let next = { ...prev, contract: { ...pk, fxRate: String(official), fxDate: fx.date || '' } };
          next = computeContractAmount(next);
          return next;
        });
      }, [fx && fx.date, fx && fx.rates && fx.rates.CNY]);
      // ---- 本地文件夹绑定 ----
      // 绑一个具体目录给项目（folderPath 落库）。绑了之后：打开文件夹 / 上传合同 / 归档
      // 都只认这个目录，不再按「编号 简称」去项目根里找 —— 项目就能放在 OneDrive、
      // 客户共享盘等任意位置；不绑定则维持原来的自动命名 + 项目根目录。
      const [bindBusy, setBindBusy] = useState('');
      const boundAbs = String(f.folderPath || '').trim();

      // 选一个已存在的目录直接绑上（不改里面任何东西）
      const bindPickExisting = async () => {
        setBindBusy('pick');
        try {
          const got = await pickFolderToBind();
          if (!got) return;
          setF(prev => ({ ...prev, folderPath: got.path, folderBoundAt: new Date().toISOString() }));
          toast('已绑定：' + got.path + '（' + got.dirs + ' 个子目录 / ' + got.files + ' 个文件）', 'ok');
        } catch (e) { toast(String((e && e.message) || e), 'danger'); }
        finally { setBindBusy(''); }
      };

      // 选一个上级目录，在里面按「编号 简称」新建一个项目文件夹并绑定
      const bindCreateIn = async () => {
        setBindBusy('new');
        try {
          const parent = await pickDirectoryPath();
          if (!parent) return;
          const cur = fRef.current;
          const r = await fetch(PREFIX + '/project/folder/new', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              parent,
              year: cur.year || projectYear(cur),
              code: cleanSegment(cur.code),
              shortName: cleanSegment(cur.shortName || cur.name),
            }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
          setF(prev => ({ ...prev, folderPath: d.path, folderBoundAt: new Date().toISOString() }));
          toast((d.created ? '已新建并绑定：' : '该目录已存在，已绑定：') + d.path, 'ok');
        } catch (e) { toast('新建文件夹失败：' + String((e && e.message) || e), 'danger'); }
        finally { setBindBusy(''); }
      };

      // 手动粘的路径：失焦时核对一下（不存在就建出来，避免绑了个空路径）
      const bindManual = async () => {
        const v = String(fRef.current.folderPath || '').trim();
        if (!v) return;
        setBindBusy('manual');
        try {
          const r = await fetch(PREFIX + '/project/folder', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder: folderNameOf(fRef.current), abs: v, create: true, open: false }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
          setF(prev => ({ ...prev, folderPath: d.path, folderBoundAt: new Date().toISOString() }));
          toast('已绑定本地文件夹：' + d.path, 'ok');
        } catch (e) { toast('绑定失败：' + String((e && e.message) || e), 'danger'); }
        finally { setBindBusy(''); }
      };

      const openProjectFolderNow = async () => {
        try {
          const r = await fetch(PREFIX + '/project/folder', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder: folderNameOf(fRef.current), abs: projectAbs(fRef.current), create: true, open: true }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
        } catch (e) { toast('打开失败：' + String((e && e.message) || e), 'danger'); }
      };

      const folderRows = [
        [L('本地文件夹', 1, '绑一个具体目录给这个项目：打开文件夹、上传合同、归档都只认它。不填则自动用「项目根目录\\编号 简称」'),
        V(h('div', { className: 'pf-folder' },
          h('input', {
            className: 'pf-in',
            value: boundAbs,
            placeholder: '未绑定 · 自动使用「00项目ing\\' + folderNameOf(f) + '」',
            onChange: e => setF(prev => ({ ...prev, folderPath: e.target.value })),
            onBlur: () => bindManual(),
          })), 3)],
        [L(''), V(h('div', { className: 'pf-folder-acts' },
          h('button', { type: 'button', className: 'pf-btn', disabled: !!bindBusy, title: '从磁盘上挑一个已有的文件夹，把当前项目嵌进去（不改动里面的文件）', onClick: bindPickExisting },
            bindBusy === 'pick' ? '选择中…' : '选择已有文件夹'),
          h('button', { type: 'button', className: 'pf-btn', disabled: !!bindBusy, title: '先挑一个上级目录，再在里面按「编号 简称」新建项目文件夹', onClick: bindCreateIn },
            bindBusy === 'new' ? '创建中…' : '新建文件夹…'),
          h('button', { type: 'button', className: 'pf-btn', disabled: !!bindBusy, title: '在系统文件管理器里打开（未绑定就是自动生成的那个目录）', onClick: openProjectFolderNow }, '打开文件夹'),
          boundAbs ? h('button', { type: 'button', className: 'pf-btn danger', disabled: !!bindBusy, title: '只解除关联，磁盘上的文件一个都不动', onClick: () => setF(prev => ({ ...prev, folderPath: '', folderBoundAt: '' })) }, '解除绑定') : null,
          boundAbs ? h('span', { className: 'pf-hint' }, '已绑定到自定义目录') : h('span', { className: 'pf-hint' }, '未绑定 · 保存时自动创建：' + folderNameOf(f))), 3)],
      ];

      // 打开「合同信息」时先看看文件夹里已经有什么：有合同就自动带出来，有 md 就自动认出来
      const detectContractFiles = async () => {
        const folder = folderNameOf(fRef.current);
        const abs = projectAbs(fRef.current);
        if (!abs && (!cleanSegment(fRef.current.code) || !cleanSegment(fRef.current.shortName || fRef.current.name))) return;
        try {
          const r = await fetch(PREFIX + '/project/contract-files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder, abs, sub: CONTRACT_SCAN_SUB }),
          });
          if (!r.ok) return;
          const d = await r.json().catch(() => ({}));
          if (!d.ok) return;
          const files = Array.isArray(d.files) ? d.files : [];
          const mds = Array.isArray(d.md) ? d.md : [];
          let found = '';
          setF(prev => {
            const cur = String(prev.contract.attachment || '').trim();
            const name = cur && files.includes(cur) ? cur : (files[0] || '');
            if (!name) return prev;
            found = name;
            const base = name.replace(/\.[^.]+$/, '');
            const md = mds.find(x => x.replace(/\.md$/i, '') === base) || mds[0] || '';
            const patch = {};
            if (name !== cur) {
              patch.attachment = name;
              patch.attachmentPath = folder + '/' + CONTRACT_SCAN_SUB + '/' + name;
            }
            if (md && !String(prev.contract.markdownPath || '').trim()) {
              patch.markdownPath = folder + '/' + CONTRACT_SCAN_SUB + '/' + md;
            }
            if (!Object.keys(patch).length) return prev;
            return syncDerived({ ...prev, contract: { ...prev.contract, ...patch } });
          });
          if (found) toast('已找到合同文件：' + found + (mds.length ? '（含 markdown）' : '') + '，可直接点「填写信息」', 'info');
        } catch (e) { /* 探测失败不影响手填 */ }
      };
      useEffect(() => { if (tab === 'contract') detectContractFiles(); }, [tab]);

      // 合同扫描件：真实落盘到 <项目文件夹>\02现场资料\业务委托合同\
      // 文件本体走宿主 POST /project/upload（原始字节流，路径放 query），宿主负责建目录并写文件；
      // 以前只记一个文件名，用户以为存进去了，其实哪里都没有。
      const pickContractFile = () => {
        const el = document.createElement('input');
        el.type = 'file';
        el.accept = '.pdf,.jpg,.jpeg,.png,.bmp,.tif,.tiff,.doc,.docx';
        el.onchange = () => { const file = el.files && el.files[0]; if (file) uploadContractFile(file); };
        el.click();
      };
      // 把解析出来的字段填进表单：只填空项，已有内容不覆盖
      const applyParsedFields = (fields) => {
        if (!fields) return;
        setF(prev => {
          let next = prev;
          const put = (path, v) => {
            const val = String(v == null ? '' : v).trim();
            if (!val) return;
            const old = String(getIn(next, path) == null ? '' : getIn(next, path)).trim();
            if (old) return;
            next = setIn(next, path, val);
          };
          const p = fields.project || {};
          put('shortName', p.shortName);
          put('baseDate', p.baseDate);
          put('economicBehavior', p.economicBehavior);
          put('objectReport', p.objectReport);
          put('scopeReport', p.scopeReport);
          put('valueType', p.valueType);
          put('purposeReport', p.purposeReport);
          put('purpose', p.purpose);
          put('objectReport2', p.objectReport2);
          put('inOut', p.inOut);
          put('equityRatio', p.equityRatio);
          put('purposeOther', p.purposeOther);
          const c = fields.customer || {};
          if (String(c.type || '').trim() === '自然人') put('customers.0.type', '自然人');
          put('customers.0.name', c.name);
          put('customers.0.shortName', c.shortName);
          put('customers.0.creditCode', c.creditCode);
          put('customers.0.entType', c.entType);
          put('customers.0.address', c.address);
          put('customers.0.capital', formatCapital(c.capital));
          put('customers.0.legalRep', c.legalRep);
          put('customers.0.business', c.business);
          put('customers.0.relation', c.relation);
          put('customers.0.idCard', c.idCard);
          put('customers.0.stateOwned', c.stateOwned);
          put('customers.0.listed', c.listed);
          const e = fields.entity || {};
          put('entity.name', e.name);
          put('entity.shortName', e.shortName);
          put('entity.creditCode', e.creditCode);
          put('entity.entType', e.entType);
          put('entity.address', e.address);
          put('entity.capital', formatCapital(e.capital));
          put('entity.legalRep', e.legalRep);
          put('entity.business', e.business);
          put('entity.stateOwned', e.stateOwned);
          put('entity.listed', e.listed);
          const k = fields.contract || {};
          put('contract.type', k.type);
          put('contract.signDate', k.signDate);
          put('contract.serviceStart', k.serviceStart);
          put('contract.serviceEnd', k.serviceEnd);
          put('contract.currency', k.currency);
          put('contract.amountOriginal', toYuanAmount(k.amountOriginal));
          put('contract.amount', toYuanAmount(k.amount));
          put('contract.payMethod', k.payMethod);
          put('contract.reportSubmitAt', k.reportSubmitAt);
          put('contract.reportSubmitWay', k.reportSubmitWay);
          put('contract.reportCopies', k.reportCopies);
          put('contract.statementCopies', k.statementCopies);
          put('contract.otherUsers', k.otherUsers);
          put('contract.purposeDetail', k.purposeDetail);
          put('contract.secret', k.secret);
          // 评估业务性质：委托人/被评估单位是国企 → 国有资产；上市/证券 → 证券期货；其余用模型的判断
          const nature = deriveBizNature(next, p.bizNature);
          if (nature) next = setIn(next, 'bizNature', nature);
          // 服务期间起止日 = 合同签订日 ~ 归档日
          const sign = String(getIn(next, 'contract.signDate') || '').trim();
          const deadline = String(getIn(next, 'deadline') || '').trim();
          if (sign && !String(getIn(next, 'contract.serviceStart') || '').trim()) next = setIn(next, 'contract.serviceStart', sign);
          if (deadline && !String(getIn(next, 'contract.serviceEnd') || '').trim()) next = setIn(next, 'contract.serviceEnd', deadline);
          return syncDerived(next);
        });
      };

      // 「添加」：只把文件存到 <项目文件夹>\02现场资料\业务委托合同\，不解析
      const uploadContractFile = async (file) => {
        const folder = folderNameOf(f);
        const abs = projectAbs(fRef.current);
        // 落位目录是「编号 简称」，两样缺一个就会存到对不上的目录里；已绑定目录的除外
        if (!abs && (!cleanSegment(f.code) || !cleanSegment(f.shortName || f.name))) {
          toast('请先填写项目编号和项目简称，合同文件要放进「编号 简称」文件夹', 'danger');
          setTab('basic');
          return;
        }
        setUploading(true);
        try {
          const r = await fetch(PREFIX + '/project/upload?folder=' + encodeURIComponent(folder)
            + (abs ? '&abs=' + encodeURIComponent(abs) : '')
            + '&sub=' + encodeURIComponent(CONTRACT_SCAN_SUB)
            + '&name=' + encodeURIComponent(file.name), {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: file,
          });
          if (r.status === 404) {
            // 宿主半侧还是旧版（改完宿主代码要重启 DSH 才生效）：先记文件名，并说清楚为什么没落盘
            setPath('contract.attachment', file.name);
            toast('宿主插件还没重启，合同文件暂时只记了文件名；重启 DSH 后即可存到「02现场资料\\业务委托合同」', 'warn');
            return;
          }
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
          setF(prev => ({ ...prev, contract: { ...prev.contract, attachment: file.name, attachmentPath: d.rel || '', markdownPath: '' } }));
          if (ensureProjectRecord()) toast('已在本地项目中生成该项目（文件夹已建好）', 'info');
          toast('已添加：' + file.name + '（需要提取信息就点「解析」）', 'ok');
        } catch (e) {
          setPath('contract.attachment', file.name);
          toast('添加失败：' + ((e && e.message) || e), 'warn');
        } finally { setUploading(false); }
      };

      // 「转换为 md」：把已添加的 word/pdf 转成同目录同名 .md（已有且不比原文件旧就直接复用）
      const clickConvert = async () => {
        const folder = folderNameOf(f);
        const abs = projectAbs(fRef.current);
        const name = String(f.contract.attachment || '').trim();
        if (!name) { toast('先点「添加」选一份合同文件', 'warn'); return; }
        if (!abs && (!cleanSegment(f.code) || !cleanSegment(f.shortName || f.name))) {
          toast('请先填写项目编号和项目简称', 'danger');
          setTab('basic');
          return;
        }
        setConverting(true);
        try {
          const r = await fetch(PREFIX + '/project/parse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder, abs, sub: CONTRACT_SCAN_SUB, name, mode: 'md' }),
          });
          if (r.status === 404) { toast('宿主插件还是旧版本：重启 DSH 后可用', 'warn'); return; }
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
          if (d.md) setF(prev => ({ ...prev, contract: { ...prev.contract, markdownPath: d.md } }));
          toast((d.reused ? '已有 markdown，直接复用：' : '已转换（' + (d.via === 'mineru' ? 'MinerU' : '本地取文') + '，' + d.chars + ' 字）：') + d.md, 'ok');
        } catch (e) {
          toast('转换失败：' + String((e && e.message) || e).slice(0, 340), 'warn');
        } finally { setConverting(false); }
      };

      // 「填写信息」：读 markdown 交给大模型，按结果填表
      const clickFill = async () => {
        const folder = folderNameOf(f);
        const abs = projectAbs(fRef.current);
        const name = String(f.contract.attachment || '').trim();
        if (!name) { toast('先点「添加」选一份合同文件', 'warn'); return; }
        if (!abs && (!cleanSegment(f.code) || !cleanSegment(f.shortName || f.name))) {
          toast('请先填写项目编号和项目简称', 'danger');
          setTab('basic');
          return;
        }
        setParsing(true);
        try {
          const r = await fetch(PREFIX + '/project/parse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              folder, abs, sub: CONTRACT_SCAN_SUB, name, mode: 'fill',
              provider: chosenModel ? chosenModel.provider : '',
              model: chosenModel ? chosenModel.model : '',
            }),
          });
          if (r.status === 404) { toast('宿主插件还是旧版本：重启 DSH 后可用', 'warn'); return; }
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
          if (!d.fields) throw new Error(d.fieldError || '模型没有返回字段');
          applyParsedFields(d.fields);
          fetchIntro('entity', (d.fields.entity || {}).name).catch(() => {});
          if (d.fields._source === 'rule') {
            toast('模型没给出结果，已按规则从合同里提取关键信息（请核对）：' + String(d.fields._note || '').slice(0, 160), 'warn');
          } else {
            toast('已按合同填写（读 ' + d.chars + ' 字 markdown，只填空项' + (d.fields._source === 'mixed' ? '；模型 + 规则补全' : '') + '）', 'ok');
          }
        } catch (e) {
          toast('填写失败：' + String((e && e.message) || e).slice(0, 340), 'warn');
        } finally { setParsing(false); }
      };

      // 把当前表单整理成一条项目记录（保存 / 上传合同后自动入库都用它）
      const buildRecord = (src) => {
        const cur = src || f;
        const shortName = String(cur.shortName || cur.name || '').trim();
        const code = String(cur.code || '').trim();
        const managers = nameList(cur.team && cur.team.managers);
        const team = {
          ...cur.team,
          managers,
          manager: managers[0] || '',
          members: nameList(cur.team && cur.team.members),
        };
        // 委托人落库成数组，customer 留第一个作兼容别名（天源同步/企业库都读它）
        const customersOut = (Array.isArray(cur.customers) ? cur.customers : []).map(c => ({ ...emptyCustomer(), ...(c || {}) }));
        if (!customersOut.length) customersOut.push(emptyCustomer());
        return {
          ...cur, team, code, shortName, name: shortName,
          customers: customersOut, customer: customersOut[0],
          year: projectYear(cur), updatedAt: new Date().toISOString(),
        };
      };
      // 上次保存时的表单快照（recordSig 压成的字符串）。打开已有项目时以「刚打开的内容」为基准：
      // 一进来不该显示「有改动」；新建项目以空串为基准，所以在保存前一直显示「尚未保存」。
      const [savedSig, setSavedSig] = useState(() => (project && project.id ? recordSig(buildRecord()) : ''));
      // 上传合同会先在磁盘上建出「编号 简称」文件夹，此时本地项目还没这条记录，
      // 列表里就对不上；这里顺手补一条（之后再点保存就是更新同一条）。
      const ensureProjectRecord = () => {
        if ((projects || []).some(x => x && x.id === f.id)) return false;
        const rec = buildRecord();
        if (!rec.shortName || !rec.code) return false;
        patch('work', w => ({
          ...w,
          projects: w.projects.some(x => x.id === rec.id) ? w.projects.map(x => (x.id === rec.id ? rec : x)) : [rec, ...w.projects],
          companies: upsertCompanies(w.companies || [], companiesFromProjects([rec])),
        }));
        return true;
      };
      // 保存 = 只落库，不离开表单：标题条上显示「已保存 16:23:45 / 有改动未保存」，
      // 回列表要点「返回」（有未保存改动时会先问一句）。
      // 返回 true 表示确实存上了（「保存并返回」按它决定要不要跳）。
      const save = () => {
        // 项目名称即项目简称：只保留简称，name 同步成同值（列表、工时、文件夹都读它）
        const shortName = String(f.shortName || f.name || '').trim();
        if (!shortName) { toast('请填写项目简称', 'danger'); setTab('basic'); return false; }
        const code = String(f.code || '').trim();
        if (!code) { toast('请填写项目编号', 'danger'); setTab('basic'); return false; }
        if ((projects || []).some(p => p && p.id !== f.id && String(p.code || '').trim().toLowerCase() === code.toLowerCase())) {
          toast('项目编号 ' + code + ' 已被其他项目占用，请换一个', 'danger'); setTab('basic'); return false;
        }
        if (!String(f.baseDate || '').trim()) { toast('请填写评估基准日', 'danger'); setTab('basic'); return false; }
        const rec = buildRecord();
        const sig = recordSig(rec);
        try {
          const r = onSave(rec, { isNewForm: isNew });
          if (r === false) throw new Error('写数据失败');
        } catch (e) {
          toast('保存失败：' + ((e && e.message) || e), 'danger');
          return false;
        }
        // 先落库再动状态：这两步都在同一拍里，界面立刻变成「已保存」
        setSavedSig(sig);
        setSavedAt(Date.now());
        toast(isNew ? '项目已保存（可继续改，点「返回」回列表）' : '项目已保存', 'ok');
        // 每次保存都把「编号 简称」文件夹建出来（已存在则复用；打开仍走列表里的点击）。
        // 同时带上 year/name：宿主还没重启（还是老版路由）时按老规则「年份 名称」建目录，
        // 不会因为读不到 folder 而建出「2026 未命名项目」这种空目录。
        fetch(PREFIX + '/project/folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            folder: folderNameOf(rec), legacy: legacyFolderName(rec),
            abs: projectAbs(rec),
            year: rec.year, name: rec.shortName, create: true, open: false,
          }),
        }).catch(() => {});
        return true;
      };

      // 标题条上的保存状态：把当前表单压成一条记录、和「上次保存的快照」比。
      // 比 updatedAt 可靠 —— 改一个字算改、改回原样就不算。
      const dirty = recordSig(buildRecord()) !== savedSig;
      const savedClock = savedAt ? new Date(savedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '';
      const badge = savedAt
        ? (dirty
          ? { tone: 'dirty', text: '有改动未保存', title: '上次保存：' + savedClock + '；现在的改动还没存，点「保存」' }
          : { tone: 'ok', text: '已保存 ' + savedClock, title: '已保存到本地数据（磁盘副本会在 1 秒内自动写入）' })
        : (dirty ? { tone: 'idle', text: '尚未保存', title: '这一个项目还没保存过，点「保存」' } : null);
      // 「返回」是唯一回列表的路：有未保存改动时先问一句，别让改动无声丢掉
      const tryBack = () => { if (dirty) { setLeaveAsk(true); return; } onBack(); };
      const leaveModal = leaveAsk ? h(Modal, { title: '还有未保存的修改', onClose: () => setLeaveAsk(false) },
        h('p', { className: 'wb-hint', style: { margin: '0 0 12px' } },
          '这个项目有改动还没保存，直接返回列表会丢掉它们。'),
        h('div', { className: 'wb-row', style: { justifyContent: 'flex-end', gap: 8 } },
          h('button', { type: 'button', className: 'pf-btn', onClick: () => setLeaveAsk(false) }, '继续编辑'),
          h('button', { type: 'button', className: 'pf-btn', onClick: () => { setLeaveAsk(false); onBack(); } }, '不保存，返回'),
          h('button', {
            type: 'button', className: 'pf-btn pri',
            onClick: () => { if (save()) { setLeaveAsk(false); onBack(); } },
          }, '保存并返回'))) : null;

      const tabs = [['basic', '基本信息'], ['client', '客户信息'], ['entity', '被评估单位信息'], ['contract', '合同信息']];

      // 行距统一：除「报告文号/经济行为/备注」外都是「标签 + 单行控件」，这三行也用单行输入，
      // 不再用多行 textarea 把行高撑开（经济行为原来是 1 行 textarea，min-height 54px，比别的行高一截）。
      // 评估咨询业务：报告文号用「天源咨报字」，且不展示报备类字段
      const isConsult = getVal('bizType') === '评估咨询业务';

      const basicRows = [
        [L('项目简称', 1, '项目名称即项目简称：列表、工时、文件夹都用这个名称'), V(inp('shortName', { placeholder: '如：示例子公司股权转让-示例大酒店A', autoFocus: isNew })), L('项目编号', 1, '年月日 + 三位流水，如 20261115001；不能与同年份项目重复'), V(inp('code', { placeholder: '20261115001' }))],
        [L('EBS项目'), V(combo('ebsProject', [], '请输入关键字搜索选择')), L('项目受理号'), V(inp('acceptNo', { placeholder: '请输入项目受理号' }))],
        [L('评估基准日', 1), V(dte('baseDate')), L('风险等级'), V(sel('risk', RISK_LEVELS, '请选择风险等级'))],
        [L('业务类型'), V(sel('bizType', BIZ_TYPES, '请选择业务类型')), L('项目阶段'), V(sel('stage', PROJECT_STAGES, '请选择项目阶段'))],
        [L('评估报告日'), V(dte('reportDate')), L('归档日', 0, '默认 = 评估报告日 + 90 天，可改'), V(dte('deadline'))],
        [L('报告文号', 0, isConsult ? '格式：天源咨报字〔XXXX〕第XXXXX号' : '格式：天源评报字〔XXXX〕第XXXX号'),
          V(h('div', { className: 'pf-2' },
            inp('reportNo', { placeholder: isConsult ? '天源咨报字〔2026〕第00001号' : '天源评报字〔2026〕第0001号' }),
            h('button', { type: 'button', className: 'pf-mini', onClick: () => setPath('reportNo', nextReportNo(projects, isConsult ? '咨询' : '评估')) }, '自动生成')), 3)],
        [L('经济行为', 0, '用于报告描述，注意确认是否添加“拟”字，例：拟转让股权，拟收购股权'), V(inp('economicBehavior', { placeholder: '如：拟转让股权 / 拟收购股权' }), 3)],
        [L('评估对象-报告', 0, '用于报告中的描述，例如：股东全部权益、股东部分权益、资产负债表列示的全部资产及负债'), V(inp('objectReport', { placeholder: '如：股东全部权益' })), L('评估范围-报告', 0, '用于报告中的描述，例如：全部资产和负债、商誉相关的资产'), V(inp('scopeReport', { placeholder: '如：全部资产和负债' }))],
        [L('价值类型'), V(sel('valueType', VALUE_TYPE_GROUPS, '请选择价值类型')),
          isConsult ? L('') : L('评估目的-报备'),
          isConsult ? V(h('div')) : V(sel('purposeReport', PURPOSE_REPORTS, '请选择评估目的-报备'))],
        [L('评估目的'), V(sel('purpose', PURPOSES, '请选择评估目的')),
          isConsult ? L('') : L('评估业务性质', 1),
          isConsult ? V(h('div')) : V(sel('bizNature', BIZ_NATURES, '请选择评估业务性质'))],
        ...(getVal('purpose') === '其他'
          ? [[L('具体评估目的', 1, '评估目的选「其他」时在这里写具体目的'), V(inp('purposeOther', { placeholder: '请填写具体评估目的' }), 3)]]
          : []),
        ...(isConsult ? [] : [[L('是否属于重大资产重组'), V(sel('majorRestructure', MAJOR_RESTRUCT, '请选择')), L('评估对象-报备'), V(sel('objectReport2', OBJECT_REPORT_GROUPS, '请选择评估对象-报备'))]]),
        ...(isConsult
          ? [[L('评估对象股权比例(%)'), V(h('div', { className: 'pf-2' }, nmb('equityRatio', { step: '0.0001', min: '0', max: '100', placeholder: '0' }), h('span', { className: 'pf-unit' }, '%'))), L(''), V(h('div'))]]
          : [[L('资产置入/置出'), V(sel('inOut', IN_OUT_OPTIONS, '请选择资产置入/置出')), L('评估对象股权比例(%)'), V(h('div', { className: 'pf-2' }, nmb('equityRatio', { step: '0.0001', min: '0', max: '100', placeholder: '0' }), h('span', { className: 'pf-unit' }, '%')))]]),
        [L('备注'), V(inp('note', { placeholder: '备注' }), 3)],
      ];

      const memberRows = [
        // 执行部门 / 项目合伙人 / 项目经理 都是普通输入框（不用 datalist：Chrome 会在输入框右侧
        // 画一个下拉箭头，和「参与人员」那一格看起来不一致）
        [L('执行部门', 1), V(inp('team.dept', { placeholder: '默认三部' })), L('项目合伙人', 1), V(inp('team.partner', { placeholder: '默认合伙人A' }))],
        [L('项目经理', 1), V(tagBox('team.managers', '输入姓名后回车', MANAGERS)), L('参与人员', 1), V(memberBox)],
        [L('签字评估师'), V(h('div', { className: 'pf-2' }, inp('team.signer1', { placeholder: '签字评估师一' }), inp('team.signer2', { placeholder: '签字评估师二' })), 3)],
      ];

      // ---------- 公司名称 → 企业库 / 企查查 自动补全 ----------
      // 填完名称（失焦）时：先查本地企业库；库里没有就请宿主调企查查·企业工商，拿到就落库。
      // prefix 是路径前缀：'customers.0' / 'customers.1' / 'entity'。
      const dbCompanies = useMemo(() => companies || [], [companies]);
      const skipLookup = useRef('');
      const lastLookup = useRef({});
      const saveCompanyToDb = c => {
        patch('work', w => ({ ...w, companies: upsertCompanies(w.companies || [], [c]) }));
      };
      const applyCompany = (prefix, c, from) => {
        setF(prev => {
          let next = prev;
          COMPANY_FIELDS.forEach(k => {
            let v = String((c && c[k]) == null ? '' : c[k]).trim();
            if (k === 'capital') v = formatCapital(v);
            if (v) next = setIn(next, prefix + '.' + k, v);
          });
          return syncDerived(next);
        });
        if (from) toast(from + '已补全「' + String((c && c.name) || '') + '」的企业信息', 'ok');
      };
      // 只有「像完整企业名」时才去问企查查：半截词（还在打字）不打扰，免得每次都弹没查到
      const COMPANY_NAME_LIKE = /(公司|集团|合伙企业|事务所|合作社|研究院|银行|医院|学校|中心|工厂|厂)$/;
      // 返回补到的公司（本地企业库或企查查），调用方据此决定要不要再生成简称
      const lookupCompany = async (prefix) => {
        const cur = getIn(fRef.current || {}, prefix) || {};
        const name = String(cur.name || '').trim();
        if (!name) return null;
        if (cur.type === '自然人') return null;
        if (lastLookup.current[prefix] === name) return null;   // 同一个名字不重复查
        const local = findCompany(dbCompanies, name);
        if (local) { lastLookup.current[prefix] = name; applyCompany(prefix, local, '企业库'); return local; }
        if (!COMPANY_NAME_LIKE.test(name)) return null;
        lastLookup.current[prefix] = name;
        setBusyCmp(prefix);
        try {
          const r = await fetch(PREFIX + '/company/lookup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          if (r.status === 404) { toast('宿主插件还是旧版本：重启 DSH 后可用企查查补全', 'warn'); return null; }
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok || !d.company) {
            toast('企查查没查到「' + name + '」：' + String(d.error || ('HTTP ' + r.status)).slice(0, 120), 'warn');
            return null;
          }
          const c = { ...d.company, name: String(d.company.name || name), source: 'qcc' };
          applyCompany(prefix, c, '企查查');
          saveCompanyToDb(c);
          return c;
        } catch (e) {
          toast('企查查补全失败：' + String((e && e.message) || e).slice(0, 120), 'warn');
          return null;
        } finally { setBusyCmp(''); }
      };
      // 简称优先级：企查查/企业库里的「企业简称」→ 大模型 → 本地规则
      const fillShortNameIfEmpty = async (prefix, found) => {
        if (found && String(found.shortName || '').trim()) return;   // 有企业简称就用它，不调模型
        await ensureShortName(prefix);
      };
      // 委托人简称：名称有了、简称还空着时按名称生成（先问宿主大模型，失败退回本地规则）
      const ensureShortName = async (prefix) => {
        if (!String(prefix).startsWith('customers.')) return;   // 只做委托人，不做被评估单位
        const cur = getIn(fRef.current || {}, prefix) || {};
        if (cur.type === '自然人') return;
        const name = String(cur.name || '').trim();
        if (!name) return;
        if (String(cur.shortName || '').trim()) return;
        let shortName = '';
        try {
          const r = await fetch(PREFIX + '/company/shortname', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          if (r.ok) {
            const d = await r.json().catch(() => ({}));
            if (d && d.ok && d.shortName) shortName = String(d.shortName).trim();
          }
        } catch (e) { /* 宿主不可用就用本地规则 */ }
        if (!shortName) shortName = guessShortName(name);
        if (!shortName) return;
        setF(prev => {
          const one = getIn(prev, prefix) || {};
          if (String(one.shortName || '').trim()) return prev;   // 已经有简称就不覆盖
          return syncDerived(setIn(prev, prefix + '.shortName', shortName));
        });
        // 企业库里已有这家的话，把生成的简称补进去，下次不用再调模型
        const known = findCompany(dbCompanies, name);
        if (known) patch('work', w => ({ ...w, companies: upsertCompanies(w.companies || [], [{ ...known, shortName }]) }));
      };
      // 更新数据：强制从企查查拉一次，覆盖当前企业信息
      const refreshCompany = async (prefix) => {
        const name = String(((getIn(fRef.current, prefix) || {}).name) || '').trim();
        if (!name) { toast('先填企业名称', 'warn'); return; }
        setBusyCmp(prefix);
        try {
          const r = await fetch(PREFIX + '/company/lookup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          if (r.status === 404) { toast('宿主插件还是旧版本：重启 DSH 后可用', 'warn'); return; }
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok || !d.company) {
            toast('没查到「' + name + '」：' + String(d.error || ('HTTP ' + r.status)).slice(0, 120), 'warn');
            return;
          }
          const c = { ...d.company, name: String(d.company.name || name), source: 'qcc' };
          applyCompany(prefix, c, '');
          saveCompanyToDb(c);
          lastLookup.current[prefix] = name;
          if (String(prefix).startsWith('customers.')) await ensureShortName(prefix);
          if (prefix === 'entity') fetchIntro(prefix);
          toast('已更新「' + name + '」的企业信息', 'ok');
        } catch (e) {
          toast('更新失败：' + String((e && e.message) || e).slice(0, 120), 'warn');
        } finally { setBusyCmp(''); }
      };

      // 被评估单位经营情况简介：宿主搜公开资料 → 一句话，搜不到就留空
      const fetchIntro = async (prefix, nameHint) => {
        const name = String(nameHint || ((getIn(fRef.current, prefix) || {}).name) || '').trim();
        if (!name) return '';
        try {
          const r = await fetch(PREFIX + '/company/intro', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          const d = await r.json().catch(() => ({}));
          if (!d || !d.ok || !d.intro) return '';
          const intro = String(d.intro).trim();
          setF(prev => {
            if (String(getIn(prev, prefix + '.intro') || '').trim()) return prev;
            return syncDerived(setIn(prev, prefix + '.intro', intro));
          });
          return intro;
        } catch (e) { return ''; }
      };

      const pickCompany = (prefix, c) => {
        setPath(prefix + '.name', c.name);
        setSug(null);
        skipLookup.current = prefix + '.name';
        applyCompany(prefix, c, '企业库');
        if (!String((c && c.shortName) || '').trim()) ensureShortName(prefix);   // 企业库没有简称才生成
      };
      // 名称输入框 + 候选下拉（不用 datalist：那个下拉箭头和别处不一致）
      const companyBox = (path, prefix, placeholder) => {
        const val = getVal(path) || '';
        const items = (sug && sug.path === path) ? searchCompanies(dbCompanies, val) : [];
        const qccName = String(val || '').trim();
        return h('div', { className: 'pf-cmp' },
          h('div', { className: 'pf-cmp-in' },
          h('input', {
            className: 'pf-in', value: val, placeholder,
            onChange: e => { setPath(path, e.target.value); setSug({ path }); },
            onFocus: () => setSug({ path }),
            onBlur: () => {
              setTimeout(() => setSug(cur => (cur && cur.path === path ? null : cur)), 150);
              if (skipLookup.current === path) { skipLookup.current = ''; return; }
              lookupCompany(prefix).then(found => fillShortNameIfEmpty(prefix, found)).catch(() => {});
            },
            onKeyDown: e => {
              if (e.key === 'Escape') setSug(null);
              if (e.key === 'Enter' && items.length === 1) { e.preventDefault(); pickCompany(prefix, items[0]); }
            },
          }),
          items.length
            ? h('div', { className: 'pf-cmp-list' }, items.map(c => h('button', {
                type: 'button',
                key: companyKey(c),
                onMouseDown: e => { e.preventDefault(); pickCompany(prefix, c); },
              },
                h('b', null, c.name),
                c.creditCode ? h('span', null, '  ' + c.creditCode) : null,
                c.legalRep ? h('span', null, ' · ' + c.legalRep) : null)))
            : null,
          busyCmp === prefix ? h('span', { className: 'pf-cmp-busy' }, '查询企业库 / 企查查…') : null),
          h('div', { className: 'pf-cmp-tools' },
            h('button', {
              type: 'button', className: 'pf-mini', disabled: busyCmp === prefix,
              title: '重新从企查查拉一次，覆盖当前企业信息（防止本地数据老化）',
              onClick: () => refreshCompany(prefix),
            }, busyCmp === prefix ? '更新中…' : '更新数据'),
            qccName
              ? h('a', {
                  className: 'pf-mini', title: '在企查查打开这家企业',
                  href: 'https://www.qcc.com/web/search?key=' + encodeURIComponent(qccName),
                  target: '_blank', rel: 'noreferrer noopener',
                }, '企查查')
              : null));
      };

      // 委托人：可以多个。每个是一组同样的字段，路径 customers.N.*；第一个同时作为 customer 别名。
      const customers = Array.isArray(getVal('customers')) ? getVal('customers') : [];
      const addCustomer = () => setF(prev => syncDerived({
        ...prev,
        customers: [...(Array.isArray(prev.customers) ? prev.customers : []), emptyCustomer()],
      }));
      const removeCustomer = idx => setF(prev => {
        const list = Array.isArray(prev.customers) ? prev.customers : [];
        if (list.length <= 1) return prev;
        return syncDerived({ ...prev, customers: list.filter((_, k) => k !== idx) });
      });
      const clientRowsFor = (idx) => {
        const base = 'customers.' + idx;
        const typeRow = [L('委托人类型', 1), V(radio(base + '.type', ['法人组织', '自然人']), 3)];
        const isPerson = getVal(base + '.type') === '自然人';
        if (isPerson) {
          return [typeRow, ...[
            [L('委托人名称', 1), V(inp(base + '.name', { placeholder: '请输入委托人名称' })), L('委托人简称', 1), V(inp(base + '.shortName', { placeholder: '请输入委托人简称' }))],
            [L('委托人身份证'), V(inp(base + '.idCard', { placeholder: '请输入委托人身份证号' })), L('与被评估单位关系'), V(inp(base + '.relation', { placeholder: '请输入与被评估单位关系' }))],
          ]];
        }
        return [typeRow, ...[
          [L('委托人名称', 1, '填完名称会自动从企业库补全简称/信用代码/企业类型/住所/注册资本/法定代表人/经营范围；库里没有的调企查查'), V(companyBox(base + '.name', base, '请输入委托人名称')), L('委托人简称', 1, '按委托人名称自动生成，可改'), V(inp(base + '.shortName', {
            placeholder: '按名称自动生成',
            onBlur: () => { if (!String((getIn(fRef.current, base) || {}).shortName || '').trim()) ensureShortName(base); },
          }))],
          [L('与被评估单位是否一致', 1, idx === 0 ? '选「是」时：关系自动填「委托人系被评估单位」，被评估单位信息与客户信息同步' : '只有第一个委托人会同步到被评估单位'), V(sel(base + '.sameAsEntity', ['是', '否'], '请选择与被评估单位是否一致')), L('委托人社会信用代码'), V(inp(base + '.creditCode', { placeholder: '请输入委托人社会信用代码' }))],
          [L('委托人企业类型'), V(inp(base + '.entType', { placeholder: '请输入委托人企业类型' })), L('委托人企业住所'), V(inp(base + '.address', { placeholder: '请输入委托人企业住所' }))],
          [L('委托人注册资本'), V(capInp(base + '.capital', { placeholder: '如：5,000万元' })), L('委托人法定代表人'), V(inp(base + '.legalRep', { placeholder: '请输入委托人法定代表人' }))],
          [L('委托人经营范围'), V(ta(base + '.business', 2), 3)],
          [L('与被评估单位关系'), V(inp(base + '.relation', { placeholder: '如：委托人系被评估单位' }), 3)],
        ]];
      };

      // 客户信息同步过来的被评估单位：映射字段锁成只读（改客户信息那边才对），经营情况简介仍可填
      const entitySynced = getVal('customers.0.type') === '法人组织' && getVal('customers.0.sameAsEntity') === '是';
      const entityLocked = path => entitySynced && CUSTOMER_ENTITY_FIELDS.includes(String(path).split('.')[1]);
      const einp = (path, opts) => inp(path, { ...(opts || {}), readOnly: entityLocked(path), className: 'pf-in' + (entityLocked(path) ? ' pf-ro' : '') });
      const esel = (path, items, ph) => sel(path, items, ph, entityLocked(path)
        ? { disabled: true, className: 'pf-sel pf-ro' }
        : {});

      const entityRows = [
        [L('公司名称', 1), V(entitySynced ? einp('entity.name', { placeholder: '请输入公司名称' }) : companyBox('entity.name', 'entity', '请输入公司名称')), L('公司简称', 1), V(einp('entity.shortName', { placeholder: '请输入公司简称' }))],
        [L('法定代表人'), V(einp('entity.legalRep', { placeholder: '请输入法定代表人' })), L('社会信用代码'), V(einp('entity.creditCode', { placeholder: '请输入社会信用代码' }))],
        [L('企业类型'), V(esel('entity.entType', ENTITY_TYPES, '请选择企业类型')), L('注册资本'), V(entityLocked('entity.capital') ? einp('entity.capital', { placeholder: '请输入注册资本' }) : capInp('entity.capital', { placeholder: '如：5,000万元' }))],
        [L('企业住所'), V(einp('entity.address', { placeholder: '请输入企业住所' })), L('经营范围'), V(einp('entity.business', { placeholder: '请输入经营范围' }))],
        [L('经营情况简介'), V(ta('entity.intro', 3), 3)],
      ];

      const contractRows = [
        [L('合同类型'), V(sel('contract.type', CONTRACT_TYPES, '请选择合同类型')), L('合同签订日期'), V(dte('contract.signDate'))],
        [L('服务期间起止日'), V(h('div', { className: 'pf-2' }, dte('contract.serviceStart'), h('span', { className: 'pf-unit' }, '至'), dte('contract.serviceEnd'))), L('合同币种'), V(sel('contract.currency', CURRENCIES, '请选择合同币种'))],
        [L('合同原币金额'), V(capInp('contract.amountOriginal', { placeholder: '如：280,000' })),
          L('合同金额'), V(h('div', { className: 'pf-2', style: { flexWrap: 'nowrap', minWidth: 0 } },
            // 合同金额是「原币金额 × 汇率」的结果，不做手填：只读展示，改算法就改原币或汇率
            // 值里存的是「100,000 元」，但框内只显示数字，单位用右侧 .pf-unit 呈现——
            // 否则输入框被压缩时「元」会贴着边框、看起来像露在框外。
            h('input', {
              className: 'pf-in',
              readOnly: true,
              value: String(getVal('contract.amount') == null ? '' : getVal('contract.amount')).replace(/\s*元\s*$/, ''),
              placeholder: '原币 × 汇率自动算出',
              title: '合同金额 = 合同原币金额 × 汇率（折人民币），自动计算\n要改请改左侧「合同原币金额」或右侧汇率',
              style: { flex: '1 1 auto', minWidth: 0, background: 'var(--dsw-alias-bg-layer-2,#f7f8fa)', cursor: 'default', color: 'var(--dsw-alias-label-secondary,#666)' },
            }),
            h('span', { className: 'pf-unit', style: { flex: '0 0 auto' } }, '元'),
            h('span', { className: 'pf-unit', style: { flex: '0 0 auto' }, title: '汇率来自基准日官方参考汇率（ECB），可手改；改了就按你填的算' },
              h('span', { style: { marginRight: 2 } }, '×'),
              h('input', {
                className: 'pf-in',
                style: { width: 44, padding: '2px 2px', textAlign: 'right', fontSize: 12 },
                value: getVal('contract.fxRate') == null || getVal('contract.fxRate') === ''
                  ? String(toRate(getVal('contract.currency')) == null ? '' : toRate(getVal('contract.currency')))
                  : getVal('contract.fxRate'),
                title: '汇率（1 ' + (getVal('contract.currency') || '人民币') + ' 折人民币）'
                  + (fx && fx.rates
                    ? '\n按' + (fxDateOf(f).by || '日期') + ' ' + (fxDateOf(f).date || '—') + ' 取的官方参考汇率'
                      + '\n用到的日期 ' + fx.date + '（' + (fx.source || 'ECB') + '）'
                      + (fxDateOf(f).by === '评估基准日' ? '\n（合同签订日期没填，退回按基准日）' : '')
                    : !fxSupported(getVal('contract.currency')) ? '\n该币种无官方参考汇率，请手填'
                      : '\n可手填'),
                onChange: e => setPath('contract.fxRate', e.target.value),
              })),
            h('button', {
              type: 'button', className: 'pf-mini',
              // 同高同圆角（pf-in 是 height:30 / radius:2）；flex:0 0 auto 保证不被压缩也不外溢
              style: { height: 30, lineHeight: '28px', borderRadius: 2, padding: '0 6px', flex: '0 0 auto', alignSelf: 'center' },
              disabled: fxBusy,
              title: fxBusy ? '正在取汇率…'
                : fx && fx.rates ? '重新取官方参考汇率（ECB）\n当前：' + fx.date + '（按' + (fxDateOf(f).by || '日期') + '）'
                  : '按合同签订日期取官方参考汇率（ECB）',
              onClick: async () => {
                await fetchFx(fxDateOf(f).date);
              },
            }, fxBusy ? '…' : '取汇率')) )],
        [L('评估费支付方式'), V(inp('contract.payMethod', { placeholder: '请输入评估费支付方式' })), L('报告提交时间'), V(dte('contract.reportSubmitAt'))],
        [L('报告提交方式'), V(sel('contract.reportSubmitWay', SUBMIT_WAYS, '请选择报告提交方式')), L('外送报告份数'), V(nmb('contract.reportCopies', { min: '0', step: '1', placeholder: '0' }))],
        [L('外送评估说明份数'), V(nmb('contract.statementCopies', { min: '0', step: '1', placeholder: '0' })), L('其他报告使用人'), V(inp('contract.otherUsers', { placeholder: '如：法律、行政法规规定的使用人' }))],
        [L('具体评估目的'), V(ta('contract.purposeDetail', 2), 3)],
        [L('合同扫描件', 0, '添加到 02现场资料\\业务委托合同\\；先「转换为 md」，再「填写信息」由大模型填表'), V(h('div', { className: 'pf-2' },
          h('button', { type: 'button', className: 'pf-btn pri sm', onClick: pickContractFile, disabled: uploading }, uploading ? '添加中…' : (f.contract.attachment ? '更换文件' : '添加')),
          h('button', { type: 'button', className: 'pf-btn sm', onClick: clickConvert, disabled: converting || !f.contract.attachment, title: '把 word/pdf 转成同目录同名 .md（已有就直接复用）' }, converting ? '转换中…' : '转换为 md'),
          h('button', { type: 'button', className: 'pf-btn sm', onClick: clickFill, disabled: parsing || !f.contract.attachment, title: '读 markdown 让大模型填表' }, parsing ? '填写中…' : '填写信息'),
          h('select', {
            className: 'pf-sel',
            style: { maxWidth: 200 },
            title: '解析用的模型',
            value: modelKey,
            disabled: !modelOptions.length,
            onChange: e => {
              const [provider, model] = String(e.target.value).split('::');
              patch('settings', st => ({ ...st, parseModel: { provider, model } }));
            },
          },
            parseModels === null ? h('option', { value: '' }, '读取模型…')
              : !modelOptions.length ? h('option', { value: '' }, '没有可用模型')
              : modelOptions.map(o => h('option', { key: o.provider + '::' + o.model, value: o.provider + '::' + o.model }, o.label))),
          h('span', { className: 'pf-hint' }, f.contract.attachment
            ? '已添加：' + f.contract.attachment + (f.contract.markdownPath ? ' · markdown：' + f.contract.markdownPath : '')
            : '未添加（存到 02现场资料\\业务委托合同\\）')), 3)],
      ];

      const secretRows = [
        [L('合同是否涉密'), V(sel('contract.secret', SECRET_OPTIONS, '请选择是否涉密'), 3)],
      ];

      // ---------- 同步到线上 ----------
      // 为什么不是「一键上传」：天源 OpenAPI（MCP 35 个工具）只开放读取 + 写「参与人员 / 公司负责人」，
      // 新建项目与基本信息 / 客户 / 被评估单位 / 合同的写入都只在网页表单里（https://ty.zhrdc.net/project/my）。
      // 所以这里的做法是：把本项目四组信息整理成清单 → 一键复制 → 打开网页表单逐项粘贴。
      const upText = buildTyFormText(f);
      const copyUp = async () => {
        let ok = false;
        try { await navigator.clipboard.writeText(upText); ok = true; } catch (e) { ok = false; }
        if (!ok) {
          try {
            const ta = document.createElement('textarea');
            ta.value = upText; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            ok = document.execCommand('copy'); ta.remove();
          } catch (e) { ok = false; }
        }
        toast(ok ? '已复制整份表单清单，去天源网页逐项粘贴' : '复制被浏览器拦了，请直接在下框里全选复制', ok ? 'ok' : 'warn');
      };
      const openTy = async (url, label) => {
        const kind = await openInApp(url);
        if (kind === 'system') toast('已在系统浏览器打开' + label);
        else if (kind === 'sidebar') toast('已在右侧栏打开' + label);
        else toast('自动开窗被拦，请手动打开：' + url, 'warn');
      };
      // 同步通道体检：打开天源首页看你的 Chrome 里是否已登录（只读，不写数据）。
      const checkTyLogin = async () => {
        if (tyLoginBusy) return tyLogin;
        setTyLoginBusy(true);
        try {
          const r = await fetch(PREFIX + '/ty/sync/login');
          const d = await r.json().catch(() => ({ ok: false, msg: 'HTTP ' + r.status }));
          setTyLogin(d);
          return d;
        } catch (e) {
          const d = { ok: false, msg: String((e && e.message) || e) };
          setTyLogin(d);
          return d;
        } finally {
          setTyLoginBusy(false);
        }
      };
      // 自动填表：宿主用 opencli 驱动你自己的 Chrome，把四组页签填进天源网页表单。
      // 注意天源保存接口永远返回 HTTP 200，成败由引擎「保存后回读」判定，所以这里只信 ok 字段。
      const doSync = async () => {
        if (upBusy) return;
        setUpBusy(true);
        setUpRes(null);
        try {
          if (!tyLogin || tyLogin.loggedIn !== true) {
            const st = await checkTyLogin();
            if (!st || st.loggedIn !== true) {
              setUpRes({ ok: false, msg: '同步通道不可用：' + ((st && st.msg) || '未知原因') });
              toast('同步通道不可用：先在你的 Chrome 里登录天源（点「检查登录状态」）', 'warn');
              return;
            }
          }
          const r = await fetch(PREFIX + '/ty/sync', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ project: f }),
          });
          const d = await r.json().catch(() => ({ ok: false, msg: 'HTTP ' + r.status }));
          setUpRes(d);
          // 同步成功后把线上「自动生成」的三项回写到本地项目：
          //   tyId（项目 id）、code（项目编号，天源年月日+流水）、acceptNo（项目受理号，填 EBS 后由系统带出）。
          // 本地这两个号的旧值一律以线上为准——线上才是权威，本地只是副本。
          if (d.ok && d.online) {
            try {
              const on = d.online;
              const tid = on.id ? String(on.id) : (f.tyId || '');
              patch('work', (w) => ({
                ...w,
                projects: (w.projects || []).map((x) => (x.id === f.id ? {
                  ...x,
                  tyId: tid || x.tyId,
                  code: on.code || x.code,
                  acceptNo: on.acceptNo || x.acceptNo,
                } : x)),
              }));
              if (tid) setPath('tyId', tid);
              if (on.code) setPath('code', on.code);
              if (on.acceptNo) setPath('acceptNo', on.acceptNo);
              const bits = [];
              if (on.code) bits.push('编号 ' + on.code);
              if (on.acceptNo) bits.push('受理号 ' + on.acceptNo);
              toast(bits.length ? ('已回写本地：' + bits.join(' · ')) : ('已回填天源项目 ID ' + tid), 'ok');
            } catch (e) { /* 回填失败不影响同步结果 */ }
          }
          if (d.ok) toast('已同步到天源：' + ((d.online && d.online.code) || '已更新'), 'ok');
          else if (d.code === 'NOT_LOGGED_IN') toast('这个浏览器窗口还没登录天源，登录后再点一次', 'warn');
          else toast('同步未完成：' + (d.msg || d.code || '未知原因'), 'warn');
        } catch (e) {
          setUpRes({ ok: false, msg: String((e && e.message) || e) });
          toast('同步失败：' + ((e && e.message) || e), 'warn');
        } finally {
          setUpBusy(false);
        }
      };
      const syncPanel = upRes ? h('div', {
        style: { marginBottom: 12, padding: '10px 12px', borderRadius: 8, border: '1px solid ' + (upRes.ok ? '#b7e1c1' : '#f0c2bd'), background: upRes.ok ? '#f2fbf4' : '#fdf4f3', fontSize: 12, lineHeight: 1.7 },
      },
        h('div', { style: { fontWeight: 600, color: upRes.ok ? '#1e7e34' : '#c0392b' } },
          upRes.ok ? '✅ 已同步到天源' : '⚠️ 同步未完成'),
        upRes.msg ? h('div', { style: { color: '#555' } }, upRes.msg) : null,
        upRes.online ? h('div', null,
          '线上项目编号：' + (upRes.online.code || '—')
          + ' · 受理号：' + (upRes.online.acceptNo || '—')
          + (upRes.online.name ? '（' + upRes.online.name + '）' : '')) : null,
        h('div', { style: { color: '#666' } }, '通道：opencli 驱动你的 Chrome' + (upRes.cdpCalls ? (' · ' + upRes.cdpCalls + ' 次往返') : '')),
        upRes.applied && upRes.applied.length ? h('div', null, '已填 ' + upRes.applied.length + ' 项：' + upRes.applied.join('、')) : null,
        upRes.mismatches && upRes.mismatches.length ? h('div', { style: { color: '#c0392b' } }, '回读不一致：' + upRes.mismatches.join('；')) : null,
        (upRes.notes || []).length ? h('div', { style: { color: '#8a6d3b' } }, (upRes.notes || []).join('；')) : null,
        (upRes.warnings || []).length ? h('div', { style: { color: '#8a6d3b' } }, (upRes.warnings || []).join('；')) : null,
      ) : null;
      const upModal = upOpen ? h(Modal, { title: '同步到线上 · 天源', onClose: () => setUpOpen(false) },
        h('p', { className: 'wb-hint', style: { marginTop: 0 } },
          '「同步到天源（自动填表）」用 opencli 驱动你自己的 Chrome：按四组页签逐项填写并保存，保存后自动回读校验。'
          + '前提是你的 Chrome 里登录着天源（点下面「检查登录状态」）。'
          + '天源开放接口只允许读项目和写「参与人员 / 公司负责人」，其余写入只能在网页表单里做，所以下面仍保留清单，供手工核对。'
          + (f.tyId ? '本项目已关联天源（ID ' + f.tyId + '）。' : '本项目还没有关联天源项目，将走「线上新建」。')),
        h('div', { className: 'wb-row', style: { marginBottom: 10 } },
          h('button', { type: 'button', className: 'pf-btn pri', disabled: upBusy, onClick: () => doSync() },
            upBusy ? '同步中…（约 1 分钟）' : '同步到天源（自动填表）'),
          h('button', { type: 'button', className: 'pf-btn', onClick: copyUp }, '复制全部'),
          h('button', { type: 'button', className: 'pf-btn', onClick: () => openTy(TY_BASE, '天源新建项目页') }, '打开线上新建项目'),
          f.tyId ? h('button', { type: 'button', className: 'pf-btn', onClick: () => openTy(tyProjectUrl(f.tyId), '该项目页') }, '打开该项目') : null),
        h('div', { className: 'wb-row', style: { marginBottom: 8, alignItems: 'center' } },
          h('span', { style: { fontSize: 12, color: tyLogin && tyLogin.loggedIn ? '#1e7e34' : '#8a6d3b', marginRight: 8 } },
            tyLoginBusy ? '正在检查浏览器…'
              : tyLogin == null ? '浏览器：未检查'
                : tyLogin.loggedIn ? '浏览器：已登录天源 ✓'
                  : '浏览器：未登录天源'),
          h('button', {
            type: 'button', className: 'pf-btn sm', disabled: tyLoginBusy,
            title: '检查你的 Chrome 里是否已登录天源（只读，不写数据）',
            onClick: () => checkTyLogin(),
          }, tyLoginBusy ? '检查中…' : '检查登录状态')),
        syncPanel,
        h('pre', {
          style: { maxHeight: 420, overflow: 'auto', margin: 0, padding: '12px 14px', borderRadius: 8, background: '#f7f8fa', border: '1px solid #e6e8ee', fontSize: 12, lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
        }, upText || '（还没有可同步的内容）')) : null;

      return h('div', { className: 'pf' },
        h('div', { className: 'pf-head' },
          h('div', { className: 'pf-title' }, isNew ? '新建项目' : '编辑项目'),
          h('div', { className: 'pf-actions' },
            badge ? h('span', { className: 'pf-save-state ' + badge.tone, title: badge.title }, badge.text) : null,
            h('button', { type: 'button', className: 'pf-btn', onClick: tryBack }, '返回'),
            h('button', { type: 'button', className: 'pf-btn', title: '把本项目四组信息整理成清单，配合天源网页表单填写', onClick: () => { setUpOpen(true); checkTyLogin(); } }, '同步到线上'),
            h('button', { type: 'button', className: 'pf-btn pri', onClick: () => save() }, '保存'))),
        h('div', { className: 'pf-tabs' }, tabs.map(([k, t]) => h('button', { key: k, type: 'button', className: 'pf-tab' + (tab === k ? ' on' : ''), onClick: () => setTab(k) }, t))),
        h('div', { className: 'pf-body' },
          tab === 'basic' ? h('div', null,
            h(PfSection, { title: '项目基础信息' }, h(PfTable, { rows: basicRows })),
            h(PfSection, { title: '本地文件夹' }, h(PfTable, { rows: folderRows })),
            h(PfSection, { title: '成员信息' }, h(PfTable, { rows: memberRows })),
            h('div', { className: 'pf-foot-hint' },
              boundAbs ? '已绑定本地文件夹：' : '保存后将在「00项目ing」下创建项目文件夹：', h('code', null, boundAbs || folderNameOf(f)))) : null,
          tab === 'client' ? h('div', null,
            customers.map((c, i) => h(PfSection, {
              key: 'cust-' + i,
              title: i === 0 ? '委托人信息' : ('委托人 ' + (i + 1)),
              extra: i > 0
                ? h('button', { type: 'button', className: 'pf-btn sm danger', onClick: () => removeCustomer(i) }, '删除该委托人')
                : null,
            }, h(PfTable, { rows: clientRowsFor(i) }))),
            h('div', { className: 'wb-row', style: { marginTop: 10 } },
              h('button', { type: 'button', className: 'pf-btn', onClick: addCustomer }, '+ 新增委托人')),
            h('div', { className: 'pf-foot-hint' },
              '委托人可以多个：点「新增委托人」再加一个，多出来的可以删除。'
              + ' 类型为自然人时只填名称/简称/身份证/与被评估单位关系；'
              + ' 企业库 ' + dbCompanies.length + ' 家（本地已存）：填完名称会自动补全简称 / 社会信用代码 / 企业类型 / 住所 / 注册资本 / 法定代表人 / 经营范围，库里没有的自动问企查查·企业工商。')) : null,
          tab === 'entity' ? h('div', null,
            entitySynced ? h('div', { className: 'pf-foot-hint' }, '客户信息里「与被评估单位是否一致」选了「是」：下面的公司名称/简称/法定代表人/社会信用代码/企业类型/注册资本/企业住所/经营范围已与客户信息同步（只读，改客户信息即可）。') : null,
            h(PfSection, { title: '基本信息' }, h(PfTable, { rows: entityRows }))) : null,
          tab === 'contract' ? h('div', null,
            h(PfSection, { title: '常规信息' }, h(PfTable, { rows: contractRows })),
            h(PfSection, { title: '涉密信息' }, h(PfTable, { rows: secretRows }))) : null,
        ),
        leaveModal,
        upModal);
    }


    // ---------- 项目界面（作业信息 / 股权信息） ----------
    // 版式对齐天源评估系统：顶部编码|项目名，下面六个页签；作业信息里再分
    // 股权信息 / 管理类底稿 / 基础类资料。股权信息是本轮真正可用的那块。
    const PW_TABS = [['work', '作业信息'], ['sum', '结果汇总'], ['report', '报告说明'], ['files', '项目文件'], ['export', '生成/导出'], ['tpl', '报表模板']];
    // 作业信息下面只留两个页签：股权信息 / 管理类底稿。
    // 财务类资料、基础类资料是「每家公司一套」，入口在股权信息每行的操作里，
    // 点进去是该公司的独立界面（CompanyMaterials），不再是项目级页签。
    const WORK_SUBS = [['equity', '股权信息'], ['mgmt', '管理类底稿']];
    const WHOLE_METHODS = ['资产基础法', '收益法', '市场法'];
    const PART_METHODS = ['报表净资产折算', '账面投资成本', '回购法', '上市公司股价法', '市场法', '股利模型', '期后转让价', '近期投融资', '其他方法'];
    const EQUITY_SUBJECTS = ['长期股权投资', '其他非流动资产-股票投资', '其他非流动资产-股权投资', '其他权益工具投资', '交易性金融资产'];
    const MGMT_CATALOG = [
      ['程序文件', '项目基本事项调查表'], ['程序文件', '专业能力分析和评价表'], ['程序文件', '项目独立性调查问卷'],
      ['程序文件', '项目风险分析评价表'], ['程序文件', '项目承接审批表'], ['程序文件', '项目涉密承诺'],
      ['程序文件', '报告签发表'], ['程序文件', '报告修订审批表'],
      ['合同与依据文件', '资产评估委托合同'], ['合同与依据文件', '经济行为文件及经济行为的审批文件'],
      ['技术文件', '项目工作计划'], ['技术文件', '评估方法适用性分析'], ['技术文件', '重大问题处理记录'],
      ['沟通记录类文件', '与注册会计师、管理层等沟通事项（三方纪要）'], ['沟通记录类文件', '委托人意见反馈表'],
      ['审核与交付文件', '外部审核意见及初稿'], ['审核与交付文件', '报告签收单'],
      ['定稿成果文件', '装订版报告及明细表'], ['定稿成果文件', '报告说明扫描件（PDF）'], ['定稿成果文件', '底稿存档介质目录'],
    ];
    const BASIC_CATALOG = [
      ['公司基础资料', '委托人营业执照'], ['公司基础资料', '被评估单位营业执照'], ['公司基础资料', '章程及修正案'],
      ['公司基础资料', '公司及业务介绍资料'], ['公司基础资料', '历史沿革资料、股权变更相关资料'], ['公司基础资料', '国有资产产权登记表'],
      ['公司基础资料', '各类经营资质证书（采矿许可证、进出口许可证、专营权许可证等）'],
      ['公司基础资料', '各类无形资产证书（专利、商标、软著等）'], ['公司基础资料', '各类荣誉证书'],
      ['公司基础资料', '可行性研究报告、初步设计报告书等'],
      ['财务资料', '历史年度审计报告（财务报表）'], ['财务资料', '评估基准日审计报告（财务报表）'],
      ['财务资料', '会计政策调查表'], ['财务资料', '所得税汇算清缴报告'], ['财务资料', '企业征信报告'],
      ['评估申报与核实资料', '盖章后的评估申报表'], ['评估申报与核实资料', '1-4表（诉讼、或有、期后、抵押事项）及相关资料'],
      ['评估申报与核实资料', '访谈记录'], ['评估申报与核实资料', '其他相关资料'],
      ['行业与宏观分析资料', '宏观经济分析资料'], ['行业与宏观分析资料', '行业经济分析资料'],
    ];

    const eqMapOf = s => (s && s.work && s.work.equity) || {};
    const eqListOf = (s, pid) => { const m = eqMapOf(s)[pid]; return (m && m.companies) || []; };
    // 管理类资料：一个项目一套，落在 03评估底稿/管理类底稿/<分类>。
    // 基础类资料：每家公司一套，跟着模板走到 02现场资料/企业提供资料/02基础类/<公司>/<分类>
    //（分类在前、公司在后，跟 03资产基础法/<公司>/<科目> 一致）。
    const BASIC_CATEGORIES = [];
    BASIC_CATALOG.forEach(it => { if (it[1] && BASIC_CATEGORIES.indexOf(it[0]) < 0) BASIC_CATEGORIES.push(it[0]); });
    const segSafe = s => String(s == null ? '' : s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
    // 管理类底稿目录：03评估底稿 下（跟 一级复核 / 二级复核 / 三级复核 / 送签发 并列）
    const MGMT_FOLDER = '03评估底稿/管理类底稿';
    const catalogFolder = (kind, cat, company) => (kind === 'mgmt'
      ? MGMT_FOLDER + '/' + cat
      : '02现场资料/企业提供资料/02基础类/' + (segSafe(company) || '未命名公司') + '/' + cat);
    // 财务类资料：每家公司一套（00财务资料/<公司>）
    const financeFolderOf = company => '02现场资料/企业提供资料/00财务资料/' + (segSafe(company) || '未命名公司');
    // 报表原件夹：客户给的各期报表放这里，「从「01财务报表」导入」就扫这个夹
    // （夹名与 folders.js 的 FIN_STATEMENT_DIR 必须一致）
    const financeStatementsFolderOf = company => financeFolderOf(company) + '/01财务报表';
    // 扫描结果的汇总口径（认出几张报表 / 各有哪些年度）。
    // AI 兜底把新认出的期并进来后要重算一次，否则卡片标题还写着旧的张数。
    function fsScanSummary(packs, fileCount) {
      const bal = []; const inc = [];
      (packs || []).forEach(p => {
        const y = Number(p.year);
        if (!y) return;
        const arr = p.statementType === 'income_statement' ? inc : bal;
        if (arr.indexOf(y) < 0) arr.push(y);
      });
      return {
        fileCount: Number(fileCount) || 0,
        packCount: (packs || []).length,
        balanceYears: bal.sort((a, b) => a - b),
        incomeYears: inc.sort((a, b) => a - b),
      };
    }
    // 基础类资料：每家公司一套（02基础类/<公司>，里面再分 4 个分类）
    const basicFolderOf = company => '02现场资料/企业提供资料/02基础类/' + (segSafe(company) || '未命名公司');

    function eqSeed(project) {
      const p = normalizeProject(project || {});
      const nm = (p.entity && p.entity.name) || p.shortName || p.name || '被评估单位';
      const sh = p.shortName || guessShortName(nm);
      const ratio = String(p.equityRatio == null || p.equityRatio === '' ? '100' : p.equityRatio);
      return [{
        id: 'root', parentId: '', name: nm, short: sh, ratio: ratio,
        // 公司负责人不预填团队人员（以前会把项目经理/成员整个带上来，看着像「有默认人员」）；
        // 由「设置公司责任人」显式勾选后再写进来。
        // 科目名称：母公司（顶层、没有上级母公司）不填 —— 那是「母公司对子公司」的持股科目，
        // 只属于子公司那一行，由「添加子公司 / 批量导入」里录。
        subject: '', manager: '',
        methods: { whole: [], part: [] }, shareholders: [],
      }];
    }

    // 编码按股权树编号（1 / 1-1 / 1-1-2），父节点不在列表里的当顶层，环状关系直接截断。
    function eqRows(list) {
      const arr = Array.isArray(list) ? list : [];
      const byId = {};
      arr.forEach(c => { if (c && c.id) byId[c.id] = c; });
      const kids = {};
      arr.forEach(c => {
        if (!c || !c.id) return;
        const pid = c.parentId && byId[c.parentId] && c.parentId !== c.id ? c.parentId : '';
        const bucket = kids[pid] || (kids[pid] = []);
        bucket.push(c);
      });
      const out = [];
      const seen = {};
      const walk = (pid, prefix, depth) => {
        if (depth > 12) return;
        (kids[pid] || []).forEach((c, i) => {
          if (seen[c.id]) return;
          seen[c.id] = 1;
          const code = prefix ? prefix + '-' + (i + 1) : String(i + 1);
          const item = Object.assign({}, c, { code: code, depth: depth });
          out.push(item);
          walk(c.id, code, depth + 1);
        });
      };
      walk('', '', 0);
      arr.forEach(c => {
        if (!c || !c.id || seen[c.id]) return;
        seen[c.id] = 1;
        out.push(Object.assign({}, c, { code: String(out.length + 1), depth: 0 }));
      });
      return out;
    }

    // 科目名称 = 「上级母公司用哪个科目持有这家公司」，所以只有子公司有；
    // 母公司（顶层、parentId 空 / 指向自己 / 父节点不在列表里）一律不填。
    function eqSubjectOf(r, byId) {
      if (!r) return '';
      const pid = r.parentId && byId && byId[r.parentId] && r.parentId !== r.id ? r.parentId : '';
      return pid ? String(r.subject || '') : '';
    }
    function eqById(list) {
      const m = {};
      (Array.isArray(list) ? list : []).forEach(c => { if (c && c.id) m[c.id] = c; });
      return m;
    }

    const eqMethodText = c => {
      const m = (c && c.methods) || {};
      const a = Array.isArray(m.whole) ? m.whole : [];
      const b = Array.isArray(m.part) ? m.part : [];
      if (!a.length && !b.length) return '';
      return a.concat(b).join(' / ');
    };

    function eqUpdate(pid, fn) {
      patch('work', w => {
        const eq = Object.assign({}, w.equity || {});
        const cur = (eq[pid] && eq[pid].companies) || [];
        eq[pid] = { companies: fn(cur) || [], updatedAt: new Date().toISOString() };
        return Object.assign({}, w, { equity: eq });
      });
    }

    // ---------- 财务资料：科目名 + 金额（给「资产基础法」科目目录挑子目录用） ----------
    // 只存「有金额」的科目；金额统一按字符串存，避免浮点误差把 0.01 变成 0.009999。
    const AB_TABLE = [
      ['01货币资金', '货币资金|库存现金|银行存款|其他货币资金'],
      ['02交易性金融资产', '交易性金融资产'],
      ['03应收票据', '应收票据'],
      ['04应收账款', '应收账款|应收帐款'],
      ['05预付款项', '预付款项|预付账款|预付帐款|预付'],
      ['06其他应收款', '其他应收款'],
      ['07存货', '存货|原材料|库存商品|在产品|半成品|周转材料|发出商品|委托加工物资|低值易耗品'],
      ['08合同资产', '合同资产'],
      ['09其他流动资产', '其他流动资产'],
      ['10长期股权投资', '长期股权投资'],
      ['11投资性房地产', '投资性房地产'],
      ['12固定资产', '固定资产'],
      ['13在建工程', '在建工程'],
      ['14使用权资产', '使用权资产'],
      ['15无形资产', '无形资产'],
      ['16研发支出', '研发支出|开发支出'],
      ['17长期待摊费用', '长期待摊费用'],
      ['18递延所得税资产', '递延所得税资产'],
      ['19其他非流动资产', '其他非流动资产'],
      ['20短期借款', '短期借款'],
      ['21交易性金融负债', '交易性金融负债'],
      ['22应付票据', '应付票据'],
      ['23应付账款', '应付账款|应付帐款'],
      ['24预收款项', '预收款项|预收账款|预收帐款'],
      ['25合同负债', '合同负债'],
      ['26应付职工薪酬', '应付职工薪酬|应付工资|应付福利费'],
      ['27应交税费', '应交税费|应交税金'],
      ['28其他应付款', '其他应付款'],
      ['29一年内到期的非流动负债', '一年内到期的非流动负债|一年内到期'],
      ['30其他流动负债', '其他流动负债'],
      ['31长期借款', '长期借款'],
      ['32递延收益', '递延收益'],
    ];

    const numOf = v => {
      if (v == null) return null;
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      let t = String(v).trim();
      if (!t) return null;
      let neg = false;
      if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
      t = t.replace(/[,，\s￥¥元]/g, '');
      if (!/^[-+]?\d+(\.\d+)?$/.test(t)) return null;
      const n = Number(t);
      return Number.isFinite(n) ? (neg ? -n : n) : null;
    };

    const finMapOf = s => (s && s.work && s.work.finance) || {};
    const finSubjects = (s, pid, cid) => {
      const p = finMapOf(s)[pid] || {};
      const c = (p.companies || {})[cid] || {};
      return Array.isArray(c.subjects) ? c.subjects : [];
    };
    // 有金额（非零）的科目在资产基础法里能对上哪些目录
    const abFoldersOf = subjects => {
      const rows = (Array.isArray(subjects) ? subjects : [])
        .map(x => ({ name: String((x && x.name) || '').trim(), amount: numOf(x && x.amount) }))
        .filter(x => x.name && x.amount != null && Math.abs(x.amount) > 0);
      const out = [];
      AB_TABLE.forEach(([fo, keys]) => {
        if (rows.some(r => keys.split('|').some(k => r.name.indexOf(k) >= 0))) out.push(fo);
      });
      return out;
    };

    function finUpdate(pid, cid, fn) {
      patch('work', w => {
        const all = Object.assign({}, w.finance || {});
        const proj = Object.assign({ companies: {} }, all[pid] || {});
        const comps = Object.assign({}, proj.companies || {});
        comps[cid] = { subjects: fn(((comps[cid] || {}).subjects) || []) || [], updatedAt: new Date().toISOString() };
        proj.companies = comps;
        all[pid] = proj;
        return Object.assign({}, w, { finance: all });
      });
    }

    // 把「公司 + 评估方法 + 有金额的科目」交给宿主，按模板建/补齐项目文件夹。
    // 幂等：已存在的目录不重建，返回新建/已存在条数。
    async function buildProjectFolders(project, s, toast, quiet) {
      const p = normalizeProject(project || {});
      const folder = folderNameOf(p);
      if (!folder && !projectAbs(p)) return { ok: false, error: '项目还没填项目编号 / 项目简称' };
      const list = eqListOf(s, p.id);
      const rows = eqRows(list.length ? list : eqSeed(p));
      // 新建项目时被评估单位还没填，种子行叫「被评估单位」——这种占位名不建 02基础类，
      // 否则会留一个「被评估单位」空目录，等真正填了名字再生成时又建一份正确的。
      const named = rows.filter(r => r.name && r.name !== '被评估单位');
      const companies = named.map(r => ({
        name: r.name,
        methods: r.methods || { whole: [], part: [] },
        subjects: finSubjects(s, p.id, r.id).map(x => ({ name: x.name, amount: x.amount })),
      }));
      return buildProjectFoldersFrom(p, companies, toast, quiet);
    }

    // 已经算好「公司 + 方法 + 科目」时的版本：设置评估方法 / 添加子公司的保存回调里，
    // 手上的 s 还是旧的（patch 还没回流），所以直接传算好的 companies 进去。
    async function buildProjectFoldersFrom(project, companies, toast, quiet) {
      const p = normalizeProject(project || {});
      const folder = folderNameOf(p);
      const abs = projectAbs(p);
      if (!folder && !abs) return { ok: false, error: '项目还没填项目编号 / 项目简称' };
      const r = await fetch(PREFIX + '/project/folders/build', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: folder, abs: abs, companies: companies }),
      });
      if (r.status === 404) throw new Error('宿主未重载，重启 DSH 后可用');
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
      if (!quiet && toast) toast('项目文件夹已按模板对齐：新建 ' + d.created + ' 个目录（已存在 ' + d.existed + '）', 'info');
      return d;
    }


    function AddCompanyDialog({ rows, onClose, onSave }) {
      // 只往上挂在被评估单位这一棵树上：默认第一行就是被评估单位（code 1），
      // 要挂到某一层子公司下面，把「上级母公司1」改成那家公司即可。
      const root = rows.filter(r => r.depth === 0)[0] || rows[0] || null;
      const blank = pid => ({ parentId: pid || '', ratio: '100', subject: EQUITY_SUBJECTS[0] });
      const [f, setF] = useState({ name: '', short: '' });
      const [sh, setSh] = useState([blank(root && root.id)]);
      const [err, setErr] = useState('');
      const set = k => e => setF(Object.assign({}, f, { [k]: e.target.value }));
      const patch = (i, k, v) => { const n = sh.slice(); n[i] = Object.assign({}, n[i], { [k]: v }); setSh(n); };
      const addRow = () => setSh(sh.concat([blank('')]));
      const delRow = i => setSh(sh.filter((x, j) => j !== i));
      const parentSel = (i) => h('select', { className: 'pf-sel', value: sh[i].parentId, onChange: e => patch(i, 'parentId', e.target.value) },
        h('option', { value: '' }, '请选择上级母公司'),
        rows.map(r => h('option', { key: r.id, value: r.id }, r.code + ' ' + r.name)));
      const submit = () => {
        if (!f.name.trim()) { setErr('请填写公司名称'); return; }
        if (!f.short.trim()) { setErr('请填写公司简称'); return; }
        for (let i = 0; i < sh.length; i += 1) {
          const x = sh[i];
          if (!x.parentId) { setErr('请选择「上级母公司' + (i + 1) + '」'); return; }
          if (!String(x.ratio).trim()) { setErr('请填写「股权比例' + (i + 1) + '%」'); return; }
          if (!x.subject) { setErr('请选择「科目名称' + (i + 1) + '」'); return; }
        }
        const primary = sh[0];
        onSave({
          name: f.name.trim(), short: f.short.trim(),
          parentId: primary.parentId, ratio: String(primary.ratio).trim(), subject: primary.subject,
          // 第一行是主股东（决定挂在谁下面），其余行只记股权结构
          shareholders: sh.map(x => ({ parentId: x.parentId, ratio: String(x.ratio).trim(), subject: x.subject })),
        });
      };
      const cells = [];
      sh.forEach((x, i) => {
        cells.push(h('label', { key: 'p' + i }, h('span', null, h('i', { className: 'pw-req' }, '*'), '上级母公司' + (i + 1)),
          h('div', { className: 'pw-inline' },
            parentSel(i),
            i === 0
              ? h('button', { type: 'button', className: 'pf-btn sm pri', onClick: addRow }, '新增股东')
              : h('button', { type: 'button', className: 'pf-btn sm danger', onClick: () => delRow(i) }, '删除'))));
        cells.push(h('label', { key: 'r' + i }, h('span', null, h('i', { className: 'pw-req' }, '*'), '股权比例' + (i + 1) + '%'),
          h('input', { className: 'pf-in', type: 'number', step: '0.0001', min: '0', max: '100', value: x.ratio, onChange: e => patch(i, 'ratio', e.target.value), placeholder: '请输入股权比例' })));
        cells.push(h('label', { key: 's' + i }, h('span', null, h('i', { className: 'pw-req' }, '*'), '科目名称' + (i + 1)),
          h('select', { className: 'pf-sel', value: x.subject, onChange: e => patch(i, 'subject', e.target.value) },
            EQUITY_SUBJECTS.map(s => h('option', { key: s, value: s }, s)))));
      });
      return h(Modal, { title: '添加子公司', onClose: onClose },
        h('p', { className: 'pw-hint' }, '可添加被评估单位下属各级子公司'),
        h('div', { className: 'pw-form' },
          h('label', null, h('span', null, h('i', { className: 'pw-req' }, '*'), '公司名称'), h('input', { className: 'pf-in', value: f.name, onChange: set('name'), placeholder: '请输入公司名称', autoFocus: true })),
          h('label', null, h('span', null, h('i', { className: 'pw-req' }, '*'), '公司简称'), h('input', { className: 'pf-in', value: f.short, onChange: set('short'), placeholder: '请输入公司简称' })),
          cells),
        err ? h('div', { className: 'pw-err' }, err) : null,
        h('div', { className: 'pw-foot' },
          h('button', { type: 'button', className: 'pf-btn', onClick: onClose }, '取消'),
          h('button', { type: 'button', className: 'pf-btn pri', onClick: submit }, '保存')));
    }

    function MethodDialog({ rows, ids, onClose, onSave }) {
      const first = rows.filter(r => ids.indexOf(r.id) >= 0)[0] || {};
      const fm = first.methods || {};
      const [whole, setWhole] = useState((fm.whole || []).slice());
      const [part, setPart] = useState((fm.part || []).slice());
      const names = rows.filter(r => ids.indexOf(r.id) >= 0).map(r => r.name);
      const flip = (arr, setArr) => v => setArr(arr.indexOf(v) >= 0 ? arr.filter(x => x !== v) : arr.concat([v]));
      const box = (arr, setArr) => list => h('div', { className: 'pw-checks' }, list.map(v => h('label', { key: v, className: 'pw-check' },
        h('input', { type: 'checkbox', checked: arr.indexOf(v) >= 0, onChange: () => flip(arr, setArr)(v) }), v)));
      return h(Modal, { title: '设置评估方法', onClose: onClose },
        h('p', { className: 'pw-hint' }, '已选 ' + ids.length + ' 家公司：' + names.slice(0, 6).join('、') + (names.length > 6 ? ' 等' : '')),
        h('div', { className: 'pw-sec-t' }, '整体评估'), box(whole, setWhole)(WHOLE_METHODS),
        h('div', { className: 'pw-sec-t' }, '非整体评估'), box(part, setPart)(PART_METHODS),
        h('div', { className: 'pw-foot' },
          h('button', { type: 'button', className: 'pf-btn', onClick: onClose }, '取消'),
          h('button', { type: 'button', className: 'pf-btn pri', onClick: () => onSave({ whole: whole, part: part }) }, '确定')));
    }

    function ManagerDialog({ rows, ids, project, onClose, onSave }) {
      // 负责人可以多人；候选人只来自本项目团队（项目经理 / 成员），不预置任何人，
      // 已设过的人从当前公司带出来（没设过就是空，不再默认任何人）。
      const t = (project && project.team) || {};
      const pool = [];
      [].concat(t.managers || [], [t.manager], t.members || []).forEach(x => { if (x && pool.indexOf(x) < 0) pool.push(x); });
      const first = rows.filter(r => ids.indexOf(r.id) >= 0)[0] || {};
      const before = nameList(first.manager);
      // 一律不预选：以前拿现有值当默认，看起来像「有默认人员」，用户明确要删掉这个默认。
      // 现有值只作为提示行显示，要保留就自己勾。
      const [picked, setPicked] = useState([]);
      const [custom, setCustom] = useState(before.filter(n => pool.indexOf(n) < 0));
      const [extra, setExtra] = useState('');
      const all = pool.concat(custom.filter(n => pool.indexOf(n) < 0));
      const toggle = n => setPicked(picked.indexOf(n) >= 0 ? picked.filter(x => x !== n) : picked.concat([n]));
      const addExtra = () => {
        const n = extra.trim();
        if (!n) return;
        if (picked.indexOf(n) < 0) setPicked(picked.concat([n]));
        if (pool.indexOf(n) < 0 && custom.indexOf(n) < 0) setCustom(custom.concat([n]));
        setExtra('');
      };
      return h(Modal, { title: '设置公司责任人', onClose: onClose },
        h('p', { className: 'pw-hint' }, '已选 ' + ids.length + ' 家公司；公司负责人可以多人，勾几个就由这几个人一起负责。'),
        h('div', { className: 'pw-form' },
          h('label', null, h('span', null, '公司负责人'),
            all.length
              ? h('div', { className: 'pw-checks' }, all.map(n => h('label', { key: n, className: 'pw-check' },
                h('input', { type: 'checkbox', checked: picked.indexOf(n) >= 0, onChange: () => toggle(n) }), n)))
              : h('span', { className: 'pf-hint' }, '项目团队里还没有人，可在下面直接输入姓名')),
          h('label', null, h('span', null, '其他人员'),
            h('div', { className: 'pw-inline' },
              h('input', { className: 'pf-in', value: extra, placeholder: '输入姓名', onChange: e => setExtra(e.target.value), onKeyDown: e => { if (e.key === 'Enter') { e.preventDefault(); addExtra(); } } }),
              h('button', { type: 'button', className: 'pf-btn sm', onClick: addExtra }, '加入')))),
        before.length ? h('p', { className: 'pf-hint' }, '原负责人：' + before.join('、') + '（不勾选就会被替换）') : null,
        h('p', { className: 'pf-hint' }, picked.length ? '本次将设为：' + picked.join('、') : '还没选人'),
        h('div', { className: 'pw-foot' },
          h('button', { type: 'button', className: 'pf-btn', onClick: onClose }, '取消'),
          h('button', { type: 'button', className: 'pf-btn pri', onClick: () => { if (!picked.length) return; onSave(picked.join('、')); } }, '确定')));
    }

    function ImportDialog({ project, onClose, onDone, toast }) {
      const [file, setFile] = useState(null);
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState('');
      const [rows, setRows] = useState(null);
      const downloadTemplate = async () => {
        try {
          const r = await fetch(PREFIX + '/project/equity/template');
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const blob = await r.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = '公司导入模板.xlsx';
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
          toast('模板已开始下载', 'info');
        } catch (e) {
          toast('下载模板失败：' + ((e && e.message) || e) + '（宿主未重载时需重启 DSH）', 'warn');
        }
      };
      const parse = async () => {
        if (!file) { setErr('请先选择要导入的文件'); return; }
        setBusy(true); setErr('');
        try {
          const buf = await file.arrayBuffer();
          const r = await fetch(PREFIX + '/project/equity/import?name=' + encodeURIComponent(file.name) + '&folder=' + encodeURIComponent(folderNameOf(project)), {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf,
          });
          if (r.status === 404) throw new Error('宿主未注册导入路由，重启 DSH 后可用');
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
          const list = d.rows || [];
          if (!list.length) throw new Error('没有解析到数据：表头需要有「公司名称」「上级母公司」「认缴持股比例%」「科目名称」');
          setRows(list);
        } catch (e) {
          setErr(String((e && e.message) || e));
        } finally { setBusy(false); }
      };
      return h(Modal, { title: '批量导入', onClose: onClose },
        h('div', { className: 'pw-form' },
          h('label', null, h('span', null, h('i', { className: 'pw-req' }, '*'), '导入文件'),
            h('input', { type: 'file', accept: '.xlsx,.xls,.csv', onChange: e => { setFile(e.target.files && e.target.files[0] || null); setRows(null); setErr(''); } })),
          h('label', null, h('span', null, '导入模板'),
            h('div', { className: 'pw-inline' },
              h('button', { type: 'button', className: 'pf-btn sm', onClick: downloadTemplate }, '下载模板'),
              h('span', { className: 'pf-hint' }, '表头：公司名称 / 公司简称 / 上级母公司 / 认缴持股比例% / 科目名称'))),
          h('label', null, h('span', null, '项目文件夹'),
            h('span', { className: 'pf-hint' }, folderNameOf(project)))),
        busy ? h('p', { className: 'pf-hint' }, '正在解析…') : null,
        err ? h('div', { className: 'pw-err' }, err) : null,
        rows ? h('div', null,
          h('p', { className: 'pf-hint' }, '解析到 ' + rows.length + ' 行：' + rows.slice(0, 4).map(r => r.name).join('、') + (rows.length > 4 ? ' 等' : '')),
          h('div', { className: 'pf-table-wrap' },
            h('table', { className: 'pf-grid pw-grid' },
              h('thead', null, h('tr', null, ['公司名称', '公司简称', '上级母公司', '股权比例%', '科目名称'].map((t, i) => h('th', { key: i }, t)))),
              h('tbody', null, rows.slice(0, 8).map((r, i) => h('tr', { key: i },
                h('td', null, r.name || '—'), h('td', null, r.short || '—'), h('td', null, r.parent || '—'),
                h('td', null, r.ratio === '' || r.ratio == null ? '—' : r.ratio),
                h('td', null, String(r.parent || '').trim() && r.subject ? r.subject : '—'))))))) : null,
        h('div', { className: 'pw-foot' },
          h('button', { type: 'button', className: 'pf-btn', onClick: onClose }, '取消'),
          rows
            ? h('button', { type: 'button', className: 'pf-btn pri', onClick: () => onDone(rows) }, '确认导入 ' + rows.length + ' 行')
            : h('button', { type: 'button', className: 'pf-btn pri', onClick: parse, disabled: busy }, busy ? '解析中…' : '确定')));
    }

    // 项目级未分配资料：只复制到公司目录，不解析报表、不操作天源。
    function UnallocatedFinance({ project, rows, toast, openSub }) {
      const categories = ['01财务报表', '02审计报告', '02科目余额表', '03辅助余额表', '04序时账'];
      const [data, setData] = useState(null);
      const [choices, setChoices] = useState({});
      const [preview, setPreview] = useState(null);
      const [results, setResults] = useState(null);
      const [ownership, setOwnership] = useState(null);
      const [folderChoices, setFolderChoices] = useState({});
      const [pending, setPending] = useState(false);
      const [inited, setInited] = useState(false);
      const [busy, setBusy] = useState('');
      const busyRef = useRef(false);
      const alive = useRef(true);
      const context = useRef(null);
      context.current = { id: String(project.id), abs: projectAbs(project) };
      useEffect(() => { setInited(false); setOwnership(null); setFolderChoices({}); }, [project.id, context.current.abs]);
      const companies = () => eqRows(eqListOf(store.get(), project.id)).map(r => ({ id: String(r.id), name: String(r.name || '') }));
      useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
      useEffect(() => {
        if (!pending) return;
        const warn = e => { e.preventDefault(); e.returnValue = ''; };
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
      }, [pending]);
      const post = async (route, body, allowError) => {
        if (!projectAbs(project) || body.abs !== projectAbs(project)) throw new Error('项目尚未绑定真实目录，请先绑定项目文件夹');
        const r = await fetch(PREFIX + '/project/finance/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({}, body, { projectId: String(project.id) })) });
        const d = await r.json().catch(() => ({}));
        if (r.status === 404) throw new Error('接口不可用，请重启宿主后重试');
        if ((!r.ok || !d.ok) && !allowError) throw new Error(d.error || ('HTTP ' + r.status));
        if (!r.ok && !Array.isArray(d.results) && !Array.isArray(d.items)) throw new Error(d.error || ('HTTP ' + r.status));
        return d;
      };
      const run = async (label, fn) => {
        if (busyRef.current) return;
        busyRef.current = true; setBusy(label);
        try { await fn(); } catch (e) { if (alive.current) toast('未分配资料操作失败：' + String(e.message || e), 'warn'); }
        finally { busyRef.current = false; if (alive.current) setBusy(''); }
      };
      const currentContext = () => ({ id: String(project.id), abs: projectAbs(project) });
      const checkContext = (snapshot, cs) => {
        if (!alive.current || JSON.stringify(snapshot) !== JSON.stringify(context.current) || JSON.stringify(cs) !== JSON.stringify(companies())) throw new Error('项目或公司名单发生变化，请重新扫描');
      };
      const readOwnership = async (snapshot, cs) => {
        const d = await post('unallocated-ownership', { abs: snapshot.abs });
        checkContext(snapshot, cs);
        if (!Array.isArray(d.rows) || !Array.isArray(d.folders) || d.folders.some(x => typeof x !== 'string')) throw new Error('目录归属响应不完整');
        setOwnership({ rows: d.rows, folders: d.folders, context: snapshot, companies: cs });
        setFolderChoices({});
      };
      const loadOwnership = () => run('ownership', async () => {
        setPreview(null); setOwnership(null);
        const snapshot = currentContext(), cs = companies();
        await readOwnership(snapshot, cs);
      });
      const bindOwnership = row => run('bind', async () => {
        setPreview(null);
        const snapshot = currentContext(), cs = companies();
        if (!ownership || JSON.stringify(ownership.context) !== JSON.stringify(snapshot) || JSON.stringify(ownership.companies) !== JSON.stringify(cs)) throw new Error('项目或公司名单已变化，请重新读取归属');
        const folder = folderChoices[String(row.companyId)];
        if (!folder || !ownership.folders.includes(folder)) throw new Error('请明确选择已有目录');
        const sep = snapshot.abs.includes('\\') ? '\\' : '/';
        const target = snapshot.abs.replace(/[\\\\/]+$/, '') + sep + ['02现场资料', '企业提供资料', '00财务资料', folder].join(sep);
        if (!window.confirm('确认将以下已有目录绑定给该公司？不会复制或移动文件。\n公司：' + row.name + '\n目录：' + target)) return;
        checkContext(snapshot, cs);
        setOwnership(null); setFolderChoices({});
        try {
          await post('unallocated-bind', { abs: snapshot.abs, companyId: String(row.companyId), folder, confirmText: '确认绑定公司目录' });
        } finally {
          if (alive.current && JSON.stringify(snapshot) === JSON.stringify(context.current)) await readOwnership(snapshot, cs);
        }
      });
      const confirmOwnershipRename = row => run('confirm-rename', async () => {
        setPreview(null);
        const snapshot = currentContext(), cs = companies();
        if (!ownership || JSON.stringify(ownership.context) !== JSON.stringify(snapshot) || JSON.stringify(ownership.companies) !== JSON.stringify(cs)) throw new Error('项目或公司名单已变化，请重新读取归属');
        if (row.status !== 'name_changed' || !row.folder || !row.recordedName || !row.name) throw new Error('更名信息不完整，请重新读取归属');
        const sep = snapshot.abs.includes('\\') ? '\\' : '/';
        const target = snapshot.abs.replace(/[\\/]+$/, '') + sep + ['02现场资料', '企业提供资料', '00财务资料', row.folder].join(sep);
        if (!window.confirm('确认这是同一家公司更名，原目录归属不变？不会重命名目录或搬迁文件。\n原名称：' + row.recordedName + '\n新名称：' + row.name + '\n现有目录：' + target)) return;
        checkContext(snapshot, cs);
        setOwnership(null); setFolderChoices({});
        try {
          await post('unallocated-reconfirm-name', { abs: snapshot.abs, companyId: String(row.companyId), folder: row.folder, expectedName: row.recordedName, currentName: row.name, confirmText: '确认更新公司目录归属名称' });
        } finally {
          if (alive.current && JSON.stringify(snapshot) === JSON.stringify(context.current)) await readOwnership(snapshot, cs);
        }
      });
      const confirmFolderIdentity = row => run('confirm-folder-identity', async () => {
        setPreview(null);
        const snapshot = currentContext(), cs = companies();
        if (!ownership || JSON.stringify(ownership.context) !== JSON.stringify(snapshot) || JSON.stringify(ownership.companies) !== JSON.stringify(cs)) throw new Error('项目或公司名单已变化，请重新读取归属');
        if (!['identity_unverified', 'folder_changed'].includes(row.status) || !row.folder || !row.recordedName || !row.name) throw new Error('目录身份信息不完整，请重新读取归属');
        const sep = snapshot.abs.includes('\\') ? '\\' : '/';
        const target = snapshot.abs.replace(/[\\/]+$/, '') + sep + ['02现场资料', '企业提供资料', '00财务资料', row.folder].join(sep);
        if (!window.confirm('目录身份无法自动证明，旧文件可能不属于该公司。请先核实目录内容与公司身份。确认只更新目录身份指纹，不会移动文件。\n公司：' + row.name + '\n清单记录名称：' + row.recordedName + '\n完整目录：' + target + (row.recordedName !== row.name ? '\n公司名称也已变更；确认身份后仍需另行确认更名。' : ''))) return;
        checkContext(snapshot, cs);
        setOwnership(null); setFolderChoices({});
        try {
          await post('unallocated-confirm-folder-identity', { abs: snapshot.abs, companyId: String(row.companyId), folder: row.folder, expectedName: row.recordedName, currentName: row.name, confirmText: '确认该公司目录身份' });
        } finally {
          if (alive.current && JSON.stringify(snapshot) === JSON.stringify(context.current)) await readOwnership(snapshot, cs);
        }
      });
      const rebindMissingOwnership = row => run('rebind-missing', async () => {
        setPreview(null);
        const snapshot = currentContext(), cs = companies();
        if (!ownership || JSON.stringify(ownership.context) !== JSON.stringify(snapshot) || JSON.stringify(ownership.companies) !== JSON.stringify(cs)) throw new Error('项目或公司名单已变化，请重新读取归属');
        const folder = folderChoices[String(row.companyId)];
        if (row.status !== 'folder_missing' || !row.folder || !folder || !ownership.folders.includes(folder)) throw new Error('请明确选择已有目录');
        if (row.recordedName !== row.name) throw new Error('公司名称同时发生变化，请先核实身份后处理');
        const sep = snapshot.abs.includes('\\') ? '\\' : '/';
        const base = snapshot.abs.replace(/[\\/]+$/, '') + sep + ['02现场资料', '企业提供资料', '00财务资料'].join(sep) + sep;
        if (!window.confirm('确认原目录缺失并为该公司重新绑定已有目录？不会移动或复制文件。\n公司：' + row.name + '\n原目录：' + base + row.folder + '\n新目录：' + base + folder)) return;
        checkContext(snapshot, cs);
        setOwnership(null); setFolderChoices({});
        try {
          await post('unallocated-rebind-missing', { abs: snapshot.abs, companyId: String(row.companyId), previousFolder: row.folder, folder, confirmText: '确认原目录缺失并重新绑定' });
        } finally {
          if (alive.current && JSON.stringify(snapshot) === JSON.stringify(context.current)) await readOwnership(snapshot, cs);
        }
      });
      const init = () => run('init', async () => {
        const snapshot = currentContext();
        const d = await post('unallocated-init', { abs: snapshot.abs });
        if (!alive.current || JSON.stringify(snapshot) !== JSON.stringify(context.current)) return;
        setInited(true);
        toast((d.created ? '未分配资料目录已创建' : '未分配资料目录已存在') + (d.dir ? '：' + d.dir : ''), 'info');
        await openSub('00财务资料/00未分配财务资料');
      });
      const scan = () => {
        if (busyRef.current) return;
        if (pending && !window.confirm('重新扫描将放弃未执行的选择和预演，继续吗？')) return;
        run('scan', async () => {
          const snapshot = currentContext(), cs = companies();
          const d = await post('unallocated-scan', { abs: snapshot.abs, companies: cs });
          checkContext(snapshot, cs);
          if (!Array.isArray(d.files)) throw new Error('扫描响应缺少文件列表');
          setData({ response: d, companies: cs, context: snapshot }); setChoices({}); setPreview(null); setResults(null); setPending(true);
        });
      };
      const selected = () => {
        if (!data) throw new Error('请先扫描');
        const files = data.response.files.filter(f => (choices[String(f.id)] || {}).checked);
        if (!files.length) throw new Error('请勾选要分配的文件');
        const ids = new Set(), names = new Set();
        return files.map(f => {
          const c = choices[String(f.id)] || {};
          if (!f.id || ids.has(String(f.id)) || !f.name || names.has(f.name) || !f.sourceHash || f.error || !data.companies.some(x => x.id === c.companyId) || !categories.includes(c.category)) throw new Error('文件不可用或缺少明确公司、类别，请核对选择');
          ids.add(String(f.id)); names.add(f.name);
          return { name: f.name, sourceHash: f.sourceHash, companyId: c.companyId, category: c.category };
        });
      };
      const validatePreview = (d, items) => {
        if (!Array.isArray(d.items) || !Array.isArray(d.errors) || d.items.length !== items.length) throw new Error('预演返回不完整，已阻止执行');
        const expected = items.map(x => JSON.stringify(x)).sort();
        const returned = d.items.map(x => JSON.stringify({ name: x.name, sourceHash: x.sourceHash, companyId: x.companyId, category: x.category })).sort();
        if (JSON.stringify(expected) !== JSON.stringify(returned)) throw new Error('预演项目与所选文件不一致，已阻止执行');
        if (!d.ok && !d.errors.length) d.errors = [d.error || '预演未通过'];
        const destinations = d.items.filter(x => x.destination).map(x => String(x.destination).replace(/\\/g, '/').toLowerCase());
        if (new Set(destinations).size !== destinations.length) d.errors = d.errors.concat(['预演目标重复，已阻止执行']);
        return d;
      };
      const requestPreview = async (items) => {
        checkContext(data.context, data.companies);
        const d = await post('unallocated-preview', { abs: data.context.abs, companies: data.companies, items }, true);
        checkContext(data.context, data.companies);
        return validatePreview(d, items);
      };
      const doPreview = () => run('preview', async () => {
        const items = selected(); const d = await requestPreview(items);
        setPreview({ response: d, items }); setResults(null);
      });
      const apply = () => run('apply', async () => {
        if (!preview) throw new Error('请先预演');
        const items = selected();
        if (JSON.stringify(items) !== JSON.stringify(preview.items)) throw new Error('选择已改变，请重新预演');
        const fresh = await requestPreview(items);
        if (JSON.stringify(fresh) !== JSON.stringify(preview.response)) { setPreview({ response: fresh, items }); throw new Error('重新预演结果已变化，请检查新清单后再次确认'); }
        if (fresh.errors.length || fresh.items.some(x => x.error || !x.destination)) throw new Error('预演发现冲突或目标不明，禁止分配');
        if (!window.confirm('确认按预演清单复制 ' + items.length + ' 个文件？源文件保留，不覆盖已有文件；可能部分成功。')) return;
        checkContext(data.context, data.companies);
        let d;
        try { d = await post('unallocated-apply', { abs: data.context.abs, companies: data.companies, items, confirmText: '确认分配财务资料' }, true); }
        catch (e) { if (alive.current) { setPreview(null); setResults({ results: [], error: '执行状态不明，可能部分成功；请检查目标目录，勿盲目重试：' + String(e.message || e) }); } return; }
        if (!alive.current) return;
        if (!Array.isArray(d.results)) throw new Error('执行结果不完整；状态不明，请先检查目标目录，不要盲目重试');
        setResults({ ok: !!d.ok, results: d.results, error: d.error || '' }); setPreview(null); setPending(false);
        toast('分配已返回，请逐项核对结果；可能部分成功，源文件保留。', 'info');
      });
      const change = (id, value) => { setChoices(prev => Object.assign({}, prev, { [id]: Object.assign({}, prev[id] || {}, value) })); setPreview(null); setPending(true); };
      return h('div', { className: 'pf-card', style: { margin: '10px 0' } },
        h('b', null, '未分配财务资料'),
        h('p', { className: 'pf-hint' }, '项目级目录内文件需逐项勾选并明确选择公司和类别，识别建议仅供参考。分配只复制文件，保留源文件，不覆盖，不解析或写入天源。'),
        h('fieldset', { disabled: !!busy, style: { border: 0, padding: 0, margin: 0, minWidth: 0 } },
          h('div', { className: 'pf-card' },
            h('b', null, '公司目录归属'),
            h('p', { className: 'pf-hint' }, '旧目录不会按名称自动认领；请核对目录内容和公司身份后逐项绑定。未绑定或名称变更时请先处理归属，不会自动复制文件。'),
            h('button', { type: 'button', className: 'pf-btn', onClick: loadOwnership }, '读取公司目录归属'),
            ownership && JSON.stringify(ownership.context) === JSON.stringify(currentContext()) && JSON.stringify(ownership.companies) === JSON.stringify(companies())
              ? h('div', { className: 'pf-table-wrap' }, h('table', { className: 'pf-grid pw-grid' },
                  h('thead', null, h('tr', null, ['公司', '归属状态', '已绑定目录', '手动选择已有目录'].map(x => h('th', { key: x }, x)))),
                  h('tbody', null, ownership.rows.map(row => h('tr', { key: String(row.companyId) },
                    h('td', null, row.name, '（ID：', String(row.companyId), '）', row.recordedName && row.recordedName !== row.name ? '；原名称：' + row.recordedName : ''),
                    h('td', null, ({ bound: '已绑定', unbound: '未绑定', name_changed: '名称已变更，需核实', folder_missing: '目录缺失', identity_unverified: '目录身份未验证', folder_changed: '目录身份已变化，需核实' })[row.status] || String(row.status || '未知')),
                    h('td', null, row.folder ? ownership.context.abs.replace(/[\\/]+$/, '') + '/02现场资料/企业提供资料/00财务资料/' + row.folder : '未绑定'),
                    h('td', null, row.status === 'name_changed'
                      ? h('button', { type: 'button', className: 'pf-btn', onClick: () => confirmOwnershipRename(row) }, '核实并确认更名')
                      : ['identity_unverified', 'folder_changed'].includes(row.status)
                        ? h('button', { type: 'button', className: 'pf-btn', onClick: () => confirmFolderIdentity(row) }, '核实并确认目录身份')
                      : row.status === 'unbound' || row.status === 'folder_missing' ? h('span', null,
                        h('select', { className: 'pf-sel', value: folderChoices[String(row.companyId)] || '', onChange: e => { setPreview(null); setFolderChoices(prev => Object.assign({}, prev, { [String(row.companyId)]: e.target.value })); } },
                          h('option', { value: '' }, '请明确选择已有目录'), ownership.folders.map(folder => h('option', { key: folder, value: folder }, folder))),
                        h('button', { type: 'button', className: 'pf-btn', disabled: !folderChoices[String(row.companyId)], onClick: () => row.status === 'unbound' ? bindOwnership(row) : rebindMissingOwnership(row) }, row.status === 'unbound' ? '确认认领' : '确认缺失并重新绑定')) : '—'))))))
              : h('p', { className: 'pf-hint' }, '尚未读取归属或项目状态已变化，请先读取。')),
          inited
            ? h('div', { className: 'pw-acts', style: { alignItems: 'center' } },
              h('span', { className: 'pf-hint' }, '✅ 未分配财务资料目录已创建，可直接扫描分配。'),
              h('button', { type: 'button', className: 'pf-btn', onClick: init }, '打开未分配资料文件夹'))
            : h('button', { type: 'button', className: 'pf-btn', onClick: init }, '创建并打开未分配目录'),
          h('button', { type: 'button', className: 'pf-btn', onClick: scan }, data ? '重新扫描' : '扫描未分配目录'),
          busy ? h('span', { className: 'pf-hint' }, ' 操作进行中…') : null,
          data ? h('div', null,
            h('p', { className: 'pf-hint' }, '来源目录：' + (data.response.dir || '未返回') + '；勾选项将单独预演目标，已有目标文件或重复目标将拦截。'),
            h('div', { className: 'pf-table-wrap', style: { overflow: 'auto' } }, h('table', { className: 'pf-grid pw-grid' },
              h('thead', null, h('tr', null, ['选择', '文件 / 错误', '识别公司与证据', '识别类别与证据', '目标公司', '资料类别'].map(t => h('th', { key: t }, t)))),
              h('tbody', null, data.response.files.map((f, i) => {
                const id = String(f.id || ''), c = choices[id] || {}, co = f.company || {}, cl = f.classification || {};
                const suggestion = data.companies.find(x => x.id === String(co.suggestedCompany || ''));
                return h('tr', { key: id || i },
                  h('td', null, h('input', { type: 'checkbox', checked: !!c.checked, disabled: !!f.error || !id || !f.sourceHash, onChange: e => change(id, { checked: e.target.checked }) })),
                  h('td', null, f.name, f.error ? '；错误：' + f.error : ''),
                  h('td', null, '状态：' + (co.status || '未知') + '；建议：' + (suggestion ? suggestion.name : '无') + '；候选：' + JSON.stringify(co.candidates || []) + '；证据：' + JSON.stringify(co.evidence || [])),
                  h('td', null, '状态：' + (cl.status || '未知') + '；建议：' + (cl.suggestedFolder || '无') + '；候选：' + JSON.stringify(cl.candidates || []) + '；证据：' + JSON.stringify(cl.evidence || [])),
                  h('td', null, h('select', { className: 'pf-sel', value: c.companyId || '', disabled: !!f.error, onChange: e => change(id, { companyId: e.target.value }) }, h('option', { value: '' }, '请明确选择'), data.companies.map(x => h('option', { key: x.id, value: x.id }, x.name)))),
                  h('td', null, h('select', { className: 'pf-sel', value: c.category || '', disabled: !!f.error, onChange: e => change(id, { category: e.target.value }) }, h('option', { value: '' }, '请明确选择'), categories.map(x => h('option', { key: x, value: x }, x)))));
              })))),
            h('button', { type: 'button', className: 'pf-btn pri', onClick: doPreview }, '预演所选分配'),
            preview ? h('div', null, h('b', null, '预演清单（请核对来源、目标及冲突）'),
              (preview.response.errors || []).map((x, i) => h('p', { key: i, className: 'pf-hint', style: { color: '#c96a00' } }, typeof x === 'string' ? x : JSON.stringify(x))),
              h('div', { className: 'pf-table-wrap' }, h('table', { className: 'pf-grid pw-grid' }, h('thead', null, h('tr', null, ['来源', '目标', '冲突 / 错误'].map(t => h('th', { key: t }, t)))), h('tbody', null, preview.response.items.map((x, i) => h('tr', { key: i }, h('td', null, ((data.response.files || []).find(f => f.name === x.name) || {}).path || x.name), h('td', null, x.destination || '未返回'), h('td', null, x.error || '无')))))),
              h('button', { type: 'button', className: 'pf-btn pri', disabled: !!preview.response.errors.length || preview.response.items.some(x => x.error || !x.destination), onClick: apply }, '重新预演并确认分配')) : null) : null,
          results ? h('div', null, h('b', null, '逐项执行结果（可能部分成功）'), results.error ? h('p', null, results.error) : null, results.results.map((x, i) => h('p', { key: i, className: 'pf-hint' }, JSON.stringify(x))), h('p', { className: 'pf-hint' }, '执行后请核对目标文件；如状态不明请先检查，不要重复执行。')) : null));
    }

    function EquityPanel({ project, s, toast, openSub, onOpenCo, goFiles }) {
      const abs = projectAbs(project);
      const list = eqListOf(s, project.id);
      const rows = useMemo(() => eqRows(list), [list]);
      const eqIdx = useMemo(() => eqById(rows), [rows]);
      const [q, setQ] = useState({ name: '', parent: '', manager: '' });
      const [applied, setApplied] = useState({ name: '', parent: '', manager: '' });
      const [sel, setSel] = useState({});
      const [dlg, setDlg] = useState('');
      const [methodIds, setMethodIds] = useState([]);
      const [mgrIds, setMgrIds] = useState([]);
      const [busy, setBusy] = useState('');
      const selIds = Object.keys(sel).filter(k => sel[k]);

      useEffect(() => {
        if (list.length) return;
        eqUpdate(project.id, cur => (cur.length ? cur : eqSeed(project)));
      }, [project.id, list.length]);

      const parentNameOf = r => {
        if (!r.parentId) return '';
        const p = rows.filter(x => x.id === r.parentId)[0];
        return (p && p.name) || '';
      };
      const shown = rows.filter(r => {
        if (applied.name && String(r.name || '').indexOf(applied.name.trim()) < 0) return false;
        if (applied.parent && String(parentNameOf(r)).indexOf(applied.parent.trim()) < 0) return false;
        if (applied.manager && String(r.manager || '').indexOf(applied.manager.trim()) < 0) return false;
        return true;
      });

      const openMethod = ids => {
        const pick = ids || selIds;
        if (!pick.length) { toast('请先勾选要设置评估方法的公司（可多选）', 'warn'); return; }
        setMethodIds(pick);
        setDlg('method');
      };
      const openManager = () => {
        if (!selIds.length) { toast('请先勾选要设置责任人的公司（可多选）', 'warn'); return; }
        setMgrIds(selIds);
        setDlg('manager');
      };
      const saveMethod = m => {
        eqUpdate(project.id, cur => cur.map(c => (methodIds.indexOf(c.id) >= 0 ? Object.assign({}, c, { methods: m }) : c)));
        toast('已为 ' + methodIds.length + ' 家公司设置评估方法', 'info');
        setDlg('');
        // 方法一改，资产基础法 / 收益法 / 市场法 目录就跟着变，顺手同步（幂等，失败不打扰）
        const after = rows.map(r => ({
          name: r.name,
          methods: methodIds.indexOf(r.id) >= 0 ? m : (r.methods || { whole: [], part: [] }),
          subjects: finSubjects(s, project.id, r.id).map(x => ({ name: x.name, amount: x.amount })),
        })).filter(r => r.name && r.name !== '被评估单位');
        buildProjectFoldersFrom(project, after, toast, true).catch(() => {});
      };
      const saveManager = who => {
        eqUpdate(project.id, cur => cur.map(c => (mgrIds.indexOf(c.id) >= 0 ? Object.assign({}, c, { manager: who }) : c)));
        toast('已把 ' + mgrIds.length + ' 家公司的负责人设为 ' + who, 'info');
        setDlg('');
      };
      const saveCompany = f => {
        eqUpdate(project.id, cur => cur.concat([{
          id: uid(), parentId: f.parentId || '', name: f.name.trim(), short: f.short.trim(),
          ratio: String(f.ratio).trim(), subject: f.parentId ? f.subject : '', manager: '',
          methods: { whole: [], part: [] }, shareholders: f.shareholders || [],
        }]));
        toast('已添加子公司：' + f.name.trim(), 'info');
        setDlg('');
        // 新子公司先补一份它自己的财务类 + 基础类目录（方法还没设，只建到这两层，幂等）
        const after = rows.map(r => ({
          name: r.name,
          methods: r.methods || { whole: [], part: [] },
          subjects: finSubjects(s, project.id, r.id).map(x => ({ name: x.name, amount: x.amount })),
        })).filter(r => r.name && r.name !== '被评估单位')
          .concat([{ name: f.name.trim(), methods: { whole: [], part: [] }, subjects: [] }]);
        buildProjectFoldersFrom(project, after, toast, true).catch(() => {});
      };
      const importDone = list2 => {
        eqUpdate(project.id, cur => {
          const byName = {};
          cur.forEach(c => { byName[c.name] = c; });
          const added = [];
          list2.forEach(r => {
            const nm = String(r.name || '').trim();
            if (!nm) return;
            const pn = String(r.parent || '').trim();
            const pid = pn && byName[pn] ? byName[pn].id : '';
            const hit = byName[nm];
            if (hit) {
              const effPid = hit.parentId || pid;
              byName[nm] = Object.assign({}, hit, {
                ratio: r.ratio != null && r.ratio !== '' ? String(r.ratio) : hit.ratio,
                // 母公司（没有上级母公司）不填科目名称，表里带了也丢掉
                subject: effPid ? (r.subject || hit.subject || '') : '',
                short: r.short || hit.short,
                parentId: effPid,
              });
            } else {
              const c = {
                id: uid(), parentId: pid, name: nm, short: String(r.short || '').trim() || guessShortName(nm),
                ratio: r.ratio != null && r.ratio !== '' ? String(r.ratio) : '',
                subject: pid ? (r.subject || '') : '', manager: '', methods: { whole: [], part: [] }, shareholders: [],
              };
              byName[nm] = c;
              added.push(c);
            }
          });
          return cur.map(c => byName[c.name] || c).concat(added);
        });
        toast('已导入 ' + list2.length + ' 行股权信息', 'info');
        setDlg('');
      };
      const removeRow = r => {
        eqUpdate(project.id, cur => cur.filter(c => c.id !== r.id).map(c => (c.parentId === r.id ? Object.assign({}, c, { parentId: '' }) : c)));
        toast('已删除：' + r.name, 'warn');
      };
      return h('div', null,
        abs ? h('div', { className: 'pf-card', style: { margin: '0 0 10px' } },
          h('b', null, '开始前的目录设置'),
          h('p', { className: 'pf-hint' }, '进入项目先到「项目文件」页签完成：① 核对项目文件夹绑定；② 读取并绑定公司目录归属；③ 把未分配财务资料分配到各公司。完成后再回这里做股权信息、报表导入等作业。'),
          h('div', { className: 'pw-acts' },
            h('button', { type: 'button', className: 'pf-btn pri', onClick: () => goFiles && goFiles() }, '前往「项目文件」设置')))
        : h('div', { className: 'pf-card', style: { margin: '0 0 10px', borderColor: '#f0b4b4', background: '#fff7f7' } },
          h('b', null, '项目尚未绑定真实文件夹'),
          h('p', { className: 'pf-hint' }, '财务资料、未分配资料等功能都依赖真实目录。请先到「项目文件」页签绑定项目文件夹，再做其他作业。'),
          h('div', { className: 'pw-acts' },
            h('button', { type: 'button', className: 'pf-btn pri', onClick: () => goFiles && goFiles() }, '前往「项目文件」绑定'))),
        h('div', { className: 'pw-bar' },
          h('div', { className: 'pw-filters' },
            h('label', null, '公司名称', h('input', { className: 'pf-in', value: q.name, onChange: e => setQ(Object.assign({}, q, { name: e.target.value })), placeholder: '请输入公司名称' })),
            h('label', null, '上级母公司', h('input', { className: 'pf-in', value: q.parent, onChange: e => setQ(Object.assign({}, q, { parent: e.target.value })), placeholder: '请输入上级母公司' })),
            h('label', null, '公司负责人', h('input', { className: 'pf-in', value: q.manager, onChange: e => setQ(Object.assign({}, q, { manager: e.target.value })), placeholder: '请输入公司负责人' })),
            h('button', { type: 'button', className: 'pf-btn pri', onClick: () => setApplied(q) }, '查询'),
            h('button', { type: 'button', className: 'pf-btn', onClick: () => { const z = { name: '', parent: '', manager: '' }; setQ(z); setApplied(z); } }, '重置')),
          h('div', { className: 'pw-acts' },
            h('button', { type: 'button', className: 'pf-btn pri', onClick: () => setDlg('add') }, '添加子公司'),
            h('button', { type: 'button', className: 'pf-btn', onClick: () => setDlg('import') }, '批量导入'),
            h('button', { type: 'button', className: 'pf-btn', onClick: openManager }, '设置公司责任人'),
            h('button', { type: 'button', className: 'pf-btn', onClick: () => openMethod() }, '设置评估方法'),
            h('button', { type: 'button', className: 'pf-btn pri', disabled: busy === 'folders', onClick: async () => {
              setBusy('folders');
              try { await buildProjectFolders(project, s, toast); }
              catch (e) { toast('生成失败：' + ((e && e.message) || e) + (/404/.test(String(e && e.message)) ? '（宿主未重载，重启 DSH 后可用）' : ''), 'warn'); }
              finally { setBusy(''); }
            } }, busy === 'folders' ? '生成中…' : '生成项目文件夹'))),
        h('div', { className: 'pf-table-wrap' },
          h('table', { className: 'pf-grid pw-grid' },
            h('thead', null, h('tr', null,
              [h('input', {
                key: 'all', type: 'checkbox',
                checked: shown.length > 0 && shown.every(r => !!sel[r.id]),
                onChange: e => { const on = e.target.checked; const nx = Object.assign({}, sel); shown.forEach(r => { if (on) nx[r.id] = true; else delete nx[r.id]; }); setSel(nx); },
              })].concat(['编码', '公司名称', '公司简称', '上级母公司', '股权比例%', '科目名称', '公司负责人', '评估方法', '操作']).map((t, i) => h('th', { key: 'h' + i }, t)))),
            h('tbody', null, shown.length
              ? shown.map(r => h('tr', { key: r.id },
                h('td', null, h('input', {
                  type: 'checkbox', checked: !!sel[r.id],
                  onChange: e => { const nx = Object.assign({}, sel); if (e.target.checked) nx[r.id] = true; else delete nx[r.id]; setSel(nx); },
                })),
                h('td', { className: 'pf-mono' }, r.code),
                h('td', { style: { paddingLeft: 8 + r.depth * 18 } }, h('span', { className: 'pf-name' }, r.name)),
                h('td', null, r.short || '—'),
                h('td', null, parentNameOf(r) || '—'),
                h('td', null, r.ratio === '' || r.ratio == null ? '—' : r.ratio),
                h('td', null, eqSubjectOf(r, eqIdx) || '—'),
                h('td', null, r.manager || '—'),
                h('td', null, eqMethodText(r) || h('span', { className: 'pf-hint' }, '未设置')),
                h('td', null, h('div', { className: 'wb-row' },
                  h('button', { type: 'button', className: 'pf-btn sm', onClick: () => openMethod([r.id]) }, '设方法'),
                  // 财务类资料 / 基础类资料：进入这家公司自己的那套界面（不再是项目级页签）
                  h('button', { type: 'button', className: 'pf-btn sm', title: financeFolderOf(r.name), onClick: () => onOpenCo(r.id, 'fin') }, '财务资料'),
                  h('button', { type: 'button', className: 'pf-btn sm', title: basicFolderOf(r.name), onClick: () => onOpenCo(r.id, 'basic') }, '基础类资料'),
                  h('button', { type: 'button', className: 'pf-btn sm danger', onClick: () => removeRow(r) }, '删除')))))
              : h('tr', null, h('td', { colSpan: 10, className: 'pf-empty' }, list.length ? '没有符合条件的公司' : '还没有股权信息，点「添加子公司」或「批量导入」'))))),
        dlg === 'add' ? h(AddCompanyDialog, { rows: rows, onClose: () => setDlg(''), onSave: saveCompany }) : null,
        dlg === 'method' ? h(MethodDialog, { rows: rows, ids: methodIds, onClose: () => setDlg(''), onSave: saveMethod }) : null,
        dlg === 'manager' ? h(ManagerDialog, { rows: rows, ids: mgrIds, project: project, onClose: () => setDlg(''), onSave: saveManager }) : null,
        dlg === 'import' ? h(ImportDialog, { project: project, toast: toast, onClose: () => setDlg(''), onDone: importDone }) : null);
    }

    // 单家公司的财务类 / 基础类资料界面：从股权信息行内按钮进来，带「返回股权信息」。
    // 财务类：顶层是目录树（报表/科目余额表/辅助余额表/序时账/审计报告），「01财务报表」
    // 点进去才是报表导入功能页（扫描 → 解析 → 展示校验 → 确认写天源）。
    const CO_KIND_TEXT = { fin: '财务类资料', basic: '基础类资料' };
    const FIN_SUBDIRS = [
      ['01财务报表', '各期财务报表原件。点这里进「报表导入」：扫描识别 → 数据展示校验 → 确认写天源', true],
      ['02科目余额表', '各期科目余额表原件（含审计版）', false],
      ['03辅助余额表', '应收/应付/其他往来等辅助核算余额明细', false],
      ['04序时账', '序时账（明细账/日记账）原件', false],
      ['02审计报告', '事务所出具的审计报告', false],
    ];
    function CompanyMaterials({ project, s, toast, openSub, co, onBack }) {
      const rows = eqRows(eqListOf(s, project.id));
      // finSub：财务类资料的子页（''=目录树，'statements'=01财务报表里的报表导入功能页）
      const [finSub, setFinSub] = useState('');
      const cur = rows.filter(r => r.id === (co && co.id))[0] || null;
      const kind = (co && co.kind) === 'basic' ? 'basic' : 'fin';
      const back = h('button', { type: 'button', className: 'pf-btn sm', onClick: onBack }, '← 返回股权信息');
      if (!cur) {
        return h('div', null, back, h('p', { className: 'pf-hint' }, '这家公司已经不在了（可能被删掉了），返回股权信息重新选。'));
      }
      const folder = kind === 'fin' ? financeFolderOf(cur.name) : basicFolderOf(cur.name);
      const coBar = extra => h('div', { className: 'pw-co-bar' },
        back,
        h('span', { className: 'pw-co-title' }, h('b', { className: 'pf-mono' }, cur.code), h('span', { className: 'pw-co-name' }, cur.name)),
        h('span', { className: 'pf-hint' }, CO_KIND_TEXT[kind] + '（这家公司那一套）'),
        extra || null,
        h('button', { type: 'button', className: 'pf-btn', title: folder, onClick: () => openSub(folder) }, '打开文件夹'));
      // 报表导入功能页：只留一个「返回财务资料目录」——目录树本来就这一层，再叠一个
      // 「返回股权信息」是冗余的；要回股权信息先回目录，一键就能到。
      if (kind === 'fin' && finSub === 'statements') {
        return h('div', null,
          h('div', { className: 'pw-co-bar' },
            h('button', { type: 'button', className: 'pf-btn sm', onClick: () => setFinSub('') }, '← 返回财务资料目录'),
            h('span', { className: 'pw-co-title' }, h('b', { className: 'pf-mono' }, cur.code), h('span', { className: 'pw-co-name' }, cur.name)),
            h('span', { className: 'pf-hint' }, '报表导入（01财务报表）'),
            h('button', { type: 'button', className: 'pf-btn', title: folder + '/01财务报表', onClick: () => openSub(folder + '/01财务报表') }, '打开报表文件夹')),
          h(FinancePanel, { project: project, s: s, toast: toast, openSub: openSub, lockId: cur.id }));
      }
      return h('div', null,
        coBar(),
        h('p', { className: 'pf-hint pw-co-dir' }, '目录：' + folder),
        kind === 'fin'
          ? h('div', null,
            h('p', { className: 'pf-hint' }, '财务资料按下面几个子目录存放；「01财务报表」里的报表导入功能页负责把各期报表写进天源。'),
            h('table', { className: 'pf-grid pw-grid' },
              h('thead', null, h('tr', null, ['子目录', '放什么', '操作'].map((t, i) => h('th', { key: i }, t)))),
              h('tbody', null, FIN_SUBDIRS.map(([dir, desc, isEntry]) => h('tr', { key: dir },
                h('td', null, h('b', { className: 'pf-mono' }, dir)),
                h('td', null, desc),
                h('td', null,
                  isEntry
                    ? h('div', { className: 'wb-row' },
                      h('button', { type: 'button', className: 'pf-btn sm pri', onClick: () => setFinSub('statements') }, '打开报表导入'),
                      h('button', { type: 'button', className: 'pf-btn sm', title: folder + '/' + dir, onClick: () => openSub(folder + '/' + dir) }, '打开文件夹'))
                    : h('button', { type: 'button', className: 'pf-btn sm', title: folder + '/' + dir, onClick: () => openSub(folder + '/' + dir) }, '打开文件夹')))))))
          : h(CatalogPanel, { kind: 'basic', project: project, s: s, toast: toast, openSub: openSub, onlyId: cur.id }));
    }

    // ── 财务报表（资 / 利）导入：读审定报表里的「资」「利」两页，按天源科目对照后整单写入天源。
    // 单体 / 合并两套口径分开存；每套含资产负债表 + 利润表两份报表。
    const FS_TYPES = [
      { key: 'balance_sheet', name: '资产负债表', sheet: '资' },
      { key: 'income_statement', name: '利润表', sheet: '利' },
    ];
    // byYear：本地按年度存的多期数据（「01财务报表」一次扫出来的各个年度都放这里），
    // 上层字段（year/columns/rows/sheetData）始终指向最近一期，兼容老数据和单文件导入。
    const fsEmptyStmt = () => ({ statementType: '', sheet: '', year: '', unit: '元', period: '', columns: [], rows: [], sheetData: null, byYear: {} });
    const fsOf = (s, pid, cid, mode) => {
      const c = ((finMapOf(s)[pid] || {}).companies || {})[cid] || {};
      const all = c.statements || {};
      const box = all[String(mode)] || {};
      return {
        balance_sheet: Object.assign(fsEmptyStmt(), box.balance_sheet || {}),
        income_statement: Object.assign(fsEmptyStmt(), box.income_statement || {}),
        importedAt: box.importedAt || '',
        lastResult: box.lastResult || null,
        tyProjectId: c.tyProjectId || '',
        tyCompanyId: c.tyCompanyId || '',
        periods: Number(c.periods) || 0,   // 报表显示期数（1-6），0 = 还没设过，按 4 期（3 年 1 期）
        config: c.config || null,
      };
    };
    const fsUpdate = (pid, cid, mode, fn) => {
      patch('work', w => {
        const all = Object.assign({}, w.finance || {});
        const proj = Object.assign({ companies: {} }, all[pid] || {});
        const comps = Object.assign({}, proj.companies || {});
        const comp = Object.assign({ subjects: [] }, comps[cid] || {});
        const statements = Object.assign({}, comp.statements || {});
        const box = Object.assign({}, statements[String(mode)] || {});
        const next = fn(box) || {};
        statements[String(mode)] = Object.assign({}, box, next, { updatedAt: new Date().toISOString() });
        comps[cid] = Object.assign({}, comp, { statements: statements });
        proj.companies = comps;
        all[pid] = proj;
        return Object.assign({}, w, { finance: all });
      });
    };
    const fsTop = (pid, cid, fn) => {
      patch('work', w => {
        const all = Object.assign({}, w.finance || {});
        const proj = Object.assign({ companies: {} }, all[pid] || {});
        const comps = Object.assign({}, proj.companies || {});
        comps[cid] = Object.assign({ subjects: [] }, comps[cid] || {}, fn(Object.assign({ subjects: [] }, comps[cid] || {})) || {});
        proj.companies = comps;
        all[pid] = proj;
        return Object.assign({}, w, { finance: all });
      });
    };

    // /ty/call 返回可能是数组、{data:[...]} 或 {content:[{type:'text',text:'[...]'}]}，统一取出列表
    function tyList(d, names) {
      let j = d && d.data !== undefined ? d.data : d;
      if (typeof j === 'string') { try { j = JSON.parse(j); } catch (e) { j = null; } }
      if (j && Array.isArray(j.content)) {
        const txt = j.content.filter(c => c && c.type === 'text').map(c => c.text).join('\n');
        try { j = JSON.parse(txt); } catch (e) {}
      }
      if (Array.isArray(j)) return j;
      if (j && typeof j === 'object') {
        for (const n of names) if (Array.isArray(j[n])) return j[n];
        for (const k of Object.keys(j)) if (Array.isArray(j[k])) return j[k];
      }
      return [];
    }

    // 一家公司在这套报表里的合计，用来校验「资产 = 负债 + 所有者权益」
    function fsTotals(sd) {
      const out = {};
      ((sd && sd.rows) || []).forEach(r => {
        if (r.kind !== 'total') return;
        const sum = (r.values || []).filter(v => v != null);
        if (sum.length && /总计|合计$/.test(String(r.name || '').replace(/\s/g, ''))) out[String(r.name).replace(/\s/g, '')] = sum[0];
      });
      return out;
    }


    // ── 报表显示期数：天源「参数设置」里的「报表显示期数」（1-6 期），列＝从评估基准日那个年度起，一年一列往回推。
    // 资产负债表/利润表都是 12-31 的年报口径；最后一期（最左）就是评估基准日所在年度。
    const FS_PERIODS_MAX = 6;
    const FS_PERIODS_DEFAULT = 4;   // 默认 3 年 1 期 = 4 期（基准日年度 + 往前 3 年）
    const fsBaseDate = s => String((s && s.baseDate) || '').slice(0, 10);
    function fsPeriods(sd, n, baseDate) {
      const base = String(baseDate || '').slice(0, 4);
      const yb = Number(base) || (sd && Number(String(sd.year || '').slice(0, 4))) || new Date().getFullYear();
      const cnt = Math.max(1, Math.min(FS_PERIODS_MAX, Number(n) || FS_PERIODS_DEFAULT));
      const out = [];
      for (let i = 0; i < cnt; i++) {
        const y = yb - i;
        out.push({ year: y, kind: i === 0 ? 'now' : (i === 1 ? 'prev' : 'past'), label: String(y) + '-12-31' });
      }
      // 列顺序按时间从小到大（23→24→25）；kind 仍按「基准年=now，上一年=prev」绑定，不受显示顺序影响
      return out.reverse();
    }
    // 一行在各期的金额：来自本地文件的行按「now/prev」落到第 1/2 期，天源视图按年度直接取
    function fsRowVals(row, periods, tyMemo) {
      const vk = (row && row.valuesByKind) || {};
      return periods.map((p) => {
        if (tyMemo) { const m = tyMemo.get(String(row.name)); return m ? m[p.year] : undefined; }
        return Object.prototype.hasOwnProperty.call(vk, p.kind) ? vk[p.kind] : undefined;
      });
    }
    const fsTypeName = k => (k === 'income_statement' ? '利润表' : '资产负债表');
    const fsModeName = m => (String(m) === '2' ? '合并' : '单体');
    // 这份数据不是从本地文件读来的，而是「查看天源已导入」时从天源模板拼出来的空白报表
    // 天源模板的科目顺序（和天源「财务报表」里的行完全一致），没导入文件时用来列空白报表
    const FS_TPL_BALANCE = ['流动资产：', '货币资金', '交易性金融资产', '衍生金融资产', '应收票据', '应收账款', '应收款项融资', '预付款项', '其他应收款', '存货', '合同资产', '持有待售资产', '一年内到期的非流动资产', '其他流动资产', '流动资产合计', '非流动资产：', '债权投资', '其他债权投资', '长期应收款', '长期股权投资', '其他权益工具投资', '其他非流动金融资产', '投资性房地产', '固定资产', '在建工程', '生产性生物资产', '油气资产', '使用权资产', '无形资产', '开发支出', '商誉', '长期待摊费用', '递延所得税资产', '其他非流动资产', '非流动资产合计', '资产总计', '流动负债：', '短期借款', '交易性金融负债', '衍生金融负债', '应付票据', '应付账款', '预收款项', '合同负债', '应付职工薪酬', '应交税费', '其他应付款', '持有待售负债', '一年内到期的非流动负债', '其他流动负债', '流动负债合计', '非流动负债：', '长期借款', '应付债券', '租赁负债', '长期应付款', '长期应付职工薪酬', '预计负债', '递延收益', '递延所得税负债', '其他非流动负债', '非流动负债合计', '负债合计', '所有者权益：', '实收资本', '其他权益工具', '资本公积', '减：库存股', '其他综合收益', '专项储备', '盈余公积', '未分配利润', '所有者权益合计', '负债和所有者权益总计', '固定资产账面原值', '无形资产账面原值', '长期待摊费用原始账面价值'];
    const FS_TPL_INCOME = ['一、营业收入', '其中：主营业务收入', '其他业务收入', '减：营业成本', '其中：主营业务成本', '其他业务成本', '税金及附加', '销售费用', '管理费用', '研发费用', '财务费用', '其中：利息费用', '利息收入', '加：其他收益', '投资收益（损失以“-”号填列）', '其中：对联营企业和合营企业的投资收益', '以摊余成本计量的金融资产终止确认收益', '净敞口套期收益（损失以“-”号填列）', '公允价值变动收益（损失以“-”号填列）', '信用减值损失（损失以“-”号填列）', '资产减值损失（损失以“-”号填列）', '资产处置收益（损失以“-”号填列）', '二、营业利润（亏损以“-”号填列）', '加：营业外收入', '减：营业外支出', '三、利润总额（亏损总额以“-”号填列）', '减：所得税费用', '四、净利润（净亏损以“-”号填列）', '五、净利润报表数（净亏损以“-”号填列）'];

    // 天源视图：把 worksheetRows 摊成 「科目名 → {年度: 金额}」，方便按年度列取数
    function fsTyMemo(rows) {
      const m = new Map();
      (Array.isArray(rows) ? rows : []).forEach(w => {
        const nm = String(w.subjectName || '').replace(/\s/g, '');
        if (!nm) return;
        const tgt = m.get(nm) || {};
        const vs = w.values || {};
        Object.keys(vs).forEach(y => { if (vs[y] != null) tgt[String(y)] = vs[y]; });
        m.set(nm, tgt);
      });
      return m;
    }
    // 没导入过本地文件时，按天源模板列一份空白报表：科目一列照模板顺序，金额列按「报表显示期数」排
    function fsBlankTable(kind, names, periods, tyMemo) {
      const list = (names && names.length) ? names : (kind === 'income_statement' ? FS_TPL_INCOME : FS_TPL_BALANCE);
      const per = (periods && periods.length) ? periods : [{ kind: 'now', label: (kind === 'income_statement' ? '本期金额' : '期末余额'), year: '' }, { kind: 'prev', label: (kind === 'income_statement' ? '上期金额' : '期初余额'), year: '' }];
      const isTitle = n => /：$|:$/.test(String(n || ''));
      const fmtv = v => (v == null || v === '' || Number.isNaN(Number(v)) ? '' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 }));
      return h('div', { className: 'pf-table-wrap', style: { maxHeight: 380, overflow: 'auto' } },
        h('table', { className: 'pf-grid pw-grid' },
          h('thead', null, h('tr', null, ['科目'].concat(per.map(p => p.label)).map((t, i) => h('th', { key: i }, String(t))))),
          h('tbody', null, list.map((n, i) => {
            const t = isTitle(n);
            // 天源模板里写作「减：库存股」「其中：…」，源表里常常只写「库存股」，两边都试一次
            const key = String(n).replace(/\s/g, '');
            const bareKey = key.replace(/^[一二三四五六七八九十]+、/, '').replace(/^(减|加|其中)[:：]/, '').replace(/[（(].*$/, '');
            const hit = tyMemo ? (tyMemo.get(key) || tyMemo.get(bareKey)) : null;
            return h('tr', { key: i, style: t ? { background: 'rgba(47,127,240,.04)' } : null },
              h('td', { style: t ? { fontWeight: 600 } : null }, String(n)),
              per.map((p, j) => h('td', { key: j, style: { textAlign: 'right' } }, hit ? fmtv(hit[p.year]) : '')));
          }))));
    }

    // 跨期财务数据校验：在本地 byYear 上做「资产=负债+权益」「利润表勾稽」「上年期末=本年年初」检查
    // 返回 [{year, kind, label, ok, detail}]，纯前端、不改数据；浮点尾差用 0.05 元容差
    function fsValidate(byYear) {
      const TOL = 0.05;
      const near = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= TOL;
      const nk = s => {
        let t = String(s || '').replace(/\s/g, '');
        t = t.replace(/^[一二三四五六七八九十]+、/, '').replace(/^(其中|减|加)[:：]/, '');
        return t.split(/[(（]/)[0];
      };
      const mapOf = ent => {
        const m = new Map();
        (((ent && ent.rows) || []).forEach(r => { if (r && r.name) m.set(nk(r.name), r); }));
        return m;
      };
      const years = Object.keys(byYear || {}).map(Number).filter(y => y > 0).sort((a, b) => a - b);
      const byType = {};
      years.forEach(y => {
        const ent = byYear[String(y)] || {};
        const st = ent.statementType || (ent.sheetData && ent.sheetData.statementType) || 'balance_sheet';
        (byType[st] = byType[st] || []).push({ year: y, ent });
      });
      const checks = [];
      const money = v => {
        const n = Number(v);
        if (v == null || Number.isNaN(n)) return '—';
        const r = Math.abs(n) < 0.005 ? 0 : n;   // 消掉浮点尾差造成的「-0.00」
        return r.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      };

      // 资产负债表：两处恒等关系（每期）
      (byType.balance_sheet || []).forEach(({ year, ent }) => {
        const m = mapOf(ent);
        const g = (name, idx) => { const r = m.get(nk(name)); return r ? Number((r.values || [])[idx]) : null; };
        const ta = g('资产总计', 0), tle = g('负债和所有者权益总计', 0);
        const tl = g('负债合计', 0), te = g('所有者权益合计', 0);
        if (ta != null && tle != null) checks.push({ year, kind: 'balance', label: '资产总计 = 负债和所有者权益总计', ok: near(ta, tle), detail: money(ta) + ' vs ' + money(tle) + '（差 ' + money(ta - tle) + '）' });
        if (ta != null && tl != null && te != null) checks.push({ year, kind: 'balance', label: '资产总计 = 负债合计 + 所有者权益合计', ok: near(ta, tl + te), detail: money(ta) + ' vs ' + money(tl + te) + '（差 ' + money(ta - tl - te) + '）' });
      });

      // 利润表：营业利润/利润总额/净利润三段勾稽（每期，包含 now 与 prev 两列）
      (byType.income_statement || []).forEach(({ year, ent }) => {
        const m = mapOf(ent);
        [0, 1].forEach(idx => {
          const col = idx === 0 ? '本期' : '上年同期';
          const g = name => { const r = m.get(nk(name)); return r ? Number((r.values || [])[idx]) : null; };
          const op = g('营业利润'), tp = g('利润总额'), ni = g('净利润');
          if (op != null && tp != null) {
            const calc = op + (g('营业外收入') || 0) - (g('营业外支出') || 0);
            checks.push({ year, kind: 'income', label: col + '：利润总额 = 营业利润 + 营业外收入 − 营业外支出', ok: near(tp, calc), detail: money(tp) + ' vs ' + money(calc) + '（差 ' + money(tp - calc) + '）' });
          }
          if (tp != null && ni != null) {
            const calc = tp - (g('所得税费用') || 0);
            checks.push({ year, kind: 'income', label: col + '：净利润 = 利润总额 − 所得税费用', ok: near(ni, calc), detail: money(ni) + ' vs ' + money(calc) + '（差 ' + money(ni - calc) + '）' });
          }
        });
      });

      // 跨期衔接：上年 now ↔ 本年 prev，逐科目比对（两种报表都做）
      ['balance_sheet', 'income_statement'].forEach(st => {
        const list = byType[st] || [];
        for (let i = 1; i < list.length; i++) {
          const py = list[i - 1], cy = list[i];
          const pm = mapOf(py.ent), cm = mapOf(cy.ent);
          const diffs = [];
          cm.forEach((r, name) => {
            const curPrev = Number((r.values || [])[1]);
            const pr = pm.get(name);
            if (!pr) return;
            const prevNow = Number((pr.values || [])[0]);
            if (Number.isNaN(curPrev) || Number.isNaN(prevNow) || (!curPrev && !prevNow)) return;
            if (!near(curPrev, prevNow)) diffs.push({ name: (r.name || name), prev: prevNow, cur: curPrev, diff: curPrev - prevNow });
          });
          checks.push({
            year: cy.year, kind: 'carry', st,
            label: py.year + '年' + (st === 'income_statement' ? '本期' : '期末') + ' → ' + cy.year + '年' + (st === 'income_statement' ? '上年同期' : '上年年末') + '逐项衔接',
            ok: diffs.length === 0, diffs,
            detail: diffs.length ? (diffs.length + ' 个科目不一致，最大差额 ' + money(Math.max.apply(null, diffs.map(d => Math.abs(d.diff))))) : '全部科目一致',
          });
        }
      });
      return checks;
    }

    function FinancePanel({ project, s, toast, openSub, lockId }) {
      const rows = eqRows(eqListOf(s, project.id));
      const [who, setWho] = useState('');
      const [busy, setBusy] = useState('');
      const [ty, setTy] = useState({ status: '', error: '', projects: [], companies: [] });
      const [mode, setMode] = useState('1');
      const [tab, setTab] = useState('balance_sheet');
      const [financeStep, setFinanceStep] = useState(0); // 仅控制界面，不改变报表或预检凭证
      const [previewOpen, setPreviewOpen] = useState(false); // 明细按需展开，默认不占用页面
      const previewContextRef = useRef(null);
      const [result, setResult] = useState(null);       // get_reports 拉回来的结果
      const fileBalRef = useRef(null);
      const fileIncRef = useRef(null);
      const [importKind, setImportKind] = useState('balance_sheet');
      // 「从 01财务报表 文件夹导入」：扫一次目录拿到所有期，批量预检 + 一次确认写天源
      const [scan, setScan] = useState(null);       // /project/finance/scan 的结果
      const [scanKeep, setScanKeep] = useState({}); // 每期是否参与导入（默认全选）
      const [scanForce, setScanForce] = useState({}); // 人工指定的页分类 {文件名::页名: 'balance'|'income'|'skip'}
      const [scanOpen, setScanOpen] = useState(true);   // 扫描卡详情是否展开
      const [scanPending, setScanPending] = useState(false); // 新扫描或勾选变更尚未确认保存
      const [batch, setBatch] = useState(null);     // 批量预检结果（待一次确认）
      const [batchOpen, setBatchOpen] = useState(false); // 预检金额明细是否展开
      const [aiBusy, setAiBusy] = useState(false);  // AI 兜底解析进行中
      const [aiNote, setAiNote] = useState(null);   // AI 兜底结果摘要 { ok, packs, errors }
      const [aiModels, setAiModels] = useState([]); // 可用模型（读表能力差别大，让人自己选）
      const [aiPick, setAiPick] = useState('');     // 'provider::model'
      const [valOpen, setValOpen] = useState(false); // 校验卡是否展开明细
      const cur = lockId
        ? (rows.filter(r => r.id === lockId)[0] || null)
        : (rows.filter(r => r.id === who)[0] || rows[0] || null);
      const cid = cur ? cur.id : '';
      const box = cur ? fsOf(s, project.id, cid, mode) : { balance_sheet: fsEmptyStmt(), income_statement: fsEmptyStmt() };
      const sd = box[tab] || fsEmptyStmt();
      previewContextRef.current = { cid: String(cid), mode: String(mode), tab };
      // 报表显示期数：金额列＝从评估基准日所在年度起，一年一列往回推（默认 6 期，和天源参数设置一致）
      const nPeriods = Math.max(1, Math.min(FS_PERIODS_MAX, Number(box.periods) || FS_PERIODS_DEFAULT));
      const baseDate = fsBaseDate(project);
      const periods = fsPeriods(sd, nPeriods, baseDate);
      // 天源结果只在本次只读查询且页签匹配时展示；其余情况下优先显示本地拟导入数据。
      const showTy = !!result && result.statementType === tab && result.projectId === String(box.tyProjectId || '') && result.companyId === String(box.tyCompanyId || '') && result.mode === String(mode) && result.localCompanyId === String(cid);
      const tyMemo = showTy ? fsTyMemo(result.tyRows || []) : null;
      const setPeriods = n => fsTop(project.id, cid, () => ({ periods: Math.max(1, Math.min(FS_PERIODS_MAX, Number(n) || FS_PERIODS_DEFAULT)) }));
      const tot = fsTotals(sd);

      // 天源连接状态 + 项目/公司清单（只拉一次）
      useEffect(() => {
        let dead = false;
        (async () => {
          setTy(x => Object.assign({}, x, { status: 'loading' }));
          try {
            const st = await fetch(PREFIX + '/ty/status').then(r => r.json());
            if (dead) return;
            if (!st || !st.connected) { setTy(x => Object.assign({}, x, { status: 'off', error: (st && st.error) || '天源未连接' })); return; }
            const d = await fetch(PREFIX + '/ty/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'get_my_projects', arguments: {} }) }).then(r => r.json());
            const list = tyList(d, ['projects']);
            if (dead) return;
            setTy(x => Object.assign({}, x, { status: 'on', projects: list, error: '' }));
          } catch (e) {
            if (!dead) setTy(x => Object.assign({}, x, { status: 'off', error: String((e && e.message) || e) }));
          }
        })();
        return () => { dead = true; };
      }, []);

      // 切到某家天源项目 → 拉它下面的公司
      const pickTyProject = async tyProjectId => {
        setTy(x => Object.assign({}, x, { companies: [] }));
        setBatch(null); setResult(null); setAiNote(null);   // 目标变化后确认 token 与旧预览作废
        fsTop(project.id, cid, () => ({ tyProjectId: tyProjectId, tyCompanyId: '' }));
        if (!tyProjectId) return;
        try {
          const d = await fetch(PREFIX + '/ty/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'get_project_companies', arguments: { projectId: Number(tyProjectId) } }) }).then(r => r.json());
          const list = tyList(d, ['companies']);
          setTy(x => Object.assign({}, x, { companies: list }));
        } catch (e) { toast('拉公司清单失败：' + String((e && e.message) || e), 'warn'); }
      };

      // 读文件：只解析，不动天源。一个按钮只管一种报表——「导入资产负债表」只写资产负债表，「导入利润表」只写利润表
      const onFile = async (e, only) => {
        const f = (e.target.files || [])[0];
        e.target.value = '';
        if (!f || !cur) return;
        setBusy('read');
        try {
          const qs = '&periods=' + encodeURIComponent(String(nPeriods)) + '&basedate=' + encodeURIComponent(baseDate || '');
          const r = await fetch(PREFIX + '/project/finance/statements?name=' + encodeURIComponent(f.name) + qs, {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f,
          });
          if (r.status === 404) throw new Error('宿主未重载，重启 DSH 后可用');
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
          const list = Array.isArray(d.statements) ? d.statements : [];
          if (!list.length) throw new Error('这个文件里没找到「资」和「利」两页（要看的是审定报表-新格式那种）');
          const got = list.filter(x => x.statementType === only)[0] || null;
          fsUpdate(project.id, cid, mode, b => {
            const next = Object.assign({}, b, { fileName: f.name, importedAt: new Date().toISOString() });
            if (got) {
              const one = Object.assign(fsEmptyStmt(), got, { fileName: f.name, importedAt: new Date().toISOString() });
              // 单文件导入也落进 byYear，跟「01财务报表」扫出来的一样，后面统一走「保存并写入天源系统」
              const byYear = Object.assign({}, (b[only] || {}).byYear || {});
              if (got.year) byYear[String(Number(got.year))] = one;
              next[only] = Object.assign({}, one, { byYear });
            }
            return next;
          });
          setResult(null);
          if (got) setTab(only);
          if (got) toast('已读入' + (only === 'income_statement' ? '利润表' : '资产负债表') + '「' + (got.sheet || '') + '」' + (got.rows || []).length + ' 行（' + f.name + '）', 'info');
          else toast('这个文件里没有' + (only === 'income_statement' ? '利润表（利）' : '资产负债表（资）') + '页', 'warn');
          // 两步走·第二步：报表读进来后，用资产负债表里非零的源科目金额补齐本地科目表，
          // 并按「方法 + 科目」补齐对应的科目文件夹（幂等）。科目没变时目录也已存在，等于无操作。
          if (got && got.statementType === 'balance_sheet' && got.sheetData && Array.isArray(got.sheetData.detail)) {
            const picked = (got.sheetData.detail)
              .map(x => ({ name: String(x.originName || '').trim(), amount: numOf(x.amount) }))
              .filter(x => x.name && x.amount != null && Math.abs(x.amount) > 0);
            if (picked.length) {
              const base = finSubjects(s, project.id, cid);
              const merged = base.slice();
              let addN = 0; let overN = 0;
              picked.forEach(p => {
                const idx = merged.map(x => x.name).indexOf(p.name);
                if (idx >= 0) { merged[idx] = { name: p.name, amount: String(p.amount) }; overN += 1; }
                else { merged.push({ name: p.name, amount: String(p.amount) }); addN += 1; }
              });
              finUpdate(project.id, cid, () => merged);
              const after = rows.map(r2 => ({
                name: r2.name,
                methods: r2.methods || { whole: [], part: [] },
                subjects: r2.id === cid ? merged : finSubjects(s, project.id, r2.id).map(x => ({ name: x.name, amount: x.amount })),
              })).filter(r2 => r2.name && r2.name !== '被评估单位');
              buildProjectFoldersFrom(project, after, toast, true)
                .then(() => toast('已按报表科目补齐本地科目表（新增 ' + addN + '、覆盖 ' + overN + '），科目文件夹已对齐', 'info'))
                .catch(() => {});
            }
          }
        } catch (err) {
          toast('读取失败：' + String((err && err.message) || err), 'warn');
        } finally { setBusy(''); }
      };

      const call = async (name, args) => {
        const r = await fetch(PREFIX + '/ty/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, arguments: args || {} }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error('HTTP ' + r.status + (d && (d.error || d.message) ? '：' + String(d.error || d.message).slice(0, 500) : ''));
        if (d && d.isError) throw new Error(typeof d.data === 'string' ? d.data.slice(0, 300) : '天源返回错误');
        return d && d.data !== undefined ? d.data : d && d.structuredContent;
      };

      // ── 从「01财务报表」文件夹批量导入 ───────────────────────────────
      // 客户把各期报表原件丢进 00财务资料/<公司>/01财务报表，这里扫一遍目录，
      // 自动认出每页是资还是利、属于哪一年；认不出的页让用户指定分类；然后一次预检、一次确认写天源。
      const scanPackKey = p => p.statementType + '@' + p.year + (p.comparisonSource ? '@comparison@' + p.fileName + '@' + p.sheet : '');
      const yearConflictFor = (notes, p) => (notes || []).find(n => n.requiresConfirmation && n.statementType === p.statementType && n.fileName === p.fileName);
      const scanFolder = async (force) => {
        if (!cur) return;
        setBusy('scan');
        setBatch(null);
        setAiNote(null);
        try {
          const r = await fetch(PREFIX + '/project/finance/scan', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              folder: folderNameOf(project), abs: projectAbs(project),
              projectId: String(project.id), companyId: String(cid), basedate: baseDate || '',
              force: force || scanForce,
            }),
          });
          if (r.status === 404) throw new Error('宿主未重载，重启 DSH 后可用');
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
          setScan(d);
          setScanPending(true);
          setScanOpen(true);
          // 重扫时保留用户已经取消的勾选（只给新出现的期默认打勾），免得人工分类一次就把选择清掉
          setScanKeep(prev => {
            const keep = {};
            (d.packs || []).forEach(p => {
              const k = scanPackKey(p);
              keep[k] = yearConflictFor(d.yearNotes, p) ? false : (prev[k] === undefined ? !p.comparisonSource : prev[k]);
            });
            return keep;
          });
          const n = (d.packs || []).length;
          const nm = (d.needManual || []).length;
          if (!(d.files || []).length) {
            toast('「01财务报表」文件夹是空的：把各期报表放进去再点一次。', 'warn');
          } else if (!n) {
            toast('扫到 ' + d.files.length + ' 个文件，但没有认出可导入的报表' + (nm ? '，有 ' + nm + ' 页需要你指定分类' : ''), 'warn');
          } else {
            setScanOpen(true);
            toast('扫到 ' + d.files.length + ' 个文件，识别 ' + n + ' 张报表' + (nm ? '，' + nm + ' 页待指定分类' : '') + '。请核对后确认保存到本地。', nm ? 'warn' : 'info');
          }
        } catch (e) {
          setScan(null); setScanOpen(false); setScanPending(false);
          toast('扫描失败：' + String((e && e.message) || e) + '。若公司目录未绑定或归属异常，请返回项目股权信息页的“公司目录归属”核实处理。', 'warn');
        } finally { setBusy(''); }
      };
      // 人工指定某页的分类 → 记下选择后重扫（force 覆盖自动判定）
      const setSheetKind = (fileName, sheet, kind, year) => {
        const key = fileName + '::' + sheet;
        const prev = scanForce[key];
        const asObj = prev && typeof prev === 'object' ? Object.assign({}, prev) : { kind: prev || '' };
        if (kind !== undefined) asObj.kind = kind;
        if (year !== undefined) asObj.year = year;
        const val = (asObj.year ? asObj : asObj.kind);   // 只有分类时仍存字符串，force 更好读
        const next = Object.assign({}, scanForce, { [key]: val });
        setScanForce(next);
        scanFolder(next);
      };
      // 读表用哪个模型：宿主报的可用清单，默认第一个
      const loadAiModels = async () => {
        if ((aiModels || []).length) return aiModels;
        try {
          const r = await fetch(PREFIX + '/company/models');
          const d = await r.json().catch(() => ({}));
          const list = (d && Array.isArray(d.providers) ? d.providers : []).flatMap(p =>
            (p.models || []).map(m => ({ provider: p.id, model: m.id, label: (p.name || p.id) + ' / ' + (m.name || m.id) })));
          setAiModels(list);
          if (list.length && !aiPick) setAiPick(list[0].provider + '::' + list[0].model);
          return list;
        } catch (e) { return []; }
      };
      useEffect(() => { if (scan || aiBusy) loadAiModels(); }, [scan, aiBusy]);

      // AI 兜底：规则认不出的页，把单元格丢给模型读一遍。
      // 只读用户点名的那些页（needManual 里还没指定分类的），不做全目录 AI 扫描。
      const aiParse = async () => {
        if (!cur) return;
        const targets = ((scan && scan.needManual) || [])
          .filter(m => !forceOf(m.fileName + '::' + m.sheet).kind)
          .map(m => ({ fileName: m.fileName, sheet: m.sheet }));
        if (!targets.length) { toast('没有需要 AI 读的页（都指定过分类了）', 'warn'); return; }
        setAiBusy(true);
        setAiNote(null);
        try {
          const r = await fetch(PREFIX + '/project/finance/ai-parse', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              abs: projectAbs(project), projectId: String(project.id), companyId: String(cid),
              basedate: baseDate || '', targets,
              provider: (aiPick || '').split('::')[0] || '',
              model: (aiPick || '').split('::')[1] || '',
            }),
          });
          if (r.status === 404) throw new Error('宿主未重载，重启 DSH 后可用');
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
          const got = d.packs || [];
          const errs = d.errors || [];
          setAiNote({ ok: got.length, errors: errs });
          if (got.length) {
            // AI 结果仅加入待核对清单，须由用户确认后才写入本地。
            setScanPending(true);
            setScanOpen(true);
            setScan(prev => {
              if (!prev) return prev;
              const done = {};
              got.forEach(p => { done[p.fileName + '::' + p.sheet] = true; });
              const packs = (prev.packs || []).slice();
              got.forEach(p => {
                const i = packs.findIndex(x => x.statementType === p.statementType && Number(x.year) === Number(p.year));
                if (i >= 0) packs[i] = p; else packs.push(p);
              });
              return Object.assign({}, prev, {
                packs,
                summary: fsScanSummary(packs, (prev.summary || {}).fileCount || (prev.files || []).length),
                needManual: (prev.needManual || []).filter(m => !done[m.fileName + '::' + m.sheet]),
              });
            });
            setScanKeep(prev => {
              const keep = Object.assign({}, prev);
              got.forEach(p => { const k = scanPackKey(p); if (yearConflictFor((scan && scan.yearNotes), p)) keep[k] = false; else if (keep[k] === undefined) keep[k] = !p.comparisonSource; });
              return keep;
            });
          }
          toast(got.length
            ? ('AI 读出 ' + got.length + ' 张报表' + (errs.length ? '，' + errs.length + ' 页仍失败' : ''))
            : ('AI 也没读出来' + (errs.length ? '：' + errs[0].error : '')), got.length ? 'info' : 'warn');
        } catch (e) {
          toast('AI 解析失败：' + String((e && e.message) || e), 'warn');
        } finally { setAiBusy(false); }
      };
      // 把若干期落到本地报表（按年度存进 byYear），上面预览表立刻能逐期核对；
      // 这一步不动天源，只有确认无误后再点下面的「保存并写入天源系统」。
      // applyScanToLocal 与扫描后的「自动写入」共用这段。
      const writePacksToLocal = (packs, note) => {
        if (!packs.length) { toast('没有勾选任何要导入的报表', 'warn'); return; }
        const subj = {};
        ['balance_sheet', 'income_statement'].forEach(st => {
          const group = packs.filter(x => x.statementType === st).sort((a, b) => Number(a.year) - Number(b.year));
          if (!group.length) return;
          fsUpdate(project.id, cid, mode, b => {
            const cur0 = b[st] || fsEmptyStmt();
            const byYear = Object.assign({}, cur0.byYear || {});
            group.forEach(x => {
              byYear[String(Number(x.year))] = Object.assign(fsEmptyStmt(), {
                statementType: st,
                sheet: x.sheet || '',
                year: Number(x.year),
                unit: x.unit || '元',
                period: x.period || '',
                columns: x.columns || [],
                rows: x.rows || [],
                sheetData: x.sheetData || null,
                fileName: x.fileName,
                importedAt: new Date().toISOString(),
              });
            });
            // 上层字段指向最新一期，保持「单文件导入」那套渲染/预检仍然可用
            const years = Object.keys(byYear).map(Number).sort((a, b) => b - a);
            const latest = byYear[String(years[0])] || fsEmptyStmt();
            (latest.sheetData || {}).detail && (latest.sheetData.detail || []).forEach(d => {
              if (d.amount) subj[String(d.originName || d.subjectName || '').replace(/\s/g, '')] = true;
            });
            return Object.assign({}, b, {
              [st]: Object.assign({}, cur0, latest, { byYear }),
            });
          });
        });
        // 资产负债表里读到的科目名并入公司科目，底稿文件夹跟着建
        const names = Object.keys(subj).filter(Boolean);
        if (names.length) {
          patch('work', w => {
            const all = Object.assign({}, w.finance || {});
            const proj = Object.assign({ companies: {} }, all[project.id] || {});
            const comps = Object.assign({}, proj.companies || {});
            const comp = Object.assign({ subjects: [] }, comps[cid] || {});
            const have = new Set((comp.subjects || []).map(x => String(x.name || x).replace(/\s/g, '')));
            const add = names.filter(n => !have.has(n)).map(n => ({ name: n }));
            comps[cid] = Object.assign({}, comp, { subjects: (comp.subjects || []).concat(add) });
            proj.companies = comps;
            all[project.id] = proj;
            return Object.assign({}, w, { finance: all });
          });
        }
        const savedBox = fsOf(store.get(), project.id, cid, mode);
        const missing = packs.filter(x => {
          const saved = (((savedBox[x.statementType] || {}).byYear || {})[String(Number(x.year))]);
          return !saved || saved.fileName !== x.fileName || JSON.stringify(saved.sheetData) !== JSON.stringify(x.sheetData || null);
        });
        if (missing.length) {
          toast('本地保存后回读缺少：' + missing.map(x => fsTypeName(x.statementType) + ' ' + x.year).join('、') + '。请勿预检写入天源。', 'warn');
          return false;
        }
        toast(note || ('已保存至本地：' + packs.map(x => fsTypeName(x.statementType) + ' ' + x.year).join('、') + '。请逐期核对；此时尚未写入天源。'), 'info');
        return true;
      };
      // 手动按钮：按当前勾选写入本地
      const applyScanToLocal = () => {
        const selected = ((scan && scan.packs) || []).filter(x => scanKeep[scanPackKey(x)]);
        if (!selected.length) { toast('没有勾选任何要导入的报表', 'warn'); return; }
        const keys = selected.map(x => x.statementType + '@' + Number(x.year));
        if (new Set(keys).size !== keys.length) { toast('同一报表类型和年度只能选择一张，请取消重复项后再保存。', 'warn'); return; }
        const overlaps = selected.filter(x => (((box[x.statementType] || {}).byYear || {})[String(Number(x.year))]));
        if (overlaps.length && !window.confirm('以下本地报表已有数据，将被替换：\n' + overlaps.map(x => fsTypeName(x.statementType) + ' ' + x.year + '（' + x.fileName + '）').join('\n') + '\n\n确认保存到本地？天源数据不会改变。')) return;
        setBatch(null);
        if (!writePacksToLocal(selected)) return;
        setScanPending(false);
        setScanOpen(false);
        setResult(null);
        setFinanceStep(1);
      };

      // 把「本地已存的各期报表」推到天源：每种报表类型一次 prepare（sheetList 装该类型所有年度），
      // 预检通过后再一次确认全部写入。数据来源是本地 byYear，也就是上面预览表给人核对的那份。
      const prepareBatch = async () => {
        if (scan && scanPending) { toast('请先确认保存或放弃扫描结果，再预检。', 'warn'); return; }
        // 预检展示本地拟导入数据；不改变 byYear、目标或现有天源数据。
        setResult(null);
        // 写天源前先过一遍校验：不一致就让人明确确认，避免把明显有问题的数写进去
        // 两种报表类型分别校验（同一年两者都有，合并到一张 Map 会互相覆盖），结果合并
        const vBad = [];
        ['balance_sheet', 'income_statement'].forEach(st => {
          const ent = (box[st] || {}).byYear || {};
          fsValidate(ent).filter(x => !x.ok).forEach(x => vBad.push(fsTypeName(st) + '：' + x.label + '（' + x.detail + '）'));
        });
        if (vBad.length && !window.confirm('数据校验有 ' + vBad.length + ' 项不一致：\n' + vBad.slice(0, 6).join('\n') + '\n\n仍然要写入天源吗？')) return;
        const p = box.tyProjectId; const c = box.tyCompanyId;
        if (!p || !c) {
          toast('还不能写天源：先在右上角「天源项目」「公司」两个下拉里选好，再点这个按钮（本地报表已经存好了，不会丢）', 'warn');
          return;
        }
        const picks = [];
        ['balance_sheet', 'income_statement'].forEach(st => {
          const boxSt = fsOf(s, project.id, cid, mode)[st] || fsEmptyStmt();
          const byYear = boxSt.byYear || {};
          Object.keys(byYear).map(Number).sort((a, b) => a - b).forEach(y => {
            const ent = byYear[String(y)] || {};
            if (ent.sheetData) picks.push({ statementType: st, year: Number(y), sheetData: ent.sheetData });
          });
        });
        if (!picks.length) { toast('本地还没有可导入的报表，先点上面的「从「01财务报表」导入」把报表读进来', 'warn'); return; }
        setBusy('batch');
        setBatch(null);
        const runs = []; const errs = [];
        for (const st of ['balance_sheet', 'income_statement']) {
          const group = picks.filter(x => x.statementType === st);
          if (!group.length) continue;
          // skipSummary 是本地展示用的字段（把 skipped 分成 零/明细/金融 三类给人看），
          // 天源的 sheetList schema 里没有它，别一起发过去（多一个字段可能整单被拒）。
          const sheets = group.map(x => {
            const src = Object.assign({}, x.sheetData, { reportYear: Number(x.year) || null });
            delete src.skipSummary;
            return src;
          });
          try {
            const d = await call('prepare_financial_statement_report_import', {
              projectId: Number(p), companyId: Number(c),
              statementType: st, reportMode: Number(mode),
              missingSubjectPolicy: 'preserve_existing', includeRequestBody: false,
              sheetList: sheets,
            });
            if (!d || !d.success) {
              const ves = (d && d.validationErrors) || [];
              errs.push({
                statementType: st,
                error: (d && (d.error || d.message)) || '预检未通过',
                details: ves.slice(0, 8).map(x => (x.reportYear ? x.reportYear + ' ' : '') + (x.originName || x.subjectName || '') + '（' + (x.error || '对不上模板') + '）'),
              });
              continue;
            }
            runs.push({ statementType: st, years: group.map(x => x.year), token: d.confirmationToken, prompt: d.confirmationPrompt, dataPrompt: d.confirmationDataPrompt, preview: d.preview });
          } catch (e) {
            errs.push({ statementType: st, error: String((e && e.message) || e), details: [] });
          }
        }
        setBatch({ runs: runs, errors: errs, projectId: String(p), companyId: String(c), mode: String(mode), dataSnapshot: JSON.stringify(['balance_sheet', 'income_statement'].map(st => ((box[st] || {}).byYear || {}))) });
        if (!runs.length) toast('预检没通过，看下面的原因', 'warn');
        else toast('预检通过 ' + runs.length + ' 张表' + (errs.length ? '，' + errs.length + ' 张没过' : '') + '，核对后点确认', 'info');
        setBusy('');
      };
      // 一次确认：把预检通过的表逐张写进天源
      const executeBatch = async () => {
        if (scan && scanPending) { toast('请先确认保存或放弃扫描结果，并重新预检。', 'warn'); return; }
        if (!batch || !batch.runs.length) return;
        if (!batch.projectId || !batch.companyId || batch.projectId !== String(box.tyProjectId || '') || batch.companyId !== String(box.tyCompanyId || '') || batch.mode !== String(mode) || batch.dataSnapshot !== JSON.stringify(['balance_sheet', 'income_statement'].map(st => ((box[st] || {}).byYear || {})))) {
          toast('预检目标或本地报表已变更，请取消后重新预检。', 'warn');
          return;
        }
        setBusy('batchExec');
        const done = []; const failed = [];
        for (const run of batch.runs) {
          try {
            const d = await call('execute_financial_statement_report_import', { confirmationToken: run.token, confirmed: true });
            if (!d || !(d.success || d.ok)) throw new Error((d && (d.error || d.message)) || '保存失败');
            done.push(run);
          } catch (e) {
            failed.push({ statementType: run.statementType, years: run.years, error: String((e && e.message) || e) });
          }
        }
        if (done.length) {
          const last = done[done.length - 1];
          fsUpdate(project.id, cid, mode, b => Object.assign({}, b, {
            lastResult: {
              at: new Date().toISOString(), statementType: last.statementType, mode: Number(mode),
              prompt: done.map(r => (r.statementType === 'income_statement' ? '利润表 ' : '资产负债表 ') + r.years.join('/')).join('、'),
              summary: ((last.preview || {}).sheets || [])[0] || null, message: '已保存到天源',
            },
          }));
        }
        // 全部成功就把这张确认卡收掉；有失败的留着，让用户看清哪张没写进去
        setBatch(failed.length
          ? { runs: [], errors: failed.map(x => ({ statementType: x.statementType, error: x.error + '（' + x.years.join('/') + '）', details: [] })) }
          : null);
        if (done.length) toast('已写入天源 ' + done.length + ' 张表：' + done.map(r => (r.statementType === 'income_statement' ? '利润表' : '资产负债表') + r.years.join('/')).join('、'), 'info');
        if (failed.length) toast(failed.length + ' 张表写入失败，看下面的原因', 'warn');
        setBusy('');
        // 不自动切换到天源视图；用户可用只读按钮主动核实写入结果。
      };

      // 「查看天源已导入XX表」：只拉当前页签这一种报表、当前口径，命中的已有年度用天源数据填进表里；
      // 天源这一口径一期都没有的时候，按模板列一张空白报表，方便照着填、核对。
      const refreshReports = async () => {
        const p = box.tyProjectId; const c = box.tyCompanyId;
        if (!p) { toast('先在右边选这家公司对应的天源项目和公司', 'warn'); return; }
        if (!c) { toast('先选天源公司', 'warn'); return; }
        if (!(ty.status === 'on')) { toast('天源未连接', 'warn'); return; }
        setBusy('refresh');
        try {
          const st = tab;
          const d = await call('get_financial_statement_reports', {
            projectId: Number(p), companyId: Number(c),
            statementType: st, reportMode: Number(mode),
            view: 'worksheet', includeEmptySubjects: true,
          });
          const reports = (d && d.reports) || [];
          const rep = reports.filter(r => r.statementType === st)[0] || reports[0] || null;
          const years = ((rep && rep.existingYears) || []).map(String).sort((a, b) => Number(a) - Number(b)).slice(-5);
          const rows = (rep && rep.worksheetRows) || [];
          const anyVal = rows.some(w => { const vs = w.values || {}; return years.some(y => vs[y] != null); });
          // 只读结果仅保存在临时视图中，不覆盖本地单文件或逐年报表。
          if (!years.length || !anyVal) {
            toast('天源「' + fsModeName(mode) + fsTypeName(st) + '」还没有数据，已按模板列出空白报表', 'info');
          } else {
            toast('已取天源『' + fsModeName(mode) + fsTypeName(st) + '』：已有年度 ' + years.join('/'), 'info');
          }
          const currentTarget = fsOf(store.get(), project.id, cid, mode);
          const context = previewContextRef.current || {};
          if (String(currentTarget.tyProjectId || '') !== String(p) || String(currentTarget.tyCompanyId || '') !== String(c) || context.cid !== String(cid) || context.mode !== String(mode) || context.tab !== st) {
            toast('查询期间天源目标已改变，已忽略旧结果，请重新查询。', 'warn');
            return;
          }
          setResult({ statementType: st, tyYears: years, tyRows: rows, report: rep, projectId: String(p), companyId: String(c), mode: String(mode), localCompanyId: String(cid) });
          setPreviewOpen(true);
        } catch (err) {
          toast('读取天源已导入数据失败：' + String((err && err.message) || err), 'warn');
        } finally { setBusy(''); }
      };
      // 从天源同步当前公司的资产基础法科目金额（对接第 1 步）：
      // /ty/report-companies 拿天源公司清单 → 名字归一化匹配 → /ty/ab-subjects 拉 level=2 非零科目
      // → 合并进本地科目表（同名覆盖金额，本地独有保留）→ 顺手重建项目文件夹。
      if (!cur) {
        return h('div', null, h('p', { className: 'pf-hint' }, '还没有股权信息。先到「股权信息」里添加被评估单位和子公司，再回来录财务资料。'));
      }
      const fmt = v => (v == null || v === '' ? '' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 }));
      const tyOpts = (ty.projects || []).map(p => {
        const id = p.id || p.projectId;
        const nm = p.projectName || p.name || '';
        return h('option', { key: 'p' + id, value: String(id) }, (p.projectCode || p.code || '') + ' ' + nm);
      });
      const tyCOpts = (ty.companies || []).map(c => {
        const id = c.id || c.companyId;
        return h('option', { key: 'c' + id, value: String(id) }, c.name || c.companyName || '');
      });
      // 本地已存的各期（「01财务报表」一次扫出来多期时都在 byYear 里），按年度倒序
      const localByYear = sd.byYear || {};
      const localYears = Object.keys(localByYear).map(Number).filter(y => y > 0).sort((a, b) => a - b);
      // 把本地多期摊成 「天源科目 → {年度: 金额}」，直接复用 fsBlankTable 的列渲染
      const localMemo = new Map();
      localYears.forEach(y => {
        const ent = localByYear[String(y)] || {};
        ((ent.sheetData || {}).detail || []).forEach(d => {
          const nm = String(d.subjectName || '').replace(/\s/g, '');
          if (!nm) return;
          const tgt = localMemo.get(nm) || {};
          const v = Number(d.amount);
          if (!Number.isNaN(v)) tgt[String(y)] = v;
          localMemo.set(nm, tgt);
        });
      });
      const localPeriods = localYears.map(y => ({ year: y, kind: 'now', label: String(y) + '-12-31' }));
      // 本地多期数据的一致性校验（写天源前的最后一道关）
      const valChecks = fsValidate(localByYear);
      const valBad = valChecks.filter(c => !c.ok);
      const valAllOk = valChecks.length > 0 && valBad.length === 0;
      const reportRows = ((result && result.reports) || []).reduce((acc, r) => acc.concat((r.worksheetRows || []).filter(w => { const vs = w.values || {}; return Object.keys(vs).some(k => vs[k] != null && vs[k] !== 0); }).map(w => Object.assign({}, w, { _years: Object.keys(w.values || {}).sort((a, b) => Number(a) - Number(b)) }))), []).slice(0, 200);
      // 扫描结果里「认不出的页」：让人工指定这页是资产负债表还是利润表
      const kindOptions = m => ['', 'balance', 'income', 'skip'].map(v => h('option', { key: v || 'none', value: v },
        v === '' ? '请选择' : (v === 'balance' ? '资产负债表' : (v === 'income' ? '利润表' : '跳过'))));
      const forceOf = key => {
        const v = scanForce[key];
        return v && typeof v === 'object' ? v : { kind: v || '', year: '' };
      };
      const manualRow = (m, i) => {
        const key = m.fileName + '::' + m.sheet;
        const f = forceOf(key);
        // 自动已经认出分类的（只是年度读不出），下拉框直接显示认出的那个，省得再选一次
        const sel = h('select', {
          className: 'pf-sel',
          value: f.kind || m.kind || '',
          onChange: e => setSheetKind(m.fileName, m.sheet, e.target.value),
        }, kindOptions(m));
        // 表头读不出年度时，让用户直接补一个四位数年份
        const yr = m.needYear
          ? h('input', {
            className: 'pf-in', style: { width: 76, marginLeft: 4, padding: '0 4px' }, placeholder: '年度', maxLength: 4,
            value: f.year || '',
            onChange: e => {
              const v = e.target.value.replace(/[^0-9]/g, '').slice(0, 4);
              if (v.length === 4 && Number(v) > 1900 && Number(v) < 2200) setSheetKind(m.fileName, m.sheet, undefined, v);
              else setScanForce(Object.assign({}, scanForce, { [key]: Object.assign({}, f, { year: v }) }));
            },
          })
          : null;
        return h('tr', { key: i },
          h('td', null, m.fileName),
          h('td', null, m.sheet),
          h('td', { className: 'pf-hint' }, m.reason),
          h('td', null, sel, yr));
      };
      const needManualBox = (scan && (scan.needManual || []).length)
        ? h('div', { className: 'pf-table-wrap', style: { maxHeight: 200, overflow: 'auto', marginTop: 6 } },
          h('table', { className: 'pf-grid pw-grid' },
            h('thead', null, h('tr', null, ['文件', '页签', '情况', '指定为'].map((t, i) => h('th', { key: i }, t)))),
            h('tbody', null, scan.needManual.map(manualRow))))
        : null;
      // AI 兜底按钮：只处理 needManual 里还没指定分类的页
      const aiTargets = ((scan && scan.needManual) || []).filter(m => !forceOf(m.fileName + '::' + m.sheet).kind);
      const aiBox = (aiBusy || aiTargets.length || (aiNote && ((aiNote.errors || []).length || aiNote.ok)))
        ? h('div', { className: 'pf-card', style: { marginTop: 8 } },
          h('p', null, h('b', null, 'AI 兜底解析'),
            h('span', { className: 'pf-hint', style: { marginLeft: 8 } },
              '规则认不出的页，让模型按业务常识把科目和金额读出来（读出的期会并到下面的勾选表里）')),
          aiTargets.length
            ? h('p', { className: 'pf-hint' }, '待 AI 读 ' + aiTargets.length + ' 页：'
              + aiTargets.slice(0, 6).map(m => m.fileName + ' / ' + m.sheet).join('；')
              + (aiTargets.length > 6 ? ' 等' : ''))
            : null,
          (aiNote && (aiNote.errors || []).length)
            ? h('p', { className: 'pf-hint' }, '仍失败 ' + aiNote.errors.length + ' 页：'
              + aiNote.errors.slice(0, 4).map(e => e.fileName + ' / ' + e.sheet + '：' + e.error).join('；'))
            : null,
          h('div', { className: 'pw-acts', style: { marginTop: 6, flexWrap: 'wrap' } },
            h('label', { className: 'pf-hint', style: { marginRight: 6 } }, '读表模型',
              h('select', {
                className: 'pf-sel', style: { marginLeft: 4, maxWidth: 260 },
                value: aiPick,
                onChange: e => setAiPick(e.target.value),
              }, (aiModels || []).length
                ? aiModels.map(o => h('option', { key: o.provider + '::' + o.model, value: o.provider + '::' + o.model }, o.label))
                : [h('option', { key: 'none', value: '' }, '（宿主没报可用模型）')])),
            h('button', {
              type: 'button', className: 'pf-btn pri',
              disabled: aiBusy || !aiTargets.length,
              onClick: aiParse,
            }, aiBusy ? 'AI 读表中…（一页可能要十几秒）' : '让 AI 读这些页'),
            h('button', {
              type: 'button', className: 'pf-btn',
              disabled: aiBusy || !aiTargets.length,
              onClick: () => {
                // 不想用 AI 也可以直接跳过：把这些页标记为 skip 后重扫，needManual 就清空了
                let next = scanForce;
                aiTargets.forEach(m => { next = Object.assign({}, next, { [m.fileName + '::' + m.sheet]: 'skip' }); });
                setScanForce(next);
                scanFolder(next);
              },
            }, '这几页直接跳过')))
        : null;
      // 认出来的报表：勾选要导入的期
      // 精简流程：扫描卡默认收成一行摘要（文件数/报表数/已自动写入），点「详情」才展开勾选表与人工分类区
      const packRow = (p, i) => {
        const k = scanPackKey(p);
        return h('tr', { key: i },
          h('td', null, h('input', {
            type: 'checkbox', checked: !!scanKeep[k],
            onChange: e => { setScanPending(true); setScanKeep(Object.assign({}, scanKeep, { [k]: e.target.checked })); },
          })),
          h('td', null, p.statementType === 'income_statement' ? '利润表' : '资产负债表'),
          h('td', null, String(p.year)),
          h('td', null, p.period || '', p.comparisonSource ? (p.statementType === 'income_statement' ? '（上年同期数候选，需勾选核对；不会自动导入）' : '（期初数候选，需勾选核对；不会自动导入）') : '', yearConflictFor(scan.yearNotes, p) ? h('strong', { style: { color: '#c96a00' } }, '；年度冲突，原始期间：' + (p.originalPeriod || yearConflictFor(scan.yearNotes, p).originalPeriod || '未提供') + '；请核实后主动勾选') : null),
          h('td', null, p.fileName),
          h('td', null, p.sheet),
          h('td', { style: { textAlign: 'right' } }, String(((p.sheetData || {}).detail || []).length)));
      };
      const packBox = (scan && (scan.packs || []).length)
        ? h('div', { className: 'pf-table-wrap', style: { maxHeight: 260, overflow: 'auto', marginTop: 6 } },
          h('table', { className: 'pf-grid pw-grid' },
            h('thead', null, h('tr', null, ['导入', '报表', '年度', '期间', '文件', '页签', '可写科目'].map((t, i) => h('th', { key: i }, t)))),
            h('tbody', null, scan.packs.map(packRow))))
        : null;
      // 同一期给了两个文件：告诉用户留了哪个
      const conflictBox = (scan && (scan.conflicts || []).length)
        ? h('p', { className: 'pf-hint', style: { marginTop: 6 } }, '同期有多个文件，只导入后者：'
          + scan.conflicts.map(c => (c.statementType === 'income_statement' ? '利润表' : '资产负债表') + c.year + ' 用 ' + c.kept + '（忽略 ' + c.dropped + '）').join('；'))
        : null;
      // 表头年份经常是错的（企业直接把去年的表改个名字），扫描器按文件名纠正了年度；
      // 这里把纠正过的逐条列出来，免得用户以为年度认错了。
      const yearNoticeBox = (scan && (scan.yearNotes || []).length)
        ? h('p', { className: 'pf-hint', style: { marginTop: 6, color: '#c96a00' } }, '年度按文件名纠正：'
          + scan.yearNotes.map(n => (n.statementType === 'income_statement' ? '利润表' : '资产负债表') + ' ' + n.fileName + ' 表头写 ' + n.from + '，按文件名取 ' + n.to + (n.requiresConfirmation ? '；原始期间：' + (n.originalPeriod || '未提供') + '，默认不勾选，请核实后主动勾选' : '')).join('；')
          + '。请核对原始期间、年度和金额。')
        : null;
      const scanSummary = scan
        ? '「01财务报表」' + (scan.files || []).length + ' 个文件，'
          + (scan.packs || []).length + ' 张报表（'
          + ((scan.summary || {}).balanceYears || []).join('/') + ' 资 · '
          + ((scan.summary || {}).incomeYears || []).join('/') + ' 利）'
        : '';
      const scanBox = scan
        ? h('div', { className: 'pf-card', style: { marginTop: 10 } },
          // 一行摘要：文件数/报表数/年度 + 展开/收起
          h('div', { className: 'pw-acts', style: { alignItems: 'center' } },
            h('b', null, scanSummary),
            ((scan.needManual || []).length) ? h('span', { className: 'pf-hint', style: { color: '#c96a00' } }, '　' + scan.needManual.length + ' 页待指定分类') : null,
            h('button', {
              type: 'button', className: 'pf-btn', style: { marginLeft: 'auto' },
              onClick: () => setScanOpen(!scanOpen),
            }, scanOpen ? '收起详情 ▲' : '详情 ▼'),
            h('button', { type: 'button', className: 'pf-btn', title: '放弃本次扫描结果，不影响已保存的本地报表', disabled: busy === 'scan' || aiBusy, onClick: () => { if (scanPending && !window.confirm('放弃本次尚未保存的扫描结果？已保存的本地报表不受影响。')) return; setScan(null); setScanPending(false); setBatch(null); } }, '✕')),
          scanOpen ? h('div', null,
            h('p', { className: 'pf-hint' }, '目录：' + (scan.rel || '') + '（请核对报表类型、年度及金额后确认保存到本地，不会直接写入天源）'),
            h('p', { className: 'pf-hint' }, '上一年候选：可从年报资产负债表期初数或利润表上年同期数生成；已有独立上一年报表时不生成。候选默认不勾选，请核对来源、期间与金额后自行勾选。'),
            needManualBox,
            aiBox,
            yearNoticeBox,
            packBox,
            conflictBox,
            h('div', { className: 'pw-acts', style: { marginTop: 6 } },
              h('button', { type: 'button', className: 'pf-btn', disabled: busy === 'scan', onClick: () => scanFolder() }, busy === 'scan' ? '扫描中…' : '重新扫描'),
              h('button', {
                type: 'button', className: 'pf-btn pri',
                disabled: busy === 'scan' || aiBusy || !(scan.packs || []).some(p => scanKeep[scanPackKey(p)]),
                onClick: applyScanToLocal,
              }, '确认并保存到本地（' + ((scan.packs || []).filter(p => scanKeep[scanPackKey(p)]).length) + ' 张）')),
            h('p', { className: 'pf-hint', style: { marginTop: 4 } }, '「写入本地」只存到这台机器的工作台里，不碰天源；核对无误后点右下角「预检」，预检通过在确认卡里点「保存并写入天源系统」。')
          ) : null)
        : null;
      // 批量预检结果：一次确认写全部
      const batchRunBox = (r, i) => {
        const rows = [];
        (((r.preview || {}).sheets) || []).forEach((sh, si) => {
          (sh.amountPreview || []).forEach((x, xi) => {
            rows.push(h('tr', { key: si + '-' + xi },
              h('td', null, String(sh.reportYear || '')),
              h('td', null, x.subjectName),
              h('td', { style: { textAlign: 'right' } }, fmt(x.amount))));
          });
        });
        return h('div', { key: i, style: { marginTop: 6 } },
          h('p', { className: 'pf-hint' }, h('b', null, (r.statementType === 'income_statement' ? '利润表' : '资产负债表') + ' ' + (r.years || []).join('/')), '　' + (r.prompt || '')),
          h('div', { className: 'pf-table-wrap', style: { maxHeight: 180, overflow: 'auto' } },
            h('table', { className: 'pf-grid pw-grid' },
              h('thead', null, h('tr', null, ['年度', '科目', '金额'].map((t, j) => h('th', { key: j }, t)))),
              h('tbody', null, rows))));
      };
      const batchErrBox = (batch && (batch.errors || []).length)
        ? h('div', { style: { marginTop: 6 } }, batch.errors.map((e, i) => h('p', { key: i, className: 'pf-hint' },
          h('b', null, '✗ ' + (e.statementType === 'income_statement' ? '利润表' : '资产负债表') + '：'), e.error,
          (e.details || []).length ? h('span', null, '（' + e.details.join('；') + '）') : null)))
        : null;
      // 要写天源就必须先选定天源项目 + 天源公司。没选时不能只闪一条 toast（用户会以为界面坏了），
      // 而是在「保存并写入天源系统」旁边常驻一条提示，说清差哪一步、去哪儿选。
      const tyReady = !!(box.tyProjectId && box.tyCompanyId);
      const tyHintBox = tyReady ? null
        : h('p', { className: 'pf-hint', style: { marginTop: 8, color: '#c96a00' } },
            '还不能写天源：' + (box.tyProjectId ? '' : '先在右上角「天源项目」里选项目') +
            (box.tyProjectId ? '' : (box.tyCompanyId ? '' : '，')) +
            (box.tyCompanyId ? '' : '再在「公司」里选对应的天源公司') +
            '。本地报表已经存好了，选完这两项再点「预检」。');
      const batchBox = batch
        ? h('div', { className: 'pf-card', style: { marginTop: 10 } },
          h('p', null, h('b', null, (batch.errors || []).length
            ? '预检结果（有未通过的）'
            : '天源预检通过：' + (batch.runs || []).map(r => (r.statementType === 'income_statement' ? '利润表' : '资产负债表') + ' ' + (r.years || []).join('/')).join('、') + '，共 ' + (batch.runs || []).reduce((s, r) => s + (((r.preview || {}).sheets) || []).length, 0) + ' 期')),
          (batch.runs || []).length ? h('p', { className: 'pf-hint' }, '将写入：' + batch.runs.map(r => fsTypeName(r.statementType) + ' ' + (r.years || []).join('/')).join('、') + '；未通过的报表不会写入。按报表分别提交，可能部分成功，请核对结果。') : null,
          (batch.runs || []).length
            ? h('button', {
              type: 'button', className: 'pf-btn', style: { marginLeft: 8 },
              onClick: () => setBatchOpen(!batchOpen),
            }, batchOpen ? '收起金额明细 ▲' : '查看金额明细 ▼')
            : null,
          batchOpen ? (batch.runs || []).map(batchRunBox) : null,
          batchErrBox,
          // 预检卡是按「当时选的天源项目+公司」生成的；如果公司下拉后来被清空/换过，
          // 这张卡对应的可能不是现在想写的公司，提示用户取消重预检最稳妥。
          !box.tyCompanyId
            ? h('p', { className: 'pf-hint', style: { margin: '6px 0 0', color: '#c96a00' } },
              '天源公司未选择，无法确认写入目标。请取消预检，选择项目和公司后重新预检。')
            : null,
          h('div', { className: 'pw-acts', style: { marginTop: 6 } },
            h('button', {              type: 'button', className: 'pf-btn pri',
              title: '确认后按报表类型写入天源，可能部分成功；需要时可通过只读查询核对结果',
              disabled: busy === 'batchExec' || !(batch.runs || []).length || !batch.projectId || !batch.companyId || batch.projectId !== String(box.tyProjectId || '') || batch.companyId !== String(box.tyCompanyId || '') || batch.mode !== String(mode) || batch.dataSnapshot !== JSON.stringify(['balance_sheet', 'income_statement'].map(st => ((box[st] || {}).byYear || {}))), onClick: executeBatch,
            }, busy === 'batchExec' ? '正在写入…' : '保存并写入天源系统'),
            h('button', {
              type: 'button', className: 'pf-btn',
              title: '放弃这张确认卡，不写入任何东西；预检过的数据还在本地，可以再改再预检',
              onClick: () => setBatch(null),
            }, '取消（不写入）')))
        : null;

      const goFinanceStep = i => {
        if (busy === 'scan' || aiBusy) { toast('请等待扫描或解析完成。', 'warn'); return; }
        if (i > 0 && scan && scanPending) {
          setScanOpen(true);
          toast('扫描结果尚未保存：请点击「确认并保存到本地」，或关闭扫描结果后再继续。', 'warn');
          return;
        }
        setFinanceStep(i);
      };
      return h('fieldset', { disabled: busy === 'batchExec', style: { border: 0, margin: 0, padding: 0, minWidth: 0 } },
        h('nav', { className: 'fs-steps', 'aria-label': '报表导入步骤' },
          ['扫描与分类', '核对本地报表', '预检与写入'].map((label, i) => h('button', {
            key: label, type: 'button', className: 'fs-step' + (financeStep === i ? ' active' : ''),
            'aria-current': financeStep === i ? 'step' : undefined, onClick: () => goFinanceStep(i),
          }, h('span', { className: 'fs-step-num' }, String(i + 1)), label))),
        financeStep !== 0 && scan && scanPending ? h('p', { className: 'pf-hint', role: 'status' }, '扫描结果尚待确认保存；下方仅展示或预检已保存到本地的报表。可返回第一步处理。') : null,
        // ── 第一行：公司 + 天源对接 + 导入按钮
        h('div', { className: 'pw-bar' },
          h('div', { className: 'pw-filters' },
            !lockId && financeStep === 0
              ? h('label', null, '公司', h('select', { className: 'pf-sel', value: cid, disabled: busy === 'scan' || aiBusy, onChange: e => { if (scanPending && !window.confirm('切换公司会放弃尚未保存的扫描结果，是否继续？')) return; setWho(e.target.value); setPreviewOpen(false); setScan(null); setScanKeep({}); setScanForce({}); setScanPending(false); setBatch(null); setResult(null); setAiNote(null); } }, rows.map(r => h('option', { key: r.id, value: r.id }, r.code + ' ' + r.name)))) : null,
            financeStep === 0 ? h('label', null, '报表口径', h('select', { className: 'pf-sel', value: mode, disabled: busy === 'scan' || aiBusy, onChange: e => { if (scanPending && !window.confirm('切换口径会放弃尚未保存的扫描结果，是否继续？')) return; setMode(e.target.value); setPreviewOpen(false); setScan(null); setScanKeep({}); setScanForce({}); setScanPending(false); setResult(null); setBatch(null); setAiNote(null); } },
              h('option', { value: '1' }, '单体'), h('option', { value: '2' }, '合并'))) : null,
            financeStep === 1 ? h('label', { title: baseDate ? ('从评估基准日 ' + baseDate + ' 所在年度往前推') : '项目里还没填评估基准日' }, '本地空表显示期数',
              h('select', { className: 'pf-sel', value: String(nPeriods), onChange: e => setPeriods(e.target.value) },
                Array.from({ length: FS_PERIODS_MAX }, (x, i) => h('option', { key: i, value: String(i + 1) }, String(i + 1) + ' 期'))),
              h('span', { className: 'pf-hint', style: { marginLeft: 4 } }, baseDate ? periods.map(p => p.year).join('/') : '先填评估基准日')) : null,
            h('button', {
              type: 'button', className: 'pf-btn' + (tab === 'balance_sheet' ? ' pri' : ''), style: { display: financeStep === 0 ? '' : 'none' }, disabled: busy === 'read',
              onClick: () => { setImportKind('balance_sheet'); if (fileBalRef.current) fileBalRef.current.click(); },
            }, busy === 'read' && importKind === 'balance_sheet' ? '读取中…' : '导入资产负债表文件'),
            h('button', {
              type: 'button', className: 'pf-btn' + (tab === 'income_statement' ? ' pri' : ''), style: { display: financeStep === 0 ? '' : 'none' }, disabled: busy === 'read',
              onClick: () => { setImportKind('income_statement'); if (fileIncRef.current) fileIncRef.current.click(); },
            }, busy === 'read' && importKind === 'income_statement' ? '读取中…' : '导入利润表文件'),
          ),
          h('input', { type: 'file', accept: '.xlsx,.xlsm,.xls', ref: fileBalRef, style: { display: 'none' }, onChange: e => onFile(e, 'balance_sheet') }),
          h('input', { type: 'file', accept: '.xlsx,.xlsm,.xls', ref: fileIncRef, style: { display: 'none' }, onChange: e => onFile(e, 'income_statement') }),
          h('div', { className: 'pw-acts', style: { display: financeStep === 2 ? 'flex' : 'none' } },
            h('span', { className: 'pf-hint' }, '报表口径：' + fsModeName(mode)),
            h('span', { className: 'pf-hint' }, '天源项目 '),
            h('select', { className: 'pf-sel', style: { maxWidth: 320 }, value: String(box.tyProjectId || ''), onChange: e => pickTyProject(e.target.value) },
              h('option', { value: '' }, ty.status === 'on' ? '选择天源项目' : (ty.status === 'loading' ? '连接中…' : '天源未连接')),
              tyOpts),
            h('span', { className: 'pf-hint' }, '公司 '),
            h('select', { className: 'pf-sel', style: { maxWidth: 260 }, value: String(box.tyCompanyId || ''), onChange: e => { fsTop(project.id, cur.id, () => ({ tyCompanyId: e.target.value })); setBatch(null); setResult(null); setAiNote(null); } },
              h('option', { value: '' }, '选择天源公司'), tyCOpts))),
        // 文件夹扫描是独立步骤，扫描不自动写入本地或天源。
        financeStep === 0 ? h('div', { className: 'pf-card', style: { marginTop: 10 } },
          h('b', null, '从文件夹扫描报表'),
          h('p', { className: 'pf-hint' }, '把各期报表放入本公司「01财务报表」文件夹，再点击扫描。识别后核对分类和年度，勾选需要的报表并确认保存到本地。'),
          h('button', { type: 'button', className: 'pf-btn pri', disabled: busy === 'scan', onClick: () => scanFolder() }, busy === 'scan' ? '扫描解析中…' : '扫描并解析文件夹报表')) : null,
        financeStep === 0 ? scanBox : null,
        // ── 跨期数据校验卡：写天源前的最后一道关
        financeStep === 1 && localYears.length ? h('div', { className: 'pf-card', style: { marginTop: 10, borderLeft: '4px solid ' + (valAllOk ? '#2e9e5b' : '#e07b39') } },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
            h('p', { style: { margin: 0 } }, h('b', null, '数据校验'),
              '　' + (valChecks.length ? (valAllOk ? '✓ ' + valChecks.length + ' 项全部一致' : '⚠ ' + valBad.length + ' / ' + valChecks.length + ' 项不一致') : '暂无可校验的多期数据')),
            h('button', { type: 'button', className: 'pf-btn', onClick: () => setValOpen(!valOpen) }, valOpen ? '收起明细' : '展开明细')),
          h('p', { className: 'pf-hint' }, '校验：每期「资产=负债+权益」「利润表三段勾稽」，以及「上年期末 = 本年年初」逐项衔接。金额有 0.05 元内尾差视为一致。'),
          valOpen && h('div', null, valChecks.length ? valChecks.map((c, i) => h('div', {
            key: i, style: { padding: '4px 0', borderTop: '1px solid rgba(0,0,0,.06)' },
          },
            h('div', null, h('span', { style: { color: c.ok ? '#2e9e5b' : '#c0392b', fontWeight: 600, marginRight: 6 } }, c.ok ? '✓' : '✗'),
              c.year + '年 · ' + c.label),
            h('div', { className: 'pf-hint', style: { paddingLeft: 18 } }, c.detail),
            (!c.ok && (c.diffs || []).length) ? h('div', { style: { paddingLeft: 18, maxHeight: 160, overflow: 'auto' } },
              c.diffs.slice(0, 20).map((d, j) => h('div', { key: j, className: 'pf-hint' },
                d.name + '：上年 ' + fmt(d.prev) + ' ≠ 本年 ' + fmt(d.cur) + '（差 ' + fmt(d.diff) + '）'))
            ) : null
          )) : h('p', { className: 'pf-hint' }, '只有一期本地数据时没有跨期校验项；可先导入多期再核对。'))) : null,
        // ── 写天源 / 查看天源：三个高频动作 + 一行流程说明（按钮名字短，作用靠说明讲清）
        h('div', { className: 'pw-acts', style: { display: financeStep === 0 ? 'none' : 'flex', marginTop: 16, alignItems: 'center', rowGap: 10 } },
          h('button', {
            type: 'button', className: 'pf-btn pri', style: { display: financeStep === 2 ? '' : 'none' },
            title: '第 1 步：把本地各期报表送天源预检，只核对科目和金额能不能填，不写入任何数据；通过后弹出确认卡',
            disabled: busy === 'batch' || busy === 'refresh' || (!localYears.length && (!sd.sheetData || showTy)),
            onClick: prepareBatch,
          }, busy === 'batch' ? '预检中…' : '预检（只核对不写入）'),
          h('button', {
            type: 'button', className: 'pf-btn',
            title: '只读操作：从天源拉回当前页签这种报表的现有数填进上方表格核对，不做任何写入',
            disabled: busy === 'refresh' || busy === 'batch' || busy === 'batchExec', onClick: refreshReports,
          }, busy === 'refresh' ? '读取中…' : '查看天源已导入' + fsTypeName(tab) + '（只读）'),
          showTy && (localYears.length || sd.sheetData) ? h('button', {
            type: 'button', className: 'pf-btn', onClick: () => setResult(null),
          }, '返回本地拟导入预览') : null,
          financeStep === 1 && localYears.length ? h('button', {
            type: 'button', className: 'pf-btn danger',
            title: '只清这台机器上存的本地报表（上方表格会清空）；天源上已经写入的数据不受影响',
            onClick: () => {
              if (!window.confirm('清掉本地已存的 ' + localYears.length + ' 期报表？天源上已经导入的不会动。')) return;
              fsUpdate(project.id, cid, mode, b => ({ balance_sheet: Object.assign(fsEmptyStmt(), { sheetData: null }), income_statement: Object.assign(fsEmptyStmt(), { sheetData: null }) }));
            },
          }, '清空本地报表（天源不动）') : null),
        // ── 批量预检结果：一次确认写全部
        financeStep === 2 ? batchBox : null,
        financeStep === 2 ? tyHintBox : null,
        h('div', { className: 'fs-step-nav' },
          financeStep > 0 ? h('button', { type: 'button', className: 'pf-btn', onClick: () => setFinanceStep(financeStep - 1) }, '上一步') : null,
          financeStep < 2 ? h('button', { type: 'button', className: 'pf-btn pri', onClick: () => goFinanceStep(financeStep + 1) }, '下一步：' + (financeStep === 0 ? '核对本地报表' : '预检与写入')) : null),
        // 本地核对与预检步骤显示公司身份；明细可按需展开。
        h('div', { style: { display: financeStep === 0 ? 'none' : '' } },
        h('p', { className: 'pf-hint' }, '当前公司：' + cur.name + ' · 报表口径：' + fsModeName(mode)),
        // ── 页签：资产负债表 / 利润表
        h('div', { className: 'pw-tabs', style: { marginTop: 20, gap: 8, alignItems: 'center', paddingBottom: 8 } },
          FS_TYPES.map(t => {
            return h('button', { key: t.key, type: 'button', className: 'pf-btn sm' + (tab === t.key ? ' pri' : ''), onClick: () => { setTab(t.key); setResult(null); } },
              t.name);
          }),
          h('span', { className: 'pf-hint' }, showTy
            ? ('天源「' + fsTypeName(tab) + '」（' + fsModeName(box.tyMode || mode) + '）的现有数' + (result && result.report ? '，天源已有年度 ' + ((result.report.existingYears || []).join('/') || '无') : ''))
            : (sd.sheetData
              ? ((localYears.length > 1 ? '本地 ' + localYears.length + ' 期：' : '本地文件：') + (localYears.length > 1 ? localYears.join('/') : ((sd.fileName || '') + (sd.sheet ? ' · 「' + sd.sheet + '」' : '') + (sd.period ? ' · ' + sd.period : ''))))
              : '这个页签还没有导入，下面是天源' + fsTypeName(tab) + '的空白报表（可照着填、核对）'))),
        // ── 明细默认收起，按公司和当前表类型按需展开；不改变本地或天源数据。
        h('button', { type: 'button', className: 'pf-btn', 'aria-expanded': previewOpen, onClick: () => setPreviewOpen(v => !v) }, previewOpen ? '收起报表预览 ▲' : '展开报表预览 ▼'),
        previewOpen ? h('div', { className: 'fs-preview' },
          h('p', { className: 'pf-hint' }, (localYears.length && !showTy)
            ? ('本地拟导入预览：' + localYears.length + ' 期（' + localYears.join('/') + '）。下表显示本地拟提交金额，不代表天源已保存；核对后预检，确认无误再写入。')
            : (showTy
              ? ('天源现有 ' + (((result && result.tyRows) || []).length) + ' 个科目' + (result && result.report ? ('，已有年度 ' + ((result.report.existingYears || []).join('/') || '无') + '，可导入年度 ' + ((result.report.missingYears || []).join('/') || '无')) : '') + '。')
              : (sd.sheetData
              ? ('本地文件可写入天源 ' + ((sd.sheetData.detail || []).length) + ' 个科目' + (((sd.sheetData.skipped || []).length) ? ('，跳过 ' + sd.sheetData.skipped.length + ' 行（' + ((sd.sheetData.skipSummary || ['天源模板里没有对应科目']).join('；')) + '）') : '')
                + (tot['资产总计'] != null ? '；资产总计 ' + fmt(tot['资产总计']) + '，负债+权益 ' + fmt((tot['负债合计'] || 0) + (tot['所有者权益合计'] || 0)) : '')
                + (((sd.sheetData.duplicates || []).length) ? '；重复挂同一科目 ' + sd.sheetData.duplicates.length + ' 处（保留第一处）' : ''))
                : '下面按天源模板列出' + fsTypeName(tab) + '的全部科目，金额列按「报表显示期数」排出 ' + periods.map(p => p.year + '-12-31').join('、') + '；点上面「导入' + fsTypeName(tab) + '」读入本地文件后按所属年度填上，没有数据的年度显示「—」。'))),
          // 本地已存了多期（从「01财务报表」一次导入各期）就按年度列出来逐期核对，这是写天源前的唯一凭据
          (localYears.length && !showTy)
            ? fsBlankTable(tab, null, localPeriods, localMemo)
            : (sd.sheetData && !showTy
              ? h('div', { className: 'pf-table-wrap', style: { maxHeight: 360, overflow: 'auto' } },
                h('table', { className: 'pf-grid pw-grid' },
                  h('thead', null, h('tr', null, ['源表科目', '天源科目'].concat(periods.map(p => p.label)).map((t, i) => h('th', { key: i }, t)))),
                  h('tbody', null, (sd.sheetData.detail || []).map((r, i) => {
                    const src = (sd.rows || []).filter(x => String(x.name).replace(/\s/g, '') === String(r.originName).replace(/\s/g, ''))[0] || null;
                    const vals = src
                      ? periods.map(p => (p.kind === 'now' ? (src.values || [])[0] : (p.kind === 'prev' ? (src.values || [])[1] : undefined)))
                      : periods.map(p => (p.kind === 'now' ? r.amount : undefined));
                    return h('tr', { key: i },
                      h('td', null, r.originName),
                      h('td', null, r.subjectName),
                      vals.map((v, j) => h('td', { key: j, style: { textAlign: 'right' } }, fmt(v))));
                  }))))
              : fsBlankTable(tab, showTy ? (((result && result.tyRows) || []).map(w => w.subjectName)) : null, periods, tyMemo))) : null,
        box.lastResult
          ? h('p', { className: 'pf-hint', style: { marginTop: 8 } }, '上次导入：' + (box.lastResult.statementType === 'income_statement' ? '利润表' : '资产负债表') + ' · ' + (box.lastResult.mode === 2 ? '合并' : '单体') + ' · ' + String(box.lastResult.at || '').slice(0, 19).replace('T', ' ') + (box.lastResult.summary ? (' · 写入 ' + box.lastResult.summary.importedSubjectCount + ' 个科目') : ''))
          : null));
    }

    // 管理类底稿：一个项目一套，落在 03评估底稿/管理类底稿/<分类>。
    // 基础类资料：每家公司一套，按「分类在前、公司在后」放在
    // 02现场资料/企业提供资料/02基础类/<公司>/<分类>，界面上也是一家一块接一家往下排。
    function CatalogPanel({ kind, project, s, toast, openSub, onlyId }) {
      const cat = kind === 'mgmt' ? MGMT_CATALOG : BASIC_CATALOG;
      const itemsTable = company => h('div', { className: 'pf-table-wrap' },
        h('table', { className: 'pf-grid pw-grid' },
          h('thead', null, h('tr', null, ['序号', '分类', '文件类型', '操作'].map((t, i) => h('th', { key: i }, t)))),
          h('tbody', null, cat.map((it, i) => h('tr', { key: i },
            h('td', null, String(i + 1)),
            h('td', null, it[0]),
            h('td', null, it[1]),
            h('td', null, h('button', { type: 'button', className: 'pf-btn sm', onClick: () => openSub(catalogFolder(kind, it[0], company)) }, '打开文件夹')))))));
      if (kind === 'mgmt') {
        return h('div', null,
          h('p', { className: 'pf-hint' }, '管理类底稿一个项目一套（不按公司拆），共 ' + cat.length + ' 项：点「打开文件夹」在 03评估底稿/管理类底稿/<分类> 里放文件，归档时整个项目文件夹会一起移进文件库。'),
          itemsTable(''));
      }
      const all = eqRows(eqListOf(s, project.id));
      // onlyId：从某家公司行内进来，只看这一家
      const companies = onlyId ? all.filter(r => r.id === onlyId) : all;
      if (!companies.length) {
        return h('div', null, h('p', { className: 'pf-hint' }, '还没有公司。先到「股权信息」里添加被评估单位和子公司，基础类资料按公司各配一套（每家公司 ' + cat.length + ' 项）。'));
      }
      if (onlyId) {
        // 页头已经写了公司名和「目录：…」，这里不再重复
        return itemsTable(companies[0].name);
      }
      return h('div', null,
        h('p', { className: 'pf-hint' }, '基础类资料每家公司一套（' + companies.length + ' 家 × ' + cat.length + ' 项），目录 02现场资料/企业提供资料/02基础类/<公司>/<分类>；管理类资料另有页签，一个项目一套。'),
        companies.map(r => h('div', { key: r.id, className: 'pw-co-block' },
          h('div', { className: 'pw-co-head' },
            h('b', { className: 'pf-mono' }, r.code),
            h('span', { className: 'pw-co-name' }, r.name),
            h('button', { type: 'button', className: 'pf-btn sm', onClick: () => openSub(basicFolderOf(r.name)) }, '打开这家公司的文件夹')),
          itemsTable(r.name))));
    }

    function SummaryPanel({ project, s, openSub }) {
      const rows = eqRows(eqListOf(s, project.id));
      const set = rows.filter(r => eqMethodText(r)).length;
      return h('div', null,
        h('p', { className: 'pf-hint' }, '结果汇总读取的是本项目的股权信息与已设置的评估方法（' + set + ' / ' + rows.length + ' 家已设方法）。整体/非整体评估的价值数要等天源线上出具汇总后才有，这里不代算。'),
        h('div', { className: 'pf-table-wrap' },
          h('table', { className: 'pf-grid pw-grid' },
            h('thead', null, h('tr', null, ['编码', '公司层级 / 公司名称', '股权比例%', '评估方法', '公司负责人'].map((t, i) => h('th', { key: i }, t)))),
            h('tbody', null, rows.length ? rows.map(r => h('tr', { key: r.id },
              h('td', { className: 'pf-mono' }, r.code),
              h('td', { style: { paddingLeft: 8 + r.depth * 18 } }, r.name),
              h('td', null, r.ratio === '' || r.ratio == null ? '—' : r.ratio),
              h('td', null, eqMethodText(r) || h('span', { className: 'pf-hint' }, '未设置')),
              h('td', null, r.manager || '—'))) : h('tr', null, h('td', { colSpan: 5, className: 'pf-empty' }, '还没有股权信息'))))),
        h('div', { className: 'pw-foot' },
          h('button', { type: 'button', className: 'pf-btn', onClick: () => openSub('') }, '打开项目文件夹')));
    }

    function ReportPanel({ project }) {
      const p = project;
      const items = [
        ['评估目的', p.purpose], ['价值类型', p.valueType], ['评估对象-报告', p.objectReport],
        ['评估范围-报告', p.scopeReport], ['经济行为', p.economicBehavior], ['评估基准日', p.baseDate],
        ['报告文号', p.reportNo], ['评估报告日', p.reportDate], ['归档日', p.archiveDate],
      ];
      return h('div', null,
        h('p', { className: 'pf-hint' }, '这些是项目表单里已填的报告口径，改口径请回「本地项目 → 编辑」。'),
        h('table', { className: 'pf-grid pw-grid' },
          h('thead', null, h('tr', null, h('th', null, '项目'), h('th', null, '内容'))),
          h('tbody', null, items.map(([k, v]) => h('tr', { key: k }, h('td', null, k), h('td', null, v || '—'))))));
    }

    function FilesPanel({ project, s, toast, openSub, onBind }) {
      const rows = useMemo(() => eqRows(eqListOf(s, project.id)), [s, project.id]);
      const abs = projectAbs(project);
      const subs = [['02现场资料/业务委托合同', '业务委托合同'], ['02现场资料/企业提供资料/00财务资料', '财务资料（按公司）'], ['02现场资料/企业提供资料/00财务资料/00未分配财务资料', '未分配财务资料'], ['02现场资料/企业提供资料/02基础类', '基础类资料（按公司）'], [MGMT_FOLDER, '管理类底稿'], ['03评估申报', '评估申报与核实资料'], ['05报告', '报告与明细表']];
      return h('div', null,
        h('div', { className: 'pf-card', style: { margin: '0 0 10px' } },
          h('b', null, '项目文件夹绑定'),
          h('p', { className: 'pf-hint' }, abs
            ? '已绑定本地文件夹，项目的打开/底稿/归档都认这个目录。'
            : '尚未绑定真实文件夹：绑定后财务资料、未分配资料等功能才能读写真实目录。'),
          h('code', { className: 'pf-hint', style: { display: 'block', wordBreak: 'break-all' } }, abs || folderNameOf(project)),
          h('div', { className: 'pw-acts' },
            onBind ? h('button', { type: 'button', className: 'pf-btn pri', title: '把这个项目和磁盘上某个文件夹绑定（或改绑、解绑）', onClick: () => onBind(project) }, abs ? '改绑定' : '绑定文件夹') : null,
            h('button', { type: 'button', className: 'pf-btn', onClick: () => openSub('') }, '打开项目根目录'))),
        h(UnallocatedFinance, { key: String(project.id), project: project, rows: rows, toast: toast, openSub: openSub }),
        h('p', { className: 'pf-hint' }, '项目文件都在「' + projectFolderLabel(project) + '」下按阶段分目录存放，点下面的按钮直接打开对应目录。'),
        h('div', { className: 'pw-acts' },
          subs.map(([p2, t]) => h('button', { key: p2, type: 'button', className: 'pf-btn', onClick: () => openSub(p2) }, t))));
    }

    function ExportPanel({ project, s, toast, openSub }) {
      const rows = eqRows(eqListOf(s, project.id));
      const exportCsv = () => {
        const head = ['编码', '公司名称', '公司简称', '上级母公司', '股权比例%', '科目名称', '公司负责人', '评估方法'];
        const byId = {};
        rows.forEach(r => { byId[r.id] = r; });
        const lines = [head.join(',')];
        rows.forEach(r => {
          const cells = [r.code, r.name, r.short || '', (r.parentId && byId[r.parentId] ? byId[r.parentId].name : ''), r.ratio, eqSubjectOf(r, byId), r.manager || '', eqMethodText(r)];
          lines.push(cells.map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(','));
        });
        const blob = new Blob([String.fromCharCode(65279) + lines.join(String.fromCharCode(13, 10))], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (project.code || 'project') + '-股权信息.csv';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        toast('股权信息已导出 CSV', 'info');
      };
      return h('div', null,
        h('p', { className: 'pf-hint' }, '线上报告的生成/导出仍走天源（项目页「生成/导出」那一套）。本机这里能导出股权信息 CSV，方便核对底稿。'),
        h('div', { className: 'pw-acts' },
          h('button', { type: 'button', className: 'pf-btn pri', onClick: exportCsv }, '导出股权信息（CSV）'),
          h('button', { type: 'button', className: 'pf-btn', onClick: () => openSub('') }, '打开项目文件夹')));
    }

    function TplPanel({ project, toast, openSub }) {
      const cats = [['报表模板', '资产评估报告模板'], ['报表模板', '评估说明模板'], ['报表模板', '评估明细表模板'], ['报表模板', '申报表模板']];
      const tplDir = '03评估底稿/报表模板';
      return h('div', null,
        h('p', { className: 'pf-hint' }, '报表模板放在项目目录「' + tplDir + '」下，改好直接放进对应项目即可。'),
        h('div', { className: 'pf-table-wrap' },
          h('table', { className: 'pf-grid pw-grid' },
            h('thead', null, h('tr', null, h('th', null, '序号'), h('th', null, '模板'), h('th', null, '操作'))),
            h('tbody', null, cats.map((it, i) => h('tr', { key: i },
              h('td', null, String(i + 1)),
              h('td', null, it[1]),
              h('td', null, h('button', { type: 'button', className: 'pf-btn sm', onClick: () => openSub(tplDir) }, '打开文件夹'))))))));
    }

    function ProjectWorkspace({ project: rawProject, s, toast, onBack, onBind }) {
      const project = useMemo(() => normalizeProject(rawProject || {}), [rawProject && rawProject.id, rawProject && rawProject.updatedAt]);
      const [tab, setTab] = useState('work');
      const [sub, setSub] = useState('equity');
      // co={id,kind}：从股权信息某一行点「财务资料 / 基础类资料」进来的单家公司视图
      const [co, setCo] = useState(null);
      const folder = folderNameOf(project);
      const abs = projectAbs(project);

      const openSub = async path => {
        try {
          const parts = path ? String(path).split('/').filter(Boolean) : [];
          // 已归档：项目目录已经移到归档库，别在 00项目ing 里新建空壳，直接开归档后的对应子目录
          if (project.archivePath) {
            const rel = [project.archivePath, ...parts].join('\\');
            const r = await fetch(PREFIX + '/lib/open', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rel }),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok || !d.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
            toast('已打开：' + (d.abs || rel), 'info');
            return;
          }
          if (project.stage === '归档/收款') throw new Error('该项目已归档，归档路径未记录，请在「文件库」里查找');
          const r = await fetch(PREFIX + '/project/folder', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder: folder, abs: abs, sub: parts, create: true }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
          toast('已打开：' + d.path, 'info');
        } catch (e) {
          toast('打开失败：' + ((e && e.message) || e) + (e && /404/.test(String(e.message)) ? '（宿主未重载，重启 DSH 后可用）' : ''), 'warn');
        }
      };

      return h('div', { className: 'pw-root' },
        h('div', { className: 'pw-head' },
          h('div', { className: 'pw-head-l' },
            h('button', { type: 'button', className: 'pf-btn sm', onClick: onBack }, '← 项目列表'),
            h('div', { className: 'pw-title' }, h('b', null, project.code || '未编号'), h('span', null, ' | '), h('span', null, project.name || '未命名项目'))),
          h('div', { className: 'pw-head-r' },
            h('span', { className: 'pf-hint' }, '基准日 ' + (project.baseDate || '—') + ' · 项目经理 ' + (managerText(project.team) || '—') + ' · ' + (project.stage || '进行中')),
            // 目录标识：绑定了就亮出绝对路径，一眼看出它不是项目根下的自动目录
            h('span', { className: 'pf-hint', title: abs ? '已绑定本地文件夹' : '自动生成的目录（项目根下）' },
              abs ? h('span', { className: 'pf-folder-chip' }, '📁 ' + abs) : '📁 ' + folder),
            onBind ? h('button', { type: 'button', className: 'pf-btn sm', title: '把这个项目和磁盘上某个文件夹绑定（或改绑、解绑）', onClick: () => onBind(project) }, abs ? '改绑定' : '绑定文件夹') : null,
            h('button', { type: 'button', className: 'pf-btn sm', onClick: () => openSub('') }, '打开项目文件夹'))),
        h('div', { className: 'pw-tabs' }, PW_TABS.map(([k, t]) => h('button', { key: k, type: 'button', className: 'pw-tab ' + (tab === k ? 'on' : ''), onClick: () => setTab(k) }, t))),
        h('div', { className: 'pw-body' },
          tab === 'work' ? h('div', null,
            h('div', { className: 'pw-subtabs' }, WORK_SUBS.map(([k, t]) => h('button', { key: k, type: 'button', className: 'pw-subtab ' + (sub === k && !co ? 'on' : ''), onClick: () => { setCo(null); setSub(k); } }, t))),
            sub === 'equity'
              ? (co
                ? h(CompanyMaterials, { project: project, s: s, toast: toast, openSub: openSub, co: co, onBack: () => setCo(null) })
                : h(EquityPanel, { project: project, s: s, toast: toast, openSub: openSub, onOpenCo: (id, kind) => setCo({ id: id, kind: kind }), goFiles: () => setTab('files') }))
              : h(CatalogPanel, { kind: 'mgmt', project: project, s: s, toast: toast, openSub: openSub }))
          : tab === 'sum' ? h(SummaryPanel, { project: project, s: s, openSub: openSub })
          : tab === 'report' ? h(ReportPanel, { project: project })
          : tab === 'files' ? h(FilesPanel, { project: project, s: s, toast: toast, openSub: openSub, onBind: onBind })
          : tab === 'export' ? h(ExportPanel, { project: project, s: s, toast: toast, openSub: openSub })
          : h(TplPanel, { project: project, toast: toast, openSub: openSub })));
    }

    const pwCss = [
      '.pw-root{display:flex;flex-direction:column;gap:10px;padding:2px 0 18px}',
      '.pw-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 12px;border:1px solid #e5e7eb;border-radius:10px;background:#fafbfc}',
      '.pw-head-l{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.pw-head-r{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.pw-title{font-size:14px;color:#111827;display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}',
      '.pw-title b{font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      '.pw-tabs{display:flex;gap:2px;flex-wrap:wrap;border-bottom:1px solid #e5e7eb}',
      '.pw-tab{border:0;background:transparent;padding:8px 14px;font-size:13px;color:#4b5563;cursor:pointer;border-bottom:2px solid transparent}',
      '.pw-tab:hover{color:#1d4ed8}',
      '.pw-tab.on{color:#1d4ed8;border-bottom-color:#1d4ed8;font-weight:600}',
      '.pw-body{border:1px solid #e5e7eb;border-radius:10px;padding:12px;background:#fff;min-height:380px}',
      '.pw-subtabs{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px}',
      '.pw-subtab{border:1px solid #e5e7eb;background:#f9fafb;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;color:#374151}',
      '.pw-subtab.on{background:#e8f0ff;border-color:#bcd0ff;color:#1d4ed8;font-weight:600}',
      '.fs-steps{display:flex;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--dsh-border,#444);padding:0 0 10px;margin-bottom:12px}',
      '.fs-step{display:inline-flex;align-items:center;gap:8px;border:1px solid transparent;border-radius:7px;background:transparent;color:inherit;opacity:.7;padding:8px 12px;cursor:pointer}',
      '.fs-step.active{opacity:1;color:#61b0f2;background:rgba(52,143,215,.14);border-color:rgba(82,163,230,.35);font-weight:600}',
      '.fs-step-num{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:rgba(127,127,127,.22);font-size:12px}',
      '.fs-step.active .fs-step-num{background:#428dc9;color:#fff}',
      '.fs-step-nav{display:flex;gap:8px;justify-content:flex-end;margin:16px 0}',
      '.pw-bar{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}',
      '.pw-filters{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.pw-filters label{display:flex;align-items:center;gap:6px;font-size:12px;color:#4b5563;white-space:nowrap;flex:0 0 auto}',
      '.pw-filters .pf-in{min-width:150px}',
      '.pw-acts{display:flex;gap:8px;flex-wrap:wrap}',
      '.pw-grid th,.pw-grid td{font-size:12px;white-space:nowrap}',
      '.fs-preview .pf-table-wrap thead th{position:sticky;top:0;z-index:2}',
      '.pw-hint{font-size:12px;color:#6b7280;margin:0 0 8px;line-height:1.6}',
      '.pw-form{display:flex;flex-direction:column;gap:10px}',
      '.pw-form>label{display:grid;grid-template-columns:96px 1fr;align-items:center;gap:8px;font-size:12px;color:#374151}',
      '.pw-req{color:#dc2626;font-style:normal;margin-right:2px}',
      '.pw-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      // 表单里「下拉 + 按钮」同一行：下拉别把整行撑满，按钮才不会被挤到下一行
      '.pw-inline>.pf-sel{flex:0 1 340px;max-width:340px}',
      '.pw-inline>.pf-in{flex:1 1 180px;min-width:150px;max-width:320px}',
      // 股权比例这类数字框不要上下小箭头，跟设计稿一致
      '.pw-form input[type=number]::-webkit-outer-spin-button,.pw-form input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}',
      '.pw-form input[type=number]{-moz-appearance:textfield;appearance:textfield}',
      '.pw-shares{display:flex;flex-direction:column;gap:6px;border-top:1px dashed #e5e7eb;padding-top:8px}',
      '.pw-err{color:#b91c1c;font-size:12px;margin-top:6px}',
      '.pw-foot{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:14px}',
      '.pw-co-block{border:1px solid #eef0f3;border-radius:10px;padding:10px 12px;margin-bottom:12px;background:#fcfdff}',
      '.pw-co-title{display:flex;align-items:baseline;gap:8px;font-size:13px;font-weight:600;color:#111827}',
      '.pw-co-title .pw-co-name{font-weight:600}',
      '.pw-co-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px}',
      '.pw-co-bar .pf-btn[title]{margin-left:auto}',
      '.pw-co-dir{margin:0 0 10px}',
      '.pw-co-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}',
      '.pw-co-head .pw-co-name{font-size:13px;font-weight:600;color:#111827}',
      '.pw-co-head .pf-btn{margin-left:auto}',
      '.pw-sec-t{font-size:12px;font-weight:600;color:#374151;margin:10px 0 6px}',
      '.pw-checks{display:flex;gap:14px;flex-wrap:wrap}',
      '.pw-check{display:flex;align-items:center;gap:5px;font-size:12px;color:#374151}',
      'body[data-ds-dark-theme] .pw-head,body[data-ds-dark-theme] .pw-body{background:#1c1c1f;border-color:#3a3a3e}',
      'body[data-ds-dark-theme] .pw-title,body[data-ds-dark-theme] .pw-sec-t{color:#f2f2f2}',
      'body[data-ds-dark-theme] .pw-tabs{border-color:#3a3a3e}',
      'body[data-ds-dark-theme] .pw-tab{color:#c7c7cc}',
      'body[data-ds-dark-theme] .pw-subtab{background:#26262a;border-color:#3a3a3e;color:#ddd}',
      'body[data-ds-dark-theme] .pw-subtab.on{background:#1e3a8a44;border-color:#3b5bdb;color:#8ab4ff}',
    ].join(String.fromCharCode(10));

    function projectStatusTag(p) {
      if (p.stage === '归档/收款') return h('span', { className: 'wb-tag grey' }, '已归档');
      const overdue = p.deadline && dateDiff(p.deadline, todayStr()) < 0;
      return h('span', { className: 'wb-tag' + (overdue ? ' red' : '') }, overdue ? '已逾期' : (p.stage || '进行中'));
    }

    function riskTag(risk) {
      if (!risk) return h('span', { className: 'wb-tag grey' }, '未定级');
      const map = { A: 'red', B: 'warn', C: '' };
      return h('span', { className: 'wb-tag ' + (map[risk] || '') }, risk + ' · ' + ({ A: '高风险', B: '中风险', C: '低风险' }[risk] || ''));
    }

    // 归档确认弹窗：先只读预览项目里「04项目归档」的内容，用户确认后才把整个项目文件夹移进归档库。
    // 目标目录：已归档\{年份}年\{项目编号 项目简称}；移动成功后宿主会顺手触发一次增量扫描。
    function ArchiveDialog({ project, toast, onClose, onArchived }) {
      const [pre, setPre] = useState(null);
      const [err, setErr] = useState('');
      const [busy, setBusy] = useState(false);
      const busyRef = useRef(false);
      const p = project || {};
      const bodyOf = () => JSON.stringify({
        folder: folderNameOf(p), legacy: legacyFolderName(p), abs: projectAbs(p),
        code: p.code, shortName: p.shortName || p.name, name: p.name, year: projectYear(p),
      });
      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const r = await fetch(PREFIX + '/project/archive/preview', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyOf(),
            });
            if (r.status === 404) throw new Error('宿主未重载，重启 DSH 后可用');
            const d = await r.json().catch(() => ({}));
            if (!alive) return;
            if (!r.ok || !d.ok) { setErr(d.error || ('HTTP ' + r.status)); return; }
            setPre(d);
          } catch (e) { if (alive) setErr(String((e && e.message) || e)); }
        })();
        return () => { alive = false; };
      }, [p.id]);

      const confirm = async () => {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true); setErr('');
        try {
          const r = await fetch(PREFIX + '/project/archive/commit', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyOf(),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
          onArchived(d);
          const scanText = d.scan
            ? (d.scanPending ? '；等当前扫描结束后会自动再扫一轮，文件库随之更新' : '；文件库正在后台增量更新')
            : '；文件库更新未启动：' + (d.scanError || '未知原因');
          toast('已归档到 ' + d.to + scanText, 'ok');
          onClose();
        } catch (e) {
          setErr('归档失败：' + ((e && e.message) || e));
          busyRef.current = false;
          setBusy(false);
        }
      };

      const sub = pre && pre.sub;
      return h(Modal, { title: '归档项目 · ' + (p.shortName || p.name || '未命名项目'), onClose: busy ? () => {} : onClose },
        err ? h('div', { className: 'wb-alert danger' }, h('div', { className: 't' }, '没能归档'), h('div', { className: 'b' }, err)) : null,
        !pre && !err ? h('p', { className: 'pf-hint', style: { margin: '4px 0 0' } }, '正在读取「04项目归档」…') : null,
        pre ? h('div', null,
          h('div', { className: 'wb-hint', style: { lineHeight: 1.9, margin: '2px 0 10px', wordBreak: 'break-all' } },
            '源目录：', h('code', null, pre.source), h('br'),
            '归档到：', h('code', null, pre.target),
            pre.targetExists ? h('div', { style: { color: '#b91c1c', fontWeight: 600 } }, '目标目录已存在，不能归档（请先处理同名目录）') : null),
          h('div', { className: 'pf-list-t', style: { margin: '6px 0 4px', display: 'flex', alignItems: 'baseline', gap: 8 } },
            h('b', null, '04项目归档 内容'),
            h('span', { className: 'pf-hint' },
              sub && sub.exists
                ? sub.files + ' 个文件 · ' + sub.dirs + ' 个目录 · ' + fmtSize(sub.bytes)
                : '目录不存在')),
          sub && sub.exists && sub.files === 0
            ? h('div', { className: 'pf-hint', style: { color: '#a35b00', margin: '0 0 4px' } }, '04项目归档 里还没有文件（只有空目录）')
            : null,
          h('div', { style: { maxHeight: 260, overflow: 'auto', border: '1px solid var(--dsw-alias-border-l1,#e5e7eb)', borderRadius: 6, padding: '6px 8px', background: 'var(--dsw-alias-bg-layer-1,#fafafa)', marginBottom: 10 } },
            sub && sub.items && sub.items.length
              ? sub.items.map((it, i) => h('div', { key: i, style: { font: '12px/1.8 Consolas, monospace', whiteSpace: 'nowrap', paddingLeft: 10 * (it.level || 0) } },
                h('span', { style: { color: it.dir ? 'var(--wb-accent,#2563eb)' : 'var(--dsw-alias-label-secondary,#6b7280)' } }, it.dir ? '▸ ' : '· '),
                h('span', null, it.name),
                it.dir ? null : h('span', { style: { color: 'var(--dsw-alias-label-secondary,#9ca3af)' } }, '  ' + fmtSize(it.size))))
              : h('span', { className: 'pf-hint' }, sub && sub.exists ? '（04项目归档 里还没有文件）' : '（项目里还没有 04项目归档 目录）'),
            sub && sub.truncated ? h('div', { className: 'pf-hint', style: { paddingTop: 4 } }, '还有 ' + (sub.total - sub.items.length) + ' 项未显示（归档不受影响）') : null),
          h('p', { className: 'pf-hint', style: { margin: '0 0 12px' } },
            '归档会把整个项目文件夹（不只是 04项目归档）移动到「已归档」的 ' + pre.yearFolder + ' 下，目录名用「项目编号 项目简称」；移动后本地不再保留该项目目录，项目标记为已归档，并自动增量更新文件库。')) : null,
        pre ? h('div', { className: 'wb-row', style: { justifyContent: 'flex-end' } },
          h(Btn, { className: 'sm', onClick: onClose, disabled: busy }, '取消'),
          h(Btn, { variant: 'pri', className: 'sm', onClick: confirm, disabled: busy || pre.targetExists }, busy ? '归档中…' : '确认归档')) : null);
    }

    // 绑定本地文件夹的小弹窗：选择已有 / 新建 / 手填路径 / 解除绑定。
    // 只改 project.folderPath（一个绝对路径字段），磁盘上已有的东西一律不动。
    function BindFolderDialog({ project, onClose, onSave, toast }) {
      const p = project || {};
      const [path, setPath] = useState(projectAbs(p));
      const [busy, setBusy] = useState('');
      const [info, setInfo] = useState(null);   // 探测结果 {dirs,files,sample}
      const probe = async v => {
        if (!String(v || '').trim()) { setInfo(null); return; }
        try {
          const r = await fetch(PREFIX + '/project/folder/probe', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: v }),
          });
          const d = await r.json().catch(() => ({}));
          setInfo(d && d.ok ? d : { error: (d && d.error) || '路径不可用' });
        } catch (e) { setInfo({ error: String((e && e.message) || e) }); }
      };
      const pickExisting = async () => {
        setBusy('pick');
        try {
          const got = await pickFolderToBind();
          if (!got) return;
          setPath(got.path);
          setInfo(got);
        } catch (e) { toast(String((e && e.message) || e), 'danger'); }
        finally { setBusy(''); }
      };
      const createIn = async () => {
        setBusy('new');
        try {
          const parent = await pickDirectoryPath();
          if (!parent) return;
          const r = await fetch(PREFIX + '/project/folder/new', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parent, year: projectYear(p), code: cleanSegment(p.code), shortName: cleanSegment(p.shortName || p.name) }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
          setPath(d.path);
          probe(d.path);
          toast((d.created ? '已新建：' : '已存在，直接绑定：') + d.path, 'info');
        } catch (e) { toast('新建失败：' + String((e && e.message) || e), 'danger'); }
        finally { setBusy(''); }
      };
      const ok = async () => {
        const v = String(path || '').trim();
        setBusy('save');
        try {
          if (v) {
            // 走一次 /project/folder（create=true）：顺手把目录建出来，避免绑一个不存在的路径
            const r = await fetch(PREFIX + '/project/folder', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ folder: folderNameOf(p), abs: v, legacy: legacyFolderName(p), create: true, open: false }),
            });
            if (r.status === 404) throw new Error('宿主未重载：重启 DSH 后可用');
            const d = await r.json().catch(() => ({}));
            if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
            onSave({ folderPath: d.path, folderBoundAt: new Date().toISOString() });
          } else {
            onSave({ folderPath: '', folderBoundAt: '' });   // 清空 = 解除绑定，回到自动命名
          }
          onClose();
        } catch (e) { toast('绑定失败：' + String((e && e.message) || e), 'danger'); }
        finally { setBusy(''); }
      };
      const cur = projectAbs(p);
      return h(Modal, { title: '本地文件夹 · ' + (p.name || '未命名项目'), onClose, style: { maxWidth: 720 } },
        h('p', { className: 'pf-hint', style: { margin: '0 0 10px' } },
          '绑定后，这个项目的「打开文件夹 / 合同扫描件 / 底稿目录 / 归档」都只认你指定的这个目录，可以放在 OneDrive、客户共享盘等任意位置。不绑定时自动用「项目根目录\\' + folderNameOf(p) + '」。'),
        h('div', { className: 'pf-folder' },
          h('input', {
            className: 'pf-in', value: path, placeholder: '绝对路径，例如 ' + folderNameOf(p),
            onChange: e => setPath(e.target.value), onBlur: () => probe(path),
          })),
        h('div', { className: 'pf-folder-acts', style: { marginTop: 8 } },
          h('button', { type: 'button', className: 'pf-btn', disabled: !!busy, onClick: pickExisting }, busy === 'pick' ? '选择中…' : '选择已有文件夹'),
          h('button', { type: 'button', className: 'pf-btn', disabled: !!busy, onClick: createIn }, busy === 'new' ? '创建中…' : '新建文件夹…'),
          cur ? h('button', { type: 'button', className: 'pf-btn danger', disabled: !!busy, onClick: () => { setPath(''); setInfo(null); } }, '清空（解除绑定）') : null),
        info
          ? (info.error
            ? h('div', { className: 'pf-err', style: { marginTop: 8 } }, info.error)
            : h('div', { style: { marginTop: 8, fontSize: 12 } },
              h('span', { className: 'pf-folder-chip' }, '目录可用'),
              h('span', { className: 'pf-hint', style: { marginLeft: 8 } }, (info.dirs || 0) + ' 个子目录 · ' + (info.files || 0) + ' 个文件'
                + (info.sample && info.sample.length ? ' · ' + info.sample.slice(0, 4).join('、') : ''))))
          : null,
        h('div', { className: 'wb-row', style: { justifyContent: 'flex-end', marginTop: 14, gap: 8 } },
          h('button', { type: 'button', className: 'pf-btn', onClick: onClose }, '取消'),
          h('button', { type: 'button', className: 'pf-btn pri', disabled: !!busy, onClick: ok }, busy === 'save' ? '绑定中…' : '确定绑定')));
    }

    function Projects({ s, toast, go, openId: openIdProp, setOpenId: setOpenIdProp }) {
      const [editing, setEditing] = useState(null);
      const [delTarget, setDelTarget] = useState(null);   // 待删除的项目（弹窗问要不要连文件夹一起删）
      const [archTarget, setArchTarget] = useState(null); // 待归档的项目（弹窗预览 04项目归档 后确认）
      const [q, setQ] = useState('');
      const [fy, setFy] = useState('');
      const [fb, setFb] = useState('');
      const [fr, setFr] = useState('');
      const [busy, setBusy] = useState('');
      // 打开哪个项目进「项目界面」：优先用 Work 传下来的（天源项目页也能直接跳进来），
      // 没传就退化成组件内自有状态，单独渲染时照样能用。
      const [openIdLocal, setOpenIdLocal] = useState('');
      const openId = openIdProp !== undefined ? openIdProp : openIdLocal;
      const setOpenId = setOpenIdProp || setOpenIdLocal;
      const [bindTarget, setBindTarget] = useState(null); // 正在绑定本地文件夹的项目

      const all = useMemo(() => (s.work.projects || []).map(normalizeProject), [s.work.projects]);
      const years = useMemo(() => [...new Set(all.map(p => projectYear(p)))].sort().reverse(), [all]);
      const boundCount = useMemo(() => all.filter(p => projectAbs(p)).length, [all]);

      // 企业库自举：库里还没有东西时，用已存项目的「委托人 / 被评估单位」把它填起来
      useEffect(() => {
        if ((s.work.companies || []).length) return;
        const seed = companiesFromProjects(s.work.projects || []);
        if (!seed.length) return;
        patch('work', w => ({ ...w, companies: upsertCompanies(w.companies || [], seed) }));
      }, []);

      const openFolder = async p => {
        setBusy(p.id);
        try {
          // 已归档的项目：原目录已经移进文件库，直接开归档后的那个目录，别再在 00项目ing 里建空壳
          if (p.archivePath) {
            const r = await fetch(PREFIX + '/lib/open', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ rel: p.archivePath }),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
            toast('已打开归档目录：' + (d.abs || p.archivePath), 'info');
            return;
          }
          if (p.stage === '归档/收款') {
            toast('该项目已归档，但没有记录归档路径；可在「文件库」里按项目名搜索', 'warn');
            return;
          }
          const r = await fetch(PREFIX + '/project/folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              folder: folderNameOf(p), legacy: legacyFolderName(p), abs: projectAbs(p),
              year: projectYear(p), name: p.shortName || p.name, create: true,
            }),
          });
          if (r.status === 404) {
            // 宿主还没重载（改过 index.js 但没重启 DSH）：退回打开项目根目录，别让人卡死
            await fetch(PREFIX + '/store/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ which: 'projects' }) }).catch(() => {});
            toast('已打开项目根目录；按项目建/开子文件夹需重启 DSH 后生效', 'warn');
            return;
          }
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
          toast('已打开：' + d.path, 'info');
        } catch (e) {
          toast('打不开项目文件夹：' + ((e && e.message) || e), 'warn');
        } finally { setBusy(''); }
      };

      // 归档成功：项目标记为已归档，记下归档后的真实路径（「文件夹」按钮改开这里）
      const markArchived = (p, d) => {
        if (!p || !d) return;
        patch('work', w => ({
          ...w,
          projects: w.projects.map(x => (x.id === p.id ? {
            ...x,
            stage: '归档/收款',
            archiveDate: x.archiveDate || todayStr(),
            archivedAt: new Date().toISOString(),
            archivePath: d.to,
            // 目录整个搬进归档库了：原来的绑定路径已经失效，清掉，之后一律走 archivePath
            folderPath: '',
          } : x)),
        }));
      };

      // 保存 = 只写数据，**留在表单里**（保存状态由表单标题条显示，回列表要点「返回」）。
      // 新项目第一次保存后把 editing 换成这条记录：标题从「新建项目」变「编辑项目」，
      // 之后再点保存更新同一条（id 不变），不会重复建。
      // opts.isNewForm 由表单传进来（表单侧的 isNew），模板目录只在新建表单的第一次保存时建。
      const save = (rec, opts) => {
        const isNewForm = !!(opts && opts.isNewForm);
        try {
          patch('work', w => ({
            ...w,
            projects: w.projects.some(x => x.id === rec.id) ? w.projects.map(x => (x.id === rec.id ? rec : x)) : [rec, ...w.projects],
            // 保存项目时顺手把这家委托人 / 被评估单位收进企业库，下次填名称就能直接补全
            companies: upsertCompanies(w.companies || [], companiesFromProjects([rec])),
          }));
        } catch (e) {
          toast('保存时写数据出错：' + ((e && e.message) || e), 'danger');
          return false;
        }
        setEditing(rec);
        // 新建项目先把模板目录建出来（此时还没填股权/方法：只有固定骨架 + 被评估单位的 02基础类）
        if (isNewForm) {
          buildProjectFolders(normalizeProject(rec), s, toast, true)
            .then(d => { const n = Number(d && d.created); if (n > 0) toast('已按模板建好项目文件夹：新建 ' + n + ' 个目录', 'info'); })
            .catch(e => toast('项目已建，但模板目录没建成：' + ((e && e.message) || e) + (/404/.test(String(e && e.message)) ? '（重启 DSH 后可用）' : ''), 'warn'));
        }
        return true;
      };

      // 删除项目：弹窗问一句「要不要连文件夹一起删」
      const doDelete = withFolder => {
        const p = delTarget;
        if (!p) return;
        setDelTarget(null);
        patch('work', w => ({
          ...w,
          logs: w.logs.map(l => (l.projectId === p.id ? { ...l, projectId: '' } : l)),
          projects: w.projects.filter(x => x.id !== p.id),
        }));
        if (!withFolder) { toast('已删除项目（文件夹保留）', 'warn'); return; }
        fetch(PREFIX + '/project/folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder: folderNameOf(p), legacy: legacyFolderName(p), abs: projectAbs(p), remove: true }),
        }).then(r => r.json().catch(() => ({})))
          .then(d => {
            if (d && d.ok) toast(d.removed ? '项目与文件夹都已删除' : '已删除项目（文件夹本来就不存在）', 'warn');
            else toast('项目已删除，但文件夹没删掉：' + String((d && d.error) || '未知错误').slice(0, 100), 'warn');
          })
          .catch(() => toast('项目已删除，但文件夹没删掉（宿主不可用）', 'warn'));
      };

      // 绑定弹窗在「列表」和「项目界面」两处都要能弹出来（项目界面头栏也有「绑定文件夹」），
      // 所以抽成一个变量，两处各挂一份。
      const bindDialog = bindTarget ? h(BindFolderDialog, {
        project: bindTarget,
        toast,
        onClose: () => setBindTarget(null),
        onSave: upd => {
          patch('work', w => ({ ...w, projects: w.projects.map(x => (x.id === bindTarget.id ? { ...x, ...upd, updatedAt: new Date().toISOString() } : x)) }));
          toast(upd.folderPath ? '已绑定本地文件夹：' + upd.folderPath : '已解除绑定，回到自动命名目录', 'ok');
        },
      }) : null;

      if (openId) {
        const cur = all.find(x => x.id === openId);
        if (cur) return h('div', null,
          h(ProjectWorkspace, {
            project: cur, s: s, toast: toast,
            onBack: () => setOpenId(''),
            onBind: p2 => setBindTarget(p2),
          }),
          bindDialog);
      }

      if (editing) {
        return h(ProjectForm, {
          project: editing.id ? editing : null,
          projects: all,
          companies: s.work.companies || [],
          parseModel: (s.settings && s.settings.parseModel) || null,
          onBack: () => setEditing(null),
          onSave: save,
          toast,
        });
      }

      const kw = q.trim().toLowerCase();
      const rows = all.filter(p => {
        if (fy && projectYear(p) !== fy) return false;
        if (fb && p.bizType !== fb) return false;
        if (fr && (p.risk || '') !== fr) return false;
        if (!kw) return true;
        const hay = [p.name, p.shortName, p.code, p.acceptNo, p.reportNo, p.client, p.objectReport,
          managerText(p.team), p.team.partner, p.team.dept, nameList(p.team.members).join(' '),
          p.customer.name, p.entity.name, p.contract.no].join(' ').toLowerCase();
        return hay.includes(kw);
      }).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

      const hoursOf = id => (s.work.logs || []).filter(l => l.projectId === id).reduce((n, l) => n + (Number(l.hours) || 0), 0);

      return h('div', { className: 'wb-sec pf-list' },
        h('div', { className: 'pf-list-h' },
          h('div', { className: 'pf-list-t' },
            h('h2', null, '本地项目'),
            h('span', { className: 'pf-hint' }, '共 ' + all.length + ' 个项目'
              + (boundCount ? '（已绑定本地文件夹 ' + boundCount + ' 个）' : '')
              + ' · 点项目名称进入项目界面；「绑定」可把项目关联到任意已有目录，「文件夹」打开本地目录，「归档」预览 04项目归档 后移入已归档库')),
          h('div', { className: 'wb-row' },
            h('button', { type: 'button', className: 'pf-btn', onClick: async () => {
              try {
                const r = await fetch(PREFIX + '/store/open', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ which: 'projects' }),
                });
                const d = await r.json().catch(() => ({}));
                if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
                toast('已打开项目根目录：' + d.dir, 'info');
              } catch (e) { toast('打开目录失败：' + ((e && e.message) || e), 'warn'); }
            } }, '打开项目根目录'),
            h('button', { type: 'button', className: 'pf-btn pri', onClick: () => setEditing({}) }, '+ 新建项目'))),
        h('div', { className: 'pf-filters' },
          h('input', { className: 'pf-in', style: { maxWidth: 260 }, placeholder: '搜索项目简称 / 编号 / 报告文号 / 委托人 / 经理', value: q, onChange: e => setQ(e.target.value) }),
          h('select', { className: 'pf-sel', style: { maxWidth: 140 }, value: fy, onChange: e => setFy(e.target.value) }, h('option', { value: '' }, '全部年份'), years.map(y => h('option', { key: y, value: y }, y + ' 年'))),
          h('select', { className: 'pf-sel', style: { maxWidth: 170 }, value: fb, onChange: e => setFb(e.target.value) }, h('option', { value: '' }, '全部业务类型'), BIZ_TYPES.map(x => h('option', { key: x, value: x }, x))),
          h('select', { className: 'pf-sel', style: { maxWidth: 140 }, value: fr, onChange: e => setFr(e.target.value) }, h('option', { value: '' }, '全部风险等级'), RISK_LEVELS.map(([v, t]) => h('option', { key: v, value: v }, t)))),
        delTarget ? h(Modal, { title: '删除项目', onClose: () => setDelTarget(null) },
          h('p', { style: { margin: '0 0 8px' } }, '确定删除「' + (delTarget.name || '未命名项目') + '」吗？工时记录会保留，但不再关联该项目。'),
          h('p', { className: 'pf-hint', style: { margin: '0 0 4px' } }, '要不要把本地项目文件夹一起删掉？'),
          h('p', { className: 'pf-hint', style: { margin: '0 0 16px', wordBreak: 'break-all' } },
            folderNameOf(delTarget) + '（删除后不可恢复）'),
          h('div', { className: 'wb-row', style: { justifyContent: 'flex-end' } },
            h(Btn, { className: 'sm', onClick: () => setDelTarget(null) }, '取消'),
            h(Btn, { className: 'sm', onClick: () => doDelete(false) }, '只删项目'),
            h(Btn, { className: 'sm danger', onClick: () => doDelete(true) }, '项目 + 文件夹'))) : null,
        archTarget ? h(ArchiveDialog, {
          project: archTarget,
          toast,
          onClose: () => setArchTarget(null),
          onArchived: d => markArchived(archTarget, d),
        }) : null,
        h('div', { className: 'pf-table-wrap' },
          h('table', { className: 'pf-grid' },
            h('thead', null, h('tr', null,
              ['项目编号 / 名称', '业务类型', '风险', '评估基准日', '项目经理', '报告文号', '阶段 / 工时', '操作'].map((t, i) => h('th', { key: i }, t)))),
            h('tbody', null, rows.length ? rows.map(p => h('tr', { key: p.id },
              h('td', null,
                h('div', { className: 'pf-name', title: '进入项目界面（作业信息 / 股权信息）', onClick: () => setOpenId(p.id) }, p.name || '未命名项目'),
                // 项目名称即项目简称：两者相同时副标题只留编号，不再把名字重复一遍
                h('div', { className: 'pf-sub' }, p.code + (p.shortName && p.shortName !== p.name ? ' · ' + p.shortName : '')),
                // 绑定了自定义文件夹的项目，直接把路径亮出来（一眼看出它不在项目根里）
                projectAbs(p) ? h('div', { className: 'pf-sub', title: '已绑定的本地文件夹' }, h('span', { className: 'pf-folder-chip' }, '📁 ' + projectAbs(p))) : null),
              h('td', null, h('span', { className: 'wb-tag grey' }, p.bizType || '—')),
              h('td', null, riskTag(p.risk)),
              h('td', null, p.baseDate || '—'),
              h('td', null, managerText(p.team) || '—'),
              h('td', null, h('span', { className: 'pf-mono' }, p.reportNo || '—')),
              h('td', null, projectStatusTag(p), h('div', { className: 'pf-sub' }, hoursOf(p.id).toFixed(1) + ' h')),
              h('td', null, h('div', { className: 'wb-row' },
                h('button', { type: 'button', className: 'pf-btn sm', onClick: () => setEditing(p) }, '编辑'),
                h('button', { type: 'button', className: 'pf-btn sm', title: projectAbs(p) ? '当前绑定：' + projectAbs(p) : '绑定一个已有的本地文件夹到该项目', onClick: () => setBindTarget(p) },
                  projectAbs(p) ? '已绑定' : '绑定'),
                h('button', { type: 'button', className: 'pf-btn sm', onClick: () => openFolder(p) }, '文件夹'),
                h('button', {
                  type: 'button', className: 'pf-btn sm',
                  disabled: p.stage === '归档/收款',
                  title: p.stage === '归档/收款' ? '已归档：原目录已移入已归档库' : '先预览 04项目归档 内容，确认后归档',
                  onClick: () => setArchTarget(p),
                }, p.stage === '归档/收款' ? '已归档' : '归档'),
                h('button', { type: 'button', className: 'pf-btn sm danger', onClick: () => setDelTarget(p) }, '删除'))),
            )) : h('tr', null, h('td', { colSpan: 8, className: 'pf-empty' }, all.length ? '没有符合条件的项目' : '还没有项目，点右上角「新建项目」开始'))))),
        bindDialog);
    }

    // ---------- work: timesheets ----------
    function LogModal({ log, projects, onClose, onSave }) {
      const [f, setF] = useState(log || { projectId: projects[0]?.id || '', date: todayStr(), hours: 8, type: '资料收集', task: '', billable: true, note: '' });
      const set = k => e => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
      return h(Modal, { title: log ? '编辑工时' : '记录工时', onClose },
        h('div', { className: 'wb-form' },
          h(Field, { label: '项目' }, h(Sel, { value: f.projectId, onChange: set('projectId') }, h('option', { value: '' }, '（未关联项目）'), projects.map(p => h('option', { key: p.id, value: p.id }, p.name)))),
          h(Field, { label: '日期' }, h(Inp, { type: 'date', value: f.date, onChange: set('date') })),
          h(Field, { label: '工时（h）' }, h(Inp, { type: 'number', min: '0', step: '0.5', value: f.hours, onChange: set('hours') })),
          h(Field, { label: '工作类型' }, h(Sel, { value: f.type, onChange: set('type') }, WORK_TYPES.map(x => h('option', { key: x, value: x }, x)))),
          h(Field, { label: '工作内容 *', full: true }, h(Inp, { value: f.task, onChange: set('task'), placeholder: '如：现场勘察固定资产并拍摄照片' })),
          h(Field, { label: '备注', full: true }, h('textarea', { className: 'wb-textarea', value: f.note, onChange: set('note') })),
          h('label', { className: 'full wb-hint', style: { display: 'flex', gap: 6, alignItems: 'center' } }, h('input', { type: 'checkbox', checked: !!f.billable, onChange: set('billable') }), '计费工时'),
        ),
        h('div', { className: 'wb-form-foot' }, h(Btn, { onClick: onClose }, '取消'), h(Btn, { variant: 'pri', onClick: () => { if (!f.task.trim()) { alert('请填写工作内容'); return; } onSave({ ...f, id: f.id || uid(), hours: num(f.hours) || 0 }); } }, '保存')),
      );
    }
    function Timesheets({ s }) {
      const [modal, setModal] = useState(null);
      const [month, setMonth] = useState(todayStr().slice(0, 7));
      const logs = s.work.logs.filter(l => String(l.date || '').startsWith(month)).sort((a, b) => b.date.localeCompare(a.date));
      const total = logs.reduce((a, l) => a + (Number(l.hours) || 0), 0);
      const byProject = {};
      logs.forEach(l => { byProject[l.projectId || '_'] = (byProject[l.projectId || '_'] || 0) + (Number(l.hours) || 0); });
      const pname = id => (s.work.projects.find(p => p.id === id) || {}).name || '未关联项目';
      const save = l => patch('work', w => ({ ...w, logs: w.logs.some(x => x.id === l.id) ? w.logs.map(x => x.id === l.id ? l : x) : [l, ...w.logs] }));
      const del = id => { if (confirm('删除这条工时记录？')) patch('work', w => ({ ...w, logs: w.logs.filter(x => x.id !== id) })); };
      return h('div', null,
        h(Section, { title: '工时管理', actions: h('div', { className: 'wb-row' },
          h('input', { className: 'wb-input', type: 'month', value: month, onChange: e => setMonth(e.target.value) }),
          h(Btn, { variant: 'pri', onClick: () => setModal({}) }, '+ 记工时')) },
          h('div', { className: 'wb-grid' },
            h(Card, null, h('div', { className: 'wb-kpi' }, total.toFixed(1)), h('div', { className: 'wb-kpi-sub' }, month + ' 合计工时')),
            h(Card, null, h('div', { className: 'wb-kpi' }, logs.length), h('div', { className: 'wb-kpi-sub' }, '本月记录条数')),
            h(Card, null, h('div', { className: 'wb-kpi' }, logs.filter(l => l.billable).reduce((a, l) => a + (Number(l.hours) || 0), 0).toFixed(1)), h('div', { className: 'wb-kpi-sub' }, '计费工时')),
          ),
          h(Table, { cols: ['日期', '项目', '工作类型 / 内容', '工时', '计费', '操作'], rows: logs.map(l => h('tr', { key: l.id },
            h('td', null, l.date), h('td', null, esc(pname(l.projectId))),
            h('td', null, h('span', { className: 'wb-tag grey' }, esc(l.type)), ' ', esc(l.task), l.note && h('div', { className: 'muted' }, esc(l.note))),
            h('td', null, (Number(l.hours) || 0).toFixed(1) + ' h'),
            h('td', null, l.billable ? '是' : '—'),
            h('td', null, h('div', { className: 'wb-row' }, h(Btn, { className: 'sm', onClick: () => setModal(l) }, '编辑'), h(Btn, { className: 'sm danger', onClick: () => del(l.id) }, '删除'))),
          )) }),
        ),
        h(Section, { title: '按项目汇总 · ' + month },
          Object.keys(byProject).length ? h(Table, { cols: ['项目', '工时', '占比'], rows: Object.keys(byProject).map(id => h('tr', { key: id },
            h('td', null, esc(pname(id === '_' ? '' : id))), h('td', null, byProject[id].toFixed(1) + ' h'),
            h('td', null, h(Bar, { v: byProject[id], max: total }), h('span', { className: 'muted' }, total ? Math.round(byProject[id] / total * 100) + '%' : '—')),
          )) }) : Empty('本月没有工时记录')),
        modal && h(LogModal, { log: modal.id ? modal : null, projects: s.work.projects, onClose: () => setModal(null), onSave: l => { save(l); setModal(null); } }),
      );
    }

    // ---------- work: Tianyuan integration settings ----------
    // 打开外部页面。本应用（Electron 桌面端）有三道限制：
    // 1) 主窗口 setWindowOpenHandler 对 window.open 一律 deny，且不返回窗口对象；
    // 2) 右侧栏 openTab 在「没有已挂载对话会话」时直接抛错（工作台占满主区正是这种情况）；
    // 3) 因此前端任何自动开窗都不可靠。
    // 真正可靠的通道是把 URL 交给宿主进程 spawn 系统默认浏览器（/ty/open，带域名白名单）。
    // 返回 'system' | 'sidebar' | 'none'，调用方据此给出准确提示。
    async function openInApp(target) {
      const u = String(target || '').trim();
      if (!/^https?:/i.test(u)) return 'none';
      // 首选：交给宿主进程用系统默认浏览器打开（唯一不受弹窗策略影响的通道）。
      try {
        const r = await fetch(PREFIX + '/ty/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: u }) });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.ok) return 'system';
      } catch (e) {}
      // 次选：右侧栏内置浏览器（需要已挂载的对话会话，工作台占满主区时通常不可用）。
      if (rightBar && typeof rightBar.openTab === 'function') {
        try { rightBar.openTab('browser', { params: { url: u } }); return 'sidebar'; } catch (e) {}
      }
      // 最后：由用户点页面上的链接（Electron 会把 https 交给系统浏览器）。
      return 'none';
    }

    function Tianyuan({ s, toast }) {
      const [st, setSt] = useState(null);
      const [mcpProbe, setMcpProbe] = useState({ state: 'checking' });
      const mcpProbeSeq = useRef(0);
      useEffect(() => () => { mcpProbeSeq.current++; }, []);
      const [busy, setBusy] = useState(false);
      const [manualToken, setManualToken] = useState('');
      const [authUrl, setAuthUrl] = useState('');
      const mcpTimer = useRef(null);
      useEffect(() => () => { if (mcpTimer.current) clearInterval(mcpTimer.current); }, []);
      const [cliStatus, setCliStatus] = useState(null);
      const [cliWaiting, setCliWaiting] = useState(false);
      // 能力清单：先用内置快照渲染，连上后换成实时 tools/list（不阻塞页面）。
      const [cat, setCat] = useState({ rows: TY_MCP_TOOLS, source: 'snapshot', at: '', err: '' });
      const [kwq, setKwq] = useState('');
      const [grp, setGrp] = useState('');
      const api = async (path, opts) => { const r = await fetch(PREFIX + path, opts); const d = await r.json().catch(() => ({})); if (!r.ok || d.error) throw new Error(d.error || d.reason || ('HTTP ' + r.status)); return d; };
      const refresh = async () => { try { const d = await api('/ty/status'); setSt(d); return d; } catch (e) { const d = { error: e.message }; setSt(d); return d; } };
      const probeMcp = async () => {
        const seq = ++mcpProbeSeq.current;
        setMcpProbe({ state: 'checking' });
        try {
          const result = await api('/ty/probe', { method: 'POST' });
          if (seq !== mcpProbeSeq.current) return result;
          setMcpProbe(result);
          if (result.connected) loadCatalog(seq);
          else setCat({ rows: TY_MCP_TOOLS, source: 'snapshot', at: '', err: '' });
          return result;
        } catch (_) {
          const result = { state: 'unavailable' };
          if (seq === mcpProbeSeq.current) { setMcpProbe(result); setCat({ rows: TY_MCP_TOOLS, source: 'snapshot', at: '', err: '' }); }
          return result;
        }
      };
      const openMcpConfig = async () => {
        const opened = await openInApp('https://mcp.zhrdc.net/connect?source=valuation');
        toast(opened === 'none' ? '无法自动打开，请点击下方「打开 MCP 接入页」' : '已打开 MCP 接入页，请完成配置后复制 token 回此处保存', opened === 'none' ? 'warn' : 'info');
      };
      // 拉实时工具清单：描述/参数以 MCP 返回为准，分组与「工作台已接入」沿用快照元数据。
      const loadCatalog = async (expectedSeq = mcpProbeSeq.current) => {
        try {
          const d = await api('/ty/tools');
          if (expectedSeq !== mcpProbeSeq.current) return;
          const list = Array.isArray(d) ? d : (Array.isArray(d.tools) ? d.tools : []);
          if (!list.length) throw new Error('工具清单为空');
          const byName = {};
          TY_MCP_TOOLS.forEach(t => { byName[t.n] = t; });
          const rows = list.map(t => {
            const base = byName[t.name] || {};
            const props = Object.keys((t.inputSchema && t.inputSchema.properties) || {});
            const req = (t.inputSchema && t.inputSchema.required) || [];
            return {
              n: t.name,
              g: base.g || '其它',
              m: base.m || (t.name.indexOf('execute_') === 0 || t.name.indexOf('save_') === 0 ? 'write' : t.name.indexOf('prepare_') === 0 ? 'preflight' : 'read'),
              u: base.u || 0,
              d: t.description || base.d || '',
              r: req, p: props.length ? props : (base.p || []),
            };
          });
          setCat({ rows, source: 'live', at: new Date().toLocaleTimeString('zh-CN'), err: '' });
        } catch (e) {
          setCat(c => ({ ...c, err: e.message }));
        }
      };
      const refreshCli = async () => {
        try { const d = await api('/ty/cli/status'); setCliStatus(d); return d; }
        catch (e) { const d = { state: 'error', reason: 'CLI 状态读取失败；请重启应用后重试' }; setCliStatus(d); return d; }
      };
      useEffect(() => { refresh().then(v => { if (v && v.connected) probeMcp(); else setMcpProbe({ state: v?.expired ? 'expired' : v?.error ? 'unavailable' : 'not_configured' }); }); refreshCli().then(d => { if (d.state === 'starting' || d.state === 'waiting') setCliWaiting(true); }); }, []);
      useEffect(() => {
        if (!cliWaiting) return;
        let active = true, count = 0;
        const check = async () => {
          const d = await refreshCli(); if (!active) return;
          if (d.state === 'authenticated') { setCliWaiting(false); toast('CLI 本地凭据已保存，可尝试导出'); }
          else if (d.state === 'failed' || d.state === 'unavailable' || d.state === 'error' || ++count >= 100) { setCliWaiting(false); toast(d.reason || 'CLI 授权等待超时，请重试', 'warn'); }
        };
        const timer = setInterval(check, 3000);
        return () => { active = false; clearInterval(timer); };
      }, [cliWaiting]);
      const loginCli = async () => {
        try {
          const d = await api('/ty/cli/login', { method: 'POST' }); setCliStatus(d);
          if (!d.installed) { toast(d.reason || '未找到 tycpv，请先安装天源 CLI', 'warn'); return; }
          if (d.state === 'authenticated') toast('检测到 CLI 已有本地凭据；如需切换账号，请先在终端退出 CLI 登录', 'info');
          else { setCliWaiting(true); toast('正在启动 CLI 授权，请在浏览器中完成登录'); }
        } catch (e) { toast('启动 CLI 授权失败：' + e.message, 'danger'); }
      };
      const login = async () => {
        setBusy(true);
        setAuthUrl('');
        try {
          const d = await api('/ty/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credentialName: '个人工作台 on DSH' }) });
          setAuthUrl(d.authorizationUrl);
          // 本应用（Electron）对 window.open 一律 deny，只把 https 交给系统浏览器，
          // 所以不能指望弹出窗口：优先用右侧栏内置浏览器，其次由用户点页面上的链接。
          const opened = await openInApp(d.authorizationUrl);
          toast(opened === 'system'
            ? '已用系统浏览器打开天源授权页，完成登录与滑块验证后本页会自动变成已连接'
            : opened === 'sidebar'
              ? '已在右侧栏打开天源授权页，完成验证后本页会自动变成已连接'
              : '授权链接已生成，请点下面的「打开授权页」或「复制链接」手动打开');
          let tries = 0;
          if (mcpTimer.current) clearInterval(mcpTimer.current);
          const iv = setInterval(async () => {
            tries++;
            const q = await api('/ty/status').catch(() => ({}));
            if (q.connected) { clearInterval(iv); setBusy(false); setSt(q); setAuthUrl(''); toast('天源已连接：' + (q.user?.fullName || q.user?.userName || '')); }
            else if (tries > 100) { clearInterval(iv); setBusy(false); toast('等待授权超时，可重新点「连接天源」', 'warn'); }
          }, 3000);
          mcpTimer.current = iv;
        } catch (e) { setBusy(false); toast('发起授权失败：' + e.message, 'danger'); }
      };
      const copyUrl = async () => {
        if (!authUrl) return;
        try { await navigator.clipboard.writeText(authUrl); toast('授权链接已复制，粘贴到浏览器地址栏打开', 'ok'); }
        catch (e) {
          const ta = document.createElement('textarea');
          ta.value = authUrl; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          const ok = document.execCommand && document.execCommand('copy');
          document.body.removeChild(ta);
          toast(ok ? '授权链接已复制' : '复制失败，请手动选中链接复制', ok ? 'ok' : 'warn');
        }
      };
      const doLogout = async () => { mcpProbeSeq.current++; try { await api('/ty/logout', { method: 'POST' }); await refresh(); setMcpProbe({ state: 'not_configured' }); setCat({ rows: TY_MCP_TOOLS, source: 'snapshot', at: '', err: '' }); toast('已清除 MCP 本地连接'); } catch (_) { toast('清除 MCP 本地连接失败', 'danger'); } };
      const saveToken = async () => { mcpProbeSeq.current++; setMcpProbe({ state: 'checking' }); try { await api('/ty/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: manualToken.trim() }) }); setManualToken(''); await refresh(); const result = await probeMcp(); toast(result.connected ? 'MCP 已连接，检查通过' : 'token 已保存，但连接检查未通过，请查看状态', result.connected ? 'ok' : 'warn'); } catch (_) { setMcpProbe({ state: 'unavailable' }); toast('保存 token 失败，请检查格式和本地文件权限', 'danger'); } };
      // 能力清单一节的数据准备：概览 KPI → 搜索/分组过滤 → 明细 → CLI 命令
      const modeTag = { read: ['只读', 'grey'], preflight: ['预检', 'warn'], write: ['写入', 'red'] };
      // 分组按业务顺序固定：实时 tools/list 的返回顺序会打散同组工具，
      // 若照原顺序渲染，同一分组会重复出现表头（React 还会因重复 key 丢行）。
      const GROUP_ORDER = ['项目与人员', '被评估公司与负责人', '资产基础法底稿', '财务报表', '汇总表', '报告配置与导出', '二级文件', '项目文件与明细表', '底稿编辑锁'];
      const gRank = g => { const i = GROUP_ORDER.indexOf(g); return i < 0 ? 99 : i; };
      const groups = [];
      cat.rows.forEach(r => { if (groups.indexOf(r.g) < 0) groups.push(r.g); });
      groups.sort((a, b) => gRank(a) - gRank(b));
      const q = kwq.trim().toLowerCase();
      const shown = cat.rows
        .filter(r => (!grp || r.g === grp) && (!q || (r.n + ' ' + r.d + ' ' + r.g).toLowerCase().indexOf(q) >= 0))
        .sort((a, b) => gRank(a.g) - gRank(b.g));
      const nMode = m => cat.rows.filter(r => r.m === m).length;
      const usedCount = cat.rows.filter(r => r.u).length;
      const kpis = [
        ['MCP 工具', cat.rows.length, 'tools/list 返回的全部工具'],
        ['只读查询', nMode('read'), '不改动天源数据'],
        ['预检', nMode('preflight'), '只读，产出一次性确认凭证'],
        ['写入', nMode('write'), '须 prepare → 确认 → execute'],
        ['CLI 命令', TY_CLI_CMDS.length, 'tycpv，本机独立登录'],
      ];
      return h(React.Fragment, null,
        h(Section, { title: '天源系统对接 · CLI / MCP' },
        h('div', { className: 'wb-alert ' + (mcpProbe.state === 'connected' ? '' : 'warn') },
          h('div', { style: { flex: 1 } },
            h('div', { className: 't', role: 'status' }, 'MCP 连接状态：' + ({ checking: '正在检查…', connected: '已连接', not_configured: '未配置', expired: '凭据已过期', unauthorized: '授权无效或已过期', unavailable: '连接失败，请检查网络或稍后重试' }[mcpProbe.state] || '未验证')),
            h('div', { className: 'b' }, mcpProbe.state === 'connected' ? '已成功调用 MCP tools/list；不代表所有业务权限均已验证。' : '配置后粘贴 token 并保存，系统会自动验证连接。'),
          ),
        ),
        h('div', { className: 'wb-alert ' + (cliStatus?.authenticated && cliStatus.state !== 'failed' ? '' : 'warn'), style: { marginTop: 10 } },
          h('div', { style: { flex: 1 } },
            h('div', { className: 't', role: 'status' }, 'CLI 状态：' + (!cliStatus ? '正在检查…'
              : cliStatus.state === 'starting' ? '正在启动授权…'
              : cliStatus.state === 'waiting' ? '等待浏览器授权…'
              : cliStatus.state === 'failed' ? '授权未完成'
              : cliStatus.state === 'error' ? '状态检查失败'
              : !cliStatus.installed ? '未找到 tycpv CLI'
              : cliStatus.authenticated ? '本地凭据有效'
              : cliStatus.expired ? '本地凭据已过期'
              : '未检测到可用本地凭据')),
            // 装上了就报出实际路径与账号，装不上时说清查过哪些位置——不再只给一句"未找到"。
            h('div', { className: 'b' }, cliStatus?.reason
              || (cliStatus
                ? cliStatus.installed
                  ? 'tycpv：' + (cliStatus.binPath || '已找到')
                    + (cliStatus.account ? ' · 账号 ' + cliStatus.account : '')
                    + (cliStatus.expiresAt ? ' · 有效期至 ' + String(cliStatus.expiresAt).slice(0, 16).replace('T', ' ') : '')
                    + (cliStatus.authenticated ? '；远端有效性仍需实际调用验证。' : '；点「授权 CLI」重新登录。')
                  : '未找到 tycpv（已检查 TYCPV_BIN、常见安装目录与 PATH）。可在终端运行 tycpv login 确认已安装。'
                : 'CLI 与 MCP 分别授权；点击「授权 CLI」完成浏览器登录。')),
          ),
        ),
        // tycpv 会自己打开浏览器；这段只在它没打开时给用户一个可点的入口，避免卡在「等待浏览器授权」。
        cliStatus?.authUrl && !cliStatus.authenticated && h('div', { className: 'wb-alert warn', style: { marginTop: 10, display: 'block' } },
          h('div', { className: 't', style: { marginBottom: 6 } }, 'CLI 授权页已打开'),
          h('div', { className: 'b', style: { marginBottom: 8 } }, 'tycpv 通常会自动打开浏览器；若没弹出，点「打开 CLI 授权页」用系统浏览器打开。完成登录后本页会自动变成「本地凭据有效」。'),
          h('div', { className: 'wb-row' },
            h('a', { className: 'wb-link', href: cliStatus.authUrl, target: '_blank', rel: 'noopener', style: { wordBreak: 'break-all', flex: 1, fontSize: 11 } }, cliStatus.authUrl),
            h(Btn, { className: 'sm', variant: 'pri', onClick: async () => {
              const r = await openInApp(cliStatus.authUrl);
              if (r === 'system') toast('已用系统浏览器打开 CLI 授权页');
              else if (r === 'sidebar') toast('已在右侧栏打开 CLI 授权页');
              else toast('无法自动打开，请手动复制链接到浏览器', 'warn');
            } }, '打开 CLI 授权页'),
            h(Btn, { className: 'sm', onClick: async () => {
              try { await navigator.clipboard.writeText(cliStatus.authUrl); toast('CLI 授权链接已复制', 'ok'); }
              catch (e) { toast('复制失败，请手动选中链接', 'warn'); }
            } }, '复制链接'),
          ),
        ),
        h('div', { className: 'wb-row', style: { marginTop: 10 } },
          h(Btn, { variant: 'pri', onClick: openMcpConfig }, '配置 MCP'),
          h(Btn, { onClick: loginCli, disabled: cliWaiting }, cliWaiting ? '等待 CLI 授权…' : '授权 CLI'),
          h(Btn, { onClick: () => { refresh(); probeMcp(); refreshCli(); } }, '检查连接'),
          (st?.connected || st?.expired) && h(Btn, { variant: 'danger', onClick: doLogout, title: '清除本地 MCP 凭据并尝试远端撤销' }, '断开连接'),
        ),
        authUrl && h('div', { className: 'wb-alert', style: { marginTop: 10, display: 'block' } },
          h('div', { className: 't', style: { marginBottom: 6 } }, '授权链接已生成'),
          h('div', { className: 'b', style: { marginBottom: 8 } }, '点「打开授权页」会用系统浏览器打开（不是弹窗）；若没反应，点「复制链接」粘到浏览器地址栏。完成登录与滑块验证后回到本页，会自动识别为已连接。'),
          h('div', { className: 'wb-row' },
            h('a', { className: 'wb-link', href: authUrl, target: '_blank', rel: 'noopener', style: { wordBreak: 'break-all', flex: 1, fontSize: 11 } }, authUrl),
            h(Btn, { className: 'sm', variant: 'pri', onClick: async () => {
              const r = await openInApp(authUrl);
              if (r === 'system') toast('已用系统浏览器打开授权页');
              else if (r === 'sidebar') toast('已在右侧栏打开授权页');
              else toast('无法自动打开，请点「复制链接」粘到浏览器地址栏', 'warn');
            } }, '打开授权页'),
            h(Btn, { className: 'sm', onClick: copyUrl }, '复制链接'),
          ),
        ),
        h('div', { className: 'wb-split', style: { marginTop: 14 } },
          h('div', null,
            h('div', { className: 'wb-hint', style: { marginBottom: 8 } }, 'MCP 配置：打开接入页 → 按页面提示生成 token → 返回此处粘贴并保存。'),
            h('a', { className: 'wb-link', href: 'https://mcp.zhrdc.net/connect?source=valuation', target: '_blank', rel: 'noopener noreferrer' }, '打开 MCP 接入页'),
            h('div', { className: 'wb-hint' }, 'token 保存在本机 ~/.dsh/workbench-tianyuan.json，不写入对话；连接时会发送给天源 MCP 服务进行认证。'),
          ),
          h('div', null,
            h('div', { className: 'wb-hint', style: { marginBottom: 6 } }, '在此粘贴 MCP 接入页生成的 token；保存后自动检查连接。'),
            h('div', { className: 'wb-row' }, h(Inp, { type: 'password', value: manualToken, onChange: e => setManualToken(e.target.value), placeholder: 'zhmcp_...', style: { flex: 1, minWidth: 160 } }), h(Btn, { onClick: saveToken }, '保存')),
          ),
        ),
        ),
        h(Section, {
          title: '能力清单 · 这个对接能做什么',
          actions: h('div', { className: 'wb-row' },
            h('span', { className: 'wb-tag ' + (cat.source === 'live' ? '' : 'grey'), title: cat.at ? '刷新于 ' + cat.at : '内置快照，连上后自动刷新' }, cat.source === 'live' ? '实时 tools/list' : '内置快照'),
            h(Btn, { className: 'sm', onClick: () => loadCatalog(), disabled: mcpProbe.state !== 'connected' }, '刷新清单'),
          ),
        },
          h('p', { className: 'wb-hint', style: { margin: 0 } },
            '天源对外有两个入口：MCP（在上方授权后使用，' + cat.rows.length + ' 个工具，其中 ' + usedCount + ' 个已接进工作台）与 tycpv CLI（本机命令，独立登录）。下面按业务分组列全；标「写入」的工具会改动天源数据。'),
          h('div', { className: 'wb-grid', style: { margin: '12px 0 4px', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' } }, kpis.map((k, i) => h(Card, { key: i },
            h('div', { className: 'wb-kpi' }, String(k[1])),
            h('div', { className: 'wb-kpi-sub' }, k[0]),
            h('div', { className: 'wb-kpi-sub', style: { opacity: .75 } }, k[2])))),
          h('div', { className: 'wb-row', style: { margin: '14px 0 10px' } },
            h(Inp, { value: kwq, onChange: e => setKwq(e.target.value), placeholder: '搜工具名或说明，例如 底稿 / 报告 / 项目', style: { flex: 1, minWidth: 240 } }),
            h(Btn, { className: 'sm ' + (grp ? '' : 'pri'), onClick: () => setGrp('') }, '全部 ' + cat.rows.length),
            groups.map(g => h(Btn, { key: g, className: 'sm ' + (grp === g ? 'pri' : ''), onClick: () => setGrp(grp === g ? '' : g) }, g + ' ' + cat.rows.filter(r => r.g === g).length)),
          ),
          h('table', { className: 'wb-table' },
            h('colgroup', null,
              h('col', { style: { width: '31%' } }),
              h('col', { style: { width: '62px' } }),
              h('col', { style: { width: '24%' } }),
              h('col', null)),
            h('thead', null, h('tr', null, ['能力 / 工具', '类型', '必填参数', '说明'].map((c, i) => h('th', { key: i }, c)))),
            h('tbody', null, (() => {
              const out = [];
              let last = '';
              shown.forEach(r => {
                if (!grp && r.g !== last) {
                  last = r.g;
                  out.push(h('tr', { key: 'g-' + r.g }, h('td', { colSpan: 4, style: { background: 'var(--wb-surface-2)', fontWeight: 600, fontSize: 11, color: 'var(--dsw-alias-label-secondary,#666)' } }, r.g + ' · ' + cat.rows.filter(x => x.g === r.g).length)));
                }
                const mt = modeTag[r.m] || modeTag.read;
                out.push(h('tr', { key: r.n },
                  h('td', null, h('code', { style: { fontSize: 11, overflowWrap: 'anywhere' } }, r.n), r.u ? h('span', { className: 'wb-tag', style: { marginLeft: 6 } }, '工作台已接入') : null),
                  h('td', null, h('span', { className: 'wb-tag ' + mt[1] }, mt[0])),
                  h('td', { className: 'muted', style: { fontSize: 11.5, overflowWrap: 'anywhere' } }, r.r.length ? r.r.join('、') + (r.p.length > r.r.length ? ' +' + (r.p.length - r.r.length) + ' 可选' : '') : '无'),
                  h('td', { style: { fontSize: 11.5, lineHeight: 1.6 } }, r.d || '—')));
              });
              if (!out.length) out.push(h('tr', { key: 'empty' }, h('td', { colSpan: 4, className: 'wb-empty' }, '没有匹配的工具')));
              return out;
            })())),
          shown.length ? h('div', { className: 'wb-hint', style: { marginTop: 6 } }, '共 ' + shown.length + ' 个工具' + (q || grp ? '（已过滤）' : '') + '；「必填参数」的名字与 MCP 入参一致。') : null,
          cat.err ? h('div', { className: 'wb-alert warn', style: { marginTop: 10 } }, h('div', { className: 'b' }, '实时清单刷新失败：' + cat.err + '。当前显示内置快照，连上后点「刷新清单」可再取。')) : null,
          h('div', { style: { marginTop: 18 } },
            h('div', { className: 'wb-row', style: { justifyContent: 'space-between', marginBottom: 8 } },
              h('div', { style: { fontWeight: 600, fontSize: 13 } }, 'tycpv CLI · ' + TY_CLI_CMDS.length + ' 条命令'),
              h('span', { className: 'wb-hint' }, 'D:\\tycpv\\tycpv.cmd · 每条命令加 --help 看参数')),
            h(Table, { cols: ['命令', '作用'], rows: TY_CLI_CMDS.map(c => h('tr', { key: c[0] },
              h('td', null, h('code', { style: { fontSize: 11.5 } }, c[0])),
              h('td', { className: 'muted' }, c[1]))) }),
          ),
          h('p', { className: 'wb-hint', style: { marginTop: 12 } },
            '边界：MCP 与 CLI 走同一套天源账号授权，token 只存本机 ~/.dsh/workbench-tianyuan.json；写入类工具一律「prepare 预检 → 用户确认 → execute 执行」，预检给出的 confirmationToken 短期一次性有效。本页只列能力、不代执行。'),
        ),
      );
    }

    // ---------- work: Tianyuan projects (sync on demand, cached in localStorage) ----------
    const TY_STATUS = { 1: { t: '进行中', c: '' }, 2: { t: '审核中', c: 'warn' }, 3: { t: '已完成', c: 'grey' } };
    const tsToDate = v => { const n = Number(v); if (!n) return ''; const d = new Date(n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

    // ---------- 天源 → 本地：四组字段映射 ----------
    // get_project_context 返回 [{namedKey, value, type}]。type 不可靠（同一个 key 在不同项目里
    // 会变），所以取值一律「先试 JSON 解析，失败就当纯文本」。
    const tyTxt = v => {
      const s = v == null ? '' : String(v).trim();
      return (s === '[]' || s === 'null' || s === 'undefined') ? '' : s;
    };
    const tyJson = (v, fallback) => {
      try { const a = JSON.parse(String(v == null ? '' : v)); return a == null ? fallback : a; } catch (e) { return fallback; }
    };
    // 多选字段把「代码 + 中文名」成对存进数组（assessmentObjectRemark: ["QYJZ","股东全部权益价值"]），取中文名
    const tyChoice = v => {
      const a = tyJson(v, null);
      if (Array.isArray(a)) return a.length ? String(a[a.length - 1]) : '';
      return tyTxt(v);
    };
    // 人员： [{employee, fullName, userName, job}] → 姓名
    const tyPeople = v => (tyJson(v, []) || []).map(x => (x && (x.fullName || x.userName)) || '').filter(Boolean);
    // 天源日期：毫秒时间戳（type 3）或 "YYYY-MM-DD …" 字符串都要认
    const tyDate = v => {
      const s = tyTxt(v);
      if (!s) return '';
      if (/^\d{10,13}$/.test(s)) return tsToDate(Number(s));
      return s.slice(0, 10);
    };
    // 全角/半角括号不一致（天源「现金购买资产（含股权）」vs 本地选项「现金购买资产(含股权)」）
    const tyKey = s => String(s || '').replace(/（/g, '(').replace(/）/g, ')').trim();
    // 尽量对齐本地下拉选项；对不上也保留原文，别把天源的数据吞掉（下拉会把未知值补成一项）
    const pickTyOption = (value, options) => {
      const v = tyTxt(value);
      if (!v) return '';
      const hit = (options || []).find(o => tyKey(o) === tyKey(v));
      return hit || v;
    };

    /**
     * 天源项目 → 本地项目记录：基本信息 / 客户信息 / 被评估单位信息 / 合同信息 四组都填。
     * 入参是 get_my_projects 的一行，加 get_project_context、get_project_companies 的返回值。
     * 天源没有的字段（归档日）留空：表单里默认按「评估报告日 + 90 天」补。
     */
    function tyToLocalProject(p, ctxList, companies, projects) {
      const ctx = {};
      (Array.isArray(ctxList) ? ctxList : []).forEach(x => { if (x && x.namedKey) ctx[x.namedKey] = x.value; });
      const g = k => tyTxt(ctx[k]);
      const co = (Array.isArray(companies) && companies[0]) || {};
      const custs = tyJson(g('customersInfo'), []);
      // 天源一个项目可以有多个委托人（customersInfo 是数组）；每个都映射成本地的委托人结构。
      // 只认有名字 / 简称 / 信用代码的项，天源的空壳行不占位。
      const custRows = (Array.isArray(custs) ? custs : [])
        .filter(c => c && String(c.clientName || c.clientShortName || c.clientCreditCode || '').trim());
      const customers = custRows.map(c => ({
        type: pickTyOption(c.clientType, ['法人组织', '自然人']) || '法人组织',
        name: String(c.clientName || ''),
        shortName: String(c.clientShortName || ''),
        idCard: String(c.clientIdentity || ''),
        sameAsEntity: pickTyOption(c.isSameWithAssessment, ['是', '否']),
        creditCode: String(c.clientCreditCode || ''),
        entType: String(c.clientUnitType || ''),
        address: String(c.clientUnitAddress || ''),
        capital: String(c.clientRegisteredCapital || ''),
        legalRep: String(c.clientLegalPerson || ''),
        business: String(c.clientBusinessScope || ''),
        relation: pickTyOption(c.clientWithUnitRelationship, CUSTOMER_RELATIONS),
      }));
      // 没有委托人时留一个空壳（和新建项目一致），不要拿「评估对象」冒充委托人
      const customer = customers[0] || emptyCustomer();
      const base = newProject(projects);
      const baseDate = tyDate(p.evaluationBaseDate) || tyDate(ctx.evaluationBaseDate) || '';
      const year = /^\d{4}$/.test(baseDate.slice(0, 4)) ? baseDate.slice(0, 4) : String(new Date().getFullYear());
      const partners = tyPeople(ctx.projectPartnerList);
      const managers = tyPeople(ctx.projectManagerList);
      const signers = tyPeople(ctx.signatureAssessorList);
      const period = tyJson(g('servicePeriodDate'), []);
      const attachments = (tyJson(g('contractAttachment'), []) || []).map(x => (x && (x.name || x.fileName || x.attachName)) || '').filter(Boolean);
      const stageMap = { 1: '现场调查', 2: '一复', 3: '归档/收款' };
      const purpose = g('evaluationPurpose');
      return {
        ...base,
        code: String(p.projectCode || g('projectCode') || base.code),
        name: String(p.projectName || base.name),
        shortName: g('projectBrief') || String(p.projectName || ''),
        acceptNo: String(p.projectAcceptanceNo || g('projectAcceptanceNo') || ''),
        ebsProject: g('ebsProject'),
        risk: String(p.riskLevelName || ''),
        bizType: pickTyOption(g('businessType'), BIZ_TYPES) || '资产评估业务',
        year,
        baseDate,
        deadline: '',
        stage: stageMap[Number(p.projectStatus)] || '承接/立项',
        budgetHours: 0,
        economicBehavior: g('economicBehavior'),
        objectReport: tyChoice(ctx.assessmentObjectReport),
        scopeReport: tyChoice(ctx.assessmentRangeReport),
        valueType: pickTyOption(tyChoice(ctx.valueType), VALUE_TYPE_GROUPS.flatMap(x => x.items)),
        purposeReport: pickTyOption(g('evaluationPurposeReport'), PURPOSE_REPORTS),
        // evaluationPurpose 有时存的是代码（PGMDQT），这种只留「评估目的-报备」，不给下拉塞乱码
        purpose: /^[A-Z0-9]{4,}$/.test(purpose) ? '' : pickTyOption(purpose, PURPOSES),
        bizNature: pickTyOption(g('evaluationBusinessNature'), BIZ_NATURES),
        majorRestructure: pickTyOption(g('isMajorAssetReorganization'), MAJOR_RESTRUCT),
        objectReport2: pickTyOption(tyChoice(ctx.assessmentObjectRemark), OBJECT_REPORT_GROUPS.flatMap(x => x.items)),
        inOut: pickTyOption(g('assetPutOrTake'), IN_OUT_OPTIONS),
        equityRatio: g('assessmentObjectShare') === '0' ? '' : g('assessmentObjectShare'),
        reportDate: tyDate(ctx.evaluationReportDate),
        reportNo: g('reportDocumentNo'),
        client: String(customer.name || p.assessmentObject || ''),
        team: {
          dept: pickTyOption(g('executionDepartment') || p.executionDepartment, DEPARTMENTS),
          partner: partners[0] || (p.partnerList || []).map(x => x.fullName).filter(Boolean)[0] || '',
          managers: managers.length ? managers : (p.managerList || []).map(x => x.fullName).filter(Boolean),
          manager: managers[0] || (p.managerList || []).map(x => x.fullName).filter(Boolean)[0] || '',
          members: tyPeople(ctx.participantList),
          signer1: signers[0] || '',
          signer2: signers[1] || '',
        },
        // 客户信息：customers 是数据本体（多委托人），customer 只留第一个作兼容别名。
        // 以前只写了 customer，customers 还是 newProject() 的空壳，而表单/保存一律读 customers，
        // 于是天源带过来的委托人到界面上全是空的（客户信息页签也空）。
        customer,
        customers,
        entity: {
          name: String(co.name || g('companyName') || ''),
          shortName: String(co.shortName || g('companyShortName') || ''),
          legalRep: g('legalRepresentative'),
          creditCode: g('socialCreditCode'),
          entType: pickTyOption(g('enterpriseType'), ENTITY_TYPES),
          capital: g('registeredCapital'),
          address: g('companyAddress'),
          business: g('businessScope'),
          intro: g('businessInfo'),
        },
        contract: {
          type: pickTyOption(g('contractType'), CONTRACT_TYPES),
          signDate: tyDate(ctx.contractSigningDate),
          serviceStart: Array.isArray(period) ? tyDate(period[0]) : '',
          serviceEnd: Array.isArray(period) ? tyDate(period[1]) : '',
          currency: pickTyOption(g('contractCurrency'), CURRENCIES) || '人民币',
          amountOriginal: g('contractOriginalAmount'),
          amount: g('contractAmount'),
          payMethod: g('evaluationFeePaymentMethod'),
          reportSubmitAt: tyDate(ctx.reportSubmitTime),
          reportSubmitWay: pickTyOption(g('reportSubmitMethod'), SUBMIT_WAYS),
          // 天源这两个计数没填时是 0，原样搬过来表单会显示「0 份」，按空处理
          reportCopies: g('reportNumber') === '0' ? '' : g('reportNumber'),
          statementCopies: g('evaluationExplanationNumber') === '0' ? '' : g('evaluationExplanationNumber'),
          otherUsers: g('otherReportUser'),
          purposeDetail: g('contractEvaluationPurpose'),
          attachment: attachments.join('、'),
          secret: pickTyOption(g('isSecret'), SECRET_OPTIONS),
        },
        tyId: String(p.id),
        tyUrl: tyProjectUrl(p.id),
        note: '天源同步 ' + new Date().toLocaleString('zh-CN') + ' · ' + (p.executionDepartment || '—') + ' · 风险 ' + (p.riskLevelName || '—'),
      };
    }

    /**
     * 「同步到线上」用：把本地项目按天源网页表单的四组页签整理成可粘贴文本。
     * 为什么只能给清单：天源 OpenAPI（35 个 MCP 工具）目前只开放读取项目 + 写「参与人员 /
     * 公司负责人」，新建项目和基本信息/客户/被评估单位/合同的写入都只在网页表单里
     * （https://ty.zhrdc.net/project/my），所以这一侧做成「对着网页逐项粘贴」。
     */
    function buildTyFormText(rec) {
      const r = rec || {};
      const t = r.team || {}; const c = r.customer || {}; const e = r.entity || {}; const k = r.contract || {};
      const groups = [
        ['基本信息', [
          ['项目名称', r.name], ['项目编号', r.code], ['项目简称', r.shortName], ['项目受理号', r.acceptNo],
          ['EBS项目', r.ebsProject], ['评估基准日', r.baseDate], ['风险等级', r.risk], ['业务类型', r.bizType],
          ['执行部门', t.dept], ['项目合伙人', t.partner], ['项目经理', managerText(t)],
          ['参与人员', (t.members || []).join('、')], ['签字评估师', [t.signer1, t.signer2].filter(Boolean).join('、')],
          ['项目阶段', r.stage], ['经济行为', r.economicBehavior], ['评估对象-报告', r.objectReport],
          ['评估范围-报告', r.scopeReport], ['价值类型', r.valueType], ['评估目的-报备', r.purposeReport],
          ['评估目的', r.purpose === '其他' ? ('其他：' + (r.purposeOther || '')) : r.purpose], ['评估业务性质', r.bizNature], ['是否属于重大资产重组', r.majorRestructure],
          ['评估对象-报备', r.objectReport2], ['资产置入/置出', r.inOut], ['评估对象股权比例(%)', r.equityRatio],
          ['评估报告日', r.reportDate], ['报告文号', r.reportNo],
        ]],
        ['客户信息', [
          ['委托人类型', c.type], ['委托人名称', c.name], ['委托人简称', c.shortName], ['委托人身份证', c.idCard],
          ['与被评估单位是否一致', c.sameAsEntity], ['委托人社会信用代码', c.creditCode],
          ['委托人企业类型', c.entType], ['委托人企业住所', c.address], ['委托人注册资本', c.capital],
          ['委托人法定代表人', c.legalRep], ['委托人经营范围', c.business], ['与被评估单位关系', c.relation],
        ]],
        ['被评估单位信息', [
          ['公司名称', e.name], ['公司简称', e.shortName], ['法定代表人', e.legalRep], ['社会信用代码', e.creditCode],
          ['企业类型', e.entType], ['注册资本', e.capital], ['企业住所', e.address],
          ['经营范围', e.business], ['经营情况简介', e.intro],
        ]],
        ['合同信息', [
          ['合同类型', k.type], ['合同签订日期', k.signDate],
          ['服务期间起止日', [k.serviceStart, k.serviceEnd].filter(Boolean).join(' 至 ')],
          ['合同币种', k.currency], ['合同原币金额', k.amountOriginal], ['合同金额', k.amount],
          ['评估费支付方式', k.payMethod], ['报告提交时间', k.reportSubmitAt], ['报告提交方式', k.reportSubmitWay],
          ['外送报告份数', k.reportCopies], ['外送评估说明份数', k.statementCopies], ['其他报告使用人', k.otherUsers],
          ['具体评估目的', k.purposeDetail], ['合同扫描件', k.attachment], ['合同是否涉密', k.secret],
        ]],
      ];
      const out = [];
      groups.forEach(([title, items]) => {
        const lines = items
          .filter(([, v]) => String(v == null ? '' : v).trim())
          .map(([label, v]) => label + '：' + String(v).trim());
        if (lines.length) out.push('【' + title + '】', ...lines, '');
      });
      return out.join('\n').trim();
    }

    // 数据契约见 folder-template.js：{ version:1, groups:[{ name, children:[…] }] }，层级≤5、目录≤400。
    // ---------- 文件夹模板 · 参数设定页（纯 DOM 实现，不依赖 React 状态）----------
    // 宿主用的是精简版 React shim：子组件 setState 不重渲染、带依赖数组的 useEffect 可能不跑、
    // 换成受控 props 提升状态也不保证子组件更新（三轮实测）。所以这个页面完全绕开 React：
    //   · 数据与 UI 状态放在模块级 FTPL 里，翻页签/重挂都不丢；
    //   · 控件用 document.createElement 递归建树，事件直接 addEventListener；
    //   · React 只渲染一个空挂载点 #ftpl-root，每次渲染后 setTimeout(0) 补挂（不依赖 useEffect）。
    // 唯一还需要 React 的两件事：toast（顶层 setState 生效）和 onDirtyChange（离页提示）。
    const FTPL = {
      tpl: null, saved: null, isDefault: true, busy: false, loadError: null,
      confirmDel: '', loading: false, loaded: false, ctx: null, rev: 'r20261126-0045',
      mountScheduled: false, dropTimer: null, notifyTimer: null, watchTimer: null,
    };
    function ftplEl(tag, props, children) {
      const n = document.createElement(tag);
      if (props) Object.keys(props).forEach(k => {
        const v = props[k];
        if (v == null || v === false) return;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'style') Object.assign(n.style, v);
        else if (k === 'disabled') n.disabled = !!v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
        else n.setAttribute(k, String(v));
      });
      (children || []).forEach(c => {
        if (c == null || c === false) return;
        n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
      return n;
    }
    function ftplRoot() { try { return document.getElementById('ftpl-root'); } catch (_) { return null; } }
    function ftplNodeAt(groups, path) {
      let node = null;
      for (let k = 1; k < path.length; k += 2) {
        const arr = k === 1 ? groups : (node ? (Array.isArray(node.children) ? node.children : (node.children = [])) : null);
        if (!arr || !arr[path[k]]) return null;
        node = arr[path[k]];
      }
      return node;
    }
    function ftplSiblingsAt(groups, path) {
      if (path.length === 2) return groups;
      const parent = ftplNodeAt(groups, path.slice(0, -2));
      if (!parent) return null;
      if (!Array.isArray(parent.children)) parent.children = [];
      return parent.children;
    }
    function ftplDirty() { return JSON.stringify(FTPL.tpl) !== JSON.stringify(FTPL.saved); }
    function ftplNotify() {
      const cb = FTPL.ctx && FTPL.ctx.onDirtyChange;
      if (typeof cb === 'function') { try { cb(ftplDirty()); } catch (_) {} }
    }
    function ftplHintText() {
      return '新建/绑定项目时按这棵树生成项目文件夹骨架。'
        + (ftplDirty() ? '有未保存的修改。' : FTPL.isDefault ? '当前为内置默认。' : '已保存自定义模板。')
        + ' 各被评估单位的 00财务资料 / 02基础类 / 03资产基础法 / 04收益法 / 05市场法 子目录按公司与评估方法自动补齐，不在这棵树里。';
    }
    function ftplCountText(t) {
      return '目录总数：' + countDirs(t === undefined ? FTPL.tpl : t) + '（上限 400，层级上限 5）。改模板只影响之后新建的项目文件夹；已经建好的项目目录不会被改动或删除。';
    }
    // 只刷新文字/按钮状态，不重建整棵树——输入框里打字时不能丢焦点。
    function ftplHint() {
      const root = ftplRoot();
      if (!root) return;
      const hint = root.querySelector('#ftpl-hint'); if (hint) hint.textContent = ftplHintText();
      const cnt = root.querySelector('#ftpl-count'); if (cnt) cnt.textContent = ftplCountText();
      const sv = root.querySelector('#ftpl-save');
      if (sv) { sv.disabled = FTPL.busy || !FTPL.tpl || !ftplDirty(); sv.textContent = FTPL.busy ? '保存中…' : '保存模板'; }
      const rs = root.querySelector('#ftpl-reset'); if (rs) rs.disabled = FTPL.busy;
      const at = root.querySelector('#ftpl-addtop'); if (at) at.disabled = !FTPL.tpl || FTPL.busy;
    }
    function ftplEdit(fn, focusPath) {
      if (!FTPL.tpl) return;
      try { fn(FTPL.tpl); } catch (e) { if (FTPL.ctx && FTPL.ctx.toast) FTPL.ctx.toast('操作失败：' + String((e && e.message) || e), 'danger'); return; }
      FTPL.focusPath = focusPath || null;
      ftplPaint();
      ftplNotify();
    }
    function ftplAddChild(path) {
      const key = path.join('.');
      ftplEdit(g => {
        const n = ftplNodeAt(g.groups, path);
        if (!n) return;
        if (!Array.isArray(n.children)) n.children = [];
        n.children.push({ name: '新目录', children: [] });
        FTPL.focusPath = path.concat(['children', n.children.length - 1]).join('.');
      });
      FTPL.confirmDel = ''; if (FTPL.dropTimer) { clearTimeout(FTPL.dropTimer); FTPL.dropTimer = null; }
      if (FTPL.focusPath) {
        const root = ftplRoot();
        const inp = root && root.querySelector('input[data-path="' + String(FTPL.focusPath).replace(/"/g, '\\"') + '"]');
        if (inp) { try { inp.focus(); inp.select(); } catch (_) {} }
        FTPL.focusPath = null;
      }
      void key;
    }
    function ftplAddTop() {
      ftplEdit(g => { g.groups.push({ name: '新目录', children: [] }); });
    }
    function ftplRemove(path) {
      ftplEdit(g => { const sib = ftplSiblingsAt(g.groups, path); if (sib) sib.splice(path[path.length - 1], 1); });
    }
    async function ftplLoad() {
      if (FTPL.loading) return;
      FTPL.loading = true; FTPL.busy = true; FTPL.loadError = null;
      ftplPaint();
      try {
        const r = await fetch(PREFIX + '/project/folders/template');
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.error) throw new Error(String(d.error || ('HTTP ' + r.status)));
        // 深拷贝成两份独立对象：编辑直接改 FTPL.tpl，saved 必须留在读取时的快照，
        // 否则两者共享引用 → ftplDirty() 永远 false → 「保存模板」按钮永远禁用。
        FTPL.tpl = JSON.parse(JSON.stringify(d.template)); FTPL.saved = JSON.parse(JSON.stringify(d.template));
        FTPL.isDefault = !!d.isDefault;
      } catch (e) {
        // 读不到不再卡死：用内置骨架兜底，页面保持可编辑（保存/恢复默认走服务器，成功即纠正）。
        FTPL.loadError = String((e && e.message) || e);
        FTPL.tpl = { version: 1, groups: NEW_FOLDER_PREVIEW.map(g => ({ name: g.name, children: g.children.map(c => ({ name: c, children: [] })) })) };
        FTPL.saved = null; FTPL.isDefault = true;
      }
      FTPL.loading = false; FTPL.busy = false; FTPL.loaded = true;
      ftplPaint(); ftplNotify();
    }
    async function ftplSave() {
      const toast = (FTPL.ctx && FTPL.ctx.toast) || function () {};
      if (!FTPL.tpl || FTPL.busy) return;
      FTPL.busy = true; ftplPaint();
      try {
        const r = await fetch(PREFIX + '/project/folders/template', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ template: FTPL.tpl }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.error) throw new Error(String(d.error || ('HTTP ' + r.status)));
        FTPL.tpl = JSON.parse(JSON.stringify(d.template)); FTPL.saved = JSON.parse(JSON.stringify(d.template));
        FTPL.isDefault = false; FTPL.busy = false;
        ftplPaint(); ftplNotify();
        toast('文件夹模板已保存（' + countDirs(d.template) + ' 个目录）', 'ok');
      } catch (e) {
        FTPL.busy = false; ftplPaint();
        toast('保存失败：' + String((e && e.message) || e), 'danger');
      }
    }
    async function ftplReset() {
      const toast = (FTPL.ctx && FTPL.ctx.toast) || function () {};
      if (FTPL.busy) return;
      FTPL.busy = true; ftplPaint();
      try {
        const r = await fetch(PREFIX + '/project/folders/template', { method: 'DELETE' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.error) throw new Error(String(d.error || ('HTTP ' + r.status)));
        FTPL.tpl = JSON.parse(JSON.stringify(d.template)); FTPL.saved = JSON.parse(JSON.stringify(d.template));
        FTPL.isDefault = true; FTPL.busy = false; FTPL.confirmDel = '';
        ftplPaint(); ftplNotify();
        toast('已恢复内置默认模板', 'ok');
      } catch (e) {
        FTPL.busy = false; ftplPaint();
        toast('恢复默认失败：' + String((e && e.message) || e), 'danger');
      }
    }
    function ftplPaint() {
      const root = ftplRoot();
      if (!root) return;
      const tpl = FTPL.tpl;
      const busy = FTPL.busy;
      while (root.firstChild) root.removeChild(root.firstChild);
      const nodeBox = (node, path, depth) => {
        const key = path.join('.');
        const box = ftplEl('div', { style: { marginLeft: depth ? '18px' : '0' } });
        const row = ftplEl('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 0' } });
        row.appendChild(ftplEl('span', {
          text: depth === 0 ? '📁' : '└',
          style: { fontSize: (depth === 0 ? 13 : 12) + 'px', fontWeight: depth === 0 ? '600' : '400', minWidth: '18px' },
        }));
        const input = ftplEl('input', {
          class: 'pf-in', value: node.name == null ? '' : String(node.name),
          'data-path': key,
          style: { width: Math.max(160, (String(node.name || '')).length * 14 + 40) + 'px' },
        });
        // 打字只改数据 + 文字提示，不重建 DOM（否则光标丢失）；失焦/回车时才通知父级「有未保存改动」。
        input.addEventListener('input', () => { node.name = input.value; ftplHint(); });
        input.addEventListener('change', () => ftplNotify());
        row.appendChild(input);
        const addBtn = ftplEl('button', {
          type: 'button', class: 'pf-btn sm', title: '在这下面加一层子目录', text: '+ 子目录',
        });
        addBtn.disabled = depth >= 4 || busy;
        addBtn.addEventListener('click', ev => { if (ev && ev.preventDefault) ev.preventDefault(); ftplAddChild(path); });
        row.appendChild(addBtn);
        const delBtn = ftplEl('button', {
          type: 'button', class: 'pf-btn sm',
          title: '删除这个目录（不影响已建好的目录）',
          text: FTPL.confirmDel === key ? '确认删除？' : '删除',
        });
        if (FTPL.confirmDel === key) { delBtn.style.color = '#c0392b'; delBtn.style.fontWeight = '600'; }
        delBtn.addEventListener('click', ev => {
          if (ev && ev.preventDefault) ev.preventDefault();
          // 不用 confirm()（部分宿主 webview 会禁弹窗，点了像没反应）：两段式，3 秒不点自动复位。
          if (FTPL.confirmDel !== key) {
            FTPL.confirmDel = key;
            ftplPaint();
            if (FTPL.dropTimer) clearTimeout(FTPL.dropTimer);
            FTPL.dropTimer = setTimeout(() => { FTPL.dropTimer = null; FTPL.confirmDel = ''; ftplPaint(); }, 3000);
            return;
          }
          FTPL.confirmDel = '';
          if (FTPL.dropTimer) { clearTimeout(FTPL.dropTimer); FTPL.dropTimer = null; }
          ftplRemove(path);
        });
        row.appendChild(delBtn);
        box.appendChild(row);
        (node.children || []).forEach((c, i) => box.appendChild(nodeBox(c, path.concat(['children', i]), depth + 1)));
        return box;
      };

      // 页头
      const headLeft = ftplEl('div', null, [
        ftplEl('h2', { text: '文件夹模板', style: { margin: '0', fontSize: '18px' } }),
        ftplEl('div', { class: 'wb-hint', text: 'client ' + FTPL.rev, style: { marginTop: '2px', fontSize: '11px', opacity: '0.55' } }),
        ftplEl('div', { class: 'wb-hint', id: 'ftpl-hint', text: ftplHintText(), style: { marginTop: '4px' } }),
      ]);
      const headRight = ftplEl('div', { class: 'wb-row', style: { gap: '8px', alignItems: 'center' } });
      if (FTPL.loadError) {
        headRight.appendChild(ftplEl('span', { class: 'pf-err', text: '读取模板失败（' + FTPL.loadError + '），当前为内置骨架，可直接编辑；点「重新读取」或「恢复默认」重试。' }));
        headRight.appendChild(ftplEl('button', { type: 'button', class: 'pf-btn', text: '重新读取', disabled: busy, onClick: () => ftplLoad() }));
      }
      headRight.appendChild(ftplEl('button', { type: 'button', class: 'pf-btn', id: 'ftpl-addtop', text: '+ 一级目录', disabled: !tpl || busy, onClick: () => ftplAddTop() }));
      headRight.appendChild(ftplEl('button', { type: 'button', class: 'pf-btn', id: 'ftpl-reset', text: '恢复默认', disabled: busy, onClick: () => ftplReset() }));
      headRight.appendChild(ftplEl('button', {
        type: 'button', class: 'pf-btn pri', id: 'ftpl-save',
        text: busy ? '保存中…' : '保存模板', disabled: busy || !tpl || !ftplDirty(),
        onClick: () => ftplSave(),
      }));
      root.appendChild(ftplEl('div', null, [
        ftplEl('div', { class: 'wb-row', style: { justifyContent: 'space-between', marginBottom: '12px', alignItems: 'flex-start' } }, [headLeft, headRight]),
      ]));

      // 树
      if (!tpl) {
        root.appendChild(ftplEl('div', { class: 'wb-hint', text: busy ? '读取中…' : '模板还没读到，点「恢复默认」重建。' }));
      } else {
        const tree = ftplEl('div', {
          style: {
            border: '1px solid var(--dsw-alias-border-l1,#ddd)', borderRadius: '10px',
            padding: '10px 12px', maxHeight: '62vh', overflow: 'auto',
          },
        });
        if (tpl.groups && tpl.groups.length) tpl.groups.forEach((g, i) => tree.appendChild(nodeBox(g, ['groups', i], 0)));
        else tree.appendChild(ftplEl('div', { class: 'wb-hint', text: '模板是空的 —— 至少加一个一级目录再保存。' }));
        root.appendChild(tree);
      }
      root.appendChild(ftplEl('div', { class: 'wb-hint', id: 'ftpl-count', text: ftplCountText(), style: { marginTop: '8px' } }));
      root.__ftplPainted = true;   // 供看门狗识别：React 重渲染若换了新 div，这个标记会丢
    }
    // 看门狗：宿主 shim 在任何顶层 setState（toast/页签/脏标记）触发重渲染时，
    // 可能会把 #ftpl-root 里我们手工挂的 DOM 清掉，而且不一定重新调用本组件——
    // 表现就是「页签还在、内容区全黑」。这里每 0.7s 检查一次：挂载点还在（说明本页激活）
    // 但内容空了且数据已就绪，就重画一次。输入框打字不会触发清空，不受影响。
    function ftplWatch() {
      if (FTPL.watchTimer) return;
      FTPL.watchTimer = setInterval(() => {
        const root = ftplRoot();
        if (!root || !FTPL.loaded || FTPL.loading) return;
        if (!root.childNodes.length || !root.__ftplPainted) { try { ftplPaint(); } catch (_) {} }
      }, 350);
    }
    function ftplMount(props) {
      if (props) FTPL.ctx = props;
      ftplWatch();
      const root = ftplRoot();
      if (!root) return;
      // React 若在重渲染时清掉了我们的外来子节点（vdom 里这个 div 没有 children），这里补挂；
      // 没被清就保持原样——正在打字的输入框才不会丢焦点。
      if (!root.childNodes.length || !root.__ftplPainted) ftplPaint(); else ftplHint();
      if (!FTPL.loaded && !FTPL.loading) ftplLoad();
    }
    function FolderTemplatePage(props) {
      // 不依赖 useEffect（宿主 shim 对依赖数组的 effect 不保证执行）：每次渲染后补挂一次。
      FTPL.ctx = props || null;
      if (!FTPL.mountScheduled) {
        FTPL.mountScheduled = true;
        setTimeout(() => {
          FTPL.mountScheduled = false;
          try { ftplMount(FTPL.ctx); } catch (e) {
            const root = ftplRoot();
            if (root) { while (root.firstChild) root.removeChild(root.firstChild); root.appendChild(ftplEl('div', { class: 'pf-err', text: '页面渲染失败：' + String((e && e.message) || e) })); }
          }
        }, 0);
      }
      return h('div', { id: 'ftpl-root', style: { minHeight: 120 } });
    }
    function countDirs(t) {
      if (!t || !Array.isArray(t.groups)) return 0;
      let n = 0;
      const walk = node => { n += 1; (node.children || []).forEach(walk); };
      t.groups.forEach(walk);
      return n;
    }

    // 天源项目「绑定文件夹」前的选择：新建本地文件夹（按模板生成一整套），还是绑定一个已经存在的文件夹。
    // 这个选择是用户明确要的「强关联」入口 —— 一进来就决定这个天源项目对应磁盘上哪个目录。
    // 新建模式下的目录预览：与 folders.js 的 planProjectFolders 模板骨架对齐（各公司/方法子目录
    // 会在填好被评估单位与评估方法后由 /project/folders/build 按需补齐，这里只展示固定骨架）。
    const NEW_FOLDER_PREVIEW = [
      { name: '01前期资料', children: ['参考资料', '待整理资料', '行业研究'] },
      { name: '02现场资料', children: ['业务委托合同', '企业提供资料 / 00财务资料', '企业提供资料 / 01管理类', '企业提供资料 / 02基础类', '企业提供资料 / 03资产基础法', '企业提供资料 / 04收益法', '企业提供资料 / 05市场法', '现场勘察照片'] },
      { name: '03评估底稿', children: ['一级复核 / 01-报告、说明、明细表', '一级复核 / 02-底稿', '一级复核 / 03-复核意见', '一级复核 / 04-财务报表、审定数据', '二级复核', '三级复核', '送签发', '管理类底稿'] },
      { name: '04项目归档', children: ['01-报告、说明、明细表', '02-底稿', '03-复核意见', '04-财务报表、审定数据'] },
    ];

    function TyImportDialog({ project, busy, onCancel, onConfirm, toast }) {
      const p = project || {};
      const [mode, setMode] = useState('new');     // new=按编号简称新建（模板整套目录） | bind=绑定已有目录
      const [abs, setAbs] = useState('');
      const [info, setInfo] = useState(null);
      const [gen, setGen] = useState(null);        // { path, created, existed } 「新建」模式立即生成骨架的结果
      // 「新建」模式下的目录预览：优先取「文件夹模板」页保存的模板，取不到就用内置骨架兜底。
      const [preview, setPreview] = useState(null);
      useEffect(() => {
        let gone = false;
        (async () => {
          try {
            const r = await fetch(PREFIX + '/project/folders/template');
            const d = await r.json().catch(() => ({}));
            if (!gone && r.ok && d.ok && d.template && Array.isArray(d.template.groups)) setPreview(d.template.groups);
          } catch (e) { /* 预览失败不拦导入 */ }
        })();
        return () => { gone = true; };
      }, []);
      const previewGroups = preview || NEW_FOLDER_PREVIEW.map(g => ({ name: g.name, children: g.children.map(c => ({ name: c })) }));
      const renderPreviewNode = (node, depth) => h('div', { key: node.name + depth, style: { marginLeft: depth ? 16 : 0 } },
        h('div', { style: { fontWeight: depth === 0 ? 600 : 400, fontSize: depth === 0 ? 12 : 11 } }, (depth === 0 ? '📁 ' : '└ ') + esc(node.name)),
        (node.children || []).map(c => renderPreviewNode(c, depth + 1)));
      // p 是天源 MCP 的原始行（projectCode/projectName），不是本地记录（code/shortName）
      const autoName = folderNameOf({ code: p.projectCode, shortName: p.projectName });
      const probe = async v => {
        if (!String(v || '').trim()) { setInfo(null); return; }
        try {
          const r = await fetch(PREFIX + '/project/folder/probe', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: v }),
          });
          const d = await r.json().catch(() => ({}));
          setInfo(d && d.ok ? d : { error: (d && d.error) || '路径不可用' });
        } catch (e) { setInfo({ error: String((e && e.message) || e) }); }
      };
      const pick = async () => {
        let got = '';
        try { got = await pickDirectoryPath(); } catch (e) { toast(String((e && e.message) || e), 'warn'); return; }
        if (!got) return;
        got = got.replace(/[\\/]+$/, '');
        setAbs(got);
        probe(got);
      };
      const canOk = mode === 'new' || (!!String(abs).trim() && !!info && !info.error);
      // 「新建」模式：点一下就真建目录（幂等，已存在跳过）；确认绑定再走 onConfirm。
      const genNow = async () => {
        try {
          const r = await fetch(PREFIX + '/project/folders/build', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: autoName, companies: [] }),
          });
          const d = await r.json().catch(() => ({}));
          if (r.ok && d.ok) { setGen(d); toast('已生成项目文件夹骨架' + (d.root ? '：' + d.root : ''), 'ok'); }
          else toast('生成失败：' + ((d && d.error) || ('HTTP ' + r.status)), 'warn');
        } catch (e) { toast('生成失败：' + String((e && e.message) || e), 'warn'); }
      };
      return h(Modal, { title: '绑定本地文件夹 · ' + (p.projectName || '未命名'), onClose: busy ? () => {} : onCancel, style: { maxWidth: 700 } },
        h('p', { className: 'pf-hint', style: { margin: '0 0 12px' } },
          esc(p.projectCode || '无编号'), p.assessmentObject ? ' · ' + esc(p.assessmentObject) : '', ' · 绑定后本地项目与天源项目一一对应，之后同步/打开都认这条关系。'),
        h('div', { className: 'wb-row', style: { gap: 8, marginBottom: 12 } },
          h('button', { type: 'button', className: 'pf-btn ' + (mode === 'new' ? 'pri' : ''), onClick: () => setMode('new') }, '新建本地文件夹'),
          h('button', { type: 'button', className: 'pf-btn ' + (mode === 'bind' ? 'pri' : ''), onClick: () => setMode('bind') }, '绑定已有文件夹')),
        mode === 'new'
          ? h('div', { className: 'pf-hint' },
            h('div', { style: { marginBottom: 8 } }, '会在项目根目录下按「编号 简称」新建 ', h('code', null, autoName), '，并按项目模板生成一整套文件夹：'),
            h('div', { style: { border: '1px solid var(--dsw-alias-border-l2,#ddd)', borderRadius: 8, padding: '8px 10px', fontSize: 12, maxHeight: 220, overflow: 'auto' } },
              previewGroups.map(g => renderPreviewNode(g, 0))),
            h('div', { style: { marginTop: 8, color: 'var(--dsw-alias-label-secondary,#777)' } },
              '各被评估单位的 00财务资料 / 02基础类 / 03资产基础法 / 04收益法 / 05市场法 子目录，会在填好被评估单位与评估方法后自动补齐。'),
            h('div', { className: 'wb-row', style: { justifyContent: 'flex-end', marginTop: 10, gap: 8 } },
              gen && gen.root
                ? h('span', { className: 'pf-hint', style: { marginRight: 'auto' } },
                  '已就绪：', h('code', null, esc(gen.root)), '（' + (gen.created || 0) + ' 新建 / ' + (gen.existed || 0) + ' 已存在）')
                : null,
              h('button', { type: 'button', className: 'pf-btn', disabled: !!busy, onClick: genNow }, '立即按模板生成文件夹')))
          : h('div', null,
            h('div', { className: 'pf-folder' },
              h('input', {
                className: 'pf-in', value: abs, placeholder: '已存在的绝对路径，例如 ' + autoName,
                onChange: e => setAbs(e.target.value), onBlur: () => probe(abs),
              })),
            h('div', { className: 'pf-folder-acts', style: { marginTop: 8 } },
              h('button', { type: 'button', className: 'pf-btn', onClick: pick }, '选择文件夹…')),
            info
              ? (info.error
                ? h('div', { className: 'pf-err', style: { marginTop: 8 } }, info.error)
                : h('div', { style: { marginTop: 8, fontSize: 12 } },
                  h('span', { className: 'pf-folder-chip' }, '目录可用'),
                  h('span', { className: 'pf-hint', style: { marginLeft: 8 } }, (info.dirs || 0) + ' 个子目录 · ' + (info.files || 0) + ' 个文件'
                    + (info.sample && info.sample.length ? ' · ' + info.sample.slice(0, 4).join('、') : ''))))
              : null),
        h('div', { className: 'wb-row', style: { justifyContent: 'flex-end', marginTop: 16, gap: 8 } },
          h('button', { type: 'button', className: 'pf-btn', disabled: !!busy, onClick: onCancel }, '取消'),
          h('button', {
            type: 'button', className: 'pf-btn pri', disabled: !!busy || !canOk,
            onClick: () => onConfirm(mode === 'bind' ? { abs: String(abs).trim() } : {}),
          }, busy ? '绑定中…' : '确认绑定')));
    }


    function TyProjects({ s, toast, go, onOpenProject }) {
      // 本地缓存：同步后写入 localStorage（经 store），打开页面只读缓存，不再自动联网。
      const cached = s.work.ty.cachedProjects;
      const [rows, setRows] = useState(Array.isArray(cached) ? cached : null);
      const [busy, setBusy] = useState(false);
      const [importing, setImporting] = useState('');
      const [kw, setKw] = useState('');
      const [dbg, setDbg] = useState('');
      const [detail, setDetail] = useState(null);
      const [expMenu, setExpMenu] = useState(null);   // { id, x, y } 「更多」下拉菜单
      const [exporting, setExporting] = useState(''); // '<id>:<kind>' 导出进行中
      const [exportDialog, setExportDialog] = useState(null);
      const [importPick, setImportPick] = useState(null);   // 待选导入方式的天源项目 {project}
      const [reportDialog, setReportDialog] = useState(null);   // 报告/说明 · 官方格式 Word 导出工作区
      const exportBusy = useRef(false);
      const api = async (path, opts) => { const r = await fetch(PREFIX + path, opts); const t = await r.text(); let d = {}; try { d = JSON.parse(t); } catch (e) { d = { raw: String(t).slice(0, 200) }; } if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + String(t).slice(0, 160)); if (d && d.error) throw new Error(String(d.error)); return d; };
      const call = async (name, args) => { const d = await api('/ty/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args || {} }) }); if (d && d.error) throw new Error(d.error); if (d && d.isError) throw new Error(typeof d.data === 'string' ? d.data.slice(0, 200) : 'MCP 返回错误'); return d.data !== undefined ? d.data : d.structuredContent; };

      const numericId = value => {
        const raw = String(value == null ? '' : value).trim();
        if (!/^\d+$/.test(raw)) return null;
        const n = Number(raw);
        return Number.isSafeInteger(n) && n > 0 ? n : null;
      };
      const absolutePath = value => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(String(value || '').trim());
      // 报告/说明 → 官方格式 Word：打开独立操作页面（选公司、输出目录、进度、结果）。
      // ── 报告/说明导出工作区：支持「JSON 重建」与「网页端原生导出」两种方式 ──
      const openReportExport = async (p) => {
        setExpMenu(null);
        const token = uid();
        setReportDialog({
          token, project: p, status: 'confirm',
          method: 'web',              // web=网页端原生（默认，内容最全）| json=本地重建
          engine: 'browser',          // 只走你的真实浏览器（共享登录态）
          companies: [], selected: [], loadingCompanies: true,
          types: [1, 2], mode: 'current',   // current=导出当前版本 | refresh=生成新版本
          webProbe: null, webReports: null,
          applyFormat: true,          // 原生导出时按报告格式页处理表格
          outputDir: '', jobId: null, message: '',
        });
        setReportDialog(prev => prev && ({ ...prev, selTypes: {} }));
        // 并行：读取公司×类型矩阵（company/list 的 reportConfigList）+ 探测登录态与现有报告
        (async () => {
          const projectId = numericId(p.id);
          if (!projectId) { setReportDialog(d => d && d.token === token ? { ...d, loadingCompanies: false, companyError: '项目 ID 不是有效数字' } : d); return; }
          // 先自检浏览器通道；扩展被回收时自动重连一次（实测 1~2 秒），避免面板干等
          try {
            const bh = await fetch(PREFIX + '/ty/browser/bridge', { cache: 'no-store' }).then(r => r.json()).catch(() => null);
            if (bh && bh.ok === false && bh.code === 'BRIDGE_DISCONNECTED') {
              await fetch(PREFIX + '/ty/browser/bridge', { method: 'POST' }).then(r => r.json()).catch(() => null);
            }
          } catch (_) { /* 自检失败不阻断主流程，后面读取会给出真实原因 */ }
          const [co, web] = await Promise.all([
            fetch(PREFIX + '/ty/browser/companies?projectId=' + encodeURIComponent(projectId), { cache: 'no-store' }).then(r => r.json()).catch(e => ({ ok: false, error: String(e.message || e) })),
            fetch(PREFIX + '/ty/browser/probe?projectId=' + encodeURIComponent(projectId), { cache: 'no-store' }).then(r => r.json()).catch(e => ({ ok: false, error: String(e.message || e) })),
          ]);
          const list = (co && co.ok && Array.isArray(co.companies)) ? co.companies : [];
          const selTypes = {};
          for (const c of list) selTypes[String(c.id)] = (c.types || []).slice().sort();
          setReportDialog(d => d && d.token === token ? {
            ...d,
            companies: list,
            selected: list.filter(c => (c.types || []).length).map(c => c.id),
            selTypes,
            loadingCompanies: false,
            companyError: (co && !co.ok) ? (co.error || '读取公司列表失败') : '',
            companyExpired: !!(co && !co.ok && co.code === 'NOT_LOGGED_IN'),
            companyBridgeDown: !!(co && !co.ok && co.code === 'BRIDGE_DISCONNECTED'),
            webProbe: web,
          } : d);
          if (web && web.ok && web.logged && Array.isArray(web.reports)) {
            setReportDialog(d => d && d.token === token ? { ...d, webReports: web.reports } : d);
          }
        })();
      };
      // 展开成具体作业项：公司 × 类型
      const buildReportItems = d => {
        const label = { 1: '评估报告', 2: '评估说明', 3: '长投说明' };
        const sel = new Set((d.selected || []).map(String));
        const out = [];
        for (const c of d.companies || []) {
          if (!sel.has(String(c.id))) continue;
          const types = (d.selTypes && d.selTypes[String(c.id)]) || c.types || [];
          for (const t of types) out.push({ companyName: c.name, companyId: String(c.id), type: t, label: label[t], mode: d.mode });
        }
        return out;
      };
      const runReportExport = async () => {
        const d0 = reportDialog; if (!d0 || d0.status !== 'confirm') return;
        const projectId = numericId(d0.project.id);
        if (!projectId) { setReportDialog(d => d && ({ ...d, message: '项目 ID 不是有效数字' })); return; }
        if (!d0.types.length) { setReportDialog(d => d && ({ ...d, message: '请至少勾选一种文档类型' })); return; }
        if (!d0.selected.length) { setReportDialog(d => d && ({ ...d, message: '请至少勾选一家公司' })); return; }
        if (d0.outputDir && !absolutePath(d0.outputDir)) { setReportDialog(d => d && ({ ...d, message: '输出目录必须是绝对路径' })); return; }

        const items = buildReportItems(d0);
        // 二次确认：网页端 refresh 模式会写入天源系统
        if (d0.method === 'web' && d0.mode === 'refresh') {
          if (!confirm(`即将为 ${d0.selected.length} 家公司生成【新版本】${d0.types.map(t => ({1:'报告',2:'说明',3:'长投说明'}[t])).join('+')}。\n\n这会调用天源系统「生成报告」，每次生成会使版本号 +1 并写入系统（旧版保留可回溯）。\n\n共 ${items.length} 项作业。确认执行？`)) return;
        } else {
          const tip = d0.method === 'web'
            ? `将从天源网页端下载 ${items.length} 份【当前已生成版本】的原生 Word。`
            : `将用本地 JSON 通道重建 ${items.length} 份 Word（明细附表与表格内图片会缺失）。`;
          if (!confirm(tip + '\n\n确认执行？')) return;
        }

        const jobId = 'rd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        setReportDialog(d => d && ({ ...d, status: 'running', jobId, startedAt: Date.now(), done: 0, total: items.length, files: [], errors: [], message: '正在启动…' }));

        if (d0.method === 'web') {
          try {
            const r = await fetch(PREFIX + '/ty/browser/export', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jobId, projectId, applyFormat: d0.applyFormat !== false, items: items.map(i => ({ companyId: i.companyId, companyName: i.companyName, type: i.type, mode: i.mode })), outputDir: d0.outputDir || undefined, projectCode: d0.project.projectCode || '', projectName: d0.project.projectName || '' }) });
            const j = await r.json().catch(() => null);
            if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || ('HTTP ' + r.status));
            const poll = async () => {
              for (let i = 0; i < 400; i++) {
                await new Promise(res => setTimeout(res, 2500));
                let pr = null;
                try { pr = await fetch(PREFIX + '/ty/export/progress?jobId=' + jobId, { cache: 'no-store' }).then(x => x.json()); } catch (_) { continue; }
                setReportDialog(d => d && d.jobId === jobId ? { ...d, done: pr.done || 0, total: pr.total || items.length, message: pr.message || '处理中…', files: Array.isArray(pr.files) ? pr.files : [], errors: Array.isArray(pr.errors) ? pr.errors : [] } : d);
                if (pr && ['done', 'failed', 'partial'].includes(pr.status)) return pr;
              }
              return { status: 'failed', message: '轮询超时' };
            };
            const pr = await poll();
            setReportDialog(d => d && d.jobId === jobId ? { ...d, status: pr.status, files: pr.files || [], errors: pr.errors || [], outDir: pr.outDir, message: pr.message || '' } : d);
          } catch (e) {
            setReportDialog(d => d && ({ ...d, status: 'failed', message: String(e.message || e) }));
          }
          return;
        }

        // JSON 重建路径：沿用 tycpv export-report-docx
        try {
          const types = [...d0.types].sort();
          const r = await fetch(PREFIX + '/ty/report-docx', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId, types, projectId, companyIds: d0.selected.join(','), projectCode: d0.project.projectCode || '', projectName: d0.project.projectName || '', outputDir: d0.outputDir || undefined }) });
          const j = await r.json().catch(() => null);
          if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || ('HTTP ' + r.status));
          const poll = async () => {
            for (let i = 0; i < 400; i++) {
              await new Promise(res => setTimeout(res, 2500));
              let pr = null;
              try { pr = await fetch(PREFIX + '/ty/export/progress?jobId=' + jobId, { cache: 'no-store' }).then(x => x.json()); } catch (_) { continue; }
              setReportDialog(d => d && d.jobId === jobId ? { ...d, message: pr.message || '处理中…' } : d);
              if (pr && ['done', 'failed', 'partial'].includes(pr.status)) return pr;
            }
            return { status: 'failed', message: '轮询超时' };
          };
          const pr = await poll();
          setReportDialog(d => d && d.jobId === jobId ? { ...d, status: pr.status, files: (pr.files || []).map(f => (typeof f === 'string' ? { file: f } : f)), errors: [], outDir: pr.outDir, message: pr.message || '' } : d);
        } catch (e) {
          setReportDialog(d => d && ({ ...d, status: 'failed', message: String(e.message || e) }));
        }
      };
      const reportDialogBody = d => {
        const TYPE_LIST = [[1, '评估报告'], [2, '评估说明'], [3, '长投说明']];
        const update = patch => setReportDialog(prev => prev && ({ ...prev, ...patch }));
        const isWeb = d.method === 'web';
        const webOk = d.webProbe && d.webProbe.ok && d.webProbe.logged;
        const total = isWeb
          ? buildReportItems(d).length
          : (d.selected || []).length * (d.types || []).length;
        const canRun = d.status === 'confirm' && total > 0 && !!numericId(d.project.id)
          && (!d.outputDir || absolutePath(d.outputDir)) && (!isWeb || webOk);
        const pct = d.total ? Math.min(100, Math.round((d.done || 0) * 100 / d.total)) : 0;
        return h(Modal, { title: '报告/说明 · 导出工作区', onClose: () => (d.status === 'running' ? null : setReportDialog(null)), style: { width: 'min(900px, 100%)', maxHeight: '92vh' } },
          h('div', { className: 'wb-hint', style: { marginBottom: 14 } }, esc(d.project.projectName || '未命名项目'), ' · ', esc(d.project.projectCode || '无编号'), ' · ID ', esc(d.project.id)),

          // 方式选择
          h('div', { className: 'wb-sec', style: { margin: 0 } },
            h('div', { className: 'wb-sec-h' }, h('h2', null, '导出方式')),
            [['web', '原生导出（推荐）', '直接调天源系统接口下载其自身生成的 Word，内容与格式 100% 一致；需先在工作台登录天源（见下方登录区）。'],
             ['json', '本地 JSON 重建', '经报告数据接口重建 Word，版式按「报告格式」页配置；不含明细附表与表格内图片。']].map(([k, t, desc]) =>
              h('label', { key: k, style: { display: 'block', padding: '7px 0', cursor: d.status === 'confirm' ? 'pointer' : 'default', opacity: d.status === 'confirm' ? 1 : .6 } },
                h('input', { type: 'radio', name: 'rd-method', checked: d.method === k, disabled: d.status !== 'confirm', onChange: () => update({ method: k }) }),
                h('b', null, ' ' + t),
                k === 'web' && d.webProbe && !webOk ? h('span', { className: 'wb-hint', style: { color: 'var(--dsw-alias-state-error-primary,#c0392b)' } }, '　不可用：' + (d.webProbe.error || (d.webProbe.logged === false ? '天源未登录' : '未知'))) : null,
                h('div', { className: 'wb-hint', style: { marginLeft: 22 } }, desc)))) ,


          isWeb && webOk ? h('div', { className: 'wb-hint', style: { marginTop: 6 } },
            '已连接你的浏览器，登录态正常',
            ' · 系统现有 ' + ((d.webReports || []).length) + ' 份文档',
            h(Btn, { className: 'sm', style: { marginLeft: 8 }, disabled: d.status !== 'confirm', onClick: async () => {
                const projectId = numericId(d.project.id);
                const rr = await fetch(PREFIX + '/ty/browser/probe?projectId=' + encodeURIComponent(projectId), { cache: 'no-store' }).then(x => x.json()).catch(() => null);
                if (rr && rr.ok && rr.logged) update({ webProbe: rr, webReports: rr.reports || [], tyLoginError: '' });
                else update({ webProbe: rr || { ok: false, logged: false }, tyLoginError: (rr && (rr.error || rr.msg)) || '重新检测失败' });
              } }, '重新检测')) : null,
          isWeb && d.webProbe && !webOk && d.status === 'confirm' ? h('div', { className: 'wb-sec', style: { marginTop: 8, padding: 10 } },
            h('div', { className: 'wb-label' }, '需要用你已登录天源的浏览器'),
            h('div', { className: 'wb-hint', style: { marginBottom: 6 } },
              '这个功能通过 opencli 驱动你正在用的 Chrome（不读取、不导出 Cookie，也不改动天源接口）。请先在天源网页上完成登录，并保持 Chrome 开着，然后点「重新检测」。'),
            (d.webProbe && d.webProbe.code === 'NO_OPENCLI') ? h('div', { className: 'wb-alert danger', style: { marginBottom: 6 } }, '未找到 opencli（浏览器通道）。请安装 opencli 后重试。') : null,
            h('div', { className: 'wb-row' },
              h('span', { className: 'wb-hint' }, '请在你的 Chrome 里登录天源后点右侧按钮。'),
              h(Btn, { variant: 'pri', disabled: d.tyLogging, onClick: async () => {
                update({ tyLogging: true, tyLoginError: '' });
                try {
                  const projectId = numericId(d.project.id);
                  const rr = await fetch(PREFIX + '/ty/browser/probe?projectId=' + encodeURIComponent(projectId), { cache: 'no-store' }).then(x => x.json());
                  if (rr && rr.ok && rr.logged) update({ webProbe: rr, webReports: rr.reports || [], tyLoginError: '' });
                  else update({ webProbe: rr || { ok: false, logged: false }, tyLoginError: (rr && (rr.error || rr.msg)) || '仍未登录' });
                } catch (e) { update({ tyLoginError: String(e.message || e) }); }
                update({ tyLogging: false });
              } }, d.tyLogging ? '检测中…' : '重新检测')),
            d.tyLoginError ? h('div', { className: 'wb-hint', style: { color: 'var(--dsw-alias-state-error-primary,#c0392b)', marginTop: 6 } }, d.tyLoginError) : null) : null,

          // 版本策略（仅网页端）
          isWeb ? h('div', { className: 'wb-sec', style: { marginTop: 14 } },
            h('div', { className: 'wb-sec-h' }, h('h2', null, '版本策略')),
            [['current', '导出当前版本', '直接下载系统中最新「已生成」的版本；若从未生成过则该类型会跳过并提示。'],
             ['refresh', '生成新版本后导出', '先调用天源「生成报告」出新版（版本号 +1，写入系统），完成后再下载。']].map(([k, t, desc]) =>
              h('label', { key: k, style: { display: 'block', padding: '7px 0', cursor: d.status === 'confirm' ? 'pointer' : 'default', opacity: d.status === 'confirm' ? 1 : .6 } },
                h('input', { type: 'radio', name: 'rd-mode', checked: d.mode === k, disabled: d.status !== 'confirm', onChange: () => update({ mode: k }) }),
                h('b', null, ' ' + t),
                h('div', { className: 'wb-hint', style: { marginLeft: 22 } }, desc))),
            d.webReports && d.webReports.length ? h('div', { style: { marginTop: 8, maxHeight: 120, overflow: 'auto', border: '1px solid var(--dsw-alias-border-l1,#ddd)', borderRadius: 8, padding: 8 } },
              h('div', { className: 'wb-label' }, '系统现有文档'),
              d.webReports.map((r, i) => h('div', { key: i, style: { fontSize: 11, padding: '2px 0' } },
                (r.type ? ({ 1: '报告', 2: '说明', 3: '长投' }[r.type]) : '?'), ' · ', r.companyName || r.name || '?', ' · V', r.version, ' · ', Number(r.jobState) === 2 ? '已生成' : '状态' + (r.jobState ?? '?')))) : null
          ) : null,

          // 格式处理（仅原生模式）：按「报告格式」页的表格参数处理下载到的 docx
          isWeb ? h('div', { className: 'wb-sec', style: { marginTop: 14 } },
            h('div', { className: 'wb-sec-h' }, h('h2', null, '格式处理')),
            h('label', { style: { display: 'block', padding: '6px 0', cursor: d.status === 'confirm' ? 'pointer' : 'default' } },
              h('input', { type: 'checkbox', checked: d.applyFormat !== false, disabled: d.status !== 'confirm', onChange: e => update({ applyFormat: e.target.checked }) }),
              h('b', null, ' 按「报告格式」页的参数设置表格格式'),
              h('div', { className: 'wb-hint', style: { marginLeft: 22 } },
                '下载后用「评估工具箱」的表格设置模块处理，参数取自报告格式页（字体/字号/行高/边框/表头重复加粗/数字右对齐/单倍行距）；只改格式，不改任何文字。',
                ' 天源默认那种每列一样宽的表格，会按内容重新分配列宽（表头不再折行）；你手工调过的列宽一律不动。',
                ' 已经符合这些参数的表格会整张跳过；附件里从 Word 粘进来的表格也整段跳过——避免把原本排好的格式改坏。',
                ' 处理失败会保留原文件并在结果里提示。')),
            h('div', { className: 'wb-hint', style: { marginLeft: 22, marginTop: 4 } },
              '提示：页边距、标题层级等正文排版由天源系统决定，此处不覆盖。')) : null,

          // 类型（JSON 重建模式用；原生模式按公司×类型矩阵逐家勾选）
          !isWeb ? h('div', { className: 'wb-sec', style: { marginTop: 14 } },
            h('div', { className: 'wb-sec-h' }, h('h2', null, '文档类型'), h('span', { className: 'wb-tag grey' }, '已选 ' + d.types.length + ' 类')),
            h('div', { className: 'wb-row' }, TYPE_LIST.map(([t, tn]) =>
              h('label', { key: t, style: { display: 'inline-flex', gap: 6, alignItems: 'center', padding: '4px 12px 4px 0', cursor: d.status === 'confirm' ? 'pointer' : 'default' } },
                h('input', { type: 'checkbox', disabled: d.status !== 'confirm', checked: d.types.includes(t), onChange: e => update({ types: e.target.checked ? [...d.types, t].sort() : d.types.filter(x => x !== t) }) }), ' ', tn)))) : null,

          // 公司多选（原生模式按公司显示其可导出类型，逐公司勾选类型）
          h('div', { className: 'wb-sec', style: { marginTop: 14 } },
            h('div', { className: 'wb-sec-h' }, h('h2', null, '公司与文档'),
              h('span', { className: 'wb-tag grey' }, '已选 ' + buildReportItems(d).length + ' 份')),
            d.loadingCompanies ? h('div', { className: 'wb-hint' }, '正在读取公司×类型矩阵…')
              : d.companyError ? h('div', { className: 'wb-alert danger' },
                  h('div', null, '读取公司失败：' + d.companyError),
                  d.companyExpired ? h('div', { className: 'wb-hint', style: { marginTop: 8 } },
                    '天源未登录：请在你的 Chrome 里登录天源后点下面的「重新检测」。')
                  : d.companyBridgeDown ? h('div', { style: { marginTop: 8 } },
                    h(Btn, {
                      className: 'sm',
                      disabled: d.tyLogging,
                      onClick: async () => {
                        // 先尝试自动重连 daemon（扩展会自己回来），再重新读取
                        update({ tyLogging: true, tyLoginError: '正在尝试重连浏览器…' });
                        const rec = await fetch(PREFIX + '/ty/browser/bridge', { method: 'POST' }).then(x => x.json()).catch(e => ({ ok: false, error: String(e.message || e) }));
                        update({ tyLoginError: rec && rec.ok ? '' : String((rec && rec.error) || '自动重连失败') });
                        update({ tyLogging: false });
                      },
                    }, '重连浏览器'),
                    h(Btn, {
                      className: 'sm',
                      style: { marginLeft: 8 },
                      disabled: d.tyLogging,
                      onClick: async () => {
                        update({ tyLogging: true, companyBridgeDown: false, companyError: '', loadingCompanies: true });
                        const projectId = numericId(d.project.id);
                        const [co, web] = await Promise.all([
                          fetch(PREFIX + '/ty/browser/companies?projectId=' + encodeURIComponent(projectId), { cache: 'no-store' }).then(r => r.json()).catch(e => ({ ok: false, error: String(e.message || e) })),
                          fetch(PREFIX + '/ty/browser/probe?projectId=' + encodeURIComponent(projectId), { cache: 'no-store' }).then(r => r.json()).catch(e => ({ ok: false, error: String(e.message || e) })),
                        ]);
                        const list = (co && co.ok && Array.isArray(co.companies)) ? co.companies : [];
                        const selTypes = {};
                        for (const c of list) selTypes[String(c.id)] = (c.types || []).slice().sort();
                        update({
                          companies: list,
                          selected: list.filter(c => (c.types || []).length).map(c => c.id),
                          selTypes, loadingCompanies: false, tyLogging: false,
                          companyError: (co && !co.ok) ? (co.error || '读取公司列表失败') : '',
                          companyExpired: !!(co && !co.ok && co.code === 'NOT_LOGGED_IN'),
                          companyBridgeDown: !!(co && !co.ok && co.code === 'BRIDGE_DISCONNECTED'),
                          webProbe: web,
                          webReports: (web && web.ok && web.logged && Array.isArray(web.reports)) ? web.reports : null,
                        });
                      },
                    }, '重新检测'),
                    h('div', { className: 'wb-hint', style: { marginTop: 6 } },
                      '先在 Chrome 里确认「OpenCLI」扩展是启用状态（地址栏输入 chrome://extensions 查看），再点「重新检测」。'))
                  : null)
              : !(d.companies || []).length ? h('div', { className: 'wb-hint' }, '未找到公司')
              : h('div', null,
                  h('div', { className: 'wb-hint', style: { marginBottom: 8 } },
                    '每家公司只显示天源里实际配置的文档类型（无该类型的公司不会被导出）；勾选行首为整家公司，类型框单独控制。'),
                  h('div', { className: 'wb-row', style: { marginBottom: 8 } },
                    h(Btn, { className: 'sm', disabled: d.status !== 'confirm', onClick: () => update({
                      selected: d.companies.filter(c => (c.types || []).length).map(c => c.id),
                      selTypes: Object.fromEntries(d.companies.map(c => [String(c.id), (c.types || []).slice().sort()])),
                    }) }, '全选（有类型的公司）'),
                    h(Btn, { className: 'sm', disabled: d.status !== 'confirm', onClick: () => update({ selected: [], selTypes: {} }) }, '清空')),
                  h('div', { style: { maxHeight: 260, overflow: 'auto', border: '1px solid var(--dsw-alias-border-l1,#ddd)', borderRadius: 8, padding: 8 } },
                    d.companies.map(c => {
                      const avail = (c.types || []);
                      const checked = d.selected.includes(c.id);
                      const cur = (d.selTypes && d.selTypes[String(c.id)]) || [];
                      return h('div', { key: c.id, style: { display: 'flex', gap: 10, alignItems: 'center', padding: '6px 4px', borderBottom: '1px solid var(--dsw-alias-border-l3,#eee)', flexWrap: 'wrap' } },
                        h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', cursor: avail.length && d.status === 'confirm' ? 'pointer' : 'default', minWidth: 260 } },
                          h('input', { type: 'checkbox', disabled: d.status !== 'confirm' || !avail.length,
                            checked, onChange: e => update({ selected: e.target.checked ? [...d.selected, c.id] : d.selected.filter(id => id !== c.id) }) }),
                          h('span', null, c.name)),
                        avail.length ? TYPE_LIST.filter(([t]) => avail.includes(t)).map(([t, tn]) =>
                          h('label', { key: t, style: { display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 11, cursor: d.status === 'confirm' ? 'pointer' : 'default', opacity: checked ? 1 : .45 } },
                            h('input', { type: 'checkbox', disabled: d.status !== 'confirm' || !checked,
                              checked: cur.includes(t),
                              onChange: e => {
                                const next = e.target.checked ? [...cur, t].sort() : cur.filter(x => x !== t);
                                const st = { ...(d.selTypes || {}), [String(c.id)]: next };
                                const sel = e.target.checked && !checked ? [...d.selected, c.id] : (!next.length && checked ? d.selected.filter(id => id !== c.id) : d.selected);
                                update({ selTypes: st, selected: sel });
                              } }), tn)) : h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-text-secondary,#888)' } }, '无可导出文档'));
                    })))),

          // 存放位置
          h('div', { className: 'wb-sec', style: { marginTop: 14 } },
            h('div', { className: 'wb-sec-h' }, h('h2', null, '存放位置')),
            h('div', { className: 'wb-row', style: { alignItems: 'flex-end' } },
              h('div', { style: { flex: 1 } },
                h('label', { className: 'wb-label', htmlFor: 'rd-out' }, '输出目录（留空使用工作台默认）'),
                h(Inp, { id: 'rd-out', value: d.outputDir, disabled: d.status !== 'confirm', onChange: e => update({ outputDir: e.target.value }), placeholder: '留空 = 工作台数据目录/导出/项目/网页端', style: { width: '100%' } })),
              workspacePicker && h(Btn, { className: 'sm', disabled: d.status !== 'confirm', onClick: () => pickExportDirectoryReport(update) }, '选择目录'))),

          // 动作 / 进度
          d.status === 'confirm' && h('div', { className: 'wb-row', style: { marginTop: 16, justifyContent: 'flex-end', alignItems: 'center' } },
            h('span', { className: 'wb-hint', style: { marginRight: 'auto' } }, d.message || ('将执行 ' + total + ' 项作业'), ),
            h(Btn, { onClick: () => setReportDialog(null) }, '取消'),
            h(Btn, { variant: 'pri', disabled: !canRun, onClick: runReportExport }, '开始导出')),

          d.status === 'running' && h('div', { style: { marginTop: 16 } },
            h('div', { className: 'wb-row', style: { justifyContent: 'space-between', marginBottom: 6 } },
              h('span', { className: 'wb-hint' }, d.message || '处理中…'),
              h('b', null, pct + '%')),
            h('div', { style: { height: 8, background: 'var(--dsw-alias-bg-layer-2,#eee)', borderRadius: 4, overflow: 'hidden' } },
              h('div', { style: { height: '100%', width: pct + '%', background: 'var(--dsw-alias-brand-primary,#2f7ff0)', transition: 'width .3s' } })),
            h('div', { className: 'wb-hint', style: { marginTop: 6 } }, '已完成 ' + (d.done || 0) + ' / ' + (d.total || total) + ' 项')),

          ['done', 'partial', 'failed'].includes(d.status) && h('div', { style: { marginTop: 16 } },
            d.status === 'failed' ? h('div', { className: 'wb-alert danger' }, '导出失败：' + (d.message || '未知原因'))
              : h('div', { className: 'wb-alert', style: { background: 'var(--dsw-alias-bg-layer-2,#f2f8f2)' } },
                  (d.status === 'partial' ? '△ 部分完成' : '✓ 导出完成') + '：' + ((d.files || []).length) + ' 份' + (d.outDir ? ' → ' + d.outDir : '')),
            (d.files || []).length ? h('div', { style: { maxHeight: 160, overflow: 'auto', marginTop: 8 } },
              d.files.map((f, i) => h('div', { key: i, style: { fontSize: 11, padding: '3px 0', overflowWrap: 'anywhere' } }, '· ', typeof f === 'string' ? f : (f.file || JSON.stringify(f)), f.version ? '  (V' + f.version + ')' : ''))) : null,
            (d.errors || []).length ? h('div', { style: { marginTop: 8 } },
              h('div', { className: 'wb-label', style: { color: 'var(--dsw-alias-state-error-primary,#c0392b)' } }, '失败项'),
              d.errors.map((e, i) => h('div', { key: i, style: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary,#c0392b)', overflowWrap: 'anywhere' } }, '· ', e))) : null,
            h('div', { className: 'wb-row', style: { marginTop: 12, justifyContent: 'flex-end' } },
              d.outDir && h(Btn, { className: 'sm', onClick: () => openExportDir(d.outDir) }, '打开目录'),
              h(Btn, { onClick: () => setReportDialog(null) }, '关闭')))
        );
      };

      const prepareTyExport = async (p, kind) => {
        setExpMenu(null);
        const token = uid();
        const prefs = (s.settings && s.settings.exportPrefs) || {};
        setExportDialog({ token, project: p, kind, status: 'confirm', mode: prefs.mode === 'manual' ? 'manual' : 'auto', companies: [], selected: [], loadingCompanies: true, restoreFormulas: kind === 'detail', applyFormat: prefs.applyFormat !== false, sourcePath: '', outputDir: typeof prefs.outputDir === 'string' && prefs.outputDir ? prefs.outputDir : '', footers: {}, footerLoading: true, footerDirty: false, footerSaving: false, footerCompany: '', footerBatch: { preparer: false, date: false, appraisers: false }, footerBatchValues: { preparer: '', date: '', appraisers: '' } });
        try {
          const projectId = numericId(p.id);
          if (!projectId) throw new Error('项目 ID 不是有效数字');
          const data = await api('/ty/export/footers?projectId=' + projectId);
          if (!data || data.ok !== true || !data.footers || typeof data.footers !== 'object' || Array.isArray(data.footers)) throw new Error('页脚数据格式无法识别');
          setExportDialog(d => d && d.token === token ? { ...d, footers: data.footers, footerLoading: false } : d);
        } catch (e) {
          setExportDialog(d => d && d.token === token ? { ...d, footerLoading: false, footerError: String(e.message || e) } : d);
        }
        try {
          const projectId = numericId(p.id);
          if (!projectId) throw new Error('项目 ID 不是有效数字');
          const data = await call('get_project_companies', { projectId });
          const list = Array.isArray(data) ? data : data && (data.list || data.companies || data.data);
          if (!Array.isArray(list)) throw new Error('公司列表格式无法识别');
          const seen = new Set();
          const companies = list.map(c => ({ id: numericId(c && (c.id != null ? c.id : c.companyId)), name: String(c && (c.name || c.companyName) || '未命名公司') })).filter(c => c.id && !seen.has(c.id) && seen.add(c.id));
          setExportDialog(d => d && d.token === token ? { ...d, companies, loadingCompanies: false } : d);
        } catch (e) {
          setExportDialog(d => d && d.token === token ? { ...d, loadingCompanies: false, companyError: String(e.message || e) } : d);
        }
      };
      const pickExportDirectory = async field => {
        if (!workspacePicker) return;
        try {
          const path = await pickDirectoryPath();
          if (path) setExportDialog(prev => prev && prev.status === 'confirm' ? { ...prev, [field]: path, ...(field === 'sourcePath' ? { sourceFiles: null } : {}) } : prev);
        } catch (e) { toast('选择目录失败：' + String(e.message || e), 'danger'); }
      };
      const pickExportDirectoryReport = async update => {
        if (!workspacePicker) return;
        try {
          const path = await pickDirectoryPath();
          if (path) update({ outputDir: path });
        } catch (e) { toast('选择目录失败：' + String(e.message || e), 'danger'); }
      };
      const saveExportFooters = async d => {
        if (!d || d.footerSaving || d.footerLoading || d.footerError || !d.footerDirty) return;
        setExportDialog(prev => prev && prev.token === d.token ? { ...prev, footerSaving: true } : prev);
        try {
          const result = await api('/ty/export/footers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: String(numericId(d.project.id)), footers: d.footers }) });
          if (!result || result.ok !== true) throw new Error('保存未确认');
          setExportDialog(prev => prev && prev.token === d.token ? { ...prev, footerSaving: false, footerDirty: false, footerSaved: true } : prev);
        } catch (e) {
          setExportDialog(prev => prev && prev.token === d.token ? { ...prev, footerSaving: false, footerSaveError: String(e.message || e) } : prev);
        }
      };
      const listExportFiles = async dir => {
        try {
          const data = await api('/ty/export/files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir }) });
          setExportDialog(prev => prev && prev.status === 'confirm' && prev.sourcePath === dir ? { ...prev, sourceFiles: data.files, filesTruncated: data.truncated } : prev);
        } catch (e) { toast('读取工作簿失败：' + String(e.message || e), 'danger'); }
      };
      const runTyExport = async d => {
        if (d.footerDirty && !window.confirm('公司页脚有未保存的修改。继续导出将使用已保存的设置，不包含这些修改。是否继续？')) return;
        if (exportBusy.current || !d || d.status !== 'confirm' || (d.kind === 'detail' && !d.restoreFormulas && !d.applyFormat)) return;
        const ids = d.selected.map(numericId);
        if (d.mode === 'auto' && (!numericId(d.project.id) || !ids.length || ids.some(id => !id || !d.companies.some(c => c.id === id)))) return;
        if ((d.outputDir && !absolutePath(d.outputDir)) || (d.mode === 'manual' && (!absolutePath(d.sourcePath) || !absolutePath(d.outputDir)))) return;
        exportBusy.current = true;
        // 记住本次导出参数（模式 / 打印格式 / 输出目录），下次打开导出工作区自动预填。
        patch('settings', x => ({ ...x, exportPrefs: { ...((x && x.exportPrefs) || {}), mode: d.mode === 'manual' ? 'manual' : 'auto', applyFormat: d.applyFormat !== false, outputDir: (d.outputDir || '').trim(), savedAt: Date.now() } }));
        setExporting(String(d.project.id) + ':' + d.kind);
        const jobId = uid();
        const startedAt = Date.now();
        setExportDialog(prev => ({ ...prev, status: 'running', error: '', progress: null, startedAt, jobId, cancelling: false }));
        // 每 250ms 轮询宿主进度快照；小项目几秒就完成，粗轮询会只看到 0%。
        // 连续 unknown / 请求失败说明任务已不在宿主里（主机重启等），置为 lost 解锁对话框，
        // 不再让用户面对永远 0% 的孤儿进度条。
        let unknownStreak = 0, errStreak = 0;
        const markLost = () => {
          setExportDialog(prev => prev && prev.status === 'running' ? { ...prev, status: 'done', error: '任务进度丢失（主机可能已重启）。已无正在运行的导出，请关闭后重新发起。' } : prev);
        };
        const progTimer = setInterval(async () => {
          try {
            const p = await api('/ty/export/progress?jobId=' + jobId);
            if (p && p.stage === 'unknown') { unknownStreak += 1; if (unknownStreak >= 20) { clearInterval(progTimer); markLost(); return; } }
            else unknownStreak = 0;
            errStreak = 0;
            setExportDialog(prev => prev && prev.status === 'running' ? { ...prev, progress: p } : prev);
          } catch (_) {
            errStreak += 1;
            if (errStreak >= 40) { clearInterval(progTimer); markLost(); }
          }
        }, 250);
        try {
          const body = d.mode === 'auto'
            ? { kind: d.kind, jobId, projectId: String(numericId(d.project.id)), projectCode: d.project.projectCode || '', projectName: d.project.projectName || '', companyIds: ids.join(','), restoreFormulas: d.kind === 'detail' && d.restoreFormulas, applyFormat: d.applyFormat, outputDir: d.outputDir.trim() }
            : { kind: d.kind, jobId, sourcePath: d.sourcePath.trim(), outputDir: d.outputDir.trim(), restoreFormulas: d.kind === 'detail' && d.restoreFormulas, applyFormat: d.applyFormat };
          const r = await fetch(PREFIX + (d.mode === 'auto' ? '/ty/export' : '/ty/export/manual'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const result = await r.json().catch(() => ({ error: '无法解析导出响应（HTTP ' + r.status + '）' }));
          if (!r.ok && !result.error) result.error = 'HTTP ' + r.status;
          setExportDialog(prev => prev && ({ ...prev, status: 'done', result }));
        } catch (e) {
          setExportDialog(prev => prev && ({ ...prev, status: 'done', error: String(e.message || e) }));
        } finally {
          clearInterval(progTimer);
          exportBusy.current = false;
          setExporting('');
        }
      };
      // 终止任务：请求宿主杀掉该导出的全部子进程并停止处理剩余文件。
      // 解锁由既有路径完成：自动导出 POST 返回 499（已取消）→ done 视图；
      // 进度轮询也会看到 stage 'cancelled'。终止失败仅提示，不改变状态。
      const cancelExport = async d => {
        if (!d || d.status !== 'running' || !d.jobId || d.cancelling) return;
        setExportDialog(prev => prev && prev.token === d.token ? { ...prev, cancelling: true } : prev);
        try {
          await api('/ty/export/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: d.jobId }) });
        } catch (e) {
          setExportDialog(prev => prev && prev.token === d.token ? { ...prev, cancelling: false } : prev);
          toast('终止请求失败：' + String(e.message || e) + '。任务可能已结束。', 'danger');
        }
      };
      const closeExportDialog = () => { if (!exportBusy.current) setExportDialog(null); };
      const copyExportPath = async path => {
        try { await navigator.clipboard.writeText(path); toast('路径已复制', 'ok'); }
        catch (e) { toast('复制失败，请手动选择并复制路径', 'warn'); }
      };
      const openExportDir = async outDir => {
        try { await api('/ty/export/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outDir }) }); }
        catch (e) { toast('打开目录失败：' + String(e.message || e), 'danger'); }
      };

      // 刷新同步：唯一的联网入口。读取天源 → 立即保存到本地（localStorage）→ 更新界面。
      const syncNow = async () => {
        if (busy) return;
        setBusy(true);
        try {
          const s0 = await api('/ty/status');
          if (!s0.connected) {
            toast(s0.expired ? '授权已过期，请重新连接天源后再同步' : '尚未连接天源，请先在「连接设置」完成授权', 'warn');
            setBusy(false);
            return;
          }
          const d = await call('get_my_projects', {});
          const list = Array.isArray(d) ? d : (d && (d.list || d.projects || d.data)) || [];
          const now = new Date().toISOString();
          patch('work', w => ({ ...w, ty: {
            ...w.ty,
            cachedProjects: list,
            cachedAt: now,
            cachedUser: s0.user?.fullName || s0.user?.userName || '已授权',
            lastSync: now,
          } }));
          setRows(list);
          toast('同步完成，已保存到本地：共 ' + list.length + ' 个项目', 'ok');
        } catch (e) {
          const m = String(e.message || e);
          setDbg(m);
          toast('刷新同步失败（本地数据未改动）：' + m, 'danger');
        }
        setBusy(false);
      };
      const openDetail = async (p) => {
        setDetail({ project: p, loading: true });
        try {
          const [comps, ctxs] = await Promise.all([
            call('get_project_companies', { projectId: Number(p.id) }).catch(() => null),
            call('get_project_context', { projectId: Number(p.id) }).catch(() => null),
          ]);
          const ctxMap = {};
          (Array.isArray(ctxs) ? ctxs : []).forEach(x => { if (x && x.namedKey) ctxMap[x.namedKey] = x.value; });
          setDetail({ project: p, companies: Array.isArray(comps) ? comps : [], ctx: ctxMap, loading: false });
        } catch (e) { setDetail({ project: p, error: e.message, loading: false }); }
      };
      // opts.abs：把项目关联到一个「已经存在的本地文件夹」（而不是按编号简称新建）
      const importProject = async (p, opts) => {
        if (importing) return;
        const bindAbs = String((opts && opts.abs) || '').trim();
        setImporting(String(p.id));
        try {
          // 导入要填满四个页签，所以除了列表行，还得拉项目上下文与被评估公司
          const [comps, ctxs] = await Promise.all([
            call('get_project_companies', { projectId: Number(p.id) }).catch(() => []),
            call('get_project_context', { projectId: Number(p.id) }).catch(() => []),
          ]);
          const rec = tyToLocalProject(p, ctxs, comps, s.work.projects);
          const existing = s.work.projects.find(x => String(x.tyId) === String(p.id));
          // 已导入过的再点就是「更新」：天源的字段覆盖过来，本地自己排的工时/归档日不动
          const merged = existing
            ? {
              ...existing, ...rec, id: existing.id, deadline: existing.deadline || rec.deadline || '', budgetHours: existing.budgetHours || 0,
              // 本地绑定的文件夹是「人做过决定」的结果，不能被天源同步覆盖掉
              folderPath: existing.folderPath || '', folderBoundAt: existing.folderBoundAt || '',
            }
            : rec;
          // 选了「已有文件夹」就把它写进项目的绑定路径，后续打开/写盘/归档都认这个目录
          if (bindAbs) { merged.folderPath = bindAbs; merged.folderBoundAt = new Date().toISOString(); }
          // 文件夹：<项目编号> <项目简称>（老项目若还留着「年份 项目名」目录，宿主会优先复用）。
          // 建完不自动弹窗（列表里点项目名才打开），但要把路径回报出来，用户能立刻确认建在哪。
          let folder = '';
          let folderErr = '';
          try {
            const fr = await fetch(PREFIX + '/project/folder', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                folder: folderNameOf(merged), legacy: legacyFolderName(merged), abs: projectAbs(merged),
                year: merged.year, name: merged.shortName || merged.name, create: true, open: false,
              }),
            });
            const fd = await fr.json().catch(() => ({}));
            if (fr.ok && fd.ok) folder = String(fd.path || '');
            else folderErr = String(fd.error || ('HTTP ' + fr.status));
          } catch (e) { folderErr = String((e && e.message) || e); }
          patch('work', w => ({
            ...w,
            projects: existing ? w.projects.map(x => (x.id === existing.id ? merged : x)) : [merged, ...w.projects],
            ty: { ...w.ty, lastSync: new Date().toISOString() },
          }));
          // 导入时顺手把模板目录建出来（此时还没有股权/方法明细：骨架 + 被评估单位的 02基础类）
          buildProjectFolders(normalizeProject(merged), s, toast, true).catch(() => {});
          const groups = ['基本信息', '客户信息', '被评估单位信息', '合同信息'];
          const empty = [
            !merged.name && '项目名称', !merged.customer.name && '委托人名称', !merged.entity.name && '被评估单位',
          ].filter(Boolean);
          toast(
            (existing ? '已更新：' : '已绑定：') + (merged.name || '未命名')
            + ' · ' + groups.join('/') + ' 已同步'
            + (folder ? ' · 文件夹 ' + folder : (folderErr ? ' · 文件夹未建：' + folderErr : ''))
            + (empty.length ? ' · 天源这几项为空：' + empty.join('、') : ''),
            folderErr ? 'warn' : 'ok',
          );
        } catch (e) {
          toast('绑定文件夹失败：' + String((e && e.message) || e), 'danger');
        }
        setImporting('');
      };
      const filtered = (rows || []).filter(p => !kw || (String(p.projectName || '') + String(p.projectCode || '') + String(p.executionDepartment || '')).toLowerCase().includes(kw.toLowerCase()));
      const hasRows = Array.isArray(rows) && rows.length > 0;
      const tyMeta = s.work.ty;
      const syncedText = tyMeta.cachedAt ? '上次同步 ' + new Date(tyMeta.cachedAt).toLocaleString('zh-CN') + (tyMeta.cachedUser ? '（' + tyMeta.cachedUser + '）' : '') : '尚未同步过';
      return h('div', null,
        h(Section, { title: '天源项目 · 同步后保存到本地', actions: h('div', { className: 'wb-row' },
          h(Inp, { placeholder: '搜索项目 / 编号 / 部门', value: kw, onChange: e => setKw(e.target.value), style: { width: 190 } }),
          h(Btn, { variant: 'pri', onClick: syncNow, disabled: busy }, busy ? '同步中…' : '刷新同步'),
          h(Btn, { onClick: () => window.open(TY_BASE, '_blank', 'noopener') }, '打开天源')) },
          h('p', { className: 'wb-hint', style: { marginTop: 0 } }, '数据来自天源 MCP（mcp.zhrdc.net/valuation-mcp）：共 ' + (rows ? rows.length : '—') + ' 个项目 · ' + syncedText + '。打开页面只显示上次保存到本机 localStorage 的副本，不会自动联网；点右上角「刷新同步」才拉取天源最新项目并覆盖保存到本地。点「绑定文件夹」会让你选：按「项目编号 项目简称」新建一整套项目文件夹（按模板），或直接绑定一个已经存在的本地文件夹 —— 选定之后，这个天源项目与那个目录一一对应，本地项目里的打开/底稿/归档都只认它。已绑定的项目点名字直接进本地项目界面；要回天源网页，用行尾的「天源」按钮。已绑定的再点「绑定文件夹」就是「更新」，同步四组信息但不动本地工时与归档日。'),
          dbg && h('div', { className: 'wb-alert danger', style: { marginBottom: 10 } }, h('div', { style: { flex: 1 } }, h('div', { className: 't' }, '最近一次同步失败'), h('div', { className: 'b' }, '本地已保存的数据未受影响。' + (tyMeta.cachedAt ? '可在「连接设置」检查授权后重试。' : '请先在「连接设置」完成授权。') + ' 错误：' + dbg))),
          !hasRows ? (busy ? Empty('正在同步并保存到本地…') : Empty('本地暂无项目数据，点右上角「刷新同步」拉取并保存')) : h(Table, { cols: ['项目编号 / 名称', '部门', '状态', '风险', '基准日', '人员', '操作'], rows: filtered.map(p => {
            const stt = TY_STATUS[Number(p.projectStatus)] || { t: '状态' + p.projectStatus, c: 'grey' };
            const people = [...(p.partnerList || []).map(x => x.fullName), ...(p.managerList || []).slice(0, 3).map(x => x.fullName)].filter(Boolean).join('、');
            const localOne = s.work.projects.find(x => String(x.tyId) === String(p.id));
            const imported = !!localOne;
            return h('tr', { key: p.id },
              h('td', null,
                // 项目名称 → 进本地项目界面（不是跳天源）。没导入过的先提示导入。
                h('div', null, h('div', {
                  className: imported ? 'pf-name' : 'pf-name muted',
                  title: imported ? '进入项目界面（作业信息 / 股权信息 / 底稿目录）' : '这个项目还没绑定本地文件夹，先点这一行的「绑定文件夹」',
                  onClick: () => {
                    if (imported) { if (onOpenProject) onOpenProject(localOne.id); return; }
                    toast('「' + (p.projectName || '') + '」还没绑定本地文件夹，先点这一行的「绑定文件夹」', 'warn');
                  },
                }, h('b', null, esc(p.projectName)))),
                h('div', { className: 'muted' }, esc(p.projectCode) + (p.assessmentObject ? ' · ' + esc(p.assessmentObject) : '')
                  + (imported && projectAbs(localOne) ? ' · 📁 ' + projectAbs(localOne) : ''))),
              h('td', null, esc(p.executionDepartment || '—')),
              h('td', null, h('span', { className: 'wb-tag ' + stt.c }, stt.t)),
              h('td', null, h('span', { className: 'wb-tag ' + (p.riskLevelName === 'A' ? 'red' : 'grey') }, p.riskLevelName || '—')),
              h('td', null, tsToDate(p.evaluationBaseDate) || '—'),
              h('td', { className: 'muted', style: { fontSize: 11 } }, esc(people || '—')),
              h('td', null, h('div', { className: 'wb-row' },
                h(Btn, { className: 'sm', onClick: () => openDetail(p) }, '详情'),
                h(Btn, {
                  className: 'sm', variant: imported ? '' : 'pri', disabled: importing === String(p.id),
                  title: imported ? '从天源重新同步四组信息（本地工时与归档日不动）' : '绑定本地文件夹：按模板新建一整套项目文件夹，或绑定一个已有的本地文件夹',
                  onClick: () => {
                    if (imported) return importProject(p);
                    setImportPick({ project: p });
                  },
                }, importing === String(p.id) ? '绑定中…' : (imported ? '更新' : '绑定文件夹')),
                imported
                  ? h(Btn, { className: 'sm', title: '在本地打开这个项目的目录', onClick: () => { if (onOpenProject) onOpenProject(localOne.id); } }, '打开')
                  : null,
                h(Btn, { className: 'sm', title: '在天源网页打开该项目', onClick: () => window.open(tyProjectUrl(p.id), '_blank', 'noopener') }, '天源'),
                h(Btn, {
                  className: 'sm', disabled: !!exporting,
                  title: '更多操作：导出明细表 / 导出申报表 / 导出报告·说明（可多选）',
                  onClick: (ev) => {
                    const r = ev.currentTarget.getBoundingClientRect();
                    const menuH = 144; // 三个菜单项
                    const menuY = r.bottom + menuH > window.innerHeight ? Math.max(8, r.top - menuH) : r.bottom + 6;
                    setExpMenu(expMenu && expMenu.id === String(p.id) ? null : { id: String(p.id), x: Math.max(8, Math.min(r.left - 80, window.innerWidth - 190)), y: menuY });
                  },
                }, exporting && exporting.indexOf(String(p.id) + ':') === 0 ? '导出中…' : '更多'))),
            );
          }) }),
        ),
        importPick ? h(TyImportDialog, {
          project: importPick.project,
          toast,
          busy: importing === String(importPick.project.id),
          onCancel: () => setImportPick(null),
          onConfirm: async (opts) => { await importProject(importPick.project, opts); setImportPick(null); },
        }) : null,
        expMenu && h('div', { onClick: () => setExpMenu(null), style: { position: 'fixed', inset: 0, zIndex: 9990 } }),
        expMenu && h('div', { style: { position: 'fixed', left: expMenu.x, top: expMenu.y, zIndex: 9991, background: 'var(--dsw-alias-bg-overlay,#fff)', border: '1px solid var(--dsw-alias-border-l2,#bbb)', borderRadius: 10, boxShadow: '0 10px 30px rgba(0,0,0,.25)', padding: 6, minWidth: 150 } },
          [['detail', '导出明细表'], ['declare', '导出申报表'], ['reports', '导出报告/说明']].map(([k, label]) => h('button', {
            key: k,
            onClick: () => { const p = (rows || []).find(x => String(x.id) === expMenu.id); if (!p) return; if (k === 'detail' || k === 'declare') prepareTyExport(p, k); else openReportExport(p); },
            style: { display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-primary,#222)', fontSize: 12, cursor: 'pointer', borderRadius: 6 },
            onMouseEnter: (ev) => { ev.currentTarget.style.background = 'var(--dsw-alias-bg-layer-2,#f0f0f0)'; },
            onMouseLeave: (ev) => { ev.currentTarget.style.background = 'transparent'; },
          }, label))),
        reportDialog && reportDialogBody(reportDialog),
        exportDialog && (() => {
          const d = exportDialog;
          const update = patch => setExportDialog(prev => prev && ({ ...prev, ...patch }));
          const canRun = d.status === 'confirm' && (d.kind !== 'detail' || d.restoreFormulas || d.applyFormat) && (d.mode === 'manual'
            ? absolutePath(d.sourcePath) && absolutePath(d.outputDir)
            : !d.loadingCompanies && !d.companyError && d.selected.length > 0 && !!numericId(d.project.id) && (!d.outputDir || absolutePath(d.outputDir)));
          const result = d.result || {};
          const files = Array.isArray(result.results) ? result.results : [];
          const pathRow = (label, path, allowOpen) => path && h('div', { style: { marginTop: 10 } },
            h('div', { className: 'wb-label' }, label),
            h('div', { style: { overflowWrap: 'anywhere', userSelect: 'text' } }, path),
            h('div', { className: 'wb-row', style: { marginTop: 5 } },
              h(Btn, { className: 'sm', onClick: () => copyExportPath(path) }, '复制路径'),
              allowOpen && h(Btn, { className: 'sm', onClick: () => openExportDir(path) }, '打开目录')));
          return h(Modal, { title: (d.kind === 'detail' ? '明细表' : '申报表') + ' · 导出工作区', onClose: closeExportDialog, style: { width: 'min(960px, 100%)', maxHeight: '90vh' } },
            h('div', { className: 'wb-hint', style: { marginBottom: 16 } }, esc(d.project.projectName || '未命名项目'), ' · ', esc(d.project.projectCode || '无编号'), ' · 项目 ID ', esc(d.project.id)),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,340px),1fr))', gap: 16 } },
              h('div', { className: 'wb-sec', style: { margin: 0 } },
                h('div', { className: 'wb-sec-h' }, h('h2', null, '工作范围'), h('span', { className: 'wb-tag grey' }, '已选 ' + d.selected.length + ' 家')),
                h('div', { className: 'wb-hint', style: { marginBottom: 8 } }, '自动导出仅处理勾选的公司；手动整理使用下方指定的本地文件或文件夹。'),
                d.loadingCompanies ? h('div', { className: 'wb-hint' }, '正在读取天源公司列表…') : d.companyError ? h('div', { className: 'wb-alert danger' }, '读取公司失败：' + d.companyError) : !d.companies.length ? h('div', { className: 'wb-hint' }, '未找到可用的数字 ID 公司。') : h('div', null,
                  h('div', { className: 'wb-row', style: { marginBottom: 8 } },
                    h(Btn, { className: 'sm', disabled: d.status !== 'confirm', onClick: () => update({ selected: d.companies.map(c => c.id) }) }, '全选'),
                    h(Btn, { className: 'sm', disabled: d.status !== 'confirm', onClick: () => update({ selected: [] }) }, '清空')),
                  h('div', { style: { maxHeight: 240, overflow: 'auto', border: '1px solid var(--dsw-alias-border-l1,#ddd)', borderRadius: 8, padding: 8 } }, d.companies.map(c => h('label', { key: c.id, style: { display: 'flex', gap: 8, alignItems: 'center', padding: '7px 4px', cursor: 'pointer' } },
                    h('input', { type: 'checkbox', disabled: d.status !== 'confirm', checked: d.selected.includes(c.id), onChange: e => update({ selected: e.target.checked ? [...d.selected, c.id] : d.selected.filter(id => id !== c.id) }) }),
                    h('span', null, c.name, ' · ID ', String(c.id))))))),
              h('div', { className: 'wb-sec', style: { margin: 0 } },
                h('div', { className: 'wb-sec-h' }, h('h2', null, '处理模式')),
                [['auto', '自动导出整理'], ['manual', '选择已有工作簿手动整理']].map(([mode, label]) => h('label', { key: mode, style: { display: 'block', padding: '5px 0' } }, h('input', { type: 'radio', name: 'ty-export-mode', checked: d.mode === mode, disabled: d.status !== 'confirm', onChange: () => update({ mode }) }), ' ', label)),
                d.mode === 'manual' && h('div', { style: { marginTop: 12 } }, h('label', { className: 'wb-label', htmlFor: 'ty-source-path' }, '源文件或文件夹绝对路径'), h(Inp, { id: 'ty-source-path', value: d.sourcePath, disabled: d.status !== 'confirm', onChange: e => update({ sourcePath: e.target.value, sourceFiles: null }), placeholder: '/绝对路径/工作簿.xlsx', style: { width: '100%' } })),
                d.mode === 'manual' && h('div', { className: 'wb-row', style: { marginTop: 6 } },
                  workspacePicker && h(Btn, { className: 'sm', disabled: d.status !== 'confirm', onClick: () => pickExportDirectory('sourcePath') }, '选择源文件夹'),
                  h(Btn, { className: 'sm', disabled: d.status !== 'confirm' || !absolutePath(d.sourcePath), onClick: () => listExportFiles(d.sourcePath) }, '列出文件夹中的工作簿')),
                d.mode === 'manual' && Array.isArray(d.sourceFiles) && h('div', { style: { maxHeight: 150, overflow: 'auto' } }, d.sourceFiles.length ? d.sourceFiles.map(f => h(Btn, { key: f.path, className: 'sm', onClick: () => update({ sourcePath: f.path, sourceFiles: null }) }, f.name)) : h('span', { className: 'wb-hint' }, '该文件夹中没有工作簿'), d.filesTruncated && h('div', { className: 'wb-hint' }, '仅显示前 500 个文件')),
                h('div', { style: { marginTop: 12 } }, h('label', { className: 'wb-label', htmlFor: 'ty-output-path' }, d.mode === 'manual' ? '现有输出目录绝对路径（必填）' : '输出根目录绝对路径（可选）'), h(Inp, { id: 'ty-output-path', value: d.outputDir, disabled: d.status !== 'confirm', onChange: e => update({ outputDir: e.target.value }), placeholder: d.mode === 'manual' ? '请输入现有目录的绝对路径' : '留空使用工作台默认输出目录', style: { width: '100%' } }), workspacePicker && h(Btn, { className: 'sm', disabled: d.status !== 'confirm', onClick: () => pickExportDirectory('outputDir') }, '选择输出目录')),
                h('div', { className: 'wb-hint', style: { marginTop: 8, overflowWrap: 'anywhere' } }, d.mode === 'manual' ? '整理副本写入独立批次，不覆盖源文件；xlsm 不支持恢复公式，可仅选格式。' : '默认根目录：' + (hostSync.dir ? hostSync.dir + ' / 导出' : '工作台数据目录 / 导出') + '。导出到独立批次，整理后会替换该批次中下载的工作簿，不另保留原始下载副本。'),
                h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l1,#ddd)', marginTop: 14, paddingTop: 12 } }, h('b', null, '处理选项'),
                  d.kind === 'detail' && h('label', { style: { display: 'block', marginTop: 8 } }, h('input', { type: 'checkbox', checked: d.restoreFormulas, disabled: d.status !== 'confirm', onChange: e => update({ restoreFormulas: e.target.checked }) }), ' 恢复公式'),
                  h('label', { style: { display: 'block', marginTop: 8 } }, h('input', { type: 'checkbox', checked: d.kind === 'declare' || d.applyFormat, disabled: d.status !== 'confirm' || d.kind === 'declare', onChange: e => update({ applyFormat: e.target.checked }) }), d.kind === 'declare' ? ' 设置申报表打印格式（必选）' : ' 设置打印格式')))),
              d.mode === 'auto' && (() => {
                // 导出页脚：按公司分别配置；批量勾选字段后填一次可应用到所有已勾选公司。
                const setFooter = (cid, patch) => {
                  const cur = (d.footers && d.footers[cid]) || { preparer: '', date: '', appraisers: '' };
                  update({ footers: { ...d.footers, [cid]: { ...cur, ...patch } }, footerDirty: true, footerSaved: false, footerSaveError: '' });
                };
                const applyBatch = () => {
                  const vals = {};
                  for (const k of ['preparer', 'date', 'appraisers']) if (d.footerBatch[k]) vals[k] = d.footerBatchValues[k];
                  if (!Object.keys(vals).length) { toast('请先勾选要批量填充的字段', 'danger'); return; }
                  const next = { ...d.footers };
                  for (const cid of d.selected) next[cid] = { ...((d.footers && d.footers[cid]) || { preparer: '', date: '', appraisers: '' }), ...vals };
                  update({ footers: next, footerDirty: true, footerSaved: false, footerSaveError: '' });
                };
                const footerInput = (cid, field, label, width) => h(Inp, { value: ((d.footers && d.footers[cid] && d.footers[cid][field]) || ''), disabled: d.status !== 'confirm', onChange: e => setFooter(cid, { [field]: e.target.value }), placeholder: label, style: { width } });
                return h('div', { className: 'wb-sec', style: { margin: 0, gridColumn: '1 / -1' } },
                  h('div', { className: 'wb-sec-h' }, h('h2', null, '导出页脚'), d.footerDirty ? h('span', { className: 'wb-tag warn' }, '未保存') : d.footerSaved ? h('span', { className: 'wb-tag grey' }, '已保存') : h('span', { className: 'wb-tag grey' }, d.kind === 'detail' ? '明细表含评估人员' : '申报表不含评估人员'),
                    h(Btn, { className: 'sm', disabled: d.status !== 'confirm' || !d.footerDirty || d.footerSaving || d.footerLoading, onClick: () => saveExportFooters(d) }, d.footerSaving ? '保存中…' : '保存页脚')),
                  d.footerLoading ? h('div', { className: 'wb-hint' }, '正在读取页脚配置…')
                    : d.footerError ? h('div', { className: 'wb-alert danger' }, '读取页脚失败：' + d.footerError + '。导出将不写入页脚。')
                    : h('div', null,
                      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 } },
                        h('span', { className: 'wb-hint' }, '批量填充到已勾选公司：'),
                        ['preparer', 'date', 'appraisers'].filter(k => k !== 'appraisers' || d.kind === 'detail').map(k => h('label', { key: k, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h('input', { type: 'checkbox', checked: d.footerBatch[k], disabled: d.status !== 'confirm', onChange: e => update({ footerBatch: { ...d.footerBatch, [k]: e.target.checked } }) }), k === 'preparer' ? '填表人' : k === 'date' ? '填表日期' : '评估人员')),
                        h(Inp, { value: d.footerBatchValues.preparer, disabled: d.status !== 'confirm' || !d.footerBatch.preparer, onChange: e => update({ footerBatchValues: { ...d.footerBatchValues, preparer: e.target.value } }), placeholder: '填表人', style: { width: 120 } }),
                        h(Inp, { value: d.footerBatchValues.date, disabled: d.status !== 'confirm' || !d.footerBatch.date, onChange: e => update({ footerBatchValues: { ...d.footerBatchValues, date: e.target.value } }), placeholder: '填表日期', style: { width: 120 } }),
                        d.kind === 'detail' && h(Inp, { value: d.footerBatchValues.appraisers, disabled: d.status !== 'confirm' || !d.footerBatch.appraisers, onChange: e => update({ footerBatchValues: { ...d.footerBatchValues, appraisers: e.target.value } }), placeholder: '评估人员', style: { width: 140 } }),
                        h(Btn, { className: 'sm', disabled: d.status !== 'confirm' || !d.selected.length, onClick: applyBatch }, '应用到所选公司')),
                      !d.companies.length ? h('div', { className: 'wb-hint' }, '暂无公司，无法配置页脚。') : h('div', { style: { maxHeight: 200, overflow: 'auto', border: '1px solid var(--dsw-alias-border-l1,#ddd)', borderRadius: 8, padding: 8 } },
                        d.companies.filter(c => d.selected.includes(c.id)).map(c => h('div', { key: c.id, style: { display: 'flex', gap: 6, alignItems: 'center', padding: '4px 0', flexWrap: 'wrap' } },
                          h('span', { style: { minWidth: 150, fontSize: 12 } }, esc(c.name)),
                          footerInput(c.id, 'preparer', '填表人', 110),
                          footerInput(c.id, 'date', '填表日期', 110),
                          d.kind === 'detail' && footerInput(c.id, 'appraisers', '评估人员', 130))),
                        !d.companies.some(c => d.selected.includes(c.id)) && h('div', { className: 'wb-hint' }, '请先在左侧勾选公司；页脚按公司分别保存。')),
                      h('div', { className: 'wb-hint', style: { marginTop: 6 } }, '汇总表、设定信息等非明细工作表不写页脚；页脚在格式整理之后写入，申报表不会出现「评估人员」。手动整理模式无法绑定公司，不应用页脚。')));
              })(),
            d.status === 'confirm' && h('p', { className: 'wb-hint' }, d.mode === 'auto' ? '请先选择至少一家公司并确认；确认前不会导出。' : '请填写源文件或文件夹和现有输出目录的绝对路径，确认后开始整理。'),
            d.status === 'running' && (() => {
              const p = d.progress || {};
              const elapsed = Math.round((Date.now() - (d.startedAt || Date.now())) / 1000);
              const hasTotal = Number.isFinite(p.total) && p.total > 0;
              const done = Math.min(p.done || 0, p.total || 0);
              const pct = hasTotal ? Math.round(done / p.total * 100) : null;
              const stageMsg = p.stage === 'cancelled' ? (p.msg || '已取消，正在收尾…')
                : p.stage === 'export' ? (p.msg || '正在调用 tycpv 导出…')
                : hasTotal ? (p.msg || '正在整理第 ' + (done + 1) + ' / ' + p.total + ' 个工作簿' + (p.file ? '：' + p.file : ''))
                : (p.msg || '正在处理，请勿关闭页面…');
              return h('div', { role: 'status', style: { margin: '12px 0' } },
                h('p', { className: 'wb-hint', style: { marginBottom: 8 } }, stageMsg, ' · 已用时 ' + elapsed + ' 秒'),
                h('div', { className: 'wb-bar' + (pct == null ? ' pulse' : '') }, h('i', { style: { width: (pct == null ? 30 : pct) + '%' } })),
                pct != null && h('p', { className: 'wb-hint', style: { marginTop: 6 } }, pct + '%'));
            })(),
            d.status === 'done' && h('div', { className: 'wb-sec', style: { marginTop: 16, marginBottom: 0 }, role: 'status' },
              h('b', null, d.error || result.error || result.ok !== true || result.failedCount ? '处理未全部完成' : '文件处理完成（公司完整性未验证）'),
              (d.error || result.error) && h('p', { style: { color: 'var(--wb-danger-ink)', overflowWrap: 'anywhere' } }, d.error || result.error),
              result.total != null && h('p', { className: 'wb-hint' }, '成功 ' + result.successCount + ' / ' + result.total + '，失败 ' + result.failedCount),
              pathRow('实际输出批次目录', result.outDir, true),
              !result.outDir && h('p', { className: 'wb-hint' }, '未返回实际输出目录。'),
              files.length > 0 && h('div', { style: { marginTop: 14 } }, h('b', null, '逐文件结果与对比报告'), files.map((file, i) => h('div', { key: i, className: 'wb-alert ' + (file.ok ? '' : 'danger'), style: { marginTop: 8 } }, h('div', { style: { minWidth: 0, width: '100%' } },
                h('div', { className: 't' }, file.ok ? '处理成功' : '处理失败'),
                pathRow('源文件', file.sourcePath, false), pathRow('输出文件', file.outputPath, false), pathRow('对比报告', file.reportPath, false),
                file.reason && h('div', { style: { color: 'var(--wb-danger-ink)', overflowWrap: 'anywhere', marginTop: 6 } }, file.reason)))))),
            h('div', { className: 'wb-form-foot' }, h(Btn, { onClick: closeExportDialog, disabled: d.status === 'running' }, d.status === 'confirm' ? '取消' : '关闭'),
              d.status === 'running' && h(Btn, { variant: 'danger', disabled: d.cancelling, onClick: () => cancelExport(d) }, d.cancelling ? '正在终止…' : '终止任务'),
              d.status === 'confirm' && h(Btn, { variant: 'pri', disabled: !canRun, onClick: () => runTyExport(d) }, d.mode === 'auto' ? '确认导出并整理' : '确认整理')));
        })(),
        detail && h(Modal, { title: '天源项目详情', onClose: () => setDetail(null) },
          detail.loading ? Empty('正在读取项目详情…') : h('div', null,
            h('div', { className: 'wb-form', style: { marginBottom: 14 } },
              h(Field, { label: '项目名称', full: true }, h('div', null, esc(detail.project.projectName))),
              h(Field, { label: '项目编号' }, h('div', null, esc(detail.project.projectCode))),
              h(Field, { label: '执行部门' }, h('div', null, esc(detail.project.executionDepartment || '—'))),
              h(Field, { label: '评估基准日' }, h('div', null, tsToDate(detail.project.evaluationBaseDate) || '—')),
              h(Field, { label: '评估目的' }, h('div', null, esc(detail.ctx?.contractEvaluationPurpose || '—'))),
              h(Field, { label: '评估对象' }, h('div', null, esc(detail.project.assessmentObject || '—'))),
              h(Field, { label: '价值类型' }, h('div', null, esc(String(detail.ctx?.valueType || '').replace(/[\[\]"]/g, '') || '—'))),
              h(Field, { label: '业务性质' }, h('div', null, esc(detail.ctx?.evaluationBusinessNature || '—'))),
            ),
            h('div', { className: 'wb-sec-h' }, h('h2', null, '被评估公司（' + (detail.companies || []).length + '）')),
            (detail.companies || []).length ? h(Table, { cols: ['公司名称', '股权比例', '项目负责人'], rows: (detail.companies || []).map(c => h('tr', { key: c.id },
              h('td', null, h('b', null, esc(c.name)), h('div', { className: 'muted' }, esc(c.shortName || ''))),
              h('td', null, ((c.companyRelationDTOList || [])[0]?.shareholdingRate ?? '—') + '%'),
              h('td', { className: 'muted', style: { fontSize: 11 } }, ((c.companyManager || []).map(m => m.fullName).join('、') || '—')),
            )) }) : Empty('未返回公司信息'),
            detail.error && h('div', { className: 'wb-hint', style: { color: 'var(--dsw-alias-state-error-primary,#c0392b)' } }, '部分数据读取失败：' + detail.error),
            h('div', { className: 'wb-form-foot' },
              h(Btn, { onClick: () => setDetail(null) }, '关闭'),
              h(Btn, { onClick: () => window.open(tyProjectUrl(detail.project.id), '_blank', 'noopener') }, '在天源打开项目页'),
              (() => {
                // 主按钮给「进本地项目界面」：对着这个天源项目干活，主场景是本地底稿，不是天源网页
                const local = s.work.projects.find(x => String(x.tyId) === String(detail.project.id));
                if (!local) return null;
                return h(Btn, { variant: 'pri', onClick: () => { setDetail(null); if (onOpenProject) onOpenProject(local.id); } }, '打开本地项目');
              })(),
            ),
          ),
        ),
      );
    }

    // ================= 知识库问答 =================
    // 输入框 + 输出区：提问 -> 宿主检索归档库 -> 拼上下文调模型 -> 流式/整段回答 + 出处。
    function KbAsk({ api, toast, onOpen }) {
      const [q, setQ] = useState('');
      const [busy, setBusy] = useState(false);
      const [thread, setThread] = useState([]);   // [{role:'user'|'assistant', text, items, mode, error, usage, model}]
      const [showSrc, setShowSrc] = useState({}); // 每条回答展开状态
      const [useModel, setUseModel] = useState(true);
      const [models, setModels] = useState(null);        // [{id,name,models:[{id,name}]}]，null=还在读
      const [modelKey, setModelKey] = useState(() => {
        try { return localStorage.getItem('wb.kbModel') || ''; } catch (e) { return ''; }
      });
      const [modelNote, setModelNote] = useState('');
      const boxRef = useRef(null);
      const inputRef = useRef(null);

      // 读可用模型：GET /lib/models（宿主未重启时退回 /company/models，再不行就提示）
      useEffect(() => {
        let gone = false;
        const load = async () => {
          const tryUrls = [PREFIX + '/lib/models', PREFIX + '/company/models'];
          for (const u of tryUrls) {
            try {
              const r = await fetch(u);
              const d = await r.json().catch(() => ({}));
              if (gone) return;
              if (d && Array.isArray(d.providers)) {
                setModels(d.providers);
                setModelNote(d.ok === false ? (d.error || '') : '');
                // 没选过就落在宿主的当前模型上
                if (!modelKey && d.current && d.current.provider && d.current.model) {
                  setModelKey(d.current.provider + '::' + d.current.model);
                }
                return;
              }
            } catch (e) { /* 换下一个地址 */ }
          }
          if (!gone) { setModels([]); setModelNote('读不到可用模型（宿主可能需要重启）'); }
        };
        load();
        return () => { gone = true; };
      }, []);

      useEffect(() => {
        if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
      }, [thread, busy]);

      const send = async () => {
        const question = q.trim();
        if (!question || busy) return;
        const history = thread.filter(t => t.text).map(t => ({ role: t.role, content: t.text }));
        setQ('');
        setThread(prev => [...prev, { role: 'user', text: question }]);
        setBusy(true);
        try {
          const r = await fetch(PREFIX + '/lib/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              question, useModel, history: history.slice(-6), topK: 8,
              provider: modelKey ? modelKey.split('::')[0] : '',
              model: modelKey ? modelKey.split('::')[1] : '',
            }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
          setThread(prev => [...prev, {
            role: 'assistant', text: d.answer || '（没有返回内容）',
            items: d.items || [], mode: d.mode, error: d.error,
            usage: d.usage, model: d.model, diag: d.diag,
          }]);
        } catch (e) {
          setThread(prev => [...prev, { role: 'assistant', text: '问答失败：' + e.message, error: e.message, items: [] }]);
          toast('问答失败：' + e.message, 'danger');
        }
        setBusy(false);
        if (inputRef.current) inputRef.current.focus();
      };

      const reset = () => { setThread([]); setQ(''); };

      const openFile = async (rel) => {
        try {
          const r = await fetch(PREFIX + '/lib/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rel }) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
          toast('已用默认程序打开');
        } catch (e) { toast('打开失败：' + e.message, 'danger'); }
      };

      return h('div', null,
        h('div', { className: 'wb-split', style: { gridTemplateColumns: '1fr', gap: 12 } },
          h('div', { className: 'wb-sec', style: { marginBottom: 0 } },
            h('div', { className: 'wb-sec-h' },
              h('h2', null, '知识库问答'),
              h('div', { className: 'wb-row' },
                h('label', { className: 'wb-hint', style: { display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' } },
                  h('input', { type: 'checkbox', checked: useModel, onChange: e => setUseModel(e.target.checked) }),
                  '用模型总结'),
                h('select', {
                  className: 'wb-select',
                  title: '回答用的模型',
                  style: { maxWidth: 230 },
                  value: modelKey,
                  disabled: !useModel,
                  onChange: e => {
                    const v = e.target.value;
                    setModelKey(v);
                    try { localStorage.setItem('wb.kbModel', v); } catch (err) { /* 隐私模式下忽略 */ }
                  },
                },
                  models === null ? h('option', { value: '' }, '读取模型…')
                    : (() => {
                      const opts = (models || []).flatMap(p => (p.models || []).map(m => ({
                        key: p.id + '::' + m.id, label: (p.name || p.id) + ' / ' + (m.name || m.id),
                      })));
                      if (!opts.length) return [h('option', { key: 'none', value: '' }, '没有可用模型')];
                      if (!opts.some(o => o.key === modelKey)) {
                        return [h('option', { key: 'auto', value: '' }, '默认模型（自动选）')]
                          .concat(opts.map(o => h('option', { key: o.key, value: o.key }, o.label)));
                      }
                      return opts.map(o => h('option', { key: o.key, value: o.key }, o.label));
                    })()),
                h('button', { className: 'wb-btn sm', onClick: reset, disabled: !thread.length }, '清空'),
                h('button', {
                  className: 'wb-btn sm',
                  title: '打开 wiki 目录（_wiki\\wiki\\index.md）：项目页 + 主题页',
                  onClick: () => openFile('_wiki\\wiki\\index.md'),
                }, '知识库目录')),
              modelNote ? h('div', { className: 'wb-hint', style: { marginTop: 4 } }, modelNote) : null),

            // 输出区
            h('div', {
              ref: boxRef,
              style: {
                minHeight: 260, maxHeight: '52vh', overflow: 'auto', padding: 12,
                background: 'var(--wb-surface-2)', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1,#e3e6e8)',
              },
            },
              thread.length === 0 && !busy ? h('div', { className: 'wb-empty' },
                '问点什么，比如：',
                h('div', { className: 'wb-hint', style: { marginTop: 8, lineHeight: 2 } },
                  '· 中科嘉亿股权评估用的是哪几种评估方法？\n',
                  '· 千年舟减值测试的评估结论是多少？\n',
                  '· 商誉减值测试底稿一般怎么组织？\n',
                  '· 1000114371 这个项目归档了哪些文件？'))
                : null,
              thread.map((m2, i) => m2.role === 'user'
                ? h('div', { key: i, style: { textAlign: 'right', margin: '8px 0' } },
                  h('div', {
                    style: {
                      display: 'inline-block', maxWidth: '82%', textAlign: 'left', padding: '8px 12px',
                      borderRadius: '10px 10px 2px 10px', background: 'var(--wb-accent-soft)',
                      color: 'var(--wb-accent-soft-ink)', fontSize: 12.5, lineHeight: 1.7, whiteSpace: 'pre-wrap',
                    },
                  }, m2.text))
                : h('div', { key: i, style: { margin: '10px 0' } },
                  h('div', {
                    style: {
                      padding: '10px 12px', borderRadius: '10px 10px 10px 2px',
                      background: 'var(--dsw-alias-bg-layer-1,#fff)', border: '1px solid var(--dsw-alias-border-l1,#e3e6e8)',
                      fontSize: 12.5, lineHeight: 1.8, whiteSpace: 'pre-wrap', color: 'var(--dsw-alias-label-primary,#222)',
                    },
                  }, m2.text),
                  h('div', { className: 'wb-row', style: { marginTop: 6, gap: 8 } },
                    m2.mode === 'model' ? h('span', { className: 'wb-tag' }, '模型生成' + (m2.model ? ' · ' + m2.model : ''))
                      : h('span', { className: 'wb-tag grey' }, '仅检索'),
                    m2.error ? h('span', { className: 'wb-tag red' }, '模型不可用') : null,
                    m2.diag ? h('span', { className: 'wb-hint' }, m2.diag) : null,
                    m2.items && m2.items.length
                      ? h('button', {
                        className: 'wb-btn sm',
                        onClick: () => setShowSrc(s => ({ ...s, [i]: !s[i] })),
                      }, (showSrc[i] ? '收起出处' : '出处') + ' (' + m2.items.length + ')')
                      : null,
                    m2.usage ? h('span', { className: 'wb-hint' }, 'tokens ' + (m2.usage.inputTokens || 0) + '/' + (m2.usage.outputTokens || 0)) : null),
                  showSrc[i] ? h('div', { style: { marginTop: 8 } },
                    h('table', { className: 'wb-table' }, (m2.items || []).slice(0, 8).map((it, k) => {
                      const cells = [
                        h('td', { key: 'n', style: { whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary,#888)' } }, '[' + (k + 1) + ']'),
                        h('td', { key: 'f' },
                          h('div', { style: { fontWeight: 600 } }, it.file),
                          h('div', { className: 'muted', style: { fontSize: 11 } }, it.project + (it.subdir && it.subdir !== '.' && !it.wiki ? ' · ' + it.subdir : '')),
                          it.snippet ? h('div', { className: 'wb-hint', style: { marginTop: 3, background: 'var(--wb-warn-soft)', padding: '3px 6px', borderRadius: 4 } }, '…' + it.snippet.slice(0, 160) + '…') : null),
                        h('td', { key: 'a', style: { whiteSpace: 'nowrap' } },
                          it.wiki ? h('span', { className: 'wb-tag', style: { marginRight: 4 } }, '知识库页') : null,
                          it.scanned ? h('span', { className: 'wb-tag warn', style: { marginRight: 4 } }, 'OCR') : null,
                          h('button', { className: 'wb-btn sm', onClick: () => openFile(it.rel) }, '打开')),
                      ];
                      return h('tr', { key: k }, cells);
                    }))) : null,
                  )),
              busy ? h('div', { style: { margin: '10px 0' } },
                h('div', { className: 'wb-hint' }, '正在检索归档库并生成回答…'),
                h('div', { className: 'wb-bar', style: { marginTop: 6, width: 160 } }, h('i', { style: { width: '60%' } }))) : null),

            // 输入区
            h('div', { style: { marginTop: 10 } },
              h('textarea', {
                ref: inputRef,
                className: 'wb-textarea',
                rows: 3,
                placeholder: '输入问题（Enter 发送，Shift+Enter 换行）…',
                value: q,
                onChange: e => setQ(e.target.value),
                onKeyDown: e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                },
              }),
              h('div', { className: 'wb-row', style: { marginTop: 8, justifyContent: 'space-between' } },
                h('span', { className: 'wb-hint' }, '答案只依据本地归档库，不编造；引用会标 [资料N]'),
                h('div', { className: 'wb-row' },
                  h('span', { className: 'wb-hint' }, thread.length ? thread.length + ' 轮' : ''),
                  h('button', { className: 'wb-btn pri', onClick: send, disabled: busy || !q.trim() }, busy ? '思考中…' : '发送'))))),
        ),
      );
    }

    // ================= 评估文件库（本地归档库） =================
    // 数据来自宿主 /lib/* 路由：读取 D:\天源评估\已归档 的索引与知识库。
    // 四个子页（按此顺序展示）：概览、浏览（年份→项目→目录树，全文检索并入这里）、问答、扫描。
    /**
     * 扫描状态机（文件库共用）。
     *
     * 宿主 POST /lib/scan 立即返回，进度靠 GET /lib/scan 轮询（1.2s）。
     * 为什么轮询而不是 SSE：连接服务只提供 register 的 fetch 语义，没有流式通道；
     * 扫描最多几分钟、事件量很小，轮询更简单也更抗断线。页面关闭时轮询自动停止，
     * 但宿主侧子进程仍在跑 —— 重新进入页面会凭 status().running 接上实时进度。
     */
    function useScanState({ toast, onDone }) {
      const [st, setSt] = useState(null);
      const [doneAt, setDoneAt] = useState(0);
      const timer = useRef(null);
      const doneRef = useRef(onDone);
      doneRef.current = onDone;
      const toastRef = useRef(toast);
      toastRef.current = toast;

      const poll = useCallback(async () => {
        try {
          const r = await fetch(PREFIX + '/lib/scan');
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
          setSt(prev => {
            // running 由 true 变 false 的那一刻触发一次完成回调（只触发一次）
            if (prev && prev.running && !d.running) {
              setDoneAt(Date.now());
              if (d.phase === 'error') toastRef.current('扫描失败：' + (d.error || '未知错误'), 'danger');
              else if (d.phase === 'done') toastRef.current(scanSummary(d), 'ok');
              if (doneRef.current) doneRef.current();
            }
            return d;
          });
        } catch (e) { /* 轮询失败不打断界面，下一轮再试 */ }
      }, []);

      useEffect(() => {
        poll();
        timer.current = setInterval(poll, 1200);
        return () => { if (timer.current) clearInterval(timer.current); };
      }, [poll]);

      const start = useCallback(async (opts) => {
        try {
          const r = await fetch(PREFIX + '/lib/scan', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(opts || {}),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
          if (d.status) setSt(d.status);
          toastRef.current(d.already ? '已有扫描在运行，已接上进度'
            : (opts && opts.full ? '已开始全量重扫（会重抽所有文件）' : '已开始增量扫描'), 'ok');
          poll();
          return d;
        } catch (e) {
          toastRef.current('启动扫描失败：' + e.message, 'danger');
          throw e;
        }
      }, [poll]);

      const cancel = useCallback(async () => {
        try {
          const r = await fetch(PREFIX + '/lib/scan', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cancel: true }),
          });
          const d = await r.json().catch(() => ({}));
          toastRef.current(d.ok ? '已请求中断扫描' : ('中断失败：' + (d.error || r.status)), d.ok ? 'ok' : 'danger');
        } catch (e) { toastRef.current('中断失败：' + e.message, 'danger'); }
      }, []);

      return { st, setSt, start, cancel, doneAt, poll };
    }

    function scanSummary(d) {
      const s = (d && d.result) || {};
      const parts = [];
      if (s.newProjects) parts.push('新增项目 ' + s.newProjects);
      if (s.extracted != null) parts.push('抽取 ' + s.extracted);
      if (s.changed) parts.push('变化 ' + s.changed);
      if (s.failed) parts.push('失败 ' + s.failed);
      return '扫描完成' + (parts.length ? '：' + parts.join('、') : '');
    }

    const SCAN_PHASE = {
      idle: '空闲', walking: '遍历目录', extracting: '抽取文本', ocr: 'OCR 识别',
      xlsx: '刷新 Excel', indexing: '重建项目索引', done: '已完成', error: '出错',
    };

    function LibraryPanel({ toast }) {
      const [sub, setSub] = useState('overview');
      const [ov, setOv] = useState(null);
      const [err, setErr] = useState('');
      // 扫描状态提升到这里：任一子页都显示进度，扫描完成后刷新概览
      const scan = useScanState({ toast, onDone: () => loadOv() });
      const api = useCallback(async (path) => {
        const r = await fetch(PREFIX + path);
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.error) { const e = new Error(d.error || ('HTTP ' + r.status)); e.detail = d; throw e; }
        return d;
      }, []);
      const loadOv = useCallback(() => {
        api('/lib/overview').then(setOv).catch(e => setErr(e.message));
      }, [api]);
      useEffect(() => { loadOv(); }, [loadOv]);
      const kb = ov ? `知识库 ${ov.kbTextDocs}/${ov.kbDocs} 个文件有全文` : '';
      const scanning = scan.st && scan.st.running;
      return h('div', null,
        h('div', { className: 'wb-tabs' },
          [['overview', '概览'], ['browse', '浏览'], ['ask', '问答'], ['scan', '扫描']].map(([k, t]) =>
            h('button', { key: k, className: 'wb-tab ' + (sub === k ? 'on' : '') + (k === 'scan' && scanning ? ' scan-live' : ''), onClick: () => setSub(k) },
              k === 'scan' && scanning ? t + ' · 进行中' : t))),
        err ? h('div', { className: 'wb-alert danger' }, h('div', { className: 't' }, '读取失败'), h('div', { className: 'b' }, err)) : null,
        sub === 'ask' ? h(KbAsk, { api, toast })
          : sub === 'browse' ? h(LibBrowse, { api, toast, refreshKey: scan.doneAt })
            : sub === 'scan' ? h(LibScan, { api, toast, scan, ov })
              : h(LibOverview, { ov, kb, onScan: () => setSub('scan') }),
      );
    }

    function fmtSize(n) {
      if (n == null) return '';
      const u = ['B', 'KB', 'MB', 'GB'];
      let i = 0, v = Number(n);
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
      return (i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + u[i];
    }

    function LibBrowse({ api, toast, refreshKey }) {
      const [year, setYear] = useState('');
      const [projs, setProjs] = useState([]);
      const [kw, setKw] = useState('');
      const [sel, setSel] = useState(null);
      const [tree, setTree] = useState([]);
      // 文件树元信息：条目数 / 是否被上限截断 / 层数
      const [treeMeta, setTreeMeta] = useState(null);
      const [loading, setLoading] = useState(false);
      // 全文检索：原「检索」子页并入浏览。同一个输入框既筛项目，也在回车后搜知识库正文；
      // 命中行可以「浏览项目」直接跳回项目树，所以不再需要一个独立页签。
      const [res, setRes] = useState(null);
      const [busy, setBusy] = useState(false);
      const [doc, setDoc] = useState(null);
      useEffect(() => {
        api('/lib/projects').then(d => setProjs(d.items || [])).catch(e => toast(e.message, 'danger'));
      }, [api, toast, refreshKey]);   // refreshKey：扫描完成后重新拉项目列表
      const years = useMemo(() => Array.from(new Set(projs.map(p => p.year))).sort(), [projs]);
      const shown = useMemo(() => {
        // 有全文检索结果时不再用关键词筛项目：检索词通常匹配不上项目名，
        // 否则结果面板下方会是一片「没有匹配的项目」，浏览区域就废了。
        const k = res ? '' : kw.trim().toLowerCase();
        return projs.filter(p => (!year || p.year === year) && (!k ||
          [p.name, p.acceptanceNo, p.client, p.manager, p.reportNo].some(v => String(v || '').toLowerCase().includes(k))));
      }, [projs, year, kw, res]);
      const openProj = async (p) => {
        setSel(p); setLoading(true); setTreeMeta(null);
        try {
          // depth=64 实际等于「不限层数」，但特意传一个大数而不是省略：
          // 宿主半侧的 library.js 要重启才换得掉，若只刷新了页面，旧宿主会按
          // min(6, depth) 封顶——省略 depth 时旧宿主用默认 3，反而比原来更浅。
          // 传 64 让新旧宿主都取各自上限（旧=6、新=64），不会出现「刷新后变差」。
          // 以前写死 &depth=4，末级文件（第 5、6 层）全被截掉，界面上只剩中间几层文件夹。
          const d = await api('/lib/files?depth=64&path=' + encodeURIComponent(p.dir));
          setTree(d.items || []);
          setTreeMeta({
            dirs: d.dirs != null ? d.dirs : (d.items || []).filter(x => x.dir).length,
            files: d.files != null ? d.files : (d.items || []).filter(x => !x.dir).length,
            truncated: !!d.truncated,
            limit: d.limit || 0,
            base: d.path || '',          // 相对库根的路径，用来安全地「打开文件夹」
            error: d.error || null,
          });
        } catch (e) { toast(e.message, 'danger'); setTree([]); setTreeMeta(null); }
        setLoading(false);
      };
      const openPath = async (rel, reveal) => {
        try {
          const r = await fetch(PREFIX + '/lib/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rel, reveal }) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
          toast(reveal ? '已在资源管理器中定位' : '已用默认程序打开');
        } catch (e) { toast('打开失败：' + e.message, 'danger'); }
      };
      const runSearch = async () => {
        const q = kw.trim();
        if (!q) { setRes(null); return; }
        setBusy(true); setDoc(null);
        try { setRes(await api('/lib/search?limit=40&q=' + encodeURIComponent(q))); }
        catch (e) { toast(e.message, 'danger'); }
        setBusy(false);
      };
      const view = async (hit) => {
        try { setDoc({ hit, ...(await api('/lib/text?max=60000&rel=' + encodeURIComponent(hit.rel))) }); }
        catch (e) { toast(e.message, 'danger'); }
      };
      const openFile = async (rel) => {
        const r = await fetch(PREFIX + '/lib/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rel }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.error) toast('打开失败：' + (d.error || r.status), 'danger'); else toast('已用默认程序打开');
      };
      // 命中 → 项目树：检索结果和浏览共用同一个项目选中态。
      // 知识库里存的是项目目录名（「受理号 项目名」），项目列表里的 name 是去掉受理号后的名字，
      // 所以优先按受理号匹配，再退回目录名包含关系。
      const locate = (hit) => {
        const folder = String(hit.project || '');
        const acc = (folder.match(/^(\d{5,})/) || [])[1] || '';
        const p = projs.find(x => (acc && String(x.acceptanceNo) === acc)
          || x.name === folder || (x.name && folder.endsWith(x.name)));
        if (!p) { toast('项目列表里没找到「' + folder + '」', 'warn'); return; }
        setRes(null);
        setKw('');      // 退回浏览态：清掉检索词，左侧恢复完整项目列表
        openProj(p);
      };
      return h('div', null,
        h('div', { className: 'wb-row', style: { marginBottom: 12 } },
          h('select', { className: 'wb-select', value: year, onChange: e => setYear(e.target.value) },
            h('option', { value: '' }, '全部年份'), years.map(y => h('option', { key: y, value: y }, y))),
          h('input', { className: 'wb-input', style: { flex: 1, minWidth: 240 }, placeholder: '筛项目名 / 受理号 / 委托方；回车可全文检索正文…', value: kw, onChange: e => setKw(e.target.value), onKeyDown: e => { if (e.key === 'Enter') runSearch(); } }),
          h('button', { className: 'wb-btn pri', disabled: busy, onClick: runSearch }, busy ? '检索中…' : '全文检索'),
          res ? h('button', { className: 'wb-btn', onClick: () => { setRes(null); setKw(''); } }, '清除检索') : null,
          h('span', { className: 'wb-hint' }, res ? (res.total + ' 个文件命中') : (shown.length + ' 个项目'))),
        res ? h('div', { className: 'wb-sec', style: { marginBottom: 14 } },
          h('div', { className: 'wb-sec-h' },
            h('h2', null, '全文检索 · 命中 ' + res.total + ' 个文件'),
            h('div', { className: 'wb-hint' }, '覆盖 Word / Excel / 有文字层的 PDF 正文；扫描版 PDF 只能按文件名检索。点「浏览项目」可回到左侧项目树。')),
          res.total === 0 ? h('div', { className: 'wb-empty' }, '没有命中，换个关键词试试')
            : h('div', { style: { maxHeight: 320, overflow: 'auto' } },
              h('table', { className: 'wb-table' }, res.hits.map(hit => h('tr', { key: hit.rel },
                h('td', { style: { whiteSpace: 'nowrap' } }, h('span', { className: 'wb-tag grey' }, hit.year)),
                h('td', null,
                  h('div', { style: { fontWeight: 600, cursor: 'pointer' }, onClick: () => view(hit) }, hit.file),
                  h('div', { className: 'muted', style: { fontSize: 11 } }, hit.project + (hit.subdir && hit.subdir !== '.' ? ' · ' + hit.subdir : '')),
                  hit.snippet ? h('div', { className: 'wb-hint', style: { marginTop: 3, background: 'var(--wb-warn-soft)', padding: '3px 6px', borderRadius: 4 } }, '…' + hit.snippet + '…') : null),
                h('td', { style: { whiteSpace: 'nowrap' } },
                  hit.where === 'content' ? h('span', { className: 'wb-tag' }, '正文') : h('span', { className: 'wb-tag grey' }, '文件名'),
                  hit.scanned ? h('span', { className: 'wb-tag warn', style: { marginLeft: 4 } }, '扫描件') : null),
                h('td', { style: { whiteSpace: 'nowrap' } },
                  h('button', { className: 'wb-btn sm', onClick: () => view(hit) }, '预览'),
                  h('button', { className: 'wb-btn sm', style: { marginLeft: 4 }, onClick: () => openFile(hit.rel) }, '打开'),
                  h('button', { className: 'wb-btn sm', style: { marginLeft: 4 }, onClick: () => locate(hit) }, '浏览项目'))))))) : null,
        h('div', { className: 'wb-split' },
          h('div', { className: 'wb-sec', style: { maxHeight: 560, overflow: 'auto' } },
            h('div', { className: 'wb-sec-h' }, h('h2', null, '项目')),
            shown.length === 0 ? h('div', { className: 'wb-empty' }, '没有匹配的项目')
              : h('table', { className: 'wb-table' },
                shown.map(p => h('tr', { key: p.dir, style: { cursor: 'pointer', background: sel && sel.dir === p.dir ? 'var(--wb-accent-soft)' : '' }, onClick: () => openProj(p) },
                  h('td', { style: { whiteSpace: 'nowrap' } }, h('span', { className: 'wb-tag grey' }, p.year)),
                  h('td', null,
                    h('div', { style: { fontWeight: 600 } }, p.name),
                    h('div', { className: 'muted', style: { fontSize: 11 } }, p.acceptanceNo + (p.client ? ' · ' + p.client : ''))),
                  h('td', { className: 'muted', style: { textAlign: 'right', whiteSpace: 'nowrap' } },
                    (p.localFiles || 0) + ' 个 · ' + fmtSize(p.localBytes)))))),
          h('div', { className: 'wb-sec', style: { maxHeight: 560, overflow: 'auto' } },
            h('div', { className: 'wb-sec-h' }, h('h2', null, sel ? sel.name : '文件'),
              // 优先传「相对库根」的路径（/lib/files 返回的 path）：项目列表里的 dir 是绝对路径，
              // 旧宿主会把它直接 join 到库根后面，拼出重复路径。相对路径新旧宿主都认。
              sel ? h('button', { className: 'wb-btn sm', onClick: () => openPath((treeMeta && treeMeta.base) || sel.dir, false) }, '打开文件夹') : null),
            sel && treeMeta && !treeMeta.error
              ? h('div', { className: 'wb-hint', style: { marginBottom: 6 } },
                treeMeta.dirs + ' 个文件夹 · ' + treeMeta.files + ' 个文件' + (treeMeta.files ? '' : '（无末级文件）'),
                treeMeta.truncated ? ' · 已达 ' + treeMeta.limit + ' 项上限，未完全展开，请用「打开文件夹」查看其余内容' : '')
              : null,
            !sel ? h('div', { className: 'wb-empty' }, '左侧选一个项目')
              : loading ? h('div', { className: 'wb-empty' }, '读取中…')
                : tree.length === 0 ? h('div', { className: 'wb-empty' }, '该项目暂无文件')
                  : h('div', null, tree.map(it => h('div', {
                    key: it.path,
                    title: it.path,
                    style: { padding: '3px 0 3px ' + (it.level - 1) * 14 + 'px', display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 },
                  },
                    it.dir ? h('span', { style: { opacity: .6 } }, '📁') : h('span', { style: { opacity: .5 } }, '·'),
                    it.dir
                      ? h('span', { style: { fontWeight: 600 } }, it.name)
                      : h('a', { className: 'wb-link', style: { cursor: 'pointer' }, onClick: () => openPath(it.path, false), title: it.path }, it.name),
                    it.dir ? null : h('span', { className: 'wb-hint' }, fmtSize(it.size)),
                  ))))),
        doc ? h('div', { className: 'wb-modal-mask', onClick: e => { if (e.target === e.currentTarget) setDoc(null); } },
          h('div', { className: 'wb-modal', style: { width: 'min(900px,100%)' } },
            h('div', { className: 'wb-sec-h' },
              h('h3', { style: { margin: 0, fontSize: 14 } }, doc.meta ? doc.meta.file : doc.hit.file),
              h('div', { className: 'wb-row' },
                h('button', { className: 'wb-btn sm', onClick: () => openFile(doc.hit.rel) }, '用默认程序打开'),
                h('button', { className: 'wb-btn sm', onClick: () => setDoc(null) }, '关闭'))),
            h('div', { className: 'wb-hint', style: { marginBottom: 8 } },
              (doc.meta ? doc.meta.rel : doc.hit.rel) + (doc.totalChars ? ' · 共 ' + doc.totalChars + ' 字' : '')),
            doc.text ? h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.7, maxHeight: '62vh', overflow: 'auto', background: 'var(--wb-surface-2)', padding: 12, borderRadius: 8, margin: 0 } }, doc.text)
              : h('div', { className: 'wb-empty' }, doc.note || '该文件暂无可预览文本'))) : null
      );
    }

    // ------------------------------------------------------------ 扫描面板
    /**
     * 「刷新扫描」：把归档目录里新出现的项目/文件扫进知识库。
     *
     * 三种粒度：
     *  - 增量扫描（默认）：只处理「新增 + 修改」的文件，未变的沿用旧记录，秒级完成；
     *  - 全量重扫：所有文件重抽文本，用于怀疑索引有错、或换了解析器时；
     *  - 顺带 OCR：扫描版 PDF 调 MinerU（限张数，很贵很慢，默认不开）。
     *
     * 扫描结束后宿主会重建 _索引库/projects_index.json 与 评估文件库索引.xlsx，
     * 新项目自动出现在「浏览」「概览」里，无需手工建档。
     */
    function LibScan({ api, toast, scan, ov }) {
      const st = scan.st || {};
      const [full, setFull] = useState(false);
      const [ocr, setOcr] = useState(false);
      const [ocrLimit, setOcrLimit] = useState(10);
      const [busy, setBusy] = useState(false);
      const [preview, setPreview] = useState(null);
      const [pvBusy, setPvBusy] = useState(false);
      const running = !!st.running;
      const p = st.progress || { done: 0, total: 0 };
      const pct = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : (running ? 5 : 0);

      const startScan = async () => {
        setBusy(true);
        try { await scan.start({ full, ocr, ocrLimit: Number(ocrLimit) || 10 }); }
        catch (e) { /* toast 已提示 */ }
        setBusy(false);
      };
      const doPreview = async () => {
        setPvBusy(true);
        try {
          const d = await api('/lib/scan?preview=1');
          setPreview(d.preview);
        } catch (e) { toast('预检失败：' + e.message, 'danger'); }
        setPvBusy(false);
      };

      // 宿主重启后内存里的扫描状态是空的，但索引文件记着上次扫描时间 —— 回落到它，
      // 否则面板会假装「从没扫过」，和概览页的「上次扫描」自相矛盾。
      const lastRaw = st.endedAt || (ov && ov.lastScanAt) || null;
      const lastScan = lastRaw ? new Date(lastRaw) : null;
      const lastText = lastScan && !isNaN(lastScan.getTime())
        ? lastScan.getFullYear() + '-' + String(lastScan.getMonth() + 1).padStart(2, '0') + '-' + String(lastScan.getDate()).padStart(2, '0')
          + ' ' + String(lastScan.getHours()).padStart(2, '0') + ':' + String(lastScan.getMinutes()).padStart(2, '0')
        : '—';
      const lastPhase = st.endedAt ? (SCAN_PHASE[st.phase] || st.phase) : (lastRaw ? '上次扫描' : '未扫描');

      return h('div', null,
        // ---- 操作区
        h('div', { className: 'wb-sec' },
          h('div', { className: 'wb-sec-h' },
            h('h2', null, '刷新扫描'),
            h('div', { className: 'wb-row' },
              running
                ? h('button', { className: 'wb-btn sm danger', onClick: scan.cancel }, '中断')
                : h('button', { className: 'wb-btn pri sm', onClick: startScan, disabled: busy }, busy ? '启动中…' : '开始扫描'))),
          h('div', { className: 'wb-hint', style: { marginBottom: 10 } },
            '扫描 ' + (st.root || 'D:\\天源评估\\已归档') + ' 下的新增项目与文件，抽取正文后并入知识库；'
            + '目录结构为「年份 → 受理号 项目名 → 01 取数表 / 02 电子底稿 / 03 纸质报告、合同扫描 / 04 装订版报告」。'),
          h('div', { className: 'wb-row', style: { gap: 14 } },
            h('label', { className: 'wb-hint', style: { display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' } },
              h('input', { type: 'checkbox', checked: full, disabled: running, onChange: e => setFull(e.target.checked) }),
              '全量重扫（重抽所有文件，慢）'),
            h('label', { className: 'wb-hint', style: { display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' } },
              h('input', { type: 'checkbox', checked: ocr, disabled: running, onChange: e => setOcr(e.target.checked) }),
              '顺带 OCR 扫描版 PDF'),
            ocr ? h('label', { className: 'wb-hint', style: { display: 'flex', alignItems: 'center', gap: 5 } },
              '最多',
              h('input', {
                className: 'wb-input', type: 'number', min: 1, max: 200, value: ocrLimit,
                style: { width: 72 }, disabled: running,
                onChange: e => setOcrLimit(e.target.value),
              }),
              '张') : null,
            h('button', { className: 'wb-btn sm', onClick: doPreview, disabled: pvBusy || running }, pvBusy ? '预检中…' : '预检新项目')),
          h('div', { className: 'wb-hint', style: { marginTop: 8 } },
            '上次扫描：' + lastText + '（' + lastPhase + '）'
            + (st.ocr ? ' · 含 OCR' : '') + (st.error ? ' · ' + st.error : '')),
        ),

        // ---- 进度
        (running || st.phase === 'error' || st.walk) ? h('div', { className: 'wb-sec' },
          h('div', { className: 'wb-sec-h' },
            h('h2', null, '进度'),
            h('span', { className: 'wb-tag ' + (st.phase === 'error' ? 'red' : running ? '' : 'grey') },
              SCAN_PHASE[st.phase] || st.phase || '空闲')),
          st.walk ? h('div', { className: 'wb-row', style: { gap: 16, marginBottom: 8 } },
            h('span', { className: 'wb-hint' }, '磁盘文件 ' + st.walk.total),
            h('span', { className: 'wb-tag' }, '新增 ' + st.walk.added),
            h('span', { className: 'wb-tag grey' }, '变化 ' + st.walk.changed),
            h('span', { className: 'wb-tag warn' }, '删除 ' + st.walk.removed),
            st.walk.recovered ? h('span', { className: 'wb-tag grey' }, '复用 ' + st.walk.recovered) : null) : null,
          h('div', { className: 'wb-bar', style: { marginBottom: 6 } }, h('i', { style: { width: pct + '%' } })),
          h('div', { className: 'wb-row', style: { justifyContent: 'space-between', marginBottom: 8 } },
            h('span', { className: 'wb-hint' },
              p.total > 0 ? ('抽取 ' + p.done + '/' + p.total + '（成功 ' + (p.ok || 0) + '，跳过 ' + (p.skip || 0) + '，失败 ' + (p.fail || 0) + '）') : '尚未抽取文件'),
            st.ocrProgress && st.ocrProgress.total
              ? h('span', { className: 'wb-hint' }, 'OCR ' + st.ocrProgress.done + '/' + st.ocrProgress.total)
              : null),
          st.events && st.events.length ? h('div', {
            style: {
              maxHeight: 180, overflow: 'auto', fontFamily: 'Consolas,monospace', fontSize: 11,
              background: 'var(--wb-surface-2)', borderRadius: 6, padding: '6px 9px', lineHeight: 1.7,
            },
          }, st.events.slice(-30).map((e, i) => h('div', { key: i, className: 'wb-hint', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
            (e.ev === 'error' ? '✕ ' : e.ev === 'ocr' ? 'OCR ' : e.ev === 'walk' ? '· ' : '  ') + (e.text || '')))) : null,
          st.error ? h('div', { className: 'wb-alert danger', style: { marginTop: 10 } },
            h('div', { className: 't' }, '扫描出错'), h('div', { className: 'b' }, st.error)) : null,
        ) : null,

        // ---- 结果：本次新增的项目
        (st.newProjects && st.newProjects.length) ? h('div', { className: 'wb-sec' },
          h('div', { className: 'wb-sec-h' }, h('h2', null, '本次新增项目 (' + st.newProjects.length + ')')),
          h('table', { className: 'wb-table' },
            h('thead', null, h('tr', null, ['年份', '项目', '受理号', '文件', '来源'].map(t => h('th', { key: t }, t)))),
            h('tbody', null, st.newProjects.map((p2, i) => h('tr', { key: i },
              h('td', { style: { whiteSpace: 'nowrap' } }, h('span', { className: 'wb-tag grey' }, p2.year)),
              h('td', null, p2.name),
              h('td', { className: 'muted' }, p2.acceptanceNo || '—'),
              h('td', { className: 'muted' }, p2.localFiles || 0),
              h('td', null, p2.origin === 'crawl'
                ? h('span', { className: 'wb-tag' }, '天源同步')
                : h('span', { className: 'wb-tag warn' }, '磁盘新建')))))),
        ) : null,

        // ---- 预检结果
        preview ? h('div', { className: 'wb-sec' },
          h('div', { className: 'wb-sec-h' },
            h('h2', null, '磁盘项目预检'),
            h('div', { className: 'wb-row' },
              h('span', { className: 'wb-hint' }, preview.projects + ' 个项目 · 知识库 ' + preview.kbRows + ' 个文件'),
              h('button', { className: 'wb-btn sm', onClick: () => setPreview(null) }, '关闭'))),
          h('table', { className: 'wb-table' },
            h('thead', null, h('tr', null, ['年份', '项目目录', '受理号', '磁盘文件', '已入库', '状态'].map(t => h('th', { key: t }, t)))),
            h('tbody', null, preview.items.map((it, i) => {
              const pending = it.diskFiles > it.kbFiles;
              return h('tr', { key: i },
                h('td', { style: { whiteSpace: 'nowrap' } }, h('span', { className: 'wb-tag grey' }, it.year)),
                h('td', { style: { fontSize: 12 } }, it.folder),
                h('td', { className: 'muted' }, it.acceptanceNo || '—'),
                h('td', null, it.diskFiles),
                h('td', null, it.kbFiles),
                h('td', null, it.diskFiles === 0
                  ? h('span', { className: 'wb-tag grey' }, '空目录')
                  : pending
                    ? h('span', { className: 'wb-tag warn' }, '待扫描 ' + (it.diskFiles - it.kbFiles))
                    : h('span', { className: 'wb-tag' }, '已入库')));
            }))),
        ) : null,

        // ---- 识别规则说明
        h('div', { className: 'wb-sec' },
          h('div', { className: 'wb-sec-h' }, h('h2', null, '能扫进知识库的文件')),
          h('table', { className: 'wb-table' },
            h('thead', null, h('tr', null, ['类型', '处理方式'].map(t => h('th', { key: t }, t)))),
            h('tbody', null, [
              ['Word（docx/docm）', '正文 + 表格文本'],
              ['Excel（xlsx/xlsm/xls）', '每个工作表前 4000 行'],
              ['PDF（有文字层）', '按页抽文字（最多 200 页）'],
              ['PDF（扫描件）', '标记为扫描件；勾选「OCR」后调 MinerU 转 Markdown'],
              ['md / txt / csv', '纯文本'],
              ['图片 / 压缩包 / 老 doc', '只进文件清单，仅按文件名检索'],
            ].map(([k, v], i) => h('tr', { key: i },
              h('td', { style: { whiteSpace: 'nowrap' } }, k), h('td', { className: 'muted' }, v))))),
          h('div', { className: 'wb-hint', style: { marginTop: 10 } },
            '新增项目只要按「年份\\受理号 项目名\\01 取数表」的目录放好，扫描后就会自动建档；'
            + '没有受理号的目录名也能收，受理号一栏留空。'),
        ),
      );
    }

    function LibOverview({ ov, kb, onScan }) {
      if (!ov) return h('div', { className: 'wb-empty' }, '读取中…');
      return h('div', null,
        h('div', { className: 'wb-grid' },
          h(Card, { title: '项目' }, h('div', { className: 'wb-kpi' }, ov.projects), h('div', { className: 'wb-kpi-sub' }, '覆盖 ' + ov.byYear.length + ' 个年份')),
          h(Card, { title: '本地文件' }, h('div', { className: 'wb-kpi' }, ov.localFiles), h('div', { className: 'wb-kpi-sub' }, fmtSize(ov.localBytes))),
          h(Card, { title: '源端挂档' }, h('div', { className: 'wb-kpi' }, ov.sourceFiles), h('div', { className: 'wb-kpi-sub' }, '四类：取数表/电子底稿/纸质扫描/装订版')),
          h(Card, { title: '知识库' }, h('div', { className: 'wb-kpi' }, ov.kbTextDocs),
            h('div', { className: 'wb-kpi-sub' }, '有全文 / 共索引 ' + ov.kbDocs + ' 个文件'
              + (ov.kbOcr ? ' · OCR ' + ov.kbOcr : ''))),
          h(Card, { title: '上次扫描' },
            h('div', { className: 'wb-kpi', style: { fontSize: 18 } }, ov.lastScanAt ? String(ov.lastScanAt).slice(0, 10) : '—'),
            h('div', { className: 'wb-kpi-sub' },
              ov.lastScanAt ? (String(ov.lastScanAt).slice(11, 16) + ' · 新增项目 ' + ((ov.lastScan && ov.lastScan.newProjects) || 0)) : '还没扫描过'),
            onScan ? h('button', { className: 'wb-btn sm', style: { marginTop: 8 }, onClick: onScan }, '刷新扫描') : null)),
        h('div', { className: 'wb-sec' },
          h('div', { className: 'wb-sec-h' }, h('h2', null, '按年份')),
          h('table', { className: 'wb-table' },
            h('thead', null, h('tr', null, ['年份', '项目', '源端文件', '本地文件', '体积'].map(t => h('th', { key: t }, t)))),
            h('tbody', null, ov.byYear.map(y => h('tr', { key: y.year },
              h('td', null, y.year), h('td', null, y.projects), h('td', null, y.sourceFiles || 0),
              h('td', null, y.files),
              h('td', { className: 'muted' }, fmtSize(y.bytes))))))),
        h('div', { className: 'wb-sec' },
          h('div', { className: 'wb-sec-h' }, h('h2', null, '库位置')),
          h('div', { className: 'wb-hint' }, ov.root),
          h('div', { className: 'wb-hint' }, '索引生成时间：' + (ov.generatedAt || '—') + ' · 扫描件（无文字层）' + ov.kbScanned + ' 个')),
      );
    }

    // ---------- 车辆评估 ----------
    // 一条链路：选项目根 → 读公司 → 预扫描 → 识别归档（后台任务轮询）→ 生成权证信息表。
    // 识别与归档规则全在宿主侧 vehicle_cert.py 里，这里只负责选路径、看进度、看结果。
    function VehicleEval({ s, toast }) {
      const api = async (path, opts) => {
        const r = await fetch(PREFIX + path, opts);
        const t = await r.text();
        let d = {};
        try { d = JSON.parse(t); } catch (e) { d = { error: String(t).slice(0, 200) }; }
        if (!r.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
        if (d && d.error) throw new Error(String(d.error));
        return d;
      };
      const projects = (s.work && s.work.projects) || [];
      const [root, setRoot] = useState('');
      const [companies, setCompanies] = useState([]);
      const [company, setCompany] = useState('');
      // root 选到「项目集合目录」（如 00项目ing）时，后端会回项目列表，先让用户选具体项目
      const [projPick, setProjPick] = useState([]);
      const [scan, setScan] = useState(null);
      const [jobId, setJobId] = useState('');
      const [job, setJob] = useState(null);
      const [busy, setBusy] = useState('');
      const [msg, setMsg] = useState('');
      const [records, setRecords] = useState([]);
      const [report, setReport] = useState('');
      const poll = useRef(null);
      // 上传到天源底稿：项目ID/单位ID 从底稿网址里取，记住上次填的
      const [tyPid, setTyPid] = useState('');
      const [tyCid, setTyCid] = useState('');
      const [overwrite, setOverwrite] = useState(false);
      const [upJobId, setUpJobId] = useState('');
      const [upJob, setUpJob] = useState(null);
      const [draftState, setDraftState] = useState(null);
      // 识别引擎：百度智能云 OCR 需要 AK/SK（存本机 ~/.dsh/workbench-vehicle-ocr.json）
      const [ocrCfg, setOcrCfg] = useState(null);
      const [ocrEngine, setOcrEngine] = useState('auto');
      const [ocrAk, setOcrAk] = useState('');
      const [ocrSk, setOcrSk] = useState('');
      const [ocrMineruToken, setOcrMineruToken] = useState('');
      const [ocrMsg, setOcrMsg] = useState('');
      // 用量（百度按自然月 1000 次免费、MinerU 按天）：本机调用计数
      const [usage, setUsage] = useState(null);

      useEffect(() => {
        try {
          const v = JSON.parse(localStorage.getItem('wb.vehicle.ty') || '{}');
          if (v.pid) setTyPid(String(v.pid));
          if (v.cid) setTyCid(String(v.cid));
        } catch (e) { /* 忽略 */ }
      }, []);

      useEffect(() => {
        if (root) return;
        let saved = '';
        try { saved = String(localStorage.getItem('wb.vehicle.root') || '').trim(); } catch (e) { /* 忽略 */ }
        if (saved) { setRoot(saved); return; }
        const first = projects.find(p => String(p.folderPath || '').trim());
        if (first) { setRoot(String(first.folderPath).trim()); return; }
        // 本地项目还没加载过：退回工作台配置的项目目录（00项目ing），下面再选具体项目
        api('/store').then(d => {
          const pd = String((d && d.projectsDir) || '').trim();
          if (pd) setRoot(pd);
        }).catch(() => { /* 忽略 */ });
      }, [projects.length]);

      useEffect(() => {
        try { if (root) localStorage.setItem('wb.vehicle.root', root); } catch (e) { /* 忽略 */ }
      }, [root]);

      useEffect(() => {
        if (!jobId) return;
        let stop = false;
        const tick = async () => {
          try {
            const d = await api('/vehicle/progress?jobId=' + encodeURIComponent(jobId));
            if (stop) return;
            setJob(d.job || null);
            if (d.job && (d.job.status === 'done' || d.job.status === 'failed')) { setTimeout(() => loadIndex(), 300); return; }
          } catch (e) { if (!stop) setMsg(String(e.message || e)); }
          poll.current = setTimeout(tick, 1500);
        };
        tick();
        return () => { stop = true; clearTimeout(poll.current); };
      }, [jobId]);

      const loadIndex = async () => {
        if (!root || !company) return;
        try {
          const d = await api('/vehicle/index?root=' + encodeURIComponent(root) + '&company=' + encodeURIComponent(company));
          setRecords(d.records || []);
          setReport(d.report || '');
        } catch (e) { /* 索引不存在时静默 */ }
      };
      useEffect(() => { loadIndex(); }, [company]);

      const loadCompanies = async (rootArg) => {
        const r0 = String(rootArg || root || '').trim();
        if (!r0) { setMsg('先选项目根目录：可以直接粘贴项目文件夹，或从「选本地项目」里挑'); return; }
        setBusy('companies'); setMsg('');
        try {
          const d = await api('/vehicle/companies?root=' + encodeURIComponent(r0));
          const list = (d && d.companies) || [];
          const projs = list.filter(c => c && c.kind === 'project');
          if (projs.length) {
            setProjPick(projs.map(p => ({ name: p.name, dir: p.dir })));
            setCompanies([]); setCompany(''); setScan(null);
            setMsg('这个目录下有 ' + projs.length + ' 个项目，先在下面选具体项目');
            return;
          }
          setProjPick([]);
          setCompanies(list);
          const first = list[0];
          if (first) setCompany(first.name);
          if (!list.length) setMsg('这个目录下没有找到 02现场资料/企业提供资料/03资产基础法，请选到具体项目文件夹');
          else setMsg(d.base ? ('资料根目录：' + d.base + ' · 共 ' + list.length + ' 家公司') : ('共 ' + list.length + ' 家公司'));
        } catch (e) { setMsg(String(e.message || e)); } finally { setBusy(''); }
      };

      const doScan = async () => {
        if (!root || !company) { setMsg('先选项目和公司'); return; }
        setBusy('scan'); setMsg('正在扫描资料…'); setScan(null);
        try {
          const d = await api('/vehicle/scan?root=' + encodeURIComponent(root) + '&company=' + encodeURIComponent(company));
          setScan(d);
          setMsg('待处理 ' + d.count + ' 份资料（归档目标：' + d.target + '）');
        } catch (e) { setMsg(String(e.message || e)); } finally { setBusy(''); }
      };

      const startRun = async () => {
        if (!root || !company) { setMsg('先选项目和公司'); return; }
        setBusy('run'); setMsg('正在启动识别…'); setJob(null); setRecords([]);
        try {
          const d = await api('/vehicle/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root, company, engine: ocrEngine }) });
          setJobId(d.jobId);
        } catch (e) { setMsg(String(e.message || e)); } finally { setBusy(''); }
      };

      const doReport = async () => {
        if (!root || !company) { setMsg('先选项目和公司'); return; }
        setBusy('report'); setMsg('正在生成权证信息表…');
        try {
          const d = await api('/vehicle/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root, company }) });
          setReport(d.path || '');
          setMsg('已生成：' + d.path + '（' + d.rows + ' 辆车 / ' + d.details + ' 份资料）');
          if (toast) toast('权证信息表已生成');
          loadIndex();
        } catch (e) { setMsg(String(e.message || e)); } finally { setBusy(''); }
      };

      const saveTy = (pid, cid) => { try { localStorage.setItem('wb.vehicle.ty', JSON.stringify({ pid, cid })); } catch (e) { /* 忽略 */ } };

      useEffect(() => {
        if (!upJobId) return;
        let stop = false;
        const tick = async () => {
          try {
            const d = await api('/vehicle/upload/progress?jobId=' + encodeURIComponent(upJobId));
            if (stop) return;
            setUpJob(d.job || null);
            if (d.job && (d.job.status === 'done' || d.job.status === 'failed')) return;
          } catch (e) { if (!stop) setMsg(String(e.message || e)); }
          poll.current = setTimeout(tick, 1500);
        };
        tick();
        return () => { stop = true; clearTimeout(poll.current); };
      }, [upJobId]);

      const startUpload = async (dry) => {
        if (!root || !company) { setMsg('先选项目和公司'); return; }
        if (!/^\d{6,}$/.test(tyPid) || !/^\d{6,}$/.test(tyCid)) { setMsg('填天源项目ID / 被评估单位ID（底稿网址里的两段数字）'); return; }
        saveTy(tyPid, tyCid);
        setBusy('upload'); setUpJob(null); setDraftState(null);
        setMsg(dry ? '正在比对底稿现状…' : '正在上传：本机 Chrome 会被切到「车辆」科目页');
        try {
          const d = await api('/vehicle/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ root, company, projectId: tyPid, companyId: tyCid, dryRun: !!dry, overwrite }) });
          setUpJobId(d.jobId);
        } catch (e) { setMsg(String(e.message || e)); } finally { setBusy(''); }
      };

      const readDraft = async () => {
        if (!/^\d{6,}$/.test(tyPid) || !/^\d{6,}$/.test(tyCid)) { setMsg('填天源项目ID / 被评估单位ID'); return; }
        setBusy('state'); setMsg('正在读取底稿现状…');
        try {
          const d = await api('/vehicle/upload/state?projectId=' + encodeURIComponent(tyPid) + '&companyId=' + encodeURIComponent(tyCid));
          setDraftState(d);
          const withFiles = (d.items || []).filter(x => (x.files || []).length).length;
          setMsg('底稿（科目 ' + (d.subjectCode || '') + '）共 ' + d.rows + ' 行，其中 ' + withFiles + ' 行已挂权证');
        } catch (e) { setMsg(String(e.message || e)); } finally { setBusy(''); }
      };

      const loadOcr = async () => {
        try {
          const d = await api('/vehicle/ocr');
          const c = d.ocr || {};
          setOcrCfg(c);
          if (c.engine) setOcrEngine(String(c.engine));
          if (c.usage) setUsage(c.usage);
        } catch (e) { /* 宿主路由未生效时静默 */ }
      };
      const loadUsage = async () => {
        try {
          const d = await api('/vehicle/usage');
          if (d.usage) setUsage(d.usage);
        } catch (e) { /* 静默 */ }
      };
      useEffect(() => { loadOcr(); }, []);

      const resetUsage = async () => {
        try {
          await api('/vehicle/usage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true }) });
          await loadUsage();
          setOcrMsg('用量已清零（只影响本机计数，不影响百度/MinerU 服务端配额）');
        } catch (e) { setOcrMsg(String(e.message || e)); }
      };

      const saveOcr = async (check) => {
        setBusy('ocr');
        setOcrMsg(check ? '正在取百度 access_token…' : '正在保存…');
        try {
          const d = await api('/vehicle/ocr', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ engine: ocrEngine, ak: ocrAk, sk: ocrSk, mineruToken: ocrMineruToken, check: !!check }) });
          const c = d.ocr || {};
          setOcrCfg(c); setOcrAk(''); setOcrSk(''); setOcrMineruToken('');
          if (c.usage) setUsage(c.usage);
          if (check) setOcrMsg(c.ok ? ('可用：' + (c.msg || 'ok') + '（当前引擎 ' + (c.resolved || c.engine || '') + '）') : ('失败：' + (c.error || '未知错误')));
          else setOcrMsg('已保存：引擎 ' + (c.engine || '') + '（百度 ' + (c.hasKey ? c.akMasked : '未配置') + '，MinerU ' + (c.hasMineruToken ? c.mineruTokenMasked : '未配置') + '）');
        } catch (e) { setOcrMsg(String(e.message || e)); } finally { setBusy(''); }
      };

      const running = job && job.status === 'running';
      const upRunning = upJob && upJob.status === 'running';
      const rows = records.map((r, i) => {
        const fd = r.fields || {};
        return h('tr', { key: r.plate + '|' + (r.type || '') + i },
          h('td', null, h('b', null, r.plate || '')),
          h('td', null, r.type || ''),
          h('td', null, fd['车辆类型'] || ''),
          h('td', null, fd['所有人'] || ''),
          h('td', null, fd['品牌型号'] || ''),
          h('td', null, fd['车辆识别代号'] || ''),
          h('td', null, fd['注册日期'] || ''),
          h('td', null, fd['里程'] || ''),
          h('td', null, r.targetName || ''));
      });
      const logs = (job && job.logs) || [];

      return h('div', null,
        h(Section, { title: '车辆评估' },
          h('div', { className: 'wb-hint' }, '把企业提供的车辆行驶证、登记证、里程资料识别成 markdown，按「车牌+证件类型」归档到公司的固定资产/车辆目录，并生成权证信息表。'),
          h(Card, { title: '① 选择项目与公司' },
            h('div', { className: 'wb-grid' },
              h(Field, { label: '项目根目录（含 02现场资料/企业提供资料/03资产基础法）' },
                h('div', { style: { display: 'flex', gap: '8px' } },
                  h(Inp, { value: root, placeholder: 'D:\\天源评估\\00项目ing\\...', onChange: e => setRoot(e.target.value) }),
                  projects.length ? h(Sel, { value: '', onChange: e => { if (e.target.value) setRoot(e.target.value); } },
                    h('option', { value: '' }, '选本地项目…'),
                    projects.map(p => h('option', { key: p.id, value: String(p.folderPath || '') }, p.name || p.folderPath))) : null)),
              h(Field, { label: '被评估公司目录' },
                h('div', { style: { display: 'flex', gap: '8px' } },
                  h(Sel, { value: company, onChange: e => setCompany(e.target.value) },
                    h('option', { value: '' }, companies.length ? '选公司…' : '先点「读取公司」'),
                    companies.map(c => h('option', { key: c.name, value: c.name }, c.name))),
                  h(Btn, { onClick: () => loadCompanies(), disabled: !!busy }, busy === 'companies' ? '读取中…' : '读取公司')))),
            projPick.length ? h(Field, { label: '项目（这个目录下有 ' + projPick.length + ' 个项目，先选具体项目）' },
              h(Sel, { value: '', onChange: e => { const v = e.target.value; if (!v) return; setRoot(v); setProjPick([]); setCompanies([]); setCompany(''); setScan(null); loadCompanies(v); } },
                h('option', { value: '' }, '选项目…'),
                projPick.map(p => h('option', { key: p.dir, value: p.dir }, p.name)))) : null,
            msg ? h('div', { className: (msg.indexOf('没有找到') >= 0 || msg.indexOf('失败') >= 0 || msg.indexOf('先选') >= 0) ? 'wb-alert danger' : 'wb-hint', style: { marginTop: '8px' } }, msg) : null,
            h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' } },
              h(Btn, { onClick: doScan, disabled: !!busy || !company }, busy === 'scan' ? '扫描中…' : '预扫描资料'),
              h(Btn, { variant: 'pri', onClick: startRun, disabled: !!busy || running || !company }, running ? '识别中…' : '开始识别归档'),
              h(Btn, { onClick: doReport, disabled: !!busy || !company }, busy === 'report' ? '生成中…' : '生成权证信息表')),
            report ? h('div', { className: 'wb-hint' }, '权证信息表：' + report) : null),
          h(Card, { title: '② 识别引擎' },
            h('div', { className: 'wb-hint' }, '默认「自动」：配了百度智能云的 API Key / Secret Key 就走百度「行驶证识别」（号牌号码、车辆类型、所有人、使用性质、品牌型号、车辆识别代号、注册日期、发证日期直接给结构化字段，比 mineru 准），没配就用 mineru。密钥只存在本机 ~/.dsh/workbench-vehicle-ocr.json。'),
            h('div', { className: 'wb-grid' },
              h(Field, { label: '引擎' },
                h(Sel, { value: ocrEngine, onChange: e => setOcrEngine(e.target.value) },
                  h('option', { value: 'auto' }, '自动（有密钥用百度）'),
                  h('option', { value: 'baidu' }, '百度智能云 OCR'),
                  h('option', { value: 'mineru' }, 'MinerU 轻量（flash，免 token）'),
                  h('option', { value: 'mineru-pro' }, 'MinerU 精准解析（需 token）'))),
              h(Field, { label: '百度 API Key' },
                h(Inp, { value: ocrAk, placeholder: (ocrCfg && ocrCfg.akMasked) || '填 API Key（留空不改）', onChange: e => setOcrAk(e.target.value.trim()) })),
              h(Field, { label: '百度 Secret Key' },
                h(Inp, { value: ocrSk, placeholder: ocrCfg && ocrCfg.hasKey ? '已保存（留空不改）' : '填 Secret Key', onChange: e => setOcrSk(e.target.value.trim()) })),
              h(Field, { label: 'MinerU 精准解析 token' },
                h(Inp, { value: ocrMineruToken, placeholder: (ocrCfg && ocrCfg.mineruTokenMasked) || 'sk-…（留空不改）', onChange: e => setOcrMineruToken(e.target.value.trim()) }))),
            h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' } },
              h(Btn, { onClick: () => saveOcr(false), disabled: !!busy }, busy === 'ocr' ? '…' : '保存设置'),
              h(Btn, { onClick: () => saveOcr(true), disabled: !!busy }, busy === 'ocr' ? '…' : '测试密钥'),
              h(Btn, { onClick: loadUsage, disabled: !!busy }, '刷新用量'),
              h(Btn, { onClick: resetUsage, disabled: !!busy }, '清零用量')),
            usage ? h('div', { className: 'wb-hint', style: { marginTop: '8px' } },
              '用量（本机计数）：百度 ' + usage.baidu.used + '/' + usage.baidu.limit + ' 次 · ' + usage.baidu.period + '　|　MinerU 轻量 '
              + usage.mineru.used + '/' + usage.mineru.limit + ' 份 · ' + usage.mineru.period + '　|　MinerU 精准 '
              + usage.mineruPro.used + ' 份 / ' + usage.mineruPro.pages + ' 页') : null,
            ocrMsg ? h('div', { className: 'wb-hint', style: { marginTop: '8px' } }, ocrMsg) : null),
          scan ? h(Card, { title: '预扫描结果（' + scan.count + ' 份）' },
            h('div', { className: 'wb-hint' }, '归档目录：' + scan.target),
            h(Table, {
              cols: ['文件', '车牌', '类型'],
              rows: (scan.files || []).slice(0, 12).map(x => h('tr', { key: x.name },
                h('td', null, x.name), h('td', null, x.plate || '—'), h('td', null, String(x.ext || '').replace('.', '')))),
            }),
            (scan.files || []).length > 12 ? h('div', { className: 'wb-hint' }, '仅显示前 12 份，共 ' + scan.count + ' 份') : null) : null,
          (running || logs.length) ? h(Card, { title: '识别进度' },
            h('div', { className: 'wb-hint' }, (job && job.message) || ''),
            job && job.total ? h(Bar, { v: job.n || 0, max: job.total }) : null,
            h('div', { style: { maxHeight: '220px', overflow: 'auto', marginTop: '8px', fontSize: '12px', lineHeight: '1.6' } },
              logs.length ? logs.slice(-40).map((l, i) => h('div', { key: i }, l)) : h('div', { className: 'wb-hint' }, '等待第一条结果…'))) : null,
          h(Card, { title: '识别结果（' + records.length + ' 条）' },
            h(Table, {
              cols: ['车牌', '证件', '车辆类型', '所有人', '品牌型号', '车辆识别代号', '注册日期', '里程', '归档文件'],
              rows,
            })),
          h(Card, { title: '③ 上传到天源底稿（权证索引）' },
            h('div', { className: 'wb-hint' }, '把归档好的行驶证 / 登记证按车牌写进天源底稿「车辆」科目的「权证索引」列。天源没有开放上传接口，这里驱动本机 Chrome 真实操作：自动打开底稿页、拿编辑锁、逐份上传、最后一次性保存。两个 ID 在底稿网址里：/ty/operation/<项目ID>/<单位ID>/asset-based-approach/draft。'),
            h('div', { className: 'wb-grid' },
              h(Field, { label: '天源项目 ID' }, h(Inp, { value: tyPid, placeholder: '190537848061952', onChange: e => setTyPid(e.target.value.trim()) })),
              h(Field, { label: '被评估单位 ID' }, h(Inp, { value: tyCid, placeholder: '190537850159200', onChange: e => setTyCid(e.target.value.trim()) }))),
            h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap', alignItems: 'center' } },
              h(Btn, { onClick: () => startUpload(true), disabled: !!busy || upRunning }, busy === 'upload' ? '…' : '试运行（只比对）'),
              h(Btn, { variant: 'pri', onClick: () => startUpload(false), disabled: !!busy || upRunning || !records.length }, upRunning ? '上传中…' : '上传权证到天源'),
              h(Btn, { onClick: readDraft, disabled: !!busy }, busy === 'state' ? '读取中…' : '读取底稿现状'),
              h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px' } },
                h('input', { type: 'checkbox', checked: overwrite, onChange: e => setOverwrite(e.target.checked) }),
                '覆盖已挂的同名分类')),
            upJob ? h('div', { className: 'wb-hint', style: { marginTop: '8px' } },
              (upJob.message || '') + (upJob.subjectCode ? '（科目 ' + upJob.subjectCode + '）' : '')) : null,
            (upJob && ((upJob.uploaded || []).length || (upJob.skipped || []).length || (upJob.failed || []).length)) ? h(Table, {
              cols: ['车牌', '证件', '结果', '说明'],
              rows: [].concat(
                (upJob.uploaded || []).map((x, i) => h('tr', { key: 'u' + i },
                  h('td', null, x.plate || ''), h('td', null, x.type || ''),
                  h('td', null, upJob.dryRun ? '可上传' : '已上传'),
                  h('td', null, upJob.dryRun ? (x.wouldReplace ? '将覆盖已有附件' : '新增') : (String(x.batchId || '').slice(0, 8) + '…')))),
                (upJob.skipped || []).map((x, i) => h('tr', { key: 's' + i },
                  h('td', null, x.plate || ''), h('td', null, x.type || ''), h('td', null, '跳过'), h('td', null, x.reason || ''))),
                (upJob.failed || []).map((x, i) => h('tr', { key: 'f' + i },
                  h('td', null, x.plate || ''), h('td', null, x.type || ''), h('td', null, '失败'), h('td', null, x.error || '')))),
            }) : null,
            (upJob && (upJob.logs || []).length) ? h('div', { style: { maxHeight: '160px', overflow: 'auto', marginTop: '8px', fontSize: '12px', lineHeight: '1.6' } },
              upJob.logs.slice(-30).map((l, i) => h('div', { key: i }, l))) : null,
            draftState ? h('div', { style: { marginTop: '10px' } },
              h(Table, {
                cols: ['车牌', '权证索引', '已挂附件'],
                rows: (draftState.items || []).map((x, i) => h('tr', { key: 'd' + i },
                  h('td', null, x.plate || ''),
                  h('td', null, x.batch ? '已挂' : '空'),
                  h('td', null, (x.files || []).map(z => (z.type || '') + '：' + (z.name || '')).join('；') || '—'))),
              })) : null)));
    }

    function Work({ s, sub, toast, go }) {
      // 「打开哪个项目」放在 Work 这一层：本地项目列表点名字进项目界面，天源项目页点名字
      // 也要能进同一个界面（而不是跳去天源网页）。两页共用同一个 openId，切页签不丢。
      // 打开中的项目也持久化（store.settings.ui.openProjectId）：重开面板后仍在原项目界面。
      const uiOp = (s.settings.ui && s.settings.ui.openProjectId) || '';
      const setOpenProjectId = v => patch('settings', x => ({ ...x, ui: { ...(x.ui || {}), openProjectId: v ? String(v) : '' } }));
      const openProject = id => {
        if (!id) return;
        setOpenProjectId(String(id));
        go('work', 'projects');
      };
      return h('div', null,
        h('div', { className: 'wb-tabs' },
          [['projects', '本地项目'], ['logs', '工时管理'], ['tylive', '天源项目'], ['vehicle', '车辆评估'], ['ty', '连接设置']].map(([k, t]) => h('button', { key: k, className: 'wb-tab ' + (sub === k || (!sub && k === 'projects') ? 'on' : ''), onClick: () => go('work', k) }, t))),
        sub === 'logs' ? h(Timesheets, { s })
          : sub === 'vehicle' ? h(VehicleEval, { s, toast })
          : sub === 'ty' ? h(Tianyuan, { s, toast })
            : sub === 'tylive' ? h(TyProjects, { s, toast, go, onOpenProject: openProject })
              : h(Projects, { s, toast, go, openId: uiOp, setOpenId: setOpenProjectId }),
      );
    }

    /**
     * 排课引擎（纯函数，便于单独验证）
     *
     * 设计目标：
     * - 学时按「距考试天数」加权分配：越近的考试单位时间越优先，而不是按天轮换考试。
     * - 每天只安排一个主任务（多场考试按权重轮流占位），避免一天被切成碎片。
     * - 自动任务带 auto:true，重新生成时可以整体替换，手动任务永远保留。
     */
    function buildSchedule(study, options) {
      const opts = options || {};
      const weeks = Math.max(1, Math.min(12, Number(opts.weeks) || 4));
      const today = opts.today || todayStr();
      const exams = (study.exams || []).filter(e => e.active && e.examDate && dateDiff(e.examDate, today) >= 0);
      if (!exams.length) {
        return { error: '请先在「考试与报名提醒」里填写至少一项未过期考试的考试日期' };
      }

      const totalWeekly = exams.reduce((n, e) => n + (Number(e.hoursPerWeek) || 0), 0);
      if (totalWeekly <= 0) {
        return { error: '每周目标学时为 0，请先在下方为至少一项考试设置每周学时' };
      }
      // 每日预算：周学时×60/7，夹在 30–240 分钟，按 15 分钟取整
      const perDay = Math.max(30, Math.min(240, Math.round(totalWeekly * 60 / 7 / 15) * 15));

      // 权重：越接近考试权重越高（天数越少 → 1/(days+7)），保证临考科目优先。
      const weighted = exams.map(e => {
        const days = Math.max(0, dateDiff(e.examDate, today));
        return { exam: e, days, weight: 1 / (days / 30 + 1) };
      });
      const weightSum = weighted.reduce((n, x) => n + x.weight, 0);

      const items = [];
      const examCounters = {};
      for (let d = 0; d < weeks * 7; d++) {
        const day = new Date(new Date(today + 'T00:00:00').getTime() + d * 86400000);
        const ds = day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') + '-' + String(day.getDate()).padStart(2, '0');

        // 当天仍有效的考试（考试当天及之后不再排）
        const pool = weighted.filter(x => x.days >= d);
        if (!pool.length) break;

        // 按权重挑当天主科目：用累计配额做平滑分配，避免长期偏斜
        const poolSum = pool.reduce((n, x) => n + x.weight, 0);
        let pick = pool[0], best = -Infinity;
        pool.forEach(x => {
          const quota = x.weight / poolSum * d;          // 到第 d 天应累计分配的天数
          const used = examCounters[x.exam.id] || 0;
          const deficit = quota - used;                   // 缺口越大越优先
          if (deficit > best) { best = deficit; pick = x; }
        });
        examCounters[pick.exam.id] = (examCounters[pick.exam.id] || 0) + 1;

        const meta = EXAMS.find(x => x.id === pick.exam.id) || { short: pick.exam.id, subjects: ['备考'] };
        const subjects = meta.subjects && meta.subjects.length ? meta.subjects : ['备考'];
        const days = pick.days - d;

        // 阶段：越接近考试越偏真题与复盘
        const phase = days > 120 ? '基础章节学习' : days > 60 ? '强化刷题' : days > 20 ? '真题模考' : '冲刺复盘';
        // 同一阶段内按约 3:1 混排一个配套任务，避免整月只有一种类型（旧算法的老毛病）
        const seq = (examCounters[pick.exam.id] || 1) - 1;
        const alt = seq % 3 === 2;
        const type = phase === '基础章节学习' ? (alt ? '章节配套练习' : '章节学习')
          : phase === '强化刷题' ? (alt ? '错题复盘' : '刷题练习')
          : phase === '真题模考' ? (alt ? '错题复盘' : '真题模考')
          : (seq % 2 === 0 ? '真题模考' : '错题复盘');

        // 科目：按该考试已排次数轮转，长期覆盖到每个科目
        const subject = subjects[seq % subjects.length];

        items.push({
          id: uid(), examId: pick.exam.id, date: ds, subject,
          title: phase + ' · ' + meta.short + ' ' + subject,
          minutes: perDay, type, done: false, auto: true, phase,
        });
      }

      return { items, perDay, weeks, totalWeekly };
    }

    // ---------- study: exam config ----------
    function Exams({ s, toast }) {
      const [editing, setEditing] = useState(null);
      const setF = (id, k, v) => patch('study', st => ({ ...st, exams: st.exams.map(e => e.id === id ? { ...e, [k]: v, userEdited: true } : e) }));
      const meta = id => EXAMS.find(e => e.id === id) || {};
      return h(Section, { title: '考试与报名提醒' },
        h('p', { className: 'wb-hint', style: { marginTop: 0, marginBottom: 12 } }, '报名与考试日期请按当年官方公告填写（各地区可能不同）。开启提醒后，在报名开始/结束前 N 天及考试临近时会在「提醒中心」和浏览器通知中提示。'),
        h(Table, { cols: ['考试', '科目', '报名开始', '报名结束', '考试日期', '倒计时', '提前提醒', '状态', ''], rows: s.study.exams.map(e => {
          const m = meta(e.id);
          const regSoon = e.active && e.regStart && dateDiff(e.regStart, todayStr()) <= e.remindDays && dateDiff(e.regEnd || e.regStart, todayStr()) >= 0;
          const days = e.examDate ? dateDiff(e.examDate, todayStr()) : null;
          const conf = e.calSource || '';
          return h('tr', { key: e.id },
            h('td', null, h('b', null, m.name), h('div', { className: 'muted' }, m.note || m.short),
              conf && h('span', { className: 'wb-tag ' + (conf === 'confirmed' ? '' : 'grey'), style: { marginTop: 4 } }, conf === 'confirmed' ? '官方已公布' : conf === 'estimated' ? '按历年推算' : '待核实'),
              e.calUrl && h('a', { className: 'wb-link', href: e.calUrl, target: '_blank', rel: 'noopener', style: { marginLeft: 6, fontSize: 11 } }, '官网')),
            h('td', { className: 'muted', style: { fontSize: 11, maxWidth: 190 } }, m.subjects.join('、')),
            h('td', null, h(Inp, { type: 'date', value: e.regStart || '', style: { width: 130 }, onChange: ev => setF(e.id, 'regStart', ev.target.value) })),
            h('td', null, h(Inp, { type: 'date', value: e.regEnd || '', style: { width: 130 }, onChange: ev => setF(e.id, 'regEnd', ev.target.value) })),
            h('td', null, h(Inp, { type: 'date', value: e.examDate || '', style: { width: 130 }, onChange: ev => setF(e.id, 'examDate', ev.target.value) })),
            h('td', null, days == null ? '—' : h('span', { className: 'wb-tag ' + (days < 0 ? 'grey' : days <= 30 ? 'red' : days <= 90 ? 'warn' : '') }, days < 0 ? '已结束' : '还有 ' + days + ' 天')),
            h('td', null, h('select', { className: 'wb-select', value: e.remindDays, onChange: ev => setF(e.id, 'remindDays', Number(ev.target.value)) }, [1, 3, 7, 14, 30].map(d => h('option', { key: d, value: d }, d + ' 天')))),
            h('td', null, h('span', { className: 'wb-tag ' + (e.active ? '' : 'grey') }, e.active ? (regSoon ? '报名窗口临近' : '已开启') : '已关闭')),
            h('td', null, h(Btn, { className: 'sm', onClick: () => setF(e.id, 'active', !e.active) }, e.active ? '停用' : '启用')),
          );
        }) }),
      );
    }

    function PlanModal({ plan, exams, onClose, onSave }) {
      const [f, setF] = useState(plan || { examId: exams[0]?.id || 'cpv', date: todayStr(), title: '', minutes: 60, type: '章节学习' });
      const set = k => e => setF({ ...f, [k]: e.target.value });
      const exam = EXAMS.find(e => e.id === f.examId) || EXAMS[0];
      return h(Modal, { title: plan ? '编辑学习计划' : '新增学习计划', onClose },
        h('div', { className: 'wb-form' },
          h(Field, { label: '考试' }, h(Sel, { value: f.examId, onChange: set('examId') }, exams.map(e => h('option', { key: e.id, value: e.id }, (EXAMS.find(x => x.id === e.id) || {}).name)))),
          h(Field, { label: '日期' }, h(Inp, { type: 'date', value: f.date, onChange: set('date') })),
          h(Field, { label: '科目' }, h(Sel, { value: f.subject || exam.subjects[0], onChange: set('subject') }, exam.subjects.map(x => h('option', { key: x, value: x }, x)))),
          h(Field, { label: '时长（分钟）' }, h(Inp, { type: 'number', min: '0', step: '15', value: f.minutes, onChange: set('minutes') })),
          h(Field, { label: '任务类型' }, h(Sel, { value: f.type, onChange: set('type') }, ['章节学习', '刷题练习', '错题复盘', '真题模考', '串讲复习', '报名准备'].map(x => h('option', { key: x, value: x }, x)))),
          h(Field, { label: '任务内容 *', full: true }, h(Inp, { value: f.title, onChange: set('title'), placeholder: '如：收益法章节 + 课后 30 题' })),
        ),
        h('div', { className: 'wb-form-foot' }, h(Btn, { onClick: onClose }, '取消'), h(Btn, { variant: 'pri', onClick: () => { if (!f.title.trim()) { alert('请填写任务内容'); return; } onSave({ ...f, id: f.id || uid(), minutes: num(f.minutes) || 0, done: !!f.done, auto: false }); } }, '保存')),
      );
    }
    // ---------- study: plan board (date-grouped, scheduled by exam urgency) ----------
    function Plans({ s, toast }) {
      const [modal, setModal] = useState(null);
      const [filter, setFilter] = useState('all');
      const [weeks, setWeeks] = useState(4);
      const today = todayStr();
      const shortOf = id => (EXAMS.find(x => x.id === id) || {}).short || id;

      const all = s.study.plans;
      const scoped = all.filter(p => filter === 'all' || p.examId === filter);
      const sorted = scoped.slice().sort((a, b) => a.date.localeCompare(b.date) || String(a.title).localeCompare(String(b.title)));

      const save = p => patch('study', st => ({ ...st, plans: st.plans.some(x => x.id === p.id) ? st.plans.map(x => x.id === p.id ? p : x) : [p, ...st.plans] }));
      const remove = p => patch('study', st => ({ ...st, plans: st.plans.filter(x => x.id !== p.id) }));

      // 统计：只看筛选范围，按「到期未完成」判断逾期
      const done = sorted.filter(p => p.done).length;
      const overdue = sorted.filter(p => !p.done && p.date < today).length;
      const todayList = sorted.filter(p => p.date === today);
      const plannedMin = sorted.reduce((n, p) => n + (Number(p.minutes) || 0), 0);
      const doneMin = sorted.filter(p => p.done).reduce((n, p) => n + (Number(p.minutes) || 0), 0);
      const rate = sorted.length ? Math.round(done / sorted.length * 100) : 0;

      const generate = () => {
        const gen = buildSchedule(s.study, { weeks, today });
        if (gen.error) { alert(gen.error); return; }
        // 手动任务永远保留；自动任务整体重建
        const manual = s.study.plans.filter(p => !p.auto);
        const manualKeys = new Set(manual.map(p => p.date + '|' + p.examId));
        const created = gen.items.filter(c => !manualKeys.has(c.date + '|' + c.examId));
        const skipped = gen.items.length - created.length;
        patch('study', st => ({ ...st, plans: [...manual, ...created] }));
        if (toast) toast('已生成 ' + created.length + ' 条 · 每天约 ' + gen.perDay + ' 分钟 · ' + gen.weeks + ' 周' + (skipped ? ' · 跳过 ' + skipped + ' 条与手动任务冲突的' : ''), 'ok');
      };
      const clearAuto = () => {
        const n = s.study.plans.filter(p => p.auto).length;
        if (!n) { toast('当前没有自动生成的任务', 'warn'); return; }
        if (!confirm('清除 ' + n + ' 条自动生成的任务？手动创建的任务会保留。')) return;
        patch('study', st => ({ ...st, plans: st.plans.filter(p => !p.auto) }));
        toast('已清除 ' + n + ' 条自动任务', 'ok');
      };
      const clearDone = () => {
        const n = all.filter(p => p.done).length;
        if (!n) { toast('没有已完成的任务', 'warn'); return; }
        if (!confirm('清除 ' + n + ' 条已完成的任务？')) return;
        patch('study', st => ({ ...st, plans: st.plans.filter(p => !p.done) }));
        toast('已清除 ' + n + ' 条已完成任务', 'ok');
      };
      const markAllToday = () => {
        if (!todayList.length) { toast('今天没有任务', 'warn'); return; }
        const ids = new Set(todayList.map(p => p.id));
        patch('study', st => ({ ...st, plans: st.plans.map(p => ids.has(p.id) ? { ...p, done: true } : p) }));
        toast('已把今天 ' + ids.size + ' 条任务标记完成', 'ok');
      };

      // 按日期分组，今天与逾期排在最前（逾期内部仍按日期升序）
      const groups = [];
      const byDate = {};
      sorted.forEach(p => { (byDate[p.date] = byDate[p.date] || []).push(p); });
      const dates = Object.keys(byDate).sort();
      dates.forEach(d => groups.push({ date: d, items: byDate[d] }));
      const pinned = groups.filter(g => g.date <= today);
      const upcoming = groups.filter(g => g.date > today);

      const dayRow = g => {
        const isToday = g.date === today;
        const isPast = g.date < today;
        const dDone = g.items.filter(p => p.done).length;
        const dMin = g.items.reduce((n, p) => n + (Number(p.minutes) || 0), 0);
        const allDone = dDone === g.items.length;
        return h('div', { key: g.date, className: 'wb-sec', style: { marginBottom: 10 } },
          h('div', { className: 'wb-row', style: { justifyContent: 'space-between', marginBottom: 8 } },
            h('div', { className: 'wb-row', style: { gap: 6 } },
              h('strong', { style: { fontSize: 13 } }, g.date),
              h('span', { className: 'wb-hint' }, ['日', '一', '二', '三', '四', '五', '六'][new Date(g.date + 'T00:00:00').getDay()]),
              isToday && h('span', { className: 'wb-tag' }, '今天'),
              isPast && !allDone && h('span', { className: 'wb-tag red' }, '逾期'),
              allDone && h('span', { className: 'wb-tag grey' }, '已完成'),
            ),
            h('span', { className: 'wb-hint' }, dMin + ' min · ' + dDone + '/' + g.items.length),
          ),
          g.items.map(p => h('div', { key: p.id, className: 'wb-alert' + (p.done ? '' : isPast ? ' danger' : '') },
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { className: 't', style: { fontWeight: p.done ? 400 : 600 } }, esc(p.title)),
              h('div', { className: 'b' },
                esc(shortOf(p.examId)) + ' · ' + esc(p.subject || '未指定科目') + ' · ' + (Number(p.minutes) || 0) + ' 分钟',
                p.auto ? ' · 自动' : ' · 手动'),
            ),
            h('div', { className: 'wb-row', style: { flexWrap: 'nowrap', gap: 6 } },
              h(Btn, { className: 'sm', variant: p.done ? 'pri' : '', onClick: () => save({ ...p, done: !p.done }) }, p.done ? '已完成' : '完成'),
              h(Btn, { className: 'sm', onClick: () => setModal(p) }, '编辑'),
              h(Btn, { className: 'sm danger', onClick: () => remove(p) }, '删除'),
            ),
          )),
        );
      };

      return h('div', null,
        h(Section, { title: '学习规划', actions: h('div', { className: 'wb-row' },
          h(Sel, { value: filter, onChange: e => setFilter(e.target.value) }, h('option', { value: 'all' }, '全部考试'), s.study.exams.map(e => h('option', { key: e.id, value: e.id }, (EXAMS.find(x => x.id === e.id) || {}).name))),
          h(Btn, { variant: 'pri', onClick: () => setModal({}) }, '+ 新增任务')) },
          h('div', { className: 'wb-grid', style: { gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' } },
            h(Card, null, h('div', { className: 'wb-kpi', style: { fontSize: 22 } }, sorted.length), h('div', { className: 'wb-kpi-sub' }, '任务总数')),
            h(Card, null, h('div', { className: 'wb-kpi', style: { fontSize: 22 } }, rate + '%'), h('div', { className: 'wb-kpi-sub' }, '完成率 · ' + done + '/' + sorted.length)),
            h(Card, null, h('div', { className: 'wb-kpi', style: { fontSize: 22, color: overdue ? 'var(--dsw-alias-state-error-primary,#c0392b)' : undefined } }, overdue), h('div', { className: 'wb-kpi-sub' }, overdue ? '逾期未完成' : '无逾期任务')),
            h(Card, null, h('div', { className: 'wb-kpi', style: { fontSize: 22 } }, todayList.filter(p => !p.done).length), h('div', { className: 'wb-kpi-sub' }, '今日待办 · 共 ' + todayList.length + ' 条')),
            h(Card, null, h('div', { className: 'wb-kpi', style: { fontSize: 22 } }, (doneMin / 60).toFixed(1) + ' h'), h('div', { className: 'wb-kpi-sub' }, '已投入 · 计划 ' + (plannedMin / 60).toFixed(1) + ' h')),
          ),
          h('div', { className: 'wb-bar', style: { marginBottom: 14 } }, h('i', { style: { width: rate + '%' } })),
          h('p', { className: 'wb-hint', style: { marginTop: 0 } },
            '排课按「考试紧迫度」加权：越接近考期的考试分到越多天数，而不是按天轮流切换考试；阶段随剩余天数推进（>120 天基础章节、60–120 天强化刷题、20–60 天真题模考、<20 天冲刺复盘），同阶段内约每 3 天混排一次配套任务。自动任务可整体重建，手动任务始终保留。'),
          h('div', { className: 'wb-row', style: { marginBottom: 14 } },
            h('span', { className: 'wb-hint' }, '生成周数'), h(Inp, { type: 'number', min: '1', max: '12', value: weeks, style: { width: 64 }, onChange: e => setWeeks(Number(e.target.value) || 4) }),
            h(Btn, { onClick: generate }, '生成排课'), h(Btn, { onClick: clearAuto }, '清除自动任务'), h(Btn, { onClick: clearDone }, '清除已完成'),
            h(Btn, { onClick: markAllToday }, '今日全部完成'),
          ),
          !sorted.length ? Empty('还没有学习计划。设置每周学时后点「生成排课」，或手动新增任务。') :
            h('div', null,
              pinned.length ? h('div', { style: { marginBottom: 18 } }, h('div', { className: 'wb-hint', style: { marginBottom: 8, fontWeight: 600 } }, '今天与逾期'), pinned.map(dayRow)) : null,
              upcoming.length ? h('div', null, h('div', { className: 'wb-hint', style: { marginBottom: 8, fontWeight: 600 } }, '后续安排'), upcoming.map(dayRow)) : null,
            ),
          h('div', { className: 'wb-row', style: { marginTop: 14 } }, h('span', { className: 'wb-hint' }, '每周目标学时：'), s.study.exams.filter(e => e.active).map(e => h('span', { key: e.id, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, shortOf(e.id), h(Inp, { type: 'number', min: '0', max: '60', value: e.hoursPerWeek, style: { width: 56 }, onChange: ev => patch('study', st => ({ ...st, exams: st.exams.map(x => x.id === e.id ? { ...x, hoursPerWeek: Number(ev.target.value) } : x) })) }), 'h'))),
        ),
        modal && h(PlanModal, { plan: modal.id ? modal : null, exams: s.study.exams, onClose: () => setModal(null), onSave: p => { save(p); setModal(null); } }),
      );
    }

    function Study({ s, sub, toast, go }) {
      return h('div', null,
        h('div', { className: 'wb-tabs' }, [['plans', '学习规划'], ['exams', '考试与报名提醒']].map(([k, t]) => h('button', { key: k, className: 'wb-tab ' + (sub === k ? 'on' : ''), onClick: () => go('study', k) }, t))),
        sub === 'exams' ? h(Exams, { s, toast }) : h(Plans, { s, toast }),
      );
    }

    // ---------- stock ----------
    // 股票页：自选股行情表（照参考截图 20 列）+ 本地日线库 + 指标分析。
    // 行情仍走宿主 /quotes（腾讯 qt.gtimg.cn）；日线与指标走独立 bundle
    // @local/dsh-workbench-stock 的 /api/workbench/stock/*（Python worker + SQLite）。
    const STOCK_API = PREFIX + '/stock';
    const STOCK_SOURCES = [
      ['akshare', 'AKShare'],
      ['tushare', 'Tushare · tushareMcp'],
      ['baostock', 'Baostock'],
      ['efinance', 'efinance'],
      ['tencent', '腾讯行情'],
    ];
    const STOCK_RANGES = [[60, '60 根'], [120, '120 根'], [250, '250 根'], [0, '全部']];
    const CHART_DAYS = 1600;   // 图表一次取最近约 6.3 年，缩放/平移都在这段里
    const STOCK_CSS = [
      ".wb-stock-wrap{overflow:auto;border:1px solid var(--dsw-alias-border-l1,#e3e6e8);border-radius:8px;max-height:calc(100vh - 340px)}",
      ".wb-stock-table{width:100%;border-collapse:collapse;font-size:11.5px;min-width:1500px}",
      ".wb-stock-table th{position:sticky;top:0;z-index:1;background:var(--wb-surface-2,#f7f9fb);text-align:left;font-weight:600;color:var(--dsw-alias-label-secondary,#666);padding:7px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,#e3e6e8);white-space:nowrap}",
      ".wb-stock-table td{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,#eef0f1);white-space:nowrap;vertical-align:middle}",
      ".wb-stock-table tr:last-child td{border-bottom:0}",
      ".wb-stock-table tr.sel td{background:rgba(29,78,216,.07)}",
      ".wb-stock-table tbody tr:hover td{background:rgba(29,78,216,.04)}",
      ".wb-stock-table th.n,.wb-stock-table td.n{text-align:right;font-variant-numeric:tabular-nums}",
      ".wb-stock-table td.num{font-family:Consolas,Menlo,monospace;font-size:11.5px}",
      ".wb-sname{cursor:pointer;font-weight:600;color:var(--dsw-alias-label-primary,#1a1a1a)}",
      ".wb-sname:hover{color:var(--wb-accent);text-decoration:underline}",
      ".wb-scode{font-size:10.5px;color:var(--dsw-alias-label-secondary,#888);font-family:Consolas,monospace}",
      ".wb-ico{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;margin-right:2px;border:1px solid var(--dsw-alias-border-l1,#d8dcde);background:transparent;border-radius:4px;cursor:pointer;font-size:11px;line-height:1;color:var(--dsw-alias-label-secondary,#666);font-family:inherit}",
      ".wb-ico:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f4f5);color:var(--wb-accent);border-color:var(--wb-accent)}",
      ".wb-ico.danger:hover{color:#b63225;border-color:#b63225}",
      ".wb-tag.green{background:#e8f6ee;color:#1b8a5a}",
      "body[data-ds-dark-theme] .wb-tag.green{background:#1b3427;color:#5ee08c}",
      ".wb-sig-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:8px;margin:10px 0 2px}",
      ".wb-sig{border:1px solid var(--dsw-alias-border-l1,#e8ebed);border-radius:8px;padding:8px 10px;background:var(--wb-surface-2,#fafbfc);font-size:11.5px;min-width:0}",
      ".wb-sig b{display:block;font-size:14px;margin:3px 0 1px;font-variant-numeric:tabular-nums}",
      ".wb-sig .n{color:var(--dsw-alias-label-secondary,#888);font-size:10.5px;line-height:1.35;white-space:normal}",
      ".wb-chart{display:block;width:100%;height:auto;min-height:220px}",
      ".wb-chart text{fill:var(--dsw-alias-label-secondary,#888);font-size:10px;font-family:Consolas,monospace}",
      ".wb-chart .grid{stroke:var(--dsw-alias-border-l1,#eef0f1);stroke-width:1}",
      ".wb-chart .k-up{stroke:#c0392b;fill:#c0392b}",
      ".wb-chart .k-down{stroke:#1b8a5a;fill:#1b8a5a}",
      ".wb-chart .ma5{stroke:#f59e0b;fill:none;stroke-width:1.2}",
      ".wb-chart .ma20{stroke:#2563eb;fill:none;stroke-width:1.2}",
      ".wb-chart .ma60{stroke:#8b5cf6;fill:none;stroke-width:1.2}",
      ".wb-chart .legend{font-size:10.5px}",
      ".wb-chart .td{font-size:9px;font-weight:600;pointer-events:none}",
      ".wb-chart .td-buy{fill:#1b8a5a}",
      ".wb-chart .td-sell{fill:#c0392b}",
      "body[data-ds-dark-theme] .wb-chart .k-up{stroke:#ff7b72;fill:#ff7b72}",
      "body[data-ds-dark-theme] .wb-chart .k-down{stroke:#4ed17e;fill:#4ed17e}",
      "body[data-ds-dark-theme] .wb-chart .grid{stroke:#333335}",
      "body[data-ds-dark-theme] .wb-chart .td-buy{fill:#4ed17e}",
      "body[data-ds-dark-theme] .wb-chart .td-sell{fill:#ff7b72}",
      ".wb-kpi-line{display:flex;gap:10px;flex-wrap:wrap;align-items:baseline}",
      ".wb-kpi-line .k{font-size:12px;color:var(--dsw-alias-label-secondary,#666)}",
      ".wb-kpi-line .v{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;margin-right:10px}",
    ].join('\n');

    const sNum = (v, d = 2) => (v == null || v === '' || !Number.isFinite(Number(v))) ? '—' : Number(v).toFixed(d);
    const sInt = v => (v == null || v === '' || !Number.isFinite(Number(v))) ? '—' : Math.round(Number(v)).toLocaleString('zh-CN');
    const sBig = (v, unit) => {
      if (v == null || v === '' || !Number.isFinite(Number(v))) return '—';
      const n = Number(v), a = Math.abs(n);
      if (a >= 1e8) return (n / 1e8).toFixed(2) + '亿' + (unit || '');
      if (a >= 1e4) return (n / 1e4).toFixed(2) + '万' + (unit || '');
      return n.toFixed(2) + (unit || '');
    };
    const sWan = v => {
      if (v == null || v === '' || !Number.isFinite(Number(v))) return '—';
      const n = Number(v);
      return Math.abs(n) >= 1e4 ? (n / 1e4).toFixed(2) + '亿' : n.toFixed(2) + '万';
    };
    const sPct = v => (v == null || !Number.isFinite(Number(v))) ? '—' : Number(v).toFixed(2) + '%';
    const sBytes = v => {
      const n = Number(v) || 0;
      if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
      if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
      return n + ' B';
    };
    const sSign = (v, d = 2) => (v == null || !Number.isFinite(Number(v))) ? '—' : (Number(v) > 0 ? '+' : '') + Number(v).toFixed(d);
    const sCls = v => (v == null || !Number.isFinite(Number(v))) ? '' : (Number(v) > 0 ? 'wb-up' : Number(v) < 0 ? 'wb-down' : '');
    const sSignalCls = st => st === 'bull' ? 'red' : st === 'bear' ? 'green' : 'grey';
    const quoteTime = t => {
      const s = String(t || '');
      if (/^\d{14}$/.test(s)) return s.slice(8, 10) + ':' + s.slice(10, 12) + ':' + s.slice(12, 14);
      if (/^\d{12}$/.test(s)) return s.slice(8, 10) + ':' + s.slice(10, 12);
      return s;
    };

    async function stockGet(path) {
      const r = await fetch(STOCK_API + path, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
      return j;
    }
    async function stockPost(path, body) {
      const r = await fetch(STOCK_API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
      return j;
    }

    function KlineChart({ rows, view, onView, onReset }) {
      if (!rows || !rows.length) return null;
      const total = rows.length;
      const cur = view && view.count ? view : { start: 0, count: total };
      const start = Math.max(0, Math.min(cur.start, Math.max(0, total - 1)));
      const count = Math.max(1, Math.min(cur.count, total - start));
      const data = rows.slice(start, start + count);
      const W = 1000, H = 330, PL = 8, PR = 58, PT = 10;
      const priceH = 214, volH = 48, gapY = 12;
      const volTop = PT + priceH + gapY;
      const n = data.length;
      const step = (W - PL - PR) / Math.max(1, n);
      const bw = Math.max(1, step * 0.6);
      let hi = -Infinity, lo = Infinity;
      data.forEach(r => [r.high, r.low, r.ma5, r.ma20, r.ma60].forEach(v => {
        if (v != null && Number.isFinite(Number(v))) { hi = Math.max(hi, Number(v)); lo = Math.min(lo, Number(v)); }
      }));
      if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
      const pad = (hi - lo) * 0.06 || 1;
      hi += pad; lo -= pad;
      const x = i => PL + i * step + step / 2;
      const y = v => PT + (hi - v) / (hi - lo) * priceH;
      let vmax = 0;
      data.forEach(r => { if (Number(r.volume) > vmax) vmax = Number(r.volume); });
      const yv = v => volTop + volH - (v / (vmax || 1)) * volH;
      const segs = key => {
        const out = []; let seg = [];
        data.forEach((r, i) => {
          if (r[key] == null) { if (seg.length > 1) out.push(seg); seg = []; }
          else seg.push(x(i) + ',' + y(Number(r[key])));
        });
        if (seg.length > 1) out.push(seg);
        return out;
      };
      const gridVals = [0, 0.25, 0.5, 0.75, 1].map(f => hi - f * (hi - lo));
      const first = data[0], last = data[n - 1];
      const svgRef = useRef(null);
      const live = useRef(null);
      live.current = { total, start, count, onView };
      useEffect(() => {
        const el = svgRef.current;
        if (!el) return;
        // Ctrl + 滚轮才缩放（触控板双指捏合同样会带 ctrlKey）；普通滚轮让页面正常滚动
        const onWheel = e => {
          if (!e.ctrlKey && !e.metaKey) return;
          const L = live.current;
          if (!L || !L.onView || L.total <= 20) return;
          e.preventDefault();
          const rect = el.getBoundingClientRect();
          const plotL = rect.left + rect.width * (PL / W);
          const plotW = rect.width * ((W - PL - PR) / W) || 1;
          const px = Math.max(0, Math.min(1, (e.clientX - plotL) / plotW));
          const anchor = L.start + px * L.count;
          const factor = e.deltaY > 0 ? 1.25 : 0.8;
          let nc = Math.max(20, Math.min(L.total, Math.round(L.count * factor)));
          if (nc === L.count) return;
          let ns = Math.round(anchor - px * nc);
          ns = Math.max(0, Math.min(L.total - nc, ns));
          L.onView({ start: ns, count: nc });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
      }, []);
      const drag = useRef(null);
      const onPointerDown = e => {
        if (count >= total) return;
        drag.current = { x: e.clientX, start };
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      };
      const onPointerMove = e => {
        if (!drag.current) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const plotW = rect.width * ((W - PL - PR) / W) || 1;
        const bars = Math.round(-(e.clientX - drag.current.x) / plotW * count);
        const ns = Math.max(0, Math.min(total - count, drag.current.start + bars));
        if (ns !== start && onView) onView({ start: ns, count });
      };
      const onPointerUp = e => {
        drag.current = null;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      };
      return h('svg', {
        ref: svgRef,
        className: 'wb-chart',
        viewBox: '0 0 ' + W + ' ' + H,
        role: 'img',
        'aria-label': '日K线与均线，可滚轮缩放、拖动平移',
        style: { maxWidth: 1180, margin: '0 auto', cursor: count < total ? 'grab' : 'default', touchAction: 'none' },
        onPointerDown, onPointerMove, onPointerUp, onPointerLeave: onPointerUp,
        onDoubleClick: () => onReset && onReset(),
      },
        gridVals.map((v, i) => h('g', { key: 'g' + i },
          h('line', { className: 'grid', x1: PL, x2: W - PR, y1: y(v), y2: y(v) }),
          h('text', { x: W - PR + 6, y: y(v) + 3 }, v.toFixed(2)))),
        h('line', { className: 'grid', x1: PL, x2: W - PR, y1: volTop + volH, y2: volTop + volH }),
        h('text', { x: W - PR + 6, y: volTop + 10 }, '量 ' + sBig(vmax, '手')),
        data.map((r, i) => {
          if (r.open == null || r.close == null) return null;
          const up = Number(r.close) >= Number(r.open);
          const cls = up ? 'k-up' : 'k-down';
          const cx = x(i);
          const top = Math.min(y(Number(r.open)), y(Number(r.close)));
          const bh = Math.max(1, Math.abs(y(Number(r.open)) - y(Number(r.close))));
          const bN = Number(r.buyCount) || 0, sN = Number(r.sellCount) || 0;
          const bShow = bN > 0 && (bN < 9 || r.buySignal);
          const sShow = sN > 0 && (sN < 9 || r.sellSignal);
          return h('g', { key: 'c' + i },
            h('line', { className: cls, x1: cx, x2: cx, y1: y(Number(r.high)), y2: y(Number(r.low)), strokeWidth: 1 }),
            h('rect', { className: cls, x: cx - bw / 2, y: top, width: bw, height: bh, opacity: 0.92 }),
            h('rect', { className: cls, x: cx - bw / 2, y: yv(Number(r.volume) || 0), width: bw, height: Math.max(1, volTop + volH - yv(Number(r.volume) || 0)), opacity: 0.55 }),
            bShow ? h('text', { key: 'tb', className: 'td td-buy', x: cx, y: Math.min(PT + priceH - 2, y(Number(r.low)) + 11), textAnchor: 'middle' }, String(bN)) : null,
            sShow ? h('text', { key: 'ts', className: 'td td-sell', x: cx, y: Math.max(PT + 9, y(Number(r.high)) - 4), textAnchor: 'middle' }, String(sN)) : null);
        }),
        ['ma5', 'ma20', 'ma60'].map(k => segs(k).map((pts, i) =>
          h('polyline', { key: k + i, className: k, points: pts.join(' ') }))),
        h('text', { x: PL, y: H - 4 }, first.date),
        h('text', { x: W - PR, y: H - 4, textAnchor: 'end' }, last.date),
        h('g', { transform: 'translate(' + (PL + 4) + ',18)' },
          h('text', { className: 'legend', x: 0, y: 0, style: { fill: '#f59e0b' } }, 'MA5'),
          h('text', { className: 'legend', x: 40, y: 0, style: { fill: '#2563eb' } }, 'MA20'),
          h('text', { className: 'legend', x: 86, y: 0, style: { fill: '#8b5cf6' } }, 'MA60')));
    }

    function SignalGrid({ analysis }) {
      const sig = analysis.signals || [];
      if (!sig.length) return null;
      return h('div', { className: 'wb-sig-grid' }, sig.map((x, i) => h('div', { key: i, className: 'wb-sig' },
        h('span', { className: 'wb-tag ' + sSignalCls(x.state) }, x.name),
        h('b', { className: sCls(x.state === 'bull' ? 1 : x.state === 'bear' ? -1 : 0) }, String(x.value)),
        h('div', { className: 'n' }, x.note))));
    }

    function IndicatorTable({ rows }) {
      if (!rows || !rows.length) return Empty('还没有指标数据，先下载日线');
      const cols = ['日期', '收盘', 'MA5', 'MA10', 'MA20', 'MA60', 'DIF', 'DEA', 'MACD', 'K', 'D', 'J', 'RSI6', 'RSI12', '布林上', '布林中', '布林下'];
      return h('div', { style: { overflowX: 'auto' } },
        h('table', { className: 'wb-table' },
          h('thead', null, h('tr', null, cols.map((c, i) => h('th', { key: i, style: i ? { textAlign: 'right' } : null }, c)))),
          h('tbody', null, rows.slice().reverse().map(r => h('tr', { key: r.date },
            h('td', null, r.date),
            h('td', { style: { textAlign: 'right' } }, sNum(r.close)),
            h('td', { style: { textAlign: 'right' } }, sNum(r.ma5)),
            h('td', { style: { textAlign: 'right' } }, sNum(r.ma10)),
            h('td', { style: { textAlign: 'right' } }, sNum(r.ma20)),
            h('td', { style: { textAlign: 'right' } }, sNum(r.ma60)),
            h('td', { style: { textAlign: 'right' } }, sNum(r.dif, 3)),
            h('td', { style: { textAlign: 'right' } }, sNum(r.dea, 3)),
            h('td', { style: { textAlign: 'right', color: r.macd >= 0 ? 'var(--wb-danger-ink)' : 'var(--wb-ok-ink)' } }, sNum(r.macd, 3)),
            h('td', { style: { textAlign: 'right' } }, sNum(r.k, 1)),
            h('td', { style: { textAlign: 'right' } }, sNum(r.d, 1)),
            h('td', { style: { textAlign: 'right' } }, sNum(r.j, 1)),
            h('td', { style: { textAlign: 'right' } }, sNum(r.rsi6, 1)),
            h('td', { style: { textAlign: 'right' } }, sNum(r.rsi12, 1)),
            h('td', { style: { textAlign: 'right' } }, sNum(r.bollUp)),
            h('td', { style: { textAlign: 'right' } }, sNum(r.bollMid)),
            h('td', { style: { textAlign: 'right' } }, sNum(r.bollLow)))))));
    }

    function HoldingsModal({ item, onClose, onSave }) {
      const [f, setF] = useState({ cost: item.cost || '', shares: item.shares || '' });
      const set = k => e => setF({ ...f, [k]: e.target.value });
      const cost = Number(f.cost) || 0, shares = Number(f.shares) || 0;
      return h(Modal, { title: '持仓成本 · ' + item.name + ' (' + item.code + ')', onClose },
        h('div', { className: 'wb-form' },
          h(Field, { label: '成本价（元）' }, h(Inp, { type: 'number', step: '0.001', min: '0', value: f.cost, onChange: set('cost'), placeholder: '如 1500.5' })),
          h(Field, { label: '持有量（股）' }, h(Inp, { type: 'number', step: '100', min: '0', value: f.shares, onChange: set('shares'), placeholder: '如 1000' }))),
        h('p', { className: 'wb-hint' }, '总成本 ' + money(cost * shares) + ' 元。用于表里的总成本 / 总现值 / 盈亏；行情按最新价实时算。留空或 0 表示不统计。'),
        h('div', { className: 'wb-form-foot' }, h(Btn, { onClick: onClose }, '取消'),
          h(Btn, { variant: 'pri', onClick: () => onSave({ ...item, cost, shares }) }, '保存')));
    }

    function Stock({ s, toast, refresh }) {
      const sk = s.stock;
      const [kw, setKw] = useState('');
      const [results, setResults] = useState([]);
      const [searching, setSearching] = useState(false);
      const [modal, setModal] = useState(null);
      const [hold, setHold] = useState(null);
      const [source, setSource] = useState(() => { try { return localStorage.getItem('dsh-wb-stock-source') || 'akshare'; } catch (e) { return 'akshare'; } });
      const [status, setStatus] = useState(null);
      const [dbInfo, setDbInfo] = useState(null);
      const [job, setJob] = useState(null);
      const [selected, setSelected] = useState(sk.watch[0] ? sk.watch[0].code : '');
      const [analysis, setAnalysis] = useState(null);
      const [anaBusy, setAnaBusy] = useState(false);
      const [range, setRange] = useState(120);
      const [view, setView] = useState({ start: 0, count: 0 });
      const [busy, setBusy] = useState(false);
      const [nineTurn, setNineTurn] = useState(null);
      const [nineBusy, setNineBusy] = useState(false);
      const [dragId, setDragId] = useState(null);
      const [overId, setOverId] = useState(null);
      const [overAfter, setOverAfter] = useState(false);
      const [years, setYears] = useState(6);
      const pushed = useRef('');
      const lastSync = useRef('');

      const loadStatus = async () => {
        try { setStatus(await stockGet('/status')); }
        catch (e) { setStatus({ ok: false, error: (e && e.message) || String(e) }); }
      };
      const loadDb = async () => {
        try { setDbInfo(await stockGet('/db')); } catch (e) { setDbInfo({ error: (e && e.message) || String(e) }); }
      };
      const loadAnalysis = useCallback(async (code, days) => {
        if (!code) return;
        setAnaBusy(true);
        try { setAnalysis(await stockGet('/analysis?code=' + encodeURIComponent(code) + '&days=' + days)); }
        catch (e) { setAnalysis({ ok: false, error: (e && e.message) || String(e) }); }
        finally { setAnaBusy(false); }
      }, []);

      useEffect(() => { loadStatus(); loadDb(); }, []);
      useEffect(() => { if (!selected && sk.watch.length) setSelected(sk.watch[0].code); }, [sk.watch.length]);
      useEffect(() => {
        if (selected && !sk.watch.some(x => x.code === selected)) setSelected(sk.watch[0] ? sk.watch[0].code : '');
      }, [sk.watch.length]);
      useEffect(() => { if (selected) loadAnalysis(selected, CHART_DAYS); }, [selected]);
      const nBars = analysis && analysis.chart ? analysis.chart.length : 0;
      useEffect(() => {
        if (!nBars) { setView({ start: 0, count: 0 }); return; }
        const count = range === 0 ? nBars : Math.min(range, nBars);
        setView({ start: Math.max(0, nBars - count), count });
      }, [analysis && analysis.code, nBars, range]);
      const zoomBy = f => {
        if (!nBars) return;
        const cur = view.count || nBars;
        let nc = Math.max(20, Math.min(nBars, Math.round(cur * f)));
        if (nc === cur) return;
        const center = view.start + cur / 2;
        let ns = Math.round(center - nc / 2);
        ns = Math.max(0, Math.min(nBars - nc, ns));
        setView({ start: ns, count: nc });
      };
      const resetView = () => {
        if (!nBars) return;
        const count = range === 0 ? nBars : Math.min(range, nBars);
        setView({ start: Math.max(0, nBars - count), count });
      };
      const vcount = view.count || nBars;

      // 自选股落库（去抖）：工作台状态仍是界面主数据，库是给「下载/分析/查询」用的副本
      const watchKey = JSON.stringify(sk.watch.map(x => [x.code, x.name, x.cost, x.shares]));
      useEffect(() => {
        if (watchKey === pushed.current) return;
        const t = setTimeout(async () => {
          try {
            // purgeMissing：让 worker 把「已不在自选」的股票日线一并清掉（服务端还要求列表非空）
            await stockPost('/watchlist', { purgeMissing: true, items: sk.watch.map(x => ({ code: x.code, name: x.name, market: x.market, cost: Number(x.cost) || 0, shares: Number(x.shares) || 0, note: x.note || '' })) });
            pushed.current = watchKey;
          } catch (e) { /* 宿主未加载股票 bundle 时静默，不打扰界面 */ }
        }, 700);
        return () => clearTimeout(t);
      }, [watchKey]);

      // 神奇九转：读库 + 实时价（宿主侧补当日临时收盘）批量计算
      const loadNineTurn = useCallback(async () => {
        if (!sk.watch.length) { setNineTurn(null); return null; }
        setNineBusy(true);
        try {
          const j = await stockGet('/nine-turn?codes=' + encodeURIComponent(sk.watch.map(x => x.code).join(',')));
          setNineTurn(j);
          return j;
        } catch (e) {
          setNineTurn({ ok: false, error: (e && e.message) || String(e) });
          return null;
        } finally { setNineBusy(false); }
      }, [watchKey]);
      useEffect(() => { loadNineTurn(); }, [loadNineTurn]);

      // 每日 13:00（中午 1 点）按九转提示买卖；页面没开着时，下次打开补一次当天提示
      useEffect(() => {
        if (!sk.watch.length || sk.nineTurnEnabled === false) return;
        let alive = true;
        const run = async () => {
          const now = new Date();
          if (now.getHours() < 13) return;
          const day = todayStr();
          const key = 'dsh-workbench:nine-turn:' + day;
          try { if (localStorage.getItem(key)) return; } catch (e) { /* 隐私模式 */ }
          const j = await loadNineTurn();
          if (!alive || !j || j.ok === false) return;   // 接口失败：下一分钟重试
          try { localStorage.setItem(key, '1'); } catch (e) { /* 忽略 */ }
          if (!j.tradingDay) return;
          const fired = [];
          (j.items || []).filter(x => (x.buy || x.sell) && x.date === day).forEach(x => {
            const isBuy = !!x.buy;
            const bull = x.bullCount || 0, bear = x.bearCount || 0;
            const names = (x.signals || []).filter(s => s.state === (isBuy ? 'bull' : 'bear')).map(s => s.name);
            const title = (x.name || x.code) + (isBuy ? ' · 多项指标偏多（买入提示）' : ' · 多项指标偏空（卖出提示）');
            const body = '看多 ' + bull + ' 项 / 看空 ' + bear + ' 项：' + (names.join('、') || '—')
              + '。现价 ' + fmt(x.close) + '（13:00 按最新价预演，仅供参考）。';
            const before = store.get().alerts.length;
            store.set(st => addAlert(st, 'multi|' + x.code + '|' + x.date + '|' + (isBuy ? 'buy' : 'sell'), title, body, isBuy ? 'info' : 'warn'));
            if (store.get().alerts.length > before) fired.push(x.name || x.code);
          });
          if (fired.length) {
            toast('多项指标：' + fired.join('、') + ' 触发买卖提示', 'warn');
            fired.forEach(n => browserNotify('个人工作台 · 多项指标', n));
          }
        };
        run();
        const iv = setInterval(run, 60000);
        return () => { alive = false; clearInterval(iv); };
      }, [loadNineTurn, sk.nineTurnEnabled, watchKey]);

      // 任务轮询
      useEffect(() => {
        if (!job || job.status !== 'running') return;
        let alive = true;
        const t = setInterval(async () => {
          try {
            const j = await stockGet('/job?job=' + encodeURIComponent(job.id));
            if (!alive) return;
            setJob(j.job);
            if (j.job && j.job.status !== 'running') {
              clearInterval(t);
              lastSync.current = new Date().toISOString();
              toast(j.job.message || ('同步完成：成功 ' + j.job.ok + ' / 失败 ' + j.job.fail), j.job.fail ? 'warn' : 'ok');
              loadDb();
              if (selected) loadAnalysis(selected, CHART_DAYS);
              loadNineTurn();
            }
          } catch (e) { /* 下一轮再试 */ }
        }, 900);
        return () => { alive = false; clearInterval(t); };
      }, [job && job.id, job && job.status, selected, range]);

      const doSearch = async () => {
        const q = kw.trim();
        if (!q) return;
        setSearching(true);
        let list = [];
        try {
          const proxy = await fetch('/api/workbench/search?q=' + encodeURIComponent(q));
          if (proxy.ok) list = await proxy.json();
        } catch (e) { /* 宿主搜索不可用时走本地 */ }
        if (!Array.isArray(list) || !list.length) {
          try { list = await searchStock(q); } catch (e) { list = []; }
        }
        const idx = matchIndexes(q);
        const rest = (Array.isArray(list) ? list : []).filter(x => !idx.some(y => y.code === x.code));
        setResults([...idx, ...rest]);
        setSearching(false);
      };
      const add = item => {
        if (sk.watch.some(x => x.code === item.code)) { toast('该股票已在自选列表中', 'warn'); return; }
        patch('stock', st => ({ ...st, watch: [...st.watch, { id: uid(), code: item.code, name: item.name, market: item.market, buyBelow: '', sellAbove: '', stopLoss: '', pctUp: '', pctDown: '', note: '', cost: 0, shares: 0 }] }));
        if (!selected) setSelected(item.code);
        toast('已添加 ' + item.name + '，请设置买卖点');
        refresh();
      };
      const saveAlert = f => patch('stock', st => ({ ...st, watch: st.watch.map(x => x.id === f.id ? f : x) }));
      const saveHold = f => patch('stock', st => ({ ...st, watch: st.watch.map(x => x.id === f.id ? { ...x, cost: f.cost, shares: f.shares } : x) }));
      // 删除自选股时连本地库一起清：只删自选行会留下孤儿日线，数据库表格里还挂着这只股票
      const watchPayload = () => sk.watch.map(x => ({ code: x.code, name: x.name, market: x.market, cost: Number(x.cost) || 0, shares: Number(x.shares) || 0, note: x.note || '' }));
      const purgeStockQuiet = async code => {
        if (!code) return;
        try {
          await stockPost('/purge', { codes: [code], keepWatch: true });
          toast('已删除 ' + code + ' 的日线数据', 'ok');
        } catch (e) {
          // 宿主半侧的 /purge 是新加路由；宿主模块没重新加载时会 404。
          // 退路：借已有的 /watchlist 覆盖保存触发级联清理，再把这只股票写回自选行 —— 效果一样，不用重启。
          const m = String((e && e.message) || e);
          if (!/40[45]|未找到|not found|HTTP 40/i.test(m)) { toast('删除日线失败：' + m, 'danger'); loadDb(); return; }
          try {
            const all = watchPayload();
            await stockPost('/watchlist', { purgeMissing: true, items: all.filter(x => x.code !== code) });
            await stockPost('/watchlist', { items: all });
            toast('已删除 ' + code + ' 的日线数据（重启 DSH 后可走直连接口）', 'ok');
          } catch (e2) {
            toast('删除日线失败：' + ((e2 && e2.message) || e2) + '（重启 DSH 后重试）', 'danger');
          }
        }
        loadDb();
      };
      const purgeStock = async (code, name) => {
        if (!code) return;
        if (!confirm('删除「' + (name || code) + '」在本地库里的日线数据？\n自选股列表不受影响。')) return;
        await purgeStockQuiet(code);
      };
      // 从自选股移除：只改状态，落库由下面那个去抖的 /watchlist 覆盖保存完成 ——
      // worker 的 watchlist_set 会按「不在列表里的 code」级联删掉日线与指标，
      // 所以这里不能再单独调 purge（那会把刚删掉的股票又写回自选行）。
      const del = id => {
        const it = sk.watch.find(x => x.id === id);
        if (!it) return;
        if (!confirm('从自选股移除「' + (it.name || it.code) + '」？\n本地库里它的日线、指标会一并删除。')) return;
        patch('stock', st => ({ ...st, watch: st.watch.filter(x => x.id !== id) }));
        setTimeout(loadDb, 1200);
      };
      // 拖动排序：after=true 落在目标行下方，否则落在上方
      const moveWatch = (fromId, toId, after) => {
        if (!fromId || !toId || fromId === toId) return;
        patch('stock', st => {
          const arr = st.watch.slice();
          const from = arr.findIndex(x => x.id === fromId);
          const to = arr.findIndex(x => x.id === toId);
          if (from < 0 || to < 0) return st;
          const [it] = arr.splice(from, 1);
          const to2 = arr.findIndex(x => x.id === toId);
          if (to2 < 0) return st;
          arr.splice(after ? to2 + 1 : to2, 0, it);
          return { ...st, watch: arr };
        });
      };
      const statusOf = (x, q) => {
        if (!q) return { text: '无行情', cls: 'grey' };
        const hits = [];
        if (x.buyBelow && q.price <= Number(x.buyBelow)) hits.push('≤ 买入 ' + x.buyBelow);
        if (x.sellAbove && q.price >= Number(x.sellAbove)) hits.push('≥ 卖出 ' + x.sellAbove);
        if (x.stopLoss && q.price <= Number(x.stopLoss)) hits.push('≤ 止损 ' + x.stopLoss);
        if (x.pctUp && q.changePct >= Number(x.pctUp)) hits.push('涨幅 ' + q.changePct.toFixed(2) + '%');
        if (x.pctDown && q.changePct <= -Number(x.pctDown)) hits.push('跌幅 ' + q.changePct.toFixed(2) + '%');
        return hits.length ? { text: hits.join(' / '), cls: 'red' } : { text: '监控中', cls: '' };
      };

      const startSync = async () => {
        if (!sk.watch.length) { toast('先添加自选股', 'warn'); return; }
        setBusy(true);
        try {
          const j = await stockPost('/sync', { source, years });
          setJob(j.job);
          toast('已开始下载 ' + j.count + ' 只 · ' + j.start + ' ~ ' + j.end, 'ok');
        } catch (e) { toast('下载失败：' + ((e && e.message) || e), 'danger'); }
        setBusy(false);
      };
      const cancelJob = async () => {
        try { await stockPost('/job/cancel', { job: job && job.id }); toast('已请求取消', 'warn'); } catch (e) { toast('取消失败：' + e.message, 'danger'); }
      };
      const changeSource = v => { setSource(v); try { localStorage.setItem('dsh-wb-stock-source', v); } catch (e) {} };
      const openDir = async () => {
        try {
          const r = await stockPost('/open-dir', {});
          toast('已打开数据目录' + (r && r.dir ? '：' + r.dir : ''));
        } catch (e) { toast('打开失败：' + ((e && e.message) || e), 'danger'); }
      };

      const q = code => sk.quotes[code] || null;
      const totals = sk.watch.reduce((a, x) => {
        const qq = q(x.code);
        const shares = Number(x.shares) || 0;
        const cost = Number(x.cost) || 0;
        if (qq && qq.price != null) a.value += qq.price * shares;
        a.cost += cost * shares;
        if (qq && qq.changePct != null) { if (qq.changePct > 0) a.up += 1; else if (qq.changePct < 0) a.down += 1; }
        return a;
      }, { value: 0, cost: 0, up: 0, down: 0 });
      const profit = totals.value - totals.cost;

      const sources = (status && status.sources) || STOCK_SOURCES.map(([id, label]) => ({ id, label, available: true }));
      const srcMeta = id => sources.find(x => x.id === id) || { id, available: true };
      const selectedItem = sk.watch.find(x => x.code === selected) || null;
      const an = analysis && analysis.ok !== false ? analysis : null;
      const anErr = analysis && analysis.ok === false ? analysis.error : '';
      const db = dbInfo && !dbInfo.error ? dbInfo : null;
      const jobPct = job && job.total ? Math.round((job.done / job.total) * 100) : 0;

      const dbBody = db ? h('div', null,
        h('div', { className: 'wb-kpi-line', style: { marginBottom: 8 } },
          h('span', { className: 'k' }, '库文件'),
          h('span', { className: 'v', style: { fontSize: 11.5, fontFamily: 'Consolas,monospace' } }, db.path || ''),
          h('span', { className: 'k' }, '体积'), h('span', { className: 'v' }, sBytes(db.sizeBytes)),
          h('span', { className: 'k' }, '自选'), h('span', { className: 'v' }, (db.stocks || 0) + ' 只'),
          h('span', { className: 'k' }, '日线'), h('span', { className: 'v' }, sInt(db.rows) + ' 行'),
          h('span', { className: 'k' }, '区间'), h('span', { className: 'v' }, (db.firstDate || '—') + ' ~ ' + (db.lastDate || '—'))),
        (db.perStock && db.perStock.length) ? h('div', { style: { overflowX: 'auto' } },
          h('table', { className: 'wb-table' },
            h('thead', null, h('tr', null, ['代码', '名称', '日线行数', '起始', '最新', '最新指标', ''].map((c, i) => h('th', { key: i }, c)))),
            h('tbody', null, db.perStock.map(x => h('tr', { key: x.code },
              h('td', { style: { fontFamily: 'Consolas,monospace' } }, x.code),
              h('td', null, x.name || '—'),
              h('td', null, sInt(x.rows)),
              h('td', null, x.firstDate || '—'),
              h('td', null, x.lastDate || '—'),
              h('td', null, x.lastIndicator || '—'),
              h('td', null,
                h(Btn, { className: 'sm', onClick: () => { setSelected(x.code); loadAnalysis(x.code, CHART_DAYS); } }, '看指标'),
                h(Btn, { className: 'sm', onClick: () => purgeStock(x.code, x.name) }, '删除'))))))) :
          h('p', { className: 'wb-hint' }, '库里还没有日线。选数据源后点「下载近 6 年日线」。'),
        (db.lastSync && db.lastSync.length) ? h('p', { className: 'wb-hint', style: { marginTop: 8 } },
          '最近同步：' + (() => {
            const seen = new Set();
            return db.lastSync.filter(x => (seen.has(x.code) ? false : (seen.add(x.code), true))).slice(0, 6)
              .map(x => (x.at || '').slice(5, 16).replace('T', ' ') + ' ' + (x.code || '') + (x.ok ? ' ✓' : ' ✗ ' + (x.message || ''))).join(' · ');
          })()) : null
      ) : h('p', { className: 'wb-hint' }, dbInfo && dbInfo.error ? '读取库统计失败：' + dbInfo.error : '正在读取库统计…');

      return h('div', null,
        h('style', null, STOCK_CSS),
        h('div', { className: 'wb-row', style: { marginBottom: 10 } },
          h(Inp, { placeholder: '输入股票名称 / 代码 / 拼音，如 茅台、600519、pingan', value: kw, onChange: e => setKw(e.target.value), onKeyDown: e => { if (e.key === 'Enter') doSearch(); }, style: { width: 300 } }),
          h(Btn, { variant: 'pri', onClick: doSearch, disabled: searching }, searching ? '搜索中…' : '搜索'),
          h('span', { style: { width: 8 } }),
          h('span', { className: 'wb-hint' }, '数据源'),
          h(Sel, { value: source, onChange: e => changeSource(e.target.value), style: { width: 170 } },
            sources.map(x => h('option', { key: x.id, value: x.id, disabled: !x.available }, (STOCK_SOURCES.find(y => y[0] === x.id) || [x.id, x.id])[1] + (x.available ? '' : '（未安装）')))),
          h(Sel, { value: years, onChange: e => setYears(Number(e.target.value)), style: { width: 86 }, title: '下载区间' },
            [[1, '近 1 年'], [3, '近 3 年'], [5, '近 5 年'], [6, '近 6 年']].map(([v, t]) => h('option', { key: v, value: v }, t))),
          h(Btn, { variant: 'pri', onClick: startSync, disabled: busy || !!(job && job.status === 'running') }, busy ? '提交中…' : '下载近 ' + years + ' 年日线'),
          job && job.status === 'running' ? h(Btn, { onClick: cancelJob }, '停止') : null,
          h(Btn, { onClick: refresh }, '刷新行情'),
          h(Btn, { onClick: () => { loadStatus(); loadDb(); if (selected) loadAnalysis(selected, CHART_DAYS); } }, '重新检测'),
          h('span', { className: 'wb-hint' }, sk.updatedAt ? '行情 ' + new Date(sk.updatedAt).toLocaleTimeString('zh-CN') : '尚未获取行情')),

        status && status.ok === false ? h('div', { className: 'wb-alert danger', style: { marginBottom: 10 } },
          h('div', { style: { flex: 1 } },
            h('div', { className: 't' }, '股票数据服务未就绪'),
            h('div', { className: 'b' }, status.error + '；若提示缺 Python 包，在命令行执行：pip install akshare baostock efinance'))) : null,

        job ? (job.status === 'running'
          ? h('div', { style: { marginBottom: 12 } },
            h('div', { className: 'wb-row', style: { justifyContent: 'space-between', marginBottom: 4 } },
              h('span', { className: 'wb-hint' }, '正在下载 · ' + (job.source || '') + ' · ' + (job.done || 0) + '/' + (job.total || 0) + ' 只'
                + (job.current ? ' · ' + job.current : '') + (job.rows ? ' · ' + job.rows + ' 行' : '')),
              h('span', { className: 'wb-hint' }, jobPct + '%')),
            h('div', { className: 'wb-bar' }, h('i', { style: { width: jobPct + '%' } })),
            job.errors && job.errors.length ? h('div', { className: 'wb-hint', style: { marginTop: 4, color: 'var(--wb-warn-ink)' } },
              '失败：' + job.errors.slice(0, 3).map(x => x.code + ' ' + x.message).join('；')) : null)
          : h('p', { className: 'wb-hint', style: { margin: '0 0 10px' } },
            '上次下载：' + (job.source || '') + ' · 成功 ' + (job.ok || 0) + ' 只 / 失败 ' + (job.fail || 0) + ' 只 · ' + (job.rows || 0) + ' 行'
            + (job.finishedAt ? ' · ' + new Date(job.finishedAt).toLocaleString('zh-CN') : '')
            + (job.errors && job.errors.length ? ' · 失败：' + job.errors.slice(0, 2).map(x => x.code + ' ' + x.message).join('；') : ''))) : null,

        results.length > 0 && h(Section, { title: '搜索结果', actions: h(Btn, { className: 'sm', onClick: () => setResults([]) }, '关闭') },
          h(Table, { cols: ['代码', '名称', '市场', ''], rows: results.map(r => h('tr', { key: r.code },
            h('td', null, r.code), h('td', null, r.name), h('td', null, r.type === 'ZS' ? '指数' : String(r.market || '').toUpperCase()),
            h('td', null, h(Btn, { className: 'sm pri', onClick: () => add(r) }, '+ 加自选')))) })),

        h(Section, {
          title: '自选股',
          actions: h('div', { className: 'wb-row' },
            h('span', { className: 'wb-hint' }, '自选 ' + sk.watch.length + ' 只'),
            h('span', { className: 'wb-hint' }, '涨 ' + totals.up + ' · 跌 ' + totals.down),
            h('span', { className: 'wb-hint' }, '总市值 ' + (totals.value ? money(totals.value) : '—')),
            h('span', { className: 'wb-hint', style: { color: profit > 0 ? 'var(--wb-danger-ink)' : profit < 0 ? 'var(--wb-ok-ink)' : undefined } }, '总盈亏 ' + (totals.cost ? (profit >= 0 ? '+' : '') + money(profit) + '（' + (profit / totals.cost * 100).toFixed(2) + '%）' : '—'))),
        },
          !sk.watch.length ? Empty('还没有自选股。用上面的搜索框添加，或点「下载近 6 年日线」前先加几只。') :
            h('div', { className: 'wb-stock-wrap' }, h('table', { className: 'wb-stock-table' },
              h('thead', null, h('tr', null,
                ['操作', '名称代码', '最新价', '涨跌', '涨跌率', '最高', '最低', '今开', '昨收', '市盈率', '成交量', '成交额(万)', '换手率', '成本', '总成本', '持有量', '总现值', '盈亏率', '盈亏', '时间']
                  .map((c, i) => h('th', { key: i, className: i >= 2 && i !== 19 ? 'n' : '' }, c)))),
              h('tbody', null, sk.watch.map(x => {
                const qq = q(x.code);
                const cp = qq ? qq.changePct : null;
                const price = qq ? qq.price : null;
                const cost = Number(x.cost) || 0;
                const shares = Number(x.shares) || 0;
                const ct = cost * shares;
                const val = price != null ? price * shares : 0;
                const pf = val - ct;
                const pfp = ct ? (pf / ct) * 100 : null;
                const stt = statusOf(x, qq);
                return h('tr', {
                  key: x.id,
                  className: (selected === x.code ? 'sel ' : '') + (dragId === x.id ? 'dragging ' : '') + (overId === x.id ? (overAfter ? 'drop-after' : 'drop-before') : ''),
                  draggable: true,
                  onDragStart: e => {
                    setDragId(x.id);
                    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', x.id); } catch (err) { /* 忽略 */ }
                  },
                  onDragEnd: () => { setDragId(null); setOverId(null); setOverAfter(false); },
                  onDragOver: e => {
                    const types = e.dataTransfer && e.dataTransfer.types;
                    const fromOutside = types && Array.from(types).indexOf('text/plain') >= 0;
                    if (!dragId && !fromOutside) return;
                    e.preventDefault();
                    try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* 忽略 */ }
                    const r = e.currentTarget.getBoundingClientRect();
                    const after = (e.clientY - r.top) > r.height / 2;
                    if (overId !== x.id) setOverId(x.id);
                    if (overAfter !== after) setOverAfter(after);
                  },
                  onDragLeave: () => setOverId(v => (v === x.id ? null : v)),
                  onDrop: e => {
                    e.preventDefault();
                    const id = dragId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
                    // 直接按落点算上下半区，避免依赖上一次 dragover 的 state
                    const r = e.currentTarget.getBoundingClientRect();
                    const after = e.clientY ? (e.clientY - r.top) > r.height / 2 : overAfter;
                    moveWatch(id, x.id, after);
                    setDragId(null);
                    setOverId(null);
                    setOverAfter(false);
                  },
                },
                  h('td', { onClick: e => e.stopPropagation() },
                    h('span', { className: 'wb-drag', title: '按住拖动，上下调整顺序' }, '⠿'),
                    h('button', { className: 'wb-ico', title: '编辑买卖点', draggable: false, onClick: () => setModal(x) }, '✎'),
                    h('button', { className: 'wb-ico', title: '设置持仓成本', draggable: false, onClick: () => setHold(x) }, '¥'),
                    h('button', { className: 'wb-ico danger', title: '删除', draggable: false, onClick: () => del(x.id) }, '✕')),
                  h('td', { onClick: () => setSelected(x.code) },
                    h('div', { className: 'wb-sname' }, esc(x.name)),
                    h('div', { className: 'wb-scode' }, x.code),
                    stt.cls !== '' || stt.text !== '监控中' ? h('div', { style: { marginTop: 2 } }, h('span', { className: 'wb-tag ' + stt.cls, style: { fontSize: 10 } }, stt.text)) : null),
                  h('td', { className: 'n num' }, h('b', { className: sCls(cp) }, sNum(price))),
                  h('td', { className: 'n num ' + sCls(qq && qq.change) }, qq ? sSign(qq.change) : '—'),
                  h('td', { className: 'n num ' + sCls(cp) }, qq && cp != null ? sSign(cp) + '%' : '—'),
                  h('td', { className: 'n num' }, qq ? sNum(qq.high) : '—'),
                  h('td', { className: 'n num' }, qq ? sNum(qq.low) : '—'),
                  h('td', { className: 'n num' }, qq ? sNum(qq.open) : '—'),
                  h('td', { className: 'n num' }, qq ? sNum(qq.prevClose) : '—'),
                  h('td', { className: 'n num' }, qq ? sNum(qq.pe) : '—'),
                  h('td', { className: 'n num' }, qq ? sBig(qq.volume, '手') : '—'),
                  h('td', { className: 'n num' }, qq ? sWan(qq.amount) : '—'),
                  h('td', { className: 'n num' }, qq ? sNum(qq.turnover) + '%' : '—'),
                  h('td', { className: 'n num' }, cost ? sNum(cost, 3) : '—'),
                  h('td', { className: 'n num' }, ct ? money(ct) : '—'),
                  h('td', { className: 'n num' }, shares ? sInt(shares) : '—'),
                  h('td', { className: 'n num' }, val ? money(val) : '—'),
                  h('td', { className: 'n num ' + sCls(pfp) }, pfp == null ? '—' : sSign(pfp) + '%'),
                  h('td', { className: 'n num ' + sCls(pf) }, ct ? sSign(pf) : '—'),
                  h('td', { className: 'n num' }, qq && qq.time ? quoteTime(qq.time) : '—'));
              })))),
          h('p', { className: 'wb-hint', style: { margin: '8px 0 0' } },
            '行情来自腾讯证券（qt.gtimg.cn），点名称看下方指标；⠿ 按住行可上下拖动排序；✎ 买卖点、¥ 持仓成本（存库并计入盈亏）、✕ 移除。红色为涨、绿色为跌。')),

        h(Section, {
          title: '神奇九转 · 多项指标',
          actions: h('div', { className: 'wb-row' },
            h('span', { className: 'wb-hint' }, nineTurn && nineTurn.today ? '检查日 ' + nineTurn.today + (nineTurn.tradingDay ? '（交易日）' : '（非交易日，按上一交易日）') : ''),
            h(Btn, { className: 'sm', onClick: loadNineTurn, disabled: nineBusy || !sk.watch.length }, nineBusy ? '计算中…' : '立即检查')),
        },
          h('p', { className: 'wb-hint', style: { margin: '0 0 8px' } },
            '统计 10 项：神奇九转 + MA20、均线排列、MACD、KDJ、RSI6、布林带、量能、20 日涨跌、60 日涨跌。看多 ≥3 项且至少比看空多 2 项 → 买入提示；看空 ≥3 项且至少比看多多 2 项 → 卖出提示。每日 13:00 按最新价预演当日收盘并提示一次，可在下方「提醒设置」关闭。'),
          !sk.watch.length ? Empty('先添加自选股') :
          nineTurn && nineTurn.ok === false ? Empty('计算失败：' + nineTurn.error) :
          !nineTurn ? Empty(nineBusy ? '正在计算…' : '暂无数据') :
          !(nineTurn.items || []).length ? Empty('暂无数据') :
            h('div', { style: { overflowX: 'auto' } }, h('table', { className: 'wb-table' },
              h('thead', null, h('tr', null, ['代码', '名称', '九转', '多空', '最新价', '日期', '买卖提示'].map((c, i) => h('th', { key: i }, c)))),
              h('tbody', null, (nineTurn.items || []).map(x => {
                const buy = (x.buyCount || 0) > 0, sell = (x.sellCount || 0) > 0;
                return h('tr', { key: x.code },
                  h('td', { style: { fontFamily: 'Consolas,monospace' } }, x.code),
                  h('td', null, x.name || '—'),
                  h('td', null, buy ? '下跌 ' + x.buyCount + '/9' : sell ? '上涨 ' + x.sellCount + '/9' : '—'),
                  h('td', null, h('span', { style: { color: (x.bullCount || 0) > (x.bearCount || 0) ? 'var(--wb-danger-ink)' : (x.bearCount || 0) > (x.bullCount || 0) ? 'var(--wb-ok-ink)' : undefined } },
                    '多 ' + (x.bullCount || 0) + ' / 空 ' + (x.bearCount || 0))),
                  h('td', { className: 'num' }, x.close == null ? '—' : fmt(x.close)),
                  h('td', null, x.date || '—', x.provisional ? h('span', { className: 'wb-tag', style: { marginLeft: 6 } }, '盘中') : null),
                  h('td', null, x.error ? h('span', { className: 'wb-tag grey' }, x.error) :
                    x.buy ? h('span', { className: 'wb-tag green' }, '买入提示') :
                      x.sell ? h('span', { className: 'wb-tag red' }, '卖出提示') :
                        h('span', { className: 'wb-tag grey', title: (x.signals || []).filter(s => s.state !== 'neutral').map(s => s.name).join('、') || '' }, '观望')));
              }))))),

        h(Section, {
          title: '指标分析' + (selectedItem ? ' · ' + selectedItem.name + ' ' + selectedItem.code : ''),
          actions: h('div', { className: 'wb-row' },
            h('span', { className: 'wb-hint' }, '显示'),
            h(Sel, { value: range, onChange: e => setRange(Number(e.target.value)), style: { width: 90 } },
              STOCK_RANGES.map(([v, t]) => h('option', { key: v, value: v }, t))),
            h(Btn, { className: 'sm', disabled: !nBars || vcount >= nBars, onClick: () => zoomBy(1.4), title: '缩小：显示更多 K 线' }, '－'),
            h(Btn, { className: 'sm', disabled: !nBars || vcount <= 20, onClick: () => zoomBy(0.7), title: '放大：显示更少 K 线' }, '＋'),
            h(Btn, { className: 'sm', disabled: !nBars, onClick: resetView, title: '回到默认显示范围' }, '重置'),
            h('span', { className: 'wb-hint', style: { minWidth: 92 } }, nBars ? ((view.count ? view.start + 1 : 1) + '–' + (view.count ? view.start + view.count : nBars) + ' / ' + nBars + ' 根') : ''),
            h(Btn, { disabled: !selected, onClick: () => selected && loadAnalysis(selected, CHART_DAYS) }, anaBusy ? '读取中…' : '刷新指标'),
            h(Btn, { disabled: !selected || !an, onClick: () => {
              if (!selected) return;
              const a = document.createElement('a');
              a.href = STOCK_API + '/export?code=' + encodeURIComponent(selected);
              a.download = selected + '-daily.csv';
              document.body.appendChild(a); a.click(); a.remove();
            } }, '导出 CSV'),
            h(Btn, { disabled: !selected, onClick: async () => { try { await stockPost('/recompute', { code: selected }); loadAnalysis(selected, CHART_DAYS); toast('指标已重算'); } catch (e) { toast('重算失败：' + e.message, 'danger'); } } }, '重算指标')),
        },
          !selected ? Empty('点上方自选股的名称，查看它按日线算出来的指标。') :
            anErr ? Empty('读取指标失败：' + anErr) :
            !an ? Empty(anaBusy ? '正在读取…' : '还没有数据') :
            !an.chart || !an.chart.length ? Empty('这只股票还没有日线数据。点上方「下载近 6 年日线」后再看。') :
              h('div', null,
                h('div', { className: 'wb-kpi-line', style: { marginBottom: 10 } },
                  h('span', { className: 'k' }, '最新'), h('span', { className: 'v' }, an.stats.lastDate || '—'),
                  h('span', { className: 'k' }, '数据源'), h('span', { className: 'v' }, (STOCK_SOURCES.find(x => x[0] === an.source) || [an.source, an.source || '未知'])[1]),
                  h('span', { className: 'k' }, '样本'), h('span', { className: 'v' }, (an.stats.bars || 0) + ' 根'),
                  h('span', { className: 'k' }, '九转'), h('span', { className: 'v' },
                    an.nineTurn ? (an.nineTurn.signal ? (an.nineTurn.signal === 'buy' ? '买入 9/9' : '卖出 9/9') : (an.nineTurn.label || '—')) : '—'),
                  h('span', { className: 'k' }, '结论'), h('span', { className: 'v' },
                    h('span', { className: 'wb-tag ' + (an.summary.label === '偏多' ? 'red' : an.summary.label === '偏空' ? 'green' : 'grey') },
                      (an.summary.label || '—') + ' · ' + (an.summary.score == null ? '—' : an.summary.score) + ' 分')),
                  h('span', { className: 'k' }, '年化波动'), h('span', { className: 'v' }, sPct(an.stats.volatility)),
                  h('span', { className: 'k' }, '最大回撤'), h('span', { className: 'v' }, sPct(an.stats.maxDrawdown)),
                  h('span', { className: 'k' }, '20 日'), h('span', { className: 'v' }, '支撑 ' + sNum(an.stats.support20) + ' / 压力 ' + sNum(an.stats.resistance20))),
                h(KlineChart, { rows: an.chart, view, onView: setView, onReset: resetView }),
                h('p', { className: 'wb-hint', style: { margin: '2px 0 0', textAlign: 'center' } }, 'Ctrl + 滚轮缩放 · 按住拖动平移 · 双击复位 · 蜡烛上下的数字为神奇九转计数（绿=下跌结构，红=上涨结构）'),
                h(SignalGrid, { analysis: an }),
                h('div', { style: { marginTop: 14 } },
                  h('div', { className: 'wb-hint', style: { marginBottom: 6, fontWeight: 600 } }, '最近 12 个交易日指标'),
                  h(IndicatorTable, { rows: an.table })))),

        h(Section, {
          title: '股票数据库',
          actions: h('div', { className: 'wb-row' },
            h(Btn, { className: 'sm', onClick: openDir }, '打开数据目录'),
            h(Btn, { className: 'sm', onClick: loadDb }, '刷新统计')),
        },
          dbBody,
          h('p', { className: 'wb-hint', style: { margin: '8px 0 0' } },
            '日线默认存 ' + ((status && status.dbPath) || 'D:\\天源评估\\个人工作台\\股票数据\\stock.db')
            + '。下载会覆盖同日期区间，指标按全部历史重算；数据源可在上面切换，AKShare 东财接口被限流时自动退回腾讯接口。'
            + '表格每行可单独删除该股的日线；从自选股移除时，库里的日线也会自动清理。')),

        h(Section, { title: '提醒设置' }, h('div', { className: 'wb-row', style: { marginBottom: 6 } },
          h('label', { className: 'wb-hint', style: { display: 'flex', gap: 6, alignItems: 'center' } },
            h('input', { type: 'checkbox', checked: sk.nineTurnEnabled !== false, onChange: e => patch('stock', st => ({ ...st, nineTurnEnabled: e.target.checked })) }),
            '每日 13:00 多项指标买卖提示'),
          h('label', { className: 'wb-hint', style: { display: 'flex', gap: 6, alignItems: 'center' } },
            h('input', { type: 'checkbox', checked: sk.alertsEnabled, onChange: e => patch('stock', st => ({ ...st, alertsEnabled: e.target.checked })) }),
            '价格到点提醒（买卖点 / 止损 / 涨跌幅）'),
          h('span', { className: 'wb-hint' }, '轮询间隔'), h(Sel, { value: sk.pollSeconds, onChange: e => patch('stock', st => ({ ...st, pollSeconds: Number(e.target.value) })) }, [30, 60, 120, 300].map(v => h('option', { key: v, value: v }, v + ' 秒')))),
        h('p', { className: 'wb-hint', style: { margin: 0 } },
          '多项指标（九转 + 均线/MACD/KDJ/RSI/布林/量能/20、60 日涨跌）在每日 13:00（页面打开时）按最新价预演当日收盘，看多或看空 ≥3 项且比反向多 2 项以上时提示；错过时下次打开页面会补一次当天提示，提醒中心留痕并弹浏览器通知。价格到点提醒按轮询间隔检查，同一条件不会重复提醒，直到价格离开该点位。')),

        modal && h(AlertModal, { item: modal, onClose: () => setModal(null), onSave: f => { saveAlert(f); setModal(null); refresh(); } }),
        hold && h(HoldingsModal, { item: hold, onClose: () => setHold(null), onSave: f => { saveHold(f); setHold(null); toast('已保存持仓'); } }));
    }

    function AlertModal({ item, onClose, onSave }) {
      const [f, setF] = useState({ ...item });
      const set = k => e => setF({ ...f, [k]: e.target.value });
      return h(Modal, { title: '设置提醒 · ' + item.name + ' (' + item.code + ')', onClose },
        h('div', { className: 'wb-form' },
          h(Field, { label: '买入点（现价 ≤）' }, h(Inp, { type: 'number', step: '0.01', min: '0', value: f.buyBelow, onChange: set('buyBelow'), placeholder: '低于该价提醒买入' })),
          h(Field, { label: '卖出点（现价 ≥）' }, h(Inp, { type: 'number', step: '0.01', min: '0', value: f.sellAbove, onChange: set('sellAbove'), placeholder: '高于该价提醒卖出' })),
          h(Field, { label: '止损价（现价 ≤）' }, h(Inp, { type: 'number', step: '0.01', min: '0', value: f.stopLoss, onChange: set('stopLoss') })),
          h(Field, { label: '单日涨幅 ≥ (%)' }, h(Inp, { type: 'number', step: '0.1', min: '0', value: f.pctUp, onChange: set('pctUp') })),
          h(Field, { label: '单日跌幅 ≥ (%)' }, h(Inp, { type: 'number', step: '0.1', min: '0', value: f.pctDown, onChange: set('pctDown') })),
          h(Field, { label: '备注', full: true }, h(Inp, { value: f.note, onChange: set('note'), placeholder: '如：突破前高减仓 / 定投观察' })),
        ),
        h('p', { className: 'wb-hint' }, '留空表示不启用该条件。提醒仅在插件页面打开期间按轮询间隔检查；关掉页面不会后台推送。'),
        h('div', { className: 'wb-form-foot' }, h(Btn, { onClick: onClose }, '取消'), h(Btn, { variant: 'pri', onClick: () => onSave(f) }, '保存')),
      );
    }

    // ---------- alerts ----------
    function Alerts({ s }) {
      return h(Section, { title: '提醒中心', actions: h(Btn, { className: 'sm', onClick: () => store.set(st => ({ ...st, alerts: st.alerts.map(a => ({ ...a, read: true })) })) }, '全部标为已读') },
        s.alerts.length ? s.alerts.map(a => h('div', { key: a.id, className: 'wb-alert ' + (a.level || '') + (a.read ? ' grey' : '') },
          h('span', { className: 'wb-tag ' + (a.level === 'danger' ? 'red' : a.level === 'warn' ? 'warn' : '') }, a.read ? '已读' : '新'),
          h('div', { style: { flex: 1 } }, h('div', { className: 't' }, a.title), h('div', { className: 'b' }, a.body)),
          h('span', { className: 'ts' }, new Date(a.at).toLocaleString('zh-CN')),
          h(Btn, { className: 'sm', onClick: () => store.set(st => ({ ...st, alerts: st.alerts.filter(x => x.id !== a.id) })) }, '删除'),
        )) : Empty('暂无提醒'),
      );
    }

    // ---------- settings ----------
    function Settings({ s, toast }) {
      // 数据落盘（目录可改，默认 D:\天源评估\个人工作台）
      const [dirInfo, setDirInfo] = useState(null);
      const [dirDraft, setDirDraft] = useState('');
      const [projDraft, setProjDraft] = useState('');
      const [dirBusy, setDirBusy] = useState(false);
      const [saveInfo, setSaveInfo] = useState('');
      const loadDir = async () => {
        try {
          const r = await fetch(PREFIX + '/store', { cache: 'no-store' });
          const d = await r.json();
          if (d && !d.error) { setDirInfo(d); setDirDraft(d.dir || ''); setProjDraft(d.projectsDir || ''); }
        } catch (e) { /* 宿主未重启时这个路由还是 404，忽略即可 */ }
      };
      useEffect(() => { loadDir(); }, []);
      const saveDir = async (dir) => {
        setDirBusy(true); setSaveInfo('');
        try {
          const r = await fetch(PREFIX + '/store', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir }) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
          await loadDir();
          toast('数据目录已改为 ' + d.dir + (d.migrated ? '（已把原目录的数据复制过来）' : ''), 'ok');
          // 立刻把当前数据写到新目录，别等下一次改动
          try { await pushState(store.get()); await loadDir(); } catch (e) {}
        } catch (e) { toast('保存失败：' + ((e && e.message) || e), 'danger'); }
        setDirBusy(false);
      };
      const openDirNow = async () => {
        try {
          const r = await fetch(PREFIX + '/store/open', { method: 'POST' });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
          toast('已打开数据目录');
        } catch (e) { toast('打开失败：' + ((e && e.message) || e), 'danger'); }
      };
      // 本地项目文件夹根目录（默认 D:\天源评估\00项目ing）：只换项目目录，不动 工作台数据.json
      const saveProjectsDir = async (dir) => {
        setDirBusy(true); setSaveInfo('');
        try {
          const r = await fetch(PREFIX + '/store', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectsDir: dir }) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
          await loadDir();
          toast('项目文件夹根目录已改为 ' + d.projectsDir, 'ok');
        } catch (e) { toast('保存失败：' + ((e && e.message) || e), 'danger'); }
        setDirBusy(false);
      };
      const openProjectsNow = async () => {
        try {
          const r = await fetch(PREFIX + '/store/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ which: 'projects' }) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
          toast('已打开项目文件夹根目录');
        } catch (e) { toast('打开失败：' + ((e && e.message) || e), 'danger'); }
      };
      const saveNow = async () => {
        setSaveInfo('正在写盘…');
        try {
          const d = await pushState(store.get());
          setSaveInfo('已写入 ' + (d.file || ''));
          await loadDir();
          toast('已保存到数据文件', 'ok');
        } catch (e) { setSaveInfo('写盘失败：' + ((e && e.message) || e)); }
      };
      const reset = async () => {
        if (!confirm('确定清空全部工作台数据并恢复示例数据？此操作不可撤销。')) return;
        const d = defaults();
        try { await pushState(d); } catch (e) {}
        try { localStorage.removeItem(STORE_KEY); localStorage.removeItem(SAVED_AT_KEY); } catch (e) {}
        location.reload();
      };
      const [seedInfo, setSeedInfo] = useState('');
      const reseed = async () => {
        setSeedInfo('正在导入…');
        try {
          const c = await seedFromHost(true);
          if (!c) { setSeedInfo('导入失败：宿主未返回数据'); return; }
          setSeedInfo('考试日历 ' + c.calendar + ' 项（已填入 ' + c.filled + ' 项）' + (c.err ? ' · 错误：' + c.err : ''));
          toast('已重新导入考试日历', 'ok');
        } catch (e) { setSeedInfo('导入失败：' + ((e && e.message) || e)); }
      };
      const exp = () => {
        const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = '工作台备份-' + todayStr() + '.json'; a.click(); URL.revokeObjectURL(a.href);
      };
      const imp = e => {
        const file = e.target.files[0]; if (!file) return;
        const rd = new FileReader();
        rd.onload = async () => {
          try { const d = normalizeState(JSON.parse(rd.result)); await pushState(d); localStorage.setItem(STORE_KEY, JSON.stringify(d)); location.reload(); }
          catch (err) { toast('导入失败：不是有效的 JSON', 'danger'); }
        };
        rd.readAsText(file);
      };
      const dirText = (dirInfo && dirInfo.dir) || hostSync.dir || 'D:\\天源评估\\个人工作台';
      const fileText = (dirInfo && dirInfo.file) || hostSync.file || '';
      const atText = (hostSync.at || (dirInfo && dirInfo.savedAt)) ? new Date(hostSync.at || dirInfo.savedAt).toLocaleString('zh-CN') : '尚未写入';
      const projText = (dirInfo && dirInfo.projectsDir) || 'D:/天源评估/00项目ing';
      const projSource = (dirInfo && dirInfo.projectsSource) === 'config' ? '设置中指定'
        : (dirInfo && dirInfo.projectsSource) === 'env' ? '环境变量指定' : '默认值';
      // 分组小标题：合并成一个 Section 后靠它分段，第一段不画分隔线
      const Sub = (t, first) => h('div', {
        style: {
          fontWeight: 600, fontSize: 12.5, margin: first ? '0 0 8px' : '18px 0 8px',
          paddingTop: first ? 0 : 14, borderTop: first ? 'none' : '1px solid var(--dsw-alias-border-l1,#e3e6e8)',
        },
      }, t);
      return h(Section, { title: '设置与数据' },
        h('p', { className: 'wb-hint', style: { margin: '0 0 12px' } },
          '数据改动会自动保存（约 1 秒内写盘，关页面前也会补一次）。最近写入：' + atText
            + '（' + (hostSync.status === 'error' ? hostSync.error : hostSync.status === 'ok' ? '已同步到磁盘' : '待写入') + '）'),
        Sub('数据保存位置', true),
        h('div', { className: 'wb-row', style: { marginBottom: 8 } },
          h('span', { className: 'wb-hint', style: { minWidth: 68 } }, '当前目录'),
          h(Inp, { value: dirDraft, onChange: e => setDirDraft(e.target.value), style: { flex: 1, minWidth: 320 }, placeholder: '例如 D:\\天源评估\\个人工作台', title: dirText }),
        ),
        h('div', { className: 'wb-row', style: { marginBottom: 8 } },
          h(Btn, { variant: 'pri', disabled: dirBusy, onClick: () => saveDir(dirDraft) }, dirBusy ? '保存中…' : '保存更改'),
          h(Btn, { disabled: dirBusy, onClick: () => saveDir((dirInfo && dirInfo.defaultDir) || 'D:\\天源评估\\个人工作台') }, '恢复默认'),
          h(Btn, { onClick: openDirNow }, '打开文件夹'),
          h(Btn, { onClick: saveNow }, '立即写盘'),
          h('span', { className: 'wb-hint' }, saveInfo || ''),
        ),
        h('div', { className: 'wb-hint', style: { lineHeight: 1.9 } },
          '数据文件：' + (fileText || dirText + '\\工作台数据.json'),
          h('br'),
          '目录来源：' + ((dirInfo && dirInfo.source) === 'config' ? '设置中指定' : (dirInfo && dirInfo.source) === 'env' ? '环境变量指定' : '默认值'),
          ' · 覆盖前自动留一份 工作台数据.json.bak。',
        ),
        Sub('本地项目文件夹位置'),
        h('div', { className: 'wb-row', style: { marginBottom: 8 } },
          h('span', { className: 'wb-hint', style: { minWidth: 68 } }, '当前目录'),
          h(Inp, { value: projDraft, onChange: e => setProjDraft(e.target.value), style: { flex: 1, minWidth: 320 }, placeholder: '例如 D:/天源评估/00项目ing', title: projText }),
        ),
        h('div', { className: 'wb-row', style: { marginBottom: 8 } },
          h(Btn, { variant: 'pri', disabled: dirBusy, onClick: () => saveProjectsDir(projDraft) }, dirBusy ? '保存中…' : '保存更改'),
          h(Btn, { disabled: dirBusy, onClick: () => saveProjectsDir((dirInfo && dirInfo.defaultProjectsDir) || 'D:/天源评估/00项目ing') }, '恢复默认'),
          h(Btn, { onClick: openProjectsNow }, '打开文件夹'),
        ),
        h('div', { className: 'wb-hint', style: { lineHeight: 1.9 } },
          '当前目录：' + projText,
          h('br'),
          '本地项目的文件夹都建在这里（目录名「项目编号 项目简称」）；升级前建在数据目录下的老项目仍能打开。',
          h('br'),
          '目录来源：' + projSource + '。归档时整个项目文件夹移到 已归档/{年份}年/ 下，并自动增量更新文件库。',
        ),
        Sub('通知'),
        h('div', { className: 'wb-row', style: { marginBottom: 0 } },
          h('label', { className: 'wb-hint', style: { display: 'flex', gap: 6, alignItems: 'center' } }, h('input', { type: 'checkbox', checked: s.settings.notify, onChange: ev => patch('settings', x => ({ ...x, notify: ev.target.checked })) }), '浏览器桌面通知'),
          h(Btn, { onClick: () => { if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission(); } }, '申请通知权限'),
        ),
        Sub('内置数据'),
        h('div', { className: 'wb-row', style: { marginBottom: 0 } },
          h(Btn, { variant: 'pri', onClick: reseed }, '重新导入内置考试日历'),
          h('span', { className: 'wb-hint', style: { marginLeft: 10 } }, seedInfo || '内置数据：7 项考试的报名与考试日期'),
        ),
        Sub('备份与重置'),
        h('div', { className: 'wb-row' }, h(Btn, { onClick: exp }, '导出数据备份'), h('label', { className: 'wb-btn' }, '导入备份', h('input', { type: 'file', accept: 'application/json', style: { display: 'none' }, onChange: imp })), h(Btn, { variant: 'danger', onClick: reset }, '清空并恢复默认')),
        h('p', { className: 'wb-hint', style: { marginTop: 14 } }, '数据写在上面这个目录的工作台数据.json 里（localStorage 只当缓存，用于离线/首屏）。天源凭据同样仅存本机，不会上传到任何服务器。'),
      );
    }

    // ---------- 报告说明格式：独立于工作台数据，由专用接口读写 ----------
    function ReportFormat({ toast, onDirtyChange }) {
      const [draft, setDraft] = useState(null);
      const [saved, setSaved] = useState(null);
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState('正在读取配置…');
      const [numberInputs, setNumberInputs] = useState({});
      const [unconfirmed, setUnconfirmed] = useState(false);
      const copy = x => JSON.parse(JSON.stringify(x));
      const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
      const dirty = !!draft && (unconfirmed || Object.keys(numberInputs).length > 0 || JSON.stringify(canonical(draft)) !== JSON.stringify(canonical(saved)));
      useEffect(() => { onDirtyChange(dirty || busy); }, [dirty, busy, onDirtyChange]);
      useEffect(() => {
        const warn = e => { if (dirty || busy) { e.preventDefault(); e.returnValue = ''; } };
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
      }, [dirty, busy]);
      const load = async () => {
        setBusy(true); setMessage('正在读取配置…');
        try {
          const r = await fetch(PREFIX + '/report-format', { cache: 'no-store' });
          const rawText = await r.text();
          let d = null; try { d = JSON.parse(rawText); } catch (e) { /* 非 JSON 响应体原样展示 */ }
          if (!r.ok || !d || typeof d !== 'object' || Array.isArray(d) || d.error) throw new Error((d && d.error) || ('HTTP ' + r.status + (rawText ? '：' + rawText.slice(0, 300) : '')));
          setSaved(copy(d)); setDraft(copy(d)); setNumberInputs({}); setUnconfirmed(false); setMessage('已读取当前配置');
        } catch (e) { setMessage('读取失败：' + ((e && e.message) || e)); }
        finally { setBusy(false); }
      };
      useEffect(() => { load(); }, []);
      const get = (obj, path) => path.reduce((v, k) => v && v[k], obj);
      const change = (path, raw, numeric) => {
        setDraft(prev => {
          const next = copy(prev); let obj = next;
          path.slice(0, -1).forEach(k => { if (!obj[k] || typeof obj[k] !== 'object' || Array.isArray(obj[k])) obj[k] = {}; obj = obj[k]; });
          const key = path[path.length - 1];
          if (raw === '') delete obj[key]; else obj[key] = numeric ? Number(raw) : raw;
          return next;
        });
        setMessage('有未保存的修改');
      };
      // 显示单位与接口整数分离：厘米/毫米允许四舍五入到最近 twip，磅必须精确落在接口步长上。
      const field = (label, path, kind, hint) => {
        const value = get(draft, path), id = path.join('.');
        const factor = kind === 'mm' ? 1440 / 25.4 : kind === 'cm' ? 1440 / 2.54 : kind === 'pt' ? 2 : kind === 'borderPt' ? 8 : 1;
        const numeric = !!kind;
        const shown = numeric && Object.prototype.hasOwnProperty.call(numberInputs, id) ? numberInputs[id]
          : value == null ? '' : numeric ? String(Number((value / factor).toFixed(kind === 'cm' || kind === 'mm' ? 2 : 3))) : value;
        return h('label', { key: id, style: { display: 'block', width: '100%' } },
          label ? h('span', { className: 'wb-label' }, label) : null,
          h('input', { className: 'wb-input', style: { width: '100%' }, type: 'text', inputMode: numeric ? 'decimal' : undefined,
            value: shown, placeholder: hint || '未设置', onChange: e => {
              const raw = e.target.value;
              if (!numeric) { change(path, raw, false); return; }
              setNumberInputs(prev => ({ ...prev, [id]: raw }));
              if (!raw.trim()) { change(path, '', false); return; }
              if (!/^(?:\d+\.?\d*|\.\d+)$/.test(raw)) { setMessage('数值无效，修改尚未保存'); return; }
              const scaled = Number(raw) * factor;
              if (!Number.isFinite(scaled) || (kind !== 'mm' && Math.abs(scaled - Math.round(scaled)) > 1e-7)) { setMessage('数值或步长无效，修改尚未保存'); return; }
              change(path, Math.round(scaled), true);
            } }));
      };
      const booleanField = (label, key) => h('label', { key, style: { display: 'block', minWidth: 150, flex: '1 1 170px' } },
        h('span', { className: 'wb-label' }, label),
        h('select', { className: 'wb-select', style: { width: '100%' }, value: get(draft, ['table', key]) == null ? '' : String(get(draft, ['table', key])),
          onChange: e => change(['table', key], e.target.value === '' ? '' : e.target.value === 'true', false) },
          h('option', { value: '' }, '未设置（使用生成器规则）'), h('option', { value: 'true' }, '开启'), h('option', { value: 'false' }, '关闭')));
      // 中文字号下拉：内部存半磅（size_half_points），与 Word/WPS 字号一一对应。
      const CN_SIZES = [['初号', 84], ['小初', 72], ['一号', 52], ['小一', 48], ['二号', 44], ['小二', 36], ['三号', 32], ['小三', 30], ['四号', 28], ['小四', 24], ['五号', 21], ['小五', 18], ['六号', 15], ['小六', 13], ['七号', 11], ['八号', 10]];
      // 常用字体下拉：与 Office 字体列表习惯一致，含自定义兜底。
      const CN_FONTS = ['宋体', '黑体', '仿宋', '楷体', '微软雅黑', '华文仿宋', '华文楷体', 'Times New Roman', 'Arial'];
      const fontField = (label, path, fonts) => {
        const list = fonts || CN_FONTS;
        const value = get(draft, path), id = path.join('.');
        return h('label', { key: id, style: { display: 'block', width: '100%' } },
          label ? h('span', { className: 'wb-label' }, label) : null,
          h('select', { className: 'wb-select', style: { width: '100%' }, value: value == null ? '' : list.includes(value) ? value : 'custom:' + value,
            onChange: e => { const v = e.target.value; change(path, v === '' ? '' : v.startsWith('custom:') ? v.slice(7) : v, false); } },
            h('option', { value: '' }, '未设置（使用默认）'),
            list.map(name => h('option', { key: name, value: name }, name)),
            value != null && !list.includes(value) ? h('option', { value: 'custom:' + value }, '自定义（' + value + '）') : null));
      };
      const sizeField = (label, path) => {
        const value = get(draft, path), id = path.join('.');
        const known = CN_SIZES.find(([, hp]) => hp === value);
        const selValue = known ? String(value) : value == null ? '' : 'custom';
        const setHalf = hp => {
          change(path, hp === null ? '' : hp, false);
          setNumberInputs(prev => { const n = { ...prev }; delete n[id]; return n; });
        };
        return h('label', { key: id, style: { display: 'block', width: '100%' } },
          label ? h('span', { className: 'wb-label' }, label) : null,
          h('div', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
            h('select', { className: 'wb-select', style: { width: '100%', minWidth: 86 }, value: selValue, 'aria-label': label ? label + '字号' : '字号',
              onChange: e => { const v = e.target.value;
                if (v === '') setHalf(null);
                else if (v === 'custom') setHalf(value != null ? value : 24);
                else setHalf(Number(v)); } },
              h('option', { value: '' }, '未设置'),
              CN_SIZES.map(([name, hp]) => h('option', { key: name, value: String(hp) }, name)),
              h('option', { value: 'custom' }, '自定义磅数')),
            selValue === 'custom' ? h('input', { className: 'wb-input', style: { width: 58 }, type: 'text', inputMode: 'decimal', value: value == null ? '' : String(value / 2), 'aria-label': '字号磅值',
              onChange: e => { const raw = e.target.value;
                if (!raw.trim()) { setHalf(null); return; }
                if (!/^(?:\d+\.?\d*|\.\d+)$/.test(raw)) { setMessage('字号须为数字磅值，修改尚未保存'); return; }
                const hp = Math.round(Number(raw) * 2);
                if (hp < 2 || hp > 3276) { setMessage('字号超出范围（1..1638 磅），修改尚未保存'); return; }
                setHalf(hp); } }) : null));
      };
      const save = async () => {
        const invalid = [];
        Object.keys(numberInputs).forEach(id => {
          const raw = numberInputs[id]; if (!raw.trim()) return;
          const factor = id.endsWith('size_half_points') ? 2 : id.endsWith('.size') ? 8 : id.endsWith('.space') ? 1 : id.endsWith('min_row_height_twips') ? 1440 / 2.54 : 1440 / 25.4;
          const looseStep = factor === 1440 / 25.4 || factor === 1440 / 2.54;
          const v = Number(raw) * factor;
          if (!/^(?:\d+\.?\d*|\.\d+)$/.test(raw) || !Number.isFinite(v) || (!looseStep && Math.abs(v - Math.round(v)) > 1e-7)) invalid.push(id + '（数值或步长有误）');
        });
        const range = (p, min, max) => { const v = get(draft, p); if (v != null && (!Number.isSafeInteger(v) || v < min || v > max)) invalid.push(p.join('.') + '（超出范围）'); };
        ['width_twips','height_twips','top_twips','right_twips','bottom_twips','left_twips'].forEach(k => range(['page', k], k === 'width_twips' || k === 'height_twips' ? 1 : 0, 31680));
        ['cover_title','cover_docno','heading1','heading2','heading3','heading4','body','table'].forEach(k => range([k, 'size_half_points'], 2, 3276));
        range(['table','min_row_height_twips'], 1, 31680);
        ['top','bottom','insideH','insideV'].forEach(k => { range(['table','border',k,'size'], 2, 96); range(['table','border',k,'space'], 0, 31); });
        const page = draft.page || {};
        if (page.width_twips != null && page.left_twips != null && page.right_twips != null && page.left_twips + page.right_twips >= page.width_twips) invalid.push('左右边距之和须小于纸张宽度');
        if (page.height_twips != null && page.top_twips != null && page.bottom_twips != null && page.top_twips + page.bottom_twips >= page.height_twips) invalid.push('上下边距之和须小于纸张高度');
        if (invalid.length) { setMessage('修改尚未保存，请检查：' + invalid.join('、')); return; }
        // 二次确认：列出相对已保存配置的全部差异（字段、旧值→新值），防误改。
        const GROUP_NAMES = { page: '页面', cover_title: '封面标题', cover_docno: '封面文号', heading1: '一级标题', heading2: '二级标题', heading3: '三级标题', heading4: '四级标题', body: '正文', table: '表格' };
        const CN_KEY = { width_twips: '纸张宽度', height_twips: '纸张高度', top_twips: '上边距', right_twips: '右边距', bottom_twips: '下边距', left_twips: '左边距', font: '字体', size_half_points: '字号', ascii_font: '西文字体', min_row_height_twips: '最小行高', repeat_header: '重复标题行', numeric_align_right: '数字右对齐', clear_shading: '清除底纹', autofit: '自动适应', single_line: '单倍行距', border: '边框', style: '样式', size: '宽度', space: '间距', color: '颜色', line_multiple: '倍数行距', line_points: '固定行距', first_line_indent_chars: '首行缩进', space_before_points: '段前', space_after_points: '段后', paragraph: '段落' };
        const fmtVal = (v, path) => {
          if (v == null) return '（默认）';
          if (typeof v === 'boolean') return v ? '开启' : '关闭';
          if (path[path.length - 1] === 'size_half_points') { const cn = CN_SIZES.find(([, hp]) => hp === v); return cn ? cn[0] : (v / 2) + '磅'; }
          if (path[path.length - 1] === 'min_row_height_twips') return (v * 25.4 / 1440).toFixed(2) + '厘米';
          return String(v);
        };
        const diff = [];
        const walkDiff = (a, b, path) => {
          const aObj = a && typeof a === 'object' && !Array.isArray(a), bObj = b && typeof b === 'object' && !Array.isArray(b);
          if (aObj || bObj) {
            const keys = new Set([...(aObj ? Object.keys(a) : []), ...(bObj ? Object.keys(b) : [])]);
            keys.forEach(k => walkDiff(aObj ? a[k] : undefined, bObj ? b[k] : undefined, [...path, k]));
            return;
          }
          if (JSON.stringify(canonical(a)) !== JSON.stringify(canonical(b))) diff.push([...path]);
        };
        walkDiff(saved, draft, []);
        if (!diff.length) { setMessage('当前配置与已保存内容一致，无需保存'); toast('没有需要保存的修改', 'ok'); setBusy(false); return; }
        const lines = diff.slice(0, 20).map(p => {
          const name = p.map(k => CN_KEY[k] != null ? CN_KEY[k] : k).join('·');
          return `· ${name}：${fmtVal(get(saved, p), p)} → ${fmtVal(get(draft, p), p)}`;
        });
        if (diff.length > 20) lines.push(`……等共 ${diff.length} 处修改`);
        if (!confirm('本次保存将修改以下 ' + diff.length + ' 处配置：\n\n' + lines.join('\n') + '\n\n确认保存？（保存后对之后新生成的文档生效）')) { setBusy(false); setMessage('已取消保存'); return; }
        const submitted = copy(draft);
        setUnconfirmed(true); setBusy(true); setMessage('正在保存…');
        try {
          const r = await fetch(PREFIX + '/report-format', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(submitted) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
          // 重新读取服务端实际保存值，确认保存结果。
          const reread = await fetch(PREFIX + '/report-format', { cache: 'no-store' });
          const actual = await reread.json().catch(() => null);
          if (!reread.ok || !actual || typeof actual !== 'object' || Array.isArray(actual) || actual.error) throw new Error('提交成功，但回读失败，请重新读取确认');
          if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(submitted))) throw new Error('提交成功，但回读配置与提交内容不一致；草稿已保留，请重新核对');
          setSaved(copy(actual)); setDraft(copy(actual)); setNumberInputs({}); setUnconfirmed(false); setMessage('已保存并回读确认'); toast('报告格式已保存', 'ok');
        } catch (e) { const m = '保存或确认失败：' + ((e && e.message) || e); setMessage(m); toast(m, 'danger'); }
        finally { setBusy(false); }
      };
      const groups = [['cover_title', '封面标题'], ['cover_docno', '封面文号'], ['heading1', '一级标题'], ['heading2', '二级标题'], ['heading3', '三级标题'], ['heading4', '四级标题'], ['body', '正文'], ['table', '表格']];
      const PARA_GROUPS = ['heading1', 'heading2', 'heading3', 'heading4', 'body'];
      // 段落设置（契约 v2）：仅 body 与标题1..4；倍数行距与固定磅值互斥，两者同填由后端拒绝。
      const paraField = (label, path, hint) => {
        const value = get(draft, path), id = path.join('.');
        const numeric = !!value || value === 0;
        const shown = numeric && Object.prototype.hasOwnProperty.call(numberInputs, id) ? numberInputs[id]
          : value == null ? '' : String(value);
        return h('label', { key: id, style: { display: 'block', width: '100%' } },
          label ? h('span', { className: 'wb-label' }, label) : null,
          h('input', { className: 'wb-input', style: { width: '100%' }, type: 'text', inputMode: 'decimal', value: shown, placeholder: hint || '未设置',
            onChange: e => {
              const raw = e.target.value;
              if (!raw.trim()) { change(path, '', false); return; }
              if (!/^(?:\d+\.?\d*|\.\d+)$/.test(raw)) { setMessage('数值无效，修改尚未保存'); return; }
              const n = Number(raw);
              if (!Number.isFinite(n)) return;
              setNumberInputs(prev => ({ ...prev, [id]: raw }));
              change(path, path[path.length - 1] === 'line_multiple' ? n : Math.round(n), false);
            } }));
      };
      // 行距复合单元格：倍数预设下拉；选「固定值」后出现磅数输入（契约互斥语义）。
      const LINE_PRESETS = [['1', 1], ['1.15', 1.15], ['1.5', 1.5], ['2', 2], ['2.5', 2.5], ['3', 3]];
      const lineCell = key => {
        const para = get(draft, [key, 'paragraph']) || {};
        const lm = para.line_multiple, lp = para.line_points;
        const selValue = lm != null ? String(lm) : lp != null ? 'fixed' : '';
        const setPara = patch => {
          setDraft(prev => {
            const next = copy(prev);
            const obj = next[key] = next[key] || {};
            const p = obj.paragraph = obj.paragraph || {};
            delete p.line_multiple; delete p.line_points;
            Object.assign(p, patch);
            if (!Object.keys(p).length) delete obj.paragraph;
            return next;
          });
          setMessage('有未保存的修改');
        };
        return h('div', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
          h('select', { className: 'wb-select', style: { width: '100%', minWidth: 86 }, value: selValue, 'aria-label': '行距',
            onChange: e => { const v = e.target.value;
              if (v === '') setPara({});
              else if (v === 'fixed') setPara({ line_points: lp != null ? lp : 28 });
              else setPara({ line_multiple: Number(v) }); } },
            h('option', { value: '' }, '未设置'),
            LINE_PRESETS.map(([label, v]) => h('option', { key: label, value: String(v) }, v + ' 倍')),
            h('option', { value: 'fixed' }, '固定值')),
          selValue === 'fixed' ? h('input', { className: 'wb-input', style: { width: 58 }, type: 'text', inputMode: 'numeric', value: lp == null ? '' : String(lp), 'aria-label': '固定行距磅值',
            onChange: e => { const raw = e.target.value; if (!/^\d+$/.test(raw)) return; setPara({ line_points: Number(raw) }); } }) : null);
      };
      // 表格样式布局：每行一个类别，列头为字体/字号/行距/缩进/段前/段后。
      const TD_BASE = { padding: '4px 6px', verticalAlign: 'middle', borderBottom: '1px solid var(--dsw-alias-border-l1,#ddd)', whiteSpace: 'nowrap' };
      const fmtTable = h('div', { style: { overflowX: 'auto' } },
        h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12 } },
          h('thead', null, h('tr', null,
            ['类别', '字体', '西文字体（含数字）', '字号', '行距', '缩进（字符）', '段前（磅）', '段后（磅）'].map((t, i) => h('th', { key: t, style: { ...TD_BASE, textAlign: i ? 'left' : 'left', background: 'var(--dsw-alias-bg-layer-2,#f5f5f5)', color: 'var(--dsw-alias-label-secondary,#666)', fontWeight: 600, position: 'sticky', top: 0 } }, t)))),
          h('tbody', null, groups.map(([key, label]) => {
            const hasPara = PARA_GROUPS.includes(key);
            return h('tr', { key },
              h('td', { style: { ...TD_BASE, fontWeight: 600 } }, label),
              h('td', { style: TD_BASE }, fontField(null, [key, 'font'])),
              h('td', { style: TD_BASE }, hasPara
                ? fontField(null, [key, 'ascii_font'])
                : h('span', { style: { color: 'var(--dsw-alias-label-secondary,#999)' } }, key === 'table' ? '见下方表格设置' : '—')),
              h('td', { style: TD_BASE }, sizeField(null, [key, 'size_half_points'])),
              ...(hasPara ? [
                h('td', { key: 'line', style: TD_BASE }, lineCell(key)),
                h('td', { key: 'indent', style: TD_BASE }, paraField(null, [key, 'paragraph', 'first_line_indent_chars'], '如 2')),
                h('td', { key: 'before', style: TD_BASE }, paraField(null, [key, 'paragraph', 'space_before_points'])),
                h('td', { key: 'after', style: TD_BASE }, paraField(null, [key, 'paragraph', 'space_after_points'])),
              ] : [h('td', { key: 'np', colSpan: 4, style: { ...TD_BASE, color: 'var(--dsw-alias-label-secondary,#999)' } }, '—（该类别无段落设置）')]));
          }))));
      const borders = [['top', '上边框'], ['bottom', '下边框'], ['insideH', '内部横线'], ['insideV', '内部竖线']];
      return h(Section, { title: '报告说明格式' },
        h('p', { className: 'wb-hint' }, '配置从接口读取，字段可留空；保存会整体替换配置，仅对之后新生成的文档生效，不会修改既有文档。页面尺寸显示为毫米并取最近可表示值，字号按 0.5 磅、边框按 0.125 磅递增；具体效果以生成的报告为准。'),
        h('p', { className: 'wb-hint', role: 'note' }, '重要：该设置仅调整格式。现有生成器可能遗漏正文、表格、图片或变量，导出结果不等同于天源系统正式导出件；使用前须与正式导出件逐项核对。'),
        h('p', { className: 'wb-hint' }, '配置供本机 tycpv export-report-docx 生成器读取，工作台其他导出功能不受影响。若命令设置了 TYCPV_FORMAT_CONFIG 环境变量，将优先读取该变量指定的文件。'),
        h('div', { className: 'wb-row', style: { marginBottom: 14 } },
          h(Btn, { variant: 'pri', disabled: busy || !draft, onClick: save }, busy ? '处理中…' : '保存配置'),
          h(Btn, { disabled: busy || !saved, onClick: () => { if (dirty && !confirm('恢复上次会丢弃当前未保存或未确认的修改，继续吗？')) return; setDraft(copy(saved)); setNumberInputs({}); setUnconfirmed(false); setMessage('已恢复上次读取或保存的配置，尚未写入'); } }, '恢复上次'),
          h(Btn, { disabled: busy, onClick: () => { if (dirty && !confirm('重新读取会丢弃未保存或未确认的修改，继续吗？')) return; load(); } }, '重新读取'),
          h('span', { className: 'wb-hint', role: 'status' }, message)),
        draft && h('fieldset', { disabled: busy, style: { border: 0, padding: 0, margin: 0, minWidth: 0 } },
          h('h3', { style: { marginTop: 22 } }, '文字与段落设置'),
          h('div', { className: 'wb-hint' }, '字体与字号按 Word/WPS 习惯下拉选择；行距选「固定值」后填磅值；封面与表格无段落设置，缺省沿用官方默认。'),
          h('div', { className: 'wb-hint' }, '「西文字体（含数字）」决定这一段里的数字、英文字母用哪个字体。留空时跟随左侧中文字体——正文设宋体，数字就跟着宋体，不会再出现个别数字变成 Times New Roman 或 Calibri 的情况。表格不读这一列，它用下方「表格设置」里的西文字体。'),
          fmtTable,
          h('h3', { style: { marginTop: 22 } }, '表格设置'),
          h('p', { className: 'wb-hint' }, '表格各项均可独立设置；评估工具箱推荐值：宋体 + Times New Roman、五号、最小行高 0.6 厘米、重复标题行、上/下线 1.5 磅、内部线 0.5 磅。'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px 12px' } },
            h('div', { style: { flex: '1 1 200px' } }, fontField('西文字体（含数字）', ['table','ascii_font'], ['Times New Roman', 'Arial', 'Calibri', '宋体'])),
            h('div', { style: { flex: '0 1 150px' } }, field('最小行高（厘米）', ['table','min_row_height_twips'], 'cm', '如 0.6')),
            [['repeat_header','重复标题行'],['numeric_align_right','数字右对齐'],['clear_shading','清除底纹'],['autofit','自动适应'],['single_line','单倍行距']].map(([key, label]) =>
              h('div', { key, style: { flex: '1 1 150px' } }, booleanField(label, key)))),
          h('p', { className: 'wb-hint' }, '重复标题未设置时按首行是否全部为表头判断；自动适应和单倍行距关闭时不显式写入，沿用模板或 Word 继承。清除底纹选项当前不执行额外操作：本生成器原本不输出表格底纹，不能用于清除既有文档底纹。'),
          h('h3', { style: { marginTop: 22 } }, '表格边框'),
          h('div', { className: 'wb-hint' }, '宽度单位磅（0.125 磅递增）、间距为整数磅；颜色填 auto 或六位十六进制。'),
          h('div', { style: { overflowX: 'auto' } },
            h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12 } },
              h('thead', null, h('tr', null,
                ['边框', '宽度（磅）', '间距（磅）', '样式', '颜色'].map(t => h('th', { key: t, style: { ...TD_BASE, textAlign: 'left', background: 'var(--dsw-alias-bg-layer-2,#f5f5f5)', color: 'var(--dsw-alias-label-secondary,#666)', fontWeight: 600 } }, t)))),
              h('tbody', null, borders.map(([key, label]) => {
                const styleValue = get(draft, ['table', 'border', key, 'style']);
                return h('tr', { key },
                  h('td', { style: { ...TD_BASE, fontWeight: 600 } }, label),
                  h('td', { style: TD_BASE }, field(null, ['table', 'border', key, 'size'], 'borderPt')),
                  h('td', { style: TD_BASE }, field(null, ['table', 'border', key, 'space'], 'integer')),
                  h('td', { style: TD_BASE }, h('select', { className: 'wb-select', style: { width: '100%' }, value: styleValue == null ? '' : styleValue, 'aria-label': label + '样式',
                    onChange: e => { const v = e.target.value; change(['table', 'border', key, 'style'], v === '' ? '' : v, false); } },
                    h('option', { value: '' }, '未设置'),
                    ['single', 'double', 'dashed', 'dotted', 'nil', 'none'].map(s => h('option', { key: s, value: s }, s)))),
                  h('td', { style: TD_BASE }, field(null, ['table', 'border', key, 'color'], false, '如 000000')));
              })))),
          h('p', { className: 'wb-hint', style: { marginTop: 16 } }, '参考图中尚未支持：统一文字黑色、单元格垂直居中、标题加粗居中及左右边框独立设置。预设不会修改这些项，也不保证作用于所有嵌套表格。'),
          h('h3', { style: { marginTop: 22 } }, '页面设置（通常无需修改，纸张为预设的 A4）'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px 12px' } },
            [['width_twips','纸张宽度'],['height_twips','纸张高度'],['top_twips','上边距'],['right_twips','右边距'],['bottom_twips','下边距'],['left_twips','左边距']].map(([k, label]) =>
              h('div', { key: k, style: { flex: '1 1 150px' } }, field(label + '（毫米）', ['page', k], 'mm')))),
          h('details', { style: { marginTop: 14 } }, h('summary', null, '配置预览（当前草稿 JSON）'), h('pre', { style: { overflow: 'auto', padding: 12, background: 'var(--wb-surface-2)', borderRadius: 8, fontSize: 11 } }, JSON.stringify(draft, null, 2)))
        )
      );
    }

    // ---------- 土地市场法作业页（iframe 承载独立页面，由 land-market 插件提供 API） ----------
    function LandMarketPanel() {
      const [reloadKey, setReloadKey] = useState(0);
      const [ping, setPing] = useState('checking'); // checking | ok | down
      useEffect(() => {
        let alive = true;
        fetch('/api/land-market/health').then(r => {
          if (alive) setPing(r.ok ? 'ok' : 'down');
        }).catch(() => { if (alive) setPing('down'); });
        return () => { alive = false; };
      }, [reloadKey]);
      const src = '/api/land-market/app' + (reloadKey ? '?r=' + reloadKey : '');
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, height: 'calc(100vh - 220px)', minHeight: 520 } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
          h('div', { style: { fontSize: 12.5, color: 'var(--wb-text-2, #5b6675)' } },
            '土地使用权市场比较法作业页 · 引擎唯一母版生成 · 六项质量门禁 · 预览/生产双模式',
            ping === 'down' ? ' — 后端未连通（land-market 插件未加载，重启 App 后生效）' : '')),
        h('iframe', {
          key: reloadKey,
          src,
          title: '土地市场法作业页',
          style: {
            flex: '1 1 auto', width: '100%', border: '1px solid var(--wb-border, #dfe3e9)',
            borderRadius: 10, background: '#fff',
          },
        }));
    }

    // ---------- main page ----------
    // ---------- 数据工具（2026-11-19 移植自评估工具箱一期模块） ----------
    // 宿主路由：/api/workbench/dt/*（@local/dsh-data-tools，index.js DT_REV）
    const DT_PREFIX = PREFIX + '/dt';

    // ---- 参数持久化（等价工具箱 save*/reset*Params：存浏览器本地，跨会话保留） ----
    function dtLoadParams(key, defaults) {
      try {
        const raw = window.localStorage.getItem('dt.params.' + key);
        if (!raw) return { ...defaults };
        const saved = JSON.parse(raw);
        return (saved && typeof saved === 'object') ? { ...defaults, ...saved } : { ...defaults };
      } catch { return { ...defaults }; }
    }
    function dtSaveParams(key, value) {
      try { window.localStorage.setItem('dt.params.' + key, JSON.stringify(value)); return true; }
      catch { return false; }
    }
    function dtResetParams(key) {
      try { window.localStorage.removeItem('dt.params.' + key); } catch { /* ignore */ }
    }
    // 模块级「保存参数 / 重置参数」按钮组
    function DtParamButtons({ paramKey, snapshot, defaults, onApply, toast }) {
      return h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
        h('button', { className: 'wb-btn sm', onClick: () => {
          if (dtSaveParams(paramKey, snapshot)) toast('参数已保存');
          else toast('参数保存失败（本地存储不可用）', 'warn');
        } }, '保存参数'),
        h('button', { className: 'wb-btn sm', onClick: () => {
          dtResetParams(paramKey);
          if (onApply) onApply({ ...defaults });
          toast('已恢复默认参数');
        } }, '重置参数'));
    }

    const DT_REV = 'rev24';
    // 数据工具的统一取数：宿主未注册该路由时会返回纯文本 "not found"，
    // 直接 r.json() 会抛 Unexpected token 'o'。这里把非 JSON 响应转成可读错误，
    // 页面显示「宿主路由未就绪」而不是一句 JSON 解析异常。
    async function dtJson(url, init) {
      const r = await fetch(url, init);
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : {}; } catch (_) { data = null; }
      if (data === null) {
        throw new Error('宿主未返回 JSON（HTTP ' + r.status + '）：' + String(text || '').trim().slice(0, 160));
      }
      return { r, d: data };
    }
    // DSH 桌面壳原生目录选择（preload: __DSH_DIRECTORY_PICKER__），uiWorkspace 不可用时兜底
    function dtPickDirectory() {
      try {
        if (window.__DSH_DIRECTORY_PICKER__ && typeof window.__DSH_DIRECTORY_PICKER__.pick === 'function') {
          return Promise.resolve(window.__DSH_DIRECTORY_PICKER__.pick());
        }
      } catch (_) { /* fallthrough */ }
      return Promise.resolve(null);
    }
    function DtDirectoryField({ value, onChange, placeholder, disabled }) {
      const [picking, setPicking] = useState(false);
      const pick = async () => {
        if (picking || disabled) return;
        setPicking(true);
        try {
          const path = await dtPickDirectory();
          if (path && typeof path === 'string') onChange(path);
        } finally { setPicking(false); }
      };
      return h('div', { style: { display: 'flex', gap: 6, width: '100%' } },
        h('input', { className: 'wb-input', style: { flex: 1, fontFamily: 'Menlo, monospace', fontSize: 11 }, value, placeholder: placeholder || '点击「选择目录」或粘贴路径', readOnly: false, onChange: e => onChange(e.target.value) }),
        h('button', { className: 'wb-btn sm', onClick: pick, disabled: picking || disabled, title: '选择目录' }, picking ? '…' : '选择目录'));
    }
    function DataTools({ toast }) {
      const [sub, setSubRaw] = useState(() => {
        try { return (s.settings.ui && s.settings.ui.subs && s.settings.ui.subs['data-tools']) || 'land'; } catch (e) { return 'land'; }
      }); // land | anjuke | map | batch | dep | auction | lease
      const setSub = v => { setSubRaw(v); patch('settings', x => ({ ...x, ui: { ...(x.ui || {}), subs: { ...((x.ui && x.ui.subs) || {}), 'data-tools': v } } })); };
      const [catalog, setCatalog] = useState(null);
      useEffect(() => {
        // 行政区目录：宿主 china-regions.cjs 一次性注入（缓存）
        if (window.__DT_REGION_CATALOG__) return;
        dtJson(DT_PREFIX + '/regions').then(({ d }) => {
          if (Array.isArray(d.catalog)) { window.__DT_REGION_CATALOG__ = d.catalog; setCatalog(d.catalog); }
        }).catch(() => {});
      }, []);
      const subTabs = [
        ['land', '浙江土地市场网'], ['auction', '阿里司法拍卖'], ['lease', '阿里资产租赁'],
        ['anjuke', '安居客数据'], ['map', '地图基础配置'], ['batch', '表格与底稿工具'], ['dep', '折旧摊销预测'],
      ];
      return h('div', { className: 'wb-card', style: { padding: 16 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
          h('h2', { style: { margin: 0, fontSize: 16, fontWeight: 650 } }, '数据工具'),
          h('span', { className: 'wb-hint' }, '移植自评估工具箱 · rev ' + DT_REV)),
        h('div', { className: 'wb-tabs', style: { margin: '10px 0 4px' } },
          subTabs.map(([k, t]) => h('button', { key: k, className: 'wb-tab ' + (sub === k ? 'on' : ''), onClick: () => setSub(k) }, t))),
        sub === 'land' ? h(DataToolsLand, { toast, openMapSub: () => setSub('map') }) :
          sub === 'auction' ? h(DataToolsAuction, { toast }) :
          sub === 'lease' ? h(DataToolsLease, { toast }) :
          sub === 'anjuke' ? h(DataToolsAnjuke, { toast }) :
          sub === 'batch' ? h(DataToolsBatch, { toast }) :
          sub === 'dep' ? h(DataToolsDep, { toast }) :
          h(DataToolsMap, { toast }));
    }

    // 进度与结果区（土地/安居客共用）
    function DataToolsProgress({ task, onOpen }) {
      if (!task) return h('p', { className: 'wb-hint' }, '尚未运行');
      const running = task.status === 'running';
      const lastProgress = (task.progress || []).filter(p => p.kind === 'progress').slice(-1)[0];
      const msg = task.message || (lastProgress && lastProgress.message) || '';
      const fetched = Number((lastProgress && (lastProgress.fetched != null ? lastProgress.fetched : lastProgress.fetchedCount)) || 0);
      const written = Number((lastProgress && (lastProgress.written != null ? lastProgress.written : lastProgress.writtenCount)) || (task.result && (task.result.writtenCount != null ? task.result.writtenCount : task.result.caseCount)) || 0);
      const statusColor = running ? '#a35b00' : task.status === 'done' ? '#1b8a5a' : '#b63225';
      return h('div', null,
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', margin: '6px 0' } },
          h('span', { style: { fontSize: 11, padding: '1px 8px', borderRadius: 8, color: '#fff', background: statusColor } },
            running ? '运行中' : task.status === 'done' ? '完成' : '失败'),
          h('span', { style: { fontSize: 12 } }, task.percent + '%'),
          h('span', { className: 'wb-hint' }, msg || '')),
        h('div', { style: { height: 6, background: 'var(--wb-surface-2,#eef0f3)', borderRadius: 4, overflow: 'hidden' } },
          h('div', { style: { height: '100%', width: Math.max(2, Math.min(100, task.percent || 0)) + '%', background: task.status === 'failed' ? '#c0392b' : '#1d4ed8', transition: 'width .4s' } })),
        h('div', { style: { display: 'flex', gap: 16, margin: '8px 0', fontSize: 12, flexWrap: 'wrap' } },
          h('span', null, '已抓取 ', h('strong', null, fetched)),
          h('span', null, '已写出 ', h('strong', null, written)),
          task.error ? h('span', { style: { color: 'var(--wb-danger-ink,#b63225)' } }, task.error) : null),
        onOpen && task.status === 'done' ? h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', margin: '6px 0' } }, onOpen(task)) : null,
        task.progress && task.progress.length ? h('details', { style: { marginTop: 6 } },
          h('summary', { className: 'wb-hint', style: { cursor: 'pointer' } }, '进度日志（最近 ' + task.progress.length + ' 条）'),
          h('pre', { style: { overflow: 'auto', maxHeight: 160, padding: 8, background: 'var(--wb-surface-2)', borderRadius: 6, fontSize: 11, whiteSpace: 'pre-wrap' } },
            task.progress.map((p, i) => { const line = p.kind === 'progress' ? (p.message || '') : p.kind === 'stderr' ? ('[stderr] ' + (p.text || '')) : '[' + p.kind + ']'; return '[' + String(p.at || '').slice(11, 19) + '] ' + line; }).join('\n'))) : null);
    }

    function dtOpenButtons(paths) {
      // paths: [{ label, path, reveal? }]
      return (paths || []).filter(p => p.path).map((p, i) =>
        h('button', { key: i, className: 'wb-btn sm', onClick: async () => {
          try {
            const r = await fetch(DT_PREFIX + '/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p.path, reveal: !!p.reveal }) });
            const d = await r.json().catch(() => ({}));
            if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
          } catch (e) { alert('打开失败：' + ((e && e.message) || e)); }
        } }, p.label));
    }

    // 打开数据来源页（宿主只放行白名单域名）
    async function dtOpenUrl(url, askHost) {
      const u = String(url || '').trim();
      if (!/^https:/i.test(u)) { alert('来源页地址无效：' + (u || '(空)')); return; }
      try {
        const r = await fetch(DT_PREFIX + '/open-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: u }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
      } catch (e) { alert('打开来源页失败：' + ((e && e.message) || e)); }
    }

    // 按当前筛选条件取来源页 URL 并打开（拍卖/租赁）
    async function dtOpenSourceFor(mod, request) {
      try {
        const r = await fetch(DT_PREFIX + '/source-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mod, request }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.ok === false || !d.url) throw new Error(d.error || '未取到来源地址');
        await dtOpenUrl(d.url);
      } catch (e) { alert('打开来源页失败：' + ((e && e.message) || e)); }
    }

    // ---- 子面板一：浙江土地市场网 ----
    function DataToolsLand({ toast, openMapSub }) {
      const [regions, setRegions] = useState(null);          // [{code,name,children}]
      const [regionErr, setRegionErr] = useState('');
      const LAND_DEFAULTS = { district: '', county: '', location: '', dateStart: '', dateEnd: '', landUses: [], generateMap: true, maxPages: '200', outputDir: '' };
      const landSavedRef = useRef(null);
      if (!landSavedRef.current) landSavedRef.current = dtLoadParams('land', LAND_DEFAULTS);
      const lSaved = landSavedRef.current;
      const [district, setDistrict] = useState(lSaved.district || '');
      const [county, setCounty] = useState(lSaved.county || '');
      // 兼容旧版保存的地市代码（如 330200）：runner 按城市名匹配，旧代码值会导致全区县被过滤为 0
      const savedDistrictIsCode = /^\d{6}$/.test(lSaved.district || '');
      const [location, setLocation] = useState(lSaved.location || '');
      const [dateStart, setDateStart] = useState(lSaved.dateStart || '');
      const [dateEnd, setDateEnd] = useState(lSaved.dateEnd || '');
      const [landUses, setLandUses] = useState(Array.isArray(lSaved.landUses) ? lSaved.landUses : []);
      const [generateMap, setGenerateMap] = useState(lSaved.generateMap !== false);
      const [maxPages, setMaxPages] = useState(lSaved.maxPages || '200');
      const [outputDir, setOutputDir] = useState(lSaved.outputDir || '');
      const applyLandDefaults = (next) => {
        setDistrict(next.district || ''); setCounty(next.county || ''); setLocation(next.location || '');
        setDateStart(next.dateStart || ''); setDateEnd(next.dateEnd || '');
        setLandUses(Array.isArray(next.landUses) ? next.landUses : []);
        setGenerateMap(next.generateMap !== false); setMaxPages(next.maxPages || '200'); setOutputDir(next.outputDir || '');
      };
      const [task, setTask] = useState(null);
      const [busy, setBusy] = useState(false);
      const [paused, setPaused] = useState(false);
      const pollRef = useRef(null);

      const loadRegions = useCallback(async () => {
        setRegionErr('');
        try {
          const { r, d } = await dtJson(DT_PREFIX + '/land/regions', { cache: 'no-store' });
          if (!d.ok) throw new Error(d.error || d.reason || ('HTTP ' + r.status));
          setRegions(d.regions || []);
        } catch (e) { setRegionErr('行政区加载失败：' + ((e && e.message) || e) + '（可点"刷新行政区"重试）'); }
      }, []);
      useEffect(() => { loadRegions(); }, [loadRegions]);

      // 轮询任务状态
      useEffect(() => {
        if (!busy) return undefined;
        pollRef.current = setInterval(async () => {
          try {
            const { d } = await dtJson(DT_PREFIX + '/land/status', { cache: 'no-store' });
            const t = d.task;
            if (t) {
              setTask(t);
              if (t.status !== 'running') {
                setBusy(false);
                setPaused(false);
                toast(t.status === 'done' ? '土地抓取完成' : '土地抓取失败：' + (t.error || t.message || ''), t.status === 'done' ? undefined : 'danger');
              }
            }
          } catch { /* 网络抖动下一轮再试 */ }
        }, 1500);
        return () => clearInterval(pollRef.current);
      }, [busy, toast]);

      // 官网行政区接口顶层是「浙江省」本身，children 才是 11 个地市；这里摊平一层
      const cities = useMemo(() => {
        const list = regions || [];
        const province = list.length === 1 && (list[0].children || []).length ? list[0] : null;
        return province ? (province.children || []) : list;
      }, [regions]);
      const districtObj = useMemo(() => cities.find(r => r.code === district || r.name === district), [cities, district]);
      const counties = (districtObj && districtObj.children) || [];
      // 旧版把地市代码（330200）存进参数：加载行政区后换回城市名，避免 select 空显 + runner 全过滤
      useEffect(() => {
        if (/^\d{6}$/.test(district)) {
          const match = cities.find(r => r.code === district);
          if (match) setDistrict(match.name);
        }
      }, [cities, district]);

      const run = async () => {
        if (busy) return;
        // 输出目录留空交给宿主落到默认目录（~/Documents/天源评估/个人工作台/数据工具输出/浙江土地成交公示）
        setBusy(true);
        setPaused(false);
        try {
          const body = {
            district, county, location,
            startDate: dateStart, endDate: dateEnd,
            landUses, generateMap,
            maxPages: Number(maxPages) || 200,
            outputDirectory: outputDir.trim(),
            provinceWide: !district && !county && !location.trim(),
          };
          const r = await fetch(DT_PREFIX + '/land/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || d.msg || ('HTTP ' + r.status));
          toast('已启动土地抓取任务');
        } catch (e) {
          setBusy(false);
          toast('启动失败：' + ((e && e.message) || e), 'danger');
        }
      };
      const stop = async () => {
        try { await fetch(DT_PREFIX + '/land/stop', { method: 'POST' }); toast('已请求终止任务'); } catch { /* noop */ }
        setPaused(false);
      };
      const togglePause = async () => {
        const action = paused ? 'resume' : 'pause';
        try {
          const r = await fetch(DT_PREFIX + '/land/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
          setPaused(action === 'pause');
          toast(action === 'pause' ? '已暂停；点「继续采集」恢复' : '已继续采集');
        } catch (e) { toast((action === 'pause' ? '暂停失败：' : '继续失败：') + ((e && e.message) || e), 'warn'); }
      };

      const resultButtons = (t) => {
        const res = t.result || {};
        const paths = [
          { label: '打开 Excel', path: res.excelPath },
          { label: '打开结果页', path: res.htmlPath },
          { label: '查看地图', path: res.mapPath },
          { label: '打开输出目录', path: res.outputDirectory || outputDir, reveal: false },
        ];
        return dtOpenButtons(paths);
      };

      return h('div', { style: { display: 'grid', gap: 14, marginTop: 8 } },
        h('div', { className: 'wb-alert', style: { fontSize: 12 } }, '交易条件固定为：国有土地 · 挂牌出让/拍卖出让 · 结果公示。行政区与查询日期直接用于官网列表查询；未选行政区且未填关键词时按全省查询。'),
        // 行政区
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' } },
          h('label', { className: 'wb-label', style: { flex: '1 1 180px' } }, '地市',
            h('select', { className: 'wb-select', style: { width: '100%' }, value: district, onChange: e => { setDistrict(e.target.value); setCounty(''); } },
              h('option', { value: '' }, cities.length ? '全省（不限地市）' : '加载中…'),
              // 与工具箱一致：提交城市名（runner CITY_CODE_PREFIXES 按名建键），不传代码
              cities.map(r => h('option', { key: r.code, value: r.name }, r.name)))),
          h('label', { className: 'wb-label', style: { flex: '1 1 180px' } }, '区县',
            h('select', { className: 'wb-select', style: { width: '100%' }, value: county, disabled: !counties.length, onChange: e => setCounty(e.target.value) },
              h('option', { value: '' }, counties.length ? '全区县（不限）' : '请先选择地市'),
              counties.map(c => h('option', { key: c.code, value: c.name }, c.name)))),
          h('label', { className: 'wb-label', style: { flex: '2 1 240px' } }, '位置关键词（可选）',
            h('input', { className: 'wb-input', style: { width: '100%' }, value: location, maxLength: 160, placeholder: '例如：街道、村、道路或交叉口', onChange: e => setLocation(e.target.value) })),
          h('button', { className: 'wb-btn sm', onClick: loadRegions, disabled: busy }, '刷新行政区'),
          openMapSub ? h('button', { className: 'wb-btn sm', onClick: openMapSub }, '地图配置') : null,
          h('button', { className: 'wb-btn sm', onClick: () => { setDistrict(''); setCounty(''); setLocation(''); setDateStart(''); setDateEnd(''); setLandUses([]); }, disabled: busy }, '清空筛选')),
        regionErr ? h('p', { className: 'wb-hint', style: { color: 'var(--wb-danger-ink,#b63225)' } }, regionErr) : null,
        // 日期 + 用途
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' } },
          h('label', { className: 'wb-label' }, '报价开始日期（起）', h('input', { className: 'wb-input', type: 'date', value: dateStart, onChange: e => setDateStart(e.target.value) })),
          h('label', { className: 'wb-label' }, '报价开始日期（止）', h('input', { className: 'wb-input', type: 'date', value: dateEnd, onChange: e => setDateEnd(e.target.value) })),
          h('label', { className: 'wb-label' }, '最大页数', h('input', { className: 'wb-input', style: { width: 90 }, inputMode: 'numeric', value: maxPages, onChange: e => setMaxPages(e.target.value.replace(/\D/g, '')) }))),
        h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 } },
          ['住宅用地', '商服用地', '工矿仓储', '其他用地'].map(u =>
            h('label', { key: u, style: { display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' } },
              h('input', { type: 'checkbox', checked: landUses.includes(u), onChange: e => setLandUses(prev => e.target.checked ? [...prev, u] : prev.filter(x => x !== u)) }), u)),
          h('label', { style: { display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: generateMap, onChange: e => setGenerateMap(e.target.checked) }), '生成独立地图 HTML')),
        // 输出目录
        h('label', { className: 'wb-label' }, '输出目录（须已存在；默认：~/Documents/天源评估/个人工作台/数据工具输出/浙江土地成交公示）',
          h(DtDirectoryField, { value: outputDir, onChange: setOutputDir, placeholder: '留空使用默认目录' })),
        // 动作
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { className: 'wb-btn', onClick: run, disabled: busy }, busy ? '任务进行中…' : '开始网络抓取'),
          h(DtParamButtons, {
            paramKey: 'land',
            snapshot: { district, county, location, dateStart, dateEnd, landUses, generateMap, maxPages, outputDir },
            defaults: LAND_DEFAULTS,
            onApply: applyLandDefaults,
            toast,
          }),
          busy ? h('button', { className: 'wb-btn sm', onClick: togglePause }, paused ? '继续采集' : '暂停采集') : null,
          busy ? h('button', { className: 'wb-btn sm', onClick: stop }, '终止任务') : null),
        h('div', { className: 'wb-card', style: { padding: 12, background: 'var(--wb-surface-2)' } },
          h('h3', { style: { margin: '0 0 6px', fontSize: 13 } }, '当前任务进度与结果'),
          h(DataToolsProgress, { task, onOpen: resultButtons })),
        h(DtHistoryPanel, {
            kind: 'land',
            directory: (task && task.result && task.result.outputDirectory) || outputDir.trim(),
            toast,
            // 等价工具箱 runLandPublicityHistory：带 historyPath 重新抓取（只刷新详情，不重扫列表）
            onRerun: async ({ path: historyPath, request: histReq, historyRefresh: allowRefresh }) => {
              if (busy) return;
              setBusy(true);
              setPaused(false);
              try {
                const hDistrict = String(histReq.district || histReq.city || '').trim();
                const hCounty = String(histReq.county || '').trim();
                const hLocation = String(histReq.location || '').trim();
                // runner 前置校验：district/county/location 全空时必须显式 provinceWide，否则报
                // LAND_DISTRICT_OR_LOCATION_REQUIRED（历史里「全省」查询的 district/county 都是空）
                const needProvinceWide = !hDistrict && !hCounty && !hLocation;
                const body = {
                  district: hDistrict, county: hCounty,
                  location: hLocation,
                  startDate: histReq.startDate || '', endDate: histReq.endDate || '',
                  landUses: Array.isArray(histReq.landUses) ? histReq.landUses : [],
                  generateMap: true,
                  provinceWide: needProvinceWide || histReq.provinceWide === true,
                  outputDirectory: outputDir.trim(),
                  historyPath,
                  historyRefresh: allowRefresh !== false,
                };
                const r = await fetch(DT_PREFIX + '/land/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                const d = await r.json().catch(() => ({}));
                if (!r.ok || !d.ok) throw new Error(d.error || d.msg || ('HTTP ' + r.status));
                toast('已按历史记录重新抓取详情');
              } catch (e) { setBusy(false); toast('历史重跑失败：' + ((e && e.message) || e), 'danger'); }
            },
          }));
    }

    /** 导入当前网址：读取本机浏览器活动标签页（安居客列表页）。 */
    async function dtImportCurrentUrl(host) {
      const r = await fetch(DT_PREFIX + '/current-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: host || 'anjuke.com' }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.msg || d.error || ('HTTP ' + r.status));
      return d.url;
    }

    // ---- 子面板二：安居客数据 ----
    function DataToolsAnjuke({ toast }) {
      const ANJUKE_DEFAULTS = { sourceUrl: '', caseType: 'auto', maxCases: '10', keyword: '', waitVerification: true, screenshot: false, autoOpenResult: true, browserEngine: 'opencli', outputDir: '' };
      const anjukeSavedRef = useRef(null);
      if (!anjukeSavedRef.current) anjukeSavedRef.current = dtLoadParams('anjuke', ANJUKE_DEFAULTS);
      const aSaved = anjukeSavedRef.current;
      const [sourceUrl, setSourceUrl] = useState(aSaved.sourceUrl || '');
      const [caseType, setCaseType] = useState(aSaved.caseType || 'auto');
      const [maxCases, setMaxCases] = useState(aSaved.maxCases || '10');
      const [keyword, setKeyword] = useState(aSaved.keyword || '');
      const [waitVerification, setWaitVerification] = useState(aSaved.waitVerification !== false);
      const [screenshot, setScreenshot] = useState(aSaved.screenshot === true);
      // 等价工具箱 anjukePropertyAutoOpenResult（默认 true）
      const [autoOpenResult, setAutoOpenResult] = useState(aSaved.autoOpenResult !== false);
      // 抓取引擎：opencli = 复用用户已登录的真实 Chrome（默认，最不易触发验证码）；
      // playwright = 早期实现，起一个独立的受控浏览器（新身份，容易被安居客判爬虫）
      const [browserEngine, setBrowserEngine] = useState(aSaved.browserEngine === 'playwright' ? 'playwright' : 'opencli');
      const [outputDir, setOutputDir] = useState(aSaved.outputDir || '');
      const applyAnjukeDefaults = (next) => {
        setSourceUrl(next.sourceUrl || ''); setCaseType(next.caseType || 'auto');
        setMaxCases(next.maxCases || '10'); setKeyword(next.keyword || '');
        setWaitVerification(next.waitVerification !== false); setScreenshot(next.screenshot === true);
        setAutoOpenResult(next.autoOpenResult !== false);
        setBrowserEngine(next.browserEngine === 'playwright' ? 'playwright' : 'opencli');
        setOutputDir(next.outputDir || '');
      };
      const [task, setTask] = useState(null);
      const [busy, setBusy] = useState(false);
      const [paused, setPaused] = useState(false);

      useEffect(() => {
        if (!busy) return undefined;
        const t = setInterval(async () => {
          try {
            const { d } = await dtJson(DT_PREFIX + '/anjuke/status', { cache: 'no-store' });
            if (d.task) {
              setTask(d.task);
              if (d.task.status !== 'running') {
                setBusy(false);
                setPaused(false);
                toast(d.task.status === 'done' ? '安居客采集完成' : '安居客采集失败：' + (d.task.error || d.task.message || ''), d.task.status === 'done' ? undefined : 'danger');
                // 等价工具箱 anjukePropertyAutoOpenResult：完成后自动用默认程序打开结果页
                const autoPath = d.task.result && d.task.result.resultHtmlPath;
                if (autoOpenResult && d.task.status === 'done' && autoPath) {
                  fetch(DT_PREFIX + '/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: autoPath }) }).catch(() => {});
                }
              }
            }
          } catch { /* 下一轮再试 */ }
        }, 1500);
        return () => clearInterval(t);
      }, [busy, toast]);

      const run = async () => {
        if (busy) return;
        const url = sourceUrl.trim();
        if (!url) { toast('请填写安居客列表页或详情页 URL', 'warn'); return; }
        setBusy(true);
        setPaused(false);
        try {
          const isDetail = /anjuke\.com\/.+\/\d+\/?/.test(url) && !/sp-shou|sp-zu|sp-rent|xzl-shou|xzl-zu/.test(url);
          const body = {
            caseType, keyword,
            maxCases: Number(maxCases) || 10,
            waitVerification,
            screenshot,
            autoOpenResult,
            browserEngine,
            outputDirectory: outputDir.trim(),
            [isDetail ? 'detailUrls' : 'listUrls']: [url],
          };
          const r = await fetch(DT_PREFIX + '/anjuke/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || d.msg || ('HTTP ' + r.status));
          toast('已启动安居客采集任务');
        } catch (e) {
          setBusy(false);
          toast('启动失败：' + ((e && e.message) || e), 'danger');
        }
      };
      const stop = async () => {
        try { await fetch(DT_PREFIX + '/anjuke/stop', { method: 'POST' }); toast('已请求终止任务'); } catch { /* noop */ }
        setPaused(false);
      };
      const togglePause = async () => {
        const action = paused ? 'resume' : 'pause';
        try {
          const r = await fetch(DT_PREFIX + '/anjuke/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
          setPaused(action === 'pause');
          toast(action === 'pause' ? '已暂停；点「继续采集」恢复' : '已继续采集');
        } catch (e) { toast((action === 'pause' ? '暂停失败：' : '继续失败：') + ((e && e.message) || e), 'warn'); }
      };

      const resultButtons = (t) => {
        const res = t.result || {};
        const paths = [
          { label: '打开 Excel', path: res.excelPath },
          { label: '打开 CSV', path: res.csvPath },
          { label: '打开结果页', path: res.resultHtmlPath },
          { label: '查看地图', path: res.mapPath },
          { label: '打开输出目录', path: res.outputDirectory || outputDir, reveal: false },
        ];
        return dtOpenButtons(paths);
      };

      return h('div', { style: { display: 'grid', gap: 14, marginTop: 8 } },
        h('div', { className: 'wb-alert', style: { fontSize: 12 } }, '通过本机 Playwright + Chrome 打开安居客页面采集出售/租赁案例；首次运行会启动受控浏览器，如遇验证码请在弹出的浏览器窗口中人工完成。列表页须为带明确区域条件的出售/租赁列表（如 https://hz.sydc.anjuke.com/sp-shou/xihu/）。'),
        h('label', { className: 'wb-label' }, '来源 URL（列表页或详情页）',
          h('div', { style: { display: 'flex', gap: 8 } },
            h('input', { className: 'wb-input', style: { flex: 1 }, value: sourceUrl, placeholder: '例如 https://hz.sydc.anjuke.com/sp-shou/xihu/ 或某案例详情页', onChange: e => setSourceUrl(e.target.value) }),
            h('button', { className: 'wb-btn sm', onClick: async () => {
              try {
                const url = await dtImportCurrentUrl('anjuke.com');
                setSourceUrl(url);
                toast('已导入浏览器当前安居客页面：' + url);
              } catch (e) { toast('导入失败：' + ((e && e.message) || e), 'warn'); }
            }, disabled: busy }, '导入当前网址'),
            h('button', { className: 'wb-btn sm', onClick: () => dtOpenUrl(sourceUrl), disabled: !sourceUrl.trim() }, '打开来源页'))),
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' } },
          h('label', { className: 'wb-label' }, '案例类型',
            h('select', { className: 'wb-select', value: caseType, onChange: e => setCaseType(e.target.value) },
              h('option', { value: 'auto' }, '自动识别'),
              h('option', { value: 'sale' }, '出售'),
              h('option', { value: 'rent' }, '租赁'))),
          h('label', { className: 'wb-label' }, '最多案例数',
            h('input', { className: 'wb-input', style: { width: 90 }, inputMode: 'numeric', value: maxCases, onChange: e => setMaxCases(e.target.value.replace(/\D/g, '')) })),
          h('label', { className: 'wb-label', style: { flex: '1 1 200px' } }, '关键词过滤（可选）',
            h('input', { className: 'wb-input', style: { width: '100%' }, value: keyword, maxLength: 60, onChange: e => setKeyword(e.target.value) }))),
        h('label', { className: 'wb-label', style: { maxWidth: 320 }, title: 'opencli 直接驱动你已登录的真实 Chrome，无需另开浏览器；Playwright 会启动一个独立的受控浏览器' }, '抓取引擎',
          h('select', { className: 'wb-select', value: browserEngine, onChange: e => setBrowserEngine(e.target.value) },
            h('option', { value: 'opencli' }, 'opencli（真实 Chrome，推荐）'),
            h('option', { value: 'playwright' }, '内置浏览器（Playwright）'))),
        h('div', { style: { display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' } },
          h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, cursor: 'pointer' }, title: '遇到验证码时轮询等待人工完成后继续，而不是直接判失败' },
            h('input', { type: 'checkbox', checked: waitVerification, onChange: e => setWaitVerification(e.target.checked) }), '遇到验证码等待人工完成'),
          h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, cursor: browserEngine === 'opencli' ? 'not-allowed' : 'pointer', opacity: browserEngine === 'opencli' ? 0.5 : 1 }, title: browserEngine === 'opencli' ? 'opencli 复用当前真实标签页，无法对他人标签页做全页截图；需要截图请切换到「内置浏览器」' : '为每个案例保存整页截图作为证据' },
            h('input', { type: 'checkbox', checked: screenshot && browserEngine !== 'opencli', disabled: browserEngine === 'opencli', onChange: e => setScreenshot(e.target.checked) }), '保存整页截图'),
          h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, cursor: 'pointer' }, title: '采集完成后自动用系统默认程序打开结果页' },
            h('input', { type: 'checkbox', checked: autoOpenResult, onChange: e => setAutoOpenResult(e.target.checked) }), '完成后自动打开结果页')),
        h('label', { className: 'wb-label' }, '输出目录（默认：~/Documents/天源评估/个人工作台/数据工具输出/安居客案例）',
          h(DtDirectoryField, { value: outputDir, onChange: setOutputDir, placeholder: '留空使用默认目录' })),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { className: 'wb-btn', onClick: run, disabled: busy }, busy ? '任务进行中…' : '开始采集'),
          h(DtParamButtons, {
            paramKey: 'anjuke',
            snapshot: { sourceUrl, caseType, maxCases, keyword, waitVerification, screenshot, autoOpenResult, browserEngine, outputDir },
            defaults: ANJUKE_DEFAULTS,
            onApply: applyAnjukeDefaults,
            toast,
          }),
          busy ? h('button', { className: 'wb-btn sm', onClick: togglePause }, paused ? '继续采集' : '暂停采集') : null,
          busy ? h('button', { className: 'wb-btn sm', onClick: stop }, '终止任务') : null),
        h('div', { className: 'wb-card', style: { padding: 12, background: 'var(--wb-surface-2)' } },
          h('h3', { style: { margin: '0 0 6px', fontSize: 13 } }, '当前任务进度与结果'),
          h(DataToolsProgress, { task, onOpen: resultButtons })));
    }

    // ---- 阿里司法拍卖（省市区联动 + 工具箱同款参数） ----
    // ---- 通用：运行历史（列出 outputDirectory 下的 *_history.json 并回载） ----
    function DtHistoryPanel({ directory, kind, toast, onLoaded, onRerun }) {
      const [items, setItems] = useState([]);
      const [sel, setSel] = useState('');
      const [busy, setBusy] = useState(false);
      const [loadedInfo, setLoadedInfo] = useState(null);
      // 等价工具箱 alibabaAuctionRefreshHistory：未勾选时重跑直接拒绝（桥内报 ALIBABA_HISTORY_REFRESH_REQUIRED）
      const [refreshHistory, setRefreshHistory] = useState(true);

      const refresh = useCallback(async () => {
        if (!directory) return;
        setBusy(true);
        try {
          const r = await fetch(DT_PREFIX + '/history/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directory, kind: kind || '' }) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
          setItems(d.items || []);
          if (d.items && d.items.length && !d.items.some(x => x.path === sel)) setSel(d.items[0].path);
        } catch (e) { toast('读取历史失败：' + ((e && e.message) || e), 'warn'); setItems([]); }
        finally { setBusy(false); }
      }, [directory, sel, toast]);

      useEffect(() => { refresh(); }, [directory]);

      const load = async () => {
        if (!sel) return;
        setBusy(true);
        try {
          const r = await fetch(DT_PREFIX + '/history/load', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: sel }) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
          setLoadedInfo(d);
          toast('已载入历史结果：' + ((d.results || []).length) + ' 条');
          if (onLoaded) onLoaded(d);
        } catch (e) { toast('载入历史失败：' + ((e && e.message) || e), 'danger'); }
        finally { setBusy(false); }
      };

      return h('div', { className: 'wb-card', style: { padding: 12, background: 'var(--wb-surface-2)', display: 'grid', gap: 8 } },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('h3', { style: { margin: 0, fontSize: 13 } }, '运行历史'),
          h('span', { className: 'wb-hint', style: { fontSize: 12 } }, directory || '（未设置输出目录）'),
          h('button', { className: 'wb-btn sm', onClick: refresh, disabled: busy || !directory }, '刷新历史')),
        items.length
          ? h('select', { className: 'wb-select', value: sel, onChange: e => setSel(e.target.value) },
              items.map(it => h('option', { key: it.path, value: it.path }, (it.label || it.name) + '（' + (it.recordCount || 0) + ' 条）')))
          : h('p', { className: 'wb-hint', style: { margin: 0, fontSize: 12 } }, busy ? '读取中…' : '该目录下暂无历史结果文件（*_history.json）。'),
        items.length ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('button', { className: 'wb-btn sm', onClick: load, disabled: busy }, '载入所选历史'),
          onRerun ? h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, cursor: 'pointer' }, title: '未勾选时只允许查看历史结果，不允许重新访问网络读取详情' },
            h('input', { type: 'checkbox', checked: refreshHistory, onChange: e => setRefreshHistory(e.target.checked) }), '允许访问网络重新读取历史详情') : null,
          onRerun ? h('button', { className: 'wb-btn sm', disabled: busy || !sel || !refreshHistory, onClick: async () => {
            if (!sel) return;
            setBusy(true);
            try {
              const r = await fetch(DT_PREFIX + '/history/load', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: sel }) });
              const d = await r.json().catch(() => ({}));
              if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
              await onRerun({ path: sel, request: d.request || {}, historyRefresh: refreshHistory });
            } catch (e) { toast('历史重跑失败：' + ((e && e.message) || e), 'danger'); }
            finally { setBusy(false); }
          } }, '用此历史重新抓取') : null,
          loadedInfo ? h('span', { className: 'wb-hint', style: { fontSize: 12 } }, '已载入 ' + ((loadedInfo.results || []).length) + ' 条') : null,
          loadedInfo ? dtOpenButtons([
            { label: '打开历史结果页', path: loadedInfo.htmlPath },
            { label: '查看历史地图', path: loadedInfo.mapPath },
          ]) : null) : null);
    }

    function DtRegionSelects({ catalog, region, setRegion }) {
      const provinces = catalog || [];
      const province = provinces.find(p => p.code === region.provinceCode);
      const cities = (province && province.children) || [];
      const city = cities.find(c => c.code === region.cityCode);
      const districts = (city && city.children) || [];
      return h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
        h('label', { className: 'wb-label' }, '省份',
          h('select', { className: 'wb-select', value: region.provinceCode, onChange: e => setRegion({ provinceCode: e.target.value, cityCode: '', districtCode: '' }) },
            provinces.map(p => h('option', { key: p.code, value: p.code }, p.name)))),
        h('label', { className: 'wb-label' }, '城市',
          h('select', { className: 'wb-select', value: region.cityCode, disabled: !cities.length, onChange: e => setRegion({ ...region, cityCode: e.target.value, districtCode: '' }) },
            h('option', { value: '' }, cities.length ? '全省' : '请先选省'),
            cities.map(c => h('option', { key: c.code, value: c.code }, c.name)))),
        h('label', { className: 'wb-label' }, '区县',
          h('select', { className: 'wb-select', value: region.districtCode, disabled: !districts.length, onChange: e => setRegion({ ...region, districtCode: e.target.value }) },
            h('option', { value: '' }, districts.length ? '不限定区县' : '请先选市'),
            districts.map(d => h('option', { key: d.code, value: d.code }, d.name)))));
    }

    function DataToolsAuction({ toast }) {
      const catalogRef = useRef(null);
      if (!catalogRef.current) catalogRef.current = window.__DT_REGION_CATALOG__ || [];
      const catalog = catalogRef.current;
      // 与工具箱 DEFAULT_CONFIG 对齐，并优先读取已保存参数
      const AUCTION_DEFAULTS = {
        region: { provinceCode: '330000', cityCode: '330100', districtCode: '' },
        entry: 'sf', propertyType: 'residential', status: 'finished',
        keyword: '', startDate: '', endDate: '', maxPages: '3',
        generateMap: true, outputDir: '',
      };
      const savedRef = useRef(null);
      if (!savedRef.current) savedRef.current = dtLoadParams('auction', AUCTION_DEFAULTS);
      const saved = savedRef.current;
      const [region, setRegion] = useState(saved.region || AUCTION_DEFAULTS.region);
      const [entry, setEntry] = useState(saved.entry || 'sf');
      const [propertyType, setPropertyType] = useState(saved.propertyType || 'residential');
      const [status, setStatus] = useState(saved.status || 'finished');
      const [keyword, setKeyword] = useState(saved.keyword || '');
      const [startDate, setStartDate] = useState(saved.startDate || '');
      const [endDate, setEndDate] = useState(saved.endDate || '');
      const [maxPages, setMaxPages] = useState(saved.maxPages || '3');
      const [generateMap, setGenerateMap] = useState(saved.generateMap !== false);
      const [outputDir, setOutputDir] = useState(saved.outputDir || '');
      const [task, setTask] = useState(null);
      const [busy, setBusy] = useState(false);
      const [paused, setPaused] = useState(false);
      const applyAuctionDefaults = (next) => {
        setRegion(next.region || AUCTION_DEFAULTS.region);
        setEntry(next.entry || 'sf');
        setPropertyType(next.propertyType || 'residential');
        setStatus(next.status || 'finished');
        setKeyword(next.keyword || '');
        setStartDate(next.startDate || '');
        setEndDate(next.endDate || '');
        setMaxPages(next.maxPages || '3');
        setGenerateMap(next.generateMap !== false);
        setOutputDir(next.outputDir || '');
      };

      useEffect(() => {
        if (!busy) return undefined;
        const t = setInterval(async () => {
          try {
            const { d } = await dtJson(DT_PREFIX + '/auction/status', { cache: 'no-store' });
            if (d.task) {
              setTask(d.task);
              if (d.task.status !== 'running') {
                setBusy(false);
                setPaused(false);
                toast(d.task.status === 'done' ? '拍卖抓取完成' : '拍卖抓取失败：' + (d.task.error || d.task.message || ''), d.task.status === 'done' ? undefined : 'warn');
              }
            }
          } catch { /* 下一轮再试 */ }
        }, 1500);
        return () => clearInterval(t);
      }, [busy, toast]);

      const run = async () => {
        if (busy) return;
        setBusy(true);
        setPaused(false);
        try {
          const province = catalog.find(p => p.code === region.provinceCode);
          const city = (province?.children || []).find(c => c.code === region.cityCode);
          const district = (city?.children || []).find(d => d.code === region.districtCode);
          const body = {
            province: province?.name || '', provinceCode: region.provinceCode,
            city: city?.name || '', cityCode: region.cityCode,
            district: district?.name || '', districtCode: region.districtCode,
            entry, propertyType, status, keyword, startDate, endDate,
            maxPages: Number(maxPages) || 3,
            generateMap,
            outputDirectory: outputDir.trim(),
          };
          const r = await fetch(DT_PREFIX + '/auction/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || d.msg || ('HTTP ' + r.status));
          toast('已启动阿里司法拍卖抓取；如出现滑块请在浏览器完成');
        } catch (e) {
          setBusy(false);
          toast('启动失败：' + ((e && e.message) || e), 'danger');
        }
      };

      // 等价工具箱 runAlibabaAuctionHistory：带 historyPath 只重抓详情，不重扫列表
      const runHistory = async ({ path: historyPath, request: histReq, historyRefresh: allowRefresh }) => {
        if (busy) return;
        setBusy(true);
        setPaused(false);
        try {
          const province = catalog.find(p => p.code === (histReq.provinceCode || region.provinceCode));
          const city = (province?.children || []).find(c => c.code === (histReq.cityCode || region.cityCode));
          const district = (city?.children || []).find(d => d.code === (histReq.districtCode || region.districtCode));
          const body = {
            province: histReq.province || province?.name || '',
            provinceCode: histReq.provinceCode || region.provinceCode,
            city: histReq.city || city?.name || '',
            cityCode: histReq.cityCode || region.cityCode,
            district: histReq.district || district?.name || '',
            districtCode: histReq.districtCode || region.districtCode,
            entry: histReq.entry === 'zc' ? 'zc' : entry,
            propertyType: histReq.propertyType || propertyType,
            status: histReq.status || status,
            keyword: histReq.keyword || '',
            startDate: histReq.startDate || '',
            endDate: histReq.endDate || '',
            generateMap,
            outputDirectory: outputDir.trim(),
            historyPath,
            historyRefresh: allowRefresh !== false,
          };
          const r = await fetch(DT_PREFIX + '/auction/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || d.msg || ('HTTP ' + r.status));
          toast('已按历史清单重新抓取详情');
        } catch (e) {
          setBusy(false);
          toast('历史重抓失败：' + ((e && e.message) || e), 'danger');
        }
      };

      const stop = async () => {
        try {
          const r = await fetch(DT_PREFIX + '/auction/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
          toast('已请求终止；当前条处理完后停止并写出已核验结果');
        } catch (e) { toast('终止失败：' + ((e && e.message) || e), 'warn'); }
      };

      const togglePause = async () => {
        const action = paused ? 'resume' : 'pause';
        try {
          const r = await fetch(DT_PREFIX + '/auction/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
          setPaused(action === 'pause');
          toast(action === 'pause' ? '已暂停；点「继续采集」恢复' : '已继续采集');
        } catch (e) { toast((action === 'pause' ? '暂停失败：' : '继续失败：') + ((e && e.message) || e), 'warn'); }
      };

      // 等价工具箱 exportAlibabaAuctionExcel：用当前结果重新导出一份 Excel（抓取时已自动导出，此处为手动重导）
      const exportExcel = async () => {
        try {
          const r = await fetch(DT_PREFIX + '/auction/export-excel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.ok === false) throw new Error(d.msg || d.error || ('HTTP ' + r.status));
          setTask(prev => (prev ? { ...prev, result: { ...(prev.result || {}), excelPath: d.excelPath } } : prev));
          toast('Excel 已导出并完成校验，共 ' + (d.rowCount || 0) + ' 条');
        } catch (e) { toast('导出 Excel 失败：' + ((e && e.message) || e), 'danger'); }
      };
      const resultButtons = (t) => {
        const res = t.result || {};
        const paths = [
          { label: '打开结果页', path: res.htmlPath },
          { label: '打开 Excel', path: res.excelPath },
          { label: '查看地图', path: res.mapPath },
        ];
        return dtOpenButtons(paths.filter(p => p.path));
      };

      return h('div', { style: { display: 'grid', gap: 14, marginTop: 8 } },
        h('div', { className: 'wb-alert', style: { fontSize: 12 } }, '通过 opencli 驱动你已登录的 Chrome 读取司法拍卖列表并逐条核验成交详情；如出现滑块/登录请在弹出的浏览器窗口完成（5 分钟窗口）。'),
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' } },
          h(DtRegionSelects, { catalog, region, setRegion }),
          h('label', { className: 'wb-label' }, '列表入口',
            h('select', { className: 'wb-select', value: entry, onChange: e => setEntry(e.target.value) },
              h('option', { value: 'sf' }, '司法拍卖列表'),
              h('option', { value: 'zc' }, '阿里资产搜索（出售）'))),
          h('label', { className: 'wb-label' }, '物业类型',
            h('select', { className: 'wb-select', value: propertyType, onChange: e => setPropertyType(e.target.value) },
              h('option', { value: 'residential' }, '住宅用房'),
              h('option', { value: 'commercial' }, '商业房'))),
          h('label', { className: 'wb-label' }, '交易状态',
            h('select', { className: 'wb-select', value: status, onChange: e => setStatus(e.target.value) },
              h('option', { value: 'finished' }, '已结束'),
              h('option', { value: 'all' }, '全部状态')))),
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' } },
          h('label', { className: 'wb-label', style: { flex: '1 1 200px' } }, '关键词（可选：标的名称、地址或法院）',
            h('input', { className: 'wb-input', style: { width: '100%' }, value: keyword, maxLength: 100, onChange: e => setKeyword(e.target.value) })),
          h('label', { className: 'wb-label' }, '成交时间起', h('input', { className: 'wb-input', type: 'date', value: startDate, onChange: e => setStartDate(e.target.value) })),
          h('label', { className: 'wb-label' }, '成交时间止', h('input', { className: 'wb-input', type: 'date', value: endDate, onChange: e => setEndDate(e.target.value) })),
          h('label', { className: 'wb-label' }, '列表页数上限', h('input', { className: 'wb-input', style: { width: 80 }, inputMode: 'numeric', value: maxPages, onChange: e => setMaxPages(e.target.value.replace(/\D/g, '')) }))),
        h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 } },
          h('label', { style: { display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: generateMap, onChange: e => setGenerateMap(e.target.checked) }), '生成独立地图 HTML')),
        h('label', { className: 'wb-label' }, '输出目录（默认：~/Documents/天源评估/个人工作台/数据工具输出/阿里司法拍卖）',
          h(DtDirectoryField, { value: outputDir, onChange: setOutputDir, placeholder: '留空使用默认目录' })),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h('button', { className: 'wb-btn', onClick: run, disabled: busy }, busy ? '任务进行中…' : '开始抓取'),
          h('button', { className: 'wb-btn sm', onClick: () => dtOpenSourceFor('auction', {
            entry, provinceCode: region.provinceCode, cityCode: region.cityCode, districtCode: region.districtCode,
            propertyType, status, keyword, startDate, endDate,
          }) }, '打开来源页'),
          busy ? h('button', { className: 'wb-btn sm', onClick: togglePause }, paused ? '继续采集' : '暂停采集') : null,
          busy ? h('button', { className: 'wb-btn sm', onClick: stop }, '终止任务') : null,
          h('button', { className: 'wb-btn sm', onClick: exportExcel, disabled: busy || !(task && task.result && (task.result.results || []).length) }, '导出 Excel'),
          h('button', { className: 'wb-btn sm', onClick: () => setTask(null), disabled: busy }, '清空结果'),
          h(DtParamButtons, {
            paramKey: 'auction',
            snapshot: { region, entry, propertyType, status, keyword, startDate, endDate, maxPages, generateMap, outputDir },
            defaults: AUCTION_DEFAULTS,
            onApply: applyAuctionDefaults,
            toast,
          }),
          busy ? h('span', { className: 'wb-hint', style: { alignSelf: 'center' } }, '遇到滑块/登录请在 Chrome 完成后自动继续') : null),
        h(DtHistoryPanel, { kind: 'auction', directory: (task && task.result && task.result.outputDirectory) || outputDir.trim(), toast, onRerun: runHistory }),
        h('div', { className: 'wb-card', style: { padding: 12, background: 'var(--wb-surface-2)' } },
          h('h3', { style: { margin: '0 0 6px', fontSize: 13 } }, '当前任务进度与结果'),
          h(DataToolsProgress, { task, onOpen: resultButtons })));
    }

    // ---- 阿里资产租赁 ----
    function DataToolsLease({ toast }) {
      const catalogRef = useRef(null);
      if (!catalogRef.current) catalogRef.current = window.__DT_REGION_CATALOG__ || [];
      const catalog = catalogRef.current;
      // 与工具箱 alibaba-lease DEFAULT_CONFIG 对齐（区县默认上城区 330102）
      const LEASE_DEFAULTS = {
        region: { provinceCode: '330000', cityCode: '330100', districtCode: '330102' },
        propertyType: 'residential', status: 'finished',
        keyword: '', startDate: '', endDate: '', maxPages: '1',
        generateMap: true, outputDir: '',
      };
      const leaseSavedRef = useRef(null);
      if (!leaseSavedRef.current) leaseSavedRef.current = dtLoadParams('lease', LEASE_DEFAULTS);
      const sSaved = leaseSavedRef.current;
      const [region, setRegion] = useState(sSaved.region || LEASE_DEFAULTS.region);
      const [propertyType, setPropertyType] = useState(sSaved.propertyType || 'residential');
      const [status, setStatus] = useState(sSaved.status || 'finished');
      const [keyword, setKeyword] = useState(sSaved.keyword || '');
      const [startDate, setStartDate] = useState(sSaved.startDate || '');
      const [endDate, setEndDate] = useState(sSaved.endDate || '');
      const [maxPages, setMaxPages] = useState(sSaved.maxPages || '1');
      const [generateMap, setGenerateMap] = useState(sSaved.generateMap !== false);
      const [outputDir, setOutputDir] = useState(sSaved.outputDir || '');
      const applyLeaseDefaults = (next) => {
        setRegion(next.region || LEASE_DEFAULTS.region);
        setPropertyType(next.propertyType || 'residential');
        setStatus(next.status || 'finished');
        setKeyword(next.keyword || ''); setStartDate(next.startDate || ''); setEndDate(next.endDate || '');
        setMaxPages(next.maxPages || '1'); setGenerateMap(next.generateMap !== false); setOutputDir(next.outputDir || '');
      };
      const [task, setTask] = useState(null);
      const [busy, setBusy] = useState(false);
      const [paused, setPaused] = useState(false);

      useEffect(() => {
        if (!busy) return undefined;
        const t = setInterval(async () => {
          try {
            const { d } = await dtJson(DT_PREFIX + '/lease/status', { cache: 'no-store' });
            if (d.task) {
              setTask(d.task);
              if (d.task.status !== 'running') {
                setBusy(false);
                setPaused(false);
                toast(d.task.status === 'done' ? '租赁抓取完成' : '租赁抓取失败：' + (d.task.error || d.task.message || ''), d.task.status === 'done' ? undefined : 'warn');
              }
            }
          } catch { /* 下一轮再试 */ }
        }, 1500);
        return () => clearInterval(t);
      }, [busy, toast]);

      const run = async () => {
        if (busy) return;
        setBusy(true);
        setPaused(false);
        try {
          const province = catalog.find(p => p.code === region.provinceCode);
          const city = (province?.children || []).find(c => c.code === region.cityCode);
          const district = (city?.children || []).find(d => d.code === region.districtCode);
          const body = {
            province: province?.name || '', provinceCode: region.provinceCode,
            city: city?.name || '', cityCode: region.cityCode,
            district: district?.name || '', districtCode: region.districtCode,
            propertyType, status, keyword, startDate, endDate,
            maxPages: Number(maxPages) || 2,
            generateMap,
            outputDirectory: outputDir.trim(),
          };
          const r = await fetch(DT_PREFIX + '/lease/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || d.msg || ('HTTP ' + r.status));
          toast('已启动阿里资产租赁抓取；如出现滑块请在浏览器完成');
        } catch (e) {
          setBusy(false);
          toast('启动失败：' + ((e && e.message) || e), 'danger');
        }
      };

      // 等价工具箱「用此历史重新抓取」：租赁历史顶层用 items，桥内 readHistoryCandidates 已兼容两种格式
      const runHistory = async ({ path: historyPath, request: histReq, historyRefresh: allowRefresh }) => {
        if (busy) return;
        setBusy(true);
        setPaused(false);
        try {
          const province = catalog.find(p => p.code === (histReq.provinceCode || region.provinceCode));
          const city = (province?.children || []).find(c => c.code === (histReq.cityCode || region.cityCode));
          const district = (city?.children || []).find(d => d.code === (histReq.districtCode || region.districtCode));
          const body = {
            province: histReq.province || province?.name || '',
            provinceCode: histReq.provinceCode || region.provinceCode,
            city: histReq.city || city?.name || '',
            cityCode: histReq.cityCode || region.cityCode,
            district: histReq.district || district?.name || '',
            districtCode: histReq.districtCode || region.districtCode,
            propertyType: histReq.propertyType || propertyType,
            status: histReq.status || status,
            keyword: histReq.keyword || '',
            startDate: histReq.startDate || '',
            endDate: histReq.endDate || '',
            generateMap,
            outputDirectory: outputDir.trim(),
            historyPath,
            historyRefresh: allowRefresh !== false,
          };
          const r = await fetch(DT_PREFIX + '/lease/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || d.msg || ('HTTP ' + r.status));
          toast('已按历史清单重新抓取租赁详情');
        } catch (e) {
          setBusy(false);
          toast('历史重抓失败：' + ((e && e.message) || e), 'danger');
        }
      };

      const stop = async () => {
        try {
          const r = await fetch(DT_PREFIX + '/lease/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
          toast('已请求终止；当前条处理完后停止并写出已核验结果');
        } catch (e) { toast('终止失败：' + ((e && e.message) || e), 'warn'); }
      };

      const togglePause = async () => {
        const action = paused ? 'resume' : 'pause';
        try {
          const r = await fetch(DT_PREFIX + '/lease/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
          setPaused(action === 'pause');
          toast(action === 'pause' ? '已暂停；点「继续采集」恢复' : '已继续采集');
        } catch (e) { toast((action === 'pause' ? '暂停失败：' : '继续失败：') + ((e && e.message) || e), 'warn'); }
      };

      // 等价工具箱 exportAlibabaLeaseExcel：用当前结果重新导出一份 Excel（抓取时已自动导出，此处为手动重导）
      const exportLeaseExcel = async () => {
        try {
          const r = await fetch(DT_PREFIX + '/lease/export-excel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.ok === false) throw new Error(d.msg || d.error || ('HTTP ' + r.status));
          setTask(prev => (prev ? { ...prev, result: { ...(prev.result || {}), excelPath: d.excelPath } } : prev));
          toast('Excel 已导出并完成校验，共 ' + (d.rowCount || 0) + ' 条');
        } catch (e) { toast('导出 Excel 失败：' + ((e && e.message) || e), 'danger'); }
      };
      const resultButtons = (t) => {
        const res = t.result || {};
        const paths = [
          { label: '打开结果页', path: res.htmlPath },
          { label: '打开 Excel', path: res.excelPath },
          { label: '查看地图', path: res.mapPath },
        ];
        return dtOpenButtons(paths.filter(p => p.path));
      };

      return h('div', { style: { display: 'grid', gap: 14, marginTop: 8 } },
        h('div', { className: 'wb-alert', style: { fontSize: 12 } }, '阿里资产（zc-paimai）租赁/使用权成交采集：URL 参数自带区域与 h_t_mode 租赁筛选；逐页读取后逐条核验详情。'),
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' } },
          h(DtRegionSelects, { catalog, region, setRegion }),
          h('label', { className: 'wb-label' }, '物业类型',
            h('select', { className: 'wb-select', value: propertyType, onChange: e => setPropertyType(e.target.value) },
              h('option', { value: 'residential' }, '住宅租赁'),
              h('option', { value: 'commercial' }, '商业租赁'))),
          h('label', { className: 'wb-label' }, '交易状态',
            h('select', { className: 'wb-select', value: status, onChange: e => setStatus(e.target.value) },
              h('option', { value: 'finished' }, '已结束'),
              h('option', { value: 'all' }, '全部状态')))),
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' } },
          h('label', { className: 'wb-label', style: { flex: '1 1 200px' } }, '关键词（可选）',
            h('input', { className: 'wb-input', style: { width: '100%' }, value: keyword, maxLength: 100, onChange: e => setKeyword(e.target.value) })),
          h('label', { className: 'wb-label' }, '结束时间起', h('input', { className: 'wb-input', type: 'date', value: startDate, onChange: e => setStartDate(e.target.value) })),
          h('label', { className: 'wb-label' }, '结束时间止', h('input', { className: 'wb-input', type: 'date', value: endDate, onChange: e => setEndDate(e.target.value) })),
          h('label', { className: 'wb-label' }, '页数上限（1-5）', h('input', { className: 'wb-input', style: { width: 80 }, inputMode: 'numeric', value: maxPages, onChange: e => setMaxPages(e.target.value.replace(/\D/g, '')) }))),
        h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 } },
          h('label', { style: { display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: generateMap, onChange: e => setGenerateMap(e.target.checked) }), '生成独立地图 HTML')),
        h('label', { className: 'wb-label' }, '输出目录（默认：~/Documents/天源评估/个人工作台/数据工具输出/阿里资产租赁）',
          h(DtDirectoryField, { value: outputDir, onChange: setOutputDir, placeholder: '留空使用默认目录' })),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { className: 'wb-btn', onClick: run, disabled: busy }, busy ? '任务进行中…' : '开始抓取'),
          h('button', { className: 'wb-btn sm', onClick: () => dtOpenSourceFor('lease', {
            provinceCode: region.provinceCode, cityCode: region.cityCode, districtCode: region.districtCode,
            propertyType, status, keyword, startDate, endDate,
          }) }, '打开来源页'),
          busy ? h('button', { className: 'wb-btn sm', onClick: togglePause }, paused ? '继续采集' : '暂停采集') : null,
          busy ? h('button', { className: 'wb-btn sm', onClick: stop }, '终止任务') : null,
          h('button', { className: 'wb-btn sm', onClick: exportLeaseExcel, disabled: busy || !(task && task.result && (task.result.results || []).length) }, '导出 Excel'),
          h('button', { className: 'wb-btn sm', onClick: () => setTask(null), disabled: busy }, '清空结果'),
          h(DtParamButtons, {
            paramKey: 'lease',
            snapshot: { region, propertyType, status, keyword, startDate, endDate, maxPages, generateMap, outputDir },
            defaults: LEASE_DEFAULTS,
            onApply: applyLeaseDefaults,
            toast,
          }),
          busy ? h('span', { className: 'wb-hint', style: { alignSelf: 'center' } }, '遇到滑块/登录请在 Chrome 完成后自动继续') : null),
        h('div', { className: 'wb-card', style: { padding: 12, background: 'var(--wb-surface-2)' } },
          h('h3', { style: { margin: '0 0 6px', fontSize: 13 } }, '当前任务进度与结果'),
          h(DataToolsProgress, { task, onOpen: resultButtons })),
        h(DtHistoryPanel, { kind: 'lease', directory: (task && task.result && task.result.outputDirectory) || outputDir.trim(), toast, onRerun: runHistory }));
    }

    // ---- 子面板四：表格与底稿工具（表格设置/明细表打印/申报表打印/公式恢复） ----
    function DataToolsBatch({ toast }) {
      const tools = [
        { id: 'table-format', name: '表格设置（Word）', desc: '为 .docx 评估报告/说明中的表格统一设置格式，清除底纹。', hint: '选择一个或多个 Word 文档；生成「-表格设置」副本。', accept: '.docx', placeholder: '/path/to/报告.docx（多个用换行分隔）' },
        { id: 'detail-print-format', name: '明细表打印格式', desc: '设置 A4 横向、一页宽度、列宽、打印区域及页脚。', hint: '支持 .xlsx/.xlsm；可传文件夹批量；生成「-打印版」副本。', accept: '.xlsx,.xlsm', placeholder: '/path/to/明细表目录 或 .xlsx 文件' },
        { id: 'declaration-print-format', name: '申报表打印格式', desc: '整理申报表标题、显示列、汇总页与打印格式。', hint: '支持 .xlsx/.xlsm；生成「-申报表」副本。', accept: '.xlsx,.xlsm', placeholder: '/path/to/明细表.xlsx' },
        { id: 'link-restore', name: '明细表公式恢复', desc: '恢复标准资产基础法明细表（表1~表6）汇总链接并生成对比报告。', hint: '仅支持标准模板 .xlsx；生成「-链接恢复」副本 + 对比报告。', accept: '.xlsx', placeholder: '/path/to/明细表.xlsx（标准表1~表6模板）' },
      ];
      const [toolId, setToolId] = useState('detail-print-format');
      const [inputsText, setInputsText] = useState('');
      const [outputMode, setOutputMode] = useState('copy_in_source');
      const [outputDir, setOutputDir] = useState('');
      const [task, setTask] = useState(null);
      const [busy, setBusy] = useState(false);
      const tool = tools.find(t => t.id === toolId);

      useEffect(() => {
        if (!busy) return undefined;
        const t = setInterval(async () => {
          try {
            const { d } = await dtJson(DT_PREFIX + '/' + toolId + '/status', { cache: 'no-store' });
            if (d.task) {
              setTask(d.task);
              if (d.task.status !== 'running') {
                setBusy(false);
                toast(d.task.status === 'done' ? '处理完成' : '处理失败：' + (d.task.error || d.task.message || ''), d.task.status === 'done' ? undefined : 'danger');
              }
            }
          } catch { /* 下一轮再试 */ }
        }, 1500);
        return () => clearInterval(t);
      }, [busy, toolId, toast]);

      const run = async () => {
        if (busy) return;
        const inputPaths = inputsText.split('\n').map(s => s.trim()).filter(Boolean);
        if (!inputPaths.length) { toast('请先填写输入路径（文件或文件夹）', 'warn'); return; }
        setBusy(true); setTask(null);
        try {
          const body = { inputPaths, outputMode };
          if (outputMode === 'new_directory') body.outputDirectory = outputDir.trim();
          const r = await fetch(DT_PREFIX + '/' + toolId + '/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || d.msg || ('HTTP ' + r.status));
          toast(`已启动任务：共 ${d.total} 个文件`);
        } catch (e) {
          setBusy(false);
          toast('启动失败：' + ((e && e.message) || e), 'danger');
        }
      };

      const resultButtons = (t) => {
        const res = t.result || {};
        const okItems = (res.results || []).filter(x => x.ok);
        const paths = [];
        // 每个成功文件给「打开」+首个给「打开目录」
        for (const item of okItems.slice(0, 6)) paths.push({ label: '打开 ' + (item.outputPath || '').split('/').pop(), path: item.outputPath });
        if (okItems.length) paths.push({ label: '打开输出目录', path: okItems[0].outputPath, reveal: true });
        const reportItem = okItems.find(x => x.reportPath);
        if (reportItem) paths.push({ label: '打开对比报告', path: reportItem.reportPath });
        return dtOpenButtons(paths);
      };

      return h('div', { style: { display: 'grid', gap: 14, marginTop: 8 } },
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          tools.map(t => h('button', { key: t.id, className: 'wb-btn ' + (toolId === t.id ? '' : 'sm'), style: toolId === t.id ? { fontWeight: 600, borderColor: 'var(--wb-accent)' } : {}, onClick: () => { setToolId(t.id); setTask(null); setBusy(false); } }, t.name))),
        h('div', { className: 'wb-alert', style: { fontSize: 12 } },
          h('div', null, h('strong', null, tool.name + '：'), tool.desc),
          h('div', { className: 'wb-hint', style: { marginTop: 4 } }, tool.hint)),
        h('label', { className: 'wb-label' }, '输入路径（每行一个；工作簿类工具支持文件夹递归，最多 500 个文件）',
          h('textarea', { className: 'wb-input', style: { width: '100%', minHeight: 64, fontFamily: 'Menlo, monospace', fontSize: 11 }, value: inputsText, placeholder: tool.placeholder, onChange: e => setInputsText(e.target.value) })),
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' } },
          h('label', { className: 'wb-label' }, '输出方式',
            h('select', { className: 'wb-select', value: outputMode, onChange: e => setOutputMode(e.target.value) },
              h('option', { value: 'copy_in_source' }, '在源目录生成副本（推荐）'),
              h('option', { value: 'overwrite' }, '覆盖原文件（谨慎）'),
              h('option', { value: 'new_directory' }, '输出到指定目录'))),
          outputMode === 'new_directory' ? h('label', { className: 'wb-label', style: { flex: '1 1 260px' } }, '输出目录（须已存在）',
            h(DtDirectoryField, { value: outputDir, onChange: setOutputDir, disabled: busy })) : null),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { className: 'wb-btn', onClick: run, disabled: busy }, busy ? '任务进行中…' : '开始处理'),
          busy ? h('button', { className: 'wb-btn sm', onClick: async () => { try { await fetch(DT_PREFIX + '/' + toolId + '/stop', { method: 'POST' }); toast('已请求终止：当前文件处理完后停止'); } catch { /* noop */ } } }, '终止任务') : null),
        h('div', { className: 'wb-card', style: { padding: 12, background: 'var(--wb-surface-2)' } },
          h('h3', { style: { margin: '0 0 6px', fontSize: 13 } }, '当前任务进度与结果'),
          h(DataToolsProgress, { task, onOpen: resultButtons })));
    }

    // ---- 子面板五：折旧摊销与资本性支出预测 ----
    function DataToolsDep({ toast }) {
      const [inputPath, setInputPath] = useState('');
      const [withDetails, setWithDetails] = useState(false);
      const [task, setTask] = useState(null);
      const [busy, setBusy] = useState(false);
      const [readResult, setReadResult] = useState(null);

      useEffect(() => {
        if (!busy) return undefined;
        const t = setInterval(async () => {
          try {
            const { d } = await dtJson(DT_PREFIX + '/dep/status', { cache: 'no-store' });
            if (d.task) {
              setTask(d.task);
              if (d.task.status !== 'running') {
                setBusy(false);
                toast(d.task.status === 'done' ? '折旧任务完成' : '折旧任务失败：' + (d.task.error || d.task.message || ''), d.task.status === 'done' ? undefined : 'danger');
              }
            }
          } catch { /* 下一轮再试 */ }
        }, 1500);
        return () => clearInterval(t);
      }, [busy, toast]);

      const requireInput = () => {
        const v = inputPath.trim();
        if (!v) { toast('请先填写工作簿路径（可先「准备工作簿」再用默认路径）', 'warn'); return null; }
        return v;
      };
      const action = async (kind) => {
        if (busy && kind !== 'status') return;
        const v = kind === 'prepare' ? inputPath.trim() : requireInput();
        setBusy(true); setTask(null);
        try {
          let url = DT_PREFIX + '/dep/' + kind;
          let body = {};
          if (kind === 'prepare') { body = { output: v || undefined }; }
          else if (kind === 'preflight') { body = { input: v }; }
          else if (kind === 'run') { body = { input: v, withDetails }; }
          else if (kind === 'status') {
            // status 是同步读取，直接走 read
            url = DT_PREFIX + '/dep/read';
            body = { sub: 'status', input: v };
            const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            const d = await r.json().catch(() => ({}));
            setReadResult(JSON.stringify(d, null, 2));
            setBusy(false);
            if (d.ok === false || d.error) toast('读取失败：' + (d.error || ''), 'danger');
            else toast('已读取工作簿状态');
            return;
          }
          const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || d.msg || ('HTTP ' + r.status));
          toast('已启动：' + kind);
        } catch (e) {
          setBusy(false);
          toast('操作失败：' + ((e && e.message) || e), 'danger');
        }
      };

      const resultButtons = (t) => {
        const res = t.result || {};
        const paths = [];
        const wb = res.workbook_path || inputPath;
        if (wb) paths.push({ label: '打开工作簿', path: wb });
        const out = res.export_path || res.output || (res.prepare && res.prepare.workbook_path);
        if (out && out !== wb) paths.push({ label: '打开输出', path: out });
        return dtOpenButtons(paths);
      };

      return h('div', { style: { display: 'grid', gap: 14, marginTop: 8 } },
        h('div', { className: 'wb-alert', style: { fontSize: 12 } }, '折旧摊销与资本性支出预测：准备工作簿 → 在 Excel/WPS 中填写参数与资产输入并关闭 → 校验（preflight）→ 运行计算 → 查看结果。工作簿被占用时请先关闭文件。'),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('button', { className: 'wb-btn', onClick: () => action('prepare'), disabled: busy }, '① 准备工作簿'),
          h('button', { className: 'wb-btn', onClick: () => action('preflight'), disabled: busy }, '② 校验输入'),
          h('button', { className: 'wb-btn', onClick: () => action('run'), disabled: busy }, '③ 运行计算'),
          h('button', { className: 'wb-btn sm', onClick: () => action('status'), disabled: busy }, '读取状态')),
        h('label', { className: 'wb-label' }, '工作簿路径（「准备工作簿」可留空 = 默认 Downloads/折旧摊销预测输入模板.xlsx）',
          h(DtDirectoryField, { value: inputPath, onChange: setInputPath, placeholder: '点击「选择目录」选 xlsx，或粘贴路径' })),
        h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: withDetails, onChange: e => setWithDetails(e.target.checked) }), '同时生成年度/月度明细（较慢）'),
        h('div', { className: 'wb-card', style: { padding: 12, background: 'var(--wb-surface-2)' } },
          h('h3', { style: { margin: '0 0 6px', fontSize: 13 } }, '任务进度与结果'),
          h(DataToolsProgress, { task, onOpen: resultButtons })),
        readResult ? h('details', { style: { marginTop: 4 } },
          h('summary', { className: 'wb-hint', style: { cursor: 'pointer' } }, '工作簿状态 JSON'),
          h('pre', { style: { overflow: 'auto', maxHeight: 220, padding: 8, background: 'var(--wb-surface-2)', borderRadius: 6, fontSize: 11, whiteSpace: 'pre-wrap' } }, readResult)) : null);
    }

    // ---- 子面板三：地图基础配置（高德 + 百度） ----
    // 两块共用一份 ~/.tianyuan-workbench/map-config.json，但各自保存各自的段：
    // 宿主 POST /dt/map-config 按 amap / baidu 分段合并，保存一块不会清掉另一块。
    function DataToolsMap({ toast }) {
      const [summary, setSummary] = useState(null);
      const [amapEnabled, setAmapEnabled] = useState(false);
      const [webKey, setWebKey] = useState('');
      const [securityCode, setSecurityCode] = useState('');
      const [baiduEnabled, setBaiduEnabled] = useState(false);
      const [baiduAk, setBaiduAk] = useState('');
      const [baiduSk, setBaiduSk] = useState('');
      const [busy, setBusy] = useState(false);
      const load = useCallback(async () => {
        try {
          const { d } = await dtJson(DT_PREFIX + '/map-config', { cache: 'no-store' });
          setSummary(d);
          setAmapEnabled(d.amap ? d.amap.enabled === true : d.enabled === true);
          setBaiduEnabled(!!(d.baidu && d.baidu.enabled === true));
        } catch (e) { toast('读取地图配置失败：' + ((e && e.message) || e), 'danger'); }
      }, [toast]);
      useEffect(() => { load(); }, [load]);

      const post = async (body) => {
        const r = await fetch(DT_PREFIX + '/map-config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const text = await r.text();
        let d = null;
        try { d = text ? JSON.parse(text) : {}; } catch (_) { d = null; }
        if (d === null) throw new Error('宿主未返回 JSON（HTTP ' + r.status + '）：' + String(text || '').trim().slice(0, 160));
        if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
        return d;
      };

      const saveAmap = async (clear) => {
        setBusy(true);
        try {
          const amap = clear
            ? { clear: true }
            : { enabled: amapEnabled, webKey: webKey.trim(), securityJsCode: securityCode.trim(), preserveExisting: !!(summary && summary.webKeyConfigured) };
          const d = await post(clear ? { clear: true } : { amap });
          setSummary(d); setWebKey(''); setSecurityCode('');
          toast(clear ? '已恢复默认公共底图' : ((d.amap ? d.amap.enabled : d.enabled) ? '已保存高德配置' : '已保存（官方高德底图未启用）'));
        } catch (e) { toast('保存失败：' + ((e && e.message) || e), 'danger'); }
        finally { setBusy(false); }
      };

      const saveBaidu = async () => {
        setBusy(true);
        try {
          const d = await post({
            baidu: {
              enabled: baiduEnabled,
              webApiAk: baiduAk.trim(),
              agentPlanSk: baiduSk.trim(),
              preserveExisting: !!(summary && summary.baidu && summary.baidu.configured),
            },
          });
          setSummary(d); setBaiduAk(''); setBaiduSk('');
          toast((d.baidu && d.baidu.enabled) ? '已保存百度地图配置' : '已保存（百度地图未启用）');
        } catch (e) { toast('保存失败：' + ((e && e.message) || e), 'danger'); }
        finally { setBusy(false); }
      };

      const amapConfigured = !!(summary && (summary.webKeyConfigured || (summary.amap && summary.amap.webKeyConfigured)));
      const amapMasked = (summary && (summary.webKeyMasked || (summary.amap && summary.amap.webKeyMasked))) || '';
      const binfo = (summary && summary.baidu) || {};
      const baiduConfigured = !!(binfo.webApiAkConfigured || binfo.agentPlanSkConfigured);
      const badge = (on) => h('span', { style: { fontSize: 11, padding: '1px 8px', borderRadius: 8, color: '#fff', background: on ? 'var(--wb-ok-ink,#1b8a5a)' : 'var(--wb-chip-grey,#eef0f1)' } }, on ? '已配置' : '未配置');

      return h('div', { style: { display: 'grid', gap: 18, marginTop: 8 } },
        h('div', { className: 'wb-alert', style: { fontSize: 12 } }, '默认使用公共底图并自动切换；只有默认底图全部无法加载时，才需要启用官方地图 API。配置只保存在本机（~/.tianyuan-workbench/map-config.json），不会上传。'),

        // —— 高德 ——
        h('div', { style: { display: 'grid', gap: 12 } },
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'center' } },
            h('h3', { style: { margin: 0, fontSize: 13 } }, '官方高德地图'), badge(amapConfigured)),
          h('p', { className: 'wb-hint' }, '还没有 Key？在高德开放平台创建"Web 端（JS API）"应用和 Key：',
            ' ', h('a', { className: 'wb-link', href: 'https://console.amap.com/dev/key/app', target: '_blank', rel: 'noopener noreferrer' }, '打开高德 API 配置页面')),
          h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: amapEnabled, onChange: e => setAmapEnabled(e.target.checked) }), '启用官方高德底图备用源'),
          h('div', { style: { display: 'grid', gap: 10, maxWidth: 560 } },
            h('label', { className: 'wb-label' }, '高德 Web 端（JS API）Key',
              h('input', { className: 'wb-input', style: { width: '100%' }, type: 'password', autoComplete: 'off', value: webKey, placeholder: amapConfigured ? '留空表示保留原 Key' : '启用时填写', onChange: e => setWebKey(e.target.value) })),
            h('label', { className: 'wb-label' }, '安全密钥（可选）',
              h('input', { className: 'wb-input', style: { width: '100%' }, type: 'password', autoComplete: 'off', value: securityCode, placeholder: '如高德控制台要求则填写', onChange: e => setSecurityCode(e.target.value) }))),
          amapConfigured ? h('p', { className: 'wb-hint', style: { color: 'var(--wb-ok-ink,#1b8a5a)' } }, '本机已配置高德 API（Key：' + (amapMasked || '已隐藏') + '）。留空 Key 保存时会保留现有配置。') : h('p', { className: 'wb-hint' }, '当前未配置高德 API。'),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { className: 'wb-btn', onClick: () => saveAmap(false), disabled: busy }, '保存高德配置'),
            h('button', { className: 'wb-btn sm', onClick: () => saveAmap(true), disabled: busy }, '恢复默认底图'))),

        h('hr', { style: { border: 0, borderTop: '1px solid var(--wb-border,#e6e8ea)', margin: 0 } }),

        // —— 百度 ——
        h('div', { style: { display: 'grid', gap: 12 } },
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'center' } },
            h('h3', { style: { margin: 0, fontSize: 13 } }, '百度地图'), badge(baiduConfigured)),
          h('p', { className: 'wb-hint' }, '百度有两套凭证，按用途填其中一个或都填：',
            h('br'), '· Web 服务 AK（地址解析 / POI 检索 / 路线规划 / 行政区划 / 天气），走 https://api.map.baidu.com/ ，也可用环境变量 BMAP_WEBAPI_AK；',
            h('br'), '· Agent Plan SK（AI 语义检索 / 语义路线），走 /agent_plan/v1/* ，也可用环境变量 BAIDU_MAP_AUTH_TOKEN；',
            h('br'), ' ', h('a', { className: 'wb-link', href: 'https://lbs.baidu.com/apiconsole/key', target: '_blank', rel: 'noopener noreferrer' }, '申请服务端 AK'), ' · ',
            h('a', { className: 'wb-link', href: 'https://lbs.baidu.com/apiconsole/agentplan', target: '_blank', rel: 'noopener noreferrer' }, '申请 Agent Plan SK')),
          h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: baiduEnabled, onChange: e => setBaiduEnabled(e.target.checked) }), '启用百度地图（供数据工具与助手调用）'),
          h('div', { style: { display: 'grid', gap: 10, maxWidth: 560 } },
            h('label', { className: 'wb-label' }, '百度 Web 服务 AK（服务端）',
              h('input', { className: 'wb-input', style: { width: '100%' }, type: 'password', autoComplete: 'off', value: baiduAk, placeholder: binfo.webApiAkConfigured ? (binfo.webApiAkFromEnv ? '已由环境变量 BMAP_WEBAPI_AK 提供，留空沿用' : '留空表示保留原 AK') : '如 BMapWebServiceAk', onChange: e => setBaiduAk(e.target.value) })),
            h('label', { className: 'wb-label' }, '百度 Agent Plan SK',
              h('input', { className: 'wb-input', style: { width: '100%' }, type: 'password', autoComplete: 'off', value: baiduSk, placeholder: binfo.agentPlanSkConfigured ? (binfo.agentPlanSkFromEnv ? '已由环境变量 BAIDU_MAP_AUTH_TOKEN 提供，留空沿用' : '留空表示保留原 SK') : '如 AgentPlanSk', onChange: e => setBaiduSk(e.target.value) }))),
          baiduConfigured
            ? h('p', { className: 'wb-hint', style: { color: 'var(--wb-ok-ink,#1b8a5a)' } },
              '本机已配置百度地图：',
              binfo.webApiAkConfigured ? ('Web 服务 AK ' + (binfo.webApiAkMasked || '已隐藏')) : '未填 Web 服务 AK',
              '；',
              binfo.agentPlanSkConfigured ? ('Agent Plan SK ' + (binfo.agentPlanSkMasked || '已隐藏')) : '未填 Agent Plan SK',
              '。留空保存会保留现有凭证。')
            : h('p', { className: 'wb-hint' }, '当前未配置百度地图。'),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { className: 'wb-btn', onClick: () => saveBaidu(), disabled: busy }, '保存百度配置'))),

        h('p', { className: 'wb-hint', style: { fontSize: 11 } }, '配置文件：' + ((summary && summary.path) || '~/.tianyuan-workbench/map-config.json')));
    }

    // ---------- 报告比对：Word 线下改稿 ↔ 天源线上报告节点 ----------
    // 形态说明：整页四步平铺（选报告 → 上传改稿 → 比对定位 → 写回线上）。
    // 不用弹窗——弹窗装不下四步内容，而且切页签就丢结果。
    //
    // 「选报告」不是「选本地基线」：用户不需要先去导出。选好项目/公司/类型后，
    // 宿主当场把线上已生成的那版 DOCX 下载下来当原版，比对完只回传一次性凭据。

    const RC_STEPS = ['选报告', '上传改稿', '比对定位', '写回线上'];
    const RC_TYPES = [{ v: '1', n: '评估报告' }, { v: '2', n: '评估说明' }, { v: '3', n: '长投说明' }];
    const RC_WARNING_LABELS = {
      'non-body content such as headers, footers, notes or comments is not compared': '页眉、页脚、脚注、尾注及批注等正文外内容未比对',
      'media, embedded objects and charts are not compared': '图片、嵌入对象和图表未比对',
      'document contains unsupported objects, fields, content controls or formulas': '包含不支持的对象、域、内容控件或公式',
      'tracked revisions are not interpreted': '未解析修订记录',
      // 新版按"接受修订"解释：改动内容会算数，所以这条是说明而非限制。
      'tracked revisions are interpreted as accepted': '修订记录按「接受全部修订」解释（改动内容已计入）',
      'nested paragraphs are not fully compared': '嵌套段落未完整比对',
      'paragraphs in unsupported body containers are not compared': '不支持的正文容器内段落未比对',
      'formatting, layout, numbering, relationships and non-body content are not compared': '格式、版式、编号、关联关系及正文外内容未比对',
    };
    function rcWhen(value) {
      const text = String(value == null ? '' : value);
      return text ? text.replace('T', ' ').slice(0, 16) : '—';
    }
    function rcSize(bytes) {
      const n = Number(bytes);
      if (!Number.isFinite(n) || n <= 0) return '—';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
      return (n / 1024 / 1024).toFixed(1) + ' MB';
    }
    // 含变量 / 图片 / 附件：这类段落替换整段会丢结构，写回一律不碰。
    // 未配对的原因要分开说。以前无论哪种情况都标"含变量 / 图片"，
    // 用户看到的是一堆看不懂的标签，实际可能只是段落重复或结构变化。
    // 未配对的原因不能靠猜。宿主在 locate 阶段做了事实判断：这段文字线上节点里到底
    // 有没有（inline）、报告里有没有上传的 Word 附件节点（attachment）。
    // 有 refuses 项就照它说；没有才退回本地按形状推断。
    function rcUnpairReason(change, miss) {
      if (miss && typeof miss === 'object') {
        // 宿主已经判清了的，一律照它说：
        // 线下新增 / 线下删除 / 表格变量 / 上传附件 / 线上有但配不上 —— 处置方式完全不同。
        if (miss.added === true) return '线下新增';
        if (miss.deleted === true) return '线下删除';
        if (miss.table === true) return '表格变量';
        if (miss.attachment === true) return '上传的 Word 附件';
        if (miss.inline === true) return '重复或结构变化';
      }
      const flag = item => !!(item && typeof item === 'object' && item.unsupported === true);
      const left = Array.isArray(change && change.baseline) ? change.baseline : [];
      const right = Array.isArray(change && change.modified) ? change.modified : [];
      const anyUnsupported = left.some(flag) || right.some(flag);
      const nonEmpty = left.concat(right).filter(x => String((x && x.text) || '').trim());
      if (anyUnsupported) return '含变量 / 图片';
      if (!left.length && right.length) return '线下新增';
      if (left.length && !right.length) return '线下删除';
      if (left.length !== right.length) return '段落数不同';
      if (!nonEmpty.length) return '空白段落';
      return '重复或结构变化';
    }
    // 附件内容说清楚代价：线上只能整份替换文件，改字做不到。
    function rcUnpairNote(change, miss) {
      if (miss && typeof miss === 'object' && miss.note) return miss.note;
      return '这几段没法可靠对应到线上某一处，需人工核对';
    }
    function rcUnsupported(change) {
      const flag = item => !!(item && typeof item === 'object' && item.unsupported === true);
      if (!change || typeof change !== 'object') return false;
      if (change.type === 'unpaired') {
        const left = Array.isArray(change.baseline) ? change.baseline : [];
        const right = Array.isArray(change.modified) ? change.modified : [];
        return left.some(flag) || right.some(flag);
      }
      return flag(change.baseline) || flag(change.modified);
    }
    function rcShort(text, max) {
      const t = String(text == null ? '' : text);
      return t.length > max ? t.slice(0, max) + '…' : t;
    }
    const rcSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    // 报告比对：只上传改稿，原版直接从线上取。
    //
    // 关键取舍：不再要求先去「工作」页签导出一份基线。
    // 选好项目/公司/报告类型后，宿主当场下载线上已生成的那版 DOCX 当原版，
    // 同时抓一份节点树与完整版正文（写回要用），比对完只回传一个一次性 token。
    // 这样用户的心智负担只剩一句话：把改过的稿子丢进来。
    function ReportComparePage({ s, toast, onDirtyChange }) {
      const cachedProjects = (s && s.work && s.work.ty && Array.isArray(s.work.ty.cachedProjects)) ? s.work.ty.cachedProjects : [];
      // 两段式：pendingProject 只是下拉里的草稿；projectId 是「已确认」的项目。
      // 天源的公司/版本读取只认 projectId —— 确认之前页面不发任何天源请求，
      // 与「导出报告/说明」一致：先选项目，确认后再打开天源。
      const [pendingProject, setPendingProject] = useState('');
      const [projectId, setProjectId] = useState('');
      const [companies, setCompanies] = useState(null);
      // 报告类型是否来自天源的真实配置。浏览器通道不可用时退回 MCP，
      // 那时拿不到 reportConfigList，types 为 null，这里置 false 以便界面说明。
      const [typesKnown, setTypesKnown] = useState(true);
      const [companyId, setCompanyId] = useState('');
      const [reportType, setReportType] = useState('1');
      const [versions, setVersions] = useState(null);
      const [attachId, setAttachId] = useState('');
      const [baselineInfo, setBaselineInfo] = useState(null);
      const [file, setFile] = useState(null);
      const [busy, setBusy] = useState('');
      const [buildingMsg, setBuildingMsg] = useState('');
      const [error, setError] = useState('');
      const [result, setResult] = useState(null);
      const [compareToken, setCompareToken] = useState('');
      const [checked, setChecked] = useState(() => new Set());
      const [confirming, setConfirming] = useState(false);
      const [writeResult, setWriteResult] = useState(null);
      const fileRef = useRef(null);
      const buildFlag = useRef(null);

      const requestJson = async (path, options) => {
        const response = await fetch(PREFIX + path, options);
        const text = await response.text();
        let data = null;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        if (!response.ok || !data || data.ok !== true) {
          throw new Error((data && (data.error || data.message)) || ('HTTP ' + response.status + (text ? '：' + text.slice(0, 200) : '')));
        }
        return data;
      };
      // /ty/call 是宿主的天源工具通道（get_project_companies 等）。
      // 注意它返回的是 { content, structuredContent, data, isError }，没有 ok 字段，
      // 所以不能复用上面的 requestJson（那个按 ok===true 判成功，会把每次都判成失败）。
      const callTool = async (name, args) => {
        const response = await fetch(PREFIX + '/ty/call', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, arguments: args || {} }),
        });
        const text = await response.text();
        let data = null;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        if (!response.ok) throw new Error((data && data.error) || ('HTTP ' + response.status));
        if (data && data.error) throw new Error(data.error);
        if (data && data.isError) {
          // MCP 把工具级错误（参数校验失败等）放在 content[0].text 里回来。
          const raw = typeof data.data === 'string' ? data.data : String((data.data && data.data.text) || '');
          throw new Error(raw.slice(0, 200) || 'MCP 返回错误');
        }
        return data && data.data !== undefined ? data.data : (data && data.structuredContent);
      };

      // 项目下拉只改草稿；不自动选任何项目。确认前页面保持第 1 步提示，
      // 不发 /ty/report-companies 之类的天源请求。
      // （与「导出报告/说明」一致：先选项目，点「确认」后才打开天源。）

      // 项目 → 公司列表。
      useEffect(() => {
        let alive = true;
        setCompanies(null); setCompanyId(''); setVersions(null); setAttachId('');
        setResult(null); setCompareToken(''); setWriteResult(null); setChecked(new Set()); setConfirming(false);
        setBaselineInfo(null); setError('');
        if (fileRef.current) fileRef.current.value = '';
        setFile(null);
        if (!/^\d+$/.test(String(projectId || ''))) return () => { alive = false; };
        (async () => {
          try {
            // 走 /ty/report-companies 而不是 MCP 的 get_project_companies：
            // 后者只给公司名，拿不到"这家公司配置了哪些报告类型"，
            // 前端就只能无条件列出三个类型，选到没配置的那个必然 0 版本。
            const data = await requestJson('/ty/report-companies?projectId=' + encodeURIComponent(projectId), { cache: 'no-store' });
            const list = Array.isArray(data.companies) ? data.companies : [];
            const seen = new Set();
            const rows = list.map(c => {
              const id = String((c && c.id) == null ? '' : c.id).trim();
              const types = Array.isArray(c && c.types) ? c.types.map(Number).filter(t => [1, 2, 3].includes(t)) : null;
              return { id, name: String((c && c.name) || '未命名公司'), types };
            }).filter(c => /^\d+$/.test(c.id) && !seen.has(c.id) && seen.add(c.id));
            if (!alive) return;
            setTypesKnown(data.typesKnown !== false);
            setCompanies(rows);
            if (rows.length === 1) setCompanyId(rows[0].id);
          } catch (e) {
            if (!alive) return;
            setCompanies([]);
            setTypesKnown(true);
            setError('读取公司列表失败：' + String(e.message || e));
          }
        })();
        return () => { alive = false; };
      }, [projectId]);

      const loadVersions = useCallback(async () => {
        if (!/^\d+$/.test(String(projectId || '')) || !/^\d+$/.test(String(companyId || ''))) { setVersions(null); return; }
        setBusy('versions'); setError('');
        try {
          const q = '?projectId=' + encodeURIComponent(projectId)
            + '&companyId=' + encodeURIComponent(companyId)
            + '&reportType=' + encodeURIComponent(reportType);
          const data = await requestJson('/ty/report-versions' + q, { cache: 'no-store' });
          setVersions(Array.isArray(data.versions) ? data.versions : []);
        } catch (e) {
          setVersions([]);
          setError('读取线上版本失败：' + String(e.message || e));
        } finally { setBusy(''); }
      }, [projectId, companyId, reportType]);

      // 公司或报告类型一变，之前的版本选择与比对结果全部作废。
      useEffect(() => {
        setAttachId(''); setVersions(null); setResult(null); setCompareToken(''); setWriteResult(null);
        setChecked(new Set()); setConfirming(false); setBaselineInfo(null);
        if (fileRef.current) fileRef.current.value = '';
        setFile(null);
        loadVersions();
      }, [companyId, reportType, loadVersions]);

      useEffect(() => () => { if (buildFlag.current) buildFlag.current.stop = true; }, []);

      const companyName = useMemo(() => {
        const hit = (companies || []).find(c => c && String(c.id) === String(companyId));
        return hit ? hit.name : '';
      }, [companies, companyId]);
      const typeName = (RC_TYPES.find(t => t.v === String(reportType)) || {}).n || '报告';
      // 被评估公司在天源里真实配置过的报告类型；null 表示这次没读到配置。
      const availableTypes = useMemo(() => {
        const hit = (companies || []).find(c => c && String(c.id) === String(companyId));
        if (!hit) return null;
        return Array.isArray(hit.types) ? hit.types : null;
      }, [companies, companyId]);
      // 下拉只列真实配置过的类型；一个都没配就明确说出来，别让人去点必然失败的「重新生成」。
      const typeOptions = useMemo(() => {
        if (!typesKnown || !availableTypes) return RC_TYPES;
        return RC_TYPES.filter(t => availableTypes.includes(Number(t.v)));
      }, [typesKnown, availableTypes]);

      const changes = result && Array.isArray(result.changes) ? result.changes : [];
      const locate = result && result.locate && typeof result.locate === 'object' ? result.locate : null;
      const located = locate && Array.isArray(locate.located) ? locate.located : [];
      const refused = locate && Array.isArray(locate.refused) ? locate.refused : [];
      const locatedByIndex = useMemo(() => new Map(located.map(x => [Number(x && x.index), x])), [located]);
      const refusedByIndex = useMemo(() => new Map(refused.map(x => [Number(x && x.index), x])), [refused]);
      const unsupportedCount = changes.filter(rcUnsupported).length;
      // 候选行 = 改字 + 插段 + 删段。后两种在线上不是"改某一段"，而是改节点里的段落数组，
      // 所以列里要说清是"插在哪一段后面"或"删掉哪一段"，不能只给原文/改后两列。
      const candidateRows = changes.map((c, i) => ({ change: c, index: i }))
        .filter(r => r.change && (r.change.type === 'candidate_change'
          || r.change.type === 'insertion' || r.change.type === 'deletion'));
      const unpairedRows = changes.map((c, i) => ({ change: c, index: i })).filter(r => r.change && r.change.type === 'unpaired');

      // 写回闸门：必须「全部改动都定位唯一」。
      // 只要有一组没定位、是未配对、或含变量/图片，就整体不给写——宁可不让点，
      // 也不要让用户在半懂不懂的状态下按下去。
      const gateReason = (() => {
        if (!result) return '还没有比对结果';
        if (!locate) return '比对结果里没有线上定位信息';
        if (!locate.available) return '这次比对没有拿到线上节点快照，只能做 Word 对 Word 比对';
        if (!changes.length) return '没有识别到任何改动';
        if (refused.length) return '还有 ' + refused.length + ' 处改动无法唯一定位，需先人工核对';
        if (located.length !== changes.length) return '不是所有改动都定位到了线上节点';
        if (unsupportedCount) return '还有 ' + unsupportedCount + ' 处含变量或图片，这类段落不能写回';
        return '';
      })();
      const canWriteback = gateReason === '';
      const picked = useMemo(() => located.filter(x => checked.has(Number(x && x.index))), [located, checked]);
      const pickedNodeCount = useMemo(() => {
        const ids = new Set();
        for (const x of picked) { const c = x && x.candidate; if (c && c.itemId != null) ids.add(String(c.itemId)); }
        return ids.size;
      }, [picked]);

      // 步骤条：第 1 步「选报告」在确认项目之前；确认项目进入第 2 步。
      const step = writeResult ? 4 : result ? 3 : (companyId && versions && versions.length) ? 2 : projectId ? 2 : 1;

      // 比对结果只活在当前页签的组件状态里：切走就没了，宿主也不会替我们保留。
      // 所以「有结果、还没写回」这段窗口要让外层知道，切页前问一句，别让用户白比一场。
      useEffect(() => {
        if (onDirtyChange) onDirtyChange(!!(result && !writeResult));
      }, [result, writeResult, onDirtyChange]);
      useEffect(() => () => { if (onDirtyChange) onDirtyChange(false); }, [onDirtyChange]);

      const resetComparison = () => {
        setResult(null); setCompareToken(''); setWriteResult(null);
        setChecked(new Set()); setConfirming(false); setBaselineInfo(null);
        if (fileRef.current) fileRef.current.value = '';
        setFile(null);
      };
      const pickProject = id => {
        // 下拉只改草稿；同值不动。确认前天源请求保持静默。
        if (String(id) === String(pendingProject)) return;
        setPendingProject(id);
        if (String(id) === String(projectId)) return;
        // 换草稿的同时作废旧项目的读取结果，避免界面残留上一个项目的数据。
        if (projectId) setProjectId('');
      };
      // 「确认项目」：草稿 → 正式。真正触发天源公司/版本读取的是 projectId 本身。
      const confirmProject = () => {
        if (!/^\d+$/.test(String(pendingProject || ''))) return;
        setProjectId(String(pendingProject));
      };
      const pickCompany = id => { if (id === companyId) return; setCompanyId(id); };
      const pickType = id => { if (id === reportType) return; setReportType(id); };
      const pickVersion = id => {
        if (String(id) === String(attachId)) return;
        setAttachId(String(id || ''));
        // 换原版 = 换比对基准，已有结果作废。
        resetComparison(); setError('');
      };

      const regenerate = async () => {
        if (busy || !/^\d+$/.test(String(projectId || '')) || !/^\d+$/.test(String(companyId || ''))) return;
        setBusy('build'); setError('');
        const flag = { stop: false };
        buildFlag.current = flag;
        setBuildingMsg('提交生成任务…');
        try {
          // 重新生成：让线上按当前节点重新出一版稿，拿新版本当原版。
          // 生成是天源后台的异步任务，这里轮询版本列表等它出现，不猜测耗时。
          const before = new Set((versions || []).map(v => String(v.attachId)));
          await requestJson('/ty/report-build', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId, companyId, reportType }),
          });
          const t0 = Date.now();
          let found = null;
          while (Date.now() - t0 < 10 * 60 * 1000 && !flag.stop) {
            setBuildingMsg('生成中… 已等 ' + Math.round((Date.now() - t0) / 1000) + ' 秒');
            await rcSleep(6000);
            if (flag.stop) break;
            const q = '?projectId=' + encodeURIComponent(projectId)
              + '&companyId=' + encodeURIComponent(companyId)
              + '&reportType=' + encodeURIComponent(reportType);
            const data = await requestJson('/ty/report-versions' + q, { cache: 'no-store' });
            const list = Array.isArray(data.versions) ? data.versions : [];
            const fresh = list.find(v => v && v.attachId && !before.has(String(v.attachId)));
            if (fresh) { found = fresh; setVersions(list); setAttachId(String(fresh.attachId)); resetComparison(); break; }
          }
          if (!found && !flag.stop) setError('等待生成超时（10 分钟）。天源可能仍在出稿，稍后点「刷新」看看。');
          else if (found) toast && toast('已生成 V' + String(found.version) + '，将用它当原版', 'ok');
        } catch (e) { setError('重新生成失败：' + String(e.message || e)); }
        finally { buildFlag.current = null; setBusy(''); setBuildingMsg(''); }
      };

      const compare = async () => {
        if (!file || busy) return;
        if (!/\.docx$/i.test(String(file.name || ''))) { setError('请选择 .docx 文件'); return; }
        if (file.size > 32 * 1024 * 1024) { setError('文件不能超过 32 MB'); return; }
        if (!/^\d+$/.test(String(companyId || ''))) { setError('先选公司和报告类型'); return; }
        setBusy('compare'); setError(''); setResult(null); setWriteResult(null); setChecked(new Set()); setConfirming(false); setCompareToken('');
        try {
          const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('读取文件失败'));
            reader.onload = () => {
              const text = String(reader.result || '');
              const comma = text.indexOf(',');
              if (comma < 0) reject(new Error('文件编码失败')); else resolve(text.slice(comma + 1));
            };
            reader.readAsDataURL(file);
          });
          const data = await requestJson('/ty/report-compare-live', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectId, companyId, reportType,
              attachId: attachId ? String(attachId) : undefined,
              filename: file.name, base64,
            }),
          });
          if (!data.result || typeof data.result !== 'object') throw new Error('比对结果格式不正确');
          if (!data.compareToken) throw new Error('宿主没有返回比对凭据，无法写回');
          setResult(data.result);
          setCompareToken(String(data.compareToken));
          setBaselineInfo(data.baseline && typeof data.baseline === 'object' ? data.baseline : null);
          toast && toast('比对完成：识别 ' + (Array.isArray(data.result.changes) ? data.result.changes.length : 0) + ' 组差异', 'ok');
        } catch (e) { setError('比对失败：' + String(e.message || e)); }
        finally { setBusy(''); }
      };

      const toggle = index => {
        setChecked(prev => {
          const next = new Set(prev);
          const key = Number(index);
          if (next.has(key)) next.delete(key); else next.add(key);
          return next;
        });
        setConfirming(false);
      };

      const runWriteback = async () => {
        if (!result || !locate || busy) return;
        if (!picked.length) { setError('请先逐个勾选要写回的改动'); return; }
        if (!compareToken) { setError('比对凭据已丢失，请重新比对一次'); return; }
        setBusy('writeback'); setError('');
        try {
          // 只把勾选的这几条放进 located；refused 原样保留（写回只用 located，
          // 但把 refused 抹空等于在请求里撒谎）。
          const payload = { ...locate, located: picked };
          const data = await requestJson('/ty/report-writeback-live', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirm: true, compareToken, projectId, locate: payload }),
          });
          if (!data.result || typeof data.result !== 'object') throw new Error('写回结果格式不正确');
          setWriteResult(data.result);
          setConfirming(false);
          setChecked(new Set());
          const failed = (data.result.failed || []).length;
          toast && toast(failed ? ('写回完成，但有 ' + failed + ' 处失败') : '已写回线上', failed ? 'warn' : 'ok');
        } catch (e) { setError('写回失败：' + String(e.message || e)); }
        finally { setBusy(''); }
      };

      const exportCsv = () => {
        if (!result) return;
        const quote = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
        const head = ['序号', '类型', '状态', '线上节点', '段落号', '原文', '改后', '说明'];
        const lines = [head.map(quote).join(',')];
        changes.forEach((c, i) => {
          const isCandidate = c && c.type === 'candidate_change';
          const hit = locatedByIndex.get(i);
          const miss = refusedByIndex.get(i);
          const status = hit ? '可唯一定位' : (rcUnsupported(c) ? '含变量/图片，不可写回' : '需人工核对');
          const itemId = hit && hit.candidate ? String(hit.candidate.itemId) : '';
          const blockIndex = hit && hit.candidate && hit.candidate.blockIndex != null ? String(hit.candidate.blockIndex) : '';
          const original = isCandidate ? String((c.baseline && c.baseline.text) || '') : (Array.isArray(c.baseline) ? c.baseline.map(x => String((x && x.text) || '')).join(' / ') : '');
          const modified = isCandidate ? String((c.modified && c.modified.text) || '') : (Array.isArray(c.modified) ? c.modified.map(x => String((x && x.text) || '')).join(' / ') : '');
          const note = hit ? '' : String((miss && miss.reason) || (isCandidate ? '' : '未配对'));
          lines.push([i + 1, isCandidate ? '候选修改' : '未配对内容', status, itemId, blockIndex, original, modified, note].map(quote).join(','));
        });
        const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = '报告差异清单-' + (companyName || companyId || 'report') + '-' + todayStr() + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      };

      const stepsBar = h('div', { className: 'rc-steps' }, RC_STEPS.map((label, i) => {
        const n = i + 1;
        return h('div', { key: label, style: { display: 'flex', alignItems: 'center' } },
          i > 0 ? h('span', { className: 'rc-step-sep' }) : null,
          h('div', { className: 'rc-step' + (step === n ? ' on' : step > n ? ' done' : '') },
            h('span', { className: 'rc-step-n' }, step > n ? '✓' : String(n)), label));
      }));

      const kpiCard = (value, label, sub) => h('div', { className: 'wb-card' },
        h('div', { className: 'wb-kpi' }, String(value)), h('div', { className: 'wb-kpi-sub' }, label), sub ? h('div', { className: 'wb-hint' }, sub) : null);

      const sumCard = result ? h('div', { className: 'wb-grid', style: { marginBottom: 12 } },
        kpiCard(changes.length, '识别改动', 'Word 与线上原版之间'),
        kpiCard(locate && locate.counts ? locate.counts.located : 0, '可唯一定位', '能落到具体节点段落'),
        kpiCard(locate && locate.counts ? locate.counts.refused : 0, '需人工核对', '无法唯一确定位置'),
        kpiCard(unsupportedCount, '含变量 / 图片', '不可写回，仅提示')) : null;

      const cellOriginal = text => h('div', { className: 'rc-cell rc-del' }, rcShort(text, 400) || '（空）');
      const cellModified = text => h('div', { className: 'rc-cell rc-add' }, rcShort(text, 400) || '（空）');

      const candidateTable = result ? h(Table, {
        cols: ['', '原（线上）', '改后（Word）', '线上位置'],
        rows: candidateRows.length ? candidateRows.map(({ change, index }) => {
          const hit = locatedByIndex.get(index);
          const miss = refusedByIndex.get(index);
          const blockable = !!hit && !rcUnsupported(change);
          const disabled = !canWriteback || !blockable;
          const isIns = change.type === 'insertion';
          const isDel = change.type === 'deletion';
          const pos = hit && hit.candidate
            ? h('div', null,
              h('div', { className: 'rc-pos' }, '节点 ' + String(hit.candidate.itemId)),
              h('div', { className: 'rc-pos' },
                '第 ' + (Number(hit.candidate.blockIndex) + 1) + ' 段'
                + (isIns ? (hit.anchorFrom === 'before' ? ' 之前插入' : ' 之后插入') : isDel ? '（删除）' : '')
                + (hit.matchedBy === 'stripped numbering prefix' ? '（去序号匹配）' : '')))
            : h('div', null,
              h('span', { className: 'wb-tag warn' }, rcUnsupported(change) ? '不可写回' : '需人工核对'),
              h('div', { className: 'wb-hint', style: { marginTop: 2 } }, rcShort((miss && miss.reason) || '未定位到线上节点', 60)));
          // 插段/删段的 baseline/modified 是段落数组，不是单段对象，展示要分开处理。
          const leftNodes = isIns ? [] : (isDel ? (change.baseline || []) : (change.baseline ? [change.baseline] : []));
          const rightNodes = isDel ? [] : (isIns ? (change.modified || []) : (change.modified ? [change.modified] : []));
          const kindTag = isIns ? h('span', { className: 'wb-tag green', style: { marginRight: 4 } }, '新增段落')
            : isDel ? h('span', { className: 'wb-tag grey', style: { marginRight: 4 } }, '删除段落') : null;
          return h('tr', { key: index, className: disabled && !hit ? 'rc-dim' : '', style: rcUnsupported(change) ? { opacity: 0.5 } : null },
            h('td', null, h('input', {
              type: 'checkbox', checked: checked.has(index), disabled,
              title: disabled ? (canWriteback ? '含变量或图片，不能写回' : gateReason) : '勾选后才写回这一处',
              onChange: () => toggle(index),
            })),
            h('td', null, leftNodes.length
              ? h('div', { className: 'rc-cell rc-del' }, leftNodes.map((n, i) => h('div', { key: i }, rcShort((n && n.text) || '', 300))))
              : h('div', { className: 'rc-cell' }, h('span', { className: 'wb-hint' }, isIns ? '（线上没有这段）' : ''))),
            h('td', null, rightNodes.length
              ? h('div', { className: 'rc-cell rc-add' }, rightNodes.map((n, i) => h('div', { key: i }, rcShort((n && n.text) || '', 300))))
              : h('div', { className: 'rc-cell' }, h('span', { className: 'wb-hint' }, isDel ? '（删除）' : ''))),
            h('td', null, kindTag, pos));
        }) : [],
      }) : null;

      const unpairedTable = result && unpairedRows.length ? h(Table, {
        cols: ['', '线上原版', '修改后', '说明'],
        rows: unpairedRows.map(({ change, index }) => {
          const left = Array.isArray(change.baseline) ? change.baseline : [];
          const right = Array.isArray(change.modified) ? change.modified : [];
          const miss = refusedByIndex.get(index);
          return h('tr', { key: 'u' + index, style: { opacity: 0.75 } },
            h('td', null, h('input', { type: 'checkbox', disabled: true, checked: false, title: '未配对内容不能写回' })),
            h('td', null, h('div', { className: 'rc-cell rc-del' }, left.length ? left.slice(0, 6).map((x, i) => h('div', { key: i }, rcShort((x && x.text) || '（空）', 300))) : '（无）')),
            h('td', null, h('div', { className: 'rc-cell rc-add' }, right.length ? right.slice(0, 6).map((x, i) => h('div', { key: i }, rcShort((x && x.text) || '（空）', 300))) : '（无）')),
            h('td', null, h('span', { className: 'wb-tag ' + (miss && miss.added ? 'green' : rcUnsupported(change) ? 'red' : miss && miss.deleted ? 'grey' : 'warn') }, rcUnpairReason(change, miss)),
              h('div', { className: 'wb-hint', style: { marginTop: 2 } }, rcUnpairNote(change, miss))));
        }),
      }) : null;

      // 附件节点单独列出来：这些内容线上改不了字，但可以打开在线编辑或整份替换。
      // 只说"改不了"会让用户卡住，必须同时告诉他去哪儿改。
      const attachRows = result && locate && Array.isArray(locate.attachments) ? locate.attachments : [];
      const attachPanel = attachRows.length ? h('div', { className: 'wb-sec', style: { marginTop: 14 } },
        h('div', { className: 'wb-sec-h' }, h('h2', null, '这份报告里的上传附件'), h('span', { className: 'wb-tag grey' }, attachRows.length + ' 个')),
        h('p', { className: 'wb-hint' }, '这些节点的正文是上传的 Word 文件，不在可编辑段落里。上面「未配对内容」里标了「上传的 Word 附件」的，都要到对应文件里改：在天源网页打开该节点在线编辑（或整份替换文件），改完重新生成报告再比对一次。改完不会自动同步到节点正文，所以这里不提供写回。'),
        h(Table, {
          cols: ['附件文件', '节点 id', '附件 id'],
          rows: attachRows.map((a, i) => h('tr', { key: 'a' + i },
            h('td', null, h('div', { className: 'rc-cell' }, a.fileName || a.itemName || '（未命名）')),
            h('td', null, h('div', { className: 'rc-pos' }, a.itemId)),
            h('td', null, h('div', { className: 'rc-pos' }, a.attachId || '—')))),
        })) : null;

      const writePanel = result && locate ? h('div', { className: 'wb-sec', style: { marginTop: 14 } },
        h('div', { className: 'wb-sec-h' }, h('h2', null, '写回线上'),
          h('span', { className: 'wb-tag ' + (canWriteback ? 'green' : 'grey') }, canWriteback ? '可以写回' : '暂不可写回')),
        // 四条限制写在按钮上方，不藏在弹窗里——用户按下去之前就该看见代价。
        h('div', { className: 'wb-alert', style: { display: 'block' } },
          h('div', { className: 't' }, '写回前请先知道这几条'),
          h('div', { className: 'b', style: { marginTop: 4 } },
            (Array.isArray(locate.writeChannel && locate.writeChannel.blocking) && locate.writeChannel.blocking.length
              ? locate.writeChannel.blocking
              : ['写回是整节点覆盖：这一处改动会连带把该节点其余段落重写一次。', '写前会重新抓线上节点树核对哈希；期间有人改过就中止。', '含变量、图片或附件的节点不写；这类节点替换整段会丢结构。']
            ).map((b, i) => h('div', { key: i, style: { marginLeft: 2 } }, (i + 1) + '. ' + b)),
            h('div', { style: { marginTop: 6 } }, '4. 写回只动「已勾选且定位唯一」的节点；每次一个节点整段保存，写后逐字核对。'))),
        gateReason ? h('div', { className: 'wb-alert warn' }, h('div', { className: 't' }, gateReason),
          h('div', { className: 'b' }, '未配对内容与含变量/图片的段落只能人工去网页上改；这里不提供一键全选。')) : null,
        canWriteback ? h('div', { style: { marginTop: 8 } },
          h('div', { className: 'wb-hint', style: { marginBottom: 8 } },
            '已勾选 ' + picked.length + ' 处，覆盖 ' + pickedNodeCount + ' 个节点。' +
            '（必须逐条勾选；不做一键全选写回。）'),
          confirming
            ? h('div', null,
              h('div', { className: 'wb-alert danger' },
                h('div', { className: 't' }, '确认写回：' + picked.length + ' 处 / 覆盖 ' + pickedNodeCount + ' 个节点'),
                h('div', { className: 'b' }, '确认后会立刻覆盖这些节点当前的正文内容。写前会核对线上节点树哈希，期间被人改过就整体中止，不会覆盖别人的改动。')),
              h('div', { className: 'wb-row' },
                h(Btn, { className: 'sm', disabled: busy === 'writeback', onClick: () => setConfirming(false) }, '取消'),
                h(Btn, { variant: 'danger', className: 'sm', disabled: busy === 'writeback', onClick: runWriteback },
                  busy === 'writeback' ? '写回中…' : '确认写回 ' + picked.length + ' 处')))
            : null) : null,
        writeResult ? h('div', { style: { marginTop: 8 } },
          h('b', null, '写回结果'),
          h('div', { className: 'wb-hint', style: { marginBottom: 6 } },
            '已写 ' + (writeResult.applied || []).length + ' 处，跳过 ' + (writeResult.skipped || []).length + ' 处，失败 ' + (writeResult.failed || []).length + ' 处。'),
          (writeResult.applied || []).map((a, i) => h('div', { key: 'a' + i, className: 'rc-result ok' },
            h('span', null, '已写'), h('span', { className: 'id' }, '节点 ' + String(a.itemId) + ' · 第 ' + (Number(a.blockIndex) + 1) + ' 段'),
            h('span', null, rcShort(a.written, 60)))),
          (writeResult.skipped || []).map((k, i) => h('div', { key: 's' + i, className: 'rc-result skip' },
            h('span', null, '跳过'), h('span', { className: 'id' }, '节点 ' + String(k.itemId || '—') + (k.blockIndex != null ? ' · 第 ' + (Number(k.blockIndex) + 1) + ' 段' : '')),
            h('span', null, String(k.reason || '未知原因')))),
          (writeResult.failed || []).map((f, i) => h('div', { key: 'f' + i, className: 'rc-result fail' },
            h('span', null, '失败'), h('span', { className: 'id' }, '节点 ' + String(f.itemId || '—') + (f.blockIndex != null ? ' · 第 ' + (Number(f.blockIndex) + 1) + ' 段' : '')),
            h('span', null, String(f.reason || '未知原因'))))) : null,
        h('p', { className: 'wb-hint', style: { marginTop: 6 } },
          '写回通道：' + String((locate.writeChannel && locate.writeChannel.endpoint) || 'POST /ty/api/report/config/item/content/save') +
          '；写前 acquire 该节点编辑锁，写后 release。')) : null;

      const versionCards = !projectId ? h('div', { className: 'wb-hint' }, '先在左边选择并确认项目，确认后才会打开天源读取。')
        : !companyId ? h('div', { className: 'wb-hint' }, '先选公司和报告类型。')
        : versions === null ? h('div', { className: 'wb-hint' }, '正在读取线上版本…')
        : !versions.length ? h('div', { className: 'wb-hint' }, '这个公司还没有已生成的「' + typeName + '」。点上面的「重新生成」让天源出一版；如果线上明明有稿子，点「刷新」重读一次。')
        : versions.map((v, i) => {
          const id = String(v.attachId);
          const on = id === String(attachId || (versions[0] && String(versions[0].attachId)));
          return h('div', {
            key: id, className: 'rc-base' + (on ? ' on' : ''),
            onClick: () => { if (!busy) pickVersion(id); },
          },
            h('div', { className: 'rc-base-h' },
              h('div', { className: 'rc-base-t' }, 'V' + String(v.version)),
              i === 0 ? h('span', { className: 'wb-tag green' }, '最新') : h('span', { className: 'wb-tag grey' }, '旧版')),
            h('div', { className: 'rc-base-m' },
              h('span', { className: 'wb-tag grey' }, typeName),
              v.creator ? h('span', { className: 'wb-tag grey' }, rcShort(v.creator, 8)) : null),
            h('div', { className: 'rc-base-f' },
              h('span', null, rcWhen(v.updatedAt)),
              h('span', null, on ? '已选为原版' : '点选作为原版')));
        });

      const sideBar = h('div', { className: 'rc-side' },
        h('div', null,
          h('span', { className: 'wb-label' }, '项目'),
          cachedProjects.length
            ? h('div', null,
              h(Sel, { value: pendingProject, disabled: !!busy, onChange: e => pickProject(e.target.value), style: { width: '100%' } },
                h('option', { value: '' }, '— 选择项目 —'),
                cachedProjects.filter(p => p && /^\d+$/.test(String(p.id == null ? '' : p.id))).map(p => h('option', { key: String(p.id), value: String(p.id) },
                  rcShort(p.projectName || p.projectCode || String(p.id), 24)))),
              // 确认按钮：与「导出报告/说明」同款两段式 —— 选定项目后点确认，
              // 才去打开天源读取公司/版本。已确认后按钮变为「重新选择」。
              h('div', { className: 'wb-row', style: { marginTop: 6, gap: 6 } },
                projectId
                  ? h(Btn, { className: 'sm', disabled: !!busy, onClick: () => {
                    // 换项目：清掉已确认状态与全部读取结果，回到待确认。
                    setProjectId(''); setPendingProject('');
                    setCompanies(null); setCompanyId(''); setVersions(null); setAttachId('');
                    setResult(null); setCompareToken(''); setWriteResult(null);
                    setChecked(new Set()); setConfirming(false); setBaselineInfo(null); setError('');
                    if (fileRef.current) fileRef.current.value = '';
                    setFile(null);
                  } }, '重新选择项目')
                  : h(Btn, { className: 'sm', variant: pendingProject ? 'pri' : '', disabled: !!busy || !pendingProject, onClick: confirmProject, title: '确认后才会打开天源读取公司列表与线上版本' },
                    '确认项目'),
                projectId ? h('span', { className: 'wb-tag green' }, '已确认') : h('span', { className: 'wb-tag grey' }, '未确认')))
            : h('div', { className: 'wb-hint' }, '本地还没有项目缓存，请先到「工作」页签同步天源项目。')),
        h('div', null,
          h('span', { className: 'wb-label' }, '公司'),
          companies === null
            ? h('div', { className: 'wb-hint' }, projectId ? '正在读取公司…' : '先选择并确认项目。')
            : !companies.length
              ? h('div', { className: 'wb-hint' }, '这个项目没有可用的被评估公司。')
              : h(Sel, { value: companyId, disabled: !!busy, onChange: e => pickCompany(e.target.value), style: { width: '100%' } },
                h('option', { value: '' }, '— 选择公司 —'),
                companies.map(c => h('option', { key: c.id, value: c.id }, rcShort(c.name, 22))))),
        h('div', null,
          h('span', { className: 'wb-label' }, '报告类型'),
          companyId && typesKnown && availableTypes && !availableTypes.length
            // 这家公司在天源报告系统里连类型都没建：说清楚，不要给一个假的空列表。
            ? h('div', { className: 'wb-hint', style: { padding: '6px 0' } },
              '这家公司在天源里还没有配置任何报告类型，所以没有线上稿可比。需要先在天源网页给这家公司建报告，再回来比对。')
            : h(Sel, { value: reportType, disabled: !!busy || !typeOptions.length, onChange: e => pickType(e.target.value), style: { width: '100%' } },
              typeOptions.map(t => h('option', { key: t.v, value: t.v }, t.n)))),
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 } },
          h('span', { className: 'wb-label', style: { margin: 0 } }, '线上版本' + (versions ? '（' + versions.length + '）' : '')),
          h('div', { style: { display: 'flex', gap: 4 } },
            h(Btn, { className: 'sm', disabled: !!busy || !companyId, onClick: loadVersions },
              busy === 'versions' ? '读取中…' : '刷新'),
            h(Btn, { className: 'sm', disabled: !!busy || !companyId || (typesKnown && availableTypes && !availableTypes.length), onClick: regenerate, title: '让天源按当前节点重新出一版稿，约 1-3 分钟' },
              busy === 'build' ? '生成中…' : '重新生成'))),
        buildingMsg ? h('div', { className: 'wb-alert', style: { display: 'block' } }, h('div', { className: 'b' }, buildingMsg)) : null,
        versionCards,
        h('p', { className: 'wb-hint', style: { margin: 0 } }, '原版就是你选中的那一版线上报告的 Word 稿；不选则默认用最新版。'),
      );

      const uploadBar = h('div', { className: 'wb-sec' },
        h('div', { className: 'wb-sec-h' }, h('h2', null, '上传改稿'),
          companyId ? h('span', { className: 'wb-tag' }, rcShort(companyName + ' · ' + typeName, 24)) : null),
        h('p', { className: 'wb-hint' }, '选你在 Word 里改过的那份 .docx（最大 32 MB）。原版由系统当场从线上取，不需要你事先导出。'),
        h('div', { className: 'wb-row', style: { flexWrap: 'wrap', gap: 8 } },
          h('input', {
            ref: fileRef, type: 'file', disabled: !!busy || !companyId,
            accept: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            onChange: e => { setFile((e.target.files && e.target.files[0]) || null); setResult(null); setCompareToken(''); setWriteResult(null); setChecked(new Set()); setConfirming(false); setBaselineInfo(null); setError(''); },
          }),
          h(Btn, { disabled: !!busy || !companyId || !file, onClick: compare, variant: file && !result ? 'pri' : '' },
            busy === 'compare' ? '比对中…' : '开始比对'),
          file ? h('span', { className: 'wb-hint' }, file.name + ' · ' + rcSize(file.size)) : null),
        baselineInfo ? h('div', { className: 'wb-hint', style: { marginTop: 6 } },
          '原版：' + (baselineInfo.companyName ? baselineInfo.companyName + ' · ' : '') + 'V' + String(baselineInfo.version || '?')
          + '（attachId ' + String(baselineInfo.attachId || '?') + '）') : null,
        !companyId ? h('div', { className: 'wb-hint' }, '先在左边确认项目，再选公司和报告类型。') : null);

      const footBar = result ? h('div', { className: 'rc-foot' },
        h('span', { className: 'wb-hint' }, '共 ' + changes.length + ' 组差异'),
        h('span', { className: 'rc-foot-sp' }),
        h(Btn, { className: 'sm', onClick: exportCsv }, '导出差异清单'),
        h(Btn, {
          variant: canWriteback && picked.length ? 'danger' : '',
          className: 'sm',
          disabled: !!busy || !canWriteback || !picked.length || confirming,
          title: canWriteback ? (picked.length ? '' : '先逐条勾选要写回的改动') : gateReason,
          onClick: () => setConfirming(true),
        }, '写回线上（' + (canWriteback ? picked.length : 0) + ' 处）'),
        writeResult ? h(Btn, { className: 'sm', onClick: () => { resetComparison(); setError(''); } }, '重新开始') : null) : null;

      const warnings = result ? [...new Set([
        ...(result.baseline && Array.isArray(result.baseline.warnings) ? result.baseline.warnings : []),
        ...(result.modified && Array.isArray(result.modified.warnings) ? result.modified.warnings : []),
      ])] : [];

      return h('div', null,
        h('p', { className: 'wb-hint', style: { marginTop: 0 } },
          '把你在 Word 里线下改过的报告丢进来，系统自动取线上那一版当原版，比对出文字差异并定位到天源报告节点，再逐条写回——不用先在网页上重敲一遍，也不用事先导出。与「导出报告/说明」一样，先选项目并确认，确认后才会打开天源读取。'),
        h('div', { className: 'rc-split' },
          sideBar,
          h('div', null,
            stepsBar,
            error ? h('div', { className: 'wb-alert danger' },
              h('div', { className: 't' }, error),
              h('div', { className: 'b' }, '登录态由你自己的 Chrome 提供（不复制、不导出 Cookie）。在浏览器里登录天源之后，点左边「线上版本」右侧的「刷新」即可重新读取；改动了公司或报告类型也会自动重读。')) : null,
            uploadBar,
            sumCard,
            result ? h('div', { className: 'wb-sec' },
              h('div', { className: 'wb-sec-h' }, h('h2', null, '候选修改'), h('span', { className: 'wb-tag grey' }, candidateRows.length + ' 组')),
              h('p', { className: 'wb-hint' }, '左列勾选框只对「定位唯一且不含变量/图片」的行开放。红色的原句来自线上原版，绿色的改后来自你的 Word；线上位置是本系统认定的对应节点与段落号（段落号从第 1 段起）。'),
              candidateRows.length ? candidateTable : h('div', { className: 'wb-empty' }, '没有候选修改')) : null,
            unpairedTable ? h('div', { className: 'wb-sec' },
              h('div', { className: 'wb-sec-h' }, h('h2', null, '未配对内容'), h('span', { className: 'wb-tag warn' }, '不能写回')),
              h('p', { className: 'wb-hint' }, '这些段落无法可靠配对（重复、结构变化或含变量/图片/附件）。它们不能写回，但必须让你看见——否则你会以为差异只有上面那几行。'),
              unpairedTable) : null,
            attachPanel,
            warnings.length ? h('div', { className: 'wb-alert warn', style: { display: 'block' } },
              h('div', { className: 't' }, '比对范围限制'),
              h('div', { className: 'b' }, warnings.map((w, i) => h('div', { key: i }, '· ' + (RC_WARNING_LABELS[w] || rcShort(w, 200))))),
              Number(result.unsupportedUnchanged) > 0
                ? h('div', { className: 'b' }, '· 另有 ' + String(result.unsupportedUnchanged) + ' 处含公式或图片的段落文字未变，未做逐字节比较。') : null) : null,
            writePanel,
            footBar,
          )),
      );
    }

    function WorkbenchPage() {
      const s = useStore();
      const [toastMsg, setToastMsg] = useState(null);
      const [reportDirty, setReportDirty] = useState(false);
      const [foldersDirty, setFoldersDirty] = useState(false);
      // 文件夹模板页已改为纯 DOM 实现（见 FolderTemplatePage 上方注释）：树数据与 UI 状态都在
      // 模块级 FTPL 里，这里只留「有未保存改动」这一个布尔给 go() 做离页拦截。
      const [compareDirty, setCompareDirty] = useState(false);
      const [sub, setSub] = useState(() => {
        const saved = (s.settings.ui && s.settings.ui.subs) || {};
        return { work: saved.work || 'projects', study: saved.study || 'plans', stock: saved.stock || '' };
      });
      // 浮动对话窗的开关。放在 WorkbenchPage 里而不是模块级，是为了跟随页签切换保留、
      // 又能在离开工作台面板时自动卸载（组件树销毁即关闭，不留幽灵浮层）。
      const [dockOpen, setDockOpen] = useState(false);
      // 页签精简（2026-11-18）：只保留 工作/文件库/设置。历史存档里的旧 activeTab
      // （overview/study/stock/alerts）一律回落到 work，避免渲染无页签高亮的孤儿页。
      const KEPT = ['work', 'assistant', 'library', 'report-format', 'report-compare', 'data-tools', 'land-market', 'folder-template', 'settings'];
      // 「保持上次打开的界面」：当前页签/子页签/打开中的项目都持久化在 store.settings.ui，
      // 重开面板、刷新页面、重启宿主后都回到上次离开时的界面，而不是首页。
      const ui = s.settings.ui || {};
      const tab = KEPT.includes(ui.tab) ? ui.tab : 'work';
      // 提示条：后一条提示必须顶掉前一条**连同它的定时器** —— 否则 3.2 秒前那条提示的
      // 定时器会把刚弹出的新提示提前清掉（保存 = 停在表单后连着点几下就能撞上）。
      const toastTimer = useRef(null);
      const toast = (m, lv) => {
        setToastMsg({ m, lv: lv || 'info' });
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => { toastTimer.current = null; setToastMsg(null); }, 3200);
      };
      const go = (t, sb) => {
        if (tab === 'report-format' && t !== tab && reportDirty && !confirm('报告格式有未保存或未确认的修改，离开将丢失草稿，继续吗？')) return;
        if (tab === 'report-format' && t !== tab) setReportDirty(false);
        if (tab === 'folder-template' && t !== tab && foldersDirty && !confirm('文件夹模板有未保存的修改，离开将丢失，继续吗？')) return;
        if (tab === 'folder-template' && t !== tab) setFoldersDirty(false);
        if (tab === 'report-compare' && t !== tab) {
          if (compareDirty && !confirm('报告比对的差异结果还没写回，离开将丢失这次比对，继续吗？')) return;
          setCompareDirty(false);
        }
        patch('settings', x => ({ ...x, activeTab: t, ui: { ...x.ui, tab: t, ...(sb ? { subs: { ...(x.ui && x.ui.subs || {}), [t]: sb } } : {}) } }));
        if (sb) setSub({ ...sub, [t]: sb });
      };

      // quote polling + alert evaluation
      const refresh = useCallback(async () => {
        const codes = state.stock.watch.map(x => x.code);
        if (!codes.length) return;
        let quotes = {};
        try {
          // 股票 bundle 的行情口字段最全（成交量/成交额/换手率/市盈率）；
          // 宿主旧的 /quotes 字段少，作为回退。
          let r = null;
          try { r = await fetch('/api/workbench/stock/quotes?codes=' + encodeURIComponent(codes.join(','))); } catch (e) { r = null; }
          if (r && r.ok) {
            const j = await r.json();
            if (j && !j.error && Object.keys(j).length) quotes = j;
          }
          if (!Object.keys(quotes).length) {
            const r2 = await fetch('/api/workbench/quotes?codes=' + encodeURIComponent(codes.join(',')));
            if (r2.ok) quotes = await r2.json();
            else quotes = await fetchQuotes(codes);
          }
        } catch (e) { try { quotes = await fetchQuotes(codes); } catch (e2) { return; } }
        if (!Object.keys(quotes).length) return;
        const fired = [];
        store.set(st => {
          let next = { ...st, stock: { ...st.stock, quotes: { ...st.stock.quotes, ...quotes }, updatedAt: new Date().toISOString() } };
          if (!st.stock.alertsEnabled) return next;
          // Latch per (stock, condition): fire once when the condition turns true and stay
          // silent until the price leaves that level again — no重复提醒，也不用靠价格文案去重。
          const prevHits = st.stock.hits || {};
          const nextHits = { ...prevHits };
          st.stock.watch.forEach(x => {
            const q = quotes[x.code]; if (!q || !q.price) return;
            const conds = {};
            if (x.buyBelow) conds.buy = q.price <= Number(x.buyBelow);
            if (x.sellAbove) conds.sell = q.price >= Number(x.sellAbove);
            if (x.stopLoss) conds.stop = q.price <= Number(x.stopLoss);
            if (x.pctUp) conds.pctUp = Number(q.changePct) >= Number(x.pctUp);
            if (x.pctDown) conds.pctDown = Number(q.changePct) <= -Number(x.pctDown);
            Object.keys(conds).forEach(kind => {
              const k = x.id + '|' + kind;
              if (!conds[kind]) { delete nextHits[k]; return; }
              if (prevHits[k]) return;
              nextHits[k] = Date.now();
              const label = ALERT_KINDS[kind] || kind;
              const body = kind === 'buy' ? '价格 ' + fmt(q.price) + ' 已低于买入点 ' + x.buyBelow
                : kind === 'sell' ? '价格 ' + fmt(q.price) + ' 已达到卖出点 ' + x.sellAbove
                : kind === 'stop' ? '价格 ' + fmt(q.price) + ' 已跌破止损价 ' + x.stopLoss
                : kind === 'pctUp' ? '涨幅 ' + fmt(q.changePct) + '% 已达到 ' + x.pctUp + '%'
                : '跌幅 ' + fmt(q.changePct) + '% 已达到 ' + x.pctDown + '%';
              const before = next.alerts.length;
              next = addAlert(next, 'stock|' + x.id + '|' + kind + '|' + todayStr(), x.name + ' ' + label + '触发', body, kind === 'stop' ? 'danger' : 'warn');
              if (next.alerts.length > before) fired.push(x.name + ' ' + label + '：' + body);
            });
          });
          return { ...next, stock: { ...next.stock, hits: nextHits } };
        });
        fired.forEach(m => browserNotify('个人工作台 · 行情提醒', m));
      }, []);

      useEffect(() => {
        // 页签精简：股票模块停用后不再轮询行情/评估买卖点（恢复 stock 页签即自动恢复）
        if (tab !== 'stock') return;
        refresh();
        const secs = Math.max(30, Number(state.stock.pollSeconds) || 60);
        const iv = setInterval(refresh, secs * 1000);
        return () => clearInterval(iv);
      }, [refresh, tab]);

      // seed exam calendar from the host plugin; retried a few times
      // because the host route may not be registered yet right after a page load.
      useEffect(() => {
        let alive = true, tries = 0;
        const run = () => seedFromHost().then(c => {
          if (!alive) return;
          tries += 1;
          const ok = c && (c.calendar > 0 || c.bank > 0);
          if (!ok && tries < 6) setTimeout(run, 1200 * tries);
        }).catch(() => { if (alive && tries < 6) { tries += 1; setTimeout(run, 1200 * tries); } });
        run();
        return () => { alive = false; };
      }, []);

      // exam registration / countdown reminders (once per day, checked on mount and tab change)
      useEffect(() => {
        // 页签精简：学习/提醒模块停用后不再播种考试日历、不再发报名/倒计时提醒
        if (tab !== 'study') return;
        const today = todayStr(), key = 'dsh-workbench:exam-remind:' + today;
        if (localStorage.getItem(key)) return;
        const fired = [];
        store.set(st => {
          let next = st;
          st.study.exams.filter(e => e.active).forEach(e => {
            const m = EXAMS.find(x => x.id === e.id) || {};
            const fire = (title, body, level) => { const before = next.alerts.length; next = addAlert(next, 'exam|' + e.id + '|' + title, title, body, level); if (next.alerts.length > before) fired.push(title + '：' + body); };
            if (e.regStart && e.regEnd) {
              const d0 = dateDiff(e.regStart, today), d1 = dateDiff(e.regEnd, today);
              if (d0 >= 0 && d0 <= e.remindDays) fire(m.name + ' 报名即将开始', '报名 ' + e.regStart + ' 开始，还有 ' + d0 + ' 天，请准备材料', 'warn');
              if (d1 >= 0 && d1 <= e.remindDays) fire(m.name + ' 报名即将截止', '报名 ' + e.regEnd + ' 截止，还有 ' + d1 + ' 天', 'danger');
              if (d0 <= 0 && d1 >= 0) fire(m.name + ' 报名进行中', '报名窗口 ' + e.regStart + ' ~ ' + e.regEnd + '，请勿错过', 'info');
            }
            if (e.examDate) {
              const d = dateDiff(e.examDate, today);
              if (d === 30 || d === 14 || d === 7 || d === 3 || d === 1) fire(m.name + ' 考试倒计时', '距考试还有 ' + d + ' 天（' + e.examDate + '）', d <= 7 ? 'warn' : 'info');
            }
          });
          return next;
        });
        if (fired.length) { localStorage.setItem(key, '1'); fired.forEach(m => browserNotify('个人工作台 · 报名/考试提醒', m)); }
        else localStorage.setItem(key, '1');
      }, [tab]);

      const unread = s.alerts.filter(a => !a.read).length;
      // 页签精简（2026-11-18）：只保留 工作/文件库/设置；想恢复全部页签，
      // 用同目录 client.js.bak-fulltabs-* 覆盖回来，或把下面数组换回七项。
      const tabs = [['work', '工作'], ['assistant', '助手'], ['library', '文件库'], ['report-format', '报告格式'], ['report-compare', '报告比对'], ['data-tools', '数据工具'], ['land-market', '土地市场法'], ['folder-template', '文件夹模板'], ['settings', '设置']];
      return h('div', { className: 'wb-root' }, h(StyleTag, null), h('div', { className: 'wb-wrap' },
        h('h1', { className: 'wb-h1' }, '个人工作台'),
        h('p', { className: 'wb-sub' }, '资产评估项目管理 — ' + todayStr()),
        h('div', { className: 'wb-tabs' }, tabs.map(([k, t]) => h('button', { key: k, className: 'wb-tab ' + (tab === k ? 'on' : ''), onClick: () => go(k) }, t, k === 'alerts' && unread ? h('span', { className: 'wb-badge' }, unread) : null))),
        tab === 'overview' ? h(Overview, { s, go }) :
          tab === 'work' ? h(Work, { s, sub: sub.work, toast, go }) :
          tab === 'assistant' ? h(AssistantPanel, { toast, onOpenDock: () => setDockOpen(true) }) :
          tab === 'library' ? h(LibraryPanel, { toast }) :
          tab === 'report-format' ? h(ReportFormat, { toast, onDirtyChange: setReportDirty }) :
          tab === 'report-compare' ? h(ReportComparePage, { s, toast, onDirtyChange: setCompareDirty }) :
          tab === 'data-tools' ? h(DataTools, { toast }) :
          tab === 'land-market' ? h(LandMarketPanel) :
          tab === 'folder-template' ? h(FolderTemplatePage, { toast, onDirtyChange: setFoldersDirty }) :
          tab === 'study' ? h(Study, { s, sub: sub.study, toast, go }) :
          tab === 'stock' ? h(Stock, { s, toast, refresh }) :
          tab === 'alerts' ? h(Alerts, { s }) : h(Settings, { s, toast }),
        dockOpen ? h(AssistantDock, { onClose: () => setDockOpen(false) }) : null,
        toastMsg && h('div', { style: { position: 'fixed', bottom: 24, right: 24, zIndex: 10000, padding: '10px 16px', borderRadius: 8, background: toastMsg.lv === 'danger' ? '#c0392b' : toastMsg.lv === 'warn' ? '#a35b00' : '#1d4ed8', color: '#fff', fontSize: 12, boxShadow: '0 6px 20px rgba(0,0,0,.3)' } }, toastMsg.m),
      ));
    }

    // ---------- sidebar icon ----------
    function WorkbenchIcon({ size, active }) {
      const s = size || 20;
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('rect', { x: 3, y: 3, width: 8, height: 8, rx: 1.6 }), h('rect', { x: 13, y: 3, width: 8, height: 8, rx: 1.6 }),
        h('rect', { x: 3, y: 13, width: 8, height: 8, rx: 1.6 }), h('rect', { x: 13, y: 13, width: 8, height: 8, rx: 1.6 }),
      );
    }

    // ---------- 自诊断（真机取证用；正常时无副作用） ----------
    // 面板空白时最先要回答的是：apply 跑没跑、槽位注册成功没有、渲染有没有抛错。
    // 生产环境拿不到控制台，所以写一份到 localStorage['dsh-workbench:diag']。
    const DIAG_KEY = 'dsh-workbench:diag';
    let wbDiagInfo = {};
    function wbDiag(patch) {
      try {
        wbDiagInfo = Object.assign({}, wbDiagInfo, patch, { at: new Date().toISOString() });
        if (typeof localStorage !== 'undefined') localStorage.setItem(DIAG_KEY, JSON.stringify(wbDiagInfo).slice(0, 4000));
        if (typeof document !== 'undefined' && document.body) document.body.setAttribute('data-wb-diag', JSON.stringify(wbDiagInfo).slice(0, 1200));
      } catch (_) {}
      return wbDiagInfo;
    }
    // 渲染错误边界：面板内部抛错时显示原因，而不是留一片空白。
    // 注意：DSH 宿主前端的 React 有可能是精简 shim（不含 Component）。
    // 若直接 `extends React.Component`，在模块求值阶段就会抛
    // "Class extends value undefined is not a constructor"，连带整个 client 模块
    // factory 失败 → apply() 里的 sidebar.panellist 注册不执行 → 侧栏【个人工作台】消失。
    // 这里做兜底：有真 Component 就用真错误边界，没有则用最小构造函数保证模块不炸。
    const WbErrorBase = (React && React.Component) || function ComponentFallback(props) { this.props = props || {}; };
    class WbErrorBoundary extends WbErrorBase {
      constructor(props) { super(props); this.state = { err: null }; }
      static getDerivedStateFromError(err) { return { err }; }
      componentDidCatch(err) { wbDiag({ renderError: String((err && err.stack) || err).slice(0, 800) }); }
      render() {
        if (!this.state.err) return this.props.children;
        return h('div', { className: 'wb-root' }, h('div', { className: 'wb-wrap' },
          h('h1', { className: 'wb-h1' }, '个人工作台'),
          h('p', { className: 'wb-sub' }, '面板渲染出错，已捕获，以下是原始信息'),
          h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.5, padding: 12, border: '1px solid var(--dsw-alias-border-l1,#e5e5e5)', borderRadius: 8 } },
            String((this.state.err && this.state.err.stack) || this.state.err))));
      }
    }

    // ---------- cordis client half ----------
    // 右侧栏精简工作台（better-sidebar 页签）：天源绑定状态 + 快捷入口。
    // 对接主通道是 tycpv CLI / valuation-mcp（官方授权，无浏览器插件）；
    // better-sidebar 未启用时由 apply() 里的守卫跳过，不影响主区工作台。
    function TyLitePanel() {
      const [mcp, setMcp] = useState(null);
      const [cli, setCli] = useState(null);
      const [busy, setBusy] = useState(false);
      const [liteTab, setLiteTab] = useState('status');
      const [liteToast, setLiteToast] = useState(null);
      const toastTimer = React.useRef(null);
      const toast = (msg, kind) => {
        setLiteToast({ msg, kind });
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setLiteToast(null), 3000);
      };
      React.useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);
      const load = async () => {
        setBusy(true);
        const j = async u => { try { const r = await fetch(PREFIX + u); return await r.json().catch(() => ({ error: '无法解析响应' })); } catch (e) { return { error: String(e.message || e) }; } };
        const [m, c] = await Promise.all([j('/ty/status'), j('/ty/cli/status')]);
        setMcp(m); setCli(c); setBusy(false);
      };
      useEffect(() => { load(); }, []);
      const openTy = () => { try { if (rightBar && typeof rightBar.openTab === 'function') rightBar.openTab('browser', { params: { url: TY_BASE } }); } catch (e) {} };
      const fmtExp = s => (s ? String(s).slice(0, 16).replace('T', ' ') : '');
      const mcpLine = !mcp ? '正在检查…'
        : mcp.error ? '检查失败：' + mcp.error
        : mcp.connected ? '已绑定' + (mcp.user && (mcp.user.fullName || mcp.user.userName) ? '：' + (mcp.user.fullName || mcp.user.userName) : '') + (mcp.expiresAt ? '，有效期至 ' + fmtExp(mcp.expiresAt) : '')
        : (mcp.expired ? '授权已过期，请在「工作 → 连接设置」重新连接' : '未绑定，请在「工作 → 连接设置」完成授权');
      const cliLine = !cli ? '正在检查…'
        : cli.error ? '检查失败：' + cli.error
        : !cli.installed ? '未找到 tycpv CLI' + (cli.reason ? '：' + cli.reason : '')
        : cli.authenticated ? '本地凭据有效' + (cli.expiresAt ? '，至 ' + fmtExp(cli.expiresAt) : '') + '（不等于远端授权一定有效）'
        : cli.expired ? '本地凭据已过期' + (cli.expiresAt ? '（' + fmtExp(cli.expiresAt) + '）' : '') + '，请在「工作 → 连接设置」点「授权 CLI」'
        : '无有效本地凭据，请在「工作 → 连接设置」点「授权 CLI」';
      return h('div', { style: { padding: '10px 12px', fontSize: 12, color: 'var(--dsw-alias-label-primary,#222)', overflow: 'auto', height: '100%', boxSizing: 'border-box' } },
        liteToast && h('div', { style: { position: 'fixed', top: 14, right: 14, zIndex: 99, padding: '6px 12px', borderRadius: 8, background: liteToast.kind === 'danger' ? 'var(--dsw-alias-state-error-primary,#c0392b)' : 'var(--dsw-alias-state-success-primary,#2e7d32)', color: '#fff', fontSize: 12, boxShadow: '0 2px 8px rgba(0,0,0,.25)' } }, liteToast.msg),
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 } },
          h('b', null, '个人工作台'),
          h('button', { className: 'wb-btn sm', onClick: load, disabled: busy }, busy ? '检查中…' : '刷新')),
        h('div', { style: { display: 'flex', gap: 6, marginBottom: 10 } },
          h('button', { className: 'wb-btn sm', style: liteTab === 'status' ? { fontWeight: 700 } : null, onClick: () => setLiteTab('status') }, '状态'),
          h('button', { className: 'wb-btn sm', style: liteTab === 'format' ? { fontWeight: 700 } : null, onClick: () => setLiteTab('format') }, '报告格式')),
        liteTab === 'format'
          ? h(ReportFormat, { toast })
          : h('div', null,
        h('button', { className: 'wb-btn sm', style: { width: '100%', marginBottom: 10 }, onClick: openTy }, '打开天源网页'),
        h('div', { style: { border: '1px solid var(--dsw-alias-border-l1,#ddd)', borderRadius: 8, padding: 8, marginBottom: 8 } },
          h('div', { className: 'wb-label' }, '天源授权绑定（MCP）'),
          h('div', null, mcpLine)),
        h('div', { style: { border: '1px solid var(--dsw-alias-border-l1,#ddd)', borderRadius: 8, padding: 8 } },
          h('div', { className: 'wb-label' }, 'CLI 绑定（tycpv）'),
          h('div', null, cliLine),
          h('div', { className: 'wb-hint', style: { marginTop: 4 } }, 'MCP 与 CLI 凭据相互独立；项目同步与导出走 CLI/MCP，网页表单类操作走 opencli 驱动你自己的 Chrome。'))));
    }
    // ---------- 助手（第四个模块）：工作台内的浮动对话窗 ----------
    // 为什么不用右侧栏的 sidechat：工作台是 main slot 里的一个 keyed 主面板，
    // 用户切到工作台后 activePanelId !== null，右侧栏的 SidebarSessionViews 拿不到
    // selected view，controller.mounted 恒为 undefined（seat 根本没挂载），于是
    // better-sidebar 的 openTab 在 `if (targetSessionId === void 0) return;` 静默返回、
    // 原生 openTab(kind) 直接抛 `sidebarRight: no session surface is mounted`。
    // 也就是说「在工作台里打开右侧对话页签」在这套架构下做不到。
    // 所以改成自绘浮层：不依赖 sidebarRight，也不依赖 better-sidebar 是否安装。

    const ASSISTANT_HINTS = ['/项目', '/状态', '/导出'];
    // 模型选择记在 localStorage：用户挑了哪个就用哪个，重开窗口不用再挑一次。
    const ASSISTANT_MODEL_KEY = 'dsh-workbench:assistant-model';
    // 浮动窗位置也记下来，拖到哪儿下次还在哪儿。
    const ASSISTANT_POS_KEY = 'dsh-workbench:assistant-pos';
    // 对话记录也持久化：关窗、切页签、刷新页面都不丢；最多留 60 条。
    const ASSISTANT_CHAT_KEY = 'dsh-workbench:assistant-chat';
    const ASSISTANT_CHAT_MAX = 60;
    const ASSISTANT_MSG_MAX_CHARS = 4000; // 单条入库截断，防止工具长结果把 localStorage 撑爆

    // 这个插件其余地方直接用的是裸 localStorage；这里包一层，两个都能用，
    // 且 localStorage 被禁用（隐私模式/配额满）时不让整块崩掉。
    function assistantStore() {
      try { if (typeof window !== 'undefined' && window.localStorage) return window.localStorage; } catch (_) {}
      try { if (typeof localStorage !== 'undefined') return localStorage; } catch (_) {}
      return null;
    }

    function readAssistantModel() {
      try {
        const st = assistantStore();
        if (!st) return null;
        const raw = st.getItem(ASSISTANT_MODEL_KEY);
        if (!raw) return null;
        const v = JSON.parse(raw);
        return v && v.provider && v.model ? { provider: String(v.provider), model: String(v.model) } : null;
      } catch (_) { return null; }
    }

    function writeAssistantModel(sel) {
      try {
        const st = assistantStore();
        if (!st) return;
        if (sel && sel.provider && sel.model) st.setItem(ASSISTANT_MODEL_KEY, JSON.stringify({ provider: sel.provider, model: sel.model }));
        else st.removeItem(ASSISTANT_MODEL_KEY);
      } catch (_) {}
    }

    function readAssistantPos() {
      try {
        const st = assistantStore();
        if (!st) return null;
        const raw = st.getItem(ASSISTANT_POS_KEY);
        if (!raw) return null;
        const v = JSON.parse(raw);
        return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? { x: v.x, y: v.y } : null;
      } catch (_) { return null; }
    }

    function writeAssistantPos(pos) {
      try {
        const st = assistantStore();
        if (!st) return;
        st.setItem(ASSISTANT_POS_KEY, JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) }));
      } catch (_) {}
    }

    // 对话记录持久化：只存 {role, content}，读回来直接当历史消息用。
    function readAssistantChat() {
      try {
        const st = assistantStore();
        if (!st) return [];
        const raw = st.getItem(ASSISTANT_CHAT_KEY);
        if (!raw) return [];
        const v = JSON.parse(raw);
        if (!Array.isArray(v)) return [];
        return v.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .slice(-ASSISTANT_CHAT_MAX);
      } catch (_) { return []; }
    }

    function writeAssistantChat(msgs) {
      try {
        const st = assistantStore();
        if (!st) return;
        const list = (Array.isArray(msgs) ? msgs : [])
          .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
          .slice(-ASSISTANT_CHAT_MAX)
          .map(m => ({ role: m.role, content: m.content.slice(0, ASSISTANT_MSG_MAX_CHARS) }));
        if (list.length) st.setItem(ASSISTANT_CHAT_KEY, JSON.stringify(list));
        else st.removeItem(ASSISTANT_CHAT_KEY);
      } catch (_) {}
    }

    // 把位置夹在可视区内：窗口宽高由 CSS 决定，这里只知道一个上限。
    // 拖动/缩放后窗口可能跑到屏幕外，夹回来比让用户自己找回来体验好。
    function clampAssistantPos(pos, size) {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
      const w = Math.min(size.w, vw - 24);
      const hgt = Math.min(size.h, vh - 24);
      return {
        x: Math.max(8, Math.min(pos.x, vw - w - 8)),
        y: Math.max(8, Math.min(pos.y, vh - hgt - 8)),
      };
    }

    function AssistantDock({ onClose }) {
      // 对话记录从 localStorage 恢复，关窗/切页签/刷新都不丢
      const [msgs, setMsgs] = useState(() => readAssistantChat());
      const [input, setInput] = useState('');
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState('');
      const [meta, setMeta] = useState('');
      const [big, setBig] = useState(false);
      const [models, setModels] = useState(null);     // {providers, current} | {error}
      const [sel, setSel] = useState(() => readAssistantModel());
      // 位置用 null 表示「还没动过」，此时走右下角默认定位；一旦拖动就转成绝对坐标。
      const [pos, setPos] = useState(() => readAssistantPos());
      const [dragging, setDragging] = useState(false);
      const listRef = useRef(null);
      const rootRef = useRef(null);      // 浮层根节点，量位置用（别靠 parentElement，DOM 结构一改就错）
      const liveRef = useRef(true);
      const dragRef = useRef(null);      // {dx, dy} 指针与窗口左上角的偏移
      const posRef = useRef(pos);        // 拖动中读最新值，避免闭包拿到旧 state
      const sizeRef = useRef({ w: 420, h: 560 });
      useEffect(() => { posRef.current = pos; }, [pos]);

      useEffect(() => () => { liveRef.current = false; }, []);
      // 对话记录变化即落盘（写入函数内部已做过滤/截断/裁剪）
      useEffect(() => { writeAssistantChat(msgs); }, [msgs]);
      useEffect(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }, [msgs, busy]);

      // 模型列表只在打开时拉一次；失败也要能继续用（后端会退回默认模型）。
      useEffect(() => {
        let alive = true;
        fetch(PREFIX + '/lib/models').then(r => r.json()).then(d => {
          if (!alive) return;
          if (d && Array.isArray(d.providers)) setModels(d);
          else setModels({ providers: [], error: (d && d.error) || '取不到模型列表' });
        }).catch(e => { if (alive) setModels({ providers: [], error: String((e && e.message) || e) }); });
        return () => { alive = false; };
      }, []);

      // 拖动：在标题栏按下时记录偏移，挂到 window 上跟随，抬起即解绑。
      const onHeaderDown = (e) => {
        if (e.button !== 0) return;
        if (e.target && e.target.closest && e.target.closest('button,select,input')) return;
        const root = rootRef.current;
        if (!root) return;
        const rect = root.getBoundingClientRect();
        dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        sizeRef.current = { w: rect.width, h: rect.height };
        setDragging(true);
        e.preventDefault();
      };

      useEffect(() => {
        if (!dragging) return () => {};
        const move = (e) => {
          const d = dragRef.current;
          if (!d) return;
          const next = clampAssistantPos({ x: e.clientX - d.dx, y: e.clientY - d.dy }, sizeRef.current);
          posRef.current = next;   // 同步写一份：mouseup 可能比 effect 先到，靠它拿到最终坐标
          setPos(next);
        };
        const up = () => {
          setDragging(false);
          const cur = posRef.current;
          if (cur) writeAssistantPos(cur);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        return () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
      }, [dragging]);

      const resetPos = () => { setPos(null); try { const st = assistantStore(); if (st) st.removeItem(ASSISTANT_POS_KEY); } catch (_) {} };

      // 放大/还原会改窗口尺寸：停在屏幕边缘的窗口可能因此越界，顺手夹一次。
      const toggleBig = () => {
        const next = !big;
        setBig(next);
        if (pos) {
          const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
          const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
          setPos(clampAssistantPos(pos, next ? { w: Math.min(860, vw - 48), h: vh - 120 } : { w: 420, h: 560 }));
        }
      };

      const send = async (raw) => {
        const text = String(raw == null ? input : raw).trim();
        if (!text || busy) return;
        setInput('');
        setErr('');
        const history = msgs.concat([{ role: 'user', content: text }]);
        setMsgs(history.concat([{ role: 'assistant', content: '' }]));
        setBusy(true);
        const patchLast = (content) => {
          if (!liveRef.current) return;
          setMsgs(cur => {
            const next = cur.slice();
            if (!next.length) return cur;
            next[next.length - 1] = { role: 'assistant', content };
            return next;
          });
        };
        try {
          const body = { messages: history.map(m => ({ role: m.role, content: m.content })) };
          if (sel && sel.provider && sel.model) { body.provider = sel.provider; body.model = sel.model; }
          const res = await fetch(PREFIX + '/assistant/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok || !res.body) {
            const d = await res.json().catch(() => ({}));
            throw new Error(d.error || ('HTTP ' + res.status));
          }
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          let acc = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const line = block.split('\n').filter(x => x.indexOf('data: ') === 0).pop();
              if (!line) continue;
              const payload = line.slice(6);
              if (payload === '[DONE]') continue;
              let evt = null;
              try { evt = JSON.parse(payload); } catch (_) { continue; }
              if (evt.type === 'text') { acc += evt.text; patchLast(acc); }
              else if (evt.type === 'tool') { acc += '〔正在查天源 · ' + (evt.name || '') + '〕\n'; patchLast(acc); }
              else if (evt.type === 'error') { setErr(evt.message || '模型返回错误'); }
              else if (evt.type === 'meta' && evt.stage === 'model') { setMeta(evt.provider + ' · ' + evt.model); }
            }
          }
          if (!acc) patchLast('（没有返回内容）');
        } catch (e) {
          if (liveRef.current) setErr(String((e && e.message) || e));
          patchLast('');
        } finally {
          if (liveRef.current) setBusy(false);
        }
      };

      const onKey = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      };

      const onPickModel = (e) => {
        const v = e.target.value;
        if (!v) { setSel(null); writeAssistantModel(null); return; }
        const [provider, ...rest] = v.split('|');
        const next = { provider, model: rest.join('|') };
        setSel(next); writeAssistantModel(next);
      };

      // 位置：拖过就用绝对坐标；没拖过就退回右下角（用 right/bottom 交给浏览器排版，
      // 这样窗口大小变化时不会错位）。
      const frame = big
        ? { width: 'min(860px, calc(100vw - 48px))', height: 'calc(100vh - 120px)' }
        : { width: 420, height: 560 };
      const place = pos
        ? { left: Math.round(pos.x), top: Math.round(pos.y), right: 'auto', bottom: 'auto' }
        : { left: 'auto', top: 'auto', right: 20, bottom: 20 };

      const modelOptions = (() => {
        const out = [h('option', { key: '__auto', value: '' }, '默认模型')];
        const providers = (models && Array.isArray(models.providers)) ? models.providers : [];
        for (const p of providers) {
          for (const m of (p.models || [])) {
            out.push(h('option', { key: p.id + '|' + m.id, value: p.id + '|' + m.id },
              (p.models.length > 1 ? (p.name || p.id) + ' · ' : '') + (m.name || m.id)));
          }
        }
        return out;
      })();
      // 存过的模型可能已经下线：列表加载完后校验一次，失配就退回「默认模型」，
      // 否则 <select> 会显示成空白，看着像坏了。
      const available = !models ? null : new Set(
        ((models.providers) || []).reduce((acc, p) => acc.concat((p.models || []).map(m => p.id + '|' + m.id)), [])
      );
      const wanted = sel && sel.provider && sel.model ? sel.provider + '|' + sel.model : '';
      const selValue = wanted && available && !available.has(wanted) ? '' : wanted;
      // 标题栏优先显示本轮实际用的模型（来自后端 meta），没发过消息就显示当前选中的那个。
      const headerMeta = meta || (selValue ? selValue.replace('|', ' · ') : '');

      return h('div', {
        ref: rootRef,
        role: 'dialog',
        'aria-label': '工作台助手',
        style: Object.assign({
          position: 'fixed', zIndex: 9998, display: 'flex', flexDirection: 'column',
          background: 'var(--dsw-alias-bg-l1,#fff)', color: 'var(--dsw-alias-label-primary,#111)',
          border: '1px solid var(--dsw-alias-border-l1,#ddd)', borderRadius: 12,
          boxShadow: dragging ? '0 18px 52px rgba(0,0,0,.30)' : '0 12px 40px rgba(0,0,0,.22)',
          overflow: 'hidden',
        }, frame, place),
      },
        // 标题栏：可拖动，双击复位到右下角。
        h('div', {
          onMouseDown: onHeaderDown,
          onDoubleClick: resetPos,
          title: '按住可拖动窗口，双击回到右下角',
          style: {
            display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px',
            borderBottom: '1px solid var(--dsw-alias-border-l1,#eee)',
            background: 'var(--dsw-alias-bg-l2,#f7f7f8)',
            cursor: dragging ? 'grabbing' : 'grab', userSelect: 'none',
          },
        },
          h('strong', { style: { fontSize: 13 } }, '工作台助手'),
          headerMeta ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary,#888)' } }, headerMeta) : null,
          h('span', { style: { flex: 1 } }),
          h('button', {
            className: 'wb-btn sm',
            disabled: busy || !msgs.length,
            title: '清空对话记录（同时清掉本地保存的）',
            onClick: () => { if (window.confirm && !window.confirm('清空全部对话记录？')) return; setMsgs([]); },
          }, '清空'),
          h('button', { className: 'wb-btn sm', onClick: toggleBig, title: big ? '还原大小' : '放大' }, big ? '还原' : '放大'),
          h('button', { className: 'wb-btn sm', onClick: onClose, title: '关闭' }, '关闭')),

        // 模型选择条：放在标题栏下面一行，不挤占对话区。
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
            borderBottom: '1px solid var(--dsw-alias-border-l1,#eee)',
            fontSize: 12, color: 'var(--dsw-alias-label-secondary,#666)',
          },
        },
          h('span', null, '模型'),
          h('select', {
            value: selValue,
            onChange: onPickModel,
            title: '选择本对话使用的模型',
            style: {
              flex: 1, minWidth: 0, height: 26, borderRadius: 6, fontSize: 12,
              border: '1px solid var(--dsw-alias-border-l1,#ddd)',
              background: 'var(--dsw-alias-bg-l1,#fff)', color: 'inherit', padding: '0 6px',
            },
          }, modelOptions),
          models && models.error
            ? h('span', { style: { color: '#c0392b', fontSize: 11 } }, '列表不可用')
            : null),

        h('div', {
          ref: listRef,
          style: { flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 },
        },
          msgs.length === 0 ? h('div', { className: 'wb-hint', style: { lineHeight: 1.7 } },
            '问项目进度、工时、天源绑定状态，或直接打命令。',
            h('br'), '可用命令：',
            ASSISTANT_HINTS.map(k => h('code', {
              key: k, style: { marginLeft: 6, cursor: 'pointer', padding: '1px 5px', borderRadius: 4, background: 'var(--dsw-alias-bg-l2,#f0f0f2)' },
              onClick: () => send(k),
            }, k)),
            h('br'), '助手只读工作台数据，不会替你改项目或跑导出。') : null,
          msgs.map((m, i) => h('div', { key: i, style: { display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' } },
            h('div', {
              style: {
                maxWidth: '86%', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6,
                fontSize: 13, padding: '8px 11px', borderRadius: 10,
                background: m.role === 'user' ? '#1d4ed8' : 'var(--dsw-alias-bg-l2,#f2f3f5)',
                color: m.role === 'user' ? '#fff' : 'inherit',
              },
            }, m.content || (busy && i === msgs.length - 1 ? '…' : '')))),
          err ? h('div', { style: { fontSize: 12, color: '#c0392b', padding: '6px 2px' } }, err) : null),

        h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l1,#eee)', padding: 10 } },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'flex-end' } },
            h('textarea', {
              className: 'wb-input',
              rows: 2,
              value: input,
              placeholder: '问点什么…（Enter 发送，Shift+Enter 换行）',
              style: { flex: 1, resize: 'none', lineHeight: 1.5, fontFamily: 'inherit' },
              onChange: e => setInput(e.target.value),
              onKeyDown: onKey,
            }),
            h('button', { className: 'wb-btn', onClick: () => send(), disabled: busy || !input.trim() }, busy ? '…' : '发送'))));
    }

    function AssistantPanel({ toast, onOpenDock }) {
      const [mcp, setMcp] = useState(null);
      const [cli, setCli] = useState(null);
      const [busy, setBusy] = useState(false);
      const api = async (path) => {
        const r = await fetch(PREFIX + path);
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return d;
      };
      const load = () => {
        setBusy(true);
        Promise.all([
          api('/ty/status').catch(e => ({ error: String(e.message || e) })),
          api('/ty/cli/status').catch(e => ({ error: String(e.message || e) })),
        ]).then(([m, c]) => { setMcp(m); setCli(c); setBusy(false); });
      };
      useEffect(() => { load(); }, []);
      const fmtExp = s => (s ? String(s).slice(0, 16).replace('T', ' ') : '');
      const mcpOk = !!(mcp && mcp.connected);
      const cliOk = !!(cli && cli.installed && cli.authenticated);
      const mcpLine = !mcp ? '正在检查…'
        : mcp.error ? '检查失败：' + mcp.error
        : mcp.connected ? '已绑定' + (mcp.user && (mcp.user.fullName || mcp.user.userName) ? '：' + (mcp.user.fullName || mcp.user.userName) : '') + (mcp.expiresAt ? '，有效期至 ' + fmtExp(mcp.expiresAt) : '') + (mcp.toolCount ? '，' + mcp.toolCount + ' 个工具' : '')
        : (mcp.expired ? '授权已过期，请在「工作 → 连接设置」重新连接' : '未绑定，请在「工作 → 连接设置」完成授权');
      const cliLine = !cli ? '正在检查…'
        : cli.error ? '检查失败：' + cli.error
        : !cli.installed ? '未找到 tycpv CLI' + (cli.reason ? '：' + cli.reason : '')
        : cli.authenticated ? '本地凭据有效' + (cli.expiresAt ? '，至 ' + fmtExp(cli.expiresAt) : '') + '（不等于远端授权一定有效）'
        : cli.expired ? '本地凭据已过期' + (cli.expiresAt ? '（' + fmtExp(cli.expiresAt) + '）' : '') + '，请在「工作 → 连接设置」点「授权 CLI」'
        : '无有效本地凭据，请在「工作 → 连接设置」点「授权 CLI」';
      const dot = ok => h('span', { style: { display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: ok ? 'var(--dsw-alias-state-success-primary,#2e7d32)' : 'var(--dsw-alias-border-l2,#aaa)', marginRight: 6 } });
      const tools = [
        ['/项目 [关键词]', '列出项目、工时与天源项目 ID'],
        ['/状态', '输出工作台与天源的当前状态'],
        ['/导出', '给出明细表 / 申报表导出的操作步骤'],
      ];
      return h('div', { className: 'wb-card' },
        h('h3', null, '助手'),
        h('div', { className: 'wb-hint', style: { marginBottom: 12 } },
          '点下面的按钮，会在工作台页面右下角打开一个浮动对话窗：可以按住标题栏拖到任意位置（双击回到右下角），顶上能选模型；它只读你的项目数据来回答，切换页签也不会关掉。'),
        h('div', { className: 'wb-grid', style: { marginBottom: 12 } },
          h('div', { className: 'wb-card', style: { padding: 10 } },
            h('div', { className: 'wb-label' }, '天源 MCP（valuation-mcp）'),
            h('div', { style: { fontSize: 12 } }, dot(mcpOk), mcpLine)),
          h('div', { className: 'wb-card', style: { padding: 10 } },
            h('div', { className: 'wb-label' }, 'CLI（tycpv）'),
            h('div', { style: { fontSize: 12 } }, dot(cliOk), cliLine))),
        h('div', { className: 'wb-row', style: { gap: 8, marginBottom: 12 } },
          h('button', { className: 'wb-btn', onClick: () => { if (onOpenDock) onOpenDock(); } }, '打开对话窗'),
          h('button', { className: 'wb-btn sm', onClick: load, disabled: busy }, busy ? '检查中…' : '刷新状态')),
        h('div', { className: 'wb-label', style: { marginBottom: 4 } }, '对话中可以直接使用的命令'),
        h('div', { style: { border: '1px solid var(--dsw-alias-border-l1,#ddd)', borderRadius: 8, overflow: 'hidden' } },
          tools.map(([n, d], i) => h('div', { key: n, style: { display: 'flex', gap: 10, padding: '7px 10px', fontSize: 12, borderTop: i ? '1px solid var(--dsw-alias-border-l1,#eee)' : 'none' } },
            h('code', { style: { flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary,#555)' } }, n),
            h('span', null, d)))),
        h('div', { className: 'wb-hint', style: { marginTop: 10 } },
          '命令不消耗模型额度；自由提问会调用当前默认模型。所有写操作（改项目、跑导出）仍要你在界面上确认。'));
    }

    const inject = ['slots', 'locale', 'layout', 'sidebarRight', 'betterSidebar'];
    function apply(ctx) {
      workspacePicker = null;
      if (typeof ctx.get === 'function') { try { const s = ctx.get('uiWorkspace'); if (s && typeof s.pickDirectory === 'function') workspacePicker = s; } catch (_) {} }
      rightBar = (ctx.sidebarRight && typeof ctx.sidebarRight.openTab === 'function') ? ctx.sidebarRight : null;
      if (!rightBar && typeof ctx.get === 'function') { try { const s = ctx.get('sidebarRight'); if (s && typeof s.openTab === 'function') rightBar = s; } catch (err) {} }
      // 右侧栏精简工作台页签：依赖 better-sidebar 的 registerTab 扩展点（本机已启用）。
      let betterSidebar = null;
      try { betterSidebar = ctx.betterSidebar || (typeof ctx.get === 'function' ? ctx.get('betterSidebar') : null); } catch (_) {}
      if (betterSidebar && typeof betterSidebar.registerTab === 'function') {
        ctx.effect(() => betterSidebar.registerTab({ id: 'workbench:lite', title: '工作台', component: () => h(TyLitePanel) }));
        // 完整工作台：store 是模块级单例（订阅广播），主区与右侧栏双实例自动同步。
        ctx.effect(() => betterSidebar.registerTab({ id: 'workbench:full', title: '工作台·完整', component: () => h(WorkbenchPage) }));
      }
      let t = () => '个人工作台';
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh: { panel: '个人工作台' }, en: { panel: 'Personal Workbench' } }));
        t = ctx.locale.bind(NS);
      } catch (e) { t = () => '个人工作台'; }
      const PanelSafe = (props) => h(WbErrorBoundary, null, h(WorkbenchPage, props));
      const reg = { version: 'v-diag-1', inject: inject.slice(), slots: !!ctx.slots, locale: !!ctx.locale, betterSidebar: !!betterSidebar };
      try {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, PanelSafe));
        reg.main = 'ok';
      } catch (err) { reg.main = 'ERR ' + String((err && err.message) || err); }
      try {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 80, label: () => t('panel'), locale: NS,
        }, WorkbenchIcon));
        reg.sidebar = 'ok';
      } catch (err) { reg.sidebar = 'ERR ' + String((err && err.message) || err); }
      wbDiag({ apply: reg });
      // 全局错误兜底：真机里最头疼的是「面板没了但没有任何提示」。
      // 这里把首个未捕获异常写进 diag，用户只要把 localStorage['dsh-workbench:diag'] 发过来就能定位。
      try {
        if (typeof window !== 'undefined' && !window.__wbDiagHooked) {
          window.__wbDiagHooked = true;
          window.addEventListener('error', (ev) => {
            wbDiag({ windowError: String((ev && ev.message) || ev).slice(0, 500), file: String((ev && ev.filename) || '').slice(-120), line: ev && ev.lineno });
          });
          window.addEventListener('unhandledrejection', (ev) => {
            const r = ev && ev.reason;
            wbDiag({ rejection: String((r && (r.stack || r.message)) || r).slice(0, 500) });
          });
        }
      } catch (_) {}
    }
    const module = { exports: {} }, exports = module.exports;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});