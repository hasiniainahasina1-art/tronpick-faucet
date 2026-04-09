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

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const humanDelay = async (min = 500, max = 2000) => {
    await delay(Math.floor(Math.random() * (max - min) + min));
};

// Recherche de l'iframe Turnstile
async function findTurnstileFrame(page) {
    const frames = page.frames();
    for (const frame of frames) {
        if (frame.url().includes('challenges.cloudflare.com') && frame.url().includes('turnstile')) {
            console.log(`✅ Iframe Turnstile trouvée`);
            return frame;
        }
    }
    return null;
}

// Clic sur la case "Vérifier que vous êtes humain" dans l'iframe Turnstile
async function clickTurnstileCheckbox(frame) {
    console.log('🔍 Recherche de la case Turnstile dans l\'iframe...');

    // Attendre que le widget soit chargé
    await frame.waitForSelector('body', { timeout: 10000 });

    // Plusieurs méthodes pour trouver la case
    const clicked = await frame.evaluate(() => {
        // 1. Chercher le label contenant le texte exact (via XPath)
        const xpath = "//label[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'vérifier que vous êtes humain')]";
        const label = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (label) {
            label.click();
            return { success: true, method: 'label XPath' };
        }

        // 2. Chercher un élément avec le texte (fallback)
        const elements = Array.from(document.querySelectorAll('label, div, span, button'));
        const target = elements.find(el => el.textContent.toLowerCase().includes('vérifier que vous êtes humain'));
        if (target) {
            target.click();
            return { success: true, method: 'text search' };
        }

        // 3. Chercher l'input checkbox associé
        const checkbox = document.querySelector('input[type="checkbox"]');
        if (checkbox) {
            checkbox.click();
            return { success: true, method: 'checkbox input' };
        }

        // 4. Cliquer au centre (dernier recours)
        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;
        const element = document.elementFromPoint(centerX, centerY);
        if (element) {
            element.click();
            return { success: true, method: 'center click' };
        }

        return { success: false };
    });

    if (clicked.success) {
        console.log(`✅ Clic effectué (${clicked.method})`);
    } else {
        console.log('❌ Impossible de cliquer sur la case Turnstile');
    }
    return clicked.success;
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

        // --- LOGIN PAGE ---
        console.log('🌐 Accès à login.php...');
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 30000 });

        // Remplir email
        const emailSelector = 'input[type="email"], input[name="email"], input#email';
        await page.waitForSelector(emailSelector, { timeout: 10000 });
        await page.type(emailSelector, EMAIL, { delay: 30 });
        await humanDelay(300, 600);

        // Remplir password
        const passwordSelector = 'input[type="password"], input[name="password"], input#password';
        await page.type(passwordSelector, PASSWORD, { delay: 30 });
        await humanDelay(500, 1000);

        console.log('⏳ Attente de l\'injection de Turnstile...');
        await delay(5000); // Laisser le temps à l'iframe d'apparaître

        // --- RECHERCHE IFRAME TURNSTILE ---
        let turnstileFrame = await findTurnstileFrame(page);
        if (!turnstileFrame) {
            // Tenter de déclencher en cliquant ailleurs
            console.log('🔄 Turnstile non visible, tentative de focus...');
            await page.click('body', { offset: { x: 400, y: 400 } });
            await delay(3000);
            turnstileFrame = await findTurnstileFrame(page);
        }

        if (!turnstileFrame) {
            console.log('❌ Iframe Turnstile introuvable. Capture d\'écran :');
            const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
            console.log('📸 CAPTURE_BASE64_START');
            console.log(screenshot);
            console.log('📸 CAPTURE_BASE64_END');
            throw new Error('Iframe Turnstile non détectée');
        }

        // --- CLIQUER SUR LA CASE TURNSTILE ---
        console.log('🎯 Clic sur "Vérifier que vous êtes humain"...');
        const checkboxClicked = await clickTurnstileCheckbox(turnstileFrame);

        if (!checkboxClicked) {
            throw new Error('Échec du clic sur la case Turnstile');
        }

        // --- ATTENTE DE LA VALIDATION TURNSTILE ---
        console.log('⏳ Attente de la validation Turnstile (max 25s)...');
        const startWait = Date.now();
        let turnstileValidated = false;
        while (Date.now() - startWait < 25000) {
            const isChecked = await turnstileFrame.evaluate(() => {
                const cb = document.querySelector('input[type="checkbox"]');
                return cb ? cb.checked : false;
            });
            if (isChecked) {
                console.log('✅ Turnstile coché !');
                turnstileValidated = true;
                break;
            }
            await delay(2000);
        }

        if (!turnstileValidated) {
            console.log('⚠️ Turnstile non coché après attente, on tente quand même le login.');
        }

        // --- CLIQUER SUR LOGIN ---
        console.log('🔐 Recherche du bouton "Log in"...');
        const loginButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(btn => btn.textContent.trim() === 'Log in');
        });

        if (!loginButton) {
            throw new Error('Bouton "Log in" introuvable');
        }

        await loginButton.click();
        console.log('🖱️ Clic sur "Log in" effectué');

        // Attendre la navigation
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(e => {
            console.log('⚠️ Navigation timeout :', e.message);
        });
        await delay(5000);

        // Vérifier si connecté
        const currentUrl = page.url();
        console.log('📍 URL après login :', currentUrl);
        if (!currentUrl.includes('login.php')) {
            status.success = true;
            status.message = 'Connexion réussie après validation Turnstile';
        } else {
            status.message = 'Échec de connexion malgré Turnstile';
        }

    } catch (error) {
        console.error('❌ Erreur :', error);
        status.message = error.message;
    } finally {
        if (browser) await browser.close();
    }

    const statusPath = path.join(__dirname, 'public', 'status.json');
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
    console.log('📝 Statut enregistré :', status.success ? 'SUCCÈS' : 'ÉCHEC', '-', status.message);
})();
