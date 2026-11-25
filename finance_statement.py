#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""财务报表（资 / 利）解析：按「中汇报表-国资委（交投）」的资、利两张表结构读数。

用法：
  python finance_statement.py <file>                    # 自动判断
  python finance_statement.py <file> --year 2025        # 指定年度
  python finance_statement.py <file> --sheet 资 --year 2025   # 只读某张表

只输出一行 JSON：
  {"ok": true, "file": "...", "statements": [{"statement":"balance","sheet":"资","year":2025,"unit":"...",
     "period":"2025年12月31日","columns":[{"label":"期末余额","kind":"now"},{"label":"期初余额","kind":"prev"}],
     "rows":[{"line":2,"name":"货币资金","side":"asset","level":1,"kind":"item","values":[1102.15,1413.4]}]}]}
  {"ok": false, "error": "..."}

设计取舍（为什么不猜）：
  * 只认「行次 + 数值」的表，行次是会计上的栏目号，靠它判断哪些行是真科目、哪些行是小计/标题；
  * 资产负债表的左右两组各自是独立的报表，右边（负债/权益）行次从 70 起，合并时按行次去重；
  * 金额一律保留原始精度（不用 Excel 显示值），由前端决定怎么展示；
  * 利润表的「上期金额」= 本年累计 - 上年同期一个季末累计（Q4 直接相减），读不到就对不上，宁可留空也不瞎填。
