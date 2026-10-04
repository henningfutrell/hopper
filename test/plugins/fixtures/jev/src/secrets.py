import os
import sys


def ensure_typesafe_api_key() -> str:
    if not os.environ.get("TYPESAFE_API_KEY"):
        raise SystemExit("TYPESAFE_API_KEY is missing; export it in the process environment")
    return os.environ["TYPESAFE_API_KEY"]
