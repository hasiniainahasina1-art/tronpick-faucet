// api/check-claim.js – VERSION DE PRODUCTION
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
    const CLAIM_WORKFLOW_ID = 'claim.yml';

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({ error: 'Configuration Supabase manquante' });
    }

    try {
        // 1. Récupérer la liste des utilisateurs
        const profilesResponse = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
            headers: {
                'apikey': SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
            }
        });
        if (!profilesResponse.ok) {
            console.error('Erreur récupération profils:', profilesResponse.status);
            return res.status(500).json({ error: 'Impossible de récupérer les utilisateurs' });
        }
        const profiles = await profilesResponse.json();

        const triggered = [];

        for (const profile of profiles) {
            const userId = profile.id;
            const filePath = `accounts_${userId}.json`;

            // Lire le fichier de l'utilisateur
            const url = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/contents/${filePath}?ref=${GH_BRANCH}`;
            const response = await fetch(url, {
                headers: {
                    Authorization: `token ${GH_TOKEN}`,
                    Accept: 'application/vnd.github.v3+json'
                }
            });

            if (response.status === 404) continue;
            if (!response.ok) {
                console.error(`Erreur lecture fichier ${userId}: ${response.status}`);
                continue;
            }

            const data = await response.json();
            const content = decodeURIComponent(
                Array.from(atob(data.content), c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
            );
            const accounts = JSON.parse(content);

            const now = Date.now();

            // Nettoyer les pendingClaim expirés (plus de 10 minutes)
            let cleaned = false;
            for (const acc of accounts) {
                if (acc.pendingClaim && acc.pendingClaimSince && (now - acc.pendingClaimSince > 10 * 60 * 1000)) {
                    acc.pendingClaim = false;
                    delete acc.pendingClaimSince;
                    cleaned = true;
                }
            }
            if (cleaned) {
                await updateAccountFile(userId, accounts, GH_USERNAME, GH_REPO, GH_BRANCH, GH_TOKEN);
                console.log(`🧹 PendingClaim nettoyé pour ${userId}`);
            }

            // Filtrer les comptes éligibles
            const eligibleAccounts = accounts.filter(acc => {
                if (acc.enabled === false) return false;
                if (acc.pendingLogout === true) return false;
                if (acc.pendingClaim === true) return false;
                const last = acc.lastClaim || 0;
                const intervalMs = (acc.timer || 60) * 60 * 1000;
                return (now - last) >= intervalMs;
            });

            for (const acc of eligibleAccounts) {
                // Marquer le compte avec pendingClaim
                acc.pendingClaim = true;
                acc.pendingClaimSince = now;
                await updateAccountFile(userId, accounts, GH_USERNAME, GH_REPO, GH_BRANCH, GH_TOKEN);

                // Déclencher le workflow
                const dispatchUrl = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/actions/workflows/${CLAIM_WORKFLOW_ID}/dispatches`;
                const dispatchRes = await fetch(dispatchUrl, {
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
                            platform: acc.platform,
                            userId: userId
                        }
                    })
                });

                if (dispatchRes.ok) {
                    triggered.push(`${acc.email} (${acc.platform}) [${userId}]`);
                } else {
                    console.error(`Erreur dispatch pour ${acc.email}: ${dispatchRes.status}`);
                    // En cas d'échec, retirer le flag
                    acc.pendingClaim = false;
                    delete acc.pendingClaimSince;
                    await updateAccountFile(userId, accounts, GH_USERNAME, GH_REPO, GH_BRANCH, GH_TOKEN);
                }
            }
        }

        return res.json({ status: 'ok', triggered: triggered.length, emails: triggered });
    } catch (error) {
        console.error('Erreur dans check-claim:', error);
        return res.status(500).json({ error: error.message });
    }
}

// Fonction de sauvegarde d'un fichier utilisateur
async function updateAccountFile(userId, accounts, owner, repo, branch, token) {
    const filePath = `accounts_${userId}.json`;
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`;
    try {
        // Récupérer le sha actuel
        const getRes = await fetch(url, {
            headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' }
        });
        if (!getRes.ok) return;
        const data = await getRes.json();
        const sha = data.sha;

        const content = btoa(unescape(encodeURIComponent(JSON.stringify(accounts, null, 2))));
        await fetch(url, {
            method: 'PUT',
            headers: {
                Authorization: `token ${token}`,
                Accept: 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message: 'Mise à jour pendingClaim',
                content,
                branch,
                sha
            })
        });
    } catch (e) {
        console.error('Erreur mise à jour pendingClaim:', e.message);
    }
}
