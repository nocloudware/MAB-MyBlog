const { BskyAgent, AtpAgent } = require('@atproto/api');

const AT_PROTO_IDENTIFIER = process.env.AT_PROTO_IDENTIFIER;
const AT_PROTO_PASSWORD = process.env.AT_PROTO_PASSWORD;

async function getAtProtoAgent() {
    const agent = new AtpAgent({ service: 'https://bsky.social' });
    await agent.login({ identifier: AT_PROTO_IDENTIFIER, password: AT_PROTO_PASSWORD });
    return agent;
}

async function createAtProtoRecord(post) {
    const agent = await getAtProtoAgent();
    const { title, excerpt, url } = post;

    const record = {
        $type: 'app.bsky.feed.post',
        text: `${title}\n\n${excerpt}\n\nRead more: ${url}`,
        createdAt: new Date().toISOString()
    };

    const response = await agent.createRecord({
        repo: agent.session.did,
        collection: 'app.bsky.feed.post',
        record: record
    });

    return response;
}

async function deleteAtProtoRecord(recordUri) {
    const agent = await getAtProtoAgent();
    await agent.deleteRecord({
        repo: agent.session.did,
        collection: 'app.bsky.feed.post',
        rkey: recordUri.split('/').pop()
    });
}

module.exports = {
    createAtProtoRecord,
    deleteAtProtoRecord
};
