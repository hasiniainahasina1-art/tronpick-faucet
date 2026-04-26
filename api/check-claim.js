// api/check-claim.js – VERSION FINALE AVEC NETTOYAGE AUTO
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

    try {
        const url = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/contents/${GH_FILE_PATH}?ref=${GH_BRANCH}`;
        const response = await fetch(url, {
            headers: {
                Authorization: `token ${GH_TOKEN}`,
                Accept: 'application/vnd.github.v3+json'
            }
        });

        let accounts = [];
        let sha = null;
        if (response.ok) {
            const data = await response.json();
            sha = data.sha;
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

        // Nettoyage automatique des pendingClaim
        let cleaned = false;
        for (const acc of accounts) {
            if (acc.pendingClaim) {
                acc.pendingClaim = false;
                delete acc.pendingClaimSince;
                cleaned = true;
                console.log(`🧹 Nettoyage pendingClaim pour ${acc.email} (${acc.platform})`);
            }
        }

        if (cleaned) {
            const cleanedContent = btoa(unescape(encodeURIComponent(JSON.stringify(accounts, null, 2))));
            await fetch(url, {
                method: 'PUT',
                headers: {
                    Authorization: `token ${GH_TOKEN}`,
                    Accept: 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: 'Nettoyage automatique pendingClaim',
                    content: cleanedContent,
                    branch: GH_BRANCH,
                    sha
                })
            });
            console.log('✅ Tous les pendingClaim ont été supprimés.');
        }

        const now = Date.now();
        const eligibleAccounts = accounts.filter(acc => {
            if (acc.enabled === false) return false;
            if (acc.pendingLogout === true) return false;
            const last = acc.lastClaim || 0;
            const intervalMs = (acc.timer || 60) * 60 * 1000;
            return (now - last) >= intervalMs;
        });

        if (eligibleAccounts.length === 0) {
            return res.json({ status: 'ok', message: 'Aucun compte éligible' });
        }

        // Poser les flags
        for (const acc of eligibleAccounts) {
            const original = accounts.find(a => a.email === acc.email && a.platform === acc.platform);
            if (original) {
                original.pendingClaim = true;
                original.pendingClaimSince = now;
            }
        }

        const updatedContent = btoa(unescape(encodeURIComponent(JSON.stringify(accounts, null, 2))));
        await fetch(url, {
            method: 'PUT',
            headers: {
                Authorization: `token ${GH_TOKEN}`,
                Accept: 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message: 'Marquage pendingClaim pour comptes éligibles',
                content: updatedContent,
                branch: GH_BRANCH,
                sha
            })
        });

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
                        ref: GH_BRANCH,
                        inputs: {
                            email: acc.email,
                            platform: acc.platform
                        }
                    })
                });

                if (dispatchResponse.ok) {
                    triggered.push(`${acc.email} (${acc.platform})`);
                } else {
                    console.error(`❌ Dispatch failed for ${acc.email} (${acc.platform}): ${dispatchResponse.status}`);
                }
            } catch (err) {
                console.error(`❌ Erreur pour ${acc.email} (${acc.platform}):`, err.message);
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
