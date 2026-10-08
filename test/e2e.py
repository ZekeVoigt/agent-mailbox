"""The Constellation end to end, against a live deployment:

    CLERK_SECRET_KEY=sk_test_... python3 test/e2e.py https://agents.ai-andromeda.com

Each person is a real Clerk user (a development-instance test phone number, made through Clerk's
Backend API) whose real session token is exchanged at /session for this site's cookie; they pick
a handle and add agents on /home. Their agents then use nothing but their own links (urllib is
"web access"). The Clerk users are deleted at the end.
"""
import http.cookiejar, json, os, random, re, sys, threading, time
import urllib.parse as U, urllib.request as R

B = sys.argv[1].rstrip("/")
KEY = os.environ["CLERK_SECRET_KEY"]
UA = {"User-Agent": "Mozilla/5.0 (constellation e2e)"}
made_users = []
handle_of = {}     # Clerk user id -> the handle it took, for clean-up


def clerk(method, path, body=None):
    req = R.Request("https://api.clerk.com/v1" + path, method=method,
                    data=json.dumps(body or {}).encode(),
                    headers={"Authorization": f"Bearer {KEY}", "content-type": "application/json",
                             **UA})
    with R.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"{}")


def loc(u):
    return re.sub(r"^https?://[^/]+", B, u)


def get(url, op=None):
    with (op or R.build_opener()).open(R.Request(loc(url), headers=UA), timeout=40) as r:
        return r.read().decode()


def post(url, data, op=None, origin=True):
    body = U.urlencode(data, doseq=True).encode()
    head = {**UA, **({"Origin": B} if origin else {})}
    with (op or R.build_opener()).open(R.Request(loc(url), body, headers=head), timeout=40) as r:
        return r.read().decode()


def refused(fn):
    try:
        fn()
        return False
    except R.HTTPError as e:
        return e.code in (403, 404, 410)


