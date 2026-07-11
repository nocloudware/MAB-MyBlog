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

async function getEffectiveToken(env, key) {
  const override = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(`_${key}_token_override`).first();
  if (override && override.value) return override.value;
  return env[key];
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

async function generateJWT(env) {
  const payload = JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400, iat: Math.floor(Date.now() / 1000) });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const sigBase64 = btoa(Array.from(new Uint8Array(sig)).map(b => String.fromCharCode(b)).join(''));
  return `${btoa(payload)}.${sigBase64}`;
}

// ============ STATS HELPERS ============
function shouldRefresh(fetchedAt, postCreatedAt) {
  const now = new Date();
  const postAge = (now - new Date(postCreatedAt)) / (1000 * 60 * 60 * 24);
  if (!fetchedAt) return true;
  const lastFetch = new Date(fetchedAt);
  const hoursSinceLastFetch = (now - lastFetch) / (1000 * 60 * 60);
  if (postAge < 1) return hoursSinceLastFetch > 0.25;
  if (postAge < 2) return hoursSinceLastFetch > 1;
  if (postAge < 3) return hoursSinceLastFetch > 2;
  if (postAge < 7) return hoursSinceLastFetch > 6;
  if (postAge < 30) return hoursSinceLastFetch > 24;
  return hoursSinceLastFetch > 72;
}

async function fetchBlueskyStats(rkey, env) {
  const row = await env.DB.prepare("SELECT encrypted_payload FROM social_tokens WHERE platform='bluesky'").first();
  if (!row) return null;
  const creds = JSON.parse(await decrypt(row.encrypted_payload, env));
  const session = await createBlueskySession(creds.identifier, creds.appPassword);
  const uri = `at://${session.did}/app.bsky.feed.post/${rkey}`;
  const res = await fetch(`https://bsky.social/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=0`, {
    headers: { 'Authorization': `Bearer ${session.accessJwt}` }
  });
  if (!res.ok) return null;
  const data = await res.json();
  const post = data.thread?.post;
  if (!post) return null;
  return { likes: post.likeCount || 0, reposts: post.repostCount || 0, replies: post.replyCount || 0, quotes: post.quoteCount || 0 };
}

async function fetchTwitterStats(tweetId, env) {
  const row = await env.DB.prepare("SELECT encrypted_payload FROM social_tokens WHERE platform='twitter'").first();
  if (!row) return null;
  const creds = JSON.parse(await decrypt(row.encrypted_payload, env));
  const auth = await buildOAuth1Header('GET', `https://api.twitter.com/2/tweets/${tweetId}?tweet.fields=public_metrics`, creds);
  const res = await fetch(`https://api.twitter.com/2/tweets/${tweetId}?tweet.fields=public_metrics`, {
    headers: { 'Authorization': auth }
  });
  if (!res.ok) return null;
  const data = await res.json();
  const metrics = data.data?.public_metrics;
  if (!metrics) return null;
  return { likes: metrics.like_count || 0, reposts: metrics.retweet_count || 0, replies: metrics.reply_count || 0, quotes: metrics.quote_count || 0 };
}

