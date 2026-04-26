// api/check-claim.js – VERSION PARALLÈLE AVEC NETTOYAGE AUTOMATIQUE
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
        // 1. Lire les comptes
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

        // 2. 🧹 Nettoyage automatique des flags pendingClaim expirés (>10 min)
        const now = Date.now();
        const MAX_PENDING_MS = 10 * 60 * 1000;
        let cleaned = false;

        for (const acc of accounts) {
            if (acc.pendingClaim === true && acc.pendingClaimSince) {
                if (now - acc.pendingClaimSince > MAX_PENDING_MS) {
                    acc.pendingClaim = false;
                    delete acc.pendingClaimSince;
                    cleaned = true;
                    console.log(`🧹 Flag pendingClaim expiré supprimé pour ${acc.email}`);
                }
            }
        }

        // Sauvegarder le nettoyage si nécessaire
        if (cleaned) {
            const updatedContent = btoa(unescape(encodeURIComponent(JSON.stringify(accounts, null, 2))));
            await fetch(url, {
                method: 'PUT',
                headers: {
                    Authorization: `token ${GH_TOKEN}`,
                    Accept: 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: 'Nettoyage automatique pendingClaim expirés',
                    content: updatedContent,
                    branch: GH_BRANCH,
                    sha
                })
            });
            console.log('✅ Fichier nettoyé avec succès.');
        }

        // 3. Filtrer les comptes éligibles (hors ceux en déconnexion ou avec pendingClaim actif)
        const eligibleAccounts = accounts.filter(acc => {
            if (acc.enabled === false) return false;
            if (acc.pendingLogout === true) return false;
            if (acc.pendingClaim === true) {
                console.log(`⏭️ Ignoré (claim déjà en cours) : ${acc.email}`);
                return false;
            }
            const last = acc.lastClaim || 0;
            const intervalMs = (acc.timer || 60) * 60 * 1000;
            return (now - last) >= intervalMs;
        });

        if (eligibleAccounts.length === 0) {
            return res.json({ status: 'ok', message: 'Aucun compte éligible' });
        }

        // 4. Poser le flag pendingClaim + pendingClaimSince pour chaque compte éligible
        for (const acc of eligibleAccounts) {
            const original = accounts.find(a => a.email === acc.email && a.platform === acc.platform);
            if (original) {
                original.pendingClaim = true;
                original.pendingClaimSince = now;   // horodatage pour le nettoyage
            }
        }
        // Sauvegarder les flags
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

        // 5. Lancer un workflow par compte éligible
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
                        inputs: { email: acc.email }
                    })
                });

                if (dispatchResponse.ok) {
                    triggered.push(acc.email);
                } else {
                    console.error(`❌ Dispatch failed for ${acc.email}: ${dispatchResponse.status}`);
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
        console.error(error);
        return res.status(500).json({ error: 'Erreur interne' });
    }
}
