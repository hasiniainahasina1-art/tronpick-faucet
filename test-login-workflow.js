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

// Coordonnées de la nouvelle séquence
const INCOCAPTCHA_ICON_COORDS = { x: 645, y: 500 };        // fallback si icône non trouvée
const VERIFY_HUMAN_COORDS = { x: 645, y: 550 };             // Y = 615 - 65
const CLAIM_COORDS = { x: 645, y: 615 };
const TURNSTILE_LOGIN_COORDS = { x: 640, y: 615 };          // inchangé pour le login

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

// --- Chargement / Sauvegarde ---
async function loadAccounts() { /* ... */ }
async function saveAccounts(accounts, modifiedAccount = null) { /* ... */ }

// --- Connexion proxy (version stable) ---
async function connectWithProxy(proxyUrl) { /* ... */ }

async function performLoginAndCaptureCookies(account) { /* ... */ }

// --- NOUVELLE VERSION DE claimWithCookies (avec séquence 4 clics) ---
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
            await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 90000 });
            await delay(5000);
            if (page.url().includes('login.php')) throw new Error('Cookies expirés');

            // Étape 1 : clic sur l'icône Incocaptcha (ou fallback)
            console.log('🔍 Recherche icône Incocaptcha…');
            const incocaptchaClicked = await page.evaluate(() => {
                const selectors = [
                    '.incocaptcha', '#incocaptcha', '[id*="incocaptcha"]', '[class*="incocaptcha"]',
                    'img[src*="incocaptcha"]', 'svg[class*="incocaptcha"]'
                ];
                for (const sel of selectors) {
                    const el = document.querySelector(sel);
                    if (el) { el.click(); return true; }
                }
                return false;
            });

            if (!incocaptchaClicked) {
                console.log('⚠️ Icône Incocaptcha non trouvée, fallback coordonné (645,500)');
                await humanClickAt(page, INCOCAPTCHA_ICON_COORDS);
            } else {
                console.log('✅ Icône Incocaptcha cliquée');
            }
            await delay(5000);
            await page.screenshot({ path: path.join(screenshotsDir, `01_after_incocaptcha_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

            // Étape 2 : clic sur la fenêtre Turnstile (comme avant)
            const frame = await page.waitForFrame(
                f => f.url().includes('challenges.cloudflare.com/turnstile'),
                { timeout: 15000 }
            ).catch(() => null);

            if (frame) {
                console.log('✅ Iframe Turnstile trouvée, clic checkbox');
                await frame.click('input[type="checkbox"]');
                await delay(8000);
            } else {
                console.log('⚠️ Iframe Turnstile non trouvée, fallback coordonné (640,615)');
                await humanClickAt(page, TURNSTILE_LOGIN_COORDS);
                await delay(10000);
            }

            await page.screenshot({ path: path.join(screenshotsDir, `02_after_turnstile_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

            // Étape 3 : clic sur "verify you are human" (645,550)
            console.log('🖱️ Clic sur Verify you are human');
            await humanClickAt(page, VERIFY_HUMAN_COORDS);
            await delay(10000);
            await page.screenshot({ path: path.join(screenshotsDir, `03_after_verify_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

            // Étape 4 : clic sur CLAIM (645,615)
            console.log('🖱️ Clic sur CLAIM');
            await humanClickAt(page, CLAIM_COORDS);
            await page.waitForNetworkIdle({ timeout: 20000 }).catch(() => {});
            await delay(5000);
            await page.screenshot({ path: path.join(screenshotsDir, `04_after_claim_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

            // Résultat
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
            if (attempt < maxAttempts && error.message.includes('timeout')) {
                console.warn(`⚠️ Timeout navigation (tentative ${attempt}/${maxAttempts}), on réessaie...`);
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
            console.error(`❌ Erreur claim : ${error.message}`);
            return { success: false, message: error.message, siteTimer: null };
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    }

    return { success: false, message: 'Échec après plusieurs tentatives', siteTimer: null };
}

// 📜 Sauvegarde de l'historique
async function saveHistory(account, success, message) { /* ... identique ... */ }

// --- Main (inchangé, appelle claimWithCookies) ---
(async () => {
    // ... identique ...
})();
