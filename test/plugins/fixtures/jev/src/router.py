from src.config import load_config, resolve_log_path
from src.jev_client import system_one
from src.logger import log_run


def route_task(state):
    cfg = load_config()
    log_path = resolve_log_path(cfg)
    if not cfg.get("enabled", True) or "bypass jev" in str(state.get("goal", "")).lower():
        out = {"action": "proceed_full", "reason": "lab disabled or bypass jev", "mode": cfg.get("mode"), "jev_used": False, "details": {}}
        log_run(log_path, {"event": "route", "state_goal": state.get("goal"), **out})
        return out

    from typesafe_sdk import Choice, Noul, Score

    questions = {
        "intent": Choice(instructions="What kind of work?", criteria={"lookup": "a status check", "coding": "edit code"}),
        "reuse_cache": Noul(instructions="Reuse a cached result?"),
        "needs_subagent": Noul(instructions="Needs an extra bot?"),
        "stop_retry": Noul(instructions="Stop retrying?"),
        "complexity": Score(instructions="How much effort?", criteria=["Trivial", "Normal", "Heavy"]),
    }
    result = system_one({"goal": state.get("goal", "")}, questions, model=cfg.get("model"))
    intent = result.choices["intent"]
    action = "run_deterministic" if intent.choice == "lookup" else "proceed_full"
    details = {
        "intent": intent.choice,
        "intent_confidence": round(float(intent.confidence), 4),
        "intent_probs": {k: round(float(v), 4) for k, v in (intent.probabilities or {}).items()},
        "reuse_cache": float(result.nouls["reuse_cache"].noul),
        "needs_subagent": float(result.nouls["needs_subagent"].noul),
        "stop_retry": float(result.nouls["stop_retry"].noul),
        "complexity_0_1": float(result.scores["complexity"].score) / 2.0,
    }
    out = {"action": action, "reason": f"intent={intent.choice}", "mode": cfg.get("mode"), "jev_used": True, "details": details}
    log_run(log_path, {"event": "route", "goal": state.get("goal", ""), "action": action})
    return out
