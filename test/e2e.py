"""
End-to-end browser test (Playwright + Chromium).
Starts the real server on a temporary database, mocks the four public APIs the
browser calls (PSGC, Google DNS, Nager.Date, Aladhan) and walks through the whole flow:
register -> email link -> mobile OTP -> login -> lockout -> unlock -> landing page -> modal -> holidays.

Run:  npm run build && python3 test/e2e.py
"""
import json, os, re, signal, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 3111
BASE = f"http://localhost:{PORT}"
SHOTS = os.environ.get("SHOTS", "")
if SHOTS: os.makedirs(SHOTS, exist_ok=True)

def shot(page, name):
    if SHOTS: page.screenshot(path=os.path.join(SHOTS, name + ".png"))

# ---------- mocked public APIs ----------
def route_json(page, pattern, handler):
    def h(route):
        body = handler(route.request.url)
        route.fulfill(status=200, content_type="application/json", headers={"access-control-allow-origin": "*"}, body=json.dumps(body))
    page.route(pattern, h)

def nager(url):
    year = int(re.search(r"PublicHolidays/(\d{4})/PH", url).group(1))
    base = [
        {"date": f"{year}-01-01", "name": "New Year's Day", "types": ["Public"], "global": True},
        {"date": f"{year}-04-09", "name": "The Day of Valor", "types": ["Public"], "global": True},
        {"date": f"{year}-06-12", "name": "Independence Day", "types": ["Public"], "global": True},
        {"date": f"{year}-08-30", "name": "Regional observance", "types": ["Observance"], "global": True},
        {"date": f"{year}-09-09", "name": "Local city holiday", "types": ["Public"], "global": False},
    ]
    if year == 2026:  # the API lists the Islamic holidays for 2026 only, so 2027 must use the Hijri fallback
        base += [{"date": "2026-03-20", "name": "Eid al-Fitr", "types": ["Public"], "global": True},
                 {"date": "2026-05-27", "name": "Eid al-Adha", "types": ["Public"], "global": True}]
    return base

def aladhan(url):
    d = re.search(r"hToG/(\d{2})-(\d{2})-(\d{4})", url)
    day, month, hy = d.groups()
    table = {("01", "10", "1448"): "10-03-2027", ("10", "12", "1448"): "17-05-2027"}
    date = table.get((day, month, hy), "01-01-2001")
    return {"code": 200, "status": "OK", "data": {"gregorian": {"date": date}}}

def psgc(url):
    if url.endswith("/regions/"): return [{"code": "130000000", "name": "NCR", "regionName": "National Capital Region"}, {"code": "010000000", "name": "Ilocos Region", "regionName": "Region I"}]
    if url.endswith("/cities-municipalities/"): return [{"code": "137501000", "name": "Caloocan City", "provinceCode": False}]
    return []

def dns(url): return {"Status": 0, "Answer": [{"type": 15, "data": "10 mx.example.net."}]}

def mock_apis(page):
    route_json(page, "**/psgc.gitlab.io/**", psgc)
    route_json(page, "**/dns.google/**", dns)
    route_json(page, "**/date.nager.at/**", nager)
    route_json(page, "**/api.aladhan.com/**", aladhan)

def dev_items(page):
    return page.evaluate("fetch('/api/dev/outbox').then(r=>r.json()).then(j=>j.items)")

def latest(page, kind, pattern):
    for _ in range(40):
        for m in dev_items(page):
            if m["type"] == kind and re.search(pattern, m["subject"] + m["body"]): return m
        time.sleep(0.1)
    raise AssertionError(f"no {kind} matching {pattern}")

