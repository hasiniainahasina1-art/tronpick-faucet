// api/check-claim.js – VERSION PRODUCTION (avec vérification d'exécution en cours)
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
    const CLAIM_WORKFLOW_ID = 'claim.yml';

    // Fonction interne pour vérifier si un workflow est déjà en cours
    async function isWorkflowAlreadyRunning() {
        try {
            const url = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/actions/runs?status=in_progress&status=queued`;
            const response = await fetch(url, {
                headers: {
                    Authorization: `token ${GH_TOKEN}`,
                    Accept: 'application/vnd.github.v3+json'
                }
            });
            if (!response.ok) return false;
            const data = await response.json();
            return data.workflow_runs.some(run => run.name === 'Claim Tronpick Faucet');
        } catch {
            return false;
        }
    }

    try {
        // 1. Vérifier si un workflow est déjà en cours
        if (await isWorkflowAlreadyRunning()) {
            return res.json({
                status: 'ok',
                message: 'Un workflow est déjà en cours, aucun nouveau déclenchement.',
                alreadyRunning: true
            });
        }

        // 2. Lire les comptes
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

        if (accounts.length === 0) {
            return res.json({ status: 'ok', message: 'Aucun compte' });
        }

        // 3. Trouver les comptes éligibles
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

        // 4. Déclencher un workflow par compte éligible
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
                    body: JSON.stringify({ ref: GH_BRANCH })
                });

                if (dispatchResponse.ok) {
                    triggered.push(acc.email);
                }

                if (eligibleAccounts.length > 1) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            } catch (err) {
                console.error(`Erreur pour ${acc.email}:`, err.message);
            }
        }

        return res.json({
            status: 'ok',
            triggered: triggered.length,
            totalEligible: eligibleAccounts.length,
            emails: triggered
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Erreur interne' });
    }
}
