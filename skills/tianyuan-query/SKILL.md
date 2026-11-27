---
name: tianyuan-query
description: |
  查询天源评估系统数据：项目列表、评估结论、公司评估方法汇总表、导出明细表/申报表。
  触发条件：用户说"查评估结论 / 查天源项目 / 查某被评估单位的评估值 / 导明细表 / 导申报表 / 批量导入财报 / 导入资产底稿"。
  优先用本 skill 的标准操作顺序，3 次工具调用内完成查询，不要去 OneDrive 目录翻文件、不要手写 MCP 握手脚本。
---

# 天源评估系统查询

## 标准操作顺序（3 步内出结论）

1. **拿 tyId**：调 `workbench_ty_projects`，可传 `keyword`（项目名/编号模糊匹配）。
   - 返回 `[{tyId, projectCode, projectName, department, status, baseDate}]`。
   - 用户给的公司简称通常会出现在 projectName 里，用 keyword 过滤即可。
2. **拿评估结论**：调 `workbench_ty_project_summary`，传 `tyId`。
   - 返回每家公司 `companyName / valuationValue / valueAdded / finalMethod / refreshed`。
   - 数值单位是**元**，逐字引用原始值，禁止四舍五入或换算成万元。
3. **需要科目级明细时**：调 `workbench_ty_company_summary`，传 `tyId`（可选 `companyId`、`method`：asset/income/market，默认 asset）。

## 降级路径（工作台工具不可用时）

用以下 Python 脚本直连 valuation-mcp。token 从 `~/.dsh/workbench-tianyuan.json` 的 `token` 字段读取，**任何输出严禁包含 token 与 mcp-session-id**。

> 优先级说明：装了本插件（dsh-workbench）时，工作台工具 `workbench_ty_projects / workbench_ty_project_summary / workbench_ty_company_summary` 已经完成 MCP 握手与 session 管理，**直接用它们，不要跑下面的脚本**。脚本只在这些工具不可用（插件未装、MCP 探活失败）时作为降级路径。

```python
import json, re, pathlib

TOKEN = json.loads(pathlib.Path.home().joinpath(".dsh/workbench-tianyuan.json").read_text())["token"]
URL = "https://mcp.zhrdc.net/valuation-mcp"

import urllib.request

def post(payload, session_id=None):
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    req = urllib.request.Request(URL, data=json.dumps(payload).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        sid = resp.headers.get("mcp-session-id")
        text = resp.read().decode()
    # 容错解析：通知类请求（payload 无 "id"）返回空 body 或 202，不解析直接返回 None；
    # SSE 取 data: 行，无 data: 行再试整体 JSON，都失败返回 None（不要抛 JSONDecodeError）
    if "id" not in payload:
        return None, sid
    m = re.search(r"data: (.*)", text)
    for raw in ([m.group(1)] if m else []) + ([text] if text.strip() else []):
        try:
            return json.loads(raw), sid
        except (json.JSONDecodeError, ValueError):
            continue
    return None, sid

# 1) initialize 握手，取 mcp-session-id
_, sid = post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
               "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                          "clientInfo": {"name": "tianyuan-query", "version": "1.0"}}})
# 2) notifications/initialized
post({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
# 3) tools/call（示例：get_my_projects）
result, _ = post({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                  "params": {"name": "get_my_projects", "arguments": {}}}, sid)
# 注意：result 可能为 None（空响应容错），用前判空；get_my_projects 直接返回数组，无包装
if result and "result" in result:
    inner = json.loads(result["result"]["content"][0]["text"])
    if isinstance(inner, list):
        for p in inner:
            print(p.get("id"), p.get("projectCode"), p.get("projectName"))
```

