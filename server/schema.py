"""模型 JSON 输出契约及本地校验（不依赖第三方包）。"""
from copy import deepcopy

def obj(properties):
    return dict(type="object", properties=properties, required=list(properties), additionalProperties=False)


def array(items):
    return dict(type="array", items=items)


STR = {"type": "string"}
SCHEMAS = {
    "plan": obj(dict(goal=STR, learningPath=obj(dict(
        currentUnderstanding=STR, targetUnderstanding=STR, missingLink=STR, basis=STR,
        nextMove=dict(type="string", enum=["clarify", "bridge", "verify"]))),
        queries=array(STR), gaps=array(obj(dict(id=STR, title=STR, reason=STR))))),
    "grade": obj(dict(verdict=dict(type="string", enum=["correct", "incorrect", "unclear"]),
                      quote=STR, explanation=STR, helpRequested={"type": "boolean"})),
    "coach": obj(dict(reply=STR, focusId=STR, check={"anyOf": [obj(dict(
        skillId=STR, kind=dict(type="string", enum=["diagnostic", "transfer"]),
        question=STR, rubric=STR)), {"type": "null"}]}, suggestions=array(STR), sourceIds=array(STR)))
}


def response_schema(kind, context):
    """检查题只能引用本轮实际保留的知识点，而非被容量限制丢弃的候选。"""
    schema = deepcopy(SCHEMAS[kind])
    if kind == "coach":
        ids = [gap["id"] for gap in context.get("gaps", [])]
        if ids:
            schema["properties"]["focusId"] = dict(type="string", enum=ids)
            check = schema["properties"]["check"]["anyOf"][0]
            check["properties"]["skillId"] = dict(type="string", enum=ids)
    return schema


def validate_response(value, schema, kind):
    validate(value, schema)
    if kind == "plan" and not value["goal"].strip():
        raise ValueError("学习目标不能为空")
    if kind == "coach":
        if not value["reply"].strip():
            raise ValueError("辅导正文不能为空")
        check = value["check"]
        if check and (not check["question"].strip() or not check["rubric"].strip()):
            raise ValueError("检查题及评分标准不能为空")
    return value


def validate(value, schema, path="response"):
    if "anyOf" in schema:
        for variant in schema["anyOf"]:
            try:
                return validate(value, variant, path)
            except ValueError:
                pass
        raise ValueError(f"{path} 不符合允许的结构")
    kind = schema["type"]
    if kind == "null":
        if value is not None:
            raise ValueError(f"{path} 应为空值")
    elif kind == "object":
        if not isinstance(value, dict):
            raise ValueError(f"{path} 应为对象")
        for key in schema["required"]:
            if key not in value:
                raise ValueError(f"{path}.{key} 缺失")
        for key, child in value.items():
            if key not in schema["properties"]:
                raise ValueError(f"{path}.{key} 为未知字段")
            validate(child, schema["properties"][key], f"{path}.{key}")
    elif kind == "array":
        if not isinstance(value, list) or len(value) > 12:
            raise ValueError(f"{path} 列表无效")
        for index, child in enumerate(value):
            validate(child, schema["items"], f"{path}[{index}]")
    elif kind == "string":
        if not isinstance(value, str) or len(value) > 12000:
            raise ValueError(f"{path} 类型或长度无效")
    elif kind == "boolean" and not isinstance(value, bool):
        raise ValueError(f"{path} 类型无效")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"{path} 值无效")
    return value
