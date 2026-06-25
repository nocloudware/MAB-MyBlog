import { decrypt } from './crypto.js';
import { createBlueskySession } from './bluesky.js';

async function getCreds(platform, env) {
  const row = await env.DB.prepare('SELECT encrypted_payload FROM social_tokens WHERE platform=?').bind(platform).first();
  if (!row) throw new Error(`${platform} not connected`);
  return JSON.parse(await decrypt(row.encrypted_payload, env));
}

export async function deleteFromSocialPlatform(platform, platformPostId, env) {
  if (platform === 'bluesky') {
    const creds = await getCreds('bluesky', env);
    const session = await createBlueskySession(creds.identifier, creds.appPassword);
    await fetch('https://bsky.social/xrpc/com.atproto.repo.deleteRecord', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.accessJwt}` },
      body: JSON.stringify({ repo: session.did, collection: 'app.bsky.feed.post', rkey: platformPostId })
    });
  } else if (platform === 'twitter') {
    const pct = s => encodeURIComponent(s);
    const creds = await getCreds('twitter', env);
    const url = `https://api.twitter.com/2/tweets/${platformPostId}`;
    const params = {
      oauth_consumer_key: creds.apiKey, oauth_nonce: crypto.randomUUID().replace(/-/g, ''),
      oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_token: creds.accessToken, oauth_version: '1.0'
    };
    const sorted = Object.keys(params).sort();
    const paramStr = sorted.map(k => `${pct(k)}=${pct(params[k])}`).join('&');
    const base = ['DELETE', pct(url), pct(paramStr)].join('&');
    const sigKey = `${pct(creds.apiSecret)}&${pct(creds.accessSecret)}`;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(sigKey), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base));
    params.oauth_signature = btoa(String.fromCharCode(...new Uint8Array(sig)));
    const auth = 'OAuth ' + Object.keys(params).map(k => `${pct(k)}="${pct(params[k])}"`).join(', ');
    const res = await fetch(url, { method: 'DELETE', headers: { 'Authorization': auth } });
    if (!res.ok && res.status !== 404) throw new Error('Failed to delete tweet');
  }
}