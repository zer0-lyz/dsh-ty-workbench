# -*- coding: utf-8 -*-
"""Tests use synthetic files and temporary directories only."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from openpyxl import Workbook
import finance_multi_scan as scan

COMPANIES = [{'id': 'a', 'name': '甲有限公司'}, {'id': 'b', 'name': '乙有限公司'}]
HERE = os.path.dirname(os.path.abspath(__file__))


def workbook(path, sheets):
    book = Workbook()
    book.remove(book.active)
    for name, rows in sheets:
        ws = book.create_sheet(name)
        for row in rows:
            ws.append(row)
    book.save(path)
    book.close()


class ProjectScanTests(unittest.TestCase):
    def test_header_and_normalization(self):
        for label in ('编制单位', '单位名称', '公司名称'):
            evidence = scan.company_evidence([[label, '甲 有限公司']], COMPANIES, '报表')
            self.assertEqual(scan.company_result(evidence)['suggestedCompany'], 'a')
        self.assertEqual(scan.company_evidence([['单位：元']], COMPANIES, '表'), [])
        evidence = scan.company_evidence([['编制单位', None, '甲有限公司']], COMPANIES, '表')
        self.assertEqual(scan.company_result(evidence)['suggestedCompany'], '')
        self.assertEqual(scan.company_evidence([[]] * 12 + [['编制单位：甲有限公司']], COMPANIES, '表'), [])

    def test_formats_company_conflicts_and_read_only(self):
        with tempfile.TemporaryDirectory() as root:
            workbook(os.path.join(root, '混合.xlsx'), [
                ('资产负债表', [['编制单位：甲有限公司']]),
                ('利润表', [['编制单位', '乙有限公司']])])
            workbook(os.path.join(root, '甲有限公司-资产负债表.xlsx'),
                     [('表', [['单位名称', '乙有限公司']])])
            for name in ('甲有限公司审计报告.pdf', '乙有限公司科目余额表.csv',
                         '甲有限公司辅助余额表.docx', '乙有限公司序时账.xlsm', '其他.bin', '损坏.xls'):
                with open(os.path.join(root, name), 'wb') as f:
                    f.write(b'not an excel workbook')
            before = {n: scan.file_hash(os.path.join(root, n)) for n in os.listdir(root)}
            result = scan.scan_directory(root, COMPANIES)
            files = {f['name']: f for f in result['files']}
            self.assertEqual(set(files), set(before))
            self.assertEqual(files['混合.xlsx']['company']['status'], 'conflict')
            self.assertEqual(len(files['混合.xlsx']['sheets']), 2)
            self.assertEqual(files['混合.xlsx']['classification']['suggestedFolder'], '01财务报表')
            self.assertEqual(files['甲有限公司-资产负债表.xlsx']['company']['status'], 'conflict')
            self.assertEqual(files['甲有限公司审计报告.pdf']['classification']['suggestedFolder'], '02审计报告')
            self.assertEqual(files['乙有限公司科目余额表.csv']['classification']['suggestedFolder'], '02科目余额表')
            self.assertEqual(files['甲有限公司辅助余额表.docx']['classification']['suggestedFolder'], '03辅助余额表')
            self.assertTrue(files['乙有限公司序时账.xlsm']['error'])
            self.assertTrue(files['损坏.xls']['error'])
            self.assertEqual(files['其他.bin']['classification']['status'], 'unrecognized')
            self.assertTrue(all(f['company']['requiresConfirmation'] and f['classification']['requiresConfirmation'] for f in files.values()))
            self.assertEqual(before, {n: scan.file_hash(os.path.join(root, n)) for n in os.listdir(root)})
            self.assertEqual([x['id'] for x in result['files']], [x['id'] for x in scan.scan_directory(root, COMPANIES)['files']])

    def test_same_name_ambiguous_and_conflicting_classes(self):
        companies = COMPANIES + [{'id': 'c', 'name': '甲 有限公司'}]
        evidence = scan.company_evidence([['编制单位：甲有限公司']], companies, '表')
        result = scan.company_result(evidence)
        self.assertEqual(result['status'], 'conflict')
        self.assertEqual(result['suggestedCompany'], '')
        evidence = scan.classification_evidence('甲资产负债表和审计报告.pdf', 'filename')
        result = scan.classification_result(evidence)
        self.assertEqual(result['status'], 'conflict')
        self.assertEqual(result['suggestedFolder'], '')

    def test_links_limits_and_changed_file(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as external:
            p = os.path.join(root, 'a.csv')
            with open(p, 'w') as f:
                f.write('one')
            os.symlink(external, os.path.join(root, '目录链接'))
            os.symlink(p, os.path.join(root, '文件链接.csv'))
            with mock.patch.object(scan, 'MAX_FILE_BYTES', 2):
                result = scan.scan_directory(root, COMPANIES)
            self.assertTrue(all(f['error'] for f in result['files']))
            self.assertEqual(len(result['files']), 3)
            with mock.patch.object(scan, 'MAX_FILES', 0):
                result = scan.scan_directory(root, COMPANIES)
            self.assertIn('文件数上限', result['files'][0]['error'])
            calls = 0
            real = scan.file_hash
            def changed(path):
                nonlocal calls
                calls += 1
                return 'different' if calls == 2 else real(path)
            with mock.patch.object(scan, 'file_hash', side_effect=changed):
                result = scan.scan_directory(root, COMPANIES)
            self.assertIn('发生变化', result['files'][0]['error'])
            self.assertIsNone(result['files'][0]['sourceHash'])

    def test_cli_and_validation(self):
        with tempfile.TemporaryDirectory() as root:
            cmd = [sys.executable, '-B', os.path.join(HERE, 'finance_multi_scan.py'), root, '--companies']
            result = subprocess.run(cmd + [json.dumps(COMPANIES, ensure_ascii=False)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(json.loads(result.stdout)['ok'])
            result = subprocess.run(cmd + ['{}'], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(json.loads(result.stdout)['ok'])
            with self.assertRaises(ValueError):
                scan.validate_companies([{'id': 'a', 'name': '甲'}, {'id': 'a', 'name': '乙'}])


if __name__ == '__main__':
    unittest.main()
