const puppeteer = require('puppeteer-core');
const EMAIL = process.env.TRONPICK_EMAIL;
const PASSWORD = process.env.TRONPICK_PASSWORD;
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

if (!EMAIL || !PASSWORD || !BROWSERLESS_TOKEN) {
    console.error('❌ Variables d\'environnement manquantes');
    process.exit(1);
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Recherche du texte et retourne l'élément trouvé (pour pouvoir l'entourer)
async function findTurnstileElement(page) {
    const keywords = [
        'vérifier que vous êtes humain',
        'verify you are human',
        'vérifiez que vous êtes humain',
        'verify that you are human',
        'confirm you are human'
    ];

    // Recherche dans la page principale
    const elementHandle = await page.evaluateHandle((kw) => {
        const bodyText = document.body.innerText.toLowerCase();
        for (const k of kw) {
            if (bodyText.includes(k)) {
                // Trouver l'élément contenant exactement ce texte
                const xpath = `//*[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${k}')]`;
                const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                return result.singleNodeValue;
            }
        }
        return null;
    }, keywords);

    const element = await elementHandle.asElement();
    if (element) {
        console.log('✅ Texte trouvé dans la page principale.');
        return element;
    }

    // Recherche dans les iframes
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const frameElement = await frame.evaluateHandle((kw) => {
                const bodyText = document.body.innerText.toLowerCase();
                for (const k of kw) {
                    if (bodyText.includes(k)) {
                        const xpath = `//*[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${k}')]`;
                        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                        return result.singleNodeValue;
                    }
                }
                return null;
            }, keywords);
            const el = await frameElement.asElement();
            if (el) {
                console.log('✅ Texte trouvé dans une iframe.');
                return el;
            }
        } catch (e) {}
    }
    return null;
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

        const emailSelector = 'input[type="email"], input[name="email"], input#email';
        await page.waitForSelector(emailSelector, { timeout: 10000 });
        await page.type(emailSelector, EMAIL, { delay: 30 });
        const passwordSelector = 'input[type="password"], input[name="password"], input#password';
        await page.type(passwordSelector, PASSWORD, { delay: 30 });

        console.log('⏳ Attente de 8 secondes pour le chargement du captcha...');
        await delay(8000);

        // Recherche de l'élément contenant le texte
        const turnstileElement = await findTurnstileElement(page);

        if (turnstileElement) {
            console.log('🎯 LE MESSAGE "VÉRIFIER QUE VOUS ÊTES HUMAIN" EST PRÉSENT !');
            // Entourer l'élément d'un rectangle rouge sur la capture
            await page.evaluate((el) => {
                el.style.border = '5px solid red';
                el.style.backgroundColor = 'rgba(255, 0, 0, 0.2)';
            }, turnstileElement);
        } else {
            console.log('❌ LE MESSAGE "VÉRIFIER QUE VOUS ÊTES HUMAIN" N\'A PAS ÉTÉ TROUVÉ.');
        }

        // Capture d'écran avec annotation éventuelle
        const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
        console.log('📸 CAPTURE_BASE64_START');
        console.log(screenshot);
        console.log('📸 CAPTURE_BASE64_END');

        // Message final très visible
        console.log('\n========================================');
        if (turnstileElement) {
            console.log('✅ RÉSULTAT : TEXTE TROUVÉ');
        } else {
            console.log('❌ RÉSULTAT : TEXTE NON TROUVÉ');
        }
        console.log('========================================\n');

    } catch (error) {
        console.error('❌ Erreur :', error);
    } finally {
        if (browser) await browser.close();
    }
})();
