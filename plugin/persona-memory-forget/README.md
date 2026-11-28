# dsh-memory-forget（0.1.0 · 人格记忆层）
> _如果不想全部忘记，那是否在一开始就要选择遗忘。_

DSH Host 插件：把一个人格长期记忆存在本地 markdown 里，**每轮注入摘要**、**每轮结束由裁判提炼记忆**，并向模型暴露只读检索工具。

## 目录

```
$DSH_HOME/memory/<persona>/
├── rules.md       L0 准则（只有用户改）
├── persona.md     L1 人格记录
├── memory.md      L2 记忆记录
├── pending_l1.md  待确认的 L1 提案（裁判写，用户改）
├── versions.jsonl 每条记录最近 5 个快照
├── versions.md    更早快照压成的固定字段摘要
├── diary-<persona>/
│   └── YYYY-MM.md 日记：裁判写过的所有事实，只追加
├── state.json     冷却/保护/抖动计数
├── audit.jsonl    最小审计（注入、裁判、工具调用、写盘）
└── .lock          跨进程写锁（写时短暂存在）
```

`$DSH_HOME` 在 Host 进程里拿不到，解析顺序是 `config.home` → `DSH_HOME` → `~/.dsh`。

## 行为

| 时机 | 动作 |
|---|---|
| 每轮第一个 `agent/pre-step` | 注入一份摘要包（准则 + 人格 + 相关记忆）；同一轮内容没变则不重复 |
| 内容变化（刚写记忆、刚改规则） | 同轮补注入一次 |
| 子智能体 | 只注入准则 + 人格，**不含 L2 记忆**（用 `ctx.subagents.namesOf(agent).parent` 判别） |
| 每轮 `turn/end` | 把本轮用户原话交给裁判；裁判产出 `add_l2` / `dereference_l2` / `propose_l1` |
| `add_l2`、`dereference_l2` | 自动落盘 |
| `propose_l1` | 追加到 `pending_l1.md`，等用户确认后才进 `persona.md` |

注入内容**只有摘要**：L2 的 `evidence` 等原文细节不出现在上下文里；要原文必须显式调 `memory_recall(reveal: true)`，此时结果会标注"将随会话上行"。

## 容量上限（现行值）

| 层 | 存储上限 | 注入上限 |
|---|---|---|
| L0 准则 | 无硬限制 | **全量注入**（部分受 3000 字符总预算挤压） |
| L1 人格 | 无硬限制 | ≤ 3 条 |
| L2 记忆 | 无硬限制（靠去重 + 降权收敛） | ≤ 8 条，超出显示"另有 N 条未展示" |
| 整包 | — | ≤ 3000 字符 |

另有一个保护：`active` 的 L2 超过 `clock.maxActive`（默认 24）时，最旧的**无日期**记录降为 `dormant`（可检索、不注入）。

设计文档 v5 的建议值是 L0 ≤15 条、L1 50–300 条、L2 无上限；代码目前不强制前两者，只做注入侧限制。

## 手写格式

`rules.md`：每行一条，其他行必须是 `#` 注释或空行，否则**整份规则解析失败（fail-closed，注入被关闭）**。支持 `- [norm]`、`* [norm]`、`* \[norm]`（编辑器转义过的形式）：

```markdown
- [norm] 不替用户做不可逆决定
- [aim] 为用户带来快乐
```

`persona.md` / `memory.md`：

```markdown
## L2-dog01
- claim: 用户提到过一只狗，叫豆豆
- status: active
- scope: 谁=用户
- evidence: E1
- updated: 2026-11-28
```

`status`：`active` / `dereferenced` / `dormant` / `superseded` / `retracted`。

## 工具

| 工具 | 说明 |
|---|---|
| `memory_recall` | 检索；默认只返回摘要。`states` 可查已摘除条目；`reveal: true` 返回原文并警告上行 |
| `memory_remember` | 用户明确要求记住时调用：绕过冷却、恢复被摘除记录、保护 30 天 |
| `memory_status` | 各层条数、状态分布、解析错误、路径、生命周期状态 |

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

## R4 生命周期（已实现）

| 机制 | 规则 |
|---|---|
| 冷却 | 记录被摘除后 7 天内，自动重记被拒（`cooling_block`） |
| 保护 | 用户显式 `memory_remember` 后 30 天内，自动摘除被拒（`protected_skip`） |
| 抖动冻结 | 同一记录被摘除 3 次 → `frozen`，自动摘除永久被拒，交用户裁定 |
| 持久化 | 以上状态写入 `state.json`，重启后仍然有效 |

## 日记（append-only 记录）

裁判每次把事实写进 L2，都会**同时追加一份**到 `diary-<persona>/YYYY-MM.md`：

```markdown
## 2026-11-28T03:12:44.120Z · L2-k3m9x2a · add
- claim: 用户有一个网友叫往昔，是男性。
- scope: 谁=用户;场景=社交
```

规则：

- **只追加，不修改**：之后 L2 里这条被改写、摘除、过期，日记里的原始记录都不变。
- **不参与人格**：从不注入、不被裁判读取、`memory_recall` 也不会命中它。
- **可以彻底销毁**：当 L2 里已经查不到某条信息时，用户手动删掉日记里对应段落，就是真正删除。
- 按自然月分文件，跨月自动新建。

## 版本历史（K=5）

- 每次 add / update / deref / expire / demote 都把快照写进 `versions.jsonl`。
- 每条记录只保留最近 **5** 个快照；更早的压成 `versions.md` 里一行固定字段摘要（id、时间范围、条数、操作集合、最后一条 claim）。
- `superseded` / `retracted` 状态永不合并。

## 已知限制（M2）

- 注入状态是**进程内**的：重启后会重注一次（无害）。
- 裁判候选只取**用户原话**；助手结论与工具结果暂不参与。
- 摘除的冷却期/保护期/flap 计数（R4 状态机）未实现。
- 裁判跟随会话模型；没有独立小模型路由。
- 裁判候选仍只取用户原话（助手结论与工具结果不参与）。
- 日记只记录裁判写入的事实，不回溯已有记录；需要补历史可以手工复制一次。

## 测试

```powershell
node --test plugin/persona-memory-forget/test/store.test.mjs plugin/persona-memory-forget/test/m2.test.mjs
```

32 项：布局、L0 fail-closed（含编辑器转义格式）、块格式往返、原子写、锁拒绝、分词、状态过滤、摘要不含原文、工具执行、注入节奏（同轮不重复/变化重注/子无 L2）、时钟触发、裁判 ops 解析与应用、去重、提案落盘、冷却/保护/抖动冻结、日记追加、版本压缩、过期快照。






