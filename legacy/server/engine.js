import { randomUUID } from 'node:crypto';
import { ModelClient } from './providers.js';
import { SearchAgent } from './agents/search-agent.js';
import { PLAN_PROMPT, COACH_PROMPT, GRADE_PROMPT, contextFor } from './agents/main-agent.js';
import { demoPlan, demoGrade, demoCoach } from './agents/demo.js';
import { mergeGaps, applyGrade, installCheck } from './learning-state.js';
export class LearningEngine {
  constructor(config, store, dependencies = {}) {
    this.config = config; this.store = store;
    this.model = dependencies.model || new ModelClient(config);
    this.search = dependencies.search || new SearchAgent(config);
    this.pending = new Set();
  }
  async start(session, text, action = 'answer', retry = false, images = []) {
    if (session.run?.status === 'running') throw Object.assign(new Error('当前回答仍在处理中，请稍候。'), { status: 409 });
    if (session.mode && session.mode !== this.config.mode) throw Object.assign(new Error('运行模式已改变，请新建学习会话，避免混合演示和真实评估。'), { status: 409 });
    if (this.pending.size >= 4) throw Object.assign(new Error('当前处理任务较多，请稍后重试。'), { status: 429 });
    let user;
    if (retry) {
      if (session.run?.status !== 'error' || session.messages.at(-1)?.role !== 'user') throw Object.assign(new Error('没有可重试的失败请求。'), { status: 400 });
      user = session.messages.at(-1);
    } else {
      user = { id: randomUUID(), role: 'user', content: text, action, imageIds: images.map(image => image.id), createdAt: new Date().toISOString() };
      session.images = [...(session.images || []), ...images];
      session.messages.push(user);
    }
    session.mode = this.config.mode;
    session.run = { id: randomUUID(), status: 'running', events: [], error: null, startedAt: new Date().toISOString() };
    try { await this.store.save(session); }
    catch (error) { session.run.status = 'error'; session.run.error = '无法保存学习记录，请检查数据目录权限或磁盘空间后重试。'; throw error; }
    const task = this.execute(session, user).catch(error => { console.error('任务持久化失败：', error.code || error.name); });
    this.pending.add(task);
    task.finally(() => this.pending.delete(task));
  }
  async event(session, actor, label, detail = '') {
    session.run.events.push({ actor, label, detail, at: new Date().toISOString() });
    await this.store.save(session);
  }
  async execute(session, user) {
    try {
      const work = structuredClone(session);
      let grade = null;
      if (work.check && !user.imageIds?.length) {
        await this.event(session, '主智能体', '检查上一次回答', '结合评分要点和提示使用情况记录证据。');
        grade = this.config.mode === 'demo' ? demoGrade(work, user)
          : await this.model.generate('grade', GRADE_PROMPT, { currentCheck: work.check, user });
        applyGrade(work, user, grade);
      }
      if (work.images?.length) await this.event(session, '主智能体', this.config.mode === 'demo' ? '图片已保存' : '结合图片材料分析', this.config.mode === 'demo' ? '演示模式不能识别图片。接入支持视觉的模型后可读取图片内容。' : '从图片识别学习主题，结合已有知识补充背景与例子。');
      await this.event(session, '主智能体', '定位可能的理解缺口', '保持本次学习目标，选择一个最相关的小步骤。');
      const searchAvailable = this.config.mode === 'demo' || Boolean(this.config.searchKey);
      const plan = this.config.mode === 'demo' ? demoPlan(work)
        : await this.model.generate('plan', PLAN_PROMPT, { ...contextFor(work, user), searchAvailable }, work.images || []);
      if (!plan.goal.trim()) throw new Error('模型没有给出明确的学习目标。');
      work.goal = plan.goal.slice(0, 400);
      work.learningPath = plan.learningPath || work.learningPath || null;
      mergeGaps(work, plan.gaps);
      let searchNote = '使用自身知识开展教学；外部资料仅作可选补充。';
      if (!searchAvailable) plan.queries = [];
      if (plan.queries.length) {
        await this.event(session, '搜索智能体', '查找补充资料', plan.queries.slice(0, 2).join(' · '));
        const result = await this.search.run(plan.queries);
        // Keep stable source IDs across turns; citations remain attached to their original messages.
        for (const source of result.sources) {
          if (work.sources.some(existing => existing.url === source.url)) continue;
          work.sources.push({ ...source, id: 's' + (work.sources.length + 1) });
        }
        work.sources = work.sources.slice(0, 24);
        searchNote = result.note;
        await this.event(session, '搜索智能体', '资料返回', searchNote);
      }
      await this.event(session, '主智能体', '组织讲解与小验证', '结合主题与自身知识补充讲解，用你的回答验证理解。');
      const output = this.config.mode === 'demo' ? demoCoach(work, user, grade)
        : await this.model.generate('coach', COACH_PROMPT, { ...contextFor(work, user), plan, assessment: grade, sources: work.sources, searchAvailable, searchNote }, work.images || []);
      if (this.config.mode === 'demo' && user.imageIds?.length) output.reply = '图片已保存，但本地演示不能识别图片；下面仍是固定的递归演示，不是对图片的分析。\n\n' + output.reply;
      if (!output.reply.trim()) throw new Error('模型没有生成有效的辅导内容。');
      if (output.check) installCheck(work, output.check); else work.check = null;
      work.focusId = work.gaps.some(g => g.id === output.focusId) ? output.focusId : work.check?.skillId || work.gaps[0].id;
      const cited = work.sources.filter(source => output.sourceIds.includes(source.id));
      work.messages.push({ id: randomUUID(), role: 'assistant', content: output.reply,
        question: work.check?.question || '', checkId: work.check?.id || null, suggestions: output.suggestions.slice(0, 3),
        sources: cited, createdAt: new Date().toISOString() });
      // Commit only after all provider responses and the check pass validation.
      for (const key of ['goal', 'learningPath', 'gaps', 'evidence', 'sources', 'check', 'focusId', 'messages', 'completedChecks']) session[key] = work[key];
      await this.event(session, '主智能体', work.check ? '等待你的下一步' : '本轮学习已记录', work.check ? '可以尝试作答，也可以先要一个提示。' : '你可以回看学习证据，或开始新的主题。');
      session.run.status = 'done';
      session.run.finishedAt = new Date().toISOString();
      await this.store.save(session);
    } catch (error) {
      session.run.status = 'error';
      session.run.error = error.name === 'ProviderError' ? error.message : '本轮处理未完成，学习进度保持在上一次成功状态。可以重试。';
      session.run.finishedAt = new Date().toISOString();
      await this.store.save(session);
    }
  }
}
