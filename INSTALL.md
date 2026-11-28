# 安装：把 dsh-memory-forget 挂到 DSH 上

本仓库里**可以直接挂载的插件只有一个目录**：

```
G:\A_Project\DSH-memory-forget\plugin\persona-memory-forget
```

它是纯 ESM JavaScript，**没有构建步骤、没有第三方依赖**（只用 `node:` 内置模块），所以下载仓库后不需要 `npm install`、不需要打包，选目录就能装。

> 不要选仓库根目录，也不要选 `probe/`。必须选到含 `package.json` 的 `plugin\persona-memory-forget`。

---

## 前提

| 项 | 要求 |
|---|---|
| DSH | Desktop 0.2.2 及以上（或带 Plugins 页的 Web 版） |
| Node | 20+（Desktop 自带 Electron 的 Node 24，无需另装） |
| 网络 | 安装本地目录不需要联网（profile 里的 pnpm 只做本地 link） |

---

## 方式 A：界面安装（推荐）

1. 打开 DSH，左侧进 **Plugins**（插件）。
2. 点 **添加插件 / 安装本地目录**，路径选：
   ```
   G:\A_Project\DSH-memory-forget\plugin\persona-memory-forget
   ```
3. 安装后确认插件列表里出现 **dsh-memory-forget** 一行，并且是启用状态。
4. **新开一个会话**（已打开的会话不会加载新工具）。

## 方式 B：让 agent 装

对 DSH 说：

> 把 `G:\A_Project\DSH-memory-forget\plugin\persona-memory-forget` 作为插件安装

它会调用 `plugin_manager install_bundle`，效果与方式 A 相同。

## 方式 C：先自检

在任何机器上，装之前可以先确认这个目录能独立运行：

```powershell
node G:\A_Project\DSH-memory-forget\plugin\persona-memory-forget\scripts\verify-bundle.mjs
```

输出 `OK: dsh-memory-forget@0.1.0 can be installed from this directory` 就说明清单、导出、导入都没有问题。

---

## 安装后怎么验证

**第 1 步：看工具在不在**

新会话里让它调 `memory_status`，正常应返回：

```
persona: default
root: C:\Users\<你>\.dsh\memory\default
L0: 0 条 (norm=0, aim=0)
L1: 0 条 {}
L2: 0 条 {}
state: {"tracked":0,"protected":0,"frozen":0,"cooling":0}
```

**第 2 步：写一条**

> 记住：我喜欢喝乌龙茶

它会调 `memory_remember`，返回 `remembered L2-xxxxxxx` 和保护截止日。

**第 3 步：查一条**

让它调 `memory_recall(query="乌龙茶")`，应命中摘要（默认不显示原文）。

**第 4 步：看注入**

下一轮对话开始时，上下文里应出现一段以「以下是从长期记忆中取回的摘要」开头的消息。没出现就去看下面「排错」。

---

## 数据放在哪

```
$DSH_HOME/memory/<人格名>/          Windows 默认 C:\Users\<你>\.dsh\memory\default\
├── rules.md        L0 准则（手写，只有你能改）
├── persona.md      L1 人格记录
├── memory.md       L2 记忆记录
├── pending_l1.md   待你确认的 L1 提案
├── versions.jsonl  每条记录最近 5 个快照
├── versions.md     更早快照压成的摘要
├── diary-<人格>/   日记（YYYY-MM.md，只追加，永不主动读取）
├── state.json      冷却/保护/抖动计数
├── audit.jsonl     审计
└── .lock           写锁
```

- 换人格 = 改配置里的 `persona`（默认 `default`），互不干扰。
- 删掉整个目录 = 清空这个人的全部记忆（不可恢复）。
- 想彻底销毁某条信息：等它在 `memory.md` 里消失后，删 `diary-*/` 里对应段落。

## 编辑准则（rules.md）

```markdown
# 注释行可以写
- [norm] 不替用户做不可逆决定
- [aim] 为用户带来快乐
```

- 只认 `norm` / `aim` 两种标签；支持 `-` `*` `+` 三种项目符、也兼容编辑器转义后的 `\[norm]`。
- **任何一行解析失败，整份规则作废**（fail-closed：插件会停止注入，而不是猜）。`memory_status` 会显示解析错误。

## 配置（可选）

在 profile 的 `cordis.patch.yml` 里覆盖 `dsh-memory-forget` 行：

```yaml
- id: dsh-memory-forget
  config:
    persona: default
    inject: { enabled: true, limits: { maxL1: 3, maxL2: 8, maxChars: 3000 } }
    judge:  { enabled: true, maxCandidates: 40 }
    clock:  { turnsPerRun: 1, maxActive: 24 }
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `persona` | `default` | 人格名，决定数据目录 |
| `inject.enabled` | `true` | 关掉就只保留工具，不注入 |
| `inject.limits.maxL1` | `3` | 每轮最多注入几条人格记录 |
| `inject.limits.maxL2` | `8` | 每轮最多注入几条记忆 |
| `inject.limits.maxChars` | `3000` | 整包字符上限 |
| `judge.enabled` | `true` | 关掉就不做自动记忆 |
| `clock.turnsPerRun` | `1` | 每几轮跑一次裁判 |
| `clock.maxActive` | `24` | active 记忆超过多少条开始降 dormant |

---

## 卸载

1. Plugins 里移除 **dsh-memory-forget** 这个 bundle。
2. 数据不会自动删：需要的话手动删 `$DSH_HOME\memory\<persona>\`。

---

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 插件行显示 **failed** | 激活时报错 | 看 Plugins 里的 diagnostic；先跑一次 `verify-bundle.mjs` |
| 一行 `dsh: warning: ... did not activate` | 服务缺失（如 `tools` 没挂） | 确认是完整 Desktop/Web profile，不是 minimal |
| 上下文里没有记忆包 | 规则解析失败 / `inject.enabled=false` / 本轮已注入过且内容未变 | 调 `memory_status` 看 `rules.error`；改完规则下一轮生效 |
| 记忆不增长 | 裁判没跑 | 看 `audit.jsonl`：`judge_skip` 带 `reason`，常见是没有会话模型路由 |
| 中文乱码 | 文件不是 UTF-8 或带 BOM | 用无 BOM 的 UTF-8 重写 `rules.md` / `memory.md` |
| 装完没反应 | 没开新会话 | 工具只在新建会话里出现 |

---

## 这个仓库里还有什么

| 目录 | 用途 |
|---|---|
| `plugin/persona-memory-forget/` | **唯一可安装的插件** |
| `probe/persona-memory-probe/` | M0 探针（当初用来验证注入/事件/LLM 能力），可删 |
| `docs/` | 设计文档与实现记录（不入版本库） |




