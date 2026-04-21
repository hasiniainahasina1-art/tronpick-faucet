// api/github.js
export default async function handler(req, res) {
  // Autoriser uniquement les méthodes nécessaires
  const allowedMethods = ['GET', 'POST', 'PUT'];
  if (!allowedMethods.includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Récupérer le chemin de l'API GitHub (ex: /repos/owner/repo/contents/accounts.json)
  const { path } = req.query;
  if (!path) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }

  const token = process.env.GH_TOKEN;
  if (!token) {
    console.error('GH_TOKEN not set in environment');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const apiUrl = `https://api.github.com${path}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json'
  };

  try {
    const fetchOptions = {
      method: req.method,
      headers,
    };
    if (req.method !== 'GET' && req.body) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(apiUrl, fetchOptions);
    const data = await response.json();

    // Retourner le même status et les données
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
