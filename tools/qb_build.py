#!/usr/bin/env python3
"""大一题库构建器

用法：
    python3 tools/qb_build.py build [--collection <id>]   # 构建（默认全部）
    python3 tools/qb_build.py check [--collection <id>]   # 只跑校验门
    python3 tools/qb_build.py mount <id>                  # 把题库集挂进 catalog.json
    python3 tools/qb_build.py status                      # 打印层级与题量

约定：
    源级（手写）    collection.config.json / site.config.json / subject.config.json / typepack.json / bank/*.json
    产物（生成）    dist/**（题库集站点 + 每个独立题库的自包含部署包）
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CORE = ROOT / "packages" / "qb-core"
sys.path.insert(0, str(HERE))
import qb_gate  # noqa: E402

TZ = timezone(timedelta(hours=8))
KIND_LABEL = {"unit": "单元", "midterm": "期中", "final": "期末", "topic": "专题", "subject": "整科"}

# 没有 Key 时注入的占位符。qb-sync.js 的 configured() 见到 __ 前缀即整体关闭，
# 所以占位符页面的同步按钮是灰的，也不会向 __ENV_ID__ 这种假域名发请求。
PLACEHOLDER_KEY = "__PUBLISHABLE_KEY__"
PLACEHOLDER_ENV = "__ENV_ID__"


# ------------------------------------------------------------------ 基础 IO

def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def env_id_from_key(key: str):
    """从 CloudBase Publishable Key（JWT）的 payload 里取云环境 ID。

    取 project_id，退而取 aud。这样换云环境只需要换一处 Key，
    不必同时改 sync.config.json 的 env。
    """
    import base64
    try:
        seg = key.split(".")
        if len(seg) < 2:
            return None
        pad = "=" * (-len(seg[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(seg[1] + pad).decode("utf-8"))
        val = payload.get("project_id") or payload.get("aud")
        return val if isinstance(val, str) and val.strip() else None
    except Exception:
        return None


def save(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def sha(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()[:16]


def js(obj) -> str:
    """把 Python 对象序列化成可内联进 <script> 的 JS 字面量。"""
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


def now_str() -> str:
    return datetime.now(TZ).strftime("%Y-%m-%d %H:%M")


# ------------------------------------------------------------------ 序列表

def ensure_order(site_root: Path, quiet: bool = False):
    """按题库顺序维护 gids.json。

    能追加就追加（旧导出码不失效）；必须插队时整体重排并告警。
    """
    site = qb_gate.Site(site_root)
    idx_path = site_root / "subjects" / "_index" / "gids.json"
    old = load(idx_path) if idx_path.exists() else {"version": 1, "order": [], "retired": []}
    existing = list(old.get("order") or [])
    retired = list(old.get("retired") or [])

    desired, seen = [], set()
    for q in site.questions:
        g = q["_gid"]
        if g not in seen:
            seen.add(g)
            desired.append(g)
    for g in existing:            # 已作废的槽位保留在原位
        if g not in seen and g not in desired:
            desired.append(g)

    if existing == desired:
        return 0, len(desired), False

    appended_only = desired[:len(existing)] == existing
    save(idx_path, {"version": 1, "order": desired, "retired": retired})
    if not quiet and not appended_only and existing:
        print(f"  ⚠ 序列表需要重排（新增题目插在了已有题目之前）：{len(existing)} → {len(desired)} 个槽位")
        print("     本次之前导出的进度码将失效。新增题目应追加到最后一个题组末尾。")
    return len(desired) - len(existing), len(desired), appended_only


# ------------------------------------------------------------------ 页面模板

PAGE_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light">
<title>__TITLE__</title>
<style>__CSS__</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div>
      <h1 id="site-title">__TITLE__</h1>
      <div class="sub"><span id="bank-name"></span> · <span id="bank-desc"></span></div>
    </div>
    <div class="spacer"></div>
    <a class="home" id="home" href="__HOME__">__HOMELABEL__</a>
  </div>

  <div class="panel" id="stats"></div>

  <div class="panel block">
    <div class="ctl">
      <div class="seg" id="modes">
        <button data-mode="seq" class="on">顺序</button>
        <button data-mode="random">随机</button>
        <button data-mode="wrong">错题</button>
        <button data-mode="fav">收藏</button>
        <button data-mode="undone">未做</button>
      </div>
      <select id="f-type"><option value="">全部题型</option></select>
      <select id="f-diff"><option value="">全部难度</option><option>易</option><option>中</option><option>难</option></select>
    </div>
    <div class="ctl">
      <input type="search" id="f-kw" placeholder="搜索题干 / 知识点">
      <span class="hint">键盘 ← → 翻题，数字键选项；手机在题目上左右滑动翻题</span>
    </div>
  </div>

  <div class="panel" id="card"></div>
  <div id="nav"></div>

  <details class="panel block">
    <summary style="cursor:pointer;font-size:14px;font-weight:600">掌握度（按知识点）</summary>
    <div id="mastery" style="padding-top:10px"></div>
  </details>

  <details class="panel block" id="cloud-wrap" style="display:none">
    <summary style="cursor:pointer;font-size:14px;font-weight:600">云同步（手动上传 / 下载）</summary>
    <div style="padding-top:10px">
      <div class="x-row">
        <input type="text" id="s-code" class="in" style="flex:1;min-width:180px;margin-top:0"
               placeholder="同步码（≥10 位，与旧页面共用）">
        <button class="btn" id="s-save">保存</button>
        <button class="btn primary" id="s-up">上传</button>
        <button class="btn" id="s-down">下载</button>
      </div>
      <div id="s-info" class="hint" style="margin-top:8px;min-height:18px"></div>
    </div>
  </details>

  <details class="panel block">
    <summary style="cursor:pointer;font-size:14px;font-weight:600">导出 / 导入进度码</summary>
    <div id="transfer" style="padding-top:10px">
      <div class="x-row">
        <select id="x-scope"></select>
        <button class="btn" id="x-do">生成</button>
        <button class="btn" id="x-copy">复制</button>
        <button class="btn" id="x-import">导入</button>
        <button class="btn" id="x-undo">撤销导入</button>
        <button class="btn ghost" id="reset" style="margin-left:auto">清空本机记录</button>
      </div>
      <textarea id="x-code" placeholder="在此粘贴他人分享的进度码，或点「生成」得到自己的"></textarea>
      <div id="x-info"></div>
    </div>
  </details>

  <div class="foot">
    __FOOT__<br>
    进度保存在本机浏览器，不上传；换设备请用进度码迁移。
  </div>
</div>
<div id="mjx-cache" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">__MJXCACHE__</div>
<div id="toast"></div>
<script>window.QB_META=__META__;</script>
<script>window.QB_SITE=__SITE__;</script>
<script>__CORE__</script>
__SYNCJS__<script>__PAGE__</script>
</body>
</html>
"""

