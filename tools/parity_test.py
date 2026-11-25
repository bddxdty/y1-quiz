#!/usr/bin/env python3
"""跨语言一致性检查：Python 校验门 ↔ 浏览器内核。

规范 2.3 要求「Node 与浏览器各一份，必须逐题比对一致」。这里比对三件事：
  1. 每道题的 gid
  2. 每个作用域的导出码字符串
  3. 导出码解码回来的作答记录

用法：python3 tools/parity_test.py [collectionId]
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import qb_gate  # noqa: E402
import qb_build  # noqa: E402

# 与构建器共用同一套 Node 定位逻辑（QB_NODE 环境变量 > 托管运行时目录 > PATH）
NODE = qb_build.NODE


def build_def(site: qb_gate.Site) -> dict:
    units = []
    for s in site.subjects:
        for u in s["units"]:
            qs = [q for q in s["questions"] if q["_unit"] == u["key"]]
            units.append({
                "key": u["key"], "label": u["label"], "title": u["title"],
                "desc": u.get("desc", ""),
                "questions": [{k: v for k, v in q.items() if not k.startswith("_")} for q in qs],
            })
    s0 = site.subjects[0]
    return {
        "title": "parity",
        "subjectKey": s0["key"],
        "subjectName": s0["config"].get("name", ""),
        "types": site.types_of(s0),
        "units": units,
        "wrong": s0["config"].get("wrong") or {"exitStreak": 1},
        "mastery": s0["config"].get("mastery") or {},
        "codec": site.config.get("codec"),
        "order": site.order,
        "retired": sorted(site.retired),
        "storePrefix": "qb.site",
    }


def encode_ref(site, kind, key, state, texts, favs):
    """参考编码器：与 qb_gate.encode_v10 同构，但作用域内 gid 去重。

    校验门的 scope_gids 会把跨题组副本各算一次（669 个位置里只有 663 个不同 gid），
    同一 gid 因此占两个位图槽位。gid 是题目身份，一个身份只应占一位，故以内核的去重
    口径为参考。无副本的作用域两者逐字节相同，测试里会同时验证这一点。
    """
    import base64
    gids, seen = [], set()
    for g in qb_gate.scope_gids(site, kind, key):
        if g not in seen:
            seen.add(g)
            gids.append(g)
    q_of = {q["_gid"]: q for q in site.questions}
    decls = qb_gate.decl_map(site)
    used = sorted({q_of[g]["type"] for g in gids if g in q_of})
    widths = {t: qb_gate.mask_width(decls.get(t) or {}) for t in used}

    n = len(gids)
    blen = (n + 7) // 8
    ans_bits = bytearray(blen)
    fav_bits = bytearray(blen)
    txt_bits = bytearray(blen)
    stream = qb_gate.BitWriter()
    blobs = []

    for i, gid in enumerate(gids):
        rec = state.get(gid)
        if rec is None:
            continue
        ans_bits[i >> 3] |= 1 << (i & 7)
        if gid in favs:
            fav_bits[i >> 3] |= 1 << (i & 7)
        stream.put(1 if rec["ok"] else 2, 2)
        w = widths.get((q_of.get(gid) or {}).get("type"), 0)
        mask = 0
        for k in rec.get("picked") or []:
            if 0 <= k < w:
                mask |= 1 << k
        if w:
            stream.put(mask, w)
        blob = texts.get(gid)
        if blob:
            raw = blob.encode("utf-8")[:255]
            txt_bits[i >> 3] |= 1 << (i & 7)
            blobs.append(raw)

    head = bytearray([10])
    head.append((1 if any(widths.values()) else 0) | (2 if blobs else 0))
    head.append({"site": 0, "subject": 1, "unit": 2}[kind])
    kb = ("" if kind == "site" else key).encode("utf-8")
    head.append(len(kb))
    head += kb
    head.append(len(widths))
    for t in used:
        tb = t.encode("utf-8")
        head.append(len(tb))
        head += tb
        head.append(widths[t])
    head += n.to_bytes(2, "big")
    head += ans_bits + fav_bits + txt_bits
    head += stream.finish()
    for blob in blobs:
        head.append(len(blob))
        head += blob
    return "10:" + base64.urlsafe_b64encode(bytes(head)).decode("ascii").rstrip("=")


def main():
    col = sys.argv[1] if len(sys.argv) > 1 else "cs"
    root = ROOT / "collections" / col
    site = qb_gate.Site(root)
    defn = build_def(site)

    # 构造一份确定的作答状态：全对，选择题记正确项，填空题写首个答案
    state, texts, favs = {}, {}, set()
    decls = qb_gate.decl_map(site)
    for i, q in enumerate(site.questions):
        g = q["_gid"]
        if g in state:
            continue
        decl = decls.get(q.get("type")) or {}
        picked = list(q.get("answer") or []) if decl.get("answerShape") == "choice" else []
        state[g] = {"ok": True, "picked": picked}
        if decl.get("answerShape") == "tokenList" and q.get("answers"):
            texts[g] = str(q["answers"][0])[:24]
        if i % 7 == 0:
            favs.add(g)

    scopes = [["subject", site.subjects[0]["key"]]]
    for s in site.subjects:
        for u in s["units"]:
            scopes.append(["unit", u["key"]])

    # Node 侧：内核记录用规范 3.2 的短键（p / x），与浏览器里落库的形态一致
    js_state = {}
    for g, r in state.items():
        rec = {"ok": r["ok"], "at": 1, "p": r.get("picked") or []}
        if g in texts:
            rec["x"] = texts[g]
        js_state[g] = rec
    payload = {"def": defn, "state": js_state,
               "favs": {g: 1 for g in sorted(favs)}, "scopes": scopes}

    proc = subprocess.run(
        [NODE, str(HERE / "parity_node.js"), str(ROOT / "packages" / "qb-core" / "qb-core.js")],
        input=json.dumps(payload).encode("utf-8"), capture_output=True)
    if proc.returncode != 0:
        print("Node 侧执行失败：")
        print(proc.stderr.decode("utf-8")[:2000])
        return 2
    out = json.loads(proc.stdout.decode("utf-8"))

    # 1. gid 逐题比对
    bad_gid = [(q["qid"], q["_gid"], out["gids"].get(q["qid"]))
               for q in site.questions if out["gids"].get(q["qid"]) != q["_gid"]]
    print(f"gid 比对：{len(site.questions)} 题，不一致 {len(bad_gid)} 题")
    for row in bad_gid[:5]:
        print(f"  ✗ {row[0]}  py={row[1]}  js={row[2]}")

    # 2. 导出码字符串比对（对去重参考实现）
    bad_code, size_rows = [], []
    for kind, key in scopes:
        ref = encode_ref(site, kind, key, state, texts, favs)
        js_code = out["codes"].get(f"{kind}:{key}")
        size_rows.append((kind, key, len(ref)))
        if ref != js_code:
            bad_code.append((kind, key, len(ref), len(js_code or ""), ref, js_code or ""))
    print(f"导出码比对：{len(scopes)} 个作用域，不一致 {len(bad_code)} 个")
    for kind, key, a, b, ref, got in bad_code[:3]:
        print(f"  ✗ {kind}:{key}  py={a}B js={b}B")
        print(f"     py={ref[:80]}")
        print(f"     js={got[:80]}")

    # 3. 参考编码器与校验门编码器：无副本的作用域必须逐字节相同
    drift = []
    for kind, key in scopes:
        raw = qb_gate.scope_gids(site, kind, key)
        if len(set(raw)) == len(raw):
            if encode_ref(site, kind, key, state, texts, favs) != qb_gate.encode_v10(
                    site, kind, key, state, texts, favs):
                drift.append(f"{kind}:{key}")
    print(f"参考编码器与校验门比对（仅无副本作用域）：{len(scopes)} 个作用域，漂移 {len(drift)} 个"
          + (f"（{', '.join(drift)}）" if drift else ""))

    print()
    for kind, key, n in size_rows:
        print(f"  {kind}:{key:<8} {n:>6} 字节")
    ok = not bad_gid and not bad_code and not drift
    print("\n结论：" + ("一致 ✓" if ok else "存在差异 ✗"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
