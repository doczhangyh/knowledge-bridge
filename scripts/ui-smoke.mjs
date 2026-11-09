// Optional browser smoke test. Uses an isolated, headless installed Chrome instance.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'test-results');
await mkdir(output, { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() { const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function until(fn, timeout = 20000) { const end = Date.now() + timeout; let last; while (Date.now() < end) { try { const result = await fn(); if (result) return result; } catch (e) { last = e; } await delay(200); } throw last || new Error('Browser condition timed out'); }
const port = await freePort(), debugPort = await freePort();
const server = spawn(process.env.PYTHON || 'python', ['-m', 'server'], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, PORT: String(port), APP_MODE: 'demo', DATA_DIR: 'test-results/ui-data-' + Date.now() } });
const browserPath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
let browser, socket;
const errors = [];
server.on('error', error => errors.push('Python server: ' + error.message));
try {
  await until(async () => (await fetch('http://127.0.0.1:' + port + '/api/config')).ok);
  browser = spawn(browserPath, ['--headless=new', '--disable-gpu', ...(process.env.UI_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + path.join(output, 'chrome-profile-' + Date.now()), 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  browser.on('error', error => errors.push(error.message));
  const target = await until(async () => {
    const targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json();
    return targets.find(t => t.type === 'page');
  });
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let seq = 0; const requests = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.id && requests.has(message.id)) { const item = requests.get(message.id); clearTimeout(item.timer); requests.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; const timer = setTimeout(() => { requests.delete(id); reject(new Error('CDP timeout: ' + method)); }, 30000);
    requests.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  console.log('Browser target connected'); await call('Page.enable'); await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: 'http://127.0.0.1:' + port });
  await until(() => evaluate("document.getElementById('mode-tag')?.textContent.includes('演示环境')"));
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true); assert.equal(await evaluate('document.querySelector(".composer-foot").getBoundingClientRect().bottom <= innerHeight + 1'), true, 'Composer must remain visible');
  await writeFile(path.join(output, 'desktop.png'), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  console.log('PASS desktop welcome and no horizontal overflow');
  await evaluate("document.querySelector('[data-starter=recursion]').click(); document.getElementById('message-form').requestSubmit()");
  await until(() => evaluate("document.querySelectorAll('.message.assistant').length === 1 && !document.getElementById('run-indicator').hidden === false"));
  assert.equal(await evaluate("document.querySelectorAll('.gap').length"), 2);
  await evaluate("document.getElementById('message-input').value='输出 6，返回 3 赋值给 y，随后乘 2'; document.getElementById('message-form').requestSubmit()");
  await until(() => evaluate("document.querySelectorAll('.message.assistant').length === 2"));
  assert.equal(await evaluate("document.getElementById('messages').textContent.includes('f(2)')"), true);
  await evaluate("document.getElementById('message-input').value='f(0)=1，f(1)=3，f(2)=5'; document.getElementById('message-form').requestSubmit()");
  await until(() => evaluate("document.querySelectorAll('.gap.independent').length === 1"));
  assert.equal(await evaluate("document.querySelectorAll('.evidence').length"), 2);
  await evaluate('document.getElementById("scroll-area").scrollTo({ top: document.getElementById("scroll-area").scrollHeight, behavior: "instant" })'); await writeFile(path.join(output, 'learning.png'), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  console.log('PASS browser diagnosis, answering and independent evidence');
  await call('Page.reload');
  await until(() => evaluate("document.querySelectorAll('.gap.independent').length === 1"));
  console.log('PASS browser reload restores session');
  // Image fixture contains values not mentioned in the live-test question.
  const fixture = await evaluate(`(() => {
    const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 330;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,900,330);
    ctx.fillStyle = '#153629'; ctx.font = '30px monospace';
    ['def add_seven(n):', '    return n + 7', '', 'print(add_seven(5))'].forEach((line, i) => ctx.fillText(line, 40, 70 + i * 60));
    return canvas.toDataURL('image/png');
  })()`);
  const fixturePath = path.join(output, 'vision-fixture.png');
  await writeFile(fixturePath, Buffer.from(fixture.split(',')[1], 'base64'));
  await evaluate("document.getElementById('new-session').click()");
  await call('DOM.enable');
  let doc = await call('DOM.getDocument');
  let picker = await call('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#image-input' });
  await call('DOM.setFileInputFiles', { nodeId: picker.nodeId, files: [fixturePath] });
  await until(() => evaluate("document.querySelectorAll('.pending-image').length === 1 && !document.getElementById('send-button').disabled"));
  await evaluate("document.querySelector('.pending-preview').click()");
  assert.equal(await evaluate("document.getElementById('image-dialog').open && document.getElementById('image-full').naturalWidth > 0"), true);
  await evaluate("document.getElementById('close-image').click(); document.querySelector('.remove-image').click()");
  assert.equal(await evaluate("document.getElementById('image-tray').hidden"), true);
  // Exercise the same paste event used by the textarea without accessing the system clipboard.
  await evaluate(`(async () => {
    const raw = atob(${JSON.stringify(fixture)}.split(',')[1]);
    const blob = new Blob([Uint8Array.from(raw, ch => ch.charCodeAt(0))], {type:'image/png'});
    const data = new DataTransfer(); data.items.add(new File([blob], '粘贴截图.png', {type:'image/png'}));
    document.getElementById('message-input').dispatchEvent(new ClipboardEvent('paste', {clipboardData:data, bubbles:true, cancelable:true}));
  })()`);
  await until(() => evaluate("document.querySelectorAll('.pending-image').length === 1 && !document.getElementById('send-button').disabled"));
  await writeFile(path.join(output, 'image-import.png'), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await evaluate("document.getElementById('message-form').requestSubmit()");
  await until(() => evaluate("document.querySelectorAll('.message.assistant').length === 1 && document.querySelector('.message-image')?.naturalWidth > 0"));
  assert.equal(await evaluate("document.getElementById('image-tray').hidden"), true);
  await call('Page.reload');
  await until(() => evaluate("document.querySelector('.message-image')?.naturalWidth > 0"));
  // Add another image to an existing conversation.
  doc = await call('DOM.getDocument');
  picker = await call('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#image-input' });
  await call('DOM.setFileInputFiles', { nodeId: picker.nodeId, files: [fixturePath] });
  await until(() => evaluate("document.querySelectorAll('.pending-image').length === 1 && !document.getElementById('send-button').disabled"));
  await evaluate("document.getElementById('message-form').requestSubmit()");
  await until(() => evaluate("document.querySelectorAll('.message.assistant').length === 2 && document.querySelectorAll('.message-image').length === 2"));
  console.log('PASS image selection, preview, removal, paste, image-only send, reload and follow-up upload');

  await evaluate("document.getElementById('settings-button').click()");
  assert.equal(await evaluate("document.getElementById('settings-dialog').open"), true);
  await evaluate("document.getElementById('settings-done').click(); document.getElementById('new-session').click()");
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true); assert.equal(await evaluate('document.querySelector(".composer-foot").getBoundingClientRect().bottom <= innerHeight + 1'), true, 'Composer must remain visible');
  await writeFile(path.join(output, 'mobile.png'), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await evaluate("document.getElementById('progress-toggle').click()");
  assert.equal(await evaluate("getComputedStyle(document.getElementById('insight-panel')).display !== 'none'"), true);
  console.log('PASS mobile layout, progress drawer and settings');
  assert.deepEqual(errors, [], 'Browser runtime errors');
  console.log('PASS no browser runtime exceptions');
} finally {
  if (socket) socket.close();
  if (browser) browser.kill();
  server.kill();
}
