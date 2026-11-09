# 知桥 · Knowledge Bridge

一个可运行的本地学习智能体项目。用户提供正在学习的话题、当前认识和困惑；主智能体先判断“当前理解 → 缺失的中间连接 → 目标理解”，再针对这一连接引导学习和验证。模型知识用于定位与补齐连接，不默认展开整个主题。材料只是话题入口，搜索仅作可选补充。

## 快速启动

后端要求 Python 3.11 或更新版本（本机使用 Python 3.12.4 验证）。只使用 Python 标准库，无需安装第三方依赖。浏览器前端仍使用 JavaScript。

```powershell
git clone https://github.com/doczhangyh/knowledge-bridge.git
cd knowledge-bridge
python -m server
```

打开 http://127.0.0.1:3210 。如果 `python` 不在 PATH 中，可使用 `py -3 -m server`。启动前先关闭占用该端口的旧服务；修改后端代码或配置后需要重启。

安装了 Node.js 的环境也可继续使用 `npm.cmd start`，该命令现在启动 Python 后端。运行应用本身不需要 Node.js；可选的浏览器自动化检查仍使用 Node.js 22.13+ 和 Chrome。

没有密钥时自动进入 **本地演示模式**。演示只覆盖普通函数返回 → 递归返回的固定教学路径；不调用模型或实时搜索，不代表系统能自动诊断任意主题。

体验演示：

1. 点“递归为什么能返回？”并发送。
2. 回答普通函数问题，例如：输出 6，add_one 返回 3 并赋给 y，随后乘 2。
3. 在递归变式中自己追踪各层返回值。
4. 观察右侧的证据记录；也可先点击提示，体验“帮助下完成”与“当次独立完成”的区别。
5. 刷新或重启服务后可从左侧历史记录继续。

## 接入真实模型与搜索

```powershell
Copy-Item .env.example .env
```

用编辑器填写 .env：

```dotenv
APP_MODE=live
PORT=3210
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=你的密钥
LLM_MODEL=你有权限使用的模型名称
LLM_JSON_MODE=json_object
TAVILY_API_KEY=你的搜索密钥
```

重启服务，然后 **新建会话**。旧演示会话不会被混入真实模式。

- 支持 Chat Completions 兼容服务；修改 LLM_BASE_URL 和 LLM_MODEL 即可切换。基础 URL 应包括服务要求的 /v1，项目在后面追加 /chat/completions。
- 模型必须支持 JSON 输出。默认 json_object，兼容性较广；支持严格结构化输出的服务可设置 json_schema。两种模式均有本地结构校验，最多重试一次格式错误。
- 不默认指定模型，避免误选账户无权限的型号或产生不明确成本。
- 模型密钥也可使用环境变量 OPENAI_API_KEY。系统环境变量优先于 .env。
- Tavily 可选；未配置时直接使用模型已有知识辅导，不要求用户提供完整材料。配置后仅在必要时补充外部资料，搜索失败会在运行记录中说明。
- 每轮最多两次搜索，每个查询最多四条结果，去重后取最多六条摘要。搜索摘录不是全文，也不是事实正确性的保证。
- .env、data、日志和测试产物已加入 .gitignore。密钥不会发送给浏览器。
- 一次真实回合通常包含计划、辅导两次模型调用；有待评估问题时另加一次评分调用。实际费用由你配置的供应商决定。

迁移前的 Node.js 版本曾使用本地配置的 DeepSeek Flash 完成真实文本与图片调用测试。Python 版本通过本地模拟供应商验证文本、视觉消息、结构化输出及 HTTP 协议，本次迁移没有调用真实付费模型或搜索服务；这些工程测试不代表已验证教学效果。

## 已实现功能

- 中文响应式学习界面，支持桌面与窄屏。
- 自由提问、粘贴材料、导入 UTF-8 TXT / Markdown / Python / JS / TS / JSON 文本。
- 导入或粘贴 PNG / JPEG / WebP / GIF 图片，支持多选、缩略图、放大预览和发送前移除；可只发图片，也可在现有会话中补图。
- 主智能体：提出候选缺口，规划必要查询，接收搜索结果，生成讲解和一题检查。
- 搜索智能体：独立模块执行 Tavily 查询、去重、过滤 URL、返回带来源的数据包。
- 评分器：按上一题 rubric 评估本轮回答，引用用户原话作为证据。
- 学习状态：假设、需要补足、观察到理解、帮助下完成、当次独立完成、需要复查。
- 问题提示、换例子、回到原问题的快捷操作。
- 实际任务阶段展示，非模型隐藏推理过程。
- 本地会话持久化、继续学习、失败重试、JSON 导出。
- 网络超时、模型拒绝/非法 JSON、搜索失败的处理。
- 服务重启中断检测，同会话运行互斥；失败不重复写入用户消息。
- 模型响应只作为文本和有限 Markdown 渲染，不执行 HTML；参考链接只接受 HTTP(S)。

