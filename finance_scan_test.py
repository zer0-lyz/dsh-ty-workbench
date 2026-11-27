"""finance_scan gate tests（不联网、不碰真实项目数据）。

用 openpyxl 现造几份「项目 + 行次 + 金额」结构的模拟报表，丢进临时目录，
验证：多文件多页识别、文件名认年份、认不出的页进 needManual、
--force 人工指定分类、同期重复文件去重、坏文件不影响其他文件。
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

from openpyxl import Workbook

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, 'finance_scan.py')

BALANCE_ROWS = [
    ('项目', '行次', '期末余额', '期初余额'),
    ('流动资产：', '', '', ''),
    ('货币资金', 1, 1000, 900),
    ('应收账款', 4, 500, 400),
    ('资产总计', 30, 1500, 1300),
    ('负债和所有者权益(或股东权益)总计', 60, 1500, 1300),
]
INCOME_ROWS = [
    ('项目', '行次', '本期金额', '上期金额'),
    ('一、营业总收入', 1, 3000, 2800),
    ('二、营业利润', 20, 600, 500),
    ('四、净利润', 30, 450, 380),
]
# 一页认不出的表：既没有「资产总计」也没有「营业总收入」，表头也不全
JUNK_ROWS = [
    ('说明', '', ''),
    ('本表由客户提供，仅供核对', '', ''),
]

# 真实企业报表版式（审定底稿里那种）：没有「行次」列，第 2 列是「注释号」，
# 资产侧首列写「资  产」而不是「项目」，最右一列还夹着科目编码（911010 这类），
# 报告期写成 Excel 序列号而不是文本。以前这种表 100% 认不出。
REAL_BALANCE_ROWS = [
    ('资  产  负  债  表', '', '', '', '', '', '', ''),
    (45291.0, '', '', '', '', '', '', ''),          # Excel 序列号日子
    ('', '', '', '', '', '', '', ''),
    ('编制单位：某某公司', '', '', '', '', '', '', '单位:人民币元'),
    ('资  产', '注释号', '期末数', '上年年末数', '', '负债和所有者权益', '注释号', '期末数'),
    ('流动资产：', '', '', '', '', '流动负债：', '', ''),
    ('  货币资金', '', 22808353.73, 11508030.07, 911010.0, '  短期借款', '', 0.0),
    ('  应收账款', '', 30874355.92, 47387821.99, 911020.0, '  应付账款', '', 1000.0),
    ('      流动资产合计', '', 53682709.65, 58895852.06, 911998.0, '       流动负债合计', '', 1000.0),
    ('资产总计', '', 53682709.65, 58895852.06, 912999.0, '负债和所有者权益总计', '', 53682709.65),
]
REAL_INCOME_ROWS = [
    ('利  润  表', '', '', '', ''),
    ('2025年度', '', '', '', ''),
    ('', '', '', '会企02表', ''),
    ('编制单位：某某公司', '', '', '单位：人民币元', ''),
    ('项  目', '注释号', '本期数', '上年同期数', ''),
    ('一、营业收入', '', 210705654.8, 290735522.8, 921010.0),
    ('减：营业成本', '', 180000000.0, 250000000.0, 921020.0),
    ('四、净利润（净亏损以“-”号填列）', '', 8839321.66, 37286258.78, 926000.0),
]


def make_book(path, sheets):
    """sheets = [(页签名, 行列表)]，行列表会原样写进前几列。"""
    wb = Workbook()
    wb.remove(wb.active)
    for name, rows in sheets:
        ws = wb.create_sheet(name)
        for r in rows:
            ws.append(list(r))
    wb.save(path)


def scan(args):
    if '--include-comparatives' not in args:
        args = args + ['--include-comparatives', '0']
    r = subprocess.run([sys.executable, SCRIPT] + args,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out = r.stdout.decode('utf-8', 'replace')
    if r.returncode != 0:
        raise AssertionError('脚本退出码 %s：%s' % (r.returncode, r.stderr.decode('utf-8', 'replace')[:400]))
    return json.loads(out)


class FinanceScanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='fscan-test-')
        make_book(os.path.join(self.tmp, '审定报表-2023.xlsx'),
                  [('资', BALANCE_ROWS), ('利', INCOME_ROWS)])
        make_book(os.path.join(self.tmp, '审定报表-2022.xlsx'),
                  [('资', BALANCE_ROWS), ('利', INCOME_ROWS)])
        make_book(os.path.join(self.tmp, '说明.xlsx'), [('Sheet1', JUNK_ROWS)])
        # 干扰项：Excel 锁文件、非报表后缀
        with open(os.path.join(self.tmp, '~$tmp.xlsx'), 'wb') as f:
            f.write(b'not a workbook')
        with open(os.path.join(self.tmp, '无关.txt'), 'w', encoding='utf-8') as f:
            f.write('hello')

    def tearDown(self):
        for root, dirs, files in os.walk(self.tmp, topdown=False):
            for n in files:
                try:
                    os.remove(os.path.join(root, n))
                except OSError:
                    pass
            for n in dirs:
                try:
                    os.rmdir(os.path.join(root, n))
                except OSError:
                    pass
        try:
            os.rmdir(self.tmp)
        except OSError:
            pass

    def test_multi_file_multi_sheet(self):
        d = scan([self.tmp])
        self.assertTrue(d['ok'])
        self.assertEqual(d['summary']['fileCount'], 3)   # 两个报表 + 说明.xlsx
        self.assertEqual(d['summary']['packCount'], 4)   # 2 年 × (资 + 利)
        self.assertEqual(d['summary']['balanceYears'], [2022, 2023])
        self.assertEqual(d['summary']['incomeYears'], [2022, 2023])

    def test_comparative_is_separate_candidate_and_does_not_override_year(self):
        for year in (2022, 2023):
            make_book(os.path.join(self.tmp, '审定报表-%d.xlsx' % year),
                      [('资', [('%d年12月31日' % year,)] + BALANCE_ROWS), ('利', INCOME_ROWS)])
        d = scan([self.tmp, '--include-comparatives', '1'])
        prior = [p for p in d['packs'] if p.get('comparisonSource')]
        self.assertEqual(len(prior), 1)
        self.assertEqual(prior[0]['year'], 2021)
        self.assertEqual(prior[0]['sheetData']['reportYear'], 2021)
        self.assertIn('期初', prior[0]['period'])
        self.assertEqual(len([p for p in d['packs'] if p['statementType'] == 'balance_sheet' and p['year'] == 2022]), 1)

    def test_balance_comparative_requires_proven_date_and_column_order(self):
        cases = [
            ('missing-date', BALANCE_ROWS),
            ('reversed', [('2024年12月31日',), ('项目', '行次', '期初余额', '期末余额')] + BALANCE_ROWS[1:]),
            ('multi-group', [('2024年12月31日',),
                ('项目', '行次', '期末余额', '期初余额', '负债和所有者权益', '行次', '期初余额', '期末余额'),
                ('货币资金', 1, 1000, 900, '应付账款', 2, 400, 500),
                ('资产总计', 30, 1000, 900, '负债和所有者权益总计', 60, 900, 1000)]),
        ]
        for label, rows in cases:
            with self.subTest(label=label), tempfile.TemporaryDirectory(prefix='fscan-balance-safe-') as d:
                make_book(os.path.join(d, '报表-2024.xlsx'), [('资产负债表', rows)])
                result = scan([d, '--include-comparatives', '1'])
                self.assertEqual([p['year'] for p in result['packs']], [2024])
                self.assertFalse(any(p.get('comparisonSource') for p in result['packs']))

    def test_balance_comparative_rejects_header_filename_year_conflict(self):
        with tempfile.TemporaryDirectory(prefix='fscan-balance-year-') as d:
            rows = [('2025年12月31日',)] + BALANCE_ROWS
            make_book(os.path.join(d, '报表-2024.xlsx'), [('资产负债表', rows)])
            result = scan([d, '--include-comparatives', '1'])
            self.assertEqual([p['year'] for p in result['packs']], [2024])
            self.assertEqual(result['packs'][0]['originalPeriod'], '2025年12月31日')
            self.assertEqual(result['yearNotes'][0]['from'], 2025)
            self.assertEqual(result['yearNotes'][0]['to'], 2024)
            self.assertEqual(result['yearNotes'][0]['originalPeriod'], '2025年12月31日')
            self.assertTrue(result['yearNotes'][0]['requiresConfirmation'])
            self.assertFalse(result['needManual'])
            self.assertFalse(any(p.get('comparisonSource') for p in result['packs']))

    def test_income_annual_prior_period_candidate(self):
        with tempfile.TemporaryDirectory(prefix='fscan-income-prior-') as d:
            make_book(os.path.join(d, '公司25-评估.xlsx'), [('利润表', REAL_INCOME_ROWS)])
            result = scan([d, '--include-comparatives', '1'])
            candidate = next(p for p in result['packs'] if p.get('comparisonSource'))
            self.assertEqual(candidate['year'], 2024)
            self.assertEqual(candidate['sheetData']['reportYear'], 2024)
            self.assertEqual(candidate['statementType'], 'income_statement')
            amounts = {x['subjectName']: x['amount'] for x in candidate['sheetData']['detail']}
            self.assertEqual(amounts['营业收入'], 290735522.8)
            self.assertEqual(amounts['净利润'], 37286258.78)
            self.assertIn('上年同期', candidate['columns'][0]['label'])
            rows_2024 = list(REAL_INCOME_ROWS)
            rows_2024[1] = ('2024年度', '', '', '', '')
            make_book(os.path.join(d, '审定报表-2024.xlsx'), [('利润表', rows_2024)])
            result = scan([d, '--include-comparatives', '1'])
            self.assertFalse(any(p.get('comparisonSource') and p['year'] == 2024 for p in result['packs']))

    def test_income_comparative_rejects_header_filename_year_conflict(self):
        with tempfile.TemporaryDirectory(prefix='fscan-income-year-') as d:
            make_book(os.path.join(d, '公司24-评估.xlsx'), [('利润表', REAL_INCOME_ROWS)])
            result = scan([d, '--include-comparatives', '1'])
            self.assertEqual([p['year'] for p in result['packs']], [2024])
            self.assertEqual(result['packs'][0]['originalPeriod'], '2025年度')
            self.assertEqual(result['yearNotes'][0]['originalPeriod'], '2025年度')
            self.assertTrue(result['yearNotes'][0]['requiresConfirmation'])
            self.assertFalse(result['needManual'])
            self.assertFalse(any(p.get('comparisonSource') for p in result['packs']))

    def test_income_quarter_not_prior_annual_candidate(self):
        with tempfile.TemporaryDirectory(prefix='fscan-income-quarter-') as d:
            rows = list(REAL_INCOME_ROWS)
            rows[1] = ('2024年1-3月', '', '', '', '')
            make_book(os.path.join(d, '公司24-评估.xlsx'), [('利润表', rows)])
            result = scan([d, '--include-comparatives', '1'])
            self.assertFalse(any(p.get('comparisonSource') for p in result['packs']))

    def test_year_and_type_on_each_pack(self):
        d = scan([self.tmp])
        kinds = sorted((p['statementType'], p['year']) for p in d['packs'])
        self.assertEqual(kinds, [('balance_sheet', 2022), ('balance_sheet', 2023),
                                 ('income_statement', 2022), ('income_statement', 2023)])
        p = [x for x in d['packs'] if x['statementType'] == 'balance_sheet' and x['year'] == 2023][0]
        self.assertEqual(p['fileName'], '审定报表-2023.xlsx')
        self.assertEqual(p['sheet'], '资')
        self.assertIn('detail', p['sheetData'])
        self.assertTrue(any(x['subjectName'] for x in p['sheetData']['detail']))

    def test_unrecognized_sheet_needs_manual(self):
        d = scan([self.tmp])
        self.assertEqual(len(d['needManual']), 1)
        m = d['needManual'][0]
        self.assertEqual(m['fileName'], '说明.xlsx')
        self.assertEqual(m['sheet'], 'Sheet1')
        self.assertTrue(m['reason'])

    def test_force_skip_clears_manual(self):
        d = scan([self.tmp, '--force', json.dumps({'说明.xlsx::Sheet1': 'skip'})])
        self.assertEqual(d['needManual'], [])
        self.assertEqual(d['summary']['packCount'], 4)

    def test_force_kind_still_fails_without_header(self):
        d = scan([self.tmp, '--force', json.dumps({'说明.xlsx::Sheet1': 'income'})])
        self.assertEqual(len(d['needManual']), 1)
        self.assertIn('找不到', d['needManual'][0]['reason'])

    def test_duplicate_period_reported_as_conflict(self):
        make_book(os.path.join(self.tmp, '审定报表-2023-第二次.xlsx'),
                  [('资', BALANCE_ROWS), ('利', INCOME_ROWS)])
        d = scan([self.tmp])
        # 4 张仍只留一份 2023，另一个进 conflicts
        self.assertEqual(d['summary']['packCount'], 4)
        self.assertEqual(len(d['conflicts']), 2)
        for c in d['conflicts']:
            self.assertEqual(c['year'], 2023)
            self.assertEqual(c['kept'], '审定报表-2023-第二次.xlsx')
            self.assertEqual(c['dropped'], '审定报表-2023.xlsx')

    def test_bad_workbook_does_not_break_others(self):
        with open(os.path.join(self.tmp, 'bad.xlsx'), 'wb') as f:
            f.write(b'not a zip at all')
        d = scan([self.tmp])
        self.assertTrue(d['ok'])
        self.assertEqual(d['summary']['packCount'], 4)
        bad = [x for x in d['files'] if x['name'] == 'bad.xlsx'][0]
        self.assertTrue(bad['error'])

    def test_year_override_fills_missing_period(self):
        # 表头没有期间字样、文件名也没有年份：能解析但年度读不出 → needManual.needYear
        make_book(os.path.join(self.tmp, '客户给的报表.xlsx'), [('资', BALANCE_ROWS)])
        d = scan([self.tmp])
        self.assertEqual(d['summary']['packCount'], 4)          # 只有那份报表读不出年度
        m = [x for x in d['needManual'] if x['fileName'] == '客户给的报表.xlsx'][0]
        self.assertTrue(m.get('needYear'))
        self.assertEqual(m['kind'], 'balance')

        # 人工补一个年度（只给 year，分类沿用自动认出的）→ 成 pack
        d2 = scan([self.tmp, '--force', json.dumps(
            {'客户给的报表.xlsx::资': {'year': 2021}})])
        got = [p for p in d2['packs'] if p['fileName'] == '客户给的报表.xlsx']
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]['year'], 2021)
        self.assertEqual(got[0]['statementType'], 'balance_sheet')
        self.assertEqual([x for x in d2['needManual'] if x['fileName'] == '客户给的报表.xlsx'], [])

    def test_real_layout_without_line_column(self):
        """真实报表：没有「行次」、首列写「资  产」、最右夹科目编码、日期是 Excel 序列号。"""
        d = tempfile.mkdtemp(prefix='fscan-real-')
        try:
            make_book(os.path.join(d, '瑞明公司25-评估.xlsx'),
                      [('资产负债表', REAL_BALANCE_ROWS), ('利润表', REAL_INCOME_ROWS)])
            out = scan([d])
            self.assertEqual(out['summary']['packCount'], 2)
            self.assertEqual(out['needManual'], [])
            b = [p for p in out['packs'] if p['statementType'] == 'balance_sheet'][0]
            # 文件名里的 25 → 2025；期间从 Excel 序列号解出来
            self.assertEqual(b['year'], 2025)
            self.assertIn('2025', b['period'])
            names = [x['subjectName'] for x in b['sheetData']['detail']]
            self.assertIn('货币资金', names)
            self.assertIn('应收账款', names)
            # 科目编码（911010）不能被当成金额
            amt = {x['subjectName']: x['amount'] for x in b['sheetData']['detail']}
            self.assertAlmostEqual(amt['货币资金'], 22808353.73, places=2)
            i = [p for p in out['packs'] if p['statementType'] == 'income_statement'][0]
            iamt = {x['subjectName']: x['amount'] for x in i['sheetData']['detail']}
            self.assertAlmostEqual(iamt['营业收入'], 210705654.8, places=2)
        finally:
            for root, dirs, files in os.walk(d, topdown=False):
                for n in files:
                    os.remove(os.path.join(root, n))
                for n in dirs:
                    os.rmdir(os.path.join(root, n))
            os.rmdir(d)

    def test_wrong_header_year_corrected_everywhere(self):
        """表头年份写错时按文件名纠正，且 pack.year / period / sheetData.reportYear 三处必须一致。"""
        d = tempfile.mkdtemp(prefix='fscan-year-')
        try:
            # 文件名叫 24，但表头写的是 2023 年（客户的真实情况）
            make_book(os.path.join(d, '公司24-评估.xlsx'),
                      [('资产负债表', REAL_BALANCE_ROWS), ('利润表', REAL_INCOME_ROWS)])
            out = scan([d])
            self.assertEqual(out['summary']['packCount'], 2)
            self.assertEqual(len(out['yearNotes']), 2)     # 资产/利润各纠正一次
            for p in out['packs']:
                self.assertEqual(p['year'], 2024)                       # 按文件名
                self.assertEqual(p['sheetData']['reportYear'], 2024)     # 真正写给天源的字段
                self.assertIn('2024', p['period'])                      # 期间列也不能留错的
                self.assertNotIn('2023', p['period'])
        finally:
            for root, dirs, files in os.walk(d, topdown=False):
                for n in files:
                    os.remove(os.path.join(root, n))
                for n in dirs:
                    os.rmdir(os.path.join(root, n))
            os.rmdir(d)

    def test_empty_dir(self):
        empty = tempfile.mkdtemp(prefix='fscan-empty-')
        try:
            d = scan([empty])
            self.assertTrue(d['ok'])
            self.assertEqual(d['summary']['fileCount'], 0)
            self.assertEqual(d['packs'], [])
        finally:
            os.rmdir(empty)


if __name__ == '__main__':
    unittest.main()
