const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

if (!CRYPTO_SECRET || !USER_ID) {
    console.error('❌ CRYPTO_SECRET ou USER_ID manquant');
    process.exit(1);
}

// ✅ Fichier individuel
const USER_FILE = `account_${USER_ID}_${platform}_${email}.json`;
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

const JP_PROXY_LIST = (process.env.JP_PROXY_LIST || '').split(',').filter(p => p.trim() !== '');
if (JP_PROXY_LIST.length === 0) {
    console.error('❌ JP_PROXY_LIST doit contenir au moins 1 proxy');
    process.exit(1);
}

const screenshotsDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

const TURNSTILE_LOGIN_COORDS = { x: 640, y: 615 };
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

// --- Fonctions Puppeteer (identiques à script.js) ---
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

async function humanClickAt(page, coords) {
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

// --- Connexion proxy ---
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

// --- Login ---
async function performLogin(page, email, password) {
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

    // ✅ CORRECTION : remplacer $x par evaluate (compatible puppeteer-real-browser)
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
}

// --- Sauvegarde (gère l'absence de fichier) ---
async function saveAccount(accountData) {
    const octokit = new Octokit({ auth: GH_TOKEN });
    let sha = null;
    try {
        const res = await octokit.repos.getContent({
            owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE, ref: GH_BRANCH
        });
        sha = res.data.sha;
    } catch (e) {
        // Le fichier n'existe pas encore, sha reste null → création
    }

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
        await page.screenshot({ path: path.join(screenshotsDir, '01_login_page.png'), fullPage: true });

        // Login
        await performLogin(page, email, password);
        console.log('✅ Login réussi');

        // Récupérer les cookies
        const cookies = await page.cookies();
        console.log(`🍪 Cookies récupérés : ${cookies.length}`);

        await page.screenshot({ path: path.join(screenshotsDir, '02_login_success.png'), fullPage: true });
        await browser.close();

        // Préparer le compte
        const timerValue = timeStrToMinutes(initialTimerStr);
        const normalizedEmail = email.trim().toLowerCase();
        const account = {
            email: normalizedEmail,
            password: encrypt(password),
            platform,
            proxyIndex,
            enabled: true,
            cookies: encrypt(JSON.stringify(cookies)),
            cookiesStatus: 'valid',
            lastClaim: Date.now(),
            timer: timerValue,
            claimResult: null,
            pendingClaim: false
        };

        await saveAccount(account);
        console.log(`✅ Compte ${normalizedEmail} enregistré avec succès (timer = ${initialTimerStr})`);
        process.exit(0);
    } catch (err) {
        console.error('❌ Erreur fatale :', err.message);
        // En cas d'échec, on enregistre quand même un compte "failed"
        try {
            const octokit = new Octokit({ auth: GH_TOKEN });
            const normalizedEmail = email.trim().toLowerCase();
            const failedAccount = {
                email: normalizedEmail,
                password: encrypt(password),
                platform,
                proxyIndex,
                enabled: false,
                cookies: encrypt('[]'),
                cookiesStatus: 'failed',
                errorMessage: err.message,
                lastClaim: 0,
                timer: 60
            };
            const content = Buffer.from(JSON.stringify(failedAccount, null, 2)).toString('base64');
            let sha = null;
            try {
                const res = await octokit.repos.getContent({ owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE, ref: GH_BRANCH });
                sha = res.data.sha;
            } catch (e) {}
            await octokit.repos.createOrUpdateFileContents({
                owner: GH_USERNAME,
                repo: GH_REPO,
                path: USER_FILE,
                message: `Échec login pour ${normalizedEmail}`,
                content,
                branch: GH_BRANCH,
                sha
            });
            console.log(`❌ État d'échec sauvegardé pour ${normalizedEmail}`);
        } catch (saveErr) {}
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
