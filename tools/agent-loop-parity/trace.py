"""Canonical trace normalization and semantic comparison for parity runs."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_VOLATILE_KEYS = {
    "timestamp", "startedAt", "completedAt", "createdAt", "updatedAt",
    "durationMs", "mtimeMs",
    "messageId", "requestId", "streamId", "runId", "operationId", "idempotencyKey",
    "connectionGeneration", "moduleInstanceId", "processId", "pid",
}
_NULL_OPTIONAL_KEYS = {"code", "structuredResult"}
_VOLATILE_ID = re.compile(r"^(?:[a-z_-]+-)?(?:[0-9a-f]{8,}|[0-9]{6,})$")
_UUID_LIKE_ID = re.compile(
    r"^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$",
    re.IGNORECASE,
)
_TIMELINE_BLOCK_REFERENCE = re.compile(
    r"^(?P<id>[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})(?P<suffix>:.+)$",
    re.IGNORECASE,
)
_SUBAGENT_SESSION_REFERENCE = re.compile(
    r"^.+::sub::(?P<subagent_id>[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$",
    re.IGNORECASE,
)
_SUBAGENT_TRANSCRIPT_REFERENCE = re.compile(
    r"^(?:.+/)?subagents/(?P<subagent_id>[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.jsonl$",
    re.IGNORECASE,
)
_GENERATED_REFERENCE_KINDS = {
    "subagentId": "subagent-id",
    "subagent_id": "subagent-id",
    "compactionId": "compaction-id",
    "itemId": "item-id",
    "turnId": "turn-id",
}
_ACCEPTED_SUBAGENT_NOTICE = re.compile(
    r"\baccepted message "
    r"(?P<message_id>[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}) "
    r"for subagent "
    r"(?P<subagent_id>[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\b",
    re.IGNORECASE,
)
_SETTLED_SUBAGENT_NOTICE = re.compile(
    r"\bContinuable subagent "
    r"(?P<subagent_id>[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}) "
    r"settled: (?P<status>[a-z_]+)\.",
    re.IGNORECASE,
)
_TOOL_LIFECYCLE_PHASE = {
    "tool.call": 0,
    "tool.start": 1,
    "tool.finish": 2,
    "tool.result": 3,
}
_HARNESS_PROOF_KINDS = {"harness.proof"}


def _generated_id_placeholder(
    value: str,
    kind: str,
    generated_ids: dict[tuple[str, str], str],
) -> str:
    key = (kind, value)
    placeholder = generated_ids.get(key)
    if placeholder is not None:
        return placeholder
    index = 1 + sum(existing_kind == kind for existing_kind, _ in generated_ids)
    placeholder = f"<{kind}-{index}>"
    generated_ids[key] = placeholder
    return placeholder


def _canonicalize_subagent_notice(
    value: str,
    generated_ids: dict[tuple[str, str], str],
) -> str:
    def replace(match: re.Match[str]) -> str:
        message_id = _generated_id_placeholder(
            match.group("message_id"), "message-id", generated_ids,
        )
        subagent_id = _generated_id_placeholder(
            match.group("subagent_id"), "subagent-id", generated_ids,
        )
        return f"accepted message {message_id} for subagent {subagent_id}"

    value = _ACCEPTED_SUBAGENT_NOTICE.sub(replace, value)

    def replace_settled(match: re.Match[str]) -> str:
        subagent_id = _generated_id_placeholder(
            match.group("subagent_id"), "subagent-id", generated_ids,
        )
        return f"Continuable subagent {subagent_id} settled: {match.group('status')}."

    return _SETTLED_SUBAGENT_NOTICE.sub(replace_settled, value)


def _canonicalize_arguments(
    value: str,
    generated_ids: dict[tuple[str, str], str],
) -> str:
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return value
    normalized = canonicalize(parsed, generated_ids=generated_ids)
    if normalized == parsed:
        return value
    return json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _canonicalize_subagent_reference(
    value: str,
    key: str | None,
    generated_ids: dict[tuple[str, str], str],
) -> str:
    if key == "subagentSessionId":
        match = _SUBAGENT_SESSION_REFERENCE.match(value)
        if match:
            subagent_id = _generated_id_placeholder(
                match.group("subagent_id"), "subagent-id", generated_ids,
            )
            return f"<subagent-session:{subagent_id}>"
    if key == "transcriptRelativePath":
        match = _SUBAGENT_TRANSCRIPT_REFERENCE.match(value)
        if match:
            subagent_id = _generated_id_placeholder(
                match.group("subagent_id"), "subagent-id", generated_ids,
            )
            return f"<subagent-transcript:{subagent_id}>"
    return value


def _canonicalize_duration_json_text(
    value: str,
    generated_ids: dict[tuple[str, str], str],
) -> str:
    """Drop framework timing from a complete JSON value or final JSON line only.

    One-shot subagent reports are presented to the parent model as a human
    summary followed by JSON. The duration is process scheduling noise, but
    the rest of that JSON remains model-visible and semantic. Do not parse or
    rewrite arbitrary prose: only a complete JSON value or the final line is
    eligible.
    """
    if not any(marker in value for marker in ('"durationMs"', '"subagentSessionId"', '"transcriptRelativePath"')):
        return value
    candidates = [(0, value)]
    final_line_start = value.rfind("\n{")
    if final_line_start >= 0:
        candidates.append((final_line_start + 1, value[final_line_start + 1:]))
    for start, candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except (TypeError, ValueError):
            continue
        if not isinstance(parsed, (dict, list)):
            continue
        normalized = canonicalize(parsed, generated_ids=generated_ids)
        if normalized == parsed:
            return value
        encoded = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return value[:start] + encoded
    return value


def canonicalize(
    value: Any,
    *,
    key: str | None = None,
    generated_ids: dict[tuple[str, str], str] | None = None,
) -> Any:
    generated_ids = {} if generated_ids is None else generated_ids
    if isinstance(value, dict):
        derived_image_bytes = value.get("type") == "image" and value.get("source") == "base64"
        return {
            k: canonicalize(v, key=k, generated_ids=generated_ids)
            for k, v in sorted(value.items())
            if k not in _VOLATILE_KEYS
            and not (k in _NULL_OPTIONAL_KEYS and v is None)
            and not (derived_image_bytes and k == "bytes")
        }
    if isinstance(value, list):
        return [canonicalize(item, key=key, generated_ids=generated_ids) for item in value]
    if isinstance(value, str) and key in _GENERATED_REFERENCE_KINDS and _UUID_LIKE_ID.match(value):
        return _generated_id_placeholder(value, _GENERATED_REFERENCE_KINDS[key], generated_ids)
    if isinstance(value, str) and key in {"id", "blockId", "previousId"}:
        match = _TIMELINE_BLOCK_REFERENCE.match(value)
        if match:
            block_id = _generated_id_placeholder(match.group("id"), "timeline-block-id", generated_ids)
            return f"{block_id}{match.group('suffix')}"
    if isinstance(value, str) and key == "arguments":
        return _canonicalize_arguments(value, generated_ids)
    if isinstance(value, str):
        value = _canonicalize_subagent_reference(value, key, generated_ids)
        value = _canonicalize_subagent_notice(value, generated_ids)
        value = _canonicalize_duration_json_text(value, generated_ids)
    if isinstance(value, str) and key == "handoff_id" and value:
        return "<generated-id>"
    if isinstance(value, str) and key in {"id", "callId", "toolCallId"} and _VOLATILE_ID.match(value):
        return "<generated-id>"
    return value


def load_trace(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    generated_ids: dict[tuple[str, str], str] = {}
    for line_no, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not raw.strip():
            continue
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise TypeError(f"{path}:{line_no}: trace record must be an object")
        required = {"kind", "scenarioId", "q", "sequence"}
        missing = sorted(required - value.keys())
        if missing:
            raise ValueError(f"{path}:{line_no}: trace record missing {', '.join(missing)}")
        records.append(canonicalize(value, generated_ids=generated_ids))
    return records


def validate_production_sidecar_proof(
    records: list[dict[str, Any]],
    required_modules: set[str] | None = None,
) -> list[str]:
    proofs = [record for record in records if record.get("kind") == "harness.proof"]
    states = {str(record.get("state")) for record in proofs}
    errors: list[str] = []
    if not any(record.get("state") == "transport_selected" and record.get("transport") == "stdio" for record in proofs):
        errors.append("production stdio transport selection proof is missing")
    if "handshake_completed" not in states:
        errors.append("production sidecar handshake proof is missing")
    observed_modules = {
        str(record.get("module"))
        for record in proofs
        if record.get("state") == "module_call_received"
    }
    missing_modules = sorted((required_modules or set()) - observed_modules)
    if missing_modules:
        errors.append(f"production sidecar module proof is missing: {', '.join(missing_modules)}")
    return errors


@dataclass(frozen=True)
class Difference:
    path: str
    left: Any
    right: Any


# Fields which are observable by a downstream model, tool, user, or StaffDeck
# state machine.  Everything else belongs to a transport/persistence envelope.
_SEMANTIC_EVENT_FIELDS = {
    "model.request": {"modelView", "messages", "systemPrompt", "tools", "metadata", "attempt"},
    "model.response": {"modelView", "message", "content", "tool_calls", "stopReason", "usage", "errors", "structuredResult", "attempt"},
    "model.error": {"code", "message", "retryable", "attempt"},
    "model.stream": {"state"},
    "tool.call": {"name", "toolName", "arguments", "toolCallId", "context", "order", "sideEffectCount", "attempt", "concurrencySafe"},
    "tool.start": {"name", "toolName", "toolCallId", "order", "attempt", "concurrencySafe"},
    "tool.finish": {"name", "toolName", "toolCallId", "order", "success", "error", "sideEffectCount", "attempt", "concurrencySafe"},
    "tool.result": {"result", "data", "error", "toolName", "toolCallId", "success", "sideEffectCount", "attempt", "concurrencySafe"},
    "permission.request": {"toolName", "toolCallId", "mode", "canPrompt"},
    "permission.answer": {"toolName", "toolCallId", "allowed", "code"},
    "permission.decision": {"toolName", "toolCallId", "allowed", "code", "retryable"},
    "steer.request": {"itemId", "accepted"},
    "steer.applied": {"itemId", "message"},
    "agent.status": {"event", "detail"},
    "durable.status": {"event", "statusKind", "text"},
    "durable.steer": {"itemId", "message"},
    "durable.compaction_completed": {"operationId"},
    "durable.state": {
        "durableStatusCount", "durableSteerCount", "compactionBoundaryCount",
        "compactionCompletedCount", "replayedStatusCount",
    },
    "sidecar.lifecycle": {
        "state", "stage", "code", "attempt", "parentClosed", "parentAborted",
        "subagentModelRequests", "terminalCount",
    },
    "fault.injected": {"target", "action", "stage", "attempt"},
    "side_effect.state": {"counts", "sideEffectCount"},
    "compact.boundary": {"compactionId", "reason", "messages", "metadata"},
    "compaction.budget": {"tokens", "systemTokens", "toolTokens", "messageTokens"},
    "seed.state": {"applied", "fileContent"},
    "checkpoint": {"status", "seedState", "messages", "activeStepId", "taskFrameId", "slots", "knowledgeBudget", "recoveryPoint", "sideEffectCount"},
    "taskframe": {"taskFrame", "status", "stepId", "nextStepId", "slots", "requiredCapabilities", "knowledgeBudget", "priorTaskResults"},
    "session.state": {"activeSkillId", "activeStepId", "pendingTasks", "awaitingInput", "handoff", "slots", "priorTaskResults"},
    "terminal": {"outcome", "code", "stopReason", "structuredResult", "output", "frameStatus", "runStatus", "taskFrame", "session"},
    "user.output": {"text"},
}


def _semantic_record(
    record: dict[str, Any],
    generated_ids: dict[tuple[str, str], str],
) -> dict[str, Any]:
    kind = str(record.get("kind") or "")
    fields = _SEMANTIC_EVENT_FIELDS.get(kind)
    if fields is None:
        # Unknown event kinds are still meaningful if they carry explicit state
        # projection fields; otherwise they are envelope-only.
        fields = set().union(*_SEMANTIC_EVENT_FIELDS.values())
    projected: dict[str, Any] = {"kind": kind}
    if "agentScope" in record:
        projected["agentScope"] = record["agentScope"]
    for key in fields:
        if key in record:
            projected[key] = record[key]
    # The logical ordering of calls/results is semantic, while the JSONL
    # sequence and transport source are not.
    for key in ("logicalSequence", "phase"):
        if key in record:
            projected[key] = record[key]
    return canonicalize(projected, generated_ids=generated_ids)


def _tool_lifecycle_name(record: dict[str, Any]) -> str | None:
    for key in ("name", "toolName"):
        value = record.get(key)
        if isinstance(value, str):
            return value
    result = record.get("result")
    if isinstance(result, dict) and isinstance(result.get("toolName"), str):
        return result["toolName"]
    return None


def _tool_lifecycle_identity(record: dict[str, Any]) -> str | None:
    value = record.get("toolCallId")
    if isinstance(value, str) and value:
        return value
    result = record.get("result")
    if isinstance(result, dict):
        value = result.get("toolCallId")
        if isinstance(value, str) and value:
            return value
    return None


def _canonicalize_parallel_tool_lifecycle(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Canonicalize only explicitly concurrency-safe tool lifecycle interleavings.

    The scheduler promises stable result order, but concurrent tool start/finish
    observations have no total order. We preserve strict ordering for every
    other event, including non-concurrent and repeated tool calls.
    """
    result = list(records)
    index = 0
    while index < len(result):
        if result[index].get("kind") not in _TOOL_LIFECYCLE_PHASE:
            index += 1
            continue
        end = index
        while end < len(result) and result[end].get("kind") in _TOOL_LIFECYCLE_PHASE:
            end += 1
        group = result[index:end]
        call_ids = [
            _tool_lifecycle_identity(record)
            for record in group
            if record.get("kind") == "tool.call"
        ]
        identities = [_tool_lifecycle_identity(record) for record in group]
        if (
            len(call_ids) > 1
            and None not in call_ids
            and len(set(call_ids)) == len(call_ids)
            and all(record.get("concurrencySafe") is True for record in group)
            and all(record.get("sideEffectCount", 0) == 0 for record in group)
            and all(identity in call_ids for identity in identities)
        ):
            order = {identity: offset for offset, identity in enumerate(call_ids)}
            result[index:end] = [
                record
                for _, record in sorted(
                    enumerate(group),
                    key=lambda item: (
                        order[_tool_lifecycle_identity(item[1])],
                        _TOOL_LIFECYCLE_PHASE[item[1]["kind"]],
                        item[0],
                    ),
                )
            ]
        index = end
    return result


