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
        page.on('dialog', async dialog => { await dialog.accept(); });

        await page.setViewport({ width: 1280, height: 720 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // --- LOGIN (inchangé) ---
        console.log('🌐 Login...');
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
        await page.type('input[type="email"]', EMAIL, { delay: 30 });
        await page.type('input[type="password"]', PASSWORD, { delay: 30 });
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
            page.keyboard.press('Enter')
        ]);
        await page.waitForTimeout(3000);

        // --- FAUCET ---
        console.log('🚰 Accès faucet...');
        await page.goto('https://tronpick.io/faucet.php', { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Attendre un peu pour le chargement dynamique
        await page.waitForTimeout(8000);

        // Prendre une capture complète (sera loguée en base64)
        const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
        console.log('📸 CAPTURE_ECRAN_BASE64_START');
        console.log(screenshot);
        console.log('📸 CAPTURE_ECRAN_BASE64_END');

        // Lister tous les éléments potentiellement cliquables
        const clickables = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('button, a, input[type="submit"], input[type="button"], div[role="button"], span[role="button"], [onclick]'));
            return elements.map(el => {
                const rect = el.getBoundingClientRect();
                const isVisible = rect.width > 0 && rect.height > 0;
                return {
                    tag: el.tagName,
                    text: (el.textContent || el.value || el.getAttribute('aria-label') || '').trim().substring(0, 40),
                    id: el.id,
                    className: el.className,
                    disabled: el.disabled || false,
                    visible: isVisible,
                    href: el.href || null
                };
            }).filter(el => el.visible);
        });

        console.log('📋 ÉLÉMENTS CLIQUABLES VISIBLES :', JSON.stringify(clickables, null, 2));

        // Vérifier les iframes
        const frames = page.frames();
        console.log(`🖼️ Nombre d'iframes : ${frames.length - 1}`);
        for (let i = 1; i < frames.length; i++) {
            const frame = frames[i];
            const frameUrl = frame.url();
            console.log(`   Iframe ${i} : ${frameUrl}`);
            try {
                const frameClickables = await frame.evaluate(() => {
                    return Array.from(document.querySelectorAll('button, a, input[type="submit"], div[role="button"]'))
                        .map(el => ({
                            text: (el.textContent || el.value || '').trim().substring(0, 40),
                            disabled: el.disabled || false
                        }));
                });
                console.log(`   Éléments dans l'iframe :`, JSON.stringify(frameClickables));
            } catch (e) {
                console.log(`   Impossible d'accéder à l'iframe (probablement cross-origin)`);
            }
        }

        status.success = true;
        status.message = 'Diagnostic terminé. Voir logs pour la capture et les éléments.';

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
