const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');

const EMAIL = process.env.TRONPICK_EMAIL;
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

// Remplissage robuste d'un champ input
async function robustType(page, selector, value) {
    // Attendre que l'élément soit présent
    await page.waitForSelector(selector, { timeout: 10000 });
    // Cliquer plusieurs fois pour focus et sélection
    await page.click(selector, { clickCount: 3 });
    await delay(200);
    // Effacer le contenu existant
    await page.evaluate((sel) => {
        document.querySelector(sel).value = '';
    }, selector);
    // Définir la valeur via evaluate et déclencher les événements
    await page.evaluate((sel, val) => {
        const el = document.querySelector(sel);
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }, selector, value);
    // Vérifier que la valeur a été prise
    const actualValue = await page.$eval(selector, el => el.value);
    if (actualValue !== value) {
        console.log(`⚠️ La valeur saisie pour ${selector} est "${actualValue}" au lieu de "${value}"`);
        // Tentative de secours : saisie lettre par lettre
        await page.click(selector, { clickCount: 3 });
        await page.type(selector, value, { delay: 50 });
    } else {
        console.log(`✅ Champ ${selector} rempli avec succès`);
    }
}

// Surveillance de Turnstile
async function waitForTurnstileGone(page, maxWaitMs = 60000) {
    console.log('🔎 Surveillance de Turnstile...');
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        const frames = page.frames();
        const turnstileFrame = frames.find(f => f.url().includes('challenges.cloudflare.com/turnstile'));
        if (!turnstileFrame) {
            console.log('✅ Iframe Turnstile disparue');
            return true;
        }
        try {
            const checked = await turnstileFrame.$eval('input[type="checkbox"]', cb => cb.checked);
            if (checked) console.log('   Case Turnstile cochée');
        } catch (e) {}
        await delay(2000);
    }
    console.log('⚠️ Turnstile toujours présent après timeout');
    return false;
}

async function isLoggedIn(page) {
    const url = page.url();
    if (!url.includes('login.php')) return true;
    const selectors = ['a[href*="dashboard"]', 'a[href*="account"]', 'a:contains("Logout")', '.user-menu'];
    for (const sel of selectors) {
        try { if (await page.$(sel)) return true; } catch (e) {}
    }
    return false;
}

async function getErrorMessages(page) {
    return await page.evaluate(() => {
        const selectors = ['.alert-danger', '.error', '.message-error', '[class*="error"]', '.text-danger'];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) return el.textContent.trim();
        }
        return null;
    });
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

        // Remplissage robuste
        console.log('⌨️ Remplissage identifiants (robuste)...');
        await robustType(page, 'input[type="email"]', EMAIL);
        await delay(500);
        await robustType(page, 'input[type="password"]', PASSWORD);
        await delay(2000);

        // Vérifier que les champs ne sont pas vides (double vérification)
        const emailValue = await page.$eval('input[type="email"]', el => el.value);
        const passwordValue = await page.$eval('input[type="password"]', el => el.value);
        console.log(`📝 Valeurs actuelles – email: "${emailValue}", password: "${passwordValue.replace(/./g, '*')}"`);

        console.log('🔐 Clic sur "Log in"...');
        const loginButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(btn => btn.textContent.trim() === 'Log in');
        });
        if (!loginButton) throw new Error('Bouton "Log in" introuvable');
        await loginButton.click();
        console.log('✅ Clic effectué');

        // Attendre Turnstile
        const turnstileGone = await waitForTurnstileGone(page, 60000);
        if (!turnstileGone) throw new Error('Turnstile non résolu');

        // Attendre confirmation connexion
        console.log('⏳ Attente de la connexion...');
        const startWait = Date.now();
        let loggedIn = false;
        while (Date.now() - startWait < 20000) {
            loggedIn = await isLoggedIn(page);
            if (loggedIn) break;
            const err = await getErrorMessages(page);
            if (err) {
                console.log('❌ Message d\'erreur :', err);
                status.message = `Échec: ${err}`;
                break;
            }
            await delay(2000);
        }

        if (!status.message) {
            if (loggedIn) {
                status.success = true;
                status.message = 'Connexion réussie !';
                console.log('✅ Connexion réussie !');
            } else {
                const pageText = await page.evaluate(() => document.body.innerText.substring(0, 500));
                console.log('📄 Extrait de la page :', pageText);
                status.message = 'Échec de connexion (toujours sur login.php)';
                console.log('❌', status.message);
            }
        }

        console.log('📍 URL finale :', page.url());

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
