export async function createGitHubRelease(tagName, name, assets, env) {
  const { GITHUB_USER, REPO_NAME, GITHUB_TOKEN } = env;
  const base = `https://api.github.com/repos/${GITHUB_USER}/${REPO_NAME}`;
  const auth = { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'MAB-MyBlog' };

  let release;
  const createRes = await fetch(`${base}/releases`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tagName, name, body: `Article: ${name}`, draft: false, prerelease: false })
  });

  if (!createRes.ok) {
    const err = await createRes.json();
    if (err.errors?.some(e => e.code === 'already_exists')) {
      const existing = await fetch(`${base}/releases/tags/${tagName}`, { headers: auth });
      if (existing.ok) {
        release = await existing.json();
        for (const a of release.assets) {
          await fetch(`${base}/releases/assets/${a.id}`, { method: 'DELETE', headers: auth });
        }
      } else throw new Error('Failed to get existing release');
    } else throw new Error(`Release failed: ${JSON.stringify(err)}`);
  } else {
    release = await createRes.json();
  }

  for (const asset of assets) {
    const uploadUrl = release.upload_url.replace('{?name,label}', `?name=${encodeURIComponent(asset.name)}`);
    const body = typeof asset.content === 'string' ? asset.content : asset.content;
    await fetch(uploadUrl, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': asset.content_type },
      body
    });
  }

  const final = await fetch(release.url, { headers: auth });
  return final.json();
}