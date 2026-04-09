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

async function findAndClickByText(page, keywords, tagNames = ['button', 'a', 'input']) {
    const found = await page.evaluate((kw, tags) => {
        const elements = Array.from(document.querySelectorAll(tags.join(',')));
        for (const el of elements) {
            const text = (el.textContent || el.value || el.getAttribute('aria-label') || '').toLowerCase();
            if (kw.some(k => text.includes(k.toLowerCase()))) {
                el.click();
                return { clicked: true, text: text };
            }
        }
        return { clicked: false };
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

        page.on('dialog', async dialog => {
            console.log('📢 Dialog :', dialog.message());
            await dialog.accept();
        });

        await page.setViewport({ width: 1280, height: 720 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // --- LOGIN ---
        console.log('🌐 Accès login...');
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('input[type="email"], input[name="email"], input#email', { timeout: 10000 });

        const emailField = await page.$('input[type="email"], input[name="email"], input#email');
        await emailField.type(EMAIL, { delay: 50 });
        const passwordField = await page.$('input[type="password"], input[name="password"], input#password');
        await passwordField.type(PASSWORD, { delay: 50 });

        // Clic login (recherche par sélecteurs + texte)
        let loginSuccess = false;
        const simpleSelectors = ['button[type="submit"]', 'input[type="submit"]', 'form button'];
        for (const sel of simpleSelectors) {
            const el = await page.$(sel);
            if (el) {
                await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}), el.click()]);
                await page.waitForTimeout(3000);
                if (!page.url().includes('login.php')) { loginSuccess = true; break; }
            }
        }
        if (!loginSuccess) {
            const clicked = await findAndClickByText(page, ['login', 'sign in', 'connexion'], ['button', 'input', 'a']);
            if (clicked.clicked) { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}); loginSuccess = true; }
        }
        if (!loginSuccess) {
            await page.focus('input[type="password"]');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(3000);
            if (!page.url().includes('login.php')) loginSuccess = true;
        }
        if (!loginSuccess) throw new Error('Échec connexion');

        // --- FAUCET ---
        console.log('🚰 Accès faucet...');
        await page.goto('https://tronpick.io/faucet.php', { waitUntil: 'networkidle2', timeout: 30000 });

        // Lister tous les boutons visibles (pour diagnostic)
        const buttonsInfo = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('button, input[type="submit"], a, div[role="button"]'))
                .map(el => ({
                    tag: el.tagName,
                    text: (el.textContent || el.value || '').trim().substring(0, 50),
                    disabled: el.disabled || false,
                    className: el.className,
                    id: el.id
                }));
        });
        console.log('📋 Boutons trouvés sur la page faucet :', JSON.stringify(buttonsInfo, null, 2));

        // Capture AVANT clic
        const screenshotBefore = await page.screenshot({ encoding: 'base64' });
        console.log('📸 Capture AVANT clic (base64, 100 premiers caractères) :', screenshotBefore.substring(0, 100) + '...');

        // Recherche et clic sur le bouton CLAIM (plus précis)
        let claimClicked = false;
        let clickedButtonText = '';

        // Stratégie 1 : chercher un bouton avec texte exact "CLAIM" (insensible casse)
        const claimBtn = await page.evaluateHandle(() => {
            const btns = Array.from(document.querySelectorAll('button, input[type="submit"], a'));
            return btns.find(el => (el.textContent || el.value || '').trim().toUpperCase() === 'CLAIM');
        });

        if (claimBtn && (await claimBtn.asElement()) !== null) {
            const btn = claimBtn.asElement();
            const isDisabled = await btn.evaluate(el => el.disabled);
            if (!isDisabled) {
                await btn.click();
                clickedButtonText = await btn.evaluate(el => el.textContent || el.value);
                console.log(`✅ Clic sur bouton exact "CLAIM" (${clickedButtonText})`);
                claimClicked = true;
            } else {
                console.log('⚠️ Bouton CLAIM trouvé mais désactivé');
            }
        }

        // Stratégie 2 : recherche par mot-clé si pas trouvé
        if (!claimClicked) {
            const result = await findAndClickByText(page, ['claim', 'get', 'receive', 'roll'], ['button', 'input', 'a']);
            if (result.clicked) {
                claimClicked = true;
                clickedButtonText = result.text;
                console.log(`✅ Clic par mot-clé sur "${clickedButtonText}"`);
            }
        }

        if (claimClicked) {
            // Attendre une éventuelle réponse
            await page.waitForTimeout(5000);

            // Capture APRÈS clic
            const screenshotAfter = await page.screenshot({ encoding: 'base64' });
            console.log('📸 Capture APRÈS clic (base64, 100 premiers caractères) :', screenshotAfter.substring(0, 100) + '...');

            // Vérifier la présence d'un message de succès/erreur
            const messages = await page.evaluate(() => {
                const selectors = ['.alert', '.message', '.notice', '.success', '.error', '[class*="toast"]', '[class*="notification"]'];
                for (const sel of selectors) {
                    const el = document.querySelector(sel);
                    if (el) return { text: el.textContent.trim(), selector: sel };
                }
                return null;
            });
            if (messages) {
                console.log('💬 Message détecté :', messages.text, '(', messages.selector, ')');
                status.message = `CLAIM cliqué. Réponse site : ${messages.text.substring(0, 100)}`;
            } else {
                status.message = `CLAIM cliqué (bouton "${clickedButtonText}") mais aucun message visible`;
            }
        } else {
            console.log('❌ Aucun bouton CLAIM trouvé');
            status.message = 'Aucun bouton CLAIM trouvé';
        }

        status.success = true;

    } catch (error) {
        console.error('❌ Erreur :', error);
        status.message = error.message;
    } finally {
        if (browser) await browser.close();
    }

    const statusPath = path.join(__dirname, 'public', 'status.json');
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
    console.log('📝 Statut enregistré');
})();
