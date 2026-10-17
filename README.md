# 🍽️ 吃什么插件（chi-plugin）

TRSS-Yunzai 随机菜谱插件，兼容 QQBot / OneBotv11 等适配器。内置 **370 道菜谱、10 个分类、370 张成菜图**，运行期零联网；菜谱内容取自 [HowToCook](https://github.com/Anduin2017/HowToCook)。

## ✨ 功能

- 随机推荐一道菜：成菜图 + 分类 + 一句话简介
- 按分类随机、按菜名精确/模糊查询
- 做法长图：食材、步骤、小贴士渲染成一张图
- B 站视频搜索（QQBot 为链接按钮，其他适配器为纯文本链接）
- QQBot 按钮交互；非 QQBot 适配器自动降级为文字指令提示
- 管理员：官网同步（预演/写入）、清理不符合菜、手动补图

## 📦 安装

```bash
cd Yunzai
git clone https://github.com/shiomon/chi-plugin.git plugins/chi-plugin
```

安装后在 `config/config/bot.yaml` 的 `plugins` 中确认插件已启用，重启 Yunzai 即可。

**无第三方 npm 依赖**：只使用 Yunzai 自带的 `lib/plugins/plugin.js`、`lib/puppeteer/puppeteer.js` 与 Node 内置模块。

## 📋 指令

主指令为「吃什么」或「今天吃什么」，支持 `#` / `/` 前缀。

| 指令 | 说明 |
| --- | --- |
| `吃什么` | 随机推荐一道菜 |
| `吃什么 分类` | 查看分类列表（QQBot 附分类按钮） |
| `吃什么 <分类名>` | 按分类随机，如「吃什么 肉菜」 |
| `吃什么 <菜名>` | 查看指定菜，如「吃什么 宫保鸡丁」 |
| `吃什么 做法 <菜名>` | 渲染该菜的做法长图 |
| `吃什么 视频 <菜名>` | 返回该菜的 B 站搜索链接 |
| `吃什么 帮助` | 帮助卡片（`help` / `说明` / `?` 同效） |

### 管理员指令（仅主人）

| 指令 | 说明 |
| --- | --- |
| `吃什么 同步` | 从 HowToCook 官网预演同步，只拉取校验、**不写入** |
| `吃什么 同步 写入` | 同步并写入，自动备份 `data/dishes.json.bak` 后重建索引与单菜文件 |
| `吃什么 清理` | 删除缺图 / 缺简介 / 缺做法的菜（同样先备份） |
| `[图片] 吃什么 补图 <菜名>` | 用附带图片补齐该菜成菜图 |

同步校验规则：图、简介、做法三项齐全才收录；不符合的菜会被跳过并在报告中列出。

## 🔘 按钮

- **出菜后**：`吃什么` ｜ `做法` ｜ `分类`
- **做法图后**：`吃什么` ｜ `视频`（跳转 B 站搜索）｜ `分类`
- **分类列表**：前两行各 4 个分类，最后一行「吃什么」+ 剩余分类

按钮仅 QQBot 适配器可见；其他适配器改为在消息末尾附带可用指令提示。

## ⚙️ 可配置项

集中在 `index.js` 顶部：

| 常量 | 默认值 | 说明 |
| --- | --- | --- |
| `AUTO_SYNC` | `false` | 运行期是否自动联网同步菜图；默认关闭，联网同步改走「吃什么 同步」 |
| `SYNC_START_DELAY` | `5000` | 开启自动同步后，插件加载多久开始同步（毫秒） |
| `MAX_TEXT` | `1600` | 单条文本上限，超出截断 |
| `DESC_MAX` | `120` | 简介无句号时的兜底截断长度 |
| `OPENERS` | 6 个词 | 随机开场词 |
| `CMD_REG` | 「吃什么 / 今天吃什么」 | 主指令正则 |

## 🗂️ 项目结构

```
chi-plugin/
├── index.js              # 插件入口：指令分发、出菜/做法/视频/帮助、管理员操作
├── model/
│   ├── parse.js          # HowToCook markdown 解析、分类别名
│   ├── sync.js           # 菜图本地同步（jsDelivr → GitHub raw 兜底）
│   ├── update.js         # 官网同步：拉取、校验、写入、备份
│   └── util.js           # JSON 读写、文件名归一、下载重试等
├── view/
│   └── recipe.js         # 做法长图 / 帮助图 HTML 生成（内联 emoji 字体）
├── resources/
│   ├── recipe.html       # 渲染模板
│   ├── image/            # 370 张成菜图（约 79MB）
│   ├── fonts/            # NotoColorEmoji（本地 emoji 字体，零外网依赖）
│   └── synced.json       # 已同步图片索引
└── data/
    ├── dishes.json       # 全量菜谱（含食材、步骤、小贴士）
    ├── dishes/           # 按菜拆分的单菜 JSON（370 个）
    ├── index.json        # 轻量索引（列表/随机用）
    ├── images.json       # 菜图清单（required 必须图 / optional 过程图）
    ├── xcf_map.json      # 上游文件映射
    └── 恢复说明.txt       # 数据恢复步骤
```

## 🔄 数据来源与同步

- 上游：[Anduin2017/HowToCook](https://github.com/Anduin2017/HowToCook)（MIT）
- 镜像顺序：`cdn.jsdelivr.net` → `raw.githubusercontent.com`
- 同步默认 **dry-run**：只拉取、对比、校验，不改任何文件；确认无误后加「写入」才落盘
- 写入前备份 `data/dishes.json.bak`，随后重建 `data/index.json` 与 `data/dishes/`
- 图片按 `data/images.json` 清单落盘到 `resources/image`，缺失图不影响文字推荐（消息中会提示管理员补齐）
- 数据恢复步骤见 `data/恢复说明.txt`

## ⚠️ 注意事项

- 做法长图与帮助图依赖 Yunzai 的 puppeteer 截图；渲染失败时帮助会自动降级为纯文本，做法图会提示稍后重试
- 菜图为本地文件，首次部署请确保 `resources/image` 完整（约 79MB）
- `data/` 属插件内容（非用户数据），随仓库分发

## 📄 许可

菜谱文字与图片版权归 HowToCook 项目及其贡献者（MIT）；插件代码许可见仓库 LICENSE（如有）。