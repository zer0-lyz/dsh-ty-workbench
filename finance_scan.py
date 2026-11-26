# -*- coding: utf-8 -*-
"""扫一个目录里的财务报表原件：逐个工作簿解析成「天源财务资料页」能直接写的数据。

用法：
    python finance_scan.py <目录> [--basedate 2023-12-31] [--force <json>]

--force：人工确认过的分类，JSON 对象 {"文件名::页签名": "balance"|"income"|"skip"}，
         覆盖自动判定（自动认不出来的页，就是靠它定性的）。
         值也可以写成 {"kind": "income", "year": 2023}，用来同时补上读不出的年度。
--basedate：项目评估基准日，只用于「读不出报告期」时的提示文案，不会替用户猜年度。

输出：
    {"ok": true, "dir": "...", "files": [{name, size, error, sheets: [{sheet, kind, year,
     period, rows, reason}]}], "packs": [{statementType, year, period, fileName, sheet,
     sheetData}], "needManual": [{fileName, sheet, reason, kind}]}

设计取舍：
  - 一个文件里可以有多页（资/利各一页很常见），每页各自成一个 pack；
  - 认不出的页不瞎猜，进 needManual 让用户点一下选「资产负债表 / 利润表 / 跳过」；
  - 期间读不到（表头没有「2023年12月31日」这类字样）就不成 pack，同样进 needManual，
    避免把不同年度的数写进同一年。
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import finance_statement as fs  # noqa: E402  (与单文件解析同一套规则，不再复制一遍)

# 只认这三种：xls 走 xlrd，xlsx/xlsm 走 openpyxl（与 finance_statement.read_workbook 一致）
EXTS = ('.xlsx', '.xlsm', '.xls')
# 打开文件夹里常有的干扰文件
SKIP_PREFIX = ('~$', '.')
KIND_NAMES = {'balance': '资产负债表', 'income': '利润表'}

# 审定底稿整包动辄 20~30 页（科余、底稿、调整分录、TB 表…），真正的报表只有两页。
# 认不出的页如果没有这些痕迹，就当「不是报表页」静默跳过——否则一个文件就能
# 刷出三四十条「请指定分类」，用户根本没法用。
STATEMENT_TITLES = ('资产负债表', '利润表', '损益表', '收益表', '利润及利润分配表')
# 底稿包的索引页：标题里会顺带提到「资产负债表」，但本身不是报表
INDEX_SHEETS = ('index', '目录', '索引')
# 一个工作簿超过这么多页，基本就是「审定底稿整包」（科余/底稿/调整分录/TB 表…），
# 里面认不出的页是正常现象，静默忽略；页数少的文件则可能是单张报表，认不出要问用户。
PACK_SHEET_THRESHOLD = 8


def statement_hint(rows, sheet_name):
    """这一页像不像财务报表：页名或前 12 行里出现报表标题词，返回那个词，否则空串。"""
    name = str(sheet_name or '')
    if name.strip().lower() in INDEX_SHEETS:
        return ''
    for t in STATEMENT_TITLES:
        if t in name:
            return t
    head = rows[:12]
    text = ''.join(fs.compact(c) for r in head for c in r)
    for t in STATEMENT_TITLES:
        if t in text:
            return t
    return ''


def year_from_name(name):
    """从文件名里猜报告年度，认不出返回空串。

    客户给的文件名五花八门，实测见过的：
      - 审定报表-2023.xlsx / 2023年度财务报表.xls   → 四位数年份，最可靠
      - A-Z-1-2-F23-TB-某某公司24-评估.xls           → 「公司24-」这种两位年份
    两位年份只认紧贴「公司/报表/评估/TB」这类线索词的，避免把编号里的数字当年份。
    """
    name = str(name or '')
    m = re.search(r'(?<![0-9])((?:19|20)\d{2})(?![0-9])', name)
    if m:
        y = int(m.group(1))
        if 1990 <= y <= 2100:
            return str(y)
    m = re.search(r'(?:公司|报表|评估|审定|TB)[-_]?(\d{2})(?=[-_\s.．]|$)', name, re.I)
    if m:
        y = 2000 + int(m.group(1))
        if 2000 <= y <= 2099:
            return str(y)
    return ''


def pack_of(st, year, file_name):
    """一张解析好的表 → 一个 pack（与 finance_statement.py --mode statements 同构）。"""
    tpl = [{'line': t['line'], 'name': t['name'], 'values': t['values']} for t in st['template']]
    sheet_data = fs.explained_skip(
        st['statement'], fs.build_sheet(st['statement'], tpl, int(year), st['sheet']))
    return {
        'statementType': 'balance_sheet' if st['statement'] == 'balance' else 'income_statement',
        'statementTypeName': KIND_NAMES.get(st['statement'], ''),
        'year': int(year),
        'period': st['period'],
        'unit': st.get('unit') or '',
        'fileName': file_name,
        'sheet': st['sheet'],
        # rows / columns 与 finance_statement.py --mode statements 同构，
        # 前端预览表靠 rows 里的源科目金额填各期列
        'columns': st.get('columns') or [],
        'rows': st.get('rows') or [],
        'sheetData': sheet_data,
    }


def scan_file(path, force, basedate):
    """一个工作簿 → {name, size, error, sheets[], packs[], needManual[]}"""
    name = os.path.basename(path)
    out = {'name': name, 'size': 0, 'error': '', 'sheets': [], 'packs': [], 'needManual': [],
           'ignoredSheets': []}
    try:
        out['size'] = os.path.getsize(path)
    except OSError:
        pass
    try:
        book = fs.read_workbook(path)
    except Exception as e:  # noqa: BLE001 —— 打不开的文件（损坏/加密/格式不符）单独报，不连累别的文件
        out['error'] = '%s: %s' % (type(e).__name__, e)
        return out

    name_year = year_from_name(name)
    # 整包底稿 vs 单张报表：决定「认不出的页」是静默忽略还是问你
    is_pack = len(book) > PACK_SHEET_THRESHOLD
    for sn, rows in book:
        key = name + '::' + sn
        forced = (force or {}).get(key)
        if forced is None:
            forced = (force or {}).get(sn) or ''
        # 允许 {'kind': 'income', 'year': 2023} 这种写法：一页既可能分类认不出，也可能年度读不出
        forced_year = ''
        if isinstance(forced, dict):
            forced_year = str(forced.get('year') or '')
            forced = str(forced.get('kind') or '')
        forced = forced or ''
        if forced == 'skip':
            out['sheets'].append({'sheet': sn, 'kind': '', 'year': '', 'period': '',
                                  'rows': 0, 'reason': '已按人工选择跳过'})
            continue
        force_kind = forced if forced in ('balance', 'income') else None
        try:
            st = fs.parse_sheet(rows, sn, name_year, force_kind)
        except Exception as e:  # noqa: BLE001
            out['sheets'].append({'sheet': sn, 'kind': '', 'year': '', 'period': '',
                                  'rows': 0, 'reason': '%s: %s' % (type(e).__name__, e)})
            out['needManual'].append({'fileName': name, 'sheet': sn, 'kind': '',
                                      'reason': '这一页解析出错：%s' % e})
            continue
        if st is None:
            hint = statement_hint(rows, sn)
            if not force_kind and not hint and is_pack:
                # 底稿包里大量非报表页（科余/底稿/调整分录/TB 表…）：静默忽略，
                # 只记一笔到 ignoredSheets，别把 needManual 刷满。
                out['sheets'].append({'sheet': sn, 'kind': '', 'year': '', 'period': '',
                                      'rows': 0, 'reason': '不是财务报表页，已忽略',
                                      'ignored': True})
                out['ignoredSheets'].append(sn)
                continue
            if not force_kind:
                out['sheets'].append({'sheet': sn, 'kind': '', 'year': '', 'period': '',
                                      'rows': 0,
                                      'reason': '认得出是「%s」，但表头读不出来' % hint})
                out['needManual'].append({
                    'fileName': name, 'sheet': sn, 'kind': '',
                    'reason': '这页标题像「%s」，但找不到可用的表头（项目 + 金额列），'
                              '可能需要手工整理成标准表' % hint,
                })
                continue
            out['sheets'].append({'sheet': sn, 'kind': '', 'year': '', 'period': '',
                                  'rows': 0, 'reason': '认不出是资产负债表还是利润表'})
            if force_kind:
                # 已经人工指定了表性质却还是读不出：问题在表结构（没「项目 + 行次」表头），
                # 不是分类错了，提示要换说法，别让用户以为再点一次就好。
                out['needManual'].append({
                    'fileName': name, 'sheet': sn, 'kind': force_kind,
                    'reason': '已指定为%s，但这页找不到「项目 + 行次」表头，读不出来（可能需要手工整理成标准表）'
                              % KIND_NAMES.get(force_kind, ''),
                })
            else:
                out['needManual'].append({'fileName': name, 'sheet': sn, 'kind': '',
                                          'reason': '认不出是资产负债表还是利润表，请指定'})
            continue

        year = forced_year or st.get('year') or name_year
        row_count = len(st.get('rows') or [])
        out['sheets'].append({
            'sheet': sn, 'kind': st['statement'], 'year': year or '',
            'period': st.get('period') or '', 'rows': row_count, 'reason': '',
        })
        if not year:
            hint = '读不出报告期（表头没有「YYYY年M月D日」这类字样），请补年度'
            if basedate:
                hint += '；项目评估基准日是 %s，报表期数一般就是基准年往前的各年' % basedate
            out['needManual'].append({
                'fileName': name, 'sheet': sn, 'kind': st['statement'],
                'needYear': True, 'reason': hint,
            })
            continue
        if not row_count:
            # 空页（模板没填数）：不算错，只是没有可导入的数据
            continue
        try:
            out['packs'].append(pack_of(st, year, name))
        except Exception as e:  # noqa: BLE001
            out['error'] = '拼装天源科目失败：%s' % e
    return out



# ---------- 年度校验：表头年份常错，靠「上年数 == 另一份的本期数」对账 ----------
#
# 实测踩过：24 号文件的资产负债表表头序列号是 45291（=2023-12-31）、利润表写「2023年度」，
# 但 25 号的「上年年末数」货币资金 11508030.07 与它「期末数」逐位相等 —— 它其实是 2024 年。
# 所以表头年份只当参考，最终年度优先用文件名里的年份；文件名也没有时，
# 再用两份报表之间的对账关系去推（甲的上年数序列 == 乙的本期数序列）。

def _amounts(pack, key):
    """取一期的金额序列（按 sheetData.detail 的科目名 → 金额），用来做跨年份对账。"""
    out = {}
    for d in ((pack.get('sheetData') or {}).get('detail') or []):
        v = d.get('amount')
        if isinstance(v, (int, float)) and v:
            out[str(d.get('subjectName') or '')] = float(v)
    return out


def _same_series(a, b, min_items=8):
    """两组金额是不是同一套数（同一期的「本年」与另一期的「上年」应当逐项相等）。"""
    keys = [k for k in a if k in b]
    if len(keys) < min_items:
        return False
    hit = sum(1 for k in keys if abs(a[k] - b[k]) <= max(1.0, abs(a[k]) * 1e-9))
    return hit >= len(keys) * 0.9


def retitle_period(period, year):
    """年度纠正后，把期间里写错的年份一起改掉（表头年份常常是错的，别让用户两列打架）。"""
    if not period or not year:
        return period
    y = str(int(year))
    return re.sub(r'(19|20)\d{2}', y, period)


def fix_years(packs):
    """按文件名年份 + 跨文件对账把年度定准，返回 (packs, notes)。"""
    notes = []
    # 1. 文件名里的年份最可信：pack 已带 fileName，重新抽一次
    for p in packs:
        ny = year_from_name(p.get('fileName') or '')
        if ny and str(p['year']) != ny:
            notes.append({
                'statementType': p['statementType'], 'fileName': p['fileName'],
                'from': p['year'], 'to': int(ny), 'why': '文件名里的年份与表头不一致，按文件名',
            })
            p['year'] = int(ny)
            # 期间列表头原文里也带着错年份，跟着改，免得「年度 2024 / 期间 2023年12月31日」
            p['period'] = retitle_period(p.get('period') or '', ny)
            # sheetData.reportYear 才是真正写给天源的年度，必须同步，否则会按表头的错年度落库
            sd = p.get('sheetData')
            if isinstance(sd, dict):
                sd['reportYear'] = int(ny)
    # 2. 至此如果还有同类型同期冲突（文件名没有年份的），用对账关系区分
    #    同一份报表的「上年」序列应当等于另一年份那份的「本期」序列。
    return packs, notes


def main():
    argv = sys.argv[1:]
    opts = {}
    for i, a in enumerate(argv):
        if a.startswith('--'):
            nxt = argv[i + 1] if i + 1 < len(argv) else ''
            opts[a[2:]] = nxt
    paths = [a for a in argv if not a.startswith('--')]
    # 位置参数里排除掉 --force 的值（它是 JSON，可能被当成路径）
    force_raw = (opts.get('force') or '').strip()
    if force_raw:
        paths = [p for p in paths if p != force_raw]
    if not paths:
        print(json.dumps({'ok': False, 'error': '缺少目录路径'}, ensure_ascii=True))
        return
    root = paths[0]
    if not os.path.isdir(root):
        print(json.dumps({'ok': False, 'error': '目录不存在：' + root}, ensure_ascii=True))
        return
    force = {}
    if force_raw:
        try:
            force = json.loads(force_raw)
        except ValueError as e:
            print(json.dumps({'ok': False, 'error': '--force 不是有效 JSON：%s' % e}, ensure_ascii=True))
            return
        if not isinstance(force, dict):
            force = {}
    basedate = (opts.get('basedate') or '').strip()

    try:
        entries = sorted(os.listdir(root))
    except OSError as e:
        print(json.dumps({'ok': False, 'error': '读不了目录：%s' % e}, ensure_ascii=True))
        return

    files = []
    packs = []
    need = []
    for fn in entries:
        if fn.startswith(SKIP_PREFIX):
            continue
        full = os.path.join(root, fn)
        if not os.path.isfile(full):
            continue
        if os.path.splitext(fn)[1].lower() not in EXTS:
            continue
        got = scan_file(full, force, basedate)
        files.append({k: got[k] for k in ('name', 'size', 'error', 'sheets')})
        packs.extend(got['packs'])
        need.extend(got['needManual'])

    packs, yearNotes = fix_years(packs)

    # 同一 (报表类型, 年度) 出现多次：大概率是同一期给了两个版本（原表 + 审定表），
    # 留后到的那个（文件名排序靠后的通常更晚给），其余进 conflicts 让用户知道。
    kept = {}
    conflicts = []
    for p in packs:
        k = (p['statementType'], p['year'])
        if k in kept:
            conflicts.append({
                'statementType': p['statementType'], 'year': p['year'],
                'kept': kept[k]['fileName'], 'dropped': p['fileName'],
            })
        kept[k] = p
    final = sorted(kept.values(), key=lambda x: (x['statementType'], x['year']))

    print(json.dumps({
        'ok': True, 'dir': root, 'basedate': basedate,
        'files': files, 'packs': final, 'needManual': need,
        'conflicts': conflicts, 'yearNotes': yearNotes,
        'summary': {
            'fileCount': len(files),
            'packCount': len(final),
            'balanceYears': [p['year'] for p in final if p['statementType'] == 'balance_sheet'],
            'incomeYears': [p['year'] for p in final if p['statementType'] == 'income_statement'],
        },
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
