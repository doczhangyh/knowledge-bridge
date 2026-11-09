"""无模型密钥时的固定教学路径；文案保存在 demo_content.json。"""
import json
import re
from copy import deepcopy
from pathlib import Path

CONTENT = json.loads(Path(__file__).with_name("demo_content.json").read_text(encoding="utf-8"))


def demo_plan(session):
    plan = deepcopy(CONTENT["plan"])
    if session["evidence"]:
        plan["learningPath"]["currentUnderstanding"] = "演示中已观察到一次函数返回过程的作答。"
        plan["learningPath"]["nextMove"] = "bridge"
    if session["sources"]:
        plan["queries"] = []
    return plan


def demo_grade(session, user):
    text = user["content"]
    help_requested = user["action"] != "answer" or bool(re.search(r"不知道|不懂|提示|换个|明白了|^懂了|没思路", text))
    if (session.get("check") or {}).get("skillId") == "return-flow":
        correct = bool(re.search(r"6|六", text) and re.search(r"返回|赋值|y|乘|print", text))
    else:
        correct = all(re.search(rf"f\s*\(\s*{n}\s*\)\s*[=＝:：]\s*{value}", text) for n, value in [(0, 1), (1, 3), (2, 5)])
    return dict(verdict="unclear" if help_requested else "correct" if correct else "unclear",
                helpRequested=help_requested, quote=text[:400],
                explanation="演示规则匹配到预期结果和关键过程；真实模式会按评分标准评估。" if correct else "演示脚本无法判断这段自由表达，暂不标为答错。")


def demo_coach(session, user, grade):
    check = session.get("check")
    grade = grade or {}
    case = "first"
    if check and grade.get("verdict") == "correct":
        case = "transfer" if check["skillId"] == "return-flow" else "assisted" if check.get("assisted") else "independent"
    elif check and (grade.get("helpRequested") or user["action"] in ("hint", "example")):
        case = "hint_first" if check["skillId"] == "return-flow" else "hint_transfer"
    elif check:
        case = "unclear"
    result = deepcopy(CONTENT["cases"][case])
    if check and case in ("hint_first", "hint_transfer", "unclear"):
        result["check"] = {key: check[key] for key in ("skillId", "kind", "question", "rubric")}
        result["focusId"] = check["skillId"]
    result["sourceIds"] = [source["id"] for source in session["sources"]]
    return result
