export function slugify(text) {
    return text
        .toString()
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^\w\-]+/g, '')
        .replace(/\-\-+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '');
}

export function generateExcerpt(markdown, maxLength = 160) {
    const plainText = markdown.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    return plainText.length > maxLength ? plainText.substring(0, maxLength) + '...' : plainText;
}

export function calculateReadingTime(text) {
    const wordsPerMinute = 200;
    const wordCount = text.split(/\s+/).length;
    return Math.ceil(wordCount / wordsPerMinute);
}

export function formatDate(date) {
    return new Date(date).toISOString().split('T')[0];
}

export function generateReleaseTag(slug, version) {
    return `${slug}-v${version}`;
}

export function generateReleaseName(title, version) {
    return `${title} (v${version})`;
}

export function getCurrentDateTime() {
    return new Date().toISOString();
}

export function getDayOfWeek() {
    return new Date().getDay();
}

export function getHashtagTemplate(dayOfWeek) {
    const templates = {
        0: '#Sunday #Reading',
        1: '#Monday #NewWeek #Motivation',
        2: '#Tuesday #Coffee',
        3: '#Wednesday #KeepGoing',
        4: '#Thursday #AlmostThere',
        5: '#Friday #Weekend',
        6: '#Saturday #Relax #Reading'
    };
    return templates[dayOfWeek] || '';
}

export function validatePostData(data) {
    if (!data.title || typeof data.title !== 'string') {
        throw new Error('Title is required and must be a string');
    }
    if (!data.content || typeof data.content !== 'string') {
        throw new Error('Content is required and must be a string');
    }
    if (data.image && typeof data.image !== 'string') {
        throw new Error('Image must be a string');
    }
    if (data.status && !['draft', 'published', 'archived'].includes(data.status)) {
        throw new Error('Invalid status');
    }
    return true;
}

export function generateMetaData(post, baseUrl) {
    const meta = {
        title: post.title,
        author: post.author || 'Author',
        date: formatDate(post.created_at),
        excerpt: post.excerpt_cache,
        image: post.image_url_cache ? `${baseUrl}${post.image_url_cache}` : null,
        url: `${baseUrl}/post/${post.slug}`,
        version: post.current_version,
        readingTime: calculateReadingTime(post.content || ''),
        wordCount: post.word_count || 0
    };
    return meta;
}
