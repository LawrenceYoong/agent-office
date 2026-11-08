// Mini App entry: verify Telegram initData with the office, then redirect to /lite.
const WebApp = (window as any).Telegram?.WebApp;

async function main() {
  const msg = document.getElementById('msg')!;
  const err = document.getElementById('err')!;
  const spin = document.getElementById('spin')!;

  if (!WebApp) {
    msg.textContent = 'Not running inside Telegram.';
    spin.style.display = 'none';
    return;
  }
  WebApp.expand();
  WebApp.ready();

  const initData = WebApp.initData;
  if (!initData) {
    msg.textContent = 'No Telegram session.';
    spin.style.display = 'none';
    return;
  }

  try {
    const r = await fetch('/api/telegram/miniapp-auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData }),
      credentials: 'same-origin',
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    // Session cookie set by the server; go to the 2D office.
    location.replace('/lite');
  } catch (e) {
    spin.style.display = 'none';
    msg.textContent = 'Sign-in failed.';
    err.textContent = e instanceof Error ? e.message : String(e);
    WebApp.showAlert?.('Sign-in failed: ' + (e instanceof Error ? e.message : e));
  }
}

main();
