import { decrypt } from './crypto.js';
const pct = s => encodeURIComponent(s);

async function getTwitterCredentials(env) {
  const row = await env.DB.prepare("SELECT encrypted_payload FROM social_tokens WHERE platform='twitter'").first();
  if (!row) throw new Error('Twitter not connected');
  return JSON.parse(await decrypt(row.encrypted_payload, env));
}

async function buildOAuth1Header(method, url, env) {
  const creds = await getTwitterCredentials(env);
  const params = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: '1.0'
  };
  const sorted = Object.keys(params).sort();
  const paramStr = sorted.map(k => `${pct(k)}=${pct(params[k])}`).join('&');
  const base = [method, pct(url), pct(paramStr)].join('&');
  const sigKey = `${pct(creds.apiSecret)}&${pct(creds.accessSecret)}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(sigKey), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base));
  params.oauth_signature = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return 'OAuth ' + Object.keys(params).map(k => `${pct(k)}="${pct(params[k])}"`).join(', ');
}

export async function publishToTwitter(text, env) {
  const url = 'https://api.twitter.com/2/tweets';
  const auth = await buildOAuth1Header('POST', url, env);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.slice(0, 280) })
  });
  if (res.status === 429) throw new Error('Twitter rate limit');
  if (!res.ok) { const e = await res.json(); throw new Error(e?.detail || 'Twitter post failed'); }
  const { data } = await res.json();
  return { platform: 'twitter', id: data.id };
}