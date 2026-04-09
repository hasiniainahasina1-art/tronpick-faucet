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

        // Attendre que les champs email/password soient présents
        await page.waitForSelector('input[type="email"], input[name="email"], input#email', { timeout: 10000 });
        console.log('✅ Champs email/password détectés');

        console.log('⌨️ Saisie des identifiants...');
        // Remplissage robuste
        const emailField = await page.$('input[type="email"], input[name="email"], input#email');
        await emailField.type(EMAIL, { delay: 50 });
        const passwordField = await page.$('input[type="password"], input[name="password"], input#password');
        await passwordField.type(PASSWORD, { delay: 50 });

        console.log('🔍 Recherche et clic sur le bouton de connexion...');

        // Stratégie multi‑niveaux pour trouver le bouton
        let loginSuccess = false;

        // 1. Essayer les sélecteurs CSS les plus probables
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
                    // Vérifier si l'URL a changé
                    await page.waitForTimeout(3000);
                    const currentUrl = page.url();
                    if (!currentUrl.includes('login.php')) {
                        console.log(`✅ Connexion réussie avec le sélecteur : ${sel}`);
                        loginSuccess = true;
                        break;
                    }
                }
            } catch (e) {
                // On passe au sélecteur suivant
            }
        }

        // 2. Si aucun sélecteur CSS n'a fonctionné, chercher par texte dans tous les éléments cliquables
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
                // Dernier recours : cliquer sur le premier bouton du formulaire
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

        // 3. Si toujours pas connecté, on essaie d'appuyer sur Entrée dans le champ password
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

        // (Optionnel) Cliquer sur le bouton Claim si nécessaire
        // Décommentez et adaptez si un clic supplémentaire est requis
        /*
        const claimSelectors = [
            'button:contains("Claim")',
            'button:contains("Get")',
            'input[value="Claim"]',
            '.claim-button',
            '#claim-btn'
        ];
        for (const sel of claimSelectors) {
            const claimBtn = await page.$(sel);
            if (claimBtn) {
                await claimBtn.click();
                console.log('🎁 Bouton Claim cliqué');
                break;
            }
        }
        */

        status.success = true;
        status.message = 'Faucet visité avec succès';
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
