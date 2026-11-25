# 个人工作台 · DSH 左侧边栏插件

> 一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的本地插件：资产评估项目管理 + 天源评估系统对接 + 考试提醒 + 自选股行情。MIT 开源，欢迎参与开发。

在 DeepSeek Harness 左侧边栏新增「个人工作台」入口，包含三大模块：

- **工作（资产评估）**：项目管理、工时管理、天源系统对接（CLI/MCP 真实通道）。
- **学习**：7 类考试（资产评估师实务一与相关知识、CPA、中级会计师、房地产估价师、矿业权评估师、中级经济师、期货投资分析）的报名/考试提醒，以及按考试紧迫度加权的学习规划排课。
- **股票**：20 列自选股行情表（照参考截图：最新价/涨跌/涨跌幅/最高最低/今开昨收/市盈率/成交量/成交额/换手率/成本/持仓/盈亏/时间）、多数据源近 1/3/5/6 年日线下载（默认 6 年）（AKShare、Tushare·tushareMcp、Baostock、efinance、腾讯备用）、本地 SQLite 自选股库、自选股拖动排序、MA/MACD/KDJ/RSI/BOLL 指标与买卖信号、K 线图（Ctrl+滚轮缩放/拖动平移）、神奇九转（TD Sequential）；买入卖出提醒改为每日 13:00 按九转提示，价格到点提醒改为可选。

## 参与开发（给协作者）

### 环境要求

1. **DeepSeek Harness 桌面版**（macOS / Windows 均可；Windows 为原始目标平台，macOS 已适配）。
2. **Node.js ≥ 20**（DSH 自带运行时即可跑插件；开发期语法检查用任意本地 node）。
3. **Python 3.10+**（仅股票/知识库/文档解析模块需要；插件优先使用 `~/.dsh/workbench-venv` 专用虚拟环境，缺失时回退 `python3`）。推荐安装：`PyYAML PyMuPDF xlrd python-docx openpyxl pandas akshare baostock efinance tushare`。
4. **天源 CLI `tycpv`**（可选）：只影响天源导出/导入功能；没有它其余模块照常工作。天源是商业内网系统，**本仓库不包含也不需要**其访问凭据。

### 本地开发工作流

```bash
# 1. clone 到任意目录
git clone https://github.com/zer0-lyz/dsh-ty-workbench.git
cd dsh-ty-workbench

# 2. 语法检查（改完必须过）
node --check index.js && node --check client.js

# 3. 安装到 DSH（在 DSH 内的会话里执行，或让 agent 执行）
#    plugin_manager: install_bundle，target 指向本仓库目录
#    或在 DSH 界面：插件 → 添加插件 → 选择本目录

# 4. 重启 DSH 桌面版生效（宿主半侧改动必须重启；网页半侧刷新页面即可）
```

### 目录导读

| 文件 | 职责 |
|---|---|
| `index.js` | 宿主半侧：全部 API 路由（`/api/workbench/*`）、天源导出/导入编排 |
| `client.js` | 网页半侧：全部界面（React，无构建步骤，动态模块直接加载） |
| `tianyuan.js` | 天源 MCP 授权与 JSON-RPC 客户端（PKCE OAuth，凭据只存本机） |
| `cli-auth.js` | tycpv CLI 授权流程与本地凭据状态 |
| `export-workflow.js` | 手动整理工作流：独立批次、不覆盖源文件、逐文件结果 |
| `tysync.js` | 天源网页表单同步引擎（ego 浏览器驱动，含回读校验） |
| `store.js` / `library.js` / `archive.js` | 数据落盘 / 归档库 / 知识库根 |
| `vehicle_cert.py` | 车辆权证识别归档：行驶证/登记证/里程表 → markdown → 按车牌归档 → 权证信息表（含 `stage` 整理待上传副本） |
| `vehicle-upload.js` | 权证索引上传：opencli 驱动 Chrome → 附件上传 → 分类保存 → 回写单元格 |
| `*.py` | 知识库扫描、文档解析、股权/财务导入 |

### 协作约定

- **数据与凭据永远不入库**：`.gitignore` 已排除凭据文件、工作簿、备份；提交前自查不含真实项目数据、姓名、机构内部路径。
- **改宿主半侧（index.js）需重启 DSH**；改 client.js 刷新页面即可。
- 每次提交前跑 `node --check`；涉及导出/整理逻辑的改动请在**隔离临时目录 + 模拟脚本**下自测，不要用真实项目数据。
- 大改动先开 Issue 讨论；PR 请附验证方式与未验证边界。
- **浏览器操作规则**：开发、测试与模块验收中的浏览器操作，优先使用 opencli（DSH 浏览器代理）执行——站点适配器 `site` → 通用 `opencli_*` → 动手前 `site_knowledge`；细节见 `AGENTS.md`。

## 车辆评估模块（行驶证 / 登记证 / 里程）

工作台「工作 → 车辆评估」页签，把企业给的车辆资料整理成可入底稿的权证档案。

**输入**：项目根目录（含 ```02现场资料/企业提供资料/03资产基础法/<NN公司>/```）。脚本优先只看名字带「车辆 / 行驶证 / 驾驶证 / 登记证 / 权证 / 里程」的目录；一个都没有才回退扫整个公司目录。支持 pdf / doc / docx / jpg / png / xlsx，文件名不规范也能处理（车牌从文件名和正文里分别找，全角字符先做 NFKC 归一）。

**项目根目录可以给哪一级**：给具体项目文件夹（例如 `D:\评估项目\<项目编号> <项目名>`）最直接；也可以给上层的项目集合目录（例如 `D:\评估项目`），这时后端先回项目列表，界面出现「项目」下拉，选完具体项目再读公司。路径里没有 `02现场资料/企业提供资料/03资产基础法` 时，界面会在按钮上方用红字提示，而不是静默无反应。选过的根目录记在浏览器 localStorage（`wb.vehicle.root`），下次打开自动恢复。

**过程**：识别引擎转 markdown（图片和 pdf 带 OCR；docx 先取正文，没有正文就把内嵌图片逐张 OCR；`.doc` 先用 Word COM 转 docx）。引擎默认 `auto`：配了百度智能云 AK/SK 走百度「行驶证识别」（结构化字段，见下节），否则走 `mineru flash-extract`；→ 标签分段 + 形状正则识别字段（号牌号码 / 车辆类型 / 所有人 / 使用性质 / 品牌型号 / 车辆识别代号 / 注册日期 / 发证日期 / 里程）→ 跨记录纠错。

纠错分四层（都可独立重跑，不必重新 OCR）：
1. **车辆类型**：对规范词库做 difflib 就近匹配（ratio ≥ 0.72）。
2. **所有人**：取同公司众数修 OCR 掉字（「OCR识别结果」→「<公司全称>」）。
3. **品牌名**：同批出现 ≥2 次且是某记录品牌后缀的，收敛（「招日产」→「日产」）。
4. **车牌规范化**：以里程表/清单 Excel 与原始文件名里的车牌为准，把 OCR 认错的牌子按 difflib ratio ≥ 0.84 拉回（「浙E68385」→「浙E68305」、「浙E938YL」→「浙E930YL」、「浙EL677」→「浙EL677Q」），同时改索引键与已归档文件名；同一车牌下重复类型会合并。

`使用性质` 专门处理 OCR 掉「非」的情形（正文出现「使用性雕营运」这类形状时判为非营运）。

**输出**：
- `<公司>/固定资产/车辆/<车牌><类型><原扩展名>`，类型 ∈ 车辆行驶证 / 车辆登记证 / 里程；
- 同目录 `_markdown/`（识别文本，可追溯）、`_md_cache/`（图片 OCR 缓存，按 sha1 复用）、`_vehicle_index.json`（索引）；
- `车辆权证信息表.xlsx`：sheet1「车辆权证信息」按车牌聚合 14 列（含**备注**：自动列出缺哪些字段），sheet2「资料明细」逐份资料；两表都冻结首行、自动筛选、横向 fit-to-width 打印版式。

**安全闸**：认不出车牌的、正文没有行驶证/号牌/车辆识别代号特征的（设备交接单、验收单、会议纪要之类）、文件名明显是合同协议的，一律不归档，只在日志里说明。`公里数.xlsx` 这类里程表另走「车牌→公里数」映射并回填到各车记录。

**接口**（宿主侧，改完需重启 DSH）：`/api/workbench/vehicle/{companies,scan,run,progress,index,report}`；命令行可直接跑：

```bash
python vehicle_cert.py companies --root "D:\评估项目\<项目编号> <项目名>"
python vehicle_cert.py scan --root <项目根> --company <公司文件夹名>
python vehicle_cert.py run  --root <项目根> --company <公司文件夹名> [--source <资料子目录>] [--limit N] [--engine auto|baidu|mineru]
python vehicle_cert.py fix    --root <项目根> --company <公司文件夹名>   # 按已存 md 重刷字段 + 车牌规范化 + 合并
python vehicle_cert.py report --root <项目根> --company <公司文件夹名>
python vehicle_cert.py ocr                                       # 看当前引擎与密钥（掩码）
python vehicle_cert.py ocr --engine baidu --ak <AK> --sk <SK>    # 保存密钥
python vehicle_cert.py ocr --check                               # 取一次 access_token 自检
python vehicle_cert.py ocr --test <图片路径 或 b64:<base64后的路径>>  # 单图试识别
```

### 上传权证到天源底稿（权证索引）

把归档好的行驶证 / 登记证按车牌写进天源「资产基础法底稿 → 车辆」的**权证索引**列。天源没有开放上传接口，模块驱动本机 Chrome（`opencli`，session `dsh-vehicle`）真实操作页面：自动导航到该科目页 → 等页面自己拿到编辑锁 → 逐份上传 → 一次性保存。

**准备**：`python vehicle_cert.py stage --root <项目根> --company <公司目录名>` 先把证件整理成待上传副本（统一命名 `<车牌><类型>`，`.doc` 用 Word COM 转 PDF，因为接口只受理 pdf/docx/xlsx/jpg/png），落在 `<公司>/固定资产/车辆/_upload/`（临时目录，可重跑、可删）。

**操作**：「车辆评估」页签 ③ 卡片里填两个 ID（底稿网址 `/ty/operation/<项目ID>/<单位ID>/...` 中的两段数字，填过会记住）→「读取底稿现状」核对每行已挂什么 →「试运行（只比对）」→「上传权证到天源」。默认**跳过已有同分类附件**，勾「覆盖已挂的同名分类」才会替换。

**接口**：`POST /api/workbench/vehicle/upload`（body `{root,company,projectId,companyId,dryRun,overwrite}`，回 `jobId`）、`GET /api/workbench/vehicle/upload/progress?jobId=`、`GET /api/workbench/vehicle/upload/state?projectId=&companyId=`（只读，列每行车牌与已挂附件）。

**链路**（实测）：`POST /ty/api/attach/upload`（multipart 字段名 `file`）→ `POST /ty/api/assignment_draft/cell_file/classify_upload`（`draftFieldCode:'QZSY'`、`draftRowId:<行_id>`、`fileUploadList:[{fileTypeDesc:'车辆行驶证',linkedFlag:0,attachId}]`，已有附件追加时带 `batchId` 与保留条目）→ `POST /ty/api/assignment_draft/save` 回写单元格。

**已知约束**：
- 编辑锁无法用接口直接申请（`edit_lock/acquire/batch` 参数对不上，返回「请求参数有误」），只能让页面停在 `?subjectCode=<车辆科目>` 由前端自己申请；拿不到 `editFlag=1` 就报 `LOCK_TIMEOUT`。
- 车辆科目 code 因项目而异（因项目而异），模块从页面科目树里按名称「车辆」自动解析。
- 页面注入脚本必须用 `TextDecoder` 解 base64，`atob` 直出是 Latin-1，中文车牌会变 mojibake 导致一行都匹配不上。
- `opencli` 必须 `spawn(process.execPath, [entry, 'browser', '--session', ...])`，经 shell 会把 `--session` 吃掉。

### 识别引擎：百度智能云 OCR（可选，比 mineru 准）

百度「行驶证识别」直接给结构化字段（号牌号码 / 车辆类型 / 所有人 / 住址 / 使用性质 / 品牌型号 / 车辆识别代号 / 发动机号码 / 注册日期 / 发证日期 / 发证单位；副页另给核定载人数 / 总质量 / 整备质量 / 外廓尺寸 / 燃油类型 / 证芯编号），认不出的再走「通用文字识别（高精度）」兜底，所以登记证、复印件也能读。文档：<https://cloud.baidu.com/doc/OCR/s/yk3h7y3ks>。

**配置**：「车辆评估」页签 ② 卡片选引擎、填百度 API Key / Secret Key 与 MinerU 精准解析 token，点「保存设置」（想顺带验证就点「测试密钥」）。都存本机 `~/.dsh/workbench-vehicle-ocr.json`（Windows：`C:\Users\<你>\.dsh\workbench-vehicle-ocr.json`，结构 `{engine, baidu:{ak,sk}, mineru:{token,model}, limits:{}}`），页面只显示掩码；也可用环境变量 `DSH_BAIDU_OCR_AK` / `DSH_BAIDU_OCR_SK` / `DSH_MINERU_TOKEN` / `DSH_MINERU_MODEL` / `DSH_VEHICLE_OCR_ENGINE` 覆盖。

**引擎优先级**：`auto` = 有百度 AK+SK 用 `baidu`；没有百度但有 MinerU token 用 `mineru-pro`；都没有用 `mineru`（轻量）。显式指定 `baidu` / `mineru-pro` 时失败直接报错不回退（避免静默降级），`auto` 下才回退。access_token 缓存在 `~/.dsh/baidu-ocr-token.json`（30 天，遇 110/111 自动刷新）。

**接口**：`GET /api/workbench/vehicle/ocr`（读配置+用量，回 `{engine,resolved,akMasked,hasKey,mineruTokenMasked,hasMineruToken,mineruModel,usage,usageLine}`）、`POST /api/workbench/vehicle/ocr`（body `{engine,ak,sk,mineruToken,mineruModel,baiduLimit,mineruLimit,resetUsage,check,test,testEngine}`，保存并可选自检/试识别）、`GET|POST /api/workbench/vehicle/usage`（读用量 / `{reset:true}` 清零）。`POST /api/workbench/vehicle/run` 接受 `engine`（`auto|baidu|mineru|mineru-pro`）。

**已踩的坑**：
- 行驶证正页当副页传、或根本不是行驶证 → 百度回 `{"error_code":282103,"error_msg":"recognize error, failed to match the template"}`，模块据此转通用高精度 OCR，不当失败。
- 百度返回的日期是 `20221117` 紧凑格式，写 md 前统一归一成 `2022-11-17`（否则报表里两种格式混排）。
- 走百度引擎时**结构化字段优先于正则解析**：每条资料建 `direct`，识别完 `fields.update(direct)`，OCR 掉字也压不歪字段。
- `run` 对同 `车牌|类型` 已存在且旧 md 更长的直接判 `dup`，所以换引擎只影响**新资料**；要重刷已有记录用 `fix`（按已存 md 重解析，不重新调接口）。

### MinerU 两种模式：轻量（flash）与精准解析（extract）

官方文档 <https://mineru.net/apiManage/docs>。两条路子都在本模块里可选：

| | MinerU 轻量（Agent 轻量解析） | MinerU 精准解析 |
|---|---|---|
| 命令 | `mineru flash-extract <file> --ocr --language ch` | `mineru --token <T> extract <file> --model vlm --language ch --ocr -o <dir>` |
| 鉴权 | 免 token（IP 限频） | 需 API 管理页创建的 token（`sk-…`） |
| 限制 | ≤10MB、≤20 页 | ≤200MB、≤200 页（本机 CLI 帮助写 600 页） |
| 输出 | 仅 markdown | Zip/目录：markdown + images，可导 docx/html/latex |
| 额度 | 按份（本模块按 5000 份/天记） | 每天 1000 页最高优先级，超出降优先级 |
| 适用 | 普通行驶证、正文可直接抽字段的文件 | 登记证书、表格/公式复杂、扫描质量差的版面 |

实测：同一张行驶证，精准解析仍会掉字（`号牌号E60153` 丢「浙」、`使用性Use Character` 丢「质」、`022-11-17` 丢年份），**行驶证仍应优先百度结构化识别**；精准解析的价值在登记证这类整页表格版面。

### 用量与额度（本机记账）

每次真正调用识别接口都会记账，存在 `~/.dsh/workbench-vehicle-usage.json`：

- **百度**：按自然月累计（`baidu_month`，默认 1000 次/月免费额度）；行驶证识别与通用高精度 OCR 都算 1 次；token 失效（110/111）不计。
- **MinerU 轻量**：按自然日累计份数（`mineru_day`，默认 5000 份/天）。
- **MinerU 精准**：按自然日累计份数与页数（同一份 PDF 多页按页折算，便于对照每日页额度）。

跨月/跨日自动归零，`total` 字段保留历史累计。额度可在配置文件的 `limits` 里改（`{"baidu_month":1000,"mineru_day":5000}`），命令行走 `ocr --baidu-limit` / `ocr --mineru-limit`。

**看用量**：「车辆评估」② 卡片底部直接显示「百度 x/1000 次 · 本月 ｜ MinerU 轻量 x/5000 份 · 今日 ｜ MinerU 精准 x 份 / x 页」，也有「刷新用量」「清零用量」两个按钮；命令行 `python vehicle_cert.py usage`，清零 `usage --reset`。

注意：只统计**本机**调用，网页版或别的机器用掉的不在账内；这里显示的是本地估算，真正的配额以百度/MinerU 控制台为准。

命令补充：`ocr --test <图片或 b64:路径> --test-engine mineru-pro` 可以单张试精准解析；`ocr --mineru-token sk-…` 保存 token，`--mineru-model vlm|pipeline` 选模型。

依赖：`mineru-open-api`（`npm i -g mineru-open-api`）、`python-docx`、`openpyxl`、`pywin32`（只有 `.doc` 转换需要）；上传另需 `@jackwener/opencli` 与本机已登录天源的 Chrome。

## 天源系统真实对接（本轮新增）

天源 CLI（`tycpv`，安装见下文「环境要求」），MCP 端点 `https://mcp.zhrdc.net/valuation-mcp`。插件实现与 `tycpv login` 同构的 **PKCE OAuth**：

1. 「工作 → 天源对接」点「连接天源」→ 宿主向 `/api/mcp/sources/valuation/cli/authorization-requests` 预登记（已实测返回 201 + 授权 URL）。
2. 自动打开 `mcp.zhrdc.net/connect?...` 登录页，**由您本人输入账号密码并完成滑块拼图验证**（滑块无法也不应被程序绕过）。
3. 授权回调 `http://127.0.0.1:2424/callback`（宿主临时监听）→ 用 code + code_verifier 向 `/cli/token` 换取 `zhmcp_*` token，存到 `~/.dsh/workbench-tianyuan.json`（仅本机）。
4. 之后插件通过标准 MCP JSON-RPC（`initialize` / `tools/list` / `tools/call`）调用天源工具：可查看全部 MCP 工具、按项目 ID 调用 `get_project_companies` 同步公司/项目，或调用任意工具并查看原始结果。

也支持手动粘贴 `zhmcp_` token（例如从 `tycpv login` 获取）。凭据只存本机，不写入插件文件、不进对话、不上传。

宿主新增同源路由（浏览器只走同源，避开 CORS）：

| 路由 | 作用 |
|---|---|
| GET /api/workbench/ty/status | 连接状态（账号、有效期、token 前缀） |
| POST /api/workbench/ty/login | 发起 PKCE 授权，返回授权 URL |
| POST /api/workbench/ty/logout | 断开并远端撤销 |
| POST /api/workbench/ty/token | 手动设置 token |
| GET /api/workbench/ty/tools | 列出 MCP 工具 |
| POST /api/workbench/ty/call | 调用任意 MCP 工具 |
| GET/POST /api/workbench/ty/projects | 按工具名+参数调用（默认 get_project_companies） |
| GET /api/workbench/quotes · /search · /proxy · /ping | 腾讯行情/搜索/通用转发/健康检查 |
| `/api/workbench/stock/*`（独立 bundle） | 自选股库、多源日线下载、指标分析、完整行情（见下节与 `plugins/dsh-workbench-stock/README.md`） |

## 能力清单一节（「连接设置」页下半部分）

