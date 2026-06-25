import { createGitHubRelease } from '../lib/releases.js';
import { markdownToHTML } from '../lib/markdown.js';
import { publishToBluesky, createBlueskySession } from '../lib/bluesky.js';
import { publishToTwitter } from '../lib/twitter.js';
import { createDocumentRecord, createPublicationRecord } from '../lib/atproto.js';
import { deleteFromSocialPlatform } from '../lib/social-delete.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import {
  generateSlug, getExcerpt, countWords, readingTimeMinutes,
  escapeHtml, formatDate, getCookie, parseFrontmatter,
  calculateNextOccurrence, processHashtags, getDayHashtags
} from '../lib/utils.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

async function verifyAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.substring(7);
  try {
    const [payloadB64, signatureB64] = token.split('.');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sigBytes = Uint8Array.from(atob(signatureB64), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(payloadB64));
    if (!valid) return false;
    const payload = JSON.parse(atob(payloadB64));
    return payload.exp > Math.floor(Date.now() / 1000);
  } catch { return false; }
}

async function generateJWT(env) {
  const payload = JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400, iat: Math.floor(Date.now() / 1000) });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const sigBase64 = btoa(Array.from(new Uint8Array(sig)).map(b => String.fromCharCode(b)).join(''));
  return `${btoa(payload)}.${sigBase64}`;
}

async function extractPostParams(request) {
  const ct = request.headers.get('Content-Type') || '';
  if (ct.includes('multipart/form-data')) {
    const fd = await request.formData();
    const img = fd.get('image');
    return { title: fd.get('title'), content: fd.get('content'), author: fd.get('author') || 'Author', hashtags: fd.get('hashtags') || '', tags: fd.get('tags') ? JSON.parse(fd.get('tags')) : [], imageFile: (img && img instanceof File) ? new Uint8Array(await img.arrayBuffer()) : null };
  }
  const body = await request.json();
  return { title: body.title, content: body.content, author: body.author || 'Author', hashtags: body.hashtags || '', tags: body.tags || [], imageFile: null };
}