def main():
    # Needs a reachable Postgres (same default as the Node test suite). The
    # tables are truncated here for isolation - schema.sql re-creates them on
    # boot if this is the very first run and they don't exist yet.
    database_url = os.environ.get("TEST_DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/registration_app_test")
    subprocess.run(["psql", database_url, "-c", "TRUNCATE TABLE sessions, verification_tokens, addresses, users RESTART IDENTITY CASCADE;"],
                    check=False, capture_output=True)
    env = dict(os.environ, PORT=str(PORT), DATABASE_URL=database_url, DEV_OUTBOX="1", NODE_ENV="development",
               UNLOCK_COOLDOWN_SECONDS="6", OTP_RESEND_SECONDS="4", REGISTER_LIMIT_PER_HOUR="50",
               APP_SECRET="e2e-secret", LOG_MESSAGES="0", BASE_URL=BASE)
    server = subprocess.Popen(["node", "--disable-warning=ExperimentalWarning", "server/index.js"], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(100):
        try: urllib.request.urlopen(BASE + "/api/config"); break
        except Exception: time.sleep(0.1)
    else: raise SystemExit("server did not start")

    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True)
            page = ctx.new_page()
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append(str(e)))
            mock_apis(page)

            # ---------------- registration form ----------------
            page.goto(BASE + "/register")
            expect(page.get_by_role("heading", name="Create an Account")).to_be_visible()
            expect(page.locator("[data-testid=mobile-prefix]")).to_have_text("+63")
            expect(page.locator("#region")).to_be_enabled()            # PSGC regions loaded
            shot(page, "01-register-mobile-empty")

            # country switch changes prefix, ZIP handling and the address fields
            page.select_option("#country", "US")
            expect(page.locator("[data-testid=mobile-prefix]")).to_have_text("+1")
            expect(page.locator("#state")).to_be_visible()
            page.select_option("#country", "PH")
            expect(page.locator("[data-testid=mobile-prefix]")).to_have_text("+63")

            # validation messages
            page.fill("#firstName", "J"); page.locator("#firstName").blur()
            expect(page.locator("#firstName-error")).to_contain_text("at least 2")
            page.fill("#firstName", "Juan")
            page.fill("#middleInitial", "D"); page.fill("#lastName", "Dela Cruz")
            page.fill("#email", "juan@mycompany.com"); page.locator("#email").blur()
            expect(page.locator("#email-error")).to_contain_text("public email")
            page.fill("#email", "juan.delacruz@gmail.com")
            expect(page.get_by_text("Email domain verified")).to_be_visible()

            page.fill("#birthday", "01012020")
            expect(page.locator("#birthday")).to_have_value("01/01/2020")   # slashes inserted while typing
            expect(page.locator("#birthday-error")).to_contain_text("at least 13")
            page.fill("#birthday", "02302000")
            expect(page.locator("#birthday-error")).to_contain_text("doesn't exist")
            page.fill("#birthday", "03251998")
            expect(page.locator("#birthday-error")).to_have_count(0)

            # strong password suggestion
            page.fill("#password", "weak"); page.locator("#password").blur()
            expect(page.locator("#password-error")).to_be_visible()
            page.get_by_role("button", name="Suggest a strong password").click()
            suggestion = page.locator("[data-testid=suggested-password]").inner_text()
            assert len(suggestion) >= 12
            page.get_by_role("button", name="Use this password").click()
            expect(page.locator("#password")).to_have_value(suggestion)
            expect(page.locator("#confirmPassword")).to_have_value(suggestion)
            expect(page.locator("#password-error")).to_have_count(0)
            password = suggestion

            page.fill("#mobile", "12345"); page.locator("#mobile").blur()
            expect(page.locator("#mobile-error")).to_contain_text("10 digits after +63")
            page.fill("#mobile", "0917 123 4567")                     # a leading 0 is dropped as it is typed
            expect(page.locator("#mobile")).to_have_value("9171234567")
            expect(page.locator("[data-testid=mobile-counter]")).to_have_text("10 / 10")
            expect(page.locator("#mobile-error")).to_have_count(0)

            page.fill("#houseStreet", "Blk 12 Lot 5, Rizal St.")
            page.select_option("#region", "130000000")
            expect(page.locator("#city")).to_be_enabled()
            page.select_option("#city", "137501000")
            # the ZIP field is a dropdown of the chosen city's own codes: Caloocan's are offered, Quezon City's are not
            expect(page.locator("select#zip")).to_be_enabled()
            expect(page.locator("#zip option[value='1400']")).to_have_count(1)
            expect(page.locator("#zip option[value='1100']")).to_have_count(0)
            page.select_option("#zip", "1400")
            expect(page.locator("#zip")).to_have_value("1400")
            shot(page, "02-register-mobile-filled")

            page.get_by_role("button", name="Create account").click()
            page.wait_for_url("**/check-email")
            expect(page.get_by_text("juan.delacruz@gmail.com")).to_be_visible()
            shot(page, "03-check-email")

            # ---------------- email link -> OTP ----------------
            mail = latest(page, "email", r"Action Required: Verify your email address for")
            assert mail["subject"] == "Action Required: Verify your email address for Registration App", mail["subject"]
            assert "The Registration App Security Team" in mail["body"]
            link = re.search(r"https?://\S+", mail["body"]).group(0)

            # a fresh login attempt before verification is refused
            page.goto(BASE + "/login")
            page.fill("#loginEmail", "juan.delacruz@gmail.com"); page.fill("#loginPassword", password)
            page.get_by_role("button", name="Sign in").click()
            expect(page.locator(".banner--error")).to_contain_text("verify your email")

            page.goto(link)
            page.wait_for_url("**/verify-mobile")
            expect(page.locator("[data-testid=otp-sent-to]")).to_contain_text("+639")
            sms = latest(page, "sms", r"verification code")
            code = re.search(r"\b(\d{6})\b", sms["body"]).group(1)
            assert "GMT+8" in sms["body"] and "5 minutes" in sms["body"], sms["body"]
            wrong = "111111" if code != "111111" else "222222"
            expect(page.get_by_role("button", name=re.compile("Resend OTP in"))).to_be_disabled()   # 60 s (4 s in this test) wait
            page.fill("#otp", wrong); page.get_by_role("button", name="Verify", exact=True).click()
            expect(page.locator(".banner--error")).to_contain_text("2 attempts left")
            shot(page, "04-otp-mobile")
            page.wait_for_timeout(4500)
            expect(page.get_by_role("button", name="Resend OTP", exact=True)).to_be_enabled()
            page.get_by_role("button", name="Resend OTP", exact=True).click()
            expect(page.locator("#otp")).to_be_enabled()
            time.sleep(0.6)
            code = re.search(r"\b(\d{6})\b", [m for m in dev_items(page) if m["type"] == "sms"][0]["body"]).group(1)
            page.fill("#otp", code); page.get_by_role("button", name="Verify", exact=True).click()
            page.wait_for_url("**/login?verified=1")
            expect(page.locator(".banner--success")).to_contain_text("verified")

            # ---------------- lockout + unlock ----------------
            for _ in range(3):
                page.fill("#loginEmail", "juan.delacruz@gmail.com"); page.fill("#loginPassword", "Wrong!Password123")
                page.get_by_role("button", name="Sign in").click()
                expect(page.locator(".banner--error")).to_be_visible()      # the banner is cleared on submit, so this waits for the new answer
            expect(page.locator(".banner--error")).to_contain_text("locked")
            unlock_mail = latest(page, "email", r"has been locked")
            unlock_link = re.search(r"https?://\S+", unlock_mail["body"]).group(0)
            shot(page, "05-locked")

            page.goto(BASE + "/login")
            page.fill("#loginEmail", "juan.delacruz@gmail.com"); page.fill("#loginPassword", password)
            page.get_by_role("button", name="Sign in").click()
            expect(page.locator(".banner--error")).to_contain_text("locked")        # right password, still locked

            page.goto(unlock_link)
            expect(page.locator("[data-testid=unlock-wait]")).to_be_visible()      # 2-minute (6 s here) cooling period
            expect(page.get_by_role("button", name=re.compile("Unlock available in"))).to_be_disabled()
            shot(page, "06-unlock-cooling")
            expect(page.get_by_role("button", name="Unlock my account")).to_be_enabled(timeout=12000)
            page.get_by_role("button", name="Unlock my account").click()
            page.wait_for_url("**/login?unlocked=1")

            # ---------------- sign in -> landing page ----------------
            page.fill("#loginEmail", "juan.delacruz@gmail.com"); page.fill("#loginPassword", password)
            page.get_by_role("button", name="Sign in").click()
            page.wait_for_url("**/dashboard")
            expect(page.get_by_role("heading", name="Hello, Juan.")).to_be_visible()
            shot(page, "07-dashboard-mobile")

            # hamburger menu on a phone
            expect(page.locator("#main-menu")).to_be_hidden()
            page.get_by_role("button", name="Menu").click()
            expect(page.locator("#main-menu")).to_be_visible()
            for name in ["Dashboard", "Profile", "Settings", "Standard Philippine Holidays"]:
                expect(page.locator("#main-menu").get_by_text(name, exact=True)).to_be_visible()
            shot(page, "08-hamburger-open")
            page.locator("#main-menu").get_by_text("Standard Philippine Holidays", exact=True).click()
            expect(page.get_by_role("dialog")).to_be_visible()
            expect(page.get_by_role("tab", name="Calendars / Holidays")).to_have_attribute("aria-selected", "true")

            # ---------------- holidays tab ----------------
            expect(page.locator("#holiday-year")).to_be_visible()
            expect(page.locator("[data-testid=holiday-list], .holidays__status").first).to_be_visible()
            page.select_option("#holiday-year", "2026")
            page.get_by_role("button", name="Whole 2026").click()
            lst = page.locator("[data-testid=holiday-list]")
            expect(lst).to_contain_text("January 1, 2026 – New Year's Day")
            expect(lst).to_contain_text("March 20, 2026 – Eid al-Fitr")
            expect(lst.locator(".badge--islamic").first).to_have_text("Islamic Holiday")
            expect(lst.locator(".holiday-item--regular .badge--regular").first).to_have_text("Regular Holiday")
            expect(lst.locator(".holiday-item--special .badge--special").first).to_have_text("Special Non-Working Day")
            expect(lst).not_to_contain_text("Regional observance")     # observances are not days off
            expect(lst).not_to_contain_text("Local city holiday")      # local (non-national) holidays are skipped
            expect(lst).to_contain_text("Black Saturday")              # built-in rule merged with the API list
            shot(page, "09-holidays-mobile")

            page.select_option("#holiday-year", "2027")
            expect(page.get_by_role("button", name="Whole 2027")).to_be_visible()
            page.get_by_role("button", name="Whole 2027").click()
            expect(lst).to_contain_text("March 10, 2027 – Eid'l Fitr (expected)")     # from the Hijri-calendar API
            expect(lst).to_contain_text("May 17, 2027 – Eid'l Adha (expected)")
            expect(lst.locator(".badge--note", has_text="Expected date").first).to_be_visible()
            page.select_option("#holiday-year", "2020")
            expect(lst).to_contain_text("January 25, 2020 – Chinese New Year")
            years = page.locator("#holiday-year option").all_inner_texts()
            assert years == [str(y) for y in range(2027, 2019, -1)], years

            # calendar: dots on the days that have holidays
            page.select_option("#holiday-year", "2026")
            page.locator(".cal-nav__month").select_option("1")
            expect(page.locator("[data-testid=cal-dot]").first).to_be_visible()
            page.keyboard.press("Escape")
            expect(page.get_by_role("dialog")).to_have_count(0)

            # ---------------- View More -> Accounts tab ----------------
            page.get_by_role("button", name="View More").click()
            expect(page.get_by_role("tab", name="Accounts")).to_have_attribute("aria-selected", "true")
            expect(page.locator(".table tbody tr")).to_have_count(1)
            expect(page.locator(".table tbody tr").first).to_contain_text("Juan D.")
            expect(page.locator(".table tbody tr").first).to_contain_text("j")
            assert "juan.delacruz@gmail.com" not in page.locator(".table").inner_text()   # masked
            shot(page, "10-accounts-mobile")
            page.get_by_role("tab", name="Accounts").focus()
            page.keyboard.press("ArrowRight")
            expect(page.get_by_role("tab", name="Calendars / Holidays")).to_have_attribute("aria-selected", "true")
            page.get_by_role("button", name="Close").click()

            # ---------------- profile dropdown, profile page, logout ----------------
            page.get_by_role("button", name=re.compile("Juan")).click() if page.get_by_role("button", name=re.compile("Juan")).count() else page.locator(".profile__button").click()
            expect(page.get_by_role("menuitem", name="Log out")).to_be_visible()
            page.get_by_role("menuitem", name="Profile").click()
            page.wait_for_url("**/profile")
            expect(page.locator(".details")).to_contain_text("+639171234567")
            expect(page.locator(".details")).to_contain_text("March 25, 1998")
            expect(page.locator(".details")).to_contain_text("Caloocan City")
            page.locator(".profile__button").click()
            page.get_by_role("menuitem", name="Log out").click()
            page.wait_for_url("**/login")
            page.goto(BASE + "/dashboard")
            page.wait_for_url("**/login")                                   # protected again

            # ---------------- desktop + ultra-wide layouts ----------------
            page.set_viewport_size({"width": 1440, "height": 900})
            page.fill("#loginEmail", "juan.delacruz@gmail.com"); page.fill("#loginPassword", password)
            page.get_by_role("button", name="Sign in").click()
            page.wait_for_url("**/dashboard")
            expect(page.locator(".hamburger")).to_be_hidden()
            expect(page.locator(".nav__links")).to_be_visible()
            shot(page, "11-dashboard-desktop")
            page.get_by_role("button", name="View More").click()
            page.get_by_role("tab", name="Calendars / Holidays").click()
            page.get_by_role("button", name="Whole 2026").click() if page.get_by_role("button", name="Whole 2026").count() else None
            page.locator(".cal-nav__month").select_option("3")
            shot(page, "12-holidays-desktop")
            page.keyboard.press("Escape")
            page.set_viewport_size({"width": 2560, "height": 1080})
            shot(page, "13-dashboard-ultrawide")

            browser.close()
    finally:
        server.send_signal(signal.SIGINT)
        try: server.wait(5)
        except Exception: server.kill()

    # The browser logs every non-2xx response (expected here: 401 signed out, 403 unverified, 423 locked...).
    # Real script errors still fail the test.
    bad = [e for e in errors if "favicon" not in e and not e.startswith("Failed to load resource: the server responded with a status")]
    if bad:
        print("Browser console errors:", *bad, sep="\n  ")
        sys.exit(1)
    print("E2E OK")

if __name__ == "__main__":
    main()