def session(uid):
    """A new browser signed in as this Clerk user: its own Clerk session, this site's cookie."""
    sid = clerk("POST", "/sessions", {"user_id": uid})["id"]
    token = clerk("POST", f"/sessions/{sid}/tokens")["jwt"]
    op = R.build_opener(R.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    op.open(R.Request(B + "/session", json.dumps({"token": token}).encode(),
                      headers={**UA, "content-type": "application/json", "Origin": B}),
            timeout=30).read()
    return op


def person(name, handle, agents):
    """A signed-in person (their browser, an opener with cookies) and their agents' links."""
    u = clerk("POST", "/users", {"phone_number": [f"+1201555{random.randint(100, 199):04d}"],
                                 "username": handle.replace("-", "_") + str(random.randint(10, 99)),
                                 "password": "Cx-e2e-pass-7731!", "skip_password_checks": True})
    made_users.append(u["id"])
    op = session(u["id"])
    first = get(B + "/home", op)
    assert "Welcome" in first, re.findall(r"<title>[^<]*|<h1>[^<]*", first)
    post(B + "/home", {"do": "onboard", "name": name, "handle": handle}, op)
    handle_of[u["id"]] = handle
    page = post(B + "/home", {"do": "add", "agent": agents}, op)
    names = list(dict.fromkeys(re.findall(r"I am @[a-z0-9-]+/([a-z0-9-]+)\.", page)))
    assert "a[href=\"#agents\"]" in page and "a.click()" in page, "after Add the page must open Agents"
    links = list(dict.fromkeys(re.findall(r"(https?://[^\s<]+/a/[A-Za-z0-9]+)", page)))
    assert names and len(names) == len(set(links)), (re.findall(r"<h1>[^<]*|class=\"err\">[^<]*|class=\"low\">[^<]*|class=\"note\">.{0,200}", page), names, links)
    return dict(zip(names, links)), op, u["id"]


def check(cond, what):
    print(("PASS " if cond else "FAIL ") + what, flush=True)
    if not cond:
        raise SystemExit(1)


def main():
    run = str(int(time.time()))[-5:]
    # not signed in: the sign-in page; a forged token is refused
    check("id=\"cf\"" in get(B + "/"), "the front page is Clerk's sign-in")
    try:
        R.urlopen(R.Request(B + "/session", b'{"token":"x.y.z"}', headers={**UA,
                  "content-type": "application/json", "Origin": B}), timeout=20)
        forged = True
    except R.HTTPError as e:
        forged = e.code != 401
    check(not forged, "a forged token is refused")
    try:
        anon = get(B + "/home")
    except Exception:
        anon = ""
    check("id=\"cf\"" in anon, "/home without a session goes to sign-in")

    z, zo, zid = person("Zeke Voigt", f"zeke{run}", ["muse", "claude-code"])
    d, do, did = person("Dad Voigt", f"dad{run}", ["muse"])
    check(set(z) == {"muse", "claude-code"} and set(d) == {"muse"},
          "signed in with Clerk, a handle, agents added from the dashboard")
    zm, zc, dm = z["muse"], z["claude-code"], d["muse"]
    p = get(zm)
    check(f"@zeke{run}/claude-code" in p and "your own agent" in p, "own agents auto-connected")
    get(zc + "/say?" + U.urlencode({"to": f"@zeke{run}/muse", "text": "hi from claude"}))
    check("hi from claude" in get(zm), "own agents message without a request")
    check(f"@zeke{run}" in get(dm + "/find?q=zeke+voigt"), "a stranger finds Zeke by name")
    out = get(dm + "/say?" + U.urlencode({"to": f"@zeke{run}", "text": "spam"}))
    check("no contact" in out, "a stranger cannot message before a request is accepted")
    check("Asked" in get(dm + "/reach?" + U.urlencode({"to": f"@zeke{run}", "why": "say hi"})),
          "the stranger asks @handle to connect")
    zp = get(zm)
    check("say hi" in zp and "accept:" not in zp, "Zeke's Muse sees the request but no accept link")
    req_id = re.search(r"decline\?id=([^\s&]+)", zp).group(1)
    check(refused(lambda: get(zm + "/accept?id=" + req_id)),
          "an agent cannot accept a request")
    check("no contact" in get(dm + "/say?" + U.urlencode({"to": f"@zeke{run}", "text": "x"})) or
          "Not connected" in get(dm + "/say?" + U.urlencode({"to": f"@zeke{run}", "text": "x"})),
          "after the agent tried, still not connected")
    home = get(B + "/home", zo)
    check("say hi" in home and "Allow" in home, "the request is on Zeke's dashboard")
    form = re.search(r'name="do" value="accept"><input type="hidden" name="agent" value="([^"]+)">'
                     r'<input type="hidden" name="id" value="([^"]+)">', home)
    check(refused(lambda: post(B + "/home", {"do": "accept", "agent": form.group(1),
                                              "id": form.group(2)}, zo, origin=False)),
          "a form from another site (no Origin) is refused")
    form = re.search(r'name="do" value="accept"><input type="hidden" name="agent" value="([^"]+)">'
                     r'<input type="hidden" name="id" value="([^"]+)">', home)
    post(B + "/home", {"do": "accept", "agent": form.group(1), "id": form.group(2)}, zo)
    check("accepted your request" in get(dm), "Zeke allows it on his dashboard; Dad's Muse hears it")
    get(dm + "/say?" + U.urlencode({"to": f"@zeke{run}", "text": "Hi son, it works!"}))
    check("Hi son, it works!" in get(zm), "Zeke's Muse gets Dad's message")
    check("read" in get(dm), "Dad sees a read receipt")
    res = {}

    def waiter():
        t = time.time()
        res["page"], res["s"] = get(dm + "?wait=20"), time.time() - t
    th = threading.Thread(target=waiter)
    th.start()
    time.sleep(2)
    get(zm + "/say?" + U.urlencode({"to": f"@dad{run}", "text": "Got it dad"}))
    th.join()
    check("Got it dad" in res["page"] and res["s"] < 10, f"?wait returns when a message lands ({res['s']:.1f}s)")
    conns = get(B + "/home", zo)
    check("<strong>Your " not in conns, "Connections list other people only, not your own agents")
    check(f"@dad{run}/muse" in conns and "Got it dad" in conns, "the dashboard's Connections show it")
    # an agent can accept too (after asking its human), and a decline is quiet
    s2, _, _ = person("Stranger Two", f"str{run}", ["muse"])
    get(s2["muse"] + "/reach?" + U.urlencode({"to": f"@zeke{run}", "why": "buy my stuff"}))
    acc = re.search(r"decline:\s+(https?://\S+)", get(zm)).group(1)
    check("Declined" in get(acc), "Zeke's Muse may decline")
    get(s2["muse"] + "/reach?" + U.urlencode({"to": f"@zeke{run}", "why": "again"}))
    check("again" not in get(zm), "after a decline the same person's new request stays quiet")
    home = get(B + "/home", do)
    agent = re.search(r'name="do" value="rotate"><input type="hidden" name="agent" value="([^"]+)"',
                      home).group(1)
    new = re.search(r"(https?://[^\s<]+/a/[A-Za-z0-9]+)",
                    post(B + "/home", {"do": "rotate", "agent": agent}, do)).group(1)
    try:
        get(dm)
        old_ok = True
    except Exception:
        old_ok = False
    check(not old_ok and "Got it dad" in get(new + f"/say?to=@zeke{run}"),
          "replacing a link on the dashboard kills the old one; history kept")
    # a long conversation: more than one storage value's 128 KiB, every message kept in order
    big = "x" * 3900
    for i in range(40):
        get(zm + "/say?" + U.urlencode({"to": f"@dad{run}", "text": f"{i:02d} {big}"}))
    thread = get(new + "/say?" + U.urlencode({"to": f"@zeke{run}"}))
    check("39 xxx" in thread and "Not sent" not in thread, "a 156 KB conversation is stored and read")
    # sessions: a second browser, the devices list, sign out everywhere
    zo2 = session(zid)
    prof = get(B + "/home", zo)
    check("Signed in" in prof and "Security activity" in prof and prof.count("this browser") == 1,
          "Profile lists sign-ins and the security log")
    post(B + "/home", {"do": "end-all"}, zo2)
    check("id=\"cf\"" in get(B + "/home", zo) and "id=\"cf\"" in get(B + "/home", zo2),
          "sign out everywhere ends every browser's session")
    zo = session(zid)
    check("Signed out everywhere" in get(B + "/home", zo), "the security log records it")
    # removing an agent: its link dies, its contacts are cut
    home = get(B + "/home", zo)
    ids = re.findall(r'value="remove-agent"><input type="hidden" name="agent" value="([^"]+)"', home)
    names = re.findall(r'Remove (muse|claude-code)</button>', home)
    post(B + "/home", {"do": "remove-agent", "agent": ids[names.index("claude-code")]}, zo)
    check(refused(lambda: get(zc)), "a removed agent's link stops working")
    check(f"@zeke{run}/claude-code" not in get(zm).split("YOUR CONTACTS")[1].split("WHAT")[0],
          "and it is gone from the other agents' contacts")
    # deleting an account: links dead, not findable, the other side cut
    post(B + "/home", {"do": "delete-account", "confirm": f"@dad{run}"}, do)
    check(refused(lambda: get(new)), "a deleted account's agent links stop working")
    check(f"@dad{run}" not in get(zm + "/find?q=dad"), "and it is no longer found")
    check("no longer connected" in get(zm + "/say?" + U.urlencode({"to": f"@dad{run}", "text": "hi?"}))
          or "Not connected" in get(zm + "/say?" + U.urlencode({"to": f"@dad{run}", "text": "hi?"})),
          "and Zeke's Muse can no longer message it")
    post(B + "/signout", {}, zo)
    check("id=\"cf\"" in get(B + "/home", zo), "signing out ends the session")
    print("ALL PASS", flush=True)


if __name__ == "__main__":
    try:
        main()
    finally:   # each test account deletes itself, as a person would; then its Clerk user goes
        for uid in made_users:
            try:
                if uid in handle_of:
                    post(B + "/home", {"do": "delete-account", "confirm": "@" + handle_of[uid]},
                         session(uid))
            except Exception as e:
                print("could not delete the account of", uid, e)
            try:
                clerk("DELETE", f"/users/{uid}")
            except Exception as e:
                print("could not delete", uid, e)
