"""可检查的证据和学习状态规则；模型不直接设置掌握状态。"""
import re
from .common import new_id, now


def merge_gaps(session, proposed):
    for candidate in proposed[:4]:
        if not candidate["title"].strip():
            continue
        gap = next((g for g in session["gaps"] if g["id"] == candidate["id"] or g["title"] == candidate["title"]), None)
        if gap is None and len(session["gaps"]) < 6:
            gap_id = candidate["id"] if re.fullmatch(r"[a-zA-Z0-9_-]{1,50}", candidate["id"]) else "gap_" + new_id()[:8]
            session["gaps"].append(dict(id=gap_id, title=candidate["title"][:100], status="hypothesis",
                                        reason=candidate["reason"][:1000], evidenceIds=[]))
        elif gap is not None:
            gap["reason"] = candidate["reason"][:1000]
    if not session["gaps"]:
        session["gaps"].append(dict(id="understanding", title="当前概念的理解", status="hypothesis",
                                    reason="尚无足够证据，需要一个具体例子。", evidenceIds=[]))


def apply_grade(session, user, grade):
    check = session.get("check")
    if not check:
        return
    if grade["helpRequested"] or user["action"] in ("hint", "example"):
        check["assisted"] = True
        return
    if not grade["quote"].strip() or grade["quote"] not in user["content"] or grade["verdict"] == "unclear":
        return
    gap = next((g for g in session["gaps"] if g["id"] == check["skillId"]), None)
    if gap is None:
        return
    assisted = bool(check.get("assisted"))
    evidence = dict(id=new_id(), messageId=user["id"], checkId=check["id"], skillId=gap["id"],
                    question=check["question"], quote=grade["quote"], explanation=grade["explanation"],
                    verdict=grade["verdict"], kind=check["kind"], assisted=assisted, createdAt=now())
    session["evidence"].append(evidence)
    gap["evidenceIds"].append(evidence["id"])
    if grade["verdict"] == "incorrect":
        gap["status"] = "revisit" if gap["status"] == "independent" else "needs_work"
    elif gap["status"] != "independent":
        gap["status"] = "assisted" if assisted else "independent" if check["kind"] == "transfer" else "observed"
    if check["question"] not in session["completedChecks"]:
        session["completedChecks"].append(check["question"])


def install_check(session, check):
    previous = session.get("check")
    if not any(g["id"] == check["skillId"] for g in session["gaps"]) or not check["question"].strip() or not check["rubric"].strip():
        raise ValueError("辅导响应缺少有效的验证问题。")
    repeated = bool(previous and previous["question"].strip() == check["question"].strip())
    session["check"] = dict(check, id=previous["id"] if repeated else new_id(),
                            assisted=bool((repeated and previous.get("assisted")) or check["question"] in session["completedChecks"]),
                            createdAt=now())
