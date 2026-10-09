#!/usr/bin/env python3
"""One-shot admitted integration command. Restart permits observation, never a second merge."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.request
from urllib.parse import urlsplit
import uuid
import github_feedback
import github_integration


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Native redirect refused")


def native(args, payload):
    base = os.environ["PAPERCLIP_API_URL"]
    parsed = urlsplit(base)
    if parsed.scheme not in ["http", "https"] or parsed.username or parsed.password:
        raise ValueError("Exact native API origin required")
    endpoint = parsed.scheme + "://" + parsed.netloc + "/api/plugins/private.paperclip-council/api/issues/" + os.environ["PAPERCLIP_TASK_ID"] + "/council/commands"
    data = json.dumps({"missionId": args.mission_id, **payload}).encode()
    request = urllib.request.Request(endpoint, data=data, method="POST", headers={"Content-Type": "application/json",
        "Authorization": "Bearer " + os.environ["PAPERCLIP_API_KEY"], "X-Paperclip-Run-Id": os.environ["PAPERCLIP_RUN_ID"]})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
        raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError("Native response exceeds bound")
        return json.loads(raw)


def private_json(path, payload):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as file:
        json.dump(payload, file)
        file.flush()
        os.fsync(file.fileno())


def current(args):
    view = native(args, {"command": "n5-inspect"})
    p = view["delivery"]["publication"]
    if p["operation"] != "integrate" or p["issueId"] != os.environ["PAPERCLIP_TASK_ID"] or p["runId"] != os.environ["PAPERCLIP_RUN_ID"]:
        raise ValueError("Exact admitted integration slot required")
    a = view["delivery"]["authority"]
    report_args = argparse.Namespace(url=p["targetUrl"], repository=a["repository"], head=p["submission"]["candidateCommit"],
        base_ref=a["baseRef"], base_sha=p["submission"]["baseCommit"], company_id=args.company_id,
        mission_id=args.mission_id, intent_id=p["intentId"])
    return view, report_args


def merge_once(args, view, report_args, directory):
    claim_file = directory / "merge-claim.json"
    if claim_file.exists() or view["delivery"]["integration"].get("mergeClaimedAt"):
        raise ValueError("Original merge was prepared or claimed; use observe, never another merge")
    report = github_integration.report(report_args)
    feedback = github_feedback.report(report_args)
    payload = {"command": "n5-claim-merge", "commandId": str(uuid.uuid4()), "expectedVersion": view["version"],
               "integrationReport": report, "feedbackReport": feedback}
    private_json(claim_file, {"missionId": args.mission_id, **payload})
    response = native(args, payload)
    if response.get("effectPermission") != "execute" or response.get("outcome") != "applied":
        raise ValueError("No one-shot merge permission observed")
    private_json(directory / "merge-permission.json", {"commandId": payload["commandId"], "effectPermission": "execute"})
    match = re.fullmatch(r"https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)", report_args.url)
    if not match or match[1] != report_args.repository:
        raise ValueError("Canonical same PR required")
    body_file = directory / "github-merge-input.json"
    private_json(body_file, {"sha": report_args.head, "merge_method": view["delivery"]["authority"]["contract"]["integration"]["mergeMethod"]})
    # The native claim and durable journal precede this single effect. A crash never repeats it.
    result = subprocess.run(["gh", "api", "--method", "PUT", "repos/" + report_args.repository + "/pulls/" + match[2] + "/merge", "--input", str(body_file)],
                            capture_output=True, text=True, timeout=30, check=False)
    private_json(directory / "merge-attempt.json", {"exitCode": result.returncode, "outcome": "readback_required"})


def observe(args, directory):
    # Read-only polling stays in the current admitted run; no provider/model wake or merge retry.
    for index in range(10):
        view, report_args = current(args)
        if not view["delivery"]["integration"].get("mergeClaimedAt"):
            raise ValueError("Original consumed merge intent required")
        report = github_integration.report(report_args)
        payload = {"command": "n5-observe-integration", "commandId": str(uuid.uuid4()), "expectedVersion": view["version"], "integrationReport": report}
        private_json(directory / ("observation-" + str(uuid.uuid4()) + ".json"), {"missionId": args.mission_id, **payload})
        response = native(args, payload)
        state = response["mission"]["aggregate"]["n5"]["integration"]["state"]
        if state in ["verified", "failed"] or report["state"] != "merged":
            return {"state": state, "effectPermission": "none", "terminalAccounting": "native_driver_pending"}
        if index < 9:
            time.sleep(30)
    return {"state": "pending", "effectPermission": "none", "reason": "Bounded observation exhausted; retain the admitted intent"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["merge", "observe"])
    parser.add_argument("--mission-id", required=True)
    parser.add_argument("--company-id", required=True)
    args = parser.parse_args()
    try:
        for key in ["PAPERCLIP_TASK_ID", "PAPERCLIP_RUN_ID"]:
            uuid.UUID(os.environ[key])
        uuid.UUID(args.mission_id)
        uuid.UUID(args.company_id)
        view, report_args = current(args)
        git_dir = subprocess.run(["git", "rev-parse", "--absolute-git-dir"], capture_output=True, text=True, timeout=15, check=True).stdout.strip()
        directory = Path(git_dir) / "council-integration" / report_args.intent_id
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if args.operation == "merge":
            merge_once(args, view, report_args, directory)
        print(json.dumps(observe(args, directory)))
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError):
        print(json.dumps({"state": "blocked", "effectPermission": "none", "reason": "Original integration outcome retained; inspect and observe, never prepare another merge"}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
