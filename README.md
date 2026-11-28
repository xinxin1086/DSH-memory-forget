# DSH-memory-forget

> 给 DeepSeek Harness 加一个**会遗忘的自己**：人格与记忆落在本地 markdown 里，会话可以清空，但"我是谁"由记忆文件连续地演化。

**当前状态**

| 部分 | 状态 |
|---|---|
| 记忆层（本仓库 `plugin/`） | ✅ **已实现，v0.1.0，可直接安装** |
| 多智能体编排层（转子 / 派发 / 令牌） | 📝 仍在设计，未随仓库发布 |

设计文档（架构 v5、可行性分析、M0 探针报告）在本地 `docs/`，**未纳入版本库**。

---

## 它解决什么

长会话不是记忆。上下文一满就压缩，会话一关就归零，所谓"人格"其实是每次重新拼出来的。

这个插件把人格换成三样**磁盘上的东西**：

| 层 | 存什么 | 谁改 |
|---|---|---|
| **L0 准则** | 方向与硬规范（"为用户带来快乐""遵守法律"） | **只有用户**，手写 `rules.md` |
| **L1 人格** | 核心事实、关系、条件性行为约束 | 裁判提案，用户确认 |
| **L2 记忆** | 偏好、事件、计划、一次性事务 | 裁判自动增删改 |

每轮对话开始时注入一份**摘要包**（准则全文 + 人格 ≤3 条 + 记忆 ≤8 条），每轮结束时由 LLM 裁判提炼一次。

### 三条与"普通记忆插件"不同的地方

1. **遗忘是主动的，不是溢出**：到期记录转 `expired`、低价值转 `dormant`、重复的摘除；过期 ≠ 删除，`states=expired` 仍可查。
2. **注入只给摘要**：原文留在本机，只有裁判调用和用户显式要求（`reveal`）时才上行，且结果会标注。
3. **日记只追加**：裁判写进 L2 的每条事实，都另存一份到 `diary-<persona>/YYYY-MM.md`。之后 L2 怎么变，日记原文不动；想彻底销毁，删日记里的段落即可。

---

## 安装

插件的唯一可安装目录：

```
plugin\persona-memory-forget
```

**没有构建步骤、没有第三方依赖**（只用 `node:` 内置模块），下载仓库后不需要 `npm install`。

1. 打开 DSH → 左侧 **Plugins**
2. **添加插件 / 安装本地目录** → 选 `plugin\persona-memory-forget`
3. 新开一个会话

装前可以自检：

```powershell
node plugin\persona-memory-forget\scripts\verify-bundle.mjs
# OK: dsh-memory-forget@0.1.0 can be installed from this directory
```

完整步骤（三种安装方式、四步验证、配置、卸载、排错）见 **[INSTALL.md](INSTALL.md)**。

---

## 用起来是什么样

装好后，模型多出三个工具：

| 工具 | 用途 |
|---|---|
| `memory_recall` | 主动检索记忆（默认只返回摘要；`states` 可查已摘除/过期条目） |
| `memory_remember` | 用户明确要求"记住这个"时调用；绕过冷却、保护 30 天 |
| `memory_status` | 看各层条数、解析错误、生命周期状态 |

对话里不需要命令：

> 用户：我下个月初要搬去成都
> （裁判在回合结束时写入 `2026年12月上旬要搬去成都`，带 expires）
>
> 用户：你还记得我什么时候搬吗？
> （`memory_recall` 命中摘要；原文仍在本机）

第一轮对话前，先按自己的情况写 `~/.dsh/memory/default/rules.md`：

```markdown
- [norm] 不替用户做不可逆决定
- [aim] 为用户带来快乐
```

规则解析失败时**整份作废**（fail-closed：宁可停止注入，也不猜）。

---

## 已实现的功能

| 能力 | 说明 |
|---|---|
| 分层记忆 | L0 准则 / L1 人格 / L2 记忆，markdown 真身 |
| 按轮注入 | 每轮首个 step 注入；内容不变不重复；子智能体只拿准则+人格 |
| 记忆裁判 | 回合结束一次 LLM 调用，产出 `add_l2` / `update_l2` / `dereference_l2` / `propose_l1` |
| 去重 | 模型侧 `update_l2` 合并同一事实；程序侧 0.85 相似度兜底 |
| 过期与淘汰 | `expires` 到期转 `expired`；active 超 24 条时最旧无日期记录转 `dormant` |
| 生命周期 | 摘除冷却 7 天、用户重记保护 30 天、抖动 3 次冻结 |
| 版本历史 | 每条记录保留 5 个快照，更早压成一行摘要 |
| 日记 | 只追加、按年月分文件、不参与人格、可手动销毁 |
| 零依赖 | 纯 ESM + `node:` 内置模块，`node --test` 32 项测试 |

## 数据在哪

```
$DSH_HOME/memory/<人格名>/        Windows 默认 C:\Users\<你>\.dsh\memory\default\
├── rules.md        L0 准则（你手写）
├── persona.md      L1 人格
├── memory.md       L2 记忆
├── pending_l1.md   待确认的 L1 提案
├── versions.jsonl  最近 5 个快照
├── versions.md     更早快照的摘要
├── diary-<人格>/   日记（YYYY-MM.md）
├── state.json      冷却/保护/抖动
├── audit.jsonl     审计
└── .lock           写锁
```

换人格只改配置里的 `persona`；删掉整个目录 = 清空记忆（不可恢复）。**卸载插件不会删数据**，重装即恢复。

## 配置

```yaml
- id: dsh-memory-forget
  name: 'dsh-memory-forget'
  config:
    persona: default
    inject: { enabled: true, limits: { maxL1: 3, maxL2: 8, maxChars: 3000 } }
    judge:  { enabled: true, maxCandidates: 40 }
    clock:  { turnsPerRun: 1, maxActive: 24 }
```

## 仓库结构

```
DSH-memory-forget\
├── INSTALL.md                     安装 / 验证 / 排错
├── README.md                      本文件
└── plugin\persona-memory-forget\  唯一可安装的插件
    ├── index.js                   装配（apply + inject）
    ├── cordis.patch.yml           bundle 行
    ├── lib\                       store / inject / judge / clock / pack / retrieve / dedupe / state / versions / tools
    ├── scripts\                   verify-bundle、backfill-diary
    └── test\                      32 项单测（node --test）
```

`docs/`（设计文档）与 `probe/`（M0 探针）都在 `.gitignore` 里，不随仓库发布。

---

## 已知限制

- 注入状态在进程内，重启后会重注入一次（无害）。
- 裁判候选只取**用户原话**；助手结论与工具结果暂不参与。
- L1 提案通道存在，但门槛偏严，实际很少产出。
- 检索是关键词 + 中文二元组，没有向量检索。
- 多智能体编排（转子、派发、令牌）尚未实现，不在本插件内。

## 设计取舍

这个项目把"人格漂移"当作**目的**而不是缺陷：低权重记忆被遗忘、原文保留、复现后由裁判重新判断，于是"我是谁"由持续的注意力自然重写。身份连续 = 有连续的因果记录，**不等于**身份稳定。

想取消漂移，做法不是加重审核，而是让 L1/L0 的变更权与裁判分离——这一点已经落在实现里（L0 只有用户能改，L1 需提案确认）。

## 参与贡献

目前处于可用但早期阶段，接口与数据格式仍可能调整。仓库内的设计文档不公开发布；改动前建议先读 `plugin/persona-memory-forget/README.md` 与 `INSTALL.md`。

## 开源协议

LGPL

> 最后更新：2026.11.28
