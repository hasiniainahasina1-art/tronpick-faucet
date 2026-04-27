// api/auth.js
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Méthode non autorisée' });
    }

    const { email, password, confirmPassword, mode } = req.body || {};

    if (!email || !password) {
        return res.status(400).json({ error: 'Email et mot de passe requis' });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({ error: 'Configuration serveur manquante' });
    }

    const headers = {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json'
    };

    try {
        if (mode === 'signup') {
            // Vérifier que les deux mots de passe correspondent
            if (password !== confirmPassword) {
                return res.status(400).json({ error: 'Les mots de passe ne correspondent pas' });
            }

            // Créer l'utilisateur via l'API Supabase Auth (service_role)
            const response = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ email, password })
            });

            const data = await response.json();

            if (!response.ok) {
                return res.status(response.status).json({ error: data.msg || data.error || 'Erreur lors de l\'inscription' });
            }

            // L'utilisateur est créé, on renvoie le token de session
            return res.status(200).json({ token: data.access_token });
        } 
        else if (mode === 'login') {
            // Connexion : échanger email/password contre un token
            const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ email, password })
            });

            const data = await response.json();

            if (!response.ok) {
                return res.status(response.status).json({ error: data.error_description || data.error || 'Identifiants incorrects' });
            }

            return res.status(200).json({ token: data.access_token });
        }
        else {
            return res.status(400).json({ error: 'Mode invalide' });
        }
    } catch (error) {
        console.error('Erreur API auth :', error);
        return res.status(500).json({ error: 'Erreur interne du serveur' });
    }
}
