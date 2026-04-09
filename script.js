const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const EMAIL = process.env.TRONPICK_EMAIL;
const PASSWORD = process.env.TRONPICK_PASSWORD;
const PROXY_USERNAME = process.env.PROXY_USERNAME;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;
const PROXY_HOST = '198.23.239.134';
const PROXY_PORT = '6540';

if (!EMAIL || !PASSWORD || !PROXY_USERNAME || !PROXY_PASSWORD) {
    console.error('❌ Variables d\'environnement manquantes');
    process.exit(1);
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const humanDelay = async (min = 500, max = 2000) => {
    const ms = Math.floor(Math.random() * (max - min) + min);
    await delay(ms);
};

(async () => {
    let browser;
    const status = {
        success: false,
        time: new Date().toISOString(),
        message: ''
    };

    try {
        console.log('🚀 Lancement du navigateur avec proxy résidentiel...');
        browser = await puppeteer.launch({
            headless: 'new',  // 🔧 Nouveau mode headless (furtif)
            args: [
                '--disable-blink-features=AutomationControlled',
                `--proxy-server=http://${PROXY_HOST}:${PROXY_PORT}`,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=1280,720'
            ]
        });

        const page = await browser.newPage();

        // Authentification proxy
        await page.authenticate({
            username: PROXY_USERNAME,
            password: PROXY_PASSWORD
        });
        console.log('✅ Proxy authentifié');

        page.on('dialog', async dialog => {
            console.log('📢 Alerte :', dialog.message());
            await dialog.accept();
        });

        await page.setViewport({ width: 1280, height: 720 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // --- LOGIN ---
        console.log('🌐 Accès à la page de login...');
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 30000 });
        await humanDelay(1000, 2000);

        console.log('⌨️ Remplissage des identifiants...');
        const emailSelector = 'input[type="email"], input[name="email"], input#email';
        await page.waitForSelector(emailSelector, { timeout: 10000 });
        await page.type(emailSelector, EMAIL, { delay: 50 });
        await humanDelay(300, 600);

        const passwordSelector = 'input[type="password"], input[name="password"], input#password';
        await page.type(passwordSelector, PASSWORD, { delay: 50 });
        await humanDelay(500, 1000);

        // --- TURNSTILE (gestion headless) ---
        console.log('⏳ Attente de l\'apparition éventuelle de Turnstile...');
        await delay(5000);

        const turnstileFrame = page.frames().find(f => f.url().includes('challenges.cloudflare.com/turnstile'));
        if (turnstileFrame) {
            console.log('🛡️ Turnstile détecté. Tentative de clic automatique...');
            try {
                await turnstileFrame.waitForSelector('body', { timeout: 5000 });
                await turnstileFrame.click('input[type="checkbox"]');
                console.log('✅ Clic sur la case Turnstile effectué');
                await delay(20000);
            } catch (e) {
                console.log('⚠️ Interaction Turnstile échouée, on tente la connexion directe.');
            }
        } else {
            console.log('✅ Aucun Turnstile visible pour le moment.');
        }

        // --- CLIQUER SUR LOGIN ---
        console.log('🔐 Recherche du bouton "Log in"...');
        const loginButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(btn => btn.textContent.trim() === 'Log in');
        });

        if (!loginButton) {
            throw new Error('Bouton "Log in" introuvable');
        }

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(e => {
                console.log('⚠️ Navigation timeout :', e.message);
            }),
            loginButton.click()
        ]);

        await delay(5000);
        const currentUrl = page.url();
        console.log('📍 URL après connexion :', currentUrl);

        if (currentUrl.includes('login.php')) {
            const errorMsg = await page.evaluate(() => {
                const err = document.querySelector('.alert-danger, .error, .message-error');
                return err ? err.textContent.trim() : null;
            });
            status.message = errorMsg ? `Échec: ${errorMsg}` : 'Échec de connexion (toujours sur login.php)';
            console.log('❌', status.message);
        } else {
            status.success = true;
            status.message = 'Connexion réussie !';
            console.log('✅ Connexion réussie !');
        }

    } catch (error) {
        console.error('❌ Erreur fatale :', error);
        status.message = error.message;
    } finally {
        if (browser) await browser.close();
    }

    const statusPath = path.join(__dirname, 'public', 'status.json');
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
    console.log('📝 Statut enregistré :', status.success ? 'SUCCÈS' : 'ÉCHEC');
})();
