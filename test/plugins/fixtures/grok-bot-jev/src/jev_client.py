from typesafe_sdk import TypeSafeClient

from src.secrets import ensure_typesafe_api_key


def system_one(state, questions, model):
    ensure_typesafe_api_key()
    with TypeSafeClient(model=model) as client:
        return client.system_one(state=state, questions=questions)
