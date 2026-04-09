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

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function waitForTurnstileAndClick(page) {
    // Attendre que l'iframe Turnstile soit présente
    console.log('⏳ Attente de l\'iframe Turnstile...');
    const frame = await page.waitForFrame(
        f => f.url().includes('challenges.cloudflare.com/turnstile'),
        { timeout: 15000 }
    ).catch(() => null);

    if (!frame) {
        console.log('⚠️ Iframe Turnstile non trouvée');
        return false;
    }

    console.log('✅ Iframe Turnstile trouvée');

    // Attendre que le contenu soit chargé
    await frame.waitForSelector('body', { timeout: 5000 }).catch(() => {});

    // Cliquer sur la case
    const clicked = await frame.evaluate(() => {
        const label = document.querySelector('label');
        if (label) { label.click(); return true; }
        const cb = document.querySelector('input[type="checkbox"]');
        if (cb) { cb.click(); return true; }
        return false;
    });

    if (clicked) {
        console.log('✅ Clic effectué sur Turnstile');
    }

    // Attendre que l'iframe disparaisse ou que la case soit cochée
    console.log('⏳ Attente résolution Turnstile (max 30s)...');
    const start = Date.now();
    while (Date.now() - start < 30000) {
        const frames = page.frames();
        const stillThere = frames.some(f => f.url().includes('challenges.cloudflare.com/turnstile'));
        if (!stillThere) {
            console.log('✅ Iframe Turnstile disparue - challenge résolu');
            return true;
        }
        try {
            const isChecked = await frame.evaluate(() => {
                const cb = document.querySelector('input[type="checkbox"]');
                return cb ? cb.checked : false;
            });
            if (isChecked) {
                console.log('✅ Case cochée');
                await delay(2000);
                return true;
            }
        } catch (e) {}
        await delay(2000);
    }
    console.log('⚠️ Turnstile non résolu dans le temps imparti');
    return false;
}

(async () => {
    let browser;
    const status = { success: false, time: new Date().toISOString(), message: '' };
    try {
        browser = await puppeteer.connect({
            browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}`
        });
        const page = await browser.newPage();
        page.on('dialog', d => d.accept());
        await page.setViewport({ width: 1280, height: 720 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

        // Login page
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 30000 });
        await page.type('input[type="email"]', EMAIL, { delay: 30 });
        await page.type('input[type="password"]', PASSWORD, { delay: 30 });

        // Laisser Turnstile apparaître
        await delay(3000);

        const resolved = await waitForTurnstileAndClick(page);

        // Attendre un peu pour la stabilité de la page principale
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 });
        await delay(2000);

        // Cliquer sur Log in
        const loginBtn = await page.evaluateHandle(() => {
            return Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Log in');
        });
        if (!loginBtn) throw new Error('Bouton Log in non trouvé');

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
            loginBtn.click()
        ]);
        await delay(5000);

        if (!page.url().includes('login.php')) {
            status.success = true;
            status.message = 'Connexion réussie';
        } else {
            status.message = 'Échec connexion';
        }
    } catch (e) {
        console.error('❌', e);
        status.message = e.message;
    } finally {
        if (browser) await browser.close();
        fs.writeFileSync(path.join(__dirname, 'public', 'status.json'), JSON.stringify(status));
        console.log('📝 Statut enregistré:', status.success ? 'SUCCÈS' : 'ÉCHEC');
    }
})();