INDEX_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light">
<title>__TITLE__</title>
<style>__CSS__</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div>
      <h1 id="site-title">__TITLE__</h1>
      <div class="sub" id="site-sub">__SUB__</div>
    </div>
    <div class="spacer"></div>
    <a class="back" id="back" href="#">返回</a>
  </div>
  <div id="sum"></div>
  <div id="groups"></div>
  <div class="foot">__FOOT__</div>
</div>
<script>window.QB_INDEX=__DATA__;</script>
<script>__CORE__</script>
<script>__INDEX__</script>
</body>
</html>
"""


# ------------------------------------------------------------------ 站点定义

def subject_units(subject_cfg: dict) -> list:
    return sorted(subject_cfg.get("units") or [], key=lambda u: u.get("order", 0))


def unit_questions(subject_dir: Path, unit: dict) -> list:
    bank = load(subject_dir / unit.get("bank", f"bank/{unit['key']}.json"))
    out = []
    for q in bank.get("questions") or []:
        item = dict(q)
        out.append(item)
    return out


# ------------------------------------------------------------------ 数学排版

def _node_roots() -> list:
    """候选的 Node 安装根目录。环境变量优先，其次几个常见的托管运行时位置。"""
    roots = []
    for var in ("QB_NODE_HOME", "QB_RUNTIME_HOME"):
        v = os.environ.get(var)
        if v:
            roots.append(Path(v))
    home = Path.home()
    roots += [home / ".workbuddypro" / "binaries" / "node",
              home / ".workbuddy" / "binaries" / "node"]
    return roots


def _find_node() -> str:
    """Node 可执行文件：QB_NODE > versions/current > 版本目录里最新的一个 > PATH。
    原先写死 22.22.2-3 与本机绝对路径，Node 一升级或换机器整个构建就起不来。"""
    env = os.environ.get("QB_NODE")
    if env and Path(env).exists():
        return env
    for base in _node_roots():
        vers = base / "versions"
        cands = [vers / "current" / "bin" / "node"]
        if vers.exists():
            cands += sorted(vers.glob("*/bin/node"), reverse=True)
        for c in cands:
            if c.exists():
                return str(c)
    return shutil.which("node") or "node"


def _node_modules() -> str:
    """数学公式渲染要用的 node_modules（katex 等）。找不到就交给 NODE_PATH 默认行为。"""
    for base in _node_roots():
        for cand in (base / "workspace" / "node_modules", base / "node_modules"):
            if cand.is_dir():
                return str(cand)
    return ""


NODE = _find_node()
NODE_MODULES = _node_modules()


def render_views(questions: list) -> str:
    """把题目里的公式渲染成内联 SVG，返回本页的字体缓存片段。

    显示源优先取 meta.tex（LaTeX，$…$ 行内、$$…$$ 行间）；没有 meta.tex 但文本里
    带 $ 的也照常渲染。纯文本题不生成视图——页面端转义后原样显示即可，省体积。
    stem / ref / exp 本身一个字不动：gid 由它们算出，改了会让用户已有记录脱钩。
    """
    texts, plan = {}, []

    def has_math(s):
        return isinstance(s, str) and "$" in s

    for q in questions:
        tex = (q.get("meta") or {}).get("tex") or {}
        qid = q["qid"]
        keys = {}

        def put(field, src, display_src):
            if display_src is None:
                return None
            if not (field in tex or has_math(display_src)):
                return None
            key = f"{qid}:{field}"
            texts[key] = display_src
            return key

        keys["stem"] = put("stem", q.get("stem"), tex.get("stem", q.get("stem")))
        keys["ref"] = put("ref", q.get("ref"), tex.get("ref", q.get("ref")))
        keys["exp"] = put("exp", q.get("exp"), tex.get("exp", q.get("exp")))

        topts = tex.get("options") or []
        keys["opts"] = [put(f"opt{i}", o, topts[i] if i < len(topts) else o)
                        for i, o in enumerate(q.get("options") or [])]
        tans = tex.get("answers") or []
        keys["answers"] = [put(f"ans{i}", a, tans[i] if i < len(tans) else a)
                           for i, a in enumerate(q.get("answers") or [])]
        if any(k for k in (keys["stem"], keys["ref"], keys["exp"])) or \
           any(keys["opts"]) or any(keys["answers"]):
            plan.append((q, keys))

    if not texts:
        return ""

    inp, outp = Path("/tmp/qb_math_in.json"), Path("/tmp/qb_math_out.json")
    inp.write_text(json.dumps({"texts": texts}, ensure_ascii=False), encoding="utf-8")
    env = dict(os.environ)
    if NODE_MODULES:
        env["NODE_PATH"] = NODE_MODULES
    proc = subprocess.run([NODE, str(HERE / "math_render.js"), str(inp), str(outp)],
                          capture_output=True, env=env)
    if proc.returncode != 0:
        raise SystemExit("数学渲染失败：" + proc.stderr.decode("utf-8")[:600])
    if proc.stderr.strip():
        print("  ⚠ " + proc.stderr.decode("utf-8").strip()[:300])
    data = json.loads(outp.read_text(encoding="utf-8"))
    html = data["html"]

    for q, keys in plan:
        views = {}
        for field in ("stem", "ref", "exp"):
            if keys[field]:
                views[field] = html.get(keys[field], "")
        if any(keys["opts"]):
            views["opts"] = [html[k] if k else "" for k in keys["opts"]]
        if any(keys["answers"]):
            views["answers"] = [html[k] if k else "" for k in keys["answers"]]
        q["views"] = views

    return data.get("cache") or ""


def build_site_def(collection_dir: Path, site_cfg: dict, subject_cfg: dict,
                   typepack: dict, units: list, order: list, retired: list,
                   title: str) -> dict:
    return {
        "title": title,
        "subjectKey": subject_cfg["key"],
        "subjectName": subject_cfg["name"],
        "types": typepack.get("types") or {},
        "units": units,
        "wrong": subject_cfg.get("wrong") or {"exitStreak": 1},
        "mastery": subject_cfg.get("mastery") or {},
        "codec": site_cfg.get("codec") or {"version": 10, "gidBits": 32, "budgetBytes": 6000},
        "order": order,
        "retired": retired,
        "storePrefix": "qb.site",
    }


def resolve_sync_cfg(col_dir: Path):
    """读 sync.config.json，返回 (占位符配置, 真实配置或 None)。

    占位符配置进 dist/（可公开、可入库）；真实配置只在 deploy/ 里用。
    Key 从 keyFile 读，文件缺失或只有注释时视为「没有 Key」，此时真实配置为 None。
    env 留 __ENV_ID__ 或留空时，从 Key 的 JWT payload 里解 project_id。
    """
    scfg_path = col_dir / "sync.config.json"
    if not scfg_path.exists():
        return None, None
    raw = load(scfg_path)
    key = ""
    if raw.get("keyFile"):
        kp = (col_dir / raw["keyFile"]).resolve()
        if kp.exists():
            key = kp.read_text(encoding="utf-8").strip()
            if key.startswith("#"):
                key = ""
    real_key = bool(key) and not key.startswith("__")
    common = {"quiz": raw.get("quiz", "global"),
              "codeKey": raw.get("codeKey", "csquiz_sync_code_v1")}
    ph = {"env": PLACEHOLDER_ENV, "key": PLACEHOLDER_KEY, "rpc": "", **common}
    if not real_key:
        return ph, None
    env = (raw.get("env") or "").strip()
    if not env or env.startswith("__"):
        env = env_id_from_key(key) or PLACEHOLDER_ENV
    rpc = (raw.get("rpc") or "").strip()   # 留空则由 qb-sync.js 从 env 拼出
    return ph, {"env": env, "key": key, "rpc": rpc, **common}


# ------------------------------------------------------------------ 构建一个题库集

def build_collection(col_id: str, verbose: bool = True) -> dict:
    col_dir = ROOT / "collections" / col_id
    col_cfg = load(col_dir / "collection.config.json")
    site_cfg = load(col_dir / "site.config.json")
    core_js = (CORE / "qb-core.js").read_text(encoding="utf-8")
    page_js = (CORE / "qb-page.js").read_text(encoding="utf-8")
    page_css = (CORE / "qb-page.css").read_text(encoding="utf-8")
    index_js = (CORE / "qb-index.js").read_text(encoding="utf-8")
    index_css = (CORE / "qb-index.css").read_text(encoding="utf-8")

    # 云同步：只有配了 sync.config.json 的题库集才注入同步模块。
    # dist/ 一律注入「占位符」版——它会进仓库、也给人直接打开看，不能带真实 Key。
    # 真实 Key 只写进 deploy/（见 build_deploy），deploy/ 不入库。
    sync_js = ""
    ph_cfg, _real_cfg = resolve_sync_cfg(col_dir)
    if ph_cfg:
        sync_js = ('<script>window.QB_SYNC_CFG=' + js(ph_cfg) + ';</script>\n'
                   + '<script>' + (CORE / "qb-sync.js").read_text(encoding="utf-8") + '</script>\n')

    added, total, appended = ensure_order(col_dir, quiet=not verbose)
    gids = load(col_dir / "subjects" / "_index" / "gids.json")
    order = list(gids.get("order") or [])
    retired = list(gids.get("retired") or [])

    dist = col_dir / "dist"
    if dist.exists():
        shutil.rmtree(dist)
    dist.mkdir(parents=True)

    subject_cfg = None
    subject_dir = None
    typepack = None
    for entry in site_cfg.get("subjects") or []:
        subject_dir = col_dir / "subjects" / entry["key"]
        subject_cfg = load(subject_dir / "subject.config.json")
        typepack = load(subject_dir / "typepack.json")
    units = subject_units(subject_cfg)
    subj_key = subject_cfg["key"]

    pages, packages, bank_meta = [], [], []

    for unit in units:
        qs = unit_questions(subject_dir, unit)
        for q in qs:
            q["_unit"] = unit["key"]
        cache_html = render_views(qs)
        kind = unit.get("kind", "unit")
        title = f"{subject_cfg['name']} · {unit['label']} {unit['title']}"

        unit_def = {
            "key": unit["key"], "label": unit["label"], "title": unit["title"],
            "desc": unit.get("desc", ""), "questions": qs,
        }
        sdef = build_site_def(col_dir, site_cfg, subject_cfg, typepack,
                              [unit_def], order, retired, title)

        # ---- 题库集内页 dist/<subject>/<unit>.html
        page_dir = dist / subj_key
        page_dir.mkdir(parents=True, exist_ok=True)
        page_path = page_dir / f"{unit['key']}.html"
        html = (PAGE_HTML
                .replace("__TITLE__", title)
                .replace("__CSS__", page_css)
                .replace("__HOME__", "../index.html")
                .replace("__HOMELABEL__", "返回题库集")
                .replace("__FOOT__", f"{col_cfg['name']} · {unit['label']} {unit['title']} · {len(qs)} 题")
                .replace("__META__", js({"home": "../index.html", "title": title}))
                .replace("__SITE__", js(sdef))
                .replace("__CORE__", core_js)
                .replace("__SYNCJS__", sync_js)
                .replace("__MJXCACHE__", cache_html)
                .replace("__PAGE__", page_js))
        page_path.write_text(html, encoding="utf-8")
        pages.append(page_path)

        # ---- 独立部署包 dist/banks/<unit>/
        # 页面在 dist/banks/<键>/ 下，题库集入口在 dist/index.html，所以上两级才是上一级题库。
        # 这里必须同时写进 href 与 QB_META：qb-page.js 读 meta.home 决定是否显示「返回题库集」，
        # 缺了 meta.home 会把链接整条隐藏，单元页就回不到题库集。
        pkg = dist / "banks" / unit["key"]
        pkg.mkdir(parents=True, exist_ok=True)
        pkg_html = (PAGE_HTML
                    .replace("__TITLE__", title)
                    .replace("__CSS__", page_css)
                    .replace("__HOME__", "../../index.html")
                    .replace("__HOMELABEL__", "返回题库集")
                    .replace("__FOOT__", f"独立题库 · {col_cfg['name']} · {unit['label']} {unit['title']} · {len(qs)} 题")
                    .replace("__META__", js({"home": "../../index.html", "title": title}))
                    .replace("__SITE__", js(sdef))
                    .replace("__CORE__", core_js)
                    .replace("__SYNCJS__", sync_js)
                    .replace("__MJXCACHE__", cache_html)
                    .replace("__PAGE__", page_js))
        (pkg / "index.html").write_text(pkg_html, encoding="utf-8")

        # 部署包内附规范要求的配置与数据，便于单独校验与二次加工
        (pkg / "subjects" / subj_key / "bank").mkdir(parents=True, exist_ok=True)
        (pkg / "subjects" / "_index").mkdir(parents=True, exist_ok=True)
        save(pkg / "site.config.json", {
            "version": 1,
            "site": {"title": title, "defaultSubject": subj_key},
            "subjects": [{"key": subj_key, "name": subject_cfg["name"],
                          "accent": col_cfg.get("accent", "#2f6fed"), "status": "active"}],
            "codec": site_cfg.get("codec"),
        })
        save(pkg / "subjects" / subj_key / "subject.config.json", {
            "version": 1, "key": subj_key, "name": subject_cfg["name"],
            "typepack": subject_cfg.get("typepack"),
            "units": [dict(unit, bank=f"bank/{unit['key']}.json")],
            "wrong": subject_cfg.get("wrong"),
            "mastery": subject_cfg.get("mastery"),
        })
        save(pkg / "subjects" / subj_key / "typepack.json", typepack)
        save(pkg / "subjects" / subj_key / "bank" / f"{unit['key']}.json",
             {"version": 1, "unit": unit["key"],
              "questions": [{k: v for k, v in q.items() if k != "views"} for q in qs]})
        # 部署包的序列表按本题库的题目顺序生成：作用域内顺序与题库集页面完全一致
        local_order, seen_local = [], set()
        for q in qs:
            g = qb_gate.fingerprint(q, int((site_cfg.get("codec") or {}).get("gidBits", 32)))
            if g not in seen_local:
                seen_local.add(g)
                local_order.append(g)
        save(pkg / "subjects" / "_index" / "gids.json",
             {"version": 1, "order": local_order, "retired": []})

        meta = {
            "version": 1,
            "id": f"{col_id}.{unit['key']}",
            "key": unit["key"],
            "kind": kind,
            "kindLabel": KIND_LABEL.get(kind, "题库"),
            "label": unit["label"],
            "title": unit["title"],
            "desc": unit.get("desc", ""),
            "collection": {"id": col_id, "name": col_cfg["name"]},
            "subject": {"key": subj_key, "name": subject_cfg["name"], "typepack": subject_cfg.get("typepack")},
            "count": len(qs),
            "types": sorted({q["type"] for q in qs}),
            "topics": sorted({q["topic"] for q in qs}),
            "sources": sorted({(q.get("meta") or {}).get("source", "") for q in qs} - {""}),
            "entry": "index.html",
            "standalone": True,
            "depends": [],
            "builtAt": now_str(),
            "codec": site_cfg.get("codec"),
            "order": unit.get("order", 0),
        }
        save(pkg / "bank.config.json", meta)
        (pkg / "README.md").write_text(
            f"""# {unit['label']} {unit['title']}

