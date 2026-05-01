// api/data.js
export default async function handler(req, res) {
    const GH_TOKEN = process.env.GH_TOKEN;
    const GH_USERNAME = process.env.GH_USERNAME;
    const GH_REPO = process.env.GH_REPO;
    const GH_BRANCH = process.env.GH_BRANCH || 'main';

    const userId = req.query.userId;
    const platform = req.query.platform;
    const email = req.query.email;

    // Construction du chemin individuel
    let filePath;
    if (userId && platform && email) {
        filePath = `account_${userId}_${platform}_${email}.json`;
    } else if (userId) {
        // Pour lister tous les comptes d'un utilisateur (dashboard)
        filePath = null; // on utilisera une autre méthode
    } else {
        return res.status(400).json({ error: 'Paramètres manquants' });
    }

    const url = filePath
        ? `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/contents/${filePath}?ref=${GH_BRANCH}`
        : `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/contents/?ref=${GH_BRANCH}`; // pour lister

    const options = {
        method: req.method,
        headers: {
            Authorization: `token ${GH_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
        }
    };

    if (req.method === 'PUT' || req.method === 'POST') {
        options.body = JSON.stringify(req.body);
    }

    try {
        if (req.method === 'GET' && !filePath) {
            // Listage des fichiers du répertoire pour un utilisateur
            const listUrl = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/contents/?ref=${GH_BRANCH}`;
            const listRes = await fetch(listUrl, { headers: options.headers });
            if (!listRes.ok) throw new Error(`Listage échoué : ${listRes.status}`);
            const files = await listRes.json();
            // Filtrer les fichiers commençant par "account_{userId}_"
            const userFiles = files.filter(f => f.name.startsWith(`account_${userId}_`));
            return res.status(200).json(userFiles);
        }

        const response = await fetch(url, options);
        const status = response.status;
        if (status === 204) return res.status(204).end();
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || `HTTP ${status}`);
        return res.status(status).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
