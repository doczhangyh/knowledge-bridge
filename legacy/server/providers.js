import { schemas, validate } from './schema.js';

export class ProviderError extends Error {}
export async function postJson(url, key, body, timeout, label, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(url, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  } catch { throw new ProviderError(`${label}连接失败或超时，请检查网络及服务地址。`); }
  if (!response.ok) {
    const reason = response.status === 401 || response.status === 403 ? '请检查密钥与访问权限' : response.status === 429 ? '请求限流或额度不足，请稍后再试' : '请检查服务状态、模型名称及接口兼容性';
    throw new ProviderError(`${label}请求失败（${response.status}）：${reason}。`);
  }
  try { return await response.json(); } catch { throw new ProviderError(`${label}没有返回有效 JSON。`); }
}

export class ModelClient {
  constructor(config, fetcher = fetch) { this.config = config; this.fetcher = fetcher; }
  async generate(type, system, context, images = []) {
    const c = this.config;
    const schema = schemas[type];
    const messages = [
      { role: 'system', content: `${system}\n只返回 JSON。严格符合以下 JSON Schema：${JSON.stringify(schema)}` },
      { role: 'user', content: images.length ? [
        { type: 'text', text: JSON.stringify(context) },
        ...images.flatMap((image, index) => [
          { type: 'text', text: '学习图片 ' + (index + 1) + '，ID：' + image.id + '，文件名：' + image.name },
          { type: 'image_url', image_url: { url: image.dataUrl, detail: 'high' } }
        ])
      ] : JSON.stringify(context) }
    ];
    // JSON mode only guarantees valid JSON. Validate every result locally, including strict mode.
    for (let attempt = 0; attempt < 2; attempt++) {
      const body = { model: c.model, messages, response_format: c.jsonMode === 'json_schema'
        ? { type: 'json_schema', json_schema: { name: type, strict: true, schema } }
        : { type: 'json_object' } };
      const data = await postJson(`${c.baseUrl}/chat/completions`, c.apiKey, body, c.timeout, '模型服务', this.fetcher);
      const choice = data.choices?.[0];
      if (choice?.message?.refusal) throw new ProviderError('模型未能处理这次请求，请调整学习问题后重试。');
      try {
        if (choice?.finish_reason && choice.finish_reason !== 'stop') throw new Error('输出未完成');
        return validate(JSON.parse(choice?.message?.content), schema);
      } catch {
        if (attempt === 1) throw new ProviderError('模型连续返回不符合结构的数据。请检查模型是否支持 JSON 输出，然后重试。');
        messages.push({ role: 'user', content: '上次输出未通过结构校验。请重新输出完整 JSON，包含所有字段，不要 Markdown 代码围栏。' });
      }
    }
  }
}