async function buildOAuth1Header(method, url, creds) {
  const pct = s => encodeURIComponent(s);
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

async function saveStats(shareId, stats, env) {
  if (!stats) return;
  await env.DB.prepare('INSERT INTO post_stats (share_id, likes, reposts, replies, quotes) VALUES (?,?,?,?,?)')
    .bind(shareId, stats.likes, stats.reposts, stats.replies, stats.quotes).run();
}

// ============ SHARED UI ============
function buildSidebar() {
  return {
    css: `
:root{--bg:#0a0a0f;--surface:#1a1a2e;--border:#2a2a3e;--text:#e0e0e0;--text2:#888;--accent:#e94560;--green:#4caf50;--radius:8px}
.sidebar{width:340px;background:#111118;border-left:1px solid var(--border);padding:1rem;overflow-y:auto;display:none;position:fixed;right:0;top:0;bottom:0;z-index:100;font-size:.8rem}
.sidebar.open{display:block}
.sidebar h2{font-size:1rem;margin:0;color:var(--text)}
.sidebar-divider{height:1px;background:var(--border);margin:1rem 0}
.sidebar-section{margin-bottom:1rem}
.section-title{font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);margin-bottom:.5rem;font-weight:600}
.status-badge{display:inline-block;padding:.15rem .5rem;border-radius:10px;font-size:.7rem;font-weight:600}
.status-ok{background:rgba(76,175,80,.15);color:var(--green)}
.status-error{background:rgba(244,67,54,.15);color:#f44336}
.help-link{font-size:.7rem;color:#64b5f6;cursor:pointer;text-decoration:underline}
.sidebar-toggle{position:fixed;right:0;top:50%;transform:translateY(-50%);background:var(--accent);color:#fff;border:none;padding:.6rem .35rem;border-radius:6px 0 0 6px;cursor:pointer;z-index:101;font-size:1rem;writing-mode:vertical-lr}
.sidebar .form-group{margin-bottom:.5rem}
.sidebar .form-group label{font-size:.7rem;color:#aaa;display:block;margin-bottom:.15rem}
.sidebar input{width:100%;padding:.45rem .5rem;background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:var(--radius);font-family:inherit;font-size:.75rem;box-sizing:border-box}
.sidebar input:focus{outline:none;border-color:var(--accent)}
.sidebar .btn-sm{padding:.3rem .7rem;font-size:.7rem;border:none;border-radius:var(--radius);cursor:pointer;font-family:inherit;background:var(--surface);color:var(--text);border:1px solid var(--border)}
.sidebar .btn-green{background:var(--green);border:1px solid var(--green);color:#fff}
.sidebar .btn-green:hover{background:#66bb6a}
.sidebar .toggle-group{display:flex;align-items:center;justify-content:space-between;padding:.3rem 0;font-size:.8rem}
.sidebar .toggle{position:relative;width:40px;height:20px}
.sidebar .toggle input{opacity:0;width:0;height:0;position:absolute}
.sidebar .toggle .slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:var(--border);border-radius:20px;transition:.3s}
.sidebar .toggle .slider:before{position:absolute;content:"";height:14px;width:14px;left:3px;bottom:3px;background:var(--text2);border-radius:50%;transition:.3s}
.sidebar .toggle input:checked+.slider{background:var(--green)}
.sidebar .toggle input:checked+.slider:before{transform:translateX(20px);background:#fff}
.save-indicator{color:var(--green);font-size:.7rem;display:none;margin-left:.5rem}
.post-actions{display:flex;flex-direction:column;gap:.4rem;flex-shrink:0}
.post-actions button{background:var(--surface);border:1px solid var(--border);color:var(--text2);padding:.3rem .6rem;border-radius:6px;cursor:pointer;font-size:.7rem;white-space:nowrap}
.post-actions button:hover{border-color:var(--accent);color:var(--accent)}
.post-actions .btn-edit:hover{border-color:#4caf50;color:#4caf50}
.post-actions .btn-delete:hover{border-color:#f44336;color:#f44336}
.share-counts{display:flex;gap:1rem;font-size:.75rem;color:var(--text2);margin-top:.3rem}
.auth-only{display:none}
`,
    html: `
<div class="sidebar" id="sidebar">
  <div style="display:flex;justify-content:space-between;align-items:center;padding-bottom:.75rem;border-bottom:1px solid #2a2a3e;margin-bottom:1rem">
    <h2>⚙ Settings</h2>
    <button onclick="toggleSidebar()" style="background:none;border:none;color:#888;cursor:pointer;font-size:1.2rem;padding:0">&times;</button>
  </div>
  <div class="sidebar-section" id="loginSection">
    <div class="section-title">🔐 Login</div>
    <div class="form-group"><label>Password</label><input type="password" id="sidebarPassword" placeholder="Enter password"></div>
    <button class="btn-sm btn-green" onclick="sidebarLogin()">Login</button> <span id="loginStatus"></span>
  </div>
  <div class="auth-only">
    <div class="sidebar-divider"></div>
    <div class="sidebar-section">
      <div class="section-title">📢 Auto-Publish</div>
      <div class="toggle-group"><span>🦋 Bluesky</span><label class="toggle"><input type="checkbox" id="autoBluesky" onchange="saveAutoPublish()"><span class="slider"></span></label></div>
      <div class="toggle-group"><span>𝕏 Twitter/X</span><label class="toggle"><input type="checkbox" id="autoTwitter" onchange="saveAutoPublish()"><span class="slider"></span></label></div>
    </div>
    <div class="sidebar-divider"></div>
    <div class="sidebar-section">
      <div class="section-title">🦋 Bluesky</div>
      <div class="form-group"><label>Identifier (user.bsky.social)</label><input type="text" id="bskyId" placeholder="user.bsky.social"></div>
      <div class="form-group"><label>App Password</label><input type="password" id="bskyPass" placeholder="xxxx-xxxx-xxxx-xxxx"></div>
      <span class="help-link" onclick="window.open('https://bsky.app/settings/app-passwords','_blank')">Get App Password →</span>
      <div style="margin-top:.5rem"><button class="btn-sm btn-green" onclick="connectBluesky()">Connect</button> <span id="bskyStatus"></span></div>
    </div>
    <div class="sidebar-divider"></div>
    <div class="sidebar-section">
      <div class="section-title">𝕏 Twitter/X</div>
      <div class="form-group"><label>API Key</label><input type="password" id="twKey"></div>
      <div class="form-group"><label>API Secret</label><input type="password" id="twSecret"></div>
      <div class="form-group"><label>Access Token</label><input type="password" id="twToken"></div>
      <div class="form-group"><label>Access Secret</label><input type="password" id="twTokenSecret"></div>
      <span class="help-link" onclick="window.open('https://developer.twitter.com/en/portal/dashboard','_blank')">Get API keys →</span>
      <div style="margin-top:.5rem"><button class="btn-sm btn-green" onclick="connectTwitter()">Connect</button> <span id="twStatus"></span></div>
    </div>
    <div class="sidebar-divider"></div>
    <div class="sidebar-section">
      <div class="section-title">📊 Stats</div>
      <div style="display:flex;gap:.3rem;margin-bottom:.5rem;align-items:center;font-size:.75rem">
        <input type="number" id="statsDays" value="1" min="0" style="width:45px;text-align:center;padding:.3rem"> days
        <input type="number" id="statsMonths" value="0" min="0" style="width:45px;text-align:center;padding:.3rem"> months
        <input type="number" id="statsYears" value="0" min="0" style="width:45px;text-align:center;padding:.3rem"> years
      </div>
      <button class="btn-sm btn-outline" onclick="refreshStats()">🔄 Refresh Stats</button> <span id="statsStatus" style="font-size:.7rem"></span>
    </div>
    <div class="sidebar-divider"></div>
    <div class="sidebar-section">
      <div class="section-title">📝 Blog</div>
      <div class="form-group"><label>Blog Name</label><input type="text" id="blogName"></div>
      <div class="form-group"><label>Default Author</label><input type="text" id="defaultAuthor"></div>
      <button class="btn-sm btn-green" onclick="saveSettings()">Save</button> <span class="save-indicator" id="settingsSaved">✓</span>
    </div>
    <div class="sidebar-divider"></div>
    <div class="sidebar-section">
      <button class="btn-sm" onclick="logout()" style="color:#f44336;border-color:#f44336;width:100%">🚪 Logout</button>
    </div>
  </div>
</div>
<button class="sidebar-toggle" id="sidebarToggle" onclick="toggleSidebar()" title="Settings">⚙</button>
`,
    js: `
let _token=localStorage.getItem('token');
function toggleSidebar(){document.getElementById('sidebar').classList.toggle('open')}
document.addEventListener('click',function(e){const sb=document.getElementById('sidebar');const st=document.getElementById('sidebarToggle');if(sb.classList.contains('open')&&!sb.contains(e.target)&&e.target!==st&&!st.contains(e.target)){sb.classList.remove('open')}})
function updateAuthUI(){
  if(_token){
    document.getElementById('loginSection').style.display='none';
    document.querySelectorAll('.auth-only').forEach(el=>el.style.display='block');
    document.getElementById('sidebarToggle').style.display='block';
    document.querySelectorAll('.post-actions').forEach(el=>el.style.display='flex');
    var nb=document.getElementById('newPostLink');if(nb)nb.style.display='inline-block';
    loadSettings();
  } else {
    document.getElementById('loginSection').style.display='block';
    document.querySelectorAll('.auth-only').forEach(el=>el.style.display='none');
    document.querySelectorAll('.post-actions').forEach(el=>el.style.display='none');
    var nb=document.getElementById('newPostLink');if(nb)nb.style.display='none';
  }
}
async function sidebarLogin(){
  const p=document.getElementById('sidebarPassword').value;
  const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})});
  if(r.ok){const d=await r.json();_token=d.token;localStorage.setItem('token',_token);document.getElementById('loginStatus').innerHTML='<span class="status-badge status-ok">✓</span>';updateAuthUI()}
  else{document.getElementById('loginStatus').innerHTML='<span class="status-badge status-error">✗</span>'}
}
function logout(){localStorage.removeItem('token');_token=null;updateAuthUI();document.getElementById('sidebarPassword').value=''}
async function connectBluesky(){const id=document.getElementById('bskyId').value;const pass=document.getElementById('bskyPass').value;if(!id||!pass){alert('Fill both fields');return}const r=await fetch('/api/social/connect',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+_token},body:JSON.stringify({platform:'bluesky',credentials:{identifier:id,appPassword:pass,handle:id}})});if(r.ok){document.getElementById('bskyStatus').innerHTML='<span class="status-badge status-ok">✓ OK</span>'}else{document.getElementById('bskyStatus').innerHTML='<span class="status-badge status-error">✗ Fail</span>'}}
async function connectTwitter(){const key=document.getElementById('twKey').value;const secret=document.getElementById('twSecret').value;const at=document.getElementById('twToken').value;const ats=document.getElementById('twTokenSecret').value;if(!key||!secret||!at||!ats){alert('Fill all fields');return}const r=await fetch('/api/social/connect',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+_token},body:JSON.stringify({platform:'twitter',credentials:{apiKey:key,apiSecret:secret,accessToken:at,accessSecret:ats}})});if(r.ok){document.getElementById('twStatus').innerHTML='<span class="status-badge status-ok">✓ OK</span>'}else{document.getElementById('twStatus').innerHTML='<span class="status-badge status-error">✗ Fail</span>'}}
async function saveSettings(){const blogName=document.getElementById('blogName').value;const author=document.getElementById('defaultAuthor').value;const r=await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json','Authorization':'Bearer '+_token},body:JSON.stringify({blog_name:blogName,author_name:author})});if(r.ok){localStorage.setItem('autoBluesky',document.getElementById('autoBluesky').checked);localStorage.setItem('autoTwitter',document.getElementById('autoTwitter').checked);document.getElementById('settingsSaved').style.display='inline';setTimeout(()=>document.getElementById('settingsSaved').style.display='none',2000)}}
function saveAutoPublish(){localStorage.setItem('autoBluesky',document.getElementById('autoBluesky').checked);localStorage.setItem('autoTwitter',document.getElementById('autoTwitter').checked)}
async function loadSettings(){try{const r=await fetch('/api/settings',{headers:{'Authorization':'Bearer '+_token}});if(r.ok){const d=await r.json();const s=d.settings||{};document.getElementById('blogName').value=s.blog_name||'';document.getElementById('defaultAuthor').value=s.author_name||'';document.getElementById('autoBluesky').checked=localStorage.getItem('autoBluesky')==='true';document.getElementById('autoTwitter').checked=localStorage.getItem('autoTwitter')==='true'}}catch(e){}}
async function publishToSocial(slug,platform){if(!_token){alert('Login required');return}const r=await fetch('/api/publish',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+_token},body:JSON.stringify({postSlug:slug,platforms:[platform]})});if(r.ok){const d=await r.json();if(d.results[0]&&d.results[0].success){alert('Published to '+platform+'!');location.reload()}else{alert('Failed: '+(d.results[0]?.error||'Unknown error'))}}else{alert('Error publishing')}}
async function editPost(slug){window.location.href='/editor?edit='+slug}
async function deletePost(slug){if(!confirm('Delete this article? It will also be removed from all social networks.'))return;const r=await fetch('/api/posts/'+slug,{method:'DELETE',headers:{'Authorization':'Bearer '+_token}});if(r.ok){alert('Deleted!');location.reload()}else{alert('Error deleting')}}
async function refreshStats(){
  const d=document.getElementById('statsDays').value;
  const m=document.getElementById('statsMonths').value;
  const y=document.getElementById('statsYears').value;
  document.getElementById('statsStatus').textContent='...';
  const r=await fetch('/api/stats/refresh?days='+d+'&months='+m+'&years='+y,{headers:{'Authorization':'Bearer '+_token}});
  if(r.ok){const j=await r.json();document.getElementById('statsStatus').textContent='✓ '+j.refreshed+'/'+j.checked}
  else{document.getElementById('statsStatus').textContent='✗ Error'}
}
updateAuthUI();
`
  };
}

// ============ RENDERER ============
async function renderHome(env) {
  const sb = buildSidebar();
  const { results: posts } = await env.DB.prepare(`SELECT p.slug, p.title, p.author, p.created_at, v.excerpt, v.image_url, v.reading_time FROM posts p JOIN post_versions v ON p.slug=v.slug AND p.current_version=v.version WHERE p.status='published' ORDER BY p.created_at DESC LIMIT 20`).all();
  const slugs = posts.map(p => `'${p.slug}'`).join(',');
  let shareCounts = {};
  let statsTotals = {};
  if (slugs) {
    const { results: counts } = await env.DB.prepare(`SELECT post_slug, platform, COUNT(*) as cnt FROM social_shares WHERE post_slug IN (${slugs}) AND status='published' GROUP BY post_slug, platform`).all();
    for (const c of counts) { if (!shareCounts[c.post_slug]) shareCounts[c.post_slug] = {}; shareCounts[c.post_slug][c.platform] = c.cnt; }
    const { results: stats } = await env.DB.prepare(`SELECT ss.post_slug, ss.platform, ps.likes, ps.reposts FROM social_shares ss JOIN post_stats ps ON ps.id = (SELECT id FROM post_stats WHERE share_id = ss.id ORDER BY fetched_at DESC LIMIT 1) WHERE ss.post_slug IN (${slugs}) AND ss.status='published'`).all();
    for (const s of stats) {
      if (!statsTotals[s.post_slug]) statsTotals[s.post_slug] = {};
      if (!statsTotals[s.post_slug][s.platform]) statsTotals[s.post_slug][s.platform] = { likes: 0, reposts: 0 };
      statsTotals[s.post_slug][s.platform].likes += (s.likes || 0);
      statsTotals[s.post_slug][s.platform].reposts += (s.reposts || 0);
    }
  }
  const cards = posts.map(p => {
    const sc = shareCounts[p.slug] || {};
    const st = statsTotals[p.slug] || {};
    const bsStats = st.bluesky || { likes: 0, reposts: 0 };
    const twStats = st.twitter || { likes: 0, reposts: 0 };
    return `<article class="post-card">${p.image_url?`<img src="${p.image_url}" alt="">`:''}<div style="flex:1"><h2><a href="/post/${p.slug}">${escapeHtml(p.title)}</a></h2><div class="post-author">by ${escapeHtml(p.author||'Author')}</div><div class="post-excerpt">${escapeHtml(p.excerpt||'')}</div><div class="share-counts"><span>🦋 ${sc.bluesky||0} (💗${bsStats.likes} 🔁${bsStats.reposts})</span><span>𝕏 ${sc.twitter||0} (💗${twStats.likes} 🔁${twStats.reposts})</span><span>📅 ${formatDate(p.created_at)}</span><span>⏱️ ${p.reading_time} min</span></div></div><div class="post-actions" style="display:none"><button onclick="publishToSocial('${p.slug}','bluesky')">🦋 Bluesky</button><button onclick="publishToSocial('${p.slug}','twitter')">𝕏 Twitter</button><button class="btn-edit" onclick="editPost('${p.slug}')">✏️ Edit</button><button class="btn-delete" onclick="deletePost('${p.slug}')">🗑️ Delete</button></div></article>`;
  }).join('');
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${escapeHtml(env.BLOG_NAME||'My Blog')}</title><meta property="og:title" content="${escapeHtml(env.BLOG_NAME||'My Blog')}"><meta property="og:type" content="website"><link rel="canonical" href="${env.BASE_URL}"><style>:root{--bg:#0a0a0f;--surface:#1a1a2e;--text:#e0e0e0;--text2:#888;--accent:#e94560}body{font-family:-apple-system,sans-serif;background:var(--bg);color:var(--text);margin:0;min-height:100vh}.container{max-width:800px;margin:0 auto;padding:2rem}h1{font-size:2.2rem;margin-bottom:.25rem;color:var(--accent)}.blog-subtitle{color:var(--text2);margin-bottom:2rem;font-size:.9rem}a{color:var(--accent);text-decoration:none}.new-post-link{display:inline-block;margin-bottom:2rem;padding:.5rem 1rem;background:var(--accent);color:#fff;border-radius:6px;font-size:.85rem}.post-card{background:var(--surface);border-radius:12px;padding:1.5rem;margin-bottom:1.5rem;display:flex;gap:1.5rem;align-items:center}.post-card img{width:120px;height:80px;object-fit:cover;border-radius:8px;flex-shrink:0}.post-card h2{margin:0 0 .15rem}.post-author{color:var(--text2);font-size:.8rem;margin-bottom:.25rem}.post-excerpt{color:var(--text2);font-size:.85rem;margin:.25rem 0}.share-counts{display:flex;gap:1rem;font-size:.75rem;color:var(--text2);margin-top:.3rem}.post-actions{display:flex;flex-direction:column;gap:.4rem;flex-shrink:0}.post-actions button{background:var(--surface);border:1px solid var(--border);color:var(--text2);padding:.3rem .6rem;border-radius:6px;cursor:pointer;font-size:.7rem;white-space:nowrap}.post-actions button:hover{border-color:var(--accent);color:var(--accent)}.post-actions .btn-edit:hover{border-color:#4caf50;color:#4caf50}.post-actions .btn-delete:hover{border-color:#f44336;color:#f44336}${sb.css}</style></head><body>${sb.html}<div class="container"><h1>${escapeHtml(env.BLOG_NAME||'My Blog')}</h1><p class="blog-subtitle">by ${escapeHtml((await env.DB.prepare("SELECT value FROM settings WHERE key='author_name'").first())?.value||'Author')}</p><a href="/editor" class="new-post-link" id="newPostLink" style="display:none">✍ New Post</a>${cards}</div><script>${sb.js}</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}

async function renderPostPage(slug, requestedVersion, env) {
  const sb = buildSidebar();
  let v;
  if (requestedVersion) {
    v = await env.DB.prepare('SELECT pv.*, p.title as post_title, pv.atproto_uri FROM post_versions pv JOIN posts p ON p.slug=pv.slug WHERE pv.slug=? AND pv.version=?').bind(slug, requestedVersion).first();
  } else {
    const post = await env.DB.prepare("SELECT * FROM posts WHERE slug=? AND status='published'").bind(slug).first();
    if (!post) return new Response('Not found', { status: 404 });
    v = await env.DB.prepare('SELECT pv.*, p.title as post_title, pv.atproto_uri FROM post_versions pv JOIN posts p ON p.slug=pv.slug WHERE pv.slug=? AND pv.version=?').bind(slug, post.current_version).first();
  }
  if (!v) return new Response('Not found', { status: 404 });
  try {
    const res = await fetch(v.article_url); const md = await res.text(); const { body } = parseFrontmatter(md);
    const contentHTML = markdownToHTML(body); const isLatest = !requestedVersion; const title = v.post_title || slug;
    const ogImage = v.image_url || ''; const ogDesc = escapeHtml(v.excerpt||'');
    const { results: shares } = await env.DB.prepare(`SELECT ss.*, (SELECT likes FROM post_stats WHERE share_id = ss.id ORDER BY fetched_at DESC LIMIT 1) as likes, (SELECT reposts FROM post_stats WHERE share_id = ss.id ORDER BY fetched_at DESC LIMIT 1) as reposts, (SELECT replies FROM post_stats WHERE share_id = ss.id ORDER BY fetched_at DESC LIMIT 1) as replies FROM social_shares ss WHERE ss.post_slug = ? AND ss.status = 'published' ORDER BY ss.shared_at DESC`).bind(slug).all();
    let statsHTML = '';
    if (shares.length > 0) {
      statsHTML = `<details style="margin:2rem 0;background:var(--surface);border-radius:8px;padding:1rem"><summary style="cursor:pointer;font-weight:600">📊 Social Stats (${shares.length} posts)</summary><div style="margin-top:1rem">`;
      for (const s of shares) {
        statsHTML += `<div style="display:flex;justify-content:space-between;align-items:center;padding:.5rem 0;border-bottom:1px solid var(--border);font-size:.85rem"><span>${s.platform==='bluesky'?'🦋':'𝕏'} ${new Date(s.shared_at).toLocaleDateString()}</span><span>💗 ${s.likes||0} 🔁 ${s.reposts||0} 💬 ${s.replies||0}</span><a href="${s.platform_post_url||'#'}" target="_blank" style="font-size:.7rem;color:var(--accent)">view</a></div>`;
      }
      statsHTML += `</div></details>`;
    }
    const content = `${!isLatest?`<div class="old">Viewing v${v.version}. <a href="/post/${slug}">See latest</a></div>`:''}${v.image_url?`<img src="${v.image_url}" alt="${escapeHtml(title)}" class="featured-image">`:''}<h1>${escapeHtml(title)}</h1><div class="meta">${v.reading_time} min read · v${v.version}</div><div>${contentHTML}</div>${statsHTML}<p style="margin-top:3rem"><a href="/">← Back to blog</a></p>`;
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${escapeHtml(title)} | ${escapeHtml(env.BLOG_NAME||'Blog')}</title><meta name="description" content="${ogDesc}"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${ogDesc}"><meta property="og:image" content="${ogImage}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:url" content="${env.BASE_URL}/post/${slug}"><meta property="og:type" content="article"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${ogDesc}"><meta name="twitter:image" content="${ogImage}">${v.atproto_uri ? `<link rel="site.standard.document" href="${v.atproto_uri}">` : ''}<link rel="canonical" href="${env.BASE_URL}/post/${slug}"><style>:root{--bg:#0a0a0f;--surface:#1a1a2e;--text:#e0e0e0;--text2:#888;--accent:#e94560}body{font-family:-apple-system,sans-serif;background:var(--bg);color:var(--text);margin:0;min-height:100vh}.container{max-width:800px;margin:0 auto;padding:2rem}h1{font-size:2.2rem;margin-bottom:.5rem;color:var(--accent)}a{color:var(--accent);text-decoration:none}img{max-width:100%;border-radius:12px;margin:1.5rem 0}blockquote{border-left:3px solid var(--accent);padding:.5rem 1rem;color:var(--text2);font-style:italic}code{background:var(--surface);padding:.2rem .5rem;border-radius:4px}pre{background:var(--surface);padding:1.5rem;border-radius:8px;overflow-x:auto}pre code{background:none;padding:0}.featured-image{width:100%;max-height:400px;object-fit:cover;border-radius:12px;margin-bottom:1.5rem}.meta{color:var(--text2);font-size:.9rem;margin-bottom:1.5rem}.old{background:rgba(255,152,0,.1);padding:1rem;border-radius:8px;margin-bottom:1.5rem}details summary:hover{color:var(--accent)}${sb.css}</style></head><body>${sb.html}<div class="container">${content}</div><script>${sb.js}</script></body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html', 'Cache-Control': isLatest ? 'public, max-age=3600' : 'public, max-age=31536000, immutable' } });
  } catch { return new Response('Temporarily unavailable', { status: 503 }); }
}

async function renderEditorPage(env, editSlug = null) {
  const sb = buildSidebar();
  let editData = { title: '', content: '', hashtags: '', image_url: '' };
  if (editSlug) {
    const post = await env.DB.prepare("SELECT p.*, v.article_url FROM posts p JOIN post_versions v ON p.slug=v.slug AND p.current_version=v.version WHERE p.slug=? AND p.status='published'").bind(editSlug).first();
    if (post) { try { const res = await fetch(post.article_url); const md = await res.text(); const { body } = parseFrontmatter(md); editData = { title: post.title, content: body, hashtags: post.default_hashtags || '', image_url: post.image_url_cache || '', slug: post.slug }; } catch {} }
  }
  const content = `<h1>MAB-MyBlog</h1><p style="text-align:center;color:var(--text2)">Write. Save. Publish.</p>
<div id="login-form" class="login-form"><h2>Login</h2><form onsubmit="handleLogin(event)"><div class="form-group"><label>Password</label><input type="password" id="login-password" required></div><button type="submit">Login</button></form></div>
<div id="editor-form" style="display:none"><form onsubmit="createPost(event)">
  <input type="hidden" id="editSlug" value="${editSlug||''}">
  <div class="form-group"><label>Title</label><input type="text" id="title" name="title" required value="${escapeHtml(editData.title)}"></div>
  <div class="form-group"><label>Content (Markdown)</label><textarea id="content" name="content" rows="20" required oninput="updatePreview()">${escapeHtml(editData.content)}</textarea></div>
  <div class="form-group"><label>Featured Image</label><input type="file" id="image" name="image" accept="image/*" onchange="updatePreview()">${editData.image_url?`<div style="font-size:.75rem;color:var(--text2);margin-top:.25rem">Current: <a href="${editData.image_url}" target="_blank">view</a></div>`:''}</div>
  <div class="form-group"><label>Hashtags</label><input type="text" id="hashtags" name="hashtags" maxlength="100" placeholder="#blog #writing" oninput="updatePreview()" value="${escapeHtml(editData.hashtags)}"></div>
  <div class="form-group"><label>Custom Message</label><textarea id="customMessage" name="customMessage" rows="3" maxlength="280" placeholder="Override default message..." oninput="updatePreview()" style="min-height:60px;resize:vertical"></textarea></div>
  <div style="display:flex;gap:2rem;margin-bottom:1rem">
    <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer"><input type="checkbox" id="pubBluesky"> 🦋 Bluesky</label>
    <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer"><input type="checkbox" id="pubTwitter"> 𝕏 Twitter</label>
  </div>
  <div id="socialPreview" style="background:var(--surface);border-radius:8px;padding:1rem;margin-bottom:1rem;display:none">
    <div style="font-size:.7rem;text-transform:uppercase;color:var(--accent);margin-bottom:.5rem">📱 Social Preview</div>
    <div style="display:flex;gap:1rem;align-items:flex-start">
      <div id="previewImage" style="width:120px;height:80px;background:var(--border);border-radius:6px;flex-shrink:0;background-size:cover;background-position:center;display:none"></div>
      <div style="flex:1;min-width:0"><div id="previewUrl" style="font-size:.65rem;color:var(--text2);margin-bottom:.15rem">mab-myblog.nocloudware.workers.dev</div><div id="previewTitle" style="font-weight:600;font-size:.85rem;margin-bottom:.15rem">Title preview</div><div id="previewDesc" style="font-size:.75rem;color:var(--text2)">Description preview...</div></div>
    </div>
    <div id="previewMsg" style="font-size:.8rem;margin-top:.5rem;padding-top:.5rem;border-top:1px solid var(--border);color:var(--text)"></div>
  </div>
  <div id="publishStatus" style="display:none;color:var(--accent);font-size:.85rem;margin-bottom:.5rem;padding:.5rem;background:rgba(233,69,96,.1);border-radius:6px"></div>
  <button type="submit">${editSlug?'Update':'Publish'}</button>
</form></div>`;
  const editorJS = `
let token=_token;
if(token){document.getElementById('login-form').style.display='none';document.getElementById('editor-form').style.display='block'}
async function handleLogin(e){e.preventDefault();const p=document.getElementById('login-password').value;const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})});if(r.ok){const d=await r.json();token=d.token;localStorage.setItem('token',token);_token=token;document.getElementById('login-form').style.display='none';document.getElementById('editor-form').style.display='block';updateAuthUI()}else{alert('Wrong password')}}
function updatePreview(){
  const title=document.getElementById('title').value||'Title preview';const content=document.getElementById('content').value||'';const hashtags=document.getElementById('hashtags').value||'';const customMsg=document.getElementById('customMessage').value||'';const imgFile=document.getElementById('image').files[0];
  document.getElementById('previewTitle').textContent=title;document.getElementById('previewDesc').textContent=content.replace(/[#*\`>]/g,'').substring(0,150)||'Description preview...';document.getElementById('previewMsg').textContent=(customMsg||title)+' '+(hashtags||'');document.getElementById('socialPreview').style.display='block';
  if(imgFile){const url=URL.createObjectURL(imgFile);document.getElementById('previewImage').style.display='block';document.getElementById('previewImage').style.backgroundImage='url('+url+')'}else{document.getElementById('previewImage').style.display='none'}
}
async function createPost(e){e.preventDefault();const editSlug=document.getElementById('editSlug').value;const title=document.getElementById('title').value;const content=document.getElementById('content').value;const hashtags=document.getElementById('hashtags').value;const customMsg=document.getElementById('customMessage').value;const imageFile=document.getElementById('image').files[0];const pubBluesky=document.getElementById('pubBluesky').checked;const pubTwitter=document.getElementById('pubTwitter').checked;const statusEl=document.getElementById('publishStatus');const btn=document.querySelector('button[type=submit]');const fd=new FormData();fd.append('title',title);fd.append('content',content);fd.append('hashtags',hashtags);if(imageFile)fd.append('image',imageFile);const url=editSlug?'/api/posts/'+editSlug:'/api/posts';const method=editSlug?'PUT':'POST';
statusEl.style.display='block';btn.disabled=true;statusEl.textContent='Creating article...';
const r=await fetch(url,{method,headers:{'Authorization':'Bearer '+token},body:fd});if(r.ok){const d=await r.json();statusEl.textContent='Article saved!';const platforms=[];if(pubBluesky)platforms.push('bluesky');if(pubTwitter)platforms.push('twitter');
for(const p of platforms){statusEl.textContent='Publishing to '+p+'...';await fetch('/api/publish',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({postSlug:d.slug||editSlug,platforms:[p],message:customMsg||undefined})});}
statusEl.textContent='Done!';const pubUrl=editSlug?'/post/'+editSlug:(d.public_url||'/post/'+d.slug);setTimeout(()=>{window.open(pubUrl,'_blank');statusEl.style.display='none';statusEl.textContent='';btn.disabled=false;document.getElementById('title').value='';document.getElementById('content').value='';document.getElementById('hashtags').value='';document.getElementById('customMessage').value='';document.getElementById('image').value='';document.getElementById('editSlug').value='';document.getElementById('socialPreview').style.display='none';btn.textContent='Publish'},800)}else{statusEl.textContent='Error: '+(await r.json()).error;btn.disabled=false}}
`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Editor | MAB-MyBlog</title><style>:root{--bg:#0a0a0f;--surface:#1a1a2e;--border:#2a2a3e;--text:#e0e0e0;--text2:#888;--accent:#e94560;--radius:8px}body{font-family:-apple-system,sans-serif;background:var(--bg);color:var(--text);margin:0;min-height:100vh}.container{max-width:700px;margin:0 auto;padding:2rem}input,textarea{width:100%;padding:.75rem;margin:.5rem 0 1rem;background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:var(--radius);font-family:inherit;box-sizing:border-box}textarea{resize:vertical;min-height:300px;font-family:monospace;font-size:.9rem}input[type="file"]{padding:.5rem;color:var(--text2)}button{background:var(--accent);color:#fff;border:none;padding:.75rem 2rem;border-radius:var(--radius);cursor:pointer;font-size:1rem}button:disabled{opacity:.5;cursor:not-allowed}button:hover:not(:disabled){background:#ff6b6b}.form-group{margin-bottom:1rem}.form-group label{display:block;margin-bottom:.25rem;font-weight:500;font-size:.9rem;color:var(--text)}.login-form{max-width:400px;margin:4rem auto}h1{color:var(--accent)}${sb.css}</style></head><body>${sb.html}<div class="container">${content}</div><script>${sb.js}${editorJS}</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}

// ============ SCHEDULER ============
async function processSchedules(env) {
  const now = new Date().toISOString();
  const { results: due } = await env.DB.prepare(`SELECT ps.*, p.title, v.article_url, v.image_url, v.excerpt FROM publication_schedules ps JOIN posts p ON p.slug=ps.post_slug AND p.status='published' JOIN post_versions v ON v.slug=p.slug AND v.version=p.current_version WHERE ps.status='active' AND ps.next_occurrence<=? AND (ps.max_occurrences IS NULL OR ps.occurrence_count<ps.max_occurrences) ORDER BY ps.next_occurrence ASC LIMIT 5`).bind(now).all();
  for (const s of due) {
    const platforms = JSON.parse(s.platforms); const hashtags = processHashtags(s.custom_hashtags); const articleUrl = `${env.BASE_URL}/post/${s.post_slug}`; const msg = s.message_template || s.title;
    for (const p of platforms) {
      try { let r; if (p === 'bluesky') r = await publishToBluesky({ message: `${msg} ${hashtags}`.trim(), articleUrl, title: s.title, excerpt: s.excerpt, ogImage: s.image_url }, env); else if (p === 'twitter') r = await publishToTwitter(`${msg} ${hashtags}\n\n${articleUrl}`.trim(), env); if (r) await env.DB.prepare('INSERT INTO publication_history (post_slug,schedule_id,platform,platform_post_id,message_used,is_republish) VALUES (?,?,?,?,?,1)').bind(s.post_slug, s.id, r.platform, r.id, msg).run(); } catch (e) { console.error(`Schedule ${s.id} failed:`, e); }
    }
    const nc = s.occurrence_count + 1; let next = null, st = 'active'; if (s.schedule_type === 'once') st = 'completed'; else if (s.max_occurrences && nc >= s.max_occurrences) st = 'completed'; else if (s.recurrence_interval && s.recurrence_unit) next = calculateNextOccurrence(new Date(), s.recurrence_interval, s.recurrence_unit).toISOString();
    await env.DB.prepare('UPDATE publication_schedules SET occurrence_count=?,next_occurrence=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(nc, next, st, s.id).run();
  }
  const { results: recentShares } = await env.DB.prepare(`SELECT ss.*, p.created_at as post_created_at, (SELECT fetched_at FROM post_stats WHERE share_id = ss.id ORDER BY fetched_at DESC LIMIT 1) as last_fetch FROM social_shares ss JOIN posts p ON p.slug = ss.post_slug WHERE ss.status = 'published'`).all();
  for (const share of recentShares) {
    if (!shouldRefresh(share.last_fetch, share.post_created_at)) continue;
    try { let stats = null; if (share.platform === 'bluesky') stats = await fetchBlueskyStats(share.platform_post_id, env); else if (share.platform === 'twitter') stats = await fetchTwitterStats(share.platform_post_id, env); if (stats) await saveStats(share.id, stats, env); } catch (e) { console.error(`Stats refresh failed:`, e); }
  }
}

// ============ MAIN ============
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url); const path = url.pathname; const method = request.method;
    if (method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    if (path === '/.well-known/site.standard.publication') { const row = await env.DB.prepare("SELECT value FROM settings WHERE key='atproto_publication_uri'").first(); return new Response(row?.value || '', { headers: { 'Content-Type': 'text/plain' } }); }
    if (method === 'GET' && (path === '/editor' || path === '/editor/')) { const editSlug = url.searchParams.get('edit') || null; return renderEditorPage(env, editSlug); }
    if (method === 'GET' && path === '/') return renderHome(env);
    const slugMatch = path.match(/^\/post\/([a-z0-9-]+)(?:\/v(\d+))?$/);
    if (method === 'GET' && slugMatch) return renderPostPage(slugMatch[1], slugMatch[2] ? parseInt(slugMatch[2]) : null, env);
    if (method === 'GET' && path === '/api/posts') { const { results } = await env.DB.prepare(`SELECT p.slug,p.title,p.author,p.status,p.created_at,v.excerpt,v.image_url,v.word_count,v.reading_time FROM posts p JOIN post_versions v ON p.slug=v.slug AND p.current_version=v.version WHERE p.status='published' ORDER BY p.created_at DESC`).all(); return json({ posts: results }); }
    if (method === 'GET' && path.match(/^\/api\/posts\/[a-z0-9-]+$/)) { const slug = path.split('/').pop(); const post = await env.DB.prepare(`SELECT p.*,v.article_url,v.image_url,v.meta_url,v.excerpt,v.word_count,v.reading_time FROM posts p JOIN post_versions v ON p.slug=v.slug AND p.current_version=v.version WHERE p.slug=? AND p.status='published'`).bind(slug).first(); if (!post) return json({ error: 'Not found' }, 404); try { const res = await fetch(post.article_url); const { body } = parseFrontmatter(await res.text()); return json({ slug: post.slug, title: post.title, author: post.author, content: body, excerpt: post.excerpt, image_url: post.image_url, word_count: post.word_count, reading_time: post.reading_time, created_at: post.created_at, version: post.current_version }); } catch { return json({ slug: post.slug, title: post.title, excerpt: post.excerpt }); } }
    if (method === 'POST' && path === '/api/auth/login') { const { password } = await request.json(); if (password !== env.ADMIN_PASSWORD) return json({ error: 'Unauthorized' }, 401); return json({ success: true, token: await generateJWT(env) }); }
    if (method === 'GET' && path === '/api/stats/refresh') {
      const days = parseInt(url.searchParams.get('days') || '1'); const months = parseInt(url.searchParams.get('months') || '0'); const years = parseInt(url.searchParams.get('years') || '0');
      const sinceDate = new Date(); sinceDate.setDate(sinceDate.getDate() - days); sinceDate.setMonth(sinceDate.getMonth() - months); sinceDate.setFullYear(sinceDate.getFullYear() - years);
      const { results: shares } = await env.DB.prepare(`SELECT ss.* FROM social_shares ss JOIN posts p ON p.slug = ss.post_slug WHERE ss.status = 'published' AND p.created_at >= ?`).bind(sinceDate.toISOString()).all();
      let refreshed = 0;
      for (const share of shares) { try { let stats = null; if (share.platform === 'bluesky') stats = await fetchBlueskyStats(share.platform_post_id, env); else if (share.platform === 'twitter') stats = await fetchTwitterStats(share.platform_post_id, env); if (stats) { await saveStats(share.id, stats, env); refreshed++; } } catch (e) { console.error(`Stats failed:`, e); } }
      return json({ success: true, refreshed, checked: shares.length, since: sinceDate.toISOString() });
    }
    if (method === 'POST' && path === '/api/posts') { try { const { title, content, author, hashtags, tags, imageFile } = await extractPostParams(request); if (!title || !content) return json({ error: 'Title and content required' }, 400); const slug = generateSlug(title); if (await env.DB.prepare('SELECT slug FROM posts WHERE slug=?').bind(slug).first()) return json({ error: 'Already exists' }, 409); const date = new Date(), version = 1, releaseTag = `post/${slug}/v${version}`; const excerpt = getExcerpt(content), wordCount = countWords(content), readingTime = readingTimeMinutes(wordCount); const articleMd = `---\ntitle:"${title}"\nauthor:"${author}"\ndate:"${date.toISOString()}"\nslug:"${slug}"\ntags:${JSON.stringify(tags)}\n---\n\n${content}`; const metaJson = JSON.stringify({ title, author, slug, tags, excerpt, date: date.toISOString(), word_count: wordCount, reading_time: readingTime }); const assets = [{ name: 'article.md', content: articleMd, content_type: 'text/markdown' }, { name: 'meta.json', content: metaJson, content_type: 'application/json' }]; if (imageFile) assets.push({ name: 'featured.webp', content: imageFile, content_type: 'image/webp' }); const ghToken = await getEffectiveToken(env, 'GITHUB_TOKEN'); const release = await createGitHubRelease(releaseTag, title, assets, { ...env, GITHUB_TOKEN: ghToken }); const articleUrl = release.assets.find(a => a.name === 'article.md').browser_download_url; const imageUrl = release.assets.find(a => a.name === 'featured.webp')?.browser_download_url || null; await env.DB.batch([env.DB.prepare("INSERT INTO posts (slug,current_release_id,current_version,title,author,excerpt_cache,image_url_cache,status,default_hashtags) VALUES (?,?,?,?,?,?,?,'published',?)").bind(slug, release.id.toString(), version, title, author, excerpt, imageUrl, hashtags), env.DB.prepare("INSERT INTO post_versions (slug,version,release_id,release_tag,release_url,article_url,image_url,meta_url,excerpt,word_count,reading_time,change_description) VALUES (?,?,?,?,?,?,?,?,?,?,?,'Initial version')").bind(slug, version, release.id.toString(), releaseTag, release.html_url, articleUrl, imageUrl, release.assets.find(a => a.name === 'meta.json').browser_download_url, excerpt, wordCount, readingTime)]); try { await createDocumentRecord({ slug, version, title, excerpt, bodyPlain: content.replace(/[#*\`>\[\]()\n]/g, ' ').substring(0, 500), tags }, env); } catch (e) { console.error('AT Protocol document creation failed:', e); } return json({ success: true, slug, version, public_url: `${env.BASE_URL}/post/${slug}`, article_url: articleUrl, image_url: imageUrl }); } catch (e) { return json({ error: e.message }, 500); } }
    if (method === 'PUT' && path.match(/^\/api\/posts\/[a-z0-9-]+$/)) { try { const slug = path.split('/').pop(); const { title: nt, content, imageFile } = await extractPostParams(request); const post = await env.DB.prepare('SELECT * FROM posts WHERE slug=?').bind(slug).first(); if (!post) return json({ error: 'Not found' }, 404); if (!content) return json({ error: 'Content required' }, 400); const title = nt || post.title, newVersion = post.current_version + 1, releaseTag = `post/${slug}/v${newVersion}`; const excerpt = getExcerpt(content), wordCount = countWords(content), readingTime = readingTimeMinutes(wordCount); const assets = [{ name: 'article.md', content, content_type: 'text/markdown' }, { name: 'meta.json', content: JSON.stringify({ title, slug, excerpt, updated_at: new Date().toISOString(), word_count: wordCount, reading_time: readingTime }), content_type: 'application/json' }]; if (imageFile) assets.push({ name: 'featured.webp', content: imageFile, content_type: 'image/webp' }); const ghToken = await getEffectiveToken(env, 'GITHUB_TOKEN'); const release = await createGitHubRelease(releaseTag, title, assets, { ...env, GITHUB_TOKEN: ghToken }); const articleUrl = release.assets.find(a => a.name === 'article.md').browser_download_url; const imageUrl = release.assets.find(a => a.name === 'featured.webp')?.browser_download_url || post.image_url_cache; await env.DB.batch([env.DB.prepare('UPDATE posts SET current_release_id=?,current_version=?,title=?,image_url_cache=?,updated_at=CURRENT_TIMESTAMP WHERE slug=?').bind(release.id.toString(), newVersion, title, imageUrl, slug), env.DB.prepare('INSERT INTO post_versions (slug,version,release_id,release_tag,release_url,article_url,image_url,meta_url,excerpt,word_count,reading_time,change_description) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(slug, newVersion, release.id.toString(), releaseTag, release.html_url, articleUrl, imageUrl, release.assets.find(a => a.name === 'meta.json').browser_download_url, excerpt, wordCount, readingTime, `Updated to v${newVersion}`)]); try { await createDocumentRecord({ slug, version: newVersion, title, excerpt, bodyPlain: content.replace(/[#*\`>\[\]()\n]/g, ' ').substring(0, 500), tags: [] }, env); } catch (e) { console.error('AT Protocol document update failed:', e); } return json({ success: true, slug, version: newVersion }); } catch (e) { return json({ error: e.message }, 500); } }
    if (method === 'DELETE' && path.match(/^\/api\/posts\/[a-z0-9-]+$/)) { const slug = path.split('/').pop(); const post = await env.DB.prepare('SELECT * FROM posts WHERE slug=?').bind(slug).first(); if (!post) return json({ error: 'Not found' }, 404); const shares = await env.DB.prepare("SELECT * FROM social_shares WHERE post_slug=? AND status='published'").bind(slug).all(); for (const s of shares.results || []) { try { await deleteFromSocialPlatform(s.platform, s.platform_post_id, env); } catch {} await env.DB.prepare("UPDATE social_shares SET status='deleted' WHERE id=?").bind(s.id).run(); } await env.DB.batch([env.DB.prepare('INSERT INTO post_deletions (slug,last_release_id) VALUES (?,?)').bind(slug, post.current_release_id), env.DB.prepare("UPDATE posts SET status='deleted',updated_at=CURRENT_TIMESTAMP WHERE slug=?").bind(slug)]); return json({ success: true, deleted: slug }); }
    if (method === 'POST' && path === '/api/publish') { try { const { postSlug, platforms, message } = await request.json(); const post = await env.DB.prepare("SELECT p.*,v.article_url,v.image_url,v.excerpt FROM posts p JOIN post_versions v ON p.slug=v.slug AND p.current_version=v.version WHERE p.slug=? AND p.status='published'").bind(postSlug).first(); if (!post) return json({ error: 'Not found' }, 404); const articleUrl = `${env.BASE_URL}/post/${post.slug}`, results = []; for (const platform of platforms) { try { let result; if (platform === 'bluesky') result = await publishToBluesky({ message: message || post.title, articleUrl, title: post.title, excerpt: post.excerpt, ogImage: post.image_url }, env); else if (platform === 'twitter') result = await publishToTwitter(`${message || post.title}\n\n${articleUrl}`, env); if (result) { await env.DB.prepare("INSERT INTO social_shares (post_slug,platform,platform_post_id,platform_post_url,status) VALUES (?,?,?,?,'published')").bind(postSlug, result.platform, result.id, result.url || '').run(); results.push({ platform, success: true, id: result.id }); } } catch (e) { results.push({ platform, success: false, error: e.message }); } } return json({ success: results.some(r => r.success), results }); } catch (e) { return json({ error: e.message }, 500); } }
    if (method === 'DELETE' && path === '/api/publish') { try { const { postSlug, platforms } = await request.json(); const ph = platforms.map(() => '?').join(','); const shares = await env.DB.prepare(`SELECT * FROM social_shares WHERE post_slug=? AND platform IN (${ph}) AND status='published'`).bind(postSlug, ...platforms).all(); const results = []; for (const s of shares.results || []) { try { await deleteFromSocialPlatform(s.platform, s.platform_post_id, env); await env.DB.prepare("UPDATE social_shares SET status='deleted' WHERE id=?").bind(s.id).run(); results.push({ platform: s.platform, success: true }); } catch (e) { results.push({ platform: s.platform, success: false, error: e.message }); } } return json({ success: results.some(r => r.success), results }); } catch (e) { return json({ error: e.message }, 500); } }
    if (method === 'POST' && path === '/api/social/connect') { try { const { platform, credentials } = await request.json(); const handle = credentials.handle || credentials.identifier || ''; const encrypted = await encrypt(JSON.stringify(credentials), env); await env.DB.prepare('INSERT OR REPLACE INTO social_tokens (platform,handle,encrypted_payload) VALUES (?,?,?)').bind(platform, handle, encrypted).run(); if (platform === 'bluesky') { try { await createPublicationRecord(env.BASE_URL, env.BLOG_NAME, '', env); } catch {} } return json({ success: true, platform }); } catch (e) { return json({ error: e.message }, 500); } }
    if (method === 'GET' && path === '/api/social/status') { const { results } = await env.DB.prepare('SELECT platform,handle FROM social_tokens').all(); return json({ connections: results }); }
    if (method === 'GET' && path === '/api/schedule') { const { results } = await env.DB.prepare('SELECT * FROM publication_schedules ORDER BY created_at DESC').all(); return json({ schedules: results }); }
    if (method === 'POST' && path === '/api/schedule') { try { const d = await request.json(); let next = d.scheduleType === 'once' ? d.scheduledAt : calculateNextOccurrence(new Date(), d.recurrenceInterval, d.recurrenceUnit).toISOString(); const r = await env.DB.prepare('INSERT INTO publication_schedules (post_slug,name,schedule_type,platforms,message_template,custom_hashtags,scheduled_at,recurrence_interval,recurrence_unit,max_occurrences,next_occurrence) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(d.postSlug, d.name, d.scheduleType, JSON.stringify(d.platforms), d.messageTemplate||'', d.customHashtags||'', d.scheduledAt||null, d.recurrenceInterval||null, d.recurrenceUnit||null, d.maxOccurrences||null, next).run(); return json({ success: true, id: r.lastRowId }); } catch (e) { return json({ error: e.message }, 500); } }
    if (method === 'DELETE' && path.match(/^\/api\/schedule\/\d+$/)) { await env.DB.prepare("UPDATE publication_schedules SET status='cancelled' WHERE id=?").bind(path.split('/').pop()).run(); return json({ success: true }); }
    if (method === 'GET' && path === '/api/hashtags') { const { results } = await env.DB.prepare('SELECT * FROM hashtag_templates ORDER BY day_of_week').all(); return json({ hashtags: results }); }
    if (method === 'GET' && path === '/api/settings') { const { results } = await env.DB.prepare('SELECT * FROM settings').all(); const s = {}; for (const r of results) s[r.key] = r.value; return json({ settings: s }); }
    if (method === 'PUT' && path === '/api/settings') { const d = await request.json(); if (d._github_token) { await env.DB.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('_GITHUB_token_override',?)").bind(d._github_token).run(); delete d._github_token; } if (d._cf_token) { await env.DB.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('_cf_token_override',?)").bind(d._cf_token).run(); delete d._cf_token; } for (const [k, v] of Object.entries(d)) await env.DB.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').bind(k, String(v)).run(); return json({ success: true }); }
    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
  async scheduled(event, env, ctx) { await processSchedules(env); }
};