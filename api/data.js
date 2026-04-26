// api/data.js
export default async function handler(req, res) {
    const GH_TOKEN = process.env.GH_TOKEN;
    const ghPath = req.query.path;
    if (!ghPath) return res.status(400).json({ error: 'Missing path parameter' });

    const url = `https://api.github.com${ghPath}`;
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
