// api/auth.js
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Méthode non autorisée' });
    }

    const { email, password, confirmPassword, username, mode } = req.body || {};

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
            // Vérifier champs obligatoires
            if (!username) {
                return res.status(400).json({ error: 'Le nom d\'utilisateur est requis' });
            }
            if (password !== confirmPassword) {
                return res.status(400).json({ error: 'Les mots de passe ne correspondent pas' });
            }

            // 1. Créer l'utilisateur via l'API Admin (contourne le rate limit)
            const signupRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({
                    email,
                    password,
                    email_confirm: true,
                    user_metadata: { username }
                })
            });

            if (!signupRes.ok) {
                const errData = await signupRes.json();
                // Si l'utilisateur existe déjà, on renvoie un message clair
                if (errData.msg?.includes('already been registered')) {
                    return res.status(400).json({ error: 'Cet email est déjà utilisé.' });
                }
                return res.status(400).json({ error: errData.msg || 'Erreur lors de l\'inscription' });
            }

            const userData = await signupRes.json();
            const userId = userData.id;

            // 2. Créer le profil dans la table `profiles`
            await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
                method: 'POST',
                headers: {
                    ...headers,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                },
                body: JSON.stringify({
                    id: userId,
                    email,
                    username
                })
            });

            // 3. Authentifier l'utilisateur pour récupérer un token de session
            const tokenRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ email, password })
            });

            const tokenData = await tokenRes.json();
            if (!tokenRes.ok) {
                return res.status(500).json({ error: 'Compte créé mais impossible de générer la session.' });
            }

            return res.status(200).json({ token: tokenData.access_token });
        } 
        else if (mode === 'login') {
            const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ email, password })
            });

            const data = await response.json();

            if (!response.ok) {
                return res.status(response.status).json({ error: 'Identifiants incorrects' });
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
