// api/check-claim.js – VERSION FINALE (anti double déclenchement)
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
    const GH_FILE_PATH = process.env.GH_FILE_PATH || 'accounts.json';
    const CLAIM_WORKFLOW_ID = 'claim.yml';

    try {
        const url = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/contents/${GH_FILE_PATH}?ref=${GH_BRANCH}`;
        let response = await fetch(url, {
            headers: {
                Authorization: `token ${GH_TOKEN}`,
                Accept: 'application/vnd.github.v3+json'
            }
        });

        let accounts = [];
        let sha = null;
        if (response.ok) {
            const data = await response.json();
            sha = data.sha;
            const content = decodeURIComponent(
                Array.from(atob(data.content), c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
            );
            accounts = JSON.parse(content);
        } else if (response.status !== 404) {
            throw new Error(`GitHub API error: ${response.status}`);
        }

        if (accounts.length === 0) {
            return res.json({ status: 'ok', message: 'Aucun compte' });
        }

        // 1. Nettoyage des pendingClaim expirés (plus de 10 min)
        const now = Date.now();
        let cleaned = false;
        for (const acc of accounts) {
            if (acc.pendingClaim === true && acc.pendingClaimSince) {
                if (now - acc.pendingClaimSince > 10 * 60 * 1000) {
                    acc.pendingClaim = false;
                    delete acc.pendingClaimSince;
                    cleaned = true;
                    console.log(`🧹 Nettoyage pendingClaim pour ${acc.email} (${acc.platform})`);
                }
            }
        }

        if (cleaned) {
            // Sauvegarde avec réessais en cas de conflit
            await saveWithRetry(url, GH_TOKEN, accounts, sha, GH_BRANCH, 'Nettoyage automatique pendingClaim');
        }

        // 2. Filtrer les comptes éligibles (en ignorant ceux marqués depuis moins de 3 min)
        const eligibleAccounts = accounts.filter(acc => {
            if (acc.enabled === false) return false;
            if (acc.pendingLogout === true) return false;
            if (acc.pendingClaim === true) {
                // Si le flag a été posé il y a moins de 3 minutes, on le considère toujours "en cours"
                const pendingDuration = acc.pendingClaimSince ? now - acc.pendingClaimSince : 0;
                if (pendingDuration < 3 * 60 * 1000) {
                    console.log(`⏭️ Ignoré (claim en cours depuis ${Math.round(pendingDuration / 1000)}s) : ${acc.email} (${acc.platform})`);
                    return false;
                }
                // Sinon, le flag est trop vieux, on le nettoiera et on pourra le retraiter
                console.log(`🔄 Flag pendingClaim trop ancien pour ${acc.email} (${acc.platform}), il sera réévalué.`);
            }
            const last = acc.lastClaim || 0;
            const intervalMs = (acc.timer || 60) * 60 * 1000;
            return (now - last) >= intervalMs;
        });

        if (eligibleAccounts.length === 0) {
            return res.json({ status: 'ok', message: 'Aucun compte éligible' });
        }

        // 3. Poser les flags pendingClaim + timestamp (sauvegarde robuste)
        for (const acc of eligibleAccounts) {
            const original = accounts.find(a => a.email === acc.email && a.platform === acc.platform);
            if (original) {
                original.pendingClaim = true;
                original.pendingClaimSince = now;
            }
        }

        // Sauvegarde avec réessais
        const saved = await saveWithRetry(url, GH_TOKEN, accounts, sha, GH_BRANCH, 'Marquage pendingClaim');
        if (!saved) {
            // Si la sauvegarde échoue, on annule tout pour ne pas dispatcher sans flag
            console.error('❌ Impossible de sauvegarder les flags, annulation des dispatchs.');
            return res.status(500).json({ error: 'Impossible de sauvegarder les flags' });
        }

        // 4. Lancer un workflow par compte éligible
        const dispatchUrl = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/actions/workflows/${CLAIM_WORKFLOW_ID}/dispatches`;
        const triggered = [];

        for (const acc of eligibleAccounts) {
            try {
                const dispatchResponse = await fetch(dispatchUrl, {
                    method: 'POST',
                    headers: {
                        Authorization: `token ${GH_TOKEN}`,
                        Accept: 'application/vnd.github.v3+json',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        ref: GH_BRANCH,
                        inputs: {
                            email: acc.email,
                            platform: acc.platform
                        }
                    })
                });

                if (dispatchResponse.ok) {
                    triggered.push(`${acc.email} (${acc.platform})`);
                } else {
                    console.error(`❌ Dispatch failed for ${acc.email} (${acc.platform}): ${dispatchResponse.status}`);
                }
            } catch (err) {
                console.error(`❌ Erreur pour ${acc.email} (${acc.platform}):`, err.message);
            }
        }

        return res.json({
            status: 'ok',
            triggered: triggered.length,
            totalEligible: eligibleAccounts.length,
            emails: triggered
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Erreur interne' });
    }
}

// 🔄 Fonction de sauvegarde avec réessais (appelée pour les flags)
async function saveWithRetry(url, token, accounts, currentSha, branch, message) {
    const maxRetries = 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const content = btoa(unescape(encodeURIComponent(JSON.stringify(accounts, null, 2))));
            const updateResponse = await fetch(url, {
                method: 'PUT',
                headers: {
                    Authorization: `token ${token}`,
                    Accept: 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message,
                    content,
                    branch,
                    sha: currentSha
                })
            });

            if (updateResponse.ok) {
                const data = await updateResponse.json();
                // Mettre à jour le sha pour les prochaines opérations
                currentSha = data.content?.sha;
                return true;
            } else if (updateResponse.status === 409) {
                console.warn(`⚠️ Conflit (409) lors de la sauvegarde – tentative ${attempt}/${maxRetries}`);
                // Recharger le fichier pour obtenir le nouveau sha et fusionner
                const res = await fetch(url, {
                    headers: {
                        Authorization: `token ${token}`,
                        Accept: 'application/vnd.github.v3+json'
                    }
                });
                if (res.ok) {
                    const data = await res.json();
                    const latest = JSON.parse(decodeURIComponent(
                        Array.from(atob(data.content), c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
                    ));
                    // On repart de la version fraîche pour les prochains essais,
                    // mais on garde nos modifications locales (les nouveaux flags)
                    // en les appliquant par-dessus cette version fraîche.
                    for (const acc of accounts) {
                        const idx = latest.findIndex(a => a.email === acc.email && a.platform === acc.platform);
                        if (idx !== -1) {
                            latest[idx] = acc;
                        } else {
                            latest.push(acc);
                        }
                    }
                    accounts = latest;
                    currentSha = data.sha;
                } else {
                    console.error('❌ Impossible de recharger après conflit');
                }
                // Attendre avant de réessayer
                await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
            } else {
                console.error(`❌ Erreur lors de la sauvegarde : ${updateResponse.status}`);
                return false;
            }
        } catch (e) {
            console.error(`❌ Exception lors de la sauvegarde : ${e.message}`);
            if (attempt < maxRetries) await new Promise(r => setTimeout(r, 1000));
        }
    }
    return false;
}
