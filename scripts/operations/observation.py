"""Small allowlisted mission views; detailed evidence stays outside model context."""
from __future__ import annotations

import hashlib
import json
import math
from typing import Any

TERMINAL = {"succeeded", "failed", "cancelled", "timed_out", "interrupted"}


def encoded(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(value: Any) -> str:
    return hashlib.sha256(encoded(value)).hexdigest()


def mapping(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def fields(value: Any, names: tuple[str, ...]) -> dict:
    """No arbitrary instructions, error bodies, credentials or logs in the projection."""
    source = mapping(value)
    result = {}
    for key in names:
        item = source.get(key)
        if item is None or isinstance(item, bool):
            result[key] = item
        elif isinstance(item, str):
            # IDs and status codes must not turn into an unbounded output channel.
            result[key] = item if len(item) <= 160 else {"sha256": digest(item), "chars": len(item)}
        elif isinstance(item, (int, float)) and math.isfinite(item):
            result[key] = item
        else:
            result[key] = {"sha256": digest(item), "kind": type(item).__name__}
    return result


def records(value: Any, name: str) -> list[dict]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise ValueError(f"{name} must be an array of objects")
    return value


def sorted_records(items: list[dict]) -> list[dict]:
    return sorted(items, key=lambda item: encoded(item))


def settlement(value: Any) -> dict:
    result = fields(value, ("runId", "reservationId", "wake", "creation", "slotId", "issueId"))
    result["settled"] = bool(mapping(value).get("settledAt") or mapping(value).get("usageSettledAt"))
    return result


def project(snapshot: dict, mission_id: str) -> dict:
    if not isinstance(snapshot, dict):
        raise ValueError("snapshot must be an object")
    mission = mapping(snapshot.get("mission", snapshot))
    declared = mission.get("missionId", snapshot.get("missionId"))
    if declared != mission_id:
        raise ValueError("snapshot missionId must match the selected mission")
    aggregate = mapping(mission.get("aggregate", mission))
    if not isinstance(aggregate.get("phase"), str) or not isinstance(aggregate.get("control"), dict):
        raise ValueError("mission phase and control are required")
    n1, n2, n3, n5 = (mapping(aggregate.get(k)) for k in ("n1", "n2", "n3", "n5"))
    # The canonical GET includes computed readiness/unknown states outside the
    # stored aggregate. Keep those, including freshness changes without a write.
    inspected_n2 = mapping(snapshot.get("n2"))
    n2 = {**n2, **inspected_n2}
    n5 = {**n5, **mapping(snapshot.get("n5"))}
    active = n2.get("activeSubmissionId")
    submissions = records(n2.get("submissions"), "submissions")
    subject = next((s for s in submissions if s.get("submissionId") == active), {})
    rounds = records(n3.get("rounds"), "review rounds")
    current_round = next((r for r in rounds if mapping(mapping(r.get("review")).get("subject")).get("submissionId") == active), n3)
    current_round = {**current_round, **mapping(snapshot.get("n3"))}
    review = mapping(current_round.get("review"))
    synthesis = mapping(review.get("synthesis"))
    publication = mapping(n5.get("publication"))
    tasks = records(n2.get("ordinaryTasks", mapping(n2.get("ordinary")).get("tasks", snapshot.get("tasks"))), "tasks")
    correction = mapping(n2.get("correction"))
    n2_usage = mapping(n2.get("usage"))
    runs = []
    for run in records(snapshot.get("runs"), "runs"):
        result = fields(run, ("id", "runId", "role", "status"))
        if not result.get("id") and not result.get("runId"):
            raise ValueError("each selected run needs an id")
        result["hasError"] = bool(run.get("error"))
        usage = mapping(run.get("usage", run.get("usageJson")))
        result["usage"] = fields(usage, ("model", "inputTokens", "cachedInputTokens", "outputTokens"))
        runs.append(result)
    admission = mapping(snapshot.get("admission", snapshot.get("budget")))
    admission = mapping(admission.get("envelope", admission))
    budget = fields(admission, ("status", "accountedUnits", "availablePeriodUnits", "allowance", "exposure"))
    blockers = admission.get("blockers")
    budget["blockers"] = [{"sha256": digest(x)} for x in blockers] if isinstance(blockers, list) else None
    available = budget.get("availablePeriodUnits")
    budget["exhausted"] = available <= 0 if isinstance(available, (float, int)) else None
    return {
        "schema": "council-observation.v1", "missionId": mission_id,
        "coverage": {"runs": "selected" if "runs" in snapshot else "not_requested",
                     "admission": "selected" if "admission" in snapshot or "budget" in snapshot else "not_requested"},
        "version": mission.get("version", snapshot.get("version")),
        "phase": aggregate["phase"], "control": fields(aggregate["control"], ("status", "reason")),
        "n2": {**fields(n2, ("status", "activeSubmissionId", "blockage")),
               "correction": {**fields(correction, ("wakeState", "runId", "reservationId")),
                              "usageSettled": bool(correction.get("usageSettledAt"))},
               "application": fields(n2.get("application"), ("state", "submissionId", "operationId", "receiptState", "nativeStatus")),
               "usage": {"complete": n2_usage.get("complete"),
                         "reviews": sorted_records([settlement(x) for x in records(n2_usage.get("reviews"), "review usage")]),
                         "correction": settlement(n2_usage.get("correction"))}},
        "candidate": fields(subject, ("submissionId", "candidateCommit", "sha256", "evidenceRevision", "mandateHash", "baseCommit")),
        "reviewSubject": fields(review.get("subject"), ("submissionId", "candidateCommit", "bundleSha256", "evidenceRevision", "mandateHash")),
        "opinions": sorted_records([fields(x, ("opinionId", "slotId", "outcome")) for x in records(review.get("opinions"), "opinions")]),
        "n3": {**fields(current_round, ("released", "nextActor", "missing", "usageUnknown")),
               "attested": bool(current_round.get("attestedAt")),
               "transmission": settlement(current_round.get("transmission")),
               "reviewStatus": fields(review, ("status",))["status"],
               "synthesis": {**fields(synthesis, ("verdict", "finalReviewerAgentId", "finalReviewerRunId")),
                             "subject": fields(synthesis.get("subject"), ("submissionId", "candidateCommit", "bundleSha256", "evidenceRevision", "mandateHash"))}},
        "specialists": sorted_records([settlement(x) for x in records(current_round.get("specialists"), "specialists")]),
        "publication": {**fields(n5, ("ready", "nativeReadbackFresh")),
                        **fields(publication, ("intentId", "issueId", "runId", "state", "readbackUnavailable", "creation", "wake")),
                        "settled": bool(publication.get("settledAt")),
                        "observation": fields(publication.get("observation"), ("headSha", "state", "draft", "matchesCandidate")),
                        "checks": fields(publication.get("checks"), ("headSha", "state")),
                        "reviews": fields(publication.get("reviews"), ("headSha", "state"))},
        "contributions": sorted_records([fields(x, ("contributionId", "childIssueId", "commit", "status", "dispatchState", "dispatchRunId")) for x in records(n1.get("contributions", snapshot.get("children")), "contributions")]),
        "tasks": sorted_records([fields(x, ("taskId", "kind", "submissionId", "runId", "wake", "settledAt", "receiptRecordedAt", "closedAt")) for x in tasks]),
        "runs": sorted_records(runs), "budget": budget,
    }


def meaningful(view: dict) -> dict:
    """Ignore timestamps/bookkeeping and running token ticks; retain terminal unknowns."""
    state = json.loads(encoded(view))
    state.pop("version", None)
    for run in state["runs"]:
        if run.get("status") not in TERMINAL:
            run.pop("usage", None)
    for task in state["tasks"]:
        for key in ("settledAt", "receiptRecordedAt", "closedAt"):
            task[key] = bool(task.get(key))
    state["budget"] = {k: state["budget"][k] for k in ("status", "blockers", "exhausted")}
    return state


def bounded_event(view: dict, previous: dict | None, evidence: dict, max_bytes: int) -> dict:
    state = meaningful(view)
    changed = sorted(k for k in state if previous is None or state[k] != previous.get(k))
    result = {"event": "initial" if previous is None else "changed", "changed": changed,
              "evidence": evidence, "observation": view, "omitted": {}}
    if len(encoded(result)) > max_bytes:
        # Keep all scalar decisions and counts. Full entity data is available in the artifact.
        for key in ("runs", "tasks", "contributions", "opinions", "specialists"):
            values = result["observation"][key]
            result["omitted"][key] = {"count": len(values), "sha256": digest(values)}
            result["observation"][key] = []
    if len(encoded(result)) > max_bytes:
        raise ValueError("output byte budget cannot preserve decision fields and evidence reference")
    return result
