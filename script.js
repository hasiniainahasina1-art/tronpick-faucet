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

// Attendre que Turnstile soit résolu (case cochée ou iframe disparue)
async function waitForTurnstileResolution(page, maxWaitMs = 60000) {
    console.log('⏳ Attente de la résolution de Turnstile...');
    const start = Date.now();
    let lastLog = '';
    while (Date.now() - start < maxWaitMs) {
        const frames = page.frames();
        const turnstileFrame = frames.find(f => f.url().includes('challenges.cloudflare.com/turnstile'));

        if (!turnstileFrame) {
            console.log('✅ Iframe Turnstile disparue – défi probablement résolu');
            return true;
        }

        try {
            const isChecked = await turnstileFrame.$eval('input[type="checkbox"]', cb => cb.checked);
            if (isChecked) {
                console.log('✅ Case Turnstile cochée !');
                // Laisser le temps au serveur de valider
                await delay(5000);
                return true;
            }
        } catch (e) {
            // L'iframe peut être en cours de rechargement
        }

        // Log d'attente toutes les 10 secondes
        const elapsed = Math.round((Date.now() - start) / 1000);
        if (elapsed % 10 === 0 && elapsed !== lastLog) {
            console.log(`   ...toujours en attente (${elapsed}s)`);
            lastLog = elapsed;
        }
        await delay(2000);
    }
    console.log('⚠️ Timeout – Turnstile non résolu dans le temps imparti');
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

        console.log('⌨️ Remplissage identifiants...');
        await page.waitForSelector('input[type="email"]', { timeout: 10000 });
        await page.type('input[type="email"]', EMAIL, { delay: 50 });
        await page.type('input[type="password"]', PASSWORD, { delay: 50 });
        await delay(2000);

        console.log('🔐 Clic sur "Log in"...');
        const loginButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(btn => btn.textContent.trim() === 'Log in');
        });
        if (!loginButton) throw new Error('Bouton "Log in" introuvable');

        await loginButton.click();
        console.log('✅ Clic effectué');

        // Attendre que Turnstile se résolve (max 60 secondes)
        const resolved = await waitForTurnstileResolution(page, 60000);

        if (!resolved) {
            // Capture d'écran pour diagnostic
            const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
            console.log('📸 CAPTURE_BASE64_START');
            console.log(screenshot);
            console.log('📸 CAPTURE_BASE64_END');
            throw new Error('Turnstile non résolu après 60 secondes');
        }

        // Attendre que la page se stabilise
        await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => console.log('⚠️ Network idle timeout, poursuite...'));
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
        const statusPath = path.join(__dirname, 'public', 'status.json');
        fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
        console.log('📝 Statut enregistré :', status.success ? 'SUCCÈS' : 'ÉCHEC');
    }
})();
