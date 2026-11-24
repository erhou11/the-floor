#!/usr/bin/env python3
"""
The Floor — a live read Englishtaskmarket. No, docstring only English.

A read-only dashboard for Taskmarket's public market API.

  python3 app.py --refresh          # fetch once, write data/snapshot.json
  python3 app.py --serve --port 8787  # serve the site and refresh in the background

Only the Python standard library is used.
"""
import gzip
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

API = "https://api.taskmarket.dev/api"
UA = "the-floor/1.0 (Taskmarket bounty visualizer; read-only)"
CHAINS = {4217: {"name": "Tempo", "token": "OUSD"}, 8453: {"name": "Base", "token": "USDC"}}
RANGES = ("7d", "30d", "90d", "all")
REFRESH_SECONDS = int(os.environ.get("FLOOR_REFRESH_SECONDS", "600"))
TASKS_EVERY = int(os.environ.get("FLOOR_TASKS_EVERY", "600"))
ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")
SNAPSHOT = os.path.join(DATA_DIR, "snapshot.json")
RAW = os.path.join(DATA_DIR, "raw.json")
WEB = os.path.join(ROOT, "web")

_lock = threading.Lock()
_mem = {"snapshot": None, "mtime": 0}


# ---------------------------------------------------------------- fetch

def get_json(path, timeout=40):
    req = urllib.request.Request(API + path, headers={"User-Agent": UA, "Accept": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise
        except Exception:
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise


def fetch_tasks(chain):
    out, cursor, pages = [], None, 0
    while True:
        q = f"/tasks?chainId={chain}&sort=newest&limit=100" + (f"&cursor={urllib.parse.quote(cursor)}" if cursor else "")
        d = get_json(q)
        ts = d.get("tasks") or []
        out.extend(ts)
        pages += 1
        if not ts or not d.get("hasMore") or pages > 60:
            break
        cursor = d.get("nextCursor")
        if not cursor:
            break
    return out


def fetch_all(prev_raw=None):
    """Fetch every endpoint used by the page. Returns raw payloads."""
    raw = {"fetchedAt": now_iso(), "chains": {}, "tasks": {}}
    for chain in CHAINS:
        c = {}
        c["market"] = get_json(f"/market/stats?chainId={chain}")
        c["breakdowns"] = get_json(f"/stats/breakdowns?chainId={chain}")
        c["series"] = {}
        for r in RANGES:
            c["series"][r] = get_json(f"/stats/platform-time-series?chainId={chain}&range={r}&bucket=day")
        c["series"]["allWeek"] = get_json(f"/stats/platform-time-series?chainId={chain}&range=all&bucket=week")
        c["heatmap"] = {}
        for r in RANGES:
            c["heatmap"][r] = {}
            for dim in ("mode", "hourOfWeek"):
                c["heatmap"][r][dim] = get_json(
                    f"/stats/activity-heatmap?chainId={chain}&range={r}&dimension={dim}")
        c["feed"] = get_json(f"/stats/activity-feed?chainId={chain}&limit=50")
        raw["chains"][str(chain)] = c

    # The task list is the expensive part. Reuse the previous copy when it is
    # still fresh enough; a per-task cache keeps the dashboard useful offline.
    prev_tasks = (prev_raw or {}).get("tasks") or {}
    prev_at = (prev_raw or {}).get("tasksFetchedAt")
    fresh = False
    if prev_at:
        try:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(prev_at.replace("Z", "+00:00"))).total_seconds()
            fresh = age < TASKS_EVERY and all(str(c) in prev_tasks for c in CHAINS)
        except Exception:
            fresh = False
    if fresh:
        raw["tasks"] = prev_tasks
        raw["tasksFetchedAt"] = prev_at
    else:
        for chain in CHAINS:
            raw["tasks"][str(chain)] = fetch_tasks(chain)
        raw["tasksFetchedAt"] = now_iso()
    raw["feedFetchedAt"] = raw["chains"]["4217"]["feed"].get("_fetchedAt") or raw["fetchedAt"]
    return raw


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------- aggregate

def units(v):
    try:
        return int(v) / 1_000_000
    except Exception:
        return 0.0


def short_addr(a):
    if not a or len(a) < 12:
        return a or ""
    return a[:6] + "\u2026" + a[-4:]


def week_start(iso):
    d = datetime.fromisoformat(iso.replace("Z", "+00:00")).date()
    return (d - timedelta(days=d.weekday())).isoformat()


def pct(part, whole):
    return round(100.0 * part / whole, 1) if whole else 0.0


def summarize_tasks(tasks, chain):
    n = len(tasks)
    if not n:
        return {"count": 0}
    created = sorted(t["createdAt"] for t in tasks)
    rewards = [units(t.get("reward")) for t in tasks]
    subs = [int(t.get("submissionCount") or 0) for t in tasks]

    by_req = {}
    for t, r in zip(tasks, rewards):
        a = (t.get("requester") or "").lower()
        e = by_req.setdefault(a, {"addr": t.get("requester") or "", "tasks": 0, "reward": 0.0, "subs": 0})
        e["tasks"] += 1
        e["reward"] += r
        e["subs"] += int(t.get("submissionCount") or 0)
    posters = sorted(by_req.values(), key=lambda x: (-x["tasks"], -x["reward"]))
    total_reward = sum(rewards)
    total_subs = sum(subs)

    def share(vals, k, key):
        top = sorted(vals, key=lambda x: -x[key])[:k]
        return pct(sum(x[key] for x in top), total_reward if key == "reward" else n)

    top = []
    for p in posters[:12]:
        top.append({
            "addr": p["addr"], "short": short_addr(p["addr"]),
            "tasks": p["tasks"], "reward": round(p["reward"], 2), "subs": p["subs"],
            "shareTasks": pct(p["tasks"], n), "shareReward": pct(p["reward"], total_reward),
        })

    # weeks
    weeks, wk = [], {}
    for t, r in zip(tasks, rewards):
        w = week_start(t["createdAt"])
        e = wk.setdefault(w, {"week": w, "tasks": 0, "reward": 0.0, "subs": 0, "posters": set()})
        e["tasks"] += 1
        e["reward"] += r
        e["subs"] += int(t.get("submissionCount") or 0)
        e["posters"].add((t.get("requester") or "").lower())
    for w in sorted(wk):
        e = wk[w]
        weeks.append({"week": w, "tasks": e["tasks"], "posters": len(e["posters"]),
                      "reward": round(e["reward"], 2), "subs": e["subs"]})

    # daily, for the chain comparison chart
    daily = {}
    for t, r in zip(tasks, rewards):
        d = t["createdAt"][:10]
        e = daily.setdefault(d, {"day": d, "tasks": 0, "reward": 0.0, "subs": 0})
        e["tasks"] += 1
        e["reward"] += r
        e["subs"] += int(t.get("submissionCount") or 0)
    daily_list = [daily[k] for k in sorted(daily)]
    for d in daily_list:
        d["reward"] = round(d["reward"], 2)

    buckets = [("0", lambda s: s == 0), ("1", lambda s: s == 1), ("2\u20135", lambda s: 2 <= s <= 5),
               ("6\u201320", lambda s: 6 <= s <= 20), ("21\u2013100", lambda s: 21 <= s <= 100),
               ("100+", lambda s: s > 100)]
    dist = [{"label": label, "tasks": sum(1 for s in subs if f(s))} for label, f in buckets]

    top_subs = sorted(tasks, key=lambda t: -int(t.get("submissionCount") or 0))[:8]
    top_tasks = [{
        "ref": t.get("referenceCode"), "id": t.get("id"), "title": (t.get("description") or "").strip().split("\n")[0][:110],
        "reward": round(units(t.get("reward")), 2), "subs": int(t.get("submissionCount") or 0),
        "status": t.get("status"), "mode": t.get("mode"), "postedAt": t.get("createdAt"),
        "requester": short_addr(t.get("requester")),
    } for t in top_subs]

    settled = [t for t in tasks if t.get("status") in ("completed", "expired", "cancelled")]
    dead = [t for t in tasks if t.get("status") in ("expired", "cancelled")]
    zero_settled = [t for t in settled if int(t.get("submissionCount") or 0) == 0]

    statuses, modes = {}, {}
    for t in tasks:
        statuses[t.get("status")] = statuses.get(t.get("status"), 0) + 1
        modes[t.get("mode")] = modes.get(t.get("mode"), 0) + 1

    reward_sorted = sorted(rewards)
    median_reward = reward_sorted[len(reward_sorted) // 2] if reward_sorted else 0
    p90_reward = reward_sorted[int(len(reward_sorted) * 0.9)] if reward_sorted else 0
    open_tasks = [t for t in tasks if t.get("status") == "open"]
    open_reward = round(sum(units(t.get("reward")) for t in open_tasks), 2)
    top5_subs = sum(int(t.get("submissionCount") or 0) for t in top_subs)

    # capital flow: reward put up, by poster -> mode -> outcome
    flow_posters = sorted(by_req.values(), key=lambda x: -x["reward"])[:5]
    flow_other = [p for p in by_req.values() if p not in flow_posters]
    p_index = {p["addr"].lower(): i for i, p in enumerate(flow_posters)}
    other_key = "__other__"
    p_nodes = [{"name": short_addr(p["addr"]), "reward": round(p["reward"], 2)} for p in flow_posters]
    if flow_other:
        p_nodes.append({"name": f"{len(flow_other)} more wallets", "reward": round(sum(x["reward"] for x in flow_other), 2)})
    mode_order = ["bounty", "claim", "pitch", "benchmark", "auction"]
    mode_nodes = []
    for mo in mode_order:
        r = sum(units(t.get("reward")) for t in tasks if t.get("mode") == mo)
        if r > 0:
            mode_nodes.append({"name": mo, "reward": round(r, 2)})
    m_index = {m["name"]: i for i, m in enumerate(mode_nodes)}
    out_order = ["completed", "open", "pending_approval", "claimed", "expired", "cancelled", "worker_selected"]
    out_nodes = []
    for st in out_order:
        r = sum(units(t.get("reward")) for t in tasks if t.get("status") == st)
        if r > 0:
            out_nodes.append({"name": st, "reward": round(r, 2)})
    o_index = {o["name"]: i for i, o in enumerate(out_nodes)}
    links1 = {}
    for t in tasks:
        a = (t.get("requester") or "").lower()
        pi = p_index.get(a, len(p_nodes) - 1 if flow_other else 0)
        mi = m_index.get(t.get("mode"))
        if mi is None:
            continue
        key = (pi, mi)
        links1[key] = links1.get(key, 0) + units(t.get("reward"))
    links2 = {}
    for t in tasks:
        mi = m_index.get(t.get("mode")); oi = o_index.get(t.get("status"))
        if mi is None or oi is None:
            continue
        key = (mi, oi)
        links2[key] = links2.get(key, 0) + units(t.get("reward"))
    flow = {
        "posters": p_nodes, "modes": mode_nodes, "outcomes": out_nodes,
        "links1": [[a, b, round(v, 2)] for (a, b), v in sorted(links1.items())],
        "links2": [[a, b, round(v, 2)] for (a, b), v in sorted(links2.items())],
        "total": round(total_reward, 2),
    }

    board = []
    for t in sorted(tasks, key=lambda x: x["createdAt"]):
        board.append([
            t.get("referenceCode") or "", t.get("status") or "", t.get("mode") or "",
            round(units(t.get("reward")), 2), int(t.get("submissionCount") or 0),
            t["createdAt"][:10], short_addr(t.get("requester")),
            (t.get("description") or "").strip().split("\n")[0][:90],
        ])
    month_ago = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    recent = [t for t, r in zip(tasks, rewards) if t["createdAt"] >= month_ago]

    return {
        "count": n,
        "from": created[0], "to": created[-1],
        "distinctPosters": len(by_req),
        "topPosters": top,
        "top1TasksShare": pct(posters[0]["tasks"], n) if posters else 0,
        "top5TasksShare": share(posters, 5, "tasks"),
        "top10TasksShare": share(posters, 10, "tasks"),
        "top1RewardShare": pct(posters[0]["reward"], total_reward) if posters else 0,
        "top5RewardShare": share(posters, 5, "reward"),
        "top10RewardShare": share(posters, 10, "reward"),
        "totalReward": round(total_reward, 2),
        "medianReward": round(median_reward, 2),
        "p90Reward": round(p90_reward, 2),
        "openTasks": len(open_tasks),
        "openReward": open_reward,
        "top5SubsShare": pct(top5_subs, total_subs),
        "board": board,
        "flow": flow,
        "under5": sum(1 for r in rewards if r < 5),
        "submissions": total_subs,
        "subsPerTask": round(total_subs / n, 1) if n else 0,
        "rewardPerSubmission": round(total_reward / total_subs, 3) if total_subs else 0,
        "subsDistribution": dist,
        "topTasks": top_tasks,
        "settled": len(settled),
        "dead": len(dead),
        "deadShare": pct(len(dead), len(settled)),
        "zeroSubSettled": len(zero_settled),
        "zeroSubSettledShare": pct(len(zero_settled), len(settled)),
        "statuses": statuses,
        "modes": modes,
        "weeks": weeks,
        "daily": daily_list,
        "recent30": {
            "tasks": len(recent),
            "posters": len({(t.get("requester") or "").lower() for t in recent}),
            "reward": round(sum(units(t.get("reward")) for t in recent), 2),
            "subs": sum(int(t.get("submissionCount") or 0) for t in recent),
        },
        "currentWeek": week_start(now_iso()),
    }


def summarize_series(series):
    """Last-7-day vs previous-7-day totals, and per-metric spans."""
    def total(rows, key):
        return sum(units(r.get(key)) if isinstance(r.get(key), str) else (r.get(key) or 0) for r in rows)

    out = {}
    if not series:
        return out
    last7 = series[-7:]
    prev7 = series[-14:-7]
    out["last7"] = {
        "tasksPosted": total(last7, "tasksCreated"),
        "rewardPutUp": round(total(last7, "rewardVolume"), 2),
        "rewardPaid": round(total(last7, "paidVolume"), 2),
        "settlements": total(last7, "settlements"),
        "activeAgents": max((r.get("activeAgents") or 0) for r in last7) if last7 else 0,
        "newAgents": total(last7, "newAgents"),
        "completedTasks": total(last7, "completedTasks"),
    }
    out["prev7"] = {
        "tasksPosted": total(prev7, "tasksCreated"),
        "rewardPutUp": round(total(prev7, "rewardVolume"), 2),
        "rewardPaid": round(total(prev7, "paidVolume"), 2),
        "settlements": total(prev7, "settlements"),
        "activeAgents": max((r.get("activeAgents") or 0) for r in prev7) if prev7 else 0,
        "completedTasks": total(prev7, "completedTasks"),
    }
    out["last30"] = {
        "tasksPosted": total(series[-30:], "tasksCreated"),
        "rewardPutUp": round(total(series[-30:], "rewardVolume"), 2),
        "rewardPaid": round(total(series[-30:], "paidVolume"), 2),
        "settlements": total(series[-30:], "settlements"),
        "activeAgents": max((r.get("activeAgents") or 0) for r in series[-30:]) if series else 0,
    }
    return out


def build_snapshot(raw):
    a = raw["chains"]["4217"]
    b = raw["chains"]["8453"]
    tasks_at = raw.get("tasksFetchedAt") or raw["fetchedAt"]
    snap = {"generatedAt": raw["fetchedAt"], "tasksFetchedAt": tasks_at,
            # the page says "data as of" the older of the two fetches: every
            # figure on it was true then, and none is older than this.
            "dataAsOf": min(raw["fetchedAt"], tasks_at),
            "refreshSeconds": REFRESH_SECONDS, "chains": {},
            "platform": {
                "series": a["series"],
                "seriesSummary": summarize_series(a["series"]["30d"]),
                "heatmap": compact_heatmaps(a["heatmap"]),
                "breakdowns": a["breakdowns"],
                "feed": list(a["feed"].get("items", [])),
                # The API answers both chainId values with one platform payload.
                # Recorded per refresh so the page can say so, or stop saying it.
                "identical": {
                    "series": a["series"] == b["series"],
                    "breakdowns": a["breakdowns"] == b["breakdowns"],
                    "heatmap": a["heatmap"] == b["heatmap"],
                    "feed": a["feed"] == b["feed"],
                },
            },
            "endpoints": ENDPOINT_LIST}
    for chain, meta in CHAINS.items():
        c = raw["chains"][str(chain)]
        tasks = raw["tasks"].get(str(chain)) or []
        snap["chains"][str(chain)] = {
            "chainId": chain, "name": meta["name"], "token": meta["token"],
            "market": c["market"],
            "tasks": summarize_tasks(tasks, chain),
        }
    return snap


def compact_heatmaps(hm):
    """{range: {dim: {rowKeys, colKeys, cells:[{row,col,count,volume}], maxCount}}}
    -> same, with cells as [row, col, count] triples."""
    out = {}
    for rng, dims in hm.items():
        out[rng] = {}
        for dim, grid in dims.items():
            out[rng][dim] = {
                "rowKeys": grid.get("rowKeys", []),
                "colKeys": grid.get("colKeys", []),
                "maxCount": grid.get("maxCount", 0),
                "cells": [[c.get("row"), c.get("col"), c.get("count", 0)] for c in grid.get("cells", [])],
            }
    return out


ENDPOINT_LIST = [
    {"path": "/api/market/stats?chainId={chain}", "used": "Headline numbers."},
    {"path": "/api/stats/breakdowns?chainId={chain}", "used": "Tasks by status, mode and actor type."},
    {"path": "/api/stats/platform-time-series?chainId={chain}&range=7d|30d|90d|all&bucket=day",
     "used": "Daily active agents, tasks posted, rewards put up, rewards paid over time; bucket=week for the all range."},
    {"path": "/api/stats/activity-heatmap?chainId={chain}&range=7d|30d|90d|all&dimension=mode|hourOfWeek",
     "used": "Activity heatmaps (mode by day, and weekday by hour, UTC)."},
    {"path": "/api/stats/activity-feed?chainId={chain}&limit=50", "used": "The live feed and the hero swarm."},
    {"path": "/api/tasks?chainId={chain}&sort=newest&limit=100&cursor=...",
     "used": "Every task, page by page: posters per week, concentration, submission counts, rewards per task."},
]


# ---------------------------------------------------------------- refresh + store

def refresh(force_tasks=False):
    prev_raw = None
    if os.path.exists(RAW):
        try:
            prev_raw = json.load(open(RAW))
        except Exception:
            prev_raw = None
    if force_tasks and prev_raw:
        prev_raw.pop("tasksFetchedAt", None)
    raw = fetch_all(prev_raw)
    snap = build_snapshot(raw)
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = RAW + ".tmp"
    json.dump(raw, open(tmp, "w"), separators=(",", ":"))
    os.replace(tmp, RAW)
    tmp = SNAPSHOT + ".tmp"
    json.dump(snap, open(tmp, "w"), separators=(",", ":"))
    os.replace(tmp, SNAPSHOT)
    with _lock:
        _mem["snapshot"] = snap
        _mem["mtime"] = time.time()
    return snap


def load_snapshot():
    with _lock:
        if _mem["snapshot"] is not None:
            return _mem["snapshot"]
    try:
        with open(SNAPSHOT, "rb") as f:
            data = f.read()
        snap = json.loads(data)
        with _lock:
            _mem["snapshot"] = snap
            _mem["mtime"] = os.path.getmtime(SNAPSHOT)
        return snap
    except Exception:
        return None


def refresher():
    while True:
        try:
            refresh()
        except Exception as e:
            sys.stderr.write(f"[floor] refresh failed: {e}\n")
        time.sleep(REFRESH_SECONDS)


# ---------------------------------------------------------------- http

SITE = os.environ.get("FLOOR_SITE", "https://floor.952121.xyz")
# No third-party anything: scripts, styles, fonts, connections and images are
# first-party only. This also stops edge HTML rewriting from adding a beacon.
SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; "
        "form-action 'none'; frame-ancestors 'none'"
    ),
    "X-Frame-Options": "DENY",
}
OG_VIEWS = {
    "": ("The Floor — a live read of the Taskmarket market",
          "Every task posted, every reward held, every agent that showed up. Read live from Taskmarket's public API."),
    "board": ("The board — every Taskmarket task, one tile each",
               "Every task posted, one tile, coloured by its outcome. The market as a grid you can read at a glance."),
    "swarm": ("The swarm — Taskmarket's submissions, counted",
               "Thousands of submissions land on a handful of tasks. Each dot is one submission, drawn around the task it was sent to."),
    "capital": ("Capital — who puts rewards up on Taskmarket",
                 "A small number of wallets posts most of the reward. The ten largest posters, and what is still held in escrow."),
    "time": ("Time — Taskmarket, day by day",
              "Active agents, tasks posted, rewards put up and rewards paid, day by day."),
    "rhythm": ("Rhythm — the week has a shape",
                "When the market wakes up, weekday by hour, in UTC."),
    "posters": ("Posters — distinct task posters per week",
                 "Unique requester addresses per ISO week, counted from every page of the task list."),
    "methods": ("Methods — how The Floor reads the API",
                 "Endpoints, definitions, refresh and cache, and how to reproduce every number."),
}

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
        ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".svg": "image/svg+xml",
        ".json": "application/json", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "the-floor"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def _send(self, body, ctype, cache="public, max-age=60", status=200, extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        accepts_gzip = "gzip" in (self.headers.get("Accept-Encoding") or "")
        if accepts_gzip and len(body) > 1024 and ctype.split("/")[0] in ("application", "text", "image/svg"):
            body = gzip.compress(body, 6)
            enc = "gzip"
        else:
            enc = None
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if enc:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def _index(self, query):
        """One page, per-view social metadata, no build step."""
        q = urllib.parse.parse_qs(query)
        view = (q.get("view") or [""])[0]
        chainkey = (q.get("chain") or ["tempo"])[0].lower()
        chainkey = "base" if chainkey in ("base", "8453") else "tempo"
        rng = (q.get("range") or ["30d"])[0]
        if view not in OG_VIEWS:
            view = ""
        title, desc = OG_VIEWS[view]
        og = f"/og/{view or 'default'}-{chainkey}.png"
        if not os.path.isfile(os.path.join(WEB, og.lstrip("/"))):
            og = f"/og/{view or 'default'}.png"
        if not os.path.isfile(os.path.join(WEB, og.lstrip("/"))):
            og = "/og/default.png"
        canon = SITE + "/" + ("?" + urllib.parse.urlencode({k: v for k, v in
                 [("chain", chainkey), ("range", rng if rng in ("7d", "30d", "90d", "all") else "30d"), ("view", view)] if v}))
        html = open(os.path.join(WEB, "index.html"), encoding="utf-8").read()
        html = (html.replace("{{OG_TITLE}}", title).replace("{{OG_DESC}}", desc)
                .replace("{{OG_IMAGE}}", SITE + og).replace("{{CANONICAL}}", canon))
        return html

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path in ("/healthz", "/api/health"):
            return self._send(json.dumps({"ok": True, "dataAsOf": (load_snapshot() or {}).get("dataAsOf")}),
                              "application/json", cache="no-store")
        if path == "/api/data":
            snap = load_snapshot()
            if not snap:
                return self._send(json.dumps({"error": "warming up"}), "application/json", cache="no-store", status=503)
            body = json.dumps(snap, separators=(",", ":"))
            return self._send(body, "application/json", cache="public, max-age=60, s-maxage=300")
        if path == "/api/snapshot.json":
            try:
                body = open(SNAPSHOT, "rb").read()
            except Exception:
                return self._send("{}", "application/json", status=503)
            return self._send(body, "application/json", cache="public, max-age=60")
        if path == "/api/raw.json":
            try:
                body = open(RAW, "rb").read()
            except Exception:
                return self._send("{}", "application/json", status=503)
            return self._send(body, "application/json", cache="public, max-age=60")
        # static
        rel = path.lstrip("/") or "index.html"
        if rel.endswith("/"):
            rel += "index.html"
        full = os.path.normpath(os.path.join(WEB, rel))
        if not full.startswith(WEB + os.sep) and full != WEB:
            return self._send("not found", "text/plain", status=404)
        if not os.path.isfile(full):
            # deep links fall back to the single page
            full = os.path.join(WEB, "index.html")
            if not os.path.isfile(full):
                return self._send("not found", "text/plain", status=404)
        if full.endswith("index.html"):
            # no-transform keeps the page byte-for-byte ours: no edge HTML rewriting
            # (Cloudflare would otherwise inject its analytics beacon into the page).
            return self._send(self._index(parsed.query), "text/html; charset=utf-8",
                              cache="public, max-age=60, no-transform", extra=SECURITY_HEADERS)
        ext = os.path.splitext(full)[1].lower()
        if ext in (".woff2", ".ttf", ".otf", ".png", ".jpg", ".svg", ".ico"):
            cache = "public, max-age=604800"
        elif ext in (".css", ".js"):
            cache = "public, max-age=3600"
        else:
            cache = "public, max-age=60"
        try:
            body = open(full, "rb").read()
        except Exception:
            return self._send("not found", "text/plain", status=404)
        return self._send(body, MIME.get(ext, "application/octet-stream"), cache=cache)


def serve(port, bind="0.0.0.0"):
    if load_snapshot() is None:
        try:
            refresh()
        except Exception as e:
            sys.stderr.write(f"[floor] initial refresh failed: {e}\n")
    threading.Thread(target=refresher, daemon=True).start()
    httpd = ThreadingHTTPServer((bind, port), Handler)
    sys.stderr.write(f"[floor] serving on {bind}:{port}\n")
    httpd.serve_forever()


if __name__ == "__main__":
    if "--refresh" in sys.argv:
        snap = refresh(force_tasks="--tasks" in sys.argv)
        print(json.dumps({"generatedAt": snap["generatedAt"],
                          "chains": {k: v["tasks"].get("count") for k, v in snap["chains"].items()}}))
    elif "--serve" in sys.argv:
        port = 8787
        bind = os.environ.get("FLOOR_BIND", "0.0.0.0")
        if "--port" in sys.argv:
            port = int(sys.argv[sys.argv.index("--port") + 1])
        if "--bind" in sys.argv:
            bind = sys.argv[sys.argv.index("--bind") + 1]
        serve(port, bind)
    else:
        print(__doc__)
