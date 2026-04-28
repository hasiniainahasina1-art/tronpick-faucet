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

function parseProxyUrl(proxyUrl) {
    if (!proxyUrl) return null;
    proxyUrl = proxyUrl.trim();
    const match = proxyUrl.match(/^http:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
    if (!match) { console.error('❌ Format HTTP invalide'); return null; }
    return { server: `http://${match[3]}:${match[4]}`, username: match[1], password: match[2] };
}

// --- Fonctions Puppeteer ---
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

// --- Chargement / Sauvegarde ---
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
                                latest[idx] = { ...latest[idx], ...modifiedAccount };
                            } else {
                                latest.push(modifiedAccount);
                            }
                        }
                        accounts = latest;
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

async function connectWithProxy(proxyUrl) {
    const proxyConfig = parseProxyUrl(proxyUrl);
    if (!proxyConfig) throw new Error('Proxy invalide');
    console.log(`🔄 Connexion avec proxy : ${proxyConfig.server}`);
    const { browser, page } = await connect({
        headless: false, turnstile: true, proxy: proxyConfig,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    return { browser, page };
}

async function performLoginAndCaptureCookies(account) {
    const { email, password, platform } = account;
    console.log(`🔐 Login pour ${email} sur ${platform}...`);
    const siteUrls = {
        tronpick: 'https://tronpick.io/login.php',
        litepick: 'https://litepick.io/login.php',
        dogepick: 'https://dogepick.io/login.php',
        solpick: 'https://solpick.io/login.php',
        binpick: 'https://binpick.io/login.php'
    };
    const loginUrl = siteUrls[platform];
    if (!loginUrl) throw new Error('Plateforme inconnue');

    let browser;
    try {
        const { browser: br, page } = await connectWithProxy(PRIMARY_PROXY);
        browser = br;
        await page.setViewport({ width: 1280, height: 720 });
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        await fillField(page, 'input[type="email"], input[name="email"]', email, 'email');
        await fillField(page, 'input[type="password"]', password, 'password');
        await delay(2000);

        const frame = await page.waitForFrame(
            f => f.url().includes('challenges.cloudflare.com/turnstile'),
            { timeout: 15000 }
        ).catch(() => null);

        if (frame) {
            console.log('✅ Iframe Turnstile trouvée (login), clic checkbox');
            await frame.click('input[type="checkbox"]');
            await delay(8000);
        } else {
            console.log('⚠️ Iframe non trouvée, fallback coordonné');
            await humanClickAt(page, TURNSTILE_LOGIN_COORDS);
            await delay(10000);
        }

        const loginClicked = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button')];
            const loginBtn = btns.find(b => b.textContent.trim() === 'Log in');
            if (loginBtn) { loginBtn.click(); return true; }
            return false;
        });
        if (!loginClicked) throw new Error('Bouton Log in introuvable');

        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        await delay(5000);
        if (page.url().includes('login.php')) {
            const errorMsg = await page.evaluate(() => {
                const el = document.querySelector('.alert-danger, .error');
                return el ? el.textContent.trim() : null;
            });
            throw new Error(errorMsg || 'Échec connexion');
        }
        const cookies = await page.cookies();
        return cookies;
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

async function claimWithCookies(account) {
    const { email, cookies, platform } = account;
    console.log(`🍪 Claim pour ${email} sur ${platform} via cookies`);
    const siteUrls = {
        tronpick: 'https://tronpick.io/faucet.php',
        litepick: 'https://litepick.io/faucet.php',
        dogepick: 'https://dogepick.io/faucet.php',
        solpick: 'https://solpick.io/faucet.php',
        binpick: 'https://binpick.io/faucet.php'
    };
    const faucetUrl = siteUrls[platform] || 'https://tronpick.io/faucet.php';

    let browser;
    try {
        const { browser: br, page } = await connectWithProxy(PRIMARY_PROXY);
        browser = br;
        await page.setCookie(...cookies);
        await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
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

        const messages = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('[class*="toast"], [class*="alert"], [role="alert"], .alert, .message, .notification'))
                .map(el => el.textContent.trim()).filter(t => t);
        });
        const btnDisabled = await page.evaluate(() => {
            const btn = document.querySelector('#process_claim_hourly_faucet');
            return btn ? btn.disabled : false;
        });
        const success = btnDisabled || messages.some(m => /success|claimed|reward|sent|received|thanks/i.test(m));
        const resultMessage = messages[0] || (btnDisabled ? 'Bouton désactivé (succès présumé)' : 'Aucune réaction');
        console.log(`📢 Messages détectés : ${messages.join(' | ')}`);
        console.log(`🔘 Bouton désactivé : ${btnDisabled}`);

        return { success, message: resultMessage };
    } catch (error) {
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
                return { success: false, message: `Échec reconnexion: ${loginError.message}` };
            }
        }
        console.error(`❌ Erreur claim : ${error.message}`);
        return { success: false, message: error.message };
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

// --- Main (version corrigée – sans l’abandon sur pendingClaim) ---
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

        // Vérification d’éligibilité classique
        const lastClaim = targetAccount.lastClaim || 0;
        const intervalMs = (targetAccount.timer || 60) * 60 * 1000;
        if ((now - lastClaim) < intervalMs) {
            console.log('⏳ Pas encore éligible');
            targetAccount.pendingClaim = false;
            targetAccount.claimResult = null;
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

        console.log(`📋 Résultat du claim : success=${result.success}, message="${result.message}"`);

        if (result.success) {
            targetAccount.lastClaim = now;
            if (targetAccount.timer !== 63) {
                console.log('🕒 Timer passé à 60 min');
                targetAccount.timer = 63;
            }
            targetAccount.claimResult = `✅ ${result.message || 'Claim réussi'}`;
            console.log('✅ Claim réussi');
        } else {
            targetAccount.claimResult = `❌ ${result.message}`;
            console.log(`❌ Claim échoué : ${result.message}`);
            if (result.message && result.message.includes('try again in 10 minutes')) {
                const deuxHeuresMs = 2 * 60 * 60 * 1000;
                targetAccount.lastClaim = now + deuxHeuresMs - ((targetAccount.timer || 60) * 60 * 1000);
                console.log('⏰ Prochain claim repoussé de 2 heures');
            }
        }

        // Délai aléatoire avant sauvegarde
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
