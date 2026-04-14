// api/env.js
export default function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    res.status(200).json({
        browserless: process.env.BROWSERLESS_TOKEN ? 'défini' : 'manquant',
        proxy_user: process.env.PROXY_USERNAME ? 'défini' : 'manquant',
        proxy_pass: process.env.PROXY_PASSWORD ? 'défini' : 'manquant',
        gh_token: process.env.GH_TOKEN ? 'défini' : 'manquant',
        gh_username: process.env.GH_USERNAME || null,
        gh_repo: process.env.GH_REPO || null
    });
}
