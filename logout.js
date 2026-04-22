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

// Ajout d'un point rouge visible
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

async function performLogout(page, account) {
    console.log(`🚪 Déconnexion pour ${account.email} selon séquence spécifique`);

    // 1. Attendre 5 secondes
    console.log('⏳ Attente de 5 secondes...');
    await delay(5000);

    // 2. Actualiser la page et attendre 15 secondes
    console.log('🔄 Actualisation de la page...');
    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    console.log('⏳ Attente de 15 secondes après actualisation...');
    await delay(15000);

    // 3. Clic à (720, 150) avec point rouge
    console.log('🖱️ Premier clic à (400, 300)');
    await humanClickAt(page, { x: 400, y: 300 });

    // 4. Capture d'écran après premier clic
    const screenshot1 = path.join(screenshotsDir, `logout_step1_${account.email.replace(/[^a-zA-Z0-9]/g, '_')}.png`);
    await page.screenshot({ path: screenshot1, fullPage: true });
    console.log(`📸 Capture après premier clic: ${screenshot1}`);

    // 5. Attendre 3 secondes
    console.log('⏳ Attente de 3 secondes...');
    await delay(3000);

    // 6. Clic à (650, 250) avec point rouge
    console.log('🖱️ Second clic à (450, 320)');
    await humanClickAt(page, { x: 450, y: 320 });

    // 7. Capture d'écran après second clic
    const screenshot2 = path.join(screenshotsDir, `logout_step2_${account.email.replace(/[^a-zA-Z0-9]/g, '_')}.png`);
    await page.screenshot({ path: screenshot2, fullPage: true });
    console.log(`📸 Capture après second clic: ${screenshot2}`);

    // 8. Attendre 6 secondes (au lieu de 5) pour laisser le site réagir
    console.log('⏳ Attente de 6 secondes pour observer le résultat...');
    await delay(6000);

    // 9. Capture finale
    const screenshot3 = path.join(screenshotsDir, `logout_step3_${account.email.replace(/[^a-zA-Z0-9]/g, '_')}.png`);
    await page.screenshot({ path: screenshot3, fullPage: true });
    console.log(`📸 Capture finale: ${screenshot3}`);

    // 10. Vérifier le résultat de la déconnexion (redirection vers login.php ou message)
    const currentUrl = page.url();
    const isLoggedOut = currentUrl.includes('login.php') || currentUrl.includes('logout');
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
            // Supprimer le compte de accounts.json
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
