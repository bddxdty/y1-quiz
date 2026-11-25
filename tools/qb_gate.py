#!/usr/bin/env python3
"""多科目题库构建校验门。

用法：
    python qb_gate.py gid <站点根目录> [--json]
    python qb_gate.py check <站点根目录> [--json]
    python qb_gate.py roundtrip <站点根目录> [--scope site|subject|unit]

只读：不写文件、不联网、不启动子进程、不读环境变量。
退出码 0 = 通过；1 = 有硬失败；2 = 用法或读取错误。
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import sys
from pathlib import Path

U1 = "\u0001"
U2 = "\u0002"

SUBJECT_RE = re.compile(r"^[a-z][a-z0-9]{1,11}$")
UNIT_RE = re.compile(r"^[a-z][a-z0-9]{0,7}$")
QID_RE = re.compile(r"^([a-z][a-z0-9]{1,11})\.([a-z][a-z0-9]{0,7})-([0-9]{2,4})$")
TYPE_RE = re.compile(r"^[a-z][a-z0-9_]{1,15}$")
GID_RE = re.compile(r"^g(?:[0-9a-f]{8}|[0-9a-f]{16})$")

DEFAULT_MASTERY = {
    "wAll": 0.4, "wRecent": 0.6, "recentN": 5,
    "weakBelow": 60, "solidAt": 85, "solidStreak": 4,
    "passMinQ": 4, "passRate": 0.9, "dueDays": [1, 3, 7],
}
DROP = set("（）()［］【】，,。．")
CODE_LIMIT = 6000
TEXT_STEPS = (32, 24, 16, 8, 4, 0)


class GateError(Exception):
    """读取或结构错误，退出码 2。"""


# ---------------------------------------------------------------- 指纹

def fp_norm(value) -> str:
    """指纹专用规范化：删空白、删括号与逗号句号。大小写敏感。"""
    text = "" if value is None else str(value)
    text = re.sub(r"\s+", "", text)
    return "".join(ch for ch in text if ch not in DROP)


def _utf16_units(text: str):
    """按 UTF-16 码元产出整数，与 JavaScript 的 charCodeAt 对齐。"""
    raw = text.encode("utf-16-le")
    for i in range(0, len(raw), 2):
        yield raw[i] | (raw[i + 1] << 8)


def _utf16_slice(text: str, n: int) -> str:
    """按 UTF-16 码元截断，不截出半个代理对。"""
    raw = text.encode("utf-16-le")
    if len(raw) <= n * 2:
        return text
    return raw[: n * 2].decode("utf-16-le", "ignore")


def fnv1a32(text: str, init: int = 0x811C9DC5) -> int:
    h = init
    for unit in _utf16_units(text):
        h ^= unit
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def fingerprint(q: dict, bits: int = 32) -> str:
    base = str(q.get("type") or "") + U1 + fp_norm(q.get("stem"))
    options = q.get("options")
    answers = q.get("answers")
    if options is not None:
        extra = U1.join(sorted(fp_norm(x) for x in options))
    elif answers is not None:
        extra = U1.join(sorted(fp_norm(x) for x in answers))
    else:
        extra = _utf16_slice(fp_norm(q.get("ref")), 80)
    seed = base + U2 + extra
    if bits == 64:
        return "g" + format(fnv1a32(seed), "08x") + format(fnv1a32(seed, 0x01000193), "08x")
    return "g" + format(fnv1a32(seed), "08x")


def content_key(q: dict) -> str:
    """同一 gid 的两份副本必须逐位相同，用这个串比较。"""
    return json.dumps(
        {
            "type": q.get("type"),
            "stem": fp_norm(q.get("stem")),
            "options": q.get("options"),
            "answer": q.get("answer"),
            "answers": q.get("answers"),
        },
        ensure_ascii=False,
        sort_keys=True,
    )


# ---------------------------------------------------------------- 载入

class Site:
    def __init__(self, root: Path):
        self.root = root
        self.config = self._read(root / "site.config.json")
        self.bits = int(self.config.get("codec", {}).get("gidBits", 32))
        self.budget = int(self.config.get("codec", {}).get("budgetBytes", CODE_LIMIT))
        self.subjects = []
        self.questions = []
        self.by_gid = {}
        self.order = []
        self.retired = set()
        self._load()

    @staticmethod
    def _read(path: Path):
        if not path.exists():
            raise GateError(f"找不到 {path}")
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise GateError(f"{path} 不是合法 JSON：{exc}") from exc

    def _load(self):
        index = self.root / "subjects" / "_index" / "gids.json"
        if index.exists():
            data = self._read(index)
            self.order = list(data.get("order") or [])
            self.retired = set(data.get("retired") or [])

        for entry in self.config.get("subjects") or []:
            key = entry.get("key")
            if not key:
                raise GateError("site.config.json 有科目缺少 key")
            sdir = self.root / "subjects" / key
            scfg = self._read(sdir / "subject.config.json")
            tpack = self._read(sdir / "typepack.json")
            subject = {
                "key": key, "entry": entry, "dir": sdir,
                "config": scfg, "typepack": tpack,
                "units": [], "questions": [],
            }
            for unit in scfg.get("units") or []:
                bank_rel = unit.get("bank") or f"bank/{unit.get('key')}.json"
                bank = self._read(sdir / bank_rel)
                for q in bank.get("questions") or []:
                    q["_subject"] = key
                    q["_unit"] = unit.get("key")
                    q["_gid"] = fingerprint(q, self.bits)
                    subject["questions"].append(q)
                    self.questions.append(q)
                subject["units"].append(unit)
            self.subjects.append(subject)
            for q in subject["questions"]:
                self.by_gid.setdefault(q["_gid"], []).append(q)

    def subject_of(self, key):
        for s in self.subjects:
            if s["key"] == key:
                return s
        return None

    def types_of(self, subject) -> dict:
        return subject["typepack"].get("types") or {}


# ---------------------------------------------------------------- 硬失败

def run_check(site: Site):
    fails, warns = [], []

    def bad(code, msg):
        fails.append((code, msg))

    def warn(msg):
        warns.append(msg)

    # G1 配置结构
    cfg = site.config
    if not isinstance(cfg.get("version"), int):
        bad("G1", "site.config.json 缺少整数 version")
    if not (cfg.get("site") or {}).get("title"):
        bad("G1", "site.config.json 缺少 site.title")
    if not site.subjects:
        bad("G1", "site.config.json 没有声明任何科目")
    codec = cfg.get("codec") or {}
    if codec.get("version") != 10:
        bad("G1", f"codec.version 应为 10，实际 {codec.get('version')!r}")
    if site.bits not in (32, 64):
        bad("G1", f"codec.gidBits 应为 32 或 64，实际 {site.bits}")
    default = (cfg.get("site") or {}).get("defaultSubject")
    if default and not site.subject_of(default):
        bad("G1", f"site.defaultSubject={default!r} 不在科目清单中")

    # G2 键语法与唯一性
    seen_subject = set()
    for s in site.subjects:
        if not SUBJECT_RE.match(s["key"]):
            bad("G2", f"subjectKey 不合语法：{s['key']!r}")
        if s["key"] in seen_subject:
            bad("G2", f"subjectKey 重复：{s['key']}")
        seen_subject.add(s["key"])

        if not (s["config"].get("name") or "").strip():
            bad("G1", f"科目 {s['key']} 缺少 name")
        if s["config"].get("key") != s["key"]:
            bad("G1", f"科目 {s['key']} 的 subject.config.json key 不一致")

        seen_unit = set()
        for u in s["units"]:
            uk = u.get("key")
            if not isinstance(uk, str) or not UNIT_RE.match(uk):
                bad("G2", f"科目 {s['key']} 的 unitKey 不合语法：{uk!r}")
                continue
            if uk in seen_unit:
                bad("G2", f"科目 {s['key']} 的 unitKey 重复：{uk}")
            seen_unit.add(uk)
            for field in ("label", "title"):
                if not str(u.get(field) or "").strip():
                    bad("G1", f"题组 {s['key']}.{uk} 缺少 {field}")
            if not isinstance(u.get("order"), int):
                bad("G1", f"题组 {s['key']}.{uk} 缺少整数 order")

        orders = [u.get("order") for u in s["units"] if isinstance(u.get("order"), int)]
        if orders and len(set(orders)) != len(orders):
            bad("G1", f"科目 {s['key']} 的题组 order 有重复")

    seen_qid = {}
    for q in site.questions:
        qid = q.get("qid")
        if not isinstance(qid, str):
            bad("G2", f"{q['_subject']}/{q['_unit']} 有题目缺少 qid")
            continue
        m = QID_RE.match(qid)
        if not m:
            bad("G2", f"qid 不合语法：{qid!r}")
            continue
        if m.group(1) != q["_subject"]:
            bad("G2", f"qid {qid} 的科目前缀与所在科目 {q['_subject']} 不一致")
        if m.group(2) != q["_unit"]:
            bad("G2", f"qid {qid} 的题组键与所在题组 {q['_unit']} 不一致")
        if qid in seen_qid:
            bad("G2", f"qid 重复：{qid}")
        seen_qid[qid] = q

    # G3 题型已注册
    decl_sig = {}
    for s in site.subjects:
        types = site.types_of(s)
        for tname, decl in types.items():
            if not TYPE_RE.match(tname):
                bad("G3", f"题型键不合语法：{tname!r}")
            for field in ("label", "answerShape", "judge", "replay", "fault", "countsInMastery"):
                if field not in decl:
                    bad("G3", f"题型 {tname} 缺少声明字段 {field}")
            if decl.get("replay") == "mask" and not isinstance(decl.get("maxOptions"), int):
                bad("G3", f"题型 {tname} 声明 replay=mask 但缺少整数 maxOptions")
            sig = json.dumps(
                {k: decl.get(k) for k in ("answerShape", "judge", "replay",
                                          "maxOptions", "fault", "countsInMastery", "fields")},
                ensure_ascii=False, sort_keys=True)
            if tname in decl_sig and decl_sig[tname][1] != sig:
                bad("G3", f"题型 {tname} 在科目 {decl_sig[tname][0]} 与 {s['key']} 的声明不一致"
                          "（题型键全站唯一，同一键必须同义；选项数上界取全站最大值）")
            else:
                decl_sig.setdefault(tname, (s["key"], sig))
        for q in s["questions"]:
            if q.get("type") not in types:
                bad("G3", f"{q.get('qid')} 的题型 {q.get('type')!r} 未在 typepack 注册")

    # G4 字段完整与取值
    for s in site.subjects:
        types = site.types_of(s)
        for q in s["questions"]:
            qid = q.get("qid") or f"{s['key']}/{q['_unit']}"
            decl = types.get(q.get("type")) or {}
            for field in ("stem", "topic", "diff", "exp"):
                if not str(q.get(field) or "").strip():
                    bad("G4", f"{qid} 缺少 {field}")
            for required in (decl.get("fields") or {}):
                if q.get(required) in (None, "", []):
                    bad("G4", f"{qid} 缺少题型 {decl.get('label')} 要求的字段 {required}")

            shape = decl.get("answerShape")
            judge = decl.get("judge")
            if shape == "choice":
                options = q.get("options")
                if not isinstance(options, list) or len(options) < 2:
                    bad("G4", f"{qid} 选项少于 2 个")
                    continue
                if any(not str(o).strip() for o in options):
                    bad("G4", f"{qid} 存在空选项")
                if len({str(o) for o in options}) != len(options):
                    bad("G4", f"{qid} 选项文本重复")
                cap = decl.get("maxOptions")
                if decl.get("replay") == "mask" and isinstance(cap, int) and len(options) > cap:
                    bad("G4", f"{qid} 选项 {len(options)} 个，超过 maxOptions={cap}")
                answer = q.get("answer")
                if not isinstance(answer, list) or not answer:
                    bad("G4", f"{qid} 缺少 answer")
                    continue
                if any(not isinstance(k, int) or k < 0 or k >= len(options) for k in answer):
                    bad("G4", f"{qid} 的 answer 下标越界")
                if len(set(answer)) != len(answer):
                    bad("G4", f"{qid} 的 answer 有重复下标")
                if judge == "exact" and len(answer) != 1:
                    bad("G4", f"{qid} 为单答案题型，answer 却有 {len(answer)} 项")
                if judge == "set" and len(answer) < 2:
                    bad("G4", f"{qid} 为多答案题型，answer 少于 2 项")
            elif shape == "tokenList":
                answers = q.get("answers")
                if not isinstance(answers, list) or not answers:
                    bad("G4", f"{qid} 缺少 answers")
                elif any(not str(a).strip() for a in answers):
                    bad("G4", f"{qid} 的 answers 存在空项")
            elif shape in ("text", "structured"):
                if judge in ("rubric", "external") and not str(q.get("ref") or "").strip():
                    bad("G4", f"{qid} 缺少参考答案 ref")

    # G5 / G6 指纹冲突与副本一致性
    for gid, group in site.by_gid.items():
        if len(group) < 2:
            continue
        base = content_key(group[0])
        for other in group[1:]:
            if content_key(other) != base:
                bad("G5", f"同一 gid {gid} 对应不同内容：{group[0].get('qid')} 与 {other.get('qid')}"
                           "（副本必须选项、答案逐位相同，否则作答记录会串位）")
                break

    # G7 序列表一致性
    if site.order:
        if len(site.order) != len(set(site.order)):
            bad("G7", "gids.json 的 order 有重复项")
        if len(site.order) > 65535:
            bad("G7", f"gids.json 的 order 长度 {len(site.order)} 超过 65535")
        for gid in site.order:
            if not GID_RE.match(gid):
                bad("G7", f"gids.json 含非法 gid：{gid!r}")
        known = set(site.order)
        for gid in site.by_gid:
            if gid not in known:
                bad("G7", f"题目 gid {gid} 不在 gids.json 中（新增题目必须追加进序列表）")
        for gid in site.retired:
            if gid not in known:
                bad("G7", f"retired 中的 {gid} 不在 order 中（删题必须保留槽位）")
        live = set(site.by_gid)
        stale = [g for g in site.order if g not in live and g not in site.retired]
        if stale:
            warn(f"order 中有 {len(stale)} 个槽位既无题目也未标记 retired：{stale[:3]}")

        # 重排会让其后所有题的下标前移，旧导出码整段失效。集合相同但顺序变了，靠这条拦。
        pos = {g: i for i, g in enumerate(site.order)}
        for s in site.subjects:
            seen, seq = set(), []
            for q in s["questions"]:
                if q["_gid"] in seen or q["_gid"] not in pos:
                    continue
                seen.add(q["_gid"])
                seq.append(pos[q["_gid"]])
            if any(seq[i] >= seq[i + 1] for i in range(len(seq) - 1)):
                bad("G7", f"科目 {s['key']} 的题目在 order 中的相对顺序与题库顺序不一致"
                          "（order 只允许追加，禁止重排）")
    else:
        warn("没有 subjects/_index/gids.json，跳过序列表校验（首次构建前正常）")

    # G10 题组非空
    for s in site.subjects:
        for u in s["units"]:
            n = sum(1 for q in s["questions"] if q["_unit"] == u.get("key"))
            if not n:
                bad("G10", f"题组 {s['key']}.{u.get('key')} 没有题目")

    # G11 掌握度参数
    for s in site.subjects:
        m = dict(DEFAULT_MASTERY)
        m.update(s["config"].get("mastery") or {})
        if abs(float(m["wAll"]) + float(m["wRecent"]) - 1.0) > 1e-9:
            bad("G11", f"科目 {s['key']} 的 wAll + wRecent 不等于 1")
        if not (0 <= float(m["weakBelow"]) < float(m["solidAt"]) <= 100):
            bad("G11", f"科目 {s['key']} 的 weakBelow / solidAt 不满足 0 ≤ weakBelow < solidAt ≤ 100")
        if not (0 < float(m["passRate"]) <= 1):
            bad("G11", f"科目 {s['key']} 的 passRate 应在 (0, 1]")
        for field in ("recentN", "solidStreak", "passMinQ"):
            if int(m[field]) < 1:
                bad("G11", f"科目 {s['key']} 的 {field} 应 ≥ 1")
        days = m.get("dueDays") or []
        if not days or any(int(d) < 1 for d in days):
            bad("G11", f"科目 {s['key']} 的 dueDays 应为正整数列表")

    # 警告
    for s in site.subjects:
        types = site.types_of(s)
        picks = [q for q in s["questions"]
                 if (types.get(q.get("type")) or {}).get("answerShape") == "choice"
                 and (types.get(q.get("type")) or {}).get("judge") == "exact"
                 and len(q.get("options") or []) >= 3]
        if len(picks) >= 10:
            tally = {}
            for q in picks:
                tally[q["answer"][0]] = tally.get(q["answer"][0], 0) + 1
            top = max(tally.values()) / len(picks)
            if top > 0.4:
                warn(f"科目 {s['key']}：{len(picks)} 道单选里有 {top:.0%} 答案集中在同一个位置（阈值 40%）")

        bools = [q for q in s["questions"] if len(q.get("options") or []) == 2]
        if len(bools) >= 10:
            yes = sum(1 for q in bools if q.get("answer") and q["answer"][0] == 0) / len(bools)
            if yes > 0.7 or yes < 0.3:
                warn(f"科目 {s['key']}：{len(bools)} 道两选项题里答案为第一项的比例 {yes:.0%}，语义可能偏斜")

        multis = [q for q in s["questions"]
                  if (types.get(q.get("type")) or {}).get("judge") == "set"]
        if len(multis) >= 10:
            full = sum(1 for q in multis if len(q.get("answer") or []) == len(q.get("options") or []))
            if full / len(multis) > 0.5:
                warn(f"科目 {s['key']}：{full}/{len(multis)} 道多选的正确答案是全部选项（阈值 50%）")

        sizes = [sum(1 for q in s["questions"] if q["_unit"] == u.get("key")) for u in s["units"]]
        sizes = [n for n in sizes if n]
        if len(sizes) >= 2 and max(sizes) > min(sizes) * 10:
            warn(f"科目 {s['key']}：题组题量悬殊，最大 {max(sizes)} / 最小 {min(sizes)}")

    return fails, warns


# ---------------------------------------------------------------- 编码往返

class BitWriter:
    def __init__(self):
        self.buf = bytearray()
        self.cur = 0
        self.n = 0

    def put(self, value: int, width: int):
        for k in range(width - 1, -1, -1):
            self.cur = (self.cur << 1) | ((value >> k) & 1)
            self.n += 1
            if self.n == 8:
                self.buf.append(self.cur)
                self.cur = 0
                self.n = 0

    def finish(self) -> bytes:
        if self.n:
            self.buf.append((self.cur << (8 - self.n)) & 0xFF)
            self.cur = 0
            self.n = 0
        return bytes(self.buf)


class BitReader:
    def __init__(self, data: bytes, start_byte: int):
        self.data = data
        self.pos = start_byte * 8

    def read(self, width: int) -> int:
        value = 0
        for _ in range(width):
            idx = self.pos >> 3
            if idx >= len(self.data):
                raise GateError("编码不完整：位流提前结束")
            bit = 7 - (self.pos & 7)
            value = (value << 1) | ((self.data[idx] >> bit) & 1)
            self.pos += 1
        return value

    def bytes_used(self) -> int:
        return (self.pos + 7) // 8


def mask_width(decl: dict) -> int:
    if decl.get("replay") != "mask":
        return 0
    cap = int(decl.get("maxOptions") or 0)
    for step in (4, 8, 16):
        if cap <= step:
            return step
    return 0


def scope_gids(site: Site, kind: str, key: str):
    if kind == "site":
        return list(site.order) if site.order else [q["_gid"] for q in site.questions]
    if kind == "subject":
        return [q["_gid"] for q in site.questions if q["_subject"] == key]
    return [q["_gid"] for q in site.questions if q["_unit"] == key]


def encode_v10(site: Site, kind: str, key: str, state: dict, texts: dict, favs: set):
    gids = scope_gids(site, kind, key)
    if not gids:
        raise GateError(f"作用域 {kind}:{key} 内没有题目")
    q_of = {q["_gid"]: q for q in site.questions}
    decls = {}
    for s in site.subjects:
        for tname, decl in site.types_of(s).items():
            decls.setdefault(tname, decl)
    used = sorted({q_of[g]["type"] for g in gids if g in q_of})
    widths = {t: mask_width(decls.get(t) or {}) for t in used}

    n = len(gids)
    blen = (n + 7) // 8
    ans_bits = bytearray(blen)
    fav_bits = bytearray(blen)
    txt_bits = bytearray(blen)

    stream = BitWriter()
    text_blobs = []
    for i, gid in enumerate(gids):
        q = q_of.get(gid)
        rec = state.get(gid)
        if rec is None:
            continue
        ans_bits[i >> 3] |= 1 << (i & 7)
        if gid in favs:
            fav_bits[i >> 3] |= 1 << (i & 7)
        stream.put(1 if rec["ok"] else 2, 2)
        w = widths.get((q or {}).get("type"), 0)
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
            text_blobs.append(raw)

    head = bytearray()
    head.append(10)
    head.append((1 if any(widths.values()) else 0) | (2 if text_blobs else 0))
    scope_kind = {"site": 0, "subject": 1, "unit": 2}[kind]
    head.append(scope_kind)
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
    for blob in text_blobs:
        head.append(len(blob))
        head += blob
    return "10:" + base64.urlsafe_b64encode(bytes(head)).decode("ascii").rstrip("=")


def decode_v10(code: str):
    if not code.startswith("10:"):
        raise GateError("不是 v10 编码")
    raw = code[3:]
    raw += "=" * (-len(raw) % 4)
    data = base64.urlsafe_b64decode(raw.encode("ascii"))
    if len(data) < 6 or data[0] != 10:
        raise GateError("编码头损坏")
    pos = 1
    pos += 1  # flags
    kind_id = data[pos]
    pos += 1
    klen = data[pos]
    pos += 1
    key = data[pos:pos + klen].decode("utf-8")
    pos += klen
    tcount = data[pos]
    pos += 1
    widths = {}
    for _ in range(tcount):
        kl = data[pos]
        pos += 1
        name = data[pos:pos + kl].decode("utf-8")
        pos += kl
        widths[name] = data[pos]
        pos += 1
    total = int.from_bytes(data[pos:pos + 2], "big")
    pos += 2
    blen = (total + 7) // 8
    ans_bits = data[pos:pos + blen]
    pos += blen
    fav_bits = data[pos:pos + blen]
    pos += blen
    txt_bits = data[pos:pos + blen]
    pos += blen
    return {
        "kind": kind_id, "key": key, "widths": widths, "total": total,
        "ans": ans_bits, "fav": fav_bits, "txt": txt_bits,
        "stream_at": pos, "raw": bytes(data),
    }


def decl_map(site: Site) -> dict:
    out = {}
    for s in site.subjects:
        for tname, decl in site.types_of(s).items():
            out.setdefault(tname, decl)
    return out


def decode_state(site: Site, code: str, kind: str, key: str):
    head = decode_v10(code)
    gids = scope_gids(site, kind, key)
    if len(gids) != head["total"]:
        raise GateError(f"编码内 gid 数 {head['total']} 与本地作用域 {len(gids)} 不一致")
    q_of = {q["_gid"]: q for q in site.questions}
    decls = decl_map(site)
    reader = BitReader(head["raw"], head["stream_at"])

    state, texts, favs = {}, {}, set()
    for i, gid in enumerate(gids):
        if head["fav"][i >> 3] & (1 << (i & 7)):
            favs.add(gid)
        if not (head["ans"][i >> 3] & (1 << (i & 7))):
            continue
        okc = reader.read(2)
        w = head["widths"].get((q_of.get(gid) or {}).get("type"), 0)
        mask = reader.read(w) if w else 0
        state[gid] = {"ok": okc == 1, "picked": [k for k in range(w) if mask & (1 << k)] if w else []}

    tpos = reader.bytes_used()
    for i, gid in enumerate(gids):
        if not (head["txt"][i >> 3] & (1 << (i & 7))):
            continue
        if tpos >= len(head["raw"]):
            raise GateError("文字段提前结束")
        ln = head["raw"][tpos]
        tpos += 1
        texts[gid] = head["raw"][tpos:tpos + ln].decode("utf-8")
        tpos += ln
    return state, texts, favs


def run_roundtrip(site: Site, scope: str):
    fails = []
    targets = []
    if scope == "site":
        targets.append(("site", ""))
    elif scope == "subject":
        for s in site.subjects:
            targets.append(("subject", s["key"]))
    else:
        for s in site.subjects:
            for u in s["units"]:
                targets.append(("unit", u.get("key")))

    reports = []
    decls = decl_map(site)
    q_of = {q["_gid"]: q for q in site.questions}
    for kind, key in targets:
        gids = scope_gids(site, kind, key)
        if not gids:
            continue
        state, texts, favs = {}, {}, set()
        for i, gid in enumerate(gids):
            q = q_of.get(gid) or {}
            decl = decls.get(q.get("type")) or {}
            picked = []
            if decl.get("answerShape") == "choice" and q.get("answer"):
                picked = [q["answer"][0]]
            state[gid] = {"ok": True, "picked": picked}
            if decl.get("answerShape") == "tokenList" and q.get("answers"):
                texts[gid] = str(q["answers"][0])[:24]
            if i % 3 == 0:
                favs.add(gid)
        code = encode_v10(site, kind, key, state, texts, favs)
        size = len(code.encode("utf-8"))
        back_state, back_texts, back_favs = decode_state(site, code, kind, key)
        if back_state != state:
            fails.append(("G8", f"{kind}:{key} 往返后作答记录不一致"))
        if back_texts != texts:
            fails.append(("G8", f"{kind}:{key} 往返后文字段不一致"))
        if back_favs != favs:
            fails.append(("G8", f"{kind}:{key} 往返后收藏集合不一致"))
        if size > site.budget:
            fails.append(("G9", f"{kind}:{key} 编码 {size} 字节，超过预算 {site.budget}"))
        reports.append((kind, key, len(gids), size))
    return fails, reports


# ---------------------------------------------------------------- 入口

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="多科目题库构建校验门")
    parser.add_argument("command", choices=("gid", "check", "roundtrip"))
    parser.add_argument("root", help="站点根目录（含 site.config.json）")
    parser.add_argument("--scope", default="subject", choices=("site", "subject", "unit"))
    parser.add_argument("--json", action="store_true", help="以 JSON 输出结果")
    args = parser.parse_args(argv)

    try:
        site = Site(Path(args.root).expanduser().resolve())
    except GateError as exc:
        print(f"✗ {exc}", file=sys.stderr)
        return 2

    if args.command == "gid":
        rows = [{"qid": q.get("qid"), "gid": q["_gid"], "type": q.get("type")}
                for q in site.questions]
        groups = {}
        for q in site.questions:
            groups.setdefault(q["_gid"], []).append(q)
        conflicts = []
        for gid, group in groups.items():
            if len(group) > 1:
                base = content_key(group[0])
                if any(content_key(o) != base for o in group[1:]):
                    conflicts.append({"gid": gid, "qids": [q.get("qid") for q in group]})
        if args.json:
            print(json.dumps({"questions": rows, "conflicts": conflicts}, ensure_ascii=False, indent=2))
        else:
            for row in rows:
                print(f"{row['gid']}  {row['qid']}  {row['type']}")
            print(f"\n题量 {len(rows)}｜唯一 gid {len(groups)}｜副本 {len(rows) - len(groups)} 条")
            for item in conflicts:
                print(f"✗ gid {item['gid']} 内容不一致：{' / '.join(map(str, item['qids']))}")
        return 1 if conflicts else 0

    if args.command == "check":
        fails, warns = run_check(site)
        if args.json:
            print(json.dumps(
                {"failures": [{"code": c, "message": m} for c, m in fails], "warnings": warns},
                ensure_ascii=False, indent=2))
        else:
            for code, msg in fails:
                print(f"✗ {code}  {msg}")
            for msg in warns:
                print(f"⚠ {msg}")
            print(f"\n硬失败 {len(fails)} 项｜告警 {len(warns)} 项｜题量 {len(site.questions)}")
        return 1 if fails else 0

    fails, reports = run_roundtrip(site, args.scope)
    if args.json:
        print(json.dumps({"failures": [{"code": c, "message": m} for c, m in fails],
                          "scopes": [{"kind": k, "key": v, "gids": n, "bytes": b}
                                     for k, v, n, b in reports]}, ensure_ascii=False, indent=2))
    else:
        for kind, key, n, size in reports:
            print(f"{kind}:{key or '-'}  {n} 个 gid  {size} 字节  预算 {site.budget}")
        for code, msg in fails:
            print(f"✗ {code}  {msg}")
        print(f"\n往返失败 {len(fails)} 项｜作用域 {len(reports)} 个")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
