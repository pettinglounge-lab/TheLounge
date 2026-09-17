import { supabase } from './supabaseClient.js';
import { refreshCredits } from './credits.js';

const panel = document.getElementById('credit-reload');
const message = document.getElementById('credit-payment-msg');
const buttons = [...panel.querySelectorAll('[data-credit-package]')];
const params = new URLSearchParams(location.search);
const { data: { session } } = await supabase.auth.getSession();
// Credit purchases are available to signed-in permanent accounts.
if (session?.user.is_anonymous === false) {
  panel.hidden = false;
  const key = 'ptl_credit_checkout_live:' + session.user.id;
  let busy = false;
  // Back from Stripe may restore the disabled page from the browser cache.
  window.addEventListener('pageshow', event => {
    if (event.persisted) location.reload();
  });
  buttons.forEach(button => button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    buttons.forEach(b => b.disabled = true);
    message.textContent = 'Opening secure checkout…';
    try {
      const packageId = button.dataset.creditPackage;
      let prior;
      try { prior = JSON.parse(sessionStorage.getItem(key)); } catch {}
      const attempt = prior?.packageId === packageId && Date.now() - prior.created < 1800000
        ? prior : { packageId, requestId: crypto.randomUUID(), created: Date.now() };
      sessionStorage.setItem(key, JSON.stringify(attempt));
      const controller = new AbortController();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Checkout took too long. Please try again; your existing checkout attempt will be reused.'));
          controller.abort();
        }, 45000);
      });
      let result;
      try {
        result = await Promise.race([
          supabase.functions.invoke('create-credit-checkout', {
            body: { packageId, requestId: attempt.requestId },
            signal: controller.signal,
          }), timeout,
        ]);
      } finally {
        clearTimeout(timer);
      }
      const { data, error } = result;
      if (error || data?.error) {
        let detail = data;
        try { detail = await error.context.json(); } catch {}
        throw new Error(detail?.error || 'Unable to open checkout. Please try again.');
      }
      const target = new URL(data.url);
      if (target.protocol !== 'https:' || target.hostname !== 'checkout.stripe.com') throw new Error('Invalid checkout link.');
      location.assign(target.href);
    } catch (error) {
      message.textContent = error.message;
      busy = false;
      buttons.forEach(b => b.disabled = false);
    }
  }));

  if (params.has('credit_payment')) {
    sessionStorage.removeItem(key);
    if (params.get('credit_payment') === 'cancelled') {
      message.textContent = 'Checkout cancelled. No credits were added by this page.';
    } else {
      const id = params.get('session_id');
      if (!/^cs_live_[A-Za-z0-9]+$/.test(id || '')) {
        message.textContent = 'Unable to identify this payment. Contact support if you need help.';
      } else {
        busy = true;
        buttons.forEach(b => b.disabled = true);
        message.textContent = 'Waiting for payment confirmation…';
        let confirmed = false;
        for (let i = 0; i < 15; i++) {
          const { data, error } = await supabase.rpc('get_credit_purchase_status', { p_session_id: id });
          if (error) { message.textContent = 'Unable to check payment status. Refresh to try again.'; break; }
          if (data?.fulfilled === true && data.livemode === true) {
            const balance = await refreshCredits();
            message.textContent = `${data.credits} credits added.` + (balance.unavailable ? ' Refresh to reload your balance.' : ' Your balance has been updated.');
            confirmed = true;
            break;
          }
          if (i === 14) message.textContent = 'Payment confirmation is still pending. Refresh in a moment; do not pay again for this purchase.';
          else await new Promise(resolve => setTimeout(resolve, 2000));
        }
        if (confirmed) {
          const cleanUrl = new URL(location.href);
          cleanUrl.searchParams.delete('credit_payment');
          cleanUrl.searchParams.delete('session_id');
          cleanUrl.searchParams.delete('credits_test');
          history.replaceState(history.state, '', cleanUrl.href);
          busy = false;
          buttons.forEach(b => b.disabled = false);
        }
      }
    }
  }
}
