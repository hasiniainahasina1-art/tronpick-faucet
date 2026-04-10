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

// Fonction pour capturer l'état de Turnstile avec logs détaillés
async function monitorTurnstile(page, maxWaitMs = 60000) {
    console.log('🔎 Surveillance de Turnstile...');
    const start = Date.now();
    let lastLog = 0;

    while (Date.now() - start < maxWaitMs) {
        const frames = page.frames();
        const turnstileFrame = frames.find(f => f.url().includes('challenges.cloudflare.com/turnstile'));

        if (!turnstileFrame) {
            console.log('✅ Iframe Turnstile disparue');
            return true;
        }

        // Essayer d'obtenir des informations sur l'état du widget
        try {
            const info = await turnstileFrame.evaluate(() => {
                const checkbox = document.querySelector('input[type="checkbox"]');
                const label = document.querySelector('label');
                const messages = Array.from(document.querySelectorAll('[class*="message"], [class*="status"], .ctp-message, .turnstile-status'))
                                     .map(el => el.textContent.trim());
                return {
                    checkboxExists: !!checkbox,
                    checkboxChecked: checkbox ? checkbox.checked : false,
                    labelText: label ? label.textContent.trim() : null,
                    messages: messages.length ? messages : null
                };
            });

            const elapsed = Math.round((Date.now() - start) / 1000);
            if (elapsed - lastLog >= 5) {
                console.log(`   [${elapsed}s] Checkbox: ${info.checkboxExists ? (info.checkboxChecked ? 'cochée ✅' : 'non cochée') : 'absente'}`);
                if (info.messages) console.log(`   Messages: ${info.messages.join(' | ')}`);
                lastLog = elapsed;
            }

            if (info.checkboxChecked) {
                console.log('✅ Case Turnstile cochée !');
                await delay(5000);
                return true;
            }
        } catch (e) {
            // L'iframe peut être inaccessible temporairement
        }

        await delay(2000);
    }

    console.log('❌ Timeout – Turnstile non résolu');
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

        // Surveillance de Turnstile
        const resolved = await monitorTurnstile(page, 60000);

        if (!resolved) {
            // Capture pour diagnostic
            const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
            console.log('📸 CAPTURE_BASE64_START');
            console.log(screenshot);
            console.log('📸 CAPTURE_BASE64_END');
            throw new Error('Turnstile non résolu après 60s');
        }

        // Attendre que le réseau se stabilise un peu (facultatif)
        await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => console.log('⚠️ Network idle timeout ignoré'));
        await delay(5000);

        const currentUrl = page.url();
        console.log('📍 URL après connexion :', currentUrl);

        if (currentUrl.includes('login.php')) {
            const errorMsg = await page.evaluate(() => {
                const err = document.querySelector('.alert-danger, .error, .message-error');
                return err ? err.textContent.trim() : null;
            });
            status.message = errorMsg ? `Échec: ${errorMsg}` : 'Échec de connexion';
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