def project_semantic_trace(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    generated_ids: dict[tuple[str, str], str] = {}
    projected = [
        _semantic_record(record, generated_ids)
        for record in records
        if record.get("kind") not in _HARNESS_PROOF_KINDS
    ]
    projected = _canonicalize_parallel_tool_lifecycle(projected)
    # Parent and host-owned child loops are independently ordered actors. Their
    # internal event order remains strict, but process scheduling does not
    # define a semantic total order between the two streams.
    parent = [record for record in projected if record.get("agentScope") != "child"]
    child = [record for record in projected if record.get("agentScope") == "child"]
    return parent + child


def project_format_trace(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return canonical envelopes for warning-only comparison."""
    return canonicalize([
        record for record in records
        if record.get("kind") not in _HARNESS_PROOF_KINDS
    ])


@dataclass(frozen=True)
class Comparison:
    semantic: list[Difference]
    format_warnings: list[Difference]


def compare_traces(left: list[dict[str, Any]], right: list[dict[str, Any]]) -> list[Difference]:
    return compare_trace_details(left, right).semantic


def _diff_values(left: Any, right: Any) -> list[Difference]:
    differences: list[Difference] = []

    def visit(a: Any, b: Any, path: str) -> None:
        if type(a) is not type(b):
            differences.append(Difference(path, a, b))
            return
        if isinstance(a, dict):
            for key in sorted(set(a) | set(b)):
                if key not in a or key not in b:
                    differences.append(Difference(f"{path}.{key}", a.get(key), b.get(key)))
                else:
                    visit(a[key], b[key], f"{path}.{key}")
            return
        if isinstance(a, list):
            if len(a) != len(b):
                differences.append(Difference(f"{path}.length", len(a), len(b)))
            for index, (item_a, item_b) in enumerate(zip(a, b)):
                visit(item_a, item_b, f"{path}[{index}]")
            return
        if a != b:
            differences.append(Difference(path, a, b))

    visit(left, right, "trace")
    return differences


def compare_trace_details(left: list[dict[str, Any]], right: list[dict[str, Any]]) -> Comparison:
    semantic = _diff_values(project_semantic_trace(left), project_semantic_trace(right))
    format_differences = _diff_values(project_format_trace(left), project_format_trace(right))
    return Comparison(semantic=semantic, format_warnings=format_differences)


def _merged_expectation(scenario: dict[str, Any], pair: str) -> dict[str, Any]:
    expected = dict(scenario.get("expected") or {})
    pair_overrides = scenario.get("expectedByPair") or {}
    if isinstance(pair_overrides, dict) and isinstance(pair_overrides.get(pair), dict):
        expected.update(pair_overrides[pair])
    return expected


def _merged_adapter_expectation(scenario: dict[str, Any], pair: str, adapter: str | None) -> dict[str, Any]:
    expected = _merged_expectation(scenario, pair)
    overrides = scenario.get("expectedByAdapter") or {}
    if adapter and isinstance(overrides, dict) and isinstance(overrides.get(adapter), dict):
        expected.update(overrides[adapter])
    return expected


def _last(records: list[dict[str, Any]], kind: str) -> dict[str, Any] | None:
    return next((record for record in reversed(records) if record.get("kind") == kind), None)


def _record_value(records: list[dict[str, Any]], key: str) -> Any:
    terminal = _last(records, "terminal") or {}
    taskframe = _last(records, "taskframe") or {}
    session = _last(records, "session.state") or {}
    checkpoint = _last(records, "checkpoint") or {}
    mapping = {
        "terminalOutcome": terminal.get("outcome"),
        "errorCode": terminal.get("code"),
        "stopReason": terminal.get("stopReason"),
        "frameStatus": terminal.get("frameStatus") or taskframe.get("status") or (taskframe.get("taskFrame") or {}).get("status"),
        "runStatus": terminal.get("runStatus"),
        "taskFrameStatus": taskframe.get("status") or (taskframe.get("taskFrame") or {}).get("status"),
        "activeStepId": session.get("activeStepId") or checkpoint.get("activeStepId"),
        "nextStepId": taskframe.get("nextStepId"),
        "awaitingInput": session.get("awaitingInput"),
        "handoff": session.get("handoff"),
        "slots": session.get("slots") or taskframe.get("slots") or checkpoint.get("slots"),
        "knowledgeBudget": taskframe.get("knowledgeBudget") or checkpoint.get("knowledgeBudget"),
        "requiredCapabilities": taskframe.get("requiredCapabilities"),
        "priorTaskResults": taskframe.get("priorTaskResults") or session.get("priorTaskResults"),
        "executionTarget": taskframe.get("executionTarget") or session.get("executionTarget"),
        "forcedSopVersion": taskframe.get("forcedSopVersion") or session.get("forcedSopVersion"),
        "output": terminal.get("output"),
        "turnSpentUsd": next(
            (
                (record.get("detail") or {}).get("turnSpentBudgetUsd")
                for record in reversed(records)
                if record.get("kind") == "agent.status"
                and record.get("event") in {"max_budget_reached", "task_budget_reached"}
                and isinstance(record.get("detail"), dict)
            ),
            (terminal.get("usage") or {}).get("nativeCost") if isinstance(terminal.get("usage"), dict) else None,
        ),
        "modelAttempts": sum(record.get("kind") == "model.request" for record in records),
        "steerAppliedCount": sum(record.get("kind") == "steer.applied" for record in records),
        "parentClosed": any(
            record.get("kind") == "sidecar.lifecycle"
            and record.get("state") == "parent_closed"
            and record.get("parentClosed") is True
            for record in records
        ),
        "parentAborted": any(
            record.get("kind") == "sidecar.lifecycle"
            and record.get("state") == "parent_abort_acknowledged"
            and record.get("parentAborted") is True
            for record in records
        ),
        "terminalCount": next(
            (
                record.get("terminalCount")
                for record in reversed(records)
                if record.get("kind") == "sidecar.lifecycle"
                and isinstance(record.get("terminalCount"), int)
            ),
            None,
        ),
        "pendingTasks": session.get("pendingTasks"),
    }
    durable = _last(records, "durable.state") or {}
    if key in {
        "durableStatusCount", "durableSteerCount", "compactionBoundaryCount",
        "compactionCompletedCount", "replayedStatusCount",
    }:
        return durable.get(key)
    if key == "compactionPersistedBeforeModel":
        compact_index = next((index for index, record in enumerate(records) if record.get("kind") == "compact.boundary"), None)
        model_index = next((index for index, record in enumerate(records) if record.get("kind") == "model.request"), None)
        return compact_index is not None and model_index is not None and compact_index < model_index
    if key == "fullRequestBudgetUsed":
        budget = _last(records, "compaction.budget") or {}
        return (
            isinstance(budget.get("systemTokens"), (int, float))
            and budget.get("systemTokens", 0) > 0
            and isinstance(budget.get("toolTokens"), (int, float))
            and budget.get("toolTokens", 0) > 0
        )
    if key == "seedReadApplied":
        return (_last(records, "seed.state") or {}).get("applied")
    if key == "seededFileContent":
        return (_last(records, "seed.state") or {}).get("fileContent")
    if key == "firstDeltaBeforeProviderCompletion":
        first_delta = next((index for index, record in enumerate(records)
                            if record.get("kind") == "model.stream" and record.get("state") == "first_delta"), None)
        provider_completed = next((index for index, record in enumerate(records)
                                   if record.get("kind") == "model.stream" and record.get("state") == "provider_completed"), None)
        user_delta = next((index for index, record in enumerate(records)
                           if record.get("kind") == "user.output" and "STREAM_PREFIX" in str(record.get("text") or "")), None)
        return (
            first_delta is not None
            and provider_completed is not None
            and user_delta is not None
            and first_delta < user_delta < provider_completed
        )
    if key == "toolCalls":
        calls = [
            record.get("name") or record.get("toolName")
            for record in records
            if record.get("kind") == "tool.call"
        ]
        if calls:
            return calls
        # Gateway adapters may observe a built-in tool call only in the
        # canonical model response, before the tool lifecycle event arrives.
        # Preserve that semantic call list instead of treating it as no call.
        for record in records:
            if record.get("kind") != "model.response":
                continue
            message = record.get("modelView") or record.get("message") or {}
            tool_calls = message.get("tool_calls") if isinstance(message, dict) else None
            if isinstance(tool_calls, list):
                return [
                    (item.get("function") or {}).get("name")
                    for item in tool_calls
                    if isinstance(item, dict) and isinstance(item.get("function"), dict)
                ]
        return []
    if key == "toolCallCount":
        calls = [record for record in records if record.get("kind") == "tool.call"]
        if calls:
            return len(calls)
        return sum(
            len((record.get("modelView") or {}).get("tool_calls") or [])
            for record in records
            if record.get("kind") == "model.response" and isinstance(record.get("modelView") or {}, dict)
        )
    if key == "sideEffectCount":
        state = _last(records, "side_effect.state") or {}
        if isinstance(state.get("sideEffectCount"), int):
            return state["sideEffectCount"]
        counts = [
            value
            for record in records
            for value in [record.get("sideEffectCount"), (record.get("result") or {}).get("sideEffectCount") if isinstance(record.get("result"), dict) else None]
            if isinstance(value, int)
        ]
        return max(counts, default=0)
    if key == "permissionAllowed":
        decisions = [
            record.get("allowed")
            for record in records
            if record.get("kind") in {"permission.answer", "permission.decision"}
            and isinstance(record.get("allowed"), bool)
        ]
        if not decisions:
            for record in records:
                if record.get("kind") != "tool.finish" or record.get("success") is not False:
                    continue
                error = record.get("error")
                code = error.get("code") if isinstance(error, dict) else None
                if code in {"permission_denied", "permission_required", "PERMISSION_DENIED"}:
                    decisions.append(False)
        return all(decisions) if decisions else None
    if key in {"toolErrorCode", "toolRetryable"}:
        errors = []
        for record in records:
            if record.get("kind") not in {"tool.finish", "tool.result"}:
                continue
            result = record.get("result") if isinstance(record.get("result"), dict) else record
            error = result.get("error") if isinstance(result.get("error"), dict) else {}
            if error:
                errors.append(error)
        if not errors:
            return None
        return errors[-1].get("code" if key == "toolErrorCode" else "retryable")
    if key == "modelVisibleTools":
        request_record = next((record for record in records if record.get("kind") == "model.request"), {})
        model_view = request_record.get("modelView") if isinstance(request_record.get("modelView"), dict) else request_record
        tools = model_view.get("tools") if isinstance(model_view, dict) else None
        names = [tool.get("name") or (tool.get("function") or {}).get("name") for tool in tools or [] if isinstance(tool, dict)]
        return names
    return mapping.get(key)


def validate_trace_expectations(
    records: list[dict[str, Any]],
    scenario: dict[str, Any],
    pair: str,
    adapter: str | None = None,
) -> list[Difference]:
    """Validate a single adapter trace against its scenario oracle."""
    expected = _merged_adapter_expectation(scenario, pair, adapter)
    failures: list[Difference] = []
    for key, wanted in expected.items():
        if key in {"requiresImage", "noToolSideEffects", "modelVisibleToolsExclude", "modelVisibleToolsInclude"}:
            if key == "requiresImage":
                requests = [record for record in records if record.get("kind") == "model.request"]
                actual = any(
                    isinstance(node, dict)
                    and (
                        node.get("type") == "image_url"
                        or (node.get("type") == "image" and node.get("source") == "base64")
                    )
                for request in requests
                for node in _walk(request.get("modelView") or request.get("request") or request.get("messages"))
                )
            elif key == "noToolSideEffects":
                actual = _record_value(records, "sideEffectCount") == 0
            elif key == "modelVisibleToolsExclude":
                visible = _record_value(records, "modelVisibleTools") or []
                excluded = wanted if isinstance(wanted, list) else [wanted]
                actual = all(str(name) not in visible for name in excluded)
                wanted = True
            else:
                visible = _record_value(records, "modelVisibleTools") or []
                included = wanted if isinstance(wanted, list) else [wanted]
                actual = all(str(name) in visible for name in included)
                wanted = True
        elif key == "outputContains":
            output = _record_value(records, "output")
            actual = isinstance(output, str) and str(wanted) in output
            wanted = True
        elif key == "modelInputContains":
            requests = [record for record in records if record.get("kind") == "model.request"]
            actual = any(str(wanted) in str(node) for request in requests for node in _walk(request.get("modelView") or request.get("request")))
            wanted = True
        else:
            actual = _record_value(records, key)
        if canonicalize(actual) != canonicalize(wanted):
            failures.append(Difference(f"{_expectation_path(key)}", wanted, actual))
    return failures


def _expectation_path(key: str) -> str:
    return {
        "terminalOutcome": "terminal.outcome",
        "errorCode": "terminal.code",
        "stopReason": "terminal.stopReason",
    }.get(key, key)


def _walk(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk(child)


def write_report(
    path: Path,
    pair_name: str,
    left_path: Path,
    right_path: Path,
    differences: list[Difference] | Comparison,
) -> None:
    comparison = differences if isinstance(differences, Comparison) else Comparison(differences, [])
    semantic = comparison.semantic
    warnings = comparison.format_warnings
    lines = [f"# {pair_name}", "", f"- left: `{left_path}`", f"- right: `{right_path}`", ""]
    if not semantic:
        lines.append("PASS: no semantic differences after projection.")
    else:
        lines.append(f"FAIL: {len(semantic)} semantic difference(s).")
        lines.append("\n## Semantic Differences\n")
        for diff in semantic[:50]:
            lines.extend(["", f"- `{diff.path}`", f"  - left: `{json.dumps(diff.left, ensure_ascii=False, sort_keys=True)}`", f"  - right: `{json.dumps(diff.right, ensure_ascii=False, sort_keys=True)}`"])
    if warnings:
        lines.append("\n## Format Warnings\n")
        lines.append(f"{len(warnings)} envelope/serialization difference(s); these do not affect exit status.")
        for diff in warnings[:50]:
            lines.extend(["", f"- `{diff.path}`", f"  - left: `{json.dumps(diff.left, ensure_ascii=False, sort_keys=True)}`", f"  - right: `{json.dumps(diff.right, ensure_ascii=False, sort_keys=True)}`"])
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
