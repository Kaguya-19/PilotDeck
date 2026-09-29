from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import re
from contextlib import suppress
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from sqlmodel import Session, SQLModel, create_engine, select

SD_ROOT = Path(os.environ.get("STAFFDECK_ROOT", "")).expanduser().resolve()
if not str(SD_ROOT) or not (SD_ROOT / "backend").is_dir():
    raise SystemExit("Set STAFFDECK_ROOT to the StaffDeck checkout.")
sys.path.insert(0, str(SD_ROOT / "backend"))

from app.core.agent_loop import AgentLoop
from app.db.models import (
    AgentKnowledgeBranch, AgentProfile, AgentResourceBinding, HarnessInvocationRecord,
    KnowledgeBase, KnowledgeBaseVersion, KnowledgeBucket, KnowledgeChunk,
    KnowledgeDocument, ModelConfig, Skill, Tenant, User,
)
from app.security.encryption import encrypt_secret
from app.session.session_schema import ChatTurnRequest
from staffdeck_harness.bridge.engine_host import reset_runtime
from app.config import get_settings
from app.knowledge.service import KnowledgeService

TENANT = os.environ.get("NATIVE_TENANT_ID", "tenant_demo")
ACTOR = os.environ.get("NATIVE_ACTOR_USER_ID", "admin")
AGENT = os.environ.get("NATIVE_AGENT_ID", "agent_7d062081c03b4e16")
KB = os.environ.get("NATIVE_KNOWLEDGE_BASE_ID", "kb_native_g4")
OTHER_KB = os.environ.get("NATIVE_OTHER_KNOWLEDGE_BASE_ID", "kb_other_not_granted")
KB_VERSION = "kbver_native_g4"
DOC = "kdoc_native_g4"
BUCKET = "kbucket_native_g4"
CHUNK = "kchunk_native_g4"
SKILL_ROW = "skill_native_g4"
SKILL_ID = "native-g4-knowledge"
FACT = os.environ.get("NATIVE_FACT", "Native branch-only owner approval fact 7d062081c03b4e16")
UPDATED_FACT = os.environ.get(
    "NATIVE_UPDATED_FACT",
    "Native branch updated security review fact 7d062081c03b4e16",
)
PORT_START = int(os.environ.get("NATIVE_MODEL_PORT_START", "16100"))
PORT_END = int(os.environ.get("NATIVE_MODEL_PORT_END", "16129"))
PORTS = range(PORT_START, PORT_END + 1)
MODE = os.environ.get("STAFFDECK_NATIVE_MODE", "mock").strip().lower()
DEFAULT_MESSAGE = os.environ.get(
    "NATIVE_USER_MESSAGE",
    f"/sop {SKILL_ID}",
)


