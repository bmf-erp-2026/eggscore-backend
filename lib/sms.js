// Text-message sender for the Owner's phone codes (Phase B, 0.61). Provider: Termii (Nigeria). Nothing here is switched on until
// the Owner sets the Railway variables below; with any of the three required ones missing the "Text me a code" link stays off.
//   TERMII_API_KEY    (required)  the API key from the Termii dashboard
//   TERMII_SENDER_ID  (required)  the sender name Termii approved for this account (3-11 letters/digits)
//   OWNER_PHONE       (required)  the Owner's own number, e.g. 08012345678 or 2348012345678. Codes are ALWAYS sent here, never to a
//                                 number typed on the page, so nobody can redirect a code.
//   TERMII_BASE_URL   (optional)  default https://v4.api.termii.com (copy the Base URL from the Termii dashboard if yours differs)
//   TERMII_CHANNEL    (optional)  default dnd (transactional, reaches Do-Not-Disturb numbers); generic or whatsapp also work
// The key is read from the environment on every call, never stored or logged.
function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if(d.length === 11 && d[0] === '0') d = '234' + d.slice(1);
  else if(d.length === 10) d = '234' + d;
  return /^234\d{10}$/.test(d) ? d : null;
}
const ownerPhone = () => normPhone(process.env.OWNER_PHONE);
const maskPhone = p => p ? '+' + p.slice(0, 3) + ' *** *** ' + p.slice(-4) : '';
const phoneReady = () => !!(process.env.TERMII_API_KEY && process.env.TERMII_SENDER_ID && ownerPhone());
function missingBits() {
  const m = [];
  if(!process.env.TERMII_API_KEY) m.push('TERMII_API_KEY');
  if(!process.env.TERMII_SENDER_ID) m.push('TERMII_SENDER_ID');
  if(!process.env.OWNER_PHONE) m.push('OWNER_PHONE'); else if(!ownerPhone()) m.push('OWNER_PHONE (not a valid Nigerian number)');
  return m;
}
async function sendSms(to, text) {
  const base = (process.env.TERMII_BASE_URL || 'https://v4.api.termii.com').replace(/\/+$/, '');
  const body = { api_key: process.env.TERMII_API_KEY, to, from: process.env.TERMII_SENDER_ID, sms: text, type: 'plain', channel: process.env.TERMII_CHANNEL || 'dnd' };
  let status = 0, j = null;
  try {
    const r = await fetch(base + '/api/sms/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    status = r.status; try { j = await r.json(); } catch(e) {}
    const ok = r.ok && !!j && (j.code === 'ok' || !!j.message_id);
    return { ok, status, reason: ok ? '' : String((j && (j.message || j.code)) || '').slice(0, 120) };
  } catch(e) { return { ok: false, status: 0, reason: 'no connection' }; }
}
module.exports = { normPhone, ownerPhone, maskPhone, phoneReady, missingBits, sendSms };