常用远端工具（tools/list 共 30+ 个，入参均为 `projectId` 数字型）：
- `get_my_projects`：全部项目（id/projectCode/projectName/…）
- `get_project_summary`：项目汇总表（rows + summary.rootValuationValue）
- `get_project_companies`：项目公司清单（拿 companyId）
- `get_company_asset_based_approach_summary` / `get_company_income_approach_summary` / `get_company_market_approach_summary`：各方法公司汇总表
- `get_asset_based_approach_draft_data`：资产基础法底稿明细（需 companyId + 科目名称）
- `get_project_file_list`：项目文件列表

session 失效（code -32001 / "no valid session"）时重新 initialize 即可。

## tycpv 导出命令（明细表/申报表落 Excel）

```bash
tycpv export-asset-detail-table  -p <projectId> [-c <companyIds逗号分隔>] -o <outDir>   # 明细表（恢复公式+打印格式）
tycpv export-asset-declare-table -p <projectId> [-c <companyIds>] -o <outDir>          # 申报表
tycpv export-asset-summary-table -p <projectId> [-c <companyIds>] -o <outDir>          # 公司汇总表
tycpv export-income-summary-table -p <projectId> [-c <companyIds>] -o <outDir>         # 收益法汇总表
```

- `tycpv` 命令行已登录时直接用；返回 `Unauthorized: invalid token` 时先运行 `tycpv login` 刷新授权。
- 不确定公司范围时不要传 `-c`，会导出该项目全部公司。
- 不确定公司编号与简称的对应关系时，先核对 `get_project_companies`，再导出。
- 成功后回读文件：确认存在、大小非零、工作表数量合理。

## 财报/底稿批量导入：对话执行（需 DSH ≥ 2026-11-27 版插件）

用户说"把 XX 公司 01财务报表 的报表导入天源 / 批量导入财报 / 导入资产底稿"时，走以下流程，**不要让用户去界面手点**：

1. **扫描本地报表**：调 `workbench_finance_folder_scan`，传 `folder`（工作台项目文件夹名）+ `company`（00财务资料 下的公司文件夹名），可选 `basedate`。返回可直接喂 prepare 的 sheetList 数据包；认不出的页用 `force` 指定分类（balance/income/skip）。
2. **预检（prepare，不写数据）**：调 `workbench_financial_import_prepare`（财报）或 `workbench_draft_import_prepare`（底稿），传 tyId + companyId(s) + sheetList/subjects。**必须把返回的预览（公司/年度/科目数/跳过行/覆盖清单）展示给用户**。
3. **用户明确确认后**（回复"确认/执行"），才调 `workbench_financial_import_execute` 或 `workbench_draft_import_execute`，传 confirmationToken + confirmed:true。禁止跳过第 2 步展示、禁止对同一 token 自动重试、禁止用户未确认就连续执行。
4. 查已有报表数据用 `workbench_financial_reports_get`（只读）；改报表参数（口径/类型/期数）用 `workbench_financial_config_save`，同样要先说明要改什么再执行。

工具不可用时（旧版插件），如实说明只能走界面"从 01财务报表 批量导入"，不要手写 MCP 调用绕行。

## 数据纪律（硬约束）

1. 聚合值（评估价值/增减值/持股比例等）**逐字引用**，禁止 AI 自行重算、四舍五入或换算单位。
2. `refreshed=false` 时必须注明"系统汇总未刷新，非最新底稿口径"。
3. 数值单位是**元**，不是万元。
4. 工具返回 0 条表述"未发现公开记录"，不得断言"一定没有"；调用失败必须说明失败原因，不得用推测数据补全。
5. 任何输出不含 token、mcp-session-id、Authorization 头内容。

## 验收基准（通用自验方法）

具体的数值基准因项目而异，不写死在本技能里。回归自验按以下口径：

1. 用 `workbench_ty_projects(keyword=<项目简称>)` 拿 tyId，确认 projectName / projectCode 与用户所指项目一致。
2. 用 `workbench_ty_project_summary(tyId)` 取各公司 valuationValue / valueAdded / finalMethod / refreshed。
3. 与用户上次认可的结论（或项目档案里的评估结论）逐字比对，单位是元；不一致时先核对基准日与 refreshed 口径再下结论，不得擅自改判。

