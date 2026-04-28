const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GH_TOKEN = process.env.GH_TOKEN;
const GH_USERNAME = process.env.GH_USERNAME;
const GH_REPO = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const USER_ID = process.env.USER_ID;
const CLAIM_EMAIL = process.env.CLAIM_EMAIL;
const CLAIM_PLATFORM = process.env.CLAIM_PLATFORM;
const CRYPTO_SECRET = process.env.CRYPTO_SECRET;

if (!GH_TOKEN || !GH_USERNAME || !GH_REPO || !USER_ID || !CLAIM_EMAIL || !CLAIM_PLATFORM) {
    console.error('❌ Variables manquantes');
    process.exit(1);
}
if (!CRYPTO_SECRET) {
    console.error('❌ CRYPTO_SECRET manquant');
    process.exit(1);
}

const KEY = crypto.createHash('sha256').update(CRYPTO_SECRET).digest();
function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}
function decrypt(encryptedText) {
    const parts = encryptedText.split(':');
    if (parts.length !== 2) return encryptedText;
    try {
        const iv = Buffer.from(parts[0], 'hex');
        const encrypted = parts[1];
        const decipher = crypto.createDecipheriv('aes-256-cbc', KEY, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) { return encryptedText; }
}

const USER_FILE = `accounts_${USER_ID}.json`;

const octokit = new Octokit({ auth: GH_TOKEN });

const JP_PROXY_LIST = (process.env.JP_PROXY_LIST || '').split(',').filter(p => p.trim() !== '');
if (JP_PROXY_LIST.length === 0) {
    console.error('❌ JP_PROXY_LIST doit contenir au moins 1 proxy');
    process.exit(1);
}
const PRIMARY_PROXY = JP_PROXY_LIST[0];
console.log(`🌐 Proxy unique : ${PRIMARY_PROXY}`);

const screenshotsDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

const TURNSTILE_LOGIN_COORDS = { x: 640, y: 615 };
const TURNSTILE_FAUCET_COORDS = { x: 400, y: 158 };
const CLAIM_COORDS = { x: 400, y: 223 };
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseProxyUrl(proxyUrl) { /* ... inchangé */ }

// --- Fonctions Puppeteer (inchangées) ---
async function fillField(page, selector, value, fieldName) { /* ... */ }
async function humanScrollToClaim(page) { /* ... */ }
async function addRedDot(page, x, y) { /* ... */ }
async function humanClickAt(page, coords) { /* ... */ }

async function loadAccounts() {
    try {
        const res = await octokit.repos.getContent({
            owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE, ref: GH_BRANCH
        });
        return JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
    } catch (e) {
        if (e.status === 404) return [];
        throw e;
    }
}

// ✅ NOUVELLE VERSION ROBUSTE avec fusion intelligente
async function saveAccounts(accounts, modifiedAccount = null) {
    const maxRetries = 30;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            let sha = null;
            try {
                const res = await octokit.repos.getContent({
                    owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE, ref: GH_BRANCH
                });
                sha = res.data.sha;
            } catch (e) {}

            const content = Buffer.from(JSON.stringify(accounts, null, 2)).toString('base64');
            await octokit.repos.createOrUpdateFileContents({
                owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE,
                message: 'Mise à jour automatique', content, branch: GH_BRANCH, sha
            });
            console.log(`💾 Sauvegarde réussie (tentative ${attempt})`);
            return;
        } catch (e) {
            if (e.status === 409) {
                console.warn(`⚠️ Conflit 409 – tentative ${attempt}/${maxRetries}`);
                if (attempt < maxRetries) {
                    // Délai aléatoire entre 1 et 5 secondes
                    const waitTime = 1000 + Math.random() * 4000;
                    await new Promise(r => setTimeout(r, waitTime));
                    try {
                        const res = await octokit.repos.getContent({
                            owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE, ref: GH_BRANCH
                        });
                        const latest = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
                        if (modifiedAccount) {
                            const idx = latest.findIndex(a => a.email === modifiedAccount.email && a.platform === modifiedAccount.platform);
                            if (idx !== -1) {
                                // Fusionner les propriétés de modifiedAccount dans l'objet existant
                                latest[idx] = { ...latest[idx], ...modifiedAccount };
                            } else {
                                latest.push(modifiedAccount);
                            }
                        }
                        accounts = latest; // repartir de la version fraîche pour la prochaine tentative
                    } catch (reloadErr) {
                        console.error('❌ Échec rechargement après conflit:', reloadErr);
                    }
                } else {
                    console.error('❌ Trop de conflits, abandon.');
                    throw e;
                }
            } else {
                throw e;
            }
        }
    }
    throw new Error('Échec sauvegarde après plusieurs tentatives');
}

async function connectWithProxy(proxyUrl) { /* ... inchangé */ }