"""
import json
import os
import re
import sys

# ---------- 小工具 ----------

def norm(v):
    if v is None:
        return ''
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, int):
        return str(v)
    return str(v).strip()


def compact(v):
    return re.sub(r'\s+', '', norm(v))


_NUM_RE = re.compile(r'^[-+]?[\d,]+(\.\d+)?$')


def parse_amount(v):
    if v is None:
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    t = norm(v)
    if not t:
        return None
    if t in ('——', '—', '--', '-', '/', '＊', '*'):
        return None
    neg = False
    if t.startswith('(') and t.endswith(')'):
        neg = True
        t = t[1:-1]
    t = t.replace(',', '').replace('，', '').replace('￥', '').replace('¥', '').replace('元', '').strip()
    if not _NUM_RE.match(t):
        return None
    try:
        n = float(t)
    except ValueError:
        return None
    return -n if neg else n


def as_line(v):
    """行次：只认 1/2/3 这种纯数字，认不出返回 None。"""
    t = compact(v)
    if not t:
        return None
    if re.match(r'^\d{1,3}$', t):
        return int(t)
    return None


# ---------- 表头识别 ----------

HEAD_MARK = ['项目', '行次']
NOW_KEYS = ['期末余额', '期末数', '期末金额', '本期金额', '本期数', '本年累计', '本年累计数', '累计金额']
PREV_KEYS = ['期初余额', '期初数', '上期金额', '上期数', '上年同期', '上年累计', '年初余额']
SKIP_KEYS = ['对应试算科目', '科目', '编码', '校验', '备注', '说明']


def is_head(cells):
    joined = ''.join(compact(c) for c in cells)
    return ('项目' in joined) and ('行次' in joined)


def find_header(rows, limit=25):
    for ri, cells in enumerate(rows[:limit]):
        if not is_head(cells):
            continue
        cols = [compact(c) for c in cells]
        groups = []
        name_col = None
        for ci, c in enumerate(cols):
            if c == '项目':
                name_col = ci
                break
        if name_col is None:
            continue
        ci = name_col + 1
        # 行次列必须紧跟项目列
        if ci >= len(cols) or '行次' not in cols[ci]:
            continue
        line_col = ci
        amt_cols = []
        for cj in range(line_col + 1, len(cols)):
            c = cols[cj]
            if not c:
                continue
            if c == '项目':
                break
            if any(k in c for k in SKIP_KEYS):
                continue
            if '校验' in c:
                break
            kind = None
            for k in NOW_KEYS:
                if k in c:
                    kind = 'now'
                    break
            if kind is None:
                for k in PREV_KEYS:
                    if k in c:
                        kind = 'prev'
                        break
            if kind is not None:
                amt_cols.append({'col': cj, 'label': c, 'kind': kind})
        if not amt_cols:
            continue
        groups.append({'name': name_col, 'line': line_col, 'amounts': amt_cols})
        # 右边还有一组（资产负债表左右并排）：后面再找一个「项目」列
        for cj in range(line_col + 1, len(cols)):
            if cols[cj] != '项目':
                continue
            lc = None
            for ck in range(cj + 1, min(cj + 3, len(cols))):
                if '行次' in cols[ck]:
                    lc = ck
                    break
            if lc is None:
                continue
            amts = []
            for ck in range(lc + 1, len(cols)):
                c = cols[ck]
                if not c:
                    continue
                if c == '项目':
                    break
                if any(k in c for k in SKIP_KEYS):
                    continue
                if '校验' in c:
                    break
                kind = None
                for k in NOW_KEYS:
                    if k in c:
                        kind = 'now'
                        break
                if kind is None:
                    for k in PREV_KEYS:
                        if k in c:
                            kind = 'prev'
                            break
                if kind is not None:
                    amts.append({'col': ck, 'label': c, 'kind': kind})
            if amts:
                groups.append({'name': cj, 'line': lc, 'amounts': amts})
                break
        return {'row': ri, 'groups': groups}
    return None


# ---------- 单元格文本清理 ----------

LEVEL_MARKS = ['△', '☆']


def clean_name(raw):
    t = norm(raw)
    t = t.replace('　', ' ').strip()
    # 合并报表专用、金融企业专用、外商投资专用、未执行新准则专用之类的标记
    for m in LEVEL_MARKS + ['*', '#']:
        t = t.replace(m, '')
    t = re.sub(r'\s+', ' ', t).strip()
    t = t.replace('（', '(').replace('）', ')')
    return t


def level_of(name):
    if re.match(r'^[一二三四五六七八九十]+、', name):
        return 0
    if re.match(r'^\(\s*[一二三四五六七八九十]+\s*\)', name) or name.startswith('其中：'):
        return 2
    if re.match(r'^\d+\.', name) or name.startswith('加：') or name.startswith('减：') or name.startswith('其中:'):
        return 2
    return 1


def kind_of(name):
    flat = name.replace(' ', '')
    if flat.endswith('：') and len(flat) <= 12:
        return 'title'
    if re.match(r'^\(\s*[一二三四五六七八九十]+\s*\)', flat):
        return 'title'
    if flat.startswith('加：') or flat.startswith('减：'):
        return 'item'
    if '：' in flat and len(flat.split('：')[0]) <= 12:
        return 'item'
    if '合计' in flat or '总计' in flat:
        return 'total'
    return 'item'

# ---------- 报表区块解析 ----------

def head_item(name):
    return clean_name(name) == '项目'


def parse_block(rows, head, group, side, skip=()):
    out = []
    for ri in range(head['row'] + 1, len(rows)):
        cells = rows[ri]
        if group['name'] >= len(cells) or group['line'] >= len(cells):
            continue
        name = clean_name(cells[group['name']])
        if not name:
            continue
        if any(name.startswith(s) for s in skip):
            continue
        if head_item(name):
            # 左右两块在纵向不是对齐的：模板把右表的「项目/行次」表头又印了一份，
            # 看到它就说明右表到底了，再往下都是注释和签章。
            break
        ln = as_line(cells[group['line']])
        vals = []
        for a in group['amounts']:
            vals.append(parse_amount(cells[a['col']]) if a['col'] < len(cells) else None)
        if ln is None and all(v is None for v in vals):
            # 没有行次又没有金额：标题行 / 注释 / 签章，跳过
            continue
        out.append({'line': ln, 'name': name, 'side': side, 'level': level_of(name),
                    'kind': kind_of(name), 'values': vals, '_row': ri})
    return out


def drop_empty(items):
    """金额全空的行不算报表行（模板里留着没填的科目）；但「流动资产：」这类分节标题要留下做分组。"""
    return [it for it in items if it['kind'] == 'title' or any(v is not None for v in it['values'])]


def find_unit(cells):
    for row in cells:
        for c in row:
            t = compact(c)
            if '金额单位' in t:
                m = re.search(r'金额单位[:：](.+)', t)
                if m:
                    return m.group(1).strip()
    return ''


def find_period(cells, default=''):
    for row in cells:
        for c in row:
            t = norm(c)
            m = re.search(r'(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日', t)
            if m:
                return '%s年%s月%s日' % (m.group(1), int(m.group(2)), int(m.group(3)))
    for row in cells:
        for c in row:
            t = norm(c)
            m = re.search(r'(\d{4})\s*年度', t)
            if m:
                return '%s年度' % m.group(1)
    return default


def sheet_kind(sheet_name, rows, head):
    sn = compact(sheet_name)
    if sn in ('资',):
        return 'balance'
    if sn in ('利',):
        return 'income'
    if '资产负债表' in sn:
        return 'balance'
    if '利润表' in sn or '损益表' in sn:
        return 'income'
    joined = ''.join(compact(c) for row in rows[:12] for c in row)
    # 现金流量表也是一对一对的（经营活动 | 投资活动），金额列同样叫「本期金额」，
    # 所以先把它排掉，不能靠「两对」当资产负债表。
    if '现金流量' in joined or '经营活动产生的现金流量' in joined:
        return None
    if '资产总计' in joined or '负债和所有者权益' in joined or '资产合计' in joined:
        return 'balance'
    if '营业总收入' in joined or '营业利润' in joined or '净利润' in joined:
        return 'income'
    if head and len(head['groups']) >= 2:
        return 'balance'
    return None


def parse_sheet(rows, sheet_name, year_hint=''):
    head = find_header(rows)
    if head is None:
        return None
    kind = sheet_kind(sheet_name, rows, head)
    if kind is None:
        return None
    above = rows[:head['row'] + 1]
    unit = find_unit(above)
    period = find_period(above)
    if not period and year_hint:
        period = (str(year_hint) + '年度') if kind == 'income' else (str(year_hint) + '年12月31日')
    year = ''
    m = re.search(r'(\d{4})', period or '')
    if m:
        year = m.group(1)
    elif year_hint:
        year = str(year_hint)

    columns = []
    for g in head['groups']:
        for a in g['amounts']:
            if a['kind'] not in [c['kind'] for c in columns]:
                columns.append({'label': a['label'], 'kind': a['kind']})

    skip = ('注：', '法定代表人', '[提示', '提示：')
    rows_out = []
    seen = set()
    for gi, g in enumerate(head['groups']):
        side = ''
        if kind == 'balance':
            side = 'asset' if gi == 0 else 'liability'
        for it in drop_empty(parse_block(rows, head, g, side, skip=skip)):
            key = (it['side'], it['line'], it['name'])
            if key in seen:
                continue
            seen.add(key)
            rows_out.append(it)
    rows_out.sort(key=lambda x: (0 if x['side'] == 'asset' else 1, x['_row']))
    for it in rows_out:
        it.pop('_row', None)
    sides = BALANCE_SIDES if kind == 'balance' else None
    tpl = capture_template(kind, rows_out, sides)
    tpl, extra = match_template(kind, rows_out, tpl)
    return {'statement': kind, 'sheet': sheet_name, 'year': year, 'unit': unit,
            'period': period, 'columns': columns, 'rows': rows_out,
            'template': tpl, 'extra': extra}


# ---------- 模板名表：中汇报表（国资委/交投）行次 → 标准名称 ----------

SA_LEFT = [
    (None, '流动资产：'), (2, '货币资金'), (3, '△结算备付金'), (4, '△拆出资金'), (5, '交易性金融资产'),
    (6, '☆以公允价值计量且其变动计入当期损益的金融资产'), (7, '衍生金融资产'), (8, '应收票据'), (9, '应收账款'),
    (10, '应收款项融资'), (11, '预付款项'), (12, '△应收保费'), (13, '△应收分保账款'), (14, '△应收分保合同准备金'),
    (15, '应收资金集中管理款'), (16, '其他应收款'), (17, '其中：应收股利'), (18, '△买入返售金融资产'),
    (19, '存货'), (20, '其中：原材料'), (21, '库存商品(产成品)'), (22, '合同资产'), (23, '持有待售资产'),
    (24, '一年内到期的非流动资产'), (25, '其他流动资产'), (26, '流动资产合计'),
    (None, '非流动资产：'), (28, '△发放贷款和垫款'), (29, '债权投资'),
    (30, '☆可供出售金融资产'), (31, '其他债权投资'), (32, '☆持有至到期投资'), (33, '长期应收款'),
    (34, '长期股权投资'), (35, '其他权益工具投资'), (36, '其他非流动金融资产'), (37, '投资性房地产'),
    (38, '固定资产'), (39, '其中：固定资产原价'), (40, '累计折旧'), (41, '固定资产减值准备'),
    (42, '在建工程'), (43, '生产性生物资产'), (44, '油气资产'), (45, '使用权资产'), (46, '无形资产'),
    (47, '开发支出'), (48, '商誉'), (49, '长期待摊费用'), (50, '递延所得税资产'), (51, '其他非流动资产'),
    (52, '其中：特准储备物资'), (53, '非流动资产合计'),
]
SA_RIGHT = [
    (None, '流动负债：'), (76, '短期借款'), (77, '△向中央银行借款'), (78, '△拆入资金'), (79, '交易性金融负债'),
    (80, '☆以公允价值计量且其变动计入当期损益的金融负债'), (81, '衍生金融负债'), (82, '应付票据'),
    (83, '应付账款'), (84, '预收款项'), (85, '合同负债'), (86, '△卖出回购金融资产款'), (87, '△吸收存款及同业存放'),
    (88, '△代理买卖证券款'), (89, '△代理承销证券款'), (90, '应付职工薪酬'), (91, '其中：应付工资'),
    (92, '应付福利费'), (93, '其中：职工奖励及福利基金'), (94, '应交税费'), (95, '其中：应交税金'),
    (96, '其他应付款'), (97, '其中：应付股利'), (98, '△应付手续费及佣金'), (99, '△应付分保账款'),
    (100, '持有待售负债'), (101, '一年内到期的非流动负债'), (102, '其他流动负债'), (103, '流动负债合计'),
    (None, '非流动负债：'), (105, '△保险合同准备金'), (106, '长期借款'), (107, '应付债券'), (108, '其中：优先股'),
    (109, '永续债'), (110, '租赁负债'), (111, '长期应付款'), (112, '长期应付职工薪酬'), (113, '预计负债'),
    (114, '递延收益'), (115, '递延所得税负债'), (116, '其他非流动负债'), (117, '其中：特准储备基金'),
    (118, '非流动负债合计'), (119, '负 债 合 计'),
    (None, '所有者权益：'), (121, '实收资本'), (122, '国家资本'), (123, '国有法人资本'), (124, '集体资本'),
    (125, '民营资本'), (126, '外商资本'), (127, '减：已归还投资'), (128, '实收资本净额'), (129, '其他权益工具'),
    (130, '其中：优先股'), (131, '永续债'), (132, '资本公积'), (133, '减：库存股'), (134, '其他综合收益'),
    (135, '其中：外币报表折算差额'), (136, '专项储备'), (137, '盈余公积'), (138, '其中：法定公积金'),
    (139, '任意公积金'), (140, '储备基金'), (141, '企业发展基金'), (142, '利润归还投资'),
    (143, '△一般风险准备'), (144, '未分配利润'), (145, '归属于母公司所有者权益合计'), (146, '少数股东权益'),
    (147, '所有者权益合计'), (148, '资 产 总 计'), (149, '负债和所有者权益总计'),
]
SI_LEFT = [
    (1, '一、营业总收入'), (2, '其中：营业收入'), (3, '△利息收入'), (4, '△已赚保费'), (5, '△手续费及佣金收入'),
    (6, '二、营业总成本'), (7, '其中：营业成本'), (8, '△利息支出'), (9, '△手续费及佣金支出'), (10, '△退保金'),
    (11, '△赔付支出净额'), (12, '△提取保险责任准备金净额'), (13, '△保单红利支出'), (14, '△分保费用'),
    (15, '税金及附加'), (16, '销售费用'), (17, '管理费用'), (18, '研发费用'), (19, '财务费用'),
    (20, '其中：利息费用'), (21, '利息收入'), (22, '汇兑净损失(净收益以"-"号填列)'), (23, '其他'),
    (24, '加：其他收益'), (25, '投资收益(损失以"-"号填列)'), (26, '其中：对联营企业和合营企业的投资收益'),
    (27, '以摊余成本计量的金融资产终止确认收益'), (28, '△汇兑收益(损失以"-"号填列)'),
    (29, '净敞口套期收益(损失以"-"号填列)'), (30, '公允价值变动收益(损失以"-"号填列)'),
    (31, '信用减值损失(损失以"-"号填列)'), (32, '资产减值损失(损失以"-"号填列)'),
    (33, '资产处置收益(损失以"-"号填列)'), (34, '三、营业利润(亏损以"－"号填列)'), (36, '加：营业外收入'),
    (37, '其中：政府补助'),
]
SI_RIGHT = [
    (38, '减：营业外支出'), (39, '四、利润总额(亏损总额以"－"号填列)'), (40, '减：所得税费用'),
    (41, '五、净利润(净亏损以"－"号填列)'), (42, '(一)按所有权归属分类：'), (43, '归属于母公司所有者的净利润'),
    (44, '少数股东损益'), (45, '(二)按经营持续性分类：'), (46, '持续经营净利润'), (47, '终止经营净利润'),
    (48, '六、其他综合收益的税后净额'), (49, '归属于母公司所有者的其他综合收益的税后净额'),
    (50, '(一)不能重分类进损益的其他综合收益'), (51, '1.重新计量设定受益计划变动额'),
    (52, '2.权益法下不能转损益的其他综合收益'), (53, '3.其他权益工具投资公允价值变动'),
    (54, '4.企业自身信用风险公允价值变动'), (55, '5.其他'), (56, '(二)将重分类进损益的其他综合收益'),
    (57, '1.权益法下可转损益的其他综合收益'), (58, '2.其他债权投资公允价值变动'),
    (59, '☆3.可供出售金融资产公允价值变动损益'), (60, '4.金融资产重分类计入其他综合收益的金额'),
    (61, '☆5.持有至到期投资重分类为可供出售金融资产损益'), (62, '6.其他债权投资信用减值准备'),
    (63, '7.现金流量套期储备(现金流量套期损益的有效部分)'), (64, '8.外币财务报表折算差额'), (65, '9.其他'),
    (66, '少数股东的其他综合收益的税后净额'), (67, '七、综合收益总额'),
    (68, '归属于母公司所有者的综合收益总额'), (69, '少数股东的综合收益总额'), (70, '八、每股收益：'),
    (71, '基本每股收益'), (72, '稀释每股收益'),
]


def template(kind):
    base = SA_LEFT + SA_RIGHT if kind == 'balance' else SI_LEFT + SI_RIGHT
    return [{'line': ln, 'name': nm} for ln, nm in base]


# 资产负债表左右两块分别带 side（asset / liability），利润表整块 side 为空。
BALANCE_SIDES = ('asset', 'liability')
FALLBACK = {}
for _ln, _nm in SA_LEFT:
    if _ln is not None:
        FALLBACK[('balance', _ln)] = _nm
for _ln, _nm in SA_RIGHT:
    if _ln is not None:
        FALLBACK[('balance', _ln)] = _nm
for _ln, _nm in SI_LEFT + SI_RIGHT:
    FALLBACK[('income', _ln)] = _nm


def capture_template(kind, rows, sides=None):
    """按「行次」从源表里把模板名抓下来。

    各家企业拿到的审定报表模板行次会随准则更新漂移（新保险合同准则就插了两行），
    死按中汇报表那份行次去挂会整体错位；行次是会计上的栏目号，以它为准，
    名表只在源表缺这一行时兜底。
    """
    got = {}
    side_of = {}
    for r in rows:
        if r.get('line') is None:
            continue
        if sides and r.get('side') not in sides:
            continue
        got.setdefault(r['line'], r['name'])
        side_of.setdefault(r['line'], r.get('side'))
    order = []
    for ln in sorted(got):
        if sides and kind == 'balance':
            group = [s for s in sides if side_of[ln] == s]
            if not group:
                continue
            order.append(ln)
        else:
            order.append(ln)
    out = []
    seen = set()
    for ln in order:
        seen.add(ln)
        out.append({'line': ln, 'name': got[ln]})
    # 源表里有、名表没有的行（模板新增科目，比如新保险合同准则那几行），照原样补在末尾
    for ln in sorted(got):
        if ln in seen:
            continue
        out.append({'line': ln, 'name': got[ln]})
    return out


def flat(s):
    return re.sub(r'\s+', '', s or '').replace('（', '(').replace('）', ')')


def norm_mark(name):
    """模板里用 △ ☆ * # 标记专用科目，源表有时写成 ▲ 或漏掉；去掉标记后只按文字比。"""
    return re.sub(r'[△☆▲★*#＊※]', '', flat(name))


