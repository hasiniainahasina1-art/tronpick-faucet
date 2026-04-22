const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');

const email = process.env.LOGOUT_EMAIL;
const password = process.env.LOGOUT_PASSWORD;
const platform = process.env.LOGOUT_PLATFORM;
const proxyIndex = process.env.LOGOUT_PROXY_INDEX !== '' ? parseInt(process.env.LOGOUT_PROXY_INDEX) : 0;
const GH_TOKEN = process.env.GH_TOKEN;
const GH_USERNAME = process.env.GH_USERNAME;
const GH_REPO = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH;
const GH_FILE_PATH = process.env.GH_FILE_PATH;
const JP_PROXY_LIST = (process.env.JP_PROXY_LIST || '').split(',').filter(p => p.trim() !== '');

if (JP_PROXY_LIST.length === 0) {
    console.error('❌ JP_PROXY_LIST doit contenir au moins 1 proxy');
    process.exit(1);
}

const screenshotsDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

const TURNSTILE_LOGIN_COORDS = { x: 640, y: 615 }; // fallback si pas d'iframe
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseProxyUrl(proxyUrl) {
    if (!proxyUrl) return null;
    proxyUrl = proxyUrl.trim();
    const match = proxyUrl.match(/^http:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
    if (!match) {
        console.error('❌ Format HTTP invalide:', proxyUrl);
        return null;
    }
    return {
        server: `http://${match[3]}:${match[4]}`,
        username: match[1],
        password: match[2]
    };
}

// === Fonctions exactement comme dans script.js ===
async function fillField(page, selector, value, fieldName) {
    await page.waitForSelector(selector, { timeout: 10000 });
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await delay(100);
    await page.evaluate((sel, val) => {
        const el = document.querySelector(sel);
        if (el) el.value = val;
    }, selector, value);
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
        dot.style.position = 'fixed';
        dot.style.left = (x - 5) + 'px';
        dot.style.top = (y - 5) + 'px';
        dot.style.width = '10px';
        dot.style.height = '10px';
        dot.style.borderRadius = '50%';
        dot.style.backgroundColor = 'red';
        dot.style.zIndex = '99999';
        dot.style.pointerEvents = 'none';
        dot.id = 'click-dot';
        document.body.appendChild(dot);
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
        await page.mouse.move(x, y);
        await delay(15);
    }
    await page.mouse.click(coords.x, coords.y);
    console.log(`🖱️ Clic à (${coords.x}, ${coords.y})`);
}

// Gestion du Turnstile (comme dans performLoginAndCaptureCookies)
async function handleTurnstile(page, coordsFallback) {
    const frame = await page.waitForFrame(
        f => f.url().includes('challenges.cloudflare.com/turnstile'),
        { timeout: 15000 }
    ).catch(() => null);
    if (frame) {
        console.log('✅ Iframe Turnstile trouvée, clic checkbox');
        await frame.click('input[type="checkbox"]');
        await delay(8000);
        return true;
    } else {
        console.log('⚠️ Iframe non trouvée, fallback coordonné');
        await humanClickAt(page, coordsFallback);
        await delay(10000);
        return false;
    }
}

