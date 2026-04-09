const puppeteer = require('puppeteer-core');
const EMAIL = process.env.TRONPICK_EMAIL;
const PASSWORD = process.env.TRONPICK_PASSWORD;
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

if (!EMAIL || !PASSWORD || !BROWSERLESS_TOKEN) {
    console.error('❌ Variables d\'environnement manquantes');
    process.exit(1);
}

// Délai aléatoire
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Recherche du texte "Vérifier que vous êtes humain" dans la page et les iframes
async function findTurnstileText(page) {
    const keywords = [
        'vérifier que vous êtes humain',
        'verify you are human',
        'vérifiez que vous êtes humain',
        'verify that you are human',
        'confirm you are human'
    ];

    // Recherche dans la page principale
    const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
    for (const kw of keywords) {
        if (bodyText.includes(kw)) {
            console.log(`✅ Texte trouvé dans la page principale : "${kw}"`);
            return true;
        }
    }

    // Recherche dans les iframes
    const frames = page.frames();
    console.log(`🔍 Vérification de ${frames.length} frame(s)...`);
    for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        try {
            const frameText = await frame.evaluate(() => document.body.innerText.toLowerCase());
            for (const kw of keywords) {
                if (frameText.includes(kw)) {
                    console.log(`✅ Texte trouvé dans l'iframe ${i} : "${kw}"`);
                    return true;
                }
            }
        } catch (e) {
            // Frame inaccessible (cross-origin)
        }
    }
    return false;
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

        // Remplir les champs
        const emailSelector = 'input[type="email"], input[name="email"], input#email';
        await page.waitForSelector(emailSelector, { timeout: 10000 });
        await page.type(emailSelector, EMAIL, { delay: 30 });
        const passwordSelector = 'input[type="password"], input[name="password"], input#password';
        await page.type(passwordSelector, PASSWORD, { delay: 30 });

        console.log('⏳ Attente de 8 secondes pour chargement des scripts...');
        await delay(8000);

        // Détection du texte Turnstile
        const found = await findTurnstileText(page);
        if (found) {
            console.log('🎯 Le message "Vérifier que vous êtes humain" est présent sur la page.');
        } else {
            console.log('❌ Le message "Vérifier que vous êtes humain" n\'a PAS été trouvé.');
        }

        // Optionnel : capture d'écran pour analyse
        const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
        console.log('📸 CAPTURE_BASE64_START');
        console.log(screenshot);
        console.log('📸 CAPTURE_BASE64_END');

    } catch (error) {
        console.error('❌ Erreur :', error);
    } finally {
        if (browser) await browser.close();
    }
})();
