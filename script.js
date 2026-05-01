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

// ✅ Fichier individuel par compte
const USER_FILE = `account_${USER_ID}_${CLAIM_PLATFORM}_${CLAIM_EMAIL}.json`;

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

function parseProxyUrl(proxyUrl) {
    if (!proxyUrl) return null;
    proxyUrl = proxyUrl.trim();
    const isSocks = proxyUrl.startsWith('socks5://') || proxyUrl.startsWith('socks://');
    const protocol = isSocks ? 'socks5' : 'http';
    const match = proxyUrl.match(/^(socks5?:\/\/)?(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/);
    if (!match) { console.error('❌ Format HTTP invalide'); return null; }
    return {
        server: `${protocol}://${match[4]}:${match[5]}`,
        username: match[2] || null,
        password: match[3] || null
    };
}

// --- Fonctions Puppeteer (inchangées) ---
async function fillField(page, selector, value, fieldName) {
    await page.waitForSelector(selector, { timeout: 10000 });
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await delay(100);
    await page.evaluate((sel, val) => { const el = document.querySelector(sel); if (el) el.value = val; }, selector, value);
    await delay(300);
    let actual = await page.$eval(selector, el => el.value);
    if (actual !== value) {
        await page.click(selector, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        for (const char of value) await page.keyboard.type(char, { delay: 30 });
    }
}

async function humanScrollToClaim(page) {
    const coords = await page.evaluate(() => {
        const btn = document.querySelector('#process_claim_hourly_faucet');
        if (!btn) return null;
        const rect = btn.getBoundingClientRect();
        return { y: rect.y + window.scrollY };
    });
    if (!coords) throw new Error('Bouton CLAIM introuvable');
    const startY = await page.evaluate(() => window.scrollY);
    const targetY = Math.max(0, coords.y - 200);
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const currentY = startY + (targetY - startY) * t;
        await page.evaluate((y) => window.scrollTo(0, y), currentY);
        await delay(50 + Math.random() * 100);
    }
}

async function addRedDot(page, x, y) {
    await page.evaluate((x, y) => {
        const dot = document.createElement('div');
        dot.style.position = 'fixed'; dot.style.left = (x - 5) + 'px'; dot.style.top = (y - 5) + 'px';
        dot.style.width = '10px'; dot.style.height = '10px'; dot.style.borderRadius = '50%';
        dot.style.backgroundColor = 'red'; dot.style.zIndex = '99999'; dot.style.pointerEvents = 'none';
        dot.id = 'click-dot'; document.body.appendChild(dot);
        setTimeout(() => dot.remove(), 2000);
    }, x, y);
}

async function humanClickAt(page, coords) {
    await addRedDot(page, coords.x, coords.y);
    const start = await page.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const cp = { x: start.x + (Math.random() - 0.5) * 100, y: start.y + (Math.random() - 0.5) * 100 };
        const x = Math.pow(1 - t, 2) * start.x + 2 * (1 - t) * t * cp.x + Math.pow(t, 2) * coords.x;
        const y = Math.pow(1 - t, 2) * start.y + 2 * (1 - t) * t * cp.y + Math.pow(t, 2) * coords.y;
        await page.mouse.move(x, y); await delay(15);
    }
    await page.mouse.click(coords.x, coords.y);
    console.log(`🖱️ Clic à (${coords.x}, ${coords.y})`);
}

// --- Chargement / Sauvegarde d'un fichier individuel ---
async function loadAccounts() {
    try {
        const res = await octokit.repos.getContent({
            owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE, ref: GH_BRANCH
        });
        const account = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
        return [account];
    } catch (e) {
        if (e.status === 404) return [];
        throw e;
    }
}

