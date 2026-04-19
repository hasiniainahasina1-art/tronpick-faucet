const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');

// --- Variables d'environnement ---
const email = process.env.TEST_EMAIL;
const password = process.env.TEST_PASSWORD;
const platform = process.env.TEST_PLATFORM;
const proxyIndex = process.env.TEST_PROXY_INDEX !== '' ? parseInt(process.env.TEST_PROXY_INDEX) : undefined;
const GH_TOKEN = process.env.GH_TOKEN;
const GH_USERNAME = process.env.GH_USERNAME;
const GH_REPO = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH;
const GH_FILE_PATH = process.env.GH_FILE_PATH;
const JP_PROXY_LIST = (process.env.JP_PROXY_LIST || '').split(',').filter(p => p.trim() !== '');

// --- Dossier pour captures d'écran ---
const screenshotsDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

// --- Coordonnées (identiques à script.js) ---
const TURNSTILE_LOGIN_COORDS = { x: 640, y: 615 };
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Fonctions copiées de script.js ---
async function fillField(page, selector, value, fieldName) {
    await page.waitForSelector(selector, { timeout: 10000 });
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await delay(100);
    await page.evaluate((sel, val) => {
        const el = document.querySelector(sel);
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
    }, selector, value);
    await delay(300);
    let actual = await page.$eval(selector, el => el.value);
    if (actual !== value) {
        await page.click(selector, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        for (const char of value) await page.keyboard.type(char, { delay: 30 });
        actual = await page.$eval(selector, el => el.value);
    }
    if (actual !== value) throw new Error(`Impossible de remplir ${fieldName}`);
}

async function humanClickAt(page, coords) {
    const start = await page.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const cp = { x: start.x + (Math.random() - 0.5) * 100, y: start.y + (Math.random() - 0.5) * 100 };
        const x = Math.pow(1 - t, 2) * start.x + 2 * (1 - t) * t * cp.x + Math.pow(t, 2) * coords.x;
        const y = Math.pow(1 - t, 2) * start.y + 2 * (1 - t) * t * cp.y + Math.pow(t, 2) * coords.y;
        await page.mouse.move(x, y);
        await delay(15);
    }
    await page.mouse.click(coords.x, coords.y);
}

// --- Parser un proxy (même fonction que dans script.js) ---
function parseProxyUrl(proxyUrl) {
    const match = proxyUrl.match(/^http:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
    if (!match) {
        console.error('❌ Format de proxy invalide:', proxyUrl);
        return null;
    }
    return {
        server: `http://${match[3]}:${match[4]}`,
        username: match[1],
        password: match[2]
    };
}

// --- Fonction de login (identique à performLoginAndCaptureCookies de script.js) ---
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

// --- Main ---
async function run() {
    let browser;
    try {
        // Sélection du proxy (identique à script.js)
        let proxyUrl = JP_PROXY_LIST[0];
        if (proxyIndex !== undefined && JP_PROXY_LIST[proxyIndex]) {
            proxyUrl = JP_PROXY_LIST[proxyIndex];
        }
        const proxyConfig = parseProxyUrl(proxyUrl);
        if (!proxyConfig) throw new Error('Proxy invalide');
        console.log(`🔄 Proxy utilisé : ${proxyConfig.server}`);

        const { browser: br, page } = await connect({
            headless: false,
            turnstile: true,
            proxy: proxyConfig,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        browser = br;

        await page.setViewport({ width: 1280, height: 720 });
        const loginUrl = `https://${platform}.io/login.php`;
        console.log(`🌐 Connexion à ${loginUrl}`);
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.screenshot({ path: path.join(screenshotsDir, '01_login_page.png'), fullPage: true });

        // Exécuter la séquence de login (copiée de script.js)
        await performLogin(page, email, password);

        // Succès : récupérer les cookies
        const cookies = await page.cookies();
        console.log(`✅ Connexion réussie pour ${email}`);
        await page.screenshot({ path: path.join(screenshotsDir, '02_login_success.png'), fullPage: true });

        await browser.close();

        // Mise à jour de accounts.json
        const octokit = new Octokit({ auth: GH_TOKEN });
        let accounts = [];
        try {
            const res = await octokit.repos.getContent({ owner: GH_USERNAME, repo: GH_REPO, path: GH_FILE_PATH, ref: GH_BRANCH });
            accounts = JSON.parse(Buffer.from(res.data.content, 'base64').toString());
        } catch (e) {}

        const existingIndex = accounts.findIndex(a => a.email === email);
        const newAccount = {
            email,
            password,
            platform,
            proxy: proxyUrl,
            enabled: true,
            cookies: cookies,
            cookiesStatus: 'valid',
            lastClaim: Date.now(),
            timer: 60,
            proxyIndex: proxyIndex !== undefined ? proxyIndex : 0
        };
        if (existingIndex !== -1) accounts[existingIndex] = newAccount;
        else accounts.push(newAccount);

        const content = Buffer.from(JSON.stringify(accounts, null, 2)).toString('base64');
        let sha = null;
        try {
            const res = await octokit.repos.getContent({ owner: GH_USERNAME, repo: GH_REPO, path: GH_FILE_PATH, ref: GH_BRANCH });
            sha = res.data.sha;
        } catch (e) {}
        await octokit.repos.createOrUpdateFileContents({
            owner: GH_USERNAME,
            repo: GH_REPO,
            path: GH_FILE_PATH,
            message: `Test login for ${email} - success`,
            content,
            branch: GH_BRANCH,
            sha
        });

        process.exit(0);
    } catch (err) {
        if (browser) {
            try {
                // Capture d'écran de l'erreur
                const screenshotPath = path.join(screenshotsDir, 'error.png');
                await page.screenshot({ fullPage: true }).then(img => fs.writeFileSync(screenshotPath, img));
                console.log(`📸 Capture d'erreur sauvegardée : ${screenshotPath}`);
            } catch (e) {}
            await browser.close();
        }
        console.error('❌ Erreur :', err.message);
        process.exit(1);
    }
}

run();
