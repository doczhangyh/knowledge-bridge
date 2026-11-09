"""本机 HTTP 服务；维持原有前端 API 和安全边界。"""
import base64
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from .common import RequestError, new_id
from .config import ROOT
from .engine import LearningEngine
from .images import IMAGE_LIMITS, validate_images
from .store import Store, public_session

STATIC_FILES = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                "/style.css": ("style.css", "text/css; charset=utf-8"), "/favicon.svg": ("favicon.svg", "image/svg+xml")}
CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"


def input_text(value, name, limit, optional=False):
    if value is None and optional:
        return ""
    if not isinstance(value, str) or len(value) > limit or (not optional and not value.strip()):
        raise RequestError(name + "为空或超过长度限制。")
    return value.strip()


class Application(ThreadingHTTPServer):
    daemon_threads = False

    def __init__(self, config, store=None, model=None, search=None):
        self.config = config
        self.store = store or Store(config["dataDir"])
        self.store.init()
        self.engine = LearningEngine(config, self.store, model, search)
        try:
            super().__init__(("127.0.0.1", config["port"]), Handler)
        except Exception:
            self.engine.close()
            raise

    def server_close(self):
        super().server_close()
        self.engine.close()


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def log_message(self, format, *args):
        # Do not log request bodies, query strings or user materials.
        pass

    def send_payload(self, status, data, mime="application/json; charset=utf-8", headers=None):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8") if not isinstance(data, bytes) else data
        self.send_response(status)
        for key, value in {"Content-Type": mime, "Content-Length": str(len(payload)),
                           "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
                           "Cache-Control": "no-store", "Content-Security-Policy": CSP, **(headers or {})}.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def body(self, limit=256000):
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            raise RequestError("请使用 JSON 请求。", 415)
        # Browser fetch sends Content-Length; chunked requests are deliberately unsupported.
        if self.headers.get("Transfer-Encoding"):
            raise RequestError("不支持此请求传输格式。", 400)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0:
                raise ValueError()
        except ValueError:
            raise RequestError("请求长度无效。") from None
        if length > limit:
            raise RequestError("内容过长，请缩小学习材料后重试。", 413)
        raw = self.rfile.read(length)
        try:
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, UnicodeError):
            raise RequestError("请求不是有效 JSON。") from None

    def do_GET(self):
        self.dispatch()

    def do_POST(self):
        self.dispatch()

    def dispatch(self):
        try:
            hosts = [f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"]
            if self.headers.get("Host") not in hosts:
                raise RequestError("仅接受本机地址访问。", 403)
            origin = self.headers.get("Origin")
            if origin and origin not in ["http://" + host for host in hosts]:
                raise RequestError("不接受跨站请求。", 403)
            self.route(urlsplit(self.path).path)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as error:
            status = error.status if isinstance(error, RequestError) else 500
            try:
                self.send_payload(status, dict(error=str(error) if isinstance(error, RequestError) else "服务暂时无法处理请求，请查看服务端状态。", requestId=new_id()))
            except (BrokenPipeError, ConnectionResetError):
                pass

    def route(self, path):
        app = self.server
        store, config = app.store, app.config
        if self.command == "GET" and path in STATIC_FILES:
            file, mime = STATIC_FILES[path]
            return self.send_payload(200, (ROOT / "public" / file).read_bytes(), mime)
        if self.command == "GET" and path == "/api/config":
            return self.send_payload(200, dict(mode=config["mode"], model=config["model"] if config["mode"] == "live" else "本地规则演示",
                searchEnabled=config["mode"] == "live" and bool(config.get("searchKey")),
                searchLabel="内置参考资料" if config["mode"] == "demo" else "Tavily 已配置" if config.get("searchKey") else "未配置搜索",
                limits=dict(message=6000, material=30000, images=IMAGE_LIMITS)))
        if path == "/api/sessions":
            if self.command == "GET":
                return self.send_payload(200, store.list())
            if self.command == "POST":
                value = self.body()
                title = input_text(value.get("title"), "主题", 100)
                material = input_text(value.get("material"), "学习材料", 30000, True)
                name = input_text(value.get("materialName"), "材料名称", 120, True)
                with store.lock:
                    session = store.create(title, material, name)
                    store.save(session)
                    result = public_session(session)
                return self.send_payload(201, result)
        image_route = re.fullmatch(r"/api/sessions/([a-f\d-]{36})/images/([a-f\d-]{36})", path)
        if image_route and self.command == "GET":
            with store.lock:
                image = next((i for i in (store.get(image_route[1]) or {}).get("images", []) if i["id"] == image_route[2]), None)
                if not image:
                    raise RequestError("图片不存在。", 404)
                data, mime = base64.b64decode(image["dataUrl"].split(",", 1)[1]), image["mime"]
            return self.send_payload(200, data, mime)
        route = re.fullmatch(r"/api/sessions/([a-f\d-]{36})(?:/(messages|retry|export))?", path)
        if route:
            session = store.get(route[1])
            if session is None:
                raise RequestError("学习记录不存在。", 404)
            operation = route[2]
            if self.command == "GET" and operation in (None, "export"):
                with store.lock:
                    result = public_session(session, include_image_data=operation == "export")
                return self.send_payload(200, result, headers={"Content-Disposition": 'attachment; filename="learning-record.json"'} if operation else None)
            if self.command == "POST" and operation == "messages":
                value = self.body(17 * 1024 * 1024)
                with store.lock:
                    images = validate_images(value.get("images", []), session.get("images", []))
                    message = input_text(value.get("message"), "问题", 6000, bool(images)) or "请帮我理解这些图片中的学习内容。"
                    action = value.get("action") or "answer"
                    if action not in ("answer", "hint", "example", "return"):
                        raise RequestError("操作类型无效。")
                    if len(session["messages"]) >= 160:
                        raise RequestError("本次对话已较长，请新建学习会话。")
                    run_id = app.engine.start(session, message, action, images=images)
                return self.send_payload(202, dict(runId=run_id))
            if self.command == "POST" and operation == "retry":
                self.body()
                run_id = app.engine.start(session, "", retry=True)
                return self.send_payload(202, dict(runId=run_id))
        raise RequestError("找不到这个页面或接口。", 404)


def create_app(config, **dependencies):
    return Application(config, **dependencies)
