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

async function performLogout(page, account) {
    console.log(`🚪 Déconnexion pour ${account.email}`);
    const possiblePaths = ['faucet.php', 'index.php', 'dashboard.php', ''];
    let logoutSuccess = false;

    for (const p of possiblePaths) {
        const url = `https://${account.platform}.io/${p}`;
        console.log(`Tentative sur ${url}`);
        try {
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
        } catch (err) {
            console.log(`Échec accès à ${url}: ${err.message}`);
            continue;
        }
        await delay(2000);
        await page.screenshot({ path: path.join(screenshotsDir, `logout_${p || 'root'}_${account.email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });

        logoutSuccess = await page.evaluate(() => {
            const keywords = ['logout', 'sign out', 'déconnexion', 'se déconnecter', 'log out', 'exit'];
            const selectors = [
                'a[href*="logout"]', 'a[href*="signout"]', 'button[onclick*="logout"]',
                '.logout', '#logout', '.signout', '#signout', '[action*="logout"]'
            ];
            let element = null;
            for (const sel of selectors) {
                element = document.querySelector(sel);
                if (element) break;
            }
            if (!element) {
                const all = [...document.querySelectorAll('a, button')];
                element = all.find(el => {
                    const text = (el.textContent || '').toLowerCase();
                    return keywords.some(kw => text.includes(kw));
                });
            }
            if (element) {
                element.click();
                return true;
            }
            return false;
        });

        if (logoutSuccess) {
            console.log(`✅ Déconnexion réussie sur ${url}`);
            await delay(3000);
            break;
        }
    }

    if (!logoutSuccess) {
        try {
            const logoutUrl = `https://${account.platform}.io/logout.php`;
            await page.goto(logoutUrl, { waitUntil: 'networkidle2', timeout: 20000 });
            await delay(3000);
            const currentUrl = page.url();
            if (!currentUrl.includes('login.php') && !currentUrl.includes('logout')) {
                console.log(`Redirection après logout.php, déconnexion probablement réussie`);
                logoutSuccess = true;
            }
            await page.screenshot({ path: path.join(screenshotsDir, `logout_direct_${account.email.replace(/[^a-zA-Z0-9]/g, '_')}.png`), fullPage: true });
        } catch (err) {
            console.log(`Échec direct logout.php: ${err.message}`);
        }
    }

    return logoutSuccess;
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