独立题库，属于「{col_cfg['name']}」题库集。

- 题量：{len(qs)} 题
- 题型：{', '.join(meta['types'])}
- 部署：把整个目录原样拷到任意静态服务器即可，入口是 `index.html`
- 离线：双击 `index.html` 也能用（进度存在本机浏览器）
- 进度码作用域：题组 `{unit['key']}`

目录内 `site.config.json` / `subjects/` 是该题库的规范数据，
可用 `python3 ../../../../../tools/qb_gate.py check .` 单独校验。
""", encoding="utf-8")

        packages.append(pkg)
        bank_meta.append({
            "key": unit["key"], "kind": kind, "kindLabel": KIND_LABEL.get(kind, "题库"),
            "label": unit["label"], "title": unit["title"], "desc": unit.get("desc", ""),
            "count": len(qs), "href": f"banks/{unit['key']}/index.html",
            "page": f"{subj_key}/{unit['key']}.html",
            "order": unit.get("order", 0),
        })
        if verbose:
            print(f"  · {unit['key']:<9} {unit['label']} {unit['title']}  {len(qs):>4} 题  → dist/banks/{unit['key']}/")

    # ---- 题库集入口
    all_gids, seen = [], set()
    for unit in units:
        for q in unit_questions(subject_dir, unit):
            g = qb_gate.fingerprint(q, int((site_cfg.get("codec") or {}).get("gidBits", 32)))
            if g not in seen:
                seen.add(g)
                all_gids.append(g)

    index_data = {
        "title": f"{col_cfg['name']}题库集",
        "subtitle": col_cfg.get("desc", ""),
        "back": {"href": "../../../index.html", "label": "返回大一题库"},
        "groups": [{
            "key": b["key"], "kind": b["kind"], "kindLabel": b["kindLabel"],
            "label": b["label"], "title": b["title"], "desc": b["desc"],
            "order": b["order"],
            "href": b["href"],
            "gids": [qb_gate.fingerprint(q, int((site_cfg.get("codec") or {}).get("gidBits", 32)))
                     for q in unit_questions(subject_dir,
                                             next(u for u in units if u["key"] == b["key"]))],
        } for b in bank_meta],
    }
    # 卡片展示顺序与编码顺序解耦：gids.json 必须按 units 配置顺序（只允许追加，
    # 否则旧进度码整段失效），但入口页按「单元 → 期中/期末 → 专题」分组排列，
    # 这样后续追加的单元不会排到专题之后。只影响展示，不影响任何编码。
    KIND_RANK = {"unit": 0, "midterm": 1, "final": 2, "topic": 3, "subject": 4}
    index_data["groups"].sort(key=lambda g: (KIND_RANK.get(g["kind"], 9), g["order"]))
    (dist / "index.html").write_text(
        INDEX_HTML
        .replace("__TITLE__", f"{col_cfg['name']}题库集")
        .replace("__SUB__", col_cfg.get("desc", ""))
        .replace("__CSS__", index_css)
        .replace("__FOOT__", f"题库集 {col_id} · {len(bank_meta)} 个独立题库 · 去重后 {len(all_gids)} 题 · 构建于 {now_str()}")
        .replace("__DATA__", js(index_data))
        .replace("__CORE__", core_js)
        .replace("__INDEX__", index_js),
        encoding="utf-8")

    manifest = {
        "version": 1,
        "collection": col_id,
        "name": col_cfg["name"],
        "builtAt": now_str(),
        "banks": bank_meta,
        "totalRecords": sum(b["count"] for b in bank_meta),
        "uniqueGids": len(all_gids),
        "artifacts": {str(p.relative_to(col_dir)): sha(p)
                      for p in sorted(dist.rglob("*")) if p.is_file()},
    }
    save(dist / "manifest.json", manifest)
    return {"id": col_id, "name": col_cfg["name"], "banks": bank_meta,
            "uniqueGids": len(all_gids), "records": manifest["totalRecords"],
            "accent": col_cfg.get("accent", "#2f6fed"), "desc": col_cfg.get("desc", "")}


# ------------------------------------------------------------------ 根入口

def build_root(results: list):
    core_js = (CORE / "qb-core.js").read_text(encoding="utf-8")
    index_js = (CORE / "qb-index.js").read_text(encoding="utf-8")
    index_css = (CORE / "qb-index.css").read_text(encoding="utf-8")
    catalog = load(ROOT / "catalog.json")

    groups = []
    for res in results:
        gids, seen = [], set()
        for b in res["banks"]:
            pkg = ROOT / "collections" / res["id"] / "dist" / "banks" / b["key"] / "subjects"
            bank_file = next(pkg.rglob("bank/*.json"))
            for q in load(bank_file).get("questions") or []:
                g = qb_gate.fingerprint(q, 32)
                if g not in seen:
                    seen.add(g)
                    gids.append(g)
        groups.append({
            "key": res["id"], "kind": "subject", "kindLabel": "题库集",
            "label": res["name"], "title": f"{len(res['banks'])} 个独立题库",
            "desc": res["desc"],
            "href": f"collections/{res['id']}/dist/index.html",
            "gids": gids,
        })

    data = {
        "title": catalog["grade"]["name"],
        "subtitle": catalog["grade"].get("desc", ""),
        "groups": groups,
    }
    total = sum(len(g["gids"]) for g in groups)
    (ROOT / "index.html").write_text(
        INDEX_HTML
        .replace("__TITLE__", catalog["grade"]["name"])
        .replace("__SUB__", catalog["grade"].get("desc", ""))
        .replace("__CSS__", index_css)
        .replace("__FOOT__", f"{len(results)} 个题库集 · {sum(len(r['banks']) for r in results)} 个独立题库 · 去重后 {total} 题 · 构建于 {now_str()}")
        .replace("__DATA__", js(data))
        .replace("__CORE__", core_js)
        .replace("__INDEX__", index_js),
        encoding="utf-8")
    catalog["builtAt"] = now_str()
    catalog["stats"] = {
        "collections": len(results),
        "banks": sum(len(r["banks"]) for r in results),
        "uniqueQuestions": total,
        "records": sum(r["records"] for r in results),
    }
    save(ROOT / "catalog.json", catalog)


# ------------------------------------------------------------------ 部署包

REDIRECT_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=__TO__">
<title>页面已迁移</title>
<style>body{font:16px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
color:#1e2330;background:#f4f6fa;padding:48px 20px;text-align:center}
a{color:#2557c7}</style>
</head>
<body>
<p>这个地址已经并入新的题库结构，正在跳转…</p>
<p><a href="__TO__">若没有自动跳转，点这里</a></p>
<script>location.replace('__TO__' + (location.hash || ''));</script>
</body>
</html>
"""

