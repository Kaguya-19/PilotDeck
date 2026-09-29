"""Native StaffDeck Harness v3 real-provider SOP evidence runner."""

import json
import os
import tempfile
from pathlib import Path

import yaml
from sqlmodel import Session, SQLModel, create_engine, select

from app.agents.branching import ensure_private_resource_binding
from app.config import get_settings
from app.core.agent_loop import AgentLoop
from app.core import handoff_reply_service
from app.db.models import (
    AgentEvent, AgentProfile, ChatSession, HarnessAgentLoopRecord,
    HarnessTaskFrameRecord, HumanHandoffRequest, ModelConfig, Skill, Tenant, User,
)
from app.security.encryption import encrypt_secret
from app.session.session_schema import ChatTurnRequest
from staffdeck_harness.bridge.engine_host import reset_runtime

ROOT = Path("/Users/a1/Desktop/claw/openbmb/deepseek-harness-dsh-v0.1.2-alpha.2")
NODE = "/Users/a1/.nvm/versions/node/v22.23.1/bin/node"
PILOT_CONFIG = Path(os.environ.get("REAL_MODEL_PILOT_CONFIG", "/Users/a1/.pilotdeck/pilotdeck.yaml"))
PUBLISHED_DEFINITION = Path(os.environ.get(
    "G5_PUBLISHED_DEFINITION",
    "/Users/a1/Desktop/claw/openbmb/PilotDeck-g5-sop-agent/products/pilotdeck-staffdeck-sop/evidence/g5-published-project-delivery-plan-1.0.1.json",
))
BRANCH = os.environ.get("G5_NATIVE_BRANCH", "scope_changed")
ARTIFACT = Path(os.environ.get(
    "G5_NATIVE_ARTIFACT",
    "/Users/a1/Desktop/claw/openbmb/PilotDeck-g5-sop-agent/products/pilotdeck-staffdeck-sop/evidence/g5-staffdeck-native-real-model-20260923.json",
))

if not (ROOT / "apps/cli/lib/bin.js").is_file():
    raise RuntimeError(f"Harness v3 bin.js missing: {ROOT / 'apps/cli/lib/bin.js'}")
if not Path(NODE).is_file():
    raise RuntimeError(f"Node binary missing: {NODE}")
source = yaml.safe_load(PILOT_CONFIG.read_text(encoding="utf-8"))
published = json.loads(PUBLISHED_DEFINITION.read_text(encoding="utf-8"))
published_content = published.get("content")
if not isinstance(published_content, dict):
    raise RuntimeError("published definition does not contain a content object")
if published_content.get("skill_id") != "project_delivery_plan" or published_content.get("version") != "1.0.1":
    raise RuntimeError("published definition identity/version does not match project_delivery_plan@1.0.1")
provider = ((source.get("model") or {}).get("providers") or {}).get("provider1") or {}
provider_url = str(provider.get("url") or "").rstrip("/")
provider_key = str(provider.get("apiKey") or "")
model_name = "qwen3.6-flash-distill"
if not provider_url or not provider_key or model_name not in ((provider.get("models") or {})):
    raise RuntimeError("provider1 URL/API key/model is not configured in the selected PilotDeck config")

tmp = Path(tempfile.mkdtemp(prefix="g5-native-real-sop-"))
home = tmp / "harness-home"
data = tmp / "data"
db_path = tmp / "staffdeck.sqlite3"
os.environ.pop("NODE_OPTIONS", None)
os.environ.update({
    "HARNESS_V3_ROOT": str(ROOT), "HARNESS_V3_HOME": str(home), "HARNESS_V3_NODE_BIN": NODE,
    "HARNESS_V3_ENABLED": "true", "HARNESS_V3_E2E": "1", "ULTRARAG_DATA_DIR": str(data),
    "HARNESS_V3_REQUEST_TIMEOUT_SECONDS": "120", "HARNESS_V3_INITIALIZE_TIMEOUT_SECONDS": "60",
    "APP_SECRET": "g5-native-real-private-secret", "PATH": str(Path(NODE).parent) + ":" + os.environ.get("PATH", ""),
})
get_settings.cache_clear()

ordinary_input = (
    "请帮我梳理项目计划，目标是完成验证交付，目前处于验证阶段，暂时没有已知阻塞。"
    "范围和交付日期需要调整，请评估影响并在需要时请负责人确认，确认后继续完成计划。"
    if BRANCH == "scope_changed" else
    "请帮我梳理项目计划，目标是完成验证交付，目前处于验证阶段，范围和交付日期都不变，也没有已知阻塞，请直接整理完整推进计划。"
)
resume_input = "负责人已经确认范围和交付日期影响，请继续推进这个项目计划并完成后续工作。"
no_change_continue_input = "范围和交付日期保持不变，请继续完成这份项目推进计划并给出最终行动清单。"


