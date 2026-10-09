#!/usr/bin/env python3
"""Bounded read-only integration observation in the admitted publisher environment."""
import argparse
import datetime
import json
import os
import re
import subprocess
from urllib.parse import quote
from github_feedback import read_api, read_checks


def report(args):
    match = re.fullmatch(r"https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)", args.url)
    if not match or match[1] != args.repository or not all(re.fullmatch(r"[a-f0-9]{40}", s) for s in [args.head, args.base_sha]):
        raise ValueError("Exact PR, candidate and base SHA required")
    if not os.environ.get("PAPERCLIP_TASK_ID") or not os.environ.get("PAPERCLIP_RUN_ID"):
        raise ValueError("Admitted publisher identity required")
    prefix = "repos/" + args.repository
    path = prefix + "/pulls/" + match[2]
    pr = read_api(path)
    if pr.get("html_url") != args.url or pr["head"]["sha"] != args.head or pr["base"]["ref"] != args.base_ref or pr.get("draft"):
        raise ValueError("Exact nondraft candidate/base required")
    merged = pr.get("merged") is True
    parents, checks, contains, commit = [], [], False, None
    if merged:
        commit = pr.get("merge_commit_sha")
        if not re.fullmatch(r"[a-f0-9]{40}", commit or ""):
            raise ValueError("Integrated commit unknown")
        metadata = read_api(prefix + "/commits/" + commit)
        if metadata.get("sha") != commit or len(metadata.get("parents", [])) > 2:
            raise ValueError("Bounded exact integrated commit required")
        parents = [p["sha"] for p in metadata["parents"]]
        current = read_api(prefix + "/branches/" + quote(args.base_ref, safe=""))["commit"]["sha"]
        comparison = read_api(prefix + "/compare/" + commit + "..." + current + "?per_page=1")
        contains = comparison.get("status") in ["identical", "ahead"] and comparison.get("merge_base_commit", {}).get("sha") == commit
        checks = read_checks(prefix, commit, args.url)
    elif pr.get("state") != "open" or pr["base"]["sha"] != args.base_sha:
        raise ValueError("Premerge source base changed or PR closed")
    after = read_api(path)
    if any(after.get(k) != pr.get(k) for k in ["head", "base", "state", "merged", "merge_commit_sha", "draft", "html_url"]):
        raise ValueError("PR changed during read; preserve unknown result")
    return {"protocol": "publisher-integration-report-v1", "provenance": "publisher_run_report",
            "companyId": args.company_id, "missionId": args.mission_id, "intentId": args.intent_id,
            "issueId": os.environ["PAPERCLIP_TASK_ID"], "runId": os.environ["PAPERCLIP_RUN_ID"],
            "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "repository": args.repository,
            "url": args.url, "candidateCommit": args.head, "baseRef": args.base_ref, "baseCommit": args.base_sha,
            "state": "merged" if merged else "open", "integratedCommit": commit,
            "baseContainsIntegrated": contains, "mergeParents": parents, "checks": checks}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["url", "repository", "head", "base-ref", "base-sha", "company-id", "mission-id", "intent-id"]:
        parser.add_argument("--" + name, required=True)
    try:
        print(json.dumps(report(parser.parse_args()), ensure_ascii=False))
    except (ValueError, KeyError, TypeError, AttributeError, subprocess.TimeoutExpired, OSError):
        print(json.dumps({"status": "blocked", "reason": "Integration read unavailable or inconsistent; retain intent, no repeated merge"}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
