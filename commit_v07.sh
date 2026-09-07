#!/bin/bash
cd /data/user/0/com.ai.assistance.operit/files/workspace/3f6381da-999a-4511-86b2-bb3837be16c3/operit-acp-plugin
git add -A
git commit -q -m "feat: V0.7 Continuous Per-Hop Pressure Controller（文档架构级改造）

新增 src/acp/pressure.ts: 拆分明晰的 pressure 函数
- computeEffectivePressure: usage 缺失/为0 用 estimate 兜底(source=measured/estimated/hybrid)
- computePressureLevel: 越线档 + epoch 内单调升级
- shouldEscalate / evaluatePressure: 主控制器

关键语义修正（对齐文档第三~十节）:
- 取消 kernelShouldInject 硬总门 → 只作辅助 signal
- cooldown/credit 只抑制 gentle; strong/emergency 必须 bypass
- hostEscalationFloor=0.70: kernel 沉默区 Adapter 自接管(配合增长条件防 spam)
- epoch 以压缩成功为边界(非 usage 回落), 支持无限连续
- 每个决策产出 decisionReason (trace 直接回答为何不 nudge)
- compression baseline: creditBaseToken 作为增长基准
- trace 增加 effPct/level/reason

测试(tests/pressure.test.mts) P1-P10 覆盖文档第十五节 15 项验收:
- 20-Hop soak: 2+ model compress, epoch>=3, strong bypass cooldown/credit
- effective estimate 兜底 / host floor / epoch 单调升级 / gentle 抑制
40/40 测试全绿"
git push origin master 2>&1 | tail -2
git log --oneline | head -2
exit 0