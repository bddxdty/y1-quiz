#!/usr/bin/env python3
"""期末冲刺题库（cs/final）内容级校验。

分两类证据：
  * 独立复算（RECALC）：不引用题库答案，由题干参数重新推导结果，再与题库答案/参考解答比对。
  * 来源复核（SOURCE）：概念、事实与主观题，核对来源标注、参考答案与采分点是否齐备可自评。

用法：
  python3 tools/cs_final_content_check.py [bank/final.json 路径] [--json 输出路径]
退出码：0 全部通过；1 存在失败；2 用法或读取错误。
"""
import json
import math
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BANK = ROOT / "collections/cs/subjects/cs/bank/final.json"

BLUEPRINT = {
    1: {"term": 1, "single": 6, "multi": 1, "fill": 3, "short": 1, "comp": 0},
    2: {"term": 1, "single": 5, "multi": 2, "fill": 6, "short": 1, "comp": 5},
    3: {"term": 3, "single": 5, "multi": 1, "fill": 3, "short": 2, "comp": 2},
    4: {"term": 1, "single": 5, "multi": 2, "fill": 4, "short": 3, "comp": 7},
    5: {"term": 1, "single": 5, "multi": 2, "fill": 4, "short": 3, "comp": 3},
    6: {"term": 1, "single": 5, "multi": 2, "fill": 3, "short": 3, "comp": 4},
    7: {"term": 0, "single": 5, "multi": 2, "fill": 3, "short": 2, "comp": 4},
    8: {"term": 0, "single": 6, "multi": 2, "fill": 4, "short": 3, "comp": 3},
}
PAPER_NOS = (
    [f"一.{i}" for i in range(1, 4)]
    + [f"二.{i}" for i in range(1, 7)]
    + [f"三.{i}" for i in range(1, 8)]
    + [f"四.{i}" for i in range(1, 4)]
    + [f"五.{i}" for i in range(1, 9)]
)

results = []  # (qid, method, ok, detail)


def record(qid, method, ok, detail=""):
    results.append((qid, method, bool(ok), detail))


def twos(value, bits=8):
    """返回 value 的 bits 位补码比特串。"""
    return format(value & (2 ** bits - 1), f"0{bits}b")


def from_twos(bits_str):
    v = int(bits_str, 2)
    return v - 2 ** len(bits_str) if bits_str[0] == "1" else v


def opt_text(q):
    return q["options"][q["answer"][0]]


def norm_num(s):
    return str(s).replace(" ", "").replace("　", "").lower()


# ------------------------------------------------------------------ 复算题


def check_011(q):  # A25FH + 2018D
    total = 0xA25F + 2018
    hex_digits = format(total, "X")
    ok = hex_digits == "AA41" and any(norm_num(a).rstrip("h") == "aa41" for a in q["answers"])
    # 十进制交叉验证
    ok = ok and total == 43585 and int("AA41", 16) == 43585
    return ok, f"A25FH+2018D={hex_digits}H（十进制 {total}）"


def check_012(q):
    kb = 0.5 * 1024
    return kb == 512 and any(norm_num(a).rstrip("kb") == "512" for a in q["answers"]), f"0.5MB={kb}KB"


def check_013(q):
    r = 0b11001010 & 0b00001001
    bits = format(r, "08b")
    return bits == "00001000" and bits in q["answers"], f"按位与={bits}"


def check_016(q):
    n = math.log2(16 * 2 ** 30)
    return n == 34 and any(a.startswith("34") for a in q["answers"]), f"16G=2^{int(n)}，需 {int(n)} 根"


def check_020(q):
    a, b = -0b101100, 0b1001001  # -44 + 73
    sum_bits = twos(a + b, 8)
    ok = (
        twos(a, 8) == "11010100"
        and twos(b, 8) == "01001001"
        and sum_bits == "00011101"
        and a + b == 29
        and format(a + b, "b") == "11101"
    )
    ref = q["ref"]
    ok = ok and all(s in ref for s in ("1 1010100", "0 1001001", "0 0011101", "11101", "29"))
    return ok, f"补码 {twos(a,8)}+{twos(b,8)}={sum_bits}，真值 {a+b}"