def match_template(kind, rows, tpl):
    """按行次把解析出来的行挂到模板行上；行次对不上时按名称兜底。"""
    by_line = {}
    by_name = {}
    for r in rows:
        if r.get('line') is not None:
            by_line.setdefault(r['line'], r)
        by_name.setdefault(norm_mark(r['name']), r)
    out = []
    used = set()
    for t in tpl:
        hit = by_line.get(t['line']) if t['line'] is not None else None
        if hit is not None and norm_mark(hit['name']) != norm_mark(t['name']):
            # 行次对上了但名字差得远：源表模板改过行次，退回按名字挂，
            # 按名字也找不到就当成模板里这一行没有数（宁空勿错位）。
            hit = by_name.get(norm_mark(t['name']))
        if hit is None:
            hit = by_name.get(norm_mark(t['name']))
        if hit is not None:
            used.add(id(hit))
        out.append({'line': t['line'], 'name': t['name'],
                    'matched': hit['name'] if hit is not None else '',
                    'values': list(hit['values']) if hit is not None else [],
                    'sourceLine': hit.get('line') if hit is not None else None})
    extra = []
    for r in rows:
        if id(r) in used:
            continue
        if r['name'] in [t['name'] for t in tpl]:
            continue
        extra.append({'line': r['line'], 'name': r['name'], 'side': r['side'], 'values': r['values']})
    return out, extra


