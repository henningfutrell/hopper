<<<<<<< HEAD:src/plugins/router/jev-router/jev_shim.py
"""Run grok-bot-jev's router once, for hopper.
=======
"""Run grok-bot-jev's router once, for job-hopper's gate router.
>>>>>>> d836e15 (feat: router is a role, Jev a model — router plugin gate-router (#76)):src/plugins/router/gate-router/gate_shim.py

Reads {"grokBotJevSrc", "mode", "logPath", "state", "jevGates", "claude": {"argv", "cwd"}} as JSON
on stdin and prints one JSON line: {"ok": true, "route": ...} or {"ok": false, "error":
"<Type>: <message>"}. Always exits 0.

grok-bot-jev's router runs unchanged; only its `system_one` call is replaced. Each gate (a named
judgement the router asks about the job) goes to Jev, through TypeSafe and grok-bot-jev's own
client, when TYPESAFE_API_KEY is set, typesafe_sdk imports, and the gate is in jevGates; every
other gate, and every gate Jev fails on, goes to the Claude model through `claude.argv` (the
locked-down claude CLI, prompt on stdin, structured output). The route's details gain `gatesBy`
(gate -> "jev" | "claude") and, when Jev was wanted but could not answer, `jevError`.

Nothing is written under grokBotJevSrc: bytecode is off, and the router's log path is redirected
to logPath. grok-bot-jev's own config.yaml is still loaded, so its kill switch is honoured;
only `mode` and `logging.path` are overridden.
"""
import sys

sys.dont_write_bytecode = True

import json  # noqa: E402
import os  # noqa: E402
import subprocess  # noqa: E402
import types  # noqa: E402
from pathlib import Path  # noqa: E402


class _Gate:
    """A gate as the typesafe_sdk stub builds it: what the Claude model needs, nothing more."""

    type = ""

    def __init__(self, *, instructions=None, criteria=None, **_kwargs):
        self.instructions = instructions
        self.criteria = criteria


def install_sdk_stub_if_missing() -> bool:
    """Let src.router import and build its gates without typesafe_sdk. True when the real one imports."""
    try:
        import typesafe_sdk  # noqa: F401
        return True
    except ImportError:
        pass

    def unavailable(*_args, **_kwargs):
        raise RuntimeError("typesafe_sdk not installed")

    stub = types.ModuleType("typesafe_sdk")
    stub.TypeSafeClient = unavailable
    for name in ("Choice", "Noul", "Score"):
        setattr(stub, name, type(name, (_Gate,), {"type": name.lower()}))
    sys.modules["typesafe_sdk"] = stub
    return False


def gate_type(gate) -> str:
    return getattr(gate, "type", "") or ""


def claude_prompt(state: dict, gates: dict) -> str:
    lines = [
        "You answer a job router's gates about one job. Judge only from the job state below.",
        "",
        "Job state (JSON):",
        json.dumps(state, ensure_ascii=False, indent=2),
        "",
        "Gates:",
    ]
    for name, gate in gates.items():
        kind = gate_type(gate)
        lines.append(f"- {name} ({kind}): {gate.instructions or ''}")
        if kind == "choice":
            for label, meaning in (gate.criteria or {}).items():
                lines.append(f"    {label}: {meaning or ''}")
        elif kind == "noul":
            lines.append("    answer: probability 0..1 that the answer is yes")
        elif kind == "score":
            for i, step in enumerate(gate.criteria or []):
                lines.append(f"    {i}: {step}")
    lines += [
        "",
        "Answer every gate, keyed by its name:",
        "- choice gates under `choices`: `choice` is exactly one listed label; `probabilities` maps every label to 0..1, summing to 1.",
        "- noul gates under `nouls`: the probability of yes, 0..1.",
        "- score gates under `scores`: the expected step index (0 = first step; fractions allowed).",
    ]
    return "\n".join(lines)


def ask_claude(claude: dict, state: dict, gates: dict) -> dict:
    """Each gate's answer, shaped as Jev's (choice/confidence/probabilities, noul, score)."""
    proc = subprocess.run(
        claude["argv"], input=claude_prompt(state, gates), capture_output=True, text=True, cwd=claude["cwd"],
    )
    if proc.returncode != 0:
        raise RuntimeError(f"claude exited {proc.returncode}: {proc.stderr.strip()[:300]}")
    out = (json.loads(proc.stdout) or {}).get("structured_output") or {}
    answers = {}
    for name, gate in gates.items():
        kind = gate_type(gate)
        group = out.get({"choice": "choices", "noul": "nouls", "score": "scores"}.get(kind, ""), {})
        if name not in group:
            raise ValueError(f"the Claude model left gate {name} unanswered")
        value = group[name]
        if kind == "choice":
            labels = list((gate.criteria or {}).keys())
            if value["choice"] not in labels:
                raise ValueError(f"the Claude model chose {value['choice']!r} for {name}, not one of {labels}")
            probs = {k: float(v) for k, v in value["probabilities"].items() if k in labels}
            answers[name] = types.SimpleNamespace(
                choice=value["choice"], confidence=probs.get(value["choice"], 0.0), probabilities=probs,
            )
        elif kind == "noul":
            answers[name] = types.SimpleNamespace(noul=min(max(float(value), 0.0), 1.0))
        else:
            top = max(len(gate.criteria or []) - 1, 0)
            answers[name] = types.SimpleNamespace(score=min(max(float(value), 0.0), float(top)))
    return answers


def make_system_one(request: dict, sdk_real: bool, jev_system_one, report: dict):
    """grok-bot-jev's `system_one(state, questions, model)`, its gates split between Jev and the Claude model."""
    def system_one(state, questions, model):
        answers, by = {}, {}
        wanted = {k: q for k, q in questions.items() if k in request.get("jevGates", [])}
        if wanted:
            if not os.environ.get("TYPESAFE_API_KEY"):
                pass  # Jev off until the key is set: the Claude model answers, and that is no error.
            elif not sdk_real:
                report["jevError"] = "RuntimeError: typesafe_sdk not installed"
            else:
                try:
                    result = jev_system_one(state, wanted, model)
                    for group in (result.choices, result.nouls, result.scores):
                        for name, answer in group.items():
                            if name in wanted:
                                answers[name], by[name] = answer, "jev"
                except BaseException as exc:  # grok-bot-jev's secrets.py raises SystemExit
                    report["jevError"] = f"{type(exc).__name__}: {exc}"
        rest = {k: q for k, q in questions.items() if k not in answers}
        if rest:
            for name, answer in ask_claude(request["claude"], state, rest).items():
                answers[name], by[name] = answer, "claude"
        report["gatesBy"] = {k: by[k] for k in questions}
        pick = lambda kind: {k: answers[k] for k, q in questions.items() if gate_type(q) == kind}  # noqa: E731
        return types.SimpleNamespace(choices=pick("choice"), nouls=pick("noul"), scores=pick("score"))
    return system_one


def route(request: dict) -> dict:
    sys.path.insert(0, request["grokBotJevSrc"])
    sdk_real = install_sdk_stub_if_missing()
    import src.router as router
    log_path = Path(request["logPath"])
    original_load_config = router.load_config

    def load_config() -> dict:
        cfg = original_load_config()
        cfg["mode"] = request["mode"]
        cfg["logging"] = {"path": str(log_path)}
        return cfg

    def resolve_log_path(_cfg: dict) -> Path:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        return log_path

    report: dict = {}
    router.load_config = load_config
    router.resolve_log_path = resolve_log_path
    router.system_one = make_system_one(request, sdk_real, router.system_one, report)
    out = router.route_task(request["state"])
    if report:
        out["details"] = {**(out.get("details") or {}), **report}
    return out


def main() -> None:
    try:
        result = {"ok": True, "route": route(json.load(sys.stdin))}
    except BaseException as exc:  # secrets.py raises SystemExit
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
