import { loadConfig } from './config.js';
import { createApp } from './app.js';
try {
  const config = loadConfig();
  const { server } = await createApp(config);
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? '端口已被占用。请修改 .env 中的 PORT，或关闭旧服务。' : '启动失败：' + error.message);
    process.exitCode = 1;
  });
  server.listen(config.port, '127.0.0.1', () => {
    console.log('\n  知桥 · Knowledge Bridge\n  http://127.0.0.1:' + config.port + '\n  模式：' + (config.mode === 'demo' ? '本地演示（未调用真实模型）' : '真实模型') + '\n');
  });
} catch (error) { console.error(error.message); process.exitCode = 1; }