## 项目结构

```text
public/
  index.html             页面结构
  style.css              响应式视觉样式
  app.js                 对话、材料、轮询、进度、导出
server/
  __main__.py            启动入口（python -m server）
  app.py                 HTTP API 与静态资源
  config.py              环境配置
  common.py              时间、标识与公开错误
  providers.py           模型 HTTP 客户端、超时、输出校验
  schema.py              模型输出契约
  images.py              图片校验与元数据
  engine.py              主流程编排、后台线程池与结果提交
  learning_state.py      证据与学习状态规则
  store.py               会话存储、线程锁与原子写入
  agents/
    main_agent.py        主智能体与评分器提示词、上下文组装
    search_agent.py      搜索执行模块
    demo.py              明确标注的本地演示逻辑
    demo_content.json    原有演示文案与题目
tests/test_backend.py    Python 自动化测试
legacy/                  保留的旧 Node.js 后端和测试
pyproject.toml           Python 版本与项目信息
docs/design.md           设计说明、API 和后续方向
```

前后端逻辑分离，同一个 Python 进程提供静态前端和 API，无需处理跨域与双服务启动。前端采用原生浏览器 JavaScript；后端使用 `ThreadingHTTPServer` 接收请求，`ThreadPoolExecutor` 执行学习任务，`urllib.request` 调用模型与搜索。不依赖前端构建工具或 Agent 框架。

现有 `.env` 配置名、HTTP 路径、JSON 字段和 `data/` 会话格式保持兼容，迁移无需转换历史记录。旧实现保存在 `legacy/`，不参与当前运行。

## 验证

```powershell
python -m compileall -q server tests
python -m unittest discover -s tests -p "test_*.py" -v
```

测试涵盖完整演示路径、提示与独立验证区分、伪造证据过滤、重复题保护、失败回滚、重启恢复、并发上限、搜索降级、供应商输出结构、图片与 HTTP 接口。测试使用临时数据目录和模拟供应商，不读取真实密钥、不产生付费调用。安装 Node.js 后也可使用 `npm.cmd test` 和 `npm.cmd run check`；后者额外检查前端 JS 语法。

## 使用范围

这是 **本机单用户开发初版**，只监听 127.0.0.1，尚未实现账户和多人权限隔离。会话保存在 data/ 下的 JSON 文件，含原始材料与聊天记录。

真实模式会将学习材料、必要的最近对话和学习状态发给配置的模型服务；搜索只发主智能体生成的主题查询。

- 图片直接通过模型的视觉接口分析，不单独运行 OCR；当前配置的 DeepSeek Flash 支持视觉。更换模型时需确认支持 image_url 输入。
- 每个会话最多 6 张图片，每张最多 4 MB，总大小最多 12 MB；前端限制长宽不超过 8192 像素。图片和会话一起保存在本机，并随相关的诊断、讲解请求发送给模型。
- 上传图片按补充学习材料处理，不自动作为上一题的答题证据；需要记录独立验证时请用文字作答。
- 当前不支持 PDF、语音或视频。
- 不执行上传的代码。
- 没有知识追踪模型训练，也不输出未经校准的掌握概率。
- 独立完成只表示当前题目的证据，不代表长期掌握；延后复测和自动提醒尚未实现。
- 模型诊断与评分仍可能出错；独立评分调用也不等于独立模型验证。
- 来源记录可追溯，但摘要质量和模型引用是否真正支持结论仍需人工抽查。
- 暂不支持多服务进程共享 JSON 存储。正式部署前应迁移数据库、鉴权和任务队列。
- 上传一小段与当前困惑直接相关的材料，效果比一次塞入整章更可控。材料限制 30,000 字，问题限制 6,000 字。

接口实现参考：[OpenAI 结构化输出](https://developers.openai.com/api/docs/guides/structured-outputs)、[Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)。

### 可选浏览器检查

`npm.cmd run test:ui` 会启动独立的 Python 演示服务和无界面 Chrome，验证桌面布局、完整作答流程、图片上传、刷新恢复、手机布局与设置面板。不会使用你的常用浏览器用户资料。可通过 `PYTHON` 环境变量指定 Python 可执行文件路径。

默认使用 Windows 标准 Chrome 安装路径，可用 CHROME_PATH 指定其它 Chromium 浏览器。本机受限测试环境需要设置 UI_NO_SANDBOX=1；该选项只用于隔离的本地测试进程，不用于日常浏览。普通环境先使用默认设置。

截图保存在 test-results/desktop.png、learning.png 和 mobile.png。test-results/ 仅包含可再生成的测试产物，已被 Git 忽略。

## 开源许可

本项目采用 [MIT License](LICENSE)。
