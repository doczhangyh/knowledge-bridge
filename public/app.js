const $ = id => document.getElementById(id);
const labels = { hypothesis: '待验证的假设', needs_work: '需要补一小步', observed: '已观察到理解', assisted: '帮助下完成', independent: '当次独立完成', revisit: '需要重新检查' };
let config, current = null, sessions = [], sending = false, pollTimer, toastTimer, selection = 0, messageSignature = '', materialName = '';
let pendingImages = [], loadingImages = false;
function node(tag, className, text) { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; }
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5000); }
async function api(url, options = {}) {
  let response;
  try { response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(15000) }); }
  catch { throw new Error('暂时无法连接本地服务。请确认后端仍在运行，然后重试。'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('服务返回格式异常，请检查后端状态。'); }
  if (!response.ok) throw new Error(data.error || '请求失败，请重试。');
  return data;
}
function inline(element, text) {
  // Render text, inline code and emphasis without interpreting HTML or model-generated links.
  for (const part of text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g)) {
    if (part.startsWith('**') && part.endsWith('**')) element.append(node('strong', '', part.slice(2, -2)));
    else if (part.startsWith('`') && part.endsWith('`')) element.append(node('code', '', part.slice(1, -1)));
    else element.append(document.createTextNode(part));
  }
}
function prose(text) {
  const container = node('div', 'prose');
  const pieces = String(text).split(/(```[\s\S]*?```)/g);
  for (const piece of pieces) {
    if (piece.startsWith('```')) {
      const code = piece.slice(3, -3).replace(/^[a-zA-Z0-9_-]*\n/, '');
      const pre = node('pre'); pre.append(node('code', '', code)); container.append(pre);
    } else for (const paragraph of piece.split(/\n\n+/).filter(Boolean)) { const p = node('p'); inline(p, paragraph); container.append(p); }
  }
  return container;
}
function safeUrl(value) { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; } }
function renderHistory() {
  $('session-list').replaceChildren(); $('session-count').textContent = sessions.length;
  if (!sessions.length) $('session-list').append(node('p', 'history-empty', '还没有学习记录。\n从一个小问题开始吧。'));
  for (const session of sessions) {
    const button = node('button', 'session-item' + (session.id === current?.id ? ' active' : ''));
    button.append(node('span', '', '▤'));
    const body = node('div'); body.append(node('strong', '', session.title));
    body.append(node('small', '', new Date(session.updatedAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }) + (session.mode === 'demo' ? ' · 演示' : '')));
    button.append(body); button.addEventListener('click', () => selectSession(session.id)); $('session-list').append(button);
  }
}
async function refreshHistory() { sessions = await api('/api/sessions'); renderHistory(); }
function renderMessages() {
  const signature = current ? current.id + ':' + current.messages.map(m => m.id).join(',') : '';
  if (signature === messageSignature) return;
  messageSignature = signature; $('messages').replaceChildren();
  for (const message of current?.messages || []) {
    const article = node('article', 'message ' + message.role);
    if (message.role === 'user') {
      const bubble = node('div', 'user-bubble');
      if (message.imageIds?.length) {
        const grid = node('div', 'message-images');
        for (const id of message.imageIds) {
          const image = current.images?.find(item => item.id === id);
          if (!image) continue;
          const button = node('button', 'message-image-button');
          button.type = 'button'; button.setAttribute('aria-label', '查看图片：' + image.name);
          const thumbnail = node('img', 'message-image'); thumbnail.src = image.url; thumbnail.alt = image.name;
          button.append(thumbnail); button.addEventListener('click', () => previewImage(image.url, image.name)); grid.append(button);
        }
        bubble.append(grid);
      }
      bubble.append(node('div', '', message.content)); article.append(bubble);
    }
    else {
      const header = node('div', 'assistant-header');
      const logo = node('img'); logo.src = '/favicon.svg'; logo.alt = '';
      header.append(logo, node('span', '', '知桥'), node('small', '', current.mode === 'demo' ? '本地演示' : '学习伙伴')); article.append(header, prose(message.content));
      if (message.question) {
        const card = node('div', 'check-card'); card.append(node('span', 'check-label', '◎  一起试一小步'), prose(message.question)); article.append(card);
      }
      if (message.sources?.length) {
        const details = node('details', 'sources'); details.append(node('summary', '', message.sources.length + ' 条参考来源'));
        for (const source of message.sources) {
          const href = safeUrl(source.url); if (!href) continue;
          const a = node('a', 'source-link', '[' + source.id + '] ' + source.title); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
          a.append(node('small', '', new URL(href).hostname + ' · ' + source.origin)); details.append(a);
        }
        article.append(details);
      }
    }
    $('messages').append(article);
  }
  requestAnimationFrame(() => $('scroll-area').scrollTop = $('scroll-area').scrollHeight);
}
function renderInsights() {
  const path = current?.learningPath;
  $('learning-path').replaceChildren(); $('learning-path').hidden = !path;
  if (path) {
    $('learning-path').append(node('h2', '', '从你的理解出发'));
    for (const [label, content] of [['你目前的认识', path.currentUnderstanding], ['这次要接上的一步', path.missingLink], ['希望你能做到', path.targetUnderstanding]]) {
      const section = node('div', 'learning-path-step');
      section.append(node('span', '', label), node('p', '', content)); $('learning-path').append(section);
    }
    $('learning-path').append(node('small', '', '这是当前判断，会随你的回答调整。'));
  }
  $('goal-text').textContent = current?.goal || '从你想弄懂的问题出发，让每一步都有方向。';
  document.querySelector('.goal-card h2').textContent = current?.goal ? '这次，我们先接上这一环' : '先确定一个小目标';
  $('goal-status').textContent = !current?.goal ? '等待你的第一个问题' : current.run?.status === 'running' ? '正在选择下一步' : '围绕当前目标继续';
  $('gap-count').textContent = current?.gaps.length ? current.gaps.filter(g => g.status === 'independent').length + ' 项独立完成' : '尚未开始';
  $('gaps').replaceChildren();
  if (!current?.gaps.length) {
    const empty = node('div', 'empty-map');
    const art = node('div', 'bridge-art'); for (const tag of ['span', 'i', 'span', 'i', 'span']) art.append(node(tag));
    empty.append(art, node('p', '', '从已知，走向未知'), node('small', '', '这里会显示可能的缺口，\n以及每一步验证的依据。')); $('gaps').append(empty);
  }
  for (const gap of current?.gaps || []) {
    const card = node('div', 'gap ' + gap.status); card.append(node('h3', '', gap.title), node('span', 'status-label', labels[gap.status] || labels.hypothesis), node('p', '', gap.reason));
    const evidence = current.evidence.filter(e => e.skillId === gap.id);
    if (evidence.length) {
      const details = node('details'); details.append(node('summary', '', '查看 ' + evidence.length + ' 条回答依据'));
      for (const item of evidence.slice(-4)) {
        const block = node('div', 'evidence'); block.append(node('blockquote', '', item.quote), node('span', '', item.explanation + (item.assisted ? '（使用过帮助）' : ''))); details.append(block);
      }
      card.append(details);
    }
    $('gaps').append(card);
  }
  const events = current?.run?.events || [];
  $('trace-section').hidden = !events.length; $('trace-list').replaceChildren();
  for (const event of events) {
    const row = node('div', 'trace-item'); row.append(node('span', 'trace-badge', event.actor === '搜索智能体' ? '搜' : '主'));
    const body = node('div'); body.append(node('strong', '', event.label), node('p', '', event.detail)); row.append(body); $('trace-list').append(row);
  }
}
function updateControls() {
  const busy = sending || loadingImages || current?.run?.status === 'running';
  $('send-button').disabled = busy || (!$('message-input').value.trim() && !pendingImages.length) || !config;
  $('send-button').replaceChildren(document.createTextNode(busy ? '处理中' : current ? '发送' : '开始学习'), node('span', '', busy ? '·' : '↑'));
  $('new-session').disabled = sending;
  $('image-button').disabled = busy || (current?.images?.length || 0) + pendingImages.length >= 6;
  for (const button of $('image-tray').querySelectorAll('button')) button.disabled = busy;
  $('material-button').disabled = sending || (Boolean(current) && !current.material); $('upload-button').disabled = Boolean(current) || sending;
  $('material-input').readOnly = Boolean(current); $('clear-material').hidden = Boolean(current);
  $('export-button').disabled = !current || busy;
  for (const button of $('suggestions').querySelectorAll('button')) button.disabled = busy;
  $('run-indicator').hidden = current?.run?.status !== 'running';
  $('run-label').textContent = current?.run?.events.at(-1)?.label || '正在分析你的问题…';
}
function render() {
  $('welcome').hidden = Boolean(current?.messages.length);
  $('session-title').textContent = current?.title || '新的开始';
  $('error-card').hidden = current?.run?.status !== 'error';
  if (current?.run?.status === 'error') $('error-text').textContent = current.run.error;
  $('composer-note').textContent = current ? '可以尝试作答，也可以先要一个提示。' : '支持粘贴截图，也可以直接发送图片。';
  renderMessages(); renderInsights(); renderHistory();
  $('suggestions').replaceChildren();
  const last = current?.messages.at(-1);
  if (last?.role === 'assistant') {
    for (const label of last.suggestions || []) {
      const button = node('button', '', label);
      button.addEventListener('click', () => submitMessage(label, /提示/.test(label) ? 'hint' : /例子|示范/.test(label) ? 'example' : 'return'));
      $('suggestions').append(button);
    }
  }
  updateControls();
}
function newSession() {
  if (sending) return;
  selection++; clearTimeout(pollTimer); current = null; messageSignature = 'reset';
  pendingImages = []; renderImageTray();
  $('message-input').value = ''; $('material-input').value = ''; materialName = ''; $('material-editor').hidden = true;
  $('sidebar').classList.remove('open'); updateMaterialBadge();
  localStorage.removeItem('knowledge-bridge-session'); render(); $('message-input').focus();
}
async function selectSession(id) {
  if (sending) return;
  const token = ++selection; clearTimeout(pollTimer);
  try {
    const session = await api('/api/sessions/' + id);
    if (token !== selection) return;
    current = session; pendingImages = []; renderImageTray(); $('material-editor').hidden = true;
    $('material-badge').hidden = true; $('sidebar').classList.remove('open');
    localStorage.setItem('knowledge-bridge-session', id); render();
    if (current.run?.status === 'running') schedulePoll(id, token);
  } catch (error) { if (token === selection) toast(error.message); }
}
function schedulePoll(id, token) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    try {
      const snapshot = await api('/api/sessions/' + id);
      if (token !== selection || current?.id !== id) return;
      current = snapshot; render();
      if (current.run?.status === 'running') schedulePoll(id, token);
      else await refreshHistory();
    } catch (error) {
      if (token !== selection) return;
      $('error-text').textContent = error.message + ' 点击重试可重新连接，不会重复发送问题。';
      $('error-card').hidden = false;
      $('run-indicator').hidden = true;
    }
  }, 750);
}
async function submitMessage(text = $('message-input').value, action = 'answer') {
  if (sending || loadingImages || current?.run?.status === 'running' || (!text.trim() && !pendingImages.length)) return;
  text = text.trim() || '请帮我理解这些图片中的学习内容。';
  if (!config) return toast('服务尚未连接。');
  if (text.length > 6000) return toast('请把问题控制在 6,000 字以内。');
  sending = true; updateControls();
  try {
    if (!current) {
      const material = $('material-input').value;
      if (material.length > 30000) throw new Error('学习材料不能超过 30,000 字。');
      current = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: text.trim().slice(0, 30), material, materialName }) });
      selection++; localStorage.setItem('knowledge-bridge-session', current.id);
      $('material-editor').hidden = true; $('material-badge').hidden = true;
    }
    const id = current.id, token = selection;
    await api('/api/sessions/' + id + '/messages', { method: 'POST', body: JSON.stringify({ message: text, action, images: pendingImages.map(({ name, dataUrl }) => ({ name, dataUrl })) }) });
    current.run = { status: 'running', events: [] };
    pendingImages = []; renderImageTray();
    $('message-input').value = '';
    current = await api('/api/sessions/' + id); render();
    await refreshHistory();
    if (current.run?.status === 'running') schedulePoll(id, token);
  } catch (error) {
    toast(error.message);
    if (current?.run?.status === 'running') {
      $('error-text').textContent = error.message + ' 问题已提交，正在重新连接。';
      $('error-card').hidden = false;
      schedulePoll(current.id, selection);
    }
  }
  finally { sending = false; updateControls(); }
}
function updateMaterialBadge() {
  const length = $('material-input').value.length;
  $('material-badge').hidden = !length || Boolean(current);
  $('material-badge').textContent = length ? length.toLocaleString('zh-CN') + ' 字材料' : '';
}
function settings() {
  $('connection-info').replaceChildren();
  for (const [label, value] of [['运行模式', config?.mode === 'live' ? '真实模型' : '本地演示'], ['模型', config?.model || '尚未连接'], ['搜索', config?.searchLabel || '尚未连接']]) {
    const row = node('div', 'connection-row'); row.append(node('span', '', label), node('strong', '', value)); $('connection-info').append(row);
  }
  $('settings-dialog').showModal();
}
$('message-form').addEventListener('submit', event => { event.preventDefault(); submitMessage(); });
$('message-input').addEventListener('input', updateControls);
$('message-input').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); submitMessage(); } });
$('new-session').addEventListener('click', newSession);
$('material-button').addEventListener('click', () => { if (current) $('material-input').value = current.material; $('material-editor').hidden = !$('material-editor').hidden; if (!$('material-editor').hidden) $('material-input').focus(); });
$('close-material').addEventListener('click', () => $('material-editor').hidden = true);
$('clear-material').addEventListener('click', () => { $('material-input').value = ''; materialName = ''; updateMaterialBadge(); });
$('material-input').addEventListener('input', updateMaterialBadge);
$('upload-button').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async () => {
  const file = $('file-input').files[0]; if (!file) return;
  try {
    if (!/\.(txt|md|py|js|ts|json)$/i.test(file.name) || file.size > 120000) throw new Error('请选择不超过 120 KB 的 TXT、Markdown 或代码文本。');
    const text = await file.text();
    if (text.includes('\u0000') || text.length > 30000) throw new Error('文件不是可读文本或超过 30,000 字。');
    $('material-input').value = text; materialName = file.name; $('material-editor').hidden = false; updateMaterialBadge(); toast('已导入 ' + file.name);
  } catch (error) { toast(error.message); }
  finally { $('file-input').value = ''; }
});
for (const button of document.querySelectorAll('[data-starter]')) {
  button.addEventListener('click', () => {
    const type = button.dataset.starter;
    if (type === 'own') { $('material-editor').hidden = false; $('material-input').focus(); return; }
    $('message-input').value = type === 'recursion' ? '我知道递归就是函数调用自己，但不明白结果为什么能一层层返回。请带我找到缺失的那一环。' : '我正在学习 HTTP。既然 HTTP 是无状态的，网站为什么还能记得我登录过？我不清楚 Cookie 和 Session 在这里分别做了什么。';
    if (type === 'http' && config?.mode === 'demo') toast('当前演示只支持递归路径。配置模型后可学习 HTTP 等主题。');
    $('message-input').focus(); updateControls();
  });
}
$('retry-button').addEventListener('click', async () => {
  if (!current || sending) return;
  sending = true; $('retry-button').disabled = true; updateControls();
  try {
    if (current.run?.status === 'error') await api('/api/sessions/' + current.id + '/retry', { method: 'POST', body: '{}' });
    const id = current.id;
    current = await api('/api/sessions/' + id); render();
    if (current.run?.status === 'running') schedulePoll(id, selection);
  } catch (error) { toast(error.message); }
  finally { sending = false; $('retry-button').disabled = false; updateControls(); }
});
$('export-button').addEventListener('click', () => { if (current) { const a = node('a'); a.href = '/api/sessions/' + current.id + '/export'; a.download = 'learning-record.json'; a.click(); } });
$('menu-toggle').addEventListener('click', () => { $('sidebar').classList.toggle('open'); $('insight-panel').classList.remove('open'); });
$('progress-toggle').addEventListener('click', () => { $('insight-panel').classList.toggle('open'); $('sidebar').classList.remove('open'); });
$('settings-button').addEventListener('click', settings); $('demo-config').addEventListener('click', settings);
$('close-settings').addEventListener('click', () => $('settings-dialog').close());
$('settings-done').addEventListener('click', () => $('settings-dialog').close());
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { $('sidebar').classList.remove('open'); $('insight-panel').classList.remove('open'); }
  if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey && !['INPUT', 'TEXTAREA'].includes(event.target.tagName) && !$('settings-dialog').open) newSession();
});
async function boot() {
  updateControls();
  try {
    [config, sessions] = await Promise.all([api('/api/config'), api('/api/sessions')]);
    $('mode-tag').textContent = config.mode === 'live' ? '● 真实模型' : '◉ 演示环境';
    $('mode-tag').classList.toggle('live', config.mode === 'live');
    $('demo-notice').hidden = config.mode !== 'demo';
    render();
    const saved = localStorage.getItem('knowledge-bridge-session');
    if (saved && sessions.some(s => s.id === saved)) await selectSession(saved);
  } catch (error) { toast(error.message); $('mode-tag').textContent = '连接未完成'; }
}
boot();

