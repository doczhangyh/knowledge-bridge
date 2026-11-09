"""行为回归测试；只用临时目录和本地模拟供应商，不调用真实付费 API。"""
import base64
import copy
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from server.app import create_app
from server.common import RequestError
from server.config import load_config
from server.engine import LearningEngine
from server.images import IMAGE_LIMITS, validate_images
from server.learning_state import apply_grade, install_check, merge_gaps
from server.providers import ModelClient, ProviderError, post_json
from server.schema import SCHEMAS, validate
from server.store import Store, public_session
from server.agents.main_agent import context_for
from server.agents.search_agent import SearchAgent

PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
GRADE = dict(verdict="correct", quote="result is 5", explanation="满足要点", helpRequested=False)
PLAN = dict(goal="理解返回", learningPath=dict(currentUnderstanding="未知", targetUnderstanding="理解返回", missingLink="调用位置", basis="待验证", nextMove="clarify"),
            queries=["Python return"], gaps=[dict(id="g", title="返回", reason="待验证")])
COACH = dict(reply="先看返回的例子 [s1]。", focusId="g", check=dict(skillId="g", kind="diagnostic", question="返回到哪里？", rubric="调用位置"),
             suggestions=["给我一个提示"], sourceIds=["s1", "fake"])


def state():
    return dict(gaps=[dict(id="g", title="返回", status="hypothesis", evidenceIds=[])], evidence=[], completedChecks=[],
                check=dict(id="q", skillId="g", kind="transfer", question="结果？", rubric="5", assisted=False))


def user(content=GRADE["quote"], action="answer"):
    return dict(id="u", content=content, action=action)


class RulesTests(unittest.TestCase):
    def test_config_defaults_validation_and_precedence(self):
        self.assertEqual(load_config({}, "missing.env")["mode"], "demo")
        for env in ({"APP_MODE": "live"}, {"LLM_API_KEY": "key"}, {"PORT": "0"}, {"PORT": "1.5"},
                    {"LLM_BASE_URL": "file:///tmp"}, {"LLM_JSON_MODE": "bad"}, {"APP_MODE": "bad"}):
            with self.subTest(env=env), self.assertRaises(ValueError):
                load_config(env, "missing.env")
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / ".env"
            file.write_text('APP_MODE="demo"\nPORT=4321\n', encoding="utf-8")
            self.assertEqual(load_config({"PORT": "4322"}, file)["port"], 4322)

    def test_gap_starts_as_hypothesis(self):
        session = dict(gaps=[])
        merge_gaps(session, [dict(id="g", title="函数", reason="待检查", status="independent")])
        self.assertEqual(session["gaps"][0]["status"], "hypothesis")

    def test_fabricated_or_unclear_evidence_ignored(self):
        for response, grade in [(user("我懂了"), GRADE), (user(), dict(GRADE, verdict="unclear"))]:
            session = state()
            apply_grade(session, response, grade)
            self.assertEqual(session["evidence"], [])
            self.assertEqual(session["gaps"][0]["status"], "hypothesis")

    def test_hint_and_diagnostic_and_transfer(self):
        session = state()
        apply_grade(session, user("提示", "hint"), GRADE)
        apply_grade(session, user(), GRADE)
        self.assertEqual(session["gaps"][0]["status"], "assisted")
        self.assertTrue(session["evidence"][0]["assisted"])
        session = state()
        session["check"]["kind"] = "diagnostic"
        apply_grade(session, user(), GRADE)
        self.assertEqual(session["gaps"][0]["status"], "observed")
        session = state()
        apply_grade(session, user(), GRADE)
        self.assertEqual(session["gaps"][0]["status"], "independent")
        session["check"]["assisted"] = True
        apply_grade(session, user(), GRADE)
        self.assertEqual(session["gaps"][0]["status"], "independent")
        apply_grade(session, user(), dict(GRADE, verdict="incorrect"))
        self.assertEqual(session["gaps"][0]["status"], "revisit")

    def test_repeat_and_invalid_check(self):
        session = state()
        session["completedChecks"].append("结果？")
        install_check(session, dict(skillId="g", kind="transfer", question="结果？", rubric="5"))
        self.assertTrue(session["check"]["assisted"])
        with self.assertRaises(ValueError):
            install_check(session, dict(skillId="missing", kind="transfer", question="q", rubric="r"))

    def test_public_session_hides_rubric_and_image_payload(self):
        session = dict(state(), id="s", images=validate_images([dict(dataUrl=PIXEL)]))
        result = public_session(session)
        self.assertNotIn("rubric", result["check"])
        self.assertNotIn("dataUrl", result["images"][0])
        self.assertEqual(session["check"]["rubric"], "5")
        self.assertEqual(public_session(session, True)["images"][0]["dataUrl"], PIXEL)
        self.assertNotIn("rubric", public_session(session, True)["check"])

    def test_image_validation(self):
        image = validate_images([dict(dataUrl=PIXEL)])[0]
        self.assertEqual(image["mime"], "image/png")
        bad = [{}, [dict(dataUrl="data:image/svg+xml;base64,PHN2Zz4=")],
               [dict(dataUrl=PIXEL.replace("image/png", "image/jpeg"))],
               [dict(dataUrl="data:image/png;base64," + "A" * 6000000)],
               [dict(dataUrl=PIXEL)] * 7, [dict(dataUrl="data:image/png;base64,AAA")]]
        for items in bad:
            with self.assertRaises(RequestError):
                validate_images(items)
        with self.assertRaises(RequestError):
            validate_images([dict(dataUrl=PIXEL)], [image] * 6)
        with self.assertRaises(RequestError):
            validate_images([dict(dataUrl=PIXEL)], [dict(size=IMAGE_LIMITS["totalBytes"])])

    def test_schema_rejects_extra_fields_and_wrong_types(self):
        self.assertEqual(validate(PLAN, SCHEMAS["plan"]), PLAN)
        for value in (dict(PLAN, unknown=True), dict(PLAN, queries=[1]), dict(PLAN, queries=["x"] * 13), {}):
            with self.assertRaises(ValueError):
                validate(value, SCHEMAS["plan"])


