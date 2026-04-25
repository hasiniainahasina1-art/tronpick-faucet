// /api/check-claim.js
export default async function handler(req, res) {
    // Sécurité : clé secrète partagée avec le cron-job externe
    const SECRET = process.env.CRON_SECRET;
    if (!SECRET || req.headers['x-cron-secret'] !== SECRET) {
        return res.status(403).json({ error: 'Accès refusé' });
    }

    const GH_TOKEN = process.env.GH_TOKEN;
    const GH_USERNAME = process.env.GH_USERNAME;
    const GH_REPO = process.env.GH_REPO;
    const GH_BRANCH = process.env.GH_BRANCH || 'main';
    const GH_FILE_PATH = process.env.GH_FILE_PATH || 'accounts.json';
    const CLAIM_WORKFLOW_ID = 'claim.yml';

    try {
        // 1. Récupérer la liste des comptes depuis GitHub
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
            const content = Buffer.from(data.content, 'base64').toString('utf8');
            accounts = JSON.parse(content);
        } else if (response.status !== 404) {
            throw new Error(`GitHub API error: ${response.status}`);
        }

        if (accounts.length === 0) {
            return res.json({ status: 'ok', message: 'Aucun compte' });
        }

        // 2. Trouver TOUS les comptes activés et éligibles
        const now = Date.now();
        const eligibleAccounts = accounts.filter(acc => {
            if (acc.enabled === false) return false;
            const last = acc.lastClaim || 0;
            const intervalMs = (acc.timer || 60) * 60 * 1000;
            return (now - last) >= intervalMs;
        });

        if (eligibleAccounts.length === 0) {
            return res.json({ status: 'ok', message: 'Aucun compte éligible' });
        }

        console.log(`🎯 ${eligibleAccounts.length} compte(s) éligible(s) trouvé(s)`);

        // 3. Déclencher un workflow pour CHAQUE compte éligible
        const dispatchUrl = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/actions/workflows/${CLAIM_WORKFLOW_ID}/dispatches`;
        const triggered = [];

        for (const acc of eligibleAccounts) {
            try {
                const dispatchResponse = await fetch(dispatchUrl, {
                    method: 'POST',
                    headers: {
                        Authorization: `token ${GH_TOKEN}`,
                        Accept: 'application/vnd.github.v3+json',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        ref: GH_BRANCH
                    })
                });

                if (dispatchResponse.ok) {
                    triggered.push(acc.email);
                    console.log(`✅ Workflow déclenché pour ${acc.email}`);
                } else {
                    const errorText = await dispatchResponse.text();
                    console.error(`❌ Échec pour ${acc.email}: ${dispatchResponse.status} ${errorText}`);
                }

                // Petit délai pour ne pas surcharger l'API GitHub
                if (eligibleAccounts.length > 1) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            } catch (err) {
                console.error(`❌ Erreur pour ${acc.email}:`, err.message);
            }
        }

        return res.json({
            status: 'ok',
            triggered: triggered.length,
            totalEligible: eligibleAccounts.length,
            emails: triggered
        });

    } catch (error) {
        console.error('Erreur:', error);
        return res.status(500).json({ error: 'Erreur interne' });
    }
}
