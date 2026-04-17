// api/check-and-trigger.js
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const GH_TOKEN = process.env.GH_WORKFLOW_TOKEN;
    const GH_USERNAME = process.env.GH_USERNAME;
    const GH_REPO = process.env.GH_REPO;

    if (!GH_TOKEN || !GH_USERNAME || !GH_REPO) {
        return res.status(500).json({ error: 'Configuration GitHub manquante' });
    }

    try {
        // 1. Lire accounts.json depuis GitHub
        const accountsRes = await fetch(
            `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/contents/accounts.json`,
            { headers: { 'Authorization': `token ${GH_TOKEN}` } }
        );
        if (!accountsRes.ok) {
            return res.status(200).json({ triggered: false, reason: 'Fichier accounts.json inaccessible' });
        }

        const accountsData = await accountsRes.json();
        const accounts = JSON.parse(Buffer.from(accountsData.content, 'base64').toString('utf8'));

        // 2. Vérifier si au moins un compte est éligible
        const now = Date.now();
        const eligible = accounts.filter(acc => {
            if (!acc.enabled || !acc.cookies || acc.cookiesStatus !== 'valid') return false;
            const last = acc.lastClaim || 0;
            return (now - last) >= (acc.timer || 60) * 60 * 1000;
        });

        if (eligible.length === 0) {
            return res.status(200).json({ triggered: false, reason: 'Aucun compte éligible' });
        }

        // 3. Déclencher le workflow GitHub Actions
        const triggerRes = await fetch(
            `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/actions/workflows/claim.yml/dispatches`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `token ${GH_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ ref: 'main' })
            }
        );
        if (!triggerRes.ok) {
            throw new Error(`GitHub API error: ${triggerRes.status}`);
        }

        res.status(200).json({ triggered: true, eligibleCount: eligible.length });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
}