async function saveAccounts(accounts, modifiedAccount = null) {
    const account = accounts[0];
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
            const content = Buffer.from(JSON.stringify(account, null, 2)).toString('base64');
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
                    const waitTime = 1000 + Math.random() * 4000;
                    await new Promise(r => setTimeout(r, waitTime));
                    try {
                        const res = await octokit.repos.getContent({
                            owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE, ref: GH_BRANCH
                        });
                        const latest = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
                        if (modifiedAccount) {
                            account = { ...latest, ...modifiedAccount };
                        }
                    } catch (reloadErr) {}
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

async function connectWithProxy(proxyUrl) {
    const proxyConfig = parseProxyUrl(proxyUrl);
    if (!proxyConfig) throw new Error('Proxy invalide');
    console.log(`🔄 Connexion avec proxy : ${proxyConfig.server}`);

    const options = {
        headless: false,
        turnstile: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    };

    if (proxyConfig.username && proxyConfig.password) {
        options.proxy = `${proxyConfig.server.replace('://', '://' + proxyConfig.username + ':' + proxyConfig.password + '@')}`;
    } else {
        options.proxy = proxyConfig.server;
    }

    const { browser, page } = await connect(options);
    return { browser, page };
}

async function performLoginAndCaptureCookies(account) { /* ... identique ... */ }

async function claimWithCookies(account) { /* ... identique ... */ }

// 📜 NOUVELLE FONCTION : sauvegarde de l'historique
async function saveHistory(account, success, message) {
    const historyFile = `history_${USER_ID}.json`;
    const octokit = new Octokit({ auth: GH_TOKEN });

    let bonus = 0;
    if (success && message) {
        const match = message.match(/([\d]+(\.[\d]+)?)/);
        if (match) bonus = parseFloat(match[1]) || 0;
    }

    const entry = {
        email: account.email,
        platform: account.platform,
        timestamp: Date.now(),
        success,
        message: message || '',
        bonus
    };

    try {
        let history = [];
        let sha = null;
        try {
            const res = await octokit.repos.getContent({
                owner: GH_USERNAME, repo: GH_REPO, path: historyFile, ref: GH_BRANCH
            });
            history = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
            sha = res.data.sha;
        } catch (e) {}

        history.push(entry);
        const content = Buffer.from(JSON.stringify(history, null, 2)).toString('base64');
        await octokit.repos.createOrUpdateFileContents({
            owner: GH_USERNAME, repo: GH_REPO, path: historyFile,
            message: 'Historique claim', content, branch: GH_BRANCH, sha
        });
    } catch (err) {
        console.error('❌ Erreur sauvegarde historique :', err.message);
    }
}

// --- Main (avec appel à saveHistory) ---
(async () => {
    try {
        let accounts = await loadAccounts();
        console.log(`📋 Comptes chargés : ${accounts.length}`);

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
            targetAccount.claimResult = null;
            for (const acc of accounts) {
                if (acc.password && !acc.password.includes(':')) acc.password = encrypt(acc.password);
                if (acc.cookies && typeof acc.cookies === 'object') acc.cookies = encrypt(JSON.stringify(acc.cookies));
            }
            await saveAccounts(accounts, targetAccount);
            process.exit(0);
        }

        console.log(`\n===== Traitement : ${CLAIM_EMAIL} (${CLAIM_PLATFORM}) =====`);

        if (!targetAccount.cookies || targetAccount.cookiesStatus === 'expired' || targetAccount.cookiesStatus === 'failed') {
            console.log('🍪 Tentative de login');
            try {
                const newCookies = await performLoginAndCaptureCookies(targetAccount);
                targetAccount.cookies = newCookies;
                targetAccount.cookiesStatus = 'valid';
            } catch (e) {
                targetAccount.cookiesStatus = 'failed';
                targetAccount.claimResult = `❌ ${e.message}`;
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
        let result = { success: false, message: 'Erreur inconnue', siteTimer: null };
        try {
            result = await claimWithCookies(targetAccount);
            if (!result) result = { success: false, message: 'Erreur inconnue', siteTimer: null };
        } catch (e) {
            console.error('Exception lors du claim :', e.message);
            result = { success: false, message: e.message, siteTimer: null };
        }

        console.log(`📋 Résultat du claim : success=${result.success}, message="${result.message}"`);

        if (result.success) {
            targetAccount.lastClaim = now;
            targetAccount.timer = 62;
            targetAccount.claimResult = `✅ ${result.message || 'Claim réussi'}`;
            console.log('✅ Claim réussi, timer passé à 62 min');
        } else {
            const msg = (result.message || '').toLowerCase();

            if (msg.includes('try again in 10 minutes')) {
                const deuxHeuresMs = 2 * 60 * 60 * 1000;
                targetAccount.lastClaim = now + deuxHeuresMs - ((targetAccount.timer || 60) * 60 * 1000);
                targetAccount.claimResult = `❌ ${result.message}`;
                console.log('⏰ Erreur site, prochain claim repoussé de 2 heures');
            } else if (msg.includes('aucun résultat') || msg.includes('aucune réaction') || (!result.message && !msg)) {
                if (result.siteTimer !== null && result.siteTimer > 0) {
                    targetAccount.lastClaim = now;
                    targetAccount.timer = result.siteTimer;
                    targetAccount.claimResult = `✅ (timer site) ${result.siteTimer.toFixed(1)} min`;
                    console.log(`ℹ️ Aucun message, timer site appliqué : ${result.siteTimer.toFixed(1)} min`);
                } else {
                    targetAccount.lastClaim = now;
                    targetAccount.timer = 60;
                    targetAccount.claimResult = '✅ (timer par défaut) 60 min';
                    console.log('ℹ️ Aucun message, timer par défaut 60 min');
                }
            } else {
                targetAccount.claimResult = `❌ ${result.message}`;
                console.log('❌ Échec non traité, compte laissé en l\'état');
            }
        }

        // 📜 Enregistrer dans l'historique
        await saveHistory(targetAccount, result.success, result.message || '');

        // Délai aléatoire avant sauvegarde
        const waitBeforeSave = 2000 + Math.random() * 5000;
        console.log(`⏳ Pause de ${Math.round(waitBeforeSave/1000)}s avant sauvegarde...`);
        await new Promise(r => setTimeout(r, waitBeforeSave));

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
