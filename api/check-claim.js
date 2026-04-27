// api/check-claim.js – version multi-utilisateurs
export default async function handler(req, res) {
    const SECRET = process.env.CRON_SECRET;
    // vérification du secret…

    const GH_TOKEN = process.env.GH_TOKEN;
    const GH_USERNAME = process.env.GH_USERNAME;
    const GH_REPO = process.env.GH_REPO;
    const GH_BRANCH = process.env.GH_BRANCH || 'main';
    const CLAIM_WORKFLOW_ID = 'claim.yml';
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    try {
        // 1. Récupérer la liste des utilisateurs depuis Supabase
        const profilesResponse = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
            headers: {
                'apikey': SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
            }
        });
        if (!profilesResponse.ok) throw new Error('Impossible de récupérer les utilisateurs');
        const profiles = await profilesResponse.json();

        const triggered = [];
        for (const profile of profiles) {
            const userId = profile.id;
            const filePath = `accounts_${userId}.json`;
            // Lire le fichier de l'utilisateur
            const url = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/contents/${filePath}?ref=${GH_BRANCH}`;
            const response = await fetch(url, {
                headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
            });
            if (response.status === 404) continue; // pas de fichier, on passe
            if (!response.ok) {
                console.error(`Erreur pour ${userId}: ${response.status}`);
                continue;
            }
            const data = await response.json();
            const content = decodeURIComponent(
                Array.from(atob(data.content), c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
            );
            const accounts = JSON.parse(content);

            // Filtrer les comptes éligibles
            const now = Date.now();
            for (const acc of accounts) {
                if (acc.enabled === false || acc.pendingLogout || acc.pendingClaim) continue;
                const last = acc.lastClaim || 0;
                const intervalMs = (acc.timer || 60) * 60 * 1000;
                if ((now - last) >= intervalMs) {
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
                    }
                }
            }
        }

        return res.json({ status: 'ok', triggered: triggered.length, emails: triggered });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
}