function previewImage(url, name) {
  $('image-full').src = url; $('image-dialog-title').textContent = name;
  if (!$('image-dialog').open) $('image-dialog').showModal();
}
function renderImageTray() {
  const tray = $('image-tray'); tray.replaceChildren(); tray.hidden = !pendingImages.length;
  if (!pendingImages.length) return;
  const heading = node('div', 'image-tray-heading', '待发送 · ' + pendingImages.length + ' 张图片');
  heading.append(node('small', '', '每张 ≤ 4 MB · 每个会话最多 6 张')); tray.append(heading);
  const grid = node('div', 'pending-images');
  pendingImages.forEach((image, index) => {
    const card = node('div', 'pending-image');
    const preview = node('button', 'pending-preview'); preview.type = 'button';
    preview.setAttribute('aria-label', '预览：' + image.name);
    const thumbnail = node('img'); thumbnail.src = image.dataUrl; thumbnail.alt = image.name;
    preview.append(thumbnail); preview.addEventListener('click', () => previewImage(image.dataUrl, image.name));
    const remove = node('button', 'remove-image', '×'); remove.type = 'button'; remove.setAttribute('aria-label', '移除：' + image.name);
    remove.addEventListener('click', () => { pendingImages.splice(index, 1); renderImageTray(); updateControls(); });
    card.append(preview, node('span', 'image-name', image.name), remove); grid.append(card);
  });
  tray.append(grid);
}
async function addImageFiles(files) {
  if (sending || loadingImages || current?.run?.status === 'running') return toast('请等待当前操作完成后再添加图片。');
  const list = Array.from(files);
  if (!list.length) return;
  const existing = current?.images || [];
  if (existing.length + pendingImages.length + list.length > 6) return toast('每个会话最多 6 张图片，请移除多余图片或新建学习会话。');
  loadingImages = true; updateControls();
  const token = selection;
  try {
    const additions = [];
    for (const file of list) {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('只支持 PNG、JPEG、WebP、GIF 图片。');
      if (!file.size || file.size > 4 * 1024 * 1024) throw new Error('每张图片不能超过 4 MB。');
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图片读取失败，请重新选择。'));
        reader.readAsDataURL(file);
      });
      await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => image.naturalWidth > 8192 || image.naturalHeight > 8192
          ? reject(new Error('图片长或宽不能超过 8192 像素，请裁剪后再导入。')) : resolve();
        image.onerror = () => reject(new Error('图片无法解码，请重新导出图片。')); image.src = dataUrl;
      });
      additions.push({ name: file.name || '粘贴截图.png', size: file.size, dataUrl });
    }
    if (token !== selection) return;
    if ([...existing, ...pendingImages, ...additions].reduce((sum, image) => sum + image.size, 0) > 12 * 1024 * 1024) throw new Error('一个会话的图片总大小不能超过 12 MB。');
    pendingImages.push(...additions); renderImageTray();
    if (config?.mode === 'demo') toast('图片可以保存；演示模式不会识别图片内容。');
    $('message-input').focus();
  } catch (error) { if (token === selection) toast(error.message); }
  finally { loadingImages = false; updateControls(); }
}
$('image-button').addEventListener('click', () => $('image-input').click());
$('image-input').addEventListener('change', async () => { await addImageFiles($('image-input').files); $('image-input').value = ''; });
$('message-input').addEventListener('paste', event => {
  const files = Array.from(event.clipboardData?.items || []).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
  if (files.length) {
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    if (text) { const input = $('message-input'); input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end'); }
    addImageFiles(files);
  }
});
$('close-image').addEventListener('click', () => $('image-dialog').close());
$('image-dialog').addEventListener('close', () => $('image-full').removeAttribute('src'));