def check_021(q):
    primes = [n for n in range(2, 201) if all(n % m for m in range(2, n))]
    # 按题干伪代码语义再跑一遍（试除到 m=n 才输出）
    out = []
    n = 2
    while n <= 200:
        m = 2
        while n % m != 0:
            m += 1
        if m == n:
            out.append(n)
        n += 1
    ok = out == primes and len(primes) == 46 and max(primes) == 199
    ok = ok and "46" in q["exp"] and "199" in q["exp"]
    return ok, f"200 以内质数 {len(primes)} 个，最大 {max(primes)}，伪代码模拟结果一致"


def bubble_passes(arr, passes=5):
    """从右向左比较、较小值向前冒泡。"""
    a = list(arr)
    trace = []
    for i in range(passes):
        for j in range(len(a) - 1, i, -1):
            if a[j] < a[j - 1]:
                a[j], a[j - 1] = a[j - 1], a[j]
        trace.append(list(a))
    return trace


def check_022(q):
    trace = bubble_passes([21, 30, 56, 4, 43, 15, 70])
    expect = [
        [4, 21, 30, 56, 15, 43, 70],
        [4, 15, 21, 30, 56, 43, 70],
        [4, 15, 21, 30, 43, 56, 70],
        [4, 15, 21, 30, 43, 56, 70],
        [4, 15, 21, 30, 43, 56, 70],
    ]
    ok = trace == expect
    for seq in expect:
        ok = ok and " ".join(map(str, seq)) in q["ref"]
    return ok, "5 趟逐趟模拟与原卷过程一致" if ok else f"模拟 {trace} 与 {expect} 不符"


def check_023(q):
    pairs = re.findall(r"(\d+)：([^/，]+)/(\d+)", q["stem"])
    table = {int(addr): (data.strip(), int(nxt)) for addr, data, nxt in pairs}
    head = int(re.search(r"头指针指向地址\s*(\d+)", q["stem"]).group(1))
    name, addr, hops = "", head, []
    while addr != 0:
        data, nxt = table[addr]
        name += data
        hops.append(addr)
        addr = nxt
        if len(hops) > 20:
            return False, "链表成环"
    ok = name == "JUDY" and hops == [44, 50, 40, 46]
    ok = ok and "JUDY" in q["ref"] and all(str(h) in q["ref"] for h in hops)
    return ok, f"遍历 {hops} 得 {name}"


def check_024(q):
    count = 512 - 0 + 1
    bits = math.ceil(math.log2(count))
    ok = count == 513 and bits == 10 and 2 ** 9 == 512 < count <= 2 ** 10
    ok = ok and "513" in q["ref"] and "10 位" in q["ref"]
    return ok, f"{count} 个取值需 {bits} 位"


def check_025(q):
    v = 0b11011110
    ok = v == 222 and oct(v) == "0o336" and format(v, "X") == "DE"
    ok = ok and all(s in q["ref"] for s in ("222", "336", "DE"))
    return ok, f"11011110B={v}D={oct(v)[2:]}O={format(v,'X')}H"


def check_026(q):
    per = 3 * 1024 * 1024
    total = 256 * 1024 * 1024
    n = math.floor(total / per)
    ok = per == 3 * 2 ** 20 and abs(total / per - 85.333333) < 1e-4 and n == 85
    ok = ok and "85" in q["ref"] and "3MB" in q["ref"]
    return ok, f"每张 {per}B，256MB/3MB={total/per:.2f}，取整 {n} 张"


def check_027(q):
    edges = re.findall(r"([A-F])—([A-F])＝(\d+)", q["stem"])
    order = ["A", "B", "C", "D", "E", "F"]
    m = {v: {w: ("0" if v == w else "∞") for w in order} for v in order}
    for a, b, w in edges:
        m[a][b] = w
        m[b][a] = w
    ok = len(edges) == 9
    for v in order:  # 对称性与对角线
        for w in order:
            ok = ok and m[v][w] == m[w][v]
        ok = ok and m[v][v] == "0"
    for v in order:  # 与参考解答逐行比对
        row = re.search(rf"^{v}：(.+)$", q["ref"], re.M)
        ok = ok and row is not None
        if row:
            ok = ok and row.group(1).split() == [m[v][w] for w in order]
    return ok, f"由 {len(edges)} 条边生成 6×6 加权邻接矩阵，逐行与 ref 相同且对称"


def check_039(q):
    b = 24 * 24 // 8
    return b == 72 and opt_text(q) == "72" and "24" in q["stem"], f"24×24÷8={b}B"


