const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');

const GH_TOKEN = process.env.GH_TOKEN;
const GH_USERNAME = process.env.GH_USERNAME;
const GH_REPO = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const GH_FILE_PATH = process.env.GH_FILE_PATH || 'accounts.json';

if (!GH_TOKEN || !GH_USERNAME || !GH_REPO) {
    console.error('❌ Variables GitHub manquantes');
    process.exit(1);
}

const octokit = new Octokit({ auth: GH_TOKEN });

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
        console.error('❌ Format HTTP invalide :', proxyUrl);
        return null;
    }
    return {
        server: `http://${match[3]}:${match[4]}`,
        username: match[1],
        password: match[2]
    };
}

async function loadAccounts() {
    try {
        const res = await octokit.repos.getContent({
            owner: GH_USERNAME,
            repo: GH_REPO,
            path: GH_FILE_PATH,
            ref: GH_BRANCH
        });
        return JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
    } catch (e) {
        if (e.status === 404) return [];
        throw e;
    }
}

(async () => {
    try {
        const accounts = await loadAccounts();
        if (accounts.length === 0) {
            console.log('Aucun compte.');
            process.exit(1);
        }
        // Prendre le premier compte actif avec des cookies
        const account = accounts.find(a => a.enabled !== false && a.cookies && a.cookies.length > 0);
        if (!account) {
            console.log('Aucun compte avec cookies valides.');
            process.exit(1);
        }
        console.log(`Utilisation du compte : ${account.email}`);

        const proxyUrl = JP_PROXY_LIST[account.proxyIndex || 0];
        const proxyConfig = parseProxyUrl(proxyUrl);
        if (!proxyConfig) throw new Error('Proxy invalide');
        console.log(`🔄 Proxy : ${proxyConfig.server}`);

        const { browser, page } = await connect({
            headless: false,
            turnstile: true,
            proxy: proxyConfig,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        await page.setCookie(...account.cookies);
        await page.goto('https://tronpick.io/faucet.php', { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(5000);

        // Attendre 5s et actualiser
        console.log('Attente 5s...');
        await delay(5000);
        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
        await page.screenshot({ path: path.join(screenshotsDir, '01_after_reload.png'), fullPage: true });

        // Attendre 20s
        console.log('Attente 20s...');
        await delay(20000);
        await page.screenshot({ path: path.join(screenshotsDir, '02_before_click.png'), fullPage: true });

        // Un seul clic (sans point rouge, sans animation)
        console.log('Clic simple à (645,40)');
        await page.mouse.click(645, 40);
        await page.screenshot({ path: path.join(screenshotsDir, '03_after_click.png'), fullPage: true });

        // Attendre 10 secondes
        console.log('Attente 10 secondes...');
        await delay(10000);
        await page.screenshot({ path: path.join(screenshotsDir, '04_final.png'), fullPage: true });

        await browser.close();
        console.log('Test terminé. Vérifiez les captures.');
        process.exit(0);
    } catch (err) {
        console.error('Erreur :', err);
        process.exit(1);
    }
})();
