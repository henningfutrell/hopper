import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_config() -> dict:
    path = ROOT / "config.json"
    data = json.loads(path.read_text()) if path.exists() else {}
    data.setdefault("enabled", True)
    data.setdefault("mode", "shadow")
    data.setdefault("model", "jev-latest")
    return data


def resolve_log_path(cfg: dict) -> Path:
    return ROOT / "logs" / "runs.jsonl"
