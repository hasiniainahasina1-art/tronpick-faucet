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

// Fonction d'attente d'un élément ou changement d'URL
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
        // Vérifier si l'URL a changé
        const currentUrl = page.url();
        if (!currentUrl.includes('login.php') && !currentUrl.includes('login')) {
            console.log(`✅ URL changée : ${currentUrl}`);
            return true;
        }

        // Vérifier la présence d'un élément de session connectée
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

        // Vérifier la présence d'un message d'erreur
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

        // --- LOGIN ---
        console.log('🌐 Accès login...');
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 30000 });
        console.log('   URL actuelle :', page.url());

        const emailSelector = 'input[type="email"], input[name="email"], input#email';
        await page.waitForSelector(emailSelector, { timeout: 15000, visible: true });
        console.log('✅ Champ email détecté');

        console.log('⌨️ Saisie identifiants...');
        await page.type(emailSelector, EMAIL, { delay: 30 });
        const passwordSelector = 'input[type="password"], input[name="password"], input#password';
        await page.type(passwordSelector, PASSWORD, { delay: 30 });

        // Recherche EXACTE du bouton "Log in"
        console.log('🔍 Recherche bouton "Log in"...');
        const loginButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(btn => btn.textContent.trim() === 'Log in');
        });

        if (!loginButton) {
            throw new Error('Bouton "Log in" introuvable');
        }

        console.log('🔐 Clic sur "Log in"...');
        await loginButton.click();

        // Attendre la confirmation de connexion (AJAX possible)
        console.log('⏳ Attente de la validation de connexion (max 30s)...');
        const loggedIn = await waitForLoginSuccess(page, 30000);

        if (!loggedIn) {
            // Prendre une capture pour diagnostic
            console.log('📸 Capture après échec connexion :');
            const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
            console.log('📸 CAPTURE_BASE64_START');
            console.log(screenshot);
            console.log('📸 CAPTURE_BASE64_END');
            throw new Error('Échec de connexion : aucun élément de session détecté et URL inchangée');
        }

        console.log('✅ Connecté avec succès !');
        await page.waitForTimeout(2000);

        // --- FAUCET ---
        console.log('🚰 Accès faucet...');
        await page.goto('https://tronpick.io/faucet.php', { waitUntil: 'networkidle2', timeout: 30000 });
        console.log('   URL faucet :', page.url());

        console.log('⏳ Attente de 15 secondes pour chargement complet...');
        await page.waitForTimeout(15000);

        // --- RECHERCHE ET CLIC SUR CLAIM ---
        console.log('\n🎯 Recherche bouton CLAIM...');
        let claimClicked = false;

        const clickClaimInFrame = async (frame) => {
            try {
                return await frame.evaluate(() => {
                    const keywords = ['claim', 'get', 'receive', 'roll', 'withdraw', 'collect', 'free', 'claim now', 'get reward'];
                    const elements = Array.from(document.querySelectorAll('button, input[type="submit"], a, div[role="button"], span[role="button"]'));
                    for (const el of elements) {
                        const text = (el.textContent || el.value || el.getAttribute('aria-label') || '').toLowerCase();
                        if (keywords.some(kw => text.includes(kw)) && !el.disabled && el.offsetParent !== null) {
                            el.click();
                            return { clicked: true, text: text };
                        }
                    }
                    return { clicked: false };
                });
            } catch (e) {
                return { clicked: false };
            }
        };

        const mainClick = await clickClaimInFrame(page.mainFrame());
        if (mainClick.clicked) {
            console.log(`✅ CLAIM cliqué (page principale) : "${mainClick.text}"`);
            claimClicked = true;
        } else {
            const frames = page.frames();
            for (let i = 1; i < frames.length; i++) {
                const frameClick = await clickClaimInFrame(frames[i]);
                if (frameClick.clicked) {
                    console.log(`✅ CLAIM cliqué (iframe ${i}) : "${frameClick.text}"`);
                    claimClicked = true;
                    break;
                }
            }
        }

        if (!claimClicked) {
            console.log('❌ Bouton CLAIM non trouvé. Éléments visibles :');
            const visibleElements = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('button, a, input[type="submit"]'))
                    .filter(el => el.offsetParent !== null)
                    .map(el => ({ tag: el.tagName, text: (el.textContent || el.value || '').trim().substring(0, 40) }));
            });
            console.log(JSON.stringify(visibleElements, null, 2));
            status.message = 'Bouton CLAIM introuvable';
        } else {
            await page.waitForTimeout(5000);
            status.message = 'CLAIM cliqué avec succès';
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