class BackendFixture(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.config = dict(mode="demo", dataDir=self.directory.name, port=0, model="test-model", apiKey="private-secret",
                           baseUrl="http://example.invalid/v1", jsonMode="json_object", timeout=1000, searchKey="", searchUrl="http://example.invalid")
        self.store = Store(self.directory.name)
        self.store.init()
        self.session = self.store.create("递归测试")
        self.store.save(self.session)

    def engine(self, **deps):
        engine = LearningEngine(self.config, self.store, **deps)
        self.addCleanup(engine.close)
        return engine

    def turn(self, engine, text, action="answer", **kwargs):
        engine.start(self.session, text, action, **kwargs)
        engine.wait_idle()
        self.assertEqual(self.session["run"]["status"], "done", self.session["run"].get("error"))


class BackendTests(BackendFixture):
    def test_demo_independent_and_restart(self):
        engine = self.engine()
        self.turn(engine, "递归为什么返回")
        self.assertEqual(self.session["check"]["skillId"], "return-flow")
        self.assertIn("非实时", self.session["sources"][0]["origin"])
        self.turn(engine, "输出 6，返回 3 赋值给 y，再乘 2")
        self.assertEqual(self.session["check"]["kind"], "transfer")
        self.turn(engine, "f(0)=1，f(1)=3，f(2)=5")
        self.assertEqual(self.session["gaps"][1]["status"], "independent")
        restored = Store(self.directory.name)
        restored.init()
        self.assertEqual(len(restored.get(self.session["id"])["messages"]), 6)
        self.assertEqual(len(restored.get(self.session["id"])["evidence"]), 2)

    def test_demo_hint(self):
        engine = self.engine()
        self.turn(engine, "递归")
        self.turn(engine, "输出 6，返回 3 赋值给 y")
        self.turn(engine, "提示", "hint")
        self.turn(engine, "f(0)=1，f(1)=3，f(2)=5")
        self.assertEqual(self.session["gaps"][1]["status"], "assisted")

    def test_restart_and_legacy_images(self):
        del self.session["images"]
        self.session["run"] = dict(status="running")
        self.store.save(self.session)
        restored = Store(self.directory.name)
        restored.init()
        session = restored.get(self.session["id"])
        self.assertEqual(session["images"], [])
        self.assertEqual(session["run"]["status"], "error")

    def test_mutual_exclusion_retry_and_rollback(self):
        release = threading.Event()
        def generate(*args):
            release.wait(5)
            raise RuntimeError("failure")
        self.config["mode"] = "live"
        engine = self.engine(model=SimpleNamespace(generate=generate))
        self.addCleanup(release.set)
        engine.start(self.session, "图片", images=validate_images([dict(dataUrl=PIXEL)]))
        with self.assertRaises(RequestError) as caught:
            engine.start(self.session, "重复")
        self.assertEqual(caught.exception.status, 409)
        release.set()
        engine.wait_idle()
        self.assertEqual(self.session["run"]["status"], "error")
        engine.start(self.session, "", retry=True)
        engine.wait_idle()
        self.assertEqual(len(self.session["messages"]), 1)
        self.assertEqual(len(self.session["images"]), 1)
        self.assertEqual(self.session["gaps"], [])

    def test_four_task_capacity(self):
        release = threading.Event()
        def generate(*args):
            release.wait(5)
            raise RuntimeError()
        self.config["mode"] = "live"
        engine = self.engine(model=SimpleNamespace(generate=generate))
        self.addCleanup(release.set)
        for i in range(4):
            engine.start(self.store.create(str(i)), "q")
        with self.assertRaises(RequestError) as caught:
            engine.start(self.session, "q")
        self.assertEqual(caught.exception.status, 429)
        self.assertEqual(self.session["messages"], [])
        release.set()
        engine.wait_idle()

    def test_mode_change_rejected(self):
        self.session["mode"] = "live"
        with self.assertRaises(RequestError):
            self.engine().start(self.session, "q")

    def test_live_orchestration_search_and_grade(self):
        calls = []
        def generate(kind, prompt, context, images=None):
            calls.append(kind)
            return copy.deepcopy(PLAN if kind == "plan" else GRADE if kind == "grade" else COACH)
        def search(queries):
            calls.append("search")
            return dict(sources=[dict(id="a", url="https://docs.python.org", title="参考", content="返回", origin="测试")], note="测试")
        self.config.update(mode="live", searchKey="configured")
        engine = self.engine(model=SimpleNamespace(generate=generate), search=SimpleNamespace(run=search))
        self.turn(engine, "返回是什么")
        self.assertEqual(calls, ["plan", "search", "coach"])
        self.assertEqual(len(self.session["messages"][-1]["sources"]), 1)
        calls.clear()
        self.turn(engine, GRADE["quote"])
        self.assertEqual(calls, ["grade", "plan", "search", "coach"])
        self.assertEqual(self.session["gaps"][0]["status"], "observed")

    def test_no_search_and_images_not_graded(self):
        calls = []
        def generate(kind, prompt, context, images=None):
            calls.append((kind, len(images or [])))
            self.assertFalse(context["searchAvailable"])
            return copy.deepcopy(PLAN if kind == "plan" else dict(COACH, check=None))
        self.config["mode"] = "live"
        self.session.update(state())
        engine = self.engine(model=SimpleNamespace(generate=generate), search=SimpleNamespace(run=lambda _: self.fail("不应搜索")))
        self.turn(engine, "补图", images=validate_images([dict(dataUrl=PIXEL)]))
        self.turn(engine, "继续")
        self.assertEqual(calls, [("plan", 1), ("coach", 1), ("plan", 1), ("coach", 1)])
        self.assertEqual(self.session["evidence"], [])

    def test_invalid_coach_rolls_back_graded_state(self):
        self.config["mode"] = "live"
        self.session.update(state())
        def generate(kind, *args):
            return copy.deepcopy(GRADE if kind == "grade" else PLAN if kind == "plan" else dict(COACH, check=dict(COACH["check"], skillId="missing")))
        engine = self.engine(model=SimpleNamespace(generate=generate))
        engine.start(self.session, GRADE["quote"])
        engine.wait_idle()
        self.assertEqual(self.session["run"]["status"], "error")
        self.assertEqual(self.session["evidence"], [])
        self.assertEqual(self.session["gaps"][0]["status"], "hypothesis")

    def test_final_save_failure_rolls_back(self):
        engine = self.engine()
        save = self.store.save
        def failing_save(session):
            if (session.get("run") or {}).get("status") == "done":
                raise OSError("disk")
            save(session)
        with patch.object(self.store, "save", side_effect=failing_save):
            engine.start(self.session, "q")
            engine.wait_idle()
        self.assertEqual(self.session["gaps"], [])
        self.assertEqual(len(self.session["messages"]), 1)
        self.assertEqual(self.session["run"]["status"], "error")

    def test_six_gaps_rejected_candidate_is_not_sent_to_coach(self):
        self.config["mode"] = "live"
        self.session["gaps"] = [dict(id=f"g{i}", title=f"skill {i}", reason="known", status="hypothesis", evidenceIds=[]) for i in range(6)]
        calls = []
        def transport(url, key, body, timeout, label):
            context = json.loads(body["messages"][1]["content"])
            if "plan" not in context:
                value = dict(PLAN, gaps=[dict(id="seventh", title="new topic", reason="new")])
            else:
                self.assertEqual([g["id"] for g in context["plan"]["gaps"]], [f"g{i}" for i in range(6)])
                calls.append("coach")
                skill = "seventh" if len(calls) == 1 else "g0"
                value = dict(COACH, focusId=skill, check=dict(COACH["check"], skillId=skill))
            return dict(choices=[dict(message=dict(content=json.dumps(value)))])
        engine = self.engine(model=ModelClient(self.config, transport))
        self.turn(engine, "a follow-up question")
        self.assertEqual(calls, ["coach", "coach"])
        self.assertEqual(len(self.session["gaps"]), 6)
        self.assertEqual(self.session["check"]["skillId"], "g0")
        self.assertEqual(self.session["evidence"], [])

    def test_error_records_stage_without_internal_message(self):
        self.config["mode"] = "live"
        def generate(*args):
            raise RuntimeError("private-secret")
        engine = self.engine(model=SimpleNamespace(generate=generate))
        with self.assertLogs(level="ERROR") as captured:
            engine.start(self.session, "q")
            engine.wait_idle()
        self.assertEqual(self.session["run"]["errorStage"], "plan")
        self.assertNotIn("private-secret", self.session["run"]["error"])
        self.assertNotIn("private-secret", " ".join(captured.output))


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.config = dict(baseUrl="https://invalid", apiKey="secret", model="test", timeout=1000, mode="live", searchKey="secret", searchUrl="https://invalid")

    def test_invalid_json_retries_once(self):
        calls = []
        def transport(*args):
            calls.append(args)
            return dict(choices=[dict(message=dict(content="{}"), finish_reason="stop")])
        with self.assertRaisesRegex(ProviderError, "连续"):
            ModelClient(self.config, transport).generate("plan", "s", {})
        self.assertEqual(len(calls), 2)

    def test_successful_format_retry_and_refusal(self):
        calls = []
        def transport(*args):
            calls.append(args)
            return dict(choices=[dict(message=dict(content=json.dumps(PLAN) if len(calls) == 2 else "bad"), finish_reason="stop")])
        self.assertEqual(ModelClient(self.config, transport).generate("plan", "s", {}), PLAN)
        refused = lambda *args: dict(choices=[dict(message=dict(refusal="no"))])
        with self.assertRaisesRegex(ProviderError, "未能处理"):
            ModelClient(self.config, refused).generate("plan", "s", {})

    def test_coach_blank_rubric_retries_and_empty_reply_fails(self):
        calls = []
        def transport(*args):
            calls.append(1)
            value = dict(COACH, check=dict(COACH["check"], rubric="  ")) if len(calls) == 1 else COACH
            return dict(choices=[dict(message=dict(content=json.dumps(value)))])
        client = ModelClient(self.config, transport)
        self.assertEqual(client.generate("coach", "s", dict(gaps=[dict(id="g")])), COACH)
        self.assertEqual(len(calls), 2)
        def empty(*args):
            return dict(choices=[dict(message=dict(content=json.dumps(dict(COACH, reply=" "))))])
        with self.assertRaisesRegex(ProviderError, "连续"):
            ModelClient(self.config, empty).generate("coach", "s", dict(gaps=[dict(id="g")]))

    def test_coach_schema_does_not_restrict_reply_or_other_sessions(self):
        from server.schema import response_schema, validate_response
        schema = response_schema("coach", dict(gaps=[dict(id="g")]))
        self.assertEqual(validate_response(COACH, schema, "coach"), COACH)
        self.assertNotIn("enum", SCHEMAS["coach"]["properties"]["reply"])
        self.assertNotIn("enum", SCHEMAS["coach"]["properties"]["focusId"])
        other = response_schema("coach", dict(gaps=[dict(id="other")]))
        self.assertEqual(other["properties"]["focusId"]["enum"], ["other"])

    def test_image_blocks_and_strict_schema(self):
        images = validate_images([dict(dataUrl=PIXEL)])
        context = context_for(dict(goal="", images=images, messages=[user()], gaps=[], evidence=[]), user())
        self.assertNotIn("base64", json.dumps(context))
        def transport(url, key, body, timeout, label):
            blocks = body["messages"][1]["content"]
            self.assertEqual(blocks[-1]["image_url"]["url"], PIXEL)
            self.assertTrue(body["response_format"]["json_schema"]["strict"])
            return dict(choices=[dict(message=dict(content=json.dumps(PLAN)))])
        ModelClient(dict(self.config, jsonMode="json_schema"), transport).generate("plan", "s", context, images)

    def test_search_limits_filter_and_failure(self):
        calls = []
        def transport(*args):
            calls.append(args)
            return dict(results=[dict(url="https://example.com", title="a"), dict(url="https://example.com"), dict(url="javascript:alert(1)")])
        result = SearchAgent(self.config, transport).run(["q1", "q2", "q3"])
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(result["sources"]), 1)
        def fail(*args):
            raise RuntimeError("secret")
        result = SearchAgent(self.config, fail).run(["q"])
        self.assertEqual(result["sources"], [])
        self.assertIn("未完成", result["note"])
        self.assertNotIn("secret", result["note"])