# 旧站路径 → 新路径（保持书签、二维码可用）
LEGACY_PATHS = {
    "unit1.html": "collections/cs/dist/banks/u1/index.html",
    "unit2.html": "collections/cs/dist/banks/u2/index.html",
    "unit3.html": "collections/cs/dist/banks/u3/index.html",
    "unit4.html": "collections/cs/dist/banks/u4/index.html",
    "exam.html": "collections/cs/dist/banks/exam/index.html",
    "terms.html": "collections/cs/dist/banks/terms/index.html",
    "calc.html": "collections/cs/dist/banks/calc/index.html",
    "midterm.html": "collections/cs/dist/index.html",
}


def build_deploy():
    """把根入口 + 各题库集产物 + 旧路径跳转页装进 deploy/，整目录即可上传。"""
    out = ROOT / "deploy"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir()

    shutil.copy2(ROOT / "index.html", out / "index.html")
    for col in (ROOT / "collections").iterdir():
        if not (col / "dist").exists():
            continue
        shutil.copytree(col / "dist", out / "collections" / col.name / "dist")

        # dist 里是占位符配置；部署包换成真实配置（只在这里落一次真实 Key）
        ph_cfg, real_cfg = resolve_sync_cfg(col)
        if not real_cfg:
            continue
        ph_js = "window.QB_SYNC_CFG=" + js(ph_cfg) + ";"
        real_js = "window.QB_SYNC_CFG=" + js(real_cfg) + ";"
        n = 0
        for page in (out / "collections" / col.name / "dist").rglob("*.html"):
            text = page.read_text(encoding="utf-8")
            if ph_js in text:
                page.write_text(text.replace(ph_js, real_js), encoding="utf-8")
                n += 1
        if n:
            print(f"  同步配置已注入 {col.name}：{n} 个页面（只写 deploy/，dist/ 保持占位符）")

    for old, new in LEGACY_PATHS.items():
        (out / old).write_text(REDIRECT_HTML.replace("__TO__", new), encoding="utf-8")

    (out / "robots.txt").write_text("User-agent: *\nAllow: /\n", encoding="utf-8")
    files = [p for p in out.rglob("*") if p.is_file()]
    total = sum(p.stat().st_size for p in files)
    print(f"\n部署包已生成：deploy/  {len(files)} 个文件  {total / 1024 / 1024:.1f} MB")
    print(f"  旧路径跳转：{'、'.join(LEGACY_PATHS)}")
    return out


