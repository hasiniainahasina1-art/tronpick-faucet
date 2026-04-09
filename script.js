const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const EMAIL = process.env.TRONPICK_EMAIL;
const PASSWORD = process.env.TRONPICK_PASSWORD;
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

if (!EMAIL || !PASSWORD || !BROWSERLESS_TOKEN) {
    console.error('❌ Variables d\'environnement manquantes');
    process.exit(1);
}

(async () => {
    let browser;
    const status = {
        success: false,
        time: new Date().toISOString(),
        message: ''
    };

    try {
        console.log('🔗 Connexion à Browserless...');
        browser = await puppeteer.connect({
            browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}`
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        console.log('🌐 Accès à la page de login...');
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 30000 });

        console.log('⌨️ Saisie des identifiants...');
        await page.type('input[type="email"]', EMAIL, { delay: 50 });
        await page.type('input[type="password"]', PASSWORD, { delay: 50 });

        console.log('🔍 Recherche du bouton de connexion...');

        // Fonction pour trouver et cliquer sur le bouton
        const clickLoginButton = async () => {
            // Essayer plusieurs sélecteurs possibles
            const selectors = [
                'button:contains("Login")',
                'button:contains("Sign in")',
                'button:contains("Connexion")',
                'input[value="Login"]',
                'input[value="Sign in"]',
                'button[type="submit"]',
                'input[type="submit"]',
                'form button',           // premier bouton dans le formulaire
                'form input[type="submit"]'
            ];

            for (const sel of selectors) {
                try {
                    const element = await page.$(sel);
                    if (element) {
                        console.log(`✅ Bouton trouvé avec le sélecteur : ${sel}`);
                        await Promise.all([
                            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
                            element.click()
                        ]);
                        return true;
                    }
                } catch (e) {
                    // continue
                }
            }

            // Dernière chance : chercher par texte avec evaluate
            const found = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]'));
                const loginBtn = buttons.find(el => {
                    const text = (el.textContent || el.value || '').toLowerCase();
                    return text.includes('login') || text.includes('sign in') || text.includes('connexion');
                });
                if (loginBtn) {
                    loginBtn.click();
                    return true;
                }
                return false;
            });

            if (found) {
                console.log('✅ Bouton trouvé par recherche textuelle');
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
                return true;
            }

            throw new Error('Aucun bouton de connexion trouvé');
        };

        await clickLoginButton();

        console.log('🚰 Accès à la page faucet...');
        await page.goto('https://tronpick.io/faucet.php', { waitUntil: 'networkidle2', timeout: 30000 });

        // Optionnel : cliquer sur "Claim" si nécessaire
        // const claimBtn = await page.$('button:contains("Claim")');
        // if (claimBtn) await claimBtn.click();

        status.success = true;
        status.message = 'Faucet visité avec succès';
        console.log('✅ Terminé !');

    } catch (error) {
        console.error('❌ Erreur :', error);
        status.message = error.message;

        // Prendre une capture d'écran pour le débogage
        if (browser) {
            try {
                const pages = await browser.pages();
                const page = pages[pages.length - 1];
                const screenshot = await page.screenshot({ encoding: 'base64' });
                console.log('📸 Capture d\'écran (base64) :', screenshot.substring(0, 200) + '...');
            } catch (e) {}
        }
    } finally {
        if (browser) await browser.close();
    }

    const statusPath = path.join(__dirname, 'public', 'status.json');
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
    console.log('📝 Statut enregistré dans', statusPath);
})();
