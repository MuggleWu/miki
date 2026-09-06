#!/usr/bin/env python3
"""生成随机参数维度的 FSRS-6 基准比对向量（补充固定默认参数的 fsrs-vectors.json）。

覆盖维度：随机 21 参数（界内均匀采样）、随机 desiredRetention、
随机 learning/relearning steps（含空）、随机 maximumInterval、随机 rating 路径。
fuzz 关闭（fuzz 含随机数，无法生成固定期望输出，其逻辑靠代码审查核对）。

用法：python3 tools/gen-fsrs-vectors-random.py [输出路径]
默认输出 tools/fsrs-vectors-random.json
"""
import json
import random
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, "/tmp/py-fsrs")

from fsrs import Scheduler, Card, Rating  # noqa: E402

random.seed(20260906)  # 固定种子保证向量可复现

EPOCH = datetime(2026, 9, 1, 0, 0, 0, tzinfo=timezone.utc)

LOWER = (0.001, 0.001, 0.001, 0.001, 1.0, 0.001, 0.001, 0.001, 0.0, 0.0,
         0.001, 0.001, 0.001, 0.001, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.1)
UPPER = (100.0, 100.0, 100.0, 100.0, 10.0, 4.0, 4.0, 0.75, 4.5, 0.8,
         3.5, 5.0, 0.25, 0.9, 4.0, 1.0, 6.0, 2.0, 2.0, 0.8, 0.8)


def random_params():
    params = []
    for lo, hi in zip(LOWER, UPPER):
        # 对数偏置小参数、线性偏置大参数：整体取界内均匀即可，clamp 已在测试面
        params.append(round(random.uniform(lo, hi), 6))
    # w20 (decay) 固定小扰动，避免极端忘曲线形状溢出
    params[20] = round(random.uniform(0.2, 0.6), 6)
    return params


def dump_card(card):
    return {
        "state": card.state.value,
        "step": card.step,
        "stability": card.stability,
        "difficulty": card.difficulty,
        "due": card.due.timestamp() * 1000,
        "lastReview": card.last_review.timestamp() * 1000 if card.last_review else None,
    }


cases = []
STEPS_POOL = [[], [60], [60, 600], [60, 600, 3600]]
RESTEPS_POOL = [[], [600], [600, 1800]]
RETENTIONS = [0.8, 0.85, 0.9, 0.95]
MAX_INTERVALS = [30, 365, 36500]

SCHEDS = 24
PATHS_PER_SCHED = 3

for si in range(SCHEDS):
    params = random_params()
    retention = random.choice(RETENTIONS)
    learn = random.choice(STEPS_POOL)
    relearn = random.choice(RESTEPS_POOL)
    max_ivl = random.choice(MAX_INTERVALS)
    sched = Scheduler(
        parameters=params,
        desired_retention=retention,
        learning_steps=[timedelta(seconds=s) for s in learn] if learn else (),
        relearning_steps=[timedelta(seconds=s) for s in relearn] if relearn else (),
        maximum_interval=max_ivl,
        enable_fuzzing=False,
    )
    for pi in range(PATHS_PER_SCHED):
        card = Card()
        card.due = EPOCH
        minute = 0.0
        path_len = random.randint(4, 10)
        meta = {
            "sched": si, "path": pi, "retention": retention,
            "learningSteps": learn, "relearningSteps": relearn,
            "maximumInterval": max_ivl, "parameters": params,
        }
        for k in range(path_len):
            rating = random.randint(1, 4)
            # 步进：步内秒级 / 跨天（ minutes 随机 5 分钟 ~ 120 天）
            minute += random.choice([1, 5, 30, 60 * 12, 60 * 24, 60 * 24 * random.randint(2, 120)])
            before = dump_card(card) if card.last_review else None
            t = EPOCH + timedelta(minutes=minute)
            card, _ = sched.review_card(card=card, rating=Rating(rating), review_datetime=t)
            cases.append({
                "name": f"rand-s{si}p{pi}#{k}-r{rating}",
                "sched": meta,
                "before": before,
                "rating": rating,
                "t": t.timestamp() * 1000,
                "after": dump_card(card),
            })

out = {"cases": cases}
dest = sys.argv[1] if len(sys.argv) > 1 else "tools/fsrs-vectors-random.json"
with open(dest, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print(f"wrote {len(cases)} cases to {dest}")
