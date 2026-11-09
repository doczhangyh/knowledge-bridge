import { postJson } from '../providers.js';
const library = [
  { id: 'python-functions', title: 'Python 官方教程：定义函数', url: 'https://docs.python.org/zh-cn/3/tutorial/controlflow.html#defining-functions', content: '函数调用会为局部变量创建新的局部符号表；return 从函数返回一个值。', origin: '内置参考资料（非实时搜索）' },
  { id: 'python-execution', title: 'Python 官方参考：执行模型', url: 'https://docs.python.org/zh-cn/3/reference/executionmodel.html', content: '代码块在执行帧中执行。名称绑定和作用域影响局部变量的查找。', origin: '内置参考资料（非实时搜索）' }
];
export function safeUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export class SearchAgent {
  constructor(config, fetcher = fetch) { this.config = config; this.fetcher = fetcher; }
  async run(queries) {
    if (this.config.mode === 'demo') return { sources: library, note: '演示模式：展示内置 Python 参考资料，未进行联网搜索。' };
    if (!queries.length) return { sources: [], note: '本轮不需要新的外部资料。' };
    if (!this.config.searchKey) return { sources: [], note: '未配置搜索服务，直接使用自身知识开展教学。' };
    const sources = [], failures = [];
    for (const query of queries.slice(0, 2)) {
      try {
        const data = await postJson(this.config.searchUrl + '/search', this.config.searchKey,
          { query: query.slice(0, 300), search_depth: 'basic', max_results: 4, include_answer: false, include_raw_content: false },
          20000, '搜索服务', this.fetcher);
        if (!Array.isArray(data.results)) throw new Error('搜索响应缺少结果列表');
        for (const item of data.results) {
          const url = safeUrl(item.url);
          if (!url || sources.some(s => s.url === url)) continue;
          sources.push({ id: 's' + (sources.length + 1), title: String(item.title || url).slice(0, 200),
            url, content: String(item.content || '').slice(0, 3500), origin: 'Tavily 搜索摘要', query });
        }
      } catch (error) { failures.push(error.message); }
    }
    return { sources: sources.slice(0, 6), note: failures.length ? '部分搜索未完成：' + failures.join(' ') : sources.length ? '已检索 ' + sources.length + ' 条来源；摘要不等于阅读全文。' : '没有检索到可用来源，暂不作外部证据支持的断言。' };
  }
}