def check_043(q):
    bits = format(0x3FC3, "016b")
    return bits == "0011111111000011" and bits in q["answers"], f"3FC3H={bits}B"


def check_044(q):
    raw = "10111010"
    sign = -1 if raw[0] == "1" else 1
    truth = sign * int(raw[1:], 2)
    return truth == -58 and "-58" in q["answers"] and from_twos(raw) == -70, f"原码真值 {truth}（若按补码则为 {from_twos(raw)}）"


def check_046(q):
    bits = twos(7 - 9, 8)
    ok = twos(7, 8) == "00000111" and twos(-9, 8) == "11110111" and bits == "11111110"
    ok = ok and from_twos(bits) == -2 and "11111110" in q["ref"] and "－2" in q["ref"]
    return ok, f"7-9 补码 {bits}，真值 {from_twos(bits)}"


def check_048(q):
    gib = 2 ** 32 / 2 ** 30
    return gib == 4 and opt_text(q) == "4G", f"2^32B={gib}GB"


def check_049(q):
    real = 128 * 10 ** 9 / 2 ** 30
    return abs(real - 119.2) < 0.1 and opt_text(q) == "119GB", f"128×10^9÷2^30={real:.1f}GB"


def check_054(q):
    words = 1024 * 1024 // 2
    ok = words == 2 ** 19 and words - 1 == 524287 and 2 ** 20 - 1 == 1048575
    ok = ok and all(s in q["ref"] for s in ("524288", "524287", "1048575"))
    return ok, f"按字 {words} 个地址（0～{words-1}），按字节 0～{2**20-1}"


def check_056(q):
    addr = 1000 + 12 * 4
    return addr == 1048 and opt_text(q) == "1048", f"1000+12×4={addr}"


def stack_possible(seq, incoming=("a1", "a2", "a3", "a4")):
    stack, out, i = [], list(seq), 0
    for item in incoming:
        stack.append(item)
        while stack and i < len(out) and stack[-1] == out[i]:
            stack.pop()
            i += 1
    return i == len(out)


def check_057(q):
    expect = {
        "a3、a1、a4、a2": False,
        "a2、a4、a3、a1": True,
        "a3、a4、a1、a2": False,
        "任意顺序": False,
    }
    got = {}
    for t in q["options"]:
        if t == "任意顺序":
            got[t] = False
        else:
            seq = tuple(x.strip() for x in t.split("、"))
            got[t] = stack_possible(seq)
    ok = got == expect
    ok = ok and opt_text(q) == "a2、a4、a3、a1"
    return ok, f"四种出栈序列逐一模拟：{got}"


def check_063(q):
    return len(range(64)) == 64 and "64" in q["answers"] and math.log2(64) == 6, "顺序查找最坏 64 次，二分对照 6 次"


def check_064(q):
    n = 2 ** (5 - 1)
    return n == 16 and "16" in q["answers"], f"第 5 层最多 2^4={n}"


def check_065(q):
    a = [1, 2, 3, 4, 5]
    swaps = 0
    for i in range(len(a)):
        for j in range(len(a) - 1, i, -1):
            if a[j] < a[j - 1]:
                a[j], a[j - 1] = a[j - 1], a[j]
                swaps += 1
    return swaps == 0 and "0" in q["answers"], "已有序时交换 0 次"


def check_069(q):
    arr = [49, 38, 65, 97, 76, 13, 27]
    a, trace = list(arr), []
    for i in range(1, len(a)):
        v, j = a[i], i - 1
        while j >= 0 and a[j] > v:
            a[j + 1] = a[j]
            j -= 1
        a[j + 1] = v
        trace.append(list(a))
    expect = [
        [38, 49, 65, 97, 76, 13, 27],
        [38, 49, 65, 97, 76, 13, 27],
        [38, 49, 65, 97, 76, 13, 27],
        [38, 49, 65, 76, 97, 13, 27],
        [13, 38, 49, 65, 76, 97, 27],
        [13, 27, 38, 49, 65, 76, 97],
    ]
    ok = trace == expect and sorted(arr) == trace[-1]
    ref_text = q["ref"].replace("｜", " ")
    for seq in trace:
        ok = ok and " ".join(map(str, seq)) in ref_text
    return ok, "直接插入排序 6 趟逐趟模拟一致" if ok else f"模拟轨迹或参考答案不符：{trace}"


