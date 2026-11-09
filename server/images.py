"""图片输入校验与不含原图的上下文元数据。"""
import base64
import binascii
import re
from .common import RequestError, new_id, now

IMAGE_LIMITS = {"count": 6, "bytes": 4 * 1024 * 1024, "totalBytes": 12 * 1024 * 1024}


def detected_type(data):
    if len(data) >= 24 and data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if len(data) >= 4 and data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if len(data) >= 10 and data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def validate_images(items, existing=None):
    existing = existing or []
    if not isinstance(items, list):
        raise RequestError("图片列表格式无效。")
    if len(existing) + len(items) > IMAGE_LIMITS["count"]:
        raise RequestError("每个会话最多 6 张图片，请移除多余图片或新建学习会话。")
    images = []
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("dataUrl"), str):
            raise RequestError("图片数据无效。")
        data_url = item["dataUrl"]
        if len(data_url) > ((IMAGE_LIMITS["bytes"] + 2) // 3) * 4 + 50:
            raise RequestError("每张图片不能超过 4 MB。", 413)
        match = re.fullmatch(r"data:(image/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})", data_url)
        if not match:
            raise RequestError("只支持 PNG、JPEG、WebP、GIF 图片。")
        try:
            data = base64.b64decode(match[2], validate=True)
        except (ValueError, binascii.Error):
            raise RequestError("图片内容与格式不匹配，请重新导出图片。") from None
        if not data or len(data) > IMAGE_LIMITS["bytes"]:
            raise RequestError("图片为空或超过 4 MB。", 413)
        if base64.b64encode(data).decode() != match[2] or detected_type(data) != match[1]:
            raise RequestError("图片内容与格式不匹配，请重新导出图片。")
        name = item.get("name")
        images.append(dict(id=new_id(), name=name[:120] if isinstance(name, str) else "学习截图",
                           mime=match[1], size=len(data), dataUrl=data_url, createdAt=now()))
    if sum(image["size"] for image in existing + images) > IMAGE_LIMITS["totalBytes"]:
        raise RequestError("一个会话的图片总大小不能超过 12 MB。", 413)
    return images


def image_metadata(images=None):
    return [{key: image[key] for key in ("id", "name", "mime", "size", "createdAt")}
            for image in images or []]
