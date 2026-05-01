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
async function fillField(page, selector, value, fieldName) { /* ... */ }
async function humanScrollToClaim(page) { /* ... */ }
async function addRedDot(page, x, y) { /* ... */ }
async function humanClickAt(page, coords) { /* ... */ }

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

async function saveAccounts(accounts, modifiedAccount = null) { /* ... */ }

async function connectWithProxy(proxyUrl) { /* ... */ }

async function performLoginAndCaptureCookies(account) { /* ... */ }

// ✅ Nouvelle version robuste de claimWithCookies
async function claimWithCookies(account) {
    const { email, cookies, platform } = account;
    console.log(`🍪 Claim pour ${email} sur ${platform} via cookies`);
    const siteUrls = {
        tronpick: 'https://tronpick.io/faucet.php',
        litepick: 'https://litepick.io/faucet.php',
        dogepick: 'https://dogepick.io/faucet.php',
        solpick: 'https://solpick.io/faucet.php',
        bnbpick: 'https://bnbpick.io/faucet.php'
    };
    const faucetUrl = siteUrls[platform] || 'https://tronpick.io/faucet.php';

    let browser;
    let attempt = 0;
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
        attempt++;
        try {
            console.log(`🔄 Tentative ${attempt}/${maxAttempts}`);
            const { browser: br, page } = await connectWithProxy(PRIMARY_PROXY);
            browser = br;
            await page.setCookie(...cookies);
            console.log('🌐 Navigation vers faucet...');
            await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 90000 });
            await delay(5000);
            if (page.url().includes('login.php')) throw new Error('Cookies expirés');

            console.log('⏳ Attente de 5 secondes...');
            await delay(5000);
            console.log('🔄 Actualisation de la page faucet...');
            await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
            await page.screenshot({ path: path.join(screenshotsDir, `01_after_reload_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

            console.log('⏳ Attente de 20 secondes...');
            await delay(20000);
            await page.screenshot({ path: path.join(screenshotsDir, `02_after_wait_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

            console.log('🔄 Scroll vers le bouton CLAIM...');
            await humanScrollToClaim(page);
            await delay(2000);
            await page.screenshot({ path: path.join(screenshotsDir, `03_turnstile_visible_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

            console.log('🖱️ Premier clic sur Turnstile faucet');
            await humanClickAt(page, TURNSTILE_FAUCET_COORDS);
            await page.screenshot({ path: path.join(screenshotsDir, `04_after_first_click_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

            console.log('⏳ Attente de 10 secondes...');
            await delay(10000);

            console.log('🖱️ Second clic sur Turnstile faucet');
            await humanClickAt(page, TURNSTILE_FAUCET_COORDS);
            await page.screenshot({ path: path.join(screenshotsDir, `05_after_second_click_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

            console.log('⏳ Attente de 10 secondes...');
            await delay(10000);

            console.log('⏳ Attente de 10 secondes avant le clic sur CLAIM...');
            await delay(10000);
            await page.screenshot({ path: path.join(screenshotsDir, `06_before_claim_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

            console.log('🖱️ Clic sur CLAIM');
            await humanClickAt(page, CLAIM_COORDS);
            await page.waitForNetworkIdle({ timeout: 20000 }).catch(() => {});
            await delay(5000);
            await page.screenshot({ path: path.join(screenshotsDir, `07_after_claim_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

            // Récupération des messages et de l'état du bouton
            const messages = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('[class*="toast"], [class*="alert"], [role="alert"], .alert, .message, .notification'))
                    .map(el => el.textContent.trim()).filter(t => t);
            });
            const btnDisabled = await page.evaluate(() => {
                const btn = document.querySelector('#process_claim_hourly_faucet');
                return btn ? btn.disabled : false;
            });

            let nextTimerMinutes = null;
            try {
                nextTimerMinutes = await page.evaluate(() => {
                    const timerEl = document.querySelector('#next_claim_timer, .countdown, [id*="timer"], [class*="timer"]');
                    if (timerEl) {
                        const txt = timerEl.textContent.trim();
                        const hMatch = txt.match(/(\d+)\s*h/i);
                        const mMatch = txt.match(/(\d+)\s*m/i);
                        if (hMatch || mMatch) {
                            const hours = hMatch ? parseInt(hMatch[1]) : 0;
                            const minutes = mMatch ? parseInt(mMatch[1]) : 0;
                            return hours * 60 + minutes;
                        }
                        const colonMatch = txt.match(/(\d+):(\d+)/);
                        if (colonMatch) {
                            return parseInt(colonMatch[1]) + parseInt(colonMatch[2]) / 60;
                        }
                    }
                    return null;
                });
            } catch (e) {}

            const success = btnDisabled || messages.some(m => /success|claimed|reward|sent|received|thanks/i.test(m));
            const resultMessage = messages[0] || (btnDisabled ? 'Bouton désactivé (succès présumé)' : 'Aucune réaction');
            console.log(`📢 Messages détectés : ${messages.join(' | ')}`);
            console.log(`🔘 Bouton désactivé : ${btnDisabled}`);
            if (nextTimerMinutes !== null) console.log(`⏱️ Timer site : ${nextTimerMinutes.toFixed(1)} min`);

            return { success, message: resultMessage, siteTimer: nextTimerMinutes };
        } catch (error) {
            // Capture d'écran d'erreur pour diagnostic
            try {
                if (browser) {
                    const page = (await browser.pages())[0] || (await browser.defaultBrowserContext()).newPage();
                    await page.screenshot({ path: path.join(screenshotsDir, `error_${email.replace(/[^a-zA-Z0-9]/g, '_')}_attempt${attempt}.png`), fullPage: true });
                }
            } catch (e) {}

            console.error(`❌ Erreur tentative ${attempt} : ${error.message}`);

            if (attempt < maxAttempts && error.message.includes('timeout')) {
                console.warn(`⚠️ Timeout navigation, on réessaie...`);
                if (browser) await browser.close().catch(() => {});
                await delay(5000);
                continue;
            }
            if (error.message.includes('Cookies expirés')) {
                console.log(`🔄 Cookies expirés pour ${email} (${platform}), reconnexion...`);
                try {
                    const newCookies = await performLoginAndCaptureCookies(account);
                    account.cookies = newCookies;
                    account.cookiesStatus = 'valid';
                    console.log(`✅ Nouveaux cookies capturés. Relance du claim.`);
                    return await claimWithCookies(account);
                } catch (loginError) {
                    console.error(`❌ Échec reconnexion : ${loginError.message}`);
                    account.cookiesStatus = 'failed';
                    return { success: false, message: `Échec reconnexion: ${loginError.message}`, siteTimer: null };
                }
            }
            // Autre erreur → on retourne un message explicite
            return { success: false, message: error.message || 'Erreur inconnue pendant le claim', siteTimer: null };
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    }

    return { success: false, message: 'Échec après plusieurs tentatives', siteTimer: null };
}

// 📜 Sauvegarde de l'historique
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

// --- Main (avec appel à saveHistory et gestion améliorée) ---
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
            if (!result) result = { success: false, message: 'Erreur inconnue (résultat vide)', siteTimer: null };
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

        // 📜 Enregistrer dans l'historique (toujours, succès ou échec)
        await saveHistory(targetAccount, result.success, result.message || 'Erreur inconnue');

        // Délai aléatoire avant sauvegarde
        const waitBeforeSave = 2000 + Math.random() * 5000;
        console.log(`⏳ Pause de ${Math.round(waitBeforeSave/1000)}s avant sauvegarde...`);
        await new Promise(r => setTimeout(r, waitBeforeSave));

        // Rechiffrer et sauvegarder le compte
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
