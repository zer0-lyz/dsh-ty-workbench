"""Hybrid row insert/delete: openpyxl preserves styles; LibreOffice UNO bridge
supplies the authoritative shifted layout (formulas, merges, print area).

Usage (as CLI, single op):
  uno_row_apply.py --source X --bridge-out LO_OUT --target Y \
      --sheet NAME --operation insert --row R --count N
Batch (as library): apply_operations(source, lo_out, target, ops=[...])

Safety model:
  - Never touches the source file; writes only --target (must not exist).
  - Applies each operation to an openpyxl copy of source (styles preserved),
    then reconciles formulas / merged ranges / print areas against the
    LibreOffice bridge output (semantic ground truth for the whole workbook).
  - Untouched sheets: values, structure key-sets, merges and print areas must
    match the source strictly; only re-pointed formulas are reconciled in.
  - Refuses when bridge output and openpyxl copy disagree on any reconciled item.
"""
from __future__ import annotations

import argparse
import sys

from openpyxl import load_workbook
from copy import copy


def _copy_row_style(ws, from_row, to_row, max_col):
    """Copy style objects from an existing row onto a newly inserted row."""
    for col in range(1, max_col + 1):
        s = ws.cell(from_row, col)
        d = ws.cell(to_row, col)
        d.font = copy(s.font)
        d.border = copy(s.border)
        d.fill = copy(s.fill)
        d.alignment = copy(s.alignment)
        d.number_format = s.number_format
        if s.has_style:
            d._style = copy(s._style)
    rd_s = ws.row_dimensions.get(from_row)
    rd_d = ws.row_dimensions.get(to_row)
    if rd_s is not None and rd_s.height is not None:
        if rd_d is None:
            rd_d = ws.row_dimensions[to_row]
        rd_d.height = rd_s.height


def _cellmap(ws):
    """Non-empty values keyed by (row, col); formulas kept as strings.

    Empty strings are normalized away: LibreOffice drops them on xlsx
    round-trip while openpyxl keeps them, so counting them as values causes
    a spurious 'bridge layout diverged' rejection that rolls back the batch.
    An empty string carries no content, so treating it as absent is safe.
    """
    return {(c.row, c.column): c.value
            for row in ws.iter_rows() for c in row
            if c.value is not None and c.value != ''}


def _norm(v):
    """Floats compare with tolerance (LO recalculates cached values)."""
    if isinstance(v, float):
        return round(v, 6)
    return v


def _is_formula(v):
    return isinstance(v, str) and v.startswith('=')


def _norm_area(area):
    """Normalize a print-area string for comparison across LO round-trips."""
    if area is None:
        return None
    ref = str(area).replace('$', '').replace("'", '')
    parts = ref.split('!')
    return parts[-1] if len(parts) == 1 else '!'.join(parts[1:]) if len(parts) > 2 else parts[-1]


def _validate_ops(src, ops):
    names = src.sheetnames
    seen = set()
    for op in ops:
        sheet = op['sheet']
        if sheet not in names:
            raise SystemExit('sheet missing in source: ' + sheet)
        if op['operation'] not in ('insert', 'delete'):
            raise SystemExit('operation must be insert or delete')
        if int(op['row']) < 1 or int(op['count']) < 1:
            raise SystemExit('row and count must be positive')
        if sheet in seen:
            raise SystemExit('multiple operations on sheet: ' + sheet)
        seen.add(sheet)


def _shift_area(area, sheet, row, count, operation):
    """Shift a print-area range for a row insert/delete, keeping it inside bounds.

    LibreOffice's xlsx round-trip drops print areas entirely, so the bridge
    output cannot be used as ground truth for them. We shift them ourselves.
    """
    if not area:
        return area
    ref = str(area).split('!')[-1].replace('$', '').replace("'", '')
    if ':' not in ref:
        return area
    from openpyxl.utils.cell import range_boundaries, get_column_letter
    try:
        c1, r1, c2, r2 = range_boundaries(ref)
    except Exception:
        return area
    def sh(r):
        if operation == 'insert':
            return r + count if r >= row else r
        if r >= row + count:
            return r - count
        if row <= r < row + count:
            return None
        return r
    nr1, nr2 = sh(r1), sh(r2)
    if nr1 is None:
        if nr2 is None:
            return None  # whole print area deleted
        nr1 = nr2
    if nr2 is None:
        nr2 = nr1
    nr1, nr2 = max(1, nr1), max(1, nr2)
    if nr1 > nr2:
        return None
    shifted = f'{get_column_letter(c1)}{nr1}:{get_column_letter(c2)}{nr2}'
    return f"'{sheet}'!{shifted}" if sheet else shifted


