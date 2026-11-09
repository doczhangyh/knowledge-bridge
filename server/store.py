"""线程安全的内存会话及 JSON 原子写入，兼容原 Node 后端的数据。"""
import json
import logging
import os
import re
from copy import deepcopy
from pathlib import Path
from threading import RLock
from .common import new_id, now


class Store:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.sessions = {}
        self.lock = RLock()

    def init(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        with self.lock:
            for file in self.directory.iterdir():
                if not re.fullmatch(r"[\da-f-]{36}\.json", file.name):
                    continue
                try:
                    session = json.loads(file.read_text(encoding="utf-8"))
                    if not session.get("id") or not isinstance(session.get("messages"), list):
                        continue
                    if (session.get("run") or {}).get("status") == "running":
                        session["run"].update(status="error", error="上次运行因服务重启中断，可以重试。")
                    session.setdefault("images", [])
                    self.sessions[session["id"]] = session
                except (ValueError, OSError, AttributeError):
                    logging.warning("跳过损坏的会话文件：%s", file.name)

    def create(self, title, material="", material_name=""):
        session = dict(id=new_id(), title=title, material=material, materialName=material_name,
                       createdAt=now(), updatedAt=now(), goal="", messages=[], images=[], gaps=[], evidence=[],
                       sources=[], check=None, run=None, mode=None, completedChecks=[])
        with self.lock:
            self.sessions[session["id"]] = session
        return session

    def get(self, session_id):
        with self.lock:
            return self.sessions.get(session_id)

    def list(self):
        with self.lock:
            return [dict(id=s["id"], title=s["title"], updatedAt=s["updatedAt"], mode=s.get("mode"), count=len(s["messages"]))
                    for s in sorted(self.sessions.values(), key=lambda s: s["updatedAt"], reverse=True)]

    def save(self, session):
        with self.lock:
            session["updatedAt"] = now()
            target = self.directory / (session["id"] + ".json")
            temporary = target.with_suffix("." + new_id() + ".tmp")
            try:
                with temporary.open("w", encoding="utf-8") as stream:
                    json.dump(session, stream, ensure_ascii=False, indent=2)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)


def public_session(session, include_image_data=False):
    result = deepcopy({key: value for key, value in session.items() if key != "images"})
    result["images"] = []
    for image in session.get("images", []):
        metadata = {key: value for key, value in image.items() if key != "dataUrl"}
        metadata["url"] = f"/api/sessions/{session['id']}/images/{image['id']}"
        if include_image_data:
            metadata["dataUrl"] = image["dataUrl"]
        result["images"].append(metadata)
    if result.get("check"):
        result["check"].pop("rubric", None)
    return result
