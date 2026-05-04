const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');

// ---------- Variables d'environnement ----------
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

// ✅ Nouvelles coordonnées pour le login
const STEP1_COORDS = { x: 700, y: 550 };
const STEP2_COORDS = { x: 700, y: 800 };
const STEP3_COORDS = { x: 651, y: 450 };
const STEP4_COORDS = { x: 651, y: 682 };

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

function timeStrToMinutes(str) {
    if (!str || !str.includes(':')) return 60;
    const parts = str.split(':');
    const mins = parseInt(parts[0]) || 0;
    const secs = parseInt(parts[1]) || 0;
    return mins + secs / 60;
}

// --- Fonctions Puppeteer (avec point rouge) ---
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

async function addRedDot(page, x, y) {
    await page.evaluate((x, y) => {
        const dot = document.createElement('div');
        dot.style.position = 'fixed'; dot.style.left = (x - 5) + 'px'; dot.style.top = (y - 5) + 'px';
        dot.style.width = '10px'; dot.style.height = '10px'; dot.style.borderRadius = '50%';
        dot.style.backgroundColor = 'red'; dot.style.zIndex = '99999'; dot.style.pointerEvents = 'none';
        dot.id = 'click-dot'; document.body.appendChild(dot);
        setTimeout(() => dot.remove(), 5000);
    }, x, y);
}

async function humanClickAt(page, coords) {
    await addRedDot(page, coords.x, coords.y);
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

// --- Connexion proxy (version simple et stable) ---
async function connectWithProxy(proxyUrl) {
    const proxyConfig = parseProxyUrl(proxyUrl);
    if (!proxyConfig) throw new Error('Proxy invalide');
    console.log(`🔄 Connexion avec proxy : ${proxyConfig.server}`);

    const options = {
        headless: false,
        turnstile: true,
        proxy: proxyConfig,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    };

    const { browser, page } = await connect(options);
    return { browser, page };
}

// --- Sauvegarde du compte ---
async function saveAccount(accountData) {
    const octokit = new Octokit({ auth: GH_TOKEN });
    let sha = null;
    try {
        const res = await octokit.repos.getContent({
            owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE, ref: GH_BRANCH
        });
        sha = res.data.sha;
    } catch (e) {}

    const content = Buffer.from(JSON.stringify(accountData, null, 2)).toString('base64');
    await octokit.repos.createOrUpdateFileContents({
        owner: GH_USERNAME,
        repo: GH_REPO,
        path: USER_FILE,
        message: `Ajout du compte ${email}`,
        content,
        branch: GH_BRANCH,
        sha
    });
}

// --- Nouvelle séquence CAPTCHA (login avec vidéo) ---
async function performLoginWithCaptcha(page, email, password) {
    const videoPath = path.join(screenshotsDir, `login_${email.replace(/[^a-zA-Z0-9]/g, '_')}.webm`);
    const recorder = await page.screencast({ path: videoPath, width: 1280, height: 720 });
    console.log('🎥 Enregistrement vidéo démarré.');

    try {
        await fillField(page, 'input[type="email"], input[name="email"]', email, 'email');
        await fillField(page, 'input[type="password"]', password, 'password');
        await delay(2000);

        // 1er clic (700,550)
        console.log('🖱️ Étape 1 : clic (700,550)');
        await humanClickAt(page, STEP1_COORDS);
        await page.screenshot({ path: path.join(screenshotsDir, '01_step1.png'), fullPage: true });
        await delay(5000);

        // 2e clic (700,800)
        console.log('🖱️ Étape 2 : clic (700,800)');
        await humanClickAt(page, STEP2_COORDS);
        await page.screenshot({ path: path.join(screenshotsDir, '02_step2.png'), fullPage: true });
        await delay(7000);

        // 3e clic (651,450)
        console.log('🖱️ Étape 3 : clic (651,450)');
        await humanClickAt(page, STEP3_COORDS);
        await page.screenshot({ path: path.join(screenshotsDir, '03_step3.png'), fullPage: true });
        await delay(15000);

        // 4e clic (651,682)
        console.log('🖱️ Étape 4 : clic (651,682)');
        await humanClickAt(page, STEP4_COORDS);
        await page.screenshot({ path: path.join(screenshotsDir, '04_step4.png'), fullPage: true });
        await delay(10000);

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