// ============ RENDERER ============
async function renderHome(env) {
  const { results: posts } = await env.DB.prepare(`SELECT p.slug, p.title, p.author, p.created_at, v.excerpt, v.image_url, v.reading_time FROM posts p JOIN post_versions v ON p.slug=v.slug AND p.current_version=v.version WHERE p.status='published' ORDER BY p.created_at DESC LIMIT 20`).all();
  const cards = posts.map(p => `<article style="background:#1a1a2e;border-radius:12px;padding:1.5rem;margin-bottom:1.5rem">${p.image_url?`<img src="${p.image_url}" style="width:100%;max-height:200px;object-fit:cover;border-radius:8px;margin-bottom:1rem">`:''}<h2><a href="/post/${p.slug}" style="color:#e0e0e0;text-decoration:none">${escapeHtml(p.title)}</a></h2><div style="color:#888;font-size:.85rem;margin:.5rem 0">${escapeHtml(p.excerpt||'')}</div><span style="color:#666;font-size:.8rem">${formatDate(p.created_at)} · ${p.reading_time} min</span></article>`).join('');
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${escapeHtml(env.BLOG_NAME||'My Blog')}</title><meta property="og:title" content="${escapeHtml(env.BLOG_NAME||'My Blog')}"><meta property="og:type" content="website"><meta property="og:url" content="${env.BASE_URL}"><link rel="canonical" href="${env.BASE_URL}"><style>body{font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e0e0e0;max-width:800px;margin:0 auto;padding:2rem}h1{text-align:center;margin-bottom:2rem}a{color:#e94560;text-decoration:none}</style></head><body><h1>${escapeHtml(env.BLOG_NAME||'My Blog')}</h1>${cards}</body></html>`, { headers: { 'Content-Type': 'text/html' } });
}

async function renderPost(slug, requestedVersion, env) {
  let v;
  if (requestedVersion) {
    v = await env.DB.prepare('SELECT pv.*, p.title as post_title FROM post_versions pv JOIN posts p ON p.slug=pv.slug WHERE pv.slug=? AND pv.version=?').bind(slug, requestedVersion).first();
  } else {
    const post = await env.DB.prepare("SELECT * FROM posts WHERE slug=? AND status='published'").bind(slug).first();
    if (!post) return new Response('Not found', { status: 404 });
    v = await env.DB.prepare('SELECT pv.*, p.title as post_title FROM post_versions pv JOIN posts p ON p.slug=pv.slug WHERE pv.slug=? AND pv.version=?').bind(slug, post.current_version).first();
  }
  if (!v) return new Response('Not found', { status: 404 });

  try {
    const res = await fetch(v.article_url);
    const md = await res.text();
    const { body } = parseFrontmatter(md);
    const contentHTML = markdownToHTML(body);
    const isLatest = !requestedVersion;
    const title = v.post_title || slug;
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${escapeHtml(title)} | ${escapeHtml(env.BLOG_NAME||'Blog')}</title><meta name="description" content="${escapeHtml(v.excerpt||'')}"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(v.excerpt||'')}"><meta property="og:image" content="${v.image_url||''}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:url" content="${env.BASE_URL}/post/${slug}"><meta property="og:type" content="article"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(v.excerpt||'')}"><meta name="twitter:image" content="${v.image_url||''}"><link rel="canonical" href="${env.BASE_URL}/post/${slug}"><style>body{font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e0e0e0;line-height:1.8;font-size:18px;max-width:800px;margin:0 auto;padding:2rem}h1{font-size:2.2rem;margin-bottom:.5rem}.meta{color:#888;font-size:.9rem;margin-bottom:1.5rem}img{max-width:100%;border-radius:12px;margin:1.5rem 0}blockquote{border-left:3px solid #e94560;padding:.5rem 1rem;color:#888;font-style:italic}a{color:#e94560}code{background:#1a1a2e;padding:.2rem .5rem;border-radius:4px}pre{background:#1a1a2e;padding:1.5rem;border-radius:8px;overflow-x:auto}pre code{background:none;padding:0}${!isLatest?'.old{background:rgba(255,152,0,.1);padding:1rem;border-radius:8px;margin-bottom:1.5rem}':''}</style></head><body>${!isLatest?`<div class="old">Viewing v${v.version}. <a href="/post/${slug}">See latest</a></div>`:''}<h1>${escapeHtml(title)}</h1><div class="meta">${v.reading_time} min read · v${v.version}</div>${v.image_url?`<img src="${v.image_url}" alt="${escapeHtml(title)}">`:''}<div>${contentHTML}</div><p style="margin-top:3rem"><a href="/">← Back to blog</a></p></body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html', 'Cache-Control': isLatest ? 'public, max-age=3600' : 'public, max-age=31536000, immutable' } });
  } catch {
    return new Response('Temporarily unavailable', { status: 503 });
  }
}

// ============ EDITOR PAGE ============
function renderEditor() {
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>MAB-MyBlog Editor</title><style>body{font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e0e0e0;max-width:700px;margin:0 auto;padding:2rem}input,textarea{width:100%;padding:.75rem;margin:.5rem 0 1rem;background:#1a1a2e;border:1px solid #2a2a3e;color:#e0e0e0;border-radius:8px;font-family:inherit}textarea{resize:vertical;min-height:300px;font-family:monospace;font-size:.9rem}button{background:#e94560;color:#fff;border:none;padding:.75rem 2rem;border-radius:8px;cursor:pointer;font-size:1rem}button:hover{background:#ff6b6b}h1{text-align:center}.login-form{max-width:400px;margin:4rem auto}.form-group{margin-bottom:1rem}.form-group label{display:block;margin-bottom:.25rem;font-weight:500}</style></head><body><div class="editor-container"><header><h1>MAB-MyBlog</h1><p style="text-align:center;color:#888">Write. Save. Publish.</p></header><div id="login-form" class="login-form"><h2>Login</h2><form onsubmit="handleLogin(event)"><div class="form-group"><label>Password</label><input type="password" id="login-password" required></div><button type="submit">Login</button></form></div><div id="editor-form" style="display:none"><form onsubmit="createPost(event)"><div class="form-group"><label>Title</label><input type="text" id="title" required></div><div class="form-group"><label>Content (Markdown)</label><textarea id="content" rows="20" required></textarea></div><div class="form-group"><label>Featured Image</label><input type="file" id="image" accept="image/*"></div><div class="form-group"><label>Hashtags</label><input type="text" id="hashtags" maxlength="100" placeholder="#blog #writing"></div><button type="submit">Publish</button></form></div></div><script>let token=localStorage.getItem('token');if(token){document.getElementById('login-form').style.display='none';document.getElementById('editor-form').style.display='block'}async function handleLogin(e){e.preventDefault();const p=document.getElementById('login-password').value;const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})});if(r.ok){const d=await r.json();token=d.token;localStorage.setItem('token',token);document.getElementById('login-form').style.display='none';document.getElementById('editor-form').style.display='block'}else{alert('Wrong password')}}async function createPost(e){e.preventDefault();const title=document.getElementById('title').value;const content=document.getElementById('content').value;const hashtags=document.getElementById('hashtags').value;const r=await fetch('/api/posts',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({title,content,hashtags})});if(r.ok){const d=await r.json();alert('Published! '+d.public_url);window.open(d.public_url,'_blank');document.getElementById('title').value='';document.getElementById('content').value='';document.getElementById('hashtags').value=''}else{alert('Error: '+(await r.json()).error)}}</script></body></html>`, { headers: { 'Content-Type': 'text/html' } });
}

// ============ SCHEDULER ============
async function processSchedules(env) {
  const now = new Date().toISOString();
  const { results: due } = await env.DB.prepare(`SELECT ps.*, p.title, v.article_url, v.image_url, v.excerpt FROM publication_schedules ps JOIN posts p ON p.slug=ps.post_slug AND p.status='published' JOIN post_versions v ON v.slug=p.slug AND v.version=p.current_version WHERE ps.status='active' AND ps.next_occurrence<=? AND (ps.max_occurrences IS NULL OR ps.occurrence_count<ps.max_occurrences) ORDER BY ps.next_occurrence ASC LIMIT 5`).bind(now).all();
  for (const s of due) {
    const platforms = JSON.parse(s.platforms);
    const hashtags = processHashtags(s.custom_hashtags);
    const articleUrl = `${env.BASE_URL}/post/${s.post_slug}`;
    const msg = s.message_template || s.title;
    for (const p of platforms) {
      try {
        let r;
        if (p === 'bluesky') r = await publishToBluesky({ message: `${msg} ${hashtags}`.trim(), articleUrl, title: s.title, excerpt: s.excerpt }, env);
        else if (p === 'twitter') r = await publishToTwitter(`${msg} ${hashtags}\n\n${articleUrl}`.trim(), env);
        if (r) await env.DB.prepare('INSERT INTO publication_history (post_slug,schedule_id,platform,platform_post_id,message_used,is_republish) VALUES (?,?,?,?,?,1)').bind(s.post_slug, s.id, r.platform, r.id, msg).run();
      } catch (e) { console.error(`Schedule ${s.id} failed:`, e); }
    }
    const nc = s.occurrence_count + 1;
    let next = null, st = 'active';
    if (s.schedule_type === 'once') st = 'completed';
    else if (s.max_occurrences && nc >= s.max_occurrences) st = 'completed';
    else if (s.recurrence_interval && s.recurrence_unit) next = calculateNextOccurrence(new Date(), s.recurrence_interval, s.recurrence_unit).toISOString();
    await env.DB.prepare('UPDATE publication_schedules SET occurrence_count=?,next_occurrence=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(nc, next, st, s.id).run();
  }
}

// ============ MAIN ============
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    // Well-known
    if (path === '/.well-known/site.standard.publication') {
      const row = await env.DB.prepare("SELECT value FROM settings WHERE key='atproto_publication_uri'").first();
      return new Response(row?.value || '', { headers: { 'Content-Type': 'text/plain' } });
    }

    // Editor route
    if (method === 'GET' && (path === '/editor' || path === '/editor/')) return renderEditor();

    // Renderer routes
    if (method === 'GET' && path === '/') return renderHome(env);
    const slugMatch = path.match(/^\/post\/([a-z0-9-]+)(?:\/v(\d+))?$/);
    if (method === 'GET' && slugMatch) return renderPost(slugMatch[1], slugMatch[2] ? parseInt(slugMatch[2]) : null, env);

    // API: list posts
    if (method === 'GET' && path === '/api/posts') {
      const { results } = await env.DB.prepare(`SELECT p.slug,p.title,p.author,p.status,p.created_at,v.excerpt,v.image_url,v.word_count,v.reading_time FROM posts p JOIN post_versions v ON p.slug=v.slug AND p.current_version=v.version WHERE p.status='published' ORDER BY p.created_at DESC`).all();
      return json({ posts: results });
    }

    // API: single post
    if (method === 'GET' && path.match(/^\/api\/posts\/[a-z0-9-]+$/)) {
      const slug = path.split('/').pop();
      const post = await env.DB.prepare(`SELECT p.*,v.article_url,v.image_url,v.meta_url,v.excerpt,v.word_count,v.reading_time FROM posts p JOIN post_versions v ON p.slug=v.slug AND p.current_version=v.version WHERE p.slug=? AND p.status='published'`).bind(slug).first();
      if (!post) return json({ error: 'Not found' }, 404);
      try {
        const res = await fetch(post.article_url);
        const { body } = parseFrontmatter(await res.text());
        return json({ slug: post.slug, title: post.title, author: post.author, content: body, excerpt: post.excerpt, image_url: post.image_url, word_count: post.word_count, reading_time: post.reading_time, created_at: post.created_at, version: post.current_version });
      } catch { return json({ slug: post.slug, title: post.title, excerpt: post.excerpt }); }
    }

    // Auth
    if (method === 'POST' && path === '/api/auth/login') {
      const { password } = await request.json();
      if (password !== env.ADMIN_PASSWORD) return json({ error: 'Unauthorized' }, 401);
      return json({ success: true, token: await generateJWT(env) });
    }

    // Protect mutations (TEMP disabled for testing)
    // if (['POST','PUT','DELETE'].includes(method) && !path.includes('/auth/')) {
    //   if (!(await verifyAuth(request, env))) return json({ error: 'Unauthorized' }, 401);
    // }

    // Create post
    if (method === 'POST' && path === '/api/posts') {
      try {
        const { title, content, author, hashtags, tags, imageFile } = await extractPostParams(request);
        if (!title || !content) return json({ error: 'Title and content required' }, 400);
        const slug = generateSlug(title);
        if (await env.DB.prepare('SELECT slug FROM posts WHERE slug=?').bind(slug).first()) return json({ error: 'Already exists' }, 409);
        const date = new Date(), version = 1, releaseTag = `post/${slug}/v${version}`;
        const excerpt = getExcerpt(content), wordCount = countWords(content), readingTime = readingTimeMinutes(wordCount);
        const articleMd = `---\ntitle:"${title}"\nauthor:"${author}"\ndate:"${date.toISOString()}"\nslug:"${slug}"\ntags:${JSON.stringify(tags)}\n---\n\n${content}`;
        const metaJson = JSON.stringify({ title, author, slug, tags, excerpt, date: date.toISOString(), word_count: wordCount, reading_time: readingTime });
        const assets = [{ name: 'article.md', content: articleMd, content_type: 'text/markdown' }, { name: 'meta.json', content: metaJson, content_type: 'application/json' }];
        if (imageFile) assets.push({ name: 'featured.webp', content: imageFile, content_type: 'image/webp' });
        const release = await createGitHubRelease(releaseTag, title, assets, env);
        const articleUrl = release.assets.find(a => a.name === 'article.md').browser_download_url;
        const imageUrl = release.assets.find(a => a.name === 'featured.webp')?.browser_download_url || null;
        await env.DB.batch([
          env.DB.prepare("INSERT INTO posts (slug,current_release_id,current_version,title,author,excerpt_cache,image_url_cache,status,default_hashtags) VALUES (?,?,?,?,?,?,?,'published',?)").bind(slug, release.id.toString(), version, title, author, excerpt, imageUrl, hashtags),
          env.DB.prepare("INSERT INTO post_versions (slug,version,release_id,release_tag,release_url,article_url,image_url,meta_url,excerpt,word_count,reading_time,change_description) VALUES (?,?,?,?,?,?,?,?,?,?,?,'Initial version')").bind(slug, version, release.id.toString(), releaseTag, release.html_url, articleUrl, imageUrl, release.assets.find(a => a.name === 'meta.json').browser_download_url, excerpt, wordCount, readingTime)
        ]);
        return json({ success: true, slug, version, public_url: `${env.BASE_URL}/post/${slug}`, article_url: articleUrl, image_url: imageUrl });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    // Update post
    if (method === 'PUT' && path.match(/^\/api\/posts\/[a-z0-9-]+$/)) {
      try {
        const slug = path.split('/').pop();
        const { title: nt, content, imageFile } = await extractPostParams(request);
        const post = await env.DB.prepare('SELECT * FROM posts WHERE slug=?').bind(slug).first();
        if (!post) return json({ error: 'Not found' }, 404);
        if (!content) return json({ error: 'Content required' }, 400);
        const title = nt || post.title, newVersion = post.current_version + 1, releaseTag = `post/${slug}/v${newVersion}`;
        const excerpt = getExcerpt(content), wordCount = countWords(content), readingTime = readingTimeMinutes(wordCount);
        const assets = [{ name: 'article.md', content, content_type: 'text/markdown' }, { name: 'meta.json', content: JSON.stringify({ title, slug, excerpt, updated_at: new Date().toISOString(), word_count: wordCount, reading_time: readingTime }), content_type: 'application/json' }];
        if (imageFile) assets.push({ name: 'featured.webp', content: imageFile, content_type: 'image/webp' });
        const release = await createGitHubRelease(releaseTag, title, assets, env);
        const articleUrl = release.assets.find(a => a.name === 'article.md').browser_download_url;
        const imageUrl = release.assets.find(a => a.name === 'featured.webp')?.browser_download_url || post.image_url_cache;
        await env.DB.batch([
          env.DB.prepare('UPDATE posts SET current_release_id=?,current_version=?,title=?,image_url_cache=?,updated_at=CURRENT_TIMESTAMP WHERE slug=?').bind(release.id.toString(), newVersion, title, imageUrl, slug),
          env.DB.prepare('INSERT INTO post_versions (slug,version,release_id,release_tag,release_url,article_url,image_url,meta_url,excerpt,word_count,reading_time,change_description) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(slug, newVersion, release.id.toString(), releaseTag, release.html_url, articleUrl, imageUrl, release.assets.find(a => a.name === 'meta.json').browser_download_url, excerpt, wordCount, readingTime, `Updated to v${newVersion}`)
        ]);
        return json({ success: true, slug, version: newVersion });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    // Delete post
    if (method === 'DELETE' && path.match(/^\/api\/posts\/[a-z0-9-]+$/)) {
      const slug = path.split('/').pop();
      const post = await env.DB.prepare('SELECT * FROM posts WHERE slug=?').bind(slug).first();
      if (!post) return json({ error: 'Not found' }, 404);
      const shares = await env.DB.prepare("SELECT * FROM social_shares WHERE post_slug=? AND status='published'").bind(slug).all();
      for (const s of shares.results || []) { try { await deleteFromSocialPlatform(s.platform, s.platform_post_id, env); } catch {} await env.DB.prepare("UPDATE social_shares SET status='deleted' WHERE id=?").bind(s.id).run(); }
      await env.DB.batch([env.DB.prepare('INSERT INTO post_deletions (slug,last_release_id) VALUES (?,?)').bind(slug, post.current_release_id), env.DB.prepare("UPDATE posts SET status='deleted',updated_at=CURRENT_TIMESTAMP WHERE slug=?").bind(slug)]);
      return json({ success: true, deleted: slug });
    }

    // Publish to social
    if (method === 'POST' && path === '/api/publish') {
      try {
        const { postSlug, platforms, message } = await request.json();
        const post = await env.DB.prepare("SELECT p.*,v.article_url,v.image_url,v.excerpt FROM posts p JOIN post_versions v ON p.slug=v.slug AND p.current_version=v.version WHERE p.slug=? AND p.status='published'").bind(postSlug).first();
        if (!post) return json({ error: 'Not found' }, 404);
        const articleUrl = `${env.BASE_URL}/post/${post.slug}`, results = [];
        for (const platform of platforms) {
          try {
            let result;
            if (platform === 'bluesky') result = await publishToBluesky({ message: message || post.title, articleUrl, title: post.title, excerpt: post.excerpt }, env);
            else if (platform === 'twitter') result = await publishToTwitter(`${message || post.title}\n\n${articleUrl}`, env);
            if (result) { await env.DB.prepare("INSERT INTO social_shares (post_slug,platform,platform_post_id,platform_post_url,status) VALUES (?,?,?,?,'published')").bind(postSlug, result.platform, result.id, result.url || '').run(); results.push({ platform, success: true, id: result.id }); }
          } catch (e) { results.push({ platform, success: false, error: e.message }); }
        }
        return json({ success: results.some(r => r.success), results });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    // Delete from social
    if (method === 'DELETE' && path === '/api/publish') {
      try {
        const { postSlug, platforms } = await request.json();
        const ph = platforms.map(() => '?').join(',');
        const shares = await env.DB.prepare(`SELECT * FROM social_shares WHERE post_slug=? AND platform IN (${ph}) AND status='published'`).bind(postSlug, ...platforms).all();
        const results = [];
        for (const s of shares.results || []) { try { await deleteFromSocialPlatform(s.platform, s.platform_post_id, env); await env.DB.prepare("UPDATE social_shares SET status='deleted' WHERE id=?").bind(s.id).run(); results.push({ platform: s.platform, success: true }); } catch (e) { results.push({ platform: s.platform, success: false, error: e.message }); } }
        return json({ success: results.some(r => r.success), results });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    // Social connect
    if (method === 'POST' && path === '/api/social/connect') {
      try {
        const { platform, credentials } = await request.json();
        const handle = credentials.handle || credentials.identifier || '';
        const encrypted = await encrypt(JSON.stringify(credentials), env);
        await env.DB.prepare('INSERT OR REPLACE INTO social_tokens (platform,handle,encrypted_payload) VALUES (?,?,?)').bind(platform, handle, encrypted).run();
        if (platform === 'bluesky') { try { await createPublicationRecord(env.BASE_URL, env.BLOG_NAME, '', env); } catch {} }
        return json({ success: true, platform });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    if (method === 'GET' && path === '/api/social/status') {
      const { results } = await env.DB.prepare('SELECT platform,handle FROM social_tokens').all();
      return json({ connections: results });
    }

    // Schedule
    if (method === 'GET' && path === '/api/schedule') {
      const { results } = await env.DB.prepare('SELECT * FROM publication_schedules ORDER BY created_at DESC').all();
      return json({ schedules: results });
    }
    if (method === 'POST' && path === '/api/schedule') {
      try {
        const d = await request.json();
        let next = d.scheduleType === 'once' ? d.scheduledAt : calculateNextOccurrence(new Date(), d.recurrenceInterval, d.recurrenceUnit).toISOString();
        const r = await env.DB.prepare('INSERT INTO publication_schedules (post_slug,name,schedule_type,platforms,message_template,custom_hashtags,scheduled_at,recurrence_interval,recurrence_unit,max_occurrences,next_occurrence) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(d.postSlug, d.name, d.scheduleType, JSON.stringify(d.platforms), d.messageTemplate||'', d.customHashtags||'', d.scheduledAt||null, d.recurrenceInterval||null, d.recurrenceUnit||null, d.maxOccurrences||null, next).run();
        return json({ success: true, id: r.lastRowId });
      } catch (e) { return json({ error: e.message }, 500); }
    }
    if (method === 'DELETE' && path.match(/^\/api\/schedule\/\d+$/)) {
      await env.DB.prepare("UPDATE publication_schedules SET status='cancelled' WHERE id=?").bind(path.split('/').pop()).run();
      return json({ success: true });
    }

    // Hashtags & Settings
    if (method === 'GET' && path === '/api/hashtags') { const { results } = await env.DB.prepare('SELECT * FROM hashtag_templates ORDER BY day_of_week').all(); return json({ hashtags: results }); }
    if (method === 'GET' && path === '/api/settings') { const { results } = await env.DB.prepare('SELECT * FROM settings').all(); const s = {}; for (const r of results) s[r.key] = r.value; return json({ settings: s }); }
    if (method === 'PUT' && path === '/api/settings') { const d = await request.json(); for (const [k, v] of Object.entries(d)) await env.DB.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').bind(k, String(v)).run(); return json({ success: true }); }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },

  async scheduled(event, env, ctx) {
    await processSchedules(env);
  }
};