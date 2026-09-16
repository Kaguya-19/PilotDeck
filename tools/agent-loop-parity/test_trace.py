"""Regression tests for subagent-aware parity trace normalization."""
from __future__ import annotations

import json
import unittest

from trace import (
    canonicalize,
    compare_traces,
    validate_production_sidecar_proof,
    validate_trace_expectations,
)


FIRST_SUBAGENT = "11111111-1111-4111-8111-111111111111"
SECOND_SUBAGENT = "22222222-2222-4222-8222-222222222222"
OTHER_SUBAGENT = "33333333-3333-4333-8333-333333333333"
FIRST_MESSAGE = "44444444-4444-4444-8444-444444444444"
SECOND_MESSAGE = "55555555-5555-4555-8555-555555555555"
FIRST_TURN = "66666666-6666-4666-8666-666666666666"
SECOND_TURN = "77777777-7777-4777-8777-777777777777"


def subagent_trace(subagent_id: str, message_id: str, turn_id: str, followup_id: str | None = None) -> dict[str, object]:
    target = followup_id or subagent_id
    return {
        "modelView": {
            "messages": [{
                "raw": {
                    "data": {"subagentId": subagent_id, "turnId": turn_id},
                    "content": [{
                        "text": f"accepted message {message_id} for subagent {subagent_id}",
                    }],
                },
            }, {
                "input": {"subagent_id": target},
            }],
            "tool_calls": [{
                "function": {
                    "name": "send_message",
                    "arguments": json.dumps({"subagent_id": target, "message": "continue"}),
                },
            }],
        },
    }


