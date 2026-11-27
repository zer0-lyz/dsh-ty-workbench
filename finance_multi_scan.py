# -*- coding: utf-8 -*-
"""Read-only identification of unallocated project financial documents.

CLI: python -B finance_multi_scan.py DIRECTORY --companies '[{"id":"1","name":"公司全称"}]'
All company and folder suggestions require human confirmation. Never copies/moves files.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import unicodedata

sys.dont_write_bytecode = True
MAX_FILES = 100
MAX_FILE_BYTES = 50 * 1024 * 1024
EXCEL_EXTENSIONS = {'.xls', '.xlsx', '.xlsm'}
COMMON_EXTENSIONS = EXCEL_EXTENSIONS | {'.csv', '.pdf', '.docx'}
# Exact folder names supplied by the integrating application; unconfirmed types remain manual.
FOLDER_PATTERNS = {'01财务报表': ('资产负债表', '利润表', '损益表', '收益表'),
                   '02审计报告': ('审计报告',),
                   '02科目余额表': ('科目余额表',),
                   '03辅助余额表': ('辅助余额表',),
                   '04序时账': ('序时账',)}


def normalize_name(value):
    return ''.join(unicodedata.normalize('NFKC', value).split()).casefold()


def validate_companies(companies):
    if not isinstance(companies, list):
        raise ValueError('companies 必须是 JSON 数组')
    ids = set()
    for company in companies:
        if (not isinstance(company, dict) or not isinstance(company.get('id'), (str, int))
                or isinstance(company.get('id'), bool) or not str(company['id']).strip()
                or not isinstance(company.get('name'), str) or not normalize_name(company['name'])):
            raise ValueError('每个公司必须包含非空 id 和 name')
        if str(company['id']) in ids:
            raise ValueError('公司 id 重复：' + str(company['id']))
        ids.add(str(company['id']))
    return companies


def file_hash(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _matches(value, companies, exact):
    value = normalize_name(value)
    return [str(c['id']) for c in companies if normalize_name(c['name']) and
            (value == normalize_name(c['name']) if exact else normalize_name(c['name']) in value)]


def company_evidence(rows, companies, sheet):
    evidence = []
    for ri, row in enumerate(rows[:12]):
        for ci, cell in enumerate(row):
            if not isinstance(cell, str):
                continue
            match = re.match(r'^(?:编制单位|单位名称|公司名称)\s*[:：]?\s*(.*)$', unicodedata.normalize('NFKC', cell).strip())
            if not match:
                continue
            value = match.group(1).strip()
            value_col = ci
            if not value and ci + 1 < len(row) and isinstance(row[ci + 1], str):
                value = row[ci + 1].strip()
                value_col = ci + 1
            evidence.append({'source': 'header', 'sheet': sheet, 'row': ri + 1,
                             'column': ci + 1, 'valueColumn': value_col + 1,
                             'value': value, 'candidates': _matches(value, companies, True)})
    return evidence


def classification_evidence(value, source, sheet=None):
    value = str(value or '')
    normalized = normalize_name(value)
    evidence = []
    for folder, patterns in FOLDER_PATTERNS.items():
        for pattern in patterns:
            if normalize_name(pattern) in normalized:
                evidence.append({'source': source, 'sheet': sheet, 'value': value,
                                 'kind': pattern, 'folder': folder})
    return evidence


def company_result(evidence):
    matched = {candidate for e in evidence for candidate in e['candidates']}
    bad_header = any(e['source'] == 'header' and len(e['candidates']) != 1 for e in evidence)
    conflict = len(matched) > 1 or (bool(matched) and bad_header)
    status = 'conflict' if conflict else 'suggested' if len(matched) == 1 and not bad_header else 'unrecognized'
    return {'status': status, 'suggestedCompany': next(iter(matched)) if status == 'suggested' else '',
            'candidates': sorted(matched), 'evidence': evidence, 'requiresConfirmation': True}


def classification_result(evidence):
    folders = sorted({e['folder'] for e in evidence})
    status = 'conflict' if len(folders) > 1 else 'suggested' if folders else 'unrecognized'
    return {'status': status, 'suggestedFolder': folders[0] if status == 'suggested' else '',
            'candidates': folders, 'evidence': evidence, 'requiresConfirmation': True}


def read_headers(path):
    """Read up to 12 rows per Excel sheet; return independent sheet errors."""
    if path.lower().endswith('.xls'):
        import xlrd
        book = xlrd.open_workbook(path, on_demand=True)
        try:
            result = []
            for name in book.sheet_names():
                try:
                    sheet = book.sheet_by_name(name)
                    rows = [sheet.row_values(i) for i in range(min(12, sheet.nrows))]
                    result.append((name, rows, ''))
                except Exception as exc:
                    result.append((name, [], '%s: %s' % (type(exc).__name__, exc)))
            return result
        finally:
            book.release_resources()
    from openpyxl import load_workbook
    book = load_workbook(path, read_only=True, data_only=True, keep_links=False)
    try:
        result = []
        for name in book.sheetnames:
            try:
                rows = [list(row) for row in book[name].iter_rows(min_row=1, max_row=12, values_only=True)]
                result.append((name, rows, ''))
            except Exception as exc:
                result.append((name, [], '%s: %s' % (type(exc).__name__, exc)))
        return result
    finally:
        book.close()


def scan_directory(directory, companies):
    validate_companies(companies)
    root = os.path.realpath(os.path.abspath(os.fspath(directory)))
    if not os.path.isdir(root):
        raise ValueError('目录不存在：' + root)
    files = []
    for name in sorted(os.listdir(root)):
        path = os.path.join(root, name)
        link = os.path.islink(path)
        if not link and not os.path.isfile(path):
            continue
        ext = os.path.splitext(name)[1].lower()
        item = {'id': hashlib.sha256(path.encode('utf-8')).hexdigest(), 'name': name,
                'path': path, 'extension': ext, 'size': 0, 'sourceHash': None, 'error': '',
                'company': company_result([]), 'classification': classification_result([]), 'sheets': []}
        files.append(item)
        if link:
            item['error'] = '符号链接未扫描（避免越界）'
            continue
        if len(files) > MAX_FILES:
            item['error'] = '超过单次文件数上限 %d，未扫描' % MAX_FILES
            continue
        try:
            item['size'] = os.path.getsize(path)
            if item['size'] > MAX_FILE_BYTES:
                item['error'] = '超过单文件大小上限 %d 字节，未扫描' % MAX_FILE_BYTES
                continue
            before = file_hash(path)
            ce = []
            filename_matches = _matches(name, companies, False)
            if filename_matches:
                ce.append({'source': 'filename', 'value': name, 'candidates': filename_matches})
            te = classification_evidence(name, 'filename') if ext in COMMON_EXTENSIONS else []
            if ext in EXCEL_EXTENSIONS:
                for sheet, rows, error in read_headers(path):
                    sheet_ce = company_evidence(rows, companies, sheet)
                    sheet_te = classification_evidence(sheet, 'sheet', sheet)
                    for row in rows:
                        for value in row:
                            if isinstance(value, str):
                                sheet_te.extend(classification_evidence(value, 'header', sheet))
                    item['sheets'].append({'sheet': sheet, 'error': error,
                                           'companyEvidence': sheet_ce, 'classificationEvidence': sheet_te})
                    ce.extend(sheet_ce)
                    te.extend(sheet_te)
            after = file_hash(path)
            if before != after:
                raise ValueError('文件在扫描期间发生变化，结果已丢弃')
            item['sourceHash'] = before
            item['company'] = company_result(ce)
            item['classification'] = classification_result(te)
            if any(sheet['error'] for sheet in item['sheets']):
                item['company']['status'] = 'incomplete'
                item['company']['suggestedCompany'] = ''
                item['classification']['status'] = 'incomplete'
                item['classification']['suggestedFolder'] = ''
        except Exception as exc:
            item['error'] = '%s: %s' % (type(exc).__name__, exc)
            item['sheets'] = []
            item['sourceHash'] = None
    return {'ok': True, 'dir': root, 'limits': {'maxFiles': MAX_FILES, 'maxFileBytes': MAX_FILE_BYTES},
            'files': files, 'summary': {'fileCount': len(files),
            'scannedCount': sum(not f['error'] for f in files), 'errorCount': sum(bool(f['error']) for f in files)}}


def main(argv=None):
    parser = argparse.ArgumentParser(description='只读识别项目未分配财务资料')
    parser.add_argument('directory')
    parser.add_argument('--companies', required=True)
    args = parser.parse_args(argv)
    try:
        result = scan_directory(args.directory, json.loads(args.companies))
    except (ValueError, OSError) as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, default=str))
    return 0


if __name__ == '__main__':
    sys.exit(main())
