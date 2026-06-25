const { octokit } = require('./github');
const { generateReleaseTag, generateReleaseName } = require('./utils');

const GITHUB_USER = process.env.GITHUB_USER;
const REPO_NAME = process.env.REPO_NAME;

async function createRelease(slug, version, title, content, image, meta) {
    const tagName = generateReleaseTag(slug, version);
    const releaseName = generateReleaseName(title, version);

    const releaseResponse = await octokit.rest.repos.createRelease({
        owner: GITHUB_USER,
        repo: REPO_NAME,
        tag_name: tagName,
        name: releaseName,
        body: `Version ${version} of ${title}`,
        draft: false,
        prerelease: false
    });

    const releaseId = releaseResponse.data.id;

    // Upload article.md
    await octokit.rest.repos.uploadReleaseAsset({
        owner: GITHUB_USER,
        repo: REPO_NAME,
        release_id: releaseId,
        name: 'article.md',
        data: Buffer.from(content, 'utf-8')
    });

    // Upload meta.json
    await octokit.rest.repos.uploadReleaseAsset({
        owner: GITHUB_USER,
        repo: REPO_NAME,
        release_id: releaseId,
        name: 'meta.json',
        data: Buffer.from(JSON.stringify(meta), 'utf-8')
    });

    // Upload featured.webp if exists
    if (image) {
        await octokit.rest.repos.uploadReleaseAsset({
            owner: GITHUB_USER,
            repo: REPO_NAME,
            release_id: releaseId,
            name: 'featured.webp',
            data: Buffer.from(image, 'base64')
        });
    }

    return {
        releaseId: releaseResponse.data.id,
        releaseUrl: releaseResponse.data.html_url,
        tagName: releaseResponse.data.tag_name
    };
}

async function getLatestRelease(slug) {
    const releases = await octokit.rest.repos.listReleases({
        owner: GITHUB_USER,
        repo: REPO_NAME
    });

    const postReleases = releases.data.filter(release => release.tag_name.startsWith(`${slug}-v`));
    if (postReleases.length === 0) return null;

    const latestRelease = postReleases.sort((a, b) => new Date(b.published_at) - new Date(a.published_at))[0];
    return {
        releaseId: latestRelease.id,
        releaseUrl: latestRelease.html_url,
        tagName: latestRelease.tag_name,
        version: parseInt(latestRelease.tag_name.split('-v')[1])
    };
}

async function getReleaseContent(releaseUrl) {
    const response = await fetch(releaseUrl);
    const data = await response.json();
    return data;
}

module.exports = {
    createRelease,
    getLatestRelease,
    getReleaseContent
};