class SubagentTraceNormalizationTests(unittest.TestCase):
    def test_compaction_identity_is_normalized_without_hiding_status_semantics(self) -> None:
        left = [{
            "kind": "agent.status",
            "scenarioId": "compact",
            "q": "compact",
            "sequence": 0,
            "event": "compact_started",
            "detail": {"compactionId": FIRST_SUBAGENT, "trigger": "auto"},
        }]
        right = [{
            "kind": "agent.status",
            "scenarioId": "compact",
            "q": "compact",
            "sequence": 0,
            "event": "compact_started",
            "detail": {"compactionId": SECOND_SUBAGENT, "trigger": "auto"},
        }]
        self.assertEqual(compare_traces(left, right), [])
        right[0]["detail"]["trigger"] = "reactive"
        self.assertTrue(compare_traces(left, right))

    def test_production_sidecar_proof_fails_closed_without_real_transport_evidence(self) -> None:
        fake_runner = [{
            "kind": "harness.proof",
            "scenarioId": "proof",
            "q": "proof",
            "sequence": 0,
            "state": "transport_selected",
            "transport": "stdio",
        }]
        self.assertEqual(
            validate_production_sidecar_proof(fake_runner, {"budget"}),
            [
                "production sidecar handshake proof is missing",
                "production sidecar module proof is missing: budget",
            ],
        )

    def test_production_sidecar_proof_accepts_handshake_and_required_modules(self) -> None:
        records = [
            {"kind": "harness.proof", "state": "transport_selected", "transport": "stdio"},
            {"kind": "harness.proof", "state": "handshake_completed"},
            {"kind": "harness.proof", "state": "module_call_received", "module": "budget"},
            {"kind": "harness.proof", "state": "module_call_received", "module": "turn"},
        ]
        self.assertEqual(validate_production_sidecar_proof(records, {"budget", "turn"}), [])

    def test_sidecar_production_oracles_cover_durable_and_model_evidence(self) -> None:
        scenario = {
            "expected": {
                "modelAttempts": 2,
                "modelInputContains": "durable compact summary",
                "steerAppliedCount": 1,
                "durableSteerCount": 1,
                "compactionBoundaryCount": 1,
                "compactionCompletedCount": 1,
                "compactionPersistedBeforeModel": True,
            },
        }
        records = [
            {"kind": "compact.boundary", "messages": [{"content": [{"text": "durable compact summary"}]}]},
            {"kind": "model.request", "modelView": {"messages": [{"content": [{"text": "durable compact summary"}]}]}},
            {"kind": "steer.applied", "itemId": "steer-1"},
            {"kind": "model.request", "modelView": {"messages": []}},
            {
                "kind": "durable.state",
                "durableSteerCount": 1,
                "compactionBoundaryCount": 1,
                "compactionCompletedCount": 1,
            },
        ]
        self.assertEqual(validate_trace_expectations(records, scenario, "pilotdeck", "sidecar"), [])

    def test_subagent_duration_is_volatile_in_objects_and_embedded_report_json(self) -> None:
        def record(duration_ms: int) -> dict[str, object]:
            report = {
                "subagentType": "general-purpose",
                "description": "Inspect one bounded task",
                "text": "same report",
                "usage": {"inputTokens": 7},
                "turns": 1,
                "durationMs": duration_ms,
            }
            return {
                "kind": "tool.result",
                "scenarioId": "one-shot",
                "q": "delegate",
                "sequence": 0,
                "result": {
                    "data": {
                        "durationMs": duration_ms,
                        "preview": "[general-purpose] inspect\n\n" + json.dumps(report),
                    },
                },
                "modelView": {
                    "content": [{"text": json.dumps(report)}],
                    "metadata": {"durationMs": duration_ms},
                },
            }

        self.assertEqual(compare_traces([record(2_034)], [record(2_046)]), [])

    def test_parent_child_interleaving_is_not_a_semantic_total_order(self) -> None:
        parent_request = {
            "kind": "model.request", "scenarioId": "continuable", "q": "delegate",
            "sequence": 0, "agentScope": "parent", "attempt": 1,
            "modelView": {"messages": [{"role": "user", "content": [{"type": "text", "text": "parent"}]}]},
        }
        child_request = {
            "kind": "model.request", "scenarioId": "continuable", "q": "delegate",
            "sequence": 1, "agentScope": "child", "attempt": 1,
            "modelView": {"messages": [{"role": "user", "content": [{"type": "text", "text": "child"}]}]},
        }
        parent_response = {
            "kind": "model.response", "scenarioId": "continuable", "q": "delegate",
            "sequence": 2, "agentScope": "parent", "attempt": 1,
            "modelView": {"content": "parent done"},
        }
        child_response = {
            "kind": "model.response", "scenarioId": "continuable", "q": "delegate",
            "sequence": 3, "agentScope": "child", "attempt": 1,
            "modelView": {"content": "child done"},
        }
        self.assertEqual(
            compare_traces(
                [parent_request, child_request, parent_response, child_response],
                [parent_request, parent_response, child_request, child_response],
            ),
            [],
        )

        changed_child = dict(child_response)
        changed_child["modelView"] = {"content": "different child result"}
        self.assertTrue(compare_traces(
            [parent_request, child_request, parent_response, child_response],
            [parent_request, parent_response, child_request, changed_child],
        ))

    def test_continuable_subagent_settlement_normalizes_identity_but_not_status(self) -> None:
        left = {"text": f"Continuable subagent {FIRST_SUBAGENT} settled: completed."}
        right = {"text": f"Continuable subagent {SECOND_SUBAGENT} settled: completed."}
        self.assertEqual(canonicalize(left), canonicalize(right))

        failed = {"text": f"Continuable subagent {SECOND_SUBAGENT} settled: failed."}
        self.assertNotEqual(canonicalize(left), canonicalize(failed))

    def test_subagent_duration_normalization_preserves_report_semantics(self) -> None:
        def record(text: str, duration_ms: int) -> dict[str, object]:
            report = {
                "text": text,
                "usage": {"inputTokens": 7},
                "turns": 1,
                "durationMs": duration_ms,
            }
            return {
                "kind": "tool.result",
                "scenarioId": "one-shot",
                "q": "delegate",
                "sequence": 0,
                "result": {"data": {"preview": "report\n" + json.dumps(report)}},
            }

        differences = compare_traces(
            [record("native report", 2_034)],
            [record("sidecar report", 2_046)],
        )
        self.assertTrue(differences)

    def test_one_shot_subagent_references_are_normalized_in_reports_and_model_input(self) -> None:
        def record(subagent_id: str, session_scope: str) -> dict[str, object]:
            report = {
                "subagentSessionId": f"/tmp/{session_scope}/home::sub::{subagent_id}",
                "transcriptRelativePath": f"{session_scope}/subagents/{subagent_id}.jsonl",
                "text": "same report",
            }
            return {
                "kind": "tool.result",
                "scenarioId": "one-shot",
                "q": "delegate",
                "sequence": 0,
                "result": {"data": {"preview": "report\n" + json.dumps(report)}},
                "modelView": {
                    "content": [{"raw": {"data": report, "metadata": report}}],
                },
            }

        self.assertEqual(
            compare_traces(
                [record(FIRST_SUBAGENT, "native")],
                [record(SECOND_SUBAGENT, "sidecar")],
            ),
            [],
        )

    def test_non_generated_one_shot_reference_remains_semantic(self) -> None:
        left = {"subagentSessionId": "stable-session", "transcriptRelativePath": "subagents/stable.jsonl"}
        right = {"subagentSessionId": "other-session", "transcriptRelativePath": "subagents/other.jsonl"}

        self.assertNotEqual(canonicalize(left), canonicalize(right))

    def test_concurrency_safe_tool_lifecycle_compares_by_tool_and_phase(self) -> None:
        def event(kind: str, name: str, tool_call_id: str, sequence: int) -> dict[str, object]:
            result = {"toolName": name, "toolCallId": tool_call_id, "type": "success"} if kind == "tool.result" else None
            return {
                "kind": kind,
                "scenarioId": "parallel-tools",
                "q": "compare",
                "sequence": sequence,
                "name": name if kind != "tool.result" else None,
                "toolCallId": tool_call_id,
                "result": result,
                "concurrencySafe": True,
                "sideEffectCount": 0,
            }

        serial = [
            event("tool.call", "lookup", "call-1", 0), event("tool.start", "lookup", "call-1", 1),
            event("tool.finish", "lookup", "call-1", 2), event("tool.result", "lookup", "call-1", 3),
            event("tool.call", "summarize", "call-2", 4), event("tool.start", "summarize", "call-2", 5),
            event("tool.finish", "summarize", "call-2", 6), event("tool.result", "summarize", "call-2", 7),
        ]
        interleaved = [
            event("tool.call", "lookup", "call-1", 0), event("tool.start", "lookup", "call-1", 1),
            event("tool.call", "summarize", "call-2", 2), event("tool.start", "summarize", "call-2", 3),
            event("tool.finish", "lookup", "call-1", 4), event("tool.result", "lookup", "call-1", 5),
            event("tool.finish", "summarize", "call-2", 6), event("tool.result", "summarize", "call-2", 7),
        ]

        self.assertEqual(compare_traces(serial, interleaved), [])

    def test_concurrency_canonicalization_requires_unique_identities_and_no_side_effect(self) -> None:
        def event(kind: str, sequence: int, *, tool_call_id: str = "call-1", side_effect_count: int = 0) -> dict[str, object]:
            return {
                "kind": kind,
                "scenarioId": "parallel-tools",
                "q": "compare",
                "sequence": sequence,
                "name": "lookup",
                "toolCallId": tool_call_id,
                "concurrencySafe": True,
                "sideEffectCount": side_effect_count,
            }

        repeated = [event("tool.call", 0), event("tool.call", 1), event("tool.finish", 2)]
        reordered_repeated = [event("tool.call", 0), event("tool.finish", 1), event("tool.call", 2)]
        self.assertTrue(compare_traces(repeated, reordered_repeated))

        side_effect = [event("tool.call", 0, tool_call_id="call-1", side_effect_count=1), event("tool.call", 1, tool_call_id="call-2", side_effect_count=1), event("tool.finish", 2, tool_call_id="call-1", side_effect_count=1)]
        reordered_side_effect = [event("tool.call", 0, tool_call_id="call-1", side_effect_count=1), event("tool.finish", 1, tool_call_id="call-1", side_effect_count=1), event("tool.call", 2, tool_call_id="call-2", side_effect_count=1)]
        self.assertTrue(compare_traces(side_effect, reordered_side_effect))

    def test_non_concurrent_tool_lifecycle_order_remains_semantic(self) -> None:
        def event(kind: str, name: str, sequence: int) -> dict[str, object]:
            return {
                "kind": kind,
                "scenarioId": "ordered-tools",
                "q": "compare",
                "sequence": sequence,
                "name": name,
                "concurrencySafe": False,
            }

        serial = [event("tool.call", "first", 0), event("tool.finish", "first", 1), event("tool.call", "second", 2)]
        interleaved = [event("tool.call", "first", 0), event("tool.call", "second", 1), event("tool.finish", "first", 2)]

        self.assertTrue(compare_traces(serial, interleaved))

    def test_uuid_backed_subagent_references_compare_by_relationship(self) -> None:
        native = subagent_trace(FIRST_SUBAGENT, FIRST_MESSAGE, FIRST_TURN)
        sidecar = subagent_trace(SECOND_SUBAGENT, SECOND_MESSAGE, SECOND_TURN)

        self.assertEqual(canonicalize(native), canonicalize(sidecar))

    def test_wrong_followup_target_is_not_normalized_away(self) -> None:
        native = subagent_trace(FIRST_SUBAGENT, FIRST_MESSAGE, FIRST_TURN)
        wrong_target = subagent_trace(SECOND_SUBAGENT, SECOND_MESSAGE, SECOND_TURN, OTHER_SUBAGENT)

        self.assertNotEqual(canonicalize(native), canonicalize(wrong_target))

    def test_non_generated_subagent_ids_remain_semantic(self) -> None:
        left = {"subagent_id": "review-child"}
        right = {"subagent_id": "build-child"}

        self.assertNotEqual(canonicalize(left), canonicalize(right))

    def test_parent_close_is_an_explicit_oracle_condition(self) -> None:
        records = [{
            "kind": "sidecar.lifecycle",
            "scenarioId": "parent-close",
            "q": "close",
            "sequence": 0,
            "state": "parent_closed",
            "parentClosed": True,
        }]

        self.assertEqual(
            validate_trace_expectations(records, {"expected": {"parentClosed": True}}, "pilotdeck"),
            [],
        )

    def test_parent_abort_requires_acknowledgement_and_one_gateway_terminal(self) -> None:
        records = [
            {
                "kind": "sidecar.lifecycle",
                "scenarioId": "parent-abort",
                "q": "abort",
                "sequence": 0,
                "state": "parent_abort_acknowledged",
                "parentAborted": True,
            },
            {
                "kind": "sidecar.lifecycle",
                "scenarioId": "parent-abort",
                "q": "abort",
                "sequence": 1,
                "state": "parent_abort_settled",
                "parentAborted": True,
                "terminalCount": 1,
            },
        ]

        self.assertEqual(
            validate_trace_expectations(
                records,
                {"expected": {"parentAborted": True, "terminalCount": 1}},
                "pilotdeck",
            ),
            [],
        )


if __name__ == "__main__":
    unittest.main()
