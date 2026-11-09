"""执行有限次数的 Tavily 查询并整理来源。"""
from urllib.parse import urlsplit
from ..providers import post_json

LIBRARY = [
    dict(id="python-functions", title="Python 官方教程：定义函数", url="https://docs.python.org/zh-cn/3/tutorial/controlflow.html#defining-functions",
         content="函数调用会为局部变量创建新的局部符号表；return 从函数返回一个值。", origin="内置参考资料（非实时搜索）"),
    dict(id="python-execution", title="Python 官方参考：执行模型", url="https://docs.python.org/zh-cn/3/reference/executionmodel.html",
         content="代码块在执行帧中执行。名称绑定和作用域影响局部变量的查找。", origin="内置参考资料（非实时搜索）")]


def safe_url(value):
    try:
        url = urlsplit(value)
        if url.scheme in ("http", "https") and url.hostname and not url.username and not url.password:
            return url.geturl()
    except (TypeError, ValueError, AttributeError):
        pass
    return None


class SearchAgent:
    def __init__(self, config, transport=post_json):
        self.config = config
        self.transport = transport

    def run(self, queries):
        c = self.config
        if c["mode"] == "demo":
            return dict(sources=[dict(source) for source in LIBRARY], note="演示模式：展示内置 Python 参考资料，未进行联网搜索。")
        if not queries:
            return dict(sources=[], note="本轮不需要新的外部资料。")
        if not c.get("searchKey"):
            return dict(sources=[], note="未配置搜索服务，直接使用自身知识开展教学。")
        sources, failures = [], []
        for query in queries[:2]:
            try:
                data = self.transport(c["searchUrl"] + "/search", c["searchKey"],
                                      dict(query=query[:300], search_depth="basic", max_results=4,
                                           include_answer=False, include_raw_content=False), 20000, "搜索服务")
                if not isinstance(data, dict) or not isinstance(data.get("results"), list):
                    raise ValueError("搜索响应缺少结果列表")
                for item in data["results"]:
                    if not isinstance(item, dict):
                        continue
                    url = safe_url(item.get("url"))
                    if not url or any(source["url"] == url for source in sources):
                        continue
                    sources.append(dict(id="s" + str(len(sources) + 1), title=str(item.get("title") or url)[:200],
                                        url=url, content=str(item.get("content") or "")[:3500], origin="Tavily 搜索摘要", query=query))
            except Exception:
                # Never expose raw provider errors or potentially sensitive request data.
                failures.append("搜索服务未完成本次查询")
        note = ("部分搜索未完成：" + "；".join(failures) if failures else
                f"已检索 {len(sources)} 条来源；摘要不等于阅读全文。" if sources else
                "没有检索到可用来源，暂不作外部证据支持的断言。")
        return dict(sources=sources[:6], note=note)