async function performLoginAndCaptureCookies(account) { /* ... inchangé */ }

async function claimWithCookies(account) {
    // ... (identique à la version précédente, avec return { success, message })
}

// --- Main ---
(async () => {
    try {
        let accounts = await loadAccounts();
        console.log(`📋 Comptes chargés : ${accounts.length}`);

        // Déchiffrer les champs sensibles
        for (const acc of accounts) {
            if (acc.password) acc.password = decrypt(acc.password);
            if (typeof acc.cookies === 'string' && acc.cookies) {
                try { acc.cookies = JSON.parse(decrypt(acc.cookies)); } catch {}
            }
        }

        const targetAccount = accounts.find(acc =>
            acc.email === CLAIM_EMAIL &&
            acc.platform === CLAIM_PLATFORM &&
            acc.enabled !== false
        );
        if (!targetAccount) {
            console.error('❌ Compte introuvable ou désactivé');
            process.exit(1);
        }

        const now = Date.now();
        const lastClaim = targetAccount.lastClaim || 0;
        const intervalMs = (targetAccount.timer || 60) * 60 * 1000;
        if ((now - lastClaim) < intervalMs) {
            console.log('⏳ Pas encore éligible');
            targetAccount.pendingClaim = false;
            targetAccount.claimResult = null;
            // Rechiffrer
            for (const acc of accounts) {
                if (acc.password && !acc.password.includes(':')) acc.password = encrypt(acc.password);
                if (acc.cookies && typeof acc.cookies === 'object') acc.cookies = encrypt(JSON.stringify(acc.cookies));
            }
            await saveAccounts(accounts, targetAccount);
            process.exit(0);
        }

        console.log(`\n===== Traitement : ${CLAIM_EMAIL} (${CLAIM_PLATFORM}) =====`);

        // Login si nécessaire
        if (!targetAccount.cookies || targetAccount.cookiesStatus === 'expired' || targetAccount.cookiesStatus === 'failed') {
            console.log('🍪 Tentative de login');
            try {
                const newCookies = await performLoginAndCaptureCookies(targetAccount);
                targetAccount.cookies = newCookies;
                targetAccount.cookiesStatus = 'valid';
            } catch (e) {
                targetAccount.cookiesStatus = 'failed';
                targetAccount.claimResult = `❌ ${e.message}`;
                targetAccount.pendingClaim = false;
                console.log(`❌ Échec login : ${e.message}`);
                for (const acc of accounts) {
                    if (acc.password && !acc.password.includes(':')) acc.password = encrypt(acc.password);
                    if (acc.cookies && typeof acc.cookies === 'object') acc.cookies = encrypt(JSON.stringify(acc.cookies));
                }
                await saveAccounts(accounts, targetAccount);
                process.exit(1);
            }
        }

        console.log('🚀 Claim éligible');
        let result = { success: false, message: 'Erreur inconnue' };
        try {
            result = await claimWithCookies(targetAccount);
            if (!result) result = { success: false, message: 'Erreur inconnue (résultat vide)' };
        } catch (e) {
            console.error('Exception lors du claim :', e.message);
            result = { success: false, message: e.message };
        }

        if (result.success) {
            targetAccount.lastClaim = now;
            if (targetAccount.timer !== 60) {
                console.log('🕒 Timer passé à 60 min');
                targetAccount.timer = 60;
            }
            targetAccount.claimResult = `✅ ${result.message || 'Claim réussi'}`;
            console.log('✅ Claim réussi');
        } else {
            targetAccount.claimResult = `❌ ${result.message}`;
            console.log('❌ Claim échoué');
            if (result.message && result.message.includes('try again in 10 minutes')) {
                const deuxHeuresMs = 2 * 60 * 60 * 1000;
                targetAccount.lastClaim = now + deuxHeuresMs - ((targetAccount.timer || 60) * 60 * 1000);
                console.log('⏰ Prochain claim repoussé de 2 heures');
            }
        }

        // ✅ Délai aléatoire avant sauvegarde pour éviter les collisions
        const waitBeforeSave = 2000 + Math.random() * 5000;
        console.log(`⏳ Pause de ${Math.round(waitBeforeSave/1000)}s avant sauvegarde...`);
        await new Promise(r => setTimeout(r, waitBeforeSave));

        targetAccount.pendingClaim = false;

        // Rechiffrer
        for (const acc of accounts) {
            if (acc.password && !acc.password.includes(':')) acc.password = encrypt(acc.password);
            if (acc.cookies && typeof acc.cookies === 'object') acc.cookies = encrypt(JSON.stringify(acc.cookies));
        }
        await saveAccounts(accounts, targetAccount);
        console.log('💾 Sauvegarde terminée');
        process.exit(0);
    } catch (e) {
        console.error('Erreur fatale:', e);
        process.exit(1);
    }
})();