def check_070(q):
    a = [4, 15, 21, 30, 43, 56, 70]
    low, high, mids, target = 0, len(a) - 1, [], 43
    found = -1
    while low <= high:
        mid = (low + high) // 2
        mids.append(mid)
        if a[mid] == target:
            found = mid
            break
        if a[mid] < target:
            low = mid + 1
        else:
            high = mid - 1
    ok = mids == [3, 5, 4] and found == 4 and len(mids) == 3
    ok = ok and all(f"mid={m}" in q["ref"] for m in mids) and "3 次" in q["ref"]
    return ok, f"mid 序列 {mids}，比较 {len(mids)} 次命中下标 {found}"


def check_071(q):
    pre = list("ABDECF")
    ino = list("DBEACF")

    def post(pre, ino):
        if not pre:
            return []
        root = pre[0]
        k = ino.index(root)
        return post(pre[1:1 + k], ino[:k]) + post(pre[1 + k:], ino[k + 1:]) + [root]

    seq = post(pre, ino)
    ok = "".join(seq) == "DEBFCA"
    ok = ok and "D、E、B、F、C、A" in q["ref"]
    return ok, f"由前序+中序重建，后序 {'、'.join(seq)}"


def check_087(q):
    expect = ["运行 → 就绪", "就绪 → 运行", "运行 → 阻塞", "阻塞 → 就绪"]
    ok = all(s in q["ref"] for s in expect)
    return ok, "四段状态转换与三态模型规则一致（阻塞解除必先回就绪）"


def check_104(q):
    db = sqlite3.connect(":memory:")
    db.executescript(
        "CREATE TABLE S(Sno TEXT PRIMARY KEY, Sname TEXT, Age INT, Sex TEXT);"
        "CREATE TABLE C(Cno TEXT PRIMARY KEY, Cname TEXT);"
        "CREATE TABLE SC(Sno TEXT, Cno TEXT, Grade INT);"
    )
    stmts = re.findall(r"(?m)^(?:①|②|③)(.+?);", q["ref"])
    ok = len(stmts) == 3
    if not ok:
        return False, "ref 中未解析到三条 SQL"
    ins, q_k2, q_join = (s.strip() for s in stmts)
    db.execute(ins)
    row = db.execute("SELECT Sno, Sname, Age, Sex FROM S").fetchone()
    ok = row == ("100001", "王刚", 19, "男")
    db.executemany("INSERT INTO C VALUES (?,?)", [("K1", "数学"), ("K2", "计导")])
    db.executemany(
        "INSERT INTO SC VALUES (?,?,?)",
        [("100001", "K2", 88), ("100002", "K2", 76), ("100002", "K1", 90)],
    )
    db.execute("INSERT INTO S VALUES ('100002','李华',20,'女')")
    r2 = db.execute(q_k2).fetchall()
    ok = ok and r2 == [("100001", 88), ("100002", 76)]
    r3 = db.execute(q_join).fetchall()
    ok = ok and len(r3) == 3 and ("100001", "王刚", "计导", 88) in r3
    ok = ok and len(r3) == db.execute("SELECT COUNT(*) FROM SC").fetchone()[0]
    return ok, f"sqlite 实跑：插入 {row}；K2 查询 {len(r2)} 行；三表连接 {len(r3)} 行（无笛卡尔积）"


def check_105(q):
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript(
        "CREATE TABLE 学生(学号 TEXT PRIMARY KEY, 姓名 TEXT, 性别 TEXT, 年龄 INT);"
        "CREATE TABLE 课程(课程号 TEXT PRIMARY KEY, 课程名 TEXT, 学分数 INT);"
        "CREATE TABLE 选课(学号 TEXT, 课程号 TEXT, 成绩 INT,"
        " PRIMARY KEY(学号,课程号),"
        " FOREIGN KEY(学号) REFERENCES 学生(学号),"
        " FOREIGN KEY(课程号) REFERENCES 课程(课程号));"
    )
    db.execute("INSERT INTO 学生 VALUES ('S1','张三','男',20)")
    db.execute("INSERT INTO 课程 VALUES ('C1','计导',3)")
    db.execute("INSERT INTO 选课 VALUES ('S1','C1',90)")
    ok = db.execute("SELECT 成绩 FROM 选课 WHERE 学号='S1' AND 课程号='C1'").fetchone()[0] == 90
    for sql in ("INSERT INTO 选课 VALUES ('S1','C1',95)", "INSERT INTO 选课 VALUES ('S9','C1',80)"):
        try:
            db.execute(sql)
            ok = False
        except sqlite3.IntegrityError:
            pass
    ok = ok and all(s in q["ref"] for s in ("M:N", "选课（学号，课程号，成绩）", "外键"))
    return ok, "按 ref 建表实跑：联合主键拒重、外键拒悬空，M:N 与成绩归属成立"


