import { mkdir, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export class Store {
  constructor(directory) { this.directory = directory; this.sessions = new Map(); this.writes = new Map(); }
  async init() {
    await mkdir(this.directory, { recursive: true });
    for (const file of await readdir(this.directory)) {
      if (!/^[\da-f-]{36}\.json$/.test(file)) continue;
      try {
        const session = JSON.parse(await readFile(path.join(this.directory, file), 'utf8'));
        if (!session.id || !Array.isArray(session.messages)) continue;
        if (session.run?.status === 'running') {
          session.run.status = 'error'; session.run.error = '上次运行因服务重启中断，可以重试。';
        }
        session.images ??= [];
        this.sessions.set(session.id, session);
      } catch { console.warn(`跳过损坏的会话文件：${file}`); }
    }
  }
  create({ title, material = '', materialName = '' }) {
    const session = { id: randomUUID(), title, material, materialName, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      goal: '', messages: [], images: [], gaps: [], evidence: [], sources: [], check: null, run: null, mode: null, completedChecks: [] };
    this.sessions.set(session.id, session);
    return session;
  }
  get(id) { return this.sessions.get(id); }
  list() {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ id, title, updatedAt, mode, messages }) => ({ id, title, updatedAt, mode, count: messages.length }));
  }
  save(session) {
    session.updatedAt = new Date().toISOString();
    const content = JSON.stringify(session, null, 2);
    const operation = (this.writes.get(session.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const target = path.join(this.directory, `${session.id}.json`);
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, content, 'utf8');
      await rename(temporary, target);
    });
    this.writes.set(session.id, operation);
    return operation;
  }
}

// Rubrics remain server-side so assessment answers aren't sent to the browser.
export function publicSession(session, { includeImageData = false } = {}) {
  const { images = [], ...rest } = session;
  const result = structuredClone(rest);
  result.images = images.map(({ dataUrl, ...metadata }) => ({
    ...metadata, url: '/api/sessions/' + session.id + '/images/' + metadata.id,
    ...(includeImageData ? { dataUrl } : {})
  }));
  if (result.check) delete result.check.rubric;
  return result;
}
