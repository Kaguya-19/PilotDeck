"""Drive a built PilotDeck sidecar against the shared deterministic mock."""
from __future__ import annotations

import datetime as dt
import json
import os
import subprocess
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any


def post(url: str, body: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read())


def write_trace(path: Path, records: list[dict[str, Any]]) -> None:
    path.write_text("\n".join(json.dumps(item, ensure_ascii=False) for item in records) + "\n", encoding="utf-8")


def scenario_messages(scenario: dict[str, Any]) -> list[dict[str, Any]]:
    messages = [
        dict(message)
        for message in scenario.get("messages") or []
        if isinstance(message, dict)
    ]
    if messages and messages[-1].get("role") == "user":
        return messages
    return [*messages, {"role": "user", "content": str(scenario["q"])}]


def main() -> int:
    scenario = json.loads(os.environ["PARITY_SCENARIO_JSON"])
    source = Path(os.environ["PARITY_SOURCE_ROOT"])
    mock = os.environ["PARITY_MOCK_BASE_URL"]
    run_key = os.environ.get("PARITY_RUN_KEY", "sidecar-parity")
    output = Path(os.environ["PARITY_TRACE_OUT"])
    command = ["node", str(source / "dist/src/cli/pilotdeck-agent-loop-sidecar.js")]
    process = subprocess.Popen(command, cwd=source, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    assert process.stdin and process.stdout
    records: list[dict[str, Any]] = []
    sequence = 0
    scenario_id = str(scenario["scenarioId"])
    q = str(scenario["q"])
    tools = [{"name": name, "description": name, "kind": "custom", "inputSchema": {"type": "object"}, "readOnly": name not in {"restricted", "loop"}, "concurrencySafe": name in {"lookup", "summarize"}} for name in scenario.get("tools", [])]
    messages = scenario_messages(scenario)
    payload: dict[str, Any] = {
        "agent": {"provider": "parity", "model": "deterministic", "cwd": str(source), "systemPrompt": "Return the deterministic answer.", "runMode": "normal"},
        "messages": messages, "tools": tools,
        "permissionContext": {"mode": "default", "canPrompt": False, "bypassAvailable": False, "rules": {"allow": [], "deny": [{"source": "user", "behavior": "deny", "toolName": name} for name in scenario.get("permission", {}).get("deny", [])], "ask": []}},
        "seedState": scenario.get("seedState"), "executionContext": {"scenarioId": scenario_id},
    }
    limits = scenario.get("limits") if isinstance(scenario.get("limits"), dict) else {}
    if limits.get("maxTurns"):
        payload["agent"]["maxTurns"] = limits["maxTurns"]
    now = dt.datetime.now(dt.UTC)
    deadline_ms = int(limits.get("deadlineMs") or 0)
    request = {"kind": "request", "messageId": "execute-1", "method": "execute", "runId": "run-parity", "operationId": f"op-{scenario_id}", "requestId": "request-1", "sessionId": "session-parity", "turnId": "turn-parity", "idempotencyKey": "parity-effect", "payload": payload}
    if deadline_ms:
        request["operationDeadline"] = (now + dt.timedelta(milliseconds=deadline_ms)).isoformat().replace("+00:00", "Z")
    process.stdin.write(json.dumps(request) + "\n")
    process.stdin.flush()
    started = time.monotonic()

    def cancel_later() -> None:
        delay = int(limits.get("cancelAfterMs") or 0)
        if delay <= 0:
            return
        threading.Event().wait(delay / 1000)
        if process.poll() is None:
            process.stdin.write(json.dumps({"kind": "request", "messageId": "cancel-1", "method": "cancel", "runId": "run-parity", "operationId": f"op-{scenario_id}", "requestId": "request-1", "reason": "parity_cancel"}) + "\n")
            process.stdin.flush()

    threading.Thread(target=cancel_later, daemon=True).start()
    try:
        for line in process.stdout:
            if time.monotonic() - started > 15:
                records.append({"kind": "terminal", "scenarioId": scenario_id, "q": q, "sequence": sequence, "outcome": "result_unknown", "code": "ADAPTER_TIMEOUT"})
                break
            if not line.strip():
                continue
            message = json.loads(line)
            if message.get("kind") == "request" and message.get("method") == "module_call":
                module = message.get("module")
                call_payload = message.get("payload") if isinstance(message.get("payload"), dict) else {}
                if module == "model":
                    model_request = call_payload.get("request") if isinstance(call_payload.get("request"), dict) else {}
                    model_response = post(f"{mock}/v1/chat/completions", {"scenarioId": scenario_id, "q": q, "messages": model_request.get("messages", messages), "runKey": run_key})
                    choice = model_response["choices"][0]["message"]
                    events: list[dict[str, Any]] = [{"type": "message_start", "role": "assistant"}]
                    if choice.get("tool_calls"):
                        for call in choice["tool_calls"]:
                            events.append({"type": "tool_call_end", "toolCall": {"id": call["id"], "name": call["function"]["name"], "input": json.loads(call["function"]["arguments"])}})
                        events.append({"type": "message_end", "finishReason": "tool_call"})
                    else:
                        events.extend([{"type": "text_delta", "text": choice.get("content") or ""}, {"type": "message_end", "finishReason": "stop"}])
                    response = {"kind": "response", "messageId": "model-response", "inReplyTo": message["messageId"], "requestId": message.get("requestId"), "ok": True, "payload": {"events": events}}
                    records.append({"kind": "model.request", "scenarioId": scenario_id, "q": q, "sequence": sequence, "request": model_request}); sequence += 1
                    records.append({"kind": "model.response", "scenarioId": scenario_id, "q": q, "sequence": sequence, "response": choice}); sequence += 1
                elif module == "capability":
                    tool_name = str(call_payload.get("name") or "")
                    result = post(f"{mock}/tools/execute", {"scenarioId": scenario_id, "q": q, "name": tool_name, "arguments": call_payload.get("arguments") or {}, "permissionAllowed": tool_name not in scenario.get("permission", {}).get("deny", []), "runKey": run_key})
                    result.setdefault("toolCallId", call_payload.get("toolCallId"))
                    result.setdefault("toolName", tool_name)
                    result["content"] = ([{"type": "text", "text": json.dumps(result.get("data", {}), ensure_ascii=False, sort_keys=True)}] if result.get("type") == "success" else [{"type": "text", "text": result.get("error", {}).get("message", "mock tool error")}])
                    result.setdefault("metadata", {})
                    result.setdefault("startedAt", "1970-01-01T00:00:00.000Z")
                    result.setdefault("completedAt", "1970-01-01T00:00:00.000Z")
                    response = {"kind": "response", "messageId": "tool-response", "inReplyTo": message["messageId"], "requestId": message.get("requestId"), "ok": True, "payload": result}
                    records.append({"kind": "tool.call", "scenarioId": scenario_id, "q": q, "sequence": sequence, "name": tool_name, "arguments": call_payload.get("arguments") or {}}); sequence += 1
                    records.append({"kind": "tool.result", "scenarioId": scenario_id, "q": q, "sequence": sequence, "result": result}); sequence += 1
                elif module == "permission":
                    allowed = str(call_payload.get("toolName") or call_payload.get("name") or "") not in scenario.get("permission", {}).get("deny", [])
                    response = {"kind": "response", "messageId": "permission-response", "inReplyTo": message["messageId"], "requestId": message.get("requestId"), "ok": True, "payload": {"allowed": allowed}}
                    records.append({"kind": "permission.decision", "scenarioId": scenario_id, "q": q, "sequence": sequence, "allowed": allowed}); sequence += 1
                else:
                    response = {"kind": "response", "messageId": "module-response", "inReplyTo": message["messageId"], "requestId": message.get("requestId"), "ok": True, "payload": {"accepted": True}}
                process.stdin.write(json.dumps(response) + "\n")
                process.stdin.flush()
                write_trace(output, records)
                continue
            if message.get("kind") == "event":
                if message.get("final"):
                    terminal_payload = message.get("payload") if isinstance(message.get("payload"), dict) else {}
                    result = terminal_payload.get("result") if isinstance(terminal_payload.get("result"), dict) else {}
                    final_message = result.get("finalMessage") if isinstance(result.get("finalMessage"), dict) else {}
                    content = final_message.get("content") if isinstance(final_message.get("content"), list) else []
                    output_text = "".join(str(block.get("text") or "") for block in content if isinstance(block, dict) and block.get("type") == "text")
                    records.append({"kind": "terminal", "scenarioId": scenario_id, "q": q, "sequence": sequence, "outcome": message.get("outcome"), "code": message.get("code"), "stopReason": result.get("stopReason"), "structuredResult": result.get("structuredOutput"), "output": output_text}); sequence += 1
                    process.stdin.close()
                    break
                else:
                    payload_event = message.get("payload") if isinstance(message.get("payload"), dict) else {}
                    if payload_event.get("type") == "text_delta":
                        records.append({"kind": "user.output", "scenarioId": scenario_id, "q": q, "sequence": sequence, "text": payload_event.get("text", "")}); sequence += 1
    finally:
        if process.poll() is None:
            process.terminate()
        process.wait(timeout=5)
    write_trace(output, records)
    return 0 if records and any(item["kind"] == "terminal" for item in records) else 2


if __name__ == "__main__":
    raise SystemExit(main())
