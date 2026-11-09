import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ROOT } from './config.js';
import { Store, publicSession } from './store.js';
import { LearningEngine } from './engine.js';
import { validateImages, IMAGE_LIMITS } from './images.js';
const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
function send(response, status, data) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); }
function fail(message, status = 400) { return Object.assign(new Error(message), { status }); }
async function body(request, limit = 256000) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw fail('请使用 JSON 请求。', 415);
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw fail('内容过长，请缩小学习材料后重试。', 413);
    chunks.push(chunk);
  }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch { throw fail('请求不是有效 JSON。'); }
}
function inputText(value, name, limit, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || value.length > limit || (!optional && !value.trim())) throw fail(name + '为空或超过长度限制。');
  return value.trim();
}
export async function createApp(config, dependencies = {}) {
  const store = dependencies.store || new Store(config.dataDir);
  await store.init();
  const engine = new LearningEngine(config, store, dependencies);
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const port = request.socket.localPort;
      const allowedHosts = ['127.0.0.1:' + port, 'localhost:' + port];
      if (!allowedHosts.includes(request.headers.host)) throw fail('仅接受本机地址访问。', 403);
      const origin = request.headers.origin;
      if (origin && !allowedHosts.map(host => 'http://' + host).includes(origin)) throw fail('不接受跨站请求。', 403);
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && staticFiles[url.pathname]) {
        const [file, type] = staticFiles[url.pathname];
        const content = await readFile(path.join(ROOT, 'public', file));
        response.writeHead(200, { 'Content-Type': type }); response.end(content); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/config') {
        return send(response, 200, { mode: config.mode, model: config.mode === 'live' ? config.model : '本地规则演示',
          searchEnabled: config.mode === 'live' && Boolean(config.searchKey),
          searchLabel: config.mode === 'demo' ? '内置参考资料' : config.searchKey ? 'Tavily 已配置' : '未配置搜索',
          limits: { message: 6000, material: 30000, images: IMAGE_LIMITS } });
      }
      if (url.pathname === '/api/sessions') {
        if (request.method === 'GET') return send(response, 200, store.list());
        if (request.method === 'POST') {
          const value = await body(request);
          const session = store.create({ title: inputText(value.title, '主题', 100),
            material: inputText(value.material, '学习材料', 30000, true),
            materialName: inputText(value.materialName, '材料名称', 120, true) });
          await store.save(session);
          return send(response, 201, publicSession(session));
        }
      }
      const imageRoute = url.pathname.match(/^\/api\/sessions\/([a-f\d-]{36})\/images\/([a-f\d-]{36})$/);
      if (imageRoute && request.method === 'GET') {
        const image = store.get(imageRoute[1])?.images?.find(item => item.id === imageRoute[2]);
        if (!image) throw fail('图片不存在。', 404);
        const bytes = Buffer.from(image.dataUrl.split(',')[1], 'base64');
        response.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': bytes.length });
        response.end(bytes); return;
      }
      const route = url.pathname.match(/^\/api\/sessions\/([a-f\d-]{36})(?:\/(messages|retry|export))?$/);
      if (route) {
        const session = store.get(route[1]);
        if (!session) throw fail('学习记录不存在。', 404);
        if (request.method === 'GET' && !route[2]) return send(response, 200, publicSession(session));
        if (request.method === 'GET' && route[2] === 'export') {
          response.setHeader('Content-Disposition', 'attachment; filename="learning-record.json"');
          return send(response, 200, publicSession(session, { includeImageData: true }));
        }
        if (request.method === 'POST' && route[2] === 'messages') {
          const value = await body(request, 17 * 1024 * 1024);
          const images = validateImages(value.images, session.images);
          const message = inputText(value.message, '问题', 6000, images.length > 0) || '请帮我理解这些图片中的学习内容。';
          if (!['answer', 'hint', 'example', 'return'].includes(value.action || 'answer')) throw fail('操作类型无效。');
          if (session.messages.length >= 160) throw fail('本次对话已较长，请新建学习会话。');
          await engine.start(session, message, value.action || 'answer', false, images);
          return send(response, 202, { runId: session.run.id });
        }
        if (request.method === 'POST' && route[2] === 'retry') {
          await body(request);
          await engine.start(session, '', 'answer', true);
          return send(response, 202, { runId: session.run.id });
        }
      }
      throw fail('找不到这个页面或接口。', 404);
    } catch (error) {
      if (!response.headersSent) send(response, error.status || 500, { error: error.status ? error.message : '服务暂时无法处理请求，请查看服务端状态。', requestId: randomUUID() });
      else response.end();
    }
  });
  server.requestTimeout = 30000;
  return { server, store, engine };
}
