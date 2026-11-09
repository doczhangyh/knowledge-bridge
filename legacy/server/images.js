import { randomUUID } from 'node:crypto';
export const IMAGE_LIMITS = { count: 6, bytes: 4 * 1024 * 1024, totalBytes: 12 * 1024 * 1024 };
function invalid(message, status = 400) { return Object.assign(new Error(message), { status }); }
function detectedType(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
export function validateImages(input = [], existing = []) {
  if (!Array.isArray(input)) throw invalid('图片列表格式无效。');
  if (existing.length + input.length > IMAGE_LIMITS.count) throw invalid('每个会话最多 6 张图片，请移除多余图片或新建学习会话。');
  const images = input.map(item => {
    if (!item || typeof item !== 'object' || typeof item.dataUrl !== 'string') throw invalid('图片数据无效。');
    if (item.dataUrl.length > Math.ceil(IMAGE_LIMITS.bytes / 3) * 4 + 50) throw invalid('每张图片不能超过 4 MB。', 413);
    const match = item.dataUrl.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) throw invalid('只支持 PNG、JPEG、WebP、GIF 图片。');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > IMAGE_LIMITS.bytes) throw invalid('图片为空或超过 4 MB。', 413);
    if (bytes.toString('base64') !== match[2] || detectedType(bytes) !== match[1]) throw invalid('图片内容与格式不匹配，请重新导出图片。');
    return { id: randomUUID(), name: typeof item.name === 'string' ? item.name.slice(0, 120) : '学习截图',
      mime: match[1], size: bytes.length, dataUrl: item.dataUrl, createdAt: new Date().toISOString() };
  });
  if ([...existing, ...images].reduce((sum, image) => sum + image.size, 0) > IMAGE_LIMITS.totalBytes) throw invalid('一个会话的图片总大小不能超过 12 MB。', 413);
  return images;
}
export function imageMetadata(images = []) {
  return images.map(({ id, name, mime, size, createdAt }) => ({ id, name, mime, size, createdAt }));
}
