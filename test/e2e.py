"""Linkpost end to end: two strangers' agents, by their links only (urllib = 'web access')."""
import re, sys, time, threading, urllib.parse as U, urllib.request as R
B = sys.argv[1].rstrip("/")
def loc(u): return re.sub(r"^https?://[^/]+", B, u)
def get(url):
    url = loc(url)
    with R.urlopen(R.Request(url, headers={"User-Agent": "Mozilla/5.0 (agent test)"}), timeout=40) as r: return r.read().decode()
def post(url, data):
    url = loc(url)
    return R.urlopen(R.Request(url, U.urlencode(data, doseq=True).encode(), headers={"User-Agent": "Mozilla/5.0 (agent test)"}), timeout=40).read().decode()
def signup(name, handle, agents):
    page = post(B + "/start", {"name": name, "handle": handle, "agent": agents})
    links = dict(re.findall(r"I am @[a-z0-9-]+/([a-z0-9-]+)\.", page) and
                 zip(re.findall(r"I am @[a-z0-9-]+/([a-z0-9-]+)\.", page),
                     re.findall(r"(https?://\S+/a/[A-Za-z0-9]+)", page)))
    owner = re.search(r"(https?://\S+/o/[A-Za-z0-9]+)", page).group(1)
    assert links, page[-800:]
    return links, owner
def check(cond, what):
    print(("PASS " if cond else "FAIL ") + what); 
    if not cond: sys.exit(1)
run = str(int(time.time()))[-5:]
z, zo = signup("Zeke Voigt", f"zeke{run}", ["muse", "claude-code"])
d, do = signup("Dad Voigt", f"dad{run}", ["muse"])
check(set(z) == {"muse", "claude-code"} and set(d) == {"muse"}, "sign-up gives one link per agent + owner page")
zm, zc, dm = z["muse"], z["claude-code"], d["muse"]
p = get(zm); check(f"@zeke{run}/claude-code" in p and "your own agent" in p, "own agents auto-connected")
out = get(zc + "/say?" + U.urlencode({"to": f"@zeke{run}/muse", "text": "hi from claude"}))
check("Sent to" in out, "own agents message without a request")
check("hi from claude" in get(zm), "Muse reads Claude's message")
f = get(dm + "/find?q=zeke+voigt"); check(f"@zeke{run}" in f, "a stranger finds Zeke by name")
f = get(dm + f"/find?q=zeke{run}"); check(f"@zeke{run}" in f, "and by handle")
out = get(dm + "/say?" + U.urlencode({"to": f"@zeke{run}", "text": "spam"}))
check("no contact" in out, "a stranger cannot message before a request is accepted")
out = get(dm + "/reach?" + U.urlencode({"to": f"@zeke{run}", "why": "say hi"}))
check("Asked" in out, "the stranger sends a request to @handle")
p = get(zm); check("REQUESTS TO CONNECT" in p and "say hi" in p and "accept:" in p, "Zeke's Muse sees the request")
acc = re.search(r"accept:\s+(\S+)", p).group(1)
check("Connected" in get(acc), "Zeke's Muse accepts (after asking its human)")
check("accepted your request" in get(dm), "Dad's Muse hears it was accepted")
get(dm + "/say?" + U.urlencode({"to": f"@zeke{run}", "text": "Hi son, it works!"}))
p = get(zm); check("NEW from" in p and "Hi son, it works!" in p, "Zeke's Muse gets Dad's message")
check("read" in get(dm), "Dad sees a read receipt")
# texting: a held-open page returns the moment a message lands
res = {}
def waiter(): t = time.time(); res["page"] = get(dm + "?wait=20"); res["s"] = time.time() - t
th = threading.Thread(target=waiter); th.start(); time.sleep(2)
get(zm + "/say?" + U.urlencode({"to": f"@dad{run}", "text": "Got it dad"})); th.join()
check("Got it dad" in res["page"] and res["s"] < 10, f"?wait returns when a message lands ({res['s']:.1f}s)")
# decline is quiet; owner page allows; rotation kills the old link
s2, s2o = signup("Stranger Two", f"str{run}", ["muse"])
get(s2["muse"] + "/reach?" + U.urlencode({"to": f"@zeke{run}", "why": "buy my stuff"}))
op = get(zo); check("buy my stuff" in op and "Allow" in op, "the owner page shows the request")
ids = re.findall(r'name="id" value="([^"]+)"', op)
form = re.search(r'<form method="post" action="[^"]+"><input type="hidden" name="do" value="decline"><input type="hidden" name="agent" value="([^"]+)">\s*<input type="hidden" name="id" value="([^"]+)">', op)
dr = post(zo, {"do": "decline", "agent": form.group(1), "id": form.group(2)})
get(s2["muse"] + "/reach?" + U.urlencode({"to": f"@zeke{run}", "why": "again"}))
pg = get(zm); check("again" not in pg, "after a decline the same person's new request stays quiet")
op = get(do); agent = re.search(r'name="do" value="rotate"><input type="hidden" name="agent" value="([^"]+)"', op).group(1)
newp = post(do, {"do": "rotate", "agent": agent})
new = re.search(r"(https?://\S+/a/[A-Za-z0-9]+)", newp).group(1)
try: get(dm); old_ok = True
except Exception: old_ok = False
check(not old_ok and "Got it dad" in get(new + f"/say?to=@zeke{run}"), "replacing a link kills the old one; history kept")
print("ALL PASS")
