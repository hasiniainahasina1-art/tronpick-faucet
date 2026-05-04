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

// Ne plus bloquer sur ces variables, car l'ancienne version fonctionnait sans vérification stricte
// if (!CRYPTO_SECRET || !USER_ID) {
//   console.error('❌ CRYPTO_SECRET ou USER_ID manquant');
//   process.exit(1);
// }

// ✅ Fichier individuel par compte
const USER_FILE = `account_${USER_ID}_${platform}_${email}.json`;
const GLOBAL_FILE = 'global_accounts.json';
const KEY = CRYPTO_SECRET ? crypto.createHash('sha256').update(CRYPTO_SECRET).digest() : null;

function encrypt(text) {
    if (!KEY) throw new Error('CRYPTO_SECRET non défini');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}
function decrypt(encryptedText) {
    if (!KEY) throw new Error('CRYPTO_SECRET non défini');
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
async function fillField(page, selector, value, fieldName) { /* ... */ }
async function humanClickAt(page, coords) { /* ... */ }

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

async function isAccountAlreadyTaken(email, platform, octokit) {
    try {
        const res = await octokit.repos.getContent({
            owner: GH_USERNAME,
            repo: GH_REPO,
            path: GLOBAL_FILE,
            ref: GH_BRANCH
        });
        const entries = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
        return entries.some(e => e.email === email && e.platform === platform);
    } catch (e) {
        return false;
    }
}

async function addToGlobalList(email, platform, normalizedEmail) {
    const octokit = new Octokit({ auth: GH_TOKEN });
    try {
        let entries = [];
        let sha = null;
        try {
            const res = await octokit.repos.getContent({
                owner: GH_USERNAME,
                repo: GH_REPO,
                path: GLOBAL_FILE,
                ref: GH_BRANCH
            });
            entries = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
            sha = res.data.sha;
        } catch (e) {}

        if (entries.some(e => e.email === email && e.platform === platform)) {
            console.log('ℹ️ Déjà présent dans la liste globale.');
            return;
        }

        entries.push({ email: normalizedEmail, platform });

        const content = Buffer.from(JSON.stringify(entries, null, 2)).toString('base64');
        const message = `Ajout de ${normalizedEmail} (${platform}) à la liste globale`;
        await octokit.repos.createOrUpdateFileContents({
            owner: GH_USERNAME,
            repo: GH_REPO,
            path: GLOBAL_FILE,
            message,
            content,
            branch: GH_BRANCH,
            sha
        });
        console.log('✅ Compte ajouté à la liste globale.');
    } catch (error) {
        console.error('❌ Erreur lors de l\'ajout global :', error.message);
    }
}

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

async function run() {
    let browser;
    try {
        const proxyUrl = JP_PROXY_LIST[proxyIndex] || JP_PROXY_LIST[0];
        if (!proxyUrl) throw new Error('Proxy indisponible');
        console.log(`🔄 Proxy utilisé : ${proxyUrl}`);

        const octokit = new Octokit({ auth: GH_TOKEN });
        const normalizedEmail = email.trim().toLowerCase();
        const alreadyTaken = await isAccountAlreadyTaken(email, platform, octokit);
        if (alreadyTaken) {
            console.error(`❌ Le compte ${normalizedEmail} (${platform}) est déjà utilisé globalement.`);
            process.exit(1);
        }

        const { browser: br, page } = await connectWithProxy(proxyUrl);
        browser = br;
        await page.setViewport({ width: 1280, height: 720 });

        const loginUrl = `https://${platform}.io/login.php`;
        console.log(`🌐 Connexion à ${loginUrl}`);
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.screenshot({ path: path.join(screenshotsDir, '01_login_page.png'), fullPage: true });

        await performLogin(page, email, password);
        console.log('✅ Login réussi');

        const cookies = await page.cookies();
        console.log(`🍪 Cookies récupérés : ${cookies.length}`);

        await page.screenshot({ path: path.join(screenshotsDir, '02_login_success.png'), fullPage: true });
        await browser.close();

        const timerValue = timeStrToMinutes(initialTimerStr);
        const account = {
            email: normalizedEmail,
            password: KEY ? encrypt(password) : password,
            platform,
            proxyIndex,
            enabled: true,
            cookies: KEY ? encrypt(JSON.stringify(cookies)) : JSON.stringify(cookies),
            cookiesStatus: 'valid',
            lastClaim: Date.now(),
            timer: timerValue,
            claimResult: null,
            pendingClaim: false
        };

        await saveAccount(account);
        console.log(`✅ Compte ${normalizedEmail} enregistré avec succès (timer = ${initialTimerStr})`);

        await addToGlobalList(email, platform, normalizedEmail);
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