# ---------- 读文件 ----------

def read_workbook(path):
    """返回 [(sheet_name, rows)]。xls 用 xlrd，其它用 openpyxl（data_only 拿缓存值）。"""
    low = path.lower()
    if low.endswith('.xls') and not low.endswith('.xlsx') and not low.endswith('.xlsm'):
        import xlrd
        book = xlrd.open_workbook(path)
        out = []
        for sh in book.sheets():
            rows = []
            for ri in range(sh.nrows):
                rows.append([sh.cell_value(ri, ci) for ci in range(sh.ncols)])
            out.append((sh.name, rows))
        return out
    from openpyxl import load_workbook
    wb = load_workbook(path, data_only=True, read_only=True)
    out = []
    for sn in wb.sheetnames:
        ws = wb[sn]
        rows = [list(r) for r in ws.iter_rows(values_only=True)]
        out.append((sn, rows))
    return out

# ---------- 天源「财务资料」模板科目（modeId=1 一般企业）与科目对照 ----------
# 上面那些是中汇报表/审定报表的行次模板；这里是天源评估平台「财务资料」那一页的
# 资产负债表 77 行、利润表 29 行（subjectName 是天源接口里认的名字，displayName 是界面上的叫法）。
# 天源 prepare_financial_statement_report_import 只要有一个科目对不上就整单不收，
# 所以这边必须先把「能对上的」挑出来，剩下的单独列给用户看。

