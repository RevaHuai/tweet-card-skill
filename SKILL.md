---
name: perfect-tweet
description: X/Twitter 推文卡片批量生成器。当用户想把推文做成精美分享卡片、批量生成推文图片、导出 X 截图风格的 PNG 时使用。用户只需在网页上设置一次模板并导入，之后粘贴任意多条推文链接即可一键批量导出高清卡片。触发词：推文卡片、推特卡片、tweet card、生成推文图片、批量出卡片。
---

# perfect-tweet — X 推文卡片批量生成器

把任意 X（Twitter）推文渲染成 X 官方详情页风格的高清分享卡片。视觉一比一复刻 X 网页版（Chirp 字体回退链、官方色彩 tokens、lucide 图标、蓝色认证标）。**在网页上设置一次模板并导入，之后所有生成全自动。**

## 依赖与安装

- Node.js ≥ 18
- 首次使用前在**本 Skill 的安装目录**执行（Puppeteer 会自动下载 Chromium，约 1~2 分钟）：

```bash
cd <skill 安装目录> && npm install
```

> `puppeteer` 用于卡片渲染；Chromium 启动失败时自动探测系统 Chrome（macOS / Linux / Windows 均支持）。

## 首次设置：网页配置模板（主流程）

模板在网页可视化工具里调，导出 JSON 后一条命令导入本地：

1. 提示用户打开 **https://perfect-tweet-a6pm.vercel.app/**
2. 用户在网页上调整主题、尺寸、字号、背景图等，实时预览
3. 满意后点右上角的导出按钮（↓ 图标，悬停提示「导出模板 JSON」），下载得到一个 JSON 文件
4. 导入模板（持久保存，重启不丢）：

```bash
perfect-tweet template import <下载的文件.json>
```

5. 跑一次 `preview` 生成示例卡片，用 markdown 图片语法展示给用户确认；不满意就回网页调整再导一次
6. 确认后进入日常使用：用户给链接 → `generate` 批量出图

> 若 `config.json` 不存在（全新安装），CLI 在无参数运行或 `help` 时也会打印这条引导。
>
> 模板持久化在 `~/.newmax/skills/perfect-tweet/config.json`（Agent skills 标准安装位置，与当前工作目录无关）；设置环境变量 `PERFECT_TWEET_CONFIG=/path/to/config.json` 可改用自定义路径（多 Agent 实例共享配置时用）。

**备选（用户不想用网页时）**：直接命令行配置——`perfect-tweet config theme=white dimension=16:9`，再 `preview` 确认，逐项微调。

## 命令

所有命令在 Skill 安装目录下运行（`node bin/perfect-tweet.js <cmd>` 或 npm link 后直接 `perfect-tweet <cmd>`）。

### `template` — 模板导入 / 导出

```bash
perfect-tweet template import <文件.json>   # 从网页导出的 JSON 导入模板（持久化）
perfect-tweet template export <文件.json>   # 导出当前模板为 JSON（备份/分享/回传网页）
```

### `config` — 命令行查看 / 修改模板

```bash
perfect-tweet config                        # 查看当前模板
perfect-tweet config theme=white dimension=square fontScale=120   # 一次改多项
perfect-tweet config bgImage=~/Pictures/bg.jpg cardOpacity=85
perfect-tweet config --reset                # 恢复默认
```

### `preview` — 用示例推文预览当前模板

```bash
perfect-tweet preview                       # 输出示例卡片（--out 可指定路径）
```

### `generate` — 批量生成卡片（核心命令）

```bash
perfect-tweet generate <链接1> <链接2> ...           # 多条链接
perfect-tweet generate "$(pbpaste)"                  # 直接处理剪贴板里的整段多链接文本
perfect-tweet generate <链接> --viral                # 随机爆款互动数据
perfect-tweet generate <链接> --set likes=999,views=88000   # 指定互动数据
perfect-tweet generate <链接> --dim 2:3 --out ~/Desktop    # 临时换尺寸/输出目录
```

默认输出到 `~/Downloads/tweet-cards/`，文件名 `tweet-{handle}-{序号}.png`，3 倍高清导出。

## 模板配置字段

| 字段 | 取值 | 默认 | 说明 |
|---|---|---|---|
| theme | black / white | black | 主题（联动卡片/文字色） |
| cardColor / textColor | #RRGGBB | 跟随主题 | 自定义颜色 |
| dimension | instagram / square / 16:9 / 3:4 / 4:3 / 2:3 | instagram | 尺寸预设（9:16 ins、1:1、公众号、图文、抖音） |
| fontScale | 60~160 | 100 | 字号系数（文字/头像/图标统一缩放） |
| contentScale | 50~150 | 100 | 内容整体缩放（非背景图模式） |
| contentWidth | 30~100 | 85 | 内容宽度 % |
| showDate / showViews / showTranslate / showStats | true/false | true/true/false/true | 元素开关 |
| bgImage | 本地路径 / URL / null | null | 背景图模式（卡片变为浮层） |
| cardOpacity | 10~100 | 100 | 卡片透明度 % |
| cardOffsetX / cardOffsetY | 数字(px) | 0 | 背景图模式下浮层偏移 |
| outputDir | 路径 | ~/Downloads/tweet-cards | 输出目录 |
| scale | 1~5 | 3 | 导出倍率 |
| timeZone | IANA 时区 | Asia/Shanghai | 推文时间显示时区 |

## Agent 标准工作流

1. **首次设置**：检测到全新安装（无 config.json）时，引导用户打开 https://perfect-tweet-a6pm.vercel.app/ 配置并导出模板 JSON，然后 `template import` 导入，`preview` 出图给用户确认。
   - 用户不想用网页：问风格偏好（暗/亮、用途平台 → 推荐尺寸：Instagram 9:16 / 公众号 16:9 / 抖音 2:3），逐项 `config` 写入，`preview` 确认微调。
   - 用户想换模板：重复网页导出 → `template import` 即可覆盖。
2. **日常生成**：用户给出一条或多条推文链接（常常直接粘贴一段文字）→ 直接 `generate` → 把生成的 PNG 用 markdown 图片语法内联展示给用户。
3. **数据修饰**：用户想「数据好看点」→ `--viral`；想精确指定 → `--set likes=N,retweets=N`。
4. **失败处理**：单条链接抓取失败不影响其他；提示用户检查链接是否为公开推文（fxtwitter 拿不到私密/删帖）。

## 增强（可选）

配置环境变量 `X_API_BEARER_TOKEN` 后优先走 X 官方 API v2（字段更全、更权威），失败自动回退 fxtwitter 公开 API（默认，无需任何凭证）。

## 实现结构

```
bin/perfect-tweet.js   # CLI 入口（config / template / generate / preview）
lib/render.js          # HTML 生成器（一比一复刻 X 详情页排版）
lib/config.js          # 模板读写 + 校验（config.json）
lib/fetch.js           # fxtwitter 抓取（+可选官方 API）
lib/screenshot.js      # Puppeteer headless 高清截图 + Chrome 回退链
assets/verified.png    # X 蓝色认证标
```
