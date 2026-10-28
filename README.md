# ChatDrop · 局域网聊天式互传

一个跑在自己电脑上的「聊天软件」——**文字、图片、文件**都以聊天气泡的形式发送，
同一 WiFi 下的手机、平板、电脑打开网页就能互相收发。

灵感来自 [LocalSend](https://github.com/localsend/localsend)，但把「文字也是文件」这个别扭的设计改掉了：
**文字就是文字**，直接显示在气泡里，可复制、可搜索、不落地成文件。

| | |
|---|---|
| **零依赖** | 只用 Node 内置模块，不需要 `npm install` |
| **零配置** | 双击一个 bat 就能用，手机浏览器扫码/输网址即连 |
| **补上 LocalSend 缺的** | 多任务并发、暂停/继续、断点续传、秒传 |
| **开源许可** | [MIT](LICENSE) — 可商用、可修改、可闭源分发 |

---

## 特性一览

| 功能 | 说明 |
|---|---|
| 文字消息 | 一等公民，气泡显示，支持多行与 emoji |
| 图片消息 | 内联预览，点击放大看原图 |
| 文件消息 | 卡片显示文件名/大小/类型，点击下载 |
| **多任务并发** | **多个文件同时传，互不阻塞** |
| **暂停/继续** | **随时暂停，保留已传数据，点继续从断点接着传** |
| **断点续传** | **中断后重选同一文件，从断点继续** |
| **秒传** | **相同文件二次上传直接命中** |
| **独立取消** | **取消一个任务不影响其他任务** |
| **sha256 校验** | **传完校验，损坏自动拒绝** |
| 拖拽上传 | 全窗口拖放，多文件自动入队 |
| 粘贴上传 | 截图直接 Ctrl+V |
| 实时同步 | SSE 推送，多端秒级同步 |
| 消息分组 | 同一人连续发言自动合并 |
| 自定义昵称 | 点右上角头像修改 |
| 深色/浅色 | 跟随系统 |
| 离线可用 | Service Worker 缓存外壳 |

---

## 快速开始

### 环境要求

- **Node.js 18 或更高版本**（推荐 LTS），[下载地址](https://nodejs.org/)
- Windows / macOS / Linux 均可运行；本项目自带的两个 `.bat` 是给 Windows 用的

### 1. 启动服务

双击 **`启动ChatDrop.bat`**

会显示类似：

```
  ChatDrop 已启动
  ─────────────────────────────────────────
  本机访问 : http://localhost:8787
  手机访问 : http://192.168.1.23:8787   (WLAN)
  数据目录 : D:\ChatDrop\data
  文件上限 : 4096 MB
  ─────────────────────────────────────────
```

非 Windows 或想手动启动：

```bash
node server.js
```

### 2. 手机连接

1. 手机连**同一个 WiFi**
2. 用 Chrome / Edge 打开上面显示的 **手机访问** 地址
3. 点浏览器菜单 → **「添加到主屏幕」**
4. 桌面出现 ChatDrop 图标，点开即用

### 3. 开始传

- **打字** → 回车发送（手机上是点发送按钮）
- **拖文件** → 直接拖进窗口，松手即传
- **粘贴** → Ctrl+V 粘贴截图或文件
- **选文件** → 点左下角 `+`

### 4. 开机自启（可选）

双击 **`安装开机自启.bat`**，会在 Windows 启动目录生成一个静默启动脚本，
下次登录自动在后台运行（无黑窗口）。卸载：删掉启动目录里的 `ChatDrop.vbs` 即可。

---

## 为什么不是 APK

安卓端用 **PWA**（渐进式 Web 应用）实现：

| | PWA 方案（本项目） | 原生 APK |
|---|---|---|
| 安装 | Chrome 打开 → 添加到主屏幕 | 下载 44MB 安装包 |
| 更新 | 刷新即最新 | 重新下载安装 |
| 权限 | 无需任何权限 | 存储/网络等权限 |
| 开发 | 零构建 | 需 JDK + Android SDK + Gradle |
| 体验 | 独立图标、全屏、无地址栏 | 相同 |

加到主屏幕后，从桌面点开就是全屏 App，看不出和原生的区别。

---

## 多任务与断点续传

这是相比 LocalSend 的改进重点。

### 多任务并发

同时上传多个文件，每个文件是**独立任务**：

```
传输队列                    3 个传输中 · 1 个等待
─────────────────────────────────────────────
报告.pdf      45% · 12.3MB/27.1MB · 890KB/s   取消
照片.zip      82% · 164MB/200MB · 1.2MB/s     取消
视频.mp4      等待中                          取消
```

- 最多 4 个任务并行（`MAX_CONCURRENT` 可配）
- 超出后自动排队，前面完成一个，后面自动补位
- 每个任务独立进度、独立速度、独立取消

### 暂停 / 继续 / 取消

三种操作行为完全不同，按需选择：

| 操作 | 已传数据 | 会话 | 之后能否接着传 |
|---|---|---|---|
| **暂停** | 保留在 `data/parts/` | 保留 | ✅ 点「继续」从断点续传 |
| **取消** | 立即删除 | 移除 | ❌ 需重新开始 |
| **继续** | — | 复用 | ✅ 从暂停点接着传 |

暂停按钮只在上传中出现。暂停后进度条变橙色，显示「已中断 · 已传 X MB」，
点「继续」立即从该位置恢复，不重传已完成的字节。

网络中断时任务会自动变为「已中断」状态，同样可以点「继续」恢复。

### 断点续传

**「上一个没传完不影响下一个」** 是设计核心：

1. 每个文件按 `名称+大小+修改时间` 生成指纹
2. 上传中断（断网、关页面、取消）后，已传数据保留在 `data/parts/`
3. 再次选择**同一个文件**上传，服务端按指纹匹配到旧会话
4. 返回已接收的偏移量，从断点继续，不重传已有部分

```
第一次：传到 45% 断网 → data/parts/<id>.part 保留 45% 数据
第二次：重选同一文件 → 服务端返回 offset=已传字节 → 从 45% 继续
```

### 秒传

如果指纹匹配到**已完成**的文件，直接返回已有消息，0 字节传输。

### 校验

全部数据到齐后，客户端计算 sha256 交给服务端核对。
不匹配则删除数据并返回 `422`，避免存下损坏文件。

### 分片机制

- 默认 4MB 一片（`CHUNK_MB` 可配）
- 每片独立请求，某片失败只重传该片
- 服务端严格校验偏移，错位返回 `409` 和正确的 `expectedOffset`

---

## 借鉴与取舍

ChatDrop 参考了 [LocalSend 协议 v2.2](https://github.com/localsend/protocol) 的设计。

| LocalSend 的做法 | 评价 | ChatDrop 的处理 |
|---|---|---|
| 多文件并行 `upload` 路由 | 精华 | **采用**，并加并发上限与队列 |
| `prepare-upload` 两阶段握手 | 精华 | **采用**，用于断点续传协商 |
| sha256 校验 + `422` | 精华 | **采用**，校验失败即拒绝 |
| sessionId 会话管理 | 精华 | **采用**，每任务独立会话 |
| 文字必须存成 `.txt` 文件 | 糟粕 | **弃用**，文字是独立消息类型 |
| 必须先被「接受」才能传 | 糟粕 | **弃用**，默认自动接收 |
| 单会话阻塞（`409 Blocked`） | 糟粕 | **弃用**，多任务并存 |
| 无断点续传 | 不足 | **补上**，指纹 + 偏移续传 |
| 无暂停/继续 | 不足 | **补上**，暂停保留数据可恢复 |
| 无秒传 | 不足 | **补上**，已完成文件直接命中 |
| 依赖 mDNS 多播发现 | 有网络限制 | 改用网页地址访问 |

> 说明：截至查证，LocalSend 官方仓库中「断点续传」仍是未实现的
> feature request（[#1191](https://github.com/localsend/localsend/issues/1191)、
> [#2127](https://github.com/localsend/localsend/issues/2127)），协议层也在讨论
> （[protocol#31](https://github.com/localsend/protocol/issues/31)）。
> 暂停/继续与秒传同样未见官方实现。

---

## 配置

通过环境变量调整（改 `启动ChatDrop.bat` 或在命令行设置）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（`127.0.0.1` 则仅本机可访问） |
| `MAX_FILE_MB` | `4096` | 单文件上限（MB） |
| `MAX_CONCURRENT` | `4` | 同时上传任务数 |
| `CHUNK_MB` | `4` | 分片大小（MB） |
| `UPLOAD_IDLE_MS` | `600000` | 上传空闲超时（毫秒） |
| `ADMIN_SIDS` | 空 | 管理员设备 ID，逗号分隔，只有管理员能「清空全部」 |

例：换端口到 9000

```bat
set PORT=9000
node server.js
```

### 上限一览

| 项目 | 默认值 | 环境变量 |
|---|---|---|
| 单文件大小 | **4096 MB (4GB)** | `MAX_FILE_MB` |
| 单条文字 | 20000 字符 | — |
| 文字请求体 | 1 MB | — |
| 同时上传任务 | 4 个 | `MAX_CONCURRENT` |
| 分片大小 | 4 MB | `CHUNK_MB` |
| 上传空闲超时 | 10 分钟无数据 | `UPLOAD_IDLE_MS` |
| 消息历史 | 3000 条 | — |

**重要**：Node 默认 `requestTimeout` 是 5 分钟，会切断慢速大文件上传。
ChatDrop 已对上传路由改为「**空闲超时**」——只要还有数据在流动就一直允许，
只有连续 10 分钟没有任何数据才判失败。按 70KB/s 的网速，4GB 文件约需 16 小时，
不会被中途切断。

---

## API

服务端同时提供 REST 接口，方便脚本调用：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/info` | 服务信息与本机地址 |
| GET | `/api/messages` | 历史消息（`?since=<id>` 增量） |
| GET | `/api/events` | SSE 实时流 |
| POST | `/api/text` | 发文字 `{"text":"..."}` |
| POST | `/api/file?name=&mime=&size=` | 上传文件（原始字节流） |
| GET | `/api/file/:id` | 下载/预览（`?dl=1` 强制下载） |
| DELETE | `/api/message/:id` | 删除单条 |
| POST | `/api/clear` | 清空全部 |

发送者身份放在 `X-Chat-Sender` 头里（base64url 编码的 JSON）：

```js
const sender = btoa(unescape(encodeURIComponent(JSON.stringify({
  sid: 'my-device', name: '我的电脑', color: '#3b82f6'
})))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
```

命令行发文字：

```bash
curl -X POST http://localhost:8787/api/text \
  -H "Content-Type: application/json" \
  -d '{"text":"来自命令行的问候"}'
```

---

## 目录结构

```
ChatDrop/
├── server.js                 零依赖 Node 服务（HTTP + SSE + 分片上传）
├── extensions/               扩展目录（每个子目录一个可插拔模块）
│   ├── gomoku/               五子棋扩展（逻辑 / 路由 / 前端 / 面板 / 样式）
│   │   ├── index.js          扩展入口：声明挂载点，注入主服务能力
│   │   ├── routes.js         HTTP 路由（/api/gomoku/*）
│   │   ├── server.js         对局逻辑（工厂模块，注入广播与设备查询）
│   │   ├── client.js         前端对局、观战与悔棋交互
│   │   ├── panel.html        游戏面板片段（运行时注入到聊天左侧）
│   │   └── style.css         五子棋布局与面板样式（需在主 style.css 之后引入）
│   ├── technicalQA/          技术问答扩展（SQLite 存储，数据库在 data/technicalQA.db）
│   │   ├── index.js          扩展入口：挂载 /qa，启动时打印全部问题与回答
│   │   ├── db.js             SQLite 建表与问答读写（Node 内置 node:sqlite）
│   │   ├── routes.js         HTTP 路由（/api/qa/*）
│   │   ├── client.js         左侧问答面板交互（提问、回答、赞踩、分页）
│   │   ├── panel.html        问答面板片段（运行时注入到聊天左侧）
│   │   └── style.css         问答面板样式
│   └── blindDate/           相亲扩展（共享表格，数据库在 data/blindDate.db）
│       ├── index.js          扩展入口：挂载 /blinddate，启动时打印表头与行数
│       ├── db.js             SQLite 建表与读写（表头与数据同表，首行为表头）
│       ├── routes.js         HTTP 路由（/api/blinddate/*）
│       ├── client.js         左侧共享表格交互（自动保存、新增/删除、实时同步）
│       ├── panel.html        相亲面板片段（运行时注入到聊天左侧）
│       └── style.css         相亲面板样式（表头 sticky 固定）
├── public/                   前端静态资源
│   ├── index.html            界面结构
│   ├── style.css             全局样式（深色优先，移动端适配）
│   ├── app.js                前端主逻辑
│   ├── uploader.js           分片上传、暂停/继续、进度
│   ├── pair.js               设备配对与二维码
│   ├── sw.js                 Service Worker
│   ├── manifest.webmanifest  PWA 清单
│   ├── icon-*.png / favicon / apple-touch-icon
│   └── vendor/qrcode-svg.min.js
├── assets/mascot.jpg         吉祥物原图
├── tests/                    测试脚本（21 个 test-*.js）
├── tools/                    开发工具
│   ├── cert-gen.js           自签 HTTPS 证书生成（可选）
│   ├── make_icons.py         图标生成脚本
│   ├── shot-ui.js            界面截图
│   └── check-*.js            接口能力探测
├── data/                     运行时生成（已在 .gitignore 中排除）
│   ├── messages.jsonl        消息记录
│   ├── files/                已完成的文件
│   ├── parts/                未完成分片（断点续传）
│   └── certs/                自签证书与私钥
├── 启动ChatDrop.bat          启动服务
├── 安装开机自启.bat          注册开机静默自启
├── LICENSE                   MIT 开源许可
└── README.md
```

### 测试与调试脚本

`tests/` 下是端到端测试，覆盖多用户、多任务、暂停/继续、断点续传、配对、
二维码、移动端布局等场景；`tools/` 下是接口能力探测、截图与图标生成等开发工具。

启动服务后按需单独运行，例如：

```bash
node server.js                 # 一个终端跑服务
node tests/test-multitask.js   # 另一个终端跑测试
```

部分测试需要通过 CDP 驱动浏览器（`test-*-ui.js`、`test-pair.js` 等），
需先以 `--remote-debugging-port=9333` 启动 Chrome。

> 注意：这些脚本默认连接 `http://localhost:8787`，且会写入 `data/`，属开发调试用途。

---

## 手机搜不到 / 连不上

### 1. 检查 IP 是否同网段

电脑和手机的前三段必须一致（如都是 `192.168.1.x`）。
电脑 IP 在启动日志里，或运行 `ipconfig` 查看。

### 2. 防火墙放行（最常见原因）

以**管理员身份**运行 PowerShell：

```powershell
New-NetFirewallRule -DisplayName "ChatDrop" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow
```

### 3. 网络配置文件要设成「专用」

Windows 默认把新 WiFi 当「公用网络」，会拦截入站连接。

`设置 → 网络和 Internet → WLAN → 你的WiFi → 网络配置文件 → 专用`

或用管理员 PowerShell：

```powershell
Set-NetConnectionProfile -InterfaceAlias "WLAN" -NetworkCategory Private
```

### 4. 路由器开了「AP 隔离」

部分公共 WiFi / 访客网络会禁止设备互访。换成手机热点试试：
电脑连手机热点，然后手机访问电脑在该热点下的 IP。

### 5. 双击 bat 一闪就退出

- 窗口显示「服务已停止」：多半是 **8787 端口已被占用**（可能开机自启的实例正在运行），
  先用浏览器打开 `http://localhost:8787` 确认。
- 提示「未找到 Node.js」：Node 未安装或未加入 PATH，装完重开窗口再试。

---

## 数据与隐私

- 所有数据都在 `data/` 目录，**不上传任何服务器**
- 传输走局域网，不出路由器
- 想清空：界面「⋮ → 清空全部消息」，或直接删 `data/` 目录
- 仓库中已通过 `.gitignore` 排除 `data/`，避免聊天记录与证书私钥被提交

---

## 已知限制

- 同一局域网内**没有身份验证**——同网段任何人都能打开这个页面收发消息。
  在家里/自己热点下没问题；**不要在公共 WiFi 上开**。
- 消息存在单个 `messages.jsonl`，适合个人/小团队，不适合海量历史。
- 没有端到端加密（LocalSend 有 HTTPS + 指纹校验，本项目默认是明文 HTTP）。

---

## 技术要点

- **零第三方依赖**：只用 Node 内置 `http`/`fs`/`crypto`/`os`
- **流式上传**：`req.pipe(writeStream)`，不占内存，4GB 文件也不爆
- **SSE 而非 WebSocket**：单向推送够用，代码量少一个数量级
- **Range 支持**：视频可拖进度条，大文件可断点续传
- **目录穿越防护**：静态文件路径做了 `startsWith` 校验
- **PWA 缓存策略**：外壳缓存优先，`/api/*` 一律走网络不缓存

---

## 许可证

本项目采用 [MIT License](LICENSE) 开源。

你可以自由使用、修改、分发，包括商业用途，只需保留版权声明与许可声明。

---

## 作者

**YellowSarkura**

如果这个项目对你有用，欢迎 Star ⭐
