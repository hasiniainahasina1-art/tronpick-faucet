// api/trigger.js
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

    const hookUrl = process.env.RENDER_DEPLOY_HOOK;
    if (!hookUrl) {
        return res.status(500).json({ error: 'RENDER_DEPLOY_HOOK manquant' });
    }

    try {
        const response = await fetch(hookUrl, { method: 'POST' });
        if (!response.ok) {
            throw new Error(`Render API error: ${response.status}`);
        }
        res.status(200).json({ success: true, message: 'Script Render déclenché' });
    } catch (error) {
        console.error('Erreur trigger:', error);
        res.status(500).json({ error: error.message });
    }
}