class HttpTests(BackendFixture):
    def start_app(self, **deps):
        app = create_app(self.config, **deps)
        thread = threading.Thread(target=app.serve_forever, daemon=True)
        thread.start()
        def cleanup():
            app.shutdown()
            thread.join()
            app.server_close()
        self.addCleanup(cleanup)
        self.app = app
        self.base = f"http://127.0.0.1:{app.server_port}"

    def request(self, route, data=None, headers=None):
        req = urllib.request.Request(self.base + route, data=None if data is None else json.dumps(data).encode(),
                                     headers={"Content-Type": "application/json", **(headers or {})})
        try:
            response = urllib.request.urlopen(req, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read()

    def test_http_contract(self):
        self.start_app()
        status, _, raw = self.request("/api/config")
        self.assertEqual(status, 200)
        self.assertNotIn(b"private-secret", raw)
        for payload in (dict(title=""), dict(title="x", material="x" * 30001)):
            self.assertEqual(self.request("/api/sessions", payload)[0], 400)
        self.assertEqual(self.request("/api/sessions", dict(title="x"), {"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.request("/api/config", headers={"Host": "evil.example"})[0], 403)
        status, _, raw = self.request("/api/sessions", dict(title="测试", material="函数"))
        self.assertEqual(status, 201)
        session = json.loads(raw)
        route = "/api/sessions/" + session["id"]
        self.assertEqual(self.request(route + "/messages", dict(message="递归"))[0], 202)
        self.app.engine.wait_idle()
        snapshot = json.loads(self.request(route)[2])
        self.assertEqual(snapshot["run"]["status"], "done")
        self.assertEqual(len(snapshot["messages"]), 2)
        self.assertNotIn("rubric", snapshot["check"])
        self.assertEqual(self.request("/.env")[0], 404)
        status, headers, _ = self.request("/")
        self.assertEqual(status, 200)
        self.assertIn("script-src 'self'", headers["Content-Security-Policy"])

    def test_http_images_export_and_isolation(self):
        self.start_app()
        session = json.loads(self.request("/api/sessions", dict(title="图片"))[2])
        route = "/api/sessions/" + session["id"]
        self.assertEqual(self.request(route + "/messages", dict(images=[dict(dataUrl="evil")]))[0], 400)
        self.assertEqual(self.app.store.get(session["id"])["messages"], [])
        self.assertEqual(self.request(route + "/messages", dict(images=[dict(dataUrl=PIXEL)]))[0], 202)
        self.app.engine.wait_idle()
        snapshot = json.loads(self.request(route)[2])
        self.assertIn("演示不能识别图片", snapshot["messages"][-1]["content"])
        image = snapshot["images"][0]
        self.assertNotIn("dataUrl", image)
        status, headers, data = self.request(image["url"])
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertEqual(base64.b64encode(data).decode(), PIXEL.split(",")[1])
        exported = json.loads(self.request(route + "/export")[2])
        self.assertEqual(exported["images"][0]["dataUrl"], PIXEL)
        self.assertNotIn("rubric", exported["check"])
        other = json.loads(self.request("/api/sessions", dict(title="other"))[2])
        self.assertEqual(self.request(f"/api/sessions/{other['id']}/images/{image['id']}")[0], 404)

    def test_real_http_provider_transport_and_error_redaction(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        received = []
        class MockProvider(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                received.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                if self.path == "/unauthorized":
                    self.send_response(401)
                    self.end_headers()
                    self.wfile.write(b"private-secret")
                elif self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("Location", "/leak")
                    self.end_headers()
                else:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(json.dumps(dict(choices=[dict(message=dict(content=json.dumps(PLAN)))])).encode())
        server = ThreadingHTTPServer(("127.0.0.1", 0), MockProvider)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{server.server_port}"
            client = ModelClient(dict(self.config, baseUrl=base))
            self.assertEqual(client.generate("plan", "test", {}), PLAN)
            for path in ("/unauthorized", "/redirect"):
                with self.assertRaises(ProviderError) as caught:
                    post_json(base + path, "private-secret", {}, 1000, "模型服务")
                self.assertNotIn("private-secret", str(caught.exception))
            self.assertEqual(len(received), 3)
        finally:
            server.shutdown()
            thread.join()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
