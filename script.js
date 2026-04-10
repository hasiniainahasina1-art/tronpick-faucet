const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');

const EMAIL = process.env.TRONPICK_EMAIL.trim().toLowerCase();
const PASSWORD = process.env.TRONPICK_PASSWORD;
const PROXY_USERNAME = process.env.PROXY_USERNAME;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;
const PROXY_HOST = '31.59.20.176';
const PROXY_PORT = '6754';

if (!EMAIL || !PASSWORD || !PROXY_USERNAME || !PROXY_PASSWORD) {
    console.error('❌ Variables d\'environnement manquantes');
    process.exit(1);
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Saisie robuste d'un champ
async function fillField(page, selector, value, fieldName) {
    console.log(`⌨️ Remplissage du champ ${fieldName}...`);
    await page.waitForSelector(selector, { timeout: 10000 });
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await delay(100);

    await page.evaluate((sel, val) => {
        const el = document.querySelector(sel);
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
    }, selector, value);
    await delay(300);

    let actualValue = await page.$eval(selector, el => el.value);
    if (actualValue !== value) {
        console.log(`   ⚠️ Valeur incorrecte, saisie lettre par lettre...`);
        await page.click(selector, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await delay(100);
        for (const char of value) {
            await page.keyboard.type(char, { delay: 30 });
        }
        actualValue = await page.$eval(selector, el => el.value);
    }

    if (actualValue !== value) {
        throw new Error(`Impossible de remplir le champ ${fieldName}`);
    }
    console.log(`✅ Champ ${fieldName} rempli`);
}

// Attendre que Turnstile disparaisse (après navigation)
async function waitForTurnstileGone(page, maxWaitMs = 60000) {
    console.log('🔎 Surveillance de Turnstile...');
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        try {
            const frames = page.frames();
            const turnstileFrame = frames.find(f => f.url().includes('challenges.cloudflare.com/turnstile'));
            if (!turnstileFrame) {
                console.log('✅ Iframe Turnstile disparue');
                return true;
            }
            const checked = await turnstileFrame.$eval('input[type="checkbox"]', cb => cb.checked);
            if (checked) console.log('   Case Turnstile cochée');
        } catch (e) {
            // Ignorer les erreurs de contexte pendant la navigation
        }
        await delay(2000);
    }
    console.log('⚠️ Timeout Turnstile');
    return false;
}

// Vérifier si connecté (avec robustesse)
async function isLoggedIn(page) {
    try {
        const url = page.url();
        if (!url.includes('login.php')) return true;
        const selectors = ['a[href*="dashboard"]', 'a[href*="account"]', '.user-menu'];
        for (const sel of selectors) {
            const el = await page.$(sel);
            if (el) return true;
        }
    } catch (e) {}
    return false;
}

// Obtenir message d'erreur
async function getErrorMessages(page) {
    try {
        return await page.evaluate(() => {
            const selectors = ['.alert-danger', '.error', '.message-error', '[class*="error"]', '.text-danger'];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el && el.offsetParent !== null) return el.textContent.trim();
            }
            return null;
        });
    } catch (e) {
        return null;
    }
}

// Clic sur CLAIM
async function clickClaimButton(page) {
    console.log('🎯 Recherche du bouton CLAIM...');
    const clicked = await page.evaluate(() => {
        const keywords = ['claim', 'get', 'receive', 'roll', 'collect', 'free'];
        const elements = Array.from(document.querySelectorAll('button, input[type="submit"], a, div[role="button"]'));
        for (const el of elements) {
            const text = (el.textContent || el.value || '').toLowerCase();
            if (keywords.some(kw => text.includes(kw)) && !el.disabled && el.offsetParent !== null) {
                el.click();
                return true;
            }
        }
        return false;
    });
    if (clicked) {
        console.log('✅ CLAIM cliqué');
        await delay(5000);
        return true;
    }
    console.log('⚠️ Bouton CLAIM non trouvé');
    return false;
}

(async () => {
    let browser;
    const status = { success: false, time: new Date().toISOString(), message: '' };

    try {
        console.log('🚀 Lancement du navigateur furtif...');
        const { browser: br, page } = await connect({
            headless: false,
            turnstile: true,
            proxy: {
                host: PROXY_HOST,
                port: PROXY_PORT,
                username: PROXY_USERNAME,
                password: PROXY_PASSWORD
            }
        });
        browser = br;
        console.log('✅ Navigateur prêt');

        page.on('dialog', async dialog => { await dialog.accept(); });
        await page.setViewport({ width: 1280, height: 720 });

        // --- LOGIN ---
        console.log('🌐 Accès login...');
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 60000 });

        const emailSelector = 'input[type="email"], input[name="email"], input#email';
        const passwordSelector = 'input[type="password"], input[name="password"], input#password';

        await fillField(page, emailSelector, EMAIL, 'email');
        await delay(500);
        await fillField(page, passwordSelector, PASSWORD, 'password');
        await delay(2000);

        console.log('🔐 Clic sur "Log in"...');
        const loginButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(btn => btn.textContent.trim() === 'Log in');
        });
        if (!loginButton) throw new Error('Bouton "Log in" introuvable');

        // ⚠️ Important : attendre la navigation APRÈS le clic
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(e => {
                console.log('⚠️ Navigation timeout ou erreur :', e.message);
            }),
            loginButton.click()
        ]);
        console.log('✅ Navigation terminée (ou timeout)');

        // Après navigation, la page peut encore charger Turnstile
        await delay(3000);
        const turnstileGone = await waitForTurnstileGone(page, 60000);
        if (!turnstileGone) {
            console.log('⚠️ Turnstile non résolu, mais on continue...');
        }

        // Vérifier si connecté
        console.log('⏳ Vérification de la connexion...');
        const loggedIn = await isLoggedIn(page);
        const currentUrl = page.url();
        console.log('📍 URL après login :', currentUrl);

        if (!loggedIn) {
            const err = await getErrorMessages(page);
            if (err) {
                console.log('❌ Message d\'erreur :', err);
                status.message = `Échec login: ${err}`;
            } else {
                status.message = 'Échec de connexion';
                console.log('❌', status.message);
            }
        } else {
            console.log('✅ Connexion réussie !');

            // --- FAUCET ---
            console.log('🚰 Accès faucet...');
            await page.goto('https://tronpick.io/faucet.php', { waitUntil: 'networkidle2', timeout: 30000 });
            await delay(10000);

            // --- CLAIM ---
            const claimClicked = await clickClaimButton(page);
            if (claimClicked) {
                status.success = true;
                status.message = 'Connexion réussie et CLAIM effectué';
            } else {
                status.success = true;
                status.message = 'Connexion réussie, mais CLAIM non trouvé';
            }
        }

    } catch (error) {
        console.error('❌ Erreur fatale :', error);
        status.message = error.message;
    } finally {
        if (browser) await browser.close();
        const statusPath = path.join(__dirname, 'public', 'status.json');
        fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
        console.log('📝 Statut enregistré :', status.success ? 'SUCCÈS' : 'ÉCHEC');
    }
})();
