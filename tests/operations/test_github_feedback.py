import importlib.util
from pathlib import Path
import types
import os
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('feedback', Path(__file__).parents[2] / 'scripts/operations/github_feedback.py')
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)

class GithubFeedbackTests(unittest.TestCase):
    def run_report(self, changes=None):
        args = types.SimpleNamespace(url='https://github.com/ty000/paperclip-council/pull/1', repository='ty000/paperclip-council', head='a'*40, mission_id='mission', intent_id='intent')
        pr = dict(head=dict(sha=args.head, ref='codex/test'), base=dict(ref='main'), html_url=args.url, state='open', draft=True)
        results = [pr, dict(total_count=1, check_runs=[dict(id=1, name='ci', head_sha=args.head, status='completed', conclusion='success', html_url=args.url)]), dict(sha=args.head, statuses=[]), [dict(id=1, state='CHANGES_REQUESTED', commit_id=args.head, user=dict(login='reviewer'), body='material defect', html_url=args.url+'#pullrequestreview-1', submitted_at='2026-10-07T15:00:00Z')], pr]
        if changes: changes(results)
        with patch.dict(os.environ, PAPERCLIP_TASK_ID='issue', PAPERCLIP_RUN_ID='run'), patch.object(f, 'read_api', side_effect=results) as reads:
            return f.report(args), reads.call_args_list
    def test_exact_publisher_context_and_change_request(self):
        result, calls = self.run_report()
        self.assertEqual(result['provenance'], 'publisher_run_report')
        self.assertEqual(result['reviews'][0]['state'], 'CHANGES_REQUESTED')
        self.assertEqual(result['issueId'], 'issue')
        self.assertTrue(all(c.args[0].startswith('repos/ty000/paperclip-council/') for c in calls))
    def test_ambiguous_check_status_names_fail_closed(self):
        with self.assertRaises(ValueError):
            self.run_report(lambda r: r[2].update(statuses=[dict(context='ci', state='success')]))
    def test_changed_pr_cannot_mix_evidence(self):
        with self.assertRaises(ValueError):
            self.run_report(lambda r: r.__setitem__(4, {**r[0], 'head': dict(sha='b'*40, ref='codex/test')}))
    def test_incomplete_inventory_refused(self):
        with self.assertRaises(ValueError): self.run_report(lambda r: r[1].update(total_count=2))
    def test_review_pagination_refused(self):
        with self.assertRaises(ValueError): self.run_report(lambda r: r.__setitem__(3, r[3]*100))
    def test_no_secret_in_read_refusal(self):
        with patch.object(f.subprocess, 'run', return_value=types.SimpleNamespace(returncode=1, stderr='SECRET')):
            with self.assertRaisesRegex(ValueError, 'GitHub read refused') as error: f.read_api('repos/scope')
            self.assertNotIn('SECRET', str(error.exception))
