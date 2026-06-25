const { postToBluesky } = require('./lib/bluesky');
const { postToTwitter } = require('./lib/twitter');
const { createAtProtoRecord } = require('./lib/atproto');
const { generateMetaData } = require('./lib/utils');

export default {
    async scheduled(event, env, ctx) {
        const now = new Date().toISOString();

        const schedules = await env.DB.prepare(
            `SELECT * FROM publication_schedules 
            WHERE status = 'active' AND next_occurrence <= ?`
        ).bind(now).all();

        for (const schedule of schedules.schedules) {
            await processSchedule(schedule, env);
        }
    }
};

async function processSchedule(schedule, env) {
    const post = await env.DB.prepare('SELECT * FROM posts WHERE slug = ?').bind(schedule.post_slug).first();
    if (!post) {
        await env.DB.prepare('UPDATE publication_schedules SET status = ? WHERE id = ?').bind('error', schedule.id).run();
        return;
    }

    const baseUrl = env.BASE_URL || 'https://mab-myblog.pages.dev';
    const meta = generateMetaData(post, baseUrl);

    const platforms = JSON.parse(schedule.platforms || '[]');
    const results = {};

    try {
        if (platforms.includes('bluesky')) {
            const result = await postToBluesky(meta, post.image_url_cache);
            results.bluesky = result;
            await recordShare(env, schedule, 'bluesky', result);
        }

        if (platforms.includes('twitter')) {
            const result = await postToTwitter(meta, post.image_url_cache);
            results.twitter = result;
            await recordShare(env, schedule, 'twitter', result);
        }

        if (platforms.includes('atproto')) {
            const result = await createAtProtoRecord(meta);
            results.atproto = result;
            await recordShare(env, schedule, 'atproto', result);
        }

        // Update schedule
        const newOccurrenceCount = schedule.occurrence_count + 1;
        let newNextOccurrence = null;

        if (schedule.schedule_type === 'recurring' && schedule.recurrence_interval && schedule.recurrence_unit) {
            const nextDate = new Date(schedule.next_occurrence);
            if (schedule.recurrence_unit === 'days') {
                nextDate.setDate(nextDate.getDate() + schedule.recurrence_interval);
            } else if (schedule.recurrence_unit === 'weeks') {
                nextDate.setDate(nextDate.getDate() + schedule.recurrence_interval * 7);
            } else if (schedule.recurrence_unit === 'months') {
                nextDate.setMonth(nextDate.getMonth() + schedule.recurrence_interval);
            }
            newNextOccurrence = nextDate.toISOString();
        }

        const isComplete = schedule.max_occurrences && newOccurrenceCount >= schedule.max_occurrences;

        await env.DB.prepare(
            `UPDATE publication_schedules SET 
            occurrence_count = ?, 
            next_occurrence = ?, 
            status = ? 
            WHERE id = ?`
        ).bind(
            newOccurrenceCount,
            newNextOccurrence,
            isComplete ? 'completed' : 'active',
            schedule.id
        ).run();

    } catch (error) {
        console.error('Schedule processing error:', error);
        await recordShare(env, schedule, 'error', { error: error.message });
    }
}

async function recordShare(env, schedule, platform, result) {
    await env.DB.prepare(
        `INSERT INTO social_shares (post_slug, platform, platform_post_id, platform_post_url, status, error_msg) 
        VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
        schedule.post_slug,
        platform,
        result.id || null,
        result.url || null,
        result.error ? 'error' : 'published',
        result.error || null
    ).run();

    await env.DB.prepare(
        `INSERT INTO publication_history (post_slug, schedule_id, platform, platform_post_id, message_used, status, is_republish) 
        VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
        schedule.post_slug,
        schedule.id,
        platform,
        result.id || null,
        JSON.stringify(result),
        result.error ? 'error' : 'success',
        schedule.occurrence_count > 0 ? 1 : 0
    ).run();
}