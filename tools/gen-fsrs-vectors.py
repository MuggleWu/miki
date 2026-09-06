#!/usr/bin/env python3
"""生成 FSRS-6 基准比对向量（供 src/core/__tests__/fsrs.spec.ts 使用）：
用官方 py-fsrs v6.3.2 对固定输入算出期望输出，TS 实现跑同样输入逐例比对。

用法：需要 /tmp/py-fsrs（clone v6.3.2）与 typing_extensions。
    python3 tools/gen-fsrs-vectors.py
输出：tools/fsrs-vectors.json
"""
import json
import math
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, "/tmp/py-fsrs")

from fsrs import Scheduler, Card, Rating  # noqa: E402

EPOCH = datetime(2026, 9, 1, 0, 0, 0, tzinfo=timezone.utc)


def ts(minute: float) -> datetime:
    return EPOCH + timedelta(minutes=minute)


def dump_card(card: Card) -> dict:
    """输出 miki CardSnapshot（camelCase）"""
    return {
        "state": card.state.value,
        "step": card.step,
        "stability": card.stability,
        "difficulty": card.difficulty,
        "due": card.due.timestamp() * 1000,
        "lastReview": card.last_review.timestamp() * 1000 if card.last_review else None,
    }


def dump_snap(card: Card) -> dict | None:
    """把卡转成 miki CardSnapshot（重放输入侧）"""
    if card.last_review is None:
        return None
    return dump_card(card)


cases = []


def run_case(name: str, path: list[tuple[int, float]]):
    """path: [(rating, minute_from_epoch)]；逐级 review，记录每步 before/after"""
    sched = Scheduler(enable_fuzzing=False)
    card = Card()
    card.due = ts(0)
    for rating, minute in path:
        before = dump_snap(card)
        t = ts(minute)
        card, _ = sched.review_card(card=card, rating=Rating(rating), review_datetime=t)
        cases.append(
            {
                "name": f"{name}#{len(cases)}",
                "before": before,
                "rating": rating,
                "t": t.timestamp() * 1000,
                "after": dump_card(card),
            }
        )


# 1. 新卡四种首评
for r in (1, 2, 3, 4):
    run_case(f"new-r{r}", [(r, 0)])

# 2. Learning 步链：Again→1min；Good→10min；毕业→长期
run_case("learn-chain-again-good-good", [(1, 0), (3, 1), (3, 11)])
run_case("learn-chain-good-good-good", [(3, 0), (3, 10), (3, 60 * 24 * 3)])
run_case("learn-chain-easy", [(4, 0), (3, 60 * 24 * 4)])
run_case("learn-hard-grad", [(2, 0), (3, 10), (4, 60 * 24 * 2)])

# 3. Review 长期 + 遗忘 → Relearning → 毕业
run_case("review-again-relearn", [(3, 0), (3, 10), (1, 60 * 24 * 3), (3, 60 * 24 * 3 + 10), (3, 60 * 24 * 10)])
run_case("review-hard-good-easy", [(3, 0), (3, 10), (2, 60 * 24 * 2), (3, 60 * 24 * 8), (4, 60 * 24 * 20)])

# 4. 同日 short-term（Review 态当天再刷）
run_case("short-term-review", [(3, 0), (3, 10), (3, 60 * 24), (3, 60 * 24 + 120), (1, 60 * 24 + 300), (3, 60 * 24 + 310)])

# 5. Learning 态逾期（跨天后再答，走 next_stability 分支）
run_case("learning-overdue", [(3, 0), (1, 60 * 24 * 2), (3, 60 * 24 * 2 + 10)])

# 6. 长序列压力（间隔拉开 + 多次遗忘）
run_case(
    "long-mixed",
    [(3, 0), (3, 10), (2, 60 * 24), (3, 60 * 24 * 6), (1, 60 * 24 * 20), (3, 60 * 24 * 20 + 10),
     (3, 60 * 24 * 12), (2, 60 * 24 * 40), (3, 60 * 24 * 90), (4, 60 * 24 * 120)],
)

out = {
    "epoch_ms": EPOCH.timestamp() * 1000,
    "parameters": list(Scheduler(enable_fuzzing=False).parameters),
    "cases": cases,
}

dest = sys.argv[1] if len(sys.argv) > 1 else "tools/fsrs-vectors.json"
with open(dest, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print(f"wrote {len(cases)} cases to {dest}")
