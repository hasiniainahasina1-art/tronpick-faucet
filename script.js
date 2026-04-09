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

        // Gérer les boîtes de dialogue (alertes) automatiquement
        page.on('dialog', async dialog => {
            console.log('📢 Message du site :', dialog.message());
            await dialog.accept();
        });

        await page.setViewport({ width: 1280, height: 720 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        console.log('🌐 Accès à la page de login...');
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 30000 });

        // Attendre que les champs email/password soient présents
        await page.waitForSelector('input[type="email"], input[name="email"], input#email', { timeout: 10000 });
        console.log('✅ Champs email/password détectés');

        console.log('⌨️ Saisie des identifiants...');
        const emailField = await page.$('input[type="email"], input[name="email"], input#email');
        await emailField.type(EMAIL, { delay: 50 });
        const passwordField = await page.$('input[type="password"], input[name="password"], input#password');
        await passwordField.type(PASSWORD, { delay: 50 });

        console.log('🔍 Recherche et clic sur le bouton de connexion...');

        let loginSuccess = false;

        const possibleSelectors = [
            'button[type="submit"]',
            'input[type="submit"]',
            'button:contains("Login")',
            'button:contains("Sign in")',
            'button:contains("Connexion")',
            'input[value="Login"]',
            'input[value="Sign in"]',
            'form button',
            'form input[type="submit"]',
            '.btn-login',
            '#login-button',
            '[data-testid="login-button"]'
        ];

        for (const sel of possibleSelectors) {
            try {
                const element = await page.$(sel);
                if (element) {
                    console.log(`   Essai du sélecteur : ${sel}`);
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
                        element.click()
                    ]);
                    await page.waitForTimeout(3000);
                    const currentUrl = page.url();
                    if (!currentUrl.includes('login.php')) {
                        console.log(`✅ Connexion réussie avec le sélecteur : ${sel}`);
                        loginSuccess = true;
                        break;
                    }
                }
            } catch (e) {
                // continuer
            }
        }

        if (!loginSuccess) {
            console.log('🔄 Recherche avancée par texte...');
            const clicked = await page.evaluate(() => {
                const clickables = Array.from(document.querySelectorAll(
                    'button, input[type="submit"], input[type="button"], a, div[role="button"], span[role="button"]'
                ));
                const loginKeywords = ['login', 'sign in', 'connexion', 'se connecter', 'enter', 'go'];
                for (const el of clickables) {
                    const text = (el.textContent || el.value || el.getAttribute('aria-label') || '').toLowerCase();
                    if (loginKeywords.some(kw => text.includes(kw))) {
                        el.click();
                        return true;
                    }
                }
                const form = document.querySelector('form');
                if (form) {
                    const firstButton = form.querySelector('button, input[type="submit"]');
                    if (firstButton) {
                        firstButton.click();
                        return true;
                    }
                }
                return false;
            });

            if (clicked) {
                console.log('✅ Clic effectué via recherche textuelle');
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
                loginSuccess = true;
            }
        }

        if (!loginSuccess) {
            console.log('⌨️ Tentative avec la touche Entrée...');
            await page.focus('input[type="password"]');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(3000);
            const currentUrl = page.url();
            if (!currentUrl.includes('login.php')) {
                console.log('✅ Connexion réussie avec la touche Entrée');
                loginSuccess = true;
            }
        }

        if (!loginSuccess) {
            throw new Error('Impossible de se connecter après plusieurs tentatives');
        }

        console.log('🚰 Accès à la page faucet...');
        await page.goto('https://tronpick.io/faucet.php', { waitUntil: 'networkidle2', timeout: 30000 });

        // -------------------------------------------------------------------
        // CLIC SUR LE BOUTON CLAIM
        // -------------------------------------------------------------------
        console.log('🎁 Recherche du bouton CLAIM...');
        const claimSelectors = [
            'button:contains("CLAIM")',
            'button:contains("Claim")',
            'button:contains("claim")',
            'input[value="CLAIM"]',
            'input[value="Claim"]',
            'button[type="submit"]', // parfois le claim est un submit
            '.claim-button',
            '#claim-btn',
            'form button' // dernier recours : premier bouton du formulaire
        ];

        let claimClicked = false;
        for (const sel of claimSelectors) {
            const claimBtn = await page.$(sel);
            if (claimBtn) {
                await claimBtn.click();
                console.log(`✅ Bouton CLAIM cliqué avec le sélecteur : ${sel}`);
                claimClicked = true;
                // Attendre une éventuelle réponse (alerte, redirection)
                await page.waitForTimeout(4000);
                break;
            }
        }

        if (!claimClicked) {
            // Essayer une recherche textuelle avancée pour le claim
            const foundClaim = await page.evaluate(() => {
                const items = Array.from(document.querySelectorAll('button, input[type="submit"], a, div[role="button"]'));
                const claimKw = ['claim', 'get', 'receive', 'roll'];
                for (const el of items) {
                    const txt = (el.textContent || el.value || '').toLowerCase();
                    if (claimKw.some(kw => txt.includes(kw))) {
                        el.click();
                        return true;
                    }
                }
                return false;
            });
            if (foundClaim) {
                console.log('✅ Bouton CLAIM trouvé par recherche textuelle');
                claimClicked = true;
                await page.waitForTimeout(4000);
            }
        }

        if (!claimClicked) {
            console.log('⚠️ Aucun bouton CLAIM trouvé, on considère que la visite suffit');
        }

        status.success = true;
        status.message = 'Faucet visité' + (claimClicked ? ' et CLAIM cliqué' : '') + ' avec succès';
        console.log('✅ Script terminé avec succès');

    } catch (error) {
        console.error('❌ Erreur :', error);
        status.message = error.message;
    } finally {
        if (browser) await browser.close();
    }

    // Écriture du fichier status.json
    const statusPath = path.join(__dirname, 'public', 'status.json');
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
    console.log('📝 Statut enregistré dans', statusPath);
})();
