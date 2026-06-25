const { marked } = require('marked');

function markdownToHtml(markdown) {
    return marked(markdown);
}

function generateOgTags(meta, baseUrl) {
    return `
        <meta property="og:title" content="${meta.title}" />
        <meta property="og:description" content="${meta.excerpt}" />
        <meta property="og:type" content="article" />
        <meta property="og:url" content="${meta.url}" />
        ${meta.image ? `<meta property="og:image" content="${meta.image}" />` : ''}
        <meta property="og:site_name" content="${process.env.BLOG_NAME}" />
        <meta property="og:locale" content="${process.env.BLOG_LANG}" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="${meta.title}" />
        <meta name="twitter:description" content="${meta.excerpt}" />
        ${meta.image ? `<meta name="twitter:image" content="${meta.image}" />` : ''}
    `;
}

function generateHtmlTemplate(title, content, ogTags) {
    return `
    <!DOCTYPE html>
    <html lang="${process.env.BLOG_LANG}">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${title}</title>
        ${ogTags}
    </head>
    <body>
        <article>
            ${content}
        </article>
    </body>
    </html>
    `;
}

module.exports = {
    markdownToHtml,
    generateOgTags,
    generateHtmlTemplate
};
