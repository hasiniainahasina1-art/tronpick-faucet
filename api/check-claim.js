// api/check-claim.js – DEBUG (aucun déclenchement)
export default async function handler(req, res) {
    const SECRET = process.env.CRON_SECRET;
    const headerSecret = req.headers['x-cron-secret'];
    const querySecret = req.query.secret;
    if ((!headerSecret || headerSecret !== SECRET) && (!querySecret || querySecret !== SECRET)) {
        return res.status(403).json({ error: 'Accès refusé' });
    }

    const GH_TOKEN = process.env.GH_TOKEN;
    const GH_USERNAME = process.env.GH_USERNAME;
    const GH_REPO = process.env.GH_REPO;
    const GH_BRANCH = process.env.GH_BRANCH || 'main';
    const GH_FILE_PATH = process.env.GH_FILE_PATH || 'accounts.json';

    try {
        const url = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/contents/${GH_FILE_PATH}?ref=${GH_BRANCH}`;
        const response = await fetch(url, {
            headers: {
                Authorization: `token ${GH_TOKEN}`,
                Accept: 'application/vnd.github.v3+json'
            }
        });

        let accounts = [];
        if (response.ok) {
            const data = await response.json();
            const content = decodeURIComponent(
                Array.from(atob(data.content), c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
            );
            accounts = JSON.parse(content);
        } else if (response.status !== 404) {
            throw new Error(`GitHub API error: ${response.status}`);
        }

        const now = Date.now();
        const debug = accounts.map(acc => ({
            email: acc.email,
            enabled: acc.enabled,
            pendingLogout: acc.pendingLogout || false,
            pendingClaim: acc.pendingClaim || false,
            lastClaim: acc.lastClaim,
            timer: acc.timer,
            diffMs: now - (acc.lastClaim || 0),
            intervalMs: (acc.timer || 60) * 60 * 1000,
            eligible: (acc.enabled !== false) && !acc.pendingLogout && !acc.pendingClaim && (now - (acc.lastClaim || 0) >= (acc.timer || 60) * 60 * 1000)
        }));

        return res.json({ now, debug });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
}
