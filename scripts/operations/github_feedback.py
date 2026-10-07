#!/usr/bin/env python3
"""Read-only bounded GitHub report inside the already admitted publisher environment.

REST review commit_id/state and check-run ref contracts: docs.github.com/en/rest/
(pulls/reviews, checks/runs), verified 2026-10-07. No credential acquisition/probe.
"""
import argparse
import datetime
import json
import os
import re
import subprocess

VERSION = "2026-03-10"

def read_api(path):
    result = subprocess.run(["gh", "api", path, "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: " + VERSION],
                            capture_output=True, text=True, timeout=15, check=False)
    if result.returncode:
        raise ValueError("GitHub read refused; retain the original publication intent")
    if len(result.stdout.encode()) > 2_000_000:
        raise ValueError("GitHub response exceeds bounded read scope")
    return json.loads(result.stdout)

def report(args):
    match = re.fullmatch(r"https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)", args.url)
    if not match or match[1] != args.repository or not re.fullmatch(r"[a-f0-9]{40}", args.head):
        raise ValueError("Exact canonical repository PR and SHA required")
    if not all(os.environ.get(key) for key in ["PAPERCLIP_TASK_ID", "PAPERCLIP_RUN_ID"]):
        raise ValueError("Current admitted publisher context required")
    prefix = "repos/" + args.repository
    pr_path = prefix + "/pulls/" + match[2]
    pr = read_api(pr_path)
    if pr["head"]["sha"] != args.head or pr.get("html_url") != args.url or pr.get("state") != "open":
        raise ValueError("Observed PR changed; no feedback on a replacement head")
    checks = read_api(prefix + "/commits/" + args.head + "/check-runs?per_page=100")
    statuses = read_api(prefix + "/commits/" + args.head + "/status?per_page=100")
    reviews = read_api(pr_path + "/reviews?per_page=100")
    if checks.get("total_count", 101) > 100 or statuses.get("sha") != args.head or len(statuses.get("statuses", [])) >= 100 or len(checks.get("check_runs", [])) != checks.get("total_count") or not isinstance(reviews, list) or len(reviews) >= 100:
        raise ValueError("Complete check/review inventory is not within the declared bound")
    named = {}
    for item in checks["check_runs"]:
        if item.get("head_sha") != args.head:
            raise ValueError("Check run belongs to another head")
        state = "pending" if item["status"] != "completed" else "passed" if item["conclusion"] in ["success", "neutral", "skipped"] else "failed"
        previous = named.get(item["name"])
        if previous is None or item["id"] > previous["id"]:
            named[item["name"]] = {"id": item["id"], "name": item["name"], "state": state, "evidenceUrl": item["html_url"]}
    status_names = set()
    for item in statuses.get("statuses", []):
        if item["context"] in status_names:
            continue
        status_names.add(item["context"])
        if item["context"] in named:
            raise ValueError("Ambiguous check-run and status names require explicit policy")
        named[item["context"]] = {"name": item["context"], "state": "passed" if item["state"] == "success" else "pending" if item["state"] == "pending" else "failed", "evidenceUrl": item.get("target_url") or args.url}
    observations = []
    for item in reviews:
        if item["state"] == "PENDING":
            continue
        if len(item.get("body") or "") > 8000:
            raise ValueError("Review body requires an explicit larger evidence scope, not silent truncation")
        observations.append({"id": item["id"], "author": item["user"]["login"], "headSha": item["commit_id"], "state": item["state"],
                             "body": item.get("body") or "", "url": item["html_url"], "submittedAt": item["submitted_at"]})
    # Re-read PR after independent reads; a changed head cannot combine cohorts.
    after = read_api(pr_path)
    if any(after.get(key) != pr.get(key) for key in ["head", "base", "draft", "state", "html_url"]):
        raise ValueError("PR changed during feedback read; preserve uncertain observation")
    return {"protocol": "publisher-github-feedback-v1", "provenance": "publisher_run_report", "missionId": args.mission_id,
            "intentId": args.intent_id, "issueId": os.environ["PAPERCLIP_TASK_ID"], "runId": os.environ["PAPERCLIP_RUN_ID"],
            "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "url": args.url, "repository": args.repository,
            "headSha": args.head, "baseRef": pr["base"]["ref"], "headRef": pr["head"]["ref"], "draft": pr["draft"],
            "checks": [{key: value for key, value in item.items() if key != "id"} for item in named.values()], "reviews": observations}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["url", "repository", "head", "mission-id", "intent-id"]:
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(report(args), ensure_ascii=False))
    except (ValueError, KeyError, TypeError, AttributeError, subprocess.TimeoutExpired, OSError):
        print(json.dumps({"status": "blocked", "reason": "Bounded GitHub feedback read is unavailable or inconsistent; no retry/write authority"}))
        return 1
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
