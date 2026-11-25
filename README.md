# 大一题库

大一学年课程题库的**总入口站点 + 完整构建工具链**。三层结构：大一题库 → 题库集 → 独立题库。

当前规模：**3 个题库集、32 个独立题库、1552 道去重题目**（1631 条题目记录，跨视图副本另计）。

| 题库集 | 独立题库 | 题目记录 | 覆盖 |
|---|---:|---:|---|
| 计算机导论 | 13 | 1243 | 第 1～8 章 + 期中冲刺 + 期末冲刺 + 两个名词解释专题 + 计算专题 |
| 高等数学 | 12 | 138 | 第 1～11 章 + 期中 + 期末 |
| 思想道德与法治 | 7 | 250 | 绪论 + 第 1～6 章 |

页面是**自包含单文件**，无外部依赖、无构建时框架，双击即用，也可以整目录丢到任意静态托管。

## 直接用

```text
index.html                                 总入口
collections/cs/dist/index.html             计算机导论题库集入口
collections/math/dist/index.html           高等数学题库集入口
collections/ethics/dist/index.html         思想道德与法治题库集入口
collections/<集>/dist/banks/<题库>/index.html   单个独立题库
```

不想起服务，双击 `index.html` 即可（localStorage 在 `file://` 下可用；云端同步需要 http）。

## 改题目

题库源是 JSON，改完重新构建：

```bash
python3 tools/qb_build.py status                 # 看层级与题量
python3 tools/qb_build.py build                  # 构建全部题库集 + 根入口 + 部署包
python3 tools/qb_build.py build --collection math # 只建一个
python3 tools/qb_build.py check                  # 只跑校验门
```

构建器会顺带跑校验门（`tools/qb_gate.py`）：硬失败不为 0 就不算通过。

## 验证

```bash
python3 tools/parity_test.py cs      # 浏览器内核 ↔ 校验门：gid 与导出码逐字节比对
python3 tools/parity_test.py math
node tools/smoke_test.js  collections/math/dist/banks/midterm/index.html   # 错题状态机 / 往返 / 重放
node tools/ui_smoke.js    collections/math/dist/banks/midterm/index.html   # 页面初始化
node tools/judge_all.js   collections/cs/dist/banks/*/index.html           # 逐题判分：对的判对、错的判错
python3 tools/rebalance_options.py collections/cs/subjects/cs/bank/u5.json # 选项位置摊平（幂等）
```

## 目录

```text
大一题库/
├── catalog.json                 挂载表：有哪些题库集
├── index.html                   总入口（构建产物）
├── 结构说明.md                   层级组织、命名与元数据、扩展步骤
├── 部署与兼容.md                 线上环境、云端 API 契约、部署与回滚
├── packages/qb-core/            共享内核：指纹、判分、错题状态机、掌握度、编码、页面渲染
├── tools/                       构建、校验、迁移、测试
└── collections/
    ├── cs/                      计算机导论
    │   ├── collection.config.json  site.config.json  sync.config.json
    │   ├── subjects/cs/bank/*.json   题目源
    │   └── dist/                     构建产物
    ├── math/                    高等数学（sources/ 下是试卷源 JSON）
    └── ethics/                  思想道德与法治
```

三层怎么设计的、新增题库要改哪些文件，见 [结构说明.md](结构说明.md)。

## 云端同步

同步是**可选的、手动的**：填一段 12 位同步码，点「上传」或「下载」，两个方向都是并集式合并，不会清空任何一端。不注册、不埋点、无账号体系，页面加载时也不发任何网络请求。

仓库里的构建产物是**用占位符构建的**：

```js
window.QB_SYNC_CFG = {"env":"__ENV_ID__","key":"__PUBLISHABLE_KEY__", ...}
```

所以 clone 下来直接部署，除云端同步外一切正常——同步按钮是灰的，`qb-sync.js` 的 `configured()` 见到 `__` 前缀就把整个模块关掉，不会去请求一个假域名。

要接上自己的 CloudBase 环境：

```bash
cp tools/publishable-key.example.txt tools/publishable-key.txt
# 编辑该文件，填入 Publishable Key 整行 JWT
python3 tools/qb_build.py build
```

`tools/publishable-key.txt` 已在 `.gitignore` 里。云环境 ID 不用手填：`collections/cs/sync.config.json` 里留 `__ENV_ID__` 时，构建器会从 Key 的 JWT payload 解出 `project_id`。换环境只换这一处 Key。

## 几处设计取舍

- **单文件页面**：题库、样式、逻辑全塞进一个 HTML，是为了在没有网络、没装任何东西的机房里打开就用。代价是文件偏大、不好做增量 diff，用「一个题库一个目录」来缓解。
- **题目身份用内容指纹**：每题有 `gid`（题型 + 规范化题干 + 排序后的选项与答案的哈希）。同一道题出现在不同题库、不同选项顺序下，仍共享同一份作答状态；改题干会变成新题，所以改措辞要留意。
- **导出码按全站序号**：v10 编码，各题库共用一套 gid 序号，任意页面导出都是全站快照，预算 6000 字节。
- **状态全在本机**：localStorage，清缓存等于清进度，所以给了导出码做备份。

## 数据来源

题目由课程课件、教材与往年试卷整理而来，用于复习练习。试卷原文与命题记录不在此仓库内。

## 许可

代码部分 MIT。题目内容仅供学习参考，版权归原课程与教材作者。
