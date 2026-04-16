// api/accounts.js
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const GH_TOKEN = process.env.GH_TOKEN;
    const GIST_ID = process.env.GIST_ID;

    if (!GH_TOKEN || !GIST_ID) {
        return res.status(500).json({ error: 'Configuration Gist manquante' });
    }

    const headers = {
        'Authorization': `token ${GH_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
    };

    try {
        if (req.method === 'GET') {
            const resGist = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers });
            if (!resGist.ok) throw new Error(`HTTP ${resGist.status}`);
            const gist = await resGist.json();
            // Le nom du fichier dans le Gist doit être exact
            const filename = 'accounts.json';
            const content = gist.files[filename]?.content || '[]';
            return res.status(200).json(JSON.parse(content));
        } 
        else if (req.method === 'POST') {
            const accounts = req.body;
            const filename = 'accounts.json';
            const body = {
                files: {
                    [filename]: {
                        content: JSON.stringify(accounts, null, 2)
                    }
                }
            };
            const resGist = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
                method: 'PATCH',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!resGist.ok) throw new Error(`HTTP ${resGist.status}`);
            return res.status(200).json({ success: true });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
}
