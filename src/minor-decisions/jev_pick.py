"""Ask Jev, through TypeSafe, one minor decision for the hopper (issue #550).

Reads {"model", "instructions", "criteria": {option id: meaning}, "state"} as JSON on stdin and prints one JSON line:
{"ok": true, "pick": <option id>, "confidence": <0..1>} or {"ok": false, "error": "<Type>: <message>"}. Always exits 0.

One TypeSafe Choice, named `decision`, over the options: the same call grok-bot-jev's own client makes for its gates
(`TypeSafeClient(model).system_one(state, questions)`), with TYPESAFE_API_KEY from the environment. Writes nothing.
"""
import sys

sys.dont_write_bytecode = True

import json  # noqa: E402


def pick(request: dict) -> dict:
    try:
        from typesafe_sdk import Choice, TypeSafeClient
    except ImportError as exc:
        raise RuntimeError(f"typesafe_sdk not installed: {exc}") from exc
    question = Choice(instructions=request["instructions"], criteria=request["criteria"])
    with TypeSafeClient(model=request["model"]) as client:
        result = client.system_one(state=request["state"], questions={"decision": question})
    answer = result.choices["decision"]
    choice = str(answer.choice)
    if choice not in request["criteria"]:
        raise ValueError(f"Jev picked {choice!r}, not one of {list(request['criteria'])}")
    confidence = float(getattr(answer, "confidence", None) or (getattr(answer, "probabilities", None) or {}).get(choice, 0.0))
    return {"ok": True, "pick": choice, "confidence": min(max(confidence, 0.0), 1.0)}


def main() -> None:
    try:
        result = pick(json.load(sys.stdin))
    except BaseException as exc:  # an SDK may raise SystemExit
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
