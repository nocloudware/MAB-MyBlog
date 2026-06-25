const { BskyAgent } = require('@atproto/api');
const { encrypt, decrypt } = require('./crypto');

const BLUESKY_IDENTIFIER = process.env.BLUESKY_IDENTIFIER;
const BLUESKY_PASSWORD = process.env.BLUESKY_PASSWORD;

async function getBlueskyAgent() {
    const agent = new BskyAgent({ service: 'https://bsky.social' });
    await agent.login({ identifier: BLUESKY_IDENTIFIER, password: BLUESKY_PASSWORD });
    return agent;
}

async function postToBluesky(post, imageUrl) {
    const agent = await getBlueskyAgent();
    const { title, excerpt, url } = post;

    const text = `${title}\n\n${excerpt}\n\nRead more: ${url}`;

    const postRecord = {
        $type: 'app.bsky.feed.post',
        text: text,
        createdAt: new Date().toISOString(),
        embed: imageUrl ? {
            $type: 'app.bsky.embed.external',
            external: {
                uri: url,
                title: title,
                description: excerpt,
                thumb: imageUrl
            }
        } : undefined
    };

    const response = await agent.post(postRecord);
    return response;
}

async function deleteFromBluesky(postId) {
    const agent = await getBlueskyAgent();
    await agent.deletePost(postId);
}

module.exports = {
    postToBluesky,
    deleteFromBluesky
};
