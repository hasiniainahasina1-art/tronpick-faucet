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

        // ------------------- LOGIN -------------------
        console.log('🌐 Login...');
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
        await page.type('input[type="email"]', EMAIL, { delay: 30 });
        await page.type('input[type="password"]', PASSWORD, { delay: 30 });
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
            page.keyboard.press('Enter')
        ]);
        await page.waitForTimeout(4000);

        // ------------------- FAUCET -------------------
        console.log('🚰 Accès faucet...');
        await page.goto('https://tronpick.io/faucet.php', { waitUntil: 'networkidle2', timeout: 30000 });

        // Attendre que la page soit complètement stable (10 secondes)
        await page.waitForTimeout(10000);

        // ------------------- RECHERCHE DU BOUTON CLAIM -------------------
        console.log('🎯 Recherche du bouton CLAIM...');

        // Fonction qui cherche le bouton dans la page et toutes les iframes
        const findAndClickClaim = async () => {
            // 1. Chercher dans la page principale
            const mainPageResult = await page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('button, input[type="submit"], a, div[role="button"], span[role="button"], [onclick]'));
                const claimKeywords = ['claim', 'get', 'receive', 'roll', 'withdraw', 'collect'];
                for (const el of elements) {
                    const text = (el.textContent || el.value || el.getAttribute('aria-label') || '').toLowerCase();
                    if (claimKeywords.some(kw => text.includes(kw)) && !el.disabled) {
                        el.click();
                        return { found: true, text: text, inFrame: false };
                    }
                }
                return { found: false };
            });

            if (mainPageResult.found) {
                console.log(`✅ Clic sur bouton (page principale) : "${mainPageResult.text}"`);
                return true;
            }

            // 2. Chercher dans les iframes
            const frames = page.frames();
            console.log(`🖼️ ${frames.length - 1} iframe(s) détectée(s)`);
            for (let i = 1; i < frames.length; i++) {
                const frame = frames[i];
                try {
                    const frameResult = await frame.evaluate(() => {
                        const elements = Array.from(document.querySelectorAll('button, input[type="submit"], a, div[role="button"], span[role="button"]'));
                        const claimKeywords = ['claim', 'get', 'receive', 'roll', 'withdraw', 'collect'];
                        for (const el of elements) {
                            const text = (el.textContent || el.value || el.getAttribute('aria-label') || '').toLowerCase();
                            if (claimKeywords.some(kw => text.includes(kw)) && !el.disabled) {
                                el.click();
                                return { found: true, text: text, inFrame: true };
                            }
                        }
                        return { found: false };
                    });
                    if (frameResult.found) {
                        console.log(`✅ Clic sur bouton (iframe) : "${frameResult.text}"`);
                        return true;
                    }
                } catch (e) {
                    console.log(`   Iframe inaccessible (cross-origin)`);
                }
            }
            return false;
        };

        const claimClicked = await findAndClickClaim();

        // Attendre après le clic
        if (claimClicked) {
            await page.waitForTimeout(6000);
            status.message = 'CLAIM cliqué avec succès';
        } else {
            // Prendre une capture d'écran pour diagnostiquer
            console.log('❌ Bouton CLAIM introuvable, capture d\'écran :');
            const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
            console.log('📸 CAPTURE_BASE64_START');
            console.log(screenshot);
            console.log('📸 CAPTURE_BASE64_END');
            status.message = 'Bouton CLAIM non trouvé';
        }

        status.success = claimClicked; // Succès seulement si on a cliqué

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
