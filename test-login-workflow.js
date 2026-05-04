const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');

const email = process.env.TEST_EMAIL;
const password = process.env.TEST_PASSWORD;
const platform = process.env.TEST_PLATFORM;
const proxyIndex = process.env.TEST_PROXY_INDEX !== '' ? parseInt(process.env.TEST_PROXY_INDEX) : 0;
const initialTimerStr = process.env.TEST_INITIAL_TIMER || '60:00';
const GH_TOKEN = process.env.GH_TOKEN;
const GH_USERNAME = process.env.GH_USERNAME;
const GH_REPO = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const USER_ID = process.env.USER_ID;
const CRYPTO_SECRET = process.env.CRYPTO_SECRET;

const USER_FILE = USER_ID
    ? `account_${USER_ID}_${platform}_${email}.json`
    : `account_${email}_${platform}.json`;

const JP_PROXY_LIST = (process.env.JP_PROXY_LIST || '').split(',').filter(p => p.trim() !== '');
if (JP_PROXY_LIST.length === 0) {
    console.error('❌ JP_PROXY_LIST doit contenir au moins 1 proxy');
    process.exit(1);
}

const screenshotsDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

const INCOCAPTCHA_ICON_COORDS = { x: 870, y: 630 };
const VERIFY_HUMAN_COORDS = { x: 645, y: 550 };
const LOGIN_BUTTON_COORDS = { x: 640, y: 615 };

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseProxyUrl(proxyUrl) {
    // (inchangée)
}
function timeStrToMinutes(str) { /* ... */ }

// --- Fonctions Puppeteer ---
async function fillField(page, selector, value, fieldName) { /* ... */ }
async function addRedDot(page, x, y) { /* ... */ }
async function humanClickAt(page, coords) { /* ... */ }

// --- Connexion proxy ---
async function connectWithProxy(proxyUrl) { /* ... */ }

// --- Sauvegarde du compte ---
async function saveAccount(accountData) { /* ... */ }

// --- Nouvelle séquence CAPTCHA (avec vidéo) ---
async function performLoginWithCaptcha(page, email, password) {
    const videoPath = path.join(screenshotsDir, `login_${email.replace(/[^a-zA-Z0-9]/g, '_')}.webm`);
    const recorder = await page.screencast({ path: videoPath, width: 1280, height: 720 });
    console.log('🎥 Enregistrement vidéo démarré.');

    try {
        await fillField(page, 'input[type="email"], input[name="email"]', email, 'email');
        await fillField(page, 'input[type="password"]', password, 'password');
        await delay(2000);

        console.log('🖱️ Clic sur l\'icône IconCaptcha');
        await humanClickAt(page, INCOCAPTCHA_ICON_COORDS);
        await page.screenshot({ path: path.join(screenshotsDir, '01_iconcaptcha_click.png'), fullPage: true });
        await delay(5000);

        const frame = await page.waitForFrame(
            f => f.url().includes('challenges.cloudflare.com/turnstile'),
            { timeout: 15000 }
        ).catch(() => null);
        if (frame) {
            console.log('✅ Iframe Turnstile trouvée, clic checkbox');
            await frame.click('input[type="checkbox"]');
        } else {
            console.log('⚠️ Iframe Turnstile non trouvée, fallback coordonné (640,615)');
            await humanClickAt(page, { x: 640, y: 615 });
        }
        await page.screenshot({ path: path.join(screenshotsDir, '02_turnstile_click.png'), fullPage: true });
        await delay(5000);

        console.log('🖱️ Clic sur Verify you are human');
        await humanClickAt(page, VERIFY_HUMAN_COORDS);
        await page.screenshot({ path: path.join(screenshotsDir, '03_verify_human_click.png'), fullPage: true });
        await delay(10000);

        console.log('🖱️ Clic sur le bouton Log in');
        const loginClicked = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button')];
            const loginBtn = btns.find(b => b.textContent.trim() === 'Log in');
            if (loginBtn) { loginBtn.click(); return true; }
            return false;
        });
        if (!loginClicked) {
            console.log('⚠️ Bouton Log in non trouvé, fallback coordonné (640,615)');
            await humanClickAt(page, LOGIN_BUTTON_COORDS);
        }
        await page.screenshot({ path: path.join(screenshotsDir, '04_login_click.png'), fullPage: true });
        await delay(5000);

        try {
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 40000 });
        } catch (navError) {
            console.warn('⚠️ Navigation après login non détectée, vérification manuelle...');
            await delay(5000);
            if (page.url().includes('login.php')) {
                const errorMsg = await page.evaluate(() => {
                    const el = document.querySelector('.alert-danger, .error');
                    return el ? el.textContent.trim() : null;
                });
                throw new Error(errorMsg || 'Échec connexion');
            }
        }
        if (page.url().includes('login.php')) {
            const errorMsg = await page.evaluate(() => {
                const el = document.querySelector('.alert-danger, .error');
                return el ? el.textContent.trim() : null;
            });
            throw new Error(errorMsg || 'Échec connexion');
        }
    } finally {
        await recorder.stop();
        console.log('🎥 Vidéo sauvegardée.');
    }
}

// --- Main ---
async function run() {
    let browser;
    try {
        const proxyUrl = JP_PROXY_LIST[proxyIndex] || JP_PROXY_LIST[0];
        if (!proxyUrl) throw new Error('Proxy indisponible');
        console.log(`🔄 Proxy utilisé : ${proxyUrl}`);

        const { browser: br, page } = await connectWithProxy(proxyUrl);
        browser = br;
        await page.setViewport({ width: 1280, height: 720 });

        const loginUrl = `https://${platform}.io/login.php`;
        console.log(`🌐 Connexion à ${loginUrl}`);
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.screenshot({ path: path.join(screenshotsDir, '00_login_page.png'), fullPage: true });

        await performLoginWithCaptcha(page, email, password);
        console.log('✅ Login réussi');

        const cookies = await page.cookies();
        console.log(`🍪 Cookies récupérés : ${cookies.length}`);

        await page.screenshot({ path: path.join(screenshotsDir, '99_login_success.png'), fullPage: true });
        await browser.close();

        const timerValue = timeStrToMinutes(initialTimerStr);
        const normalizedEmail = email.trim().toLowerCase();
        const account = {
            email: normalizedEmail,
            password,
            platform,
            proxyIndex,
            enabled: true,
            cookies,
            cookiesStatus: 'valid',
            lastClaim: Date.now(),
            timer: timerValue
        };

        await saveAccount(account);
        console.log(`✅ Compte ${normalizedEmail} enregistré avec succès (timer = ${initialTimerStr})`);
        process.exit(0);
    } catch (err) {
        console.error('❌ Erreur fatale :', err.message);
        if (browser) {
            try {
                const screenshotPath = path.join(screenshotsDir, 'error.png');
                await browser.screenshot({ fullPage: true }).then(img => fs.writeFileSync(screenshotPath, img));
            } catch (e) {}
            await browser.close();
        }
        process.exit(1);
    }
}
run();