async function performLogout(page, account) {
    console.log(`🚪 Déconnexion pour ${account.email} selon séquence avec gestion Turnstile`);

    // 1. Attendre 5 secondes
    console.log('⏳ Attente de 5 secondes...');
    await delay(5000);

    // 2. Actualiser la page
    console.log('🔄 Actualisation de la page...');
    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });

    // 3. Attendre 30 secondes
    console.log('⏳ Attente de 30 secondes...');
    await delay(30000);

    // 4. Avant tout clic, gérer un éventuel Turnstile
    console.log('🔐 Vérification et résolution du Turnstile si présent...');
    await handleTurnstile(page, TURNSTILE_LOGIN_COORDS);

    // 5. Premier clic à (640, 43)
    console.log('🖱️ Premier clic à (640, 43)');
    await humanClickAt(page, { x: 640, y: 43 });
    await page.screenshot({ path: path.join(screenshotsDir, `logout_after_first_click_${account.email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

    // 6. Attendre 2 secondes
    console.log('⏳ Attente de 2 secondes...');
    await delay(2000);

    // 7. Deuxième clic à (400, 285)
    console.log('🖱️ Deuxième clic à (400, 285)');
    await humanClickAt(page, { x: 400, y: 285 });
    await page.screenshot({ path: path.join(screenshotsDir, `logout_after_second_click_${account.email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

    // 8. Attendre 10 secondes pour observer le résultat
    console.log('⏳ Attente de 10 secondes pour le résultat...');
    await delay(10000);

    // 9. Capture finale
    const screenshotFinal = path.join(screenshotsDir, `logout_final_${account.email.replace(/[^a-zA-Z0-9]/g, '_')}.png`);
    await page.screenshot({ path: screenshotFinal, fullPage: true });
    console.log(`📸 Capture finale: ${screenshotFinal}`);

    // 10. Vérifier si déconnecté
    const currentUrl = page.url();
    const isLoggedOut = currentUrl.includes('login.php') || currentUrl.includes('logout') || currentUrl.includes('index.php');
    let logoutMessage = '';
    if (!isLoggedOut) {
        logoutMessage = await page.evaluate(() => {
            const msg = document.querySelector('.alert-success, .alert-info, .message, .toast');
            return msg ? msg.textContent.trim() : '';
        }).catch(() => '');
    }
    const success = isLoggedOut || logoutMessage.toLowerCase().includes('logout') || logoutMessage.toLowerCase().includes('déconnecté');
    if (success) {
        console.log(`✅ Déconnexion confirmée (URL: ${currentUrl}, message: "${logoutMessage}")`);
    } else {
        console.log(`⚠️ Déconnexion non confirmée (URL: ${currentUrl}, message: "${logoutMessage}")`);
    }
    return success;
}

// --- Main ---
(async () => {
    let browser;
    try {
        const octokit = new Octokit({ auth: GH_TOKEN });
        let accounts = [];
        try {
            const res = await octokit.repos.getContent({ owner: GH_USERNAME, repo: GH_REPO, path: GH_FILE_PATH, ref: GH_BRANCH });
            accounts = JSON.parse(Buffer.from(res.data.content, 'base64').toString());
        } catch (e) {
            console.log(`Impossible de lire accounts.json : ${e.message}`);
            process.exit(1);
        }

        const normalizedEmail = email.trim().toLowerCase();
        const accountIndex = accounts.findIndex(a => a.email.toLowerCase() === normalizedEmail);
        if (accountIndex === -1 || !accounts[accountIndex].cookies || accounts[accountIndex].cookies.length === 0) {
            console.log(`❌ Aucun cookie trouvé pour ${email}, impossible de se déconnecter.`);
            process.exit(1);
        }

        const account = accounts[accountIndex];
        const proxyUrl = JP_PROXY_LIST[proxyIndex];
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
        await page.setCookie(...account.cookies);
        const faucetUrl = `https://${account.platform}.io/faucet.php`;
        await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(2000);

        const logoutSuccess = await performLogout(page, account);
        await browser.close();

        if (logoutSuccess) {
            accounts.splice(accountIndex, 1);
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
                message: `Logout and remove account ${email}`,
                content,
                branch: GH_BRANCH,
                sha
            });
            console.log(`✅ Déconnexion réussie pour ${email}, compte supprimé.`);
            process.exit(0);
        } else {
            console.log(`❌ Déconnexion échouée pour ${email}, compte non supprimé.`);
            process.exit(1);
        }
    } catch (err) {
        if (browser) await browser.close();
        console.error('❌ Erreur :', err.message);
        process.exit(1);
    }
})();