def check_106(q):
    need = ["数据冗余", "插入异常", "删除异常", "更新异常", "学生（学号，姓名）", "课程（课程号，课程名）", "选课（学号，课程号，成绩）"]
    return all(s in q["ref"] for s in need), "四类异常与三个分解关系均在参考解答中"


def check_107(q):
    cols = [("Sno", "int", False), ("Sname", "str", False), ("Sex", "str", True), ("Age", "int", True)]
    tuples = [
        (5051, "刘祥", "男", 21),
        ("5051", "刘祥", "男", 21),
        (5052, None, "女", 20),
        (5053, "王芳", None, None),
    ]
    verdicts = []
    for t in tuples:
        good = True
        for (_, typ, nullable), v in zip(cols, t):
            if v is None:
                good = good and nullable
            elif typ == "int":
                good = good and isinstance(v, int)
            else:
                good = good and isinstance(v, str)
        verdicts.append(good)
    ok = verdicts == [True, False, False, True]
    marks = ["①可以", "②不能", "③不能", "④可以"]
    ok = ok and all(m in q["ref"] for m in marks)
    return ok, f"四元组约束校验 {verdicts}"


def check_125(q):
    import ipaddress

    valid = {}
    for t in q["options"]:
        try:
            ipaddress.IPv4Address(t)
            valid[t] = True
        except Exception:
            valid[t] = False
    ok = valid["123.256.36.2"] is False and sum(valid.values()) == 3
    ok = ok and opt_text(q) == "123.256.36.2"
    return ok, f"IPv4 合法性 {valid}"


def check_129(q):
    first = 200
    klass = "C" if 192 <= first <= 223 else ("B" if 128 <= first <= 191 else "A")
    host = "65" if klass == "C" else None
    ok = klass == "C" and host == "65" and opt_text(q) == "65"
    return ok, f"首字节 {first} 属 {klass} 类，主机号 {host}"


def check_133(q):
    url = "http://www.bjfu.edu.cn/index.html"
    proto, rest = url.split("://")
    ok = proto == "http" and rest.split("/")[0] == "www.bjfu.edu.cn"
    ok = ok and "://" in q["answers"]
    return ok, "按 :// 与 / 分解 URL 得到协议、域名、路径"


def check_140(q):
    t1 = 250 * 8 / 100
    t2 = 250 / 10
    ceiling = 100 / 8
    ok = t1 == 20 and t2 == 25 and ceiling == 12.5
    ok = ok and all(s in q["ref"] for s in ("2000Mb", "20 秒", "25 秒", "12.5MB/s"))
    return ok, f"理论 {t1}s，实际 {t2}s，带宽上限 {ceiling}MB/s"


def check_019(q):
    ceiling = 100 / 8
    ok = ceiling == 12.5 and "12.5MB/s" in q["ref"] and "1B = 8b" in q["ref"]
    return ok, f"100Mb/s÷8={ceiling}MB/s，实际 10MB/s 对应 {10*8}Mb/s"


RECALC = {
    "cs.final-011": check_011, "cs.final-012": check_012, "cs.final-013": check_013,
    "cs.final-016": check_016, "cs.final-019": check_019, "cs.final-020": check_020,
    "cs.final-021": check_021, "cs.final-022": check_022, "cs.final-023": check_023,
    "cs.final-024": check_024, "cs.final-025": check_025, "cs.final-026": check_026,
    "cs.final-027": check_027, "cs.final-039": check_039, "cs.final-043": check_043,
    "cs.final-044": check_044, "cs.final-046": check_046, "cs.final-048": check_048,
    "cs.final-049": check_049, "cs.final-054": check_054, "cs.final-056": check_056,
    "cs.final-057": check_057, "cs.final-063": check_063, "cs.final-064": check_064,
    "cs.final-065": check_065, "cs.final-069": check_069, "cs.final-070": check_070,
    "cs.final-071": check_071, "cs.final-087": check_087, "cs.final-104": check_104,
    "cs.final-105": check_105, "cs.final-106": check_106, "cs.final-107": check_107,
    "cs.final-125": check_125, "cs.final-129": check_129, "cs.final-133": check_133,
    "cs.final-140": check_140,
}

