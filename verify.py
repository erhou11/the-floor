#!/usr/bin/env python3
"""Check The Floor against the live Taskmarket API.

    python3 verify.py [https://floor.952121.xyz]

It reads the site's snapshot, recomputes each headline and task-derived figure
from the API, and prints both values with their difference. A snapshot is by
design a few minutes old, so fast-moving counts can differ slightly; the values
that are cumulative (listed tasks, posters, submissions already made) should
match exactly.
"""
import json
import sys
import urllib.request

API = "https://api.taskmarket.dev/api"
UA = "the-floor-verifier/1.0"
SITE = (sys.argv[1] if len(sys.argv) > 1 else "https://floor.952121.xyz").rstrip("/")


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.loads(r.read().decode())


def units(v):
    return int(v) / 1_000_000


def main():
    snap = get(SITE + "/api/snapshot.json")
    print(f"site snapshot: {snap['generatedAt']}   (task list {snap.get('tasksFetchedAt')})")
    print(f"as of now:     fetching live API…\n")
    rows = []

    for chain, meta in (("4217", "Tempo"), ("8453", "Base")):
        market = get(f"{API}/market/stats?chainId={chain}")
        s = snap["platform"]["series"]
        last7 = s["30d"][-7:]
        rows.append((f"{meta} · open tasks (market/stats → openTasks)",
                     snap["chains"][chain]["market"]["openTasks"], market["openTasks"]))
        rows.append((f"{meta} · active agents 7d (market/stats → activeAgents7d)",
                     snap["chains"][chain]["market"]["activeAgents7d"], market["activeAgents7d"]))
        if chain == "4217":
            rows.append(("Platform · tasks posted 7d (platform-time-series → Σ tasksCreated)",
                         round(sum(r["tasksCreated"] for r in last7)),
                         round(sum(r["tasksCreated"] for r in get(f"{API}/stats/platform-time-series?chainId=4217&range=30d&bucket=day")[-7:]))))
            rows.append(("Platform · rewards paid 7d (platform-time-series → Σ paidVolume)",
                         round(sum(units(r["paidVolume"]) for r in last7), 2),
                         round(sum(units(r["paidVolume"]) for r in get(f"{API}/stats/platform-time-series?chainId=4217&range=30d&bucket=day")[-7:]), 2)))

        # the task list, page by page, exactly as the dashboard does it
        tasks, cursor = [], None
        while True:
            q = f"{API}/tasks?chainId={chain}&sort=newest&limit=100" + (f"&cursor={cursor}" if cursor else "")
            d = get(q)
            tasks += d.get("tasks") or []
            if not d.get("hasMore") or not d.get("nextCursor"):
                break
            cursor = d["nextCursor"]
        snap_t = snap["chains"][chain]["tasks"]
        rows.append((f"{meta} · listed tasks (/tasks, all pages)",
                     snap_t["count"], len(tasks)))
        rows.append((f"{meta} · distinct posters (/tasks → unique requester)",
                     snap_t["distinctPosters"], len({t["requester"].lower() for t in tasks})))
        rows.append((f"{meta} · submissions (/tasks → Σ submissionCount)",
                     snap_t["submissions"], sum(int(t.get("submissionCount") or 0) for t in tasks)))

    width = max(len(r[0]) for r in rows)
    bad = 0
    for label, snapv, livev in rows:
        if snapv == livev:
            mark = "match"
        else:
            diff = (livev - snapv)
            mark = f"moved by {diff:+}" if isinstance(snapv, (int, float)) else "differs"
            bad += 1
        print(f"{label:<{width}}  snapshot {snapv!s:>10}   live {livev!s:>10}   {mark}")
    print("\nCumulative counts should match exactly; live counters move between the snapshot and now.")
    return 0 if bad <= 2 else 1


if __name__ == "__main__":
    sys.exit(main())
