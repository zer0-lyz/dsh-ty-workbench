"""Read-only structural proposals using a generic bottom-total-block rule.

A sheet qualifies when its print area ends in a summary footer: a bottom-most
'合计/小计' labelled row whose rows down to the print-area end contain only
label text, formulas or blanks. Insertion happens at the footer's first row
(just above the label), so blank filler rows land outside business SUM ranges
(verified: the boundary row's SUM must end at or before boundary-1).

A proposal is NOT authorization or an executable edit plan. Formula/reference,
package-feature and calculation compatibility must be verified separately by
the LibreOffice bridge + reconciliation pass.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.utils.cell import get_column_letter, range_boundaries


def _normal(value):
    return re.sub(r'\s+', '', str(value or ''))


def _total_label(value):
    return _normal(value) in ('合计', '小计')


# Rows whose label announces a summary row may legitimately carry static
# numbers (system-provided totals). Any other static number in the block
# means the boundary guess is wrong (data below the total) and is rejected.
_LABELLED_TOTAL_RE = re.compile(r'^(合计|小计|净额|减|汇总|评估)')

_SUM_RE = re.compile(r'SUM\(\$?[A-Z]{1,3}\$?(\d+):\$?[A-Z]{1,3}\$?(\d+)\)', re.I)
# Plain cell reference, not preceded by a letter/digit/underscore (so LOG10,
# defined names and sheet-qualified tokens are not misread as bare refs).
_REF_RE = re.compile(r'(?<![A-Za-z0-9_$])\$?[A-Z]{1,3}\$?(\d+)(?![\d(])', re.I)


def _print_bounds(ws):
    """(first_row, last_row, last_col) of ws.print_area, or None.

    print_area may hold several comma-separated ranges; the first one wins.
    range_boundaries returns (min_col, min_row, max_col, max_row) - unpacking
    that in the wrong order silently enlarged last_col to the row count and
    made every later scan walk thousands of phantom columns.
    """
    area = ws.print_area
    if not area:
        return None
    try:
        refs = str(area).split('!')[-1].split(',')[0]
        refs = refs.replace('$', '')
        a, b = refs.split(':')
        _c1, r1, c2, r2 = range_boundaries(f'{a}:{b}')
        return r1, r2, c2
    except Exception:
        return None


def _val(ws, r, c):
    """Value at (r, c) without creating a cell (ws.cell would).

    openpyxl's ws.cell() instantiates missing cells, which inflates max_row /
    max_column and turns a scan of the used range into a quadratic walk.
    """
    cell = ws._cells.get((r, c))
    return None if cell is None else cell.value


def _find_header(ws, first_row, last_row):
    """Row whose cells A..E contain '序号'."""
    for r in range(first_row, last_row + 1):
        if any(_normal(_val(ws, r, c)) == '序号' for c in (1, 2, 3, 4, 5)):
            return r
    return None


def _total_candidates(ws, header, last_row):
    return [r for r in range(header + 1, last_row + 1)
            if any(_total_label(_val(ws, r, c)) for c in (1, 2, 3))]


def _block_ok(ws, boundary, last_row, max_col):
    """Validate the footer block [boundary..last_row]. Returns None or a reason."""
    for r in range(boundary, last_row + 1):
        label = _normal(_val(ws, r, 1))
        labelled = bool(_LABELLED_TOTAL_RE.match(label))
        for c in range(1, max_col + 1):
            v = _val(ws, r, c)
            if v is None:
                continue
            if isinstance(v, str) and v.startswith('='):
                formula = v
                at_boundary = (r == boundary)
                for m in _SUM_RE.finditer(formula):
                    end = int(m.group(2))
                    if at_boundary and end > boundary - 1:
                        return 'unverified_subtotal_formula'
                    if not at_boundary and end < boundary:
                        return 'block_sum_reaches_business_rows'
                # Non-SUM references: business-row references are only allowed
                # at the boundary row (the total itself aggregates business).
                for m in _REF_RE.finditer(formula):
                    row_ref = int(m.group(1))
                    if row_ref < boundary and not at_boundary:
                        return 'block_formula_references_business_rows'
                    if row_ref >= boundary and at_boundary and not _SUM_RE.search(formula):
                        # boundary-row formula referencing the block itself
                        # (e.g. I26=H26-G26) is fine; nothing to reject here.
                        pass
            elif isinstance(v, (int, float)) and not labelled:
                return 'static_values_in_total_block'
    return None


def plan_sheet(ws):
    """Return a conservative structural proposal without changing the worksheet."""
    bounds = _print_bounds(ws)
    if not bounds:
        return {'sheet': ws.title, 'status': 'skip', 'reason': 'no_print_area'}
    first_area, last_area, max_col = bounds
    header = _find_header(ws, first_area, last_area)
    if not header or header >= last_area:
        return {'sheet': ws.title, 'status': 'skip', 'reason': 'no_header'}
    candidates = _total_candidates(ws, header, last_area)
    # The footer starts at the top-most bottom '合计'. If that candidate's
    # block fails, lower labels sit inside the footer (second total row), not
    # at a footer start — falling back to them would insert mid-footer, so we
    # skip the sheet instead.
    boundary = None
    reason = 'missing_total'
    if candidates:
        cand = sorted(candidates)[0]
        bad = _block_ok(ws, cand, last_area, max_col)
        if bad is None:
            boundary = cand
        else:
            reason = bad
    if not boundary or boundary <= header + 1:
        return {'sheet': ws.title, 'status': 'skip', 'reason': reason}
    # All nonempty cells are evidence, including zeros, formula-only rows and
    # comments. Index them once: ws._cells can hold tens of thousands of
    # entries and a per-row rescan over it is quadratic.
    occupied_index = set()
    for (r, _c), cell in ws._cells.items():
        if (cell.value is not None or cell.comment is not None
                or cell.hyperlink is not None):
            occupied_index.add(r)

    def occupied(r):
        return r in occupied_index

    occupied_rows = [r for r in range(header + 1, boundary) if occupied(r)]
    last = max(occupied_rows, default=header)

    merge_spans = list(ws.merged_cells.ranges)

    def strictly_empty(r):
        # row_dimensions.get() avoids creating a RowDimension for blank rows.
        rd = ws.row_dimensions.get(r)
        return (not occupied(r)
                and not (rd is not None and rd.hidden)
                and not any(m.min_row <= r <= m.max_row for m in merge_spans))

    # Delete candidates start at the row immediately after the last occupied
    # row (表数据最后一行的下一行) and extend while strictly empty/visible/unmerged.
    delete_run = []
    r = last + 1
    while r < boundary and strictly_empty(r):
        delete_run.append(r)
        r += 1
    crossings = [str(m) for m in merge_spans if m.min_row < boundary <= m.max_row]
    if crossings:
        return {'sheet': ws.title, 'status': 'skip', 'reason': 'merge_crosses_insertion_boundary', 'merges': crossings}
    return {'sheet': ws.title, 'status': 'proposal', 'family': 'generic_bottom_total',
            'first_business_row': header + 1,
            'last_occupied_row': last, 'first_subtotal_row': boundary,
            'total_rows': candidates,
            'insert_before': boundary, 'delete_run': delete_run,
            'input_columns': f'A:{get_column_letter(max_col)}',
            'warnings': ['read_only_not_safe_to_execute', 'all_formulas_count_as_occupied',
                         'references_merges_and_package_features_not_validated']}


def plan_file(path):
    """Read a workbook without saving; hash identifies the exact inspected bytes."""
    p = Path(path)
    digest = hashlib.sha256(p.read_bytes()).hexdigest()
    wb = load_workbook(p, data_only=False, read_only=False)
    try:
        return {'source_sha256': digest, 'sheets': [plan_sheet(ws) for ws in wb.worksheets]}
    finally:
        wb.close()


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Read-only template boundary proposal')
    parser.add_argument('workbook')
    args = parser.parse_args()
    print(json.dumps(plan_file(args.workbook), ensure_ascii=False, indent=2))