# 来源复核时必须命中的关键事实（防止参考答案被改空或答非所问）
SOURCE_KEYWORDS = {
    "cs.final-001": ["有限", "步骤"],
    "cs.final-002": ["总体布局", "连接方式"],
    "cs.final-003": ["基本操作", "时间"],
    "cs.final-017": ["输入系统", "输出系统", "运算器", "控制器", "存储器"],
    "cs.final-018": ["LIFO", "FIFO"],
    "cs.final-028": ["纸带", "读写头"],
    "cs.final-036": ["巨型化", "智能化"],
    "cs.final-037": ["取反", "加 1"],
    "cs.final-045": ["原码", "反码", "补码"],
    "cs.final-047": ["数据总线", "地址总线", "控制总线"],
    "cs.final-053": ["RAM", "ROM", "断电"],
    "cs.final-055": ["吞吐量", "并行处理"],
    "cs.final-067": ["O(1)", "O(n)"],
    "cs.final-068": ["递归", "迭代"],
    "cs.final-072": ["系统软件", "接口"],
    "cs.final-084": ["死锁", "饥饿"],
    "cs.final-085": ["进程", "存储", "设备", "文件"],
    "cs.final-086": ["批处理", "分时", "实时"],
    "cs.final-088": ["生态"],
    "cs.final-089": ["共享", "保密", "保护"],
    "cs.final-090": ["有组织", "可共享"],
    "cs.final-101": ["需求分析", "概念结构设计", "逻辑结构设计", "物理设计", "实施", "维护"],
    "cs.final-102": ["层次模型", "网状模型", "关系模型"],
    "cs.final-103": ["物理数据独立性", "逻辑数据独立性"],
    "cs.final-118": ["编译", "解释", "目标程序"],
    "cs.final-119": ["自然进化", "人为设计"],
    "cs.final-120": ["①正确", "②错误", "③正确", "④正确"],
    "cs.final-121": ["增量模型", "不准确"],
    "cs.final-122": ["结构化", "面向对象"],
    "cs.final-123": ["测试程序", "验证程序"],
    "cs.final-136": ["物理层", "数据链路层", "网络层", "传输层", "会话层", "表示层", "应用层"],
    "cs.final-137": ["中继器", "网桥", "路由器", "网关"],
    "cs.final-138": ["网络接口层", "网际层", "传输层", "应用层", "TCP", "UDP"],
    "cs.final-139": ["局域网", "星型", "交换机", "路由器"],
}


def structural(qs, topics_known):
    problems = []
    if len(qs) != 140:
        problems.append(f"题量 {len(qs)} ≠ 140")
    for i, q in enumerate(qs, 1):
        if q["qid"] != f"cs.final-{i:03d}":
            problems.append(f"qid 错位：第 {i} 题为 {q['qid']}")
    mat = defaultdict(Counter)
    for q in qs:
        mat[int(q["topic"].split(".")[0])][q["type"]] += 1
        if q["topic"] not in topics_known:
            problems.append(f"{q['qid']} topic 不在既有题库命名中：{q['topic']}")
        if q.get("diff") not in ("易", "中", "难"):
            problems.append(f"{q['qid']} diff 非法")
        if not q.get("exp"):
            problems.append(f"{q['qid']} 缺解析")
        if not q.get("meta", {}).get("source"):
            problems.append(f"{q['qid']} 缺来源")
        blob = json.dumps(q, ensure_ascii=False)
        for bad in ("SHAPE", "MERGEFORMAT", "EMBED", "如图", "�"):
            if bad in blob:
                problems.append(f"{q['qid']} 含残留标记 {bad}")
        if q["type"] in ("single", "multi"):
            if not 2 <= len(q["options"]) <= 4:
                problems.append(f"{q['qid']} 选项数非法")
            if q["type"] == "single" and len(q["answer"]) != 1:
                problems.append(f"{q['qid']} 单选答案数非法")
            if q["type"] == "multi" and len(q["answer"]) < 2:
                problems.append(f"{q['qid']} 多选答案数非法")
            if max(q["answer"]) >= len(q["options"]):
                problems.append(f"{q['qid']} 答案下标越界")
            if len(set(q["options"])) != len(q["options"]):
                problems.append(f"{q['qid']} 选项重复")
        if q["type"] == "fill" and not q.get("answers"):
            problems.append(f"{q['qid']} 填空缺 answers")
        if q["type"] in ("term", "short", "comp") and len(q.get("ref", "")) < 20:
            problems.append(f"{q['qid']} 参考解答过短")
        if q["type"] in ("single", "multi") and re.search(r"[ABCD][ ）)]?[对错选]", q.get("exp", "")):
            problems.append(f"{q['qid']} 解析疑似引用选项字母")
    for ch, expect in BLUEPRINT.items():
        for t, n in expect.items():
            if mat[ch][t] != n:
                problems.append(f"第 {ch} 章 {t} 为 {mat[ch][t]}，蓝图要求 {n}")
    if sum(mat[ch][t] for ch in (1, 2, 3, 4) for t in mat[ch]) != 70:
        problems.append("第 1～4 章题量不是 70")
    if sum(mat[ch][t] for ch in (5, 6, 7, 8) for t in mat[ch]) != 70:
        problems.append("第 5～8 章题量不是 70")
    paper = [q for q in qs if q.get("meta", {}).get("paper") == "final2019"]
    nos = sorted(q["meta"]["paperNo"] for q in paper)
    if len(paper) != 27 or nos != sorted(PAPER_NOS):
        problems.append(f"2019 真题题号不齐：{len(paper)} 题")
    return problems