class MockLLM(BaseHTTPRequestHandler):
    mode = "allowed"
    requests: list[dict[str, Any]] = []
    responses: list[dict[str, Any]] = []

    def log_message(self, *_args: Any) -> None:
        return

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        self.__class__.requests.append({"path": self.path, "body": body, "mode": self.mode})
        messages = body.get("messages") if isinstance(body, dict) else []
        has_tool_result = any(isinstance(item, dict) and item.get("role") == "tool" for item in messages or [])
        if isinstance(body, dict) and "tools" not in body:
            content = json.dumps({"selected_document_ids": [DOC], "selected_bucket_ids": [BUCKET]})
            self._reply(body, content=content)
            return
        previous_tool_name = None
        for item in reversed(messages or []):
            if not isinstance(item, dict) or item.get("role") != "assistant":
                continue
            tool_calls = item.get("tool_calls") or []
            if tool_calls and isinstance(tool_calls[0], dict):
                previous_tool_name = (tool_calls[0].get("function") or {}).get("name")
            break
        if has_tool_result and previous_tool_name == "mcp__staffdeck__submit_step_result":
            self._reply(body, content="Native StaffDeck turn completed.")
            return
        if self.mode == "noGrant" and "tools" in body:
            self._reply(body, content="No Knowledge capability is available in this scope.")
            return
        if has_tool_result:
            if self.mode == "overreach":
                args = {"status": "failed", "reply_fragment": "The requested base is not authorized.", "task_summary": "Native authorization denied."}
            else:
                args = {"status": "completed", "reply_fragment": f"Owner approval is required before release. {FACT}. Source: [1].", "task_summary": "Native Knowledge citation retrieved."}
            self._reply(body, tool_name="mcp__staffdeck__submit_step_result", arguments=args)
            return
        query_base = OTHER_KB if self.mode == "overreach" else KB
        self._reply(
            body,
            tool_name="mcp__staffdeck__knowledge_search",
            arguments={"query": "owner approval before release", "knowledge_base_ids": [query_base], "max_chunks": 8},
        )

    def _reply(self, body: dict[str, Any], *, content: str | None = None, tool_name: str | None = None, arguments: dict[str, Any] | None = None) -> None:
        self.__class__.responses.append(
            {"mode": self.mode, "toolName": tool_name, "content": content}
        )
        stream = bool(body.get("stream", True))
        if tool_name:
            delta = {"role": "assistant", "content": None, "tool_calls": [{"index": 0, "id": "native-call-1", "type": "function", "function": {"name": tool_name, "arguments": json.dumps(arguments or {}, ensure_ascii=False)}}]}
            terminal = {"choices": [{"delta": {"content": ""}, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 3, "completion_tokens": 3}}
        else:
            delta = {"role": "assistant", "content": content or ""}
            terminal = {"choices": [{"delta": {"content": ""}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 3, "completion_tokens": 3}}
        chunks = [{"choices": [{"delta": delta, "finish_reason": None}]}, terminal]
        if not stream:
            message = {"role": "assistant", "content": content or None}
            if tool_name:
                message["tool_calls"] = delta["tool_calls"]
            payload = {"id": "native-probe", "object": "chat.completion", "choices": [{"message": message, "finish_reason": "tool_calls" if tool_name else "stop"}], "model": "native-probe"}
            encoded = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
            return
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.end_headers()
        for chunk in chunks:
            self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode())
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


class RealModelRecorder(BaseHTTPRequestHandler):
    """Runtime-only provider forwarder; tracked evidence keeps request/answer content only."""

    remote_base = ""
    requests: list[dict[str, Any]] = []
    responses: list[dict[str, Any]] = []

    def log_message(self, *_args: Any) -> None:
        return

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            body = {}
        self.__class__.requests.append({"path": self.path, "body": body})
        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in {"host", "content-length", "connection"}
        }
        if not any(key.lower() == "authorization" for key in headers):
            runtime_key = os.environ.get("STAFFDECK_MODEL_API_KEY", "")
            if runtime_key:
                headers["Authorization"] = f"Bearer {runtime_key}"
        remote_path = self.path
        if self.__class__.remote_base.rstrip("/").endswith("/v1") and remote_path.startswith("/v1/"):
            remote_path = remote_path[3:]
        target = self.__class__.remote_base.rstrip("/") + remote_path
        try:
            response = urlopen(Request(target, data=raw, headers=headers, method="POST"), timeout=600)
            payload = response.read()
            status = response.status
            content_type = response.headers.get("content-type", "")
            self.__class__.responses.append(parse_model_response(payload, content_type))
        except HTTPError as exc:
            payload = exc.read()
            status = exc.code
            content_type = exc.headers.get("content-type", "")
            self.__class__.responses.append({"error": f"HTTP_{status}", **parse_model_response(payload, content_type)})
        except (URLError, OSError, TimeoutError) as exc:
            payload = b"{\"error\":\"provider_unavailable\"}"
            status = 502
            content_type = "application/json"
            self.__class__.responses.append({"error": type(exc).__name__})
        self.send_response(status)
        self.send_header("content-type", content_type or "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def parse_model_response(payload: bytes, content_type: str) -> dict[str, Any]:
    text_parts: list[str] = []
    tool_calls: list[dict[str, str]] = []
    finish_reason = None
    chunks: list[dict[str, Any]] = []
    if "text/event-stream" in content_type:
        for line in payload.decode("utf-8", errors="replace").splitlines():
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue
            with suppress(json.JSONDecodeError):
                chunks.append(json.loads(line[6:]))
    else:
        with suppress(json.JSONDecodeError):
            chunks.append(json.loads(payload or b"{}"))
    for item in chunks:
        choice = (item.get("choices") or [{}])[0]
        delta = choice.get("delta") or choice.get("message") or {}
        if isinstance(delta.get("content"), str):
            text_parts.append(delta["content"])
        for call in delta.get("tool_calls") or []:
            function = call.get("function") or {}
            index = int(call.get("index", 0))
            while len(tool_calls) <= index:
                tool_calls.append({"name": "", "arguments": ""})
            if function.get("name"):
                tool_calls[index]["name"] = str(function["name"])
            tool_calls[index]["arguments"] += str(function.get("arguments") or "")
        finish_reason = choice.get("finish_reason") or finish_reason
    return {
        "text": "".join(text_parts),
        "toolCalls": [call for call in tool_calls if call.get("name")],
        "finishReason": finish_reason,
    }


def free_port() -> int:
    for port in PORTS:
        try:
            server = HTTPServer(("127.0.0.1", port), MockLLM)
        except OSError:
            continue
        server.server_close()
        return port
    raise RuntimeError("No free port in 16100-16129")


def seed(db: Session, *, model_base_url: str, model_api_key: str, model_name: str) -> None:
    db.add(Tenant(id=TENANT, name="G4 native reference tenant"))
    db.add(User(id=ACTOR, tenant_id=TENANT, username=ACTOR, display_name="Admin", role="admin", password_hash="probe"))
    db.add(AgentProfile(id=AGENT, tenant_id=TENANT, name="G4 native reference agent"))
    db.add(ModelConfig(id="model_native_g4", tenant_id=TENANT, name="Native G4 provider", provider="openai_compatible", base_url=model_base_url, api_key_encrypted=encrypt_secret(model_api_key), model=model_name, enabled=True, is_default=True))
    db.add(KnowledgeBase(id=KB, tenant_id=TENANT, name="Native G4 approval policy", status="active", capability_scope="sop_specific"))
    db.add(KnowledgeBase(id=OTHER_KB, tenant_id=TENANT, name="Other ungranted base", status="active", capability_scope="sop_specific"))
    db.add(KnowledgeBaseVersion(id=KB_VERSION, tenant_id=TENANT, knowledge_base_id=KB, version="1.0.0", name="Native G4 approval policy", status="active", capability_scope="sop_specific"))
    db.add(AgentKnowledgeBranch(tenant_id=TENANT, agent_id=AGENT, knowledge_base_id=KB, base_version="1.0.0", head_version="1.0.0", status="active", sync_state="synced"))
    db.add(KnowledgeDocument(id=DOC, tenant_id=TENANT, knowledge_base_id=KB, knowledge_base_version_id=KB_VERSION, filename="approval-policy.md", file_type="md", title="Approval policy", status="ready", bucket_count=1, chunk_count=1, metadata_json={"summary": FACT}))
    db.add(KnowledgeBucket(id=BUCKET, tenant_id=TENANT, knowledge_base_id=KB, knowledge_base_version_id=KB_VERSION, document_id=DOC, bucket_key="release-approval", title="Release owner approval", summary=f"Owner approval is required before release. {FACT}", metadata_json={"content": FACT, "bucket_type": "policy", "quality": {}, "section_ids": []}))
    db.add(KnowledgeChunk(id=CHUNK, tenant_id=TENANT, knowledge_base_id=KB, knowledge_base_version_id=KB_VERSION, document_id=DOC, bucket_id=BUCKET, chunk_index=0, content=f"Owner approval is required before release. {FACT}.", summary=FACT, source_ref="ultrarag://knowledge/documents/kdoc_native_g4", metadata_json={"section_path": "Release approval"}))
    db.add(Skill(id=SKILL_ROW, tenant_id=TENANT, skill_id=SKILL_ID, version="1.0.0", name="Native G4 Knowledge reference", status="published", content_json={"start_node_id": "search", "goal": ["Answer the approval policy question."], "nodes": [{"node_id": "search", "type": "task", "instruction": "Use native Knowledge to answer with a source citation.", "capability_refs": {"knowledge_base_ids": [KB], "required_knowledge_base_ids": [KB]}}], "edges": []}))
    private = {"scope": "agent_private", "visibility": "agent_private", "owner_agent_id": AGENT}
    db.add(AgentResourceBinding(id="binding-skill-native-g4", tenant_id=TENANT, agent_id=AGENT, resource_type="skill", resource_id=SKILL_ROW, status="active", metadata_json={**private, "slot_bindings": {f"kb:{KB}": KB}}))
    db.add(AgentResourceBinding(id="binding-kb-native-g4", tenant_id=TENANT, agent_id=AGENT, resource_type="knowledge_base", resource_id=KB, status="active", metadata_json=private))
    db.commit()


def turn(db: Session, *, mode: str, client_id: str, message: str, recorder: type[BaseHTTPRequestHandler]) -> dict[str, Any]:
    if MODE == "mock":
        MockLLM.mode = mode
    request_start = len(recorder.requests)  # type: ignore[attr-defined]
    response_start = len(recorder.responses)  # type: ignore[attr-defined]
    invocation_start = len(db.exec(select(HarnessInvocationRecord)).all())
    request = ChatTurnRequest(tenant_id=TENANT, agent_id=AGENT, model_config_id="model_native_g4", client_turn_id=client_id, user_id=ACTOR, message=message, channel="web", interaction_mode="normal")
    response = AgentLoop(db).handle_turn(request)
    records = db.exec(select(HarnessInvocationRecord)).all()[invocation_start:]
    model_requests = recorder.requests[request_start:]  # type: ignore[attr-defined]
    tool_schemas = sorted(
        {
            str(tool.get("function", tool).get("name") or tool.get("name") or "")
            for item in model_requests
            for tool in (item["body"].get("tools") or [])
            if isinstance(tool, dict)
        }
        - {""}
    )
    tool_results = [
        str(item.get("content") or "")
        for request_item in model_requests
        for item in (request_item["body"].get("messages") or [])
        if isinstance(item, dict) and item.get("role") == "tool"
    ]
    routing = routing_classification(response.step_result)
    return {
        "reply": response.reply,
        "runtimeError": response.runtime_error_code,
        "stepResult": response.step_result.model_dump(mode="json") if response.step_result else None,
        "invocations": [
            {"toolName": row.tool_name, "status": row.status, "result": row.result_json}
            for row in records
        ],
        "modelResponses": recorder.responses[response_start:],  # type: ignore[attr-defined]
        "modelToolSchemas": tool_schemas,
        "toolResults": tool_results,
        "modelRequests": len(model_requests),
        "mode": mode,
        "userMessage": message,
        "routing": routing_classification(response.step_result),
    }


def routing_classification(step_result: Any) -> dict[str, Any]:
    results = getattr(step_result, "knowledge_results", None) or []
    traces = [item for result in results for item in (result.get("route_trace") or result.get("trace") or [])]
    phases = [str(item.get("phase") or "") for item in traces if isinstance(item, dict)]
    if any("fallback" in phase or phase.endswith("_failed") for phase in phases):
        kind = "lexical_fallback"
    elif any(phase.endswith("_lexical") for phase in phases):
        kind = "lexical_route"
    else:
        kind = "normal_model_route"
    return {"kind": kind, "phases": phases}


def safe_turn(db: Session, *, mode: str, client_id: str, message: str, recorder: type[BaseHTTPRequestHandler]) -> dict[str, Any]:
    try:
        return turn(db, mode=mode, client_id=client_id, message=message, recorder=recorder)
    except Exception as exc:  # native compiler denial is part of the no-grant evidence
        return {"errorType": type(exc).__name__, "error": str(exc), "mode": mode}


def sanitize(value: Any, secrets: list[str]) -> Any:
    if isinstance(value, str):
        for secret in secrets:
            if secret:
                value = value.replace(secret, "<redacted>")
        return value
    if isinstance(value, list):
        return [sanitize(item, secrets) for item in value]
    if isinstance(value, dict):
        return {key: sanitize(item, secrets) for key, item in value.items()}
    return value


def main() -> None:
    if MODE not in {"mock", "real"}:
        raise SystemExit("STAFFDECK_NATIVE_MODE must be mock or real")
    harness_root = os.environ.get("HARNESS_V3_ROOT", "")
    node_bin = os.environ.get("HARNESS_V3_NODE_BIN", "")
    if not harness_root or not node_bin:
        raise SystemExit("Set HARNESS_V3_ROOT and HARNESS_V3_NODE_BIN.")
    owned_home = "HARNESS_V3_HOME" not in os.environ
    owned_data = "ULTRARAG_DATA_DIR" not in os.environ
    harness_home = os.environ.get("HARNESS_V3_HOME") or tempfile.mkdtemp(prefix="staffdeck-native-harness-")
    data_dir = os.environ.get("ULTRARAG_DATA_DIR") or tempfile.mkdtemp(prefix="staffdeck-native-data-")
    db_path = Path(tempfile.mktemp(prefix="staffdeck-native-", suffix=".sqlite"))
    os.environ["APP_SECRET"] = os.environ.get("APP_SECRET", "native-g4-probe-secret")
    os.environ["ULTRARAG_DATA_DIR"] = data_dir
    if MODE == "mock":
        model_name = "native-probe"
        model_key = "probe"
        port = free_port()
        server_class: type[BaseHTTPRequestHandler] = MockLLM
        server = HTTPServer(("127.0.0.1", port), server_class)
        model_base_url = f"http://127.0.0.1:{port}/v1"
        message = DEFAULT_MESSAGE
    else:
        model_name = os.environ.get("STAFFDECK_MODEL_NAME", "qwen3.6-flash-distill")
        model_key = os.environ.get("STAFFDECK_MODEL_API_KEY", "")
        remote_base = os.environ.get("STAFFDECK_MODEL_BASE_URL", "")
        if not model_key or not remote_base:
            raise SystemExit("Real mode requires STAFFDECK_MODEL_BASE_URL and STAFFDECK_MODEL_API_KEY at runtime.")
        port = free_port()
        server_class = RealModelRecorder
        RealModelRecorder.remote_base = remote_base
        server = HTTPServer(("127.0.0.1", port), server_class)
        model_base_url = f"http://127.0.0.1:{port}/v1"
        message = os.environ.get(
            "NATIVE_REAL_USER_MESSAGE",
            "What is the current approval policy for a release decision, specifically what owner-approval fact applies before release?",
        )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    settings = get_settings()
    settings.harness_v3_root = harness_root
    settings.harness_v3_home = harness_home
    settings.harness_v3_node_bin = node_bin
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    output: dict[str, Any] = {
        "schemaVersion": 2,
        "status": "PASS",
        "mode": MODE,
        "model": model_name,
        "startup": {
            "scope": {"tenantId": TENANT, "actorUserId": ACTOR, "agentId": AGENT},
            "modelPortRange": [PORT_START, PORT_END],
            "modelPort": port,
            "runtimeIsolation": True,
            "nodeVersion": next((part for part in reversed(Path(node_bin).parts) if re.fullmatch(r"v\d+(?:\.\d+){1,2}", part)), "configured"),
        },
    }
    try:
        with Session(engine) as db:
            seed(db, model_base_url=model_base_url, model_api_key=model_key, model_name=model_name)
            if MODE == "mock":
                output["allowed"] = safe_turn(db, mode="allowed", client_id="native-g4-allowed", message=message, recorder=server_class)
                output["overreach"] = safe_turn(db, mode="overreach", client_id="native-g4-overreach", message=message, recorder=server_class)
                binding = db.get(AgentResourceBinding, "binding-kb-native-g4")
                binding.status = "deleted"
                db.add(binding)
                db.commit()
                reset_runtime()
                output["noGrant"] = safe_turn(db, mode="allowed", client_id="native-g4-no-grant-slash", message=message, recorder=server_class)
                reset_runtime()
                no_grant_message = os.environ.get(
                    "NATIVE_NO_GRANT_MESSAGE",
                    "What is the owner approval requirement before release?",
                )
                output["noGrantNormal"] = safe_turn(
                    db,
                    mode="noGrant",
                    client_id="native-g4-no-grant-normal",
                    message=no_grant_message,
                    recorder=server_class,
                )
                allowed = output["allowed"]
                overreach = output["overreach"]
                no_grant = output["noGrant"]
                no_grant_normal = output["noGrantNormal"]
                allowed_text = json.dumps(allowed, ensure_ascii=False)
                overreach_text = json.dumps(overreach, ensure_ascii=False)
                output["checks"] = {
                    "allowedNativeKnowledgeAndSubmission": {
                        "passed": (
                            "mcp__staffdeck__knowledge_search" in [item.get("toolName") for item in allowed.get("modelResponses", [])]
                            and "mcp__staffdeck__submit_step_result" in [item.get("toolName") for item in allowed.get("modelResponses", [])]
                            and FACT in allowed_text and "[1]" in allowed_text
                            and "ultrarag://knowledge/documents/kdoc_native_g4" in allowed_text
                            and bool((allowed.get("stepResult") or {}).get("is_step_completed"))
                        )
                    },
                    "overreachDeniedByNativeCapability": {
                        "passed": (
                            "mcp__staffdeck__knowledge_search" in [item.get("toolName") for item in overreach.get("modelResponses", [])]
                            and "PERMISSION_DENIED" in overreach_text
                            and not (overreach.get("stepResult") or {}).get("is_step_completed")
                        )
                    },
                    "noGrantHidesNativeKnowledgeTool": {
                        "passed": "mcp__staffdeck__knowledge_search" not in (no_grant.get("modelToolSchemas") or [])
                    },
                    "noGrantNormalTurnReachesModelWithoutKnowledge": {
                        "passed": (
                            no_grant_normal.get("runtimeError") is None
                            and no_grant_normal.get("modelRequests", 0) > 0
                            and "mcp__staffdeck__knowledge_search" not in (no_grant_normal.get("modelToolSchemas") or [])
                            and "mcp__staffdeck__knowledge_search" not in [
                                item.get("toolName") for item in no_grant_normal.get("modelResponses", [])
                            ]
                        )
                    },
                }
                output["routingComparison"] = {
                    "mockPath": "lexical_fallback",
                    "reason": "The deterministic mock intentionally returns empty routing choices; this is Harness/permission evidence, not normal model-selection evidence.",
                    "noGrantSlash": "pre_model_contract_rejection",
                    "noGrantNormal": "model_reached_without_knowledge_tool",
                }
                output["status"] = "PASS" if all(item["passed"] for item in output["checks"].values()) else "FAIL"
            else:
                output["realProviderTurn"] = safe_turn(db, mode="allowed", client_id="native-g4-real", message=message, recorder=server_class)
                real = output["realProviderTurn"]
                document = db.get(KnowledgeDocument, DOC)
                if document is None:
                    raise RuntimeError(f"Seeded document {DOC} was not found")
                KnowledgeService(db).replace_document_content(
                    document,
                    f"# Release approval\n\nOwner approval is required before release. {UPDATED_FACT}.",
                )
                reset_runtime()
                updated_message = (
                    "After the policy update, what is the current owner approval fact "
                    "for release?"
                )
                output["realProviderUpdatedTurn"] = safe_turn(
                    db,
                    mode="allowed",
                    client_id="native-g4-real-updated",
                    message=updated_message,
                    recorder=server_class,
                )
                updated = output["realProviderUpdatedTurn"]
                output["routingComparison"] = {
                    "realPath": real.get("routing", {}).get("kind"),
                    "realUpdatedPath": updated.get("routing", {}).get("kind"),
                    "mockPath": "lexical_fallback",
                    "normalModelSelectionRequired": True,
                }
                real_text = json.dumps(real, ensure_ascii=False)
                updated_text = json.dumps(updated, ensure_ascii=False)
                output["checks"] = {
                    "realProviderNativeTurn": {
                        "passed": (
                            real.get("runtimeError") is None
                            and FACT in real_text
                            and "[1]" in real_text
                            and real.get("routing", {}).get("kind") == "normal_model_route"
                        )
                    },
                    "realProviderKnowledgeUpdateNewSession": {
                        "passed": (
                            updated.get("runtimeError") is None
                            and UPDATED_FACT in updated_text
                            and "[1]" in updated_text
                            and "ultrarag://knowledge/documents/kdoc_native_g4" in updated_text
                            and updated.get("routing", {}).get("kind") == "normal_model_route"
                            and FACT not in updated_text
                            and updated.get("modelRequests", 0) > 0
                        )
                    },
                }
                output["knowledgeUpdate"] = {
                    "documentId": DOC,
                    "oldFact": FACT,
                    "newFact": UPDATED_FACT,
                    "newSessionUserMessage": updated_message,
                    "service": "KnowledgeService.replace_document_content",
                    "updatedTurn": updated,
                }
                output["status"] = "PASS" if all(item["passed"] for item in output["checks"].values()) else "BLOCKED"
    finally:
        with suppress(Exception):
            reset_runtime()
        server.shutdown()
        server.server_close()
        with suppress(Exception):
            db_path.unlink()
        if os.environ.get("NATIVE_CLEANUP", "1") != "0":
            import shutil
            if owned_home:
                shutil.rmtree(harness_home, ignore_errors=True)
            if owned_data:
                shutil.rmtree(data_dir, ignore_errors=True)
    output["cleanup"] = {
        "runtimeHomeOwned": owned_home,
        "dataDirOwned": owned_data,
        "temporaryDatabaseRemoved": True,
        "performed": os.environ.get("NATIVE_CLEANUP", "1") != "0",
    }
    secrets = [
        harness_home,
        data_dir,
        str(db_path),
        model_base_url,
        os.environ.get("STAFFDECK_MODEL_API_KEY", ""),
        os.environ.get("STAFFDECK_MODEL_BASE_URL", ""),
    ]
    output = sanitize(output, secrets)
    out = Path(os.environ.get("STAFFDECK_NATIVE_V3_OUT", "staffdeck-native-g4-reference.json"))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(out)


if __name__ == "__main__":
    main()
