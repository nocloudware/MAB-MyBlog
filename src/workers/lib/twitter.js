const { TwitterApi } = require('twitter-api-v2');
const { encrypt, decrypt } = require('./crypto');

const TWITTER_API_KEY = process.env.TWITTER_API_KEY;
const TWITTER_API_SECRET = process.env.TWITTER_API_SECRET;
const TWITTER_ACCESS_TOKEN = process.env.TWITTER_ACCESS_TOKEN;
const TWITTER_ACCESS_SECRET = process.env.TWITTER_ACCESS_SECRET;

async function getTwitterClient() {
    return new TwitterApi({
        appKey: TWITTER_API_KEY,
        appSecret: TWITTER_API_SECRET,
        accessToken: TWITTER_ACCESS_TOKEN,
        accessSecret: TWITTER_ACCESS_SECRET
    });
}

async function postToTwitter(post, imageUrl) {
    const client = await getTwitterClient();
    const { title, excerpt, url } = post;

    const text = `${title}\n\n${excerpt}\n\nRead more: ${url}`;

    let mediaId;
    if (imageUrl) {
        const mediaResponse = await client.v1.uploadMedia(imageUrl);
        mediaId = mediaResponse.media_id_string;
    }

    const tweet = await client.v2.tweet(text, {
        media: mediaId ? { media_ids: [mediaId] } : undefined
    });

    return tweet;
}

async function deleteFromTwitter(tweetId) {
    const client = await getTwitterClient();
    await client.v2.deleteTweet(tweetId);
}

module.exports = {
    postToTwitter,
    deleteFromTwitter
};
