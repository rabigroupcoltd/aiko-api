export const DELETE_ACCOUNT_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Delete your Aiko account</title>
<meta name="description" content="Request deletion of your Aiko account and the data associated with it.">
<style>
  :root { --green:#0D8A41; --deep:#054A22; --ink:#111917; --muted:#5B6662; --line:#E2E7E5; --bg:#F7F9F8; --card:#FFFFFF; --danger:#C62828; }
  @media (prefers-color-scheme: dark) { :root { --ink:#EAF1EE; --muted:#A9B7B2; --line:#2A3833; --bg:#0B1210; --card:#151E1B; } }
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--ink); line-height: 1.55; }
  header { background: linear-gradient(135deg, #21B85A, var(--green) 55%, var(--deep)); color: #fff; padding: 28px 16px 72px; }
  .wrap { max-width: 680px; margin: 0 auto; }
  .brand { font-weight: 800; font-size: 22px; letter-spacing: -0.5px; }
  h1 { margin: 18px 0 6px; font-size: 28px; line-height: 1.2; letter-spacing: -0.5px; }
  header p { margin: 0; opacity: .9; }
  main { padding: 0 16px 48px; margin-top: -48px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 22px; margin-bottom: 16px; }
  h2 { font-size: 18px; margin: 0 0 10px; }
  ol, ul { margin: 0; padding-left: 20px; }
  li { margin: 4px 0; }
  label { display: block; font-weight: 600; font-size: 14px; margin: 14px 0 6px; }
  input, textarea { width: 100%; font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 10px; padding: 11px 12px; }
  input:focus, textarea:focus { outline: 2px solid var(--green); border-color: transparent; }
  textarea { min-height: 84px; resize: vertical; }
  .check { display: flex; gap: 10px; align-items: flex-start; font-weight: 400; font-size: 14px; margin-top: 16px; }
  .check input { width: auto; margin-top: 4px; }
  button { margin-top: 18px; width: 100%; border: 0; border-radius: 12px; padding: 14px; font: inherit; font-weight: 700; color: #fff; background: var(--danger); cursor: pointer; }
  button[disabled] { opacity: .5; cursor: default; }
  .muted { color: var(--muted); font-size: 14px; }
  .notice { display: none; border-radius: 12px; padding: 14px; margin-top: 16px; font-size: 15px; }
  .notice.ok { display: block; background: rgba(13,138,65,.12); color: var(--ink); }
  .notice.err { display: block; background: rgba(198,40,40,.12); color: var(--ink); }
  footer { text-align: center; color: var(--muted); font-size: 13px; padding: 8px 16px 32px; }
</style>
</head>
<body>
<header>
  <div class="wrap">
    <div class="brand">aiko</div>
    <h1>Delete your Aiko account</h1>
    <p>Aiko — send anything, we deliver fast. Use this page to have your account and its data deleted.</p>
  </div>
</header>
<main>
  <div class="wrap">
    <section class="card">
      <h2>Fastest way: delete it in the app</h2>
      <ol>
        <li>Open the Aiko app and sign in.</li>
        <li>Open the menu, then tap <strong>Settings</strong>.</li>
        <li>Tap <strong>Delete account</strong> and confirm.</li>
      </ol>
      <p class="muted">Your account is deleted immediately. Finish or cancel any order in progress first.</p>
    </section>

    <section class="card">
      <h2>Can't use the app? Ask us here</h2>
      <p class="muted">Enter the email address or phone number on your account. We'll confirm it's yours and delete the account within 30 days.</p>
      <form id="form" novalidate>
        <label for="contact">Email or phone number</label>
        <input id="contact" name="contact" autocomplete="email" required placeholder="you@example.com or 0803 000 0000">
        <label for="reason">Reason (optional)</label>
        <textarea id="reason" name="reason" maxlength="500" placeholder="Anything you'd like to tell us"></textarea>
        <label class="check"><input type="checkbox" id="confirm" required> I understand my account will be permanently deleted and can't be recovered.</label>
        <button type="submit" id="submit">Request account deletion</button>
        <div id="notice" class="notice" role="status" aria-live="polite"></div>
      </form>
    </section>

    <section class="card">
      <h2>What gets deleted</h2>
      <ul>
        <li>Your name, email address, phone number and date of birth</li>
        <li>Your profile photo and, for riders, your licence, ID and vehicle photos</li>
        <li>Saved addresses, device notification tokens and your sign-in link</li>
        <li>For riders: your location history and vehicle details</li>
      </ul>
      <h2 style="margin-top:18px">What we keep</h2>
      <ul>
        <li>Records of completed trips and payments, with your personal details removed, for accounting, tax and fraud-prevention purposes.</li>
        <li>Messages sent in an order chat stay attached to that order for the other party's record, without your name.</li>
      </ul>
    </section>
  </div>
</main>
<footer>Aiko by Nuriq Solutions · Minna, Niger State, Nigeria<br>Questions? <a href="mailto:rabigroupcoltd@gmail.com" style="color:inherit">rabigroupcoltd@gmail.com</a> · <a href="https://aika-admin.onrender.com/privacy" style="color:inherit">Privacy Policy</a> · <a href="https://aika-admin.onrender.com/terms" style="color:inherit">Terms of Service</a></footer>
<script>
  var form = document.getElementById('form');
  var notice = document.getElementById('notice');
  var submit = document.getElementById('submit');
  function show(kind, text) { notice.className = 'notice ' + kind; notice.textContent = text; }
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var contact = document.getElementById('contact').value.trim();
    var reason = document.getElementById('reason').value.trim();
    if (contact.length < 5) return show('err', 'Enter the email address or phone number on your account.');
    if (!document.getElementById('confirm').checked) return show('err', 'Tick the box to confirm you want your account deleted.');
    submit.disabled = true;
    fetch('/api/account/deletion-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reason ? { contact: contact, reason: reason } : { contact: contact })
    }).then(function (res) {
      if (!res.ok) throw new Error();
      form.reset();
      show('ok', 'Request received. If an account matches these details, it will be deleted within 30 days.');
    }).catch(function () {
      show('err', 'Something went wrong. Please try again in a moment.');
    }).finally(function () { submit.disabled = false; });
  });
</script>
</body>
</html>`;