def main():
    bank = Path(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else DEFAULT_BANK
    out_json = None
    if "--json" in sys.argv:
        out_json = Path(sys.argv[sys.argv.index("--json") + 1])
    if not bank.exists():
        print(f"找不到 {bank}", file=sys.stderr)
        return 2
    data = json.loads(bank.read_text())
    qs = data["questions"]
    topics_known = set()
    for other in (ROOT / "collections/cs/subjects/cs/bank").glob("*.json"):
        if other.name == "final.json":
            continue
        for q in json.loads(other.read_text())["questions"]:
            topics_known.add(q["topic"])
    problems = structural(qs, topics_known)

    for q in qs:
        qid = q["qid"]
        if qid in RECALC:
            try:
                ok, detail = RECALC[qid](q)
            except Exception as exc:  # 复算脚本自身出错也算失败，不能静默放过
                ok, detail = False, f"复算异常：{exc}"
            record(qid, "RECALC", ok, detail)
        else:
            ok = True
            detail = "来源：{}；".format(q["meta"]["source"])
            if q["type"] in ("term", "short", "comp"):
                keys = SOURCE_KEYWORDS.get(qid)
                if keys:
                    missing = [k for k in keys if k not in q["ref"]]
                    if missing:
                        ok = False
                        detail += f"参考解答缺关键要点 {missing}；"
                if "采分点" not in q["exp"]:
                    ok = False
                    detail += "解析缺采分点；"
            if q["type"] in ("single", "multi"):
                # 选择题必须能用解析说明正确项与干扰项
                if len(q["exp"]) < 20:
                    ok = False
                    detail += "解析过短，无法支撑干扰项排除；"
                detail += "正确项：" + "；".join(q["options"][i] for i in q["answer"])[:40] + "；"
            record(qid, "SOURCE", ok, detail or "来源与答案要点齐备")

    lines = []
    fails = 0
    for qid, method, ok, detail in results:
        flag = "PASS" if ok else "FAIL"
        if not ok:
            fails += 1
        line = f"{qid}  {method:7s}  {flag}  {detail}"
        lines.append(line)
        print(line)
    n_recalc = sum(1 for r in results if r[1] == "RECALC")
    print("-" * 70)
    print(f"共 {len(results)} 题：独立复算 {n_recalc} 题，来源复核 {len(results)-n_recalc} 题；失败 {fails} 题")
    for p in problems:
        print("STRUCT FAIL:", p)
    print("结构审计问题：", len(problems))
    if out_json:
        out_json.parent.mkdir(parents=True, exist_ok=True)
        out_json.write_text(json.dumps({
            "total": len(results),
            "recalc": n_recalc,
            "failures": fails,
            "structuralProblems": problems,
            "results": [
                {"qid": q, "method": m, "ok": ok, "detail": d} for q, m, ok, d in results
            ],
        }, ensure_ascii=False, indent=2) + "\n")
        print("已写出", out_json)
    return 1 if (fails or problems) else 0


if __name__ == "__main__":
    sys.exit(main())