# ------------------------------------------------------------------ 校验

def run_gate(col_id: str) -> bool:
    col_dir = ROOT / "collections" / col_id
    print(f"\n=== 校验 {col_id}（题库集站点）===")
    try:
        site = qb_gate.Site(col_dir)
    except qb_gate.GateError as exc:
        print(f"✗ {exc}")
        return False
    fails, warns = qb_gate.run_check(site)
    for code, msg in fails:
        print(f"✗ {code}  {msg}")
    for msg in warns:
        print(f"⚠ {msg}")
    rfails, reports = qb_gate.run_roundtrip(site, "subject")
    for kind, key, n, size in reports:
        print(f"  {kind}:{key or '-'}  {n} gid  {size} 字节 / 预算 {site.budget}")
    for code, msg in rfails:
        print(f"✗ {code}  {msg}")
    ok = not fails and not rfails
    print(f"硬失败 {len(fails) + len(rfails)} 项｜告警 {len(warns)} 项｜题量 {len(site.questions)}")

    # 每个独立部署包单独再校验一次
    print(f"=== 校验 {col_id} 的独立部署包 ===")
    pkg_root = col_dir / "dist" / "banks"
    bad = 0
    if pkg_root.exists():
        for pkg in sorted(pkg_root.iterdir()):
            if not pkg.is_dir():
                continue
            try:
                psite = qb_gate.Site(pkg)
            except qb_gate.GateError as exc:
                print(f"  ✗ {pkg.name}: {exc}")
                bad += 1
                continue
            pf, pw = qb_gate.run_check(psite)
            prf, _ = qb_gate.run_roundtrip(psite, "unit")
            if pf or prf:
                bad += 1
                print(f"  ✗ {pkg.name}: {len(pf) + len(prf)} 项硬失败")
                for code, msg in (pf + prf)[:3]:
                    print(f"      {code} {msg}")
            else:
                print(f"  ✓ {pkg.name:<10} {len(psite.questions):>4} 题  {len(pw)} 告警")
    return ok and bad == 0


