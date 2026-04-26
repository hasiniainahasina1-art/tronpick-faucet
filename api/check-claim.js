export default async function handler(req, res) {
    const SECRET = process.env.CRON_SECRET;
    const headerSecret = req.headers['x-cron-secret'];
    const querySecret = req.query.secret;
    if ((!headerSecret || headerSecret !== SECRET) && (!querySecret || querySecret !== SECRET)) {
        return res.status(403).json({ error: 'Accès refusé' });
    }

    try {
        const url = `https://api.github.com/repos/${process.env.GH_USERNAME}/${process.env.GH_REPO}/contents/${process.env.GH_FILE_PATH || 'accounts.json'}?ref=${process.env.GH_BRANCH || 'main'}`;
        const response = await fetch(url, {
            headers: { Authorization: `token ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
        });

        let accounts = [];
        if (response.ok) {
            const data = await response.json();
            const content = Buffer.from(data.content, 'base64').toString('utf8');
            accounts = JSON.parse(content);
        } else if (response.status !== 404) {
            throw new Error(`GitHub API error: ${response.status}`);
        }

        const now = Date.now();
        const debug = accounts.map(acc => ({
            email: acc.email,
            enabled: acc.enabled,
            lastClaim: acc.lastClaim,
            timer: acc.timer,
            diffMs: now - (acc.lastClaim || 0),
            intervalMs: (acc.timer || 60) * 60 * 1000,
            eligible: (acc.enabled !== false) && (now - (acc.lastClaim || 0) >= (acc.timer || 60) * 60 * 1000)
        }));

        return res.json({ now, debug });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