TY_BALANCE = [
    ('流动资产', '流动资产:'), ('货币资金', '货币资金'), ('交易性金融资产', '交易性金融资产'),
    ('衍生金融资产', '衍生金融资产'), ('应收票据', '应收票据'), ('应收账款', '应收账款'),
    ('应收款项融资', '应收款项融资'), ('预付款项', '预付款项'), ('其他应收款', '其他应收款'),
    ('存货', '存货'), ('合同资产', '合同资产'), ('持有待售资产', '持有待售资产'),
    ('一年内到期的非流动资产', '一年内到期的非流动资产'), ('其他流动资产', '其他流动资产'),
    ('流动资产合计', '流动资产合计'),
    ('非流动资产', '非流动资产:'), ('债权投资', '债权投资'), ('其他债权投资', '其他债权投资'),
    ('长期应收款', '长期应收款'), ('长期股权投资', '长期股权投资'), ('其他权益工具投资', '其他权益工具投资'),
    ('其他非流动金融资产', '其他非流动金融资产'), ('投资性房地产', '投资性房地产'), ('固定资产', '固定资产'),
    ('在建工程', '在建工程'), ('生产性生物资产', '生产性生物资产'), ('油气资产', '油气资产'),
    ('使用权资产', '使用权资产'), ('无形资产', '无形资产'), ('开发支出', '开发支出'), ('商誉', '商誉'),
    ('长期待摊费用', '长期待摊费用'), ('递延所得税资产', '递延所得税资产'),
    ('其他非流动资产', '其他非流动资产'), ('非流动资产合计', '非流动资产合计'), ('资产总计', '资产总计'),
    ('流动负债', '流动负债:'), ('短期借款', '短期借款'), ('交易性金融负债', '交易性金融负债'),
    ('衍生金融负债', '衍生金融负债'), ('应付票据', '应付票据'), ('应付账款', '应付账款'),
    ('预收款项', '预收款项'), ('合同负债', '合同负债'), ('应付职工薪酬', '应付职工薪酬'),
    ('应交税费', '应交税费'), ('其他应付款', '其他应付款'), ('持有待售负债', '持有待售负债'),
    ('一年内到期的非流动负债', '一年内到期的非流动负债'), ('其他流动负债', '其他流动负债'),
    ('流动负债合计', '流动负债合计'),
    ('非流动负债', '非流动负债:'), ('长期借款', '长期借款'), ('应付债券', '应付债券'),
    ('租赁负债', '租赁负债'), ('长期应付款', '长期应付款'), ('长期应付职工薪酬', '长期应付职工薪酬'),
    ('预计负债', '预计负债'), ('递延收益', '递延收益'), ('递延所得税负债', '递延所得税负债'),
    ('其他非流动负债', '其他非流动负债'), ('非流动负债合计', '非流动负债合计'), ('负债合计', '负债合计'),
    ('所有者权益', '所有者权益:'), ('实收资本', '实收资本'), ('其他权益工具', '其他权益工具'),
    ('资本公积', '资本公积'), ('库存股', '减：库存股'), ('其他综合收益', '其他综合收益'),
    ('专项储备', '专项储备'), ('盈余公积', '盈余公积'), ('未分配利润', '未分配利润'),
    ('所有者权益合计', '所有者权益合计'), ('负债和所有者权益总计', '负债和所有者权益总计'),
    ('固定资产账面原值', '固定资产账面原值'), ('无形资产账面原值', '无形资产账面原值'),
    ('长期待摊费用原始账面价值', '长期待摊费用原始账面价值'),
]

