// api/check-claim.js – VERSION DIAGNOSTIC
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

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({ error: 'Configuration Supabase manquante' });
    }

    const debug = { profiles: [], accounts: [], errors: [] };

    try {
        // 1. Récupérer les utilisateurs
        const profilesResponse = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
            headers: {
                'apikey': SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
            }
        });
        if (!profilesResponse.ok) {
            debug.errors.push(`Erreur récupération profils: ${profilesResponse.status}`);
            return res.json(debug);
        }
        const profiles = await profilesResponse.json();
        debug.profiles = profiles.map(p => ({ id: p.id, email: p.email, username: p.username }));

        // 2. Parcourir chaque profil
        for (const profile of profiles) {
            const userId = profile.id;
            const filePath = `accounts_${userId}.json`;

            const url = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/contents/${filePath}?ref=${GH_BRANCH}`;
            const fileResponse = await fetch(url, {
                headers: {
                    Authorization: `token ${GH_TOKEN}`,
                    Accept: 'application/vnd.github.v3+json'
                }
            });

            if (fileResponse.status === 404) {
                debug.accounts.push({ userId, file: filePath, status: 'fichier inexistant' });
                continue;
            }
            if (!fileResponse.ok) {
                debug.errors.push(`Erreur fichier ${userId}: ${fileResponse.status}`);
                continue;
            }

            const data = await fileResponse.json();
            const content = decodeURIComponent(
                Array.from(atob(data.content), c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
            );
            const accounts = JSON.parse(content);

            const now = Date.now();
            for (const acc of accounts) {
                const last = acc.lastClaim || 0;
                const intervalMs = (acc.timer || 60) * 60 * 1000;
                const eligible = (acc.enabled !== false) && !acc.pendingLogout && !acc.pendingClaim && ((now - last) >= intervalMs);
                debug.accounts.push({
                    userId,
                    email: acc.email,
                    platform: acc.platform,
                    enabled: acc.enabled,
                    pendingLogout: acc.pendingLogout || false,
                    pendingClaim: acc.pendingClaim || false,
                    lastClaim: new Date(last).toISOString(),
                    timer: acc.timer,
                    diffMinutes: Math.round((now - last) / 60000),
                    intervalMinutes: Math.round(intervalMs / 60000),
                    eligible
                });
            }
        }

        return res.json(debug);
    } catch (error) {
        debug.errors.push(error.message);
        return res.json(debug);
    }
}
