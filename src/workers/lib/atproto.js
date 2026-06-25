import { createBlueskySession } from './bluesky.js';
import { decrypt } from './crypto.js';

async function getSession(env) {
  const row = await env.DB.prepare("SELECT encrypted_payload FROM social_tokens WHERE platform='bluesky'").first();
  if (!row) throw new Error('Bluesky not connected');
  const creds = JSON.parse(await decrypt(row.encrypted_payload, env));
  return createBlueskySession(creds.identifier, creds.appPassword);
}

export async function createPublicationRecord(blogUrl, blogName, description, env) {
  const session = await getSession(env);
  const record = { $type: 'site.standard.publication', url: blogUrl, name: blogName, description: description || '', preferences: { showInDiscover: true } };
  const res = await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.accessJwt}` },
    body: JSON.stringify({ repo: session.did, collection: 'site.standard.publication', record })
  });
  if (!res.ok) throw new Error('Failed to create publication record');
  const { uri } = await res.json();
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('atproto_publication_uri', ?)").bind(uri).run();
  return uri;
}

export async function createDocumentRecord(article, env) {
  const pubRow = await env.DB.prepare("SELECT value FROM settings WHERE key='atproto_publication_uri'").first();
  if (!pubRow?.value) return null;
  const session = await getSession(env);
  const record = { $type: 'site.standard.document', site: pubRow.value, path: '/post/' + article.slug, title: article.title, description: article.excerpt || '', textContent: article.bodyPlain || '', tags: article.tags || [], publishedAt: new Date().toISOString() };
  const res = await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.accessJwt}` },
    body: JSON.stringify({ repo: session.did, collection: 'site.standard.document', record })
  });
  if (!res.ok) return null;
  const { uri } = await res.json();
  await env.DB.prepare('UPDATE post_versions SET atproto_uri=? WHERE slug=? AND version=?').bind(uri, article.slug, article.version).run();
  return uri;
}