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

// Délai aléatoire
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Fonction pour explorer une frame et lister tous les éléments d'interface
async function exploreFrame(frame, frameIndex = 0) {
    const indent = '  '.repeat(frameIndex);
    console.log(`\n${indent}📁 Frame ${frameIndex}: ${frame.url().substring(0, 80)}`);

    try {
        // Récupérer tous les éléments pertinents
        const elements = await frame.evaluate(() => {
            const selectors = [
                'input', 'button', 'a', 'select', 'textarea',
                '[role="button"]', '[onclick]', 'div[class*="btn"]', 'span[class*="btn"]',
                'label', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div[class*="captcha"]',
                'iframe', 'form', '[class*="error"]', '[class*="message"]'
            ];
            const els = Array.from(document.querySelectorAll(selectors.join(',')));

            return els.map(el => {
                const rect = el.getBoundingClientRect();
                const isVisible = rect.width > 0 && rect.height > 0;
                const text = (el.textContent || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().substring(0, 50);
                return {
                    tag: el.tagName,
                    type: el.type || null,
                    id: el.id || null,
                    className: el.className || null,
                    name: el.name || null,
                    href: el.href || null,
                    text: text,
                    disabled: el.disabled || false,
                    visible: isVisible,
                    position: isVisible ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null
                };
            }).filter(el => el.visible); // on ne garde que les éléments visibles
        });

        console.log(`${indent}   ✅ ${elements.length} élément(s) visible(s) trouvé(s) :`);
        elements.forEach((el, i) => {
            console.log(`${indent}   ${i+1}. [${el.tag}] ${el.type || ''} "${el.text}" (id=${el.id}, class=${el.className})`);
        });

        // Explorer les frames enfants
        const childFrames = frame.childFrames();
        for (let i = 0; i < childFrames.length; i++) {
            await exploreFrame(childFrames[i], frameIndex + 1);
        }
    } catch (e) {
        console.log(`${indent}   ❌ Frame inaccessible (cross-origin) : ${e.message}`);
    }
}

(async () => {
    let browser;
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

        // Attendre le champ email
        const emailSelector = 'input[type="email"], input[name="email"], input#email';
        await page.waitForSelector(emailSelector, { timeout: 10000 });
        console.log('✅ Champ email détecté');

        // Remplir les champs
        console.log('⌨️ Remplissage des identifiants...');
        await page.type(emailSelector, EMAIL, { delay: 30 });
        const passwordSelector = 'input[type="password"], input[name="password"], input#password';
        await page.type(passwordSelector, PASSWORD, { delay: 30 });

        console.log('⏳ Attente de 10 secondes pour le chargement des scripts/captcha...');
        await delay(10000);

        // Explorer tous les éléments visibles de la page principale et des iframes
        console.log('\n🔍 EXPLORATION DE L\'INTERFACE :');
        await exploreFrame(page.mainFrame());

        // Prendre une capture d'écran (optionnel, mais utile)
        const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
        console.log('\n📸 CAPTURE_BASE64_START');
        console.log(screenshot);
        console.log('📸 CAPTURE_BASE64_END');

        console.log('\n✅ Diagnostic terminé.');

    } catch (error) {
        console.error('❌ Erreur :', error);
    } finally {
        if (browser) await browser.close();
    }
})();
