"""固定学习工作流。网络调用不持有存储锁，提交和快照在锁内完成。"""
import logging
import traceback
from concurrent.futures import ThreadPoolExecutor, wait
from copy import deepcopy
from .common import RequestError, new_id, now
from .providers import ModelClient, ProviderError
from .agents.search_agent import SearchAgent
from .agents.main_agent import PLAN_PROMPT, COACH_PROMPT, GRADE_PROMPT, context_for
from .agents.demo import demo_plan, demo_grade, demo_coach
from .learning_state import merge_gaps, apply_grade, install_check


class LearningEngine:
    def __init__(self, config, store, model=None, search=None):
        self.config, self.store = config, store
        self.model = model or ModelClient(config)
        self.search = search or SearchAgent(config)
        self.executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="learning")
        self.pending = set()

    def start(self, session, text, action="answer", retry=False, images=None):
        with self.store.lock:
            run = session.get("run") or {}
            if run.get("status") == "running":
                raise RequestError("当前回答仍在处理中，请稍候。", 409)
            if session.get("mode") and session["mode"] != self.config["mode"]:
                raise RequestError("运行模式已改变，请新建学习会话，避免混合演示和真实评估。", 409)
            if len(self.pending) >= 4:
                raise RequestError("当前处理任务较多，请稍后重试。", 429)
            if retry:
                if run.get("status") != "error" or not session["messages"] or session["messages"][-1]["role"] != "user":
                    raise RequestError("没有可重试的失败请求。")
                user = session["messages"][-1]
            else:
                images = images or []
                user = dict(id=new_id(), role="user", content=text, action=action,
                            imageIds=[image["id"] for image in images], createdAt=now())
                session["images"] = session.get("images", []) + images
                session["messages"].append(user)
            session["mode"] = self.config["mode"]
            session["run"] = dict(id=new_id(), status="running", events=[], error=None, startedAt=now())
            try:
                self.store.save(session)
            except OSError:
                session["run"].update(status="error", error="无法保存学习记录，请检查数据目录权限或磁盘空间后重试。")
                raise
            task = self.executor.submit(self.execute, session, user)
            self.pending.add(task)
            task.add_done_callback(self._finished)
            return session["run"]["id"]

    def _finished(self, task):
        with self.store.lock:
            self.pending.discard(task)
        if task.exception():
            logging.error("任务持久化失败：%s", type(task.exception()).__name__)

    def wait_idle(self):
        with self.store.lock:
            tasks = tuple(self.pending)
        wait(tasks)

    def close(self):
        self.executor.shutdown(wait=True)

    def event(self, session, actor, label, detail=""):
        with self.store.lock:
            session["run"]["events"].append(dict(actor=actor, label=label, detail=detail, at=now()))
            self.store.save(session)

    def execute(self, session, user):
        stage = "prepare"
        try:
            with self.store.lock:
                work = deepcopy(session)
            demo = self.config["mode"] == "demo"
            grade = None
            if work.get("check") and not user.get("imageIds"):
                stage = "grade"
                self.event(session, "主智能体", "检查上一次回答", "结合评分要点和提示使用情况记录证据。")
                grade = demo_grade(work, user) if demo else self.model.generate("grade", GRADE_PROMPT, dict(currentCheck=work["check"], user=user))
                apply_grade(work, user, grade)
            if work.get("images"):
                self.event(session, "主智能体", "图片已保存" if demo else "结合图片材料分析",
                           "演示模式不能识别图片。接入支持视觉的模型后可读取图片内容。" if demo else "从图片识别学习主题，结合已有知识补充背景与例子。")
            self.event(session, "主智能体", "定位可能的理解缺口", "保持本次学习目标，选择一个最相关的小步骤。")
            stage = "plan"
            search_available = demo or bool(self.config.get("searchKey"))
            plan = demo_plan(work) if demo else self.model.generate("plan", PLAN_PROMPT,
                dict(context_for(work, user), searchAvailable=search_available), work.get("images", []))
            if not plan["goal"].strip():
                raise ValueError("模型没有给出明确的学习目标。")
            work["goal"] = plan["goal"][:400]
            work["learningPath"] = plan.get("learningPath") or work.get("learningPath")
            merge_gaps(work, plan["gaps"])
            # merge_gaps can discard candidates at capacity or retain an existing
            # ID by title. Never send rejected/stale IDs to the coaching step.
            plan["gaps"] = deepcopy(work["gaps"])
            search_note = "使用自身知识开展教学；外部资料仅作可选补充。"
            if not search_available:
                plan["queries"] = []
            if plan["queries"]:
                stage = "search"
                self.event(session, "搜索智能体", "查找补充资料", " · ".join(plan["queries"][:2]))
                result = self.search.run(plan["queries"])
                for source in result["sources"]:
                    if any(existing["url"] == source["url"] for existing in work["sources"]):
                        continue
                    work["sources"].append(dict(source, id="s" + str(len(work["sources"]) + 1)))
                work["sources"] = work["sources"][:24]
                search_note = result["note"]
                self.event(session, "搜索智能体", "资料返回", search_note)
            self.event(session, "主智能体", "组织讲解与小验证", "结合主题与自身知识补充讲解，用你的回答验证理解。")
            stage = "coach"
            output = demo_coach(work, user, grade) if demo else self.model.generate("coach", COACH_PROMPT,
                dict(context_for(work, user), plan=plan, assessment=grade, sources=work["sources"],
                     searchAvailable=search_available, searchNote=search_note), work.get("images", []))
            if demo and user.get("imageIds"):
                output["reply"] = "图片已保存，但本地演示不能识别图片；下面仍是固定的递归演示，不是对图片的分析。\n\n" + output["reply"]
            if not output["reply"].strip():
                raise ValueError("模型没有生成有效的辅导内容。")
            stage = "validate_coach"
            if output.get("check"):
                install_check(work, output["check"])
            else:
                work["check"] = None
            work["focusId"] = (output["focusId"] if any(g["id"] == output["focusId"] for g in work["gaps"])
                               else (work.get("check") or {}).get("skillId") or work["gaps"][0]["id"])
            work["messages"].append(dict(id=new_id(), role="assistant", content=output["reply"],
                question=(work.get("check") or {}).get("question", ""), checkId=(work.get("check") or {}).get("id"),
                suggestions=output["suggestions"][:3], sources=[s for s in work["sources"] if s["id"] in output["sourceIds"]], createdAt=now()))
            keys = ("goal", "learningPath", "gaps", "evidence", "sources", "check", "focusId", "messages", "completedChecks")
            stage = "commit"
            with self.store.lock:
                # Roll back learning state even if the final disk write fails.
                previous = {key: session.get(key) for key in keys}
                previous_run = deepcopy(session["run"])
                try:
                    session.update({key: work[key] for key in keys})
                    session["run"]["events"].append(dict(actor="主智能体", label="等待你的下一步" if work["check"] else "本轮学习已记录",
                        detail="可以尝试作答，也可以先要一个提示。" if work["check"] else "你可以回看学习证据，或开始新的主题。", at=now()))
                    session["run"].update(status="done", finishedAt=now())
                    self.store.save(session)
                except Exception:
                    session.update(previous)
                    session["run"] = previous_run
                    raise
        except Exception as error:
            frames = traceback.extract_tb(error.__traceback__)
            location = f"{frames[-1].name}:{frames[-1].lineno}" if frames else "unknown"
            # Log diagnostic identifiers only, never prompts, answers or provider bodies.
            logging.error("Learning run failed: session=%s run=%s stage=%s type=%s at=%s",
                          session["id"], session["run"]["id"], stage, type(error).__name__, location)
            stage_name = {"prepare": "准备", "grade": "作答评估", "plan": "学习规划", "search": "资料搜索",
                          "coach": "生成讲解", "validate_coach": "检查题校验", "commit": "保存记录"}[stage]
            with self.store.lock:
                session["run"].update(status="error", finishedAt=now(), errorStage=stage,
                    error=str(error) if isinstance(error, ProviderError)
                    else f"本轮在“{stage_name}”阶段未完成，此前成功的学习记录已保留。可以重试。")
                self.store.save(session)
