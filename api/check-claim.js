// api/check-claim.js – DIAGNOSTIC FINAL (avec correction atob)
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

    const vars = {
        GH_USERNAME,
        GH_REPO,
        GH_BRANCH,
        GH_FILE_PATH,
        hasToken: !!GH_TOKEN
    };

    const url = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/contents/${GH_FILE_PATH}?ref=${GH_BRANCH}`;

    try {
        const response = await fetch(url, {
            headers: {
                Authorization: `token ${GH_TOKEN}`,
                Accept: 'application/vnd.github.v3+json'
            }
        });

        const status = response.status;
        const responseText = await response.text();

        if (!response.ok) {
            return res.status(500).json({
                error: 'GitHub API error',
                status,
                responseText: responseText.substring(0, 500),
                url,
                vars
            });
        }

        const data = JSON.parse(responseText);

        // Utiliser atob pour décoder le base64 (plus compatible que Buffer)
        const content = decodeURIComponent(
            Array.from(atob(data.content), c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
        );

        const accounts = JSON.parse(content);

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

        return res.json({ now, debug, vars, accountCount: accounts.length });

    } catch (error) {
        return res.status(500).json({ error: error.message, stack: error.stack });
    }
}