「工作 → 连接设置」原来只有授权/连接状态，看不出这个对接到底能提供什么。现在页面标题为 `天源系统对接 · CLI / MCP`，下面接一节 **`能力清单 · 这个对接能做什么`**，把两条通道的能力一次列全：

| 内容 | 数据来源 | 说明 |
|---|---|---|
| MCP 工具 35 个 | 连上后实时 `tools/list`（`/api/workbench/ty/tools`），失败回退 `client.js` 里内嵌的快照（由 `data/ty-tools.json` 生成） | 每行：工具名、类型、必填参数、说明；按 9 个业务分组固定排序（项目与人员、被评估公司与负责人、资产基础法底稿、财务报表、汇总表、报告配置与导出、二级文件、项目文件与明细表、底稿编辑锁） |
| 类型标签 | 工具名前缀判定 | `get_*` / `export_*` / `download_*` / `request_*` = **只读**（22 个）；`prepare_*` = **预检**（5 个，只读但会发一次性 confirmationToken）；`execute_*` / `save_*` / `release_*` / `force_release_*` = **写入**（8 个，会改天源数据） |
| CLI 命令 11 条 | `tycpv --help`（本机 `D:\tycpv\tycpv.cmd`），存 `data/ty-cli.json` | 登录/登出 + 9 条导入导出命令，每条可加 `--help` 看参数 |
| 工作台已接入标记 | `data/ty-tools.json` 的 `usedBy` | 目前 4 个：`get_my_projects`、`get_project_context`、`get_project_companies`、`get_project_file_list` |

交互：KPI 卡（工具总数 / 只读 / 预检 / 写入 / CLI 命令数）→ 搜索框（按工具名或说明过滤）→ 分组筛选按钮（带各自数量，再点一次取消）→ 分组明细表；右上角显示「实时 tools/list」或「内置快照」，未连接时「刷新清单」置灰。

**为什么把 35 个工具的快照内嵌在 `client.js`**：宿主半侧改 `index.js` 要递增 `?rev=` 并重启 DSH，而浏览器半侧走 HMR 刷新即生效。把目录快照放进前端，离线/未连接时也能看到全表，且这次改动不需要重启应用。快照由 `tools/gen_ty_catalog.mjs` 从真实 `tools/list` 生成（补分组、类型、`usedBy`），天源加工具后重跑该脚本再把生成物粘回 `client.js` 即可。

安全边界：这一节**只列能力、不代执行**（避免在工作台上误触发 `execute_*` 写操作）；页面上写明「写入类工具一律 prepare 预检 → 用户确认 → execute 执行」。

验证（headless harness，`tools/uiharness/run-ty-catalog.mjs` + `run-ty-theme.mjs`）：实时拉到 35 个工具、KPI 显示 35/22/5/8/11、分组筛选到「资产基础法底稿」得 4 个、搜「报告」得 6 个且含 `export_report_full_json`、CLI 表 11 行；暗色与 760px 窄屏均无横向溢出、无 console/pageerror。截图：`C1`–`C6`。

## 安装与生效

- 插件目录 `plugins/dsh-workbench/` 已通过目录联结挂到 `~/.dsh/profiles/desktop/node_modules/@local/dsh-workbench`，并登记进 profile 的 `package.json` bundles 与 `cordis.patch.yml`。
- 原始清单备份：工作区根目录 `_backup_profile_package.json`、`_backup_cordis_patch.yml`。
- 浏览器半侧改动经 HMR 推送（`/plugins/events` graph 中 `@local/dsh-workbench` 的 rev 会变，`client.js` 返回 200），改完即生效、无需重启。
- **宿主半侧热更新**：Cordis 对已 import 过的 ESM 模块不会重新求值，所以直接改 `index.js` 不会热生效。为此另建包装包 `plugins/dsh-workbench-host/`（`@local/dsh-workbench-host`），它只做 `await import(new URL('../dsh-workbench/index.js?rev=N', import.meta.url).href)` 再透传 name/inject/apply；改 `index.js` 后把 rev 递增即可让宿主重新载入。两个 entry 都会 apply，`index.js` 的 `apply` 开头有 `globalThis.__dshWorkbenchHostApplied` 幂等守卫（精确路径重复注册会抛错）。
- 若宿主仍加载不到（浏览器侧报 `HTTP 404`、`/api/workbench/ping` 404），检查 `%APPDATA%/@deepseek-ai/dsh-desktop/logs/crash-*-host.log` 里 `workbench (@local/dsh-workbench): pending (waiting for service: ...)` 一行 —— 说明 `apply()` 未执行，通常是 `inject` 声明了本版本不存在的服务名（本插件只需 `connection`）。

## 天源项目「同步后保存到本地」（本轮变更）

「工作 → 天源项目」不再自动联网拉取。原来的 `天源项目 · 实时同步` 会在每次进入/挂载时请求 `/ty/status` 与 `get_my_projects`，结果只留在内存里，关掉页面就没了；现改为：

- 打开页面**只读本地缓存**，显示上次保存的项目副本，不发起任何天源网络请求。
- 点右上角「**刷新同步**」才联网：读取 `/ty/status` → 调用 `get_my_projects` → **把结果写入 `localStorage`（键 `dsh-workbench:v1` 的 `work.ty.cachedProjects` / `cachedAt` / `cachedUser` / `lastSync`）** → 再刷新界面。toast「同步完成，已保存到本地：共 N 个项目」。
- 同步失败时本地已保存的数据**不被覆盖**，页面显示失败告警，toast 明确「本地数据未改动」。
- 未连接 / 授权过期时点同步会提示先去「连接设置」完成授权，不改动缓存。
- 缓存随工作台数据一起走设置页的「导出/导入备份」；`cachedAt` 在页面顶部提示「上次同步 …（账号）」。

## 天源 ⇄ 本地：导入（建文件夹 + 四组信息）与反向填单

### 一、天源项目 → 本地项目（点「导入」）

原来「导入」只塞 6 个字段进本地列表（名称/编号/部门/阶段/基准日/风险），既没建文件夹、四组信息也全是空的。现在一次点完：

1. 并发拉 `get_project_context`（项目上下文，namedKey/value 列表）与 `get_project_companies`（被评估公司）；
2. 按 `<数据目录>\<年份> <项目名>` 建文件夹（`POST /api/workbench/project/folder`，`open:false`，只建不弹窗，路径回报在 toast 里）；
3. 把四组信息写进本地项目：**基本信息 + 成员信息 / 客户信息 / 被评估单位信息 / 合同信息**；
4. 已导入过的再点就是「**更新**」：天源字段覆盖过来，本地 `id`、工时记录、`deadline`、`budgetHours` 原样保留（工时不脱钩）。

字段映射（`tyToLocalProject()`，`client.js`）：

| 本地 | 天源来源 |
|---|---|
| 项目名称 / 项目编号 / 项目受理号 / 项目简称 / EBS项目 / 风险等级 / 基准日 / 业务类型 / 项目阶段 | `get_my_projects` 的 `projectName` `projectCode` `projectAcceptanceNo` `projectBrief` `ebsProject` `riskLevelName` `evaluationBaseDate` `businessType` `projectStatus`(1 现场调查 / 2 内部审核 / 3 归档收款) |
| 执行部门 / 项目合伙人 / 项目经理 / 参与人员 / 签字评估师 | `executionDepartment`、`projectPartnerList`、`projectManagerList`、`participantList`、`signatureAssessorList`（都取 `fullName`；单项字段 `projectPartner`/`projectManager` 是工号，只当兜底） |
| 经济行为 / 评估对象-报告 / 评估范围-报告 / 价值类型 / 评估目的-报备 / 评估目的 / 业务性质 / 重大重组 / 评估对象-报备 / 置入置出 / 股权比例 / 报告日 / 报告文号 | `economicBehavior` `assessmentObjectReport` `assessmentRangeReport` `valueType` `evaluationPurposeReport` `evaluationPurpose` `evaluationBusinessNature` `isMajorAssetReorganization` `assessmentObjectRemark` `assetPutOrTake` `assessmentObjectShare` `evaluationReportDate` `reportDocumentNo` |
| 委托人（类型/名称/简称/是否与被评估单位一致/信用代码/企业类型/住所/注册资本/法定代表人/经营范围/与被评估单位关系） | `customersInfo[0]` 的 `clientType` `clientName` `clientShortName` `isSameWithAssessment` `clientCreditCode` `clientUnitType` `clientUnitAddress` `clientRegisteredCapital` `clientLegalPerson` `clientBusinessScope` `clientWithUnitRelationship` |
| 被评估单位（名称/简称/法定代表人/信用代码/企业类型/注册资本/住所/经营范围/经营情况简介） | `get_project_companies[0]` 的 `name` `shortName` + `legalRepresentative` `socialCreditCode` `enterpriseType` `registeredCapital` `companyAddress` `businessScope` `businessInfo` |
| 合同（类型/签订日期/服务期间/币种/原币金额/合同金额/支付方式/报告提交时间与方式/外送份数/其他使用人/具体评估目的/扫描件/是否涉密） | `contractType` `contractSigningDate` `servicePeriodDate`（区间数组）`contractCurrency` `contractOriginalAmount` `contractAmount` `evaluationFeePaymentMethod` `reportSubmitTime` `reportSubmitMethod` `reportNumber` `evaluationExplanationNumber` `otherReportUser` `contractEvaluationPurpose` `contractAttachment` `isSecret` |

取值规则（都是实测出来的坑）：

- `type` 字段不可靠（同一个 key 在不同项目里类型会变），所以一律「先试 JSON 解析，失败当纯文本」；多选值形如 `["QYJZ","股东全部权益价值"]`（代码 + 中文名成对），取中文名。
- 天源有的下拉值是全角括号（`现金购买资产（含股权）`），本地选项表是半角，比对前统一括号；仍对不上就保留原文。
- `evaluationPurpose` 有时存的是代码（`PGMDQT`），这种不塞进「评估目的」下拉，只留「评估目的-报备」。
- 计数类（`reportNumber` / `evaluationExplanationNumber` / `assessmentObjectShare`）没填时天源给 `0`，搬过来表单会显示「0 份 / 0%」，按空处理。
- 表单下拉遇到「不在选项表里的值」时补一项显示原文（`sel()`），否则天源同步来的企业类型「有限责任公司(非自然人投资或控股的法人独资)」会显示成「请选择」，看着像丢数据。
- 天源合同区本来就大量为空（实测 24 个项目里合同类型/金额/日期基本都是空），所以合同页签同步后仍可能大半是空的 —— 这是源数据空，不是没同步。

### 客户信息 / 委托人导入为空（2026-11-15 已修复）

**现象**：天源项目点「导入」（或「更新」）后本地项目建出来了，但打开项目 →**客户信息**页签全空：委托人名称、简称、社会信用代码、企业类型、住所、注册资本、法定代表人、经营范围一个都没有；toast 还会带一句「天源这几项为空：委托人名称」。

**根因**：本地项目里委托人有两个字段——`customers`（数组，多委托人的数据本体）与 `customer`（第一个的别名）。`tyToLocalProject()` 当时只写了 `customer`，`customers` 还是 `newProject()` 里那个 `emptyCustomer()` 空壳；而 `normalizeProject()`、表单和保存一律以 `customers` 为准（数组里有值就优先），空壳把真数据顶掉了。天源那边的 `customersInfo` 其实是有值的。

**修复**（都在 `client.js`）：

1. `tyToLocalProject()` 把 `customersInfo` 整个数组映射成 `customers`（不再只取 `[0]`），`customer` 取第一个作别名，`client` 取第一个的名字；没有名字/简称/信用代码的空行不占位；没有委托人时留一个空壳，不拿「评估对象」冒充。
2. 新增 `projectCustomers()` 兜底：`customers` 里没有任何有效委托人、而 `customer` 有内容时，用 `customer` 补回去；`normalizeProject()` 改用它——这样**旧版导入过的存量项目不用重新导入**，打开就正常。
3. `normalizeState()` 载入数据时对每个项目跑一次 `repairCustomers()`：把「`customers` 空壳 + `customer` 有值」就地改成 `customers: [customer]`，随下一次保存落盘。

**验证**（`tools/uiharness/verify-ty-import.mjs`、`verify-ty-import2.mjs`、`verify-ty-save.mjs`，走真实 MCP）：

- 导入「示例子公司股权转让-子公司A」后，`customers[0]` 11 个字段全有值（信用代码 `91XXXXXXXXXXXXXXXX`、注册资本 55,000万元、经营范围等），客户信息页签逐项显示；
- 模拟存量坏数据（`customers` 置回空壳、`customer` 保留）刷新页面，客户信息页签仍能显示；
- 在表单里点「保存」后，`localStorage` 里 `customers` 仍是天源的委托人（没被空壳覆盖），被评估单位信息不受影响；
- 合同页签仍可能空——天源该项目合同字段本来就是空串（实测 `contractAmount` 等均为 `""`）。


### 二、本地项目 → 线上（表单页右上「同步到线上」）

**先说清边界**：天源 OpenAPI（本机接的 35 个 MCP 工具）只开放「读项目 + 写参与人员 / 写公司负责人」，**没有**新建项目、也没有改基本信息/客户/被评估单位/合同的接口；`tycpv` CLI 也只有登录登出 + 9 条导入导出。所以这三类写入只能在网页表单里做：`https://ty.zhrdc.net/project/my`。

因此「同步到线上」做成「把本地这一份整理成网页表单可以直接粘的清单」：

- 弹窗按网页四个页签分组，逐行「字段：值」，空值不列，一键「复制全部」（`navigator.clipboard`，被拦就退回 `execCommand('copy')`）；
- 「打开线上新建项目」→ `https://ty.zhrdc.net/project/my`；已关联天源的还有「打开该项目」（`excel.zhrdc.net/ty/operation/<id>/equity/list`）；
- 打开通道沿用 `openInApp()`：宿主 `POST /ty/open` 交系统浏览器（唯一不受 Electron 弹窗策略影响的通道），失败再退右侧栏、最后提示复制链接。

想做到「一键真上传」只有两条前提之一：天源开放项目写入类工具，或允许在插件里驱动天源网页（当前 DSH 的 `sidebarRight` 只提供 `openTab`，没有脚本注入能力）。两条都不具备，所以这里不做假同步。

### 验证

`tools/uiharness/run-ty-import.mjs`（先起 `tools/uiharness/server.mjs`，走真实 MCP + 临时数据目录 `tmp-store`）：

- 刷新同步拿到 24 个天源项目 → 对「示例子公司股权转让-示例大酒店A」点导入；
- 断言：本地记录 22 个基本信息字段、`team`、`customers[0]`（含信用代码/注册资本/经营范围，`customer` 为同一对象）、`entity`（含信用代码/企业类型/经营范围）、`contract`（`reportSubmitWay`/`otherUsers` 等）都有值；
- 断言：`tmp-store/2026 示例子公司股权转让-示例大酒店A` 文件夹真的建出来；
- 断言：再点「更新」不产生第二条记录、`id` 不变；
- 断言：「同步到线上」清单 55 行、按四组分组（截图 `TY1`–`TY5`）。

## 数据来源与边界

| 来源 | 方式 | 说明 |
|---|---|---|
| 腾讯行情/搜索 | 宿主同源代理，失败回退 JSONP | 无需 API Key |
| 天源 MCP | PKCE OAuth + Bearer token | 35 个工具；`get_my_projects` 直接返回「我的项目」（实测 24 个），`get_project_context` / `get_project_companies` / `get_project_file_list` 取项目上下下文、被评估公司与底稿文件。注意 `projectId` 必须传 number。浏览器不能直连 MCP（无 CORS 头），一律走宿主代理 |
| 考试日历 | 内置 `data/exam-calendar.json`（7 项，按历年规则推算） | 2027 年度人社部考试计划尚未发布时全部标记 `estimated`（按历年推算），行内显示来源标签与官网链接；用户在表格里改日期会写 `userEdited` 且不再被内置数据覆盖 |

## 提醒与数据

提醒中心 + 未读角标 + 浏览器 Notification；股票按 30/60/120/300 秒轮询，报名/考试提醒每天首次打开检查一次。数据默认写在用户文档目录的 `天源评估/个人工作台/工作台数据.json`（Windows 默认 `D:\天源评估\个人工作台`）（设置里可改目录），`localStorage`（键 `dsh-workbench:v1`）只当缓存；天源 token 单独存 `~/.dsh/workbench-tianyuan.json`。设置页可导出/导入 JSON 备份。

股票买卖点采用 **latch（门闩）** 语义：每个 `股票 id + 条件类型` 只在「由假变真」的那一刻提醒一次并记时间戳，条件转假时清掉记录重新武装 —— 否则价格每轮抖动会让同一条提醒每 60 秒重复一次。

「生成排课」由 `buildSchedule()` 完成（纯函数，可单独测试）：先按各考试每周目标学时算出每日预算（`周学时×60/7`，夹在 30–240 分钟、按 15 分钟取整），再按**考试紧迫度加权**分配——权重 `1/(距考试天数/30+1)`，用累计配额挑出当天主科目，越接近考期的考试分到越多天数，不再按天轮流切换考试；科目按该考试已排次数轮转，保证每科都被覆盖。阶段随剩余天数推进：>120 天基础章节、60–120 天强化刷题、20–60 天真题模考、<20 天冲刺复盘，同阶段内约每 3 天混排一次配套任务（如「错题复盘」），避免整月只有一种类型。考试当天及之后不再排该考试。自动任务带 `auto:true`，重新生成时整体重建；手动任务永远保留，冲突（同日同考试）的自动条目会被跳过并提示。面板支持生成周数（1–12）、清除自动任务、清除已完成、今日全部完成，并按日期分组展示，今天与逾期置顶。

## 目录结构

