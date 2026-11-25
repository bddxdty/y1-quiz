#!/usr/bin/env python3
"""把 计算机导论_题库合集.html 的 QUESTIONS 抽成规范题库。

只搬运，不改题干与答案；唯一的结构性改动是：
同一道题出现在两个题组时，把选项顺序对齐到 qid 较小的一份（规范 2.3 性质 2、gotchas #3）。

用法：python3 tools/migrate_cs.py
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SRC = ROOT.parent / "计算机导论" / "计算机导论_题库合集.html"
OUT = ROOT / "collections" / "cs" / "subjects" / "cs" / "bank"
sys.path.insert(0, str(HERE))
import qb_gate  # noqa: E402


def extract_questions() -> list:
    html = SRC.read_text(encoding="utf-8")
    i = html.index("const QUESTIONS")
    s = html.index("[", i)
    e = html.index("\n];", s)
    literal = html[s:e + 2]

    tmp_js = ROOT / "tools" / "_extract.tmp.cjs"
    tmp_out = ROOT / "tools" / "_extract.tmp.json"
    tmp_js.write_text(
        "const fs=require('fs');"
        f"const s=fs.readFileSync({json.dumps(str(ROOT / 'tools' / '_literal.tmp.js'))},'utf8');"
        f"fs.writeFileSync({json.dumps(str(tmp_out))}, JSON.stringify(eval(s)));",
        encoding="utf-8")
    (ROOT / "tools" / "_literal.tmp.js").write_text(literal, encoding="utf-8")
    try:
        subprocess.run(["node", str(tmp_js)], check=True)
        return json.loads(tmp_out.read_text(encoding="utf-8"))
    finally:
        for p in (tmp_js, tmp_out, ROOT / "tools" / "_literal.tmp.js"):
            p.unlink(missing_ok=True)


UNIT_OF = [
    ("u1", lambda q: q.get("ch") == 1 and q.get("type") != "term"),
    ("u2", lambda q: q.get("ch") == 2 and q.get("type") != "term"),
    ("u3", lambda q: q.get("mod") == "计算机组成原理" and q.get("type") != "term"),
    ("u4", lambda q: q.get("mod") in ("数据结构", "算法") and q.get("type") != "term"),
    ("exam", lambda q: q.get("mod") == "期中冲刺"),
    ("terms", lambda q: q.get("type") == "term"),
    ("calc", lambda q: q.get("mod") == "计算专题"),
]

ORDER = ["u1", "u2", "u3", "u4", "exam", "terms", "calc"]


def unit_of(q) -> str:
    for key, pred in UNIT_OF:
        if pred(q):
            return key
    raise SystemExit(f"题目 {q['id']} 无法归入任何题组：{q.get('mod')} / ch={q.get('ch')} / {q.get('type')}")


def to_question(q, qid) -> dict:
    out = {
        "qid": qid,
        "type": q["type"],
        "topic": q["topic"],
        "diff": q["diff"],
        "stem": q["stem"],
        "exp": q["exp"],
    }
    for f in ("options", "answer", "answers", "ref"):
        if q.get(f) is not None:
            out[f] = q[f]
    out["meta"] = {
        "origin": {"id": q["id"], "no": q["no"], "mod": q["mod"], "ch": q.get("ch")},
        "source": "计算机导论 题库合集（原站）",
    }
    return out


def canon(records: list) -> int:
    """同一 gid 的多份副本：把选项顺序与答案下标对齐到 qid 最小的一份。"""
    groups = {}
    for r in records:
        groups.setdefault(qb_gate.fingerprint(r, 32), []).append(r)
    fixed = 0
    for gid, group in groups.items():
        if len(group) < 2:
            continue
        group.sort(key=lambda x: x["qid"])
        base = group[0]
        if "options" not in base:
            continue
        for other in group[1:]:
            if other.get("options") == base["options"] and other.get("answer") == base["answer"]:
                continue
            # 对齐前先确认正确答案文字一致，否则说明不是同一道题
            base_right = {base["options"][i] for i in base["answer"]}
            other_right = {other["options"][i] for i in other["answer"]}
            if base_right != other_right:
                raise SystemExit(
                    f"gid {gid} 的两份副本正确答案文字不一致：{base['qid']} 与 {other['qid']}，需人工判定")
            remap = [base["options"].index(t) for t in other["options"]]
            other["options"] = list(base["options"])
            other["answer"] = sorted(remap[i] for i in other["answer"])
            fixed += 1
    return fixed


def main():
    questions = extract_questions()
    print(f"抽取 {len(questions)} 题")

    buckets = {k: [] for k in ORDER}
    for q in questions:
        buckets[unit_of(q)].append(q)

    records = []
    for key in ORDER:
        items = sorted(buckets[key], key=lambda q: q["no"])
        for n, q in enumerate(items, 1):
            qid = f"cs.{key}-{n:03d}"
            records.append(to_question(q, qid))

    fixed = canon(records)
    if fixed:
        print(f"对齐了 {fixed} 份副本的选项顺序")

    OUT.mkdir(parents=True, exist_ok=True)
    for key in ORDER:
        items = [r for r in records if r["qid"].startswith(f"cs.{key}-")]
        bank = {"version": 1, "unit": key, "questions": items}
        (OUT / f"{key}.json").write_text(
            json.dumps(bank, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"  {key:<6} {len(items):>4} 题")

    gids = {}
    for r in records:
        gids.setdefault(qb_gate.fingerprint(r, 32), []).append(r["qid"])
    dup = {g: v for g, v in gids.items() if len(v) > 1}
    print(f"唯一 gid {len(gids)}｜跨题组副本 {len(dup)} 组：")
    for g, v in list(dup.items())[:10]:
        print(f"  {g}  {' / '.join(v)}")


if __name__ == "__main__":
    main()