def snapshot(db: Session, session_id: str) -> dict:
    session = db.get(ChatSession, session_id)
    handoffs = db.exec(select(HumanHandoffRequest).where(HumanHandoffRequest.session_id == session_id)).all()
    frames = db.exec(select(HarnessTaskFrameRecord).where(HarnessTaskFrameRecord.session_id == session_id)).all()
    loops = db.exec(select(HarnessAgentLoopRecord).where(HarnessAgentLoopRecord.session_id == session_id)).all()
    return {
        "session": None if session is None else {
            "status": session.status, "active_skill_id": session.active_skill_id,
            "active_step_id": session.active_step_id, "pending_tasks": session.pending_tasks_json,
            "awaiting_input": session.awaiting_input_json,
        },
        "handoffs": [{"id": row.id, "status": row.status, "human_reply": row.human_reply,
                      "trigger_skill_id": row.trigger_skill_id, "trigger_step_id": row.trigger_step_id,
                      "answered_at": row.answered_at.isoformat() if row.answered_at else None} for row in handoffs],
        "task_frames": [{"task_id": row.task_id, "status": row.status, "step_id": row.step_id,
                         "result": row.result_json, "error": row.error_json} for row in frames],
        "agent_loops": [{"id": row.id, "status": row.status, "kind": row.kind, "skill_id": row.skill_id,
                         "finished_at": row.finished_at.isoformat() if row.finished_at else None} for row in loops],
    }


def execution_complete(state: dict) -> bool:
    return (
        not state.get("handoffs")
        and state.get("task_frames")
        and all(row.get("status") == "completed" for row in state["task_frames"])
        and state.get("agent_loops")
        and all(row.get("status") == "completed" for row in state["agent_loops"])
        and (state.get("session") or {}).get("active_step_id") is None
        and not (state.get("session") or {}).get("awaiting_input")
    )


engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
SQLModel.metadata.create_all(engine)
handoff_reply_service.engine = engine
with Session(engine) as db:
    tenant = Tenant(id="tenant_real", name="G5 real provider tenant")
    user = User(id="user_real", tenant_id=tenant.id, username="alice", role="member", password_hash="x")
    model = ModelConfig(id="model_provider1_qwen", tenant_id=tenant.id,
        name="provider1 qwen3.6 flash distill", provider="openai_compatible", base_url=provider_url,
        api_key_encrypted=encrypt_secret(provider_key), model=model_name, is_default=True, enabled=True)
    agent = AgentProfile(id="agent_real", tenant_id=tenant.id, name="项目助手", status="active",
                         metadata_json={"owner_user_id": user.id})
    skill = Skill(id=str(published["id"]), tenant_id=tenant.id, skill_id=published_content["skill_id"],
        version=published_content["version"], name=published.get("name") or published_content["name"],
        status="published", content_json=published_content)
    db.add_all([tenant, user, model, agent, skill]); db.commit()
    ensure_private_resource_binding(db, tenant.id, agent.id, "skill", skill.id); db.commit()

    loop = AgentLoop(db)
    first = loop.handle_turn(ChatTurnRequest(tenant_id=tenant.id, agent_id=agent.id, user_id=user.id,
        message=ordinary_input, channel="web", client_turn_id="native-real-1"))
    session_id = first.session_id
    before_resume = snapshot(db, session_id)
    handoff_id = str((before_resume["session"].get("awaiting_input") or {}).get("handoff_id") or "")
    handoff = db.get(HumanHandoffRequest, handoff_id)
    if BRANCH == "scope_changed" and handoff is None:
        events = db.exec(select(AgentEvent).where(AgentEvent.session_id == session_id).order_by(AgentEvent.created_at)).all()
        diagnostic = {"status": "failed", "failure": "no_persisted_handoff", "runner": "g5-staffdeck-native-real-model-run.py",
                      "inputs": {"ordinary_user_text": ordinary_input}, "initial_reply": first.reply,
                      "initial_session": before_resume, "event_counts": {name: sum(1 for event in events if event.event_type == name)
                      for name in sorted({event.event_type for event in events})},
                      "key_events": [{"type": event.event_type, "payload": event.payload_json} for event in events
                                     if event.event_type in {"task_frame_finished", "assistant_message_created", "session_state_changed", "harness_v3_task_finished"}]}
        ARTIFACT.write_text(json.dumps(diagnostic, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        raise RuntimeError("native run did not persist a HumanHandoffRequest; diagnostic artifact was written")
    continuation = None
    if BRANCH == "no_change" and not execution_complete(before_resume):
        continuation = loop.handle_turn(ChatTurnRequest(
            tenant_id=tenant.id, agent_id=agent.id, user_id=user.id,
            session_id=session_id, message=no_change_continue_input,
            channel="web", client_turn_id="native-real-2",
        ))
    elif BRANCH == "scope_changed":
        # This is the same durable answer path used by the web/API handoff entry;
        # the callback runs the real AgentLoop resume with channel=human_handoff_resume.
        handoff_reply_service.apply_handoff_reply(
            db, handoff, resume_input, answered_by_user_id=user.id,
            source="web", resume=handoff_reply_service.resume_human_handoff_worker,
        )
    after_resume = snapshot(db, session_id)
    events = db.exec(select(AgentEvent).where(AgentEvent.session_id == session_id).order_by(AgentEvent.created_at)).all()
    resume_replies = [event.payload_json.get("reply") for event in events
                      if event.event_type == "assistant_message_created" and event.payload_json.get("reply")]
    final_task_statuses = [row["status"] for row in after_resume["task_frames"]]
    final_loop_statuses = [row["status"] for row in after_resume["agent_loops"]]
    final_handoff_statuses = [row["status"] for row in after_resume["handoffs"]]
    continuation_reply = continuation.reply if continuation is not None else (
        resume_replies[-1] if BRANCH == "scope_changed" and resume_replies else None
    )
    continuation_channel = (
        "human_handoff_resume" if BRANCH == "scope_changed" else
        "web" if continuation is not None else None
    )
    handoff_ok = (BRANCH == "no_change" and not final_handoff_statuses) or (BRANCH == "scope_changed" and final_handoff_statuses and all(status == "answered" for status in final_handoff_statuses))
    run_status = "passed" if (handoff_ok and final_task_statuses and all(status == "completed" for status in final_task_statuses)
                               and final_loop_statuses and all(status == "completed" for status in final_loop_statuses)) else "failed"
    artifact = {
        "status": run_status, "runner": "g5-staffdeck-native-real-model-run.py", "branch": BRANCH,
        "reproduction": {
            "command": "env -u NODE_OPTIONS PYTHONPATH=StaffDeck-g5-sop-agent/backend:StaffDeck-g5-sop-agent/backend/src StaffDeck-g5-sop-agent/backend/.venv/bin/python products/pilotdeck-staffdeck-sop/evidence/g5-staffdeck-native-real-model-run.py",
            "provider_config": str(PILOT_CONFIG), "published_definition": str(PUBLISHED_DEFINITION),
            "private_state": "temporary Harness home, SQLite, and APP_SECRET are generated per run",
        },
        "execution_entry": "app.core.agent_loop.AgentLoop.handle_turn", "execution_engine": "harness_v3",
        "inputs": {"ordinary_user_text": ordinary_input,
                   "human_handoff_resume_text": resume_input if BRANCH == "scope_changed" else None,
                   "no_change_continuation_text": no_change_continue_input if BRANCH == "no_change" else None},
        "published_definition": {"id": published["id"], "skill_id": published_content["skill_id"], "version": published_content["version"],
                                 "node_ids": [node.get("node_id") for node in published_content.get("nodes", [])],
                                 "edges": published_content.get("edges", [])},
        "model": {"provider": "provider1", "model": model_name, "protocol": provider.get("protocol"), "endpoint": provider_url},
        "resolved_runtime": {"harness_v3_root": str(ROOT), "bin_js": str(ROOT / "apps/cli/lib/bin.js"),
                             "node_bin": NODE, "private_harness_home": str(home), "private_sqlite": str(db_path)},
        "initial_turn": {"reply": first.reply, "runtime_error_code": first.runtime_error_code,
                          "session_id": session_id, "session_state": first.session_state.model_dump(mode="json")},
        "before_resume": before_resume,
        "resume_turn": {"channel": continuation_channel,
                         "reply": continuation_reply,
                         "session_id": session_id, "session_state": snapshot(db, session_id)["session"]},
        "after_resume": after_resume,
        "event_counts": {name: sum(1 for event in events if event.event_type == name)
                         for name in sorted({event.event_type for event in events})},
        "key_events": [{"type": event.event_type, "payload": event.payload_json} for event in events if event.event_type in {
            "harness_v3_process_started", "harness_action_created", "harness_control_result", "harness_v3_task_finished",
            "human_handoff_requested", "human_handoff_notified", "human_handoff_answered", "human_handoff_resume_started", "skill_completed",
            "task_frame_finished", "assistant_message_created", "session_state_changed"}],
        "state_semantics": {"session_status_note": "ChatSession.status is a handoff marker; SOP outcome is owned by handoff, task-frame, and agent-loop records. Completion requires answered handoff when scope_changed, no pending handoff when no_change, cleared pending/active step, and completed task-frame plus agent-loop.",
                             "expected_after_resume": {"handoff_status": "answered", "task_frame_status": "completed", "agent_loop_status": "completed", "session_active_step": None}},
    }
    ARTIFACT.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"artifact": str(ARTIFACT), "status": artifact["status"], "initial_reply": first.reply,
                      "resume_reply": continuation_reply,
                      "before_resume": before_resume, "after_resume": after_resume}, ensure_ascii=False, indent=2))

reset_runtime()
