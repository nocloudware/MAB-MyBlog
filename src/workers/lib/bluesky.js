import { decrypt } from './crypto.js';

export async function createBlueskySession(identifier, appPassword) {
  const res = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password: appPassword })
  });
  if (!res.ok) throw new Error('Bluesky auth failed');
  return res.json();
}

async function getBlueskyCredentials(env) {
  const row = await env.DB.prepare("SELECT encrypted_payload FROM social_tokens WHERE platform='bluesky'").first();
  if (!row) throw new Error('Bluesky not connected');
  return JSON.parse(await decrypt(row.encrypted_payload, env));
}

export async function publishToBluesky(post, env) {
  const creds = await getBlueskyCredentials(env);
  const session = await createBlueskySession(creds.identifier, creds.appPassword);

  const record = {
    $type: 'app.bsky.feed.post',
    text: post.message.slice(0, 300),
    createdAt: new Date().toISOString(),
    langs: ['en'],
    embed: {
      $type: 'app.bsky.embed.external',
      external: { uri: post.articleUrl, title: post.title, description: post.excerpt || '' }
    }
  };

  const res = await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.accessJwt}` },
    body: JSON.stringify({ repo: session.did, collection: 'app.bsky.feed.post', record })
  });
  if (!res.ok) throw new Error('Bluesky post failed');
  const { uri } = await res.json();
  const rkey = uri.split('/').pop();
  return { platform: 'bluesky', id: rkey, url: `https://bsky.app/profile/${session.did}/post/${rkey}` };
}