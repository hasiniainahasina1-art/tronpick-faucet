// api/accounts.js
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const GH_TOKEN = process.env.GH_TOKEN;
    const GH_USERNAME = process.env.GH_USERNAME;
    const GH_REPO = process.env.GH_REPO;
    const GH_BRANCH = process.env.GH_BRANCH || 'main';
    const FILE_PATH = process.env.GH_FILE_PATH || 'accounts.json';

    if (!GH_TOKEN || !GH_USERNAME || !GH_REPO) {
        return res.status(500).json({ error: 'Configuration GitHub manquante' });
    }

    const apiUrl = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/contents/${FILE_PATH}`;
    const headers = { 'Authorization': `token ${GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' };

    try {
        if (req.method === 'GET') {
            const response = await fetch(apiUrl, { headers });
            if (response.status === 404) return res.status(200).json([]);
            if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
            const data = await response.json();
            const content = Buffer.from(data.content, 'base64').toString('utf8');
            return res.status(200).json(JSON.parse(content));
        } 
        else if (req.method === 'POST') {
            const accounts = req.body;
            let sha = null;
            try {
                const getRes = await fetch(apiUrl, { headers });
                if (getRes.ok) { const data = await getRes.json(); sha = data.sha; }
            } catch (e) {}
            const content = Buffer.from(JSON.stringify(accounts, null, 2)).toString('base64');
            const body = { message: 'Mise à jour comptes', content, branch: GH_BRANCH };
            if (sha) body.sha = sha;
            const putRes = await fetch(apiUrl, {
                method: 'PUT',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!putRes.ok) throw new Error(`GitHub API error: ${putRes.status}`);
            return res.status(200).json({ success: true });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
}
