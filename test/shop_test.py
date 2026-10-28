"""Browser test of the public storefront against the real server and database."""
import json, os, re, subprocess, sys, tempfile, time, urllib.request, urllib.error, shutil, http.cookiejar
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 47832; BASE = f"http://127.0.0.1:{PORT}"; A = BASE + "/control-center/api"
tmp = tempfile.mkdtemp(prefix="ct-shop-")
env = {**os.environ, "PORT": str(PORT), "DATA_DIR": tmp, "APP_SECRET": "shop-test-secret-" * 4, "NODE_ENV": "test", "HOST": "127.0.0.1"}
ok = fail = 0
def check(c, n):
    global ok, fail
    if c: ok += 1; print("  PASS", n)
    else: fail += 1; print("  FAIL", n)

subprocess.run(["node", "--no-warnings", "scripts/create-admin.js", "--username", "boss", "--name", "Boss", "--role", "owner", "--password-stdin"], input="Correct-Horse-Battery-9\n", env=env, cwd=ROOT, text=True, capture_output=True, check=True)
srv = subprocess.Popen(["node", "--no-warnings", "src/server.js"], env=env, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
for _ in range(50):
    try: urllib.request.urlopen(BASE + "/healthz"); break
    except Exception: time.sleep(0.1)

jar = http.cookiejar.CookieJar(); op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)); CSRF = ""
def call(method, url, body=None, public=False):
    h = {"Content-Type": "application/json", "Origin": BASE}
    if CSRF and not public: h["X-CSRF-Token"] = CSRF
    req = urllib.request.Request(url, json.dumps(body).encode() if body is not None else None, h, method=method)
    try: r = op.open(req); return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e: return {"_status": e.code, **json.loads(e.read() or b"{}")}
call("POST", A + "/login", {"username": "boss", "password": "Correct-Horse-Battery-9"})
CSRF = call("GET", A + "/me")["csrf"]

