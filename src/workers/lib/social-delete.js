const { postToBluesky, deleteFromBluesky } = require('./bluesky');
const { postToTwitter, deleteFromTwitter } = require('./twitter');
const { createAtProtoRecord, deleteAtProtoRecord } = require('./atproto');

async function deleteFromSocialMedia(platform, postId) {
    switch (platform) {
        case 'bluesky':
            await deleteFromBluesky(postId);
            break;
        case 'twitter':
            await deleteFromTwitter(postId);
            break;
        case 'atproto':
            await deleteAtProtoRecord(postId);
            break;
        default:
            throw new Error(`Unsupported platform: ${platform}`);
    }
}

module.exports = {
    deleteFromSocialMedia
};
