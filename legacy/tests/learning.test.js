import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, publicSession } from '../server/store.js';
import { mergeGaps, applyGrade, installCheck } from '../server/learning-state.js';
import { LearningEngine } from '../server/engine.js';
import { ModelClient } from '../server/providers.js';
import { SearchAgent } from '../server/agents/search-agent.js';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';

async function fixture(t, mode = 'demo', dependencies = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'knowledge-bridge-test-'));
  const config = { mode, dataDir: directory, port: 0, model: 'test-model', apiKey: 'test-secret', baseUrl: 'https://model.invalid/v1', jsonMode: 'json_object', timeout: 1000, searchKey: '', searchUrl: 'https://search.invalid' };
  const store = new Store(directory); await store.init();
  const engine = new LearningEngine(config, store, dependencies);
  t.after(async () => { await Promise.allSettled([...engine.pending]); await rm(directory, { recursive: true, force: true }); });
  const session = store.create({ title: '递归测试' }); await store.save(session);
  return { config, store, engine, session, directory };
}
async function turn(engine, session, text, action = 'answer') {
  await engine.start(session, text, action);
  await Promise.all([...engine.pending]);
  assert.equal(session.run.status, 'done', session.run.error);
}
const grade = { verdict: 'correct', quote: 'result is 5', explanation: '满足要点', helpRequested: false };
function state() {
  return { gaps: [{ id: 'g', title: '返回', status: 'hypothesis', evidenceIds: [] }], evidence: [], completedChecks: [],
    check: { id: 'q', skillId: 'g', kind: 'transfer', question: '结果？', rubric: '5', assisted: false } };
}
test('没有密钥时演示；真实模式配置不完整时拒绝启动', () => {
  assert.equal(loadConfig({}, 'missing.env').mode, 'demo');
  assert.throws(() => loadConfig({ APP_MODE: 'live' }, 'missing.env'), /LLM_API_KEY/);
  assert.throws(() => loadConfig({ APP_MODE: 'auto', LLM_API_KEY: 'key' }, 'missing.env'), /LLM_MODEL/);
});
test('初始缺口始终是假设，模型不能在计划中标记掌握', () => {
  const session = { gaps: [] };
  mergeGaps(session, [{ id: 'g', title: '函数', reason: '需要检查', status: 'independent' }]);
  assert.equal(session.gaps[0].status, 'hypothesis');
});
test('评分必须引用当前用户回答，不能凭空添加证据', () => {
  const session = state();
  applyGrade(session, { id: 'u', content: '我懂了', action: 'answer' }, grade);
  assert.equal(session.evidence.length, 0);
  assert.equal(session.gaps[0].status, 'hypothesis');
});
test('不明确的回答不改学习状态', () => {
  const session = state();
  applyGrade(session, { id: 'u', content: grade.quote, action: 'answer' }, { ...grade, verdict: 'unclear' });
  assert.equal(session.evidence.length, 0);
});
test('提示后的答对只记录帮助下完成', () => {
  const session = state();
  applyGrade(session, { id: 'h', content: '提示', action: 'hint' }, grade);
  applyGrade(session, { id: 'u', content: grade.quote, action: 'answer' }, grade);
  assert.equal(session.gaps[0].status, 'assisted');
  assert.equal(session.evidence[0].assisted, true);
});
test('诊断题答对只能表明观察到理解', () => {
  const session = state(); session.check.kind = 'diagnostic';
  applyGrade(session, { id: 'u', content: grade.quote, action: 'answer' }, grade);
  assert.equal(session.gaps[0].status, 'observed');
});
test('新变式独立答对有独立完成证据；后续答错需复查', () => {
  const session = state();
  const user = { id: 'u', content: grade.quote, action: 'answer' };
  applyGrade(session, user, grade);
  assert.equal(session.gaps[0].status, 'independent');
  applyGrade(session, user, { ...grade, verdict: 'incorrect' });
  assert.equal(session.gaps[0].status, 'revisit');
  assert.equal(session.evidence.length, 2);
});
test('同题重复作答不能伪装成新的独立验证', () => {
  const session = state(); session.completedChecks.push(session.check.question);
  installCheck(session, { skillId: 'g', kind: 'transfer', question: '结果？', rubric: '5' });
  assert.equal(session.check.assisted, true);
});
test('验证题必须绑定已有知识点', () => {
  assert.throws(() => installCheck(state(), { skillId: 'missing', kind: 'transfer', question: 'q', rubric: 'r' }), /有效/);
});
test('前端获取不到验证题评分答案', () => {
  const session = state();
  assert.equal(publicSession(session).check.rubric, undefined);
  assert.equal(session.check.rubric, '5');
});
test('演示端到端：提问、诊断、递归变式、独立完成、重启恢复', async t => {
  const { engine, session, directory } = await fixture(t);
  await turn(engine, session, '递归为什么会返回');
  assert.equal(session.check.skillId, 'return-flow');
  assert.ok(session.run.events.some(e => e.actor === '搜索智能体'));
  assert.match(session.sources[0].origin, /非实时/);
  await turn(engine, session, '输出 6，返回 3 赋值给 y，再乘 2。');
  assert.equal(session.check.kind, 'transfer');
  await turn(engine, session, 'f(0)=1，f(1)=3，f(2)=5');
  assert.equal(session.gaps.find(g => g.id === 'recursive-return').status, 'independent');
  const restored = new Store(directory); await restored.init();
  assert.equal(restored.get(session.id).messages.length, 6);
  assert.equal(restored.get(session.id).evidence.length, 2);
});
test('演示端到端：请求提示后不能升级为独立掌握', async t => {
  const { engine, session } = await fixture(t);
  await turn(engine, session, '递归');
  await turn(engine, session, '输出 6，返回 3 赋值给 y');
  await turn(engine, session, '给我一个提示', 'hint');
  await turn(engine, session, 'f(0)=1，f(1)=3，f(2)=5');
  assert.equal(session.gaps.find(g => g.id === 'recursive-return').status, 'assisted');
});
test('运行中的请求互斥；失败重试不重复写入用户消息', async t => {
  let release;
  const blocked = new Promise(resolve => release = resolve);
  const model = { generate: async () => { await blocked; throw new Error('test failure'); } };
  const { engine, session } = await fixture(t, 'live', { model });
  await engine.start(session, '问题');
  await assert.rejects(engine.start(session, '重复'), /处理中/);
  release(); await Promise.all([...engine.pending]);
  assert.equal(session.run.status, 'error');
  assert.equal(session.gaps.length, 0);
  assert.equal(session.messages.length, 1);
  await engine.start(session, '', 'answer', true); await Promise.all([...engine.pending]);
  assert.equal(session.messages.length, 1);
});
test('重启后把未结束的任务标为可重试错误', async t => {
  const { store, session, directory } = await fixture(t);
  session.run = { status: 'running' }; await store.save(session);
  const restored = new Store(directory); await restored.init();
  assert.equal(restored.get(session.id).run.status, 'error');
});
test('搜索失败透明降级，不伪造来源', async () => {
  const agent = new SearchAgent({ mode: 'live', searchKey: 'secret', searchUrl: 'https://invalid' }, async () => { throw new Error('network'); });
  const result = await agent.run(['递归']);
  assert.deepEqual(result.sources, []);
  assert.match(result.note, /未完成/);
});
test('搜索限制两次查询、去重并过滤危险链接', async () => {
  let calls = 0;
  const agent = new SearchAgent({ mode: 'live', searchKey: 'secret', searchUrl: 'https://invalid' }, async () => {
    calls++;
    return { ok: true, json: async () => ({ results: [
      { title: '官方', url: 'https://docs.python.org/test', content: 'return' },
      { title: '重复', url: 'https://docs.python.org/test', content: 'return' },
      { title: '危险', url: 'javascript:alert(1)' }
    ] }) };
  });
  const result = await agent.run(['q1', 'q2', 'q3']);
  assert.equal(calls, 2); assert.equal(result.sources.length, 1);
});
test('模型 JSON 结构错误最多重试一次', async () => {
  let calls = 0;
  const client = new ModelClient({ baseUrl: 'https://invalid', apiKey: 'secret', model: 'test', timeout: 1000 }, async () => {
    calls++; return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }) };
  });
  await assert.rejects(client.generate('plan', 's', {}), /连续/);
  assert.equal(calls, 2);
});
test('供应商错误不向浏览器透传密钥或原始响应', async () => {
  const client = new ModelClient({ baseUrl: 'https://invalid', apiKey: 'private-secret', model: 'test', timeout: 1000 }, async () => ({ ok: false, status: 401, json: async () => ({ detail: 'private-secret' }) }));
  await assert.rejects(client.generate('plan', 's', {}), error => !error.message.includes('private-secret') && /401/.test(error.message));
});
test('真实模式编排契约：主智能体计划→搜索→辅导（使用模拟供应商）', async t => {
  const calls = [];
  const model = { generate: async type => {
    calls.push(type);
    if (type === 'plan') return { goal: '理解返回', queries: ['Python return'], gaps: [{ id: 'g', title: '返回', reason: '待验证' }] };
    return { reply: '先看返回的例子 [s1]。', focusId: 'g', check: { skillId: 'g', kind: 'diagnostic', question: '返回到哪里？', rubric: '调用位置' }, suggestions: ['给我一个提示'], sourceIds: ['s1', 'fake'] };
  } };
  const search = { run: async () => { calls.push('search'); return { sources: [{ id: 'a', title: '参考', url: 'https://docs.python.org', content: '返回', origin: '测试搜索' }], note: '测试' }; } };
  const { engine, session, config } = await fixture(t, 'live', { model, search });
  config.searchKey = 'test-configured-key';
  await turn(engine, session, '返回是什么');
  assert.deepEqual(calls, ['plan', 'search', 'coach']);
  assert.equal(session.messages.at(-1).sources.length, 1);
});
test('HTTP 接口：输入校验、持久化、异步回复、秘密隔离与同源限制', async t => {
  const { config } = await fixture(t);
  const app = await createApp(config);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await Promise.allSettled([...app.engine.pending]); await new Promise(resolve => app.server.close(resolve)); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const request = (route, data, extra = {}) => fetch(base + route, { ...(data !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}), ...extra });
  const settings = await (await request('/api/config')).text();
  assert.ok(!settings.includes('test-secret')); assert.ok(settings.includes('demo'));
  assert.equal((await request('/api/sessions', { title: '' })).status, 400);
  assert.equal((await request('/api/sessions', { title: 'x', material: 'x'.repeat(30001) })).status, 400);
  assert.equal((await request('/api/sessions', { title: 'x' }, { headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' } })).status, 403);
  const created = await (await request('/api/sessions', { title: '测试', material: '函数返回' })).json();
  assert.equal((await request('/api/sessions/' + created.id + '/messages', { message: '为什么递归会返回' })).status, 202);
  await Promise.all([...app.engine.pending]);
  const snapshot = await (await request('/api/sessions/' + created.id)).json();
  assert.equal(snapshot.run.status, 'done');
  assert.equal(snapshot.messages.length, 2); assert.equal(snapshot.check.rubric, undefined);
  assert.equal((await request('/.env')).status, 404);
  const home = await request('/'); assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
});

test('已有独立完成证据不会因重复的帮助下练习被抹掉', () => {
  const session = state(); session.gaps[0].status = 'independent'; session.check.assisted = true;
  applyGrade(session, { id: 'u', content: grade.quote, action: 'answer' }, grade);
  assert.equal(session.gaps[0].status, 'independent');
  assert.equal(session.evidence[0].assisted, true);
});

test('没有搜索配置时仍正常教学，模型提出查询也不触发搜索', async t => {
  const calls = [], contexts = [];
  const model = { generate: async (type, prompt, context) => {
    calls.push(type); contexts.push(context);
    if (type === 'plan') return { goal: '理解无状态与登录状态', queries: ['HTTP Cookie'], gaps: [{ id: 'state', title: '请求与登录状态', reason: '用户困惑' }] };
    return { reply: 'HTTP 请求本身不自动保留上一次请求的状态，应用可以通过 Cookie 携带会话标识。', focusId: 'state',
      check: { skillId: 'state', kind: 'diagnostic', question: '下一次请求如何携带身份线索？', rubric: '携带 Cookie 或令牌' }, suggestions: [], sourceIds: [] };
  } };
  const search = { run: async () => { throw new Error('没有配置时不应调用搜索'); } };
  const { engine, session } = await fixture(t, 'live', { model, search });
  session.material = 'HTTP 是无状态协议。';
  await turn(engine, session, '为什么网站还能记住登录状态？');
  assert.deepEqual(calls, ['plan', 'coach']);
  assert.ok(contexts.every(context => context.searchAvailable === false));
  assert.deepEqual(contexts[1].plan.queries, []);
  assert.equal(session.run.events.some(event => event.actor === '搜索智能体'), false);
  assert.match(session.messages.at(-1).content, /Cookie/);
});
