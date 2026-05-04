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

const INCOCAPTCHA_ICON_COORDS = { x: 645, y: 500 };
const VERIFY_HUMAN_COORDS = { x: 645, y: 550 };
const LOGIN_BUTTON_COORDS = { x: 640, y: 615 };
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseProxyUrl(proxyUrl) {
    // (inchangée)
}
function timeStrToMinutes(str) { /* ... */ }

// --- Fonctions Puppeteer ---
async function fillField(page, selector, value, fieldName) { /* ... */ }

async function addRedDot(page, x, y) {
    await page.evaluate((x, y) => {
        const dot = document.createElement('div');
        dot.style.position = 'fixed'; dot.style.left = (x - 5) + 'px'; dot.style.top = (y - 5) + 'px';
        dot.style.width = '10px'; dot.style.height = '10px'; dot.style.borderRadius = '50%';
        dot.style.backgroundColor = 'red'; dot.style.zIndex = '99999'; dot.style.pointerEvents = 'none';
        dot.id = 'click-dot'; document.body.appendChild(dot);
        setTimeout(() => dot.remove(), 5000); // laisser le point 5 secondes pour être sûr
    }, x, y);
}

async function humanClickAt(page, coords) {
    await addRedDot(page, coords.x, coords.y);
    // petit délai pour que le point apparaisse
    await delay(200);
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

async function connectWithProxy(proxyUrl) { /* ... */ }

// --- SAUVEGARDE ---
async function saveAccount(accountData) { /* ... */ }

// --- NOUVELLE SÉQUENCE CAPTCHA (avec captures immédiates) ---
async function performLoginWithCaptcha(page, email, password) {
    await fillField(page, 'input[type="email"], input[name="email"]', email, 'email');
    await fillField(page, 'input[type="password"]', password, 'password');
    await delay(2000);

    // 1er clic : icône Incocaptcha
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
    // Capture immédiate après le clic (le point rouge est encore visible)
    await page.screenshot({ path: path.join(screenshotsDir, '01_incocaptcha_click.png'), fullPage: true });
    await delay(5000); // attendre la suite

    // 2e clic : Turnstile
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

    // 3e clic : Verify you are human
    console.log('🖱️ Clic sur Verify you are human');
    await humanClickAt(page, VERIFY_HUMAN_COORDS);
    await page.screenshot({ path: path.join(screenshotsDir, '03_verify_human_click.png'), fullPage: true });
    await delay(10000);

    // 4e clic : bouton Log in
    console.log('🖱️ Clic sur le bouton Log in');
    const loginClicked = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const loginBtn = btns.find(b => b.textContent.trim() === 'Log in');
        if (loginBtn) { loginBtn.click(); return true; }
        return false;
    });
    if (!loginClicked) {
        console.log('⚠️ Bouton Log in non trouvé par texte, fallback coordonné (640,615)');
        await humanClickAt(page, LOGIN_BUTTON_COORDS);
    }
    await page.screenshot({ path: path.join(screenshotsDir, '04_login_click.png'), fullPage: true });
    await delay(5000);

    // Attendre la navigation
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
}

// --- Main (inchangé) ---
async function run() { /* ... */ }
run();
