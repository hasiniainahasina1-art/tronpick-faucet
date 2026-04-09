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

// --- Fonctions utilitaires pour simulation humaine ---
const humanDelay = async (min = 500, max = 2000) => {
    const ms = Math.floor(Math.random() * (max - min) + min);
    await new Promise(resolve => setTimeout(resolve, ms));
};

const randomMouseMove = async (page) => {
    const width = 1280;
    const height = 720;
    const x = Math.floor(Math.random() * width);
    const y = Math.floor(Math.random() * height);
    await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 20) + 10 });
};

const randomScroll = async (page) => {
    const scrollAmount = Math.floor(Math.random() * 500) + 100;
    await page.evaluate((amount) => {
        window.scrollBy({ top: amount, behavior: 'smooth' });
    }, scrollAmount);
    await humanDelay(300, 800);
    await page.evaluate((amount) => {
        window.scrollBy({ top: -amount / 2, behavior: 'smooth' });
    }, scrollAmount);
};

// Fonction d'attente de succès de connexion (inchangée)
async function waitForLoginSuccess(page, timeoutMs = 30000) {
    const start = Date.now();
    const checkInterval = 2000;
    const successSelectors = [
        'a[href*="dashboard"]',
        'a[href*="account"]',
        'a:contains("Logout")',
        'a:contains("Sign out")',
        'a:contains("Profile")',
        '.user-menu',
        '.navbar-user',
        '[data-testid="user-menu"]'
    ];

    while (Date.now() - start < timeoutMs) {
        const currentUrl = page.url();
        if (!currentUrl.includes('login.php') && !currentUrl.includes('login')) {
            console.log(`✅ URL changée : ${currentUrl}`);
            return true;
        }

        for (const sel of successSelectors) {
            try {
                const el = await page.$(sel);
                if (el) {
                    const text = await page.evaluate(e => e.textContent, el);
                    console.log(`✅ Élément connecté détecté : "${text.trim()}"`);
                    return true;
                }
            } catch (e) {}
        }

        const errorMsg = await page.evaluate(() => {
            const errors = document.querySelectorAll('.alert-danger, .error, .message-error, [class*="error"]');
            return errors.length > 0 ? errors[0].textContent.trim() : null;
        });
        if (errorMsg) {
            console.log(`❌ Message d'erreur détecté : ${errorMsg}`);
            return false;
        }

        await page.waitForTimeout(checkInterval);
    }
    return false;
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

        // --- LOGIN avec simulation humaine renforcée ---
        console.log('🌐 Accès login...');
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 30000 });
        console.log('   URL actuelle :', page.url());

        await humanDelay(1000, 2500);
        await randomMouseMove(page);
        await randomScroll(page);
        await humanDelay(500, 1500);

        const emailSelector = 'input[type="email"], input[name="email"], input#email';
        await page.waitForSelector(emailSelector, { timeout: 15000, visible: true });
        console.log('✅ Champ email détecté');

        await page.click(emailSelector);
        await humanDelay(300, 700);
        await randomMouseMove(page);

        console.log('⌨️ Saisie identifiants avec délais réalistes...');
        await page.type(emailSelector, EMAIL, { delay: () => Math.floor(Math.random() * 80) + 30 });
        await humanDelay(600, 1200);
        await randomMouseMove(page);

        const passwordSelector = 'input[type="password"], input[name="password"], input#password';
        await page.click(passwordSelector);
        await humanDelay(300, 700);
        await page.type(passwordSelector, PASSWORD, { delay: () => Math.floor(Math.random() * 100) + 40 });

        await humanDelay(800, 1500);
        await randomMouseMove(page);
        await randomScroll(page);

        console.log('🔍 Recherche bouton "Log in"...');
        const loginButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(btn => btn.textContent.trim() === 'Log in');
        });

        if (!loginButton) {
            throw new Error('Bouton "Log in" introuvable');
        }

        const box = await loginButton.boundingBox();
        if (box) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 15 });
            await humanDelay(200, 500);
        }

        console.log('🔐 Clic sur "Log in"...');
        await loginButton.click();

        console.log('⏳ Attente de la validation de connexion (max 40s)...');
        const startWait = Date.now();
        let loggedIn = false;
        while (Date.now() - startWait < 40000 && !loggedIn) {
            loggedIn = await waitForLoginSuccess(page, 5000);
            if (!loggedIn) {
                await randomMouseMove(page);
                await humanDelay(1500, 3000);
                await randomScroll(page);
            }
        }

        if (!loggedIn) {
            console.log('📸 Capture après échec connexion :');
            const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
            console.log('📸 CAPTURE_BASE64_START');
            console.log(screenshot);
            console.log('📸 CAPTURE_BASE64_END');
            throw new Error('Échec de connexion : aucun élément de session détecté et URL inchangée');
        }

        console.log('✅ Connecté avec succès !');
        await humanDelay(1000, 2000);

        // --- FAUCET ---
        console.log('🚰 Accès faucet...');
        await page.goto('https://tronpick.io/faucet.php', { waitUntil: 'networkidle2', timeout: 30000 });
        console.log('   URL faucet :', page.url());

        console.log('⏳ Attente de 15 secondes pour chargement complet...');
        await humanDelay(10000, 15000);
        await randomMouseMove(page);
        await randomScroll(page);

        // --- RECHERCHE DU BOUTON CLAIM AVANT SCROLL ET ATTENTE SUPPLÉMENTAIRE ---
        console.log('\n🎯 Recherche bouton CLAIM...');
        let claimClicked = false;
        let claimButtonHandle = null;

        // Fonction pour trouver l'élément CLAIM sans cliquer
        const findClaimInFrame = async (frame) => {
            try {
                const handle = await frame.evaluateHandle(() => {
                    const keywords = ['claim', 'get', 'receive', 'roll', 'withdraw', 'collect', 'free', 'claim now', 'get reward'];
                    const elements = Array.from(document.querySelectorAll('button, input[type="submit"], a, div[role="button"], span[role="button"]'));
                    for (const el of elements) {
                        const text = (el.textContent || el.value || el.getAttribute('aria-label') || '').toLowerCase();
                        if (keywords.some(kw => text.includes(kw)) && !el.disabled && el.offsetParent !== null) {
                            return el;
                        }
                    }
                    return null;
                });
                return handle;
            } catch (e) {
                return null;
            }
        };

        // Chercher d'abord dans la page principale
        claimButtonHandle = await findClaimInFrame(page.mainFrame());
        let foundInFrame = 'page principale';

        if (!claimButtonHandle) {
            const frames = page.frames();
            for (let i = 1; i < frames.length; i++) {
                claimButtonHandle = await findClaimInFrame(frames[i]);
                if (claimButtonHandle) {
                    foundInFrame = `iframe ${i}`;
                    break;
                }
            }
        }

        if (claimButtonHandle) {
            console.log(`📍 Bouton CLAIM trouvé dans ${foundInFrame}`);

            // Scroll vers le bouton
            await page.evaluate((el) => {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, claimButtonHandle);
            console.log('📜 Scroll vers le bouton CLAIM effectué');

            // Attendre 15 secondes AVANT de cliquer
            console.log('⏳ Attente de 15 secondes avant le clic...');
            await humanDelay(14000, 16000);

            // Clic
            await claimButtonHandle.click();
            console.log('✅ CLAIM cliqué après attente');
            claimClicked = true;

            // Attendre après clic
            await humanDelay(4000, 6000);
            status.message = 'CLAIM cliqué avec succès';
        } else {
            console.log('❌ Bouton CLAIM non trouvé. Éléments visibles :');
            const visibleElements = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('button, a, input[type="submit"]'))
                    .filter(el => el.offsetParent !== null)
                    .map(el => ({ tag: el.tagName, text: (el.textContent || el.value || '').trim().substring(0, 40) }));
            });
            console.log(JSON.stringify(visibleElements, null, 2));
            status.message = 'Bouton CLAIM introuvable';
        }

        status.success = claimClicked;

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