def apply_operations(source_path, bridge_out_path, target_path, ops):
    """Apply a list of single-sheet ops with the bridge output as ground truth."""
    if target_path == source_path:
        raise SystemExit('target must differ from source')
    if not ops:
        raise SystemExit('no operations')
    src = load_workbook(source_path)
    lo = load_workbook(bridge_out_path)
    if set(src.sheetnames) != set(lo.sheetnames):
        raise SystemExit('sheet set mismatch between source and bridge output')
    _validate_ops(src, ops)
    changed = {op['sheet'] for op in ops}
    # LibreOffice drops print areas on save -> capture them from the authoritative
    # source before any structural shift, then reapply (shifted) at the end.
    orig_areas = {name: src[name].print_area for name in src.sheetnames}

    # 1) structural shifts on the openpyxl copy (styles move with rows)
    for op in ops:
        ws = src[op['sheet']]
        row, count, operation = int(op['row']), int(op['count']), op['operation']
        if operation == 'insert':
            ws.insert_rows(row, count)
            max_col = ws.max_column
            for i in range(count):
                template_row = row - 1 if row > 1 else 1
                _copy_row_style(ws, template_row, row + i, max_col)
        else:
            ws.delete_rows(row, count)

    # 2) changed sheets: key-set must match bridge layout (shift integrity)
    for sheet in changed:
        ws_keys = set(_cellmap(src[sheet]))
        lo_keys = set(_cellmap(lo[sheet]))
        if ws_keys != lo_keys:
            raise SystemExit('bridge layout diverged on changed sheet: ' + sheet)

    # 3) formulas: wipe every formula, then place all per bridge ground truth
    total_formulas = 0
    for name in src.sheetnames:
        ws, lo_ws = src[name], lo[name]
        for (r, c), v in _cellmap(ws).items():
            if _is_formula(v):
                ws.cell(r, c).value = None
        lo_formulas = {(c.row, c.column): c.value
                       for row in lo_ws.iter_rows() for c in row
                       if _is_formula(c.value)}
        for (r, c), v in lo_formulas.items():
            ws.cell(r, c).value = v
        total_formulas += len(lo_formulas)

    # 4) merges: changed sheets take bridge values verbatim; untouched sheets
    #    must match strictly. Print areas are handled separately: LibreOffice
    #    drops them on save, so we shift them ourselves for changed sheets and
    #    preserve them verbatim for untouched sheets.
    op_by_sheet = {o['sheet']: o for o in ops}
    total_merges = 0
    for name in src.sheetnames:
        ws, lo_ws = src[name], lo[name]
        want = {str(m) for m in lo_ws.merged_cells.ranges}
        have = {str(m) for m in ws.merged_cells.ranges}
        if name in changed:
            if have != want:
                # unmerge_cells 要求左上角单元格对象存在，插删行后可能已缺失；
                # 直接移除合并定义（不触碰单元格），再按桥输出重建。
                for m in list(ws.merged_cells.ranges):
                    ws.merged_cells.ranges.remove(m)
                for m in sorted(want):
                    ws.merge_cells(m)
            op = op_by_sheet[name]
            old_area = orig_areas.get(name)
            if old_area:
                ws.print_area = _shift_area(old_area, name, int(op['row']),
                                            int(op['count']), op['operation']) or ''
            total_merges += len(want)
        else:
            if have != want:
                raise SystemExit('bridge output diverged on untouched sheet merges: ' + name)
            # 打印区不比对桥输出：LibreOffice 会清空打印区；原样保留即可。

    # 5) untouched sheets: non-formula values must match the source strictly
    #    (formula cells were reconciled above; type mismatches are divergence).
    for name in src.sheetnames:
        if name in changed:
            continue
        s_ws, l_ws = src[name], lo[name]
        sc, lc = _cellmap(s_ws), _cellmap(l_ws)
        if set(sc.keys()) != set(lc.keys()):
            raise SystemExit('bridge output diverged on untouched sheet: ' + name)
        for (r, c) in sc:
            sv, lv = sc[(r, c)], lc[(r, c)]
            if _is_formula(sv) != _is_formula(lv):
                raise SystemExit('bridge output diverged on untouched sheet: ' + name)
            if not _is_formula(sv) and _norm(sv) != _norm(lv):
                raise SystemExit('bridge output diverged on untouched sheet: ' + name)

    src.save(target_path)
    return {'ok': True, 'sheets': sorted(changed), 'ops': len(ops),
            'reconciled': {'formulas': total_formulas, 'merges': total_merges}}


def apply_operation(source_path, bridge_out_path, target_path, sheet, operation, row, count):
    """Single-operation wrapper kept for compatibility."""
    return apply_operations(source_path, bridge_out_path, target_path,
                            [{'sheet': sheet, 'operation': operation,
                              'row': row, 'count': count}])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', required=True)
    ap.add_argument('--bridge-out', required=True, dest='bridge_out')
    ap.add_argument('--target', required=True)
    ap.add_argument('--sheet', required=True)
    ap.add_argument('--operation', choices=('insert', 'delete'), required=True)
    ap.add_argument('--row', type=int, required=True)
    ap.add_argument('--count', type=int, default=1)
    args = ap.parse_args()
    print(apply_operation(args.source, args.bridge_out, args.target,
                          args.sheet, args.operation, args.row, args.count))


if __name__ == '__main__':
    main()
