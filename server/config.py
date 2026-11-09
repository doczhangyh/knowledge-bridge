"""加载 .env；系统环境变量优先。内部与现有 JSON 契约保持相同键名。"""
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent


def load_config(env=None, env_file=None):
    env = os.environ if env is None else env
    env_file = ROOT / ".env" if env_file is None else Path(env_file)
    values = {}
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8-sig").splitlines():
            match = re.fullmatch(r"\s*([A-Z_]+)\s*=\s*(.*?)\s*", line)
            if match:
                value = match[2]
                if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
                    value = value[1:-1]
                values[match[1]] = value

    def get(key, default=""):
        return env.get(key, values.get(key, default))

    api_key = get("LLM_API_KEY") or get("OPENAI_API_KEY")
    requested = get("APP_MODE", "auto")
    if requested not in ("auto", "live", "demo"):
        raise ValueError("APP_MODE 必须为 auto、live 或 demo")
    mode = ("live" if api_key else "demo") if requested == "auto" else requested
    model = get("LLM_MODEL")
    if mode == "live" and not (api_key and model):
        raise ValueError("真实模式需要配置 LLM_API_KEY 和 LLM_MODEL。")
    try:
        port = int(get("PORT", "3210"))
        if not 1 <= port <= 65535:
            raise ValueError()
    except ValueError:
        raise ValueError("PORT 无效") from None
    base_url = get("LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    search_url = get("TAVILY_BASE_URL", "https://api.tavily.com").rstrip("/")
    for url in (base_url, search_url):
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValueError("服务地址必须是 HTTP(S) URL")
    json_mode = get("LLM_JSON_MODE", "json_object")
    if json_mode not in ("json_object", "json_schema"):
        raise ValueError("LLM_JSON_MODE 无效")
    try:
        timeout = float(get("LLM_TIMEOUT_MS", "60000")) or 60000
    except ValueError:
        timeout = 60000
    return dict(mode=mode, port=port, apiKey=api_key, model=model,
                baseUrl=base_url, jsonMode=json_mode, searchUrl=search_url,
                searchKey=get("TAVILY_API_KEY"), timeout=min(120000, max(1000, timeout)),
                dataDir=str((ROOT / get("DATA_DIR", "data")).resolve()))