TY_INCOME = [
    ('营业收入', '一、营业收入'), ('主营业务收入', '其中：主营业务收入'), ('其他业务收入', '其他业务收入'),
    ('营业成本', '减：营业成本'), ('主营业务成本', '其中：主营业务成本'), ('其他业务成本', '其他业务成本'),
    ('税金及附加', '税金及附加'), ('销售费用', '销售费用'), ('管理费用', '管理费用'), ('研发费用', '研发费用'),
    ('财务费用', '财务费用'), ('利息费用', '其中：利息费用'), ('利息收入', '利息收入'),
    ('其他收益', '加：其他收益'), ('投资收益', '投资收益（损失以“-”号填列）'),
    ('对联营企业和合营企业的投资收益', '其中：对联营企业和合营企业的投资收益'),
    ('以摊余成本计量的金融资产终止确认收益', '以摊余成本计量的金融资产终止确认收益'),
    ('净敞口套期收益', '净敞口套期收益（损失以“-”号填列）'),
    ('公允价值变动收益', '公允价值变动收益（损失以“-”号填列）'),
    ('信用减值损失', '信用减值损失（损失以“-”号填列）'),
    ('资产减值损失', '资产减值损失（损失以“-”号填列）'),
    ('资产处置收益', '资产处置收益（损失以“-”号填列）'),
    ('营业利润', '二、营业利润（亏损以“-”号填列）'),
    ('营业外收入', '加：营业外收入'), ('营业外支出', '减：营业外支出'),
    ('利润总额', '三、利润总额（亏损总额以“-”号填列）'),
    ('所得税费用', '减：所得税费用'),
    ('净利润', '四、净利润（净亏损以“-”号填列）'),
    ('净利润报表数', '五、净利润报表数（净亏损以“-”号填列）'),
]

# 源表科目名（去掉 ▲△☆*、括号统一成半角、冒号统一成半角之后）→ 天源 subjectName。
# 天源资产负债表没有「其中：」明细行（应收股利、应交税金、固定资产原价…），这类不映射。
MAP_BALANCE = {
    '货币资金': '货币资金', '交易性金融资产': '交易性金融资产', '衍生金融资产': '衍生金融资产',
    '应收票据': '应收票据', '应收账款': '应收账款', '应收款项融资': '应收款项融资',
    '预付款项': '预付款项', '预付账款': '预付款项', '其他应收款': '其他应收款',
    '存货': '存货', '合同资产': '合同资产', '持有待售资产': '持有待售资产',
    '一年内到期的非流动资产': '一年内到期的非流动资产', '其他流动资产': '其他流动资产',
    '流动资产合计': '流动资产合计',
    '债权投资': '债权投资', '持有至到期投资': '债权投资', '其他债权投资': '其他债权投资',
    '可供出售金融资产': '其他权益工具投资',
    '长期应收款': '长期应收款', '长期股权投资': '长期股权投资',
    '其他权益工具投资': '其他权益工具投资', '其他非流动金融资产': '其他非流动金融资产',
    '投资性房地产': '投资性房地产', '固定资产': '固定资产',
    '在建工程': '在建工程', '生产性生物资产': '生产性生物资产', '油气资产': '油气资产',
    '使用权资产': '使用权资产', '无形资产': '无形资产', '开发支出': '开发支出', '商誉': '商誉',
    '长期待摊费用': '长期待摊费用', '递延所得税资产': '递延所得税资产',
    '其他非流动资产': '其他非流动资产', '非流动资产合计': '非流动资产合计', '资产总计': '资产总计',
    '短期借款': '短期借款', '交易性金融负债': '交易性金融负债', '衍生金融负债': '衍生金融负债',
    '应付票据': '应付票据', '应付账款': '应付账款', '预收款项': '预收款项', '预收账款': '预收款项',
    '合同负债': '合同负债', '应付职工薪酬': '应付职工薪酬', '应交税费': '应交税费',
    '其他应付款': '其他应付款', '持有待售负债': '持有待售负债',
    '一年内到期的非流动负债': '一年内到期的非流动负债', '其他流动负债': '其他流动负债',
    '流动负债合计': '流动负债合计', '长期借款': '长期借款', '应付债券': '应付债券',
    '租赁负债': '租赁负债', '长期应付款': '长期应付款', '长期应付职工薪酬': '长期应付职工薪酬',
    '预计负债': '预计负债', '递延收益': '递延收益', '递延所得税负债': '递延所得税负债',
    '其他非流动负债': '其他非流动负债', '非流动负债合计': '非流动负债合计', '负债合计': '负债合计',
    '实收资本': '实收资本', '实收资本净额': '实收资本', '股本': '实收资本',
    '实收资本(或股本)': '实收资本', '实收资本(或股本)净额': '实收资本',
    '其他权益工具': '其他权益工具', '资本公积': '资本公积', '库存股': '库存股',
    '其他综合收益': '其他综合收益', '专项储备': '专项储备', '盈余公积': '盈余公积',
    '未分配利润': '未分配利润', '所有者权益合计': '所有者权益合计',
    '所有者权益(或股东权益)合计': '所有者权益合计',
    '归属于母公司所有者权益合计': '所有者权益合计',
    '归属于母公司所有者权益(或股东权益)合计': '所有者权益合计',
    '负债和所有者权益总计': '负债和所有者权益总计', '负债和所有者权益合计': '负债和所有者权益总计',
    '负债和股东权益总计': '负债和所有者权益总计',
    '负债和所有者权益(或股东权益)总计': '负债和所有者权益总计',
    '固定资产账面原值': '固定资产账面原值', '无形资产账面原值': '无形资产账面原值',
    '长期待摊费用原始账面价值': '长期待摊费用原始账面价值',
}

