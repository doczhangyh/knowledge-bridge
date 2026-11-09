import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export function loadConfig(env = process.env, envFile = path.join(ROOT, '.env')) {
  const values = {};
  try {
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const get = (key, fallback = '') => env[key] ?? values[key] ?? fallback;
  const apiKey = get('LLM_API_KEY') || get('OPENAI_API_KEY');
  const requestedMode = get('APP_MODE', 'auto');
  if (!['auto', 'live', 'demo'].includes(requestedMode)) throw new Error('APP_MODE 必须为 auto、live 或 demo');
  const mode = requestedMode === 'auto' ? (apiKey ? 'live' : 'demo') : requestedMode;
  const model = get('LLM_MODEL');
  if (mode === 'live' && (!apiKey || !model)) throw new Error('真实模式需要配置 LLM_API_KEY 和 LLM_MODEL。');
  const port = Number(get('PORT', '3210'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效');
  const baseUrl = get('LLM_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, '');
  const searchUrl = get('TAVILY_BASE_URL', 'https://api.tavily.com').replace(/\/$/, '');
  for (const url of [baseUrl, searchUrl]) if (!['https:', 'http:'].includes(new URL(url).protocol)) throw new Error('服务地址必须是 HTTP(S) URL');
  const jsonMode = get('LLM_JSON_MODE', 'json_object');
  if (!['json_object', 'json_schema'].includes(jsonMode)) throw new Error('LLM_JSON_MODE 无效');
  return { mode, port, apiKey, model, baseUrl, jsonMode, searchUrl,
    searchKey: get('TAVILY_API_KEY'),
    timeout: Math.min(120000, Math.max(1000, Number(get('LLM_TIMEOUT_MS', '60000')) || 60000)),
    dataDir: path.resolve(ROOT, get('DATA_DIR', 'data')) };
}
