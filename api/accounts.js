// api/accounts.js
export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Vérification des variables d'environnement
    const GH_TOKEN = process.env.GH_TOKEN;
    const GH_USERNAME = process.env.GH_USERNAME;
    const GH_REPO = process.env.GH_REPO;
    const GH_BRANCH = process.env.GH_BRANCH || 'main';
    const FILE_PATH = process.env.GH_FILE_PATH || 'accounts.json';

    if (!GH_TOKEN || !GH_USERNAME || !GH_REPO) {
        console.error('❌ Variables GitHub manquantes');
        return res.status(500).json({ error: 'Configuration serveur incomplète' });
    }

    const apiUrl = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/contents/${FILE_PATH}`;
    const headers = {
        'Authorization': `token ${GH_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
    };

    try {
        if (req.method === 'GET') {
            const response = await fetch(apiUrl, { headers });
            
            // Si le fichier n'existe pas (404), on retourne un tableau vide
            if (response.status === 404) {
                return res.status(200).json([]);
            }
            
            if (!response.ok) {
                const errorText = await response.text();
                console.error('GitHub GET error:', response.status, errorText);
                throw new Error(`GitHub API error: ${response.status}`);
            }
            
            const data = await response.json();
            const content = Buffer.from(data.content, 'base64').toString('utf8');
            return res.status(200).json(JSON.parse(content));
        } 
        else if (req.method === 'POST' || req.method === 'PUT') {
            const accounts = req.body;
            
            // Récupérer le SHA si le fichier existe
            let sha = null;
            try {
                const getRes = await fetch(apiUrl, { headers });
                if (getRes.ok) {
                    const data = await getRes.json();
                    sha = data.sha;
                }
            } catch (e) {
                // Ignorer, le fichier n'existe peut-être pas
            }
            
            const content = Buffer.from(JSON.stringify(accounts, null, 2)).toString('base64');
            const body = {
                message: 'Mise à jour des comptes via dashboard',
                content,
                branch: GH_BRANCH
            };
            if (sha) body.sha = sha;
            
            const putRes = await fetch(apiUrl, {
                method: 'PUT',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            
            if (!putRes.ok) {
                const errorText = await putRes.text();
                console.error('GitHub PUT error:', putRes.status, errorText);
                throw new Error(`GitHub API error: ${putRes.status}`);
            }
            
            return res.status(200).json({ success: true });
        } 
        else {
            return res.status(405).json({ error: 'Méthode non autorisée' });
        }
    } catch (error) {
        console.error('API accounts error:', error);
        return res.status(500).json({ error: error.message });
    }
}
