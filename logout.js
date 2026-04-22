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

// Ajout d'un point rouge visible (optionnel)
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

// Clique sur le bouton à l'index donné (0‑based) et retourne ses coordonnées
async function clickButtonByIndex(page, index) {
    const elements = await page.$$('button, a, [role="button"], input[type="button"], input[type="submit"]');
    if (index >= elements.length) {
        throw new Error(`Bouton index ${index} inexistant (seulement ${elements.length})`);
    }
    const element = elements[index];
    const box = await element.boundingBox();
    if (!box) throw new Error(`Impossible d'obtenir les coordonnées du bouton ${index+1}`);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    console.log(`🖱️ Bouton ${index+1} coordonnées : (${Math.round(x)}, ${Math.round(y)})`);
    await addRedDot(page, x, y);
    await element.click();
    console.log(`✅ Clic sur le bouton ${index+1} effectué`);
    return { x: Math.round(x), y: Math.round(y) };
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

        // --- Séquence demandée ---
        console.log('⏳ Attente de 3 secondes...');
        await delay(3000);
        console.log('🔄 Actualisation de la page...');
        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
        console.log('⏳ Attente de 5 secondes après actualisation...');
        await delay(5000);

        // Lister tous les boutons
        await listAllButtons(page);

        // Cliquer sur le 7ème bouton (index 6)
        const coords = await clickButtonByIndex(page, 6);
        console.log(`📌 Coordonnées du bouton 7 : (${coords.x}, ${coords.y})`);

        // Capture après clic
        const screenshotAfter = path.join(screenshotsDir, `logout_after_click7_${account.email.replace(/[^a-zA-Z0-9]/g, '_')}.png`);
        await page.screenshot({ path: screenshotAfter, fullPage: true });
        console.log(`📸 Capture après clic: ${screenshotAfter}`);

        // Attendre 6 secondes pour laisser le site réagir
        console.log('⏳ Attente de 6 secondes pour observer le résultat...');
        await delay(6000);

        // Capture finale
        const screenshotFinal = path.join(screenshotsDir, `logout_final_${account.email.replace(/[^a-zA-Z0-9]/g, '_')}.png`);
        await page.screenshot({ path: screenshotFinal, fullPage: true });
        console.log(`📸 Capture finale: ${screenshotFinal}`);

        // Vérifier si déconnecté
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

        await browser.close();

        if (success) {
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