# 利润表：源表的「一、营业总收入」「减：营业成本」「其中：利息费用」这类带序号/前缀的行，
# 一律剥掉前缀再对；净利润有「四、净利润」和「五、净利润报表数」两行，整名先查。
MAP_INCOME = {
    '一、营业总收入': '营业收入', '营业总收入': '营业收入', '营业收入': '营业收入',
    '其中：营业收入': '营业收入', '主营业务收入': '主营业务收入', '其他业务收入': '其他业务收入',
    '二、营业总成本': '营业成本', '营业总成本': '营业成本', '营业成本': '营业成本',
    '其中：营业成本': '营业成本', '主营业务成本': '主营业务成本', '其他业务成本': '其他业务成本',
    '营业税金及附加': '税金及附加', '税金及附加': '税金及附加',
    '销售费用': '销售费用', '管理费用': '管理费用', '研发费用': '研发费用', '财务费用': '财务费用',
    '其中：利息费用': '利息费用', '利息费用': '利息费用', '利息收入': '利息收入',
    '加：其他收益': '其他收益', '其他收益': '其他收益', '投资收益': '投资收益',
    '对联营企业和合营企业的投资收益': '对联营企业和合营企业的投资收益',
    '以摊余成本计量的金融资产终止确认收益': '以摊余成本计量的金融资产终止确认收益',
    '净敞口套期收益': '净敞口套期收益', '公允价值变动收益': '公允价值变动收益',
    '信用减值损失': '信用减值损失', '资产减值损失': '资产减值损失', '资产处置收益': '资产处置收益',
    '二、营业利润': '营业利润', '营业利润': '营业利润',
    '加：营业外收入': '营业外收入', '营业外收入': '营业外收入',
    '减：营业外支出': '营业外支出', '营业外支出': '营业外支出',
    '三、利润总额': '利润总额', '利润总额': '利润总额',
    '减：所得税费用': '所得税费用', '所得税费用': '所得税费用',
    '四、净利润': '净利润', '五、净利润': '净利润', '净利润': '净利润', '净利润报表数': '净利润报表数',
}

SECTION_TITLES = ('流动资产:', '非流动资产:', '流动负债:', '非流动负债:', '所有者权益:')


def ty_template(kind):
    """天源「财务资料」页的科目行（subjectName 是天源认的名字，display 是界面上的叫法）。"""
    src = TY_INCOME if kind == 'income' else TY_BALANCE
    return [{'subjectName': n, 'displayName': d, 'title': n in ('流动资产', '非流动资产', '流动负债', '非流动负债', '所有者权益')}
            for n, d in src]


def _q(s):
    """去标记、括号/冒号/引号统一成半角，再去掉「一、/减:/加:/其中:」这类前缀，供对照表按裸名查。"""
    t = norm_mark(s)
    t = (t.replace('（', '(').replace('）', ')').replace('“', '"').replace('”', '"')
          .replace('：', ':').replace('，', ',').replace(' ', ''))
    out = [t]
    bare = re.sub(r'\([^()]*填列[^()]*\)|\([^()]*号[^()]*\)', '', t).replace(' ', '')
    if bare and bare != t:
        out.append(bare)
    for pre in ('一、', '二、', '三、', '四、', '五、', '六、', '七、', '八、', '减:', '加:', '其中:'):
        if t.startswith(pre):
            out.append(t[len(pre):])
    return out


def ty_map(kind, name):
    """源表科目名 → 天源 subjectName；对不上返回空串。"""
    table = MAP_INCOME if kind == 'income' else MAP_BALANCE
    cands = _q(name)
    if kind != 'income' and cands[0].startswith('其中:'):
        return ''  # 资产负债表的「其中：」明细行，天源没有对应科目
    for c in cands:
        if c in table:
            return table[c]
    return ''


FINANCE_MARKS = ('保险', '保费', '分保', '准备金', '同业', '拆出', '拆入', '中央银行', '回购金融资产', '吸收存款', '代理买卖证券', '代理承销', '结算备付金', '客户资金', '存出保证金', '买入返售', '卖出回购', '存放同业', '贷款', '贴现')


def explained_skip(kind, sheet_data, group=''):
    """把 skipped 里的行按原因归类，前端一句话说清「跳过 54 行」是怎么回事。"""
    rows = sheet_data.get('skipped') or []
    buckets = {'detail': [], 'finance': [], 'zero': []}
    for r in rows:
        name = norm_mark(r.get('originName') or '')
        amount = r.get('amount')
        if isinstance(amount, (int, float)) and round(float(amount), 2) == 0:
            buckets['zero'].append(name)
        elif name.startswith('其中:') or name.startswith('其中：'):
            buckets['detail'].append(name)
        elif any(k in name for k in FINANCE_MARKS):
            buckets['finance'].append(name)
        else:
            buckets['detail'].append(name)
    parts = []
    if buckets['zero']:
        parts.append('金额为 0 %d 行' % len(buckets['zero']))
    if buckets['detail']:
        parts.append('「其中：」明细行 %d 行（并入上级科目）' % len(buckets['detail']))
    if buckets['finance']:
        parts.append('天源模板没有的行业专有科目 %d 行（%s）' % (
            len(buckets['finance']), '、'.join(buckets['finance'][:4]) + ('…' if len(buckets['finance']) > 4 else '')))
    sheet_data['skipSummary'] = parts
    return sheet_data


