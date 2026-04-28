// api/check-claim.js – VERSION FINALE
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

    try {
        // Récupérer tous les profils
        const profilesRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
            headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
        });
        if (!profilesRes.ok) throw new Error('Erreur récupération profils');
        const profiles = await profilesRes.json();

        const triggered = [];

        for (const profile of profiles) {
            const userId = profile.id;
            const filePath = `accounts_${userId}.json`;
            const fileUrl = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/contents/${filePath}?ref=${GH_BRANCH}`;

            const fileRes = await fetch(fileUrl, {
                headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
            });
            if (fileRes.status === 404) continue;
            if (!fileRes.ok) {
                console.error(`Erreur fichier ${userId}: ${fileRes.status}`);
                continue;
            }

            const fileData = await fileRes.json();
            const content = decodeURIComponent(
                Array.from(atob(fileData.content), c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
            );
            const accounts = JSON.parse(content);
            const now = Date.now();

            for (const acc of accounts) {
                // Vérifier si un claim est déjà en cours
                if (acc.pendingClaim === true) continue;
                if (acc.enabled === false) continue;
                if (acc.pendingLogout === true) continue;

                const last = acc.lastClaim || 0;
                const intervalMs = (acc.timer || 60) * 60 * 1000;
                if ((now - last) < intervalMs) continue;

                // ✅ Compte éligible et libre → poser le flag
                acc.pendingClaim = true;
                acc.pendingClaimSince = now;
                // Sauvegarde rapide pour poser le flag
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
                        inputs: { email: acc.email, platform: acc.platform, userId }
                    })
                });

                if (dispatchRes.ok) {
                    triggered.push(`${acc.email} (${acc.platform})`);
                } else {
                    console.error(`Erreur dispatch ${acc.email}: ${dispatchRes.status}`);
                    // Retirer le flag en cas d'échec
                    acc.pendingClaim = false;
                    delete acc.pendingClaimSince;
                    await updateAccountFile(userId, accounts, GH_USERNAME, GH_REPO, GH_BRANCH, GH_TOKEN);
                }
            }
        }

        return res.json({ status: 'ok', triggered: triggered.length, emails: triggered });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
}

async function updateAccountFile(userId, accounts, owner, repo, branch, token) {
    const filePath = `accounts_${userId}.json`;
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`;
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
        body: JSON.stringify({ message: 'Flag pendingClaim', content, branch, sha })
    });
}
