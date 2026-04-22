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

// Liste tous les boutons/liens avec leurs coordonnées
async function listAllButtons(page) {
    const buttonsInfo = await page.evaluate(() => {
        const elements = [...document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')];
        return elements.map(el => ({
            tag: el.tagName,
            text: (el.textContent || '').trim(),
            id: el.id,
            className: el.className,
            href: el.href,
            rect: el.getBoundingClientRect()
        }));
    });
    console.log(`🔘 Boutons trouvés : ${buttonsInfo.length}`);
    buttonsInfo.forEach((b, i) => {
        console.log(`${i+1}. ${b.tag} "${b.text}" (${b.id ? '#'+b.id : ''} ${b.className ? '.'+b.className : ''}) position: (${Math.round(b.rect.x)}, ${Math.round(b.rect.y)})`);
    });
    return buttonsInfo;
}

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
            console.log(`❌ Aucun cookie trouvé pour ${email}, impossible de se connecter.`);
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

        // --- Démarche demandée ---
        console.log('⏳ Attente de 3 secondes...');
        await delay(3000);
        console.log('🔄 Actualisation de la page...');
        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
        console.log('⏳ Attente de 5 secondes après actualisation...');
        await delay(5000);

        // Lister tous les boutons avec leurs coordonnées
        await listAllButtons(page);

        // Capture d'écran pour référence
        const screenshot = path.join(screenshotsDir, `all_buttons_${account.email.replace(/[^a-zA-Z0-9]/g, '_')}.png`);
        await page.screenshot({ path: screenshot, fullPage: true });
        console.log(`📸 Capture de la page sauvegardée : ${screenshot}`);

        await browser.close();
        console.log(`✅ Diagnostic terminé pour ${email}`);
        process.exit(0);
    } catch (err) {
        if (browser) await browser.close();
        console.error('❌ Erreur :', err.message);
        process.exit(1);
    }
})();
