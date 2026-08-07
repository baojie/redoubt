# 项目约束（不可违反）

项目代号 **redoubt**。完整方案见 `PLAN.md`，里程碑分解见其 §5。

## 架构
- `packages/core` 是纯函数规则引擎：不得 import 任何渲染、网络、文件系统、
  计时器相关模块。不得使用 Math.random()、Date.now()、performance.now()。
  随机数只能来自注入的 seeded RNG；时间只能来自 tick 计数。
- 所有游戏数值常量必须定义在 `packages/core/src/rules.ts`。
  在其他文件中出现裸数字（0/1/-1 除外）视为 bug。
- 服务器是唯一权威。客户端可以预测，但客户端的计算结果永远不写回权威状态。

### 上述「裸数字」规则的两条豁免
1. `packages/core/src/maps/*.ts` 是**地图几何数据**（控制点坐标、主基地位置、
   lane 拓扑），不是可调数值。数据文件里出现坐标是正常的，但任何有「规则含义」
   的量（半径、时长、成本）仍必须来自 `rules.ts`。
2. 位运算常量（FNV hash 的 prime/offset、RNG 的 multiplier）属于算法定义，
   写在 `rng.ts` / `hash.ts` 内部，不进 `rules.ts`。

## 不变量（每次改动后必须仍然成立，写成属性测试）
1. 任一时刻，任一队伍票数 ≥ 0 且单调不增（除明确的加票事件）
2. FOB 之间距离恒 ≥ 400m；FOB 距主基地恒 ≥ 150m
3. FOB 的 CP / AP 恒在 [0, 20000] 区间
4. 控制点占领顺序恒符合当前 lane 的拓扑约束
5. 同一 seed + 同一输入序列 → 逐 tick bit-identical 的状态哈希

## 测试门禁
每次提交前必须通过：
- `pnpm test`（单测 + 属性测试）
- `pnpm sim --matches 100`（100 局无头对战，零崩溃、零死锁、
  平均局时在 30-60 分钟区间）
状态哈希写入快照文件，回归时对比。

## 禁止
- 不得使用 "Squad" 作为项目名、模块名、类名或任何用户可见文本
- 不得引入任何来自 Squad 或其他商业游戏的美术、音频、地图数据
- 不要为了让测试通过而修改测试或放宽不变量；先修实现

## 常用命令
```
pnpm test                    # vitest：单测 + fast-check 属性测试 + 平衡性门禁
pnpm sim --seed 42           # 跑一局，输出文字战报
pnpm sim --matches 1000      # 批量对战 + 平衡性统计（约 40 秒）
pnpm sim --seed 7 --hash     # 逐 tick 状态哈希，用于排查 desync
pnpm typecheck               # tsc 仅做类型检查，不产出构建物
```

## 代码组织约定
- `packages/*/src` 是实现，`packages/*/test` 是测试，两者都进类型检查。
- 需要「驱动一整局」才能验证的测试放 `packages/sim/test`，不放 core —
  core 不做任何决策，只做裁决，测试也不该让它反向依赖 sim。
- 持续性动作（建造、救援、装卸补给）在 core 里是**按 tick 累积的速率**。
  任何驱动层（bot、服务器）必须逐 tick 重复发送这些命令，否则实际速率会
  按其决策频率被整除。
