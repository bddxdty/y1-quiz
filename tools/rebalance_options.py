#!/usr/bin/env python3
"""选项位置重排：把正确答案在 A/B/C/D 之间摊开，避免「答案总在第一个」。

为什么需要：出题时人习惯把正确项写在第一位，成卷后单选答案会一边倒地集中在 A。
做题的人摸到规律就能不读题干直接选，练习信度下降。本工具只改选项顺序与 answer
下标，不动题干、解析与任何内容，因此不影响 gid（指纹按选项集合排序后计算）。

用法：
    python3 tools/rebalance_options.py <bank.json> [<bank.json> ...] [--dry]

约定：
  · 只处理 single / multi 且选项 ≥ 3 的题；两选项判断题不参与（换序治不了语义偏斜）。
  · 幂等：已重排过的题写 meta.optperm，再次运行直接跳过。
  · 解析里若出现独立的 A/B/C/D 字母（指代选项），换序会让它指向错项，工具拒绝处理该题
    并打印出来，需先把解析里的字母改成选项文字再重跑。
"""
import json
import re
import sys

# 只认「指代选项」的字母：必须紧邻判断词，或成串出现，或跟在「选项」后面。
# 这样 C 语言、C 编译器、C/C++、C# 这类技术写法不会被误判。
REF = re.compile(
    r"(?<![A-Za-z])[ABCD](?![A-Za-z])\s*(?:对|错|正确|错误|项|混淆|不成立|均|说法|描述|属于|是常见)"
    r"|(?<![A-Za-z])[ABCD](?![A-Za-z+#])\s*[、，和与]\s*[ABCD](?![A-Za-z+#])"
    r"|选项\s*[ABCD]"
)
# 目标位置序列：先按「最少使用」贪心选位，同票时按这个顺序取，保证确定性
PREF = [2, 1, 3, 0]
# 多选轮换步长：让答案集合里的位置分布开，同时保证有一部分题不含 A
ROT = [0, 1, 2, 3, 1, 3, 2, 0]


def rebalance(questions, dry=False):
    counts = [0, 0, 0, 0]
    changed, skipped, refused = 0, 0, []

    # 先把已重排过的题计入分布，新题从「当前真实的偏斜」继续摊平，
    # 否则每次运行都从零开始，后处理的那几道会全被塞到同一个位置。
    for q in questions:
        if q.get("type") not in ("single", "multi") or len(q.get("options") or []) < 3:
            continue
        if not (q.get("meta") or {}).get("optperm"):
            continue
        for a in q["answer"]:
            counts[a] += 1

    for q in questions:
        if q.get("type") not in ("single", "multi"):
            continue
        opts = q.get("options") or []
        if len(opts) < 3:
            continue
        if (q.get("meta") or {}).get("optperm"):
            skipped += 1
            continue
        if REF.search(q.get("exp") or "") or REF.search(q.get("ref") or ""):
            refused.append(q.get("qid"))
            continue

        n = len(opts)
        if q["type"] == "single":
            cur = q["answer"][0]
            # 选当前用得最少的落点，同票按 PREF 顺序
            target = min(range(n), key=lambda i: (counts[i], PREF.index(i) if i < 4 else 9))
            if target != cur:
                opts[cur], opts[target] = opts[target], opts[cur]
                q["answer"] = [target]
            counts[target] += 1
        else:
            k = ROT[changed % len(ROT)] % n
            if k:
                q["options"] = opts[k:] + opts[:k]
                q["answer"] = sorted((a - k) % n for a in q["answer"])
            for a in q["answer"]:
                counts[a] += 1

        q.setdefault("meta", {})["optperm"] = True
        changed += 1

    return counts, changed, skipped, refused


def main(argv):
    dry = "--dry" in argv
    files = [a for a in argv[1:] if not a.startswith("--")]
    if not files:
        print(__doc__)
        return 2
    rc = 0
    for path in files:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
        qs = doc.get("questions") or []
        counts, changed, skipped, refused = rebalance(qs, dry)
        total = sum(counts) or 1
        dist = " ".join(f"{'ABCD'[i]} {counts[i] / total:.0%}" for i in range(4))
        print(f"{path}: 重排 {changed} 题（已重排跳过 {skipped}）｜答案位置 {dist}")
        if refused:
            rc = 1
            print("  ✗ 下列题的解析引用了选项字母，换序会指错，需先改成选项文字：")
            for qid in refused:
                print("    ·", qid)
        if not dry:
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(doc, fh, ensure_ascii=False, indent=1)
                fh.write("\n")
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv))
