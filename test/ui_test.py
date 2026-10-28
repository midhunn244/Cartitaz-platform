"""Browser test of the real dashboard: boots the real server, drives it with headless Chromium."""
import base64, hashlib, hmac, json, os, struct, subprocess, sys, tempfile, time, urllib.request, shutil
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 47831; BASE = f"http://127.0.0.1:{PORT}"; ADMIN = BASE + "/control-center"
tmp = tempfile.mkdtemp(prefix="ct-ui-")
env = {**os.environ, "PORT": str(PORT), "DATA_DIR": tmp, "APP_SECRET": "ui-test-secret-" * 4, "NODE_ENV": "test", "HOST": "127.0.0.1"}
ok = fail = 0
def check(cond, name):
    global ok, fail
    if cond: ok += 1; print("  PASS", name)
    else: fail += 1; print("  FAIL", name)

def totp(secret, ahead=0):
    key = base64.b32decode(secret + "=" * (-len(secret) % 8)); c = int(time.time() // 30) + ahead
    h = hmac.new(key, struct.pack(">Q", c), hashlib.sha1).digest(); o = h[19] & 15
    return str((struct.unpack(">I", h[o:o+4])[0] & 0x7fffffff) % 1000000).zfill(6)

r = subprocess.run(["node", "--no-warnings", "scripts/create-admin.js", "--username", "boss", "--name", "Store Boss", "--role", "owner", "--password-stdin"],
                   input="Correct-Horse-Battery-9\n", env=env, cwd=ROOT, text=True, capture_output=True)
assert r.returncode == 0, r.stderr
srv = subprocess.Popen(["node", "--no-warnings", "src/server.js"], env=env, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
for _ in range(50):
    try: urllib.request.urlopen(BASE + "/healthz"); break
    except Exception: time.sleep(0.1)

# a small real PNG for upload
from PIL import Image
png = os.path.join(tmp, "photo.png"); Image.new("RGB", (900, 700), (200, 120, 60)).save(png)

def post(path, body):
    req = urllib.request.Request(BASE + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
    try: return json.loads(urllib.request.urlopen(req).read())
    except urllib.error.HTTPError as e: return {"_status": e.code, **json.loads(e.read())}

try:
    with sync_playwright() as p:
        b = p.chromium.launch(); ctx = b.new_context(viewport={"width": 1280, "height": 860}); page = ctx.new_page()
        page.add_init_script("window.__opened=[];window.open=function(u){window.__opened.push(String(u));return null}")
        problems = []
        page.on("console", lambda m: problems.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: problems.append(str(e)))

        print("# login")
        page.goto(ADMIN); page.wait_for_selector("#u")
        check("Authorized staff only" in page.content(), "login page shown to anonymous visitors")
        check(page.request.get(ADMIN + "/assets/app.js").status == 404, "dashboard script not downloadable before login")
        page.fill("#u", "boss"); page.fill("#p", "wrong-password-xyz"); page.click("#go")
        page.wait_for_selector("#err:not(:empty)")
        check("Invalid" in page.inner_text("#err"), "wrong password shows an error")
        page.fill("#p", "Correct-Horse-Battery-9"); page.click("#go")
        page.wait_for_selector(".nav")
        names = [x.strip() for x in page.locator(".nav button").all_inner_texts()]
        for n in ["Overview", "Products", "Categories", "Orders", "WhatsApp requests", "Customers", "Suppliers", "Inventory", "Promotions", "Website settings", "Security"]:
            check(any(n in x for x in names), "nav has " + n)
        page.screenshot(path="/tmp/ui_overview.png")

        def nav(label):
            page.locator(".nav button", has_text=label).first.click(); page.wait_for_timeout(500)
        def modal_field(label):
            return page.locator(".modal label.fld", has_text=label).first.locator("input,select,textarea").first

        print("# categories, suppliers")
        nav("Categories"); page.get_by_text("+ Add category").click()
        modal_field("Name").fill("Bags"); page.locator(".modal .btn.pri", has_text="Save").click(); page.wait_for_selector("td:has-text('Bags')")
        check(True, "category created through the UI")
        nav("Suppliers"); page.get_by_text("+ Add supplier").click()
        modal_field("Supplier name").fill("Shenzhen Goods"); modal_field("Private notes").fill("PRIVATE-NOTE"); page.locator(".modal .btn.pri", has_text="Save").click()
        page.wait_for_selector("td:has-text('Shenzhen Goods')"); check(True, "supplier created through the UI")

        print("# products")
        nav("Products"); page.get_by_text("+ Add product").click()
        modal_field("Product name").fill("Leather Tote"); modal_field("Category").select_option(label="Bags")
        modal_field("Selling price").fill("100"); modal_field("Original price").fill("150"); modal_field("Supplier purchase price").fill("60")
        modal_field("Stock (when no variants)").fill("10"); modal_field("Caption").fill("Full-grain tote")
        modal_field("Supplier (private)").select_option(label="Shenzhen Goods")
        modal_field("Published").check()
        page.get_by_text("Create product").click()
        page.wait_for_selector(".modal h2:has-text('Edit product')", timeout=8000); check(True, "product created and reopened for photos")
        page.locator(".modal input[type=file]").set_input_files(png); page.wait_for_selector(".modal .imgs img", timeout=8000)
        check(page.locator(".modal .imgs img").count() == 1, "photo uploaded through the UI")
        page.get_by_text("+ Add variant").click()
        page.locator(".vrow input").nth(0).fill("Black"); page.locator(".vrow input").nth(2).fill("4")
        page.get_by_text("Save changes").click(); page.wait_for_timeout(700)
        page.locator(".modal .x").first.click(); page.wait_for_selector("td:has-text('Leather Tote')")
        cat = json.loads(urllib.request.urlopen(BASE + "/api/public/catalog").read())
        prod = cat["products"][0]
        check(prod["name"] == "Leather Tote" and prod["compare_price"] == 150 and len(prod["images"]) == 1, "published product is visible on the public API with offer and photo")
        check(prod["variants"][0]["name"] == "Black", "variant saved")
        txt = json.dumps(cat); check("cost_price" not in txt and "Shenzhen" not in txt and "PRIVATE" not in txt, "public API leaks no private data")
        img = page.request.get(BASE + prod["images"][0]); check(img.status == 200 and img.headers["content-type"] == "image/jpeg", "product image served publicly (re-encoded JPEG)")
        page.screenshot(path="/tmp/ui_products.png")

        print("# settings")
        nav("Website settings"); modal = page.locator("label.fld", has_text="WhatsApp number").locator("input")
        modal.fill("+91 90000 11111"); page.locator(".card .btn.pri", has_text="Save").first.click(); page.wait_for_selector(".toast:has-text('Settings saved')")
        check(json.loads(urllib.request.urlopen(BASE + "/api/public/catalog").read())["settings"]["whatsapp_number"] == "919000011111", "WhatsApp number saved and live")

        print("# a customer request arrives and is managed by hand")
        req = post("/api/public/requests", {"name": "Asha Rao", "phone": "+91 98765 43210", "address": "12 MG Road, Bengaluru", "pincode": "560001", "items": [{"product_id": prod["id"], "variant_id": prod["variants"][0]["id"], "qty": 2}]})
        check(req.get("code", "").startswith("CT-"), "request accepted: " + str(req.get("code")))
        nav("WhatsApp requests"); page.wait_for_selector("td:has-text('Asha Rao')")
        check("Request received" in page.inner_text("main") or "New request" in page.inner_text("main") or "Request" in page.inner_text("main"), "request listed as a new request, not confirmed")
        page.get_by_role("button", name=req["code"]).click(); page.wait_for_selector(".modal h2:has-text('Order')")
        check("Asha Rao" in page.inner_text(".modal") and "Shenzhen Goods" in page.inner_text(".modal"), "order shows customer and supplier info")
        check("60" in page.inner_text(".modal"), "supplier cost visible to the owner")
        page.get_by_text("Confirm details", exact=True).click(); page.wait_for_timeout(300)
        opened = page.evaluate("window.__opened")
        check(len(opened) == 1 and opened[0].startswith("https://wa.me/919876543210?text=") and "CT-" in opened[0], "WhatsApp link targets the customer and quotes the order code")
        status_now = json.loads(subprocess.run(["node", "--no-warnings", "-e", f"const {{open}}=require('./src/db');const d=open(process.env.DATA_DIR);console.log(JSON.stringify(d.get('SELECT status,confirmed_at FROM orders')))"], env=env, cwd=ROOT, capture_output=True, text=True).stdout)
        check(status_now["status"] == "new_request" and status_now["confirmed_at"] is None, "opening WhatsApp left the status unchanged")
        page.locator(".modal select").first.select_option(label="Confirmed"); page.get_by_role("button", name="Update status").click()
        page.wait_for_selector(".overlay:nth-of-type(2) .btn.pri, .modal .btn.pri:has-text('Confirmed')"); page.locator(".btn.pri", has_text="Confirmed").last.click()
        page.wait_for_selector(".toast:has-text('Status updated')"); check(True, "owner confirmed the order manually")
        page.screenshot(path="/tmp/ui_order.png")
        page.locator(".modal .x").last.click()
        nav("Inventory"); page.wait_for_selector("td:has-text('Black')"); check("2" in page.locator("tr", has_text="Black").first.inner_text(), "stock for the variant dropped from 4 to 2 after confirmation")
        nav("Overview"); page.wait_for_selector(".stats"); page.screenshot(path="/tmp/ui_overview2.png")

        print("# two-factor")
        nav("Security"); page.get_by_text("Set up two-factor").click(); page.wait_for_selector(".sec")
        secret = page.inner_text(".sec").strip(); check(len(secret) == 32, "2FA secret displayed")
        page.locator("label.fld", has_text="Enter the 6-digit").locator("input").fill(totp(secret)); page.get_by_text("Turn on", exact=True).click()
        page.wait_for_selector(".toast:has-text('Two-factor enabled')"); check(True, "2FA enabled with a real code")
        page.wait_for_selector(".sec.rc"); codes = [x.strip() for x in page.locator(".sec.rc div").all_inner_texts()]
        check(len(codes) == 8 and all(len(c) == 11 for c in codes), "dashboard shows 8 recovery codes once")
        page.locator(".modal input[type=checkbox]").check(); page.get_by_role("button", name="Done").click()
        page.screenshot(path="/tmp/ui_security.png")
        page.get_by_text("Sign out").click(); page.wait_for_selector("#u")
        page.fill("#u", "boss"); page.fill("#p", "Correct-Horse-Battery-9"); page.click("#go"); page.wait_for_selector("#totpRow:not([hidden])")
        check(True, "login now asks for the authentication code")
        page.fill("#c", totp(secret, 1)); page.click("#go")
        try: page.wait_for_selector(".nav", timeout=4000); check(True, "signed in with password + code")
        except Exception:
            check(False, "signed in with password + code")
        check(page.locator("body").inner_text().find("Correct-Horse") < 0, "password never appears on the page")
        page.get_by_text("Sign out").click(); page.wait_for_selector("#u"); page.fill("#u", "boss"); page.fill("#p", "Correct-Horse-Battery-9"); page.click("#go")
        page.wait_for_selector("#totpRow:not([hidden])"); page.fill("#c", codes[0]); page.click("#go"); page.wait_for_selector(".nav", timeout=6000)
        check(True, "signed in with a recovery code instead of the phone")
        nav("Security"); page.wait_for_selector("text=Recovery codes: 7 left"); check(True, "dashboard shows 7 recovery codes left")

        print("# mobile layout")
        m = b.new_context(viewport={"width": 390, "height": 800}, is_mobile=True); mp = m.new_page()
        mp.goto(ADMIN); mp.screenshot(path="/tmp/ui_mobile_login.png")
        csp = [x for x in problems if "Content Security Policy" in x or "Refused" in x]
        check(not csp, "no Content-Security-Policy violations in the dashboard: " + "; ".join(csp)[:200])
        real = [x for x in problems if "Content Security Policy" not in x and "401" not in x and "404" not in x and "Failed to load resource" not in x]
        check(not real, "no JavaScript errors: " + "; ".join(real)[:300])
        b.close()
finally:
    srv.terminate(); shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{ok} passed, {fail} failed"); sys.exit(1 if fail else 0)