| 文件 | 作用 |
|---|---|
| package.json | bundle 清单（dsh.bundle.patch / dsh.client / exports / locales / icon） |
| cordis.patch.yml | 插入 workbench loader 行 |
| index.js | 宿主半侧：腾讯行情代理 + 天源路由 |
| tianyuan.js | PKCE OAuth、2424 回调、token 存储、MCP JSON-RPC 客户端 |
| client.js | 浏览器半侧：侧边栏入口 + 三大模块 UI；内含「能力清单」的 MCP 工具快照与 CLI 命令表 |
| data/ty-tools.json · data/ty-cli.json | 能力清单数据：35 个 MCP 工具（分组/类型/参数/是否已接入）与 11 条 tycpv 命令 |
| locale/*.json · icon.svg | 中英文元数据与图标 |
## 网页标签页 · 与对话并排（本轮新增）

「网页」标签页调用宿主原生 `ctx.sidebarRight.openTab('browser', { params: { url } })`，在**右侧栏**打开独立浏览器标签页（Web 用 iframe、桌面版用 Electron webview）。界面是三栏布局：左侧导航、中间对话（至少保留 400px）、右侧网页（默认约 45%，可拖到 70%）。**打开网页后对话仍可持续提问、看回复**，两者互不遮挡。

- 预置了天源项目系统、天源 MCP、腾讯自选股、中评协、中注协等快捷网址，也可输入任意 http/https 地址。
- 每次点「在右侧打开」会新建一个浏览器标签页。
- **嵌入限制**：天源 MCP 连接页返回 `X-Frame-Options: DENY`，`ty.zhrdc.net/project/my` 会跳到统一认证登录页（需扫码/滑块）。这类站点在 iframe 里可能白屏或反复跳登录，宿主文档明确建议此时用「系统浏览器打开」。这类页面登录完成后，回到工作台用 MCP 同步数据即可。
- 依赖宿主内置插件 `@deepseek-ai/dsh-client-ui-sidebar-right` 与 `dsh-client-ui-sidebar-browser`（HMR 图中均已启用）；新增的 inject 声明在**重启 DSH 后**才完全生效，运行时若 `sidebarRight` 不可用会给出明确提示。

## 验证记录（2026-11-13）

应用内与 headless 双轨验证均已通过。headless harness 在 `E:/Deepseek Harness/tools/uiharness/`（`server.mjs` 起 8799、`run*.mjs` 是 Playwright 脚本），它把 `client.js` 用桩 `__ModuleLoader__` + 桩 ctx 真实渲染进无头 Chromium，并把 `/api/workbench/*` 用 mock 接到真实 `tianyuan.js` 与 `qt.gtimg.cn`，因此能脱离桌面窗口复核 UI。

| 链路 | 结果 |
| --- | --- |
| 侧边栏入口 → 面板 | 7 个一级 tab 正常渲染，标题带当天日期 |
| 天源项目列表 | 打开页面只读本地缓存、零网络请求；点「刷新同步」拉取并保存，toast「同步完成，已保存到本地：共 24 个项目」，24 行真实项目（编号/名称/部门/状态/风险/基准日/人员）；刷新后缓存仍在、不重新联网 |
| 天源项目详情 | 弹窗含 项目编号 20261110001、执行部门 三部、评估基准日 2026-11-30、评估对象 股东全部权益价值、价值类型 市场价值、业务性质 国有资产评估业务、被评估公司（2）含 100% 股权比例与负责人 |
| 导入 → 本地项目 | toast「已导入」，本地项目表出现该天源项目（阶段映射为「现场调查」）；客户信息页签的委托人（名称/简称/信用代码/企业类型/住所/注册资本/法定代表人/经营范围/关系）随导入填好 |
| 工时管理 | KPI 合计工时/本月记录条数/计费工时 + 明细 + 按项目汇总 |
| 连接设置 | 显示账号、凭据有效期、token 前缀、MCP 端点；含重新连接/检查/打开天源/断开/手动 token；下方「能力清单」列出 35 个 MCP 工具（分组/类型/必填参数/说明）与 11 条 tycpv CLI 命令，支持搜索与分组筛选 |
| 考试日历 | 7 项全部填入报名与考试日期并计算倒计时，带「按历年推算」来源标签与官网链接 |
| 学习规划生成 | 点「生成排课」→ toast「已生成 N 条 · 每天约 X 分钟 · 4 周」；面板按日期分组，逾期标红置顶、今天单独标记，KPI 显示完成率/逾期数/今日待办/已投入学时；手动任务点「生成排课」后仍在 |
| 股票行情 | 走宿主 `/quotes` 代理 qt.gtimg.cn，自选股显示现价与涨跌幅，按轮询间隔刷新 |
| 买卖点提醒 | 设「买入点 9999」→ 状态列变红「≤ 买入 9999」、一级 tab 变「提醒 (1)」、提醒中心出现记录、总览 KPI 与「最近提醒」同步；latch 生效后不重复告警 |
| 设置页 | 重新导入内置考试日历回报「考试日历 7 项（已填入 7 项）」 |

本轮「同步后保存到本地」另用 `tools/uiharness/verify-sync.mjs`（配 `index-sync.html`，用 sessionStorage 支撑跨刷新持久化）做了无头回归：进入页面 0 次网络请求、点「刷新同步」后 1 次 `/ty/status` + 1 次 `get_my_projects` 且 `work.ty.cachedProjects` 落盘、刷新后缓存行仍在且仍 0 次网络请求、顶部显示「上次同步 …（账号）」、无 console/pageerror。

已知限制：提醒仅在插件页面打开期间按轮询间隔检查，关掉页面不会后台推送；天源授权有效期 7 天，到期需重新授权。


## 评估文件库（本轮新增）

侧边栏「个人工作台 → 文件库」四个子页：**问答 / 浏览 / 扫描 / 概览**。全文检索已并入「浏览」，不再单独占一个页签。

### 数据来源

| 层 | 位置 | 说明 |
|---|---|---|
| 归档库 | `D:\天源评估\已归档\{2024年\|2025年\|2026年}\{受理号} {项目名称}\{四类目录}` | 真实文件，从旧系统下载并按四类落位 |
| 索引 | `_索引库\projects_index.json` + `评估文件库索引.xlsx` | 50 个项目 / 368 个源端挂档，含本地文件数与体积 |
| 知识库 | `_知识库\kb_index.jsonl` + `texts\*.txt` + `mineru\*.md` | 全文文本，供检索 |

四类目录与天源系统「项目文件信息」一一对应：`01 取数表`、`02 电子底稿`、`03 纸质报告、合同扫描`、`04 装订版报告`。

### 宿主路由

| 路由 | 作用 |
|---|---|
| GET /api/workbench/lib/overview | 库概览（项目数、文件数、体积、按年份汇总） |
| GET /api/workbench/lib/projects?q= | 项目列表，按名称/受理号/委托方/报告号模糊过滤 |
| GET /api/workbench/lib/files?path=&depth= | 项目下文件树；`depth` 省略/0 = 展开到末级（上限 20000 项），正数 = 只展开到该层 |
| GET /api/workbench/lib/dir?path= | 任意库内目录列表 |
| GET /api/workbench/lib/search?q=&limit= | 知识库检索：文件名 + 正文，返回命中片段 |
| GET /api/workbench/lib/text?rel=&max= | 取某文件正文（预览用） |
| POST /api/workbench/lib/open | 用系统默认程序打开文件/文件夹（`reveal:true` 为资源管理器定位） |
| GET /api/workbench/store | 数据落盘目录信息（当前目录、来源、文件路径、是否存在、最近写入） |
| POST /api/workbench/store `{dir}` | 切换数据目录（建目录；旧目录有数据而新目录为空时自动复制一份过去） |
| GET /api/workbench/store/state | 读磁盘上的工作台数据（`{data, savedAt, dir, file}`） |
| POST /api/workbench/store/state `{data}` | 写工作台数据（原子替换，覆盖前留 `.bak`） |
| POST /api/workbench/store/open | 用资源管理器打开当前数据目录 |

实现集中在 `library.js`（不依赖 MCP，直接读本地归档），`index.js` 只做路由注册。所有路径都限制在库根目录内（`resolveLibPath()` 守卫），越界直接拒绝。

`resolveLibPath()` 同时接受**相对库根**和**绝对路径**两种写法：项目列表 `projects()` 返回的 `dir` 是绝对路径，而树节点 `path`、检索结果的 `rel` 是相对路径。早先 `openPath()` 直接 `join(ROOT, rel)`，前端把绝对 `dir` 传进来就拼成
`D:\天源评估\已归档\D:\天源评估\已归档\2025年\...`，`existsSync` 必然失败 → 界面弹「打开失败：文件不存在」。
现在统一走 `resolveLibPath()`：绝对路径原样用、相对路径拼库根、`..` 越界返回 null。

文件树默认**展开到末级**。归档目录实际深度在 6～7 层（`项目\02 电子底稿\2-底稿\1-股权评估底稿\2-实物资产\设备询价\1.png`），
早先前端写死 `&depth=4`、后端又在 `Math.min(6, depth)` 封顶，末级文件全被截掉，界面上只看得到中间几层文件夹。
现在前端传 `depth=64`（新旧宿主都取各自上限，避免「只刷新页面、宿主还是旧代码」时反而变浅），
后端 `depth` 省略/0 表示不限层数，并用 20000 项上限兜底 + `truncated` 标记；同层按「文件夹在前、文件在后 + 中文数字序」排序，子目录紧跟父目录。

### 数据保存位置（默认 `D:\天源评估\个人工作台`）

工作台数据不再只活在浏览器里：

- 正式数据：`<数据目录>\工作台数据.json`，结构 `{ app:"dsh-workbench", version:1, savedAt, data }`；默认目录 `D:\天源评估\个人工作台`，在「设置 → 数据保存位置」可以改，旁边有「打开文件夹 / 立即写盘 / 恢复默认」。
- 目录配置：`~/.dsh/workbench-store.json`（`{dir}`）。优先级：配置文件 > `DSH_WORKBENCH_DATA_DIR`（只当默认值，测试用）> 内置默认 `D:\天源评估\个人工作台`；`DSH_WORKBENCH_CONFIG` 可改配置文件路径。
- localStorage（`dsh-workbench:v1`）只当快路径缓存：首屏同步读、离线可用；写盘由 `client.js` 每次改动后 800ms 防抖推送 `POST /store/state`。
- **数据变动即自动保存**：勾选框、改目录、排课、记账…任何 `store.set` 都会触发；关页面/切后台时用 `pagehide` + `visibilitychange` 把还压在防抖里的最后一份改动补写出去（`sendBeacon`，退回 `fetch keepalive`），「改完立刻关窗口」不丢最后一次修改。设置页保留「立即写盘」只是给怀疑没存上时手动兜底。
- 设置页只有一个「设置与数据」区块，内部用分隔线分四段：数据保存位置 / 通知 / 内置数据 / 备份与重置；顶部一行常驻显示最近写入时间与状态。
- 写盘用「临时文件 → rename」原子替换，覆盖前把上一版留成 `工作台数据.json.bak`；改目录时若新目录还没有数据文件，会把旧目录那份复制过去。

启动顺序里有两个坑（都踩过）：

1. **读盘回来之前不许写盘**。页面挂载时的排课/提醒 effect 会立刻 `store.set` 一次，若此时就把「默认值」推给磁盘，会盖掉真实数据（清过浏览器缓存就中招）。所以 `saveState` 里有 `if (hydrated)` 闸门，`hydrateFromHost()` 完成后才放开，并在收尾时补推一次让两边收敛。
2. **`savedAt` 比较要用「挂载前」的快照**。挂载时的自动写会刷新 `dsh-workbench:v1:savedAt`，等 fetch 回来再读，本地时间永远是「刚刚」，磁盘数据永远被判成旧的、永远不被采纳。`hydrateFromHost()` 一开始就同步取一次 `localAt` 再发请求。
3. 写盘串行化：两次改动挨得近时 HTTP 完成顺序不保证，旧快照可能后到；`pushState` 走一条 promise 队列，按调用顺序落地。

「网页」页签已删除（连带 `WebPanel` 组件与注释）：右侧栏浏览器的能力仍在，工作台不再单独提供一个开网页的入口。



### 检索能力边界

- **可全文检索**：Word（docx/docm）、Excel（xlsx/xlsm/xls）、PDF 文字层、md/txt/csv。
- **扫描版 PDF**：用 MinerU（标准 API）OCR 成 Markdown 后并入知识库；`_知识库/mineru_index.jsonl` 记录每篇的解析结果，可断点续跑。
- **>200MB 的 PDF**：MinerU 标准 API 上限，解析前需先拆分（脚本已内置 `--split`）。
- 图片（png/jpg）不抽文本，只能按文件名检索。

### 已知限制

- 宿主半侧改了 `index.js`/`library.js`/`scanner.js` 后必须**重启 DSH** 才生效。实测（`~/.dsh/workbench-host-applied.json` 的 `at`/`rev` 不随文件改动变化）：打包版里宿主插件文件不被 watch，递增 `?rev=` 也不会触发热更；即便触发，主 entry（`index.js` 无查询串）已被 Cordis 缓存，只有 `?rev=` 换 URL 的包装 entry 会重新求值，而路由实际由先注册的主 entry 持有（标记文件里 `registered: []`、`serving: other-entry` 就是这个状态）。
- 不要靠给 `./library.js` 加 `?v=` 来绕缓存：那会让 `library.js` 出现两份实例（`scanner.js`/`kbqa.js` 走不带查询串的那份），`refresh()` 清不掉同一份缓存。要么全带、要么全不带，目前选择全不带 + 重启。
- 浏览器半侧（`client.js`）改完刷新页面即可；但**只刷新页面不重启**时宿主仍是旧代码，所以前端刻意传 `depth=64`、并优先用相对路径调 `/lib/open`，保证两种组合下都不会比原来更差。
- 标记文件里 `libRev` 为 `rev12` 且 `serving: this-entry` 才说明新宿主代码在真正服务请求。


### 知识库问答（本轮新增）

「文件库 → 问答」子页：输入问题，检索本地归档库后由当前默认模型总结，答案标 `[资料N]` 出处。

**链路**

1. 前端 `POST /api/workbench/lib/ask`，带 `question` / `history` / `useModel` / `topK`。
2. `kbqa.retrieve()` 拆分问题（标点 → 疑问词 → 2~4 字滑窗），多路并行调 `library.search`。
3. 打分：正文命中 > 文件名命中；专名按「覆盖项目数」加权（`杭氧`只覆盖 3 个项目 → 高分，`减值`覆盖 10 个 → 低分）；`取数表`/`模板` 降权，`底稿`/`评估说明`/`报告` 加权。
4. 取前 5~8 篇正文（每篇截 6000 字）拼成【资料】上下文。
5. `ctx.llm.stream()` 流式生成，system 提示要求「只依据资料、不编造、标出处」。
6. 模型不可用（未选模型 / llm 服务缺失）时自动降级为检索摘要，答案卡标「仅检索」。

**路由**

| 路由 | 说明 |
|---|---|
| POST /api/workbench/lib/ask | 问答主入口，`useModel:false` 可只走检索 |
| GET /api/workbench/lib/retrieve?q= | 只看召回了哪些文件（调参用） |

**性能**：`library.search` 给正文加了 LRU 缓存（1500 篇），元数据先扫、正文分批并发读。
典型问题 20ms~1s 出结果（冷缓存约 2.7s）。

**关键实现约束**：中文没有空格，整句子串匹配常 0 命中（「千年舟减值测试」搜不到），
必须靠滑窗切词 + 专名加权；2 字词只在「覆盖项目数 ≤ 3」时才当专名，否则噪声过大。


## 文件库扫描（本轮新增）

「文件库 → 扫描」。给归档目录按「年份\受理号 项目名\01 取数表|02 电子底稿|03 纸质报告、合同扫描|04 装订版报告」放好新项目后，点一次扫描就能把它扫进索引与知识库，**不需要手工改 JSON、也不需要重跑 Python 脚本**。

### 三种扫描粒度

| 选项 | 行为 | 何时用 |
|---|---|---|
| 增量扫描（默认） | 只处理「新增 + 修改」的文件，未变的沿用旧记录（按 `rel + size + mtime` 判定） | 日常，秒级完成 |
| 全量重扫 | 所有文件重新抽文本 | 怀疑索引有错、换了解析器 |
| 顺带 OCR | 扫描版 PDF 调 MinerU 转 Markdown（默认最多 10 张，可调） | 新增了扫描版报告 |

### 扫描做了什么

1. 遍历归档根目录，比对现有 `_知识库\kb_index.jsonl`，算出 新增 / 变化 / 删除 / 未变。
2. 对新增与变化的文件抽正文，写 `_知识库\texts\<md5>.txt`；文本抽取失败时用 OOXML 直接解包兜底。
3. 原子替换 `kb_index.jsonl`（写 `.tmp` 再 rename），中断不会留下半截索引。
4. 重建 `_索引库\projects_index.json`：把磁盘上的项目目录与历史爬取元数据（状态/委托方/报告号/源端挂档数）按「年份+受理号」合并。**新项目自动建档；没有任何文件的空目录不再收录**（旧版会把它列出来并标「待归档」，现已取消）。项目目录从磁盘删除后，它的源端挂档记录也一并从索引里剔除。
5. 重写 `_索引库\评估文件库索引.xlsx`（项目索引 / 文件清单 / 分类统计）。
6. 清理孤儿正文：磁盘上删掉的文件，其 `texts\*.txt` 一并删除。
7. 让 `library.js` 缓存失效，界面立刻看到新数据。

### 宿主路由

| 路由 | 说明 |
|---|---|
| `POST /api/workbench/lib/scan` | 启动扫描，**立即返回**（`{ok,id,started}`）；`{full:true}` 全量、`{ocr:true,ocrLimit:N}` 顺带 OCR、`{cancel:true}` 中断 |
| `GET /api/workbench/lib/scan` | 只读扫描状态：`phase` / `progress` / `walk` / `events` / `newProjects` / `result` / `error` |
| `GET /api/workbench/lib/scan?preview=1` | 顺带返回磁盘项目预检（每个项目的磁盘文件数 vs 已入库数） |
| `GET /api/workbench/lib/scan/status` | 同 GET，语义化别名 |

进度为什么用轮询而不是 SSE：连接服务只提供 `register` 的 fetch 语义，没有流式通道；扫描事件量很小，1.2s 轮询更简单也更抗断线。**页面关掉再进来，会凭 `status().running` 接上正在跑的任务**（子进程在宿主侧继续跑）。

### 实现位置

| 文件 | 作用 |
|---|---|
| `scan_kb.py` | 目录遍历 + 文本抽取 + OCR + 索引/Excel 落盘，stdout 逐行输出 JSON 进度 |
| `scanner.js` | 宿主侧调度：找 Python、起子进程、把进度转成内存状态、扫描完成后重建项目索引并清缓存 |
| `library.js` | 新增 `refresh()`（清缓存）与 `kbRows()`（读知识库记录） |
| `client.js` | 「扫描」子页：启动/中断、进度条、事件流、本次新增项目、磁盘预检 |
| `index.js` | 注册 `/lib/scan` 系列路由 |

### 解析器与限制

- Word（docx/docm）、Excel（xlsx/xlsm/xls）、有文字层的 PDF、md/txt/csv 可全文检索。
- 扫描版 PDF 标记 `scanned`，无文字层时 `text=false` + `note`；勾选 OCR 后由 MinerU 补 Markdown 并回填。
- 图片、压缩包、老 `.doc`（OLE 二进制）只进文件清单，仅能按文件名检索。
- 单文件 >300MB 跳过抽取；PDF 最多读 200 页；Excel 每表最多 4000 行。
- Python 依赖 `python-docx` / `openpyxl` / `xlrd` / `PyMuPDF`。宿主会依次尝试 `DSH_PYTHON` 环境变量、`python`、`py -3`、`python3`；都找不到时扫描会明确报错而不是静默失败。

### 排障：怎么确认运行中的进程加载了新代码

宿主半侧改动（`index.js` / `library.js` / `scanner.js`）后，HMR 会在下一次 profile 重组时替换插件。是否真的换上了，看这个标记文件：

```json
// ~/.dsh/workbench-host-applied.json
{ "rev": "rev8", "at": "...", "pid": 20888, "routes": [... "/api/workbench/lib/scan" ...], "disposers": 24 }
```

`rev` 与 `index.js` 的 `REV` 常量、`dsh-workbench-host/index.js` 的 `?rev=` 必须一致。若 `routes` 里没有 `/lib/scan`，说明还是旧代码 —— 重启 DSH 即可。

**注意（两个已踩过的坑）**：

1. **不能再用「REV 布尔标记挡住第二次 apply」**。宿主半侧有两个 entry 都会 apply，启动时需要去重；但 HMR 重载是「先停止旧实例、再启动新实例」，布尔标记会让同版本的新实例直接 return，而旧实例的路由已经被 dispose —— 结果一条路由都不剩、整个文件库 404。
   现在改成**按实例认领/释放的路由归属表**（`globalThis.__dshWorkbenchRouteOwners`，path → token）：apply 时只登记「还没人认领」的路径，effect 销毁时只释放自己认领的。双 entry 去重与重载交接都能正确工作，且不依赖 REV 是否变化。

2. **标记文件只由 Electron 宿主进程写**（判断 `process.versions.electron`）。本地用 `node` 跑集成测试也会 import `index.js`，若不拦着，marker 里会出现测试进程的 pid，排查时容易误判「宿主没重载」。

## 文件库清理与「检索并入浏览」（2026-11-14）

### 删了什么

- **6 个没有任何文件的项目目录**从归档盘删除：华江科技股权评估项目、杭泰光伏私募REITs-长期股权投资、杭徽高速2025年度评估(8187)、立妙达估值项目、中碳股改、终验项目（都是 0 个文件，删除前逐个复查过；改动前的索引/Excel 备份在 `_revert_backup/workbench-20261114/`）。
- **索引同步删除**：`_索引库\projects_index.json` 由 55 个项目降到 50 个，`评估文件库索引.xlsx` 用 `scan_kb.py` 重建，`项目索引` 工作表同为 50 行。源端挂档仍为 368 条 —— 其中杭泰/杭徽两个受理号在盘上还有同名号但带文件的目录（`杭泰光伏私募REITs项目-资产组`、`杭徽高速2025年度评估(8410)`），它们的源端挂档记录应当保留。
- 概览 KPI 同步变成 50 个项目（2024 年 5 / 2025 年 27 / 2026 年 18）。

### 代码层：空目录不再算项目

| 文件 | 改动 |
|---|---|
| `scanner.js` | `rebuildProjectIndex()` 不再把磁盘上的空目录塞进项目列表；`old.files` 按「年份+受理号」过滤，项目删掉后源端挂档记录一起消失 |
| `scan_kb.py` | `project_meta(records)` 去掉 `disk_projects` 空目录补录，Excel 只收有文件的项目 |
| `library.js` | `projects()` 与 `overview()` 兜底过滤 `localFiles === 0`，旧索引残留也不会显示；`byYear.empty` 字段删除 |

验证：临时目录里造一个空项目 + 一个有文件项目，`rebuildProjectIndex` 得 0 个项目（空目录不进 JSON）、`scan_kb.py` 生成的 Excel 只有 1 行（有文件的那个）。

### UI：检索并入浏览

- 文件库页签从「问答 / 浏览 / 检索 / 扫描 / 概览」变成 **问答 / 浏览 / 扫描 / 概览**，「检索」组件 `LibSearch` 删除。
- 浏览页顶部一个输入框同时承担两件事：输入即筛项目（名称/受理号/委托方/报告号），**回车或点「全文检索」**走 `/lib/search` 搜知识库正文。命中面板在项目列表上方（最高 320px 滚动），每行有「预览 / 打开 / 浏览项目」。
- 「浏览项目」按受理号（退回目录名包含）定位到左侧项目并加载文件树，同时清空检索词、退出检索态；检索期间项目列表不再被关键词过滤，避免结果下方一片「没有匹配的项目」。
- 项目行右侧由「(空) / 待归档」改为「N 个 · 体积」；概览「按年份」表删掉「待归档」列。

验证：`tools/uiharness/run-lib2.mjs`（无头 Chromium + 桩宿主）—— 4 个页签、50 行项目、无「待归档」、搜「评估范围」得 40 个命中且结果出现在浏览页内、预览出正文、点「浏览项目」后选中中科嘉亿并展开 16 个文件、概览无待归档列、无 pageerror。截图 `L6`–`L10`。

### 生效方式

- 浏览器侧 `client.js`：HMR，刷新即生效。
- 宿主侧 `scanner.js` / `library.js`：Cordis 不重新求值已缓存的 ESM，**重启 DSH 后**才用上新逻辑（数据清理已直接落盘，重启前后界面一致）。


## 本地项目：报备表单版（2026-11-15）

把「工作 → 本地项目」从「一张小表 + 弹窗」改成评估报备系统的版式：列表页 + 全屏表单页（顶部标题条 + 返回/保存，四个页签，左灰标签格 / 右输入格的两列表格）。

### 交互

- 列表页：搜索（名称/编号/文号/委托人/经理）、年份 / 业务类型 / 风险等级三个筛选、共 N 个项目提示；右上「打开根目录」「+ 新建项目」。
- **点项目名称 → 打开该项目在数据目录下的文件夹**（`<数据目录>\<年份> <项目名>`，不存在就建）。
- 行操作：编辑、文件夹、删除（删除会解除工时关联，不删工时记录）。
- 表单页四个页签：基本信息（含项目基础信息 + 成员信息）、客户信息（委托人）、被评估单位信息、合同信息（常规信息 + 涉密信息）。
- 底部提示「保存后将在数据目录下创建文件夹：2026 XXX」，保存新建项目时会异步建目录（失败静默，不影响保存）。

### 字段

- 基础：项目名称*、项目编号（自动 `TY-YYYY-NNN`）、EBS 项目、项目简称*、项目受理号、风险等级（A/B/C）、业务类型（5 类）、评估基准日*、经济行为、评估对象-报告、评估范围-报告、价值类型（常用 5 种 + 其他 5 种）、评估目的-报备（25）、评估目的（17）、评估业务性质（7）、是否重大资产重组、评估对象-报备（7 类分组）、资产置入/置出、评估对象股权比例(%)、评估报告日、报告文号（`天源评报字〔XXXX〕第XXXX号`，可一键按年份流水生成）、项目阶段、截止日/预算工时、备注。
- 成员：执行部门（一部/二部/三部，可自填）、项目合伙人（合伙人A，可自填）、项目经理（经理A，可自填）、参与人员（标签式，回车添加，预设成员A）、签字评估师（两人）。
- 委托人：类型（法人组织/自然人）、名称*、简称*、与被评估单位是否一致*、社会信用代码、企业类型、住所、注册资本、法定代表人、经营范围、与被评估单位关系。
- 被评估单位：名称*、简称*、法定代表人、社会信用代码、企业类型、注册资本、住所、经营范围、经营情况简介。
- 合同：合同类型、签订日期、服务期间起止、币种、原币金额、合同金额、支付方式、报告提交时间/方式、外送报告份数、外送评估说明份数、其他报告使用人、具体评估目的、合同扫描件（只记文件名）、是否涉密。

### 数据

项目对象在原字段（`id/code/name/client/type/baseDate/stage/budgetHours/tyId/tyUrl/note`）之上增加 `bizType/risk/year/shortName/acceptNo/ebsProject`、评估要素扁平字段、`team/customer/entity/contract` 四个分组。`normalizeProject()` 负责把旧记录补齐默认值，旧数据不需要迁移。

### 宿主侧

新增 `POST /api/workbench/project/folder`（`index.js`）→ `store.projectFolder()` / `store.openProjectFolder()`（`store.js`）：按 `<数据目录>\<年份> <项目名>` 建目录并打开，`open:false` 时只建不打开。前端在路由 404（宿主未重载）时退回 `POST /store/open` 打开根目录并提示重启。

### 生效方式

- `client.js`：刷新页面即生效（已在 `tools/uiharness` 用桩宿主回归：`run-projects-pf.mjs`、`run-projects-save.mjs`，截图 `PF1`–`PF12`、`F1`–`F4`）。
- `index.js` / `store.js`：**重启 DSH** 后新路由才可用；未重启时点项目名只会打开根目录并提示。

## 修复：点项目名/文件夹「提示已打开，但什么窗口都没出现」（rev14）

**现象**：点项目名称或行操作「文件夹」，底部弹「已打开：`D:\天源评估\个人工作台\2026 XXX`」，但桌面上没有资源管理器窗口。点「打开根目录」「设置 → 打开文件夹」、文件库里的「打开」也一样。

**根因**：`spawn('explorer.exe', [dir], { windowsHide: true })`。Node 在 Windows 上把 `windowsHide` 写进 `STARTUPINFO.wShowWindow = SW_HIDE`，`explorer.exe` 尊重这个隐藏标志 —— 窗口**确实建出来了**（`CabinetWClass`，标题正是目标文件夹，大小位置都正常），只是 `IsWindowVisible()` 为 false，于是人看不见，弹窗却照报成功。

- 定位证据：点一次 → `EnumWindows` 列出 `CabinetWClass`，目标文件夹窗口在、`vis=False`；同一条命令去掉 `windowsHide` 再点 → 立刻 `vis=True`，窗口可见。
- 佐证：之前每次失败点击都留下一份隐藏窗口，进程各占约 270 MB，`explorer.exe` 进程数一度到 7 个（这些已清理）。

**为什么原来报成功**：`spawn()` 对 ENOENT/EPERM 是异步 `error` 事件，不是同步抛；原代码只包了 `try/catch`，任何失败都会被吞成 `{ok:true}`。

**改法**：新增 `opener.js` 收口「交给系统 shell 打开」的动作 ——

- 打开窗口时**不传 `windowsHide`**（`explorer.exe` 是 GUI 子系统程序，不传也不会闪黑框；只有 `cmd /c start` 打开系统浏览器那种需要隐藏控制台）；
- 监听 `error` 事件，并把 `unref()` 挪到确认没报错之后，最多等 600 ms 再回 `{ok:true}`，失败则回 `{ok:false, error}`，前端就会显示「打不开项目文件夹：…」而不是假成功；
- `explorer.exe` 成功时也常以退出码 1 立刻退出（把请求转交给已在运行的 shell 实例），所以**不能**用退出码判定成败。

调用点已全部改到 `opener.js`：`store.js` 的 `openDir()` / `openProjectFolder()`、`library.js` 的 `openPath()`（`index.js` 的 `/lib/open` 相应改为 `await`）。`index.js` 的 REV 与 `dsh-workbench-host/index.js` 的 `?rev=` 同步递增到 `rev14`。

**验证**：直接 `node` 调用修好的 `store.openProjectFolder()` / `lib.openPath()`，前后用 `EnumWindows` 对比，新窗口 `vis=True`；再用不存在的命令验证失败路径返回 `{ok:false,error:"启动失败：spawn … ENOENT"}`（不再假报成功）。

## 项目表单：编号/简称/行距/默认值/客户联动/合同扫描件（rev15）

这一轮按使用反馈把「工作 → 本地项目 → 新建/编辑项目」四组信息改了一版，改动集中在 `client.js`（表单）与 `index.js`（两个宿主路由）。

### 基本信息

| 项 | 原来 | 现在 |
|---|---|---|
| 项目名称 | 与「项目简称」两个字段并存 | **删除**；项目名称即项目简称，只留「项目简称」（保存时 `name` 与 `shortName` 写入同一个值，列表/工时/文件夹都读它） |
| 项目编号 | 只读，`TY-2026-001` | **可输入框**，规则「年月日 + 三位流水」如 `20261115001`；流水在**同一年**内递增，保存时再查一次重号，撞号直接拦下并提示 |
| 行距 | 经济行为用 1 行 textarea（min-height 54px）、备注用 2 行 textarea，比别的行高一截 | 两行都改成单行输入框，13 行统一 39px（自动化断言 max-min ≤ 2px） |
| 评估对象股权比例(%) | 空 | 默认 `100`（老数据里是空串的打开时也补成 100） |
| 资产置入/置出 | 空 | 默认 `不适用`（空串同样补） |
| 评估报告日 / 归档日 | 「截止日 / 预算工时」在前、评估报告日在后；截止日是个日期+预算工时的组合格 | **调换位置**：评估报告日在前、归档日在后；「截止日 / 预算工时」改名 **归档日**（只留一个日期框），**预算工时输入框删除**；归档日默认 = **评估报告日 + 90 天**（选报告日时自动带上；手改过归档日的不会被覆盖；报告日清空则归档日跟着清空） |
| 经济行为 | 提示「本次评估对应的经济行为，例如：股东拟转让其持有的全部股权」 | 提示改为「**用于报告描述，注意确认是否添加“拟”字，例：拟转让股权，拟收购股权**」，占位符也换成「如：拟转让股权 / 拟收购股权」 |
| 项目阶段 | 含「内部审核」 | 内部复核拆成 **一复 → 二复 → 三复 → 签发**，其后才是出具报告、归档/收款 |

### 成员信息

- 执行部门 / 项目合伙人：**普通输入框**（原来 `datalist` 组合框聚焦会弹建议下拉，和「参与人员」那格不一致）。
- 项目经理：与「参与人员」**同一套标签框** —— 输入姓名回车加一个、× 删除、右侧 `+` 补回，默认 `经理A`。落库为 `team.managers` 数组，`team.manager` 同步成第一个（列表、搜索、「同步到线上」仍按字符串读，多人时用「、」连接；老数据只有 `manager` 字符串的，打开时自动补出数组）。
- 签字评估师两个输入框的占位符去掉括号与默认值说明，只剩「签字评估师一」「签字评估师二」。
- 默认值：执行部门 `三部`、项目合伙人 `合伙人A`、项目经理 `经理A`、签字评估师一 `经理A`、签字评估师二 `合伙人A`。新建时预填；**老数据里这几项是空串的也按默认补上**（`fillTeamDefaults()`），已经有人的原样保留 —— 之前从天源导入的项目这几格是空的，打开表单要手填一遍。

### 客户信息 / 被评估单位：企业库自动补全（本轮新增）

- **本地企业库**：`work.companies` 存在工作台数据文件里（`企业库 N 家` 显示在客户信息页脚）。来源两处：
  ① 打开「本地项目」时用已存项目的**委托人（法人组织）与被评估单位**自动建库/补库；
  ② 每次**保存项目**都把这两家 upsert 进去。空值不会覆盖库里已有的值，按统一社会信用代码去重（没有代码才按名称）。
- **填名称自动补全**：委托人名称 / 公司名称输入框失焦时，按名称（或信用代码）命中企业库 → 一次补全 **简称 / 社会信用代码 / 企业类型 / 住所 / 注册资本 / 法定代表人 / 经营范围**，toast「企业库已补全…」。委托人那边如果勾了「与被评估单位一致 = 是」，补全的同时仍按既有规则同步到被评估单位页签。
- **候选下拉**：输入关键字（名称 / 简称 / 信用代码片段）时在输入框下方列出最多 6 家，点一下就把名称 + 七项一起填上。没用 `datalist`（避免那个和别处不一致的下拉箭头）。
- **库里没有 → 企查查·企业工商**：宿主新增 `POST /api/workbench/company/lookup`，用宿主已连接的 dsh-mcp-connector「企查查·企业工商」（`mcp__qcc-company__*`）查工商登记信息，映射成同一组字段后**落进企业库**，下次离线也能补。简介/短名走 `get_company_by_query` 先做实体识别（只接受唯一候选），再按信用代码查登记信息。
- 只为「像完整企业名」的输入触发（以 公司/集团/合伙企业/事务所/合作社/研究院/银行/医院/学校/中心/工厂/厂 结尾），半截词不打扰；同一个名字不重复查。
- 企查查不可用/查无此企业时，toast 说明原因，字段保持空白可直接手填，不影响保存。
- **工具结果结构兼容（rev18 修）**：`ctx.tools.execute()` 的批量结果是 `{ results: [{ callId, result }] }`，正文挂在 `result.content` 上，不是 `content`。rev17 只读 `content`，于是企查查明明查到了也被判成「工具返回空结果」——现在先解包 `result`（并兼容 output/value/data/text 兜底），`isError` 也改看解包后的对象；解析失败时错误里会带上原始结构的 240 字符，便于定位。
- **委托人简称的取值顺序**：**企查查「企业简称」→ 大模型 → 本地规则**。补全到企业简称就不再调模型（`fillShortNameIfEmpty` 先看 lookup 回来的记录有没有 `shortName`）；企业库/企查查都没有简称时才走 `/company/shortname`；生成的简称会回写企业库记录，下次免费。
- **注册资本千分位**：`formatCapital()` —— 数字部分按千分位分组、单位原样保留（`1400万元 → 1,400万元`、`2000.5万元 → 2,000.5万元`）。三处生效：企查查/企业库补进来的值、打开老项目时的显示（`normalizeProject`）、手输框（打字时若光标在末尾就顺手分组，失焦再统一格式化一次，中段编辑不折腾光标）。
- **委托人简称按名称自动生成**：`POST /api/workbench/company/shortname` —— 优先用宿主默认大模型（`ctx.llm.stream`，提示词要求去掉行政区划与组织形式、2-10 字），模型不可用/输出不像话时退回本地规则（`ruleShortName`：去掉 `XX省/市` 前缀与 `股份有限公司/有限公司/集团/公司` 等后缀，截 12 字）。前端在「名称失焦」和「简称被清空后失焦」时触发，只补空值、不覆盖手填；宿主没重启（路由 404）时前端用同一套规则（`guessShortName`）兜底，所以刷新页面就能用。

### 项目编号规则 / 评估咨询业务表单（rev32）

- **项目编号**：`nextProjectCode()` 只跟**同一天**的编号比较——当天没有就是 `YYYYMMDD001`，有 `001` 才 `002`，依次递增（原来按年份取最大值，昨天的 002 会让今天从 003 开始）。
- **业务类型 = 评估咨询业务** 时：
  - 报告文号提示与占位符改为 **`天源咨报字〔XXXX〕第XXXXX号`**（五位序号），「自动生成」也按咨报字出号；资产评估业务仍是 `天源评报字〔XXXX〕第XXXX号`（四位）。
  - **不展示**：评估业务性质、是否属于重大资产重组、评估对象-报备、评估目的-报备、资产置入/置出（保留价值类型、评估目的、评估对象股权比例）。

### 合同信息自动带出 / 模型空输出兜底（rev31）

- **打开「合同信息」自动带出**：新增 `POST /project/contract-files` 列出 `02现场资料\业务委托合同\` 里的合同与 `.md`；页签切过去时自动填 `attachment` / `markdownPath`，有文件就直接能点「填写信息」，不用再添加、转换。
- **模型空输出不再失败**：`ruleExtractFields()` 用正则从合同正文兜底——委托人（`甲方（委托人）` / `委托人名称(甲方)` 等多种写法）、18 位信用代码（只认 9x 开头）、法定代表人、住所、注册资本、被评估单位（`（以下简称：被评估单位）` 前的公司名）、评估基准日、签订日期、金额、评估目的、评估对象。模型结果优先、规则补空（`_source: model | mixed | rule`）；模型彻底没输出时返回 `_source: rule` 并在提示里说明「已按规则提取，请核对」。
- 抽取链路还加了：`maxTokens` 3000→**4000**；空输出时用「只输出 JSON」的短路提示重试一次；再不行才让模型修 JSON；最后才落到规则。

### 合同「添加 + 解析」两段式 / markdown 落盘（rev28）

- **三个按钮（rev30）**：合同扫描件那一行是 **「添加」**（原来叫「点击上传」，已有文件时叫「更换文件」）+ **「转换为 md」** + **「填写信息」**。原来的「解析并自动填写」复选框去掉了。
  - 「转换为 md」：只把 word/pdf 转成同目录同名 `.md`（已有且不比原件旧就直接复用，秒回）；
  - 「填写信息」：读那份 `.md` 交给大模型，按结果填表（此时不再碰 MinerU）；没有 md 会提示先转换。
- **宿主路由 `POST /project/parse`** 带 `mode`：`md` 只转换（返回 `md` 路径 / `via` / `reused`），`fill` 只读 md 调模型（返回 `fields`），不传 mode 则两步都做。
- **已有 markdown 就直接用**（rev29）：点「解析」时，如果同目录同名 `.md` 已存在且不比原文件旧，就直接读这份 `.md` 交给模型填表，**不再走 MinerU / 本地取文**；`.md` 比原文件旧（或没有）时才重新解析并覆盖。返回里的 `reused: true` 会体现在提示里（「已按合同填写（复用已有 markdown …）」）。
- **解析即填表**：项目基础信息、委托人、被评估单位、合同全部字段照旧只填空项；解析成功顺带补被评估单位经营情况简介。
- **报告提交方式默认「特快专递」**（新项目预填；老数据空着也补）。
- **「更新数据」和「企查查」按钮等高同宽**：两者都走 `.pf-cmp-tools .pf-mini`（24px 高、8px 内边距、同一套边框圆角），深色模式也给了配色。

### 删除项目可选删文件夹 / 成员与重组默认值（rev27）

- **删除项目弹窗**：点「删除」不再直接 confirm，而是弹窗写明项目名 + 文件夹名，三个选择 —— **取消 / 只删项目 / 项目 + 文件夹**；选后者会调宿主 `/project/folder`（`remove: true`）把 `<数据根>/<编号 简称>` 整个删掉（路径按 `safeFolderName` 校验、只允许删根目录下一层）。工时记录两种方式都保留、只解除关联。
- **项目经理默认 成员A、经理A**（`DEFAULT_MANAGERS`，第一个英文别名 `manager` 取成员A）；**参与人员默认 成员A**；**是否属于重大资产重组默认 不适用**（老数据空值也补）。

### 成员默认值（rev26）

- **项目经理默认 成员A**（`DEFAULT_MANAGER`），**参与人员默认 成员A**（`DEFAULT_MEMBERS`）；老项目里这两项为空的打开时也补（和之前 经理A 的处理一致）。
- 签字评估师默认不变：一 经理A / 二 合伙人A。

### 资产置入/置出（rev25）

- 选项：**置入 / 置出 / 不适用**——去掉 **「不适宜」**，保留「不适用」，新项目默认「不适用」。
- 老数据里存的「不适宜」打开时归到「不适用」（`LEGACY_IN_OUT`），空值也补「不适用」。

### 合同解析覆盖项目基础信息 / 金额转元 / 业务性质判定 / 企业简介（rev24）

- **解析回填范围扩到项目基础信息**：评估基准日、经济行为、评估对象-报告、评估范围-报告、价值类型、评估目的-报备、评估目的、评估对象-报备、资产置入/置出、评估对象股权比例(%)、评估业务性质，以及委托人 / 被评估单位 / 合同全部字段（提示词里逐条写了取值口径）。
- **金额统一「元 + 千分位」**：`toYuanAmount()` 把 `28万元 / 28万 / 280000` 都换成 `280,000 元`（亿元也认）；合同原币金额、合同金额两个框都走它，输入框本身也还是 `capInp`。
- **评估业务性质按规则判**：`deriveBizNature()` —— 委托人或被评估单位是国企（`国有/全民所有制/国资委/国有资产/国有资本/国营`，或模型给出 `stateOwned=是`）→ **国有资产评估业务**；任一是上市公司 → **证券期货评估业务**；否则用模型判断的合法值，再否则保留原值。
- **被评估单位经营情况简介**：新增宿主路由 `POST /company/intro` —— 先 `web_search` 搜公开资料，再让模型压成 80~120 字一段话（不要客套话）；**搜不到就返回空、不填**。上传解析成功、以及点「更新数据」时自动补。
- **企业信息工具条**：委托人 / 被评估单位名称右边加了 **「更新数据」**（强制重拉企查查并覆盖）和 **「企查查」**（`https://www.qcc.com/web/search?key=<企业名>`，新窗口打开），防止本地企业库数据老化。
- **委托人删除按钮**：至少保留一个委托人；删除按钮只出现在第 2 个起的区块上，并且移到了标题行右侧（`.pf-sec-x{margin-left:auto}`），不再挤在表格上方。

### JSON 解析加固（rev23）

- 上一版 `maxTokens: 1600` 容易被截断（合同字段多），现在 **3000**；提示词也加了「值都用双引号字符串、不要注释、宁可留空不要猜」。
- `parseModelJson()` 三级兜底：去掉 ``` 代码块 → `firstBalancedObject()`（字符串内的括号不计，前后多说几句也能抠出来）→ 老的 `pickJsonObject()` 从后往前收。
- 解析失败**自动再来一次**：把上次输出丢回模型（system 换成「你是 JSON 修复器，只输出合法 JSON」）再解析；仍然失败才报错。
- 报错带证据：`模型输出不是合法 JSON（触到 maxTokens 上限 / JSON 没闭合，像是被截断）；已尝试修复仍失败；原文前 240 字：…`。

### 合同默认值 / 金额千分位 / 建文件夹即入列表（rev22）

- **其他报告使用人**默认填 `法律、行政法规规定的使用人`（rev33 改，原来那句话太长；新项目预填，老数据空着的打开时也补）。
- **合同原币金额 / 合同金额**：解析回填时按千分位（`280000 → 280,000`）；两个输入框也换成和注册资本同一套 `capInp`（打字时光标在末尾就顺手分组，失焦统一格式化）。
- **建文件夹即在本地项目里生成条目**：上传合同会先在磁盘上建出「编号 简称」文件夹，以前这时列表里还没有这条记录；现在上传成功后 `ensureProjectRecord()` 会顺手 upsert 一条项目（编号/简称都在才算），之后再点「保存」就是更新同一条，不会重复。保存与自动入库共用 `buildRecord()`。

### 合同扫描件 / Word 解析（rev19）

- 合同扫描件那一行新增 **「解析并自动填写」** 复选框，**默认不勾**。勾上再上传 → 文件先照旧存进 `<项目文件夹>\02现场资料\业务委托合同\`，然后解析、抽字段、回填四组信息。
- 取文顺序（`extractDocumentText`）：
  1. **本地 python**（`parse_doc.py`：PDF 用 PyMuPDF、DOCX 用 python-docx，含表格）—— 快、不出本机；
  2. 文本太少（扫描件）或本地取不到，才调 **MinerU CLI**（`mineru-open-api.cmd flash-extract <file>`，spawn 时剔除本机注入的过期 `MINERU_TOKEN`）；
  3. 两边都失败才报错，**文件已经存好**，`parseError` 里写原因。
- **服务访问顺序（rev21 修）**：在 Cordis 里直接读一个**没 inject** 的服务（`ctx.llm`）会抛错，`ctx.llm || ctx.get('llm')` 这种写法一旦前一段抛错，整个表达式就进 catch —— 于是明明 `ctx.get('llm')` 拿得到，也报「没有 llm」。现在统一用 `safeService()`：`ctx.get(name)` → `ctx[name]` → `ctx.root` 三条路各自 try，互不影响；`agentDefaultModel` 同样处理（顺手也修了文件库问答的同一处）。再取不到，还会借 `agentPresets.serviceFor(活跃 agent, 'llm')`。
- **插件里的模型选择框（rev21 新）**：合同扫描件那一排多了个模型下拉（`GET /company/models` 取 provider/model 列表），选择存在 `settings.parseModel`，上传解析时用 `&provider=&model=` 指定；宿主 `extractContractFields(ctx, text, choice)` 优先用它，没选才回退默认/第一个可用模型。
- **模型选择（rev20 修）**：`resolveModel()` 先取 `agentDefaultModel.currentSelection()`；如果没配（桌面端模型可能放在会话/预设里，这个服务是空的），退到 `llm.listProviders()` + `listModels()` 取第一个可用模型。都拿不到时错误里直接写出诊断：`没有可用的大模型（llm=有/无，默认模型=未设置，可用提供方=…）`。
- 实测这份扫描件（`澳多商誉评估合同.pdf`，无文字层）：本地取文 0 字 → MinerU flash-extract 7.5 秒拿回 3258 字 markdown（甲方/乙方/评估目的/评估对象都在）。
- 抽字段用宿主默认大模型（`ctx.llm.stream` + 严格 JSON 提示词），输出 `{project, customer, entity, contract}`；**只填空项，已有内容不覆盖**；解析失败只弹提示，不影响已上传文件。
- 回填范围：项目简称 / 经济行为 / 评估目的（含「其他」的具体目的）、委托人 7 项 + 关系 + 身份证、被评估单位 7 项、合同全部字段；服务期间起止日按「合同签订日 ~ 归档日」补齐。

### 委托人可多个（rev19）

- 数据模型从单个 `customer` 改成 `customers: []`，`customer` 保留为第一个的别名（天源同步、企业库、清单都还读它）。
- 客户信息页签按委托人分组渲染：第一个叫「委托人信息」，后面「委托人 2 / 3…」，每个都有完整字段；底部 **「+ 新增委托人」**，多于一个时每个区块右上角有 **「删除该委托人」**（只剩一个时不给删）。
- 只有**第一个**委托人勾「与被评估单位一致 = 是」时会同步被评估单位信息（多个都同步会互相打架，提示里写明了）。

### 评估目的「其他」/ 服务期间（rev19）

- 评估目的下拉末尾增加 **「其他」**；选中后多出一行 **具体评估目的**（`purposeOther`），保存与「同步到线上」清单都会带上。
- 服务期间起止日 = **合同签订日 ~ 归档日**：改签订日自动带起始日、改归档日自动带结束日（手改过的不覆盖）；老项目打开时为空也按这两个日期补。

### 客户信息（上一轮）

- 「与被评估单位关系」由下拉改为**输入框**。
- 委托人类型 = 法人组织 且「与被评估单位是否一致」= 是 时：关系自动填 **委托人系被评估单位**，并把被评估单位信息的 **公司名称/公司简称/法定代表人/社会信用代码/企业类型/注册资本/企业住所/经营范围** 与客户信息同步（这些字段在「被评估单位信息」页签里显示为只读，经营情况简介仍可填）。
- 委托人类型 = 自然人 时只渲染 4 项：委托人名称、委托人简称、**委托人身份证**（新增字段 `customer.idCard`）、与被评估单位关系；同时清掉不适用的「是否一致」和自动填的关系句。

### 合同信息

- 合同类型 = **框架协议 / 非框架协议**。
- 外送报告份数、外送评估说明份数默认 **4**。
- 合同扫描件**真的落盘**：`POST /api/workbench/project/upload?folder=<项目文件夹>&sub=02现场资料/业务委托合同&name=<文件名>`，请求体是文件原始字节（不走 base64），宿主建目录后写入 `<数据目录>\<编号> <简称>\02现场资料\业务委托合同\<文件名>`。表单里回显文件名与相对路径；以前只把文件名记在字段里，磁盘上什么都没有。

### 文件夹命名

`<数据目录>\<项目编号> <项目简称>`（原来是 `<年份> <项目名称>`）。老项目如果还留着「年份 项目名」目录，宿主会优先复用老目录（`legacy` 参数），不会让原文件夹"消失"。

客户端会同时带 `year` / `name` 两个老参数：**宿主还没重启**（路由还是旧版）时按老规则建目录，不会因为读不到 `folder` 建出「2026 未命名项目」这种空目录；上传接口在旧宿主上返回 404，前端提示「重启 DSH 后上传才会落盘」，并把文件名先记下来。

### 生效方式

- `client.js`：刷新工作台页面即生效（HMR）。
- `index.js`（两个新路由 `/project/folder` 的新参数、`/project/upload`）：**需要重启 DSH**。`index.js` 的 REV 与 `dsh-workbench-host/index.js` 的 `?rev=` 已同步递增到 `rev15`。

### 验证

- `tools/workbench-host-test.mjs`：用假 `ctx` 接住 `register()`，直接调 route 的 fetch —— 新建「编号 简称」目录、老目录回退、非法名拒绝、`create=false` 只探测、扫描件落盘字节一致、越界子目录与空文件被拒。
- `tools/uiharness/run-projects-form-v2.mjs`（先起 `tools/uiharness/server.mjs`）：无头 Chromium 断言 13 行行高一致、删除项目名称、编号可输入且为年月日+流水、股权比例 100、置入置出 不适用、阶段含一复/二复/三复/签发、成员默认值、关系输入框与联动同步、自然人四项、合同类型两项、份数 4、文件选择框上传后真的写进 `02现场资料\业务委托合同`、保存后文件夹名为「编号 简称」、同编号第二次保存被拦。
- `tools/uiharness/run-company-db.mjs`：企业库自举（已存项目 → 2 家）、本地命中一次补全 7 项且**不发网络请求**、库里没有时走 `/company/lookup` 并把结果落库、关键字弹出候选且点击回填、被评估单位页签同样补全、页脚显示企业库规模。
- `tools/workbench-host-test.mjs` 新增：`/company/lookup` 用假 `tools` 服务回放企查查返回 —— 完整名直接查、简称先 `get_company_by_query` 再按信用代码查、查不到返回 `ok:false`、空名称 400。
- 本轮新增断言：评估报告日排在归档日前、预算工时输入框已删除、归档日 = 报告日 + 90 天、手改过的归档日不被报告日覆盖、经济行为提示含「报告描述 / 拟」、老数据里 `equityRatio: ""` 打开即 100。
- `tools/uiharness/run-real-project.mjs`：**用真实数据文件**（`D:\天源评估\个人工作台\工作台数据.json`，只读）灌进无头页面 —— 现有项目能在新表单里打开，简称自动回退成原名、编号/基准日/部门不被改动，缺的字段用新默认值补齐（合伙人合伙人A、经理经理A、股权比例 100、置入置出不适用）。
- `tools/uiharness/run-projects-responsive-v2.mjs`：1500/1000/760 三个宽度都无横向溢出，暗色下标签格与输入框配色正常。
- `tools/uiharness/run-smoke-v2.mjs`：七个一级 tab（总览/工作/文件库/学习/股票/提醒/设置）+ 工作下四个子页全部渲染，无 pageerror / console error。
- 截图：`tools/uiharness/V1-basic.png`、`V2-client.png`、`V3-contract.png`、`PF2b-entity-synced.png`、`PF3b-person.png`、`PF5b-contract-upload.png`、`R1-1500.png`/`R2-1000.png`/`R3-760.png`/`R4-dark.png`、`PF-real-edit.png`。

列表副标题也顺手改了：项目名称与项目简称现在是同一个值时，副标题只显示编号，不再把名字重复一遍；
上传扫描件前要求「编号」与「简称」都填了，否则会存到对不上的目录里 —— 缺哪个就提示先补。

## 项目界面：作业信息 / 股权信息（rev33）

点「工作 → 本地项目」里的**项目名称**不再直接弹文件夹，而是进入项目界面（打开文件夹仍可用行操作的「文件夹」和界面右上角按钮）。

### 版式

- 顶部：`← 项目列表` + `项目编号 | 项目名称`，右侧基准日 / 项目经理 / 阶段，以及「打开项目文件夹」。
- 六个页签：**作业信息 / 结果汇总 / 报告说明 / 项目文件 / 生成/导出 / 报表模板**（对齐天源项目页）。
- 作业信息下再分：**股权信息 / 管理类底稿 / 基础类资料**。

### 股权信息（可用）

- 表格列：编码 / 公司名称 / 公司简称 / 上级母公司 / 股权比例% / 科目名称 / 公司负责人 / 评估方法 / 操作，编码按股权树自动编号（`1`、`1-1`、`1-1-2`）。
- 筛选：公司名称 / 上级母公司 / 公司负责人 + 查询、重置（本地过滤）。
- 「添加子公司」：公司名称*、公司简称*、上级母公司（下拉，可为顶层）、股权比例%*、科目名称*（长期股权投资 / 其他非流动资产-股票投资 / 其他非流动资产-股权投资 / 其他权益工具投资 / 交易性金融资产），旁边「新增股东」可以再记其他股东与持股比例。
- 「批量导入」：选 .xlsx/.csv → 宿主 `POST /project/equity/import` 交给 `equity_import.py`（openpyxl）按表头认列（公司名称 / 公司简称 / 上级母公司 / 认缴持股比例% / 科目名称），先给前 8 行预览再「确认导入」；同名公司按名称合并更新，不会重复插一条。表头认不到的「注：…」「1. …」这类说明行会被跳过。
- 「下载模板」：宿主 `GET /project/equity/template` 现场生成 xlsx（表头同上，带两行示例、冻结首行）。
- **「设置评估方法」必须先勾选公司**：没勾就点，只弹提示「请先勾选要设置评估方法的公司（可多选）」，不会打开对话框；勾了 N 家就一次给 N 家设成同一套（整体评估：资产基础法 / 收益法 / 市场法；非整体评估：报表净资产折算 / 账面投资成本 / 回购法 / 上市公司股价法 / 市场法 / 股利模型 / 期后转让价 / 近期投融资 / 其他方法）。行内「设方法」等价于勾这一家再打开对话框。
- 「设置公司责任人」同理需要先勾选；「刷新列表」在项目已关联天源（有 `tyId`）时调 MCP `get_project_companies` 合并回来，没关联就明确提示只读本地数据。
- 空项目进入时自动用「被评估单位 / 项目简称 / 评估对象股权比例」生成顶层公司一行（编码 1，科目默认长期股权投资），再往下加子公司。

### 数据

`work.equity[projectId] = { companies: [...], updatedAt }`，每家：`id/parentId/name/short/ratio/subject/manager/methods{whole,part}/shareholders`。随工作台数据一起落盘（`<数据目录>\工作台数据.json`），旧数据不需要迁移。

### 宿主侧（要重启 DSH）

- `POST /api/workbench/project/equity/import?name=xx.xlsx`：请求体是文件原始字节，写临时文件 → `equity_import.py import` → 返回 `{ok, rows}`，读完删临时文件。
- `GET /api/workbench/project/equity/template`：`equity_import.py template` 生成 xlsx 后直接以附件返回。
- `POST /api/workbench/project/folder` 新增可选 `sub`（数组或 `a/b` 字符串）：打开/创建项目目录下的子目录，界面里的「打开文件夹」（管理类底稿、基础类资料、项目文件）都走它。
- `runCli()` 给子进程加了 `PYTHONIOENCODING=utf-8` / `PYTHONUTF8=1`：Windows 上 python 默认 cp936，Node 按 utf8 读会把中文读成乱码。`equity_import.py` 自己再用 `ensure_ascii` 转义兜底。
- `package.json` 的 `files` 补上 `equity_import.py`；`REV` 与 `dsh-workbench-host/index.js` 的 `?rev=` 同步到 `rev33`。

### 验证（本轮）

- `tools/uiharness/run-pw-shots.mjs`（先起 `server.mjs`）：点项目名进项目界面、**未勾选点「设置评估方法」只出提示且不弹窗（`.wb-modal` 数量 0）**、勾选后弹窗并能保存（表格「评估方法」= 资产基础法 / 收益法 / 报表净资产折算）、添加子公司后行数 2、管理类底稿 20 项、结果汇总跟随股权数据；`pageerror` 为空。截图 `PW1`–`PW9`。
- `equity_import.py`：模板生成可打开（5275 B）；用真实 `公司导入模板.xlsx`（只有表头+说明行）导入得 0 行；自造含 2 家公司的表返回 `浙江省机电集团有限公司 / 100`、`浙江省机电设计研究院有限公司 / 80.1106`，中文与小数位无损。

## 项目文件夹模板：新建/导入即建目录，方法与科目决定子目录（rev34）

模板对齐 `D:\天源评估\【模板】项目文件夹`。规则只有一份，落在 `plugins/dsh-workbench/folders.js`（宿主路由与测试都调同一个 `planProjectFolders`）：

| 位置 | 什么时候建 |
|---|---|
| `01前期资料/{参考资料,待整理资料,行业研究}`、`02现场资料/业务委托合同`、`02现场资料/企业提供资料/00财务资料`（分类根）、`…/01管理类`、`02现场资料/现场勘察照片`、`03评估底稿/*`、`04项目归档/*` | 永远建（固定骨架 18 个目录） |
| `02现场资料/企业提供资料/00财务资料/<公司>` | **每家公司一套**（rev43 起；以前是项目级空目录） |
| `02现场资料/企业提供资料/02基础类/<公司>` 与 `<公司>/{公司基础资料,财务资料,评估申报与核实资料,行业与宏观分析资料}` | **每家公司一套**（分类在前、公司在后）；公司目录同名自动加 `(2)` |
| `…/03资产基础法/<公司>/<科目目录>` | 只在该公司选了**资产基础法**时建；科目子目录只给「财务资料」里**有金额（非 0）**的科目建，`12固定资产` 连 01房屋建筑物和构筑物 / 02机器设备和电子设备 / 03车辆，`15无形资产` 连 01土地使用权 / 02其他无形资产 |
| `…/04收益法/<公司>/01…07` | 只在选了**收益法**时建，7 个子目录固定（主营收入成本、销售费用、管理费用、研发费用、税金、非经、折现率） |
| `…/05市场法/<公司>` | 只在选了**市场法**时建 |
| 管理类资料（`01管理类`、`04底稿/管理类底稿/<分类>`） | 只有一份，不按公司拆（rev43 没动） |

- 五个触发点：新建项目保存后、天源项目导入后、**设置评估方法保存后**（方法一改目录就跟着变）、**添加子公司后**（先补一份 02基础类）、以及「股权信息」工具栏的 **生成项目文件夹** 按钮（手动补齐/同步）。全部幂等——已存在的目录跳过，只报新建/已存在条数；自动触发的那几处失败只提示一次、不弹窗。
- 新增「作业信息 → 财务资料」子页签：按公司录「科目 + 金额」，支持导入科目余额表 / 财务报表（`finance_import.py` 自动认「科目名称」与「期末余额 / 账面价值 / 余额 / 金额」两列，合计小计行跳过），表格右侧实时显示该科目对应哪个资产基础法目录，底部显示「将生成：…」。
- 数据形状：`work.finance[projectId] = { companies: { [companyId]: { subjects: [{ name, amount }], updatedAt } } }`。金额按字符串存，避免浮点误差把 0.01 存成 0.009999。
- 新建项目时被评估单位还没填，种子行叫「被评估单位」——这种占位名只建骨架、不建 `02基础类/被评估单位`，等填了真名再点「生成项目文件夹」。

宿主新增路由：

| 路由 | 作用 |
|---|---|
| POST /api/workbench/project/folders/build | `{ folder, companies:[{ name, methods:{whole,part}, subjects:[{name,amount}] }] }` → 返回 `{ ok, root, total, created, existed, dirs }` |
| POST /api/workbench/project/finance/import?name=xx.xlsx | 请求体是文件原始字节（8 MB 上限）→ `{ ok, rows:[{name,amount}], sheet, header }` |

`index.js` 的 `REV` 与 `dsh-workbench-host/index.js` 的 `?rev=` 同步到 `rev34`。**宿主路由改过，要重启 DSH 才生效**；客户端改动刷新页面即可。

### 验证（rev34）

- `node --check`：`client.js` / `index.js` / `folders.js` 全部通过。
- `tools/wb-test-folders.mjs`：4 家公司 → 43 个相对目录；`存货=0` 不建目录、`固定资产` 连带 3 个子目录、同名公司得 `(2)`、选了收益法的两家各 7 个子目录、没选市场法为 0。
- `tools/wb-test-build.mjs`：用与宿主同一套清洗逻辑真实落盘到临时目录——首轮 `created 43`，二轮 `created 0 / existed 43`（幂等），`01前期资料…04项目归档` 四个顶层齐全，`03资产基础法/…/12固定资产/03车辆` 存在；公司名里的 `/ < >` 与结尾点号被清洗、无非法段。
- `tools/wb-test-finance.py`：自造科目余额表（第 2 行表头、`3,456.78`、`(500)`、`合计` 行）→ 读出 4 行，`合计` 被跳过、括号金额为 `-500`、千分位正常。
- `tools/uiharness/run-pw-shots.mjs`：`{"errs":[],"toastShown":true,"dlgBefore":0,"dlgAfter":1,"methodCell":"资产基础法 / 收益法 / 报表净资产折算","rowsAfter":2,"finMapped":true,"finZeroCell":false}`；截图 `PW1`–`PW10`。
## 本地项目目录改为 00项目ing + 归档到文件库（rev37）

> 本节取代前面各节里「项目文件夹建在 `<数据目录>` 下」的旧描述；数据目录现在只放 `工作台数据.json` 与 `股票数据\`。

### 1. 项目文件夹根目录：默认 `D:\评估项目`

- 本地项目的文件夹（`<项目编号> <项目简称>`）不再建在数据目录（`D:\天源评估\个人工作台`）里，统一建在**项目目录**：默认 `D:\评估项目`。
- 数据目录仍只放 `工作台数据.json` 与 `股票数据\`；两套目录分开了。设置页新增「本地项目文件夹位置」，可以改项目目录、恢复默认、直接打开，旁边显示路径来源（设置 / 环境变量 / 默认值）。
- **老项目不用搬**：所有项目目录操作都先按「项目目录 → 数据目录」两个根查找。升级前建在 `个人工作台\2026 老项目` 里的项目仍然能打开、上传、生成模板目录；只有找不到时才在 `00项目ing` 下新建，不会留下重复空目录。
- 配置写在 `~/.dsh/workbench-store.json`：`{ dir, projectsDir }`；环境变量 `DSH_WORKBENCH_PROJECTS_DIR` 只当默认值（测试用）。

### 2. 行操作新增「归档」

流程（两段确认，不会误移）：

1. 本地项目列表每行新增 **归档** 按钮（已归档的项目显示灰色的「已归档」，不可点）。
2. 点归档 → `POST /project/archive/preview` 只读预览，弹窗里列出该项目 **`04项目归档`** 的真实内容：目录树、文件数 / 目录数 / 体积、每个文件大小；同时显示**源目录**、**归档到**（`已归档\{年份}年\{项目编号} {项目简称}`）以及「目标目录是否已存在」。04项目归档 为空时明确写「里还没有文件（只有空目录）」，仍可继续。
3. 确认归档 → `POST /project/archive/commit`：**整个项目文件夹**（不只是 04项目归档）移动到 `D:\天源评估\已归档\{年份}年\{项目编号} {项目简称}`。年份取项目的「年份」（表单里的 year，缺省按基准日/当年推算）；老项目原来的「年份 项目名」目录会顺便改成「编号 简称」。
4. 移动成功后宿主立刻触发一次**增量扫描**（`scanner.startScan({ full:false })`），文件库的 `_索引库\projects_index.json`、`_知识库\kb_index.jsonl` 与 `评估文件库索引.xlsx` 随之更新；前端提示「文件库正在后台增量更新」，可到「文件库 → 扫描」看进度。
5. 项目记录标记为阶段 `归档/收款`（列表显示「已归档」），写入 `archiveDate` 与 `archivePath`。之后点行操作「文件夹」直接打开归档后的真实目录（走 `/lib/open`），不会在 `00项目ing` 里再造空壳；项目界面里的「打开项目文件夹 / 各阶段目录」同样落到归档后的路径。

安全边界：

- 目标目录已存在 → 拒绝覆盖，一个字节都不动（宁可报错，也不把两个项目混进一个目录）。
- 源目录不存在（已经被归档或手工移走）→ 返回 `notFound` + 明确文案，不猜接近的名字。
- 只允许移动「项目目录 / 数据目录」下的一层项目文件夹；源目录落在归档库内部时拒绝。
- 跨盘才走「复制 + 删除」；其它移动失败（文件被资源管理器占用等）保留源目录并提示先关掉占用。

### 3. 新增 / 改动的宿主路由

| 路由 | 作用 |
|---|---|
| GET/POST /api/workbench/store | GET 返回 `dir` + `projectsDir`（含 default/source）；POST `{ dir }` 改数据目录，`{ projectsDir }` 改项目目录（互不影响） |
| POST /api/workbench/store/open | `{ which:"projects" }` 打开 00项目ing；不带则打开数据目录 |
| POST /api/workbench/project/folder | 按「项目目录 → 数据目录」查找/复用；新建落在项目目录；`remove:true` 只删找到的那一份 |
| POST /api/workbench/project/upload | 上传落到项目所在根目录下的 `02现场资料\业务委托合同\`（老项目落在老目录） |
| POST /api/workbench/project/archive/preview | 只读预览 04项目归档 内容 + 目标目录 |
| POST /api/workbench/project/archive/commit | 移动整个项目文件夹 → 触发增量扫描（已有扫描在跑时排队补扫）→ 返回 `{ from, to, scan, scanError, scanPending }` |
| POST /api/workbench/project/archive/open | 打开归档后的目录（限归档根之内） |

新增 `plugins/dsh-workbench/archive.js`（预览 / 移动 / 目标名校验），`store.js` 增加 `projectsDir` 配置与 `findProjectDir / projectDir / openProjectsDir`；`index.js` 的 `REV` 与 `dsh-workbench-host/index.js` 的 `?rev=` 同步到 `rev37`。**宿主路由改过，要重启 DSH 才生效**；`client.js` 刷新页面即可。

### 4. 验证（rev37）

- `node --check`：`client.js` / `index.js` / `store.js` / `archive.js` 全部通过。
- `node tools/workbench-archive-test.mjs`（临时数据目录 + 临时项目目录 + 临时归档库，不碰真实数据）：
  - 新项目建在 `00项目ing`、数据目录不再出现重复目录；老项目（`2026 老项目`）仍复用数据目录里的旧目录；
  - 预览统计 04项目归档「2 文件 / 2 目录」、列出文件与目录、目标 = `已归档\2026年\编号 简称`、预览不动源目录；
  - 确认后整个文件夹移动（含 04项目归档 之外的前期资料）、源目录消失；老项目归档时目录名改成「编号 简称」；
  - 目标已存在时拒绝覆盖且源目录保留；源目录不存在时 `notFound`；
  - 归档触发的增量扫描跑完后 `/lib/overview` 与 `/lib/projects` 能查到新项目（文件库确实更新了）。
- `node tools/uiharness/archive-server.mjs` + `node tools/uiharness/run-archive-ui.mjs`（Playwright，真实 client.js）：
  - 每行有「归档」；预览弹窗显示源目录 / 目标 / 04项目归档 的 4 个文件与目录树；
  - 取消不发 commit、源目录不动；确认后发一次带编号/年份的 commit，磁盘上整个文件夹移动到 `已归档\2026年\…`；
  - 列表 toast「已归档到 …；文件库正在后台增量更新」，状态变「已归档」、按钮变灰；
  - 空 04项目归档 提示「里还没有文件（只有空目录）」仍可确认；设置页显示项目文件夹根目录。
  - 截图：`tools/uiharness/AR1-archive-preview.png`、`AR2-archived-row.png`、`AR3-settings-projects-dir.png`。

## 股权信息：添加子公司按设计稿改、负责人多人、去掉刷新列表（rev35）

- **「添加子公司」弹窗改成设计稿的样子**：公司名称 / 公司简称，下面按行重复「上级母公司N / 股权比例N% / 科目名称N」。第一行右侧是蓝色「新增股东」，从第二行起右侧是「删除」。上级母公司只能从被评估单位这一棵树里选（默认第一行就是被评估单位，要挂到某一层子公司下面把第一行改掉即可），不再有「（顶层：被评估单位）」空选项，也没有单独的自由文本「其他股东」块。
  - 保存时第一行是主股东，决定表格「上级母公司 / 股权比例% / 科目名称」三列；所有行一起存进 `shareholders: [{ parentId, ratio, subject }]`。
- **「设置公司责任人」改成多人**：候选人来自本项目团队（项目经理 + 成员），勾选框多选；团队外的人可在「其他人员」里输入后「加入」。保存时用「、」连接写进 `manager`。**不再预选任何人**——以前会拿现有值 / 团队人员当默认，看着像「默认经理A」；现有值只作为「原负责人：…（不勾选就会被替换）」提示行显示。
- 种子股权行不再把项目经理 / 成员抄进「公司负责人」（`eqSeed` 的 `manager` 置空），负责人一律由弹窗显式设置。
- 工具栏**删掉「刷新列表」**，连带删掉它调的 `/ty/call get_project_companies` 实现和只剩它用的 `tyCompanyRows`。天源公司仍然走「天源项目 → 导入」那条路同步。
- 表单细节：`.pw-inline` 里的下拉不再撑满整行（「新增股东」按钮回到下拉右边）、数字框去掉上下小箭头。
- 新增子公司 / 设置评估方法后同步生成项目文件夹的逻辑沿用 rev34（幂等），本轮没动。
- 本轮只改浏览器半侧（`client.js`），**刷新工作台页面即可**，不用重启 DSH。

### 验证（rev35）

`tools/uiharness/run-pw-shots.mjs`（先起 `server.mjs`）：

```json
{"errs":[],"toastShown":true,"dlgBefore":0,"dlgAfter":1,"methodCell":"资产基础法 / 收益法 / 报表净资产折算","rowsAfter":2,"finMapped":true,"finZeroCell":false,"parent2":1,"mgrPreChecked":0,"mgrCandidates":6,"mgrCell":"经理A、成员B"}
```

- `parent2: 1`：点「新增股东」后弹窗里出现「上级母公司2 / 股权比例2% / 科目名称2」，删除后回到一行，保存成功（`rowsAfter: 2`）。
- `mgrPreChecked: 0`：负责人弹窗打开时一个都没勾（不再有默认）；`mgrCandidates: 6` 来自项目团队；勾两人保存后表格「公司负责人」= `经理A、成员B`。
- 旧断言全部保持：未勾选点「设置评估方法」只提示不弹窗、方法保存、财务资料科目能对上 `04应收账款`。
- 截图：`PW1`–`PW11`（新增 `PW6b-add-second.png` 第二行股东、`PW11-manager-multi.png` 多人负责人）。





## 股票：多源日线库与指标分析（2026-11-15）

### 页面

- **自选股表**照参考截图做成 20 列：操作 / 名称代码 / 最新价 / 涨跌 / 涨跌率 / 最高 / 最低 / 今开 / 昨收 / 市盈率 / 成交量 / 成交额(万) / 换手率 / 成本 / 总成本 / 持有量 / 总现值 / 盈亏率 / 盈亏 / 时间。红涨绿跌，数字右对齐、等宽字体，首列固定、可横向滚动。
- 操作列三个小按钮：`✎` 买卖点、`¥` 持仓成本、`✕` 移除；持仓弹窗填成本价与持有量，表内总成本/总现值/盈亏/盈亏率按最新价实时算。
- 工具栏：搜索、数据源下拉（未安装的显示「未安装」并禁用）、近 1/3/5/6 年（默认 6 年）、下载按钮、刷新行情、重新检测；下载时显示进度条与当前股票，结束后缩成一行「上次下载：…」。
- **指数搜索**：`上证指数`、`深证指数/深证成指`、`创业板指`、`科创50`、`沪深300`、`中证500/1000`、`上证50`、`北证50`、`深证100` 内置目录兜底，腾讯搜索返回 NONE 也能加进自选；指数行情、日线下载、指标与九转与个股一致。
- **神奇九转 · 多项指标**：一节里同时显示九转计数与多空汇总（`多 4 / 空 2`）及买卖提示；K 线蜡烛上下数字为九转计数（绿=下跌结构，红=上涨结构）；每日 13:00 按最新价预演当日收盘，多项指标共振时在提醒中心留痕并弹通知。
- **自选股排序**：鼠标按住行左侧 ⠿（或行任意位置）上下拖动即可调整顺序，松手立即保存；拖到某行上半区落在它前面、下半区落在它后面。
- **指标分析**：点股票名称选中；显示根数 60/120/250/全部（默认 120 根，图表一次取最近 1600 根）；K 线 + MA5/20/60 + 成交量 SVG 图，**Ctrl+滚轮缩放、按住拖动平移、双击复位**，表头另有 － / ＋ / 重置 按钮和「x–y / n 根」提示；9 个信号卡（均线位置、均线排列、MACD、KDJ、RSI6、布林带、量能、20/60 日涨跌）；最近 12 个交易日指标表；导出 CSV、重算指标。
- **股票数据库**：库文件路径、体积、自选数、日线行数、区间、每只行数与起止、最近同步日志、打开数据目录。

### 后端

独立 bundle `@local/dsh-workbench-stock`（宿主侧），常驻 Python worker + SQLite：

| 数据源 | 实现 | 备注 |
|---|---|---|
| AKShare | `stock_zh_a_hist_em` 优先，失败退回 **分窗腾讯**（`_fetch_tencent`，按约 2 年切窗拼接，6 年完整；akshare 自带的 tx 接口单次只有 800 根）；指数用 `index_zh_hist_em` | 本机东财 push2 被限流时自动走腾讯接口 |
| Tushare | 宿主调用 tushareMcp 的 `daily` / `index_daily`，行数据交给 worker 入库 | 不需要 Python token |
| Baostock | `query_history_k_data_plus(adjustflag=2)` | 单只约 10 秒 |
| efinance | `get_quote_history(fqt=1)` | 东财接口被限时会报错，按只记录 |
| 腾讯 | `web.ifzq.gtimg.cn` 前复权日线（urllib），单次 800 根上限，按约 2 年分窗拼接 | 免依赖，6 年约 1450 根 |

库：`<工作台目录>\股票数据\stock.db`（WAL），表 `watchlist` / `daily` / `indicators` / `sync_log` / `jobs`。日线覆盖式写入，指标每次按全部历史重算。

接口在 `/api/workbench/stock/`：`status`、`db`、`watchlist`、`sync`、`job`、`job/cancel`、`analysis`、`klines`、`export`、`recompute`、`quotes`、`open-dir`。

### 为什么单独一个 bundle

工作台的宿主 `index.js` 改一行也要重启 DSH 才生效；而「新装一个 bundle」会在当前进程里直接激活（`application: applied`）。所以股票后端单独成包，股票页前端仍在工作台 `client.js` 里（浏览器侧改完刷新即生效）。旧 `/api/workbench/quotes` 的解析只有 10 个字段，缺市盈率/成交量/成交额/换手率，新 bundle 的 `/quotes` 补齐，前端优先用它。

### 验证（无头站桩 + 真后端）

`tools/uiharness/run-stock.mjs`：Playwright 载入工作台页面，桩宿主把 `/api/workbench/stock/*` 直接转给真插件（真 Python worker、真行情、真腾讯行情），用本地种子自选表跑：

- 表头 20 列与截图一致；4 行数据，贵州茅台一行：`1435.26 / +24.99 / +1.77% / … / 21.84 / 4.18万手 / 59.55亿 / 0.33% / 1500.000 / 150,000 / 100 / 143,526 / -4.32% / -6474.00 / 16:14:55`。
- 下载 4 只 × 近 6 年（AKShare）= 5,816 行；样本 1454 根；缩放验证：默认 120 根（1335–1454）→ ＋ 84 根 → － 118 根 → 滚轮 94 根 → 重置 120 根；显示范围 60 / 全部 / 250 根分别渲染 120 / 2908 / 500 个图元。
- 指标分析：726 根样本，9 个信号卡，240 个 SVG 图元（120 蜡烛 + 120 量柱），指标表 12 行。
- 持仓弹窗改五粮液为 500 股，行内总成本/盈亏即时变化。
- 宽屏 1680 / 窄屏 1280 / 深色主题截图 `tools/uiharness/S1…S7-*.png`。

### 生效

- 前端 `client.js`：刷新页面（或重开侧边栏页面）即生效。
- 后端 bundle 已安装并 active（`~/.dsh/workbench-stock-applied.json` 的 `rev` 与 12 条路由可核对）；改后端代码后 `remove_bundle` + `install_bundle` 换一代模块，改 `stock_worker.py` 则下次请求自动重启 worker 即可。


## 神奇九转（TD Sequential）与 13:00 买卖提醒（2026-11-15）

### 算法

- **下跌结构（买入）**：连续 9 个交易日 `收盘价 < 4 天前收盘价`；第 9 天完成 → 买入提示。
- **上涨结构（卖出）**：连续 9 个交易日 `收盘价 > 4 天前收盘价`；第 9 天完成 → 卖出提示。
- 完成一次后计数冻结在 9，直到条件被反向或持平打断才归零；信号只在「8→9」那一次触发，不会天天重复。
- 每日 13:00 检查时，用腾讯实时价作为「当日临时收盘」追加一根（日期取行情自带日期，周末/节假日不会凭空多一根），据此预演当日收盘后的全部指标。

### 页面

- 「神奇九转 · 多项指标」表格：代码、名称、九转（下跌 n/9）、多空（多 X / 空 Y）、最新价、日期（盘中带「盘中」标签）、买卖提示（买入/卖出/观望）。
- K 线蜡烛上下标注 1~9：绿字在下方=下跌结构，红字在上方=上涨结构；9 只在完成当天显示。
- 指标分析顶部 KPI 增加「九转」一项（如「下跌结构 4/9」）。

### 13:00 多项指标提醒

- 每日 13:00（中午 1 点）页面打开时自动检查一次；页面没开着则在当天之后首次打开时补检查一次。
- 只在交易日提示：用行情时间判断今天是否有交易（周末/节假日不提示，也不会把上一交易日的价格当今天）。
- 统计 10 项：神奇九转、MA20、均线排列、MACD、KDJ、RSI6、布林带、量能、20 日涨跌、60 日涨跌。
- **看多 ≥3 项且至少比看空多 2 项 → 买入提示**；**看空 ≥3 项且至少比看多多 2 项 → 卖出提示**；否则观望。
- 提示写入提醒中心（标题如 `潍柴重机 · 多项指标偏多（买入提示）`，正文列出命中的指标名与现价）并弹浏览器通知；同一天同一只不会重复。
- 提醒设置里「每日 13:00 神奇九转买卖提示」默认开；原「价格到点提醒（买卖点/止损/涨跌幅）」改为可选、默认关（旧数据首次加载会自动关闭一次，可在页面重新勾选）。
- 限制：浏览器通知需要页面处于打开状态；关掉页面时不会后台推送，但当天再打开会补一条提醒。

### 接口

- `GET /api/workbench/stock/nine-turn?codes=sz000880,sh600519` → `{ ok, today, tradingDay, quotes, items:[{code,name,date,close,provisional,buyCount,sellCount,signal,label,signals,bullCount,bearCount,score,buy,sell}] }`
- 指标分析 `GET /analysis` 的返回新增 `nineTurn` 汇总和每根 K 线的 `buyCount / sellCount / buySignal / sellSignal`；`signals` 里也包含「神奇九转」一项（共 10 项）。

---

## rev36 · 知识库问答接上模型 + 按 llm-wiki 编译知识库 + Word 优先

本轮围绕三件事：**问答终于能调模型（还能选模型）**、**知识库改成 llm-wiki 的编译层结构**、
**构建时报告/说明有 Word 版就不再解析对应 PDF**。

> 宿主半侧（`index.js` / `library.js` / `scanner.js` / `kbqa.js`）改完**必须重启 DSH** 才生效；
> `client.js` 刷新工作台页面即可。`REV` 与 `dsh-workbench-host/index.js` 的 `?rev=` 都已到 `rev37`。

### 1. 「没连上模型」的原因与修法

旧代码 `kbqa.ask()` 只认 `agentDefaultModel.currentSelection()`，取不到就直接判「没有可用的默认模型」，
`/lib/ask` 随即退回纯检索摘要——界面上就是那句「没连上模型，先按检索结果给你原始片段」。

而插件里其实早有一套能用的解析顺序（`resolveModel()`：默认模型 → `llm.listProviders()` 第一个可用模型），
只是问答这条路没接上。现在：

- `/lib/ask` 取模型的顺序：**请求里带的 provider/model（问答面板选的）→ `resolveModel()`**；
- `kbqa.ask(ctx, q, items, { selection, llm })` 用调用方解好的模型，不再自己猜；
- 失败时把原因写回 `error` 与 `diag`（如「插件作用域里取不到 llm 服务（llm=无，默认模型=未设置，可用提供方=空，可见服务=llm-…）」），
  界面在答案下面直接显示，不再只有一句「模型不可用」。

### 2. 问答可以选模型

- 新接口 `GET /api/workbench/lib/models`（和 `/company/models` 同一份实现，改成共用 `listModelChoices()`）。
- 问答面板「用模型总结」旁边多了一个下拉：provider / model 两级展平，选择存 `localStorage['wb.kbModel']`，
  每次提问随请求带 `provider` / `model`；留空则用宿主默认模型。宿主没重启（新接口 404）时自动退回 `/company/models`。

### 3. 知识库改成 llm-wiki 结构

```
D:\\天源评估\\已归档\\_wiki\\
├─ WIKI-SCHEMA.md          约定的三层结构、页面格式、交叉引用规则、工作流
├─ _work\topic-*.md        主题证据摘要（编译输入，可删）
└─ wiki\
   ├─ index.md             目录（主题 + 按年份的项目清单）
   ├─ log.md               操作日志（只追加）
   ├─ projects\339 页      每个项目一页：关键摘录 + 文档地图 + 出处
   ├─ years\6 页           年度页
   └─ topics\11 页         商誉减值 / 收益法 / 市场法 / 资产基础法 / 无形资产与土地 /
                           矿业权 / 设备与房屋 / 长投与股权 / 报告结构 / 复核体系 / 归档规范
```

- `build_wiki.py`：从 `_知识库\kb_index.jsonl` 生成项目页/年度页/目录/主题骨架，纯脚本、可反复重跑；
  项目页的「关键摘录」按 `评估结论 / 评估方法 / 评估目的 / 基准日 / 价值类型` 等关键词从正文里切片，能直接引用。
- `topic_digest.py`：给每个主题收集 16 条库内证据（正文命中、每项目最多 2 条），供 LLM 编译主题页正文。
- 主题页是**LLM 编译**的：脚本只建骨架、不覆盖已有文件，重扫不会把人工/LLM 写的正文冲掉。
- 页面命名带 5 位哈希：同一受理号下会挂多个子项目（1000060659 天信仪表 / 易联云 / 湖北震新），
  只用「年份_受理号」会让 86 个页面互相覆盖。

### 4. 问答先读编译层，再回原文

`kbqa.retrieve()` 先跑 `wikiRetrieve()`：受理号精确命中 > 项目名整体命中 > 项目名前缀（≥6 字）>
主题名整词命中 > 字片段覆盖，命中就把 wiki 页面排在最前（标「知识库页面·编译层」），
原文片段跟在后面当证据。喂给模型时统一编号成 `【资料N】`，所以引用格式没变。
出处表里 wiki 行带「知识库页」标签，可以直接点「打开」。

### 5. Word 优先（构建期规则）

`scan_kb.py` 新增 `word_priority_shadow()`，只看文件名 + 大小，不读正文，所以扫描阶段就能跳过：

- **报告/说明有 Word 版 → 以 Word 版为准，PDF 不再解析**（记录保留、标 `shadow: pdf-word`，浏览页还看得到这个 PDF）；
- **没有 Word 版 → 才解析 PDF**（扫描件该 OCR 照样 OCR）；
- 「04 装订版报告」里与电子底稿**同名同大小**的副本 → 标 `shadow: bound-copy`，不重复入库。

配对规则：去掉类别词/版本号/括号内容/「扫描件·定稿·签章版」这类尾巴，再按「双字片段包含度 ≥ 0.8」
判定是同一份文档，且**类别必须一致**（报告不会被说明顶掉）。本轮实测：9863 个文件里 455 个被顶替
（79 个 PDF 有 Word 版、376 个装订版副本）；PDF 记录 `text=false`，检索时由 `library.search()` 跳过。
Word 版被删掉时，下次扫描会把原来被顶的 PDF 自动放回抽取队列（`revived`）。

**文件名对不上的补齐（`content_word_shadow()`，第二遍）**：电子稿常叫「杭州蔬菜、果品、水产市场价值咨询【定稿】.docx」，
而 03 里的打印件叫「天源咨报字〔2025〕第20238号 …房地产价值分析报告.pdf」，名字一个字都对不上，
第一遍必然漏。第二遍看内容：

- **文号相同**：文号只从**封面区**（文件名 + 正文前 240 字）取——审计报告、长投附件正文里也会提到评估报告文号；
- **正文重合 ≥ 0.6**：PDF 的 5 字片段有多大比例出现在 Word 稿里（扫描件 OCR 文本错字多，阈值不能太高）；
- 两条都要求**同类**：报告↔报告、说明↔说明。同一项目的报告和说明共用一个文号，只看文号会
  把「有说明 Word 版」错当「报告也有 Word 版」，把唯一的报告 PDF 压掉；
- 文号命中、但 PDF 自己有 3000 字以上正文的，再验一次重合（≥ 0.15）：审计报告提到评估文号不算同一份。

本轮累计：**794 个文件被顶替**——418 个 PDF 有 Word 版（79 文件名对得上 + 339 文号/正文判出）、
376 个装订版副本；有全文 6017 → 5834。典型例子：勾庄项目里
`…房地产价值分析报告.pdf` 被 `杭州蔬菜、果品、水产市场价值咨询【定稿】.docx` 顶掉（文号 2025-20238、重合 0.29），
而同一目录下的 `咨询业务委托合同.pdf` 没有 Word 版，照常解析。

扫描接口新增 `wordFirst`（默认 true，传 `false` 关掉）；`/lib/scan` 的进度事件多两条 `dedupe` / `dedupe-content`，
状态里多一个 `S.dedupe = { shadowed, pdfWord, boundCopy, contentShadowed, totalShadowed }`。

### 6. 本轮踩到的坑（免得下轮重犯）

- `word_priority_shadow()` 一开始拿**绝对路径**去算文件名，目录名里的字被算进「文档名」，
  79 个配对膨胀成 252 个 —— 一律用 `os.path.basename()`。
- `build_wiki.py` 第一版用「年份_受理号」当 slug，339 个项目只落盘 253 个页（86 个被覆盖）。
- `topic_digest.py` 第一版把 `_知识库` 本身当 texts 目录，读不到正文，摘要里全是文件名，5 秒跑完（正常要 6 秒）。
- wiki 页面不在 `kb_index.jsonl` 里，`lib.docText()` 读不到 → `/lib/wiki/page` 直接 `readFile`。

## 「同步到线上」变成真同步（rev38）

表单页右上「同步到线上」弹窗里新增 **「同步到天源（自动填表）」**：宿主 spawn `ego-browser`，
在固定 task space `workbench-sync` 里把四组页签填进天源网页表单，保存后自动回读校验。
引擎在 `tysync.js`，宿主路由 `POST /api/workbench/ty/sync`（`{ project }` → `{ ok, applied, mismatches, online }`）。

### 为什么是浏览器而不是接口
天源 OpenAPI 只开放「读项目 + 写参与人员/公司负责人」，新建项目与基本信息/客户/被评估单位/合同的写入
只在网页表单里。DSH 侧栏（`sidebarRight`）只有 `openTab`，没有脚本注入能力，所以走 ego 的 nodejs 模式
（`ego-browser nodejs`，可用 `cdp()` + `ego.helpers`）。

### 五条硬约束（全部来自真实失败）
1. **保存接口 `/api/projects/update` 永远返回 HTTP 200**，成败只看响应体 `code`；前端对 `code=500`
   不弹任何提示。所以引擎靠「保存 → 重新加载 → 回读比对」判定，不看界面。
2. **el-input 只发 `input` 不进 payload**，必须补 `change` + `blur`。
3. **下拉/日期/级联用 JS `.click()` 常常只改显示不改模型**，要用真实鼠标
   （`Input.dispatchMouseEvent` 的 moved → pressed → released 三段）。
4. **级联（价值类型、评估对象-报备）点节点无效**，要点节点内 `input.el-radio__original`。
5. **天源有同名不同人**（实测两个同名账号：离职的排前面、`employee=null`，在职的有工号）。
   下拉文本完全一样、DOM 上没有任何区分字段，只能取**最后一个**；选错会让整单回滚。

### 使用前提
- 首次要**在 `workbench-sync` 那个 ego 窗口里登录一次天源**（扫码/滑块）。ego 的 task space
  之间 cookie 是隔离的：agent 空间登录过，不代表这个空间登录了。未登录时路由返回
  `code: 'NOT_LOGGED_IN'`，窗口会停在登录页。
- **改宿主代码（index.js / tysync.js）要重启 DSH**；客户端只改 client.js 刷新页面即可。
- 排障：`GET /api/workbench/ty/sync/probe` 返回宿主解析到的 ego-browser 路径与 space 名；
  独立跑引擎不经 DSH：`node tools/uiharness/test-tysync.mjs 啦啦啦`。

### 修订（rev39）：登录态检查 + 不依赖保存跳转

两个实测问题：

1. **同步窗口没登录 → 整个功能看起来"失效"**。ego 的 task space 之间 cookie 隔离：
   在你自己窗口或别的 space 登录过天源，`workbench-sync` 这个 space 仍然是未登录；
   而且 ego 浏览器重启后该登录态会丢。现在弹窗一打开就调 `GET /api/workbench/ty/sync/login`
   （复用/打开 workbench-sync 并顺带回报 `loggedIn`），顶部显示「同步窗口：已登录 / 未登录」，
   旁边有「打开登录窗口」按钮；点同步前若仍未登录会直接提示，不再跑一遍再失败。
2. **点「保存」后页面不一定会跳转**（实测有停留在原页的情况）。原实现把"跳转"当成功判据，
   会误报「保存后仍停在新建页」。现在改成：点保存 → 等 3 秒 → 新建走「回列表按项目简称找」、
   更新走「重开编辑页」，然后**逐字段回读比对**，完全不看 URL 变化。

排障顺序：`/ty/sync/probe`（ego 路径）→ `/ty/sync/login`（登录态）→ `/ty/sync`（同步结果 mismatches）。

## 保存不跳回列表：表单里显示保存状态，点「返回」才回（rev40）

需求原话：「点击保存后显示保存状态，但不返回，点击返回才返回。」

### 行为变更
- **「保存」= 只落库**：写完数据、建好「编号 简称」文件夹，界面停在表单上，标题条右侧出现状态徽标：
  - `○ 尚未保存` —— 新建表单还没存过；
  - `✓ 已保存 16:23:45` —— 存上了（后续再改会自动变回下面那条）；
  - `● 有改动未保存` —— 相对上次保存改过东西。
- **「返回」是唯一回列表的出口**：没有未保存改动时直接回；有改动时先弹确认
  （`继续编辑` / `不保存，返回` / `保存并返回`），不再让改动无声丢掉。
- **标题会从「新建项目」变「编辑项目」**：第一次保存成功后父层 `setEditing(rec)`，表单拿到 id，
  之后再点保存是更新同一条（id 不变），不会重复建项目；模板目录只在「新建表单的第一次保存」时建
  （`onSave(rec, { isNewForm })`），重复保存不会重复建目录。

### 怎么判断「改没改」
`recordSig()` 把 `buildRecord()` 的结果压成字符串再比，**剔掉 `updatedAt`**（每次保存都变）。
比时间戳可靠：改一个字算改、改回原样就不算。打开已有项目时以「刚打开的内容」为基准，
所以一进编辑页不会莫名其妙提示有改动。

### 顺手修掉的旧 bug：提示条被前一条的定时器清掉
`toast()` 原来是 `setTimeout(() => setToastMsg(null), 3200)`，不复用句柄。两条提示挨得近时，
**前一条的定时器会把后一条提前清掉** —— 保存后连着操作就能撞上（实测弹了 200ms 就没了）。
现在用 `useRef` 存定时器，新提示先 `clearTimeout` 旧的。

### 验证
- 新增 `tools/uiharness/run-save-inplace.mjs`（先起 `server.mjs`）：12 项断言全过 ——
  保存后仍在表单、标题变「编辑项目」、徽标是「已保存 HH:MM:SS」、改一个字变「有改动未保存」、
  点返回先弹确认且三个按钮齐、继续编辑不离开、保存并返回回列表且新项目排第一行、落库名称是改后的、
  重开编辑页没有徽标、不保存返回不改数据、无 console/pageerror。截图 `S1-saved-inline.png`、`S2-dirty.png`、`S3-leave-ask.png`。
- 按新语义更新并跑通：`run-projects-form-v2.mjs`（新增「保存后停在表单并显示保存状态」一项，其余断言不变）、
  `run-projects-save.mjs`（保存后先断言还在表单，再点返回）、`run-contract-parse.mjs`（返回前处理确认弹窗）。
- 只改 `client.js`，刷新工作台页面即生效。

### rev40：填表驱动换成 agent-browser-cli（bridge），ego 兜底

**为什么换**：ego 的 task space 之间 cookie 隔离，同步窗口必须单独登录一次，且 ego 重启后登录态丢失。
agent-browser-cli 驱动的是用户真实 Edge（扩展 + CDP），直接用已有天源登录态，**ego/DSH 重启都不用重新扫码**。

**怎么做的（关键设计）**：`SYNC_SCRIPT` 里只用一个原语 `cdp(method, params)`，
驱动由第三/四参注入：

```js
SYNC_SCRIPT(DATA, cdp, setup, pace)
// ego   ：cdp = ego-browser nodejs 的全局 cdp；setup 切到 workbench-sync；pace=1
// bridge：cdp = agent-browser-cli exec {"cmd":"cdp",...}；pace=2（每次调用要起进程，动画等更久）
```

字段逻辑（按 label 定位、select/date/cascader/人员处理、保存后回读）**一份代码两个驱动**。

**Windows 上的坑**：直接 `spawn('cmd.exe', ['/c','agent-browser-cli','exec',json])` 会把 JSON 里的引号吃掉
（报「文件名、目录名或卷标语法不正确」）。改成用 node 直接跑 npm 包的 JS 入口
`%APPDATA%\npm\node_modules\@sleepinsummer\agent-browser-cli\npm\bin\agent-browser-cli.js`，参数由 Node 转义。

**实测（啦啦啦 → 线上 20261116011）**：326 次 CDP 调用、164 秒、`ok:true`，唯一提示是
「参与人员：线上没有经理A（离职/禁用账号，天源静默丢弃）」——这是数据问题，不是驱动问题。

**其它改动**
- 每次开 select 前先发 Esc 关掉残留下拉（bridge 慢，会读到上一个没关的下拉，报「选项里没有…」）
- 人员类字段只缺一部分时降级为 warning，不判整次失败
- 新建成功后把线上 `id` 回填到本地项目的 `tyId`（下次同步走更新，不再建重复项目）
- `/ty/sync` 支持 `engine: auto|bridge|ego`，auto = bridge 优先、不可用才退回 ego
- `/ty/sync/login` 先报 bridge 就绪状态，`?ego=1` 才拉起 ego 窗口

**运维**：`agent-browser-cli restart` 拉 daemon；Edge 里至少开着一个普通网页（扩展只上报 http/https 页）。

**rev40 补丁：bridge 冷启动**
daemon 是按需拉起的，刚被杀/空闲退出后 `tabs` 会卡在「等扩展连接」（实测能挂 2 分钟）。
现在 `bridgeTabs()` 的策略：短超时(8s)试一次 → 不行就 `agent-browser-cli restart` → 再按扩展 ~24s 保活闹钟每 3s 重试，预算 45s。
实测冷启动恢复 33s；daemon 活着时仍是 1s 级。

### rev41：同步默认走 ego（lite）浏览器

**为什么改**：rev40 默认拿 agent-browser-cli 驱动 Edge，要求 Edge 开着、扩展连着、daemon 活着，链路长且冷启动慢；ego（lite）本身就是给 agent 用的浏览器，`workbench-sync` 一个窗口就能完成「登录 → 填表 → 回读」。

**改法**：
- `POST /api/workbench/ty/sync` 的 `engine` 默认值从 `auto`（bridge 优先）改成 **`ego`**；仍保留 `bridge` / `auto`（ego 未登录或起不来才退回 bridge）。
- `GET /api/workbench/ty/sync/login` 改成 **ego 优先**：先 `openSyncSpace()` 看 `workbench-sync` 的天源登录态，未登录再看 bridge；返回里 `ego` 字段带 url/msg。
- 弹窗文案同步改成「调用 ego (lite) 浏览器…ego 未登录或起不来时退回 Edge」。
- `REV` → `rev41`，`dsh-workbench-host/index.js` 的 `?rev=41`。

**顺手修掉的两个真 bug（都是 update 路径才会撞上的）**：
1. **页签等待**：编辑页是 SPA，`gotoAndWait` 只等到 `readyState=complete`，页面骨架到了但 `.el-radio-button__inner` 还没渲染，`goTab` 直接报「找不到页签：基本信息」（实测 2 秒就失败）。现在 `goTab` 找不到页签时先 `waitTabs(25s)` 轮询「基本信息」出现再点。
2. **只读字段**：编辑页有 `disabled` 的输入（不同页面/权限下「项目编号」「项目简称」等），往 disabled 的 input 里写等于没写，硬写会让整单在第 1 个字段就失败。现在 `fieldDisabled()` 命中就跳过、记 note，回读校验也跳过该字段。
3. **占位符护栏**：`报告文号` 是「天源评报字〔2026〕第XXXX号」时不再写入线上（会把真实文号盖成假号），改为 warning。

**排障经验（本轮实测）**：
- 本地项目记着的 `tyId` 可能在线上已被删除：编辑页会请求 `/projects/<id>/contexts` 得到 **404**，所有字段变灰、`disabled=25/25`，引擎报「找不到页签」或「写入不生效」。先打开 `/project/my` 列表核对编号，本地 `tyId` 失效就清掉走新建。
- 天源登录态会过期：`/project/my` 被重定向到 `auth.zhrdc.net/login` 即失效，需要在该窗口重新登录一次（扫码/账号密码 + 滑块）。

**生效**：宿主侧（`index.js`/`tysync.js`）改动**要重启 DSH**；客户端文案改动刷新页面即可。

### rev42：同步后回写「线上自动生成」的项目编号 / 项目受理号

**规则**（按业务口径）：
- **项目编号**：新建时由天源自动生成（年月日+流水），本地手填的不算数 → 同步成功后**本地改成线上版本**。
- **项目受理号**：填了 **EBS 项目** 之后由天源系统带出，本地这份只能是上一轮回读的 → **从线上回读后写回本地**。

**改动**：
1. `buildData` 不再把「项目受理号」当可写字段推给浏览器（原来会尝试把本地值写进线上，属于反向污染）。项目编号本来就只在新建时自动生成，从不写。
2. 引擎在保存后、进到编辑页时**回读两个只读字段**：`readValue('项目编号')` / `readValue('项目受理号')`，放进 `out.online.code` / `out.online.acceptNo`（新建分支原有列表行里的编号会被编辑页的值覆盖，编辑页更权威）。
3. `client.js` 的 `doSync` 在 `d.ok` 时统一回写本地项目：`tyId`、`code`、`acceptNo`（本地旧值一律让位给线上值），并把这些值同步进当前表单状态，toast 显示「已回写本地：编号 … · 受理号 …」。
4. 同步结果面板显示「线上项目编号 · 受理号」。

**注意**：
- 新建时如果没填 EBS 项目，受理号线上也是空，本地就保持原值（不会被清空）。
- 本地项目文件夹名（`编号 简称`）**不会**因为编号回写而自动改名；需要的话同步后在「项目文件夹」里重新生成。

**生效**：`index.js`/`tysync.js` 改动要重启 DSH；`client.js` 刷新页面即可。

### rev43：财务类/基础类资料改成「每家公司一套」，科目名称母公司不填

**业务口径（用户口径）**
- **基础类资料、财务类资料：每家公司一套**，分类在前、公司在后 —— `00财务资料/<公司>`、`02基础类/<公司>/<分类>`（跟 `03资产基础法/<公司>/<科目>` 写法一致）。
- **管理类资料：一个项目一套，不动** —— 仍然 `01管理类`、`04底稿/管理类底稿/<分类>`。
- **科目名称：母公司不填**。这一列表示「上级母公司用哪个科目持有这家公司」，只有子公司有值；母公司（顶层、没有上级母公司）显示 `—`。

**改动**
1. `folders.js`：`planProjectFolders` 里每家公司除了原来的 `02基础类/<公司>`，再补 `00财务资料/<公司>` 与 `02基础类/<公司>/{公司基础资料,财务资料,评估申报与核实资料,行业与宏观分析资料}`；新增导出 `BASIC_CATEGORIES`（与 `client.js` 的 `BASIC_CATALOG` 分类一一对应，改一边要同步另一边）。
2. `client.js`：
   - `catalogFolder(kind, cat, company)`：管理类仍是 `04底稿/管理类底稿/<cat>`；基础类改成 `02现场资料/企业提供资料/02基础类/<公司>/<cat>`（原来是项目级的 `04底稿/基础类资料/<cat>`）。
   - 新增 `financeFolderOf(company)` → `02现场资料/企业提供资料/00财务资料/<公司>`；「财务资料」页签底部的按钮从「打开财务资料文件夹」改成跟着当前公司走的「打开「<公司简称>」财务资料文件夹」，旁边常显该公司的相对目录。
   - **基础类资料页签改成按公司分块**：一家一块（`编码 + 公司名 + 打开这家公司的文件夹`），块里是这家公司自己的 21 项；管理类页签保持原来的单张清单 20 项。
   - `eqSeed` 的种子行 `subject` 从 `长期股权投资` 改成空；新增 `eqSubjectOf(r, byId)`——`parentId` 空 / 指向自己 / 父节点不在列表里时一律当母公司，科目名称返回空。列表、CSV 导出、批量导入预览、`导入` 落库、`添加子公司` 落库都走这条判定，所以老数据里母公司的 `长期股权投资` 也不会再显示/导出。
   - 「项目文件」页签里的按钮改成 `财务资料（按公司）`=`00财务资料`、`基础类资料（按公司）`=`02基础类`（点进去是分类根，再往下就是各家）。
3. `index.js` 的 `REV` 与 `dsh-workbench-host/index.js` 的 `?rev=` 同步到 `rev43`。**`folders.js` 在宿主侧，要重启 DSH 才生效**；`client.js` 刷新页面即可。

**老项目**
- 已有的 `00财务资料` 还是项目级空目录，`02基础类/<公司>` 已经存在但没有分类子目录；到「股权信息」点一次 **生成项目文件夹** 就补齐（幂等，只建缺的）。
- 老项目里如果之前点过基础类资料的「打开文件夹」，会留下一个项目级的 `04底稿/基础类资料/…`；新规则不再往那里放东西，需要的话手动删掉即可（插件不会自动删）。

**验证（rev43）**
- `node --check`：`client.js` / `index.js` / `folders.js` / `dsh-workbench-host/index.js` 全部通过。
- `tools/wb-test-folders.mjs`（改成断言式）：3 家公司 → 56 个相对目录；`00财务资料/<公司>` 一家一个、`02基础类/<公司>/<4 个分类>` 一家 5 个、`01管理类` 仍只有 1 个且不含公司名、没有 `04底稿/基础类资料`、`存货=0` 不建目录、`12固定资产/03车辆` 存在。`FOLDERS OK`。
- `tools/wb-test-build.mjs`：真实落盘首轮 `created 63`、二轮 `created 0 / existed 63`（幂等）。
- `tools/uiharness/run-rev43-shots.mjs`（先起 `tools/uiharness/server.mjs` 8799，Playwright 跑真实 `client.js`）：母公司行科目名称 `—`、两家子公司分别是 `长期股权投资` / `其他非流动资产-股权投资`；基础类资料 3 家公司各一块、每块 21 行、4 个分类；点第二家公司的「财务资料」落盘到 `…/02基础类/<公司全称>/财务资料`、点块头落到 `…/02基础类/<公司全称>`；财务资料页签切公司后按钮/目录跟着换（`00财务资料/<公司全称>`）；管理类底稿仍是 0 个公司块、20 行；`pageerror` 为空。`UI CHECK OK`；截图 `REV43-1-equity.png`–`REV43-4-mgmt.png`。
- 顺手补了 `tools/uiharness/server.mjs` 的 `/project/folder` 桩：以前忽略 `sub`，现在跟宿主一样按 `sub` 建子目录并回带完整 `path`，否则这条路径根本测不出来。

### rev44：财务资料 / 基础类资料 按钮挪到股权信息每行的「操作」里

**口径**：这两套资料是「每家公司一套」，所以入口跟着公司行走 —— 股权信息表每行「操作」现在是 `设方法 · 财务资料 · 基础类资料 · 删除`。

- `财务资料` → 打开该行公司的 `02现场资料/企业提供资料/00财务资料/<公司>`
- `基础类资料` → 打开该行公司的 `02现场资料/企业提供资料/02基础类/<公司>`（进去再按 4 个分类）
- 按钮 `title` 就是它要打开的相对目录，鼠标悬停能看到，避免点了才发现不对。
- 母公司那一行同样有这两个按钮（母公司也有它自己的那套目录）；科目名称仍然按 rev43 只给子公司显示。

改动只在 `client.js`：新增 `basicFolderOf(company)`；`EquityPanel` 增加 `openSub` 参数（`ProjectWorkspace` 里传进来）；工具栏提示补一句说明行内两个按钮。**刷新工作台页面即可**，不需要重启 DSH（`REV` 不用动，宿主没改）。

**验证**
- `node --check client.js` 通过。
> 注：rev45 起这两个按钮改成「进入这家公司的界面」（不再是直接开文件夹），对应的 `run-rev44-row-actions.mjs` 已删除，改由 `run-rev45-company-views.mjs` 覆盖。
- `tools/uiharness/run-rev44-narrow.mjs`（1280 宽 + 真实工作台数据）：表格 `scrollWidth == clientWidth`（没被挤到横向滚动），「基础类资料」按钮完整在视口内 → `NARROW OK`。截图 `REV44-2-narrow-1280.png`。

### rev45：删掉上方「财务资料 / 基础类资料」页签，改从每家公司进

**口径**：这两套是「每家公司一套」，做成项目级页签会把「同一份清单套在所有公司上」。所以页签撤掉，入口只留股权信息每行的按钮。

- `作业信息` 现在只有两个页签：**股权信息 / 管理类底稿**。（管理类仍是项目级，一个项目一套，不动。）
- 股权信息每行「操作」：`设方法 · 财务资料 · 基础类资料 · 删除`。点后两者进入**这家公司的独立界面**（`CompanyMaterials`）：
  - 页头一行：`← 返回股权信息` · `编码 公司名` · `财务类资料 / 基础类资料（这家公司那一套）` · 右侧 `打开文件夹`；下面一行 `目录：…` 就是它对应的相对路径。
  - 点「财务资料」→ `FinancePanel`（公司已锁定：不再有公司下拉，只显示这一家；科目/金额、导入科目余额表、清空、生成项目文件夹都在，底部重复的「打开…文件夹」在单公司视图里不显示）。
  - 点「基础类资料」→ `CatalogPanel` 只出这一家的 21 项（4 个分类），不再罗列其他公司。
- 点上方任一页签会把单公司视图收掉（`setCo(null)`）。

改动都在 `client.js`：`WORK_SUBS` 去掉 `fin`/`basic`；新增 `CompanyMaterials` 组件与 `co` 状态；`FinancePanel` 加 `lockId`（锁定公司）、`CatalogPanel` 加 `onlyId`（只看一家）；`EquityPanel` 加 `onOpenCo`；新增 `.pw-co-bar / .pw-co-dir` 样式。**刷新工作台页面即可**，不用重启 DSH。

**验证**
- `node --check client.js` 通过。
- `tools/uiharness/run-rev45-company-views.mjs` → `COMPANY VIEW OK`：页签只剩 `股权信息 / 管理类底稿`（`财务资料`、`基础类资料` 都没了）；点第 2 行「财务资料」→ 有 `← 返回股权信息`、标题 `1-1 <公司全称>`、**没有公司下拉**、`目录：02现场资料/企业提供资料/00财务资料/<公司全称>`、看到该公司的 1 条科目（应收账款）、页头 1 个「打开文件夹」；返回后仍在「股权信息」且有 2 行；点「基础类资料」→ 21 行、4 个分类、0 个 `.pw-co-block`、目录指向 `02基础类/<公司全称>`；再点「管理类底稿」页签 → 单公司视图让位、20 行、无「返回」按钮；`pageerror` 为空。截图 `REV45-1-company-fin.png`、`REV45-2-company-basic.png`、`REV45-3-mgmt-tab.png`。
- `tools/uiharness/run-rev43-shots.mjs` 精简成只验「科目名称母公司不填」→ `SUBJECT OK`；`run-rev44-narrow.mjs` 仍 `NARROW OK`（1280 宽、真实数据、4 个行内按钮不挤压表格）。rev44 里「点了直接打开文件夹」的断言随本次改动删除（`run-rev44-row-actions.mjs` 已删）。

### rev46：管理类底稿生成到 03评估底稿 下（不再单独一个 04底稿）

**口径**：管理类底稿是项目级底稿，跟 一级复核 / 二级复核 / 三级复核 / 送签发 并列，落在 **`03评估底稿/管理类底稿/<分类>`**。6 个分类：程序文件 / 合同与依据文件 / 技术文件 / 沟通记录类文件 / 审核与交付文件 / 定稿成果文件。

- `folders.js`：新增 `MGMT_CATEGORIES`、`MGMT_FOLDER = '03评估底稿/管理类底稿'`；`planProjectFolders` 在固定骨架之后把这个目录 + 6 个分类一并 push（所以 **「生成项目文件夹」会真的把这套建出来**，以前只在点「打开文件夹」时才懒建，而且建在 `04底稿`）。
- `client.js`：`catalogFolder('mgmt', …)` 改成 `MGMT_FOLDER + '/' + 分类`；管理类底稿页签的提示文案跟着改；「项目文件」页签的「管理类底稿」按钮指向 `03评估底稿/管理类底稿`；「报表模板」页签原来借道 `catalogFolder('mgmt','报表模板')`，现在独立成 `03评估底稿/报表模板`（提示文案同步）。
- 旧项目里项目根目录下那个 `04底稿/管理类底稿/…` 不再产生；本机 `<项目编号> <项目名>` 下那个**空的** `04底稿` 已经手工删掉（没有文件，删前确认过 `find -type f` 为 0）。
- `index.js` 的 `REV` 与 `dsh-workbench-host/index.js` 的 `?rev=` 同步到 `rev44`。**`folders.js` 在宿主侧，要重启 DSH 才生效**；`client.js` 刷新页面即可。

**验证**
- `node --check`：`folders.js` / `client.js` / `index.js` / `dsh-workbench-host/index.js` 通过。
- `tools/wb-test-folders.mjs`：新增 `mgmtFolderOk`（`03评估底稿/管理类底稿` + 6 个分类齐全，且该前缀下只有这 6 个）、`noLegacyMgmt`（整份 plan 里没有 `04底稿` 开头）→ `FOLDERS OK`，total 63。
- `tools/wb-test-build.mjs`：落盘后 `03评估底稿/管理类底稿/程序文件` 真的存在、项目根下没有 `04底稿` → `BUILD OK`（首轮 created 70、二轮 0/70 幂等）。
- `tools/uiharness/run-rev46-mgmt-location.mjs` → `MGMT IN 03 OK`：管理类底稿页签 20 项、第一项分类「程序文件」，点「打开文件夹」落到 `…\03评估底稿\管理类底稿\程序文件`；点「生成项目文件夹」toast「新建 30 个目录（已存在 2）」，磁盘上 `03评估底稿/管理类底稿/{程序文件,合同与依据文件,技术文件,沟通记录类文件,审核与交付文件,定稿成果文件}` 全部建出、项目根下没有 `04底稿`；「项目文件 → 管理类底稿」落到 `…\03评估底稿\管理类底稿`；「报表模板」落到 `…\03评估底稿\报表模板`；`pageerror` 为空。截图 `REV46-1-mgmt-tab.png`。
- 顺带修了 `tools/uiharness/server.mjs` 一个桩缺陷：`/project/folders/build` 被 `/project/folder` 的 `startsWith` 吞掉（真宿主是精确匹配，不受影响），已加排除条件并补了 `folders/build` 的真实桩，UI 里「生成项目文件夹」现在能在测试环境真建目录。

### rev43：级联选二级科目 + 同步窗口被接管后的处理

**问题 1：级联选不到「股东全部权益价值」**
`评估对象-报备` 是两级级联：`股东全部权益价值` 挂在 **企业价值** 下面，不展开父节点，DOM 里根本不存在这个节点 —— 旧版 `pickCascader` 只扫当前已渲染的节点，于是报
`级联里没有「股东全部权益价值」：no-node 企业价值/单项资产/资产组合/无形资产/…`。

**修法**（`pickCascader`）：
1. 先按显示文本（`.el-cascader-node__label`）在已展开的节点里找；找不到再展开父级：
2. 取第一列所有节点坐标，**先逐个悬停**（`expandTrigger=hover` 时不改变选中就能展开子列）；
3. 悬停都不出来（`expandTrigger=click`）再点**带箭头（`.el-cascader-node__postfix` / `.el-icon-arrow-right`）的父节点**，避免误点叶子；
4. 每展开一个父节点就重新扫一遍，命中后点它的 `input.el-radio__original`。
另外选完之后输入框显示的是「企业价值 / 股东全部权益价值」，所以「已选过」的判断改成**包含匹配**，否则每次同步都会重选。

**问题 2：`workbench-sync` 窗口被你点过之后，ego 判成「人工窗口」**
ego 的规则是：task space 被用户操作过就归用户，agent 不能自己接管——
`useOrCreateTaskSpace("workbench-sync")` 会报 `A task space named "workbench-sync" already exists and belongs to the user`，
于是下次同步直接失败。

**修法**（显式授权，不偷偷接管）：
- `buildScript(data, { claim })` 的 setup 先 `listTaskSpaces()`：agent 窗口直接用；用户窗口且 `claim=true` 才 `claimTaskSpace(id)`；否则抛 `SPACE_OWNED:<id>`。
- 引擎把 `SPACE_OWNED` 转成 `{ code: 'SPACE_OWNED', spaceId, msg }`。
- `/ty/sync` 接受 `{ claimSpace: true }` 透传给引擎。
- 弹窗在 `SPACE_OWNED` 时多一个按钮 **「接管同步窗口并重试」**——点它才是授权，重跑即接管并继续填表。
- `/ty/sync/login` 的 `openSyncSpace()` 遇到用户窗口不再强行接管，直接回报 `owned: "user"`（提示可在同步时授权接管）。

**注意**：接管后引擎会重新走「新建项目 → 填表」，你窗口里那份没保存的表单会被放弃（本地数据会重新填一遍）。

**生效**：`index.js`/`tysync.js` 要重启 DSH；`client.js` 刷新页面即可。

## 工作台助手：浮动对话窗（rev49，2026-11-20）

工作台顶部第四个模块「助手」+ 全页签可用的浮动对话窗。之前尝试复用 better-sidebar 的侧边对话，但工作台是 `main` 插槽里的主面板条目，激活时右侧栏没有 session seat，侧栏对话打不开；改成页面内自绘浮层，不依赖 sidebarRight。

### 功能

- **浮动对话窗**：右下角浮层，按住标题栏拖到任意位置（双击标题栏回到右下角），位置、放大/还原状态记住；「放大」切换 860px 宽屏。
- **模型选择**：下拉列出宿主全部 provider/model，选择存 localStorage；选「默认模型」时由后端 `resolveModel` 决定。
- **对话记录持久化**：写入 `localStorage`（最多 60 条、单条 4000 字符），关窗/切页签/刷新都不丢，恢复的记录还能延续多轮上下文；标题栏「清空」按钮（需确认）。
- **天源只读工具循环**：模型可调用 4 个白名单只读 MCP 工具（`get_my_projects` / `get_project_companies` / `get_project_summary` / `get_company_asset_based_approach_summary`）直接查天源数据；写操作类工具一律拒绝。最多 4 跳，单个工具结果压缩截断到 12000 字符。
- **确定性命令**（不消耗模型额度）：`/项目 [关键词]`、`/状态`、`/导出`。
- **多轮历史修复**：历史 assistant 消息带 `source: {kind:'model'}`，修复 pi-ai 适配器（如 zai-coding-cn）读 `source.replayState` 时 `Cannot read properties of undefined` 崩溃。

### 实现

- 后端 `index.js`：`runAssistantChat` SSE 流式（`text/event-stream`）+ 有界工具循环（`tool-call-delta` 累积 + `block-end` 兜底，`tool_result` 紧跟 `tool_use` 回填）；`ASSISTANT_TOOLS` 白名单；`compactTyToolResult` 对大结果瘦身。
- 前端 `client.js`：`AssistantDock` 浮层（拖动/放大/模型选择/持久化）、`AssistantPanel` 状态卡与说明。

**生效**：`index.js` 要重启 DSH（REV 标记）；`client.js` 刷新页面。

## 财务资料：报表显示期数（2026-11-23）

天源「参数设置」里的 **报表显示期数**（1-6 期）现在在本地财务资料页也生效，两边的金额列口径一致。

- **列怎么排**：资产负债表 / 利润表都是一年一列，**最左一期＝评估基准日所在年度的 12-31**，往右依次往前推一年，列数＝报表显示期数。例：基准日 2025-12-31、**默认 4 期（3 年 1 期）** → `2025-12-31 / 2024-12-31 / 2023-12-31 / 2022-12-31`；选到 6 期就再往前推到 2020-12-31。
- **哪来的数**：审定报表的「资 / 利」本身只有两期（期末/期初或本期/上期），分别落在**第 1 列（基准日年度）**和**第 2 列（上一年度）**，更早的列没有数就显示 `—`。实际写入天源时仍按被导入那一年的年度 sheet 走（`reportYear`），期数列只是展示口径。
- **改期数**：第一行「报表显示期数」下拉（1-6 期，**默认 4 期＝基准日年度 + 往前 3 年**），改完立即重排；期数存在 `finance[pid].companies[cid].periods`。
- **基准日**：取项目「基本信息」里的评估基准日；没填时退回用报表表头里的年度，并在期数旁边提示「先填评估基准日」。
- **数据从哪来**：`finance_statement.py` 的 statements 模式除了 `rows` 还输出 `rowsByKind`（`{now, prev}`），前端换期数时不需要重新解析文件；解析时如果带了 `--periods / --basedate`，会在返回里回显 `periodsOption / baseDateOption`。
- **回归**：`tools/uiharness/run-finance-periods.mjs`（默认 4 期表头、导入后货币资金落 2025 列且 2024 列有期初数、改 3 期后表头变 3 列、利润表同步变 3 期）。

## 面板空白自诊断（2026-11-23）

真机（DSH 桌面版）里「个人工作台」偶尔整块空白，而本地无头回归（真实 client.js + 真实数据）始终正常，说明问题在桌面运行时的加载/注册环节，需要现场证据。插件内置一份轻量自诊断，**正常使用没有任何界面变化**：

- **注册结果**：`apply()` 每次执行都把结果写进 `localStorage['dsh-workbench:diag']` 的 `apply` 字段：`{version, inject, slots, locale, betterSidebar, main:'ok'|'ERR …', sidebar:'ok'|'ERR …'}`。看到这条记录就能判断「插件是否被加载、主区面板是否注册成功」。
- **渲染错误**：面板内部抛错由错误边界接住，页面显示「面板渲染出错」+ 原始堆栈（而不是一片空白），同时写进 diag 的 `renderError`。
- **未捕获异常**：`window.onerror` / `unhandledrejection` 的首条原因写进 diag 的 `windowError` / `rejection`。
- **DOM 标记**：同一份 JSON 挂在 `document.body[data-wb-diag]`（截断 1200 字符），方便截图。

取证步骤（面板空白时）：

1. 工作台窗口按 `Ctrl+Shift+I` 打开开发者工具 → Console。
2. 输入 `localStorage['dsh-workbench:diag']` 回车，把输出发出来。
3. 顺带看一眼 `document.body.getAttribute('data-wb-diag')`。

判读：

| diag 内容 | 含义 | 处置 |
| --- | --- | --- |
| 完全没有这个键 | client 半未被加载（boot 清单没有它 / bundle 404 / id 与包名不一致） | 查 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 insert 段与 `node_modules/@local` 软链；核对 `client.js` 第 2 行 id＝`package.json` 的 name |
| `apply.main:'ERR …'` | 槽位注册抛错 | 按错误文案定位（多为 DSH 升级后 slots API 变化） |
| `main:'ok'` 但页面空白 | 面板已注册，问题在渲染或选中 | 看 `renderError` / `windowError` |
| `betterSidebar:false` | 右侧栏精简页签没挂上（不影响主区面板） | 确认 `dsh-better-sidebar` 已启用 |

**生效**：`client.js` 刷新页面即可；`index.js` 的 REV 现在是 `rev56`（改了宿主代码要重启 DSH）。

