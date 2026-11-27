import unittest
import finance_statement as fs


class IncomeMappingTests(unittest.TestCase):
    def test_compound_prefix_and_parenthetical(self):
        self.assertEqual(fs.ty_map('income', '一、营业收入（金额以元填列）'), '营业收入')
        self.assertEqual(fs.ty_map('income', '五、净利润报表数（净亏损以“-”号填列）'), '净利润报表数')

    def test_net_profit_report_value_uses_source(self):
        result = fs.build_sheet('income', [{'name': '四、净利润', 'values': [-123.45]}], 2024, '利润表')
        values = {d['subjectName']: d['amount'] for d in result['detail']}
        self.assertEqual(values['净利润报表数'], -123.45)
        self.assertEqual(values['净利润'], -123.45)

    def test_totals_temporarily_fill_main_with_source_and_review(self):
        result = fs.build_sheet('income', [
            {'name': '一、营业收入', 'values': [123.45]},
            {'name': '减：营业成本', 'values': [67.89]},
        ], 2024, '利润表')
        detail = {d['subjectName']: d for d in result['detail']}
        for main, total, amount in [('主营业务收入', '营业收入', 123.45), ('主营业务成本', '营业成本', 67.89)]:
            self.assertEqual(detail[main]['amount'], amount)
            self.assertIn(total, detail[main]['originName'])
            self.assertIn('暂填', detail[main]['originName'])
            self.assertIn('待核对', detail[main]['originName'])
        self.assertNotIn('其他业务收入', detail)
        self.assertNotIn('其他业务成本', detail)

    def test_any_explicit_breakdown_prevents_fallback(self):
        for name, amount in [('主营业务收入', 80), ('其他业务收入', 20), ('其他业务收入', None)]:
            result = fs.build_sheet('income', [
                {'name': '营业收入', 'values': [100]}, {'name': name, 'values': [amount]},
            ], 2024, '利润表')
            detail = {d['subjectName']: d for d in result['detail']}
            if name == '主营业务收入':
                self.assertEqual(detail[name]['amount'], 80)
                self.assertNotIn('暂填', detail[name]['originName'])
            else:
                self.assertNotIn('主营业务收入', detail)

    def test_aggregate_cost_is_not_operating_cost(self):
        result = fs.build_sheet('income', [{'name': '二、营业总成本', 'values': [100]}], 2024, '利润表')
        self.assertNotIn('主营业务成本', {d['subjectName'] for d in result['detail']})

    def test_explicit_report_value_wins(self):
        result = fs.build_sheet('income', [{'name': '净利润', 'values': [5]}, {'name': '净利润报表数', 'values': [6]}], 2024, '利润表')
        values = {d['subjectName']: d['amount'] for d in result['detail']}
        self.assertEqual(values['净利润报表数'], 6)


if __name__ == '__main__':
    unittest.main()