def build_sheet(kind, tpl_rows, report_year, source_sheet, audit=None):
    """把解析出来的一张表拼成天源 prepare 的 sheetList 一项。

    返回 {reportYear, sourceSheetName, auditType, detail, skipped, empty}：
      detail  = 天源会收的 {subjectName, amount, originName}；
      skipped = 对不上天源的科目（带上它天源整单都收不了，所以留着给前端列出来）；
      empty   = 模板里有、源表这一期没数的科目（不传，天源按缺省策略保留原值）。
    """
    detail = []
    skipped = []
    empty = []
    dup = []
    seen_target = {}
    for t in tpl_rows:
        name = t['name']
        flat_name = norm_mark(name)
        if not flat_name or flat_name == '项目' or flat_name.endswith(':'):
            continue  # 分节标题（流动资产：/ 流动负债：）不是科目
        target = ty_map(kind, name)
        vals = t.get('values') or []
        amount = vals[0] if vals else None
        if not target:
            skipped.append({'originName': name, 'amount': amount, 'reason': '天源模板里没有这个科目'})
            continue
        if amount is None:
            empty.append({'subjectName': target, 'originName': name})
            continue
        if target in seen_target:
            # 利润表「一、营业总收入」和「其中：营业收入」都挂在营业收入上，取先出现的那个
            dup.append({'subjectName': target, 'originName': name, 'amount': round(float(amount), 2),
                        'keptFrom': seen_target[target]})
            continue
        seen_target[target] = name
        detail.append({'subjectName': target, 'amount': round(float(amount), 2), 'originName': name})
    order = {x['subjectName']: i for i, x in enumerate(ty_template(kind)) if not x['title']}
    detail.sort(key=lambda x: order.get(x['subjectName'], 999))
    sheet = {'reportYear': int(report_year), 'sourceSheetName': source_sheet, 'detail': detail,
             'skipped': skipped, 'empty': empty, 'duplicates': dup}
    if kind == 'balance':
        sheet['auditType'] = int((audit or {}).get('auditType') or 1)
        if audit:
            aud = dict((k, audit[k]) for k in ('auditOrganization', 'reportName', 'reportNumber',
                                               'reportDate', 'auditOpinion', 'attachId') if audit.get(k))
            if aud:
                sheet['audit'] = aud
    return sheet


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    opts = {}
    for i, a in enumerate(sys.argv[1:]):
        if a.startswith('--'):
            key = a[2:]
            nxt = sys.argv[i + 2] if i + 2 <= len(sys.argv) - 1 else ''
            opts[key] = nxt
    if not args:
        print(json.dumps({'ok': False, 'error': '缺少文件路径'}, ensure_ascii=True))
        return
    path = args[0]
    if not os.path.exists(path):
        print(json.dumps({'ok': False, 'error': '找不到文件：' + path}, ensure_ascii=True))
        return
    year_hint = (opts.get('year') or '').strip()
    periods_opt = (opts.get('periods') or '').strip()
    base_opt = (opts.get('basedate') or '').strip()
    only = (opts.get('sheet') or '').strip()
    try:
        book = read_workbook(path)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}, ensure_ascii=True))
        return
    statements = []
    tried = []
    for sn, rows in book:
        if only and sn != only:
            continue
        try:
            st = parse_sheet(rows, sn, year_hint)
        except Exception as e:  # noqa: BLE001
            tried.append({'sheet': sn, 'error': '%s: %s' % (type(e).__name__, e)})
            continue
        if st is None:
            tried.append({'sheet': sn, 'error': '不是资产负债表/利润表结构'})
            continue
        statements.append(st)
    if not statements:
        print(json.dumps({'ok': False, 'error': '这个文件里没有找到「资 / 利」结构的资产负债表或利润表',
                          'sheets': [s for s, _ in book], 'tried': tried}, ensure_ascii=True))
        return
    if (opts.get('mode') or '').strip() == 'statements':
        # 给天源财务资料页用的：每张表拼好明细（year 默认取表头期间，读不到才用 --year）
        packs = []
        for st in statements:
            year = st.get('year') or year_hint
            if not year:
                continue
            tpl = [{'line': t['line'], 'name': t['name'], 'values': t['values']} for t in st['template']]
            # 每行的金额按列的性质拆开存（now=本期/期末，prev=上期/期初），
            # 前端按「报表显示期数」和「评估基准日」排具体年份，换口径不用重新读文件。
            rows_vk = []
            for r in st['rows']:
                vk = {}
                for ci, c in enumerate(st['columns']):
                    if ci < len(r['values']) and r['values'][ci] is not None:
                        vk.setdefault(c.get('kind') or ('prev' if ci else 'now'), r['values'][ci])
                rows_vk.append({'line': r.get('line'), 'name': r['name'], 'side': r.get('side'),
                                'level': r.get('level'), 'kind': r.get('kind'), 'valuesByKind': vk})
            packs.append({
                'statement': st['statement'],
                'statementType': 'balance_sheet' if st['statement'] == 'balance' else 'income_statement',
                'sheet': st['sheet'], 'year': int(year), 'unit': st['unit'], 'period': st['period'],
                'columns': st['columns'], 'rows': st['rows'], 'rowsByKind': rows_vk,
                'sheetData': explained_skip(st['statement'], build_sheet(st['statement'], tpl, year, st['sheet'])),
            })
        out = {'ok': True, 'file': os.path.basename(path), 'statements': packs}
        if periods_opt:
            out['periodsOption'] = int(periods_opt)
        if base_opt:
            out['baseDateOption'] = base_opt
        print(json.dumps(out, ensure_ascii=False))
        return
    for st in statements:
        st['sheetData'] = explained_skip(st['statement'], build_sheet(st['statement'], st['template'], st.get('year') or year_hint or 0, st['sheet']))
    print(json.dumps({'ok': True, 'file': os.path.basename(path), 'statements': statements},
                     ensure_ascii=False))


if __name__ == '__main__':
    main()
