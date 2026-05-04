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
const STEP1_COORDS = { x: 700, y: 550 };
const STEP2_COORDS = { x: 700, y: 800 };
const STEP3_COORDS = { x: 651, y: 450 };
const CLAIM_COORDS = { x: 651, y: 682 };

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseProxyUrl(proxyUrl) {
    // (inchangée)
}
// --- Fonctions Puppeteer (inchangées) ---
async function fillField(page, selector, value, fieldName) { /* ... */ }
async function addRedDot(page, x, y) { /* ... */ }
async function humanClickAt(page, coords) { /* ... */ }

// --- Connexion proxy ---
async function connectWithProxy(proxyUrl) { /* ... */ }

async function performLoginAndCaptureCookies(account) { /* ... */ }

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

            // --- Démarrer l'enregistrement vidéo ---
            const videoPath = path.join(screenshotsDir, `claim_${email.replace(/[^a-zA-Z0-9]/g, '_')}.webm`);
            const recorder = await page.screencast({ path: videoPath, width: 1280, height: 720 });
            console.log('🎥 Enregistrement vidéo démarré.');

            // Étape 1 : clic (700,550)
            console.log('🖱️ Étape 1 : clic (700,550)');
            await humanClickAt(page, STEP1_COORDS);
            await page.screenshot({ path: path.join(screenshotsDir, `01_step1_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });
            await delay(5000);

            // Étape 2 : clic (700,800)
            console.log('🖱️ Étape 2 : clic (700,800)');
            await humanClickAt(page, STEP2_COORDS);
            await page.screenshot({ path: path.join(screenshotsDir, `02_step2_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });
            await delay(7000);

            // Étape 3 : clic (651,450)
            console.log('🖱️ Étape 3 : clic (651,450)');
            await humanClickAt(page, STEP3_COORDS);
            await page.screenshot({ path: path.join(screenshotsDir, `03_step3_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });
            await delay(15000);

            // Clic CLAIM (651,682)
            console.log('🖱️ Clic sur CLAIM (651,682)');
            await humanClickAt(page, CLAIM_COORDS);
            await page.waitForNetworkIdle({ timeout: 20000 }).catch(() => {});
            await delay(10000);
            await page.screenshot({ path: path.join(screenshotsDir, `04_claim_${email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

            // Arrêter l'enregistrement
            await recorder.stop();
            console.log('🎥 Vidéo sauvegardée.');

            // Résultat (inchangé)
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
            if (browser) {
                try { await recorder?.stop(); } catch (e) {}
                await browser.close().catch(() => {});
            }
        }
    }
    return { success: false, message: 'Échec après plusieurs tentatives', siteTimer: null };
}

// --- Sauvegarde historique (inchangée) ---
async function saveHistory(account, success, message) { /* ... */ }

// --- Main (inchangé) ---
(async () => { /* ... */ })();
