const { markdownToHtml, generateOgTags, generateHtmlTemplate } = require('./lib/markdown');
const { getLatestRelease } = require('./lib/releases');
const { generateMetaData, formatDate } = require('./lib/utils');

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        if (path === '/') {
            return await renderHomePage(request, env);
        }

        if (path.startsWith('/post/')) {
            const slug = path.split('/post/')[1];
            return await renderPost(request, env, slug);
        }

        return new Response('Not Found', { status: 404 });
    }
};

async function renderHomePage(request, env) {
    const posts = await env.DB.prepare('SELECT * FROM posts WHERE status = ? ORDER BY created_at DESC').bind('published').all();

    const html = `
    <!DOCTYPE html>
    <html lang="${env.BLOG_LANG || 'en'}">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${env.BLOG_NAME || 'My Blog'}</title>
        <meta name="description" content="${env.BLOG_DESCRIPTION || 'An autonomous personal blog'}">
        <link rel="stylesheet" href="/assets/css/style.css">
    </head>
    <body>
        <header>
            <h1>${env.BLOG_NAME || 'My Blog'}</h1>
            <p>${env.BLOG_DESCRIPTION || 'An autonomous personal blog'}</p>
        </header>
        <main>
            ${posts.posts.map(post => `
                <article>
                    <h2><a href="/post/${post.slug}">${post.title}</a></h2>
                    <p>${post.excerpt_cache}</p>
                    <time>${formatDate(post.created_at)}</time>
                </article>
            `).join('')}
        </main>
    </body>
    </html>`;

    return new Response(html, {
        headers: {
            'Content-Type': 'text/html',
            'Cache-Control': 'public, max-age=300'
        }
    });
}

async function renderPost(request, env, slug) {
    const post = await env.DB.prepare('SELECT * FROM posts WHERE slug = ? AND status = ?').bind(slug, 'published').first();
    if (!post) {
        return new Response('Post not found', { status: 404 });
    }

    const release = await getLatestRelease(slug);
    if (!release) {
        return new Response('Post content not found', { status: 404 });
    }

    const baseUrl = env.BASE_URL || 'https://mab-myblog.pages.dev';
    const meta = generateMetaData(post, baseUrl);
    const ogTags = generateOgTags(meta, baseUrl);

    // Fetch article content from GitHub release
    const articleUrl = `${release.releaseUrl}/assets/article.md`;
    const response = await fetch(articleUrl);
    const markdown = await response.text();
    const htmlContent = markdownToHtml(markdown);

    const html = generateHtmlTemplate(post.title, htmlContent, ogTags);

    return new Response(html, {
        headers: {
            'Content-Type': 'text/html',
            'Cache-Control': 'public, max-age=600'
        }
    });
}