try:
    cat = call("POST", A + "/categories", {"name": "Bags"})["id"]; cat2 = call("POST", A + "/categories", {"name": "Home"})["id"]
    sup = call("POST", A + "/suppliers", {"name": "Shenzhen Goods"})["id"]
    tote = call("POST", A + "/products", {"name": "Leather Tote", "category_id": cat, "supplier_id": sup, "price": 100, "compare_price": 150, "cost_price": 60, "published": True, "caption": "Full-grain tote",
        "description": "A roomy tote.", "variants": [{"name": "Black", "stock": 5}, {"name": "Olive", "stock": 0}]})["id"]
    vase = call("POST", A + "/products", {"name": "Opal Vase", "category_id": cat2, "price": 40, "cost_price": 15, "stock": 0, "published": True, "caption": "Ceramic"})["id"]
    clutch = call("POST", A + "/products", {"name": "Mini Clutch", "category_id": cat, "price": 58, "cost_price": 20, "stock": 3, "published": True, "caption": "Evening clutch"})["id"]
    call("POST", A + "/promotions", {"code": "SAVE10", "kind": "percent", "value": 10})
    r = call("PUT", A + "/settings", {"whatsapp_number": "+91 90000 11111", "store_name": "Cartitaz", "announcement": ["Shop-test announcement"],
        "contact": {"email": "hello@cartitaz.example", "phone": "+91 90000 11111", "address": "Bengaluru", "hours": "Mon-Sat 9-6"}, "policies": {"returns": "RETURNS-POLICY-TEXT: 7 days.", "shipping": "", "privacy": "", "terms": ""},
        "banners": [{"title": "Season sale", "subtitle": "Up to 33% off", "category": "Bags", "c1": "#1F2A24", "c2": "#3B5246"}],
        "home_sections": [{"type": "deals", "title": "Hot deals", "enabled": True}, {"type": "category", "title": "All our bags", "category": "Bags", "enabled": True}, {"type": "bestsellers", "title": "Hidden section", "enabled": False}]})
    check("_status" not in r, "store configured through the admin API")

    with sync_playwright() as p:
        b = p.chromium.launch(); ctx = b.new_context(viewport={"width": 1280, "height": 900}); page = ctx.new_page(); probs = []
        page.on("console", lambda m: probs.append(m.text) if m.type == "error" else None); page.on("pageerror", lambda e: probs.append(str(e)))
        page.goto(BASE + "/"); page.wait_for_selector("#splash", state="detached", timeout=6000); page.wait_for_selector(".card[data-open]")
        html = page.content()
        check(not re.search(r"admin|control-center", html, re.I), "public page contains no admin link, text or path")
        check("Shop-test announcement" in page.inner_text(".tick"), "announcement bar comes from the admin settings")
        check("Season sale" in page.inner_text("main"), "banner comes from the admin settings")
        check("Hot deals" in page.inner_text("main") and "All our bags" in page.inner_text("main") and "Hidden section" not in page.inner_text("main"), "homepage sections follow the admin configuration (disabled section hidden)")
        check("hello@cartitaz.example" in page.inner_text("footer") and "Returns" in page.inner_text("footer"), "footer shows contact details and policy links")
        page.locator(".fpol", has_text="Returns").click(); page.wait_for_selector(".policy")
        check("RETURNS-POLICY-TEXT" in page.inner_text(".policy"), "policy page shows the text written in the admin")
        page.locator("#home").click(); page.wait_for_selector(".card[data-open]")

        print("# product page, variants, out of stock")
        page.locator(".hb[data-nav=cats]").click(); page.locator(".ct", has_text="Home").click(); page.wait_for_selector(".card[data-open]")
        page.locator(".card", has_text="Opal Vase").first.click(); page.wait_for_selector(".stk.out")
        page.get_by_role("button", name="Add to cart").click(); page.wait_for_selector(".toast:has-text('Out of stock')"); check(True, "out-of-stock product cannot be added")
        page.locator("#home").click(); page.wait_for_selector(".card[data-open]")
        page.locator(".card", has_text="Leather Tote").first.click(); page.wait_for_selector(".vopt")
        check(page.locator(".vopt:disabled").count() == 1, "sold-out variant is disabled")
        page.get_by_role("button", name="Add to cart").click(); page.wait_for_selector(".toast:has-text('Choose an option')"); check(True, "must choose an option before adding")
        page.locator(".vopt", has_text="Black").click(); page.get_by_role("button", name="Add to cart").click()
        page.wait_for_selector(".toast:has-text('Added to cart')"); page.wait_for_timeout(300)
        page.screenshot(path="/tmp/shop_product.png")

        print("# checkout creates a request, not an order")
        page.locator("#ct").click(); page.wait_for_selector("#send"); check("Black" in page.inner_text("main"), "cart shows the chosen variant")
        page.locator("#send").click(); page.wait_for_selector("#kn")
        page.fill("#kn", "Asha Rao"); page.fill("#kp", "+91 98765 43210"); page.fill("#ka", "12 MG Road, Bengaluru"); page.fill("#kz", "560001"); page.fill("#kpromo", "BADCODE")
        page.locator("#kgo").click(); page.wait_for_selector("#kerr:not(:empty)"); check("not valid" in page.inner_text("#kerr"), "invalid promo code is reported in the checkout")
        page.fill("#kpromo", "SAVE10"); page.locator("#kgo").click(); page.wait_for_selector("#kwa", timeout=8000)
        href = page.locator("#kwa").get_attribute("href"); code = re.search(r"CT-[A-Z0-9]{7}", href).group(0)
        check(href.startswith("https://wa.me/919000011111?text="), "WhatsApp link uses the number configured in the admin")
        check("not confirmed yet" in page.inner_text(".ck"), "customer is told the request is not confirmed")
        orders = call("GET", A + "/orders?q=" + code)
        o = call("GET", A + "/orders/%d" % orders["rows"][0]["id"])
        check(o["status"] == "new_request" and o["confirmed_at"] is None, "server stored it as an unconfirmed request")
        check(o["total"] == 90 and o["discount"] == 10 and o["shipping"] == 0, "totals were computed by the server (10% promo applied, free delivery at 100)")
        check(call("GET", A + "/products/%d" % tote)["variants"][0]["stock"] == 5, "stock untouched until the owner confirms")
        page.locator(".ckh .x").click(); page.wait_for_timeout(300)
        check(not page.evaluate("Object.keys(JSON.parse(localStorage.getItem('ct_cart')||'{}')).length"), "ordered items removed from the cart")

        print("# tracking follows what the owner does")
        page.locator(".hb[data-nav=orders]").click(); page.wait_for_selector(".ord")
        check("Request received" in page.inner_text(".ord") and code in page.inner_text(".ord"), "My orders shows the request as 'Request received'")
        call("POST", A + "/orders/%d/status" % o["id"], {"status": "confirmed", "note": "paid"})
        page.reload(); page.wait_for_selector(".card, .ord", timeout=8000); page.locator(".hb[data-nav=orders]").click(); page.wait_for_selector(".ord")
        page.wait_for_selector(".sb:has-text('Confirmed')", timeout=8000); check(True, "after the owner confirms, the customer sees Confirmed")
        call("POST", A + "/orders/%d/status" % o["id"], {"status": "shipped", "country": "India", "state": "Karnataka", "district": "Bengaluru Urban", "place": "Bengaluru hub", "public_note": "Dispatched today"})
        page.reload(); page.locator(".hb[data-nav=orders]").click(); page.wait_for_selector(".sb:has-text('Shipped')", timeout=8000)
        page.get_by_role("button", name="Track order").click(); page.wait_for_selector(".wh")
        t = page.inner_text(".ord"); check("Karnataka" in t and "Bengaluru Urban" in t and "India" in t, "tracking shows country, state and district entered by the owner")
        check("paid" not in t and "Shenzhen" not in t, "internal notes and supplier are not shown to the customer")
        page.screenshot(path="/tmp/shop_tracking.png")
        call("POST", A + "/orders/%d/status" % o["id"], {"status": "delivered"})
        page.reload(); page.locator(".hb[data-nav=orders]").click(); page.wait_for_selector(".sb:has-text('Delivered')", timeout=8000); check(True, "delivered orders show Delivered")

        print("# stock rules from the customer side")
        page.locator("#home").click(); page.wait_for_selector(".card[data-open]")
        page.locator(".card", has_text="Mini Clutch").first.click(); page.wait_for_selector("[data-q='1']")
        for _ in range(4): page.locator("[data-q='1']").click()
        page.get_by_role("button", name="Buy on WhatsApp").click(); page.wait_for_selector("#kn")
        page.locator("#kgo").click(); page.wait_for_selector("#kerr:not(:empty)", timeout=8000)
        check("Only 3 left" in page.inner_text("#kerr"), "asking for more than the stock is refused with a clear message")

        print("# mobile")
        m = b.new_context(viewport={"width": 390, "height": 820}, is_mobile=True, has_touch=True); mp = m.new_page(); mp.on("console", lambda x: probs.append(x.text) if x.type == "error" else None)
        mp.goto(BASE + "/"); mp.wait_for_selector("#splash", state="detached", timeout=6000); mp.wait_for_selector(".card[data-open]"); mp.screenshot(path="/tmp/shop_mobile.png")
        bad = [x for x in probs if "Content Security Policy" in x or "Refused" in x]
        check(not bad, "no Content-Security-Policy violations on the storefront " + "; ".join(bad)[:200])
        js = [x for x in probs if "Failed to load resource" not in x]
        check(not js, "no JavaScript errors on the storefront " + "; ".join(js)[:300])
        b.close()
finally:
    srv.terminate(); shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{ok} passed, {fail} failed"); sys.exit(1 if fail else 0)
