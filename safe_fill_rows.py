"""Safe fill-rows orchestrator: row_plan (structure) + LibreOffice UNO bridge
(shift semantics, one session for the whole workbook) + uno_row_apply (styles).
Fail-closed: any uncertainty means the sheet is skipped and reported; the input
workbook is never modified.

CLI: safe_fill_rows.py --workbook STAGE --output NEW.xlsx --kind detail|declare \
       --java-home ... --soffice ... --uno-jars ... [--uno-bridge PATH]

Output: JSON {ok, changed:[{sheet,op,rows}], skipped:[{sheet,reason,extra}]}
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from zipfile import ZipFile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

MAX_ROWS_PER_SHEET = 20
A4_SHORT_PT = 595.276  # landscape A4 printable height base
SUPPORTED_KINDS = ('detail', 'declare')


def _print_rows(ws):
    """Row bounds of ws.print_area, or None."""
    area = ws.print_area
    if not area:
        return None
    try:
        ref = str(area).split('!')[-1].replace('$', '')
        a, b = ref.split(':')
        from openpyxl.utils.cell import range_boundaries
        _, r1, _, r2 = range_boundaries(f'{a}:{b}')
        return r1, r2
    except Exception:
        return None


def _row_height(ws, r):
    rd = ws.row_dimensions.get(r)
    if rd is not None and rd.height is not None:
        return rd.height
    return ws.sheet_format.defaultRowHeight or 15.0


def _gap_pt(ws):
    """Positive = how many points of blank space remain under content."""
    rows = _print_rows(ws)
    if not rows:
        return None
    margins = ws.page_margins
    cap = A4_SHORT_PT - (margins.top + margins.bottom) * 72.0
    content = sum(_row_height(ws, r) for r in range(rows[0], rows[1] + 1))
    return cap - content


def plan_visible_sheets(wb):
    """Plan insert/delete ops for visible sheets only; hidden sheets are skipped.

    Returns (plans, skipped) where plans is a list of
    (sheet_title, plan, gap_pt, template_row_height) tuples.
    Kept separate from fill_workbook so the visible-only gate is unit-testable
    without LibreOffice.
    """
    import row_plan
    plans, skipped = [], []
    for ws in wb.worksheets:
        # 只对显示状态的工作表做格式/增删行处理；隐藏表一律跳过。
        # 与打印格式脚本（detail 407-408 / declare 940）保持一致。
        if ws.sheet_state != 'visible':
            skipped.append({'sheet': ws.title, 'reason': 'hidden_sheet'})
            continue
        plan = row_plan.plan_sheet(ws)
        if plan.get('status') != 'proposal':
            skipped.append({'sheet': ws.title, 'reason': plan.get('reason', 'skip')})
            continue
        gap = _gap_pt(ws)
        if gap is None:
            skipped.append({'sheet': ws.title, 'reason': 'no_print_area'})
            continue
        template_h = _row_height(ws, plan['first_subtotal_row'] - 1)
        plans.append((ws.title, plan, gap, template_h))
    return plans, skipped


def fill_workbook(workbook, output, kind, java_home, soffice, uno_jars, bridge=None,
                  timeout=300):
    import row_plan
    import uno_row_apply
    # 结构规则按底部合计块通用识别，明细表与申报表同一逻辑；其余类型不执行。
    if kind not in SUPPORTED_KINDS:
        return {'ok': True, 'changed': [], 'skipped': [
            {'sheet': '*', 'reason': 'fill_disabled_for_kind:' + str(kind)}]}
    # 桥以 Calc xlsx 过滤器保存，xlsm 的宏会丢失；含宏工作簿一律跳过（fail-closed）。
    if Path(workbook).suffix.lower() == '.xlsm':
        return {'ok': True, 'changed': [], 'skipped': [
            {'sheet': '*', 'reason': 'unsupported_format_xlsm'}]}
    bridge = Path(bridge) if bridge else Path(
        '/Users/lin/Library/CloudStorage/OneDrive-个人/共享/DeepSeek/个人工作台/uno_print_rows/row_bridge.py')
    for exe in (Path(java_home) / 'bin' / 'java', Path(java_home) / 'bin' / 'javac',
                Path(soffice)):
        if not exe.exists():
            return {'ok': False, 'changed': [], 'skipped': [
                {'sheet': '*', 'reason': f'bridge_unavailable: {exe}'}]}
    src_sha = hashlib.sha256(Path(workbook).read_bytes()).hexdigest()

    changed, skipped, ops = [], [], []
    with tempfile.TemporaryDirectory(prefix='safe-fill-') as td:
        td = Path(td)
        base = td / 'base.xlsx'
        shutil.copyfile(workbook, base)
        from openpyxl import load_workbook
        wb = load_workbook(base)  # read-only planning pass on the copy
        plans, plan_skips = plan_visible_sheets(wb)
        skipped.extend(plan_skips)
        wb.close()

        for sheet, plan, gap, template_h in plans:
            delta = 0
            op = None
            if gap > 0.5 and template_h > 0:
                delta = min(int(gap // template_h), MAX_ROWS_PER_SHEET)
                op = 'insert'
            elif gap < -0.5 and plan.get('delete_run'):
                delta = min(int(-gap // template_h) + 1, len(plan['delete_run']), MAX_ROWS_PER_SHEET)
                op = 'delete'
            if not delta or not op:
                skipped.append({'sheet': sheet, 'reason': 'gap_within_one_row',
                                'gap_pt': round(gap, 1)})
                continue
            anchor = plan['insert_before'] if op == 'insert' else plan['delete_run'][0]
            ops.append({'sheet': sheet, 'operation': op, 'row': anchor, 'count': delta})

        if ops:
            ops_file = td / 'ops.json'
            ops_file.write_text(json.dumps(ops, ensure_ascii=False), encoding='utf-8')
            lo_out = td / 'lo.xlsx'
            args = ['--java-home', java_home, '--soffice', soffice,
                    '--uno-jars', uno_jars, '--source', str(base),
                    '--target', str(lo_out), '--ops-file', str(ops_file),
                    '--timeout', str(timeout)]
            try:
                r = subprocess.run([sys.executable, str(bridge)] + args,
                                   capture_output=True, text=True, timeout=timeout + 60)
            except subprocess.TimeoutExpired:
                skipped.append({'sheet': '*', 'reason': 'bridge_timeout'})
                ops = []
                r = None
            if r is None or r.returncode != 0 or not lo_out.exists():
                skipped.append({'sheet': '*', 'reason': 'bridge_failed',
                                'detail': (r.stderr or '').strip()[-200:]})
                ops = []
            else:
                out = td / 'out.xlsx'
                try:
                    uno_row_apply.apply_operations(str(base), str(lo_out), str(out), ops)
                except SystemExit as e:
                    skipped.append({'sheet': '*', 'reason': 'apply_rejected',
                                    'detail': str(e)[:200]})
                    ops = []
                else:
                    with ZipFile(out) as z:
                        if z.testzip() is not None:
                            skipped.append({'sheet': '*', 'reason': 'zip_corrupt'})
                            ops = []
                        else:
                            shutil.copyfile(out, base)
                            changed = [{'sheet': o['sheet'], 'op': o['operation'],
                                        'rows': o['count']} for o in ops]

        if changed:
            shutil.copyfile(base, output)
    final_sha = hashlib.sha256(Path(workbook).read_bytes()).hexdigest()
    if final_sha != src_sha:
        return {'ok': False, 'changed': [], 'skipped': [
            {'sheet': '*', 'reason': 'input_was_modified'}]}
    return {'ok': True, 'changed': changed, 'skipped': skipped}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--workbook', required=True)
    ap.add_argument('--output', required=True)
    ap.add_argument('--kind', required=True, choices=list(SUPPORTED_KINDS))
    ap.add_argument('--java-home', required=True)
    ap.add_argument('--soffice', required=True)
    ap.add_argument('--uno-jars', required=True)
    ap.add_argument('--bridge')
    ap.add_argument('--timeout', type=int, default=300)
    args = ap.parse_args()
    print(json.dumps(fill_workbook(args.workbook, args.output, args.kind,
                                   args.java_home, args.soffice, args.uno_jars,
                                   args.bridge, timeout=args.timeout), ensure_ascii=False))


if __name__ == '__main__':
    main()
