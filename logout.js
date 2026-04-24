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
        console.error('❌ Format HTTP invalide (attendu: http://user:pass@ip:port) :', proxyUrl);
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

function getProxyUrlForAccount(account) {
    if (account.proxyIndex !== undefined && JP_PROXY_LIST[account.proxyIndex]) {
        return JP_PROXY_LIST[account.proxyIndex];
    }
    return JP_PROXY_LIST[0];
}

async function connectWithProxy(proxyUrl) {
    const proxyConfig = parseProxyUrl(proxyUrl);
    if (!proxyConfig) throw new Error('Proxy invalide');
    console.log(`🔄 Connexion avec proxy : ${proxyConfig.server}`);
    const { browser, page } = await connect({
        headless: false,
        turnstile: true,
        proxy: proxyConfig,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    return { browser, page };
}

(async () => {
    try {
        let accounts = await loadAccounts();
        if (!accounts.length) {
            console.log('Aucun compte.');
            process.exit(1);
        }
        const targetEmail = process.env.LOGOUT_EMAIL;
        if (!targetEmail) {
            console.error('❌ Aucun email fourni (LOGOUT_EMAIL)');
            process.exit(1);
        }
        const normalizedEmail = targetEmail.trim().toLowerCase();
        const account = accounts.find(a => a.email.toLowerCase() === normalizedEmail);
        if (!account) {
            console.log(`❌ Compte ${normalizedEmail} non trouvé`);
            process.exit(1);
        }
        if (!account.cookies || account.cookies.length === 0) {
            console.log(`❌ Aucun cookie pour ${account.email}`);
            process.exit(1);
        }

        const proxyUrl = getProxyUrlForAccount(account);
        const { browser, page } = await connectWithProxy(proxyUrl);
        await page.setCookie(...account.cookies);
        await page.goto('https://tronpick.io/faucet.php', { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(5000);

        // Étape 1 : attendre 5s
        console.log('⏳ Attente de 5 secondes...');
        await delay(5000);

        // Étape 2 : actualiser
        console.log('🔄 Actualisation...');
        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
        await page.screenshot({ path: path.join(screenshotsDir, '01_after_reload.png'), fullPage: true });

        // Étape 3 : attendre 20s
        console.log('⏳ Attente de 20 secondes...');
        await delay(20000);
        await page.screenshot({ path: path.join(screenshotsDir, '02_after_wait.png'), fullPage: true });

        // Étape 4 : un seul clic simple (sans point rouge)
        console.log('🖱️ Clic unique à (645, 40)');
        await page.mouse.click(645, 40);
        await page.screenshot({ path: path.join(screenshotsDir, '03_after_click.png'), fullPage: true });

        // Étape 5 : attendre 10 secondes
        console.log('⏳ Attente de 10 secondes...');
        await delay(10000);
        await page.screenshot({ path: path.join(screenshotsDir, '04_final.png'), fullPage: true });

        await browser.close();
        console.log('Test terminé. Vérifiez les captures dans les artefacts.');
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
})();
