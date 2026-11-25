#!/usr/bin/env python3
"""由 sources/papers/*.json 生成 subjects/math/bank/*.json。

源是「试卷」：一份真题一个文件，题目只写一次。
题库是「视图」：
  · 试卷视图  math/midterm、math/final —— 按卷面顺序排
  · 单元视图  math/u1 … math/u10      —— 按知识点归集，跨卷混排
同一道题在两个视图里是同一份内容，只是 qid 不同；内容指纹 gid 相同，
所以在一处答对，另一处直接显示已答对（规范 1.1 不变量一）。

用法：python3 tools/qb_math_bank.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
COL = ROOT / "collections" / "math"
PAPERS_DIR = COL / "sources" / "papers"
BANK_DIR = COL / "subjects" / "math" / "bank"
SUBJECT = "math"

# 试卷顺序 = 单元视图内的排序依据，也是试卷视图内的排序依据
PAPER_ORDER = ["mid2024", "mid2023selftest", "final2023b"]

# 试卷类别 → 题库键
KIND_BANK = {"midterm": "midterm", "final": "final"}

# 题组清单：与 subject.config.json 保持一致
UNITS = ["u1", "u2", "u3", "u4", "u5", "u7", "u8", "u9", "u10", "u11"]


def load_papers() -> list:
    papers = []
    for pid in PAPER_ORDER:
        path = PAPERS_DIR / f"{pid}.json"
        if not path.exists():
            raise SystemExit(f"缺少试卷源文件：{path}")
        data = json.loads(path.read_text(encoding="utf-8"))
        if data["id"] != pid:
            raise SystemExit(f"{path} 的 id 与文件名不一致")
        papers.append(data)
    return papers


def to_question(paper: dict, item: dict, qid: str) -> dict:
    q = {
        "qid": qid,
        "type": item["type"],
        "topic": item["topic"],
        "diff": item["diff"],
        "stem": item["stem"],
        "exp": item.get("exp", ""),
    }
    for f in ("options", "answer", "answers", "ref"):
        if item.get(f) is not None:
            q[f] = item[f]
    q["meta"] = {
        "source": paper["name"],
        "paper": paper["id"],
        "paperNo": item.get("no", ""),
    }
    # tex 是排版源（LaTeX），只影响显示，不进指纹：stem/options 一个字不改，gid 保持稳定
    if item.get("tex"):
        q["meta"]["tex"] = item["tex"]
    return q


def main():
    papers = load_papers()
    banks = {u: [] for u in UNITS}
    for kind_bank in KIND_BANK.values():
        banks[kind_bank] = []

    counts = {}
    bank_seq = {k: 0 for k in banks}
    for paper in papers:
        bank_key = KIND_BANK.get(paper["kind"])
        if bank_key is None:
            raise SystemExit(f"试卷 {paper['id']} 的 kind={paper['kind']!r} 没有对应的题库键")
        for item in paper["questions"]:
            unit = item["unit"]
            if unit not in banks:
                raise SystemExit(f"{paper['id']} 第 {item.get('no')} 题的 unit={unit!r} 不在题组清单内")
            # 试卷视图：序号在同一题库内跨卷连续
            bank_seq[bank_key] += 1
            exam_q = to_question(paper, item, f"{SUBJECT}.{bank_key}-{bank_seq[bank_key]:03d}")
            banks[bank_key].append(exam_q)
            # 单元视图：qid 用单元键，序号在单元内连续
            unit_seq = len(banks[unit]) + 1
            unit_q = to_question(paper, item, f"{SUBJECT}.{unit}-{unit_seq:03d}")
            banks[unit].append(unit_q)
            counts[paper["id"]] = counts.get(paper["id"], 0) + 1

    BANK_DIR.mkdir(parents=True, exist_ok=True)
    for key, items in banks.items():
        if not items:
            raise SystemExit(f"题组 {key} 为空：每个题组至少一题（规范 7.1 第 10 项）")
        path = BANK_DIR / f"{key}.json"
        path.write_text(json.dumps({"version": 1, "unit": key, "questions": items},
                                   ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"  {key:<8} {len(items):>3} 题")

    print("\n各卷题量：" + "、".join(f"{k} {v} 题" for k, v in counts.items()))
    total = sum(len(banks[k]) for k in ("midterm", "final"))
    print(f"试卷视图合计 {total} 题；单元视图合计 {sum(len(banks[u]) for u in UNITS)} 题")


if __name__ == "__main__":
    sys.exit(main())
