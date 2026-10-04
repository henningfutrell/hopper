"""Fake typesafe_sdk for the jev-router tests: the question types and TypeSafeClient.system_one.

Records the question names it was asked, and the TYPESAFE_API_KEY it ran with, to $FAKE_TYPESAFE_OUT
(JSON) and answers them;
$FAKE_TYPESAFE_MODE=error raises instead, as an unreachable or rejecting TypeSafe would.
"""
import json
import os
from types import SimpleNamespace


class _Question:
    type = ""

    def __init__(self, *, instructions=None, criteria=None):
        self.instructions = instructions
        self.criteria = criteria


class Choice(_Question):
    type = "choice"


class Noul(_Question):
    type = "noul"


class Score(_Question):
    type = "score"


class TypeSafeAuthenticationError(Exception):
    pass


class TypeSafeClient:
    def __init__(self, *, api_key=None, model=None, **_kw):
        self.model = model

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def system_one(self, state, questions, **_kw):
        with open(os.environ["FAKE_TYPESAFE_OUT"], "w", encoding="utf-8") as f:
            json.dump({"questions": sorted(questions), "state": state, "model": self.model, "key": os.environ.get("TYPESAFE_API_KEY")}, f)
        if os.environ.get("FAKE_TYPESAFE_MODE") == "error":
            raise TypeSafeAuthenticationError("401 invalid api key")
        choices, nouls, scores = {}, {}, {}
        for name, q in questions.items():
            if q.type == "choice":
                first = next(iter(q.criteria))
                choices[name] = SimpleNamespace(choice=first, confidence=0.9, probabilities={first: 0.9})
            elif q.type == "noul":
                nouls[name] = SimpleNamespace(noul=0.11)
            else:
                scores[name] = SimpleNamespace(score=0.0, confidence=0.8)
        return SimpleNamespace(choices=choices, nouls=nouls, scores=scores)
