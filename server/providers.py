"""Chat Completions 兼容接口；密钥与供应商错误正文不向前端透传。"""
import json
import urllib.error
import urllib.request
from .schema import response_schema, validate_response


class ProviderError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def post_json(url, key, body, timeout, label):
    request = urllib.request.Request(url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                                     headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
                                     method="POST")
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=timeout / 1000) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        reason = ("请检查密钥与访问权限" if status in (401, 403) else
                  "请求限流或额度不足，请稍后再试" if status == 429 else "请检查服务状态、模型名称及接口兼容性")
        raise ProviderError(f"{label}请求失败（{status}）：{reason}。") from None
    except (OSError, ValueError):
        raise ProviderError(f"{label}连接失败或超时，请检查网络及服务地址。") from None
    try:
        return json.loads(raw)
    except (ValueError, UnicodeError):
        raise ProviderError(f"{label}没有返回有效 JSON。") from None


class ModelClient:
    def __init__(self, config, transport=post_json):
        self.config = config
        self.transport = transport

    def generate(self, kind, system, context, images=None):
        c = self.config
        schema = response_schema(kind, context)
        content = json.dumps(context, ensure_ascii=False)
        if images:
            content = [{"type": "text", "text": content}]
            for index, image in enumerate(images, 1):
                content.extend([
                    {"type": "text", "text": f"学习图片 {index}，ID：{image['id']}，文件名：{image['name']}"},
                    {"type": "image_url", "image_url": {"url": image["dataUrl"], "detail": "high"}}])
        messages = [{"role": "system", "content": system + "\n只返回 JSON。严格符合以下 JSON Schema：" + json.dumps(schema, ensure_ascii=False)},
                    {"role": "user", "content": content}]
        for attempt in range(2):
            output_format = ({"type": "json_schema", "json_schema": {"name": kind, "strict": True, "schema": schema}}
                             if c.get("jsonMode") == "json_schema" else {"type": "json_object"})
            data = self.transport(c["baseUrl"] + "/chat/completions", c["apiKey"],
                                  {"model": c["model"], "messages": messages, "response_format": output_format},
                                  c["timeout"], "模型服务")
            try:
                choice = data["choices"][0]
                if choice.get("message", {}).get("refusal"):
                    raise ProviderError("模型未能处理这次请求，请调整学习问题后重试。")
                if choice.get("finish_reason") not in (None, "stop"):
                    raise ValueError("输出未完成")
                return validate_response(json.loads(choice["message"]["content"]), schema, kind)
            except (KeyError, IndexError, TypeError, ValueError):
                if attempt == 1:
                    detail = "检查题需要关联已有知识点，正文、题目与评分标准不能为空。" if kind == "coach" else "请检查模型是否支持 JSON 输出。"
                    raise ProviderError("模型连续返回不符合要求的数据。" + detail + "本轮尚未保存，可重试。") from None
                messages.append({"role": "user", "content": "上次输出未通过校验。请重新输出完整 JSON，包含所有字段，不要 Markdown 代码围栏。focusId 和 check.skillId 必须选择 Schema 中列出的已有知识点 ID；正文、题目、评分标准及学习目标不得为空。"})