# ------------------------------------------------------------------ 挂载

def mount(col_id: str):
    col_dir = ROOT / "collections" / col_id
    col_cfg = load(col_dir / "collection.config.json")
    catalog = load(ROOT / "catalog.json")
    entries = catalog.setdefault("collections", [])
    if any(e["id"] == col_id for e in entries):
        print(f"题库集 {col_id} 已在 catalog.json 中")
        return
    entries.append({
        "id": col_id,
        "name": col_cfg["name"],
        "dir": f"collections/{col_id}",
        "subject": col_cfg.get("subjectKey"),
        "accent": col_cfg.get("accent", "#2f6fed"),
        "status": col_cfg.get("status", "active"),
        "order": col_cfg.get("order", len(entries) + 1),
    })
    entries.sort(key=lambda e: e.get("order", 99))
    save(ROOT / "catalog.json", catalog)
    print(f"已挂载 {col_cfg['name']} → catalog.json")


# ------------------------------------------------------------------ 入口

def main(argv=None):
    ap = argparse.ArgumentParser(description="大一题库构建器")
    ap.add_argument("command", choices=("build", "check", "mount", "status", "deploy-pack"))
    ap.add_argument("target", nargs="?", help="题库集 id（mount 时必填）")
    ap.add_argument("--collection", help="只处理某个题库集")
    args = ap.parse_args(argv)

    catalog = load(ROOT / "catalog.json")

    if args.command == "mount":
        if not args.target:
            print("用法：qb_build.py mount <collectionId>")
            return 2
        mount(args.target)
        return 0

    ids = [args.collection] if args.collection else [e["id"] for e in catalog["collections"]]

    if args.command == "status":
        for cid in ids:
            col_cfg = load(ROOT / "collections" / cid / "collection.config.json")
            site_cfg = load(ROOT / "collections" / cid / "site.config.json")
            subj = load(ROOT / "collections" / cid / "subjects" / site_cfg["subjects"][0]["key"]
                        / "subject.config.json")
            units = subject_units(subj)
            n = 0
            for u in units:
                n += len(unit_questions(ROOT / "collections" / cid / "subjects" / subj["key"], u))
            print(f"{cid:<8} {col_cfg['name']:<12} {len(units)} 个独立题库  {n} 条题目记录")
        return 0

    if args.command == "check":
        ok = all([run_gate(cid) for cid in ids])
        return 0 if ok else 1

    results = []
    for cid in ids:
        print(f"\n构建题库集 {cid} …")
        results.append(build_collection(cid))
    build_root(results)
    print("\n根入口已生成：index.html")
    ok = all([run_gate(cid) for cid in ids])
    if ok and not args.collection:
        build_deploy()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
