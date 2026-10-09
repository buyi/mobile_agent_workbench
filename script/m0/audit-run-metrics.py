#!/usr/bin/env python3
"""Read-only timing/accounting audit of an exported M0 Run history.

These observations are not a Gate, a signature check or new model execution.
Missing phase instrumentation stays unknown; wall time is never partitioned
into guessed queue/inference/tool durations.
"""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def timestamp(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000


def interval(start, end, source, meaning):
    try:
        duration = round(timestamp(end) - timestamp(start), 3)
        if duration < 0:
            raise ValueError("negative duration")
        return {"known": True, "start": start, "end": end, "durationMs": duration,
                "source": source, "meaning": meaning}
    except (TypeError, ValueError, AttributeError):
        return {"known": False, "source": source, "reason": "Missing or invalid boundary timestamps"}


def audit(source):
    pins = {}

    def read(path):
        if path.is_symlink() or not path.is_file():
            raise ValueError("Expected regular evidence file: " + str(path))
        raw = path.read_bytes()
        pins[str(path.relative_to(source))] = digest(raw)
        return raw

    def document(path):
        return json.loads(read(path))

    directories = [source]
    history = source / "run-history"
    if history.exists():
        directories += sorted(p for p in history.iterdir() if p.is_dir() and not p.is_symlink())
    rows = []
    for directory in directories:
        reports = directory / "reports"
        result = document(reports / "result.json")
        execution = document(reports / "execution.json")
        run = result["run"]
        if result["binding"]["runId"] != run["runId"] or execution["binding"] != result["binding"]:
            raise ValueError("Run binding mismatch")
        row = {"runId": run["runId"], "status": run["status"], "priorRunId": run.get("priorRunId"),
               "source": str((reports / "result.json").relative_to(source)),
               "usage": result["usage"], "reportedRunUsage": run["usage"],
               "queue": {"known": False, "reason": "No separate admission/queue start and finish receipt"},
               "inference": {"known": False, "reason": "Native step boundaries include tool and bookkeeping time; no provider inference-only receipt"},
               "humanInterventions": {"reported": run["usage"]["humanInterventions"], "fullExperimentKnown": False,
                                      "reason": "Delivery counter covers recorded Run reports; infrastructure fixes, administrator authentication and earlier user decisions were not metered as Run events"}}
        native = reports / "native.jsonl"
        if native.exists():
            events = [json.loads(line) for line in read(native).splitlines() if line.strip()]
            unique = {}
            duplicates = 0
            for event in events:
                if event.get("type") not in ("step_start", "step_finish", "tool_use"):
                    continue
                part = event.get("part", {})
                key = (event.get("sessionID"), event["type"], part.get("id"))
                if not all(isinstance(item, str) and item for item in key):
                    raise ValueError("Missing native event identity")
                if key in unique:
                    if unique[key] != event:
                        raise ValueError("Conflicting native event identity")
                    duplicates += 1
                unique[key] = event
            events = list(unique.values())
            steps, tools = [], []
            messages = sorted({(e["sessionID"], e["part"].get("messageID")) for e in events})
            native_ref = str(native.relative_to(source))
            for session, message in messages:
                starts = [e for e in events if e["type"] == "step_start" and e["sessionID"] == session and e["part"].get("messageID") == message]
                ends = [e for e in events if e["type"] == "step_finish" and e["sessionID"] == session and e["part"].get("messageID") == message]
                if len(starts) == len(ends) == 1:
                    steps.append({"messageId": message, **interval(starts[0].get("timestamp"), ends[0].get("timestamp"), native_ref,
                                  "Runtime-reported step interval, not inference-only time")})
                else:
                    steps.append({"messageId": message, "known": False, "reason": "Missing or ambiguous native step boundaries"})
            for event in events:
                if event["type"] != "tool_use":
                    continue
                part = event["part"]
                timing = part.get("state", {}).get("time", {})
                tools.append({"partId": part["id"], "tool": part.get("tool"),
                              **interval(timing.get("start"), timing.get("end"), native_ref, "Runtime-reported tool interval, not independently measured service latency")})
            row["nativeSteps"] = steps
            row["tools"] = tools
            row["duplicateTimingEvents"] = duplicates
            row["toolDurationSumMs"] = sum(t["durationMs"] for t in tools) if all(t["known"] for t in tools) else None
        else:
            row["nativeSteps"] = {"known": False, "reason": "No exported native stream; ambiguous dispatch does not establish zero calls"}
            row["tools"] = {"known": False, "reason": "No exported native stream"}
        evidence = reports / "verification-evidence.json"
        if evidence.exists():
            check = document(evidence)
            if check["binding"] != result["binding"]:
                raise ValueError("Verification binding mismatch")
            row["verification"] = interval(check.get("startedAt"), check.get("finishedAt"), str(evidence.relative_to(source)),
                                           "Independent verifier evidence interval; signature must be checked by the dedicated verifier consumer")
        else:
            row["verification"] = {"known": False, "reason": "No verification-evidence receipt for this Run"}
        row["stateTransitions"] = run["history"]
        row["stateTransitionMeaning"] = "Control-plane observation/commit times; delayed event consumption is not original execution timing"
        rows.append(row)
    current = document(source / "reports/result.json")
    expected = current["task"]["revisions"][str(current["binding"]["goalRevision"])]["runIds"]
    if set(expected) != {row["runId"] for row in rows} or len(expected) != len(rows):
        raise ValueError("Incomplete or duplicate Run history")
    rows.sort(key=lambda row: expected.index(row["runId"]))
    for relative, expected_digest in pins.items():
        if digest((source / relative).read_bytes()) != expected_digest:
            raise ValueError("Original evidence changed during audit")
    return {"schemaVersion": "m0-run-metrics-audit/1", "observedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "status": "observations-with-explicit-unknowns", "milestonePassed": False, "originalEvidenceUnchanged": True,
            "scope": "Read-only exported-history audit; no database, model, signing, device or administrator calls",
            "runs": rows, "upperLayerRepairs": len(rows) - 1,
            "providerRetryCount": {"known": False, "reason": "step_finish count does not identify provider internal retries"},
            "completeExperimentTokensKnown": False, "completeExperimentCostKnown": False,
            "phaseTimingComplete": False, "fullHumanInterventionCountKnown": False,
            "sourcePins": pins, "toolDigest": digest(Path(__file__).read_bytes())}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    source = Path(args.source).resolve(strict=True)
    output = Path(args.out).absolute()
    parent = output.parent.resolve(strict=True)
    if output.exists() or output.is_symlink() or parent == source or source in parent.parents:
        raise SystemExit("Output must be a new file outside the evidence tree")
    result = audit(source)
    with output.open("x") as stream:
        json.dump(result, stream, indent=2, ensure_ascii=False)
        stream.write("\n")
    print(json.dumps({"status": result["status"], "runs": len(result["runs"]), "report": str(output), "complete": False}))
