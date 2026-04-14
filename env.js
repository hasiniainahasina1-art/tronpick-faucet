// api/env.js
export default function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({
        browserless: process.env.BROWSERLESS_TOKEN ? 'défini' : 'manquant',
        gh_token: process.env.GH_TOKEN ? 'défini' : 'manquant',
        gh_username: process.env.GH_USERNAME || null,
        gh_repo: process.env.GH_REPO || null,
        proxy_user: process.env.PROXY_USERNAME ? 'défini' : 'manquant',
        proxy_pass: process.env.PROXY_PASSWORD ? 'défini' : 'manquant'
    });
}
