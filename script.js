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

// Fonction utilitaire : trouver un élément par son texte
async function findAndClickByText(page, keywords, tagNames = ['button', 'a', 'input']) {
    const found = await page.evaluate((kw, tags) => {
        const elements = Array.from(document.querySelectorAll(tags.join(',')));
        for (const el of elements) {
            const text = (el.textContent || el.value || el.getAttribute('aria-label') || '').toLowerCase();
            if (kw.some(k => text.includes(k.toLowerCase()))) {
                el.click();
                return true;
            }
        }
        return false;
    }, keywords, tagNames);
    return found;
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

        // Accepter automatiquement les alertes
        page.on('dialog', async dialog => {
            console.log('📢 Message du site :', dialog.message());
            await dialog.accept();
        });

        await page.setViewport({ width: 1280, height: 720 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        console.log('🌐 Accès à la page de login...');
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 30000 });

        // Attendre les champs
        await page.waitForSelector('input[type="email"], input[name="email"], input#email', { timeout: 10000 });
        console.log('✅ Champs email/password détectés');

        console.log('⌨️ Saisie des identifiants...');
        const emailField = await page.$('input[type="email"], input[name="email"], input#email');
        await emailField.type(EMAIL, { delay: 50 });
        const passwordField = await page.$('input[type="password"], input[name="password"], input#password');
        await passwordField.type(PASSWORD, { delay: 50 });

        console.log('🔍 Recherche et clic sur le bouton de connexion...');

        let loginSuccess = false;

        // 1. Essayer les sélecteurs CSS simples (sans :contains)
        const simpleSelectors = [
            'button[type="submit"]',
            'input[type="submit"]',
            'form button',
            'form input[type="submit"]',
            '.btn-login',
            '#login-button',
            '[data-testid="login-button"]'
        ];

        for (const sel of simpleSelectors) {
            try {
                const element = await page.$(sel);
                if (element) {
                    console.log(`   Essai du sélecteur : ${sel}`);
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
                        element.click()
                    ]);
                    await page.waitForTimeout(3000);
                    if (!page.url().includes('login.php')) {
                        console.log(`✅ Connexion réussie avec : ${sel}`);
                        loginSuccess = true;
                        break;
                    }
                }
            } catch (e) {}
        }

        // 2. Recherche par texte
        if (!loginSuccess) {
            console.log('🔄 Recherche par texte du bouton login...');
            const loginKeywords = ['login', 'sign in', 'connexion', 'se connecter', 'enter', 'go'];
            const clicked = await findAndClickByText(page, loginKeywords, ['button', 'input', 'a']);
            if (clicked) {
                console.log('✅ Bouton login cliqué via recherche textuelle');
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
                loginSuccess = true;
            }
        }

        // 3. Touche Entrée
        if (!loginSuccess) {
            console.log('⌨️ Tentative avec la touche Entrée...');
            await page.focus('input[type="password"]');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(3000);
            if (!page.url().includes('login.php')) {
                console.log('✅ Connexion réussie avec Entrée');
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

        // Sélecteurs CSS simples (sans :contains)
        const simpleClaimSelectors = [
            'button[type="submit"]',
            'input[type="submit"]',
            '.claim-button',
            '#claim-btn',
            'form button'
        ];

        let claimClicked = false;
        for (const sel of simpleClaimSelectors) {
            const btn = await page.$(sel);
            if (btn) {
                // Vérifier que le texte contient "claim" (optionnel mais prudent)
                const text = await page.evaluate(el => (el.textContent || el.value || '').toLowerCase(), btn);
                if (text.includes('claim')) {
                    await btn.click();
                    console.log(`✅ Bouton CLAIM cliqué avec : ${sel}`);
                    claimClicked = true;
                    await page.waitForTimeout(4000);
                    break;
                }
            }
        }

        // Si pas trouvé, recherche textuelle large
        if (!claimClicked) {
            const claimKeywords = ['claim', 'get', 'receive', 'roll'];
            const foundClaim = await findAndClickByText(page, claimKeywords, ['button', 'input', 'a', 'div']);
            if (foundClaim) {
                console.log('✅ Bouton CLAIM trouvé par recherche textuelle');
                claimClicked = true;
                await page.waitForTimeout(4000);
            }
        }

        if (!claimClicked) {
            console.log('⚠️ Aucun bouton CLAIM trouvé (la visite simple suffit peut-être)');
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

    const statusPath = path.join(__dirname, 'public', 'status.json');
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
    console.log('📝 Statut enregistré dans', statusPath);
})();
