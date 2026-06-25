const { Octokit } = require('@octokit/rest');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USER = process.env.GITHUB_USER;
const REPO_NAME = process.env.REPO_NAME;

if (!GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN environment variable is not set');
}
if (!GITHUB_USER) {
    throw new Error('GITHUB_USER environment variable is not set');
}
if (!REPO_NAME) {
    throw new Error('REPO_NAME environment variable is not set');
}

const octokit = new Octokit({
    auth: GITHUB_TOKEN
});

async function verifyGitHubToken() {
    try {
        await octokit.rest.users.getAuthenticated();
        return true;
    } catch (error) {
        console.error('GitHub token verification failed:', error);
        return false;
    }
}

async function createRepositoryIfNotExists() {
    try {
        await octokit.rest.repos.get({
            owner: GITHUB_USER,
            repo: REPO_NAME
        });
    } catch (error) {
        if (error.status === 404) {
            await octokit.rest.repos.createForAuthenticatedUser({
                name: REPO_NAME,
                private: true
            });
        } else {
            throw error;
        }
    }
}

module.exports = {
    verifyGitHubToken,
    createRepositoryIfNotExists,
    octokit
};
