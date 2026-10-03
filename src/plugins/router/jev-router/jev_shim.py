"""Run grok-bot-jev's router once, for job-hopper.

Reads {"jevSrc", "mode", "logPath", "state"} as JSON on stdin and prints one JSON line:
{"ok": true, "route": ...} or {"ok": false, "error": "<Type>: <message>"}. Always exits 0.

Nothing is written under jevSrc: bytecode is off, and the router's log path is redirected
to logPath. The Jev repo's own config.yaml is still loaded, so its kill switch is honoured;
only `mode` and `logging.path` are overridden.
"""
import sys

sys.dont_write_bytecode = True

import json  # noqa: E402
import types  # noqa: E402
from pathlib import Path  # noqa: E402


def install_sdk_stub_if_missing() -> None:
    """Let src.router import without typesafe_sdk; any use of the SDK raises."""
    try:
        import typesafe_sdk  # noqa: F401
        return
    except ImportError:
        pass

    def unavailable(*_args, **_kwargs):
        raise RuntimeError("typesafe_sdk not installed")

    stub = types.ModuleType("typesafe_sdk")
    for name in ("TypeSafeClient", "Choice", "Noul", "Score"):
        setattr(stub, name, unavailable)
    sys.modules["typesafe_sdk"] = stub


def route(request: dict) -> dict:
    sys.path.insert(0, request["jevSrc"])
    install_sdk_stub_if_missing()
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

    router.load_config = load_config
    router.resolve_log_path = resolve_log_path
    return router.route_task(request["state"])


def main() -> None:
    try:
        result = {"ok": True, "route": route(json.load(sys.stdin))}
    except BaseException as exc:  # secrets.py raises SystemExit
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
