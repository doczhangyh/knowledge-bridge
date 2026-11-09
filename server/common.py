"""共享的时间、标识与可公开错误。"""
from datetime import datetime, timezone
from uuid import uuid4


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_id():
    return str(uuid4())


class RequestError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status
