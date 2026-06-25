const { Router } = require('itty-router');
const { verifyGitHubToken, createRepositoryIfNotExists } = require('./lib/github');
const { createRelease, getLatestRelease } = require('./lib/releases');
const { markdownToHtml, generateOgTags, generateHtmlTemplate } = require('./lib/markdown');
const { postToBluesky } = require('./lib/bluesky');
const { postToTwitter } = require('./lib/twitter');
const { createAtProtoRecord } = require('./lib/atproto');
const { deleteFromSocialMedia } = require('./lib/social-delete');
const { slugify, generateExcerpt, calculateReadingTime, validatePostData, generateMetaData } = require('./lib/utils');

const router = Router();

// Middleware
async function authenticate(request) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    const token = authHeader.split(' ')[1];
    if (token !== process.env.ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }
}

// Routes
router.post('/api/posts', authenticate, async (request, env) => {
    try {
        const data = await request.json();
        validatePostData(data);

        const slug = slugify(data.title);
        const excerpt = generateExcerpt(data.content);
        const readingTime = calculateReadingTime(data.content);

        const meta = generateMetaData({
            ...data,
            slug,
            excerpt_cache: excerpt,
            word_count: data.content.split(/\s+/).length,
            reading_time: readingTime
        }, process.env.BASE_URL);

        const release = await createRelease(slug, 1, data.title, data.content, data.image, meta);

        const post = {
            slug,
            current_release_id: release.releaseId,
            current_version: 1,
            title: data.title,
            author: data.author || 'Author',
            excerpt_cache: excerpt,
            image_url_cache: data.image ? `${process.env.BASE_URL}/post/${slug}/image` : null,
            status: data.status || 'published',
            default_hashtags: data.default_hashtags || '',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        await env.DB.prepare(
            `INSERT INTO posts (slug, current_release_id, current_version, title, author, excerpt_cache, image_url_cache, status, default_hashtags, created_at, updated_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
            post.slug,
            post.current_release_id,
            post.current_version,
            post.title,
            post.author,
            post.excerpt_cache,
            post.image_url_cache,
            post.status,
            post.default_hashtags,
            post.created_at,
            post.updated_at
        ).run();

        return new Response(JSON.stringify({ success: true, slug }), { status: 201 });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400 });
    }
});

router.get('/api/posts', async (request, env) => {
    const posts = await env.DB.prepare('SELECT * FROM posts WHERE status = ? ORDER BY created_at DESC').bind('published').all();
    return new Response(JSON.stringify({ posts }), {
        headers: { 'Content-Type': 'application/json' }
    });
});

router.get('/api/posts/:slug', async (request, env) => {
    const { slug } = request.params;
    const post = await env.DB.prepare('SELECT * FROM posts WHERE slug = ?').bind(slug).first();
    if (!post) {
        return new Response(JSON.stringify({ error: 'Post not found' }), { status: 404 });
    }
    return new Response(JSON.stringify({ post }), {
        headers: { 'Content-Type': 'application/json' }
    });
});

router.put('/api/posts/:slug', authenticate, async (request, env) => {
    try {
        const { slug } = request.params;
        const data = await request.json();
        validatePostData(data);

        const post = await env.DB.prepare('SELECT * FROM posts WHERE slug = ?').bind(slug).first();
        if (!post) {
            return new Response(JSON.stringify({ error: 'Post not found' }), { status: 404 });
        }

        const newVersion = post.current_version + 1;
        const excerpt = generateExcerpt(data.content);
        const readingTime = calculateReadingTime(data.content);

        const meta = generateMetaData({
            ...data,
            slug,
            excerpt_cache: excerpt,
            word_count: data.content.split(/\s+/).length,
            reading_time: readingTime
        }, process.env.BASE_URL);

        const release = await createRelease(slug, newVersion, data.title, data.content, data.image, meta);

        await env.DB.prepare(
            `UPDATE posts SET 
            current_release_id = ?, 
            current_version = ?, 
            title = ?, 
            author = ?, 
            excerpt_cache = ?, 
            image_url_cache = ?, 
            status = ?, 
            default_hashtags = ?, 
            updated_at = ? 
            WHERE slug = ?`
        ).bind(
            release.releaseId,
            newVersion,
            data.title,
            data.author || 'Author',
            excerpt,
            data.image ? `${process.env.BASE_URL}/post/${slug}/image` : null,
            data.status || 'published',
            data.default_hashtags || '',
            new Date().toISOString(),
            slug
        ).run();

        return new Response(JSON.stringify({ success: true, slug, version: newVersion }), { status: 200 });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400 });
    }
});

router.delete('/api/posts/:slug', authenticate, async (request, env) => {
    try {
        const { slug } = request.params;
        const post = await env.DB.prepare('SELECT * FROM posts WHERE slug = ?').bind(slug).first();
        if (!post) {
            return new Response(JSON.stringify({ error: 'Post not found' }), { status: 404 });
        }

        await env.DB.prepare('INSERT INTO post_deletions (slug, reason, last_release_id) VALUES (?, ?, ?)').bind(
            slug,
            'User deleted',
            post.current_release_id
        ).run();

        await env.DB.prepare('DELETE FROM posts WHERE slug = ?').bind(slug).run();

        return new Response(JSON.stringify({ success: true }), { status: 200 });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400 });
    }
});

router.post('/api/publish', authenticate, async (request, env) => {
    try {
        const { slug, platforms } = await request.json();
        const post = await env.DB.prepare('SELECT * FROM posts WHERE slug = ?').bind(slug).first();
        if (!post) {
            return new Response(JSON.stringify({ error: 'Post not found' }), { status: 404 });
        }

        const meta = generateMetaData(post, process.env.BASE_URL);
        const results = {};

        if (platforms.includes('bluesky')) {
            const blueskyResult = await postToBluesky(meta, post.image_url_cache);
            results.bluesky = blueskyResult;
        }

        if (platforms.includes('twitter')) {
            const twitterResult = await postToTwitter(meta, post.image_url_cache);
            results.twitter = twitterResult;
        }

        if (platforms.includes('atproto')) {
            const atprotoResult = await createAtProtoRecord(meta);
            results.atproto = atprotoResult;
        }

        return new Response(JSON.stringify({ success: true, results }), { status: 200 });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400 });
    }
});

router.delete('/api/publish', authenticate, async (request, env) => {
    try {
        const { slug, platforms, postIds } = await request.json();
        const post = await env.DB.prepare('SELECT * FROM posts WHERE slug = ?').bind(slug).first();
        if (!post) {
            return new Response(JSON.stringify({ error: 'Post not found' }), { status: 404 });
        }

        for (const platform of platforms) {
            if (postIds[platform]) {
                await deleteFromSocialMedia(platform, postIds[platform]);
            }
        }

        return new Response(JSON.stringify({ success: true }), { status: 200 });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400 });
    }
});

// 404 for everything else
router.all('*', () => new Response('Not Found.', { status: 404 }));

export default {
    fetch: router.handle
};
